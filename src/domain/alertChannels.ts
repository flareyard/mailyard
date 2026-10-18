import { and, eq, isNull } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { members, settings, webhookEndpoints } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { ALERT_KINDS } from "./alertKinds.ts"
import { parseParty, sendBulkMessage } from "./outbox.ts"
import { emitSafely } from "./webhooks.ts"

/**
 * Where alerts go besides the in-app drawer (HAL-3465). An alert that suspends sending in a week
 * shouldn't wait for someone to open the drawer. Each channel takes some alert kinds (or all) at or
 * above a severity:
 * - `email`: a short message to an address, on Mailyard's own `system` stream (no contact made).
 * - `webhook`: the `alert.raised` event to one endpoint, whatever events it subscribes to.
 * With no channels set, critical alerts mail `defaultEmail`, else the workspace's owner. Every
 * endpoint subscribed to `alert.raised` gets every alert, as with any event.
 * An alert is sent when it opens, and again only when its severity rises.
 */

export const SEVERITIES = ["info", "warning", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]
export const rank = (s: Severity) => SEVERITIES.indexOf(s)

export const AlertChannel = Schema.Struct({
  kind: Schema.Literals(["email", "webhook"]),
  /** An email address, or a webhook endpoint's id. */
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
  /** Alert kinds this channel takes; empty or absent for every kind. */
  kinds: Schema.optionalKey(Schema.Array(Schema.Literals(ALERT_KINDS)).check(Schema.isMaxLength(50))),
  minSeverity: Schema.Literals(SEVERITIES),
})
export type AlertChannel = typeof AlertChannel.Type

export const AlertSettings = Schema.Struct({
  channels: Schema.Array(AlertChannel).check(Schema.isMaxLength(20)),
  /** Where critical alerts go when no channel is set; the owner's address when absent. */
  defaultEmail: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(254)))),
})
export type AlertSettings = typeof AlertSettings.Type

export class AlertSettingsInvalid extends Schema.TaggedError<AlertSettingsInvalid>()("AlertSettingsInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMPTY: AlertSettings = { channels: [] }

export const getAlertSettings = Effect.fn("alertSettings.get")(function* () {
  const database = yield* Database
  const row = yield* database.query("settings.alerts", (db) =>
    db.select().from(settings).where(eq(settings.key, "alerts")).get(),
  )
  const decoded = Schema.decodeUnknownOption(AlertSettings)(row?.value)
  return decoded._tag === "Some" ? decoded.value : EMPTY
})

/** The workspace owner's address, if someone has claimed it. */
const ownerEmail = Effect.fn("alertSettings.owner")(function* () {
  const database = yield* Database
  const owner = yield* database.query("alerts.owner", (db) =>
    db
      .select({ email: members.email })
      .from(members)
      .where(and(eq(members.role, "owner"), isNull(members.removedAt)))
      .get(),
  )
  return owner?.email ?? null
})

/** What the settings mean right now: who gets mail, and a nudge when nobody does. */
export const describeAlertSettings = Effect.fn("alertSettings.describe")(function* () {
  const value = yield* getAlertSettings()
  const fallback = value.channels.length === 0 ? (value.defaultEmail ?? (yield* ownerEmail())) : null
  return {
    ...value,
    defaultEmail: value.defaultEmail ?? null,
    effective: {
      /** With no channels: where critical alerts are mailed (null: the drawer only). */
      criticalEmail: fallback,
      note:
        value.channels.length > 0
          ? null
          : fallback
            ? `Critical alerts are mailed to ${fallback}. Add channels to choose what goes where.`
            : "Alerts only show in the app. Add an email channel (or claim the workspace) so a critical one reaches someone.",
    },
  }
})

/** `PUT /v1/settings/alerts`: replaces the channels. Webhook targets must be existing endpoints. */
export const putAlertSettings = Effect.fn("alertSettings.put")(function* (value: AlertSettings) {
  for (const [i, c] of value.channels.entries()) {
    if (c.kind === "email" && !EMAIL.test(c.target.trim()))
      return yield* new AlertSettingsInvalid({
        field: `channels[${i}].target`,
        message: `${c.target} isn't an email address.`,
      })
  }
  if (value.defaultEmail && !EMAIL.test(value.defaultEmail.trim()))
    return yield* new AlertSettingsInvalid({
      field: "defaultEmail",
      message: `${value.defaultEmail} isn't an email address.`,
    })
  const database = yield* Database
  for (const [i, c] of value.channels.entries()) {
    if (c.kind !== "webhook") continue
    const endpoint = yield* database.query("alerts.channelEndpoint", (db) =>
      db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, c.target))
        .get(),
    )
    if (!endpoint)
      return yield* new AlertSettingsInvalid({
        field: `channels[${i}].target`,
        message: `No webhook endpoint ${c.target}.`,
      })
  }
  const stored: AlertSettings = {
    channels: value.channels.map((c) => ({
      ...c,
      target: c.kind === "email" ? c.target.trim().toLowerCase() : c.target,
    })),
    ...(value.defaultEmail !== undefined
      ? { defaultEmail: value.defaultEmail?.trim().toLowerCase() ?? null }
      : {}),
  }
  const now = Date.now()
  yield* database.query("settings.alerts.put", (db) =>
    db
      .insert(settings)
      .values({ key: "alerts", value: stored, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: now } })
      .run(),
  )
  return yield* describeAlertSettings()
})

const takes = (c: AlertChannel, alert: { kind: string; severity: Severity }) =>
  rank(alert.severity) >= rank(c.minSeverity) &&
  (!c.kinds || c.kinds.length === 0 || c.kinds.some((k) => k === alert.kind))

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/**
 * Sends a just-opened (or just-escalated) alert to its channels. Called by `raiseAlert`; never fails
 * it. The link back to the app uses MAILYARD_PUBLIC_ORIGIN when it is set.
 */
export const notifyAlert = (alert: {
  readonly id: string
  readonly key: string
  readonly kind: string
  readonly severity: Severity
  readonly title: string
  readonly detail: string
  readonly subject: { readonly type: string; readonly id: string } | null
  readonly escalated: boolean
}) =>
  Effect.gen(function* () {
    const env = yield* Bindings
    const value = yield* getAlertSettings()
    const data = {
      alertId: alert.id,
      key: alert.key,
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      subject: alert.subject,
      escalated: alert.escalated,
    }
    // Every endpoint subscribed to alert.raised, as with any event.
    yield* emitSafely("alert.raised", data)
    // Webhook channels: their endpoint gets it even without subscribing, unless it already did.
    const database = yield* Database
    for (const c of value.channels.filter((x) => x.kind === "webhook" && takes(x, alert))) {
      const endpoint = yield* database.query("alerts.channelEndpointEvents", (db) =>
        db
          .select({ events: webhookEndpoints.events })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, c.target))
          .get(),
      )
      if (!endpoint || endpoint.events.includes("*") || endpoint.events.includes("alert.raised")) continue
      yield* emitSafely("alert.raised", data, c.target)
    }
    // Email: the channels that take it, or with none set, critical alerts to the default address.
    const to =
      value.channels.length > 0
        ? value.channels.filter((c) => c.kind === "email" && takes(c, alert)).map((c) => c.target)
        : alert.severity === "critical"
          ? [value.defaultEmail ?? (yield* ownerEmail())].filter((x): x is string => Boolean(x))
          : []
    const fromRaw = env.MAILYARD_SYSTEM_FROM ?? env.DEFAULT_FROM
    if (to.length === 0 || !fromRaw) return
    const from = parseParty(fromRaw)
    const origin = env.MAILYARD_PUBLIC_ORIGIN?.replace(/\/$/, "") ?? null
    const link = origin ? `${origin}/alerts` : null
    const verb = alert.escalated ? "is now" : "is"
    const subject = `[${alert.severity}] ${alert.title}`
    for (const address of [...new Set(to)]) {
      yield* sendBulkMessage({
        stream: "system",
        message: {
          from: from.name ? { email: from.email, name: from.name } : { email: from.email },
          to: [{ email: address }],
          subject: subject.slice(0, 998),
          html: `<p><strong>${esc(alert.title)}</strong> ${verb} ${alert.severity}.</p><p>${esc(alert.detail)}</p>${link ? `<p><a href="${esc(link)}">Open the alerts</a></p>` : ""}<p style="color:#666">Mailyard sends this because alerts are set to reach you. Change that in Settings, Alerts.</p>`,
          text: `${alert.title} ${verb} ${alert.severity}.\n\n${alert.detail}\n${link ? `\nOpen the alerts: ${link}\n` : ""}\nMailyard sends this because alerts are set to reach you. Change that in Settings, Alerts.\n`,
        },
        contactId: null,
        campaignId: null,
        idempotencyKey: `alert:${alert.id}:${alert.severity}:${address}`,
      })
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`alerts: could not send ${alert.key} to its channels`, cause),
    ),
  )

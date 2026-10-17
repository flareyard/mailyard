import { and, count, desc, eq, isNotNull, isNull, like, lt, or, type SQL } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { stopRunsForEmail } from "../automations/runs.ts"
import { Bindings } from "../Bindings.ts"
import { contacts, settings, suppressions } from "../db/schema.ts"
import { CloudflareEmail, type CloudflareSuppression } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { EMAIL, isBlocked, normalizeEmail } from "./contacts.ts"
import { emitSafely } from "./webhooks.ts"

/**
 * The suppression list (HAL-3372): addresses Mailyard won't send to, and how it stays in step with
 * Cloudflare's own Email Sending suppression list.
 *
 * - Bounces and complaints arrive from delivery events, Cloudflare refusals from the send path, and
 *   the rest from here: added by hand, imported from a CSV, or adopted from Cloudflare's list.
 * - A row blocks every stream, or only bulk mail (campaigns and automations) when `bulkOnly`.
 *   Unsubscribes are always bulk-only: someone who left a newsletter still gets their receipts.
 * - A complaint never clears for bulk mail. Removing one is refused; narrowing it to bulk-only is how
 *   transactional mail reaches that person again.
 * - Removing a suppression restores the contact's status from before it was blocked, and removes the
 *   address from Cloudflare's list too, where Mailyard holds a write token. Otherwise Cloudflare
 *   would keep refusing it and the removal would only look done.
 * - The hourly sync reads Cloudflare's whole list: it marks each row in-sync or missing, and adopts
 *   Cloudflare's permanent entries Mailyard didn't know about (a bounce whose event never arrived).
 */

export const REASONS = ["hard_bounce", "complaint", "unsubscribe", "manual"] as const
export type Reason = (typeof REASONS)[number]
export type SuppressionRow = typeof suppressions.$inferSelect
export type CloudflareState = "in-sync" | "missing" | "not-applicable" | "unchecked"

export class SuppressionNotFound extends Schema.TaggedError<SuppressionNotFound>()("SuppressionNotFound", {
  email: Schema.String,
}) {}
export class SuppressionInvalid extends Schema.TaggedError<SuppressionInvalid>()("SuppressionInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
/** A change the list refuses: removing a complaint, or pushing what Cloudflare shouldn't block. */
export class SuppressionRefused extends Schema.TaggedError<SuppressionRefused>()("SuppressionRefused", {
  reason: Schema.Literals(["complaint", "not-applicable"]),
  message: Schema.String,
}) {}
/** Cloudflare's list can't be changed: no write token, or Cloudflare said no. */
export class CloudflareUnavailable extends Schema.TaggedError<CloudflareUnavailable>()(
  "CloudflareUnavailable",
  {
    reason: Schema.Literals(["not-connected", "refused"]),
    status: Schema.Number,
    message: Schema.String,
  },
) {}

const SYNC_KEY = "suppressions.cloudflare"
/** At most this many pages of 1,000 per sync: 50,000 entries. */
const MAX_PAGES = 50
const SLICE = 500

export type SyncState = {
  readonly checkedAt: number | null
  /** Cloudflare's entries Mailyard doesn't hold: temporary ones (with an expiry), left to Cloudflare. */
  readonly cloudflareOnly: number
  readonly adopted: number
  readonly complete: boolean
  readonly error: string | null
}

const EMPTY_SYNC: SyncState = { checkedAt: null, cloudflareOnly: 0, adopted: 0, complete: false, error: null }

/** Whether Cloudflare's list agrees, for one row. */
export const cloudflareStateOf = (row: SuppressionRow): CloudflareState => {
  // Pushing these would block transactional mail too, which they mustn't.
  if (row.reason === "unsubscribe" || row.bulkOnly) return "not-applicable"
  if (row.cloudflareId) return "in-sync"
  return row.cloudflareCheckedAt !== null ? "missing" : "unchecked"
}

export const describeSuppression = (row: SuppressionRow) => ({
  email: row.email,
  reason: row.reason,
  source: row.source,
  messageId: row.messageId,
  note: row.note,
  bulkOnly: row.bulkOnly,
  streams: row.bulkOnly ? (["campaign", "automation"] as const) : (["all"] as const),
  cloudflare: cloudflareStateOf(row),
  at: row.at,
  updatedAt: row.updatedAt ?? row.at,
})
export type SuppressionView = ReturnType<typeof describeSuppression>

const checkEmail = (raw: string) =>
  Effect.gen(function* () {
    const email = normalizeEmail(raw)
    if (!EMAIL.test(email))
      return yield* new SuppressionInvalid({ field: "email", message: "Not an email address." })
    return email
  })

const findRow = (email: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("suppressions.get", (db) =>
      db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, normalizeEmail(email)))
        .get(),
    )
    if (!row) return yield* new SuppressionNotFound({ email: normalizeEmail(email) })
    return row
  })

const syncState = Effect.gen(function* () {
  const database = yield* Database
  const row = yield* database.query("suppressions.syncState", (db) =>
    db.select().from(settings).where(eq(settings.key, SYNC_KEY)).get(),
  )
  return row ? ({ ...EMPTY_SYNC, ...(row.value as Partial<SyncState>) } as SyncState) : EMPTY_SYNC
})

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const cursorOf = (row: SuppressionRow) => btoa(`${row.at}:${row.email}`)
const parseCursor = (cursor: string) => {
  try {
    const text = atob(cursor)
    const at = Number(text.slice(0, text.indexOf(":")))
    const email = text.slice(text.indexOf(":") + 1)
    return Number.isFinite(at) && email ? { at, email } : null
  } catch {
    return null
  }
}

export const listSuppressions = Effect.fn("suppressions.list")(function* (query: {
  readonly reason?: Reason | undefined
  readonly source?: SuppressionRow["source"] | undefined
  readonly cloudflare?: CloudflareState | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const conditions: Array<SQL | undefined> = []
  if (query.reason) conditions.push(eq(suppressions.reason, query.reason))
  if (query.source) conditions.push(eq(suppressions.source, query.source))
  if (query.q?.trim()) {
    const term = query.q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`)
    conditions.push(like(suppressions.email, `%${term}%`))
  }
  if (query.cloudflare === "not-applicable")
    conditions.push(or(eq(suppressions.reason, "unsubscribe"), eq(suppressions.bulkOnly, true)))
  else if (query.cloudflare) {
    const applicable = and(
      eq(suppressions.bulkOnly, false),
      or(
        eq(suppressions.reason, "hard_bounce"),
        eq(suppressions.reason, "complaint"),
        eq(suppressions.reason, "manual"),
      ),
    )
    conditions.push(
      and(
        applicable,
        query.cloudflare === "in-sync"
          ? isNotNull(suppressions.cloudflareId)
          : query.cloudflare === "missing"
            ? and(isNull(suppressions.cloudflareId), isNotNull(suppressions.cloudflareCheckedAt))
            : and(isNull(suppressions.cloudflareId), isNull(suppressions.cloudflareCheckedAt)),
      ),
    )
  }
  if (query.cursor) {
    const c = parseCursor(query.cursor)
    if (!c) return yield* new SuppressionInvalid({ field: "cursor", message: "Not a cursor from this list." })
    conditions.push(
      or(lt(suppressions.at, c.at), and(eq(suppressions.at, c.at), lt(suppressions.email, c.email))),
    )
  }
  const rows = yield* database.query("suppressions.list", (db) =>
    db
      .select()
      .from(suppressions)
      .where(and(...conditions))
      .orderBy(desc(suppressions.at), desc(suppressions.email))
      .limit(limit + 1)
      .all(),
  )
  const counts = yield* database.query("suppressions.counts", (db) =>
    db
      .select({ reason: suppressions.reason, n: count() })
      .from(suppressions)
      .groupBy(suppressions.reason)
      .all(),
  )
  const byReason = Object.fromEntries(
    REASONS.map((r) => [r, counts.find((c) => c.reason === r)?.n ?? 0]),
  ) as Record<Reason, number>
  const cf = yield* CloudflareEmail
  const sync = yield* syncState
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    suppressions: page.map(describeSuppression),
    counts: { total: REASONS.reduce((n, r) => n + byReason[r], 0), ...byReason },
    cloudflare: {
      readable: cf.suppressions.canRead,
      writable: cf.suppressions.canWrite,
      checkedAt: sync.checkedAt,
      cloudflareOnly: sync.cloudflareOnly,
      error: sync.error,
    },
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  }
})

/** One suppression, with the contact it blocks and Cloudflare's own entries for the address. */
export const getSuppression = Effect.fn("suppressions.get")(function* (raw: string) {
  const row = yield* findRow(raw)
  const database = yield* Database
  const contact = yield* database.query("suppressions.contact", (db) =>
    db
      .select({ id: contacts.id, status: contacts.status })
      .from(contacts)
      .where(eq(contacts.email, row.email))
      .get(),
  )
  const cf = yield* CloudflareEmail
  const entries = yield* cf.suppressions.find(row.email)
  return {
    ...describeSuppression(row),
    contact: contact ? { id: contact.id, status: contact.status } : null,
    contactStatusBefore: row.contactStatusBefore,
    cloudflareEntries: Option.match(entries, {
      onNone: () => null,
      onSome: (list) => list.map(describeCloudflareEntry),
    }),
  }
})

const describeCloudflareEntry = (e: CloudflareSuppression) => ({
  id: e.id,
  reason: e.reason,
  scope: e.scope?.type === "sending_domain" ? `domain:${e.scope.value ?? ""}` : "account",
  expiresAt: e.expires_at ? Date.parse(e.expires_at) : null,
  readOnly: e.read_only === true,
})

// ---------------------------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------------------------

/** Blocks the contact for the suppression just added, remembering what its status was. */
const blockContact = (email: string, reason: Reason) =>
  Effect.gen(function* () {
    const database = yield* Database
    const contact = yield* database.query("suppressions.contactBefore", (db) =>
      db
        .select({ id: contacts.id, status: contacts.status })
        .from(contacts)
        .where(eq(contacts.email, email))
        .get(),
    )
    if (!contact || isBlocked(contact.status)) return contact?.status ?? null
    // An unsubscribe only ends bulk mail, which is exactly what the contact's unsubscribed status says.
    const next = reason === "unsubscribe" ? "unsubscribed" : "suppressed"
    if (contact.status !== next)
      yield* database.query("suppressions.blockContact", (db) =>
        db.update(contacts).set({ status: next }).where(eq(contacts.id, contact.id)).run(),
      )
    return contact.status
  })

export type AddInput = {
  readonly email: string
  readonly reason?: Reason | undefined
  readonly note?: string | null | undefined
  readonly bulkOnly?: boolean | undefined
  /** Also add it to Cloudflare's list. */
  readonly push?: boolean | undefined
}

/**
 * `POST /v1/suppressions`. An address already on the list keeps its reason (a hand-added row never
 * downgrades a complaint); only a new note is taken.
 */
export const addSuppression = Effect.fn("suppressions.add")(function* (input: AddInput, actor: string) {
  const email = yield* checkEmail(input.email)
  const reason = input.reason ?? "manual"
  const note = input.note?.trim().slice(0, 1000) || null
  const database = yield* Database
  const now = Date.now()
  const existing = yield* database.query("suppressions.existing", (db) =>
    db.select().from(suppressions).where(eq(suppressions.email, email)).get(),
  )
  if (existing) {
    const row =
      note && note !== existing.note
        ? yield* database.query("suppressions.note", (db) =>
            db
              .update(suppressions)
              .set({ note, updatedAt: now })
              .where(eq(suppressions.email, email))
              .returning()
              .get(),
          )
        : existing
    return { suppression: describeSuppression(row ?? existing), created: false, cloudflare: null }
  }
  const before = yield* blockContact(email, reason)
  const row = yield* database.query("suppressions.insert", (db) =>
    db
      .insert(suppressions)
      .values({
        email,
        reason,
        source: "manual",
        note,
        bulkOnly: reason === "unsubscribe" || input.bulkOnly === true,
        contactStatusBefore: before && !isBlocked(before) ? before : null,
        at: now,
        updatedAt: now,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "suppression.add", target: email, after: describeSuppression(row) })
  yield* emitSafely("contact.suppressed", { email, reason, source: "manual", bulkOnly: row.bulkOnly })
  if (!row.bulkOnly) yield* stopRunsForEmail(email, "The address was added to the suppression list.")
  const cloudflare = input.push
    ? yield* pushSuppression(email, actor).pipe(
        Effect.map((r) => r.cloudflare as { readonly state: string; readonly message: string | null }),
        Effect.catchTags({
          SuppressionNotFound: (e) => Effect.succeed(pushOutcome(e)),
          SuppressionRefused: (e) => Effect.succeed(pushOutcome(e)),
          CloudflareUnavailable: (e) => Effect.succeed(pushOutcome(e)),
        }),
      )
    : null
  const latest = yield* findRow(email)
  return { suppression: describeSuppression(latest), created: true, cloudflare }
})

const pushOutcome = (e: SuppressionNotFound | SuppressionRefused | CloudflareUnavailable) =>
  ({
    state: e._tag === "CloudflareUnavailable" ? e.reason : "not-applicable",
    message: "message" in e ? e.message : "Not on the list.",
  }) as const

/** `PATCH /v1/suppressions/{email}`: the note, and whether it blocks every stream or only bulk mail. */
export const updateSuppression = Effect.fn("suppressions.update")(function* (
  raw: string,
  patch: { readonly note?: string | null | undefined; readonly bulkOnly?: boolean | undefined },
  actor: string,
) {
  const row = yield* findRow(raw)
  if (patch.bulkOnly === false && row.reason === "unsubscribe")
    return yield* new SuppressionInvalid({
      field: "bulkOnly",
      message: "An unsubscribe only stops bulk mail; add a manual suppression to block everything.",
    })
  const database = yield* Database
  const changed = yield* database.query("suppressions.update", (db) =>
    db
      .update(suppressions)
      .set({
        ...(patch.note !== undefined ? { note: patch.note?.trim().slice(0, 1000) || null } : {}),
        ...(patch.bulkOnly !== undefined ? { bulkOnly: patch.bulkOnly } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(suppressions.email, row.email))
      .returning()
      .get(),
  )
  const after = changed ?? row
  yield* recordAudit({
    actor,
    action: "suppression.update",
    target: row.email,
    before: describeSuppression(row),
    after: describeSuppression(after),
  })
  // Narrowed to bulk mail: Cloudflare's account-wide entry would still block transactional mail.
  let cloudflare: RemovalOutcome | null = null
  if (after.bulkOnly && !row.bulkOnly) cloudflare = yield* removeFromCloudflare(row.email, after)
  return { suppression: describeSuppression(yield* findRow(row.email)), cloudflare }
})

export type RemovalOutcome = {
  /**
   * `removed`: Cloudflare's entries for the address are gone. `not-listed`: it had none.
   * `read-only`: Cloudflare keeps an entry it won't let anyone delete. `not-connected`: no write
   * token, so Cloudflare may still refuse the address. `failed`: Cloudflare said no.
   */
  readonly state: "removed" | "not-listed" | "read-only" | "not-connected" | "failed"
  readonly message: string | null
}

const removeFromCloudflare = (email: string, row: SuppressionRow) =>
  Effect.gen(function* () {
    const cf = yield* CloudflareEmail
    const database = yield* Database
    const entries = yield* cf.suppressions.find(email)
    if (Option.isNone(entries)) {
      return {
        state: "not-connected",
        message: row.cloudflareId
          ? "Cloudflare's list still has this address; set CLOUDFLARE_EMAIL_WRITE_TOKEN so Mailyard can remove it, or remove it in the dashboard."
          : "Mailyard can't read Cloudflare's list, so it may still refuse this address.",
      } satisfies RemovalOutcome
    }
    if (entries.value.length === 0) return { state: "not-listed", message: null } satisfies RemovalOutcome
    const deletable = entries.value.filter((e) => e.read_only !== true)
    if (deletable.length > 0 && !cf.suppressions.canWrite)
      return {
        state: "not-connected",
        message: `Cloudflare's list has ${entries.value.length} ${entries.value.length === 1 ? "entry" : "entries"} for this address; set CLOUDFLARE_EMAIL_WRITE_TOKEN so Mailyard can remove ${entries.value.length === 1 ? "it" : "them"}.`,
      } satisfies RemovalOutcome
    for (const e of deletable) {
      const done = yield* cf.suppressions.remove(e.id)
      if (!done.ok && done.status !== 404)
        return { state: "failed", message: done.message } satisfies RemovalOutcome
    }
    yield* database.query("suppressions.cloudflareCleared", (db) =>
      db
        .update(suppressions)
        .set({ cloudflareId: null, cloudflareCheckedAt: Date.now() })
        .where(eq(suppressions.email, email))
        .run(),
    )
    return deletable.length < entries.value.length
      ? ({
          state: "read-only",
          message:
            "Cloudflare keeps a read-only entry for this address and will go on refusing it until it expires.",
        } satisfies RemovalOutcome)
      : ({ state: "removed", message: null } satisfies RemovalOutcome)
  })

/**
 * `DELETE /v1/suppressions/{email}` with `confirm: true`. Complaints are refused: a complaint is
 * permanent for bulk mail, and narrowing it to bulk-only is how transactional mail gets through.
 */
export const removeSuppression = Effect.fn("suppressions.remove")(function* (
  raw: string,
  input: { readonly confirm?: boolean | undefined },
  actor: string,
) {
  if (input.confirm !== true)
    return yield* new SuppressionInvalid({
      field: "confirm",
      message: "Removing a suppression lets mail go to the address again; send confirm: true.",
    })
  const row = yield* findRow(raw)
  if (row.reason === "complaint")
    return yield* new SuppressionRefused({
      reason: "complaint",
      message: row.bulkOnly
        ? "This person complained, so bulk mail stays off for good. Transactional mail already reaches them."
        : "This person complained, so bulk mail stays off for good. To let transactional mail through, set bulkOnly: true.",
    })
  const cloudflare = yield* removeFromCloudflare(row.email, row)
  const database = yield* Database
  yield* database.query("suppressions.delete", (db) =>
    db.delete(suppressions).where(eq(suppressions.email, row.email)).run(),
  )
  const contact = yield* database.query("suppressions.contactAfter", (db) =>
    db
      .select({ id: contacts.id, status: contacts.status })
      .from(contacts)
      .where(eq(contacts.email, row.email))
      .get(),
  )
  let contactStatus: string | null = contact?.status ?? null
  if (contact && (contact.status === "suppressed" || contact.status === "bounced")) {
    // Rows from before HAL-3372 don't know: a bounced or suppressed contact had been sendable, so
    // subscribed is the status it was blocked from. A complaint never gets here.
    const restored = (row.contactStatusBefore ?? "subscribed") as typeof contact.status
    yield* database.query("suppressions.restoreContact", (db) =>
      db.update(contacts).set({ status: restored }).where(eq(contacts.id, contact.id)).run(),
    )
    contactStatus = restored
  }
  yield* recordAudit({
    actor,
    action: "suppression.remove",
    target: row.email,
    before: describeSuppression(row),
    after: { contactStatus, cloudflare: cloudflare.state },
  })
  yield* emitSafely("contact.unsuppressed", { email: row.email, reason: row.reason, contactStatus })
  return { email: row.email, removed: true, contactStatus, cloudflare }
})

/** `POST /v1/suppressions/{email}/push`: adds the address to Cloudflare's list, account-wide. */
export const pushSuppression = Effect.fn("suppressions.push")(function* (raw: string, actor: string) {
  const row = yield* findRow(raw)
  if (row.reason === "unsubscribe" || row.bulkOnly)
    return yield* new SuppressionRefused({
      reason: "not-applicable",
      message:
        "This suppression only stops bulk mail. Cloudflare's list blocks every message, transactional ones too, so it isn't pushed.",
    })
  const cf = yield* CloudflareEmail
  if (!cf.suppressions.canWrite)
    return yield* new CloudflareUnavailable({
      reason: "not-connected",
      status: 0,
      message:
        "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_WRITE_TOKEN (Email Sending: Edit) to push to Cloudflare.",
    })
  const database = yield* Database
  const found = Option.getOrElse(yield* cf.suppressions.find(row.email), () => [])
  const account = found.find((e) => e.scope?.type !== "sending_domain")
  let id = account?.id ?? null
  if (!id) {
    const created = yield* cf.suppressions.create(
      row.email,
      `Mailyard: ${row.reason}${row.note ? `. ${row.note}` : ""}`,
    )
    if (!created.ok)
      return yield* new CloudflareUnavailable({
        reason: "refused",
        status: created.status,
        message: created.message,
      })
    id = created.value.id
  }
  const now = Date.now()
  const updated = yield* database.query("suppressions.pushed", (db) =>
    db
      .update(suppressions)
      .set({ cloudflareId: id, syncedToCloudflare: true, cloudflareCheckedAt: now, updatedAt: now })
      .where(eq(suppressions.email, row.email))
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "suppression.push", target: row.email, after: { cloudflareId: id } })
  return {
    suppression: describeSuppression(updated ?? row),
    cloudflare: { state: account ? ("already-listed" as const) : ("pushed" as const), message: null },
  }
})

// ---------------------------------------------------------------------------------------------
// Keeping in step with Cloudflare
// ---------------------------------------------------------------------------------------------

const ADOPTABLE: Record<string, Reason> = {
  hard_bounce: "hard_bounce",
  complaint: "complaint",
  manual: "manual",
}

/**
 * Reads Cloudflare's whole list (up to 50,000 entries) and brings Mailyard's into step: each
 * applicable row gets Cloudflare's id or is marked missing, and Cloudflare's permanent bounces,
 * complaints and manual entries that Mailyard didn't know about are adopted, blocking their
 * contacts. Temporary entries (an expiry, usually soft bounces) are left to Cloudflare and counted.
 * Runs from the hourly cron and from `POST /v1/suppressions/sync`.
 */
export const syncWithCloudflare = Effect.fn("suppressions.sync")(function* () {
  const cf = yield* CloudflareEmail
  const database = yield* Database
  if (!cf.suppressions.canRead) return { connected: false as const, ...(yield* syncState) }
  const startedAt = Date.now()
  const byEmail = new Map<string, CloudflareSuppression>()
  let cursor: string | null = null
  let complete = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: Option.Option<{
      readonly items: ReadonlyArray<CloudflareSuppression>
      readonly next: string | null
    }> = yield* cf.suppressions.page(cursor)
    if (Option.isNone(result)) {
      const state: SyncState = {
        ...(yield* syncState),
        error: "Cloudflare's suppression list couldn't be read.",
      }
      yield* saveSync(state)
      return { connected: true as const, ...state }
    }
    for (const e of result.value.items) {
      const email = normalizeEmail(e.email)
      const seen = byEmail.get(email)
      // Prefer the account-wide entry, then a permanent one.
      if (
        !seen ||
        (seen.scope?.type === "sending_domain" && e.scope?.type !== "sending_domain") ||
        (seen.expires_at && !e.expires_at)
      )
        byEmail.set(email, e)
    }
    cursor = result.value.next
    if (!cursor) {
      complete = true
      break
    }
  }

  const local = new Set<string>()
  for (let offset = 0; ; offset += 5_000) {
    const rows = yield* database.query("suppressions.syncLocal", (db) =>
      db
        .select({ email: suppressions.email })
        .from(suppressions)
        .orderBy(suppressions.email)
        .limit(5_000)
        .offset(offset)
        .all(),
    )
    for (const r of rows) local.add(r.email)
    if (rows.length < 5_000) break
  }
  const matched: Array<{ email: string; id: string }> = []
  const adopt: Array<{ email: string; reason: Reason; id: string }> = []
  let cloudflareOnly = 0
  for (const [email, e] of byEmail) {
    if (local.has(email)) matched.push({ email, id: e.id })
    else if (!e.expires_at && ADOPTABLE[e.reason] && EMAIL.test(email))
      adopt.push({ email, reason: ADOPTABLE[e.reason] as Reason, id: e.id })
    else cloudflareOnly++
  }

  const { DB } = yield* Bindings
  const statements: Array<D1PreparedStatement> = []
  // A partial read can't say an address is missing, only that it was found.
  if (complete)
    statements.push(
      DB.prepare(
        "update suppressions set cloudflare_id = null, cloudflare_checked_at = ? where at <= ?",
      ).bind(startedAt, startedAt),
    )
  for (let i = 0; i < matched.length; i += SLICE)
    statements.push(
      DB.prepare(
        `update suppressions set cloudflare_id = json_extract(j.value, '$.id'), synced_to_cloudflare = 1, cloudflare_checked_at = ?
         from json_each(?) as j where suppressions.email = json_extract(j.value, '$.email')`,
      ).bind(startedAt, JSON.stringify(matched.slice(i, i + SLICE))),
    )
  for (let i = 0; i < adopt.length; i += SLICE) {
    const json = JSON.stringify(adopt.slice(i, i + SLICE))
    statements.push(
      DB.prepare(
        `insert into suppressions (email, reason, source, synced_to_cloudflare, note, contact_status_before, cloudflare_id, cloudflare_checked_at, at, updated_at)
         select json_extract(j.value, '$.email'), json_extract(j.value, '$.reason'), 'cloudflare', 1,
           'On Cloudflare''s suppression list; adopted by the sync.',
           (select c.status from contacts c where c.email = json_extract(j.value, '$.email')
             and c.status not in ('bounced', 'complained', 'suppressed')),
           json_extract(j.value, '$.id'), ?, ?, ?
         from json_each(?) as j where true
         on conflict(email) do nothing`,
      ).bind(startedAt, startedAt, startedAt, json),
      DB.prepare(
        `update contacts set status = case json_extract(j.value, '$.reason')
             when 'complaint' then 'complained' when 'hard_bounce' then 'bounced' else 'suppressed' end
         from json_each(?) as j
         where contacts.email = json_extract(j.value, '$.email') and contacts.status not in ('bounced', 'complained', 'suppressed')`,
      ).bind(json),
    )
  }
  if (statements.length > 0) yield* database.query("suppressions.syncBatch", () => DB.batch(statements))
  const state: SyncState = {
    checkedAt: startedAt,
    cloudflareOnly,
    adopted: adopt.length,
    complete,
    error: complete
      ? null
      : `Cloudflare's list is longer than ${MAX_PAGES * 1000} entries; only the first ${MAX_PAGES * 1000} were read.`,
  }
  yield* saveSync(state)
  if (adopt.length > 0)
    yield* recordAudit({
      actor: "system",
      action: "suppression.adopt",
      target: "cloudflare",
      after: { adopted: adopt.length, emails: adopt.slice(0, 20).map((a) => a.email) },
    })
  return { connected: true as const, matched: matched.length, ...state }
})

const saveSync = (state: SyncState) =>
  Effect.gen(function* () {
    const database = yield* Database
    const now = Date.now()
    yield* database.query("suppressions.saveSync", (db) =>
      db
        .insert(settings)
        .values({ key: SYNC_KEY, value: state, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: now } })
        .run(),
    )
  })

import { and, desc, eq, gte } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { automationSends, automations, contacts, events, messagesOut, subscriptions } from "../db/schema.ts"
import { engagementOf } from "../domain/contacts.ts"
import { isGroup, type Rule } from "../segments/rules.ts"
import { Database } from "../services/Database.ts"
import { AutomationNotFound, AutomationNotReady, publishedVersion } from "./automations.ts"
import { entryTriggerData } from "./entryData.ts"
import {
  DEFAULT_SETTINGS,
  Graph,
  nextNode,
  type Port,
  Settings,
  structuralIssues,
  triggerOf,
} from "./graph.ts"
import { missingDetail, renderAutomationMail } from "./mail.ts"
import { runStep, type SendInput, type SendResult, type StepContext } from "./steps/index.ts"

/**
 * The dry run (HAL-3301): one contact (real, or made up) walked through an automation version in
 * simulated time, with the same step files the real runs use (src/automations/steps), so it can't
 * drift from production. Every send is rendered (subject and preview) and nothing is sent or
 * written. Events can be injected at offsets; `assume` settles a branch or a wait the events don't.
 */

const MINUTE = 60_000
const DAY = 86_400_000
const MAX_STEPS = 500

export const DryRunInput = Schema.Struct({
  /** A real contact, or `contact` for a made-up one. */
  contactId: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(
    Schema.Struct({
      email: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      status: Schema.optionalKey(Schema.Literals(["subscribed", "unconfirmed"])),
      fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  /** The draft (default), or a published version. */
  version: Schema.optionalKey(Schema.Union([Schema.Literal("draft"), Schema.Number])),
  /** Events the contact does, minutes after the run starts. */
  events: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        afterMinutes: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 525_600 })),
        data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ).check(Schema.isMaxLength(50)),
  ),
  /** Per node: settle a branch (`yes`/`no`) or a wait for an event (`happens`/`times-out`). */
  assume: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Literals(["yes", "no", "happens", "times-out"])),
  ),
  /** The trigger's data, for templates that use `trigger.*`. */
  triggerData: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type DryRunInput = typeof DryRunInput.Type

export type DryRunStep = {
  readonly nodeId: string
  readonly label: string | null
  readonly type: string
  readonly at: number
  readonly outcome:
    | "would-run"
    | "would-wait"
    | "yes"
    | "no"
    | "event"
    | "timed-out"
    | "would-send"
    | "skipped"
    | "deferred"
    | "exited"
    | "stopped"
  readonly detail: string
  readonly missing?: ReadonlyArray<string>
  readonly send?: { readonly to: string; readonly subject: string; readonly preview: string }
}

type SimContact = {
  id: string | null
  email: string
  name: string | null
  status: string
  fields: Record<string, unknown>
  createdAt: number
  lastEventAt: number | null
  lastOpenedAt: number | null
  lastClickedAt: number | null
}

/** A rule tree evaluated against the simulated contact, its injected events and the real history. */
const evaluate = (
  rule: Rule,
  c: SimContact,
  now: number,
  facts: {
    readonly eventsAt: (name: string, since: number, until: number) => number
    readonly topicState: (topicId: string) => string | null
    /** Campaign mail the contact received, opened or clicked: one campaign, or any; optionally since `since`. */
    readonly campaign: (campaignId: string | undefined, activity: string, since?: number) => boolean
  },
): boolean => {
  if (isGroup(rule)) {
    const results = rule.rules.map((r) => evaluate(r, c, now, facts))
    return rule.type === "all" ? results.every(Boolean) : results.some(Boolean)
  }
  switch (rule.type) {
    case "field": {
      const raw = rule.field === "email" ? c.email : rule.field === "name" ? c.name : c.fields[rule.field]
      const exists = raw !== undefined && raw !== null && raw !== ""
      if (rule.op === "exists") return exists
      if (rule.op === "missing") return !exists
      if (!exists) return rule.op === "neq" || rule.op === "notContains"
      if (rule.op === "in")
        return (Array.isArray(rule.value) ? rule.value : []).some((x) =>
          typeof x === "string" ? String(raw).toLowerCase() === x.toLowerCase() : raw === x,
        )
      const v = rule.value
      const text = String(raw).toLowerCase()
      const want = String(v ?? "").toLowerCase()
      const num = Number(raw)
      const wantNum = Number(v)
      switch (rule.op) {
        case "eq":
          return typeof v === "number"
            ? num === v
            : typeof v === "boolean"
              ? String(raw) === String(v)
              : text === want
        case "neq":
          return text !== want
        case "contains":
          return text.includes(want)
        case "notContains":
          return !text.includes(want)
        case "startsWith":
          return text.startsWith(want)
        case "endsWith":
          return text.endsWith(want)
        case "gt":
          return num > wantNum
        case "gte":
          return num >= wantNum
        case "lt":
          return num < wantNum
        case "lte":
          return num <= wantNum
      }
      return false
    }
    case "status":
      return rule.in.includes(c.status as never)
    case "topic": {
      const state = facts.topicState(rule.topicId)
      const match = state === (rule.state ?? "subscribed")
      return rule.is === false ? !match : match
    }
    case "event": {
      const since = rule.withinDays ? now - rule.withinDays * DAY : 0
      const times = facts.eventsAt(rule.name, since, now)
      const atLeast = rule.atLeast ?? 1
      return rule.did === false ? times < atLeast : times >= atLeast
    }
    case "engagement":
      return rule.in.includes(
        engagementOf(
          {
            lastEventAt: c.lastEventAt,
            lastOpenedAt: c.lastOpenedAt,
            lastClickedAt: c.lastClickedAt,
            createdAt: c.createdAt,
          } as never,
          now,
        ),
      )
    case "campaign": {
      const did = facts.campaign(
        rule.campaignId,
        rule.activity,
        rule.withinDays ? now - rule.withinDays * DAY : undefined,
      )
      return rule.did === false ? !did : did
    }
    case "created":
      return (
        (rule.withinDays === undefined || c.createdAt >= now - rule.withinDays * DAY) &&
        (rule.olderThanDays === undefined || c.createdAt < now - rule.olderThanDays * DAY)
      )
  }
}

export const dryRun = Effect.fn("automations.dryRun")(function* (automationId: string, input: DryRunInput) {
  const database = yield* Database
  const a = yield* database.query("dryRun.automation", (db) =>
    db.select().from(automations).where(eq(automations.id, automationId)).get(),
  )
  if (!a) return yield* new AutomationNotFound({ id: automationId })
  const which = input.version ?? "draft"
  const { graph, settings } =
    which === "draft"
      ? {
          graph: Schema.decodeUnknownSync(Graph)(a.graph),
          settings: a.settings ? Schema.decodeUnknownSync(Settings)(a.settings) : DEFAULT_SETTINGS,
        }
      : yield* publishedVersion(automationId, which)
  const structure = structuralIssues(graph)
  if (structure.length > 0) return yield* new AutomationNotReady({ issues: structure })

  // The contact: a real one as it is now, or the made-up one.
  const start = Date.now()
  let sim: SimContact
  if (input.contactId) {
    const id = input.contactId
    const row = yield* database.query("dryRun.contact", (db) =>
      db.select().from(contacts).where(eq(contacts.id, id)).get(),
    )
    if (!row) return yield* new AutomationNotFound({ id: `contact ${id}` })
    sim = {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      fields: { ...row.fields },
      createdAt: row.createdAt,
      lastEventAt: row.lastEventAt,
      lastOpenedAt: row.lastOpenedAt,
      lastClickedAt: row.lastClickedAt,
    }
  } else {
    const c = input.contact ?? { email: "someone@example.com" }
    sim = {
      id: null,
      email: c.email,
      name: c.name ?? null,
      status: c.status ?? "subscribed",
      fields: { ...(c.fields ?? {}) },
      createdAt: start,
      lastEventAt: null,
      lastOpenedAt: null,
      lastClickedAt: null,
    }
  }

  // What's already true for a real contact: events, topic states, campaign activity, recent automation sends.
  const realEvents = sim.id
    ? yield* database.query("dryRun.events", (db) =>
        db
          .select({ name: events.name, at: events.at })
          .from(events)
          .where(eq(events.contactId, sim.id as string))
          .orderBy(desc(events.at))
          .limit(1_000)
          .all(),
      )
    : []
  const realTopics = sim.id
    ? yield* database.query("dryRun.topics", (db) =>
        db
          .select({ topicId: subscriptions.topicId, state: subscriptions.state })
          .from(subscriptions)
          .where(eq(subscriptions.contactId, sim.id as string))
          .all(),
      )
    : []
  const topicStates = new Map(realTopics.map((t) => [t.topicId, t.state as string]))
  const campaignRows = sim.id
    ? yield* database.query("dryRun.campaigns", (db) =>
        db
          .select({
            campaignId: messagesOut.campaignId,
            stream: messagesOut.stream,
            createdAt: messagesOut.createdAt,
            status: messagesOut.status,
            opened: messagesOut.firstOpenedAt,
            clicked: messagesOut.firstClickedAt,
          })
          .from(messagesOut)
          .where(eq(messagesOut.contactId, sim.id as string))
          .all(),
      )
    : []
  const priorSends = sim.id
    ? (yield* database.query("dryRun.cadence", (db) =>
        db
          .select({ at: automationSends.at })
          .from(automationSends)
          .where(
            and(eq(automationSends.contactId, sim.id as string), gte(automationSends.at, start - 365 * DAY)),
          )
          .all(),
      )).map((r) => r.at)
    : []
  const injected = (input.events ?? []).map((e) => ({ name: e.name, at: start + e.afterMinutes * MINUTE }))
  const allEvents = [...realEvents, ...injected]
  const facts = {
    eventsAt: (name: string, since: number, until: number) =>
      allEvents.filter((e) => e.name === name && e.at >= since && e.at <= until).length,
    topicState: (topicId: string) => topicStates.get(topicId) ?? null,
    campaign: (campaignId: string | undefined, activity: string, since?: number) =>
      campaignRows.some(
        (r) =>
          (campaignId ? r.campaignId === campaignId : r.stream === "campaign") &&
          (since === undefined || r.createdAt >= since) &&
          (activity === "received"
            ? r.status === "sent" || r.status === "delivered"
            : activity === "opened"
              ? r.opened !== null
              : r.clicked !== null),
      ),
  }
  const assume = input.assume ?? {}
  const simulatedSends: Array<number> = []
  const path: Array<DryRunStep> = []
  const origin = a.origin ?? "https://example.invalid"
  let now = start
  let pendingSend: DryRunStep["send"] | undefined

  const ctxFor = (nodeId: string): StepContext => ({
    now,
    runStartedAt: start,
    contact: {
      id: sim.id ?? "dry-run",
      email: sim.email,
      name: sim.name,
      status: sim.status,
      fields: sim.fields,
    },
    settings,
    matches: async (rule) => {
      const forced = assume[nodeId]
      if (forced === "yes" || forced === "no") return forced === "yes"
      return evaluate(rule, sim, now, facts)
    },
    didEvent: async (event, since) => {
      const forced = assume[nodeId]
      if (forced === "yes" || forced === "no") return forced === "yes"
      return facts.eventsAt(event, since, now) > 0
    },
    send: (input: SendInput) => simulateSend(input),
    updateFields: async (fields) => {
      for (const [k, v] of Object.entries(fields)) {
        if (v === null) delete sim.fields[k]
        else sim.fields[k] = v
      }
    },
    setTopic: async (topicId, action) => {
      topicStates.set(topicId, action === "subscribe" ? "subscribed" : "unsubscribed")
    },
    webhook: async () => ({ status: 200 }),
  })

  // A send, rendered for real and recorded, never delivered.
  const renderLayer = yield* Effect.context<Effect.Services<ReturnType<typeof renderAutomationMail>>>()
  // What the run would carry as `trigger`: the given data, or what the trigger kind fills in (HAL-3411).
  const triggerData = yield* entryTriggerData(
    triggerOf(graph)?.config,
    { createdAt: sim.createdAt, fields: sim.fields },
    input.triggerData ?? null,
    start,
  )
  const simulateSend = async (send: SendInput): Promise<SendResult> => {
    pendingSend = undefined
    if (["bounced", "complained", "suppressed"].includes(sim.status))
      return { status: "skipped", reason: "suppressed", detail: `${sim.email} is ${sim.status}.` }
    if (sim.status === "unsubscribed")
      return { status: "skipped", reason: "unsubscribed", detail: "The contact unsubscribed." }
    if (send.topicId && topicStates.get(send.topicId) === "unsubscribed")
      return { status: "skipped", reason: "unsubscribed", detail: "The contact left this topic." }
    if (!send.fromAddress) return { status: "skipped", reason: "suppressed", detail: "No sender is set." }
    const cap = settings.cadence
    if (cap) {
      const inWindow = [...priorSends, ...simulatedSends].filter((at) => at > now - cap.days * DAY).length
      if (inWindow >= cap.max)
        return {
          status: "skipped",
          reason: "cadence",
          detail: `The contact would already have had ${cap.max} automation email${cap.max === 1 ? "" : "s"} in ${cap.days} days.`,
        }
    }
    const render = renderAutomationMail({
      templateId: send.templateId,
      version: send.version,
      subject: send.subject,
      fromAddress: send.fromAddress,
      topicId: send.topicId,
      origin,
      automationName: a.name,
      contact: { id: sim.id ?? "dry-run", email: sim.email, name: sim.name, fields: sim.fields },
      triggerData,
    })
    const rendered = await Effect.runPromiseWith(renderLayer)(
      render.pipe(
        Effect.map((mail) => ({ mail })),
        Effect.catchTag("MissingMergeData", (e) =>
          Effect.succeed({
            skipped: {
              status: "skipped",
              reason: "missing_data",
              detail: missingDetail(e.missing),
              missing: e.missing,
            } satisfies SendResult,
          }),
        ),
      ),
    )
    if ("skipped" in rendered) return rendered.skipped
    const { mail } = rendered
    simulatedSends.push(now)
    pendingSend = { to: sim.email, subject: mail.message.subject, preview: mail.preview }
    return { status: "sent", messageId: "dry-run", subject: mail.message.subject, preview: mail.preview }
  }

  let node: string | null = triggerOf(graph)?.id ?? null
  let endedBy: "exit" | "stop" | "limit" = "limit"
  for (let i = 0; i < MAX_STEPS && node !== null; i++) {
    const current = graph.nodes.find((n) => n.id === node)
    if (!current) break
    // The stop rules, as the real run checks them before every step.
    const stop = injected.find((e) => settings.stopEvents.includes(e.name) && e.at <= now)
    if (stop && current.type !== "trigger") {
      path.push({
        nodeId: current.id,
        label: current.label ?? null,
        type: current.type,
        at: now,
        outcome: "stopped",
        detail: `Stopped by ${stop.name}.`,
      })
      endedBy = "stop"
      break
    }
    const outcome = yield* Effect.promise(() => runStep(current, ctxFor(current.id)))
    const base = { nodeId: current.id, label: current.label ?? null, type: current.type, at: now }
    if (outcome.kind === "exit") {
      path.push({ ...base, outcome: "exited", detail: outcome.detail })
      endedBy = "exit"
      break
    }
    if (outcome.kind === "retry") {
      path.push({ ...base, outcome: "deferred", detail: outcome.detail })
      now = outcome.until
      continue
    }
    if (outcome.kind === "sleep") {
      path.push({ ...base, outcome: "would-wait", detail: outcome.detail })
      now = outcome.until
      node = nextNode(graph, current.id)
      continue
    }
    if (outcome.kind === "wait_event") {
      path.push({ ...base, outcome: "would-wait", detail: outcome.detail })
      const forced = assume[current.id]
      const arrives = injected
        .filter((e) => e.name === outcome.event && e.at >= now && e.at <= outcome.until)
        .sort((x, y) => x.at - y.at)[0]
      let port: Port
      if (forced === "happens" || (forced !== "times-out" && arrives)) {
        now = arrives?.at ?? now
        port = "event"
        path.push({ ...base, at: now, outcome: "event", detail: `${outcome.event} happened.` })
      } else {
        now = outcome.until
        port = "timeout"
        path.push({ ...base, at: now, outcome: "timed-out", detail: `No ${outcome.event} in time.` })
      }
      node = nextNode(graph, current.id, port)
      continue
    }
    if (current.type === "branch")
      path.push({ ...base, outcome: outcome.port === "yes" ? "yes" : "no", detail: outcome.detail })
    else if (current.type === "send")
      path.push({
        ...base,
        outcome: outcome.messageId ? "would-send" : "skipped",
        detail: outcome.detail,
        ...(outcome.missing ? { missing: outcome.missing } : {}),
        ...(outcome.messageId && pendingSend ? { send: pendingSend } : {}),
      })
    else path.push({ ...base, outcome: "would-run", detail: outcome.detail })
    node = nextNode(graph, current.id, outcome.port)
  }
  return {
    version: which,
    contact: { id: sim.id, email: sim.email },
    startedAt: start,
    endsAt: now,
    endedBy,
    sends: path.filter((p) => p.outcome === "would-send").length,
    path,
  }
})

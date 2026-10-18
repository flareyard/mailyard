import { and, count, desc, eq, gte, inArray, like, lt, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { trackingOrigin } from "../campaigns/compliance.ts"
import {
  automationRunSteps,
  automationRuns,
  automationSends,
  automations,
  contacts,
  events,
  segments,
  subscriptions,
} from "../db/schema.ts"
import { clearAlert, raiseAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { findContact, isBlocked, writeSubscription } from "../domain/contacts.ts"
import { parseParty, sendBulkMessage } from "../domain/outbox.ts"
import type { appLayer } from "../layers.ts"
import { compile, type Rule } from "../segments/rules.ts"
import { Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { publishedVersion } from "./automations.ts"
import { entryTriggerData } from "./entryData.ts"
import { type Graph, nextNode, type Port, type Settings, triggerOf } from "./graph.ts"
import { missingDetail, renderAutomationMail } from "./mail.ts"
import {
  runStep,
  type SendInput,
  type SendResult,
  type StepContext,
  type StepOutcome,
} from "./steps/index.ts"
import { dateTriggerData } from "./triggerData.ts"

/**
 * Automation runs (HAL-3300): who enters, and one AutomationRunWorkflow per run walking the
 * published graph. Each step is a durable step in the Workflow; this module is what those steps do.
 *
 * - Triggers are queued (`mailyard-automation-triggers`) by the places that cause them: a tracked
 *   event, a contact created by the API, a form or an event (not by a CSV import, which would mail
 *   a whole list at once), a topic subscription, a contact change (for segment triggers), and the
 *   hourly cron (date triggers, and the nightly segment sweep).
 * - Entry is idempotent: the run id is `automation-contact-entry`, so a duplicate trigger finds the
 *   run already there.
 * - Before every step the run is checked: an exit from the API, the automation paused, the contact
 *   gone, unsubscribed or blocked, or one of the stop events since the run began.
 * - Sends go through the governor and the outbox with the idempotency key `runId:nodeId`, and the
 *   cadence cap is one conditional insert, so it holds however many runs send at once.
 */

type AppServices = Layer.Success<ReturnType<typeof appLayer>>
type RunRow = typeof automationRuns.$inferSelect

export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", { id: Schema.String }) {}
export class RunInvalid extends Schema.TaggedError<RunInvalid>()("RunInvalid", { message: Schema.String }) {}

export const AUTOMATION_QUEUE_NAME = "mailyard-automation-triggers"

export const AutomationTriggerJob = Schema.Struct({
  kind: Schema.Literals(["event", "created", "topic", "segment", "enter"]),
  contactId: Schema.String,
  /** The event name, the topic id, or (for `enter`) the automation id. */
  key: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  at: Schema.Number,
})
export type AutomationTriggerJob = typeof AutomationTriggerJob.Type

const BLOCKED_OR_LEFT = ["unsubscribed", "bounced", "complained", "suppressed"]
const DAY = 86_400_000

const triggerKeyFor = (job: AutomationTriggerJob) =>
  job.kind === "event" ? `event:${job.key}` : job.kind === "topic" ? `topic:${job.key}` : job.kind

/**
 * Queues a trigger if any live automation listens for it. Never fails its caller: tracking an event
 * or creating a contact must not break because automations couldn't be told.
 */
export const fireTrigger = (job: Omit<AutomationTriggerJob, "at">) =>
  Effect.gen(function* () {
    const database = yield* Database
    const listening = yield* database.query("automations.listening", (db) =>
      db
        .select({ id: automations.id })
        .from(automations)
        .where(
          and(
            eq(automations.status, "live"),
            job.kind === "segment"
              ? like(automations.triggerKey, "segment:%")
              : eq(automations.triggerKey, triggerKeyFor({ ...job, at: 0 })),
          ),
        )
        .limit(1)
        .get(),
    )
    if (!listening) return
    const env = yield* Bindings
    yield* Effect.promise(() => env.AUTOMATION_QUEUE.send({ ...job, at: Date.now() }))
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("automations: could not queue a trigger", cause)))

/** Whether a contact matches a rule tree right now. */
export const contactMatches = (contactId: string, rule: Rule) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("automations.match", (db) =>
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), compile(rule)))
        .get(),
    )
    return row !== undefined
  })

const didEvent = (contactId: string, event: string, since: number) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("automations.didEvent", (db) =>
      db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.contactId, contactId), eq(events.name, event), gte(events.at, since)))
        .limit(1)
        .get(),
    )
    return row !== undefined
  })

export const runIdFor = (automationId: string, contactId: string, entry: number) =>
  `${automationId}-${contactId}-${entry}`

/**
 * Puts a contact into an automation's live version, unless they can't or shouldn't enter: not
 * live, the contact blocked or unsubscribed, the trigger's filter or segment not matched, already
 * in a run, or inside the re-entry window.
 */
export const enterAutomation = Effect.fn("automations.enter")(function* (
  automationId: string,
  contactId: string,
  data: Readonly<Record<string, unknown>> | null,
) {
  const database = yield* Database
  const a = yield* database.query("automations.enterGet", (db) =>
    db.select().from(automations).where(eq(automations.id, automationId)).get(),
  )
  if (!a || a.status !== "live" || a.publishedVersion === null) return "skipped: not live"
  const { graph, settings } = yield* publishedVersion(a.id, a.publishedVersion)
  const contact = yield* database.query("automations.enterContact", (db) =>
    db.select().from(contacts).where(eq(contacts.id, contactId)).get(),
  )
  if (!contact) return "skipped: no such contact"
  if (BLOCKED_OR_LEFT.includes(contact.status)) return `skipped: contact is ${contact.status}`
  const trigger = triggerOf(graph)?.config
  if (trigger?.kind === "event" && trigger.filter && !(yield* contactMatches(contactId, trigger.filter)))
    return "skipped: filter not matched"
  if (trigger?.kind === "segment") {
    const seg = yield* database.query("automations.enterSegment", (db) =>
      db.select({ filter: segments.filter }).from(segments).where(eq(segments.id, trigger.segmentId)).get(),
    )
    if (!seg || !(yield* contactMatches(contactId, seg.filter as Rule))) return "skipped: not in the segment"
  }
  const entryData = yield* entryTriggerData(
    trigger,
    { createdAt: contact.createdAt, fields: contact.fields as Readonly<Record<string, unknown>> },
    data,
    Date.now(),
  )
  const prior = yield* database.query("automations.prior", (db) =>
    db
      .select({ state: automationRuns.state, startedAt: automationRuns.startedAt })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.contactId, contactId)))
      .orderBy(desc(automationRuns.startedAt))
      .all(),
  )
  if (prior.some((p) => p.state === "running" || p.state === "waiting")) return "skipped: already in a run"
  const last = prior[0]
  if (last) {
    if (settings.reentry.mode === "never") return "skipped: re-entry is off"
    if (last.startedAt > Date.now() - settings.reentry.days * DAY)
      return "skipped: inside the re-entry window"
  }
  const runId = runIdFor(a.id, contactId, prior.length + 1)
  const now = Date.now()
  const inserted = yield* database.query("automations.insertRun", (db) =>
    db
      .insert(automationRuns)
      .values({
        id: runId,
        automationId: a.id,
        version: a.publishedVersion as number,
        contactId,
        workflowId: runId,
        state: "running",
        currentStep: triggerOf(graph)?.id ?? null,
        triggerData: entryData,
        startedAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: automationRuns.id })
      .all(),
  )
  if (inserted.length === 0) return `skipped: ${runId} exists`
  const env = yield* Bindings
  yield* Effect.tryPromise({
    try: async () => {
      const instance = await env.AUTOMATION_WORKFLOW.create({ id: runId, params: { runId } })
      ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchCause((cause) =>
      // Already created by an earlier attempt of this same job: fine. Anything else: undo the row so a retry can enter.
      String(cause).includes("already exists")
        ? Effect.void
        : database
            .query("automations.undoRun", (db) =>
              db.delete(automationRuns).where(eq(automationRuns.id, runId)).run(),
            )
            .pipe(Effect.andThen(Effect.failCause(cause))),
    ),
    // A Workflow that won't start is a fault: the trigger's queue message is retried.
    Effect.orDie,
  )
  return `entered: ${runId}`
})

/** The trigger queue's consumer: every live automation listening for this trigger, entered in turn. */
export const handleTrigger = Effect.fn("automations.trigger")(function* (job: AutomationTriggerJob) {
  const database = yield* Database
  const candidates =
    job.kind === "enter"
      ? [{ id: job.key ?? "" }]
      : yield* database.query("automations.candidates", (db) =>
          db
            .select({ id: automations.id })
            .from(automations)
            .where(
              and(
                eq(automations.status, "live"),
                job.kind === "segment"
                  ? like(automations.triggerKey, "segment:%")
                  : eq(automations.triggerKey, triggerKeyFor(job)),
              ),
            )
            .all(),
        )
  const results: Array<string> = []
  for (const c of candidates)
    results.push(`${c.id} ${yield* enterAutomation(c.id, job.contactId, job.data ?? null)}`)
  return results.join("; ") || "no automation listening"
})

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

const findRun = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const run = yield* database.query("runs.get", (db) =>
      db.select().from(automationRuns).where(eq(automationRuns.id, id)).get(),
    )
    if (!run) return yield* new RunNotFound({ id })
    return run
  })

/** Where a run (or a retry of it) starts: its current step and the next number in its history. */
export const loadRun = Effect.fn("runs.load")(function* (runId: string) {
  const run = yield* findRun(runId)
  const { graph } = yield* publishedVersion(run.automationId, run.version)
  return { node: run.currentStep ?? triggerOf(graph)?.id ?? "", seq: run.seq, state: run.state }
})

/** Before each step: carry on, hold (paused), or stop (and why). */
export const checkRun = Effect.fn("runs.check")(function* (runId: string) {
  const run = yield* findRun(runId)
  if (run.state === "exited" || run.state === "completed")
    return { verdict: "stop" as const, detail: `The run is ${run.state}.` }
  const database = yield* Database
  const a = yield* database.query("runs.automation", (db) =>
    db
      .select({ status: automations.status })
      .from(automations)
      .where(eq(automations.id, run.automationId))
      .get(),
  )
  if (!a) return { verdict: "stop" as const, detail: "The automation was deleted." }
  const contact = yield* database.query("runs.contact", (db) =>
    db.select({ status: contacts.status }).from(contacts).where(eq(contacts.id, run.contactId)).get(),
  )
  if (!contact) return { verdict: "stop" as const, detail: "The contact was deleted." }
  if (BLOCKED_OR_LEFT.includes(contact.status))
    return { verdict: "stop" as const, detail: `The contact is ${contact.status}.` }
  const { settings } = yield* publishedVersion(run.automationId, run.version)
  if (settings.stopEvents.length > 0) {
    const stop = yield* database.query("runs.stopEvent", (db) =>
      db
        .select({ name: events.name })
        .from(events)
        .where(
          and(
            eq(events.contactId, run.contactId),
            // d1: bounded: settings allow at most 20 stop events.
            inArray(events.name, [...settings.stopEvents]),
            gte(events.at, run.startedAt),
          ),
        )
        .limit(1)
        .get(),
    )
    if (stop) return { verdict: "stop" as const, detail: `Stopped by ${stop.name}.` }
  }
  if (a.status === "paused") return { verdict: "hold" as const, detail: "The automation is paused." }
  return { verdict: "go" as const, detail: "" }
})

/** What the Workflow does next after a step. Plain data, since it's a step's result. */
export type Executed = {
  readonly kind: StepOutcome["kind"]
  readonly next: string | null
  readonly seq: number
  readonly until: number | null
  readonly event: string | null
  readonly detail: string
}

const recordStep = (
  run: RunRow,
  seq: number,
  nodeId: string,
  outcome: "passed" | "waiting" | "sent" | "skipped" | "exited" | "failed",
  detail: string,
  extra: { readonly port?: Port | undefined; readonly messageId?: string | undefined } = {},
) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("runs.step", (db) =>
      db
        .insert(automationRunSteps)
        .values({
          runId: run.id,
          seq,
          automationId: run.automationId,
          nodeId,
          outcome,
          port: extra.port ?? null,
          detail: detail.slice(0, 500),
          messageId: extra.messageId ?? null,
          at: Date.now(),
        })
        .onConflictDoNothing()
        .run(),
    )
  })

const setRun = (runId: string, patch: Partial<typeof automationRuns.$inferInsert>) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("runs.set", (db) =>
      db
        .update(automationRuns)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(automationRuns.id, runId))
        .run(),
    )
  })

/** The workflow-safe name for waiting on an event. */
export const eventTypeFor = (event: string) => `ev-${event.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 90)}`

/**
 * Runs one step of a run: the real StepContext over the database, the governor and the outbox,
 * then the history row and the run's new position. Safe to repeat: the history row is keyed by
 * (run, seq) and a send by `runId:nodeId`.
 */
export const executeNode = Effect.fn("runs.execute")(function* (runId: string, nodeId: string, seq: number) {
  const run = yield* findRun(runId)
  const { graph, settings } = yield* publishedVersion(run.automationId, run.version)
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) {
    yield* setRun(runId, {
      state: "failed",
      error: `Step ${nodeId} isn't in version ${run.version}.`,
      finishedAt: Date.now(),
    })
    return {
      kind: "exit",
      next: null,
      seq,
      until: null,
      event: null,
      detail: "Unknown step.",
    } satisfies Executed
  }
  const services = yield* Effect.context<AppServices>()
  const ctx = yield* makeContext(run, graph, settings, nodeId, services)
  const outcome = yield* Effect.promise(() => runStep(node, ctx))
  const nextSeq = seq + 1
  const sent = outcome.kind === "next" && outcome.messageId !== undefined
  const skipped = node.type === "send" && outcome.kind === "next" && !sent
  if (outcome.kind === "exit") {
    yield* recordStep(run, seq, nodeId, "exited", outcome.detail)
    yield* setRun(runId, {
      state: "completed",
      currentStep: nodeId,
      seq: nextSeq,
      nextAt: null,
      waitingEvent: null,
      finishedAt: Date.now(),
    })
    return {
      kind: "exit",
      next: null,
      seq: nextSeq,
      until: null,
      event: null,
      detail: outcome.detail,
    } satisfies Executed
  }
  if (outcome.kind === "retry") {
    yield* recordStep(run, seq, nodeId, "waiting", outcome.detail)
    yield* setRun(runId, { state: "waiting", currentStep: nodeId, seq: nextSeq, nextAt: outcome.until })
    return {
      kind: "retry",
      next: nodeId,
      seq: nextSeq,
      until: outcome.until,
      event: null,
      detail: outcome.detail,
    } satisfies Executed
  }
  if (outcome.kind === "sleep") {
    const next = nextNode(graph, nodeId)
    yield* recordStep(run, seq, nodeId, "waiting", outcome.detail)
    yield* setRun(runId, { state: "waiting", currentStep: next, seq: nextSeq, nextAt: outcome.until })
    return {
      kind: "sleep",
      next,
      seq: nextSeq,
      until: outcome.until,
      event: null,
      detail: outcome.detail,
    } satisfies Executed
  }
  if (outcome.kind === "wait_event") {
    yield* recordStep(run, seq, nodeId, "waiting", outcome.detail)
    yield* setRun(runId, {
      state: "waiting",
      currentStep: nodeId,
      seq: nextSeq,
      nextAt: outcome.until,
      waitingEvent: outcome.event,
    })
    return {
      kind: "wait_event",
      next: null,
      seq: nextSeq,
      until: outcome.until,
      event: outcome.event,
      detail: outcome.detail,
    } satisfies Executed
  }
  const next = nextNode(graph, nodeId, outcome.port)
  yield* recordStep(run, seq, nodeId, sent ? "sent" : skipped ? "skipped" : "passed", outcome.detail, {
    port: outcome.port,
    messageId: outcome.messageId,
  })
  yield* setRun(runId, {
    state: "running",
    currentStep: next,
    seq: nextSeq,
    nextAt: null,
    waitingEvent: null,
  })
  return {
    kind: "next",
    next,
    seq: nextSeq,
    until: null,
    event: null,
    detail: outcome.detail,
  } satisfies Executed
})

/**
 * After a wait for an event: which path to take. On a timeout it looks once more, in case the event
 * arrived as the wait began.
 */
export const afterWait = Effect.fn("runs.afterWait")(function* (
  runId: string,
  nodeId: string,
  seq: number,
  arrived: boolean,
) {
  const run = yield* findRun(runId)
  const { graph } = yield* publishedVersion(run.automationId, run.version)
  const node = graph.nodes.find((n) => n.id === nodeId)
  const event = node?.type === "wait_event" ? node.config.event : ""
  const steps = yield* Database.use((d) =>
    d.query("runs.waitStart", (db) =>
      db
        .select({ at: automationRunSteps.at })
        .from(automationRunSteps)
        .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.nodeId, nodeId)))
        .orderBy(desc(automationRunSteps.seq))
        .limit(1)
        .get(),
    ),
  )
  const happened = arrived || (yield* didEvent(run.contactId, event, steps?.at ?? run.startedAt))
  const port: Port = happened ? "event" : "timeout"
  const next = nextNode(graph, nodeId, port)
  yield* recordStep(run, seq, nodeId, "passed", happened ? `${event} happened.` : `No ${event} in time.`, {
    port,
  })
  yield* setRun(runId, {
    state: "running",
    currentStep: next,
    seq: seq + 1,
    nextAt: null,
    waitingEvent: null,
  })
  return { next, seq: seq + 1 }
})

/**
 * Where a run is, for people: a waiting run is at the step it's waiting in (its latest "waiting"
 * history row); otherwise its current step. `currentStep` itself is where it resumes.
 */
const POSITION = sql<
  string | null
>`case when ${automationRuns.state} = 'waiting' then coalesce((select s.node_id from automation_run_steps s where s.run_id = ${automationRuns.id} and s.outcome = 'waiting' order by s.seq desc limit 1), ${automationRuns.currentStep}) else ${automationRuns.currentStep} end`

const positionOf = (runId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("runs.position", (db) =>
      db.select({ at: POSITION }).from(automationRuns).where(eq(automationRuns.id, runId)).get(),
    )
    return row?.at ?? null
  })

/** Ends a run for good: exited (stop rule, API) or failed (a step kept failing). */
export const finishRun = Effect.fn("runs.finish")(function* (
  runId: string,
  state: "exited" | "failed",
  detail: string,
  by: string | null = null,
) {
  const run = yield* findRun(runId)
  if (run.state === "completed" || run.state === "exited") return run.state
  const at = (yield* positionOf(runId)) ?? "-"
  yield* recordStep(run, run.seq, at, state === "failed" ? "failed" : "exited", detail)
  yield* setRun(runId, {
    state,
    seq: run.seq + 1,
    error: state === "failed" ? detail.slice(0, 500) : null,
    exitedBy: by,
    nextAt: null,
    waitingEvent: null,
    finishedAt: Date.now(),
  })
  if (state === "failed") yield* syncFailedAlert(run.automationId)
  return state
})

const DAY_MS = 86_400_000

/**
 * `automation_failed:<automation>`: open while the automation has runs that failed in the last day,
 * with their count and the step most of them failed on. Retrying them, or a quiet day, clears it.
 */
export const syncFailedAlert = (automationId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const since = Date.now() - DAY_MS
    const failed = yield* database.query("runs.failedToday", (db) =>
      db
        .select({ n: count() })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.automationId, automationId),
            eq(automationRuns.state, "failed"),
            gte(automationRuns.finishedAt, since),
          ),
        )
        .get(),
    )
    const n = failed?.n ?? 0
    const key = `automation_failed:${automationId}`
    if (n === 0) return yield* clearAlert(key, "automations")
    const automation = yield* database.query("runs.failedAutomation", (db) =>
      db.select({ name: automations.name }).from(automations).where(eq(automations.id, automationId)).get(),
    )
    const step = yield* database.query("runs.failedStep", (db) =>
      db
        .select({ nodeId: automationRunSteps.nodeId, detail: automationRunSteps.detail, n: count() })
        .from(automationRunSteps)
        .where(
          and(
            eq(automationRunSteps.automationId, automationId),
            eq(automationRunSteps.outcome, "failed"),
            gte(automationRunSteps.at, since),
          ),
        )
        .groupBy(automationRunSteps.nodeId)
        .orderBy(desc(count()))
        .get(),
    )
    yield* raiseAlert({
      key,
      kind: "automation_failed",
      severity: "warning",
      title: `${n} run${n === 1 ? "" : "s"} of "${automation?.name ?? automationId}" failed today`,
      detail: step
        ? `Most failed at step ${step.nodeId}: ${step.detail.slice(0, 300)} Retry them from the run list once it's fixed.`
        : "Retry them from the run list once it's fixed.",
      subject: { type: "automation", id: automationId },
      count: n,
    })
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("automations: could not update the failure alert", cause)),
  )

/** Marks a run waiting (paused automation), so the run list says why it's still. */
export const holdRun = Effect.fn("runs.hold")(function* (runId: string, until: number) {
  yield* setRun(runId, { state: "waiting", nextAt: until })
})

// ---------------------------------------------------------------------------------------------
// The real StepContext
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder()
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))

/** The secret automation webhooks are signed with (Standard Webhooks), derived per automation. */
export const automationWebhookSecret = Effect.fn("automations.webhookSecret")(function* (
  automationId: string,
) {
  const env = yield* Bindings
  const root = env.WEBHOOK_SIGNING_KEY ?? env.ADMIN_KEY ?? ""
  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey("raw", enc.encode(root), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  )
  const raw = yield* Effect.promise(() =>
    crypto.subtle.sign("HMAC", key, enc.encode(`automation-webhook:${automationId}`)),
  )
  return `whsec_${b64(raw)}`
})

const makeContext = (
  run: RunRow,
  graph: Graph,
  settings: Settings,
  nodeId: string,
  services: import("effect/Context").Context<AppServices>,
) =>
  Effect.gen(function* () {
    const contact = yield* findContact(run.contactId)
    const database = yield* Database
    const a = yield* database.query("runs.automationRow", (db) =>
      db
        .select({ name: automations.name, origin: automations.origin })
        .from(automations)
        .where(eq(automations.id, run.automationId))
        .get(),
    )
    const run$ = <A, E>(effect: Effect.Effect<A, E, AppServices>) => Effect.runPromiseWith(services)(effect)
    const ctx: StepContext = {
      now: Date.now(),
      runStartedAt: run.startedAt,
      contact: {
        id: contact.id,
        email: contact.email,
        name: contact.name,
        status: contact.status,
        fields: contact.fields,
      },
      settings,
      matches: (rule) => run$(contactMatches(contact.id, rule)),
      didEvent: (event, since) => run$(didEvent(contact.id, event, since)),
      send: (input) => run$(sendForRun(run, nodeId, input, a?.name ?? "", a?.origin ?? null, settings)),
      updateFields: (fields) =>
        run$(
          database
            .query("runs.updateFields", (db) =>
              db
                .update(contacts)
                .set({ fields: sql`json_patch(${contacts.fields}, ${JSON.stringify(fields)})` })
                .where(eq(contacts.id, contact.id))
                .run(),
            )
            .pipe(Effect.asVoid),
        ),
      setTopic: (topicId, action) =>
        run$(
          writeSubscription(
            contact,
            topicId,
            action === "subscribe" ? "subscribed" : "unsubscribed",
            `automation:${run.automationId}`,
          ).pipe(Effect.asVoid),
        ),
      webhook: (url, payload) =>
        run$(
          Effect.gen(function* () {
            const secret = yield* automationWebhookSecret(run.automationId)
            const body = JSON.stringify({
              type: "automation.webhook",
              automationId: run.automationId,
              runId: run.id,
              step: nodeId,
              ...payload,
            })
            const id = `${run.id}:${nodeId}`
            const timestamp = Math.floor(Date.now() / 1000)
            const key = yield* Effect.promise(() =>
              crypto.subtle.importKey(
                "raw",
                Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"],
              ),
            )
            const signature = b64(
              yield* Effect.promise(() =>
                crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)),
              ),
            )
            const status = yield* Effect.promise(async () => {
              try {
                const response = await fetch(url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "webhook-id": id,
                    "webhook-timestamp": String(timestamp),
                    "webhook-signature": `v1,${signature}`,
                  },
                  body,
                  signal: AbortSignal.timeout(10_000),
                })
                return response.status
              } catch {
                return 0
              }
            })
            return { status }
          }),
        ),
    }
    void graph
    return ctx
  })

/**
 * One automation send: can this contact get it (status, topic, cadence cap), will the governor let
 * it go now, then render and send through the outbox. The cap is counted in a single conditional
 * insert, so two runs can't both slip under it.
 */
const sendForRun = (
  run: RunRow,
  nodeId: string,
  input: SendInput,
  automationName: string,
  origin: string | null,
  settings: Settings,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const contact = yield* findContact(run.contactId)
    if (isBlocked(contact.status))
      return {
        status: "skipped",
        reason: "suppressed",
        detail: `${contact.email} is ${contact.status}.`,
      } satisfies SendResult
    if (contact.status === "unsubscribed")
      return {
        status: "skipped",
        reason: "unsubscribed",
        detail: "The contact unsubscribed.",
      } satisfies SendResult
    if (input.topicId) {
      const sub = yield* database.query("runs.topicState", (db) =>
        db
          .select({ state: subscriptions.state })
          .from(subscriptions)
          .where(
            and(eq(subscriptions.contactId, contact.id), eq(subscriptions.topicId, input.topicId as string)),
          )
          .get(),
      )
      if (sub?.state === "unsubscribed")
        return {
          status: "skipped",
          reason: "unsubscribed",
          detail: "The contact left this topic.",
        } satisfies SendResult
    }
    if (!input.fromAddress)
      return { status: "skipped", reason: "suppressed", detail: "No sender is set." } satisfies SendResult
    // The origin captured when the automation was published: the base of its unsubscribe and tracking links.
    const base = origin ?? ""
    // Rendered before the governor and the cadence cap, so a send skipped for missing data uses up neither.
    const rendered = yield* renderAutomationMail({
      templateId: input.templateId,
      version: input.version,
      subject: input.subject,
      fromAddress: input.fromAddress,
      topicId: input.topicId,
      origin: base,
      automationName,
      contact: { id: contact.id, email: contact.email, name: contact.name, fields: contact.fields },
      triggerData: run.triggerData ?? null,
    }).pipe(
      Effect.catchTag("MissingMergeData", (e) =>
        Effect.succeed({
          status: "skipped",
          reason: "missing_data",
          detail: missingDetail(e.missing),
        } satisfies SendResult),
      ),
    )
    if ("status" in rendered) return rendered
    const mail = rendered
    const sendId = `${run.id}:${nodeId}`
    const already = yield* database.query("runs.sendCounted", (db) =>
      db.select({ id: automationSends.id }).from(automationSends).where(eq(automationSends.id, sendId)).get(),
    )
    if (!already) {
      // The governor first: a deferred send mustn't use up the contact's cadence.
      const from = parseParty(input.fromAddress).email.toLowerCase()
      const grant = yield* (yield* Governor)
        .acquire({
          campaignId: run.automationId,
          stream: "automation",
          sendingDomain: from.slice(from.lastIndexOf("@") + 1),
          recipients: [
            {
              key: contact.id,
              domain: contact.email.slice(contact.email.lastIndexOf("@") + 1).toLowerCase(),
            },
          ],
        })
        .pipe(
          Effect.orElseSucceed(() => ({
            granted: [] as ReadonlyArray<string>,
            retryAt: Date.now() + 5 * 60_000,
            reason: null,
          })),
        )
      if (!grant.granted.includes(contact.id)) {
        const retryAt = grant.retryAt ?? Date.now() + 60 * 60_000
        return {
          status: "deferred",
          retryAt,
          detail: `Waiting for the sending pace (${grant.reason ?? "pacing"}); trying again at ${new Date(retryAt).toISOString()}.`,
        } satisfies SendResult
      }
      const now = Date.now()
      const cap = settings.cadence
      const counted = yield* database.query("runs.cadence", (db) =>
        db.run(
          cap
            ? sql`insert into automation_sends (id, contact_id, automation_id, run_id, at)
                select ${sendId}, ${contact.id}, ${run.automationId}, ${run.id}, ${now}
                where (select count(*) from automation_sends where contact_id = ${contact.id} and at > ${now - cap.days * DAY}) < ${cap.max}
                on conflict(id) do nothing`
            : sql`insert into automation_sends (id, contact_id, automation_id, run_id, at)
                values (${sendId}, ${contact.id}, ${run.automationId}, ${run.id}, ${now}) on conflict(id) do nothing`,
        ),
      )
      const changes = (counted as { meta?: { changes?: number } }).meta?.changes ?? 0
      if (changes === 0 && cap)
        return {
          status: "skipped",
          reason: "cadence",
          detail: `The contact already had ${cap.max} automation email${cap.max === 1 ? "" : "s"} in ${cap.days} days.`,
        } satisfies SendResult
    }
    const result = yield* sendBulkMessage({
      stream: "automation",
      message: mail.message,
      contactId: contact.id,
      campaignId: null,
      automationRunId: run.id,
      templateId: mail.templateId,
      templateVersion: mail.templateVersion,
      track: {
        opens: input.trackOpens,
        clicks: input.trackClicks,
        origin: trackingOrigin(mail.compliance, base),
      },
      idempotencyKey: sendId,
    })
    return {
      status: "sent",
      messageId: result.id,
      subject: mail.message.subject,
      preview: mail.preview,
    } satisfies SendResult
  })

// ---------------------------------------------------------------------------------------------
// Waking waiting runs, stopping runs, and the API's view of runs
// ---------------------------------------------------------------------------------------------

/** A tracked event: wake every run of this contact waiting for it. */
export const wakeWaiting = (
  contactId: string,
  event: string,
  data: Readonly<Record<string, unknown>> | null,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    const waiting = yield* database.query("runs.waitingFor", (db) =>
      db
        .select({ id: automationRuns.id, workflowId: automationRuns.workflowId })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.contactId, contactId),
            eq(automationRuns.state, "waiting"),
            eq(automationRuns.waitingEvent, event),
          ),
        )
        .all(),
    )
    if (waiting.length === 0) return
    const env = yield* Bindings
    for (const w of waiting)
      yield* Effect.tryPromise(async () => {
        const instance = await env.AUTOMATION_WORKFLOW.get(w.workflowId)
        await instance.sendEvent({ type: eventTypeFor(event), payload: { event, data } })
        ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`automations: could not wake ${w.id}`, cause)))
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("automations: could not look for waiting runs", cause)),
  )

/**
 * Ends every active run of a contact at once, as when they unsubscribe or bounce: their waits are
 * cut short rather than left to discover it when they wake.
 */
export const stopRunsFor = (contactId: string, detail: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const active = yield* database.query("runs.activeFor", (db) =>
      db
        .select({ id: automationRuns.id, workflowId: automationRuns.workflowId })
        .from(automationRuns)
        .where(
          and(eq(automationRuns.contactId, contactId), inArray(automationRuns.state, ["running", "waiting"])),
        )
        .all(),
    )
    for (const r of active) yield* endRun(r.id, r.workflowId, "exited", detail, null)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("automations: could not stop runs", cause)))

/** As stopRunsFor, by address: a bounce or complaint names the recipient, not the contact. */
export const stopRunsForEmail = (email: string, detail: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const contact = yield* database.query("runs.contactByEmail", (db) =>
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.email, email.trim().toLowerCase()))
        .get(),
    )
    if (contact) yield* stopRunsFor(contact.id, detail)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("automations: could not stop runs", cause)))

const endRun = (runId: string, workflowId: string, state: "exited", detail: string, by: string | null) =>
  Effect.gen(function* () {
    yield* finishRun(runId, state, detail, by)
    const env = yield* Bindings
    yield* Effect.tryPromise(async () => {
      const instance = await env.AUTOMATION_WORKFLOW.get(workflowId)
      await instance.terminate()
      ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    }).pipe(Effect.catchCause((cause) => Effect.logInfo(`automations: ${runId} had already stopped`, cause)))
  })

/** `POST /v1/runs/:id/exit`: ends a run now and records who ended it. */
export const exitRun = Effect.fn("runs.exit")(function* (runId: string, actor: string) {
  const run = yield* findRun(runId)
  if (run.state !== "running" && run.state !== "waiting")
    return yield* new RunInvalid({ message: `The run is already ${run.state}.` })
  yield* endRun(run.id, run.workflowId, "exited", "Ended from the API.", actor)
  yield* recordAudit({ actor, action: "automation.run.exit", target: runId })
  return yield* getRun(runId)
})

/** `POST /v1/runs/:id/retry`: a failed run carries on from the step that failed, in a new instance. */
export const retryRun = Effect.fn("runs.retry")(function* (runId: string, actor: string) {
  const run = yield* findRun(runId)
  if (run.state !== "failed") return yield* new RunInvalid({ message: "Only a failed run can be retried." })
  const database = yield* Database
  const [{ n } = { n: 0 }] = yield* database.query("runs.retries", (db) =>
    db
      .select({ n: count() })
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.outcome, "failed")))
      .all(),
  )
  const workflowId = `${runId}-r${n}`
  yield* setRun(runId, { state: "running", error: null, finishedAt: null, workflowId })
  const env = yield* Bindings
  yield* Effect.tryPromise({
    try: async () => {
      const instance = await env.AUTOMATION_WORKFLOW.create({ id: workflowId, params: { runId } })
      ;(instance as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    },
    catch: (cause) => new RunInvalid({ message: `The retry didn't start: ${String(cause).slice(0, 200)}` }),
  })
  yield* recordAudit({ actor, action: "automation.run.retry", target: runId })
  yield* syncFailedAlert(run.automationId)
  return yield* getRun(runId)
})

const describeRun = (r: RunRow, email: string | null, position: string | null) => ({
  id: r.id,
  automationId: r.automationId,
  contactId: r.contactId,
  email,
  version: r.version,
  nodeId: position,
  status: r.state,
  enteredAt: r.startedAt,
  nextAt: r.nextAt,
  waitingFor: r.waitingEvent,
  error: r.error,
  exitedBy: r.exitedBy,
  finishedAt: r.finishedAt,
})

export const listRuns = Effect.fn("runs.list")(function* (
  automationId: string,
  query: {
    readonly status?: RunRow["state"] | undefined
    readonly version?: number | undefined
    readonly cursor?: string | undefined
    readonly limit?: number | undefined
  },
) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const where = and(
    eq(automationRuns.automationId, automationId),
    query.status ? eq(automationRuns.state, query.status) : undefined,
    query.version !== undefined ? eq(automationRuns.version, query.version) : undefined,
  )
  const rows = yield* database.query("runs.page", (db) =>
    db
      .select({ run: automationRuns, email: contacts.email, position: POSITION })
      .from(automationRuns)
      .leftJoin(contacts, eq(contacts.id, automationRuns.contactId))
      .where(and(where, query.cursor ? lt(automationRuns.id, query.cursor) : undefined))
      .orderBy(desc(automationRuns.id))
      .limit(limit + 1)
      .all(),
  )
  const [total] = yield* database.query("runs.total", (db) =>
    db.select({ n: count() }).from(automationRuns).where(where).all(),
  )
  const page = rows.slice(0, limit)
  return {
    runs: page.map((r) => describeRun(r.run, r.email, r.position)),
    total: total?.n ?? 0,
    nextCursor: rows.length > limit ? (page.at(-1)?.run.id ?? null) : null,
  }
})

export const getRun = Effect.fn("runs.getView")(function* (runId: string) {
  const run = yield* findRun(runId)
  const database = yield* Database
  const contact = yield* database.query("runs.email", (db) =>
    db.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, run.contactId)).get(),
  )
  const steps = yield* database.query("runs.steps", (db) =>
    db
      .select()
      .from(automationRunSteps)
      .where(eq(automationRunSteps.runId, runId))
      .orderBy(automationRunSteps.seq)
      .all(),
  )
  return {
    ...describeRun(run, contact?.email ?? null, yield* positionOf(runId)),
    steps: steps.map((s) => ({
      seq: s.seq,
      nodeId: s.nodeId,
      outcome: s.outcome,
      port: s.port,
      detail: s.detail,
      messageId: s.messageId,
      at: s.at,
    })),
  }
})

// ---------------------------------------------------------------------------------------------
// Sweeps: date triggers every hour, segment triggers every night
// ---------------------------------------------------------------------------------------------

/** How many contacts one automation may enter per sweep; the rest enter on the next. */
const SWEEP_LIMIT = 1_000
const NIGHTLY_HOUR = 2

const enqueueEntries = (
  automationId: string,
  entries: ReadonlyArray<{ readonly contactId: string; readonly data?: Record<string, unknown> | null }>,
) =>
  Effect.gen(function* () {
    const env = yield* Bindings
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100).map(({ contactId, data }) => ({
        body: { kind: "enter" as const, contactId, key: automationId, data: data ?? null, at: Date.now() },
      }))
      yield* Effect.promise(() => env.AUTOMATION_QUEUE.sendBatch(batch))
    }
  })

/**
 * The hourly sweep. Date triggers whose hour it is enter the contacts whose date (field plus the
 * offset) is today; at 02:00 UTC every segment trigger enters the segment's contacts that have never
 * been through it. Entry still checks everything, so a sweep that overlaps a live trigger is harmless.
 */
export const sweepAutomations = Effect.fn("automations.sweep")(function* (now: number = Date.now()) {
  const database = yield* Database
  const hour = new Date(now).getUTCHours()
  const live = yield* database.query("automations.sweepLive", (db) =>
    db
      .select({
        id: automations.id,
        version: automations.publishedVersion,
        triggerKey: automations.triggerKey,
      })
      .from(automations)
      .where(
        and(
          eq(automations.status, "live"),
          sql`${automations.triggerKey} = 'date' or ${automations.triggerKey} like 'segment:%'`,
        ),
      )
      .all(),
  )
  const { DB } = yield* Bindings
  const report: Array<string> = []
  for (const a of live) {
    if (a.version === null) continue
    const { graph } = yield* publishedVersion(a.id, a.version)
    const trigger = triggerOf(graph)?.config
    if (trigger?.kind === "date" && trigger.hour === hour) {
      const today = new Date(now)
      const target = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - trigger.offsetDays * DAY,
      )
        .toISOString()
        .slice(0, 10)
      const field = `$.${trigger.field}`
      const day = `case when typeof(json_extract(fields, ?)) in ('integer', 'real') then date(json_extract(fields, ?) / 1000, 'unixepoch') else date(json_extract(fields, ?)) end`
      const match =
        trigger.repeat === "yearly" ? `strftime('%m-%d', ${day}) = strftime('%m-%d', ?)` : `${day} = ?`
      const rows = yield* Effect.promise(() =>
        DB.prepare(
          `select id, json_extract(fields, ?) as day from contacts where status not in ('unsubscribed', 'bounced', 'complained', 'suppressed') and ${match}
           and not exists (select 1 from automation_runs r where r.automation_id = ? and r.contact_id = contacts.id and r.started_at > ?)
           limit ${SWEEP_LIMIT}`,
        )
          .bind(field, field, field, field, target, a.id, now - 20 * 3_600_000)
          .all<{ id: string; day: unknown }>(),
      )
      // Each run carries the date it's about (HAL-3411): the field, the day and the years since.
      yield* enqueueEntries(
        a.id,
        rows.results.map((r) => ({ contactId: r.id, data: dateTriggerData(trigger, r.day, now) })),
      )
      report.push(`${a.id} date ${rows.results.length}`)
    }
    if (trigger?.kind === "segment" && hour === NIGHTLY_HOUR) {
      const seg = yield* database.query("automations.sweepSegment", (db) =>
        db
          .select({ sql: segments.compiledSql, params: segments.compiledParams })
          .from(segments)
          .where(eq(segments.id, trigger.segmentId))
          .get(),
      )
      if (!seg) continue
      const rows = yield* Effect.promise(() =>
        DB.prepare(
          `select id from contacts where (${seg.sql}) and status not in ('unsubscribed', 'bounced', 'complained', 'suppressed')
           and not exists (select 1 from automation_runs r where r.automation_id = ? and r.contact_id = contacts.id)
           limit ${SWEEP_LIMIT}`,
        )
          .bind(...((seg.params as ReadonlyArray<unknown>) ?? []), a.id)
          .all<{ id: string }>(),
      )
      yield* enqueueEntries(
        a.id,
        rows.results.map((r) => ({ contactId: r.id })),
      )
      report.push(`${a.id} segment ${rows.results.length}`)
    }
  }
  return report
})

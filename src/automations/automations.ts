import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  automationRunSteps,
  automationRuns,
  automationSends,
  automations,
  automationVersions,
  domains,
  segments,
  templates,
  templateVersions,
  topics,
} from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { parseParty } from "../domain/outbox.ts"
import { Ids } from "../kit/index.ts"
import { validate as validateRule } from "../segments/rules.ts"
import { Database, queryIn } from "../services/Database.ts"
import { templateTexts, variablesOf } from "../templates/render.ts"
import {
  DEFAULT_SETTINGS,
  Graph,
  type GraphNode,
  type Issue,
  Settings,
  structuralIssues,
  type TriggerConfig,
  triggerOf,
} from "./graph.ts"
import { restoreSecrets } from "./secrets.ts"
import { validateStep } from "./steps/index.ts"
import { TRIGGER_DATA_KEYS, unsuppliedTriggerKeys } from "./triggerData.ts"

/**
 * Automations (HAL-3299): the draft people edit, its validation, and publishing it as a frozen
 * version that runs enter on. Runs themselves are src/automations/runs.ts and the Workflow.
 */

export class AutomationNotFound extends Schema.TaggedError<AutomationNotFound>()("AutomationNotFound", {
  id: Schema.String,
}) {}
export class AutomationInvalid extends Schema.TaggedError<AutomationInvalid>()("AutomationInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
/** Publish refused: the draft has problems, listed per node. */
export class AutomationNotReady extends Schema.TaggedError<AutomationNotReady>()("AutomationNotReady", {
  issues: Schema.Array(
    Schema.Struct({ nodeId: Schema.NullOr(Schema.String), code: Schema.String, message: Schema.String }),
  ),
}) {}
export class AutomationBusy extends Schema.TaggedError<AutomationBusy>()("AutomationBusy", {
  message: Schema.String,
}) {}

type AutomationRow = typeof automations.$inferSelect
type VersionRow = typeof automationVersions.$inferSelect

const DAY = 86_400_000

/** A new automation: a "contact created" trigger straight into an exit, for the builder to fill in. */
export const STARTER_GRAPH: Graph = {
  nodes: [
    { id: "trigger", type: "trigger", config: { kind: "created" } },
    { id: "exit", type: "exit", config: {} },
  ],
  edges: [{ from: "trigger", to: "exit" }],
}

const decodeGraph = Schema.decodeUnknownSync(Graph)
const decodeSettings = Schema.decodeUnknownSync(Settings)
export const graphOf = (row: { readonly graph: unknown }): Graph => decodeGraph(row.graph)
const settingsOf = (row: { readonly settings: unknown }): Settings =>
  row.settings ? decodeSettings(row.settings) : DEFAULT_SETTINGS

/** What starts runs of this trigger, as stored for lookup: `event:<name>`, `created`, `segment:<id>`, `topic:<id>`, `date`. */
export const triggerKeyOf = (t: TriggerConfig) =>
  t.kind === "event"
    ? `event:${t.event}`
    : t.kind === "segment"
      ? `segment:${t.segmentId}`
      : t.kind === "topic"
        ? `topic:${t.topicId}`
        : t.kind

/**
 * Every problem with a draft: structure, each step's own rules, and what needs the database (the
 * templates sends use, the topics, the segment, the sender). An empty list means it can publish.
 */
export const issuesOf = Effect.fn("automations.issues")(function* (graph: Graph, settings: Settings) {
  const issues: Array<Issue> = [...structuralIssues(graph)]
  for (const node of graph.nodes) {
    const problem = validateStep(node)
    if (problem) issues.push({ nodeId: node.id, code: "invalid_config", message: problem })
    const rule =
      node.type === "branch" && node.config.kind === "rule"
        ? node.config.rule
        : node.type === "trigger" && node.config.kind === "event"
          ? node.config.filter
          : undefined
    if (rule) {
      const bad = validateRule(rule)
      if (bad)
        issues.push({ nodeId: node.id, code: "invalid_config", message: `${bad.message} (${bad.path})` })
    }
  }
  const database = yield* Database
  const sends = graph.nodes.filter((n): n is Extract<GraphNode, { type: "send" }> => n.type === "send")
  const templateIds = [...new Set(sends.map((s) => s.config.templateId))]
  const found =
    templateIds.length === 0
      ? []
      : yield* queryIn("automations.templates", templateIds, (db, chunk) =>
          db
            .select({
              id: templates.id,
              published: templates.publishedVersion,
              latest: templates.latestVersion,
              archivedAt: templates.archivedAt,
            })
            .from(templates)
            .where(inArray(templates.id, chunk))
            .all(),
        )
  for (const s of sends) {
    const t = found.find((f) => f.id === s.config.templateId)
    const version = s.config.version
    if (!t || t.archivedAt !== null)
      issues.push({
        nodeId: s.id,
        code: "missing_content",
        message: `Template ${s.config.templateId} doesn't exist or is archived.`,
      })
    else if (version === "published" ? t.published === null : version > t.latest)
      issues.push({
        nodeId: s.id,
        code: "missing_content",
        message:
          version === "published"
            ? "That template has no published version yet."
            : `That template has no version ${version}.`,
      })
    const from = s.config.fromAddress ?? settings.fromAddress
    if (!from)
      issues.push({
        nodeId: s.id,
        code: "invalid_config",
        message: "Choose who this mail comes from (here or in the automation's settings).",
      })
  }
  // A send's template must not need `trigger.*` data its trigger can't carry (HAL-3411).
  const triggerKind = triggerOf(graph)?.config.kind
  const resolvable = sends.flatMap((s) => {
    const t = found.find((f) => f.id === s.config.templateId)
    const version = s.config.version === "published" ? t?.published : s.config.version
    return t && t.archivedAt === null && typeof version === "number" && version <= t.latest
      ? [{ send: s, version }]
      : []
  })
  if (triggerKind && triggerKind !== "event" && resolvable.length > 0) {
    const versions = yield* database.query("automations.templateVersions", (db) =>
      db
        .select({
          templateId: templateVersions.templateId,
          version: templateVersions.version,
          subject: templateVersions.subject,
          source: templateVersions.source,
          text: templateVersions.text,
          kind: templates.kind,
        })
        .from(templateVersions)
        .innerJoin(templates, eq(templates.id, templateVersions.templateId))
        .where(
          or(
            ...resolvable.map((r) =>
              and(
                eq(templateVersions.templateId, r.send.config.templateId),
                eq(templateVersions.version, r.version),
              ),
            ),
          ),
        )
        .all(),
    )
    for (const { send: s, version } of resolvable) {
      const v = versions.find((x) => x.templateId === s.config.templateId && x.version === version)
      if (!v) continue
      const texts = templateTexts({
        kind: v.kind,
        subject: s.config.subject ?? v.subject,
        source: v.source,
        text: v.text,
      })
      let required: ReadonlyArray<string> = []
      try {
        required = variablesOf(...texts).required
      } catch {
        continue
      }
      const unsupplied = unsuppliedTriggerKeys(triggerKind, required)
      if (unsupplied.length > 0) {
        const keys = TRIGGER_DATA_KEYS[triggerKind]
        issues.push({
          nodeId: s.id,
          code: "invalid_config",
          message: `The template needs ${unsupplied.map((k) => `{{ trigger.${k} }}`).join(", ")}, which a ${triggerKind} trigger doesn't carry${keys === "any" ? "" : ` (it has ${keys.map((k) => `trigger.${k}`).join(", ")})`}. Use a contact field, or give it a fallback with ??.`,
        })
      }
    }
  }
  const topicIds = [
    ...new Set(
      [
        settings.topicId,
        ...sends.map((s) => s.config.topicId ?? null),
        ...graph.nodes.flatMap((n) =>
          n.type === "topic"
            ? [n.config.topicId]
            : n.type === "trigger" && n.config.kind === "topic"
              ? [n.config.topicId]
              : [],
        ),
      ].filter((t): t is string => t !== null && t !== undefined),
    ),
  ]
  if (topicIds.length > 0) {
    const rows = yield* queryIn("automations.topics", topicIds, (db, chunk) =>
      db
        .select({ id: topics.id, archived: topics.archived })
        .from(topics)
        .where(inArray(topics.id, chunk))
        .all(),
    )
    for (const id of topicIds)
      if (!rows.some((r) => r.id === id && !r.archived))
        issues.push({
          nodeId: null,
          code: "invalid_config",
          message: `Topic ${id} doesn't exist or is archived.`,
        })
  }
  const trigger = triggerOf(graph)
  if (trigger?.config.kind === "segment") {
    const segmentId = trigger.config.segmentId
    const seg = yield* database.query("automations.segment", (db) =>
      db.select({ id: segments.id }).from(segments).where(eq(segments.id, segmentId)).get(),
    )
    if (!seg)
      issues.push({
        nodeId: trigger.id,
        code: "invalid_config",
        message: `Segment ${segmentId} doesn't exist.`,
      })
  }
  // Every sender's domain must be set up for sending.
  const senders = [
    ...new Set(
      sends.map((s) => s.config.fromAddress ?? settings.fromAddress).filter((f): f is string => Boolean(f)),
    ),
  ]
  for (const from of senders) {
    const email = parseParty(from).email.toLowerCase()
    const domain = email.slice(email.lastIndexOf("@") + 1)
    const row = yield* database.query("automations.domain", (db) =>
      db.select({ sending: domains.sendingEnabled }).from(domains).where(eq(domains.name, domain)).get(),
    )
    if (!row?.sending)
      issues.push({ nodeId: null, code: "invalid_config", message: `${domain} isn't set up for sending.` })
  }
  return issues
})

export const findAutomation = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("automations.get", (db) =>
      db.select().from(automations).where(eq(automations.id, id)).get(),
    )
    if (!row) return yield* new AutomationNotFound({ id })
    return row
  })

/** Live counts per node: who is waiting there now, how many passed through, how many failed. */
const nodeCounts = (automationId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    // A waiting run is "here" at the step it waits in, not the one it will resume at.
    const position = sql<
      string | null
    >`case when ${automationRuns.state} = 'waiting' then coalesce((select s.node_id from automation_run_steps s where s.run_id = ${automationRuns.id} and s.outcome = 'waiting' order by s.seq desc limit 1), ${automationRuns.currentStep}) else ${automationRuns.currentStep} end`
    const here = yield* database.query("automations.here", (db) =>
      db
        .select({ nodeId: position, n: count() })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.automationId, automationId),
            inArray(automationRuns.state, ["running", "waiting"]),
          ),
        )
        .groupBy(position)
        .all(),
    )
    const passed = yield* database.query("automations.passed", (db) =>
      db
        .select({ nodeId: automationRunSteps.nodeId, outcome: automationRunSteps.outcome, n: count() })
        .from(automationRunSteps)
        .where(eq(automationRunSteps.automationId, automationId))
        .groupBy(automationRunSteps.nodeId, automationRunSteps.outcome)
        .all(),
    )
    const counts: Record<string, { here: number; passed: number; failed: number }> = {}
    const at = (id: string) => {
      counts[id] ??= { here: 0, passed: 0, failed: 0 }
      return counts[id]
    }
    for (const h of here) if (h.nodeId) at(h.nodeId).here += h.n
    for (const p of passed) {
      if (p.outcome === "failed") at(p.nodeId).failed += p.n
      else if (p.outcome !== "waiting") at(p.nodeId).passed += p.n
    }
    return counts
  })

const runCounts = (automationId: string, since: number) =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.query("automations.runCounts", (db) =>
      db
        .select({ state: automationRuns.state, n: count() })
        .from(automationRuns)
        .where(and(eq(automationRuns.automationId, automationId), gte(automationRuns.startedAt, since)))
        .groupBy(automationRuns.state)
        .all(),
    )
    const active = yield* database.query("automations.active", (db) =>
      db
        .select({ n: count() })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.automationId, automationId),
            inArray(automationRuns.state, ["running", "waiting"]),
          ),
        )
        .get(),
    )
    const by = (s: string) => rows.find((r) => r.state === s)?.n ?? 0
    return {
      activeRuns: active?.n ?? 0,
      entered: rows.reduce((n, r) => n + r.n, 0),
      completed: by("completed"),
      exited: by("exited"),
      failed: by("failed"),
    }
  })

const describe = (row: AutomationRow) => {
  const graph = graphOf(row)
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    trigger: triggerOf(graph)?.config ?? null,
    version: row.version,
    publishedVersion: row.publishedVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

const RANGE_MS = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY } as const
export type Range = keyof typeof RANGE_MS

export const listAutomations = Effect.fn("automations.list")(function* (range: Range = "7d") {
  const database = yield* Database
  const rows = yield* database.query("automations.list", (db) =>
    db.select().from(automations).orderBy(desc(automations.createdAt)).all(),
  )
  const since = Date.now() - RANGE_MS[range]
  const list = []
  for (const row of rows) list.push({ ...describe(row), ...(yield* runCounts(row.id, since)) })
  return {
    range,
    summary: {
      live: list.filter((a) => a.status === "live").length,
      activeRuns: list.reduce((n, a) => n + a.activeRuns, 0),
      entered: list.reduce((n, a) => n + a.entered, 0),
      completed: list.reduce((n, a) => n + a.completed, 0),
      failed: list.reduce((n, a) => n + a.failed, 0),
    },
    automations: list,
  }
})

/** The Overview's line: how many are live, how many runs are going, and sends in the last week. */
export const automationSummary = Effect.fn("automations.summary")(function* () {
  const database = yield* Database
  const [live] = yield* database.query("automations.live", (db) =>
    db.select({ n: count() }).from(automations).where(eq(automations.status, "live")).all(),
  )
  const [running] = yield* database.query("automations.running", (db) =>
    db
      .select({ n: count() })
      .from(automationRuns)
      .where(inArray(automationRuns.state, ["running", "waiting"]))
      .all(),
  )
  const [sends] = yield* database.query("automations.sends7d", (db) =>
    db
      .select({ n: count() })
      .from(automationSends)
      .where(gte(automationSends.at, Date.now() - 7 * DAY))
      .all(),
  )
  return { live: live?.n ?? 0, activeRuns: running?.n ?? 0, sends7d: sends?.n ?? 0 }
})

export const getAutomation = Effect.fn("automations.get")(function* (id: string) {
  const row = yield* findAutomation(id)
  const graph = graphOf(row)
  const settings = settingsOf(row)
  return {
    ...describe(row),
    graph,
    settings,
    issues: yield* issuesOf(graph, settings),
    counts: yield* nodeCounts(id),
    ...(yield* runCounts(id, 0)),
    /** True when secret config fields came back redacted (see ./secrets.ts); set by the caller's scope. */
    redacted: false,
  }
})

/** A graph can't carry a redacted value it has nowhere to restore from. */
const refuseRedacted = (unrestorable: ReadonlyArray<{ nodeId: string; field: string }>) =>
  unrestorable.length === 0
    ? Effect.void
    : Effect.fail(
        new AutomationInvalid({
          field: "graph",
          message: `Enter the ${unrestorable.map((u) => `${u.field} of step ${u.nodeId}`).join(", ")} again: a redacted value can't be saved.`,
        }),
      )

export const createAutomation = Effect.fn("automations.create")(function* (
  input: {
    readonly name: string
    readonly graph?: Graph | undefined
    readonly settings?: Settings | undefined
  },
  actor: string,
) {
  const name = input.name.trim()
  if (!name || name.length > 100)
    return yield* new AutomationInvalid({ field: "name", message: "A name is 1 to 100 characters." })
  const graph = input.graph ?? STARTER_GRAPH
  yield* refuseRedacted(restoreSecrets(graph, { nodes: [], edges: [] }).unrestorable)
  const database = yield* Database
  const id = `aut_${yield* (yield* Ids).next}`
  yield* database.query("automations.insert", (db) =>
    db
      .insert(automations)
      .values({
        id,
        name,
        trigger: triggerOf(graph)?.config ?? null,
        graph,
        settings: input.settings ?? DEFAULT_SETTINGS,
        status: "draft",
        updatedAt: Date.now(),
        updatedBy: actor,
      })
      .run(),
  )
  yield* recordAudit({ actor, action: "automation.create", target: id, after: { name } })
  return yield* getAutomation(id)
})

/** Saves the draft. Live runs are untouched: they finish on their published version. */
export const updateAutomation = Effect.fn("automations.update")(function* (
  id: string,
  patch: {
    readonly name?: string | undefined
    readonly graph?: Graph | undefined
    readonly settings?: Settings | undefined
  },
  actor: string,
) {
  const row = yield* findAutomation(id)
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 100))
    return yield* new AutomationInvalid({ field: "name", message: "A name is 1 to 100 characters." })
  // A graph read with redacted secrets saves with the stored values kept (HAL-3412).
  let graph = patch.graph
  if (graph !== undefined) {
    const restored = restoreSecrets(graph, graphOf(row))
    yield* refuseRedacted(restored.unrestorable)
    graph = restored.graph
  }
  const database = yield* Database
  yield* database.query("automations.update", (db) =>
    db
      .update(automations)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(graph !== undefined ? { graph, trigger: triggerOf(graph)?.config ?? null } : {}),
        ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
        updatedAt: Date.now(),
        updatedBy: actor,
      })
      .where(eq(automations.id, id))
      .run(),
  )
  return yield* getAutomation(id)
})

/**
 * Freezes the draft as the next version and makes it the one new runs enter. Refused with the
 * list of problems while there are any. A paused automation stays paused; a draft goes live.
 */
export const publishAutomation = Effect.fn("automations.publish")(function* (
  id: string,
  note: string | null,
  actor: string,
  /** The API's origin, from the publish request: the base of the links runs send. */
  origin: string | null = null,
) {
  const row = yield* findAutomation(id)
  const graph = graphOf(row)
  const settings = settingsOf(row)
  const issues = yield* issuesOf(graph, settings)
  if (issues.length > 0) return yield* new AutomationNotReady({ issues })
  const trigger = triggerOf(graph)
  if (!trigger)
    return yield* new AutomationNotReady({
      issues: [{ nodeId: null, code: "no_trigger", message: "No trigger." }],
    })
  const database = yield* Database
  const version = row.version
  const now = Date.now()
  yield* database.query("automations.publish", (db) =>
    db.batch([
      db
        .insert(automationVersions)
        .values({ automationId: id, version, graph, settings, note, publishedBy: actor, publishedAt: now }),
      db
        .update(automations)
        .set({
          publishedVersion: version,
          version: version + 1,
          triggerKey: triggerKeyOf(trigger.config),
          status: row.status === "paused" ? "paused" : "live",
          ...(origin ? { origin } : {}),
          enabled: row.status !== "paused",
          updatedAt: now,
          updatedBy: actor,
        })
        .where(and(eq(automations.id, id), eq(automations.version, version))),
    ]),
  )
  yield* recordAudit({ actor, action: "automation.publish", target: id, after: { version, note } })
  return { version, runsByVersion: yield* runsByVersion(id) }
})

const runsByVersion = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    return yield* database.query("automations.byVersion", (db) =>
      db
        .select({ version: automationRuns.version, active: count() })
        .from(automationRuns)
        .where(
          and(eq(automationRuns.automationId, id), inArray(automationRuns.state, ["running", "waiting"])),
        )
        .groupBy(automationRuns.version)
        .all(),
    )
  })

export const listVersions = Effect.fn("automations.versions")(function* (id: string) {
  const row = yield* findAutomation(id)
  const database = yield* Database
  const versions = yield* database.query("automations.versionsList", (db) =>
    db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, id))
      .orderBy(desc(automationVersions.version))
      .all(),
  )
  const active = new Map((yield* runsByVersion(id)).map((r) => [r.version, r.active]))
  const statusOf = (v: VersionRow): "live" | "paused" | "finishing" | "retired" =>
    v.version === row.publishedVersion
      ? row.status === "paused"
        ? "paused"
        : "live"
      : (active.get(v.version) ?? 0) > 0
        ? "finishing"
        : "retired"
  return {
    draft: { version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
    versions: versions.map((v) => ({
      version: v.version,
      status: statusOf(v),
      note: v.note,
      publishedAt: v.publishedAt,
      publishedBy: v.publishedBy,
      activeRuns: active.get(v.version) ?? 0,
    })),
  }
})

/** Copies a published version back into the draft, to edit or republish. */
export const restoreVersion = Effect.fn("automations.restore")(function* (
  id: string,
  version: number,
  actor: string,
) {
  yield* findAutomation(id)
  const database = yield* Database
  const v = yield* database.query("automations.version", (db) =>
    db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, id), eq(automationVersions.version, version)))
      .get(),
  )
  if (!v)
    return yield* new AutomationInvalid({ field: "version", message: `There is no version ${version}.` })
  const graph = graphOf(v)
  return yield* updateAutomation(id, { graph, settings: settingsOf(v) }, actor)
})

/** A paused automation takes no new entries, and its runs hold before their next step until it resumes. */
export const setPaused = Effect.fn("automations.pause")(function* (
  id: string,
  paused: boolean,
  actor: string,
) {
  const row = yield* findAutomation(id)
  if (row.publishedVersion === null)
    return yield* new AutomationInvalid({
      field: "status",
      message: "Publish it first; a draft has nothing to pause.",
    })
  const database = yield* Database
  yield* database.query("automations.status", (db) =>
    db
      .update(automations)
      .set({ status: paused ? "paused" : "live", enabled: !paused, updatedAt: Date.now(), updatedBy: actor })
      .where(eq(automations.id, id))
      .run(),
  )
  yield* recordAudit({ actor, action: paused ? "automation.pause" : "automation.resume", target: id })
  return yield* getAutomation(id)
})

/** Deletes an automation with no runs in progress (exit them first), and its history. */
export const deleteAutomation = Effect.fn("automations.delete")(function* (id: string, actor: string) {
  yield* findAutomation(id)
  const database = yield* Database
  const active = yield* database.query("automations.activeForDelete", (db) =>
    db
      .select({ n: count() })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, id), inArray(automationRuns.state, ["running", "waiting"])))
      .get(),
  )
  if ((active?.n ?? 0) > 0)
    return yield* new AutomationBusy({
      message: `${active?.n} runs are still in progress; exit them or wait for them to finish.`,
    })
  yield* database.query("automations.delete", (db) =>
    db.batch([
      db.delete(automationRunSteps).where(eq(automationRunSteps.automationId, id)),
      db.delete(automationRuns).where(eq(automationRuns.automationId, id)),
      db.delete(automations).where(eq(automations.id, id)),
    ]),
  )
  yield* recordAudit({ actor, action: "automation.delete", target: id })
  return { id, deleted: true }
})

/** A published version's graph and settings: what a run walks. */
export const publishedVersion = Effect.fn("automations.publishedVersion")(function* (
  id: string,
  version: number,
) {
  const database = yield* Database
  const v = yield* database.query("automations.version", (db) =>
    db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, id), eq(automationVersions.version, version)))
      .get(),
  )
  if (!v) return yield* new AutomationNotFound({ id: `${id}@${version}` })
  return { graph: graphOf(v), settings: settingsOf(v) }
})

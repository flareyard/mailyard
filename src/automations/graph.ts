import * as Schema from "effect/Schema"
import { Rule } from "../segments/rules.ts"

/**
 * An automation is a trigger plus a directed acyclic graph of steps (HAL-3299). The graph is what
 * the builder edits and what a run walks: one `trigger` node where every run starts, steps joined
 * by edges, and `exit` nodes where runs end. Edges out of `branch` carry a `yes` or `no` port and
 * edges out of `wait_event` an `event` or `timeout` port; every other node has one way out.
 *
 * The draft graph is edited freely; `publish` freezes it as version N (automation_versions), and a
 * run keeps the version it entered on.
 */

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,40}$/))
const Days = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 3650 }))
const Hour = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 23 }))
const EventName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,100}$/))
const FieldName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/))

/** A length of time: what a `wait` sleeps and a `wait_event` allows. */
export const Duration = Schema.Struct({
  amount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  unit: Schema.Literals(["minutes", "hours", "days", "weeks"]),
})
export type Duration = typeof Duration.Type

export const TriggerConfig = Schema.Union([
  /** A tracked event (`/v1/track`), optionally only for contacts matching a rule tree. */
  Schema.Struct({ kind: Schema.Literal("event"), event: EventName, filter: Schema.optionalKey(Rule) }),
  /** A contact is created, by any route (API, form, import, event). */
  Schema.Struct({ kind: Schema.Literal("created") }),
  /** A contact comes to match a saved segment (checked when the contact changes, and nightly). */
  Schema.Struct({ kind: Schema.Literal("segment"), segmentId: Schema.String }),
  /** A contact subscribes to a topic. */
  Schema.Struct({ kind: Schema.Literal("topic"), topicId: Schema.String }),
  /** A date in a contact field, plus or minus days, at an hour (UTC); yearly or once. */
  Schema.Struct({
    kind: Schema.Literal("date"),
    field: FieldName,
    offsetDays: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: -365, maximum: 365 })),
    hour: Hour,
    repeat: Schema.Literals(["yearly", "once"]),
  }),
  /**
   * Mail arrives in a mailbox (HAL-3467): the sender becomes the contact (added unconfirmed if new,
   * never subscribed). Optionally only for some mailboxes, sender domains, or subjects containing
   * some text. Automated mail (auto-replies, bulk, lists) and spam never start a run.
   */
  Schema.Struct({
    kind: Schema.Literal("mail_received"),
    mailboxIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
    senderDomains: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(253))).check(Schema.isMaxLength(50)),
    ),
    subjectContains: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
])
export type TriggerConfig = typeof TriggerConfig.Type

const node = <T extends string, C extends Schema.Top>(type: T, config: C) =>
  Schema.Struct({ id: Id, type: Schema.Literal(type), label: Schema.optionalKey(Schema.String), config })

export const TriggerNode = node("trigger", TriggerConfig)
export const WaitNode = node("wait", Schema.Struct({ duration: Duration }))
export const WaitUntilNode = node(
  "wait_until",
  Schema.Union([
    /** The next time it's this weekday (0 = Sunday) and hour, UTC. */
    Schema.Struct({
      kind: Schema.Literal("weekday"),
      weekday: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 6 })),
      hour: Hour,
    }),
    /** A date held in a contact field, plus or minus days; continues at once when it has passed. */
    Schema.Struct({
      kind: Schema.Literal("field"),
      field: FieldName,
      offsetDays: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: -365, maximum: 365 })),
      hour: Hour,
    }),
  ]),
)
export const WaitEventNode = node("wait_event", Schema.Struct({ event: EventName, timeout: Duration }))
export const BranchNode = node(
  "branch",
  Schema.Union([
    /** Does the contact match this rule tree right now? */
    Schema.Struct({ kind: Schema.Literal("rule"), rule: Rule }),
    /** Did the contact do this event since the run started (or within the last `withinDays`)? */
    Schema.Struct({ kind: Schema.Literal("event"), event: EventName, withinDays: Schema.optionalKey(Days) }),
  ]),
)
export const SendNode = node(
  "send",
  Schema.Struct({
    templateId: Schema.String,
    /** A frozen version, or the template's published version at the time of sending. */
    version: Schema.Union([
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      Schema.Literal("published"),
    ]),
    subject: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    /** Overrides the automation's sender. */
    fromAddress: Schema.optionalKey(Schema.String),
    /** Overrides the automation's topic: whose unsubscribe link the mail carries. */
    topicId: Schema.optionalKey(Schema.String),
    trackOpens: Schema.optionalKey(Schema.Boolean),
    trackClicks: Schema.optionalKey(Schema.Boolean),
  }),
)
export const UpdateNode = node(
  "update",
  Schema.Struct({
    /** Custom fields to set (null removes one). */
    fields: Schema.Record(
      FieldName,
      Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
    ),
  }),
)
export const TopicNode = node(
  "topic",
  Schema.Struct({ topicId: Schema.String, action: Schema.Literals(["subscribe", "unsubscribe"]) }),
)
export const WebhookNode = node(
  "webhook",
  Schema.Struct({
    url: Schema.String.check(Schema.isPattern(/^https:\/\//)),
    /** Extra JSON merged into the signed payload. */
    payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
export const ExitNode = node("exit", Schema.Struct({}))

export const GraphNode = Schema.Union([
  TriggerNode,
  WaitNode,
  WaitUntilNode,
  WaitEventNode,
  BranchNode,
  SendNode,
  UpdateNode,
  TopicNode,
  WebhookNode,
  ExitNode,
])
export type GraphNode = typeof GraphNode.Type
export type NodeType = GraphNode["type"]
export type NodeOf<T extends NodeType> = Extract<GraphNode, { readonly type: T }>

export const Port = Schema.Literals(["yes", "no", "event", "timeout"])
export type Port = typeof Port.Type

export const Edge = Schema.Struct({ from: Id, to: Id, port: Schema.optionalKey(Port) })
export type Edge = typeof Edge.Type

export const Graph = Schema.Struct({
  nodes: Schema.Array(GraphNode).check(Schema.isMaxLength(200)),
  edges: Schema.Array(Edge).check(Schema.isMaxLength(400)),
})
export type Graph = typeof Graph.Type

/** Rules that apply to the whole automation, not one step. */
export const Settings = Schema.Struct({
  /** Who the mail comes from, unless a send step says otherwise ("Name <address>"). */
  fromAddress: Schema.NullOr(Schema.String),
  /** The topic whose unsubscribe link sends carry, unless a send step says otherwise. */
  topicId: Schema.NullOr(Schema.String),
  /** Whether a contact can go through again: never, or once this many days have passed since they entered. */
  reentry: Schema.Union([
    Schema.Struct({ mode: Schema.Literal("never") }),
    Schema.Struct({ mode: Schema.Literal("after"), days: Days }),
  ]),
  /**
   * At most `max` automation sends to one contact in `days` days, counted across every automation.
   * A send over the cap is skipped and the run goes on; null means no cap from this automation.
   */
  cadence: Schema.NullOr(
    Schema.Struct({
      max: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
      days: Days,
    }),
  ),
  /** Events that end a run at once, checked before every step; unsubscribing always ends it. */
  stopEvents: Schema.Array(EventName).check(Schema.isMaxLength(20)),
})
export type Settings = typeof Settings.Type

export const DEFAULT_SETTINGS: Settings = {
  fromAddress: null,
  topicId: null,
  reentry: { mode: "never" },
  cadence: null,
  stopEvents: [],
}

export type IssueCode =
  | "no_trigger"
  | "unreachable"
  | "no_exit"
  | "cycle"
  | "invalid_edge"
  | "invalid_config"
  | "missing_content"
export type Issue = { readonly nodeId: string | null; readonly code: IssueCode; readonly message: string }

/** The ports a node's outgoing edges must cover, exactly. */
export const portsOf = (type: NodeType): ReadonlyArray<Port | undefined> =>
  type === "branch"
    ? ["yes", "no"]
    : type === "wait_event"
      ? ["event", "timeout"]
      : type === "exit"
        ? []
        : [undefined]

/** Where a run goes from `nodeId` through `port`, or null at an exit. */
export const nextNode = (graph: Graph, nodeId: string, port?: Port) =>
  graph.edges.find((e) => e.from === nodeId && (e.port ?? undefined) === port)?.to ?? null

/**
 * The structural checks: one trigger, every edge between real nodes on the right port, every port
 * covered once, no cycles, every node reachable, and every path ending at an exit. Content checks
 * (does the template exist?) are the caller's, since they need the database.
 */
export const structuralIssues = (graph: Graph): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = []
  const byId = new Map<string, GraphNode>()
  for (const n of graph.nodes) {
    if (byId.has(n.id))
      issues.push({ nodeId: n.id, code: "invalid_config", message: `Two nodes are called ${n.id}.` })
    byId.set(n.id, n)
  }
  const triggers = graph.nodes.filter((n) => n.type === "trigger")
  if (triggers.length !== 1)
    issues.push({
      nodeId: null,
      code: "no_trigger",
      message:
        triggers.length === 0
          ? "Add a trigger: where every run starts."
          : "An automation has exactly one trigger.",
    })
  for (const e of graph.edges) {
    const from = byId.get(e.from)
    if (!from || !byId.has(e.to)) {
      issues.push({
        nodeId: e.from,
        code: "invalid_edge",
        message: `An edge joins a node that doesn't exist (${e.from} → ${e.to}).`,
      })
      continue
    }
    if (byId.get(e.to)?.type === "trigger")
      issues.push({ nodeId: e.to, code: "invalid_edge", message: "Nothing can lead back into the trigger." })
    if (!portsOf(from.type).includes(e.port ?? undefined))
      issues.push({
        nodeId: from.id,
        code: "invalid_edge",
        message:
          from.type === "exit"
            ? "An exit ends the run; nothing comes after it."
            : `A ${from.type} step can't have a ${e.port ? `"${e.port}"` : "plain"} way out.`,
      })
  }
  for (const n of graph.nodes) {
    for (const port of portsOf(n.type)) {
      const out = graph.edges.filter((e) => e.from === n.id && (e.port ?? undefined) === port)
      if (out.length === 0)
        issues.push({
          nodeId: n.id,
          code: "no_exit",
          message: port
            ? `Connect the "${port}" path of ${n.label ?? n.id}.`
            : `Connect ${n.label ?? n.id} to a next step or an exit.`,
        })
      if (out.length > 1)
        issues.push({
          nodeId: n.id,
          code: "invalid_edge",
          message: `${n.label ?? n.id} has more than one ${port ?? "next"} step.`,
        })
    }
  }
  // Cycles, by depth-first search with colours.
  const colour = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    colour.set(id, 1)
    for (const e of graph.edges.filter((x) => x.from === id)) {
      const c = colour.get(e.to)
      if (c === 1) return true
      if (c === undefined && byId.has(e.to) && visit(e.to)) return true
    }
    colour.set(id, 2)
    return false
  }
  for (const n of graph.nodes)
    if (!colour.has(n.id) && visit(n.id)) {
      issues.push({
        nodeId: null,
        code: "cycle",
        message: "The steps loop back on themselves; an automation must always move forward.",
      })
      break
    }
  // Reachability from the trigger.
  const trigger = triggers[0]
  if (trigger) {
    const seen = new Set([trigger.id])
    const queue = [trigger.id]
    while (queue.length > 0) {
      const id = queue.shift() as string
      for (const e of graph.edges.filter((x) => x.from === id))
        if (!seen.has(e.to)) {
          seen.add(e.to)
          queue.push(e.to)
        }
    }
    for (const n of graph.nodes)
      if (!seen.has(n.id))
        issues.push({
          nodeId: n.id,
          code: "unreachable",
          message: `${n.label ?? n.id} can't be reached from the trigger.`,
        })
  }
  return issues
}

/** Milliseconds in a duration. */
export const durationMs = (d: Duration) =>
  d.amount * { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 }[d.unit]

export const triggerOf = (graph: Graph) =>
  graph.nodes.find((n): n is NodeOf<"trigger"> => n.type === "trigger") ?? null

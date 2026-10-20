/**
 * Automations as pure functions (HAL-3299, HAL-3411, HAL-3412; HANDOFF-audience §4 and §6, GAPS A8). The
 * canvas has no coordinates: the graph lays out as nested flex columns walked from the trigger along
 * `graph.edges`, forking into lanes at a branch (yes/no) or a wait-for-event (event/timeout). Everything the
 * builder decides is here, so it is tested without a browser: the layout, what's unreachable, what each node
 * says, which trigger data a kind carries, who fills each placeholder, the step log's look, and the edits.
 */
import type { Json } from "../audience/kit/queries.ts"
import { fmtInt, num } from "../lib/format.ts"

export type Automation = Json<"/v1/automations/{id}", "get">
export type AutomationRow = Json<"/v1/automations", "get">["automations"][number]
export type Graph = Automation["graph"]
export type GNode = Graph["nodes"][number]
export type GEdge = Graph["edges"][number]
export type NodeType = GNode["type"]
export type Port = NonNullable<GEdge["port"]>
export type Trigger = Extract<GNode, { type: "trigger" }>["config"]
export type TriggerKind = Trigger["kind"]
export type Issue = Automation["issues"][number]
export type Counts = Automation["counts"]
export type Settings = Automation["settings"]
export type DryRun = Json<"/v1/automations/{id}/dry-run", "post">
export type DryStep = DryRun["path"][number]
export type Run = Json<"/v1/automations/{id}/runs", "get">["runs"][number]
export type RunDetail = Json<"/v1/runs/{id}", "get">
export type RunStep = RunDetail["steps"][number]
export type SegmentRule = Extract<GNode, { type: "branch" }>["config"] extends infer C
  ? C extends { kind: "rule"; rule: infer R }
    ? R
    : never
  : never

type N = number | string | null | undefined

// ---------------------------------------------------------------------------------------------
// Ports and layout
// ---------------------------------------------------------------------------------------------

/** The ways out of a node, exactly as the API checks them (`portsOf`). */
export function portsOf(type: NodeType): (Port | undefined)[] {
  if (type === "branch") return ["yes", "no"]
  if (type === "wait_event") return ["event", "timeout"]
  if (type === "exit") return []
  return [undefined]
}

export const PORT_LABEL: Record<Port, string> = {
  yes: "Yes",
  no: "No",
  event: "It happened",
  timeout: "Timed out",
}

export type Lane = { port: Port; label: string; items: FlowItem[] }
export type FlowItem =
  | { kind: "node"; node: GNode; from: string | null; port: Port | undefined }
  | { kind: "fork"; from: string; lanes: Lane[] }
  /** A way out with nothing connected: an open end the API reports as `no_exit`. */
  | { kind: "open"; from: string; port: Port | undefined }
  /** An edge into a node already drawn elsewhere (two paths joining). */
  | { kind: "ref"; from: string; port: Port | undefined; to: GNode }

export type Layout = { main: FlowItem[]; orphans: FlowItem[][]; reachable: Set<string> }

export const nextOf = (graph: Graph, from: string, port: Port | undefined) =>
  graph.edges.find((e) => e.from === from && (e.port ?? undefined) === port)?.to ?? null

/**
 * The graph as nested columns: from the trigger, one node after another until a fork (two lanes) or an exit.
 * A node already drawn is a reference, so joins and cycles never recurse forever. Nodes no walk reaches are
 * laid out from their own roots as `orphans`, drawn dashed as unreachable.
 */
export function layoutGraph(graph: Graph): Layout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const drawn = new Set<string>()
  const walk = (start: string | null, from: string | null, port: Port | undefined): FlowItem[] => {
    const items: FlowItem[] = []
    let id = start
    let prev = from
    let prevPort = port
    while (id) {
      const node = byId.get(id)
      if (!node) {
        if (prev) items.push({ kind: "open", from: prev, port: prevPort })
        break
      }
      if (drawn.has(id)) {
        if (prev) items.push({ kind: "ref", from: prev, port: prevPort, to: node })
        break
      }
      drawn.add(id)
      items.push({ kind: "node", node, from: prev, port: prevPort })
      const ports = portsOf(node.type)
      if (ports.length === 0) break
      if (ports.length === 1) {
        const next = nextOf(graph, id, undefined)
        if (!next) {
          items.push({ kind: "open", from: id, port: undefined })
          break
        }
        prev = id
        prevPort = undefined
        id = next
        continue
      }
      const lanes = ports.map((p) => {
        const P = p as Port
        const next = nextOf(graph, node.id, P)
        return {
          port: P,
          label: PORT_LABEL[P],
          items: next ? walk(next, node.id, P) : [{ kind: "open" as const, from: node.id, port: P }],
        }
      })
      items.push({ kind: "fork", from: node.id, lanes })
      break
    }
    return items
  }
  const trigger = graph.nodes.find((n) => n.type === "trigger")
  const main = trigger ? walk(trigger.id, null, undefined) : []
  const reachable = new Set(drawn)
  const orphans: FlowItem[][] = []
  const left = () => graph.nodes.filter((n) => !drawn.has(n.id))
  // Roots first (nothing undrawn leads in), then whatever is left in a cycle among themselves.
  const roots = left().filter((x) => !graph.edges.some((e) => e.to === x.id && !drawn.has(e.from)))
  for (const n of roots) if (!drawn.has(n.id)) orphans.push(walk(n.id, null, undefined))
  for (const n of left()) if (!drawn.has(n.id)) orphans.push(walk(n.id, null, undefined))
  return { main, orphans, reachable }
}

/** Every node id in a flow, in drawing order (for Tab order and "fit"). */
export function flowNodeIds(items: readonly FlowItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.kind === "node") out.push(it.node.id)
    if (it.kind === "fork") for (const l of it.lanes) out.push(...flowNodeIds(l.items))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// What each node says
// ---------------------------------------------------------------------------------------------

export type Names = {
  mailbox?: (id: string) => string | undefined
  segment?: (id: string) => string | undefined
  topic?: (id: string) => string | undefined
  template?: (id: string) => string | undefined
}

const UNIT: Record<string, [string, string]> = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
  weeks: ["week", "weeks"],
}
export function fmtDuration(d: { amount: number; unit: string }): string {
  const [one, many] = UNIT[d.unit] ?? [d.unit, d.unit]
  return `${fmtInt(d.amount)} ${d.amount === 1 ? one : many}`
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
export const hh = (h: number) => `${String(h).padStart(2, "0")}:00 UTC`

function offsetWords(days: number, field: string): string {
  if (days === 0) return `on ${field}`
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days < 0 ? "before" : "after"} ${field}`
}

export const NODE_KIND_LABEL: Record<NodeType, string> = {
  trigger: "Trigger",
  wait: "Wait",
  wait_until: "Wait until",
  wait_event: "Wait for event",
  branch: "Branch",
  send: "Send email",
  update: "Update contact",
  topic: "Topic",
  webhook: "Call webhook",
  exit: "Exit",
}

export const TRIGGER_KIND_LABEL: Record<TriggerKind, string> = {
  event: "event",
  created: "contact created",
  segment: "segment",
  topic: "topic",
  date: "date",
  mail_received: "mail received",
}

type MailTrigger = Extract<Trigger, { kind: "mail_received" }>

/** Where a mail trigger listens: "support@", "support@ or billing@", "any mailbox". */
export function mailWhere(t: MailTrigger, names: Names = {}): string {
  const boxes = (t.mailboxIds ?? []).map((id) => names.mailbox?.(id) ?? id)
  if (!boxes.length) return "any mailbox"
  return boxes.length === 1
    ? (boxes[0] as string)
    : `${boxes.slice(0, -1).join(", ")} or ${boxes[boxes.length - 1]}`
}

/** A mail trigger's filters in words: "from coursified.app or stripe.com, subject has “invoice”". */
export function mailFilters(t: MailTrigger): string {
  const parts: string[] = []
  const d = t.senderDomains ?? []
  if (d.length)
    parts.push(`from ${d.length === 1 ? d[0] : `${d.slice(0, -1).join(", ")} or ${d[d.length - 1]}`}`)
  if (t.subjectContains) parts.push(`subject has “${t.subjectContains}”`)
  return parts.join(", ")
}

/**
 * The domains typed for a mail trigger, as the API matches them: lower case, without a leading @, empties
 * dropped, each once; a subdomain matches too. At most 50, each at most 253 characters.
 */
export function parseDomains(text: string): { domains: string[]; error: string | null } {
  const domains = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ]
  const bad = domains.find((d) => d.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))
  if (bad) return { domains, error: `“${bad}” isn’t a domain, like coursified.app.` }
  if (domains.length > 50) return { domains, error: "At most 50 sender domains." }
  return { domains, error: null }
}

/** The trigger in one line: "event signed_up", "date signed_up_at, yearly at 09:00 UTC". */
export function describeTrigger(t: Trigger | null | undefined, names: Names = {}): string {
  if (!t) return "No trigger yet"
  switch (t.kind) {
    case "event":
      return `event ${t.event}`
    case "created":
      return "a contact is created"
    case "segment":
      return `enters ${names.segment?.(t.segmentId) ?? t.segmentId}`
    case "topic":
      return `subscribes to ${names.topic?.(t.topicId) ?? t.topicId}`
    case "date":
      return `date ${t.field}${t.offsetDays ? ` ${t.offsetDays > 0 ? "+" : "−"}${Math.abs(t.offsetDays)} d` : ""}, ${t.repeat === "yearly" ? "yearly" : "once"} at ${hh(t.hour)}`
    case "mail_received": {
      const f = mailFilters(t)
      return `mail arrives in ${mailWhere(t, names)}${f ? `, ${f}` : ""}`
    }
  }
}

/** The list row's second line, as the designs word it. */
export function triggerSub(t: Trigger | null | undefined, names: Names = {}): string {
  if (!t) return "No trigger yet"
  switch (t.kind) {
    case "event":
      return `Event ${t.event}`
    case "created":
      return "When a contact is created"
    case "segment":
      return `Enters ${names.segment?.(t.segmentId) ?? t.segmentId}`
    case "topic":
      return `Subscribes to ${names.topic?.(t.topicId) ?? t.topicId}`
    case "date":
      return `${t.repeat === "yearly" ? "Every year" : "Once"} ${offsetWords(t.offsetDays, t.field)}`
    case "mail_received": {
      const f = mailFilters(t)
      return `Mail arrives in ${mailWhere(t, names)}${f ? `, ${f}` : ""}`
    }
  }
}

const OPS: Record<string, string> = {
  eq: "is",
  neq: "isn’t",
  contains: "contains",
  notContains: "doesn’t contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "is over",
  gte: "is at least",
  lt: "is under",
  lte: "is at most",
  exists: "is set",
  missing: "is empty",
  in: "is any of",
}

/** A rule tree in plain words, one sentence per leaf, groups in brackets. */
export function describeRule(r: SegmentRule, names: Names = {}): string {
  switch (r.type) {
    case "all":
    case "any": {
      const parts = r.rules.map((x) => {
        const s = describeRule(x, names)
        return x.type === "all" || x.type === "any" ? `(${s})` : s
      })
      return parts.length ? parts.join(r.type === "all" ? " and " : " or ") : "everyone"
    }
    case "field": {
      const v = Array.isArray(r.value) ? r.value.join(", ") : r.value === undefined ? "" : String(r.value)
      return `${r.field} ${OPS[r.op] ?? r.op}${v ? ` ${v}` : ""}`
    }
    case "status":
      return `status is ${r.in.join(" or ")}`
    case "engagement":
      return `engagement is ${r.in.join(" or ")}`
    case "topic":
      return `${r.is === false ? "not " : ""}${r.state ?? "subscribed"} to ${names.topic?.(r.topicId) ?? r.topicId}`
    case "event":
      return `${r.did === false ? "didn’t do" : "did"} ${r.name}${r.atLeast && r.atLeast > 1 ? ` at least ${r.atLeast} times` : ""}${r.withinDays ? ` in the last ${r.withinDays} days` : ""}`
    case "campaign":
      return `${r.did === false ? "wasn’t" : "was"} ${r.activity === "received" ? "sent" : r.activity} ${r.campaignId ? `campaign ${r.campaignId}` : "any campaign"}${r.withinDays ? ` in the last ${r.withinDays} days` : ""}`
    case "created":
      return r.withinDays
        ? `created in the last ${r.withinDays} days`
        : r.olderThanDays
          ? `created over ${r.olderThanDays} days ago`
          : "created any time"
  }
}

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/]+)(\/.*)?$/i.exec(url)
  return m ? `${m[1]}${m[2] && m[2] !== "/" ? m[2] : ""}` : url
}

/** `mono` names the part of `meta` that is an id, event, address or URL, drawn in mono. */
export type NodeText = { kind: string; title: string; meta: string; mono?: string }

/** A node's three lines on the canvas: what kind, its title, and one line of detail. */
export function describeNode(n: GNode, names: Names = {}): NodeText {
  switch (n.type) {
    case "trigger": {
      const t = n.config
      const kind = `Trigger · ${TRIGGER_KIND_LABEL[t.kind]}`
      if (t.kind === "event")
        return {
          kind,
          title: n.label ?? t.event,
          meta: "When your app sends POST /v1/track with this event",
          mono: "POST /v1/track",
        }
      if (t.kind === "created")
        return {
          kind,
          title: n.label ?? "A contact is created",
          meta: "Any route: the API, a form, an import",
        }
      if (t.kind === "segment")
        return {
          kind,
          title: n.label ?? names.segment?.(t.segmentId) ?? t.segmentId,
          meta: "When a contact comes to match this segment",
        }
      if (t.kind === "topic")
        return {
          kind,
          title: n.label ?? `Subscribes to ${names.topic?.(t.topicId) ?? t.topicId}`,
          meta: "When a contact subscribes",
        }
      if (t.kind === "mail_received")
        return {
          kind,
          title: n.label ?? `Mail to ${mailWhere(t, names)}`,
          meta: mailFilters(t) || "From anyone; automated mail and spam never start a run",
        }
      return {
        kind,
        title: n.label ?? t.field,
        meta: `${t.repeat === "yearly" ? "Every year" : "Once"} ${offsetWords(t.offsetDays, t.field)}, ${hh(t.hour)}`,
      }
    }
    case "wait":
      return { kind: "Wait", title: n.label ?? fmtDuration(n.config.duration), meta: "Then continue" }
    case "wait_until": {
      const c = n.config
      if (c.kind === "weekday")
        return {
          kind: "Wait until",
          title: n.label ?? `${WEEKDAYS[c.weekday] ?? "Day"} ${hh(c.hour)}`,
          meta: "The next time it’s this day and hour",
        }
      return {
        kind: "Wait until",
        title: n.label ?? offsetWords(c.offsetDays, c.field).replace(/^on /, ""),
        meta: `At ${hh(c.hour)}; at once if it has passed`,
      }
    }
    case "wait_event":
      return {
        kind: "Wait for event",
        title: n.label ?? `${n.config.event}, up to ${fmtDuration(n.config.timeout)}`,
        meta: "Continues the moment it happens",
      }
    case "branch": {
      const c = n.config
      if (c.kind === "event")
        return {
          kind: "Branch · event",
          title: n.label ?? `Did ${c.event}?`,
          meta: `Did ${c.event} ${c.withinDays ? `in the last ${c.withinDays} days` : "since they entered"}`,
          mono: c.event,
        }
      return {
        kind: "Branch · rule",
        title: n.label ?? "Matches the rule?",
        meta: describeRule(c.rule, names),
      }
    }
    case "send": {
      const c = n.config
      const tpl = names.template?.(c.templateId) ?? (c.templateId || "no template")
      return {
        kind: "Send email",
        title: n.label ?? c.subject ?? tpl,
        meta: `Template ${tpl}${c.version === "published" ? " · published" : ` v${c.version}`}`,
        mono: tpl,
      }
    }
    case "update": {
      const entries = Object.entries(n.config.fields)
      const title =
        entries.map(([k, v]) => (v === null ? `clear ${k}` : `${k} = ${String(v)}`)).join(", ") ||
        "No fields yet"
      return {
        kind: "Update contact",
        title: n.label ?? title,
        meta: entries.length === 1 ? `Field ${entries[0]?.[0]}` : `${entries.length} fields`,
        ...(entries.length === 1 ? { mono: entries[0]?.[0] ?? "" } : {}),
      }
    }
    case "topic": {
      const c = n.config
      const name = names.topic?.(c.topicId) ?? c.topicId
      return {
        kind: "Topic",
        title:
          n.label ?? `${c.action === "subscribe" ? "Subscribe to" : "Unsubscribe from"} ${name || "a topic"}`,
        meta: `${c.topicId || "no topic"} · ${c.action}`,
        mono: c.topicId,
      }
    }
    case "webhook":
      return {
        kind: "Call webhook",
        title: n.label ?? hostOf(n.config.url),
        meta: `POST ${hostOf(n.config.url)}`,
        mono: `POST ${hostOf(n.config.url)}`,
      }
    case "exit":
      return { kind: "Exit", title: n.label ?? "Exit", meta: "The run ends" }
  }
}

/** A step's title in a step log and the outline: "Send · Welcome", "Wait 1 day", "Exit". */
export function stepTitle(
  n: GNode | undefined,
  fallback: { type?: string; label?: string | null } = {},
  names: Names = {},
): string {
  if (!n) {
    const t = fallback.type as NodeType | undefined
    return fallback.label ?? (t ? (NODE_KIND_LABEL[t] ?? t) : "Step")
  }
  const d = describeNode(n, names)
  switch (n.type) {
    case "trigger":
      return n.config.kind === "event" ? `Trigger · ${n.config.event}` : `Trigger · ${d.title}`
    case "send":
      return `Send · ${d.title}`
    case "wait":
      return `Wait ${d.title}`
    case "wait_until":
      return `Wait until ${d.title}`
    case "wait_event":
      return `Wait for ${d.title}`
    case "branch":
      return `Branch · ${d.title}`
    case "update":
      return `Update ${d.title}`
    case "topic":
      return d.title
    case "webhook":
      return `Call webhook · ${d.title}`
    case "exit":
      return "Exit"
  }
}

/** The outline's sentence for a trigger node (phone view). */
export function outlineTitle(n: GNode, names: Names = {}): string {
  if (n.type === "trigger") {
    const t = n.config
    if (t.kind === "event") return `When ${t.event} happens`
    if (t.kind === "date")
      return `${t.repeat === "yearly" ? "Every year" : "Once"} ${offsetWords(t.offsetDays, t.field)}, ${hh(t.hour)}`
    return describeNode(n, names).title
  }
  return stepTitle(n, {}, names)
}

/** "1,204 passed", "23 here", "1 failed" for a node's counts, in the design's order. */
export function countChips(
  c: { here: N; passed: N; failed: N } | undefined,
): { cls: string; text: string }[] {
  if (!c) return []
  const out: { cls: string; text: string }[] = []
  const here = num(c.here) ?? 0
  const passed = num(c.passed) ?? 0
  const failed = num(c.failed) ?? 0
  if (here) out.push({ cls: "ncount is-here", text: `${fmtInt(here)} here` })
  if (passed || (!here && !failed)) out.push({ cls: "ncount", text: `${fmtInt(passed)} passed` })
  if (failed) out.push({ cls: "ncount is-fail", text: `${fmtInt(failed)} failed` })
  return out
}

// ---------------------------------------------------------------------------------------------
// Trigger data and placeholders (HAL-3411)
// ---------------------------------------------------------------------------------------------

/** What a run's `trigger` holds, per kind (`TRIGGER_DATA_KEYS` in src/automations/triggerData.ts). */
export const TRIGGER_DATA_KEYS: Record<TriggerKind, readonly string[] | "any"> = {
  event: "any",
  created: ["createdAt"],
  topic: ["topicId", "topicName"],
  segment: ["segmentId", "segmentName"],
  date: ["field", "date", "offsetDays", "years"],
  mail_received: ["mailboxId", "threadId", "messageId", "from", "fromName", "subject", "senderDomain"],
}

export const TRIGGER_KEY_HINT: Record<string, string> = {
  createdAt: "When the contact was created, in ms",
  topicId: "The topic’s id",
  topicName: "The topic’s name",
  segmentId: "The segment’s id",
  segmentName: "The segment’s name",
  field: "The date field",
  date: "Its value, as a day",
  offsetDays: "Days before (−) or after (+)",
  years: "Years since that date, on the anniversary the run is about",
  mailboxId: "The mailbox it arrived in",
  threadId: "Its thread, for a link to it in Mail",
  messageId: "The message’s id",
  from: "The sender’s address (also the contact)",
  fromName: "The sender’s display name, if any",
  subject: "The subject line",
  senderDomain: "The part of the address after @",
}

/** An example for a key, from the trigger itself where it can be known. */
export function triggerKeyExample(key: string, t: Trigger, names: Names = {}): string | null {
  if (t.kind === "date") {
    if (key === "field") return t.field
    if (key === "offsetDays") return String(t.offsetDays)
    if (key === "date") return "2025-10-17"
    if (key === "years") return "1"
  }
  if (t.kind === "topic") {
    if (key === "topicId") return t.topicId
    if (key === "topicName") return names.topic?.(t.topicId) ?? null
  }
  if (t.kind === "segment") {
    if (key === "segmentId") return t.segmentId
    if (key === "segmentName") return names.segment?.(t.segmentId) ?? null
  }
  if (t.kind === "mail_received") {
    const box = t.mailboxIds?.length === 1 ? t.mailboxIds[0] : undefined
    if (key === "mailboxId" && box) return box
    if (key === "senderDomain" && t.senderDomains?.length === 1) return t.senderDomains[0] ?? null
  }
  return null
}

/** Placeholders Mailyard fills on every send itself. */
export const MAILYARD_FILLS = new Set([
  "unsubscribe_url",
  "view_url",
  "preferences_url",
  "email",
  "contact.email",
  "contact.id",
])

export type Placeholder = { name: string; cls: "is-ok" | "is-bad" | "is-field" | "is-event"; why: string }

/** Who fills each required placeholder of a template, for a trigger of this kind. */
export function classifyPlaceholders(required: readonly string[], kind: TriggerKind | null): Placeholder[] {
  return required.map((name): Placeholder => {
    if (name === "trigger" || name.startsWith("trigger.")) {
      const key = name.split(".")[1] ?? ""
      if (!kind) return { name, cls: "is-event", why: "the trigger fills it" }
      const keys = TRIGGER_DATA_KEYS[kind]
      if (keys === "any") return { name, cls: "is-event", why: "from the event’s data" }
      return keys.includes(key)
        ? { name, cls: "is-ok", why: "trigger fills it" }
        : { name, cls: "is-bad", why: `a ${TRIGGER_KIND_LABEL[kind]} trigger can’t` }
    }
    if (MAILYARD_FILLS.has(name)) return { name, cls: "is-ok", why: "Mailyard fills it" }
    return { name, cls: "is-field", why: "contact field · skipped if empty" }
  })
}

/** The `trigger.*` placeholders a kind can't carry (the API's `unsuppliedTriggerKeys`). */
export function unsuppliedTriggerKeys(kind: TriggerKind, required: readonly string[]): string[] {
  const keys = TRIGGER_DATA_KEYS[kind]
  if (keys === "any") return []
  return [
    ...new Set(
      required
        .filter((n) => n === "trigger" || n.startsWith("trigger."))
        .map((n) => n.split(".")[1] ?? "")
        .filter((k) => !keys.includes(k)),
    ),
  ]
}

/** Inserts a placeholder at the caret of a subject, with spaces so it never glues to a word. */
export function insertAt(value: string, at: number | null, token: string): { value: string; caret: number } {
  const i = at === null || at < 0 || at > value.length ? value.length : at
  const before = value.slice(0, i)
  const after = value.slice(i)
  const pre = before && !/\s$/.test(before) ? " " : ""
  const post = after && !/^\s/.test(after) ? " " : ""
  const v = `${before}${pre}${token}${post}${after}`
  return { value: v, caret: before.length + pre.length + token.length }
}

// ---------------------------------------------------------------------------------------------
// Step logs: dry runs and runs
// ---------------------------------------------------------------------------------------------

export type LogLook = {
  cls: "is-pass" | "is-wait" | "is-warn" | "is-skip" | "is-fail" | "is-neutral"
  pill: "skip" | "fail" | null
}

export function dryOutcomeLook(o: DryStep["outcome"]): LogLook {
  switch (o) {
    case "would-wait":
    case "deferred":
      return { cls: "is-wait", pill: null }
    case "timed-out":
      return { cls: "is-warn", pill: null }
    case "skipped":
      return { cls: "is-skip", pill: "skip" }
    case "stopped":
      return { cls: "is-neutral", pill: null }
    default:
      return { cls: "is-pass", pill: null }
  }
}

export function runOutcomeLook(o: RunStep["outcome"]): LogLook {
  switch (o) {
    case "waiting":
      return { cls: "is-wait", pill: null }
    case "skipped":
      return { cls: "is-skip", pill: "skip" }
    case "failed":
      return { cls: "is-fail", pill: "fail" }
    default:
      return { cls: "is-pass", pill: null }
  }
}

/** The step-log title: a timeout reads "Timed out waiting for X", everything else the step's title. */
export function logTitle(
  n: GNode | undefined,
  timedOut: boolean,
  fallback: { type?: string; label?: string | null },
  names: Names = {},
): string {
  if (timedOut && n?.type === "wait_event") return `Timed out waiting for ${n.config.event}`
  return stepTitle(n, fallback, names)
}

/**
 * The contact field a skipped send was missing: the first of `steps[].missing` / `path[].missing` (HAL-3417),
 * else read from the detail the API words ("Skipped: The template needs {{ first_name }}, which has no value…")
 * for runs recorded before `missing` existed.
 */
export function missingField(
  detail: string | null | undefined,
  missing?: readonly string[] | null,
): string | null {
  if (missing?.length) return missing[0] ?? null
  const m = /needs \{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\?\?[^}]*)?\}\}/.exec(detail ?? "")
  if (!m?.[1] || m[1].startsWith("trigger.")) return null
  return m[1]
}

/** Every placeholder a skipped send was missing, for "Skipped: missing first_name, plan" (HAL-3417). */
export function missingKeys(detail: string | null | undefined, missing?: readonly string[] | null): string[] {
  if (missing?.length) return [...missing]
  const f = missingField(detail)
  return f ? [f] : []
}

/** Run status words for the runs table's "Step now" column. */
export function runStepNow(
  r: Pick<Run, "status" | "nodeId" | "waitingFor" | "exitedBy">,
  node: GNode | undefined,
  names: Names = {},
): string {
  if (r.status === "completed") return "Finished"
  if (r.status === "exited") return r.exitedBy ? `Exited: ${r.exitedBy}` : "Exited"
  if (r.waitingFor) return `Waiting for ${r.waitingFor}`
  return node ? stepTitle(node, {}, names) : (r.nodeId ?? "—")
}

/** The path a dry run or a run took, as the canvas overlay: ordered node ids, skipped and failed ones. */
export type Overlay = {
  order: Map<string, number>
  skipped: Set<string>
  failed: Set<string>
  ports: Set<string>
  /** The field a skipped send was missing, by node. */
  why: Map<string, string>
}

export function overlayFromDryRun(d: DryRun): Overlay {
  const order = new Map<string, number>()
  const skipped = new Set<string>()
  const ports = new Set<string>()
  const why = new Map<string, string>()
  let i = 0
  for (const s of d.path) {
    if (!order.has(s.nodeId)) order.set(s.nodeId, ++i)
    if (s.outcome === "skipped") {
      skipped.add(s.nodeId)
      const f = missingField(s.detail, s.missing)
      if (f) why.set(s.nodeId, f)
    }
    const p =
      s.outcome === "yes"
        ? "yes"
        : s.outcome === "no"
          ? "no"
          : s.outcome === "event"
            ? "event"
            : s.outcome === "timed-out"
              ? "timeout"
              : null
    if (p) ports.add(`${s.nodeId}:${p}`)
  }
  return { order, skipped, failed: new Set(), ports, why }
}

export function overlayFromRun(r: RunDetail): Overlay {
  const order = new Map<string, number>()
  const skipped = new Set<string>()
  const failed = new Set<string>()
  const ports = new Set<string>()
  const why = new Map<string, string>()
  let i = 0
  for (const s of [...r.steps].sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0))) {
    if (!order.has(s.nodeId)) order.set(s.nodeId, ++i)
    if (s.outcome === "skipped") {
      skipped.add(s.nodeId)
      const f = missingField(s.detail, s.missing)
      if (f) why.set(s.nodeId, f)
    }
    if (s.outcome === "failed") failed.add(s.nodeId)
    if (s.port) ports.add(`${s.nodeId}:${s.port}`)
  }
  return { order, skipped, failed, ports, why }
}

// ---------------------------------------------------------------------------------------------
// Editing the draft graph
// ---------------------------------------------------------------------------------------------

export const ADDABLE: { type: Exclude<NodeType, "trigger">; label: string }[] = [
  { type: "wait", label: "Wait" },
  { type: "wait_until", label: "Wait until" },
  { type: "wait_event", label: "Wait for event" },
  { type: "branch", label: "Branch" },
  { type: "send", label: "Send email" },
  { type: "update", label: "Update contact" },
  { type: "topic", label: "Topic" },
  { type: "webhook", label: "Webhook" },
  { type: "exit", label: "Exit" },
]

export function newId(graph: Graph, type: NodeType): string {
  const base = `n_${type === "wait_event" ? "waitev" : type === "wait_until" ? "until" : type}`
  let i = 1
  const ids = new Set(graph.nodes.map((n) => n.id))
  while (ids.has(`${base}${i}`)) i++
  return `${base}${i}`
}

/** A new step's starting config: valid where the API allows, blank where a person has to choose. */
export function defaultNode(type: Exclude<NodeType, "trigger">, id: string): GNode {
  switch (type) {
    case "wait":
      return { id, type, config: { duration: { amount: 1, unit: "days" } } }
    case "wait_until":
      return { id, type, config: { kind: "weekday", weekday: 1, hour: 9 } }
    case "wait_event":
      return { id, type, config: { event: "event_name", timeout: { amount: 3, unit: "days" } } }
    case "branch":
      return { id, type, config: { kind: "event", event: "event_name" } }
    case "send":
      return { id, type, config: { templateId: "", version: "published" } }
    case "update":
      return { id, type, config: { fields: {} } }
    case "topic":
      return { id, type, config: { topicId: "", action: "subscribe" } }
    case "webhook":
      return { id, type, config: { url: "https://" } }
    case "exit":
      return { id, type, config: {} }
  }
}

/**
 * Puts a new step on the edge leaving `from` through `port`. A one-way step takes over that edge; a fork's
 * first way out keeps the rest of the path and its second ends at a new exit, so nothing is left open.
 */
export function insertStep(
  graph: Graph,
  from: string,
  port: Port | undefined,
  type: Exclude<NodeType, "trigger">,
): { graph: Graph; id: string } {
  const id = newId(graph, type)
  const node = defaultNode(type, id)
  const old = graph.edges.find((e) => e.from === from && (e.port ?? undefined) === port)
  const edges = graph.edges.filter((e) => e !== old)
  const nodes = [...graph.nodes, node]
  edges.push(port ? { from, to: id, port } : { from, to: id })
  const ports = portsOf(type)
  if (ports.length === 1 && old) edges.push({ from: id, to: old.to })
  if (ports.length === 2) {
    const [first, second] = ports as [Port, Port]
    if (old) edges.push({ from: id, to: old.to, port: first })
    else {
      const e1 = newId({ nodes, edges }, "exit")
      nodes.push({ id: e1, type: "exit", config: {} })
      edges.push({ from: id, to: e1, port: first })
    }
    const e2 = newId({ nodes, edges }, "exit")
    nodes.push({ id: e2, type: "exit", config: {} })
    edges.push({ from: id, to: e2, port: second })
  }
  // An exit put in the middle drops what came after it: those steps show as unreachable until reconnected.
  return { graph: { nodes, edges }, id }
}

/**
 * Removes a step and joins what led into it to its first way out. Steps that only its other way led to stay
 * in the graph and show as unreachable, so nothing is deleted by surprise.
 */
export function deleteStep(graph: Graph, id: string): Graph {
  const node = graph.nodes.find((n) => n.id === id)
  if (!node || node.type === "trigger") return graph
  const ports = portsOf(node.type)
  const next = ports.length ? nextOf(graph, id, ports[0]) : null
  const edges: GEdge[] = []
  for (const e of graph.edges) {
    if (e.from === id) continue
    if (e.to === id) {
      if (next) edges.push({ ...e, to: next })
      continue
    }
    edges.push(e)
  }
  return { nodes: graph.nodes.filter((n) => n.id !== id), edges }
}

export function replaceNode(graph: Graph, node: GNode): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? node : n)) }
}

/** Where the toolbar's Add step goes: after the selected step, else before the main path's first exit. */
export function addTarget(
  graph: Graph,
  selected: string | null,
): { from: string; port: Port | undefined } | null {
  const sel = selected ? graph.nodes.find((n) => n.id === selected) : undefined
  if (sel && sel.type !== "exit") {
    const ports = portsOf(sel.type)
    return { from: sel.id, port: ports[0] }
  }
  const trigger = graph.nodes.find((n) => n.type === "trigger")
  if (!trigger) return null
  let cur: GNode = trigger
  const seen = new Set<string>()
  while (!seen.has(cur.id)) {
    seen.add(cur.id)
    const ports = portsOf(cur.type)
    const port = ports[0]
    const next = nextOf(graph, cur.id, port)
    const nn = next ? graph.nodes.find((n) => n.id === next) : undefined
    if (!nn || nn.type === "exit") return { from: cur.id, port }
    cur = nn
  }
  return { from: cur.id, port: undefined }
}

/** Issues by node id; issues with no node (no_trigger, cycle) under "". */
export function issuesByNode(issues: readonly Issue[]): Map<string, Issue[]> {
  const m = new Map<string, Issue[]>()
  for (const i of issues) {
    const k = i.nodeId ?? ""
    m.set(k, [...(m.get(k) ?? []), i])
  }
  return m
}

/** "84 running · 1 failed in 7 days". */
export function runSummary(a: Pick<AutomationRow, "activeRuns" | "failed">, rangeWords = "7 days"): string {
  const failed = num(a.failed) ?? 0
  return `${fmtInt(a.activeRuns)} running${failed ? ` · ${fmtInt(failed)} failed in ${rangeWords}` : ""}`
}

/** The list's version column: "v4 · draft v5", "v2", "Never published". */
export function versionLine(a: Pick<AutomationRow, "version" | "publishedVersion">): string {
  const pub = num(a.publishedVersion)
  const v = num(a.version) ?? 1
  if (pub === null) return "Never published"
  return v > pub ? `v${pub} · draft v${v}` : `v${pub}`
}

/** Whether two graphs are the same, for "unsaved changes". */
export const sameGraph = (a: Graph, b: Graph) => JSON.stringify(a) === JSON.stringify(b)

/** A 409 NotReady body's issues, if this error is one. */
export function notReadyIssues(body: unknown): Issue[] | null {
  if (!body || typeof body !== "object") return null
  const b = body as { _tag?: unknown; issues?: unknown }
  if (b._tag !== "NotReady" || !Array.isArray(b.issues)) return null
  return b.issues as Issue[]
}

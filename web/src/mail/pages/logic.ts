/**
 * The mailbox pages' pure logic: rules in words, a rule prefilled from a message and checked against it,
 * reordering, import and export arithmetic. Tested in logic.test.ts.
 */
import { num, toDate } from "../../lib/format.ts"
import { utcStamp } from "../logic.ts"
import type { MailExport, MailImport, RuleAction, RuleCondition, RuleCreate } from "./types.ts"

/* ───────────── Rules in words ───────────── */

export const FIELD_WORDS: Record<string, string> = {
  from: "from",
  to: "to",
  cc: "cc",
  recipients: "any recipient",
  subject: "subject",
  listId: "list id",
  tag: "tag",
  body: "body",
}

export const OP_WORDS: Record<string, string> = {
  contains: "contains",
  notContains: "doesn’t contain",
  equals: "is",
  startsWith: "starts with",
  endsWith: "ends with",
}

export type Words = { k: string; v?: string }

export function conditionWords(c: RuleCondition): Words {
  if (c.field === "hasAttachment") return { k: c.value ? "has an attachment" : "has no attachment" }
  if (c.field === "automated") return { k: c.value ? "is automated" : "isn’t automated" }
  return { k: `${FIELD_WORDS[c.field] ?? c.field} ${OP_WORDS[c.op] ?? c.op}`, v: c.value }
}

export type ActionPart =
  | { kind: "label"; labelId: string }
  | { kind: "text"; text: string }
  | { kind: "kv"; k: string; v: string }
  | { kind: "assign"; keyId: string }

const SIMPLE_ACTION: Record<string, string> = {
  archive: "archive",
  trash: "move to trash",
  spam: "mark as spam",
  markRead: "mark read",
  star: "star",
  skipSpamCheck: "skip the spam check",
}

export function actionPart(a: RuleAction): ActionPart {
  switch (a.type) {
    case "label":
      return { kind: "label", labelId: a.labelId }
    case "forward":
      return { kind: "kv", k: "forward to", v: a.to.join(", ") }
    case "autoReply":
      return { kind: "kv", k: "auto-reply", v: `“${a.subject}”` }
    case "webhook":
      return { kind: "kv", k: "webhook", v: a.endpointId }
    case "assign":
      return { kind: "assign", keyId: a.assignee }
    default:
      return { kind: "text", text: SIMPLE_ACTION[a.type] ?? a.type }
  }
}

/** Actions that send something, skipped when a rule runs over existing mail. */
export const SENDING_ACTIONS = new Set(["forward", "autoReply", "webhook"])

/** “212 matches · last 2 min ago”, or “never matched”. */
export function matchWords(count: number | string, lastAt: number | string | null, now = Date.now()) {
  const n = num(count) ?? 0
  const last = toDate(lastAt)
  const ago = last ? relativeShort(last.getTime(), now) : null
  return {
    count: `${n.toLocaleString("en")} ${n === 1 ? "match" : "matches"}`,
    last: ago ? `last ${ago}` : "never matched",
  }
}

export function relativeShort(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`
  return utcStamp(at).split(",")[0] ?? ""
}

/* ───────────── A rule from a message ───────────── */

export type RuleMessage = {
  subject: string
  from: { name?: string | null; address: string } | null
  listId: string | null
  tag: string | null
  to: { address: string }[]
  cc: { address: string }[]
  snippet: string
  automated: boolean
  attachments: unknown[]
  body?: { text: string } | undefined
}

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
])
const STOP = new Set([
  "re",
  "fwd",
  "fw",
  "the",
  "and",
  "for",
  "with",
  "your",
  "you",
  "from",
  "about",
  "this",
  "that",
  "have",
  "didn’t",
  "didn't",
  "can’t",
  "can't",
])

/** The subject without Re:/Fwd: prefixes. */
export const bareSubject = (s: string) => s.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim()

/** The first word of a subject worth matching on (≥ 4 letters, not a stop word), lower-cased. */
export function keyword(subject: string): string | null {
  for (const w of bareSubject(subject).split(/[^\p{L}\p{N}’']+/u)) {
    const lw = w.toLowerCase()
    if (lw.length >= 4 && !STOP.has(lw)) return lw
  }
  return null
}

const titleCase = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s)

/** A new rule filled in from a message: who it's from (or its list), a subject word, no actions yet. */
export function prefillFromMessage(m: RuleMessage): RuleCreate {
  const conditions: RuleCondition[] = []
  let source = "this sender"
  if (m.listId) {
    conditions.push({ field: "listId", op: "equals", value: m.listId })
    source = m.listId
  } else if (m.from) {
    const address = m.from.address.toLowerCase()
    const domain = address.split("@")[1] ?? ""
    if (domain && !FREEMAIL.has(domain)) {
      conditions.push({ field: "from", op: "endsWith", value: `@${domain}` })
      source = domain
    } else {
      conditions.push({ field: "from", op: "equals", value: address })
      source = m.from.name?.trim() || address
    }
  }
  const word = keyword(m.subject)
  if (word) conditions.push({ field: "subject", op: "contains", value: word })
  return {
    name: word ? `${titleCase(word)} from ${source}` : `Mail from ${source}`,
    enabled: true,
    match: "all",
    conditions,
    actions: [],
    stop: false,
  }
}

const fieldText = (m: RuleMessage, field: string): string[] => {
  switch (field) {
    case "from":
      return m.from ? [m.from.address, m.from.name ?? ""] : []
    case "to":
      return m.to.map((p) => p.address)
    case "cc":
      return m.cc.map((p) => p.address)
    case "recipients":
      return [...m.to, ...m.cc].map((p) => p.address)
    case "subject":
      return [m.subject]
    case "listId":
      return m.listId ? [m.listId] : []
    case "tag":
      return m.tag ? [m.tag] : []
    case "body":
      return [m.body?.text ?? m.snippet]
    default:
      return []
  }
}

/** One condition against a message, as the server evaluates it (case-insensitive). */
export function conditionMatches(c: RuleCondition, m: RuleMessage): boolean {
  if (c.field === "hasAttachment") return m.attachments.length > 0 === c.value
  if (c.field === "automated") return m.automated === c.value
  const want = c.value.toLowerCase()
  const values = fieldText(m, c.field).map((v) => v.toLowerCase())
  const test = (v: string) => {
    switch (c.op) {
      case "contains":
        return v.includes(want)
      case "notContains":
        return !v.includes(want)
      case "equals":
        return v === want
      case "startsWith":
        return v.startsWith(want)
      case "endsWith":
        return v.endsWith(want)
      default:
        return false
    }
  }
  return c.op === "notContains" ? values.every(test) : values.some(test)
}

/** Whether a rule (saved or still being written) matches a message. No conditions match nothing. */
export function ruleMatches(match: "all" | "any", conditions: readonly RuleCondition[], m: RuleMessage) {
  if (!conditions.length) return false
  return match === "all"
    ? conditions.every((c) => conditionMatches(c, m))
    : conditions.some((c) => conditionMatches(c, m))
}

/** What's wrong with a rule before it's saved, or null. */
export function ruleProblem(r: RuleCreate): string | null {
  if (!r.name.trim()) return "Give the rule a name."
  if (!r.conditions.length) return "Add at least one condition."
  if (r.conditions.some((c) => "op" in c && !c.value.trim())) return "Every condition needs a value."
  if (!r.actions.length) return "Add at least one action."
  for (const a of r.actions) {
    if (a.type === "label" && !a.labelId) return "Choose a label."
    if (a.type === "forward" && !a.to.filter((t) => /.+@.+\..+/.test(t)).length)
      return "Forward needs an address."
    if (a.type === "assign" && !a.assignee) return "Choose who to assign to."
    if (a.type === "autoReply" && (!a.subject.trim() || !a.body.trim()))
      return "An auto-reply needs a subject and a body."
    if (a.type === "webhook" && !a.endpointId.trim()) return "Choose a webhook."
  }
  return null
}

/* ───────────── Reordering ───────────── */

/** Moves one id to a new index. Out-of-range moves leave the order as it was. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/* ───────────── Senders ───────────── */

export const SOURCE_WORDS: Record<string, string> = {
  user: "Added by hand",
  not_spam: "From “Not spam”",
  spam: "From “Mark as spam”",
}

/** An address or a whole domain, normalised; null when it's neither. */
export function senderValue(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^@/, "")
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v
  if (/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(v)) return v
  return null
}

/**
 * A trusted image sender as the API stores it: an address, or a whole domain written `@example.com`
 * (`SENDER_VALUE` in the backend). Accepts `example.com` or `@example.com` for a domain.
 */
export function imageSenderValue(raw: string): string | null {
  const v = senderValue(raw)
  if (!v) return null
  return v.includes("@") ? v : `@${v}`
}

/* ───────────── Import arithmetic ───────────── */

export function importProgress(imp: Pick<MailImport, "totals">) {
  const t = imp.totals
  const source = num(t.source) ?? 0
  const imported = num(t.imported) ?? 0
  const duplicates = num(t.duplicates) ?? 0
  const failed = num(t.failed) ?? 0
  const skipped = num(t.skipped) ?? 0
  const done = imported + duplicates + failed + skipped
  const pct = source > 0 ? Math.min(100, Math.round((done / source) * 100)) : 0
  return { source, imported, duplicates, failed, skipped, done, pct }
}

export const folderProgress = (f: MailImport["folders"][number]) => {
  const source = num(f.source) ?? 0
  const done =
    (num(f.imported) ?? 0) + (num(f.duplicates) ?? 0) + (num(f.failed) ?? 0) + (num(f.skipped) ?? 0)
  return source > 0 ? Math.min(100, Math.round((done / source) * 100)) : done > 0 ? 100 : 0
}

export function folderState(f: MailImport["folders"][number], status: MailImport["status"]) {
  const source = num(f.source) ?? 0
  const skipped = num(f.skipped) ?? 0
  if (source > 0 && skipped >= source) return { label: "Skipped", tone: "neutral" as const }
  const pct = folderProgress(f)
  if (pct >= 100)
    return {
      label: (num(f.failed) ?? 0) > 0 ? "Done with failures" : "Done",
      tone: (num(f.failed) ?? 0) > 0 ? ("warn" as const) : ("pass" as const),
    }
  const started = (num(f.batchesDone) ?? 0) > 0 || (num(f.imported) ?? 0) > 0
  if (status === "paused")
    return { label: started ? "Paused" : "Waiting", tone: started ? ("warn" as const) : ("neutral" as const) }
  if (status === "failed")
    return {
      label: started ? "Stopped" : "Not started",
      tone: started ? ("fail" as const) : ("neutral" as const),
    }
  if (status === "cancelled") return { label: "Cancelled", tone: "neutral" as const }
  return started
    ? { label: "Copying", tone: "info" as const }
    : { label: "Waiting", tone: "neutral" as const }
}

/** “done about 17:56 UTC, in 0 h 08 min”. */
export function etaWords(etaAt: number | string | null, now = Date.now()) {
  const d = toDate(etaAt)
  if (!d) return null
  const m = Math.max(0, Math.round((d.getTime() - now) / 60000))
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `done about ${hh}:${mm} UTC, in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}

/** Minutes between two instants as “23 min” or “1 h 05 min”. */
export function durationWords(from: number | string | null, to: number | string | null) {
  const a = toDate(from)
  const b = toDate(to)
  if (!a || !b) return null
  const m = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}

export const retryableCount = (imp: Pick<MailImport, "folders">) =>
  imp.folders.reduce((n, f) => n + (num(f.retryable) ?? 0), 0)

export const isActive = (s: MailImport["status"]) => s === "pending" || s === "running"

/** An `import.progress` frame merged into the import it describes. */
export function applyImportProgress(imp: MailImport, f: Readonly<Record<string, unknown>>): MailImport {
  if (f.importId !== imp.id) return imp
  return {
    ...imp,
    ...(typeof f.status === "string" ? { status: f.status as MailImport["status"] } : {}),
    ...(f.totals && typeof f.totals === "object"
      ? { totals: { ...imp.totals, ...(f.totals as MailImport["totals"]) } }
      : {}),
    ...(f.ratePerMinute !== undefined ? { ratePerMinute: f.ratePerMinute as number | null } : {}),
    ...(f.etaAt !== undefined ? { etaAt: f.etaAt as number | null } : {}),
    ...(Array.isArray(f.folders) && f.folders.length
      ? {
          folders: imp.folders.map((old) => {
            const next = (f.folders as MailImport["folders"]).find((x) => x.name === old.name)
            return next ? { ...old, ...next } : old
          }),
        }
      : {}),
  }
}

/* ───────────── Export ───────────── */

/** “Links work until Sun 18 Oct, 17:08 UTC”, or that they've stopped. */
export function expiryWords(e: Pick<MailExport, "downloadsExpireAt">, now = Date.now()) {
  const d = toDate(e.downloadsExpireAt)
  if (!d) return null
  return d.getTime() > now
    ? `Links work until ${utcStamp(d.getTime())}; after that, Export again makes fresh ones.`
    : `These links stopped working ${utcStamp(d.getTime())}. Export again for fresh ones.`
}

export const exportPct = (e: Pick<MailExport, "messageCount">, total: number | null) => {
  const n = num(e.messageCount) ?? 0
  return total && total > 0 ? Math.min(100, Math.round((n / total) * 100)) : null
}

export const FORMAT_WORDS: Record<string, string> = {
  mbox: "mbox",
  "eml-zip": ".eml zip",
  both: "mbox and .eml zip",
}

/* ───────────── The rule test, with the rule being written ───────────── */

export type Outcome = {
  matched: string[]
  folder: string | null
  labelIds: string[]
  markRead: boolean
  star: boolean
  skipSpamCheck: boolean
  forwards: { ruleId: string; to: string[] }[]
  autoReplies: { ruleId: string; subject: string }[]
  webhooks: { ruleId: string; endpointId: string }[]
  assignee: string | null
  stoppedAt: string | null
}

/**
 * `rules/test` runs the saved rules over a message; a rule still being written isn't saved yet, so its effect
 * is added here, as the server would: after the existing rules, unless one of them stopped the run.
 */
export function withDraftRule(
  server: Outcome,
  draft: { id: string; matches: boolean; actions: readonly RuleAction[]; stop: boolean },
): Outcome & { draftRan: boolean } {
  if (!draft.matches || server.stoppedAt) return { ...server, draftRan: false }
  const o: Outcome = { ...server, matched: [...server.matched, draft.id], labelIds: [...server.labelIds] }
  for (const a of draft.actions) {
    switch (a.type) {
      case "label":
        if (!o.labelIds.includes(a.labelId)) o.labelIds.push(a.labelId)
        break
      case "archive":
      case "trash":
      case "spam":
        o.folder = a.type
        break
      case "markRead":
        o.markRead = true
        break
      case "star":
        o.star = true
        break
      case "skipSpamCheck":
        o.skipSpamCheck = true
        break
      case "forward":
        o.forwards = [...o.forwards, { ruleId: draft.id, to: a.to }]
        break
      case "autoReply":
        o.autoReplies = [...o.autoReplies, { ruleId: draft.id, subject: a.subject }]
        break
      case "webhook":
        o.webhooks = [...o.webhooks, { ruleId: draft.id, endpointId: a.endpointId }]
        break
      case "assign":
        o.assignee = a.assignee
        break
    }
  }
  if (draft.stop) o.stoppedAt = draft.id
  return { ...o, draftRan: true }
}

/** “No forwards, auto-replies or webhooks”, or what would be sent. */
export function sendsWords(o: Pick<Outcome, "forwards" | "autoReplies" | "webhooks">) {
  const parts = [
    ...o.forwards.map((f) => `forward to ${f.to.join(", ")}`),
    ...o.autoReplies.map((r) => `auto-reply “${r.subject}”`),
    ...o.webhooks.map((w) => `webhook ${w.endpointId}`),
  ]
  return parts.length ? parts.join("; ") : "No forwards, auto-replies or webhooks"
}

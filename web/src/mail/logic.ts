/**
 * Mail's pure logic: the list URL, what a thread list holds after a live frame, search highlights, the
 * authentication line, times and names. No React here, so all of it is unit-tested (logic.test.ts).
 */
import { num, toDate } from "../lib/format.ts"
import type {
  Agent,
  BulkAction,
  Draft,
  Folder,
  ListQuery,
  MessageSummary,
  Note,
  Party,
  SearchSort,
  Thread,
  ThreadDetail,
  ThreadPage,
} from "./types.ts"

/* ───────────── The list URL ───────────── */

export const FOLDERS: readonly Folder[] = ["inbox", "archive", "sent", "spam", "trash", "snoozed"]
const isFolder = (v: unknown): v is Folder | "all" =>
  typeof v === "string" && (v === "all" || (FOLDERS as readonly string[]).includes(v))
const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1"
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

/** Search params → the list query. Inbox is the default and stays out of the URL. */
export function validateListSearch(s: Record<string, unknown>): ListQuery {
  const folder = isFolder(s.folder) && s.folder !== "inbox" ? s.folder : undefined
  const q = str(s.q)
  return {
    ...(folder ? { folder } : {}),
    ...(str(s.labelId) ? { labelId: str(s.labelId) as string } : {}),
    ...(truthy(s.unread) ? { unread: true } : {}),
    ...(truthy(s.starred) ? { starred: true } : {}),
    ...(str(s.assignee) ? { assignee: str(s.assignee) as string } : {}),
    ...(truthy(s.att) ? { att: true } : {}),
    ...(q ? { q } : {}),
    ...(s.sort === "relevance" ? { sort: "relevance" as SearchSort } : {}),
  }
}

/** The list query → search params (what Copy link copies). */
export function listSearchString(q: ListQuery): string {
  const p = new URLSearchParams()
  if (q.folder) p.set("folder", q.folder)
  if (q.labelId) p.set("labelId", q.labelId)
  if (q.unread) p.set("unread", "true")
  if (q.starred) p.set("starred", "true")
  if (q.assignee) p.set("assignee", q.assignee)
  if (q.att) p.set("att", "1")
  if (q.q) p.set("q", q.q)
  if (q.sort) p.set("sort", q.sort)
  const s = p.toString()
  return s ? `?${s}` : ""
}

/** Which folder a list is, for its title and the folder pane's current item. */
export function listKind(q: ListQuery): string {
  if (q.q) return "search"
  if (q.labelId) return `label:${q.labelId}`
  if (q.starred) return "starred"
  if (q.assignee) return "assigned"
  return q.folder ?? "inbox"
}

export const FOLDER_TITLE: Record<Folder | "all" | "drafts" | "scheduled", string> = {
  inbox: "Inbox",
  archive: "Archive",
  sent: "Sent",
  spam: "Spam",
  trash: "Trash",
  snoozed: "Snoozed",
  all: "All mail",
  drafts: "Drafts",
  scheduled: "Scheduled",
}

/** Whether a list has a server-side filter on top of its folder, so `total` is null (HAL-3367). */
export const isFiltered = (q: ListQuery) => Boolean(q.unread || q.att)

/* ───────────── Live frames applied to the cache ───────────── */

/** Whether a thread belongs in a list with this query: the server's rules, applied to the summary. */
export function threadMatches(t: Thread, q: ListQuery): boolean {
  const folders = t.folders as readonly Folder[]
  if (q.folder === "all") {
    if (!folders.some((f) => f !== "spam" && f !== "trash")) return false
  } else if (q.folder) {
    if (!folders.includes(q.folder)) return false
  } else if (!q.labelId && !q.starred && !q.assignee) {
    if (!folders.includes("inbox")) return false
  }
  if (q.labelId && !t.labelIds.includes(q.labelId)) return false
  if (q.starred && !t.starred) return false
  if (q.unread && !(num(t.unreadCount) ?? 0)) return false
  if (q.assignee && t.assignee !== q.assignee) return false
  return true
}

type Pages = { pages: ThreadPage[]; pageParams: unknown[] }

const sortAt = (t: Thread) => num(t.sortAt) ?? 0

/**
 * A thread list after a frame: changed threads replace their old copy, ones that now match slide in by
 * sortAt (only into the first page, so a later page never shows a row the server would put elsewhere),
 * ones that no longer match leave, and removed ids go. `total` follows what moved in and out.
 */
export function applyThreadsToPages(
  data: Pages | undefined,
  q: ListQuery,
  changed: readonly Thread[],
  removed: readonly string[],
): Pages | undefined {
  if (!data) return data
  const byId = new Map(changed.map((t) => [t.id, t]))
  const gone = new Set(removed)
  const present = new Set<string>()
  let delta = 0
  const pages = data.pages.map((page) => {
    const threads: Thread[] = []
    for (const t of page.threads) {
      if (gone.has(t.id)) {
        delta--
        continue
      }
      const next = byId.get(t.id)
      if (next) {
        present.add(t.id)
        if (threadMatches(next, q)) threads.push(next)
        else delta--
      } else threads.push(t)
    }
    return { ...page, threads }
  })
  const incoming = changed.filter((t) => !present.has(t.id) && threadMatches(t, q))
  if (incoming.length && pages[0]) {
    const first = pages[0]
    const merged = [...incoming, ...first.threads].sort((a, b) => sortAt(b) - sortAt(a))
    // Keep a row out of page one when it sorts below everything loaded there and more pages exist.
    const lastLoaded = first.threads[first.threads.length - 1]
    const kept =
      pages.length === 1 && !first.nextCursor
        ? merged
        : merged.filter((t) => !incoming.includes(t) || !lastLoaded || sortAt(t) >= sortAt(lastLoaded))
    delta += kept.length - first.threads.length
    pages[0] = { ...first, threads: kept }
  }
  const t0 = pages[0]
  if (t0 && t0.total !== null && t0.total !== undefined) {
    const total = num(t0.total)
    if (total !== null) pages[0] = { ...t0, total: Math.max(0, total + delta) }
  }
  return { ...data, pages }
}

/** A thread detail after a `threads.changed` frame carrying its summary. */
export function applyThreadToDetail(d: ThreadDetail | undefined, t: Thread): ThreadDetail | undefined {
  return d && d.thread.id === t.id ? { ...d, thread: t } : d
}

/** A thread detail after `drafts.changed`: this thread's drafts replaced, removed ones dropped. */
export function applyDraftsToDetail(
  d: ThreadDetail | undefined,
  drafts: readonly Draft[],
  removed: readonly string[],
): ThreadDetail | undefined {
  if (!d) return d
  const gone = new Set(removed)
  const mine = drafts.filter((x) => x.threadId === d.thread.id)
  const ids = new Set(mine.map((x) => x.id))
  const kept = d.drafts.filter((x) => !gone.has(x.id) && !ids.has(x.id))
  if (kept.length === d.drafts.length && !mine.length) return d
  return { ...d, drafts: [...kept, ...mine] }
}

/** A drafts list after `drafts.changed`: upserts that still match the list's status, removals dropped. */
export function applyDraftsToList(
  list: { drafts: Draft[] } | undefined,
  status: Draft["status"] | "all",
  drafts: readonly Draft[],
  removed: readonly string[],
): { drafts: Draft[] } | undefined {
  if (!list) return list
  const gone = new Set([...removed, ...drafts.map((d) => d.id)])
  const kept = list.drafts.filter((d) => !gone.has(d.id))
  const add = drafts.filter((d) => status === "all" || d.status === status)
  return {
    ...list,
    drafts: [...add, ...kept].sort((a, b) => (num(b.updatedAt) ?? 0) - (num(a.updatedAt) ?? 0)),
  }
}

/** `notes.changed` carries author ids; names come from what the cache already knows. */
export function applyNotesToDetail(
  d: ThreadDetail | undefined,
  threadId: string,
  notes: readonly { id: string; author: string; body: string; createdAt: number }[],
): { detail: ThreadDetail | undefined; unknownAuthor: boolean } {
  if (!d || d.thread.id !== threadId) return { detail: d, unknownAuthor: false }
  const names = new Map(d.notes.map((n) => [n.author.id, n.author.name]))
  let unknownAuthor = false
  const next: Note[] = notes.map((n) => {
    const name = names.get(n.author)
    if (!name) unknownAuthor = true
    return {
      id: n.id,
      body: n.body,
      createdAt: n.createdAt,
      author: { id: n.author, name: name ?? n.author },
    }
  })
  return { detail: { ...d, notes: next }, unknownAuthor }
}

/* ───────────── Search highlights ───────────── */

export const HL_START = "\u0002"
export const HL_END = "\u0003"

/** Splits the API's marked text into plain and matched runs: `\u0002…\u0003` become <mark>. */
export function highlightRuns(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  let hit = false
  let buf = ""
  for (const ch of s) {
    if (ch === HL_START || ch === HL_END) {
      if (buf) out.push({ text: buf, hit })
      buf = ""
      hit = ch === HL_START
      continue
    }
    buf += ch
  }
  if (buf) out.push({ text: buf, hit })
  return out
}

export const stripMarks = (s: string) => s.replaceAll(HL_START, "").replaceAll(HL_END, "")

/** The search box's operators, for the help and the suggestions (search-operators). */
export const OPERATORS: { op: string; hint: string; example: string }[] = [
  { op: "from:", hint: "Sender address or name", example: "from:ada@gmail.com" },
  { op: "to:", hint: "A recipient", example: "to:billing@" },
  { op: "subject:", hint: "Words in the subject", example: "subject:refund" },
  { op: "has:attachment", hint: "Only threads with files", example: "has:attachment" },
  { op: "is:unread", hint: "Unread only", example: "is:unread" },
  { op: "is:starred", hint: "Starred only", example: "is:starred" },
  { op: "in:", hint: "A folder: inbox, sent, archive, spam, trash", example: "in:sent" },
  { op: "label:", hint: "A label’s name", example: "label:billing" },
  { op: "after:", hint: "On or after a day, YYYY-MM-DD (inclusive)", example: "after:2026-10-01" },
  { op: "before:", hint: "Before a day, YYYY-MM-DD (exclusive)", example: "before:2026-10-15" },
]

/** Removes one operator from a query string, for the chip's ×. */
export function removeOperator(q: string, op: string, value: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const quoted = new RegExp(`(^|\\s)${esc(op)}:("${esc(value)}"|${esc(value)})(?=\\s|$)`, "i")
  return q.replace(quoted, " ").replace(/\s+/g, " ").trim()
}

/** The operator being typed at the end of the box (`fro` → from:), for suggestions. */
export function operatorSuggestions(q: string) {
  const last = q.split(/\s+/).pop() ?? ""
  if (!last || last.includes(":")) return []
  return OPERATORS.filter((o) => o.op.startsWith(last.toLowerCase()) && o.op !== last)
}

/* ───────────── People, names, initials ───────────── */

export function initials(name: string | null | undefined, address?: string): string {
  const src = (name ?? "").trim() || (address ?? "").split("@")[0] || "?"
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "")
  return (a + b).toUpperCase()
}

export const partyName = (p: { name?: string | null; address: string } | null | undefined) =>
  p ? p.name?.trim() || p.address : "Unknown sender"

/**
 * The row's names: participants with the mailbox's own address shown as “us”, like the designs.
 * `ours` is every address this mailbox sends as.
 */
export function namesLine(participants: readonly Party[], ours: ReadonlySet<string>) {
  const out: { name: string; us: boolean }[] = []
  for (const p of participants) {
    const us = ours.has(p.address.toLowerCase())
    if (us && out.some((x) => x.us)) continue
    out.push({ name: us ? "us" : partyName(p), us })
  }
  return out.slice(0, 4)
}

/** The first participant that isn't us: whose avatar a row shows. */
export function counterpart(participants: readonly Party[], ours: ReadonlySet<string>) {
  return participants.find((p) => !ours.has(p.address.toLowerCase())) ?? participants[0] ?? null
}

/* ───────────── Times (UTC until me.timeZone, HAL-3361) ───────────── */

const DAY = 86_400_000
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")

/** Rows: `2 min`, `5 h`, `3 d`, then `12 Oct`. */
export function rowTime(v: number | string | null | undefined, now = Date.now()): string {
  const d = toDate(v)
  if (!d) return ""
  const s = Math.max(0, (now - d.getTime()) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`
  const y = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : ` ${d.getUTCFullYear()}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${y}`
}

/** `Sat 17 Oct, 17:46 UTC`. */
export function utcStamp(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** `Sun 08:00 UTC`: a short day-and-time for picker rows and chips. */
export function utcShort(v: number | string | null | undefined): string {
  const d = toDate(v)
  if (!d) return "—"
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** `Sat 17 Oct, 17:46 UTC · 2 min ago`, the reader's stamp. */
export function readerTime(v: number | string | null | undefined, now = Date.now()): string {
  const t = rowTime(v, now)
  if (!t) return "—"
  const ago = t === "now" ? "just now" : /\d (min|h|d)$/.test(t) ? `${t} ago` : t
  return `${utcStamp(v)} · ${ago}`
}

/** The snooze presets: later today (18:00 or +3 h), tomorrow 08:00, Monday 08:00, next week. All UTC. */
export function snoozePresets(now = Date.now()) {
  const d = new Date(now)
  const at = (days: number, h: number) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, h, 0, 0)
  const laterToday = Math.max(at(0, 18), now + 3 * 3600_000)
  const sameDay = new Date(laterToday).getUTCDate() === d.getUTCDate()
  const dow = d.getUTCDay()
  const toMonday = ((8 - dow) % 7 || 7) as number
  const out = [
    ...(sameDay ? [{ label: "Later today", until: Math.ceil(laterToday / 3600_000) * 3600_000 }] : []),
    { label: "Tomorrow morning", until: at(1, 8) },
    ...(toMonday > 1 ? [{ label: "Monday morning", until: at(toMonday, 8) }] : []),
    { label: "Next week", until: at(toMonday + 7, 8) },
  ]
  // De-duplicate presets that land on the same instant (Sunday: Monday morning is also tomorrow).
  return out.filter((o, i) => out.findIndex((x) => x.until === o.until) === i)
}

/** A date (YYYY-MM-DD) and time (HH:MM) typed as UTC → epoch ms, or null when either is invalid. */
export function utcFromInputs(date: string, time: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const t = time.match(/^(\d{2}):(\d{2})$/)
  if (!m || !t) return null
  const v = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]))
  return Number.isFinite(v) ? v : null
}

export const dateInput = (v: number) => {
  const d = new Date(v)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
export const timeInput = (v: number) => {
  const d = new Date(v)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
export const daysUntil = (v: number | string | null | undefined, now = Date.now()) => {
  const d = toDate(v)
  return d ? Math.max(0, Math.ceil((d.getTime() - now) / DAY)) : null
}

/* ───────────── Files ───────────── */

export function fileSize(bytes: number | string | null | undefined): string {
  const n = num(bytes)
  if (n === null) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`
}

export function fileExt(name: string | null | undefined, mime: string): string {
  const fromName = name?.includes(".") ? name.split(".").pop() : undefined
  const fromMime = mime
    .split("/")
    .pop()
    ?.split(/[+.;-]/)[0]
  return (fromName || fromMime || "file").slice(0, 4).toUpperCase()
}

export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime)
export const isPdf = (mime: string) => mime.toLowerCase() === "application/pdf"

/* ───────────── Authentication line ───────────── */

export type AuthChip = {
  key: string
  label: string
  result: string
  sub?: string
  tone: "pass" | "fail" | "warn" | "neutral"
}

const tone = (r: string | null | undefined): AuthChip["tone"] => {
  const v = (r ?? "").toLowerCase()
  if (v === "pass") return "pass"
  if (v === "fail" || v === "permerror" || v === "hardfail") return "fail"
  if (v === "softfail" || v === "temperror" || v === "neutral") return "warn"
  return "neutral"
}

/** SPF, DKIM, DMARC and ARC as Cloudflare saw them (message.auth), in that order. */
export function authChips(auth: MessageSummary["auth"]): AuthChip[] {
  const out: AuthChip[] = []
  if (auth.spf) out.push({ key: "spf", label: "SPF", result: auth.spf, tone: tone(auth.spf) })
  const dkim = auth.dkim[0]
  if (dkim) {
    const worst = auth.dkim.find((k) => tone(k.result) === "fail") ?? dkim
    out.push({
      key: "dkim",
      label: "DKIM",
      result: worst.result,
      tone: tone(worst.result),
      ...(worst.domain ? { sub: `d=${worst.domain}` } : {}),
    })
  }
  if (auth.dmarc) out.push({ key: "dmarc", label: "DMARC", result: auth.dmarc, tone: tone(auth.dmarc) })
  if (auth.arc) {
    const i = num(auth.arc.instance)
    const sub = [i !== null ? `i=${i}` : null, auth.arc.sealer].filter(Boolean).join(" · ")
    out.push({
      key: "arc",
      label: "ARC",
      result: auth.arc.result,
      tone: tone(auth.arc.result),
      ...(sub ? { sub } : {}),
    })
  }
  return out
}

/** The plain-words warning when authentication failed (thread-auth-fail), or null when it didn't. */
export function authWarning(auth: MessageSummary["auth"]): string | null {
  const chips = authChips(auth)
  const failed = chips.filter((c) => c.tone === "fail").map((c) => c.label)
  if (!failed.length) return null
  const arcPass = chips.find((c) => c.key === "arc")?.tone === "pass"
  const what =
    failed.length > 1 ? `${failed.slice(0, -1).join(", ")} and ${failed[failed.length - 1]}` : failed[0]
  return arcPass
    ? `${what} failed, but ARC passed: a forwarder probably changed the message on the way. Be careful with links and attachments unless you expected it.`
    : `${what} failed: this message may not be from who it says. Don’t open attachments or follow links unless you’re sure.`
}

/* ───────────── Delivery of our replies ───────────── */

export const DELIVERY_TONE: Record<string, "pass" | "warn" | "fail" | "neutral"> = {
  delivered: "pass",
  sent: "neutral",
  queued: "neutral",
  deferred: "warn",
  bounced: "fail",
  failed: "fail",
  rejected: "fail",
  complained: "fail",
  suppressed: "fail",
}

export const DELIVERY_WORDS: Record<string, string> = {
  queued: "Queued: waiting its turn to go out.",
  sent: "Sent: handed to Cloudflare Email Service; no answer from the receiving server yet.",
  delivered: "Delivered: the receiving server accepted it.",
  deferred: "Deferred: the receiving server said try later; Mailyard retries on its own.",
  bounced: "Bounced: the receiving server refused it for good.",
  failed: "Failed: it couldn’t be sent; nothing more will be tried.",
  rejected: "Rejected: refused before it left, usually by a check on our side.",
  complained: "Complained: the recipient marked it as spam.",
  suppressed: "Suppressed: the address is on the suppression list, so it wasn’t sent.",
}

export const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s)

/** The summary pills for a sent copy: “2 delivered · 1 deferred”. */
export function deliveryCounts(recipients: readonly { status: string }[]) {
  const counts = new Map<string, number>()
  for (const r of recipients) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, n]) => ({ status, n, tone: DELIVERY_TONE[status] ?? "neutral" }))
}

/* ───────────── Agents ───────────── */

/** The agent that owns a mailbox, if one does (GET /v1/agents, HAL-3460). Removed agents don't count. */
export function agentFor(mailboxId: string, agents: readonly Agent[] | undefined): Agent | undefined {
  return agents?.find((a) => a.mailbox.id === mailboxId && a.removedAt === null)
}

/* ───────────── Selection and keyboard ───────────── */

/** Range-select with Shift: every id between the anchor and the clicked one, in list order. */
export function rangeSelect(order: readonly string[], anchor: string | null, to: string): string[] {
  const a = anchor ? order.indexOf(anchor) : -1
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return [to]
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1)
}

/** The keys Mail answers (HANDOFF-mail §6), shown in tooltips and the ? sheet. */
export const SHORTCUTS: { keys: string; label: string; group: "Move" | "Act" | "Write" }[] = [
  { keys: "J", label: "Next conversation", group: "Move" },
  { keys: "K", label: "Previous conversation", group: "Move" },
  { keys: "↵ · O", label: "Open", group: "Move" },
  { keys: "U", label: "Back to the list", group: "Move" },
  { keys: "/", label: "Search this mailbox", group: "Move" },
  { keys: "G then I", label: "Go to Inbox", group: "Move" },
  { keys: "G then S", label: "Go to Starred", group: "Move" },
  { keys: "G then T", label: "Go to Sent", group: "Move" },
  { keys: "G then D", label: "Go to Drafts", group: "Move" },
  { keys: "G then A", label: "Go to All mail", group: "Move" },
  { keys: "X", label: "Select", group: "Act" },
  { keys: "⇧ X", label: "Select all", group: "Act" },
  { keys: "E", label: "Archive", group: "Act" },
  { keys: "#", label: "Delete", group: "Act" },
  { keys: "!", label: "Spam", group: "Act" },
  { keys: "S", label: "Snooze", group: "Act" },
  { keys: "L", label: "Label", group: "Act" },
  { keys: "V", label: "Move", group: "Act" },
  { keys: "A", label: "Assign", group: "Act" },
  { keys: "⇧ S", label: "Star", group: "Act" },
  { keys: "⇧ U", label: "Mark unread", group: "Act" },
  { keys: "⇧ I", label: "Mark read", group: "Act" },
  { keys: "R", label: "Reply", group: "Write" },
  { keys: "⇧ R", label: "Reply all", group: "Write" },
  { keys: "F", label: "Forward", group: "Write" },
  { keys: "N", label: "Internal note", group: "Write" },
  { keys: "C", label: "Compose", group: "Write" },
  { keys: "⌘ ↵", label: "Send", group: "Write" },
  { keys: "Z", label: "Undo send", group: "Write" },
  { keys: "?", label: "Mail shortcuts", group: "Write" },
]

/** What a keydown means in a mailbox, or null to let it through. Pure, so the map is tested. */
export type MailKey =
  | "next"
  | "prev"
  | "open"
  | "back"
  | "select"
  | "selectAll"
  | "archive"
  | "delete"
  | "spam"
  | "snooze"
  | "label"
  | "move"
  | "assign"
  | "star"
  | "unread"
  | "read"
  | "reply"
  | "replyAll"
  | "forward"
  | "note"
  | "search"
  | "help"
  | "escape"

export function mailKey(e: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): MailKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const k = e.key
  if (e.shiftKey) {
    if (k === "X") return "selectAll"
    if (k === "S") return "star"
    if (k === "U") return "unread"
    if (k === "I") return "read"
    if (k === "R") return "replyAll"
    if (k === "#") return "delete"
    if (k === "!") return "spam"
    if (k === "?") return "help"
    return null
  }
  switch (k) {
    case "j":
    case "ArrowDown":
      return "next"
    case "k":
    case "ArrowUp":
      return "prev"
    case "Enter":
    case "o":
      return "open"
    case "u":
      return "back"
    case "x":
      return "select"
    case "e":
      return "archive"
    case "#":
      return "delete"
    case "!":
      return "spam"
    case "s":
      return "snooze"
    case "l":
      return "label"
    case "v":
      return "move"
    case "a":
      return "assign"
    case "r":
      return "reply"
    case "f":
      return "forward"
    case "n":
      return "note"
    case "/":
      return "search"
    case "?":
      return "help"
    case "Escape":
      return "escape"
    default:
      return null
  }
}

/** The mailbox g-chords (G then I…). The shell owns G then a section letter; these win inside a mailbox. */
export const MAIL_CHORDS: Record<
  string,
  { label: string; search: Partial<ListQuery>; to?: "drafts" | "scheduled" }
> = {
  i: { label: "Inbox", search: {} },
  s: { label: "Starred", search: { starred: true } },
  t: { label: "Sent", search: { folder: "sent" } },
  d: { label: "Drafts", search: {}, to: "drafts" },
  a: { label: "All mail", search: { folder: "all" } },
}

/* ───────────── Composer helpers shared with the reader ───────────── */

/** `Re: ` once, never `Re: Re:`. */
export const replySubject = (s: string) => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`)
export const forwardSubject = (s: string) => (/^fwd?:/i.test(s.trim()) ? s.trim() : `Fwd: ${s.trim()}`)

/* ───────────── What the caller may do in a mailbox ───────────── */

type MeLike = {
  role: "owner" | "admin" | "sender" | "agent" | "viewer" | null
  via: string
  scopes: readonly string[]
  permissions: readonly string[]
  mailboxes?: readonly { id: string; address: string; access: "owner" | "member" | "viewer" | null }[] | null
}

const PERM_SCOPE: Record<string, string> = {
  "mail.read": "read",
  "mail.send": "send",
  "mail.manage": "admin",
}
const PERM_ROLES: Record<string, readonly string[]> = {
  "mail.read": ["owner", "admin", "sender", "agent", "viewer"],
  "mail.send": ["owner", "admin", "sender", "agent"],
  "mail.manage": ["owner", "admin"],
}

/** A workspace permission (HAL-3361): the session's list when it has one, else the role, else the key's scope. */
export function hasPerm(me: MeLike | undefined, p: "mail.read" | "mail.send" | "mail.manage"): boolean {
  if (!me) return false
  if (me.via === "admin-key") return true
  if (me.permissions.length) return me.permissions.includes(p)
  if (me.role) return (PERM_ROLES[p] ?? []).includes(me.role)
  return me.scopes.includes(PERM_SCOPE[p] ?? "admin")
}

export type MailAccess = {
  read: boolean
  /** Reply, move, label, assign, snooze, notes. */
  write: boolean
  /** Rules, senders, import and export. */
  manage: boolean
  /** Why writing is off, for the disabled controls' first line. */
  writeReason: string
  /** Who can, for the second line. */
  writeWho: string
  manageReason: string
  manageWho: string
  /** This person's access on the mailbox, when people exist (`me.mailboxes[].access`). */
  mailboxAccess: "owner" | "member" | "viewer" | null
}

export function mailAccess(me: MeLike | undefined, mailboxId: string): MailAccess {
  const entry = me?.mailboxes?.find((m) => m.id === mailboxId)
  const mailboxAccess = entry?.access ?? null
  const read = hasPerm(me, "mail.read")
  const send = hasPerm(me, "mail.send")
  const viewerHere = mailboxAccess === "viewer"
  const write = read && send && !viewerHere
  const manage = hasPerm(me, "mail.manage") || mailboxAccess === "owner"
  const keyOnly = me ? !me.role && me.via !== "admin-key" : false
  return {
    read,
    write,
    manage,
    mailboxAccess,
    writeReason: viewerHere
      ? "You can read this mailbox but not reply or change it"
      : "You can’t change mail here",
    writeWho: viewerHere
      ? "A mailbox owner can give you member access in Settings → Mailboxes."
      : keyOnly
        ? "Needs a key with the send scope, or the admin key."
        : "Owners, admins, senders and agents can.",
    manageReason: "You can’t manage this mailbox’s rules, senders, import or export",
    manageWho: keyOnly ? "Needs a key with the admin scope, or the admin key." : "Owners and admins can.",
  }
}

/* ───────────── Bulk actions: the optimistic thread, and the inverse for Undo ───────────── */

export type BulkExtra = {
  labelId?: string
  folder?: Folder
  until?: number
  assignee?: string | null
  assigneeName?: string | null
}

/** A thread as it will be after a bulk action, so lists move before the server answers. Null: it's gone. */
export function optimisticThread(t: Thread, action: BulkAction, x: BulkExtra = {}): Thread | null {
  const to = (folder: Folder, extra: Partial<Thread> = {}): Thread => ({ ...t, folders: [folder], ...extra })
  switch (action) {
    case "archive":
      return to("archive")
    case "inbox":
    case "notSpam":
    case "unsnooze":
      return to("inbox", { snoozedUntil: null })
    case "trash":
      return to("trash")
    case "spam":
      return to("spam")
    case "move":
      return x.folder ? to(x.folder) : t
    case "snooze":
      return to("snoozed", { snoozedUntil: x.until ?? null })
    case "delete":
      return null
    case "read":
      return { ...t, unreadCount: 0 }
    case "unread":
      return { ...t, unreadCount: Math.max(1, num(t.unreadCount) ?? 0) }
    case "star":
      return { ...t, starred: true }
    case "unstar":
      return { ...t, starred: false }
    case "label":
      return x.labelId && !t.labelIds.includes(x.labelId) ? { ...t, labelIds: [...t.labelIds, x.labelId] } : t
    case "unlabel":
      return x.labelId ? { ...t, labelIds: t.labelIds.filter((l) => l !== x.labelId) } : t
    case "assign":
      return {
        ...t,
        assignee: x.assignee ?? null,
        assignedTo: x.assignee ? { id: x.assignee, name: x.assigneeName ?? x.assignee } : null,
      }
    default:
      return t
  }
}

/**
 * How to undo a bulk action on these threads: one inverse call per distinct previous state (threads that
 * came from different folders go back to each). Null when it can't be undone (delete forever).
 */
export function inverseBulk(
  threads: readonly Thread[],
  action: BulkAction,
  x: BulkExtra = {},
): { action: BulkAction; threadIds: string[]; extra: BulkExtra }[] | null {
  const ids = threads.map((t) => t.id)
  const back = (): { action: BulkAction; threadIds: string[]; extra: BulkExtra }[] => {
    const groups = new Map<Folder, string[]>()
    for (const t of threads) {
      const f = (t.folders[0] ?? "inbox") as Folder
      groups.set(f, [...(groups.get(f) ?? []), t.id])
    }
    return [...groups.entries()].map(([folder, threadIds]) =>
      folder === "snoozed" && action !== "snooze"
        ? { action: "move" as BulkAction, threadIds, extra: { folder } }
        : { action: "move" as BulkAction, threadIds, extra: { folder } },
    )
  }
  switch (action) {
    case "archive":
    case "trash":
    case "spam":
    case "move":
    case "inbox":
    case "notSpam":
      return back()
    case "snooze":
      return [{ action: "unsnooze", threadIds: ids, extra: {} }]
    case "unsnooze":
      return null
    case "delete":
      return null
    case "read":
      return threads.some((t) => (num(t.unreadCount) ?? 0) > 0)
        ? [
            {
              action: "unread",
              threadIds: threads.filter((t) => (num(t.unreadCount) ?? 0) > 0).map((t) => t.id),
              extra: {},
            },
          ]
        : null
    case "unread":
      return [{ action: "read", threadIds: ids, extra: {} }]
    case "star":
      return [{ action: "unstar", threadIds: threads.filter((t) => !t.starred).map((t) => t.id), extra: {} }]
    case "unstar":
      return [{ action: "star", threadIds: threads.filter((t) => t.starred).map((t) => t.id), extra: {} }]
    case "label":
      return x.labelId
        ? [
            {
              action: "unlabel",
              threadIds: threads.filter((t) => !t.labelIds.includes(x.labelId as string)).map((t) => t.id),
              extra: { labelId: x.labelId },
            },
          ]
        : null
    case "unlabel":
      return x.labelId
        ? [
            {
              action: "label",
              threadIds: threads.filter((t) => t.labelIds.includes(x.labelId as string)).map((t) => t.id),
              extra: { labelId: x.labelId },
            },
          ]
        : null
    case "assign": {
      const groups = new Map<string, Thread[]>()
      for (const t of threads) groups.set(t.assignee ?? "", [...(groups.get(t.assignee ?? "") ?? []), t])
      return [...groups.entries()].map(([assignee, ts]) => ({
        action: "assign" as BulkAction,
        threadIds: ts.map((t) => t.id),
        extra: { assignee: assignee || null, assigneeName: ts[0]?.assignedTo?.name ?? null },
      }))
    }
    default:
      return null
  }
}

/** “Archived 3 conversations”, for the toast. */
export function bulkWords(action: BulkAction, n: number, x: BulkExtra = {}, labelName?: string): string {
  const what = n === 1 ? "conversation" : `${n} conversations`
  const v: Record<string, string> = {
    archive: `Archived ${what}`,
    inbox: `Moved ${what} to the Inbox`,
    trash: `Moved ${what} to Trash`,
    delete: `Deleted ${what} forever`,
    spam: `Marked ${what} as spam`,
    notSpam: `Moved ${what} to the Inbox; the sender is allowed from now on`,
    read: `Marked ${what} read`,
    unread: `Marked ${what} unread`,
    star: `Starred ${what}`,
    unstar: `Unstarred ${what}`,
    label: `Labelled ${what} ${labelName ?? ""}`.trim(),
    unlabel: `Removed ${labelName ?? "the label"} from ${what}`,
    move: `Moved ${what} to ${x.folder ? FOLDER_TITLE[x.folder] : "the folder"}`,
    snooze: `Snoozed ${what} until ${utcStamp(x.until)}`,
    unsnooze: `Unsnoozed ${what}`,
    assign: x.assignee ? `Assigned ${what} to ${x.assigneeName ?? x.assignee}` : `Unassigned ${what}`,
  }
  return v[action] ?? `Updated ${what}`
}

/* ───────────── The reader's URL (drawers and views over the open thread) ───────────── */

export type ReaderSearch = {
  /** The original (.eml) of this message, in the reader pane. */
  raw?: string
  /** The details drawer for this message, and its tab. */
  details?: string
  tab?: "summary" | "headers" | "spam"
  /** One recipient's delivery drawer: the message and the recipient. */
  dlv?: string
  rcpt?: string
  /** An attachment opened full screen: `<messageId>:<attachmentId>`. */
  preview?: string
  /** Opens the inline reply to the newest message (a link straight into replying). */
  reply?: "reply" | "replyAll" | "forward"
}

export function validateReaderSearch(s: Record<string, unknown>): ReaderSearch {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const tab = s.tab === "headers" || s.tab === "spam" || s.tab === "summary" ? s.tab : undefined
  return {
    ...(str(s.raw) ? { raw: str(s.raw) as string } : {}),
    ...(str(s.details) ? { details: str(s.details) as string } : {}),
    ...(tab ? { tab } : {}),
    ...(str(s.dlv) ? { dlv: str(s.dlv) as string } : {}),
    ...(str(s.rcpt) ? { rcpt: str(s.rcpt) as string } : {}),
    ...(str(s.preview) ? { preview: str(s.preview) as string } : {}),
    ...(s.reply === "reply" || s.reply === "replyAll" || s.reply === "forward" ? { reply: s.reply } : {}),
  }
}

/* ───────────── The sandboxed body frame ───────────── */

/** Remote images in an HTML body: what the remote bar counts before the user shows them. */
export function remoteImageCount(html: string): number {
  return (
    (html.match(/<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//gi) ?? []).length +
    (html.match(/url\(\s*["']?\s*(https?:)?\/\//gi) ?? []).length
  )
}

/**
 * The srcdoc for an email's HTML (HANDOFF-mail §4): scripts never run (the sandbox has no allow-scripts and
 * the CSP says `script-src 'none'`), forms and handlers are stripped as a second line, links open in a new
 * tab, inline `cid:` images point at their signed links, and remote images load only after Show images.
 */
export function buildSrcdoc(
  html: string,
  opts: { showImages: boolean; cid: Record<string, string>; tokensCss: string },
): string {
  let body = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|object|embed|form|base|meta)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
  body = body.replace(/(["'(])cid:([^"')\s]+)/gi, (m, q: string, id: string) => {
    const url = opts.cid[id] ?? opts.cid[`<${id}>`]
    return url ? `${q}${url}` : m
  })
  const img = opts.showImages ? "data: 'self' https: http:" : "data: 'self'"
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:; media-src 'none'; script-src 'none'; form-action 'none'`
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><meta name="referrer" content="no-referrer"><style>${opts.tokensCss}
html,body{margin:0;background:var(--background-100);color:var(--gray-1000)}body{padding:16px 18px;font:14px/21px Arial,Helvetica,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid var(--gray-400);color:var(--gray-900)}</style></head><body>${body}</body></html>`
}

/** Plain text as paragraphs, with quoted lines (`>`) grouped, for `.msg-body`. */
export function textBlocks(text: string): { kind: "p" | "quote"; text: string }[] {
  const out: { kind: "p" | "quote"; text: string }[] = []
  for (const para of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = para.split("\n")
    const quoted = lines.every((l) => /^\s*>/.test(l) || !l.trim())
    const t = quoted ? lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n") : para
    if (!t.trim()) continue
    const last = out[out.length - 1]
    if (quoted && last?.kind === "quote") last.text += `\n\n${t}`
    else out.push({ kind: quoted ? "quote" : "p", text: t })
  }
  return out
}

/** Which messages start expanded: the newest, and any unread. Older ones fold when three or more. */
export function expandedByDefault(messages: readonly { id: string; seen: boolean }[]): Set<string> {
  const out = new Set<string>()
  const last = messages[messages.length - 1]
  if (last) out.add(last.id)
  for (const m of messages) if (!m.seen) out.add(m.id)
  return out
}

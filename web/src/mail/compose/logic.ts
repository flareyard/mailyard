/**
 * The composer's pure logic: recipients, the attachment budget, the body (what the user typed, the
 * signature and the server-built quote), the schedule presets and every send refusal mapped to the words
 * the designs use. No React here; all of it is unit-tested (logic.test.ts).
 */
import { ApiError } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { fileSize, utcStamp } from "../logic.ts"
import type { BlockedReason, Identity, Mailbox, Party } from "../types.ts"

/* ───────────── Recipients ───────────── */

/** Cloudflare Email Service takes at most 50 recipients per message (To, Cc and Bcc together). */
export const MAX_RECIPIENTS = 50

export type Rcpt = { name: string | null; address: string }

const ADDR = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/

/** Why an address isn't one, in plain words, or null when it's fine. */
export function addressProblem(address: string): string | null {
  const a = address.trim()
  if (!a) return "it’s empty"
  if (!a.includes("@")) return "it has no @"
  if ((a.match(/@/g) ?? []).length > 1) return "it has more than one @"
  const domain = a.split("@")[1] ?? ""
  if (domain.includes(",")) return "it has a comma where the dot should be"
  if (/\s/.test(a)) return "it has a space in it"
  if (!domain.includes(".")) return "the part after @ has no dot"
  if (domain.endsWith(".") || domain.startsWith(".") || domain.includes(".."))
    return "the domain has a stray dot"
  if (!ADDR.test(a)) return "it has a character addresses can’t contain"
  return null
}

export const isValidAddress = (a: string) => addressProblem(a) === null

/**
 * Splits typed or pasted text into recipients: `Name <a@b.c>`, `"Last, First" <a@b.c>` and bare addresses,
 * separated by commas, semicolons or new lines. A comma inside a domain (`gmail,com`) stays in the token so
 * it can be flagged, not silently split.
 */
export function parseRecipients(text: string): Rcpt[] {
  const out: Rcpt[] = []
  let buf = ""
  let quoted = false
  let angle = false
  const flush = () => {
    const t = buf.trim()
    buf = ""
    if (!t) return
    const m = t.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/)
    if (m) {
      const name = (m[1] ?? "").trim()
      out.push({ name: name || null, address: (m[2] ?? "").trim() })
    } else out.push({ name: null, address: t.replace(/^mailto:/i, "") })
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '"') quoted = !quoted
    if (ch === "<") angle = true
    if (ch === ">") angle = false
    if (!quoted && !angle && (ch === ";" || ch === "\n" || ch === "\r" || ch === "\t")) {
      flush()
      continue
    }
    if (!quoted && !angle && ch === ",") {
      // `x@gmail,com`: a comma right after an @-domain fragment and followed by a TLD-like word is a typo,
      // not a separator.
      const before = buf.trim()
      const after = text.slice(i + 1).match(/^([a-z]{2,6})(?=$|[\s,;>])/i)
      if (before.includes("@") && !before.split("@")[1]?.includes(".") && after) {
        buf += ch
        continue
      }
      flush()
      continue
    }
    if (!quoted && !angle && ch === " " && buf.trim().includes("@") && !buf.includes("<")) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return out
}

/** Adds recipients without duplicates (by address, case-insensitively). */
export function addRecipients(list: readonly Rcpt[], add: readonly Rcpt[]): Rcpt[] {
  const seen = new Set(list.map((r) => r.address.toLowerCase()))
  const out = [...list]
  for (const r of add) {
    const k = r.address.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

export type RecipientCheck = {
  total: number
  invalid: { address: string; problem: string }[]
  overLimit: boolean
  /** Nobody to send to yet. */
  empty: boolean
}

export function checkRecipients(
  to: readonly Rcpt[],
  cc: readonly Rcpt[],
  bcc: readonly Rcpt[],
): RecipientCheck {
  const all = [...to, ...cc, ...bcc]
  const invalid = all
    .map((r) => ({ address: r.address, problem: addressProblem(r.address) }))
    .filter((r): r is { address: string; problem: string } => r.problem !== null)
  return {
    total: all.length,
    invalid,
    overLimit: all.length > MAX_RECIPIENTS,
    empty: to.length + cc.length + bcc.length === 0,
  }
}

/** Splits recipients into batches of at most 50 (for "Move them to Bcc in batches"). */
export const batches = <T>(list: readonly T[], size = MAX_RECIPIENTS): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size))

/** A chip's label: “Ada Okafor · ada@…” or the bare address. */
export const chipLabel = (r: Rcpt) => (r.name ? `${r.name} · ${r.address}` : r.address)

/* ───────────── Attachments and the message budget ───────────── */

/** The live upload route takes at most 25 MiB per file (the design said 50; the API wins). */
export const MAX_FILE = 25 * 1024 * 1024
/** Email Service's message budget: attachments past it go as expiring download links. */
export const BUDGET = 5 * 1024 * 1024

export type Delivery = "inline" | "link"

export type UploadRow = {
  id: string
  filename: string
  mimeType: string
  size: number
  status: "uploading" | "done" | "failed" | "too-big"
  progress: number
  key?: string
  delivery: Delivery
  /** From the original message (a forward). */
  carried?: boolean
  error?: string
}

/**
 * Which attachments go inline and which as links: files keep their choice while the inline ones fit the
 * 5 MiB budget; any file that can't fit next to what's already inline is forced to Link.
 */
export function budgetPlan(rows: readonly UploadRow[]) {
  const ready = rows.filter((r) => r.status === "done" || r.status === "uploading")
  let inline = 0
  const forced = new Set<string>()
  for (const r of ready) {
    if (r.delivery === "link") continue
    if (inline + r.size > BUDGET) forced.add(r.id)
    else inline += r.size
  }
  const links = ready.filter((r) => r.delivery === "link" || forced.has(r.id)).length
  return {
    inlineBytes: inline,
    share: Math.min(1, inline / BUDGET),
    links,
    /** Files that can only go as a link, because they don't fit the budget. */
    forced,
    tone: inline / BUDGET >= 0.8 ? ("warn" as const) : ("ok" as const),
  }
}

/** Whether a file can be inline at all: it alone has to fit the budget. */
export const canInline = (size: number) => size <= BUDGET

/** A file the composer refuses before uploading, with the words for its row; null when it's fine. */
export function fileRefusal(size: number): string | null {
  if (size > MAX_FILE)
    return `Too big to attach: each file can be up to ${fileSize(MAX_FILE)}. Share it from a drive and paste the link instead.`
  if (size === 0) return "This file is empty."
  return null
}

/* ───────────── The body: what you wrote, the signature, the quote ───────────── */

/** The plain-text signature delimiter (RFC 3676 §4.3), so a resumed draft can find its parts again. */
export const SIG_DELIM = "\n\n-- \n"
const QUOTE_START = /\n\n(?:On .+ wrote:\n|---------- Forwarded message ---------)/

/** Splits a draft's bodyText into what the user wrote, the signature and the quoted original. */
export function splitBody(bodyText: string): { text: string; signature: string | null; quote: string } {
  let rest = bodyText
  let quote = ""
  const q = rest.search(QUOTE_START)
  if (q >= 0) {
    quote = rest.slice(q)
    rest = rest.slice(0, q)
  } else if (/^\n?(?:On .+ wrote:\n|---------- Forwarded message ---------)/.test(rest)) {
    // A fresh reply: the server's body is only the quote.
    quote = rest.startsWith("\n") ? rest : `\n${rest}`
    rest = ""
  }
  const s = rest.indexOf(SIG_DELIM)
  if (s >= 0) return { text: rest.slice(0, s), signature: rest.slice(s + SIG_DELIM.length), quote }
  return { text: rest, signature: null, quote }
}

/** The bodyText the API stores: text, then the signature after `-- `, then the quote. */
export function joinBody(text: string, signature: string | null, quote: string): string {
  const t = text.replace(/\s+$/, "")
  const sig = signature?.trim() ? `${SIG_DELIM}${signature.trim()}` : ""
  return `${t}${sig}${quote}`
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c)

/** Plain text to safe HTML, keeping line breaks and making bare links clickable. */
export function textToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>")
}

const ALLOWED = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "A",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "BR",
  "P",
  "DIV",
  "SPAN",
])

/**
 * Keeps the editor's HTML to the few tags its toolbar makes (bold, links, lists, quotes) and drops every
 * attribute but a link's http(s)/mailto href. What's pasted from elsewhere can't carry scripts or styles.
 */
export function sanitizeHtml(html: string, doc: Document = document): string {
  const tpl = doc.createElement("template")
  tpl.innerHTML = html
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return escapeHtml(node.textContent ?? "")
    if (node.nodeType !== 1) return ""
    const el = node as Element
    const inner = [...el.childNodes].map(walk).join("")
    if (!ALLOWED.has(el.tagName)) return inner
    const tag = el.tagName.toLowerCase()
    if (tag === "br") return "<br>"
    if (tag === "a") {
      const href = el.getAttribute("href") ?? ""
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner
    }
    return `<${tag}>${inner}</${tag}>`
  }
  return [...tpl.content.childNodes].map(walk).join("")
}

/** The HTML part the API stores: the user's HTML in a marked block, the signature, the quote as text. */
export function joinHtml(
  userHtml: string,
  signature: { text: string; html: string | null } | null,
  quote: string,
) {
  const sig = signature
    ? `<div class="sig" data-my-sig>${signature.html ?? textToHtml(signature.text)}</div>`
    : ""
  const q = quote.trim() ? `<blockquote data-my-quote>${textToHtml(quote.trim())}</blockquote>` : ""
  return `<div data-my-body>${userHtml}</div>${sig}${q}`
}

/** The user's part of a stored bodyHtml, when this composer wrote it. */
export function userHtmlOf(bodyHtml: string | null | undefined): string | null {
  if (!bodyHtml) return null
  const m = bodyHtml.match(
    /^<div data-my-body>([\s\S]*?)<\/div>(?=<div class="sig"|<blockquote data-my-quote>|$)/,
  )
  return m ? (m[1] ?? "") : null
}

/** Whether the user's part is empty (only whitespace and line breaks). */
export const isBlank = (text: string) => text.replace(/\s+/g, "") === ""

/* ───────────── From: identities and signatures ───────────── */

/** Where an identity's signature comes from, for the From picker and the footer. */
export function signatureSource(
  id: Identity,
  identities: readonly Identity[],
  mailboxes: readonly Mailbox[] | undefined,
) {
  const own = id.signature
  if (id.kind === "alias") {
    const target = mailboxes?.find((m) => m.address === id.address)?.targetIds[0]
    const parent =
      identities.find((i) => i.mailboxId === target && i.kind !== "alias") ??
      identities.find((i) => i.mailboxId === id.mailboxId && i.kind !== "alias")
    const local = parent ? `${parent.address.split("@")[0]}@` : "its mailbox"
    if (!own && parent?.signature)
      return {
        signature: parent.signature,
        words: `signature inherited from ${local}`,
        footer: `Signature from ${local}`,
      }
  }
  if (own)
    return { signature: own, words: "own signature", footer: `Signature from ${id.address.split("@")[0]}@` }
  return { signature: null, words: "no signature", footer: "No signature" }
}

/** “You’re a member”, “Your mailbox”, “Alias of support@”: how you may use an identity. */
export function identityRelation(
  id: Identity,
  identities: readonly Identity[],
  mailboxes: readonly Mailbox[] | undefined,
) {
  if (id.kind === "alias") {
    const target = mailboxes?.find((m) => m.address === id.address)?.targetIds[0]
    const parent = identities.find((i) => i.mailboxId === target && i.kind !== "alias")
    return parent ? `Alias of ${parent.address.split("@")[0]}@` : "Alias"
  }
  if (id.kind === "user") return id.via === "admin" ? "Your mailbox" : "Your mailbox"
  if (id.kind === "group") return "Group"
  if (id.kind === "catch_all") return "Catch-all"
  return id.via === "admin" ? "Shared · you’re an admin" : "You’re a member"
}

/** The default From for a mailbox: its own identity, else the first identity you may use. */
export function defaultIdentity(identities: readonly Identity[], mailboxId: string, address?: string) {
  return (
    identities.find(
      (i) => i.mailboxId === mailboxId && (!address || i.address === address) && i.kind !== "alias",
    ) ??
    identities.find((i) => i.mailboxId === mailboxId) ??
    identities[0]
  )
}

/* ───────────── Schedule ───────────── */

const at = (now: number, days: number, h: number, m = 0) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, h, m, 0)
}

/** The schedule menu's presets, all UTC: this afternoon (if it's morning), tomorrow 08:00, Monday 08:00. */
export function schedulePresets(now = Date.now()) {
  const d = new Date(now)
  const toMonday = (8 - d.getUTCDay()) % 7 || 7
  const out: { label: string; at: number }[] = []
  if (d.getUTCHours() < 12) out.push({ label: "This afternoon", at: at(now, 0, 13) })
  out.push({ label: "Tomorrow morning", at: at(now, 1, 8) })
  if (toMonday > 1) out.push({ label: "Monday morning", at: at(now, toMonday, 8) })
  return out
}

/** A default for the custom date and time: tomorrow at 08:30 UTC. */
export const defaultCustom = (now = Date.now()) => at(now, 1, 8, 30)

/* ───────────── Refusals ───────────── */

export type Refusal = {
  kind:
    | BlockedReason
    | "agent_limit"
    | "recipient_not_allowed"
    | "workspace-deleting"
    | "forbidden"
    | "rate-limited"
    | "idempotency"
    | "invalid"
    | "conflict"
    | "not-found"
    | "unreachable"
    | "other"
  /** The Send button's label while it's refused. */
  button: string
  /** The reason popover's first line. */
  title: string
  /** Its second line: who can, or when it unblocks. */
  who: string
  /** The notice above the footer. */
  notice: {
    tone: "error" | "warn" | "info"
    lead: string
    body: string
    link?: { label: string; to: string }
  }
  /** Send stays refused until the draft changes (vs a transient refusal you can retry). */
  sticky: boolean
  /** For quota: when to queue the send for. */
  queueAt?: number
  /** Addresses to mark on the chips. */
  marked?: string[]
  requestId?: string
}

export const nextUtcMidnight = (now = Date.now()) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}
const inWords = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((ms - now) / 60000))
  const h = Math.floor(m / 60)
  return h ? `in ${h} h ${m % 60} min` : `in ${m} min`
}
const hhmm = (v: number) => {
  const d = new Date(v)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

/** A draft's blockedReason (or a SendBlocked refusal) in the designs' words. */
export function blockedRefusal(
  reason: BlockedReason,
  extra: {
    resetsAt?: number | null
    domainId?: string | null
    message?: string
    recipients?: string[]
    domain?: string
    quota?: { sent: number; quota: number } | null
  },
  now = Date.now(),
): Refusal {
  if (reason === "quota_exhausted") {
    // The daily quota resets at 00:00 UTC; when the refusal didn't say when, that's the next one.
    const at = extra.resetsAt ?? nextUtcMidnight(now)
    const when = `${utcStamp(at)}, ${inWords(at, now)}`
    const figures = extra.quota ? `: ${fmtInt(extra.quota.sent)} of ${fmtInt(extra.quota.quota)}` : ""
    return {
      kind: reason,
      button: "Quota used",
      title: `The daily quota is used${figures}`,
      who: `Schedule it, or press Queue: it goes at ${hhmm(at)}, ${inWords(at, now)}. The quota resets daily.`,
      notice: {
        tone: "warn",
        lead: `Daily quota used${figures}.`,
        body: `Sending resumes at ${when}. Press Queue and it goes then, or schedule it.`,
      },
      sticky: true,
      queueAt: at,
    }
  }
  if (reason === "domain_unhealthy") {
    const domain = extra.domain ?? "The sending domain"
    return {
      kind: reason,
      button: "Can’t send: domain failing",
      title: `${domain} isn’t passing authentication`,
      who: "Mail from it would fail authentication and likely land in spam. An owner or admin can fix the record in Domains.",
      notice: {
        tone: "error",
        lead: `${domain} is failing its DNS checks, so mail from it would fail authentication.`,
        body: `${extra.message ? `${extra.message} ` : ""}Sending is held so replies don’t land in spam.`,
        ...(extra.domainId
          ? {
              link: {
                label: `Open ${extra.domain ?? "the domain"} (${extra.domainId})`,
                to: `/domains/${extra.domainId}`,
              },
            }
          : { link: { label: "Open Domains", to: "/domains" } }),
      },
      sticky: true,
    }
  }
  const who = extra.recipients?.length ? extra.recipients.join(", ") : "Every recipient"
  return {
    kind: reason,
    button: "Can’t send: recipient suppressed",
    title: "Every recipient is suppressed",
    who: `${who} ${extra.recipients && extra.recipients.length === 1 ? "is" : "are"} on the suppression list, so Mailyard won’t send to ${extra.recipients && extra.recipients.length === 1 ? "it" : "them"}. Add someone who can receive mail, or ask an owner or admin to lift the suppression.`,
    notice: {
      tone: "error",
      lead: "Nobody here can receive this.",
      body: `${who} ${extra.recipients && extra.recipients.length === 1 ? "is" : "are"} suppressed. Add a working address, or ask an owner or admin to lift the suppression.`,
      link: { label: "See the suppressions", to: "/audience" },
    },
    sticky: true,
    ...(extra.recipients ? { marked: extra.recipients } : {}),
  }
}

/** Any error from create, save or send, mapped to what the composer shows. */
export function refusalFrom(
  e: unknown,
  ctx: { recipients?: string[]; domain?: string } = {},
  now = Date.now(),
): Refusal {
  if (!(e instanceof ApiError)) {
    return {
      kind: "unreachable",
      button: "Send",
      title: "Mailyard couldn’t be reached",
      who: "Check your connection. The draft is kept; press Send again when you’re back.",
      notice: {
        tone: "error",
        lead: "Mailyard couldn’t be reached.",
        body: "Your draft is kept on this device. Send again when you’re back online.",
      },
      sticky: false,
    }
  }
  const b = e.body
  const requestId = e.requestId
  const withId = (r: Refusal): Refusal => (requestId ? { ...r, requestId } : r)
  if (
    b._tag === "SendBlocked" &&
    (b.reason === "quota_exhausted" ||
      b.reason === "domain_unhealthy" ||
      b.reason === "all_recipients_suppressed")
  ) {
    return withId(
      blockedRefusal(
        b.reason,
        {
          resetsAt: num(b.resetsAt as number | null) ?? null,
          domainId: (b.domainId as string | null) ?? null,
          ...(b.message ? { message: b.message } : {}),
          ...(ctx.recipients ? { recipients: ctx.recipients } : {}),
          ...(ctx.domain ? { domain: ctx.domain } : {}),
        },
        now,
      ),
    )
  }
  if (e.status === 409 && b.reason === "agent_limit") {
    const limit = num(b.limit as number | undefined)
    const sent = num(b.sentToday as number | undefined)
    const resets = num(b.resetsAt as number | undefined)
    const figures = limit !== null ? `${fmtInt(sent ?? limit)} of ${fmtInt(limit)} today` : "its limit"
    return withId({
      kind: "agent_limit",
      button: "Can’t send: agent limit",
      title: `This key has sent ${figures}`,
      who: resets
        ? `Its limit resets at ${hhmm(resets)}, ${inWords(resets, now)}. An owner or admin can raise it in Settings → Agents.`
        : "An owner or admin can raise it in Settings → Agents.",
      notice: {
        tone: "warn",
        lead: "This key’s send limit is reached.",
        body: `${b.message ?? `It has sent ${figures}.`}${resets ? ` It resets at ${utcStamp(resets)}.` : ""}`,
        link: { label: "Open Settings → Agents", to: "/settings" },
      },
      sticky: false,
      ...(resets ? { queueAt: resets } : {}),
    })
  }
  if (e.status === 409 && b.reason === "recipient_not_allowed") {
    const notAllowed = Array.isArray(b.notAllowed) ? (b.notAllowed as string[]) : []
    const list = notAllowed.join(", ") || "Some recipients"
    return withId({
      kind: "recipient_not_allowed",
      button: "Can’t send: recipient not allowed",
      title: "This key can’t send to every recipient",
      who: `${list} ${notAllowed.length === 1 ? "is" : "are"} outside its allow-list. Remove ${notAllowed.length === 1 ? "it" : "them"}, or ask an owner or admin to widen the list in Settings → Agents.`,
      notice: {
        tone: "error",
        lead: `${list} ${notAllowed.length === 1 ? "isn’t" : "aren’t"} on this key’s allow-list.`,
        body: b.message ?? "Remove them to send, or ask an owner or admin to change the key’s limits.",
      },
      sticky: true,
      marked: notAllowed,
    })
  }
  if (e.status === 409 && b.reason === "workspace-deleting") {
    const at = num(b.deletesAt as number | undefined)
    return withId({
      kind: "workspace-deleting",
      button: "Can’t send: workspace deleting",
      title: "This workspace is being deleted",
      who: `Nothing new goes out${at ? ` before it’s deleted on ${utcStamp(at)}` : ""}. The owner can restore it in Settings.`,
      notice: {
        tone: "error",
        lead: "The workspace is scheduled for deletion.",
        body: `Mail still arrives, but nothing new is sent${at ? ` until it’s deleted on ${utcStamp(at)}` : ""}. The owner can restore it from Settings.`,
        link: { label: "Open Settings", to: "/settings" },
      },
      sticky: true,
    })
  }
  if (e.status === 403) {
    const roles = Array.isArray(b.allowedRoles) ? (b.allowedRoles as string[]) : []
    const owners = Array.isArray(b.owners) ? (b.owners as string[]) : []
    const who =
      b.reason === "mailbox_role"
        ? owners.length
          ? `You’re a viewer on this mailbox. ${owners.join(", ")} can give you member access.`
          : "You’re a viewer on this mailbox. A mailbox owner can give you member access."
        : b.reason === "insufficient-scope"
          ? `Needs a key with the ${String(b.required ?? "send")} scope, or the admin key.`
          : roles.length
            ? `${roles.map((r, i) => (i === 0 ? r[0]?.toUpperCase() + r.slice(1) : r)).join(", ")} can send from here.`
            : "Owners, admins, senders and agents can send."
    return withId({
      kind: "forbidden",
      button: "Can’t send from here",
      title: "You can’t send from this mailbox",
      who,
      notice: { tone: "error", lead: "You can’t send from this mailbox.", body: who },
      sticky: true,
    })
  }
  if (e.status === 429) {
    const s = num(b.retryAfter) ?? 60
    return withId({
      kind: "rate-limited",
      button: "Send",
      title: "Too many sends just now",
      who: `Try again in ${s} s.`,
      notice: {
        tone: "warn",
        lead: "Too many requests.",
        body: `Mailyard asked to wait ${s} s. Press Send again after that.`,
      },
      sticky: false,
    })
  }
  if (b._tag === "IdempotencyConflict") {
    return withId({
      kind: "idempotency",
      button: "Send",
      title: "This send already went with different content",
      who: "Reload the draft and send again.",
      notice: {
        tone: "warn",
        lead: "This send was already made with different content.",
        body: b.message ?? "Reload the draft and try again.",
      },
      sticky: false,
    })
  }
  if (e.status === 400) {
    const field = typeof b.field === "string" ? b.field : null
    return withId({
      kind: "invalid",
      button: "Send",
      title: "Something in the draft needs fixing",
      who: field ? `Check ${field}.` : (b.message ?? "Check the draft."),
      notice: {
        tone: "error",
        lead: field ? `Check ${field}.` : "Something in the draft needs fixing.",
        body: b.message ?? "",
      },
      sticky: false,
    })
  }
  if (e.status === 404) {
    return withId({
      kind: "not-found",
      button: "Send",
      title: "This draft is gone",
      who: "It was sent or discarded somewhere else.",
      notice: {
        tone: "error",
        lead: "This draft is gone.",
        body: "It was sent or discarded from another tab or device.",
      },
      sticky: true,
    })
  }
  if (e.status === 409) {
    return withId({
      kind: "conflict",
      button: "Send",
      title: "The draft changed elsewhere",
      who: b.message ?? "Reload it and try again.",
      notice: {
        tone: "warn",
        lead: "The draft changed elsewhere.",
        body: b.message ?? "Reload it and try again.",
      },
      sticky: false,
    })
  }
  return withId({
    kind: "other",
    button: "Send",
    title: "The send failed",
    who: b.message ?? `The API answered ${e.status}.`,
    notice: { tone: "error", lead: `The API answered ${e.status}.`, body: b.message ?? "Try again." },
    sticky: false,
  })
}

/** The client-side refusal before any call: bad addresses, too many, nobody. */
export function recipientRefusal(c: RecipientCheck): Refusal | null {
  if (c.empty)
    return {
      kind: "invalid",
      button: "Send",
      title: "Add a recipient",
      who: "Type a name or an address in To.",
      notice: { tone: "info", lead: "", body: "" },
      sticky: true,
    }
  if (!c.invalid.length && !c.overLimit) return null
  const parts = [
    ...(c.invalid.length ? [`Remove or correct ${c.invalid.map((i) => i.address).join(", ")}`] : []),
    ...(c.overLimit ? [`keep it to ${MAX_RECIPIENTS} or fewer`] : []),
  ]
  return {
    kind: "invalid",
    button: "Fix recipients to send",
    title: "Fix the recipients first",
    who: `${parts.join(", and ")}.`,
    notice: { tone: "error", lead: "", body: "" },
    sticky: true,
    marked: c.invalid.map((i) => i.address),
  }
}

/** New ids for drafts and sends: one per draft, so a retried create or send is the same request. */
export const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** Recipients in the draft's shape (name null when there is none). */
export const toParties = (list: readonly Rcpt[]): Party[] =>
  list.map((r) => ({ name: r.name, address: r.address.trim() }))

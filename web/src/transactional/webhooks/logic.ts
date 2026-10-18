/**
 * Webhooks (HANDOFF-ops §10, §22, §33): Standard Webhooks signing, 8 attempts with exponential backoff
 * (src/domain/webhooks.ts: 30 s doubling, capped at 6 h), dead letters and the replay loop.
 */
import { num } from "../../lib/format.ts"

export const MAX_ATTEMPTS = 8
export const TIMEOUT_S = 10
export const REPLAY_PAGE = 500
/** Seconds the queue waits after attempt `n` fails (1-based), as the backend computes it. */
export const retryDelay = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 60 * 60)

export type DeliveryStatus = "pending" | "succeeded" | "retrying" | "dead" | "paused"
export type DeliveryLike = {
  id: string
  eventId: string
  eventType: string
  status: DeliveryStatus
  attempts: number | string
  lastStatusCode: number | string | null
  lastError: string | null
  lastDurationMs: number | string | null
  lastAttemptAt: number | string | null
  nextAttemptAt: number | string | null
  createdAt: number | string
  payload: unknown
  /** The receiver's `x-request-id` from the last attempt (HAL-3464). */
  requestId?: string | null
}

export type WebhookLike = {
  enabled: boolean
  paused?: boolean
  lastSuccessAt: number | string | null
  lastFailureAt: number | string | null
  deadLetters: number | string
}

export type Health = "disabled" | "paused" | "failing" | "healthy" | "waiting"

/** Failing when the last outcome was a failure, or anything is dead-lettered. */
export function webhookHealth(w: WebhookLike): Health {
  if (!w.enabled) return "disabled"
  if (w.paused) return "paused"
  const ok = num(w.lastSuccessAt)
  const bad = num(w.lastFailureAt)
  if (bad !== null && (ok === null || bad > ok)) return "failing"
  if ((num(w.deadLetters) ?? 0) > 0 && bad !== null) return "failing"
  if (ok === null) return "waiting"
  return "healthy"
}

export const HEALTH_PILL: Record<Health, { tone: string; label: string }> = {
  disabled: { tone: "pill-neutral", label: "Disabled" },
  paused: { tone: "pill-warn", label: "Paused" },
  failing: { tone: "pill-fail", label: "Failing" },
  healthy: { tone: "pill-pass", label: "Healthy" },
  waiting: { tone: "pill-neutral", label: "No deliveries yet" },
}

export const STATUS_PILL: Record<DeliveryStatus, { tone: string; label: string }> = {
  pending: { tone: "pill-neutral", label: "Pending" },
  succeeded: { tone: "pill-pass", label: "Succeeded" },
  retrying: { tone: "pill-warn", label: "Retrying" },
  dead: { tone: "pill-fail", label: "Dead letter" },
  paused: { tone: "pill-warn", label: "Held: paused" },
}

const GROUPS: { label: string; test: (e: string) => boolean }[] = [
  { label: "Sending", test: (e) => e.startsWith("message.") },
  { label: "Engagement", test: (e) => e.startsWith("email.") },
  { label: "Contacts", test: (e) => e.startsWith("contact.") },
  {
    label: "Events, campaigns and mail",
    test: (e) => e.startsWith("event.") || e.startsWith("campaign.") || e.startsWith("mail."),
  },
  { label: "Agent approvals", test: (e) => e.startsWith("approval.") },
]

/** The picker's groups, from the API's own `events` list, so a new event appears without a UI change. */
export function groupEvents(events: readonly string[]): { label: string; events: string[] }[] {
  const out = GROUPS.map((g) => ({ label: g.label, events: events.filter(g.test) }))
  const rest = events.filter((e) => !GROUPS.some((g) => g.test(e)))
  if (rest.length) out.push({ label: "Other", events: rest })
  return out.filter((g) => g.events.length)
}

/** The streams a filter can name, from the schema (`filter.streams`). */
export const FILTER_STREAMS = [
  "transactional",
  "campaign",
  "automation",
  "reply",
  "mailbox",
  "test",
  "system",
] as const
export type FilterStream = (typeof FILTER_STREAMS)[number]

export type Filter = {
  mailboxIds: string[]
  streams: FilterStream[]
  campaignIds: string[]
  topicIds: string[]
}
export const EMPTY_FILTER: Filter = { mailboxIds: [], streams: [], campaignIds: [], topicIds: [] }

/** The API's filter (null, or any subset of its lists) as the editor's full shape. */
export function toFilter(f: Partial<Filter> | null | undefined): Filter {
  return {
    mailboxIds: [...(f?.mailboxIds ?? [])],
    streams: [...(f?.streams ?? [])],
    campaignIds: [...(f?.campaignIds ?? [])],
    topicIds: [...(f?.topicIds ?? [])],
  }
}

/** What to send: only the non-empty lists, or null to clear the filter (every subscribed event). */
export function filterBody(f: Filter): Partial<Filter> | null {
  const out: Partial<Filter> = {}
  if (f.mailboxIds.length) out.mailboxIds = f.mailboxIds
  if (f.streams.length) out.streams = f.streams
  if (f.campaignIds.length) out.campaignIds = f.campaignIds
  if (f.topicIds.length) out.topicIds = f.topicIds
  return Object.keys(out).length ? out : null
}

/** "support@ · transactional stream": the filter in a line, with names looked up where known. */
export function filterSummary(
  f: Partial<Filter> | null | undefined,
  names: {
    mailbox?: (id: string) => string | undefined
    campaign?: (id: string) => string | undefined
    topic?: (id: string) => string | undefined
  } = {},
): string | null {
  const body = filterBody(toFilter(f))
  if (!body) return null
  const parts: string[] = []
  if (body.mailboxIds) parts.push(body.mailboxIds.map((id) => names.mailbox?.(id) ?? id).join(", "))
  if (body.streams) parts.push(`${body.streams.join(", ")} stream${body.streams.length === 1 ? "" : "s"}`)
  if (body.campaignIds) parts.push(body.campaignIds.map((id) => names.campaign?.(id) ?? id).join(", "))
  if (body.topicIds) parts.push(body.topicIds.map((id) => names.topic?.(id) ?? id).join(", "))
  return parts.join(" · ")
}

/** The events a test can send: the endpoint's own, or every event for `*`. */
export const testableEvents = (subscribed: readonly string[], all: readonly string[]) =>
  subscribed.includes("*") ? [...all] : subscribed.filter((e) => all.includes(e))

/** Events designed ahead of the API: shown disabled with their issue until `events` lists them. */
export const PLANNED_EVENTS: { event: string; sub: string; issue: string }[] = [
  { event: "alert.raised", sub: "An alert opened or got worse", issue: "HAL-3465" },
]

export function toggleEvent(selected: readonly string[], e: string): string[] {
  if (e === "*") return selected.includes("*") ? [] : ["*"]
  const base = selected.filter((x) => x !== "*")
  return base.includes(e) ? base.filter((x) => x !== e) : [...base, e]
}

export function validateWebhookUrl(v: string): string | null {
  const s = v.trim()
  if (!s) return "Enter the URL Mailyard should POST to."
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return "That isn’t a URL. It starts with https://."
  }
  if (u.protocol !== "https:") return "HTTPS only: the request carries a signature and your data."
  return null
}

export type Attempt = {
  n: number
  /** When it ran, or when it's due; `exact` says whether the API recorded it or it's derived from the schedule. */
  at: number
  exact: boolean
  outcome: "fail" | "pass" | "next" | "unknown"
  title: string
  detail: string
}

const statusText = (d: DeliveryLike) => {
  const code = num(d.lastStatusCode)
  if (code !== null) return String(code)
  return d.lastError?.toLowerCase().includes("timed out") ? "timeout" : "no response"
}

/**
 * The attempts trail for the drawer. The API keeps only the last attempt's response, so earlier attempts
 * are shown at the times the retry schedule puts them, marked approximate, and say only that they failed.
 */
export function attemptTrail(d: DeliveryLike): Attempt[] {
  const attempts = num(d.attempts) ?? 0
  const created = num(d.createdAt) ?? 0
  const last = num(d.lastAttemptAt)
  const out: Attempt[] = []
  let t = created
  for (let n = 1; n <= attempts; n++) {
    const isLast = n === attempts
    const at = isLast && last !== null ? last : t
    const ok = isLast && d.status === "succeeded"
    out.push({
      n,
      at,
      exact: isLast && last !== null,
      outcome: ok ? "pass" : isLast ? "fail" : "unknown",
      title: isLast ? `Attempt ${n} · ${statusText(d)}` : `Attempt ${n} · failed`,
      detail: isLast
        ? ok
          ? `Answered ${statusText(d)}${d.lastDurationMs !== null ? ` in ${Math.round(num(d.lastDurationMs) ?? 0)} ms` : ""}.`
          : (d.lastError ?? "No 2xx answer.")
        : "Didn’t get a 2xx. Mailyard keeps only the last attempt’s response.",
    })
    t = at + retryDelay(n) * 1000
  }
  const next = num(d.nextAttemptAt)
  if (d.status === "retrying" && next !== null)
    out.push({
      n: attempts + 1,
      at: next,
      exact: true,
      outcome: "next",
      title: `Attempt ${attempts + 1} of ${MAX_ATTEMPTS}`,
      detail: "Queued; it runs on its own.",
    })
  if (d.status === "pending" && attempts === 0)
    out.push({
      n: 1,
      at: created,
      exact: true,
      outcome: "next",
      title: "Attempt 1",
      detail: "Queued to send.",
    })
  return out
}

export type ReplayStep = { call: number; replayed: number; remaining: number }

/**
 * Replays every dead letter: calls `replay` while `remaining > 0` (each call replays up to 500, oldest first),
 * reporting each step. `stopped()` ends the loop after the call in flight.
 */
export async function replayAll(
  replay: () => Promise<{ replayed: number | string; remaining: number | string }>,
  onStep: (s: ReplayStep) => void,
  stopped: () => boolean = () => false,
  maxCalls = 1000,
): Promise<{ replayed: number; remaining: number; calls: number; stopped: boolean }> {
  let replayed = 0
  let remaining = 0
  let call = 0
  do {
    call++
    const r = await replay()
    const got = num(r.replayed) ?? 0
    remaining = num(r.remaining) ?? 0
    replayed += got
    onStep({ call, replayed: got, remaining })
    if (got === 0) break
    if (stopped()) return { replayed, remaining, calls: call, stopped: remaining > 0 }
  } while (remaining > 0 && call < maxCalls)
  return { replayed, remaining, calls: call, stopped: false }
}

/** The headers a delivery is sent with (Standard Webhooks); the signature and timestamp are made per attempt. */
export function deliveryHeaders(d: Pick<DeliveryLike, "eventId" | "payload">): string {
  const p = d.payload as { id?: unknown } | null
  const id = typeof p?.id === "string" ? p.id : d.eventId
  return [
    "content-type: application/json",
    "user-agent: Mailyard-Webhooks/1",
    `webhook-id: ${id}`,
    "webhook-timestamp: <unix seconds, set on each attempt>",
    'webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">',
  ].join("\n")
}

export const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const VERIFY_SNIPPET = `import { Webhook } from "standardwebhooks"

const wh = new Webhook(process.env.MAILYARD_WEBHOOK_SECRET) // whsec_…
const event = wh.verify(rawBody, {
  "webhook-id": req.headers["webhook-id"],
  "webhook-timestamp": req.headers["webhook-timestamp"],
  "webhook-signature": req.headers["webhook-signature"],
})
// throws on a bad signature or an old timestamp; event is { id, type, createdAt, data }`

import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { contacts, events, messagesOut } from "../db/schema.ts"
import { timingSafeEqual } from "../domain/crypto.ts"
import { emitSafely } from "../domain/webhooks.ts"
import { Ids, type Outgoing } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

/**
 * Open and click tracking. A tracked message carries a 1×1 pixel and has its links pointed through
 * `/t/c/{token}`. Each token is signed and names the message, the link and where it goes, so a
 * forged or edited token is a 404, never an open redirect.
 * Hits that look like machines (Apple Mail Privacy Protection fetching every image, security
 * scanners following every link, anything within seconds of sending) are counted, but apart: they
 * never set a message's first open or click, nor a contact's engagement.
 */

export const OPEN_PATH = /^\/t\/o\/([^/]+)\.gif$/
export const CLICK_PATH = /^\/t\/c\/([^/]+)$/

/** The smallest transparent GIF: 43 bytes. */
export const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="),
  (c) => c.charCodeAt(0),
)

export class TrackingKeyMissing extends Schema.TaggedError<TrackingKeyMissing>()("TrackingKeyMissing", {}) {}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))

interface Payload {
  /** messages_out id */
  readonly m: string
  /** "o" for the open pixel, else the link's index */
  readonly k: "o" | number
  /** where a click goes */
  readonly u?: string
}

const keyOf = Effect.gen(function* () {
  const env = yield* Bindings
  // Its own key when set; else the file-signing key, kept apart by the "track:" prefix below.
  const secret = env.TRACKING_KEY ?? env.FILE_SIGNING_KEY
  if (!secret) return yield* new TrackingKeyMissing()
  return yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  )
})

/** 128 bits of HMAC-SHA256: plenty against forgery, and short enough for every link in a newsletter. */
const mac = (key: CryptoKey, body: string) =>
  Effect.promise(async () =>
    b64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`track:${body}`))).slice(
        0,
        16,
      ),
    ),
  )

const sign = (key: CryptoKey, payload: Payload) =>
  Effect.gen(function* () {
    const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
    return `${body}.${yield* mac(key, body)}`
  })

export const verifyToken = Effect.fn("tracking.verify")(function* (token: string) {
  const [body, signature] = token.split(".")
  if (!body || !signature) return null
  const key = yield* keyOf
  if (!timingSafeEqual(signature, yield* mac(key, body))) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Payload
    if (typeof payload.m !== "string" || (payload.k !== "o" && typeof payload.k !== "number")) return null
    if (payload.k !== "o" && (typeof payload.u !== "string" || !/^https?:\/\//i.test(payload.u))) return null
    return payload
  } catch {
    return null
  }
})

/**
 * Adds the pixel and points every http(s) link through the click redirect. Unsubscribe and
 * preference links are left as they are: one-click unsubscribing must not depend on tracking.
 */
export const instrument = Effect.fn("tracking.instrument")(function* (
  message: Outgoing,
  input: {
    readonly messageId: string
    readonly origin: string
    readonly opens: boolean
    readonly clicks: boolean
  },
) {
  if (!message.html || (!input.opens && !input.clicks)) return message
  const key = yield* keyOf
  let html = message.html
  if (input.clicks) {
    const parts: Array<string> = []
    let last = 0
    let index = 0
    for (const m of html.matchAll(/(href\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi)) {
      const raw = (m[3] ?? "").replaceAll("&amp;", "&")
      const skip = raw.startsWith(`${input.origin}/u/`) || raw.startsWith(`${input.origin}/c/`)
      parts.push(html.slice(last, m.index))
      if (skip) parts.push(m[0])
      else {
        const token = yield* sign(key, { m: input.messageId, k: index++, u: raw })
        parts.push(`${m[1]}${m[2]}${input.origin}/t/c/${token}${m[2]}`)
      }
      last = (m.index ?? 0) + m[0].length
    }
    parts.push(html.slice(last))
    html = parts.join("")
  }
  if (input.opens) {
    const token = yield* sign(key, { m: input.messageId, k: "o" })
    const pixel = `<img src="${input.origin}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : `${html}${pixel}`
  }
  return { ...message, html }
})

/** Signals that a hit came from a machine rather than a person reading. */
const SCANNER =
  /(barracuda|mimecast|proofpoint|messagelabs|symantec|trendmicro|fortinet|sophos|safelinks|protection\.outlook|bot\b|spider|crawler|python-requests|curl\/|wget|go-http-client|okhttp|microsoft office protocol discovery|preview)/i

export const classify = (input: {
  readonly kind: "open" | "click"
  readonly userAgent: string
  readonly ip: string
  readonly sentAt: number
  readonly at: number
  readonly humanOpenSeen: boolean
}) => {
  const ua = input.userAgent.trim()
  const soon = input.at - input.sentAt
  if (input.kind === "open") {
    // Gmail fetches images through its proxy when the person opens the message: a real open.
    if (/GoogleImageProxy/i.test(ua)) return "human" as const
    // Apple Mail Privacy Protection fetches from Apple's network (17.0.0.0/8) with a bare UA, on delivery.
    if (ua === "Mozilla/5.0" || input.ip.startsWith("17.")) return "machine" as const
    if (soon < 3_000 || SCANNER.test(ua)) return "machine" as const
    return "human" as const
  }
  if (SCANNER.test(ua)) return "machine" as const
  // Security scanners follow every link moments after delivery, before anyone could have read it.
  if (soon < 10_000 && !input.humanOpenSeen) return "machine" as const
  return "human" as const
}

/**
 * Records one hit: the message's counters, its first human open or click, the contact's engagement
 * and timeline, Analytics Engine's raw row, and a webhook on the first human one. Returns where a
 * click goes, or null for an unknown or tampered token.
 */
export const recordHit = Effect.fn("tracking.record")(function* (
  kind: "open" | "click",
  token: string,
  request: { readonly userAgent: string; readonly ip: string; readonly at: number },
) {
  const payload = yield* verifyToken(token)
  if (!payload || (kind === "open") !== (payload.k === "o")) return null
  const database = yield* Database
  const row = yield* database.query("tracking.message", (db) =>
    db
      .select({
        id: messagesOut.id,
        contactId: messagesOut.contactId,
        campaignId: messagesOut.campaignId,
        createdAt: messagesOut.createdAt,
        firstOpenedAt: messagesOut.firstOpenedAt,
        firstClickedAt: messagesOut.firstClickedAt,
      })
      .from(messagesOut)
      .where(eq(messagesOut.id, payload.m))
      .get(),
  )
  // The message was erased or never existed: a click still goes where its signed link says.
  if (!row) return { url: payload.u ?? null, recorded: false }
  const verdict = classify({
    kind,
    userAgent: request.userAgent,
    ip: request.ip,
    sentAt: row.createdAt,
    at: request.at,
    humanOpenSeen: row.firstOpenedAt !== null,
  })
  const human = verdict === "human"
  const first = human && (kind === "open" ? row.firstOpenedAt === null : row.firstClickedAt === null)
  const counter =
    kind === "open"
      ? human
        ? messagesOut.opens
        : messagesOut.machineOpens
      : human
        ? messagesOut.clicks
        : messagesOut.machineClicks
  yield* database.query("tracking.count", (db) =>
    db
      .update(messagesOut)
      .set({
        [kind === "open" ? (human ? "opens" : "machineOpens") : human ? "clicks" : "machineClicks"]:
          sql`${counter} + 1`,
        ...(first ? (kind === "open" ? { firstOpenedAt: request.at } : { firstClickedAt: request.at }) : {}),
        // A click proves an open, even when the images stayed blocked.
        ...(kind === "click" && human && row.firstOpenedAt === null ? { firstOpenedAt: request.at } : {}),
      })
      .where(eq(messagesOut.id, row.id))
      .run(),
  )
  const env = yield* Bindings
  env.TRACK_EVENTS?.writeDataPoint({
    indexes: [row.id],
    blobs: [kind, verdict, row.id, row.campaignId ?? "", request.userAgent.slice(0, 200)],
    doubles: [request.at, request.at - row.createdAt],
  })
  if (human && row.contactId) {
    yield* database.query("tracking.contact", (db) =>
      db
        .update(contacts)
        .set(
          kind === "open"
            ? { lastOpenedAt: request.at }
            : { lastClickedAt: request.at, lastOpenedAt: request.at },
        )
        .where(eq(contacts.id, row.contactId as string))
        .run(),
    )
  }
  if (first) {
    if (row.contactId) {
      const id = yield* (yield* Ids).next
      yield* database.query("tracking.event", (db) =>
        db
          .insert(events)
          .values({
            id,
            contactId: row.contactId as string,
            name: kind === "open" ? "email.opened" : "email.clicked",
            data: {
              messageId: row.id,
              campaignId: row.campaignId,
              ...(kind === "click" ? { url: payload.u } : {}),
            },
            at: request.at,
          })
          .run(),
      )
    }
    yield* emitSafely(kind === "open" ? "email.opened" : "email.clicked", {
      messageId: row.id,
      contactId: row.contactId,
      campaignId: row.campaignId,
      ...(kind === "click" ? { url: payload.u } : {}),
    })
  }
  return { url: payload.u ?? null, recorded: true }
})

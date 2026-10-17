import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import PostalMime, { type Address, type Email } from "postal-mime"
import { htmlToText } from "../domain/render.ts"
import { type AuthResults, readAuthResults } from "./auth.ts"

export interface Party {
  readonly name: string | null
  readonly address: string
}

export interface ParsedAttachment {
  readonly filename: string | null
  readonly mimeType: string
  readonly disposition: string | null
  /** Without angle brackets, as an HTML `cid:` reference names it. */
  readonly contentId: string | null
  /** Referenced from the HTML body (an inline image) rather than offered as a download. */
  readonly related: boolean
  readonly size: number
  readonly sha256: string
  readonly content: Uint8Array
}

/** What the inbox needs from a message, decoded and normalised. Bodies and attachments go to R2. */
export interface ParsedMessage {
  /** `<…@…>`, angle brackets kept, or null when the sender set none. */
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: ReadonlyArray<string>
  readonly subject: string
  /** Unix ms from the Date header, or null when it is missing or unreadable. */
  readonly date: number | null
  readonly from: Party | null
  readonly sender: Party | null
  readonly replyTo: ReadonlyArray<Party>
  readonly to: ReadonlyArray<Party>
  readonly cc: ReadonlyArray<Party>
  readonly text: string
  readonly html: string | null
  /** The first ~200 characters of the new text, quoted lines left out. */
  readonly snippet: string
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly attachments: ReadonlyArray<ParsedAttachment>
  readonly auth: AuthResults
  /** RFC 3834 Auto-Submitted, Precedence bulk/junk/list, or a vacation responder's headers. */
  readonly automated: boolean
  readonly listId: string | null
  readonly listUnsubscribe: string | null
}

export class ParseFailed extends Schema.TaggedError<ParseFailed>()("ParseFailed", {
  reason: Schema.String,
}) {}

/** Bounds that keep a hostile message from exhausting the isolate. A message over them fails to parse and is kept raw. */
export const PARSE_LIMITS = {
  maxNestingDepth: 64,
  maxHeadersSize: 2 * 1024 * 1024,
  maxPartCount: 2_000,
  maxRfc822NestingDepth: 4,
  maxForwardedAddresses: 2_000,
} as const

export const SNIPPET_LENGTH = 200

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")

export const sha256Hex = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes))

const flatten = (addresses: ReadonlyArray<Address> | undefined): Array<Party> =>
  (addresses ?? []).flatMap((a) =>
    a.group
      ? a.group.map((m) => ({ name: m.name || null, address: m.address.toLowerCase() }))
      : a.address
        ? [{ name: a.name || null, address: a.address.toLowerCase() }]
        : [],
  )

const one = (address: Address | undefined) => flatten(address ? [address] : [])[0] ?? null

const messageIds = (value: string | undefined) => value?.match(/<[^<>\s]+>/g) ?? []

const firstId = (value: string | undefined) => {
  const ids = messageIds(value)
  if (ids[0]) return ids[0]
  const bare = value?.trim()
  return bare ? `<${bare.replace(/^<|>$/g, "")}>` : null
}

const parseDate = (value: string | undefined) => {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Leaves out quoted replies and the "On …, … wrote:" line above them, then collapses whitespace. */
export const snippetOf = (text: string) => {
  const lines = text.split(/\r?\n/)
  const kept: Array<string> = []
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue
    if (/^On .{4,200} wrote:\s*$/.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break
    kept.push(line)
  }
  const flat = kept.join(" ").replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : flat
}

const header = (email: Email, key: string) => email.headers.find((h) => h.key === key)?.value

const isAutomated = (email: Email) => {
  const autoSubmitted = header(email, "auto-submitted")?.trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== "no") return true
  const precedence = header(email, "precedence")?.trim().toLowerCase()
  if (precedence === "bulk" || precedence === "junk" || precedence === "list") return true
  return email.headers.some(
    (h) => h.key === "x-autoreply" || h.key === "x-autorespond" || h.key === "x-auto-response-suppress",
  )
}

const toBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content)

/** Parses raw RFC 5322 bytes. Never throws: anything postal-mime refuses becomes ParseFailed. */
export const parseMessage = (raw: Uint8Array) =>
  Effect.gen(function* () {
    const email = yield* Effect.tryPromise({
      try: () => PostalMime.parse(raw, { ...PARSE_LIMITS, attachmentEncoding: "arraybuffer" }),
      catch: (cause) => new ParseFailed({ reason: cause instanceof Error ? cause.message : String(cause) }),
    })
    const attachments = yield* Effect.promise(() =>
      Promise.all(
        email.attachments.map(async (a): Promise<ParsedAttachment> => {
          const content = toBytes(a.content)
          return {
            filename: a.filename,
            mimeType: a.mimeType,
            disposition: a.disposition,
            contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
            related: a.related === true,
            size: content.byteLength,
            sha256: await sha256Hex(content),
            content,
          }
        }),
      ),
    )
    const html = email.html?.trim() ? email.html : null
    const text = email.text ?? (html ? htmlToText(html) : "")
    const headers = email.headers.map((h) => ({ key: h.key, value: h.value }))
    return {
      messageId: firstId(email.messageId),
      inReplyTo: firstId(email.inReplyTo),
      references: messageIds(email.references),
      subject: (email.subject ?? "").trim(),
      date: parseDate(email.date),
      from: one(email.from),
      sender: one(email.sender),
      replyTo: flatten(email.replyTo),
      to: flatten(email.to),
      cc: flatten(email.cc),
      text,
      html,
      snippet: snippetOf(text),
      headers,
      attachments,
      auth: readAuthResults(headers),
      automated: isAutomated(email),
      listId: header(email, "list-id")?.trim() ?? null,
      listUnsubscribe: header(email, "list-unsubscribe")?.trim() ?? null,
    } satisfies ParsedMessage
  })

import type { Address, Outgoing } from "../kit/index.ts"

/**
 * Builds an RFC 5322 message from an Outgoing, so sent mail has a real `.eml` like received mail does:
 * for "download original" and for exports. Not used to send (Email Service builds its own MIME).
 * Headers are folded at 78 columns, non-ASCII header text is RFC 2047 base64-encoded, bodies are
 * quoted-printable, and attachments base64 in 76-column lines.
 */

const CRLF = "\r\n"
const enc = new TextEncoder()

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const wrap76 = (s: string) => s.replace(/(.{76})/g, `$1${CRLF}`)

/** RFC 2047 encoded-word for header text that isn't plain ASCII. */
export const encodeWord = (text: string) => (isAscii(text) ? text : `=?UTF-8?B?${base64(enc.encode(text))}?=`)

/** RFC 5322 display name: quoted when it has specials, encoded when it isn't ASCII. */
const displayName = (name: string) => {
  if (!isAscii(name)) return encodeWord(name)
  return /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name
}

export const formatAddress = (a: Address) => (a.name ? `${displayName(a.name)} <${a.email}>` : a.email)

/** Folds a header line at whitespace so no line exceeds 78 characters (RFC 5322 §2.2.3). */
export const foldHeader = (name: string, value: string) => {
  const words = `${name}: ${value}`.split(" ")
  const lines: Array<string> = []
  let line = ""
  for (const word of words) {
    if (line && line.length + 1 + word.length > 78) {
      lines.push(line)
      line = ` ${word}`
    } else line = line ? `${line} ${word}` : word
  }
  lines.push(line)
  return lines.join(CRLF)
}

/** Quoted-printable (RFC 2045 §6.7) of UTF-8 text, soft-wrapped at 76 columns. */
export const quotedPrintable = (text: string) => {
  const out: Array<string> = []
  for (const rawLine of text.replace(/\r?\n/g, "\n").split("\n")) {
    let line = ""
    const bytes = enc.encode(rawLine)
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] ?? 0
      const last = i === bytes.length - 1
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)
      const token = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`
      if (line.length + token.length > 75) {
        out.push(`${line}=`)
        line = ""
      }
      line += token
    }
    out.push(line)
  }
  return out.join(CRLF)
}

const boundary = () => `=_mailyard_${crypto.randomUUID().replace(/-/g, "")}`

/** A MIME entity: its own headers and its body. */
interface Part {
  readonly headers: ReadonlyArray<string>
  readonly body: string
}

const render = (p: Part) => [...p.headers, "", p.body].join(CRLF)

const textPart = (type: "text/plain" | "text/html", body: string): Part => ({
  headers: [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"],
  body: quotedPrintable(body),
})

const attachmentPart = (a: NonNullable<Outgoing["attachments"]>[number]): Part => {
  const name = encodeWord(a.filename).replace(/"/g, "")
  return {
    headers: [
      `Content-Type: ${a.type}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${a.disposition}; filename="${name}"`,
      ...(a.contentId ? [`Content-ID: <${a.contentId.replace(/^<|>$/g, "")}>`] : []),
    ],
    body: wrap76(base64(a.content)),
  }
}

const multipart = (subtype: "alternative" | "mixed", parts: ReadonlyArray<Part>): Part => {
  const b = boundary()
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${b}"`],
    body: [...parts.map((p) => `--${b}${CRLF}${render(p)}`), `--${b}--`, ""].join(CRLF),
  }
}

/** text and html as multipart/alternative, wrapped in multipart/mixed when there are attachments. */
const bodyOf = (m: Outgoing): Part => {
  const alternatives: Array<Part> = []
  if (m.text !== undefined) alternatives.push(textPart("text/plain", m.text))
  if (m.html !== undefined) alternatives.push(textPart("text/html", m.html))
  const content =
    alternatives.length === 0
      ? textPart("text/plain", "")
      : alternatives.length === 1
        ? (alternatives[0] as Part)
        : multipart("alternative", alternatives)
  const attachments = m.attachments ?? []
  return attachments.length === 0
    ? content
    : multipart("mixed", [content, ...attachments.map(attachmentPart)])
}

export const buildMime = (
  m: Outgoing,
  extra: { readonly messageId?: string | null; readonly date?: Date; readonly bccInHeaders?: boolean } = {},
) => {
  const headers: Array<string> = [
    foldHeader("From", formatAddress(m.from)),
    foldHeader("To", m.to.map(formatAddress).join(", ")),
  ]
  if (m.cc?.length) headers.push(foldHeader("Cc", m.cc.map(formatAddress).join(", ")))
  // Bcc is never in a sent message's headers; a sender's own copy may keep it.
  if (extra.bccInHeaders && m.bcc?.length)
    headers.push(foldHeader("Bcc", m.bcc.map(formatAddress).join(", ")))
  if (m.replyTo) headers.push(foldHeader("Reply-To", formatAddress(m.replyTo)))
  headers.push(foldHeader("Subject", encodeWord(m.subject)))
  headers.push(`Date: ${(extra.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`)
  if (extra.messageId) headers.push(`Message-ID: ${extra.messageId}`)
  for (const [name, value] of Object.entries(m.headers ?? {})) headers.push(foldHeader(name, value))
  headers.push("MIME-Version: 1.0")
  const body = bodyOf(m)
  return enc.encode([...headers, ...body.headers, "", body.body].join(CRLF))
}

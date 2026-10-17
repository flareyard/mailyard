/**
 * An IMAP4rev1 client (RFC 3501) for importing mail: login, folder listing, read-only selection, UID
 * search and fetch. Just enough of the protocol, done carefully: responses are tokenised with literals
 * (`{n}` followed by n raw bytes) kept as bytes, so message bodies arrive byte for byte.
 *
 * It talks to a Transport, so the same client runs over Workers `connect()` with TLS in production and
 * over a scripted server in tests.
 */

export interface Transport {
  write(bytes: Uint8Array): Promise<void>
  /** The next chunk from the server, or null once the connection has closed. */
  read(): Promise<Uint8Array | null>
  close(): Promise<void>
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: "protocol" | "auth" | "command" | "closed",
  ) {
    super(message)
  }
}

/** A parsed token: an atom or string, a literal's bytes, a parenthesised list, or NIL. */
export type Token = string | Uint8Array | ReadonlyArray<Token> | null

export interface Response {
  /** `*` for untagged data, `+` for a continuation, otherwise the command's tag. */
  readonly tag: string
  readonly tokens: ReadonlyArray<Token>
  /** The line's text after the tag, literals left out: for status responses and errors. */
  readonly text: string
}

const enc = new TextEncoder()
const latin1 = new TextDecoder("latin1")

/** Splits one response into tokens. Literals come in as separate byte segments, in order. */
export const tokenize = (segments: ReadonlyArray<string | Uint8Array>): Array<Token> => {
  let si = 0
  let pos = 0
  const peek = () => {
    const seg = segments[si]
    return typeof seg === "string" ? seg[pos] : undefined
  }
  const skipSpaces = () => {
    while (peek() === " ") pos++
  }
  const atEndOfSegment = () => {
    const seg = segments[si]
    return typeof seg !== "string" || pos >= seg.length
  }
  const parseList = (close: ")" | "]"): Array<Token> => {
    const items: Array<Token> = []
    for (;;) {
      skipSpaces()
      if (atEndOfSegment()) {
        // A literal can sit inside a list: the bytes are the next segment, then the text continues.
        const literal = segments[si + 1]
        if (literal instanceof Uint8Array) {
          items.push(literal)
          si += 2
          pos = 0
          continue
        }
        return items
      }
      const c = peek()
      if (c === close) {
        pos++
        return items
      }
      items.push(parseOne())
    }
  }
  const parseOne = (): Token => {
    const seg = segments[si] as string
    const c = seg[pos]
    if (c === "(") {
      pos++
      return parseList(")")
    }
    if (c === '"') {
      pos++
      let out = ""
      while (pos < seg.length && seg[pos] !== '"') {
        if (seg[pos] === "\\" && pos + 1 < seg.length) pos++
        out += seg[pos]
        pos++
      }
      pos++
      return out
    }
    const literal = /^\{(\d+)\+?\}$/.exec(seg.slice(pos))
    if (literal) {
      pos = seg.length
      const bytes = segments[si + 1]
      si += 2
      pos = 0
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
    }
    // An atom runs to a space or a closing bracket. `BODY[]` and `BODY[HEADER.FIELDS (…)]` stay whole.
    let out = ""
    let depth = 0
    while (pos < seg.length) {
      const ch = seg[pos] as string
      if (ch === "[") depth++
      if (ch === "]") depth--
      if (depth <= 0 && (ch === " " || ch === ")" || (ch === "(" && out.length > 0 && depth === 0))) break
      out += ch
      pos++
    }
    return out.toUpperCase() === "NIL" ? null : out
  }
  const tokens: Array<Token> = []
  while (si < segments.length) {
    skipSpaces()
    if (atEndOfSegment()) {
      const literal = segments[si + 1]
      if (literal instanceof Uint8Array) {
        tokens.push(literal)
        si += 2
        pos = 0
        continue
      }
      break
    }
    tokens.push(parseOne())
  }
  return tokens
}

/** Quotes a string for a command, or returns null when it must go as a literal. */
const quoted = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) && !/[\r\n]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : null

/** Modified UTF-7 (RFC 3501 §5.1.3), the encoding of folder names. */
export const decodeMailboxName = (name: string) =>
  name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === "") return "&"
    const bin = atob(b64.replace(/,/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="))
    let out = ""
    for (let i = 0; i + 1 < bin.length; i += 2)
      out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1))
    return out
  })

export interface FolderInfo {
  readonly name: string
  /** As the server spells it, for SELECT. */
  readonly raw: string
  readonly delimiter: string | null
  readonly flags: ReadonlyArray<string>
}

export interface SelectInfo {
  readonly exists: number
  readonly uidValidity: number | null
  readonly uidNext: number | null
}

export interface FetchedMessage {
  readonly uid: number
  readonly flags: ReadonlyArray<string>
  /** INTERNALDATE as Unix ms, when the server sent one. */
  readonly internalDate: number | null
  readonly size: number | null
  readonly body: Uint8Array | null
}

const toText = (t: Token): string =>
  typeof t === "string" ? t : t instanceof Uint8Array ? latin1.decode(t) : ""

/** Parses IMAP's INTERNALDATE: `17-Jul-1996 02:44:25 -0700`. */
export const parseInternalDate = (value: string): number | null => {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/.exec(value)
  if (!m) return null
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
  const month = months.indexOf((m[2] ?? "").toLowerCase())
  if (month < 0) return null
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === "+" ? 1 : -1)
  return utc - offset
}

/** Compresses sorted UIDs into an IMAP sequence set: `1:4,7,9:12`. */
export const uidSet = (uids: ReadonlyArray<number>) => {
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  const parts: Array<string> = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`)
    i = j + 1
  }
  return parts.join(",")
}

export class ImapClient {
  private buffer = new Uint8Array(0)
  private closed = false
  private counter = 0
  capabilities: ReadonlyArray<string> = []

  constructor(private readonly transport: Transport) {}

  private async fill() {
    const chunk = await this.transport.read()
    if (!chunk) {
      this.closed = true
      throw new ImapError("The server closed the connection.", "closed")
    }
    const next = new Uint8Array(this.buffer.length + chunk.length)
    next.set(this.buffer)
    next.set(chunk, this.buffer.length)
    this.buffer = next
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf(10)
      if (idx >= 0) {
        const line = latin1.decode(
          this.buffer.subarray(0, idx > 0 && this.buffer[idx - 1] === 13 ? idx - 1 : idx),
        )
        this.buffer = this.buffer.subarray(idx + 1)
        return line
      }
      await this.fill()
    }
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill()
    const out = this.buffer.slice(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }

  /** One complete response: its lines and any literals they announce. */
  private async readResponse(): Promise<Response> {
    const segments: Array<string | Uint8Array> = []
    let text = ""
    for (;;) {
      const line = await this.readLine()
      segments.push(line)
      text += line
      const literal = /\{(\d+)\+?\}$/.exec(line)
      if (!literal) break
      segments.push(await this.readBytes(Number(literal[1])))
    }
    const first = segments[0] as string
    const space = first.indexOf(" ")
    const tag = space < 0 ? first : first.slice(0, space)
    segments[0] = space < 0 ? "" : first.slice(space + 1)
    return { tag, tokens: tokenize(segments), text: text.slice(space + 1) }
  }

  /** The server's greeting; call once after connecting. */
  async greet() {
    const greeting = await this.readResponse()
    if (greeting.tag !== "*" || !/^(OK|PREAUTH)\b/i.test(greeting.text)) {
      throw new ImapError(`Unexpected greeting: ${greeting.text}`, "protocol")
    }
    const caps = /\[CAPABILITY ([^\]]+)\]/i.exec(greeting.text)
    if (caps?.[1]) this.capabilities = caps[1].toUpperCase().split(/\s+/)
  }

  /**
   * Sends a command and collects its untagged responses until the tagged result. Arguments that can't
   * be quoted go as synchronising literals: send `{n}`, wait for `+`, then the bytes.
   */
  async command(name: string, args: ReadonlyArray<string | { readonly literal: string }> = []) {
    if (this.closed) throw new ImapError("The connection is closed.", "closed")
    const tag = `A${(++this.counter).toString().padStart(4, "0")}`
    const parts: Array<string> = []
    const literals: Array<Uint8Array> = []
    for (const arg of args) {
      if (typeof arg === "string") parts.push(arg)
      else {
        const q = quoted(arg.literal)
        if (q) parts.push(q)
        else {
          const bytes = enc.encode(arg.literal)
          parts.push(`{${bytes.length}}`)
          literals.push(bytes)
        }
      }
    }
    // Split the command at each literal: everything up to `{n}` goes first.
    const chunks: Array<string> = []
    let current = `${tag} ${name}`
    for (const part of parts) {
      current += ` ${part}`
      if (/^\{\d+\}$/.test(part)) {
        chunks.push(current)
        current = ""
      }
    }
    chunks.push(current)
    const untagged: Array<Response> = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as string
      if (i < chunks.length - 1) {
        await this.transport.write(enc.encode(`${chunk}\r\n`))
        for (;;) {
          const response = await this.readResponse()
          if (response.tag === "+") break
          if (response.tag === tag) throw new ImapError(`${name} refused: ${response.text}`, "command")
          untagged.push(response)
        }
        await this.transport.write(literals[i] as Uint8Array)
      } else {
        await this.transport.write(enc.encode(`${chunk}\r\n`))
      }
    }
    for (;;) {
      const response = await this.readResponse()
      if (response.tag === "*") {
        untagged.push(response)
        continue
      }
      if (response.tag === "+") continue
      if (response.tag !== tag) continue
      if (!/^OK\b/i.test(response.text)) {
        throw new ImapError(
          `${name} failed: ${response.text}`,
          /^NO\b/i.test(response.text) && name === "LOGIN" ? "auth" : "command",
        )
      }
      return { untagged, text: response.text }
    }
  }

  async login(username: string, password: string) {
    try {
      await this.command("LOGIN", [{ literal: username }, { literal: password }])
    } catch (error) {
      if (error instanceof ImapError && error.kind === "command") throw new ImapError(error.message, "auth")
      throw error
    }
  }

  async list(): Promise<Array<FolderInfo>> {
    const { untagged } = await this.command("LIST", ['""', '"*"'])
    return untagged
      .filter((r) => toText(r.tokens[0] ?? "").toUpperCase() === "LIST")
      .map((r) => {
        const flags = (Array.isArray(r.tokens[1]) ? (r.tokens[1] as ReadonlyArray<Token>) : []).map((f) =>
          toText(f),
        )
        const delimiter = r.tokens[2] === null ? null : toText(r.tokens[2] ?? "")
        const raw = toText(r.tokens[3] ?? "")
        return { name: decodeMailboxName(raw), raw, delimiter, flags }
      })
  }

  /** Read-only selection, so importing never changes a flag on the source. */
  async examine(folder: FolderInfo): Promise<SelectInfo> {
    const { untagged, text } = await this.command("EXAMINE", [{ literal: folder.raw }])
    let exists = 0
    let uidValidity: number | null = null
    let uidNext: number | null = null
    for (const r of untagged) {
      if (toText(r.tokens[1] ?? "").toUpperCase() === "EXISTS") exists = Number(toText(r.tokens[0] ?? "0"))
      const validity = /\[UIDVALIDITY (\d+)\]/i.exec(r.text)
      if (validity) uidValidity = Number(validity[1])
      const next = /\[UIDNEXT (\d+)\]/i.exec(r.text)
      if (next) uidNext = Number(next[1])
    }
    const inline = /\[UIDVALIDITY (\d+)\]/i.exec(text)
    if (inline && uidValidity === null) uidValidity = Number(inline[1])
    return { exists, uidValidity, uidNext }
  }

  /** UIDs in the selected folder at or above `fromUid`, ascending. */
  async searchUids(fromUid = 1): Promise<Array<number>> {
    const { untagged } = await this.command("UID SEARCH", [`UID ${fromUid}:*`])
    const uids: Array<number> = []
    for (const r of untagged) {
      if (toText(r.tokens[0] ?? "").toUpperCase() !== "SEARCH") continue
      for (const t of r.tokens.slice(1)) {
        const n = Number(toText(t))
        if (Number.isInteger(n) && n >= fromUid) uids.push(n)
      }
    }
    return [...new Set(uids)].sort((a, b) => a - b)
  }

  /**
   * Fetches messages by UID. With `body`, the whole message as the server stores it (BODY.PEEK[], which
   * leaves \Seen alone); without, only sizes and flags, for planning batches.
   */
  async fetch(
    uids: ReadonlyArray<number>,
    options: { readonly body: boolean },
  ): Promise<Array<FetchedMessage>> {
    if (uids.length === 0) return []
    const items = options.body
      ? "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])"
      : "(UID FLAGS RFC822.SIZE)"
    const { untagged } = await this.command("UID FETCH", [uidSet(uids), items])
    const out: Array<FetchedMessage> = []
    for (const r of untagged) {
      if (toText(r.tokens[1] ?? "").toUpperCase() !== "FETCH") continue
      const list = r.tokens[2]
      if (!Array.isArray(list)) continue
      const fields = list as ReadonlyArray<Token>
      let uid = 0
      let flags: Array<string> = []
      let internalDate: number | null = null
      let size: number | null = null
      let body: Uint8Array | null = null
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const key = toText(fields[i] ?? "").toUpperCase()
        const value = fields[i + 1] ?? null
        if (key === "UID") uid = Number(toText(value))
        else if (key === "FLAGS")
          flags = (Array.isArray(value) ? (value as ReadonlyArray<Token>) : []).map((f) => toText(f))
        else if (key === "INTERNALDATE") internalDate = parseInternalDate(toText(value))
        else if (key === "RFC822.SIZE") size = Number(toText(value))
        else if (key.startsWith("BODY["))
          body = value instanceof Uint8Array ? value : typeof value === "string" ? enc.encode(value) : null
      }
      if (uid > 0) out.push({ uid, flags, internalDate, size, body })
    }
    return out.sort((a, b) => a.uid - b.uid)
  }

  async logout() {
    try {
      await this.command("LOGOUT")
    } catch {
      // The server may close the connection straight after BYE.
    }
    await this.transport.close().catch(() => {})
  }
}

/**
 * DMARC aggregate reports (RFC 7489 appendix C, and the DMARCbis `urn:ietf:params:xml:ns:dmarc-2.0`
 * namespace): unpacked from the gzip, zip or plain XML a receiver attaches, and read into plain rows
 * (HAL-3375). Pure code, so it runs anywhere and is tested without the Workers runtime.
 *
 * Workers have no DOMParser, and these reports are a small fixed schema, so this reads the elements it
 * needs by name. It tolerates namespace prefixes, CDATA, comments and entity escapes, and refuses
 * anything that isn't a `<feedback>` document. Sizes are capped: a report is at most 20 MB unpacked
 * and 20,000 records, far beyond any real one, so a zip bomb can't take the Worker down.
 */

export const MAX_UNPACKED = 20 * 1024 * 1024
export const MAX_RECORDS = 20_000

export interface DmarcAuthResult {
  readonly domain: string
  readonly result: string
  readonly selector?: string
}

export interface DmarcRecord {
  readonly sourceIp: string
  readonly count: number
  /** What the receiver did: none, quarantine or reject. */
  readonly disposition: string
  /** The aligned results DMARC was evaluated on. */
  readonly dkimAligned: boolean
  readonly spfAligned: boolean
  readonly headerFrom: string
  readonly envelopeFrom: string | null
  readonly dkim: ReadonlyArray<DmarcAuthResult>
  readonly spf: ReadonlyArray<DmarcAuthResult>
  /** Why the receiver overrode the policy (forwarded, mailing_list, local_policy …), if it said. */
  readonly overrides: ReadonlyArray<string>
}

export interface DmarcReport {
  readonly orgName: string
  readonly email: string | null
  readonly reportId: string
  /** Seconds since the epoch, as the report gives them. */
  readonly begin: number
  readonly end: number
  readonly policy: {
    readonly domain: string
    readonly p: string
    readonly sp: string | null
    readonly pct: number | null
    readonly adkim: string | null
    readonly aspf: string | null
  }
  readonly records: ReadonlyArray<DmarcRecord>
}

export class DmarcParseError extends Error {
  override readonly name = "DmarcParseError"
}

// ---------------------------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------------------------

const readAll = async (stream: ReadableStream<Uint8Array>, limit: number) => {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new DmarcParseError(`The report unpacks to more than ${limit} bytes.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const inflate = (bytes: Uint8Array, format: "gzip" | "deflate-raw") =>
  readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)), MAX_UNPACKED)

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0

/** The first `.xml` entry of a zip, read through its central directory (local sizes can be zero). */
const unzip = async (bytes: Uint8Array) => {
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new DmarcParseError("Not a zip file.")
  const entries = u16(bytes, eocd + 10)
  let at = u32(bytes, eocd + 16)
  for (let n = 0; n < entries && at + 46 <= bytes.length; n++) {
    if (u32(bytes, at) !== 0x02014b50) break
    const method = u16(bytes, at + 10)
    const compressed = u32(bytes, at + 20)
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    const commentLength = u16(bytes, at + 32)
    const local = u32(bytes, at + 42)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (!/\.xml$/i.test(name)) continue
    if (u32(bytes, local) !== 0x04034b50) throw new DmarcParseError("A broken zip entry.")
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
    const data = bytes.subarray(start, start + compressed)
    if (method === 0) {
      if (data.byteLength > MAX_UNPACKED) throw new DmarcParseError("The report is too large.")
      return data
    }
    if (method === 8) return inflate(data, "deflate-raw")
    throw new DmarcParseError(`Zip compression method ${method} isn't supported.`)
  }
  throw new DmarcParseError("The zip has no .xml report in it.")
}

/** The report's XML from an attachment: by its magic bytes first, its name and type second. */
export const unpack = async (bytes: Uint8Array): Promise<string> => {
  let xml: Uint8Array
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) xml = await inflate(bytes, "gzip")
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b) xml = await unzip(bytes)
  else {
    if (bytes.byteLength > MAX_UNPACKED) throw new DmarcParseError("The report is too large.")
    xml = bytes
  }
  return new TextDecoder().decode(xml)
}

/** Whether an attachment could be an aggregate report, before unpacking it. */
export const looksLikeReport = (a: { readonly filename: string | null; readonly mimeType: string }) =>
  /\.(xml|xml\.gz|gz|zip)$/i.test(a.filename ?? "") ||
  /(^|\/)(x-)?(gzip|zip|xml)$|zip-compressed/i.test(a.mimeType)

// ---------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

/** Strips comments, the prolog and namespace prefixes, and unwraps CDATA, so tags are plain names. */
const normalize = (xml: string) =>
  xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    )
    .replace(/<(\/?)[A-Za-z_][\w.-]*:/g, "<$1")

/** Every `<tag>…</tag>` directly or deeply inside `xml`, as inner text, in document order. */
const all = (xml: string, tag: string): Array<string> => {
  const out: Array<string> = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, "g")
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? "")
  return out
}
const one = (xml: string, tag: string) => all(xml, tag)[0]
const text = (xml: string | undefined, tag: string) => {
  if (xml === undefined) return null
  const v = one(xml, tag)
  if (v === undefined) return null
  const t = decodeEntities(v.replace(/<[^>]*>/g, "")).trim()
  return t === "" ? null : t
}
const required = (xml: string | undefined, tag: string, where: string) => {
  const v = text(xml, tag)
  if (v === null) throw new DmarcParseError(`The report has no <${tag}> in <${where}>.`)
  return v
}
const int = (v: string | null) => {
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

const authResults = (xml: string, tag: "dkim" | "spf"): Array<DmarcAuthResult> =>
  all(xml, tag).map((r) => {
    const selector = text(r, "selector")
    return {
      domain: (text(r, "domain") ?? "").toLowerCase(),
      result: (text(r, "result") ?? "none").toLowerCase(),
      ...(selector ? { selector } : {}),
    }
  })

/** Reads one aggregate report. Throws DmarcParseError for anything that isn't one. */
export const parseReport = (raw: string): DmarcReport => {
  const xml = normalize(raw)
  const feedback = one(xml, "feedback")
  if (feedback === undefined) throw new DmarcParseError("Not a DMARC aggregate report: no <feedback>.")
  const meta = one(feedback, "report_metadata")
  const policy = one(feedback, "policy_published")
  const range = meta === undefined ? undefined : one(meta, "date_range")
  const recordXml = all(feedback, "record")
  if (recordXml.length > MAX_RECORDS) throw new DmarcParseError(`More than ${MAX_RECORDS} records.`)
  const records = recordXml.map((r): DmarcRecord => {
    const row = one(r, "row")
    const evaluated = row === undefined ? undefined : one(row, "policy_evaluated")
    const identifiers = one(r, "identifiers")
    const auth = one(r, "auth_results") ?? ""
    const sourceIp = required(row, "source_ip", "row")
    const count = int(text(row, "count")) ?? 0
    const overrides =
      evaluated === undefined
        ? []
        : all(evaluated, "reason")
            .map((x) => (text(x, "type") ?? "").toLowerCase())
            .filter((x) => x !== "")
    return {
      sourceIp,
      count: Math.max(0, count),
      disposition: (text(evaluated, "disposition") ?? "none").toLowerCase(),
      dkimAligned: (text(evaluated, "dkim") ?? "").toLowerCase() === "pass",
      spfAligned: (text(evaluated, "spf") ?? "").toLowerCase() === "pass",
      headerFrom: (text(identifiers, "header_from") ?? "").toLowerCase(),
      envelopeFrom: text(identifiers, "envelope_from")?.toLowerCase() ?? null,
      dkim: authResults(auth, "dkim"),
      spf: authResults(auth, "spf"),
      overrides,
    }
  })
  return {
    orgName: required(meta, "org_name", "report_metadata"),
    email: text(meta, "email"),
    reportId: required(meta, "report_id", "report_metadata"),
    begin: int(required(range, "begin", "date_range")) ?? 0,
    end: int(required(range, "end", "date_range")) ?? 0,
    policy: {
      domain: required(policy, "domain", "policy_published").toLowerCase(),
      p: (text(policy, "p") ?? "none").toLowerCase(),
      sp: text(policy, "sp")?.toLowerCase() ?? null,
      pct: int(text(policy, "pct")),
      adkim: text(policy, "adkim")?.toLowerCase() ?? null,
      aspf: text(policy, "aspf")?.toLowerCase() ?? null,
    },
    records,
  }
}

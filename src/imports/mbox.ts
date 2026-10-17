/**
 * mboxrd (the variant Gmail Takeout and most tools write): each message starts with a `From ` line,
 * lines in the message matching `>*From ` gain one more `>`, and messages end with a blank line.
 * Files use LF; messages are converted from and back to CRLF, so a CRLF message round-trips byte for byte.
 */

const enc = new TextEncoder()

const asctime = (ms: number) => {
  const d = new Date(ms)
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate().toString().padStart(2, " ")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** CRLF to LF, with mboxrd From-quoting applied to every line. */
const quoteLines = (raw: Uint8Array) => {
  const out: Array<number> = []
  let lineStart = true
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] as number
    if (lineStart) {
      // >*From  → one more '>'
      let j = i
      while (raw[j] === 0x3e) j++
      if (
        raw[j] === 0x46 &&
        raw[j + 1] === 0x72 &&
        raw[j + 2] === 0x6f &&
        raw[j + 3] === 0x6d &&
        raw[j + 4] === 0x20
      )
        out.push(0x3e)
      lineStart = false
    }
    if (b === 0x0d && raw[i + 1] === 0x0a) continue
    out.push(b)
    if (b === 0x0a) lineStart = true
  }
  if (out.length === 0 || out[out.length - 1] !== 0x0a) out.push(0x0a)
  return Uint8Array.from(out)
}

/** One message as an mbox entry: its `From ` line, the quoted message, and the blank separator line. */
export const mboxEntry = (raw: Uint8Array, envelopeFrom: string, receivedAt: number) => {
  const sender = envelopeFrom.trim().replace(/\s+/g, "") || "MAILER-DAEMON"
  const header = enc.encode(`From ${sender} ${asctime(receivedAt)}\n`)
  const body = quoteLines(raw)
  const out = new Uint8Array(header.length + body.length + 1)
  out.set(header)
  out.set(body, header.length)
  out[out.length - 1] = 0x0a
  return out
}

/** Byte ranges of the messages in an mbox, `From ` lines excluded: scans without decoding. */
export const mboxRanges = (bytes: Uint8Array) => {
  const starts: Array<{ readonly fromLine: number; readonly body: number }> = []
  const isFromLine = (i: number) =>
    bytes[i] === 0x46 &&
    bytes[i + 1] === 0x72 &&
    bytes[i + 2] === 0x6f &&
    bytes[i + 3] === 0x6d &&
    bytes[i + 4] === 0x20
  for (let i = 0; i < bytes.length; i++) {
    if ((i === 0 || bytes[i - 1] === 0x0a) && isFromLine(i)) {
      let end = i
      while (end < bytes.length && bytes[end] !== 0x0a) end++
      starts.push({ fromLine: i, body: Math.min(end + 1, bytes.length) })
      i = end
    }
  }
  return starts.map((s, k) => {
    const next = starts[k + 1]?.fromLine ?? bytes.length
    // The blank line before the next From line belongs to the separator, not the message.
    let end = next
    if (end > s.body && bytes[end - 1] === 0x0a) end--
    return { offset: s.body, length: Math.max(0, end - s.body) }
  })
}

/** Undoes mboxrd quoting and turns LF back into CRLF. */
export const mboxMessage = (body: Uint8Array) => {
  const out: Array<number> = []
  let lineStart = true
  for (let i = 0; i < body.length; i++) {
    const b = body[i] as number
    if (lineStart && b === 0x3e) {
      let j = i
      while (body[j] === 0x3e) j++
      if (
        body[j] === 0x46 &&
        body[j + 1] === 0x72 &&
        body[j + 2] === 0x6f &&
        body[j + 3] === 0x6d &&
        body[j + 4] === 0x20
      ) {
        i++ // drop one '>'
        lineStart = false
        out.push(body[i] as number)
        continue
      }
    }
    lineStart = false
    if (b === 0x0a) {
      if (out[out.length - 1] !== 0x0d) out.push(0x0d)
      out.push(0x0a)
      lineStart = true
      continue
    }
    out.push(b)
  }
  return Uint8Array.from(out)
}

/** Every message in an mbox, as CRLF bytes. */
export const parseMbox = (bytes: Uint8Array) =>
  mboxRanges(bytes).map((r) => mboxMessage(bytes.subarray(r.offset, r.offset + r.length)))

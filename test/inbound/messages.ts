/** Builders for inbound messages that are too large or too odd to keep as fixture files. */

const enc = new TextEncoder()

export const simpleMessage = (fields: {
  readonly from?: string
  readonly to?: string
  readonly subject?: string
  readonly messageId?: string
  readonly body?: string
  readonly headers?: string
}) =>
  enc.encode(
    [
      `From: ${fields.from ?? "Ada <ada@example.org>"}`,
      `To: ${fields.to ?? "sam@acme.test"}`,
      `Subject: ${fields.subject ?? "Hello"}`,
      "Date: Fri, 16 Oct 2026 12:00:00 +0000",
      `Message-ID: ${fields.messageId ?? `<${crypto.randomUUID()}@example.org>`}`,
      ...(fields.headers ? [fields.headers] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      fields.body ?? "Hello there.",
      "",
    ].join("\r\n"),
  )

/** A message of about `targetBytes` on the wire: one base64 attachment in 76-character lines. */
export const largeMessage = (targetBytes: number) => {
  // base64 with 76-character lines costs 78 bytes per 57 bytes of payload.
  const payloadBytes = Math.floor(((targetBytes - 2048) * 57) / 78 / 3) * 3
  const payload = new Uint8Array(payloadBytes)
  for (let i = 0; i < payloadBytes; i += 65536)
    crypto.getRandomValues(payload.subarray(i, Math.min(i + 65536, payloadBytes)))
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const head = enc.encode(
    [
      "From: big@example.org",
      "To: sam@acme.test",
      "Subject: Big file",
      "Date: Fri, 16 Oct 2026 12:00:00 +0000",
      "Message-ID: <big@example.org>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b",
      'Content-Type: application/octet-stream; name="big.bin"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="big.bin"',
      "",
      "",
    ].join("\r\n"),
  )
  const tail = enc.encode("\r\n--b--\r\n")
  const lines = Math.ceil(payloadBytes / 57)
  const raw = new Uint8Array(head.byteLength + lines * 78 + tail.byteLength)
  raw.set(head, 0)
  let o = head.byteLength
  for (let i = 0; i < payloadBytes; i += 57) {
    const end = Math.min(i + 57, payloadBytes)
    for (let j = i; j < end; j += 3) {
      const a = payload[j] ?? 0
      const b = payload[j + 1] ?? 0
      const c = payload[j + 2] ?? 0
      raw[o++] = alphabet.charCodeAt(a >> 2)
      raw[o++] = alphabet.charCodeAt(((a & 3) << 4) | (b >> 4))
      raw[o++] = alphabet.charCodeAt(((b & 15) << 2) | (c >> 6))
      raw[o++] = alphabet.charCodeAt(c & 63)
    }
    raw[o++] = 13
    raw[o++] = 10
  }
  raw.set(tail, o)
  return { raw: raw.subarray(0, o + tail.byteLength), payload }
}

/** Multiparts nested `depth` deep, past the parser's nesting limit. */
export const deepMessage = (depth: number) => {
  let body = "Content-Type: text/plain\r\n\r\ninnermost\r\n"
  for (let i = depth; i > 0; i--) {
    body = `Content-Type: multipart/mixed; boundary="d${i}"\r\n\r\n--d${i}\r\n${body}--d${i}--\r\n`
  }
  return enc.encode(
    `From: deep@example.org\r\nTo: sam@acme.test\r\nSubject: Deep\r\nMIME-Version: 1.0\r\n${body}`,
  )
}

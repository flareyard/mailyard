import { describe, expect, it } from "vitest"
import {
  b64url,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  vapidAuthorization,
} from "../../src/push/webPush.ts"
import { decrypt, subscriber } from "./subscriber.ts"

/**
 * HAL-3369: the subscriber's side of RFC 8291, written out here, decrypts what the Worker sends, and
 * the VAPID token verifies with the published key. If either half were wrong, a browser would drop
 * the push silently, so this is the test that matters.
 */
const enc = new TextEncoder()

describe("Web Push encryption (RFC 8291)", () => {
  it("encrypts a payload the subscriber decrypts, as one aes128gcm record", async () => {
    const sub = await subscriber()
    const payload = JSON.stringify({ title: "Ada Lovelace", body: "Refund for order #42", threadId: "thr_1" })
    const body = await encryptPayload(
      { endpoint: "https://push.example.net/x", p256dh: sub.p256dh, auth: sub.authB64 },
      enc.encode(payload),
    )
    const read = await decrypt(body, sub)
    expect(read).toEqual({ rs: 4096, idlen: 65, delimiter: 2, text: payload })
  })

  it("uses a fresh key and salt every time", async () => {
    const sub = await subscriber()
    const s = { endpoint: "https://push.example.net/x", p256dh: sub.p256dh, auth: sub.authB64 }
    const a = await encryptPayload(s, enc.encode("same"))
    const b = await encryptPayload(s, enc.encode("same"))
    expect(b64url(a.slice(0, 86))).not.toBe(b64url(b.slice(0, 86)))
  })

  it("refuses keys that aren't a subscription's", async () => {
    await expect(
      encryptPayload(
        {
          endpoint: "https://p.example/x",
          p256dh: b64url(new Uint8Array(10)),
          auth: b64url(new Uint8Array(16)),
        },
        enc.encode("x"),
      ),
    ).rejects.toThrow(/p256dh/)
  })
})

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 token for the push service's origin that verifies with the public key", async () => {
    const keys = await generateVapidKeys()
    expect(fromB64url(keys.publicKey).length).toBe(65)
    const now = Date.UTC(2026, 9, 18, 12)
    const header = await vapidAuthorization({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc:def",
      subject: "mailto:hello@mailyard.test",
      publicKey: keys.publicKey,
      privateJwk: keys.privateJwk,
      now,
    })
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
    expect(match?.[2]).toBe(keys.publicKey)
    const [h, c, s] = (match?.[1] ?? "").split(".")
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h ?? "")))).toEqual({ typ: "JWT", alg: "ES256" })
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c ?? "")))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:hello@mailyard.test",
    })
    const pub = await crypto.subtle.importKey(
      "raw",
      fromB64url(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      fromB64url(s ?? ""),
      enc.encode(`${h}.${c}`),
    )
    expect(ok).toBe(true)
  })
})

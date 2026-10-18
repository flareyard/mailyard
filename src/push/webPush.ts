/**
 * Web Push from a Worker (HAL-3369), with nothing but WebCrypto:
 * - the message is encrypted for the subscriber as RFC 8291 says (`aes128gcm`, RFC 8188): an
 *   ephemeral P-256 ECDH key, HKDF with the subscription's `auth` secret, AES-128-GCM, one record;
 * - the request carries a VAPID token (RFC 8292): an ES256 JWT for the push service's origin, signed
 *   with the server's P-256 key, and that key's public half.
 */

const enc = new TextEncoder()

export const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let s = ""
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const fromB64url = (text: string) => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  )
}

export interface Subscription {
  readonly endpoint: string
  /** The subscriber's P-256 public key, uncompressed (65 bytes), base64url. */
  readonly p256dh: string
  /** The subscriber's 16-byte auth secret, base64url. */
  readonly auth: string
}

/** RFC 8291 §3.4: the encrypted body (a single aes128gcm record) for one subscriber. */
export const encryptPayload = async (subscription: Subscription, payload: Uint8Array) => {
  const uaPublic = fromB64url(subscription.p256dh)
  const authSecret = fromB64url(subscription.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh isn't an uncompressed P-256 key")
  if (authSecret.length !== 16) throw new Error("auth isn't 16 bytes")
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as never, local.privateKey, 256),
  )
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12)
  // One record: the payload and the last-record delimiter (0x02), no padding.
  const plain = concat(payload, new Uint8Array([2]))
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain))
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

/** A P-256 key pair for VAPID, as JWKs (the private one is kept sealed). */
export const generateVapidKeys = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  return {
    publicKey: b64url(publicRaw),
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  }
}

/** RFC 8292 §2: the `Authorization: vapid t=…, k=…` header for one push service origin. */
export const vapidAuthorization = async (input: {
  readonly endpoint: string
  readonly subject: string
  readonly publicKey: string
  readonly privateJwk: JsonWebKey
  readonly now?: number
}) => {
  const audience = new URL(input.endpoint).origin
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        // At most 24 hours; 12 leaves room for clock skew.
        exp: Math.floor((input.now ?? Date.now()) / 1000) + 12 * 3600,
        sub: input.subject,
      }),
    ),
  )
  const key = await crypto.subtle.importKey(
    "jwk",
    input.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  // WebCrypto's ECDSA signature is r || s, which is what a JWS needs.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(`${header}.${claims}`),
  )
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${input.publicKey}`
}

export type PushOutcome = "sent" | "gone" | "failed"

/**
 * Sends one notification. `gone` (404 or 410) means the subscription is dead and should be dropped;
 * anything else that isn't a 2xx is `failed`.
 */
export const sendWebPush = async (input: {
  readonly subscription: Subscription
  readonly payload: unknown
  readonly vapid: { readonly subject: string; readonly publicKey: string; readonly privateJwk: JsonWebKey }
  /** Seconds the push service may hold it for an offline device. */
  readonly ttl?: number
  readonly urgency?: "very-low" | "low" | "normal" | "high"
  /** Replaces an undelivered notification with the same topic (at most 32 base64url characters). */
  readonly topic?: string | undefined
}): Promise<{ readonly outcome: PushOutcome; readonly status: number }> => {
  const body = await encryptPayload(input.subscription, enc.encode(JSON.stringify(input.payload)))
  const authorization = await vapidAuthorization({ endpoint: input.subscription.endpoint, ...input.vapid })
  try {
    const response = await fetch(input.subscription.endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(input.ttl ?? 24 * 3600),
        urgency: input.urgency ?? "normal",
        ...(input.topic ? { topic: input.topic } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404 || response.status === 410)
      return { outcome: "gone", status: response.status }
    return { outcome: response.ok ? "sent" : "failed", status: response.status }
  } catch {
    return { outcome: "failed", status: 0 }
  }
}

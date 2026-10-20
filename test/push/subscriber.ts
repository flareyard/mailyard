import { b64url } from "../../src/push/webPush.ts"

/** A browser's side of Web Push (RFC 8291), for tests: its keys, and decrypting what it receives. */
const enc = new TextEncoder()
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  )
}

export const subscriber = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { pair, publicRaw, auth, p256dh: b64url(publicRaw), authB64: b64url(auth) }
}

/** RFC 8291 §3.4 and RFC 8188, from the receiving end. */
export const decrypt = async (body: Uint8Array, sub: Awaited<ReturnType<typeof subscriber>>) => {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)
  const idlen = body[20] ?? 0
  const asPublic = body.slice(21, 21 + idlen)
  const cipher = body.slice(21 + idlen)
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, sub.pair.privateKey, 256),
  )
  const keyInfo = new Uint8Array([...enc.encode("WebPush: info\0"), ...sub.publicRaw, ...asPublic])
  const ikm = await hkdf(sub.auth, ecdh, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher))
  return { rs, idlen, delimiter: plain.at(-1), text: new TextDecoder().decode(plain.slice(0, -1)) }
}

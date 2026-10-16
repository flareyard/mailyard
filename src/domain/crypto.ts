const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")

export const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))

/** A random token in base62, `bytes` of entropy. */
export const randomToken = (bytes = 24) => {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => alphabet[b % 62]).join("")
}

/** Compares two strings in time that depends only on their length, so a key can't be guessed byte by byte. */
export const timingSafeEqual = (a: string, b: string) => {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

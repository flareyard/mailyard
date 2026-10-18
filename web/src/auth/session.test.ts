import { describe, expect, it } from "vitest"
import { ApiError } from "../api/client.ts"
import { keyLooksValid, signInError } from "./session.ts"

describe("signInError", () => {
  it("maps each typed refusal (HAL-3359) to its screen", () => {
    expect(signInError(new ApiError(401, { reason: "format" }))).toEqual({ kind: "format" })
    expect(signInError(new ApiError(401, { reason: "unknown" }))).toEqual({ kind: "unknown" })
    expect(signInError(new ApiError(401, { reason: "revoked", revokedAt: "2026-10-12T09:40:00Z" }))).toEqual({
      kind: "revoked",
      revokedAt: "2026-10-12T09:40:00Z",
    })
    expect(signInError(new ApiError(403, { reason: "public-key" }))).toEqual({ kind: "public-key" })
    expect(
      signInError(new ApiError(403, { reason: "insufficient-scope", required: "read", scopes: ["send"] })),
    ).toEqual({
      kind: "insufficient-scope",
      required: "read",
      scopes: ["send"],
    })
    expect(signInError(new ApiError(429, { retryAfter: 42 }))).toEqual({
      kind: "rate-limited",
      retryAfter: 42,
    })
  })
  it("treats a network failure and a 5xx as unreachable, and keeps the request id otherwise", () => {
    expect(signInError(new TypeError("Failed to fetch"))).toEqual({ kind: "unreachable" })
    expect(signInError(new ApiError(502, {}))).toEqual({ kind: "unreachable" })
    expect(signInError(new ApiError(400, { message: "Bad", requestId: "r1" }))).toEqual({
      kind: "other",
      message: "Bad",
      requestId: "r1",
    })
  })
})

describe("keyLooksValid", () => {
  it("accepts sk_ and pk_ keys and long admin keys, and rejects fragments", () => {
    expect(keyLooksValid("sk_abcdef123456")).toBe(true)
    expect(keyLooksValid("pk_abcdef123456")).toBe(true)
    expect(keyLooksValid("a".repeat(32))).toBe(true)
    expect(keyLooksValid("sk_abc")).toBe(false)
    expect(keyLooksValid("hello")).toBe(false)
  })
})

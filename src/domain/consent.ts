import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { timingSafeEqual } from "./crypto.ts"

/**
 * Signed consent links, verified without a login or a database lookup: the token carries what it
 * grants, and an HMAC over it with UNSUBSCRIBE_KEY proves it came from us. Format
 * `v1.<payload, base64url JSON>.<HMAC-SHA256, base64url>`.
 */
export const ConsentPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("confirm"),
    contactId: Schema.String,
    topicId: Schema.String,
    issuedAt: Schema.Number,
  }),
  /**
   * In every bulk message: opens the preference page, and one-click unsubscribes from `topicId`
   * (everything, when null). It never expires: Gmail and Yahoo require the link to keep working.
   */
  Schema.Struct({
    kind: Schema.Literal("unsubscribe"),
    contactId: Schema.String,
    topicId: Schema.NullOr(Schema.String),
    campaignId: Schema.NullOr(Schema.String),
    issuedAt: Schema.Number,
  }),
])
export type ConsentPayload = typeof ConsentPayload.Type

export class ConsentKeyMissing extends Schema.TaggedError<ConsentKeyMissing>()("ConsentKeyMissing", {}) {}
export class ConsentTokenInvalid extends Schema.TaggedError<ConsentTokenInvalid>()("ConsentTokenInvalid", {
  reason: Schema.String,
}) {}

/** A confirmation link is good for this long; after that the person signs up again. */
export const CONFIRM_TTL_MS = 14 * 86_400_000

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
const fromB64url = (text: string) => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

const keyOf = Effect.gen(function* () {
  const env = yield* Bindings
  if (!env.UNSUBSCRIBE_KEY) return yield* new ConsentKeyMissing()
  return yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.UNSUBSCRIBE_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  )
})

const signature = (key: CryptoKey, body: string) =>
  Effect.promise(async () =>
    b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))),
  )

export const signConsent = Effect.fn("consent.sign")(function* (payload: ConsentPayload) {
  const key = yield* keyOf
  const body = `v1.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`
  return `${body}.${yield* signature(key, body)}`
})

export const verifyConsent = Effect.fn("consent.verify")(function* (token: string, now = Date.now()) {
  const [version, encoded, sig] = token.split(".")
  if (version !== "v1" || !encoded || !sig) return yield* new ConsentTokenInvalid({ reason: "malformed" })
  const key = yield* keyOf
  if (!timingSafeEqual(sig, yield* signature(key, `v1.${encoded}`))) {
    return yield* new ConsentTokenInvalid({ reason: "signature" })
  }
  const payload = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(fromB64url(encoded))) as unknown,
    catch: () => new ConsentTokenInvalid({ reason: "malformed" }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(ConsentPayload)(raw).pipe(
        Effect.mapError(() => new ConsentTokenInvalid({ reason: "malformed" })),
      ),
    ),
  )
  if (payload.kind === "confirm" && now - payload.issuedAt > CONFIRM_TTL_MS) {
    return yield* new ConsentTokenInvalid({ reason: "expired" })
  }
  return payload
})

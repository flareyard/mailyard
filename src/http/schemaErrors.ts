import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { HttpApiSchemaError } from "effect/http-api/HttpApiError"
import * as SchemaIssue from "effect/SchemaIssue"

/**
 * A request that fails an endpoint's declared schema (path, headers, query or body) answers like every
 * other bad request (HAL-3781): `400 { _tag: "InvalidRequest", field, message }`, with requestId added
 * on the way out (workers/api.ts). Effect's HttpApi answers these with an empty 400, which left people
 * and agents with nothing to read; checks written inside handlers already answered this way.
 */

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

const WHERE = { Params: "path", Headers: "header", Query: "query", Payload: "body" } as const

/** The first problem, as the field it's in and a sentence about it. */
export const describeSchemaError = (error: HttpApiSchemaError) => {
  const { issues } = formatter(error.cause.issue)
  const where = WHERE[error.kind as keyof typeof WHERE] ?? "request"
  const first = issues[0]
  const field = first?.path && first.path.length > 0 ? first.path.map(String).join(".") : undefined
  const problems = issues.slice(0, 5).map((i) => {
    const at = i.path && i.path.length > 0 ? i.path.map(String).join(".") : where
    return `${at}: ${i.message}`
  })
  const more = issues.length > 5 ? ` (and ${issues.length - 5} more)` : ""
  return {
    _tag: "InvalidRequest" as const,
    message: `The ${where} doesn't match this endpoint's schema. ${problems.join("; ")}${more}.`,
    ...(field ? { field } : {}),
  }
}

/** Only request decoding: a response that fails to encode is the server's fault and stays a 500. */
const isRequestSchemaError = (u: unknown): u is HttpApiSchemaError =>
  HttpApiSchemaError.is(u) && u.kind !== "Body" && u.kind !== "ResponseHeaders"

export const SchemaErrorsAsJson = HttpRouter.middleware(
  (httpEffect) =>
    Effect.catchDefect(httpEffect, (defect) =>
      isRequestSchemaError(defect)
        ? Effect.succeed(HttpServerResponse.jsonUnsafe(describeSchemaError(defect), { status: 400 }))
        : Effect.die(defect),
    ),
  { global: true },
)

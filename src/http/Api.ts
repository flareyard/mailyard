import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ApiKeyAuth, Forbidden } from "./Auth.ts"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  app: Schema.Literal("mailflare"),
  version: Schema.String,
  database: Schema.Literal("ok"),
})

export class Unhealthy extends Schema.TaggedError<Unhealthy>()(
  "Unhealthy",
  { database: Schema.Literal("unreachable") },
  { httpApiStatus: 503 },
) {}

/** The platform's health check calls this before it marks a deploy as running (manifest `health`). */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", { success: Health, error: Unhealthy }),
) {}

// ---------------------------------------------------------------------------------------------
// Plunk-compatible actions. Shapes measured from useplunk/plunk `apps/api/src/controllers/Actions.ts`
// (branch next, 2026-10-16), so the Plunk SDK works by changing only its base URL.
// ---------------------------------------------------------------------------------------------

const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
const Named = Schema.Struct({ email: Email, name: Schema.optionalKey(Schema.String) })
const Recipient = Schema.Union([Email, Named])

export const SendPayload = Schema.Struct({
  to: Schema.Union([Recipient, Schema.NonEmptyArray(Recipient)]),
  subject: Schema.optionalKey(Schema.String),
  /** HTML body, with {{ placeholders }}. */
  body: Schema.optionalKey(Schema.String),
  subscribed: Schema.optionalKey(Schema.Boolean),
  /** Sender name, when `from` is a bare address. */
  name: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.Union([Email, Named])),
  reply: Schema.optionalKey(Email),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  template: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        filename: Schema.NonEmptyString,
        /** Base64. */
        content: Schema.String,
        contentType: Schema.NonEmptyString,
      }),
    ),
  ),
})
export type SendPayload = typeof SendPayload.Type

export const SendResponse = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    emails: Schema.Array(
      Schema.Struct({
        contact: Schema.Struct({ id: Schema.String, email: Schema.String }),
        email: Schema.String,
        /** Mailflare addition: sent, deferred (queued for retry), failed or rejected. */
        status: Schema.String,
      }),
    ),
    timestamp: Schema.String,
  }),
})

export const TrackPayload = Schema.Struct({
  event: Schema.NonEmptyString,
  email: Email,
  subscribed: Schema.optionalKey(Schema.Boolean),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

export const TrackResponse = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({ contact: Schema.String, event: Schema.String, timestamp: Schema.String }),
})

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { field: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class Unprocessable extends Schema.TaggedError<Unprocessable>()(
  "Unprocessable",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const IdempotencyHeader = {
  "idempotency-key": Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
}

export class ActionsApi extends HttpApiGroup.make("actions")
  .add(
    HttpApiEndpoint.post("send", "/v1/send", {
      headers: IdempotencyHeader,
      payload: SendPayload,
      success: SendResponse,
      error: [InvalidRequest, NotFound, IdempotencyConflict, Unprocessable, Forbidden],
    }),
    HttpApiEndpoint.post("track", "/v1/track", {
      headers: IdempotencyHeader,
      payload: TrackPayload,
      success: TrackResponse,
      error: [InvalidRequest, IdempotencyConflict, Forbidden],
    }),
  )
  .middleware(ApiKeyAuth)
  .annotateMerge(
    OpenApi.annotations({ title: "Actions", description: "Send and track, compatible with Plunk." }),
  ) {}

// ---------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------

const Scope = Schema.Literals(["send", "track", "read", "admin"])

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["secret", "public"]),
  prefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
})

export class ApiKeysApi extends HttpApiGroup.make("apiKeys")
  .add(
    HttpApiEndpoint.get("list", "/v1/api-keys", {
      success: Schema.Struct({ keys: Schema.Array(ApiKeySummary) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/api-keys", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
        kind: Schema.Literals(["secret", "public"]),
        scopes: Schema.optionalKey(Schema.Array(Scope)),
      }),
      /** `key` is returned once, here, and never again. */
      success: Schema.Struct({ key: Schema.String, apiKey: ApiKeySummary }),
      error: Forbidden,
    }),
    HttpApiEndpoint.delete("revoke", "/v1/api-keys/:id", {
      params: { id: Schema.String },
      success: ApiKeySummary,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Message log
// ---------------------------------------------------------------------------------------------

export const MessageStatus = Schema.Literals([
  "queued",
  "sent",
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
])

export const MessageSummary = Schema.Struct({
  id: Schema.String,
  stream: Schema.String,
  recipient: Schema.String,
  sender: Schema.String,
  subject: Schema.String,
  status: MessageStatus,
  bounceType: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  cfMessageId: Schema.NullOr(Schema.String),
  templateId: Schema.NullOr(Schema.String),
  apiKeyId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

export const MessageDetail = Schema.Struct({
  ...MessageSummary.fields,
  smtpResponse: Schema.NullOr(Schema.String),
  rendered: Schema.NullOr(
    Schema.Struct({
      from: Schema.String,
      to: Schema.Array(Schema.String),
      subject: Schema.String,
      html: Schema.NullOr(Schema.String),
      text: Schema.NullOr(Schema.String),
      attachments: Schema.Array(
        Schema.Struct({ filename: Schema.String, type: Schema.String, size: Schema.Number }),
      ),
    }),
  ),
})

export class MessagesApi extends HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.get("list", "/v1/messages", {
      query: {
        status: Schema.optionalKey(MessageStatus),
        recipient: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        messages: Schema.Array(MessageSummary),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/messages/:id", {
      params: { id: Schema.String },
      success: MessageDetail,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

/** Mailflare's HTTP API. The UI contract (docs/plans/email-ui.html#contract) grows here, group by group. */
export class MailApi extends HttpApi.make("mailflare")
  .add(SystemApi)
  .add(ActionsApi)
  .add(ApiKeysApi)
  .add(MessagesApi)
  .annotateMerge(OpenApi.annotations({ title: "Mailflare API" })) {}

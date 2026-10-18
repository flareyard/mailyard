import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as OpenApi from "effect/http-api/OpenApi"
import * as Schema from "effect/Schema"
import { DryRunInput } from "../automations/dryRun.ts"
import {
  Graph as AutomationGraph,
  Settings as AutomationSettings,
  TriggerConfig,
} from "../automations/graph.ts"
import { TrackingOriginCheck } from "../campaigns/compliance.ts"
import { RECIPIENT_FILTERS } from "../campaigns/report.ts"
import { ALERT_KINDS } from "../domain/alerts.ts"
import { BrandSettings } from "../domain/brand.ts"
import { WEBHOOK_EVENTS } from "../domain/webhooks.ts"
import { SendBlocked } from "../mail/send.ts"
import { LABEL_COLORS } from "../mailbox/types.ts"
import { Action as RuleAction, Condition as RuleCondition } from "../rules/engine.ts"
import { Rule as SegmentRule } from "../segments/rules.ts"
import { BlocksDocument } from "../templates/document.ts"
import { ApiKeyAuth, Forbidden, RateLimited, Unauthorized } from "./Auth.ts"
import { withRawRoutes } from "./rawRoutes.ts"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  app: Schema.Literal("mailyard"),
  version: Schema.String,
  database: Schema.Literal("ok"),
})

export class Unhealthy extends Schema.TaggedError<Unhealthy>()(
  "Unhealthy",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    database: Schema.Literal("unreachable"),
  },
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
  /** Track opens and clicks on this send. Transactional mail is untracked unless asked. */
  track: Schema.optionalKey(
    Schema.Struct({ opens: Schema.optionalKey(Schema.Boolean), clicks: Schema.optionalKey(Schema.Boolean) }),
  ),
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
        /** Mailyard addition: sent, deferred (queued for retry), failed or rejected. */
        status: Schema.String,
      }),
    ),
    timestamp: Schema.String,
    /** Mailyard addition (HAL-3460): set, with `emails` empty, when the key's sends wait for approval. */
    approval: Schema.optionalKey(Schema.Struct({ id: Schema.String, status: Schema.Literal("pending") })),
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
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    field: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/** `POST /v1/domains/{id}/fix` can't: no zone token, no zone for the domain, or nothing failing. */
export class FixRefused extends Schema.TaggedError<FixRefused>()(
  "FixRefused",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    reason: Schema.Literals(["no_dns_token", "zone_not_found", "nothing_to_fix"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
    /** A machine-readable why, where the screen acts on it (suppressions: `complaint`, `not-applicable`). */
    reason: Schema.optionalKey(Schema.String),
    /** With `reason: "stale"`: when the other save was, and whose (HAL-3428). */
    updatedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    updatedBy: Schema.optionalKey(Schema.NullOr(Schema.String)),
    /** With `reason: "routing-rule-exists"` (HAL-3378): where Cloudflare's rule sends the mail now. */
    ruleDestination: Schema.optionalKey(Schema.String),
    ruleAction: Schema.optionalKey(Schema.String),
    ruleId: Schema.optionalKey(Schema.String),
    /** With `reason: "alias-targets"` on a mailbox removal: the aliases and groups that still deliver there. */
    aliasIds: Schema.optionalKey(Schema.Array(Schema.String)),
    /** With `reason: "agent_limit"` (HAL-3460): the key's daily cap, what it sent today, and when it resets. */
    limit: Schema.optionalKey(Schema.Number),
    sentToday: Schema.optionalKey(Schema.Number),
    resetsAt: Schema.optionalKey(Schema.Number),
    /** With `reason: "recipient_not_allowed"`: the addresses outside the key's allow-list. */
    notAllowed: Schema.optionalKey(Schema.Array(Schema.String)),
    /** With `reason: "workspace-deleting"` (HAL-3448): when the workspace will be deleted. */
    deletesAt: Schema.optionalKey(Schema.Number),
    /** With `reason: "already-claimed"` (HAL-3361): who claimed the workspace, and when. */
    claimedBy: Schema.optionalKey(Schema.String),
    claimedAt: Schema.optionalKey(Schema.Number),
  },
  { httpApiStatus: 409 },
) {}

/** A link that worked once and doesn't any more: `expired`, `used` or `revoked` (HAL-3361). */
export class Gone extends Schema.TaggedError<Gone>()(
  "Gone",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
    reason: Schema.Literals(["expired", "used", "revoked"]),
  },
  { httpApiStatus: 410 },
) {}

/** Mailyard has no address to send its own mail from: set MAILYARD_SYSTEM_FROM or DEFAULT_FROM. */
export class NoSystemSender extends Schema.TaggedError<NoSystemSender>()(
  "NoSystemSender",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

/** An automation can't publish yet: what's wrong, per node. */
export class NotReady extends Schema.TaggedError<NotReady>()(
  "NotReady",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({ nodeId: Schema.NullOr(Schema.String), code: Schema.String, message: Schema.String }),
    ),
  },
  { httpApiStatus: 409 },
) {}

export class Unprocessable extends Schema.TaggedError<Unprocessable>()(
  "Unprocessable",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
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
      error: [InvalidRequest, NotFound, IdempotencyConflict, Unprocessable, Forbidden, Conflict],
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
const KeyPurpose = Schema.Literals(["api", "mcp"])

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["secret", "public"]),
  /** `api` for code calling the API, `mcp` for an agent's key. A label: scopes decide access. */
  purpose: KeyPurpose,
  prefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.Number),
  /** When it stopped working; in the future, a rotated key's last moment. */
  revokedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  /** With `?include=usage`: requests in the last 24 hours, by the hour they arrived in. */
  requests24h: Schema.optionalKey(Schema.Number),
})

export class ApiKeysApi extends HttpApiGroup.make("apiKeys")
  .add(
    HttpApiEndpoint.get("list", "/v1/api-keys", {
      query: {
        purpose: Schema.optionalKey(KeyPurpose),
        include: Schema.optionalKey(Schema.Literal("usage")),
      },
      success: Schema.Struct({ keys: Schema.Array(ApiKeySummary) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/api-keys", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
        kind: Schema.Literals(["secret", "public"]),
        scopes: Schema.optionalKey(Schema.Array(Scope)),
        /** Defaults to `api`. Public keys are always `api`: /mcp refuses them. */
        purpose: Schema.optionalKey(KeyPurpose),
      }),
      /** `key` is returned once, here, and never again. */
      success: Schema.Struct({ key: Schema.String, apiKey: ApiKeySummary }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.post("rotate", "/v1/api-keys/:id/rotate", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** How long the old key keeps working, 0 (default) to 604800 (a week). */
        graceSeconds: Schema.optionalKey(
          Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 604_800 })),
        ),
      }),
      /** `key` is returned once, here. The new key has the old one's scopes, purpose and mailboxes. */
      success: Schema.Struct({
        key: Schema.String,
        apiKey: ApiKeySummary,
        previous: Schema.Struct({ id: Schema.String, revokedAt: Schema.Number }),
      }),
      error: [Forbidden, NotFound],
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

const MessageStream = Schema.Literals([
  "transactional",
  "campaign",
  "automation",
  "reply",
  "mailbox",
  "test",
  "system",
])
/** What sent it: `api` (POST /v1/send), a campaign, an automation, a mailbox, or a campaign test send. */
const MessageSource = Schema.Literals(["api", "campaign", "automation", "mailbox", "test", "system"])

export const MessageEvent = Schema.Struct({
  type: Schema.Literals([
    "accepted",
    "sent",
    "deferred",
    "delivered",
    "bounced",
    "complained",
    "failed",
    "rejected",
    "suppressed",
    "opened",
    "clicked",
  ]),
  at: Schema.Number,
  /** Mailyard's attempt number when it changed, for sends and retries. */
  attempt: Schema.NullOr(Schema.Number),
  /** The receiving provider (gmail, outlook, …) Email Service reported. */
  provider: Schema.NullOr(Schema.String),
  bounceType: Schema.NullOr(Schema.String),
  smtpResponse: Schema.NullOr(Schema.String),
  /** Why an attempt failed or was deferred, in the sender's words. */
  detail: Schema.NullOr(Schema.String),
})

export const MessageSummary = Schema.Struct({
  id: Schema.String,
  stream: Schema.String,
  source: MessageSource,
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
  templateVersion: Schema.NullOr(Schema.Number),
  apiKeyId: Schema.NullOr(Schema.String),
  campaignId: Schema.NullOr(Schema.String),
  tracked: Schema.Boolean,
  firstOpenedAt: Schema.NullOr(Schema.Number),
  firstClickedAt: Schema.NullOr(Schema.Number),
  opens: Schema.Number,
  clicks: Schema.Number,
  /** Opens and clicks that looked like machines: privacy proxies, link scanners. */
  machineOpens: Schema.Number,
  machineClicks: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

export const MessageDetail = Schema.Struct({
  ...MessageSummary.fields,
  smtpResponse: Schema.NullOr(Schema.String),
  /** The Idempotency-Key the request carried (for API sends), or the internal one for runs. */
  idempotencyKey: Schema.NullOr(Schema.String),
  /** When Mailyard's own retry is due, while one is queued. */
  nextAttemptAt: Schema.NullOr(Schema.Number),
  /** The trail, oldest first. Messages sent before 2026-10-18 have none. */
  events: Schema.Array(MessageEvent),
  /** The headers Mailyard gave Email Service; it adds its own (Received, DKIM-Signature, …). */
  headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
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
        stream: Schema.optionalKey(MessageStream),
        templateId: Schema.optionalKey(Schema.String),
        /** A message id or Cloudflare message id (exact), or the start of a recipient address. */
        q: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254))),
        /** Created at or after, and before, in epoch milliseconds. */
        from: Schema.optionalKey(Schema.NumberFromString),
        to: Schema.optionalKey(Schema.NumberFromString),
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

// ---------------------------------------------------------------------------------------------
// Templates and brand
// ---------------------------------------------------------------------------------------------

const TemplateKind = Schema.Literals(["html", "blocks"])
const Variables = Schema.Struct({ used: Schema.Array(Schema.String), required: Schema.Array(Schema.String) })

export const TemplateSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: TemplateKind,
  publishedVersion: Schema.NullOr(Schema.Number),
  latestVersion: Schema.Number,
  hasUnpublishedChanges: Schema.Boolean,
  archived: Schema.Boolean,
  updatedAt: Schema.Number,
  createdAt: Schema.Number,
  /** With `?include=usage`: sends in the last 30 days, and what uses it. */
  usage: Schema.optionalKey(
    Schema.Struct({
      sends30d: Schema.Number,
      usedBy: Schema.Array(
        Schema.Struct({
          type: Schema.Literals(["automation", "campaign", "apiKey"]),
          id: Schema.String,
          name: Schema.String,
        }),
      ),
    }),
  ),
})

export const TemplateDetail = Schema.Struct({
  ...TemplateSummary.fields,
  latest: Schema.NullOr(
    Schema.Struct({
      version: Schema.Number,
      subject: Schema.String,
      source: Schema.String,
      text: Schema.NullOr(Schema.String),
      publishedAt: Schema.NullOr(Schema.Number),
      /** When this version was last saved, and the key that saved it. */
      updatedAt: Schema.Number,
      updatedBy: Schema.NullOr(Schema.String),
      variables: Variables,
    }),
  ),
  versions: Schema.Array(
    Schema.Struct({
      version: Schema.Number,
      subject: Schema.String,
      publishedAt: Schema.NullOr(Schema.Number),
      createdBy: Schema.NullOr(Schema.String),
      createdAt: Schema.Number,
    }),
  ),
})

export const RenderResult = Schema.Struct({
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
  size: Schema.Number,
  /** Email Service's 5 MiB limit, before attachments. */
  withinLimit: Schema.Boolean,
  variables: Schema.Struct({ ...Variables.fields, missing: Schema.Array(Schema.String) }),
})

const TemplateBody = {
  subject: Schema.String.check(Schema.isMaxLength(998)),
  /** HTML for `html` templates; the blocks document as JSON text for `blocks` templates. */
  source: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
}

const RenderData = Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))

export class TemplatesApi extends HttpApiGroup.make("templates")
  .add(
    HttpApiEndpoint.get("list", "/v1/templates", {
      query: {
        archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
        include: Schema.optionalKey(Schema.Literal("usage")),
      },
      success: Schema.Struct({ templates: Schema.Array(TemplateSummary) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/templates", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
        kind: TemplateKind,
        ...TemplateBody,
        publish: Schema.optionalKey(Schema.Boolean),
      }),
      success: TemplateDetail,
      error: [Forbidden, InvalidRequest, NotFound],
    }),
    HttpApiEndpoint.get("get", "/v1/templates/:id", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.put("saveDraft", "/v1/templates/:id/draft", {
      params: { id: Schema.String },
      payload: Schema.Struct(TemplateBody),
      success: TemplateDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("publish", "/v1/templates/:id/publish", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("rollback", "/v1/templates/:id/rollback", {
      params: { id: Schema.String },
      payload: Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThan(0)) }),
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.delete("archive", "/v1/templates/:id", {
      params: { id: Schema.String },
      success: TemplateDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("render", "/v1/templates/:id/render", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        data: RenderData,
        /** `published` (default), `latest` (the draft), or a version number. */
        version: Schema.optionalKey(Schema.Union([Schema.Literals(["published", "latest"]), Schema.Int])),
      }),
      success: RenderResult,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("test", "/v1/templates/:id/test", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** One to five addresses. */
        to: Schema.Array(Schema.String),
        /** Merge data, as `POST /v1/send` takes it; also visible as `data.*` and `trigger.*`. */
        data: RenderData,
        /** `latest` (default, so a draft can be tried), `published`, or a version number. */
        version: Schema.optionalKey(Schema.Union([Schema.Literals(["published", "latest"]), Schema.Int])),
        /** Who it comes from; DEFAULT_FROM when left out. */
        from: Schema.optionalKey(Schema.String),
      }),
      success: Schema.Struct({
        version: Schema.Number,
        sent: Schema.Array(
          Schema.Struct({ email: Schema.String, messageId: Schema.String, status: Schema.String }),
        ),
      }),
      error: [Conflict, Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("preview", "/v1/templates/preview", {
      payload: Schema.Struct({ kind: TemplateKind, ...TemplateBody, data: RenderData }),
      success: RenderResult,
      error: [Forbidden, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

/** The sender's brand: what templates, signup forms and the public pages are drawn with. */
export const BrandSettingsSchema = BrandSettings

const AuditEntrySchema = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  actor: Schema.Struct({
    /** `key` an API key, `root` the deploy's admin key, `system` Mailyard itself (sweeps, workflows). */
    type: Schema.Literals(["key", "root", "system"]),
    id: Schema.String,
    name: Schema.String,
  }),
  /** How a key acted: `mcp` for a key made for the MCP server; null for root and system. */
  via: Schema.NullOr(Schema.Literals(["api", "mcp"])),
  /** Not recorded: always null. */
  ip: Schema.Null,
  location: Schema.Null,
  action: Schema.String,
  target: Schema.NullOr(
    Schema.Struct({
      type: Schema.NullOr(Schema.String),
      id: Schema.String,
      /** The thing's current name or address; null once it's gone, or for kinds without one. */
      label: Schema.NullOr(Schema.String),
    }),
  ),
  before: Schema.Unknown,
  after: Schema.Unknown,
})

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("getBrand", "/v1/settings/brand", { success: BrandSettingsSchema, error: Forbidden }),
    /**
     * Replaces the brand. Colours are checked against WCAG AA (4.5:1) as they'll be used: a pair that
     * fails answers `400 { field: "colors.indigo", message }`. `logoUploadId` (a PNG, JPEG, WebP or GIF
     * from `POST /v1/uploads`, at most 1 MiB) stores the logo here and sets `logoUrl` to it, so it
     * isn't hotlinked.
     */
    HttpApiEndpoint.put("putBrand", "/v1/settings/brand", {
      payload: Schema.Struct({
        ...BrandSettings.fields,
        logoUploadId: Schema.optionalKey(Schema.String),
      }),
      success: BrandSettingsSchema,
      error: [Forbidden, InvalidRequest],
    }),
    /**
     * The audit log, newest first. `action` is exact, or a family ending in `.` or `.*`. `from`/`to`
     * are ms. `GET /v1/audit?format=csv` answers the same entries as CSV (up to 10,000), with
     * `x-truncated: true` when there were more.
     */
    HttpApiEndpoint.get("audit", "/v1/audit", {
      query: {
        actor: Schema.optionalKey(Schema.String),
        action: Schema.optionalKey(Schema.String),
        target: Schema.optionalKey(Schema.String),
        from: Schema.optionalKey(Schema.NumberFromString),
        to: Schema.optionalKey(Schema.NumberFromString),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
        format: Schema.optionalKey(Schema.Literals(["json", "csv"])),
      },
      success: Schema.Struct({
        entries: Schema.Array(AuditEntrySchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Webhooks (Standard Webhooks signatures)
// ---------------------------------------------------------------------------------------------

/**
 * What a webhook can subscribe to. Deliveries are signed per Standard Webhooks: headers `webhook-id`,
 * `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, keyed
 * by the endpoint's `whsec_` secret.
 */
export const WebhookEventSchema = Schema.Literals(WEBHOOK_EVENTS).annotate({
  description:
    'A webhook event. Deliveries carry Standard Webhooks headers: webhook-id, webhook-timestamp and webhook-signature (v1,<base64 HMAC-SHA256 of "id.timestamp.body"> with the endpoint\'s whsec_ secret).',
})

export const WebhookEndpoint = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The events this endpoint receives; `*` means all of them. */
  events: Schema.Array(Schema.Union([WebhookEventSchema, Schema.Literal("*")])),
  enabled: Schema.Boolean,
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastFailureAt: Schema.NullOr(Schema.Number),
  /** Deliveries that failed for good; replay them with POST …/deliveries/replay. */
  deadLetters: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const DeliveryStatus = Schema.Literals(["pending", "succeeded", "retrying", "dead"])

export const WebhookDelivery = Schema.Struct({
  id: Schema.String,
  eventId: Schema.String,
  eventType: Schema.String,
  status: DeliveryStatus,
  attempts: Schema.Number,
  lastStatusCode: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
  lastDurationMs: Schema.NullOr(Schema.Number),
  lastAttemptAt: Schema.NullOr(Schema.Number),
  nextAttemptAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  payload: Schema.Unknown,
})

const WithSecret = Schema.Struct({
  endpoint: WebhookEndpoint,
  /** `whsec_…`, shown here once. Verify signatures with any Standard Webhooks library. */
  secret: Schema.String,
})

export class WebhooksApi extends HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("list", "/v1/webhooks", {
      success: Schema.Struct({
        webhooks: Schema.Array(WebhookEndpoint),
        /** Every event an endpoint can subscribe to. */
        events: Schema.Array(WebhookEventSchema),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/webhooks", {
      payload: Schema.Struct({
        url: Schema.String,
        description: Schema.optionalKey(Schema.String),
        events: Schema.NonEmptyArray(Schema.String),
      }),
      success: WithSecret,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      success: WebhookEndpoint,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        url: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        events: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
        enabled: Schema.optionalKey(Schema.Boolean),
      }),
      success: WebhookEndpoint,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/webhooks/:id", {
      params: { id: Schema.String },
      success: WebhookEndpoint,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("rotateSecret", "/v1/webhooks/:id/rotate-secret", {
      params: { id: Schema.String },
      success: WithSecret,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("deliveries", "/v1/webhooks/:id/deliveries", {
      params: { id: Schema.String },
      query: {
        status: Schema.optionalKey(DeliveryStatus),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        deliveries: Schema.Array(WebhookDelivery),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("replayAll", "/v1/webhooks/:id/deliveries/replay", {
      params: { id: Schema.String },
      payload: Schema.Struct({ status: Schema.Literal("dead") }),
      /** At most 500 per call; call again while `remaining` is above 0. */
      success: Schema.Struct({ replayed: Schema.Number, remaining: Schema.Number }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("replay", "/v1/webhooks/:id/deliveries/:deliveryId/replay", {
      params: { id: Schema.String, deliveryId: Schema.String },
      success: Schema.Struct({ id: Schema.String, status: DeliveryStatus }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("test", "/v1/webhooks/:id/test", {
      params: { id: Schema.String },
      success: Schema.Struct({ deliveryId: Schema.String, eventId: Schema.String }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Insights: what the Overview screen shows (docs/email-ui.html#overview)
// ---------------------------------------------------------------------------------------------

const Range = Schema.Literals(["24h", "7d", "30d"])
const Num = Schema.Number
const NullableNum = Schema.NullOr(Schema.Number)

export const Totals = Schema.Struct({
  sent: Num,
  delivered: Num,
  deferred: Num,
  bouncedHard: Num,
  bouncedSoft: Num,
  complained: Num,
  rejected: Num,
  failed: Num,
})

export const Rates = Schema.Struct({
  /** True under the minimum volume; the rates are then null rather than misleading. */
  insufficientData: Schema.Boolean,
  minimumSends: Num,
  bounceRate: NullableNum,
  complaintRate: NullableNum,
  rejectionRate: NullableNum,
  deliveryRate: NullableNum,
})

/** Messages per stream: the governor's four, always all present. Replies count as mailbox; tests aren't counted. */
const StreamCounts = Schema.Struct({ transactional: Num, campaign: Num, automation: Num, mailbox: Num })

const ThresholdSchema = Schema.Struct({ warning_at: Num, at_risk_at: Num, minimum_denominator: Num })
const Level = Schema.Literals(["ok", "warning", "at-risk", "insufficient-data"])

export class InsightsApi extends HttpApiGroup.make("insights")
  .add(
    HttpApiEndpoint.get("health", "/v1/health", {
      success: Schema.Struct({
        status: Schema.Literals(["ok", "warn", "fail"]),
        checks: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            status: Schema.Literals(["ok", "warn", "fail", "unknown"]),
            detail: Schema.String,
          }),
        ),
        checkedAt: Schema.String,
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("usage", "/v1/usage", {
      success: Schema.Struct({
        today: Schema.Struct({
          sent: Num,
          quota: NullableNum,
          remaining: NullableNum,
          overQuota: Schema.NullOr(Schema.Boolean),
          resetsAt: Schema.NullOr(Schema.String),
          source: Schema.Literals(["cloudflare", "cloudflare-unreachable", "not-connected"]),
        }),
        month: Schema.Struct({
          from: Schema.String,
          billed: Num,
          included: Num,
          overage: Num,
          costUsd: Num,
          projectedBilled: Num,
          projectedCostUsd: Num,
        }),
        pricing: Schema.Struct({ includedPerMonth: Num, usdPerThousand: Num, measuredAt: Schema.String }),
      }),
      error: Forbidden,
    }),
    /**
     * How long a bulk send takes from `startAt`, behind the campaigns already scheduled or sending,
     * on each day's bulk share (the transactional reserve is left out). Automations share it too
     * and aren't forecast.
     */
    HttpApiEndpoint.get("forecast", "/v1/usage/forecast", {
      query: {
        recipients: Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 10_000_000 })),
        /** When the send starts (ms); left out or past, now. */
        startAt: Schema.optionalKey(Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0))),
        /** The campaign being planned, so its own place in the queue isn't counted twice. */
        campaignId: Schema.optionalKey(Schema.String),
      },
      success: Schema.Union([
        Schema.Struct({
          recipients: Num,
          startAt: Num,
          possible: Schema.Literal(false),
          reason: Schema.String,
        }),
        Schema.Struct({
          recipients: Num,
          startAt: Num,
          possible: Schema.Literal(true),
          quota: Num,
          sendableToday: Num,
          additionalDays: Num,
          finishesBy: Schema.NullOr(Schema.String),
          /** Today to the finish, a UTC day each: bulk sends the day allows, and who gets them. */
          days: Schema.Array(
            Schema.Struct({ day: Schema.String, available: Num, queued: Num, thisCampaign: Num }),
          ),
          cost: Schema.Struct({ billedAfter: Num, extraUsd: Num }),
        }),
      ]),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("delivery", "/v1/stats/delivery", {
      query: {
        range: Schema.optionalKey(Range),
        /** `day`: per-day totals and rates too, each with its own `insufficientData`. */
        by: Schema.optionalKey(Schema.Literal("day")),
      },
      success: Schema.Struct({
        range: Range,
        from: Schema.String,
        totals: Totals,
        rates: Rates,
        /**
         * From each message's sent event to its delivered event, to the bucket: each quantile is the
         * upper bound of its bucket (null in the open last one, a day or more). Null with no deliveries.
         */
        deliveryTime: Schema.Struct({
          medianMs: NullableNum,
          p95Ms: NullableNum,
          samples: Num,
          approximate: Schema.Literal(true),
          buckets: Schema.Array(Schema.Struct({ underMs: NullableNum, n: Num })),
        }),
        /** With by=day: every day in the range, oldest first. */
        days: Schema.Array(Schema.Struct({ day: Schema.String, totals: Totals, rates: Rates })),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("engagement", "/v1/stats/engagement", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({
        range: Range,
        from: Schema.String,
        /** Opens are estimates: privacy proxies open mail for people, so machine opens are counted apart. */
        estimate: Schema.Literal(true),
        /** Campaigns started in the range, newest first, at most 100. Rates are fractions of delivered. */
        campaigns: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            startedAt: Num,
            delivered: Num,
            uniqueOpens: Num,
            machineOpens: Num,
            uniqueClicks: Num,
            unsubscribed: Num,
            openRate: NullableNum,
            clickRate: NullableNum,
          }),
        ),
        /** First human opens and clicks of bulk mail, Monday first, by UTC hour. */
        byHour: Schema.Array(
          Schema.Struct({
            weekday: Schema.Literals(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
            hours: Schema.Array(Schema.Struct({ hour: Num, opens: Num, clicks: Num })),
          }),
        ),
        unsubscribesByTopic: Schema.Array(
          Schema.Struct({ topicId: Schema.String, name: Schema.String, unsubscribed: Num }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("storage", "/v1/usage/storage", {
      success: Schema.Struct({
        totalBytes: Num,
        mailBytes: Num,
        exportsBytes: Num,
        uploadsBytes: Num,
        /** Largest first; a mailbox that didn't answer has null counts and isn't in the total. */
        byMailbox: Schema.Array(
          Schema.Struct({
            mailboxId: Schema.String,
            address: Schema.String,
            messages: NullableNum,
            bytes: NullableNum,
          }),
        ),
        measuredAt: Num,
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("deferrals", "/v1/stats/deferrals", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({
        range: Range,
        /** At most 50, most common first. `smtpStatus` is the response's leading code ("421 4.7.0"), when it has one. */
        reasons: Schema.Array(
          Schema.Struct({
            reason: Schema.String,
            smtpStatus: Schema.NullOr(Schema.String),
            provider: Schema.NullOr(Schema.String),
            count: Num,
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("volume", "/v1/stats/volume", {
      query: {
        range: Schema.optionalKey(Range),
        /** `hour`: the last 24 hours in hourly buckets (range is then 24h). */
        by: Schema.optionalKey(Schema.Literals(["day", "hour"])),
      },
      success: Schema.Struct({
        range: Range,
        by: Schema.Literals(["day", "hour"]),
        /** With by=day. */
        days: Schema.Array(Schema.Struct({ day: Schema.String, byStream: StreamCounts })),
        /** With by=hour: 24 buckets, oldest first, each the hour's start as ISO 8601. */
        hours: Schema.Array(Schema.Struct({ hour: Schema.String, byStream: StreamCounts })),
        streams: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("providers", "/v1/stats/providers", {
      query: { range: Schema.optionalKey(Range) },
      success: Schema.Struct({
        range: Range,
        providers: Schema.Array(
          Schema.Struct({
            provider: Schema.String,
            delivered: Num,
            deferred: Num,
            bounced: Num,
            complained: Num,
            total: Num,
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("reputation", "/v1/reputation", {
      success: Schema.Struct({
        status: Schema.NullOr(Schema.String),
        statusSince: Schema.NullOr(Schema.String),
        graceStartedAt: Schema.NullOr(Schema.String),
        evaluatedAt: Schema.NullOr(Schema.String),
        source: Schema.Literals(["cloudflare", "not-connected"]),
        policySource: Schema.Literals(["account", "measured-2026-10-16"]),
        policy: Schema.Struct({
          customer_bounce: ThresholdSchema,
          complaint: ThresholdSchema,
          spam_rejection: ThresholdSchema,
          suspension_after_hours: Num,
        }),
        window: Schema.Literal("30d"),
        totals: Totals,
        rates: Rates,
        levels: Schema.Struct({ bounce: Level, complaint: Level, spamRejection: Level }),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Inbound ledger: every message Email Routing handed us, and whether it reached its mailboxes
// ---------------------------------------------------------------------------------------------

const InboundStatus = Schema.Literals(["received", "filed", "rejected", "held", "failed", "consumed"])

export const InboundMessage = Schema.Struct({
  id: Schema.String,
  status: InboundStatus,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  messageId: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  fromAddress: Schema.NullOr(Schema.String),
  size: Schema.Number,
  sha256: Schema.String,
  via: Schema.NullOr(Schema.Literals(["mailbox", "alias", "group", "catch_all"])),
  tag: Schema.NullOr(Schema.String),
  mailboxIds: Schema.Array(Schema.String),
  deliveredTo: Schema.Array(Schema.String),
  attempts: Schema.Number,
  error: Schema.NullOr(Schema.String),
  receivedAt: Schema.Number,
  filedAt: Schema.NullOr(Schema.Number),
})

export class InboundApi extends HttpApiGroup.make("inbound")
  .add(
    HttpApiEndpoint.get("list", "/v1/inbound", {
      query: {
        status: Schema.optionalKey(InboundStatus),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        ),
      },
      success: Schema.Struct({
        messages: Schema.Array(InboundMessage),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/inbound/:id", {
      params: { id: Schema.String },
      success: InboundMessage,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("reprocess", "/v1/inbound/:id/reprocess", {
      params: { id: Schema.String },
      success: InboundMessage,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Domains, mailboxes and identities (docs/email-ui.html: Domain detail, Mailboxes and addresses)
// ---------------------------------------------------------------------------------------------

/** `checking`: a recheck is running; the record's last known detail stays until it finishes. */
const CheckStatus = Schema.Literals(["pass", "warn", "fail", "error", "checking"])
const CatchAll = Schema.Literals(["bounce", "keep"])

export const RecordCheckSchema = Schema.Struct({
  id: Schema.Literals(["mx", "spf", "dkim", "dmarc", "bounce-mx", "bounce-spf", "bounce-dkim"]),
  purpose: Schema.Literals(["receiving", "sending"]),
  name: Schema.String,
  type: Schema.Literals(["MX", "TXT", "CNAME"]),
  expected: Schema.String,
  actual: Schema.Array(Schema.String),
  status: CheckStatus,
  detail: Schema.String,
  /** When this check last changed status; missing on checks stored before 2026-10-18. */
  changedAt: Schema.optionalKey(Schema.Number),
})

export const DomainSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  zoneId: Schema.NullOr(Schema.String),
  receiving: Schema.Boolean,
  sending: Schema.Boolean,
  catchAll: CatchAll,
  mailboxCount: Schema.Number,
  lastCheckedAt: Schema.NullOr(Schema.Number),
  checkStatus: Schema.NullOr(CheckStatus),
  /** Cloudflare's zone status at the last recheck (`active`, `pending`, `moved`, …); null without a zone token. */
  zoneStatus: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const MailboxKindSchema = Schema.Literals(["user", "shared", "group", "alias", "catch_all"])

export const DomainDetailSchema = Schema.Struct({
  ...DomainSummarySchema.fields,
  /** The zone the domain lives in (itself or a parent). From public DNS, or the zone token. */
  zoneName: Schema.NullOr(Schema.String),
  /** The nameservers Cloudflare assigned; null without CLOUDFLARE_DNS_TOKEN. */
  nameservers: Schema.NullOr(Schema.Array(Schema.String)),
  /** What public DNS answers now; differs from `nameservers` while a move is pending. */
  currentNameservers: Schema.NullOr(Schema.Array(Schema.String)),
  registrar: Schema.NullOr(Schema.String),
  /** DNSSEC status (`active`, `pending`, `disabled`). */
  dnssec: Schema.NullOr(Schema.String),
  /** Complaints Email Sending counted in the last 30 days. */
  complaints30d: Schema.NullOr(Schema.Number),
  /** The bounce (return-path) domain mail is sent with. */
  returnPath: Schema.NullOr(Schema.String),
  /** When the zone fields were read: the last recheck. */
  zoneCheckedAt: Schema.NullOr(Schema.Number),
  checks: Schema.Array(RecordCheckSchema),
  expectedRecords: Schema.Array(
    Schema.Struct({
      purpose: Schema.String,
      type: Schema.Literals(["MX", "TXT", "CNAME"]),
      name: Schema.String,
      value: Schema.String,
    }),
  ),
  mailboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      address: Schema.String,
      kind: MailboxKindSchema,
      displayName: Schema.NullOr(Schema.String),
    }),
  ),
})

const SignatureSchema = Schema.Struct({ text: Schema.String, html: Schema.NullOr(Schema.String) })
const AutoReplySchema = Schema.Struct({
  enabled: Schema.Boolean,
  subject: Schema.String.check(Schema.isMaxLength(998)),
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  startsAt: Schema.NullOr(Schema.Number),
  endsAt: Schema.NullOr(Schema.Number),
})
const ForwardingSchema = Schema.Struct({
  enabled: Schema.Boolean,
  to: Schema.Array(Schema.String),
  keepCopy: Schema.Boolean,
})
const MemberRoleSchema = Schema.Literals(["owner", "member", "viewer"])

export const MailboxSummarySchema = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  domainId: Schema.String,
  kind: MailboxKindSchema,
  displayName: Schema.NullOr(Schema.String),
  holdsMail: Schema.Boolean,
  targetIds: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const MailboxDetailSchema = Schema.Struct({
  ...MailboxSummarySchema.fields,
  targets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      address: Schema.NullOr(Schema.String),
      kind: Schema.NullOr(MailboxKindSchema),
    }),
  ),
  signature: Schema.NullOr(SignatureSchema),
  autoReply: Schema.NullOr(AutoReplySchema),
  forwarding: Schema.NullOr(ForwardingSchema),
  spamThreshold: Schema.Number.annotate({
    description: "Spam points at or above which mail is filed as spam.",
  }),
  spamThresholdIsDefault: Schema.Boolean,
  members: Schema.Array(
    Schema.Struct({
      apiKeyId: Schema.String,
      name: Schema.String,
      role: MemberRoleSchema,
      revoked: Schema.Boolean,
    }),
  ),
  /** People given this mailbox (HAL-3361): their access in it, and their role in the workspace. */
  people: Schema.Array(
    Schema.Struct({
      memberId: Schema.String,
      name: Schema.String,
      email: Schema.String,
      access: MemberRoleSchema,
      role: Schema.Literals(["owner", "admin", "sender", "agent", "viewer"]),
    }),
  ),
  /** Messages held; null for aliases and groups, which hold none. */
  messageCount: Schema.NullOr(Schema.Number),
  lastExport: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["pending", "running", "complete", "failed"]),
      format: Schema.Literals(["mbox", "eml-zip", "both"]),
      messageCount: Schema.Number,
      size: Schema.Number,
      createdAt: Schema.Number,
      completedAt: Schema.NullOr(Schema.Number),
    }),
  ),
})

export class DomainsApi extends HttpApiGroup.make("domains")
  .add(
    HttpApiEndpoint.get("list", "/v1/domains", {
      success: Schema.Struct({ domains: Schema.Array(DomainSummarySchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/domains", {
      payload: Schema.Struct({
        name: Schema.String,
        receiving: Schema.optionalKey(Schema.Boolean),
        sending: Schema.optionalKey(Schema.Boolean),
        catchAll: Schema.optionalKey(CatchAll),
        zoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: DomainDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("candidates", "/v1/domains/candidates", {
      success: Schema.Struct({
        /** False without CLOUDFLARE_DNS_TOKEN (or when it can't list zones); `candidates` is then empty. */
        connected: Schema.Boolean,
        candidates: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            zoneId: Schema.String,
            zoneStatus: Schema.String,
            nameservers: Schema.Array(Schema.String),
            registrar: Schema.NullOr(Schema.String),
            /** The zone, or a subdomain of it, is already a workspace domain. */
            inWorkspace: Schema.Boolean,
            workspaceDomains: Schema.Array(Schema.String),
            /** The zone apex's MX today: who receives its mail now. */
            existingMx: Schema.Array(Schema.String),
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/domains/:id", {
      params: { id: Schema.String },
      success: DomainDetailSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/domains/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        receiving: Schema.optionalKey(Schema.Boolean),
        sending: Schema.optionalKey(Schema.Boolean),
        catchAll: Schema.optionalKey(CatchAll),
        zoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: DomainDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/domains/:id", {
      params: { id: Schema.String },
      success: DomainSummarySchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("recheck", "/v1/domains/:id/recheck", {
      params: { id: Schema.String },
      success: DomainDetailSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("fix", "/v1/domains/:id/fix", {
      params: { id: Schema.String },
      success: Schema.Struct({
        domain: DomainDetailSchema,
        actions: Schema.Array(
          Schema.Struct({
            checks: Schema.Array(Schema.String),
            action: Schema.Literals(["enable_routing", "fix_sending", "add_dmarc", "manual"]),
            ok: Schema.Boolean,
            detail: Schema.String,
          }),
        ),
      }),
      /** 409 with `reason`: `no_dns_token`, `zone_not_found` or `nothing_to_fix`. */
      error: [Forbidden, NotFound, FixRefused],
    }),
  )
  .middleware(ApiKeyAuth) {}

const MailboxSettings = {
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  signature: Schema.optionalKey(Schema.NullOr(SignatureSchema)),
  autoReply: Schema.optionalKey(Schema.NullOr(AutoReplySchema)),
  forwarding: Schema.optionalKey(Schema.NullOr(ForwardingSchema)),
  spamThreshold: Schema.optionalKey(
    Schema.NullOr(Schema.Number).annotate({
      description: "1 to 20 points; null goes back to the default (5).",
    }),
  ),
}

export class MailboxesApi extends HttpApiGroup.make("mailboxes")
  .add(
    HttpApiEndpoint.get("list", "/v1/mailboxes", {
      query: { domainId: Schema.optionalKey(Schema.String), kind: Schema.optionalKey(MailboxKindSchema) },
      success: Schema.Struct({ mailboxes: Schema.Array(MailboxSummarySchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/mailboxes", {
      payload: Schema.Struct({
        address: Schema.String,
        kind: MailboxKindSchema,
        targets: Schema.optionalKey(Schema.Array(Schema.String)),
        ...MailboxSettings,
        /**
         * When Cloudflare already routes this address elsewhere (a forward, a drop, another Worker),
         * the create answers 409 `reason: "routing-rule-exists"` with `ruleDestination`; true repoints
         * that rule at Mailyard instead. Needs the zone token (CLOUDFLARE_DNS_TOKEN) with Email
         * Routing Rules: Edit.
         */
        replaceRoutingRule: Schema.optionalKey(Schema.Boolean),
      }),
      success: Schema.Struct({
        ...MailboxDetailSchema.fields,
        /**
         * What the routing check found: `clear` (nothing else claims the address), `replaced` (a rule
         * was repointed here) or `unchecked` (no zone token, or a catch-all, which no rule shadows).
         */
        routing: Schema.Literals(["clear", "replaced", "unchecked"]),
      }),
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("get", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        targets: Schema.optionalKey(Schema.Array(Schema.String)),
        ...MailboxSettings,
      }),
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.put("setMembers", "/v1/mailboxes/:id/members", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** Keys (`{ apiKeyId, role }`) and people (`{ memberId, access }`, HAL-3361); both lists are
         * replaced. */
        members: Schema.Array(
          Schema.Union([
            Schema.Struct({ apiKeyId: Schema.String, role: MemberRoleSchema }),
            Schema.Struct({ memberId: Schema.String, access: MemberRoleSchema }),
          ]),
        ),
      }),
      success: MailboxDetailSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/mailboxes/:id", {
      params: { id: Schema.String },
      success: MailboxSummarySchema,
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class IdentitiesApi extends HttpApiGroup.make("identities")
  .add(
    HttpApiEndpoint.get("list", "/v1/identities", {
      success: Schema.Struct({
        identities: Schema.Array(
          Schema.Struct({
            address: Schema.String,
            displayName: Schema.NullOr(Schema.String),
            mailboxId: Schema.String,
            kind: MailboxKindSchema,
            via: Schema.Literals(["admin", "member", "alias"]),
            signature: Schema.NullOr(
              Schema.Struct({ text: Schema.String, html: Schema.NullOr(Schema.String) }),
            ).annotate({
              description:
                "The signature to start a message from this address with: its own, or for an alias its mailbox's.",
            }),
          }),
        ),
        /** Domains on which this key may send as any address (root and admin keys). */
        anyAddressOn: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Mail: folders, threads, messages, labels, drafts and sending (docs/email-ui.html: Mail)
// ---------------------------------------------------------------------------------------------

const FolderSchema = Schema.Literals(["inbox", "archive", "sent", "spam", "trash", "snoozed"])
const PartySchema = Schema.Struct({ name: Schema.NullOr(Schema.String), address: Schema.String })
const AuthVerdictSchema = Schema.NullOr(Schema.String)

export const ThreadSchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  snippet: Schema.String,
  latestMessageId: Schema.String,
  messageCount: Schema.Number,
  unreadCount: Schema.Number,
  starred: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  participants: Schema.Array(PartySchema),
  folders: Schema.Array(FolderSchema),
  labelIds: Schema.Array(Schema.String),
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  sortAt: Schema.Number,
  snoozedUntil: Schema.NullOr(Schema.Number),
  assignee: Schema.NullOr(Schema.String).annotate({
    description: "The API key id handling it; see assignedTo for the name.",
  }),
  assignedTo: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })).annotate({
      description: "Who is handling it, with a name to show: the key's name until people exist (HAL-3361).",
    }),
  ),
  scheduledSendAt: Schema.optionalKey(
    Schema.NullOr(Schema.Number).annotate({
      description: "The earliest scheduled send of a reply in this conversation.",
    }),
  ),
  spamScore: Schema.optionalKey(
    Schema.NullOr(Schema.Number).annotate({
      description: "The highest spam score of its messages in spam; only when listing spam.",
    }),
  ),
})

const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  filename: Schema.NullOr(Schema.String),
  mimeType: Schema.String,
  disposition: Schema.NullOr(Schema.String),
  contentId: Schema.NullOr(Schema.String),
  related: Schema.Boolean,
  size: Schema.Number,
  sha256: Schema.String,
})

export const MessageSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  folder: FolderSchema,
  seen: Schema.Boolean,
  starred: Schema.Boolean,
  answered: Schema.Boolean,
  labelIds: Schema.Array(Schema.String),
  receivedAt: Schema.Number,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  via: Schema.String,
  tag: Schema.NullOr(Schema.String),
  size: Schema.Number,
  messageId: Schema.NullOr(Schema.String),
  inReplyTo: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  subject: Schema.String,
  date: Schema.NullOr(Schema.Number),
  from: Schema.NullOr(PartySchema),
  replyTo: Schema.Array(PartySchema),
  to: Schema.Array(PartySchema),
  cc: Schema.Array(PartySchema),
  snippet: Schema.String,
  hasHtml: Schema.Boolean,
  automated: Schema.Boolean,
  listId: Schema.NullOr(Schema.String),
  listUnsubscribe: Schema.NullOr(Schema.String),
  auth: Schema.Struct({
    source: Schema.String,
    spf: AuthVerdictSchema,
    dmarc: AuthVerdictSchema,
    dkim: Schema.Array(
      Schema.Struct({
        result: Schema.String,
        domain: Schema.NullOr(Schema.String),
        selector: Schema.NullOr(Schema.String),
      }),
    ),
    arc: Schema.NullOr(
      Schema.Struct({
        result: Schema.String,
        instance: Schema.NullOr(Schema.Number),
        sealer: Schema.NullOr(Schema.String).annotate({
          description: "The domain that sealed the newest ARC hop (d=).",
        }),
      }),
    ).annotate({ description: "The ARC chain from the newest ARC-Seal; null when the mail carried none." }),
  }),
  attachments: Schema.Array(AttachmentSchema),
  /** The spam check's score at delivery and its reasons; null for mail this mailbox sent. */
  spamScore: Schema.NullOr(Schema.Number),
  spamReasons: Schema.Array(Schema.Struct({ rule: Schema.String, points: Schema.Number })),
  rulesMatched: Schema.Array(Schema.String),
})

export const MessageDetailSchema = Schema.Struct({
  ...MessageSchema.fields,
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })).annotate({
      description: "With ?include=headers: every header in the order it arrived, newest hop first.",
    }),
  ),
  body: Schema.Struct({ text: Schema.String, html: Schema.NullOr(Schema.String) }),
  /** Signed links that work without a key for an hour: for <img> tags and download buttons. */
  rawUrl: Schema.String,
  attachmentUrls: Schema.Record(Schema.String, Schema.String),
  /**
   * For a message this mailbox sent: how its delivery went, and its opens and clicks when the sender
   * asked for tracking. Null for received mail.
   */
  delivery: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        messageId: Schema.String,
        status: Schema.String,
        tracked: Schema.Boolean,
        opens: Schema.Number,
        clicks: Schema.Number,
        machineOpens: Schema.Number,
        machineClicks: Schema.Number,
        firstOpenedAt: Schema.NullOr(Schema.Number),
        firstClickedAt: Schema.NullOr(Schema.Number),
        recipients: Schema.Array(
          Schema.Struct({
            recipient: Schema.String,
            kind: Schema.Literals(["to", "cc", "bcc"]),
            status: Schema.Literals([
              "queued",
              "sent",
              "delivered",
              "deferred",
              "bounced",
              "failed",
              "rejected",
              "complained",
              "suppressed",
            ]),
            at: Schema.Number,
            attempts: Schema.Number.annotate({
              description: "Deferrals so far: each is Email Service trying again.",
            }),
            smtpResponse: Schema.NullOr(Schema.String),
          }),
        ).annotate({
          description:
            "Each recipient's own delivery, moved by its delivery events and pushed as delivery.changed on the live socket. Empty for mail sent before it was recorded.",
        }),
      }),
    ),
  ),
})

const DraftAttachmentSchema = Schema.Struct({
  key: Schema.String.annotate({ description: "The `key` POST /v1/mailboxes/{id}/uploads answered with." }),
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  delivery: Schema.optionalKey(
    Schema.Literals(["inline", "link"]).annotate({
      description:
        "How it would go if sent now: in the message, or as an expiring link because the message would pass Email Service's 5 MiB. Read-only; ignored on input.",
    }),
  ),
})
const ReplyModeSchema = Schema.Literals(["reply", "replyAll", "forward"])

export const DraftSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  inReplyTo: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.Array(PartySchema),
  cc: Schema.Array(PartySchema),
  bcc: Schema.Array(PartySchema),
  subject: Schema.String,
  bodyText: Schema.String,
  bodyHtml: Schema.NullOr(Schema.String),
  attachments: Schema.Array(DraftAttachmentSchema),
  status: Schema.Literals(["draft", "scheduled", "due"]),
  sendAt: Schema.NullOr(Schema.Number),
  replyMode: Schema.NullOr(ReplyModeSchema),
  sourceMessageId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  blockedReason: Schema.NullOr(
    Schema.Literals(["quota_exhausted", "domain_unhealthy", "all_recipients_suppressed"]),
  ).annotate({
    description:
      "Why the last send was refused before it went out, as SendBlocked's reason; cleared when the draft is edited.",
  }),
  /** Opens and clicks tracked on this send, when the sender asked; null otherwise. */
  track: Schema.NullOr(Schema.Struct({ opens: Schema.Boolean, clicks: Schema.Boolean })),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const LabelColorSchema = Schema.Literals(LABEL_COLORS).annotate({
  description: "A name from the label palette, drawn from the design tokens in either theme.",
})

export const LabelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(LabelColorSchema),
  threads: Schema.Number,
  unreadThreads: Schema.Number,
  createdAt: Schema.Number,
})

const FolderCountSchema = Schema.Struct({
  folder: Schema.Literals(["inbox", "archive", "sent", "spam", "trash", "snoozed", "drafts"]),
  threads: Schema.Number,
  unreadThreads: Schema.Number,
})

const PartyInput = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  address: Schema.String,
})

const DraftFields = {
  from: Schema.optionalKey(Schema.NullOr(Schema.String)),
  to: Schema.optionalKey(Schema.Array(PartyInput)),
  cc: Schema.optionalKey(Schema.Array(PartyInput)),
  bcc: Schema.optionalKey(Schema.Array(PartyInput)),
  subject: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(998))),
  bodyText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000_000))),
  bodyHtml: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000)))),
  attachments: Schema.optionalKey(Schema.Array(DraftAttachmentSchema)),
}

export const BULK_ACTIONS = [
  "archive",
  "inbox",
  "trash",
  "delete",
  "spam",
  "notSpam",
  "read",
  "unread",
  "star",
  "unstar",
  "label",
  "unlabel",
  "move",
  "snooze",
  "unsnooze",
  "assign",
] as const

const MailboxParam = { id: Schema.String }
const Limit = Schema.optionalKey(
  Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
)
const MailErrors = [Forbidden, NotFound, InvalidRequest, Conflict] as const

export const CreateDraftPayload = Schema.Struct({
  /** Start from a message in this mailbox: a reply, a reply to all, or a forward. */
  replyTo: Schema.optionalKey(Schema.Struct({ messageId: Schema.String, mode: ReplyModeSchema })),
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ...DraftFields,
})
export type CreateDraftPayload = typeof CreateDraftPayload.Type

const NoteSchema = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  createdAt: Schema.Number,
})

const SmartFolderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  q: Schema.String.annotate({ description: "The search it saves; open it with GET …/search?q=." }),
  createdAt: Schema.Number,
})

export class MailApiGroup extends HttpApiGroup.make("mail")
  .add(
    HttpApiEndpoint.get("folders", "/v1/mailboxes/:id/folders", {
      params: MailboxParam,
      success: Schema.Struct({
        folders: Schema.Array(FolderCountSchema),
        labels: Schema.Array(LabelSchema),
        smartFolders: Schema.Array(SmartFolderSchema),
        views: Schema.Struct({
          starred: Schema.Number,
          assignedToMe: Schema.Number.annotate({ description: "Conversations assigned to the calling key." }),
          scheduled: Schema.Number.annotate({ description: "Drafts scheduled to send." }),
          all: Schema.Struct({ threads: Schema.Number, unreadThreads: Schema.Number }),
        }).annotate({
          description: "The views beside the folders: Starred, Assigned to me, Scheduled, All mail.",
        }),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("emptyFolder", "/v1/mailboxes/:id/folders/:folder/empty", {
      params: { id: Schema.String, folder: Schema.Literals(["trash", "spam"]) },
      success: Schema.Struct({ purged: Schema.Number }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("threads", "/v1/mailboxes/:id/threads", {
      params: MailboxParam,
      query: {
        folder: Schema.optionalKey(
          Schema.Union([FolderSchema, Schema.Literal("all")]).annotate({
            description: "A folder, or all: every folder but spam and trash (All mail).",
          }),
        ),
        labelId: Schema.optionalKey(Schema.String),
        unread: Schema.optionalKey(Schema.Literals(["true", "false"])),
        starred: Schema.optionalKey(Schema.Literals(["true", "false"])),
        assignee: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        threads: Schema.Array(ThreadSchema),
        total: Schema.NullOr(Schema.Number).annotate({
          description:
            "Conversations in the whole list, when it's a plain folder (no other filter); null otherwise.",
        }),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("thread", "/v1/mailboxes/:id/threads/:threadId", {
      params: { id: Schema.String, threadId: Schema.String },
      success: Schema.Struct({
        thread: ThreadSchema,
        messages: Schema.Array(MessageSchema),
        drafts: Schema.Array(DraftSchema),
        notes: Schema.Array(NoteSchema).annotate({ description: "Internal notes for the team; never sent." }),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("addNote", "/v1/mailboxes/:id/threads/:threadId/notes", {
      params: { id: Schema.String, threadId: Schema.String },
      payload: Schema.Struct({
        body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
      }),
      success: NoteSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteNote", "/v1/mailboxes/:id/notes/:noteId", {
      params: { id: Schema.String, noteId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("bulk", "/v1/mailboxes/:id/threads/bulk", {
      params: MailboxParam,
      payload: Schema.Struct({
        threadIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        action: Schema.Literals(BULK_ACTIONS),
        labelId: Schema.optionalKey(Schema.String),
        folder: Schema.optionalKey(FolderSchema),
        until: Schema.optionalKey(Schema.Number),
        assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: Schema.Struct({ updated: Schema.Number }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("search", "/v1/mailboxes/:id/search", {
      params: MailboxParam,
      query: {
        q: Schema.String.annotate({
          description:
            'Words (prefix matches), "phrases", and operators: from:, to:, cc:, subject:, body:, in:<folder>, label:, is:unread, is:starred, has:attachment, before:YYYY-MM-DD, after:YYYY-MM-DD (inclusive). Unknown operators are searched as words and listed in parsed.unsupported.',
        }),
        sort: Schema.optionalKey(Schema.Literals(["recent", "relevance"])),
        limit: Limit,
      },
      success: Schema.Struct({
        hits: Schema.Array(
          Schema.Struct({
            messageId: Schema.String,
            threadId: Schema.String,
            folder: FolderSchema,
            from: Schema.NullOr(PartySchema),
            receivedAt: Schema.Number,
            subject: Schema.String,
            subjectHighlighted: Schema.String.annotate({
              description: "The subject with matches wrapped in U+0002 … U+0003, as excerpt is.",
            }),
            excerpt: Schema.String,
            rank: Schema.Number,
          }),
        ),
        threads: Schema.Array(ThreadSchema),
        parsed: Schema.Struct({
          operators: Schema.Array(Schema.Struct({ op: Schema.String, value: Schema.String })),
          terms: Schema.Array(Schema.String),
          unsupported: Schema.Array(Schema.Struct({ op: Schema.String, value: Schema.String })),
        }).annotate({
          description: "What the query was understood as, for the search bar to show as chips.",
        }),
        sort: Schema.Literals(["recent", "relevance"]),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("smartFolders", "/v1/mailboxes/:id/smart-folders", {
      params: MailboxParam,
      success: Schema.Struct({ smartFolders: Schema.Array(SmartFolderSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createSmartFolder", "/v1/mailboxes/:id/smart-folders", {
      params: MailboxParam,
      payload: Schema.Struct({ name: Schema.String, q: Schema.String }),
      success: SmartFolderSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateSmartFolder", "/v1/mailboxes/:id/smart-folders/:folderId", {
      params: { id: Schema.String, folderId: Schema.String },
      payload: Schema.Struct({ name: Schema.String, q: Schema.String }),
      success: SmartFolderSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteSmartFolder", "/v1/mailboxes/:id/smart-folders/:folderId", {
      params: { id: Schema.String, folderId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("message", "/v1/mailboxes/:id/messages/:messageId", {
      params: { id: Schema.String, messageId: Schema.String },
      query: {
        include: Schema.optionalKey(
          Schema.Literal("headers").annotate({ description: "headers: also return every header, in order." }),
        ),
      },
      success: MessageDetailSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateMessage", "/v1/mailboxes/:id/messages/:messageId", {
      params: { id: Schema.String, messageId: Schema.String },
      payload: Schema.Struct({
        seen: Schema.optionalKey(Schema.Boolean),
        starred: Schema.optionalKey(Schema.Boolean),
        folder: Schema.optionalKey(FolderSchema),
        addLabels: Schema.optionalKey(Schema.Array(Schema.String)),
        removeLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      success: MessageSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("labels", "/v1/mailboxes/:id/labels", {
      params: MailboxParam,
      success: Schema.Struct({ labels: Schema.Array(LabelSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createLabel", "/v1/mailboxes/:id/labels", {
      params: MailboxParam,
      payload: Schema.Struct({
        name: Schema.String,
        color: Schema.optionalKey(Schema.NullOr(LabelColorSchema)),
      }),
      success: LabelSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateLabel", "/v1/mailboxes/:id/labels/:labelId", {
      params: { id: Schema.String, labelId: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        color: Schema.optionalKey(Schema.NullOr(LabelColorSchema)),
      }),
      success: LabelSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteLabel", "/v1/mailboxes/:id/labels/:labelId", {
      params: { id: Schema.String, labelId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("drafts", "/v1/mailboxes/:id/drafts", {
      params: MailboxParam,
      query: { status: Schema.optionalKey(Schema.Literals(["draft", "scheduled", "due"])), limit: Limit },
      success: Schema.Struct({ drafts: Schema.Array(DraftSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("correspondents", "/v1/mailboxes/:id/correspondents", {
      params: MailboxParam,
      query: {
        q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        ),
      },
      success: Schema.Struct({
        correspondents: Schema.Array(
          Schema.Struct({
            address: Schema.String,
            name: Schema.NullOr(Schema.String),
            received: Schema.Number,
            sent: Schema.Number,
            lastAt: Schema.Number,
          }),
        ),
      }).annotate({
        description:
          "People this mailbox has heard from or written to whose address or name starts with q, most recent first: the composer's To field.",
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createDraft", "/v1/mailboxes/:id/drafts", {
      params: MailboxParam,
      headers: IdempotencyHeader,
      payload: CreateDraftPayload,
      success: DraftSchema,
      error: [...MailErrors, IdempotencyConflict],
    }),
    HttpApiEndpoint.get("draft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      success: DraftSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("updateDraft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      payload: Schema.Struct(DraftFields),
      success: DraftSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("deleteDraft", "/v1/mailboxes/:id/drafts/:draftId", {
      params: { id: Schema.String, draftId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("send", "/v1/mailboxes/:id/drafts/:draftId/send", {
      params: { id: Schema.String, draftId: Schema.String },
      headers: IdempotencyHeader,
      payload: Schema.Struct({
        sendAt: Schema.optionalKey(Schema.Number),
        /** How long the send can be undone, when it goes now: 0 to 30 s, else the account's default. */
        undoSeconds: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
        /** Track opens and clicks on this message only. Off unless asked, replies included. */
        track: Schema.optionalKey(
          Schema.Struct({
            opens: Schema.optionalKey(Schema.Boolean),
            clicks: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      }),
      success: Schema.Struct({
        draft: DraftSchema,
        /** When it goes; null while it waits for approval. */
        sendAt: Schema.NullOr(Schema.Number),
        undoUntil: Schema.NullOr(Schema.Number),
        /** Set when the key's limits hold its sends for a person's yes (HAL-3460). */
        approval: Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.Literal("pending") })),
      }),
      error: [...MailErrors, IdempotencyConflict, SendBlocked],
    }),
    HttpApiEndpoint.post("cancelSend", "/v1/mailboxes/:id/drafts/:draftId/cancel", {
      params: { id: Schema.String, draftId: Schema.String },
      success: DraftSchema,
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Inbox rules and sender lists (docs/email-ui.html: Rules)
// ---------------------------------------------------------------------------------------------

export const RuleSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  match: Schema.Literals(["all", "any"]),
  conditions: Schema.Array(RuleCondition),
  actions: Schema.Array(RuleAction),
  stop: Schema.Boolean,
  position: Schema.Number,
  matchCount: Schema.Number.annotate({
    description: "Messages it matched as they arrived; an apply run doesn't count.",
  }),
  lastMatchedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const SpamReasonSchema = Schema.Struct({ rule: Schema.String, points: Schema.Number })
const RuleOutcomeSchema = Schema.Struct({
  matched: Schema.Array(Schema.String),
  folder: Schema.NullOr(Schema.Literals(["archive", "trash", "spam"])),
  labelIds: Schema.Array(Schema.String),
  markRead: Schema.Boolean,
  star: Schema.Boolean,
  skipSpamCheck: Schema.Boolean,
  forwards: Schema.Array(Schema.Struct({ ruleId: Schema.String, to: Schema.Array(Schema.String) })),
  autoReplies: Schema.Array(
    Schema.Struct({ ruleId: Schema.String, subject: Schema.String, body: Schema.String }),
  ),
  webhooks: Schema.Array(Schema.Struct({ ruleId: Schema.String, endpointId: Schema.String })),
  assignee: Schema.NullOr(Schema.String),
  stoppedAt: Schema.NullOr(Schema.String).annotate({
    description: "The rule that stopped the ones after it.",
  }),
})

const SenderSchema = Schema.Struct({
  value: Schema.String,
  list: Schema.Literals(["allow", "block"]),
  source: Schema.Literals(["user", "not_spam", "spam"]),
  createdAt: Schema.optionalKey(Schema.Number),
})

const RuleFields = {
  name: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  match: Schema.optionalKey(Schema.Literals(["all", "any"])),
  conditions: Schema.Array(RuleCondition),
  actions: Schema.Array(RuleAction),
  stop: Schema.optionalKey(Schema.Boolean),
}

export class RulesApi extends HttpApiGroup.make("rules")
  .add(
    HttpApiEndpoint.get("list", "/v1/mailboxes/:id/rules", {
      params: { id: Schema.String },
      success: Schema.Struct({ rules: Schema.Array(RuleSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("create", "/v1/mailboxes/:id/rules", {
      params: { id: Schema.String },
      payload: Schema.Struct(RuleFields),
      success: RuleSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.patch("update", "/v1/mailboxes/:id/rules/:ruleId", {
      params: { id: Schema.String, ruleId: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        enabled: Schema.optionalKey(Schema.Boolean),
        match: Schema.optionalKey(Schema.Literals(["all", "any"])),
        conditions: Schema.optionalKey(Schema.Array(RuleCondition)),
        actions: Schema.optionalKey(Schema.Array(RuleAction)),
        stop: Schema.optionalKey(Schema.Boolean),
      }),
      success: RuleSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("remove", "/v1/mailboxes/:id/rules/:ruleId", {
      params: { id: Schema.String, ruleId: Schema.String },
      success: Schema.Struct({ deleted: Schema.String }),
      error: MailErrors,
    }),
    HttpApiEndpoint.put("reorder", "/v1/mailboxes/:id/rules/order", {
      params: { id: Schema.String },
      payload: Schema.Struct({ ruleIds: Schema.Array(Schema.String) }),
      success: Schema.Struct({ rules: Schema.Array(RuleSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("test", "/v1/mailboxes/:id/rules/test", {
      params: { id: Schema.String },
      payload: Schema.Struct({ messageId: Schema.String }),
      success: Schema.Struct({
        matched: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
        outcome: RuleOutcomeSchema,
        authScore: Schema.Struct({ score: Schema.Number, reasons: Schema.Array(SpamReasonSchema) }),
        filedWith: Schema.Struct({
          folder: Schema.String,
          spamScore: Schema.NullOr(Schema.Number),
          spamReasons: Schema.Array(SpamReasonSchema),
          rulesMatched: Schema.Array(Schema.String),
        }).annotate({ description: "How the message was actually filed when it arrived." }),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("apply", "/v1/mailboxes/:id/rules/:ruleId/apply", {
      params: { id: Schema.String, ruleId: Schema.String },
      payload: Schema.Struct({
        folder: Schema.optionalKey(
          Schema.Literals(["inbox", "archive", "sent", "trash", "spam", "snoozed"]).annotate({
            description: "Only mail in this folder; by default everything but trash, spam and sent.",
          }),
        ),
        cursor: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
      }),
      success: Schema.Struct({
        examined: Schema.Number,
        matched: Schema.Number,
        changed: Schema.Number,
        skippedActions: Schema.Array(Schema.String).annotate({
          description:
            "Actions that only run as mail arrives (forward, autoReply, webhook): applying a rule never sends.",
        }),
        nextCursor: Schema.NullOr(Schema.String).annotate({
          description: "Call again with it to go on to older mail.",
        }),
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("senders", "/v1/mailboxes/:id/senders", {
      params: { id: Schema.String },
      query: { list: Schema.optionalKey(Schema.Literals(["allow", "block"])) },
      success: Schema.Struct({ senders: Schema.Array(SenderSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("addSender", "/v1/mailboxes/:id/senders", {
      params: { id: Schema.String },
      payload: Schema.Struct({ value: Schema.String, list: Schema.Literals(["allow", "block"]) }),
      success: SenderSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.delete("removeSender", "/v1/mailboxes/:id/senders/:value", {
      params: { id: Schema.String, value: Schema.String },
      success: Schema.Struct({ removed: Schema.String }),
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Imports and exports (docs/email-ui.html: Import mailbox, Export)
// ---------------------------------------------------------------------------------------------

const ImportFolderSchema = Schema.Struct({
  name: Schema.String,
  folder: Schema.String,
  label: Schema.NullOr(Schema.String),
  uidValidity: Schema.NullOr(Schema.Number),
  source: Schema.Number,
  imported: Schema.Number,
  duplicates: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.optionalKey(Schema.Number),
  lastUid: Schema.Number,
  batches: Schema.Number,
  batchesDone: Schema.Number,
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Why the latest failure in this folder failed.",
  }),
  retryable: Schema.Number.annotate({
    description: "Failed messages POST …/retry-failed can fetch again (IMAP).",
  }),
})

export const ImportSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["imap", "mbox"]),
  mode: Schema.Literals(["full", "catchup"]),
  host: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  username: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "running", "paused", "complete", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  folders: Schema.Array(ImportFolderSchema),
  totals: Schema.Struct({
    source: Schema.Number,
    imported: Schema.Number,
    duplicates: Schema.Number,
    failed: Schema.Number,
    skipped: Schema.Number,
  }),
  accountedFor: Schema.Boolean,
  ratePerMinute: Schema.NullOr(Schema.Number).annotate({
    description:
      "Messages a minute since it started moving, paused time left out; null for its first minute.",
  }),
  etaAt: Schema.NullOr(Schema.Number).annotate({
    description: "When it should finish at that rate; null unless running.",
  }),
  startedAt: Schema.NullOr(Schema.Number),
  pausedAt: Schema.NullOr(Schema.Number),
  catchupOf: Schema.NullOr(Schema.String).annotate({
    description: "A catch-up: the import it continues from.",
  }),
  since: Schema.NullOr(Schema.Number).annotate({
    description: "A catch-up: when that import finished, what it fetches after.",
  }),
  retryOf: Schema.NullOr(Schema.String).annotate({
    description: "A retry: the import whose failed messages it fetches.",
  }),
  credentialsHeld: Schema.Boolean,
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

export const ExportSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pending", "running", "complete", "failed"]),
  format: Schema.Literals(["mbox", "eml-zip", "both"]),
  messageCount: Schema.Number,
  size: Schema.Number,
  zipSize: Schema.Number,
  error: Schema.NullOr(Schema.String),
  /** Signed links valid for a week; null until the export is complete. */
  downloads: Schema.Struct({ mbox: Schema.NullOr(Schema.String), zip: Schema.NullOr(Schema.String) }),
  downloadsExpireAt: Schema.NullOr(Schema.Number).annotate({
    description:
      "When these download links stop working (a week); every read of the export signs a fresh pair.",
  }),
  createdAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
})

export class TransfersApi extends HttpApiGroup.make("transfers")
  .add(
    HttpApiEndpoint.post("createImport", "/v1/mailboxes/:id/imports", {
      params: { id: Schema.String },
      payload: Schema.Union([
        Schema.Struct({
          source: Schema.Literal("imap"),
          host: Schema.String,
          port: Schema.optionalKey(Schema.Number),
          username: Schema.String,
          password: Schema.String,
          folders: Schema.optionalKey(Schema.Array(Schema.String)),
          mode: Schema.optionalKey(Schema.Literals(["full", "catchup"])),
        }),
        Schema.Struct({
          source: Schema.Literal("mbox"),
          uploadKey: Schema.optionalKey(Schema.String),
          exportId: Schema.optionalKey(Schema.String),
        }),
      ]),
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("imports", "/v1/mailboxes/:id/imports", {
      params: { id: Schema.String },
      success: Schema.Struct({ imports: Schema.Array(ImportSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("import", "/v1/mailboxes/:id/imports/:importId", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("cancelImport", "/v1/mailboxes/:id/imports/:importId/cancel", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("pauseImport", "/v1/mailboxes/:id/imports/:importId/pause", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("resumeImport", "/v1/mailboxes/:id/imports/:importId/resume", {
      params: { id: Schema.String, importId: Schema.String },
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("retryFailed", "/v1/mailboxes/:id/imports/:importId/retry-failed", {
      params: { id: Schema.String, importId: Schema.String },
      payload: Schema.Struct({
        password: Schema.String.annotate({
          description: "The source password again: the first import's was wiped when it ended.",
        }),
      }),
      success: ImportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.post("probeImport", "/v1/mailboxes/:id/imports/probe", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        host: Schema.String,
        port: Schema.optionalKey(Schema.Number),
        username: Schema.String,
        password: Schema.String,
      }),
      success: Schema.Struct({
        host: Schema.String,
        port: Schema.Number,
        folders: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            messages: Schema.NullOr(Schema.Number),
            folder: Schema.NullOr(Schema.String).annotate({
              description: "Where it would land; null when skipped.",
            }),
            label: Schema.NullOr(Schema.String),
            skipped: Schema.Boolean,
            skipReason: Schema.NullOr(Schema.String),
          }),
        ),
      }).annotate({
        description: "The account's folders before importing. The password is used for this connection only.",
      }),
      error: MailErrors,
    }),
    HttpApiEndpoint.post("createExport", "/v1/mailboxes/:id/exports", {
      params: { id: Schema.String },
      success: ExportSchema,
      error: MailErrors,
    }),
    HttpApiEndpoint.get("exports", "/v1/mailboxes/:id/exports", {
      params: { id: Schema.String },
      success: Schema.Struct({ exports: Schema.Array(ExportSchema) }),
      error: MailErrors,
    }),
    HttpApiEndpoint.get("export", "/v1/mailboxes/:id/exports/:exportId", {
      params: { id: Schema.String, exportId: Schema.String },
      success: ExportSchema,
      error: MailErrors,
    }),
  )
  .middleware(ApiKeyAuth) {}

/** Mailyard's HTTP API. The UI contract (docs/plans/email-ui.html#contract) grows here, group by group. */
// Audience: contacts, topics and signup forms (docs/email-ui.html: Contacts list, Contact detail)

const ContactStatusSchema = Schema.Literals([
  "subscribed",
  "unconfirmed",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
])
const SubscriptionStateSchema = Schema.Literals(["subscribed", "unconfirmed", "unsubscribed"])
const EngagementSchema = Schema.Literals(["active", "cooling", "dormant"])
/** One value, or several joined by commas (`subscribed,unconfirmed`): any of them matches. */
const commaList = (values: ReadonlyArray<string>) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(`^(${values.join("|")})(,(${values.join("|")}))*$`)),
  ).annotate({
    description: `One of ${values.join(", ")}, or several joined by commas (any matches).`,
  })
const StatusList = commaList([
  "subscribed",
  "unconfirmed",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
])
const EngagementList = commaList(["active", "cooling", "dormant"])
const Fields = Schema.Record(Schema.String, Schema.Unknown)

export const ContactSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  status: ContactStatusSchema,
  fields: Fields,
  topics: Schema.Array(
    Schema.Struct({
      topicId: Schema.String,
      name: Schema.String,
      state: SubscriptionStateSchema,
      /** When the state last changed, and how: form, import, api, unsubscribe link, one-click, admin. */
      changedAt: Schema.optionalKey(Schema.Number),
      source: Schema.optionalKey(Schema.String),
      /** The consent on record: when they confirmed (double opt-in) or were last subscribed. */
      confirmedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
  engagement: EngagementSchema,
  lastActivityAt: Schema.NullOr(Schema.Number),
  lastEventAt: Schema.NullOr(Schema.Number),
  lastOpenedAt: Schema.NullOr(Schema.Number),
  lastClickedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  /** On a single contact: why mail to them is held back, or null. Not on list rows. */
  suppression: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.Literals(["hard_bounce", "complaint", "unsubscribe", "manual"]),
        source: Schema.Literals(["cloudflare", "events", "manual", "import"]),
        detail: Schema.NullOr(Schema.String),
        /** The message whose bounce or complaint added it. */
        messageId: Schema.NullOr(Schema.String),
        /** Only bulk mail (campaigns, automations) is held back; transactional still goes. */
        bulkOnly: Schema.Boolean,
        createdAt: Schema.Number,
        cloudflare: Schema.Struct({
          synced: Schema.Boolean,
          id: Schema.NullOr(Schema.String),
          checkedAt: Schema.NullOr(Schema.Number),
        }),
      }),
    ),
  ),
})

const BulkFilterSchema = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(StatusList),
  topicId: Schema.optionalKey(Schema.String),
  engagement: Schema.optionalKey(EngagementList),
  segmentId: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  event: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})

const BulkJobSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["queued", "running", "done", "failed"]),
  action: Schema.Record(Schema.String, Schema.Unknown),
  filter: Schema.Record(Schema.String, Schema.Unknown),
  /** Matching contacts when the job was made. */
  total: Schema.Number,
  processed: Schema.Number,
  updated: Schema.Number,
  skipped: Schema.Number,
  /** The first 100. */
  errors: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

const ContactFieldSchema = Schema.Struct({
  key: Schema.String,
  /** What people read; the key until someone names it. */
  label: Schema.String,
  /** Inferred from the first value written, or set by hand. */
  type: Schema.Literals(["string", "number", "boolean", "date"]),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
  /** Segments whose rules read it, and automations that set or test it. */
  usedBy: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["segment", "automation"]),
      id: Schema.String,
      name: Schema.String,
    }),
  ),
})

const TimelineItemSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event"),
    id: Schema.String,
    at: Schema.Number,
    name: Schema.String,
    data: Schema.NullOr(Fields),
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    id: Schema.String,
    at: Schema.Number,
    stream: Schema.String,
    subject: Schema.String,
    status: Schema.String,
    bounceType: Schema.NullOr(Schema.String),
    campaignId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("subscription"),
    id: Schema.String,
    at: Schema.Number,
    topicId: Schema.String,
    topic: Schema.String,
    from: Schema.NullOr(SubscriptionStateSchema),
    to: SubscriptionStateSchema,
    source: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("delivery"),
    id: Schema.String,
    at: Schema.Number,
    /** delivered, deferred, bounced, failed, rejected, complained, opened, clicked, unsubscribed… */
    event: Schema.String,
    messageId: Schema.NullOr(Schema.String),
    subject: Schema.NullOr(Schema.String),
    data: Schema.NullOr(Fields),
  }),
  Schema.Struct({
    kind: Schema.Literal("consent"),
    id: Schema.String,
    at: Schema.Number,
    topicId: Schema.String,
    topic: Schema.String,
    source: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    id: Schema.String,
    at: Schema.Number,
    subject: Schema.NullOr(Schema.String),
    to: Schema.String,
    inReplyTo: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    id: Schema.String,
    at: Schema.Number,
    automationId: Schema.String,
    automation: Schema.NullOr(Schema.String),
    state: Schema.String,
    finishedAt: Schema.NullOr(Schema.Number),
  }),
])

export const TopicSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  doubleOptIn: Schema.Boolean,
  sender: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  subscribers: Schema.Number,
  createdAt: Schema.Number,
})

const FormFieldType = Schema.Literals(["text", "number", "date", "checkbox", "select", "tel", "url"])
const FormFieldDefSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: FormFieldType,
  required: Schema.Boolean,
  /** For `select`. */
  options: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A field definition in a request: everything but the key has a default (label from it, text, optional). */
const FormFieldDefInput = Schema.Struct({
  key: Schema.String,
  label: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(FormFieldType),
  required: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
})
const TopicChoice = Schema.Literals(["all", "pick"])

export const FormSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  topicIds: Schema.Array(Schema.String),
  /** `all`: a signup joins every topic. `pick`: the visitor ticks at least one of them. */
  topicChoice: TopicChoice,
  /** The custom fields' keys, in page order. */
  fields: Schema.Array(Schema.String),
  /** How each is asked: label, type, required, options. Older forms get optional text for each. */
  fieldDefs: Schema.Array(FormFieldDefSchema),
  redirectUrl: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  turnstileSiteKey: Schema.NullOr(Schema.String),
  /** On when the form has a site key; `configured` says whether this deploy can check it (TURNSTILE_SECRET). */
  turnstile: Schema.Struct({
    enabled: Schema.Boolean,
    siteKey: Schema.NullOr(Schema.String),
    configured: Schema.Boolean,
  }),
  archived: Schema.Boolean,
  createdAt: Schema.Number,
})

export class ContactsApi extends HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.get("list", "/v1/contacts", {
      query: {
        q: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(StatusList),
        topicId: Schema.optionalKey(Schema.String),
        engagement: Schema.optionalKey(EngagementList),
        /** A saved segment's rules. */
        segmentId: Schema.optionalKey(Schema.String),
        /** `key:op:value`, as a segment field rule; repeat it to AND several. */
        field: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
          description:
            "key:op[:value], repeatable, ANDed. key is email, name or a custom field; op is one of eq, neq, contains, notContains, startsWith, endsWith, gt, gte, lt, lte, exists, missing. The value is everything after the second colon; gt/gte/lt/lte compare numbers when it is numeric. exists and missing take no value.",
        }),
        /** `[!]name[:days]`: did (or with `!` didn't) the event, within the last `days`. */
        event: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
          description:
            "[!]name[:days], repeatable, ANDed: the contact did the event (within the last 1–3650 days), or with a leading ! didn't.",
        }),
        sort: Schema.optionalKey(
          Schema.Literals([
            "createdAt",
            "-createdAt",
            "email",
            "-email",
            "lastActivityAt",
            "-lastActivityAt",
          ]),
        ),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        contacts: Schema.Array(ContactSchema),
        /** Every contact in the account, and those matching the filters. */
        total: Schema.Number,
        count: Schema.Number,
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, InvalidRequest, NotFound],
    }),
    HttpApiEndpoint.post("create", "/v1/contacts", {
      payload: Schema.Struct({
        email: Schema.String,
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        fields: Schema.optionalKey(Fields),
        status: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
      }),
      success: ContactSchema,
      error: [Forbidden, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.get("get", "/v1/contacts/:id", {
      params: { id: Schema.String },
      success: ContactSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/contacts/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        /** Merged into the contact's fields; a null value removes that field. */
        fields: Schema.optionalKey(Fields),
        status: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
      }),
      success: ContactSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/contacts/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("timeline", "/v1/contacts/:id/timeline", {
      params: { id: Schema.String },
      query: {
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
        /** Only these kinds: event, message, delivery, subscription, consent, reply, automation, comma-separated. */
        kind: Schema.optionalKey(
          commaList(["event", "message", "delivery", "subscription", "consent", "reply", "automation"]),
        ),
      },
      success: Schema.Struct({
        items: Schema.Array(TimelineItemSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.put("setTopic", "/v1/contacts/:id/topics/:topicId", {
      params: { id: Schema.String, topicId: Schema.String },
      payload: Schema.Struct({
        state: Schema.Literals(["subscribed", "unsubscribed"]),
        /** Consent was collected elsewhere: skip the topic's double opt-in mail. */
        confirmed: Schema.optionalKey(Schema.Boolean),
      }),
      success: Schema.Struct({
        contact: ContactSchema,
        state: SubscriptionStateSchema,
        confirmationSent: Schema.Boolean,
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("bulk", "/v1/contacts/bulk", {
      payload: Schema.Struct({
        /** Up to 1,000 contact ids. Give `ids` or `filter`, not both. */
        ids: Schema.optionalKey(Schema.Array(Schema.String)),
        /** The contacts list's filters. Up to 1,000 matches are done at once; more become a job. */
        filter: Schema.optionalKey(BulkFilterSchema),
        action: Schema.Union([
          Schema.Struct({
            action: Schema.Literal("addTopic"),
            topicId: Schema.String,
            confirmed: Schema.optionalKey(Schema.Boolean),
          }),
          Schema.Struct({ action: Schema.Literal("removeTopic"), topicId: Schema.String }),
          Schema.Struct({
            action: Schema.Literal("setStatus"),
            status: Schema.Literals(["subscribed", "unsubscribed"]),
          }),
          Schema.Struct({ action: Schema.Literal("delete") }),
        ]),
      }),
      success: Schema.Union([
        Schema.Struct({
          /** Done in this request (ids, or a filter matching at most 1,000). */
          mode: Schema.optionalKey(Schema.Literal("sync")),
          updated: Schema.Number,
          skipped: Schema.Number,
          errors: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
        }),
        Schema.Struct({
          /** More than 1,000 matched: a Workflow does it; watch `GET /v1/contacts/bulk/{id}`. */
          mode: Schema.Literal("async"),
          job: BulkJobSchema,
        }),
      ]),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("bulkJob", "/v1/contacts/bulk/:id", {
      params: { id: Schema.String },
      success: BulkJobSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("fields", "/v1/contact-fields", {
      success: Schema.Struct({
        fields: Schema.Array(ContactFieldSchema),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.patch("updateField", "/v1/contact-fields/:key", {
      params: { key: Schema.String },
      payload: Schema.Struct({
        label: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(120)))),
        type: Schema.optionalKey(Schema.Literals(["string", "number", "boolean", "date"])),
      }),
      success: ContactFieldSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("export", "/v1/contacts/:id/export", {
      params: { id: Schema.String },
      success: Schema.Struct({
        exportedAt: Schema.String,
        contact: Fields,
        subscriptions: Schema.Array(Fields),
        subscriptionChanges: Schema.Array(Fields),
        events: Schema.Array(Fields),
        messages: Schema.Array(Fields),
        suppression: Schema.NullOr(Fields),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("preferencesLink", "/v1/contacts/:id/preferences-link", {
      params: { id: Schema.String },
      /** Ties the link (and its one-click) to one topic; without it, the link manages every topic. */
      query: { topicId: Schema.optionalKey(Schema.String) },
      success: Schema.Struct({ url: Schema.String }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("erase", "/v1/contacts/:id/erase", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, erased: Schema.Boolean, messagesScrubbed: Schema.Number }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class TopicsApi extends HttpApiGroup.make("topics")
  .add(
    HttpApiEndpoint.get("list", "/v1/topics", {
      success: Schema.Struct({ topics: Schema.Array(TopicSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("stats", "/v1/topics/stats", {
      query: { range: Schema.optionalKey(Schema.Literals(["7d", "30d", "90d"])) },
      success: Schema.Struct({
        range: Schema.Literals(["7d", "30d", "90d"]),
        minimumSubscribers: Schema.Number,
        /** Unarchived topics. Rates are fractions of the subscribers at the range's start, null under the minimum. */
        topics: Schema.Array(
          Schema.Struct({
            topicId: Schema.String,
            name: Schema.String,
            subscribers: Schema.Number,
            joined: Schema.Number,
            left: Schema.Number,
            subscribersAtStart: Schema.Number,
            insufficientData: Schema.Boolean,
            growthRate: Schema.NullOr(Schema.Number),
            unsubscribeRate: Schema.NullOr(Schema.Number),
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/topics", {
      payload: Schema.Struct({
        name: Schema.String,
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        doubleOptIn: Schema.optionalKey(Schema.Boolean),
        sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: TopicSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/topics/:id", {
      params: { id: Schema.String },
      success: TopicSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/topics/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        doubleOptIn: Schema.optionalKey(Schema.Boolean),
        sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
        archived: Schema.optionalKey(Schema.Boolean),
      }),
      success: TopicSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class FormsApi extends HttpApiGroup.make("forms")
  .add(
    HttpApiEndpoint.get("list", "/v1/forms", {
      success: Schema.Struct({ forms: Schema.Array(FormSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/forms", {
      payload: Schema.Struct({
        name: Schema.String,
        topicIds: Schema.Array(Schema.String),
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
        /** Replaces `fields` when given: keys, labels, types, required, in page order. */
        fieldDefs: Schema.optionalKey(Schema.Array(FormFieldDefInput)),
        topicChoice: Schema.optionalKey(TopicChoice),
        redirectUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        turnstileSiteKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      success: FormSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/forms/:id", {
      params: { id: Schema.String },
      success: FormSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/forms/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        topicIds: Schema.optionalKey(Schema.Array(Schema.String)),
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
        fieldDefs: Schema.optionalKey(Schema.Array(FormFieldDefInput)),
        topicChoice: Schema.optionalKey(TopicChoice),
        redirectUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
        turnstileSiteKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
        archived: Schema.optionalKey(Schema.Boolean),
      }),
      success: FormSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** The hosted page's address and a snippet to paste into another site, which posts to submit. */
    HttpApiEndpoint.get("embed", "/v1/forms/:id/embed", {
      params: { id: Schema.String },
      success: Schema.Struct({
        pageUrl: Schema.String,
        /** The form itself, posted with fetch: the visitor stays on the page. */
        html: Schema.String,
        /** The hosted page in a frame: no script on the host page. */
        iframe: Schema.String,
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("stats", "/v1/forms/:id/stats", {
      params: { id: Schema.String },
      query: { range: Schema.optionalKey(Schema.Literals(["7d", "30d", "90d"])) },
      success: Schema.Struct({
        range: Schema.Literals(["7d", "30d", "90d"]),
        submissions: Schema.Number,
        subscribed: Schema.Number,
        /** Sent a double opt-in link. */
        confirm: Schema.Number,
        /** Turned away: a failed challenge, a bad address, a missing field, too many tries. */
        refused: Schema.Number,
        days: Schema.Array(
          Schema.Struct({
            day: Schema.String,
            submissions: Schema.Number,
            subscribed: Schema.Number,
            confirm: Schema.Number,
            refused: Schema.Number,
          }),
        ),
      }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Segments: saved audiences as a rule tree (docs/email-ui.html: Segment builder)

/**
 * A rule tree in a request. Decoded by the segment code itself, so a bad tree is a 400 whose `field`
 * names the rule at fault (`filter.rules[1].rules[0]`); its shape is `SegmentRule`.
 */
const SegmentRuleInput = Schema.Unknown.annotate({
  description:
    "A SegmentRule tree (see the SegmentRule schema). A tree that can't work is a 400 with the rule's path in `field`.",
})

export const SegmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  filter: SegmentRule,
  /** Campaigns built on it and automations whose draft or live graph names it; delete refuses while any do. */
  usedBy: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["campaign", "automation"]),
      id: Schema.String,
      name: Schema.String,
    }),
  ),
  count: Schema.NullOr(Schema.Number),
  countedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

export class SegmentsApi extends HttpApiGroup.make("segments")
  .add(
    HttpApiEndpoint.get("list", "/v1/segments", {
      success: Schema.Struct({ segments: Schema.Array(SegmentSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("preview", "/v1/segments/preview", {
      payload: Schema.Struct({ filter: SegmentRuleInput }),
      success: Schema.Struct({
        count: Schema.Number,
        /** Who a campaign to it would mail (subscribed contacts), and who it would leave out, by why. */
        sendable: Schema.Number,
        excluded: Schema.Struct({
          unconfirmed: Schema.Number,
          unsubscribed: Schema.Number,
          bounced: Schema.Number,
          complained: Schema.Number,
          suppressed: Schema.Number,
        }),
        tookMs: Schema.Number,
        sample: Schema.Array(ContactSchema),
        /** The condition it runs over `contacts`, with `?` for each of `params`. */
        sql: Schema.String,
        params: Schema.Array(Schema.Unknown),
      }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.post("create", "/v1/segments", {
      /** A filter that decodes but can't work is a 400 whose `field` is the path of the rule at fault. */
      payload: Schema.Struct({ name: Schema.String, filter: SegmentRuleInput }),
      success: SegmentSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/segments/:id", {
      params: { id: Schema.String },
      success: SegmentSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/segments/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        filter: Schema.optionalKey(SegmentRuleInput),
      }),
      success: SegmentSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/segments/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Sending pace and alerts (docs/email-ui.html: Usage, Overview "needs you")

const ProviderCounts = Schema.Struct({
  gmail: Schema.Number,
  microsoft: Schema.Number,
  yahoo: Schema.Number,
  apple: Schema.Number,
  other: Schema.Number,
})
const Rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const GovernorConfigSchema = Schema.Struct({
  dailyQuota: Schema.NullOr(Count),
  fallbackQuota: Count,
  transactionalReserve: Rate,
  providerPerMinute: ProviderCounts,
  warmup: Schema.Struct({
    enabled: Schema.Boolean,
    start: Count,
    factor: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    maxBounceRate: Rate,
    maxComplaintRate: Rate,
  }),
  establishedDomains: Schema.Array(Schema.String),
  pause: Schema.Struct({ bounceRate: Rate, minOutcomes: Count, complaintRate: Rate, minComplaints: Count }),
})

const GovernorPatchSchema = Schema.Struct({
  dailyQuota: Schema.optionalKey(Schema.NullOr(Count)),
  fallbackQuota: Schema.optionalKey(Count),
  transactionalReserve: Schema.optionalKey(Rate),
  providerPerMinute: Schema.optionalKey(
    Schema.Struct({
      gmail: Schema.optionalKey(Count),
      microsoft: Schema.optionalKey(Count),
      yahoo: Schema.optionalKey(Count),
      apple: Schema.optionalKey(Count),
      other: Schema.optionalKey(Count),
    }),
  ),
  warmup: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      start: Schema.optionalKey(Count),
      factor: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
      maxBounceRate: Schema.optionalKey(Rate),
      maxComplaintRate: Schema.optionalKey(Rate),
    }),
  ),
  establishedDomains: Schema.optionalKey(Schema.Array(Schema.String)),
  pause: Schema.optionalKey(
    Schema.Struct({
      bounceRate: Schema.optionalKey(Rate),
      minOutcomes: Schema.optionalKey(Count),
      complaintRate: Schema.optionalKey(Rate),
      minComplaints: Schema.optionalKey(Count),
    }),
  ),
})

export const GovernorOverviewSchema = Schema.Struct({
  day: Schema.String,
  quota: Schema.Number,
  quotaSource: Schema.Literals(["configured", "cloudflare", "fallback"]),
  sent: Schema.Struct({
    transactional: Schema.Number,
    campaign: Schema.Number,
    automation: Schema.Number,
    mailbox: Schema.Number,
  }),
  bulkRemaining: Schema.Number,
  transactionalReserve: Schema.Number,
  resetsAt: Schema.Number,
  providerThisMinute: ProviderCounts,
  warming: Schema.Array(
    Schema.Struct({
      domain: Schema.String,
      warmingSince: Schema.String,
      day: Schema.Number,
      cap: Schema.Number,
      sentToday: Schema.Number,
    }),
  ),
  config: GovernorConfigSchema,
})

export class GovernorUnreachable extends Schema.TaggedError<GovernorUnreachable>()(
  "GovernorUnreachable",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

const TestSendSchema = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  /** Sent to Mailyard's probe address, so arrival and its verdicts are measured here. */
  probe: Schema.Boolean,
  messageId: Schema.NullOr(Schema.String),
  /** `sending` → `sent` → `received` (probe, verdicts in) or `delivered` (any other address); `failed`. */
  status: Schema.Literals(["sending", "sent", "delivered", "received", "failed"]),
  error: Schema.NullOr(Schema.String),
  sentAt: Schema.Number,
  receivedAt: Schema.NullOr(Schema.Number),
  /** From the send to the arrival (probe) or Email Service's delivered event. */
  deliveryTimeMs: Schema.NullOr(Schema.Number),
  /**
   * What the receiving side's Authentication-Results said (probe only, once received): `pass`,
   * `fail`, `softfail`, `neutral`, `none`, …; `dkim` is the sender's own signature when present.
   * `dmarcPolicy` is the sender's published `p=` (none, quarantine, reject), null with no record.
   */
  authentication: Schema.NullOr(
    Schema.Struct({
      spf: Schema.NullOr(Schema.String),
      spfDomain: Schema.NullOr(Schema.String),
      dkim: Schema.NullOr(Schema.String),
      dkimDomain: Schema.NullOr(Schema.String),
      dmarc: Schema.NullOr(Schema.String),
      dmarcPolicy: Schema.NullOr(Schema.String),
    }),
  ),
})

export class SendingApi extends HttpApiGroup.make("sending")
  .add(
    HttpApiEndpoint.get("governor", "/v1/sending/governor", {
      success: GovernorOverviewSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
    /** Whether each sending domain's delivery events reach Mailyard (subscription and ledger). */
    HttpApiEndpoint.get("events", "/v1/sending/events", {
      success: Schema.Struct({
        domains: Schema.Array(
          Schema.Struct({
            domainId: Schema.String,
            domain: Schema.String,
            subscribed: Schema.NullOr(Schema.Boolean),
            withEvents: Schema.Number,
            silent: Schema.Number,
            status: Schema.Literals(["ok", "warn", "unknown"]),
            detail: Schema.String,
          }),
        ),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("getSettings", "/v1/settings/sending", {
      success: GovernorConfigSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
    HttpApiEndpoint.put("putSettings", "/v1/settings/sending", {
      payload: GovernorPatchSchema,
      success: GovernorConfigSchema,
      error: [Forbidden, GovernorUnreachable],
    }),
    /**
     * Sends one test message from `from` (an address on a sending domain). Without `to` it goes to
     * Mailyard's probe address on a receiving domain (`mailyard-test@`, the sender's own domain when
     * it receives), which reads the receiving side's SPF, DKIM and DMARC verdicts on arrival and
     * drops the mail. With `to`, it reports delivery only. Poll `GET /v1/test-send/{id}`.
     */
    HttpApiEndpoint.post("startTestSend", "/v1/test-send", {
      payload: Schema.Struct({ from: Schema.String, to: Schema.optionalKey(Schema.String) }),
      success: TestSendSchema,
      error: [Conflict, Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("getTestSend", "/v1/test-send/:id", {
      params: { id: Schema.String },
      success: TestSendSchema,
      error: [Forbidden, NotFound],
    }),
    /**
     * The account's verified destination addresses (Email Routing). Mail to them is free and outside
     * the daily quota, so they're good test recipients. `available: false` with a reason when the
     * read token can't list them (it needs Email Routing Addresses: Read).
     */
    HttpApiEndpoint.get("verifiedAddresses", "/v1/verified-addresses", {
      success: Schema.Union([
        Schema.Struct({
          available: Schema.Literal(true),
          addresses: Schema.Array(Schema.Struct({ email: Schema.String, verifiedAt: Schema.Number })),
        }),
        Schema.Struct({ available: Schema.Literal(false), reason: Schema.String }),
      ]),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

export const AlertKindSchema = Schema.Literals(ALERT_KINDS).annotate({
  description:
    "What the alert is about. Conditions clear themselves when they stop holding: delivery_events_missing, campaign_paused (on resume), dns_drift, reputation_warning, reputation_at_risk, bounce_spike, complaint_spike, quota_80, quota_100, webhook_dead_letter, automation_failed. Notices clear after a while: export_ready (a day), domain_activated and import_failed (a week).",
})

export const AlertSchema = Schema.Struct({
  id: Schema.String,
  kind: AlertKindSchema,
  severity: Schema.Literals(["info", "warning", "critical"]),
  title: Schema.String,
  detail: Schema.String,
  subject: Schema.NullOr(Schema.Struct({ type: Schema.String, id: Schema.String })),
  count: Schema.Number.annotate({
    description:
      "How many times it happened while open: failed runs today, dead deliveries, failing records.",
  }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
  resolvedBy: Schema.NullOr(Schema.String).annotate({
    description:
      "Who resolved it: an API key id, or the system (sweep, expired, watchdog, …) when its condition cleared.",
  }),
})

export class AlertsApi extends HttpApiGroup.make("alerts")
  .add(
    HttpApiEndpoint.get("list", "/v1/alerts", {
      query: {
        status: Schema.optionalKey(Schema.Literals(["open", "resolved", "all"])),
        kind: Schema.optionalKey(AlertKindSchema),
        severity: Schema.optionalKey(Schema.Literals(["info", "warning", "critical"])),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        alerts: Schema.Array(AlertSchema),
        open: Schema.Struct({
          total: Schema.Number,
          critical: Schema.Number,
          warning: Schema.Number,
          info: Schema.Number,
        }).annotate({ description: "Open alerts by severity, whatever the filters: the badge on the bell." }),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("resolve", "/v1/alerts/:id/resolve", {
      params: { id: Schema.String },
      success: AlertSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

// Campaigns (docs/email-ui.html: Campaigns list, Campaign editor)

const CampaignStatusSchema = Schema.Literals(["draft", "scheduled", "sending", "paused", "sent", "cancelled"])
const AbSchema = Schema.Struct({
  percent: Schema.Number,
  waitHours: Schema.Number,
  metric: Schema.Literals(["clicks", "opens"]),
})

const ExcludeSchema = Schema.Struct({
  /** Contacts in any of these segments are left out (at most 10). */
  segmentIds: Schema.Array(Schema.String),
  /** Anyone another campaign mailed in the last this-many days (1 to 90) is left out; null, nobody. */
  recentlySentDays: Schema.NullOr(Schema.Number),
})

export const CampaignSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: CampaignStatusSchema,
  segmentId: Schema.NullOr(Schema.String),
  topicId: Schema.NullOr(Schema.String),
  templateId: Schema.NullOr(Schema.String),
  templateVersion: Schema.NullOr(Schema.Number),
  bodyHtml: Schema.NullOr(Schema.String),
  bodyText: Schema.NullOr(Schema.String),
  /** Block content: a template-kit document rendered in the brand, in place of `bodyHtml`. */
  bodyBlocks: Schema.NullOr(BlocksDocument),
  fromAddress: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  subject: Schema.String,
  subjectB: Schema.NullOr(Schema.String),
  preheader: Schema.NullOr(Schema.String),
  ab: Schema.NullOr(AbSchema),
  trackOpens: Schema.Boolean,
  trackClicks: Schema.Boolean,
  sendAt: Schema.NullOr(Schema.Number),
  audienceSize: Schema.NullOr(Schema.Number),
  pausedReason: Schema.NullOr(Schema.String),
  /** Why it's paused, as a code: the governor's bounce or complaint line, or a person. */
  pausedBy: Schema.NullOr(Schema.Literals(["bounce_rate", "complaint_rate", "admin"])),
  /**
   * A sending campaign the governor holds until this time (ms): the day's quota or the domain's
   * warm-up cap is spent. It carries on by itself; `status` stays "sending". Null otherwise.
   */
  heldUntil: Schema.NullOr(Schema.Number),
  heldBy: Schema.NullOr(Schema.Literals(["quota", "warmup"])),
  /** The IANA zone the schedule was picked in. */
  timezone: Schema.NullOr(Schema.String),
  /** The last test send, and how each address went. */
  lastTest: Schema.NullOr(
    Schema.Struct({
      at: Schema.Number,
      results: Schema.Array(
        Schema.Struct({ email: Schema.String, messageId: Schema.String, status: Schema.String }),
      ),
    }),
  ),
  /** Who it leaves out beyond the blocked and unsubscribed; null when nobody. */
  exclude: Schema.NullOr(ExcludeSchema),
  /** Who saved it last; with `updatedAt`, what PATCH's `ifMatch` checks. */
  updatedBy: Schema.NullOr(Schema.String),
  abWinner: Schema.NullOr(Schema.Literals(["a", "b"])),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
})

/** A campaign in the list: once it has started, its numbers too, from the rollup. */
const CampaignListItem = Schema.Struct({
  ...CampaignSchema.fields,
  summary: Schema.NullOr(
    Schema.Struct({
      sent: Schema.Number,
      delivered: Schema.Number,
      opened: Schema.Number,
      clicked: Schema.Number,
      bounced: Schema.Number,
      unsubscribed: Schema.Number,
    }),
  ),
})

const CampaignReportSchema = Schema.Struct({
  campaignId: Schema.String,
  status: CampaignStatusSchema,
  audience: Count,
  sent: Count,
  delivered: Count,
  pending: Count,
  tracked: Schema.Boolean,
  opened: Count,
  machineOnlyOpens: Count,
  machineOpenShare: Schema.NullOr(Schema.Number),
  clicked: Count,
  replied: Count,
  unsubscribed: Count,
  bounced: Schema.Struct({ hard: Count, soft: Count }),
  complained: Count,
  failed: Count,
  /** Under `minimumSends` the rates are null rather than misleading. */
  insufficientData: Schema.Boolean,
  minimumSends: Schema.Number,
  rates: Schema.Struct({
    delivery: Schema.NullOr(Schema.Number),
    open: Schema.NullOr(Schema.Number),
    click: Schema.NullOr(Schema.Number),
    clickToOpen: Schema.NullOr(Schema.Number),
    bounce: Schema.NullOr(Schema.Number),
    complaint: Schema.NullOr(Schema.Number),
    unsubscribe: Schema.NullOr(Schema.Number),
  }),
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      sent: Count,
      delivered: Count,
      bounced: Count,
      complained: Count,
      opened: Count,
    }),
  ),
  links: Schema.Array(Schema.Struct({ url: Schema.String, clicks: Count, machineClicks: Count })),
  activity: Schema.Array(
    Schema.Struct({
      hour: Count.check(Schema.isLessThanOrEqualTo(167)).annotate({
        description:
          "Whole hours from the campaign's startedAt to the first opens and clicks counted in this bucket; the first 7 days only (0–167). Not an hour of the day.",
      }),
      opens: Count,
      clicks: Count,
    }),
  ),
  ab: Schema.NullOr(
    Schema.Struct({
      metric: Schema.Literals(["clicks", "opens"]),
      winner: Schema.NullOr(Schema.Literals(["a", "b"])),
      variants: Schema.Array(
        Schema.Struct({
          variant: Schema.Literals(["a", "b"]),
          subject: Schema.String,
          sent: Count,
          opened: Count,
          clicked: Count,
        }),
      ),
    }),
  ),
})

const CampaignRecipientSchema = Schema.Struct({
  messageId: Schema.String,
  contactId: Schema.NullOr(Schema.String),
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  status: Schema.String,
  bounceType: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  openedAt: Schema.NullOr(Schema.Number),
  clickedAt: Schema.NullOr(Schema.Number),
  opens: Count,
  clicks: Count,
  machineOpens: Count,
  unsubscribed: Schema.Boolean,
  sentAt: Schema.Number,
})

const CampaignFields = {
  segmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  topicId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  templateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyHtml: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bodyText: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * Block content, kept as the block editor's source. Merge fields in its strings are
   * `{{ name }}`, with a fallback `{{ name ?? "there" }}`.
   */
  bodyBlocks: Schema.optionalKey(Schema.NullOr(BlocksDocument)),
  replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subjectB: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preheader: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  ab: Schema.optionalKey(Schema.NullOr(AbSchema)),
  trackOpens: Schema.optionalKey(Schema.Boolean),
  trackClicks: Schema.optionalKey(Schema.Boolean),
  timezone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  exclude: Schema.optionalKey(Schema.NullOr(ExcludeSchema)),
}

const CheckSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pass", "warn", "fail"]),
  title: Schema.String,
  detail: Schema.String,
  /**
   * Where it's fixed: `content` (a campaign `field`: subject, bodyHtml, bodyBlocks, bodyText,
   * templateId, fromAddress, replyTo, trackClicks), `settings.compliance` (a compliance `field`:
   * linkAllowlist, trackingOrigin, postalAddress), `domains` (with `domainId` once the domain
   * exists) or `audience`. Null when there's nothing to fix.
   */
  fix: Schema.NullOr(
    Schema.Struct({
      label: Schema.String,
      target: Schema.Literals(["content", "audience", "settings.compliance", "domains"]),
      field: Schema.optionalKey(Schema.String),
      domainId: Schema.optionalKey(Schema.String),
    }),
  ),
})

/** A link in the content and its last check: null status and `checkedAt` when never followed. */
const LinkStatusSchema = Schema.Struct({
  url: Schema.String,
  status: Schema.NullOr(Schema.Number),
  /** "timed out" or "unreachable" when nothing answered. */
  error: Schema.NullOr(Schema.String),
  redirectsTo: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.Number),
})

/** What new campaigns and topics start with, and how the preference page looks (HAL-3376). */
const ComplianceDefaults = {
  /** Null: the deploy's MAILYARD_TRACK_OPENS (on unless "false"). */
  trackOpensDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** Null: the deploy's MAILYARD_TRACK_CLICKS (on unless "false"). */
  trackClicksDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** Null: on. */
  doubleOptInDefault: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  preferencePage: Schema.optionalKey(
    Schema.Struct({ useBrand: Schema.Boolean, showTopicDescriptions: Schema.Boolean }),
  ),
}

const ComplianceSchema = Schema.Struct({
  postalAddress: Schema.NullOr(Schema.String),
  linkAllowlist: Schema.Array(Schema.String),
  seedAddresses: Schema.Array(Schema.String),
  trackingOrigin: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** An https link to the sender's privacy policy, shown in the footer of the public pages. */
  privacyUrl: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)))),
  ...ComplianceDefaults,
  /** The last live check of `trackingOrigin`; recheck with `POST /v1/settings/compliance/tracking-check`. */
  trackingOriginCheck: Schema.optionalKey(Schema.NullOr(TrackingOriginCheck)),
})

const ImportRowErrorSchema = Schema.Struct({
  line: Schema.Number,
  message: Schema.String,
  /** The column the problem is in, as the file names it. */
  column: Schema.NullOr(Schema.String),
  /** The cell as written (up to 200 characters); null for a missing email. */
  value: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.Literals(["missing_email", "invalid_email", "invalid_value", "parse_error"])),
})

const ContactImportSchema = Schema.Struct({
  id: Schema.String,
  uploadId: Schema.String,
  /** The uploaded file's name and size (HAL-3371). */
  fileName: Schema.NullOr(Schema.String),
  fileSize: Schema.NullOr(Schema.Number),
  /** `cancelled`: stopped by `POST /v1/imports/{id}/cancel`; rows already written stay. */
  status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
  mapping: Schema.Record(Schema.String, Schema.String),
  topicIds: Schema.Array(Schema.String),
  onConflict: Schema.Literals(["update", "skip"]),
  defaultStatus: Schema.Literals(["subscribed", "unsubscribed"]),
  headers: Schema.NullOr(Schema.Array(Schema.String)),
  rows: Schema.Number.annotate({
    description:
      "Data rows read so far, the header excluded; it grows while the import runs. rows = created + updated + skipped + invalid + duplicates.",
  }),
  created: Schema.Number,
  updated: Schema.Number,
  skipped: Schema.Number,
  invalid: Schema.Number,
  /** Rows whose address appeared earlier in the same step of the file: merged into it, not counted elsewhere. */
  duplicates: Schema.Number.annotate({
    description:
      "Rows repeating an address already read in the same step: merged into that row. Not part of skipped.",
  }),
  suppressed: Schema.Number.annotate({
    description:
      "New contacts that joined as suppressed because their address is on the suppression list. Part of created.",
  }),
  /** The first 100 rejected rows; `errorsTotal` counts them all, and `GET /v1/imports/{id}/errors.csv` lists them all. */
  errors: Schema.Array(ImportRowErrorSchema),
  errorsTotal: Schema.Number,
  /** Rows read so far (the same as `rows`). */
  processed: Schema.Number,
  /** Bytes of the file read so far, of `size`: an exact progress bar from the start. */
  bytesRead: Schema.Number,
  size: Schema.NullOr(Schema.Number),
  /** Rows a minute since it started; null unless running. */
  ratePerMinute: Schema.NullOr(Schema.Number),
  /** When it should finish at the current pace (ms); null unless running. */
  etaAt: Schema.NullOr(Schema.Number),
  /** The attestation given with the import, also stored on each subscription it made. */
  consent: Schema.NullOr(
    Schema.Struct({
      attested: Schema.Literal(true),
      statement: Schema.NullOr(Schema.String),
      attestedBy: Schema.String,
      attestedAt: Schema.NullOr(Schema.Number),
    }),
  ),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
})

/** Contact CSV imports. The file goes up first, as the body of `POST /v1/uploads?filename=` (50 MiB). */
const BinaryBody = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
)
const UploadQuery = {
  /** The file's name (no slashes); or send it as an `x-filename` header. */
  filename: Schema.optionalKey(Schema.String),
}

/**
 * Files in and out (documented by HAL-3475): the request body is the file itself, in its own
 * content type, at most 50 MiB (25 MiB for a mailbox attachment). The Worker serves these directly;
 * the handlers here run the same code.
 */
export class FilesApi extends HttpApiGroup.make("files")
  .add(
    /** A file for a contact import (`POST /v1/imports/contacts { uploadId }`) or a brand logo (`logoUploadId`). Admin. */
    HttpApiEndpoint.post("upload", "/v1/uploads", {
      query: UploadQuery,
      payload: BinaryBody,
      success: Schema.Struct({
        id: Schema.String,
        filename: Schema.String,
        mimeType: Schema.String,
        size: Schema.Number,
        sha256: Schema.String,
        createdAt: Schema.Number,
      }).pipe(HttpApiSchema.status(201)),
      error: [Forbidden, InvalidRequest],
    }),
    /** An attachment for a draft in this mailbox; its `key` goes in the draft's attachments. Mailbox write access. */
    HttpApiEndpoint.post("mailboxUpload", "/v1/mailboxes/:id/uploads", {
      params: { id: Schema.String },
      query: UploadQuery,
      payload: BinaryBody,
      success: Schema.Struct({
        key: Schema.String,
        filename: Schema.String,
        mimeType: Schema.String,
        size: Schema.Number,
        sha256: Schema.String,
      }).pipe(HttpApiSchema.status(201)),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** An outbound message exactly as it was sent, as an .eml file. Read scope. */
    HttpApiEndpoint.get("messageRaw", "/v1/messages/:id/raw", {
      params: { id: Schema.String },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "message/rfc822" })),
      error: [Forbidden, NotFound],
    }),
    /**
     * A chart as CSV: volume, delivery, providers, deferrals, engagement, engagement-hours,
     * unsubscribes, inbound, audience. `range` as on the JSON stats. Rates stay fractions. Read scope.
     */
    HttpApiEndpoint.get("statsCsv", "/v1/stats/:chart.csv", {
      params: {
        chart: Schema.Literals([
          "volume",
          "delivery",
          "providers",
          "deferrals",
          "engagement",
          "engagement-hours",
          "unsubscribes",
          "inbound",
          "audience",
        ]),
      },
      query: { range: Schema.optionalKey(Schema.String) },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

const FormSubmitFields = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
).annotate({
  description:
    "`email` (required), `name`, `topics` (topic ids, when the form lets the visitor pick), `cf-turnstile-response` (when the form has Turnstile), and the form's custom fields by key. `_hp` and `website` are honeypots and must stay empty.",
})

const FormSubmitRefused = (status: number, codes: ReadonlyArray<string>) =>
  Schema.Struct({
    error: Schema.Literals(codes as [string, ...Array<string>]),
    /** The field that's wrong, for `invalid`. */
    field: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
  }).pipe(HttpApiSchema.status(status))

/**
 * A signup form's submit (HAL-3317, documented by HAL-3472). Public: no key. A browser posting the
 * hosted page gets HTML back (the result page, or the form again with its error); a script asking
 * for JSON gets these answers. CORS allows any origin, and `OPTIONS` answers the preflight.
 */
export class PublicFormsApi extends HttpApiGroup.make("publicForms").add(
  HttpApiEndpoint.post("submit", "/v1/forms/:id/submit", {
    params: { id: Schema.String },
    payload: [FormSubmitFields, FormSubmitFields.pipe(HttpApiSchema.asFormUrlEncoded())],
    success: Schema.Struct({
      /** `confirm`: a double opt-in mail went out; `subscribed`: they're on the list now. */
      status: Schema.Literals(["confirm", "subscribed"]),
    }),
    error: [
      FormSubmitRefused(400, ["invalid", "invalid_body", "challenge"]),
      FormSubmitRefused(404, ["not_found"]),
      FormSubmitRefused(429, ["rate_limited"]),
    ],
  }),
) {}

export class ImportsApi extends HttpApiGroup.make("imports")
  .add(
    HttpApiEndpoint.post("contacts", "/v1/imports/contacts", {
      payload: Schema.Struct({
        uploadId: Schema.String,
        /**
         * Column header → a target: `email` (exactly one), `name`, or `name.first` and `name.last`
         * (joined with a space), `status` (cells of subscribed or unsubscribed), `fields.<name>` or
         * `ignore`. A field in the registry (`GET /v1/contact-fields`) is read as its type (number,
         * boolean, date as ISO); a cell that isn't one rejects the row. A new name is stored as text and
         * registers the field. Unmapped columns are left out.
         */
        mapping: Schema.Record(Schema.String, Schema.String),
        topicIds: Schema.optionalKey(Schema.Array(Schema.String)),
        /** An address that's already a contact: merge the row into it, or leave it alone. */
        onConflict: Schema.optionalKey(Schema.Literals(["update", "skip"])),
        /** New contacts' status when the file has no status column (or the cell is empty). */
        defaultStatus: Schema.optionalKey(Schema.Literals(["subscribed", "unsubscribed"])),
        /**
         * The importer's word that these people agreed to hear from you. Stored on the import (with who
         * and when) and as evidence on every subscription the import makes.
         */
        consent: Schema.optionalKey(
          Schema.Struct({
            attested: Schema.Boolean,
            statement: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
          }),
        ),
      }),
      success: ContactImportSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("list", "/v1/imports", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        imports: Schema.Array(ContactImportSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/imports/:id", {
      params: { id: Schema.String },
      success: ContactImportSchema,
      error: [Forbidden, NotFound],
    }),
    /**
     * Stops a queued or running import. Rows already written stay; it answers the import as
     * `cancelled`. `GET /v1/imports/{id}/errors.csv` lists every rejected row (line, column, value,
     * code, message) at any point.
     */
    HttpApiEndpoint.post("cancel", "/v1/imports/:id/cancel", {
      params: { id: Schema.String },
      success: ContactImportSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** Every rejected row of an import as CSV (`line,column,value,code,message`), in file order. */
    HttpApiEndpoint.get("errorsCsv", "/v1/imports/:id/errors.csv", {
      params: { id: Schema.String },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

const ExportPartSchema = Schema.Struct({
  kind: Schema.Literals(["mail", "contacts", "templates", "lists", "settings", "audit", "manifest"]),
  format: Schema.Literals(["mbox", "zip", "csv", "json"]),
  filename: Schema.String,
  /** Messages, contacts, templates, entries: what the part holds. */
  items: Schema.Number,
  bytes: Schema.Number,
  status: Schema.Literals(["pending", "complete", "failed"]),
  error: Schema.NullOr(Schema.String),
  /** For a `mail` part: the mailbox it is. */
  mailboxId: Schema.NullOr(Schema.String),
  /** A signed link good for a day, once the part is complete and the export is fetched by id. */
  url: Schema.NullOr(Schema.String),
})

const ContactExportSchema = Schema.Struct({
  id: Schema.String,
  /** `workspace`: every part of the workspace, listed in `parts` (HAL-3451). */
  kind: Schema.Literals(["contacts", "workspace"]),
  status: Schema.Literals(["running", "completed", "failed"]),
  rows: Schema.Number,
  /** Rows written so far; with `total`, how far a running export has got (HAL-3371). */
  processed: Schema.Number,
  /** Contacts matching when it started; null for a workspace export, whose parts carry their own. */
  total: Schema.NullOr(Schema.Number),
  /** The key that started it. */
  createdBy: Schema.String,
  fields: Schema.Array(Schema.String),
  filename: Schema.String,
  url: Schema.NullOr(Schema.String).annotate({
    description:
      "A signed link to the CSV, good for a day. Null until it's written, and always null in GET /v1/exports: fetch the export by id for a fresh link.",
  }),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  /** A workspace export's files, each with its own link; null for a contacts export. */
  parts: Schema.NullOr(Schema.Array(ExportPartSchema)),
})

/**
 * Exports: the contacts list as CSV (with the list's filters), or the whole workspace (HAL-3451):
 * mail per mailbox, contacts, templates, lists, settings without secrets, and the audit log, with
 * a manifest. A workspace export runs in the background; an `export_ready` alert says when.
 */
export class ExportsApi extends HttpApiGroup.make("exports")
  .add(
    HttpApiEndpoint.post("create", "/v1/exports", {
      payload: Schema.Struct({
        kind: Schema.Literals(["contacts", "workspace"]),
        /** Contacts only. */
        filter: Schema.optionalKey(
          Schema.Struct({
            q: Schema.optionalKey(Schema.String),
            status: Schema.optionalKey(ContactStatusSchema),
            topicId: Schema.optionalKey(Schema.String),
            engagement: Schema.optionalKey(EngagementSchema),
            segmentId: Schema.optionalKey(Schema.String),
            field: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
            event: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          }),
        ),
        /** Custom fields to add as columns, in this order. */
        fields: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      /** `?dryRun=1` (contacts only): how many rows the export would hold, and nothing is written. */
      query: { dryRun: Schema.optionalKey(Schema.Literals(["1", "true", "0", "false"])) },
      success: Schema.Union([
        ContactExportSchema,
        Schema.Struct({ dryRun: Schema.Literal(true), rows: Schema.Number }),
      ]),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("list", "/v1/exports", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        exports: Schema.Array(ContactExportSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/exports/:id", {
      params: { id: Schema.String },
      success: ContactExportSchema,
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

const AutomationStatus = Schema.Literals(["draft", "live", "paused"])
const AutomationRunCounts = {
  activeRuns: Schema.Number,
  entered: Schema.Number,
  completed: Schema.Number,
  exited: Schema.Number,
  failed: Schema.Number,
}
const AutomationListItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: AutomationStatus,
  trigger: Schema.NullOr(TriggerConfig),
  version: Schema.Number,
  publishedVersion: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
  updatedBy: Schema.NullOr(Schema.String),
  ...AutomationRunCounts,
})
const AutomationIssue = Schema.Struct({
  nodeId: Schema.NullOr(Schema.String),
  code: Schema.String,
  message: Schema.String,
})
const AutomationDetail = Schema.Struct({
  ...AutomationListItem.fields,
  graph: AutomationGraph,
  settings: AutomationSettings,
  /** What stops it publishing; empty when it can. */
  issues: Schema.Array(AutomationIssue),
  /** Per node: runs waiting there now, runs that passed through, and failures. */
  counts: Schema.Record(
    Schema.String,
    Schema.Struct({ here: Schema.Number, passed: Schema.Number, failed: Schema.Number }),
  ),
  /**
   * True when secret step settings (a webhook's URL) came back redacted, as `https://host/•••`,
   * because the key lacks `admin`. Saving a graph that still holds a redacted value keeps the stored one.
   */
  redacted: Schema.Boolean,
})
const AutomationRange = Schema.Literals(["24h", "7d", "30d"])

const AutomationRunState = Schema.Literals(["running", "waiting", "completed", "exited", "failed"])
const AutomationRun = Schema.Struct({
  id: Schema.String,
  automationId: Schema.String,
  contactId: Schema.String,
  email: Schema.NullOr(Schema.String),
  version: Schema.Number,
  /** The step it's at (or will run next). */
  nodeId: Schema.NullOr(Schema.String),
  status: AutomationRunState,
  enteredAt: Schema.Number,
  nextAt: Schema.NullOr(Schema.Number),
  waitingFor: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  exitedBy: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.Number),
})
const AutomationRunDetail = Schema.Struct({
  ...AutomationRun.fields,
  steps: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      nodeId: Schema.String,
      outcome: Schema.Literals(["passed", "waiting", "sent", "skipped", "exited", "failed"]),
      port: Schema.NullOr(Schema.String),
      detail: Schema.String,
      messageId: Schema.NullOr(Schema.String),
      at: Schema.Number,
    }),
  ),
})

/** One run: its history, and ending or retrying it. */
export class RunsApi extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("get", "/v1/runs/:id", {
      params: { id: Schema.String },
      success: AutomationRunDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("exit", "/v1/runs/:id/exit", {
      params: { id: Schema.String },
      success: AutomationRunDetail,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("retry", "/v1/runs/:id/retry", {
      params: { id: Schema.String },
      success: AutomationRunDetail,
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

/** Automations: a trigger and a graph of steps, edited as a draft and published as frozen versions. */
export class AutomationsApi extends HttpApiGroup.make("automations")
  .add(
    HttpApiEndpoint.get("list", "/v1/automations", {
      query: { range: Schema.optionalKey(AutomationRange) },
      success: Schema.Struct({
        range: AutomationRange,
        summary: Schema.Struct({
          live: Schema.Number,
          activeRuns: Schema.Number,
          entered: Schema.Number,
          completed: Schema.Number,
          failed: Schema.Number,
        }),
        automations: Schema.Array(AutomationListItem),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("summary", "/v1/automations/summary", {
      success: Schema.Struct({ live: Schema.Number, activeRuns: Schema.Number, sends7d: Schema.Number }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/automations", {
      payload: Schema.Struct({
        name: Schema.String,
        graph: Schema.optionalKey(AutomationGraph),
        settings: Schema.optionalKey(AutomationSettings),
      }),
      success: AutomationDetail,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/automations/:id", {
      params: { id: Schema.String },
      success: AutomationDetail,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/automations/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        graph: Schema.optionalKey(AutomationGraph),
        settings: Schema.optionalKey(AutomationSettings),
      }),
      success: AutomationDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/automations/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("publish", "/v1/automations/:id/publish", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
      }),
      success: Schema.Struct({
        version: Schema.Number,
        runsByVersion: Schema.Array(Schema.Struct({ version: Schema.Number, active: Schema.Number })),
      }),
      error: [Forbidden, NotFound, NotReady],
    }),
    HttpApiEndpoint.get("versions", "/v1/automations/:id/versions", {
      params: { id: Schema.String },
      success: Schema.Struct({
        draft: Schema.Struct({
          version: Schema.Number,
          updatedAt: Schema.NullOr(Schema.Number),
          updatedBy: Schema.NullOr(Schema.String),
        }),
        versions: Schema.Array(
          Schema.Struct({
            version: Schema.Number,
            status: Schema.Literals(["live", "paused", "finishing", "retired"]),
            note: Schema.NullOr(Schema.String),
            publishedAt: Schema.Number,
            publishedBy: Schema.String,
            activeRuns: Schema.Number,
          }),
        ),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("restore", "/v1/automations/:id/versions/:version/restore", {
      params: { id: Schema.String, version: Schema.NumberFromString },
      success: AutomationDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("pause", "/v1/automations/:id/pause", {
      params: { id: Schema.String },
      success: AutomationDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("resume", "/v1/automations/:id/resume", {
      params: { id: Schema.String },
      success: AutomationDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /**
     * Walks one contact (real, or made up) through the draft or a version in simulated time, with the
     * real step code: the path with times, every send rendered, where a cap or stop rule would end it.
     * Nothing is sent or written.
     */
    HttpApiEndpoint.post("dryRun", "/v1/automations/:id/dry-run", {
      params: { id: Schema.String },
      payload: DryRunInput,
      success: Schema.Struct({
        version: Schema.Union([Schema.Literal("draft"), Schema.Number]),
        contact: Schema.Struct({ id: Schema.NullOr(Schema.String), email: Schema.String }),
        startedAt: Schema.Number,
        endsAt: Schema.Number,
        endedBy: Schema.Literals(["exit", "stop", "limit"]),
        sends: Schema.Number,
        path: Schema.Array(
          Schema.Struct({
            nodeId: Schema.String,
            label: Schema.NullOr(Schema.String),
            type: Schema.String,
            at: Schema.Number,
            outcome: Schema.Literals([
              "would-run",
              "would-wait",
              "yes",
              "no",
              "event",
              "timed-out",
              "would-send",
              "skipped",
              "deferred",
              "exited",
              "stopped",
            ]),
            detail: Schema.String,
            send: Schema.optionalKey(
              Schema.Struct({ to: Schema.String, subject: Schema.String, preview: Schema.String }),
            ),
          }),
        ),
      }),
      error: [Forbidden, NotFound, NotReady, InvalidRequest],
    }),
    /** Puts one contact into the live version now, with the same entry checks as a trigger. */
    HttpApiEndpoint.post("enter", "/v1/automations/:id/enter", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        contactId: Schema.String,
        data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
      success: Schema.Struct({ result: Schema.String }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("runs", "/v1/automations/:id/runs", {
      params: { id: Schema.String },
      query: {
        status: Schema.optionalKey(AutomationRunState),
        version: Schema.optionalKey(Schema.NumberFromString),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        runs: Schema.Array(AutomationRun),
        total: Schema.Number,
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound],
    }),
    /** The secret this automation's webhook steps are signed with (Standard Webhooks). */
    HttpApiEndpoint.get("webhookSecret", "/v1/automations/:id/webhook-secret", {
      params: { id: Schema.String },
      success: Schema.Struct({ secret: Schema.String }),
      error: [Forbidden, NotFound],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class CampaignsApi extends HttpApiGroup.make("campaigns")
  .add(
    HttpApiEndpoint.get("list", "/v1/campaigns", {
      query: {
        status: Schema.optionalKey(Schema.Union([CampaignStatusSchema, Schema.Literal("active")])),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        campaigns: Schema.Array(CampaignListItem),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("counts", "/v1/campaigns/counts", {
      success: Schema.Struct({
        draft: Schema.Number,
        scheduled: Schema.Number,
        sending: Schema.Number,
        paused: Schema.Number,
        sent: Schema.Number,
        cancelled: Schema.Number,
        /** Scheduled, sending and paused. */
        active: Schema.Number,
        total: Schema.Number,
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/v1/campaigns", {
      payload: Schema.Struct({
        name: Schema.String,
        fromAddress: Schema.String,
        subject: Schema.String,
        ...CampaignFields,
      }),
      success: CampaignSchema,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("get", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        fromAddress: Schema.optionalKey(Schema.String),
        subject: Schema.optionalKey(Schema.String),
        ...CampaignFields,
        /** The `updatedAt` the editor loaded; a later save answers 409 `reason: "stale"` with who saved. */
        ifMatch: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
      success: CampaignSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.delete("remove", "/v1/campaigns/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ id: Schema.String, deleted: Schema.Boolean }),
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("render", "/v1/campaigns/:id/render", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        contactId: Schema.optionalKey(Schema.String),
        variant: Schema.optionalKey(Schema.Literals(["a", "b"])),
        /** Follow the links not checked in the last hour (at most 30) before answering. */
        checkLinks: Schema.optionalKey(Schema.Boolean),
      }),
      success: Schema.Struct({
        subject: Schema.String,
        html: Schema.String,
        text: Schema.String,
        headers: Schema.Record(Schema.String, Schema.String),
        size: Schema.Number,
        /** Mailyard added the unsubscribe footer because the content had no such link. */
        footerAdded: Schema.Boolean,
        /** Each link in the message, with what the links check (or `checkLinks`) last found. */
        links: Schema.Array(LinkStatusSchema),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.post("test", "/v1/campaigns/:id/test", {
      params: { id: Schema.String },
      payload: Schema.Struct({ to: Schema.optionalKey(Schema.Array(Schema.String)) }),
      success: Schema.Struct({
        sent: Schema.Array(
          Schema.Struct({ email: Schema.String, messageId: Schema.String, status: Schema.String }),
        ),
      }),
      error: [Conflict, Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("checks", "/v1/campaigns/:id/checks", {
      params: { id: Schema.String },
      success: Schema.Struct({ ready: Schema.Boolean, checks: Schema.Array(CheckSchema) }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("audiencePreview", "/v1/campaigns/:id/audience/preview", {
      params: { id: Schema.String },
      success: Schema.Struct({
        matching: Schema.Number,
        sendable: Schema.Number,
        /** Each contact the segment matches is counted once, so these and `sendable` add up to `matching`. */
        excluded: Schema.Struct({
          blocked: Schema.Number,
          unsubscribed: Schema.Number,
          unconfirmed: Schema.Number,
          notOnTopic: Schema.Number,
          /** Left out by `exclude.segmentIds`; someone in two counts under the first. */
          bySegment: Schema.Array(
            Schema.Struct({ segmentId: Schema.String, name: Schema.String, count: Schema.Number }),
          ),
          /** Left out by `exclude.recentlySentDays`. */
          recentlySent: Schema.Number,
        }),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("schedule", "/v1/campaigns/:id/schedule", {
      params: { id: Schema.String },
      /** When to start; now when absent. */
      payload: Schema.Struct({ sendAt: Schema.optionalKey(Schema.Number) }),
      success: CampaignSchema,
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.post("pause", "/v1/campaigns/:id/pause", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("resume", "/v1/campaigns/:id/resume", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.post("cancel", "/v1/campaigns/:id/cancel", {
      params: { id: Schema.String },
      success: CampaignSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
    HttpApiEndpoint.get("pace", "/v1/campaigns/:id/pace", {
      params: { id: Schema.String },
      success: Schema.Struct({
        paused: Schema.Boolean,
        reason: Schema.NullOr(Schema.String),
        sent: Schema.Number,
        delivered: Schema.Number,
        bounced: Schema.Number,
        complained: Schema.Number,
        remaining: Schema.Number,
        /** Sends in the trailing hour; null while paused. */
        ratePerHour: Schema.NullOr(Schema.Number),
        eta: Schema.Struct({ days: Schema.NullOr(Schema.Number), at: Schema.NullOr(Schema.Number) }),
      }),
      error: [Forbidden, NotFound, GovernorUnreachable],
    }),
    HttpApiEndpoint.get("report", "/v1/campaigns/:id/report", {
      params: { id: Schema.String },
      success: CampaignReportSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("recipients", "/v1/campaigns/:id/recipients", {
      params: { id: Schema.String },
      query: {
        status: Schema.optionalKey(Schema.Literals(RECIPIENT_FILTERS)),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        recipients: Schema.Array(CampaignRecipientSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, NotFound],
    }),
    /**
     * A draft for the people who received this campaign and didn't open it. Opens are people's
     * unless `countMachineOpensAsOpened`: by default someone whose only open was a privacy proxy
     * fetching the pixel counts as not opened, and gets the resend.
     */
    HttpApiEndpoint.post("resendNonOpeners", "/v1/campaigns/:id/resend-non-openers", {
      params: { id: Schema.String },
      /** Optional: an empty body resends with the original subject, counting people's opens only. */
      payload: [
        Schema.Struct({
          countMachineOpensAsOpened: Schema.optionalKey(Schema.Boolean),
          /** The resend's subject; left out, the original's. */
          subject: Schema.optionalKey(Schema.String),
        }),
        // A member of its own, so the builder reads an empty body as null rather than refusing it.
        Schema.Null,
      ],
      success: CampaignSchema,
      error: [Conflict, Forbidden, NotFound, InvalidRequest],
    }),
    /** What a resend would reach, creating nothing: who didn't open, and who of them can still be mailed. */
    HttpApiEndpoint.get("resendNonOpenersDryRun", "/v1/campaigns/:id/resend-non-openers", {
      params: { id: Schema.String },
      query: { countMachineOpensAsOpened: Schema.optionalKey(Schema.Literals(["true", "false", "1", "0"])) },
      success: Schema.Struct({
        recipients: Schema.Number,
        sendable: Schema.Number,
        countMachineOpensAsOpened: Schema.Boolean,
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("getCompliance", "/v1/settings/compliance", {
      success: ComplianceSchema,
      error: Forbidden,
    }),
    /** Checks the tracking hostname live again (CNAME, HTTPS, reaches this Worker) and keeps the answer. */
    HttpApiEndpoint.post("recheckTracking", "/v1/settings/compliance/tracking-check", {
      success: ComplianceSchema,
      error: Forbidden,
    }),
    HttpApiEndpoint.put("putCompliance", "/v1/settings/compliance", {
      payload: Schema.Struct({
        postalAddress: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
        linkAllowlist: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/i))),
        seedAddresses: Schema.Array(
          Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
        ).check(Schema.isMaxLength(5)),
        trackingOrigin: Schema.optionalKey(
          Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9.-]+$/i))),
        ),
        /** The sender's privacy policy (https), linked in the public pages' footer. */
        privacyUrl: Schema.optionalKey(
          Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/))),
        ),
        ...ComplianceDefaults,
      }),
      success: ComplianceSchema,
      error: [Forbidden, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

const SuppressionReason = Schema.Literals(["hard_bounce", "complaint", "unsubscribe", "manual"])
const CloudflareStateSchema = Schema.Literals(["in-sync", "missing", "not-applicable", "unchecked"]).annotate(
  {
    description:
      "Whether Cloudflare's Email Sending suppression list agrees. in-sync: it has the address. missing: the last sync didn't find it (push it). not-applicable: an unsubscribe or bulk-only row, which Cloudflare's list must not hold, since it blocks transactional mail too. unchecked: no sync has looked yet, or Mailyard can't read the list.",
  },
)

const SuppressionSchema = Schema.Struct({
  email: Schema.String,
  reason: SuppressionReason,
  source: Schema.Literals(["cloudflare", "events", "manual", "import"]).annotate({
    description:
      "events: a bounce or complaint event. cloudflare: Cloudflare refused a send, or the sync adopted it from Cloudflare's list. manual: added through the API. import: a suppression CSV.",
  }),
  messageId: Schema.NullOr(Schema.String).annotate({
    description: "The message whose bounce or complaint added it.",
  }),
  note: Schema.NullOr(Schema.String),
  bulkOnly: Schema.Boolean.annotate({
    description:
      "Blocks only campaigns and automations; transactional and mailbox mail still go. Always true for unsubscribes.",
  }),
  streams: Schema.Array(Schema.Literals(["all", "campaign", "automation"])),
  cloudflare: CloudflareStateSchema,
  at: Schema.Number,
  updatedAt: Schema.Number,
})

const CloudflareRemovalSchema = Schema.Struct({
  state: Schema.Literals(["removed", "not-listed", "read-only", "not-connected", "failed"]),
  message: Schema.NullOr(Schema.String),
}).annotate({
  description:
    "What happened on Cloudflare's list. removed: its entries for the address are gone. not-listed: it had none. read-only: Cloudflare keeps an entry nobody can delete, until it expires. not-connected: no write token, so Cloudflare may still refuse the address. failed: Cloudflare said no.",
})

const SuppressionImportSchema = Schema.Struct({
  id: Schema.String,
  uploadId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed"]),
  reason: SuppressionReason,
  note: Schema.NullOr(Schema.String),
  emailColumn: Schema.NullOr(Schema.String),
  reasonColumn: Schema.NullOr(Schema.String),
  noteColumn: Schema.NullOr(Schema.String),
  push: Schema.Boolean,
  headers: Schema.NullOr(Schema.Array(Schema.String)),
  rows: Schema.Number.annotate({
    description: "Data rows read so far. rows = added + existing + invalid + duplicates.",
  }),
  added: Schema.Number,
  existing: Schema.Number.annotate({ description: "Addresses already on the list; their reason is kept." }),
  invalid: Schema.Number,
  duplicates: Schema.Number,
  pushed: Schema.Number.annotate({
    description: "New addresses also added to Cloudflare's list (with push).",
  }),
  errors: Schema.Array(Schema.Struct({ line: Schema.Number, message: Schema.String })),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})

const SyncSchema = Schema.Struct({
  connected: Schema.Boolean,
  checkedAt: Schema.NullOr(Schema.Number),
  cloudflareOnly: Schema.Number.annotate({
    description: "Cloudflare's temporary entries (with an expiry, usually soft bounces), left to Cloudflare.",
  }),
  adopted: Schema.Number.annotate({
    description: "Cloudflare's permanent entries Mailyard didn't hold, added to its list by this sync.",
  }),
  complete: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  matched: Schema.optionalKey(Schema.Number),
})

/** Cloudflare's list can't be changed from here: no CLOUDFLARE_EMAIL_WRITE_TOKEN. */
export class CloudflareNotConnected extends Schema.TaggedError<CloudflareNotConnected>()(
  "CloudflareNotConnected",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}
/** Cloudflare refused the change; its status and words. */
export class CloudflareRefused extends Schema.TaggedError<CloudflareRefused>()(
  "CloudflareRefused",
  {
    requestId: Schema.optionalKey(
      Schema.String.annotate({
        description: "The request's id, also in the x-request-id header: quote it when asking for help.",
      }),
    ),
    status: Schema.Number,
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

const EmailParam = { email: Schema.String }

/**
 * The suppression list: addresses Mailyard won't send to, and its agreement with Cloudflare's Email
 * Sending suppression list. Reading needs `read`; changing it needs `admin`.
 */
export class SuppressionsApi extends HttpApiGroup.make("suppressions")
  .add(
    HttpApiEndpoint.get("list", "/v1/suppressions", {
      query: {
        reason: Schema.optionalKey(SuppressionReason),
        source: Schema.optionalKey(Schema.Literals(["cloudflare", "events", "manual", "import"])),
        cloudflare: Schema.optionalKey(CloudflareStateSchema),
        q: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
        limit: Limit,
      },
      success: Schema.Struct({
        suppressions: Schema.Array(SuppressionSchema),
        counts: Schema.Struct({
          total: Schema.Number,
          hard_bounce: Schema.Number,
          complaint: Schema.Number,
          unsubscribe: Schema.Number,
          manual: Schema.Number,
        }),
        cloudflare: Schema.Struct({
          readable: Schema.Boolean,
          writable: Schema.Boolean,
          checkedAt: Schema.NullOr(Schema.Number),
          cloudflareOnly: Schema.Number,
          error: Schema.NullOr(Schema.String),
        }),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.post("add", "/v1/suppressions", {
      payload: Schema.Struct({
        email: Schema.String,
        reason: Schema.optionalKey(SuppressionReason),
        note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
        bulkOnly: Schema.optionalKey(Schema.Boolean),
        push: Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Also add it to Cloudflare's list." }),
        ),
      }),
      success: Schema.Struct({
        suppression: SuppressionSchema,
        created: Schema.Boolean.annotate({
          description:
            "False when the address was already on the list: its reason is kept, and a new note is taken.",
        }),
        cloudflare: Schema.NullOr(
          Schema.Struct({ state: Schema.String, message: Schema.NullOr(Schema.String) }),
        ),
      }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.post("import", "/v1/suppressions/import", {
      payload: Schema.Struct({
        uploadId: Schema.String,
        reason: Schema.optionalKey(SuppressionReason),
        note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
        emailColumn: Schema.optionalKey(Schema.String),
        reasonColumn: Schema.optionalKey(Schema.String),
        noteColumn: Schema.optionalKey(Schema.String),
        push: Schema.optionalKey(Schema.Boolean),
      }),
      success: SuppressionImportSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("imports", "/v1/suppressions/imports", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        imports: Schema.Array(SuppressionImportSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("getImport", "/v1/suppressions/imports/:id", {
      params: { id: Schema.String },
      success: SuppressionImportSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.post("sync", "/v1/suppressions/sync", {
      success: SyncSchema,
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/suppressions/:email", {
      params: EmailParam,
      success: Schema.Struct({
        ...SuppressionSchema.fields,
        contact: Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.String })),
        contactStatusBefore: Schema.NullOr(Schema.String),
        cloudflareEntries: Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              reason: Schema.String,
              scope: Schema.String,
              expiresAt: Schema.NullOr(Schema.Number),
              readOnly: Schema.Boolean,
            }),
          ),
        ).annotate({
          description: "Cloudflare's own entries for the address; null when Mailyard can't read its list.",
        }),
      }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.patch("update", "/v1/suppressions/:email", {
      params: EmailParam,
      payload: Schema.Struct({
        note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000)))),
        bulkOnly: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "True lets transactional mail through again (the way to treat a complaint); Cloudflare's account-wide entry is removed too, since it would block that mail.",
          }),
        ),
      }),
      success: Schema.Struct({
        suppression: SuppressionSchema,
        cloudflare: Schema.NullOr(CloudflareRemovalSchema),
      }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.delete("remove", "/v1/suppressions/:email", {
      params: EmailParam,
      payload: Schema.Struct({ confirm: Schema.optionalKey(Schema.Boolean) }),
      success: Schema.Struct({
        email: Schema.String,
        removed: Schema.Boolean,
        contactStatus: Schema.NullOr(Schema.String).annotate({
          description: "The contact's status now: restored to what it was before the suppression.",
        }),
        cloudflare: CloudflareRemovalSchema,
      }),
      error: [Forbidden, NotFound, InvalidRequest, Conflict],
    }),
    HttpApiEndpoint.post("push", "/v1/suppressions/:email/push", {
      params: EmailParam,
      success: Schema.Struct({
        suppression: SuppressionSchema,
        cloudflare: Schema.Struct({
          state: Schema.Literals(["pushed", "already-listed"]),
          message: Schema.NullOr(Schema.String),
        }),
      }),
      error: [Forbidden, NotFound, Conflict, CloudflareNotConnected, CloudflareRefused],
    }),
  )
  .middleware(ApiKeyAuth) {}

const StatsRangeSchema = Schema.optionalKey(Schema.Literals(["24h", "7d", "30d", "90d"]))

const MailboxAttentionSchema = Schema.Struct({
  mailboxId: Schema.String,
  address: Schema.String,
  unread: Schema.Number,
  waitingForReply: Schema.Number,
  oldestWaitingAt: Schema.NullOr(Schema.Number),
  snoozedReturning: Schema.Number,
  assignedToMe: Schema.Number,
})

const ActivityEventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String.annotate({
    description:
      "audit.<action> for a change someone made (audit.campaign.schedule, audit.domain.created, …), alert.<kind> for an alert raised, email.bounced and email.complained for delivery trouble.",
  }),
  text: Schema.String,
  subject: Schema.NullOr(
    Schema.Struct({ type: Schema.String, id: Schema.String, label: Schema.NullOr(Schema.String) }),
  ),
  actor: Schema.NullOr(
    Schema.Struct({
      type: Schema.Literals(["key", "system"]),
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
    }),
  ),
  at: Schema.Number,
})

/**
 * The Overview's read models: what needs a person in the mail, inbound and audience numbers, response
 * times and the activity feed. Each reads through indexes or stored daily totals, never a whole table.
 */
export class OverviewApi extends HttpApiGroup.make("overview")
  .add(
    HttpApiEndpoint.get("attention", "/v1/mail/attention", {
      query: {
        replyTargetHours: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 720 })),
        ),
      },
      success: Schema.Struct({
        replyTargetHours: Schema.Number.annotate({
          description:
            "How long a conversation may wait before it counts as waiting: MAILYARD_REPLY_TARGET_HOURS (24) unless asked.",
        }),
        unread: Schema.Array(
          Schema.Struct({ mailboxId: Schema.String, address: Schema.String, count: Schema.Number }),
        ),
        unreadTotal: Schema.Number,
        waitingForReply: Schema.Number.annotate({
          description:
            "Inbox conversations whose latest message is someone else's and older than the target.",
        }),
        oldestWaitingAt: Schema.NullOr(Schema.Number),
        snoozedReturningToday: Schema.Number,
        assignedToMe: Schema.Number.annotate({
          description: "Inbox conversations assigned to the calling key.",
        }),
        mailboxes: Schema.Array(MailboxAttentionSchema),
        unavailable: Schema.Array(Schema.String).annotate({
          description: "Mailboxes that didn't answer; their numbers are missing.",
        }),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("inbound", "/v1/stats/inbound", {
      query: { range: StatsRangeSchema },
      success: Schema.Struct({
        range: Schema.String,
        received: Schema.Number,
        rejected: Schema.Struct({
          total: Schema.Number,
          noSuchAddress: Schema.Number,
          dmarcFail: Schema.NullOr(Schema.Number),
          rbl: Schema.NullOr(Schema.Number),
        }).annotate({
          description:
            "Mailyard's own refusals (no such address). Email Routing rejects DMARC failures and listed senders before mail reaches Mailyard, so those are null until its analytics are read.",
        }),
        held: Schema.Number,
        spam: Schema.Number,
        byMailbox: Schema.Array(
          Schema.Struct({
            mailboxId: Schema.String,
            address: Schema.NullOr(Schema.String),
            received: Schema.Number,
            spam: Schema.Number,
          }),
        ),
        days: Schema.Array(
          Schema.Struct({
            day: Schema.String,
            received: Schema.Number,
            rejected: Schema.Number,
            spam: Schema.Number,
          }),
        ),
        topSenders: Schema.Array(Schema.Struct({ address: Schema.String, received: Schema.Number })),
        topSendersEstimate: Schema.Boolean,
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("audience", "/v1/stats/audience", {
      query: { range: StatsRangeSchema },
      success: Schema.Struct({
        range: Schema.String,
        asOf: Schema.Number.annotate({
          description: "When the counts by status were taken: the hourly snapshot.",
        }),
        total: Schema.Number,
        byStatus: Schema.Struct({
          subscribed: Schema.Number,
          unconfirmed: Schema.Number,
          unsubscribed: Schema.Number,
          bounced: Schema.Number,
          complained: Schema.Number,
          suppressed: Schema.Number,
        }),
        new: Schema.Number,
        unsubscribed: Schema.Number,
        suppressed: Schema.Number,
        totalByDay: Schema.Array(Schema.Struct({ day: Schema.String, total: Schema.NullOr(Schema.Number) })),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("responseTimes", "/v1/stats/response-times", {
      query: { range: StatsRangeSchema },
      success: Schema.Struct({
        range: Schema.String,
        mailboxes: Schema.Array(
          Schema.Struct({
            mailboxId: Schema.String,
            address: Schema.String,
            assignees: Schema.Array(
              Schema.Struct({
                assigneeId: Schema.NullOr(Schema.String),
                name: Schema.NullOr(Schema.String),
                threads: Schema.Number,
                answered: Schema.Number,
                firstResponseMedianMin: Schema.NullOr(Schema.Number),
                firstResponseP90Min: Schema.NullOr(Schema.Number),
                resolutionMedianHours: Schema.NullOr(Schema.Number),
              }),
            ),
          }),
        ),
        unavailable: Schema.Array(Schema.String),
      }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("activity", "/v1/activity", {
      query: { cursor: Schema.optionalKey(Schema.String), limit: Limit },
      success: Schema.Struct({
        events: Schema.Array(ActivityEventSchema),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

const SearchHitSchema = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  folder: FolderSchema,
  from: Schema.NullOr(PartySchema),
  receivedAt: Schema.Number,
  subject: Schema.String,
  subjectHighlighted: Schema.String,
  excerpt: Schema.String,
  rank: Schema.Number,
})
const PartialSchema = Schema.Array(
  Schema.Struct({ mailboxId: Schema.String, reason: Schema.Literals(["timeout", "error"]) }),
).annotate({
  description: "Mailboxes that didn't answer in time (2.5 s each) or failed: their results are missing.",
})

/** Search across the workspace: the command palette and "search all mail". Only what the caller can read. */
export class SearchApi extends HttpApiGroup.make("search")
  .add(
    HttpApiEndpoint.get("workspace", "/v1/search", {
      query: {
        q: Schema.String,
        types: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "Comma-separated: thread, contact, campaign, template, mailbox, domain. All of them by default.",
          }),
        ),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
        ),
      },
      success: Schema.Struct({
        query: Schema.String,
        results: Schema.Array(
          Schema.Struct({
            type: Schema.Literals(["thread", "contact", "campaign", "template", "mailbox", "domain"]),
            id: Schema.String,
            title: Schema.String,
            subtitle: Schema.NullOr(Schema.String),
            url: Schema.String.annotate({ description: "The web app's route for it." }),
            mailboxId: Schema.optionalKey(Schema.String),
          }),
        ),
        partial: PartialSchema,
      }),
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("mail", "/v1/search/mail", {
      query: {
        q: Schema.String,
        sort: Schema.optionalKey(Schema.Literals(["recent", "relevance"])),
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        ),
      },
      success: Schema.Struct({
        query: Schema.String,
        parsed: Schema.NullOr(
          Schema.Struct({
            operators: Schema.Array(Schema.Struct({ op: Schema.String, value: Schema.String })),
            terms: Schema.Array(Schema.String),
            unsupported: Schema.Array(Schema.Struct({ op: Schema.String, value: Schema.String })),
          }),
        ),
        groups: Schema.Array(
          Schema.Struct({
            mailboxId: Schema.String,
            address: Schema.String,
            hits: Schema.Array(SearchHitSchema),
            threads: Schema.Array(ThreadSchema),
          }),
        ),
        searched: Schema.Number.annotate({ description: "Mailboxes that answered." }),
        partial: PartialSchema,
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Browser sessions and /v1/me (HAL-3358)
// ---------------------------------------------------------------------------------------------

const Workspace = Schema.Struct({
  id: Schema.String,
  /** The brand's name until the workspace is claimed and named (HAL-3361). */
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  /** Where the workspace's app and public links live: `MAILYARD_PUBLIC_ORIGIN`, else the origin the
   * request came in on (HAL-3483). */
  url: Schema.String,
  /** `url`'s hostname, e.g. `mail.flareyard.dev`. */
  host: Schema.String,
  /** Whether someone has claimed the workspace and become its owner (HAL-3361). */
  claimed: Schema.Boolean,
})

export const MemberRole = Schema.Literals(["owner", "admin", "sender", "agent", "viewer"])

export const Me = Schema.Struct({
  /** The signed-in person; null for a key or the admin key (HAL-3361). */
  user: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      /** IANA time zone for the snooze and schedule pickers; UTC until they choose. */
      timeZone: Schema.String,
    }),
  ),
  workspace: Workspace,
  /** The person's role; null for keys, which are checked by scopes. */
  role: Schema.NullOr(MemberRole),
  /** `session-member`: a person signed in by email link. `session-key`: a browser session opened with
   * an API key. `admin-key`: the ADMIN_KEY, by session or Bearer. `api-key`: a Bearer API key. */
  via: Schema.Literals(["session-member", "session-key", "admin-key", "api-key"]),
  /** The key behind the request; null for the admin key and for people. */
  key: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String, prefix: Schema.String })),
  scopes: Schema.Array(Scope),
  /** What the caller may do (`mail.read`, `campaigns.write`, `members.manage`, …), from the role for
   * a person and the scopes for a key, so screens hide what the API would refuse. */
  permissions: Schema.Array(Schema.String),
  /** For a person: the mailboxes they can open, with their access where they've been given one
   * (null where their role reads every mailbox). Null for keys. */
  mailboxes: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        address: Schema.String,
        access: Schema.NullOr(Schema.Literals(["owner", "member", "viewer"])),
      }),
    ),
  ),
  workspaces: Schema.Array(Workspace),
  /** The browser session, when the request came with one. */
  session: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      /** 14 days from now, or the absolute cap if that comes first. */
      expiresAt: Schema.Number,
      /** 30 days after sign-in: the session ends then whatever its use. */
      absoluteExpiresAt: Schema.Number,
    }),
  ),
})

export const SessionSummary = Schema.Struct({
  id: Schema.String,
  /** The session this request came with. */
  current: Schema.Boolean,
  via: Schema.Literals(["session-key", "admin-key", "session-member"]),
  key: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      prefix: Schema.String,
      scopes: Schema.Array(Scope),
    }),
  ),
  userAgent: Schema.NullOr(Schema.String),
  ip: Schema.NullOr(Schema.String),
  /** City and country from Cloudflare, when it knew them. */
  location: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  lastSeenAt: Schema.Number,
  expiresAt: Schema.Number,
  absoluteExpiresAt: Schema.Number,
})

/**
 * Signing in and out of the web app. `POST /v1/session` exchanges a key (it needs the `read` scope)
 * for the HTTP-only cookie `__Host-mailyard_session` (Secure, SameSite=Lax) and answers like
 * `GET /v1/me`; the key is never stored or put in the cookie. Sessions last 14 days from their last
 * use and 30 days at most. `DELETE /v1/session` signs out (204, idempotent) and clears the cookie.
 */
export class SessionApi extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("signIn", "/v1/session", {
    payload: Schema.Struct({ key: Schema.NonEmptyString.check(Schema.isMaxLength(512)) }),
    success: Me,
    error: [Unauthorized, Forbidden, RateLimited],
  }),
  HttpApiEndpoint.delete("signOut", "/v1/session", {
    success: HttpApiSchema.NoContent,
    error: Forbidden,
  }),
) {}

/** Who's signed in, and their sessions ("Your sessions" in Settings). */
export class MeApi extends HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("me", "/v1/me", { success: Me }),
    /** A signed-in person changes their own name and time zone. */
    HttpApiEndpoint.patch("updateMe", "/v1/me", {
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
        timeZone: Schema.optionalKey(Schema.String),
      }),
      success: Me,
      error: [Forbidden, InvalidRequest],
    }),
    HttpApiEndpoint.get("listSessions", "/v1/sessions", {
      success: Schema.Struct({ sessions: Schema.Array(SessionSummary) }),
    }),
    /** Sign out everywhere else: ends every session of this key except the current one. */
    HttpApiEndpoint.delete("endOtherSessions", "/v1/sessions", {
      success: Schema.Struct({ ended: Schema.Number }),
    }),
    HttpApiEndpoint.delete("endSession", "/v1/sessions/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// People: members, roles, invitations and claiming the workspace (HAL-3361)
// ---------------------------------------------------------------------------------------------

const InviteRole = Schema.Literals(["admin", "sender", "agent", "viewer"])
const MailboxAccess = Schema.Literals(["owner", "member", "viewer"])
const MailboxGrant = Schema.Struct({ mailboxId: Schema.String, access: MailboxAccess })

export const MemberSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: MemberRole,
  timeZone: Schema.String,
  createdAt: Schema.Number,
  lastActiveAt: Schema.NullOr(Schema.Number),
})

export const MemberDetail = Schema.Struct({
  ...MemberSchema.fields,
  /** Mailboxes they've been given. Owners, admins, senders and viewers read the rest by role. */
  mailboxes: Schema.Array(Schema.Struct({ ...MailboxGrant.fields, address: Schema.String })),
})

export const InviteSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: InviteRole,
  mailboxes: Schema.Array(MailboxGrant),
  message: Schema.NullOr(Schema.String),
  /** The name of the person who invited; null when a key (or the admin key) did, as in the public view. */
  invitedBy: Schema.NullOr(Schema.String),
  /** Who invited, for the audit trail: a member id, a key id, or `root` for the admin key. */
  invitedById: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  /** When the invitation email last went out; null while it's a draft. */
  sentAt: Schema.NullOr(Schema.Number),
  sendCount: Schema.Number,
  status: Schema.Literals(["draft", "sent", "expired", "accepted", "revoked"]),
})

/** Signing in without a key: a link mailed to a member (no sign-in needed to ask for one). */
export class SignInLinkApi extends HttpApiGroup.make("signInLink").add(
  /** Mails a sign-in link if the address belongs to a member. The answer never says whether it does. */
  HttpApiEndpoint.post("request", "/v1/session/link", {
    payload: Schema.Struct({ email: Schema.String.check(Schema.isMaxLength(254)) }),
    success: Schema.Struct({ sent: Schema.Boolean }).pipe(HttpApiSchema.status(202)),
    error: [RateLimited, NoSystemSender, Forbidden],
  }),
  /** Uses a link's token (the app's own sign-in screen); sets the session cookie like `POST /v1/session`.
   * Opening the link itself shows a page with the same button (`GET /v1/session/link/{token}`). */
  HttpApiEndpoint.post("verify", "/v1/session/link/verify", {
    payload: Schema.Struct({ token: Schema.NonEmptyString.check(Schema.isMaxLength(256)) }),
    success: Me,
    error: [InvalidRequest, Gone, RateLimited, Forbidden],
  }),
) {}

/** An invitation, seen and accepted by the person invited: the token is the credential. */
export class InviteLinkApi extends HttpApiGroup.make("inviteLink").add(
  HttpApiEndpoint.get("describe", "/v1/invites/:token", {
    params: { token: Schema.String },
    success: Schema.Struct({
      email: Schema.String,
      role: InviteRole,
      workspace: Schema.String,
      invitedBy: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Schema.String),
      expiresAt: Schema.Number,
      mailboxes: Schema.Array(
        Schema.Struct({ ...MailboxGrant.fields, address: Schema.NullOr(Schema.String) }),
      ),
    }),
    error: [NotFound, Gone],
  }),
  /** Joins and signs in (sets the session cookie). `409 email-mismatch` when signed in as someone else. */
  HttpApiEndpoint.post("accept", "/v1/invites/:token/accept", {
    params: { token: Schema.String },
    payload: [
      Schema.Struct({ name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))) }),
      Schema.Null,
    ],
    success: Me,
    error: [NotFound, Gone, Conflict, Forbidden],
  }),
) {}

/** Members, invitations and the workspace itself. Managing people needs `members.manage`. */
export class PeopleApi extends HttpApiGroup.make("people")
  .add(
    /** The person holding the admin key names the workspace and becomes its owner; a sign-in link is
     * mailed to them. Once only: `409 already-claimed` with `claimedBy` and `claimedAt`. */
    HttpApiEndpoint.post("claim", "/v1/workspace/claim", {
      payload: Schema.Struct({
        workspaceName: Schema.String.check(Schema.isMaxLength(120)),
        name: Schema.String.check(Schema.isMaxLength(120)),
        email: Schema.String.check(Schema.isMaxLength(254)),
      }),
      success: Schema.Struct({ member: MemberSchema, signInLinkSent: Schema.Boolean }),
      error: [Forbidden, Conflict, InvalidRequest],
    }),
    /** The owner hands ownership on, and becomes an admin. */
    HttpApiEndpoint.post("transfer", "/v1/workspace/transfer", {
      payload: Schema.Struct({ memberId: Schema.String }),
      success: MemberSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    HttpApiEndpoint.get("listMembers", "/v1/members", {
      success: Schema.Struct({ members: Schema.Array(MemberDetail), invites: Schema.Array(InviteSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("getMember", "/v1/members/:id", {
      params: { id: Schema.String },
      success: MemberDetail,
      error: [Forbidden, NotFound],
    }),
    /** Role, name, time zone and mailboxes. The owner can't be demoted (`403 owner`); a new role ends
     * their sessions so it applies at once. */
    HttpApiEndpoint.patch("updateMember", "/v1/members/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        role: Schema.optionalKey(InviteRole),
        name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
        timeZone: Schema.optionalKey(Schema.String),
        mailboxes: Schema.optionalKey(Schema.Array(MailboxGrant)),
      }),
      success: MemberDetail,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** Removes someone: their sessions end and their mailboxes are taken back. Not the owner. */
    HttpApiEndpoint.delete("removeMember", "/v1/members/:id", {
      params: { id: Schema.String },
      success: MemberSchema,
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.get("listInvites", "/v1/invites", {
      success: Schema.Struct({ invites: Schema.Array(InviteSchema) }),
      error: Forbidden,
    }),
    /** Drafts an invitation and returns the email it would send. Nothing goes out until `…/send`. */
    HttpApiEndpoint.post("createInvite", "/v1/invites", {
      payload: Schema.Struct({
        email: Schema.String.check(Schema.isMaxLength(254)),
        role: InviteRole,
        mailboxes: Schema.optionalKey(Schema.Array(MailboxGrant)),
        message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
      }),
      success: Schema.Struct({
        invite: InviteSchema,
        draft: Schema.Struct({
          /** Null when no system sender is set: sending will answer 503 until one is. */
          from: Schema.NullOr(Schema.String),
          to: Schema.String,
          subject: Schema.String,
          html: Schema.String,
          text: Schema.String,
        }),
      }),
      error: [Forbidden, Conflict, InvalidRequest],
    }),
    /** Sends the invitation: a fresh link (any earlier one stops working) for another 7 days. */
    HttpApiEndpoint.post("sendInvite", "/v1/invites/:id/send", {
      params: { id: Schema.String },
      payload: [Schema.Struct({}), Schema.Null],
      success: InviteSchema,
      error: [Forbidden, NotFound, Gone, Conflict, NoSystemSender],
    }),
    HttpApiEndpoint.post("resendInvite", "/v1/invites/:id/resend", {
      params: { id: Schema.String },
      payload: [Schema.Struct({}), Schema.Null],
      success: InviteSchema,
      error: [Forbidden, NotFound, Gone, Conflict, NoSystemSender],
    }),
    HttpApiEndpoint.delete("revokeInvite", "/v1/invites/:id", {
      params: { id: Schema.String },
      success: InviteSchema,
      error: [Forbidden, NotFound, Gone],
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Deleting the workspace (HAL-3448)
// ---------------------------------------------------------------------------------------------

const DeletionSchema = Schema.Struct({
  requestedAt: Schema.Number,
  /** The member (or `root`, the admin key) who asked. */
  requestedBy: Schema.String,
  /** When everything is deleted: 7 days after the request. */
  deletesAt: Schema.Number,
  /** The full export started with the request; its files outlive the deletion. */
  exportId: Schema.String,
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
})

/**
 * Deleting the workspace: the owner (or the admin key, before anyone owns it) types its name, an
 * export starts at once, and everything is deleted 7 days later unless restored. Meanwhile sending
 * answers `409 { reason: "workspace-deleting", deletesAt }`, mail still arrives, and every response
 * carries `x-workspace-deleting: <deletesAt>`.
 */
export class WorkspaceApi extends HttpApiGroup.make("workspace")
  .add(
    HttpApiEndpoint.delete("delete", "/v1/workspace", {
      payload: Schema.Struct({
        /** The workspace's name, exactly as `GET /v1/me` shows it. */
        confirm: Schema.String.check(Schema.isMaxLength(200)),
      }),
      success: DeletionSchema.pipe(HttpApiSchema.status(202)),
      error: [Forbidden, Conflict, InvalidRequest],
    }),
    /** Calls the deletion off while its 7 days run. */
    HttpApiEndpoint.post("restore", "/v1/workspace/restore", {
      payload: [Schema.Struct({}), Schema.Null],
      success: Schema.Struct({ restored: Schema.Literal(true) }),
      error: [Forbidden, Conflict, InvalidRequest],
    }),
    /** `none`, `scheduled`, `deleting` or `deleted`; after the deletion, the owner gets fresh links
     * (a day each) to the export it kept. */
    HttpApiEndpoint.get("deletion", "/v1/workspace/deletion", {
      success: Schema.Struct({
        status: Schema.Literals(["none", "scheduled", "deleting", "deleted"]),
        deletion: Schema.NullOr(DeletionSchema),
        files: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
      }),
      error: Forbidden,
    }),
  )
  .middleware(ApiKeyAuth) {}

// ---------------------------------------------------------------------------------------------
// Agents, send limits and approvals (HAL-3460)
// ---------------------------------------------------------------------------------------------

export const LimitsSchema = Schema.Struct({
  /** Messages a UTC day; null for no cap. Over it: `409 { reason: "agent_limit", limit, sentToday, resetsAt }`. */
  sendsPerDay: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  /** Who it may write to: anyone, people already in contacts, or the listed domains (subdomains too).
   * Outside it: `409 { reason: "recipient_not_allowed", notAllowed }`. */
  recipients: Schema.Literals(["any", "contacts", "domains"]),
  allowDomains: Schema.Array(Schema.String.check(Schema.isMaxLength(253))).check(Schema.isMaxLength(100)),
  /** Every send waits in `GET /v1/approvals` for a person's yes. */
  requireApproval: Schema.Boolean,
})

const AgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mailbox: Schema.Struct({ id: Schema.String, address: Schema.NullOr(Schema.String) }),
  key: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      prefix: Schema.String,
      scopes: Schema.Array(Scope),
      lastUsedAt: Schema.NullOr(Schema.Number),
      revoked: Schema.Boolean,
    }),
  ),
  limits: Schema.NullOr(LimitsSchema),
  sentToday: Schema.Number,
  pendingApprovals: Schema.Number,
  createdAt: Schema.Number,
  removedAt: Schema.NullOr(Schema.Number),
})

/**
 * Agents: an AI agent's own mailbox and the MCP key that uses it, made together, with limits on
 * what the key may send. Managing them needs `agents.manage` (owners and admins; the admin scope).
 */
export class AgentsApi extends HttpApiGroup.make("agents")
  .add(
    /** The mailbox, a `purpose: mcp` key that owns it, and its limits. The key is shown once, here,
     * with the `claude mcp add` command that uses it. */
    HttpApiEndpoint.post("create", "/v1/agents", {
      payload: Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
        address: Schema.String.check(Schema.isMaxLength(254)),
        displayName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
        /** `read` and `send` unless given; never `admin`. */
        scopes: Schema.optionalKey(Schema.Array(Scope)),
        limits: Schema.optionalKey(LimitsSchema),
      }),
      success: Schema.Struct({
        agent: AgentSchema,
        key: Schema.String,
        mcp: Schema.Struct({ url: Schema.String, command: Schema.String }),
      }),
      error: [Forbidden, InvalidRequest, Conflict, NotFound],
    }),
    HttpApiEndpoint.get("list", "/v1/agents", {
      success: Schema.Struct({ agents: Schema.Array(AgentSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/agents/:id", {
      params: { id: Schema.String },
      success: AgentSchema,
      error: [Forbidden, NotFound],
    }),
    /** Its name, and its limits (null removes them). */
    HttpApiEndpoint.patch("update", "/v1/agents/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
        limits: Schema.optionalKey(Schema.NullOr(LimitsSchema)),
      }),
      success: AgentSchema,
      error: [Forbidden, NotFound, InvalidRequest],
    }),
    /** Revokes its key at once; its mailbox and mail stay. Its pending sends are rejected. */
    HttpApiEndpoint.delete("remove", "/v1/agents/:id", {
      params: { id: Schema.String },
      success: AgentSchema,
      error: [Forbidden, NotFound],
    }),
    /** Any key's limits (an agent's or not). */
    HttpApiEndpoint.get("getLimits", "/v1/api-keys/:id/limits", {
      params: { id: Schema.String },
      success: Schema.Struct({ limits: Schema.NullOr(LimitsSchema), sentToday: Schema.Number }),
      error: [Forbidden, NotFound],
    }),
    HttpApiEndpoint.put("putLimits", "/v1/api-keys/:id/limits", {
      params: { id: Schema.String },
      payload: Schema.Struct({ limits: Schema.NullOr(LimitsSchema) }),
      success: Schema.Struct({ limits: Schema.NullOr(LimitsSchema), sentToday: Schema.Number }),
      error: [Forbidden, NotFound, InvalidRequest],
    }),
  )
  .middleware(ApiKeyAuth) {}

const ApprovalSchema = Schema.Struct({
  id: Schema.String,
  /** The key that asked to send. */
  keyId: Schema.String,
  kind: Schema.Literals(["transactional", "draft"]),
  mailboxId: Schema.NullOr(Schema.String),
  draftId: Schema.NullOr(Schema.String),
  recipients: Schema.Array(Schema.String),
  subject: Schema.String,
  from: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "approved", "rejected", "failed"]),
  createdAt: Schema.Number,
  decidedAt: Schema.NullOr(Schema.Number),
  decidedBy: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  /** What approving it did: the emails sent, or the draft's send time (it still waits the undo window). */
  result: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
})

/**
 * Sends held for a person's yes, from keys whose limits say `requireApproval`. Raises the
 * `approval_pending` alert and the `approval.pending` webhook. Deciding needs `approvals.manage`.
 */
export class ApprovalsApi extends HttpApiGroup.make("approvals")
  .add(
    HttpApiEndpoint.get("list", "/v1/approvals", {
      query: { status: Schema.optionalKey(Schema.Literals(["pending", "approved", "rejected", "failed"])) },
      success: Schema.Struct({ approvals: Schema.Array(ApprovalSchema) }),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("get", "/v1/approvals/:id", {
      params: { id: Schema.String },
      success: ApprovalSchema,
      error: [Forbidden, NotFound],
    }),
    /** Sends it through the path it was held on, as the key that asked. */
    HttpApiEndpoint.post("approve", "/v1/approvals/:id/approve", {
      params: { id: Schema.String },
      payload: [Schema.Struct({}), Schema.Null],
      success: ApprovalSchema,
      error: [Forbidden, NotFound, Conflict, InvalidRequest],
    }),
    HttpApiEndpoint.post("reject", "/v1/approvals/:id/reject", {
      params: { id: Schema.String },
      payload: [
        Schema.Struct({ reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))) }),
        Schema.Null,
      ],
      success: ApprovalSchema,
      error: [Forbidden, NotFound, Conflict],
    }),
  )
  .middleware(ApiKeyAuth) {}

export class MailApi extends HttpApi.make("mailyard")
  .add(SystemApi)
  .add(ActionsApi)
  .add(ApiKeysApi)
  .add(MessagesApi)
  .add(TemplatesApi)
  .add(SettingsApi)
  .add(WebhooksApi)
  .add(InsightsApi)
  .add(InboundApi)
  .add(DomainsApi)
  .add(MailboxesApi)
  .add(IdentitiesApi)
  .add(MailApiGroup)
  .add(RulesApi)
  .add(TransfersApi)
  .add(ContactsApi)
  .add(TopicsApi)
  .add(FormsApi)
  .add(SegmentsApi)
  .add(SendingApi)
  .add(AlertsApi)
  .add(CampaignsApi)
  .add(ImportsApi)
  .add(PublicFormsApi)
  .add(FilesApi)
  .add(SuppressionsApi)
  .add(OverviewApi)
  .add(SearchApi)
  .add(ExportsApi)
  .add(AutomationsApi)
  .add(RunsApi)
  .add(SessionApi)
  .add(MeApi)
  .add(SignInLinkApi)
  .add(InviteLinkApi)
  .add(PeopleApi)
  .add(WorkspaceApi)
  .add(AgentsApi)
  .add(ApprovalsApi)
  .annotateMerge(OpenApi.annotations({ title: "Mailyard API", transform: withRawRoutes })) {}

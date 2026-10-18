import { and, desc, eq, gte, lt, or } from "drizzle-orm"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import pkg from "../../package.json" with { type: "json" }
import { Bindings } from "../Bindings.ts"
import { messageEvents, messagesOut } from "../db/schema.ts"
import { type AgentLimited, checkSend, holdSend } from "../domain/agents.ts"
import {
  authenticate,
  type Caller,
  createKey,
  listKeys,
  requests24h,
  revokeKey,
  rotateKey,
  type Scope,
} from "../domain/apiKeys.ts"
import { track } from "../domain/events.ts"
import { claim, complete, release } from "../domain/idempotency.ts"
import { sentHeaders } from "../domain/messageRaw.ts"
import { decodeRendered, sendTransactional } from "../domain/outbox.ts"
import { allowedRoles, can, type Permission } from "../domain/permissions.ts"
import { resolveSession, SESSION_COOKIE } from "../domain/sessions.ts"
import type { SecretBox, WebhookQueue } from "../domain/webhooks.ts"
import { refuseWhileDeleting } from "../domain/workspaceDeletion.ts"
import type { ImapConnector } from "../imports/importer.ts"
import type { InboundQueue } from "../inbound/pipeline.ts"
import { BlobStore, type Ids, type Sender } from "../kit/index.ts"
import { grantForKey, revokeGrant } from "../oauth/grants.ts"
import { linkOrigin } from "../public/origin.ts"
import type { Assistant } from "../services/Assistant.ts"
import type { Classifier } from "../services/Classifier.ts"
import type { CloudflareEmail } from "../services/CloudflareEmail.ts"
import type { CloudflareZones } from "../services/CloudflareZones.ts"
import { Database } from "../services/Database.ts"
import type { Dns } from "../services/Dns.ts"
import type { Governor } from "../services/Governor.ts"
import type { Mailboxes } from "../services/Mailboxes.ts"
import type { SendQueue } from "../services/SendQueue.ts"
import {
  type ApiKeySummary,
  Conflict,
  IdempotencyConflict,
  InvalidRequest,
  MailApi,
  NotFound,
  type SendPayload,
  Unhealthy,
  Unprocessable,
} from "./Api.ts"
import { ApiKeyAuth, CurrentCaller, Forbidden, RateLimited, Unauthorized } from "./Auth.ts"

/** Methods that change nothing, so a cross-site request can't do harm with them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** A URL's origin, or null for something that isn't a URL. */
const urlOrigin = (url: string | undefined) => {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Whether a request came from this site: its `Origin` header is this request's origin or the
 * workspace's public origin (`MAILYARD_PUBLIC_ORIGIN`), or (when a browser sends no Origin)
 * `Sec-Fetch-Site` says same-origin. A cookie-signed write that is neither is refused, which with
 * SameSite=Lax closes cross-site request forgery (HAL-3358).
 */
export const sameOrigin = (request: HttpServerRequest.HttpServerRequest, publicOrigin?: string) => {
  const origin = request.headers.origin
  if (origin) return origin === urlOrigin(request.originalUrl) || origin === urlOrigin(publicOrigin)
  return request.headers["sec-fetch-site"] === "same-origin"
}

/** Expires the session cookie on the response (sign-out, or a session that no longer works). */
export const clearSessionCookie = HttpEffect.appendPreResponseHandler((_req, response) =>
  Effect.orDie(
    HttpServerResponse.setCookie(response, SESSION_COOKIE, "", {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
  ),
)

/** Failed sign-in attempts count against the caller's address; past the limit, they wait. */
export const throttle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const ip = request.headers["cf-connecting-ip"] ?? "unknown"
  const limiter = (yield* Bindings).AUTH_LIMITER
  if (!limiter) return
  const { success } = yield* Effect.promise(() => limiter.limit({ key: `auth:${ip}` }))
  if (!success)
    return yield* new RateLimited({
      message: "Too many failed attempts from your address. Wait a minute and try again.",
      retryAfter: 60,
    })
})

export const ApiKeyAuthLive = Layer.effect(
  ApiKeyAuth,
  Effect.gen(function* () {
    const database = yield* Database
    const bindings = yield* Bindings
    const byKey = (token: string) =>
      authenticate(token).pipe(
        Effect.catchTag("InvalidKey", (e) =>
          throttle.pipe(
            Effect.andThen(
              new Unauthorized({
                message: e.reason,
                reason: e.code,
                ...(e.revokedAt !== undefined ? { revokedAt: e.revokedAt } : {}),
              }),
            ),
          ),
        ),
      )
    const bySession = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = request.cookies[SESSION_COOKIE]
      if (!token)
        return yield* new Unauthorized({
          message: "Send your API key as Authorization: Bearer <key>, or sign in at POST /v1/session.",
          reason: "missing",
        })
      const caller = yield* resolveSession(token).pipe(
        Effect.catchTag("SessionExpired", (e) =>
          clearSessionCookie.pipe(
            Effect.andThen(throttle),
            Effect.andThen(new Unauthorized({ message: e.message, reason: "session-expired" })),
          ),
        ),
      )
      if (!SAFE_METHODS.has(request.method) && !sameOrigin(request, bindings.MAILYARD_PUBLIC_ORIGIN))
        return yield* new Forbidden({
          message:
            "This request was signed in by the session cookie but didn't come from this site, so it was refused. Reload the page and try again.",
          reason: "csrf",
        })
      return caller
    })
    return ApiKeyAuth.of({
      bearer: (httpEffect, { credential }) => {
        const token = Redacted.value(credential)
        return (token ? byKey(token) : bySession).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Bindings, bindings),
          Effect.flatMap((caller) => Effect.provideService(httpEffect, CurrentCaller, caller)),
        )
      },
    })
  }),
)

/** The app's services, captured when a handler group is built and provided to each request. */
export const provideTo =
  <C>(context: Context.Context<C>) =>
  <Args extends ReadonlyArray<unknown>, A, E, R>(handler: (...args: Args) => Effect.Effect<A, E, R>) =>
  (...args: Args) =>
    handler(...args).pipe(Effect.provideContext(context))

export const appContext = Effect.context<
  | Database
  | Bindings
  | BlobStore
  | Ids
  | Sender
  | SendQueue
  | WebhookQueue
  | SecretBox
  | CloudflareEmail
  | CloudflareZones
  | Mailboxes
  | Governor
  | InboundQueue
  | Dns
  | Classifier
  | Assistant
  | ImapConnector
>()

/** A send a key's limits refused (HAL-3460), as the 409 the caller reads. */
export const agentConflict = (e: AgentLimited) =>
  new Conflict({
    reason: e.reason,
    message: e.message,
    ...(e.limit !== undefined ? { limit: e.limit } : {}),
    ...(e.sentToday !== undefined ? { sentToday: e.sentToday } : {}),
    ...(e.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}),
    ...(e.notAllowed !== undefined ? { notAllowed: [...e.notAllowed] } : {}),
  })

/**
 * The endpoints that send call this first: while the workspace is being deleted (HAL-3448) they
 * answer `409 { reason: "workspace-deleting", deletesAt }` instead.
 */
export const notWhileDeleting = refuseWhileDeleting().pipe(
  Effect.catchTag("WorkspaceDeleting", (e) =>
    Effect.fail(
      new Conflict({
        reason: "workspace-deleting",
        message: `The workspace is being deleted on ${new Date(e.deletesAt).toUTCString()}, so nothing more is sent. Restore it to send again.`,
        deletesAt: e.deletesAt,
      }),
    ),
  ),
)

/** The refusal for a person whose role doesn't hold a permission (HAL-3361). */
export const roleRefusal = (caller: Caller, permission: Permission) =>
  new Forbidden({
    message: `Your role (${caller.member?.role}) can't do this. Ask an owner or admin.`,
    reason: "role",
    required: permission,
    ...(caller.member ? { role: caller.member.role } : {}),
    allowedRoles: [...allowedRoles(permission)],
  })

/**
 * The caller, if it may do this: a key needs `scope` (as it always has), a signed-in person needs
 * `permission` from their role (src/domain/permissions.ts).
 */
export const requireScope = (scope: Scope, permission: Permission) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    if (caller.member) {
      if (!can(caller, permission)) return yield* roleRefusal(caller, permission)
      return caller
    }
    if (!caller.scopes.includes(scope)) {
      return yield* new Forbidden(
        caller.kind === "public"
          ? {
              message: "Public keys (pk_) can only track events; use a secret key (sk_).",
              reason: "public-key",
              required: scope,
              scopes: [...caller.scopes],
            }
          : {
              message: `This key lacks the "${scope}" scope.`,
              reason: "insufficient-scope",
              required: scope,
              scopes: [...caller.scopes],
            },
      )
    }
    return caller
  })

export const SystemHandlers = HttpApiBuilder.group(
  MailApi,
  "system",
  Effect.fn(function* (handlers) {
    const database = yield* Database
    return handlers.handleAll({
      health: () =>
        database.ping.pipe(
          Effect.as({ status: "ok", app: "mailyard", version: pkg.version, database: "ok" } as const),
          Effect.catchTag("DatabaseError", (e) =>
            Effect.logError("health check: database unreachable", e.cause).pipe(
              Effect.andThen(Effect.fail(new Unhealthy({ database: "unreachable" }))),
            ),
          ),
        ),
    })
  }),
)

const normalizeRecipients = (to: SendPayload["to"]) =>
  (Array.isArray(to) ? to : [to]).map((r) => (typeof r === "string" ? { email: r } : r))

/** Runs `body` under an Idempotency-Key when the client sent one: first use runs, a repeat replays. */
export const idempotent = <A, E, R>(
  caller: Caller,
  route: string,
  key: string | undefined,
  payload: unknown,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!key) return yield* body
    const result = yield* claim({ apiKeyId: caller.keyId, key, route, body: payload }).pipe(Effect.orDie)
    if (result.kind === "conflict") return yield* new IdempotencyConflict({ message: result.reason })
    if (result.kind === "replay") return result.response as A
    return yield* body.pipe(
      Effect.tap((response) =>
        complete({ apiKeyId: caller.keyId, key, status: 200, response }).pipe(Effect.orDie),
      ),
      Effect.tapError(() => release(caller.keyId, key).pipe(Effect.orDie)),
    )
  })

export const ActionsHandlers = HttpApiBuilder.group(
  MailApi,
  "actions",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      send: p(({ payload, headers, request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("send", "email.send")
          yield* notWhileDeleting
          const from =
            payload.from === undefined
              ? undefined
              : typeof payload.from === "string"
                ? { email: payload.from, name: payload.name }
                : { email: payload.from.email, name: payload.from.name ?? payload.name }
          const outgoing = {
            recipients: normalizeRecipients(payload.to),
            subject: payload.subject,
            body: payload.body,
            from,
            reply: payload.reply,
            headers: payload.headers,
            data: payload.data,
            template: payload.template,
            subscribed: payload.subscribed,
            attachments: payload.attachments,
            track: payload.track
              ? {
                  opens: payload.track.opens ?? false,
                  clicks: payload.track.clicks ?? false,
                  origin: linkOrigin(request.originalUrl) ?? "",
                }
              : undefined,
            apiKeyId: caller.keyId,
            idempotencyKey: headers["idempotency-key"],
          }
          const run = Effect.gen(function* () {
            // The key's guardrails (HAL-3460): allow-list, daily cap, or a hold for a person's yes.
            const recipients = outgoing.recipients.map((r) => r.email)
            const decision = yield* checkSend(caller, {
              recipients,
              messages: recipients.length,
              holdable: true,
              what: "this email",
            })
            if (decision === "hold") {
              const approval = yield* holdSend(caller, {
                kind: "transactional",
                request: JSON.parse(JSON.stringify(outgoing)) as Record<string, unknown>,
                recipients,
                subject: payload.subject ?? `Template ${payload.template ?? ""}`.trim(),
                from: from?.email ?? null,
              })
              return {
                success: true as const,
                data: { emails: [], timestamp: new Date().toISOString(), approval },
              }
            }
            const emails = yield* sendTransactional(outgoing)
            return { success: true as const, data: { emails, timestamp: new Date().toISOString() } }
          }).pipe(
            Effect.catchTags({
              AgentLimited: (e) => Effect.fail(agentConflict(e)),
              SendRequestInvalid: (e) =>
                Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
              TemplateMissing: (e) =>
                Effect.fail(new NotFound({ message: `Template ${e.template}: ${e.reason}.` })),
              InvalidMessage: (e) => Effect.fail(new Unprocessable({ message: e.reason })),
            }),
            Effect.catchTags({
              DatabaseError: Effect.die,
              BlobStoreError: Effect.die,
              TrackingKeyMissing: Effect.die,
            }),
          )
          return yield* idempotent(caller, "send", headers["idempotency-key"], payload, run)
        }),
      ),
      track: p(({ payload, headers }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("track", "events.track")
          const run = track(payload).pipe(
            Effect.map((data) => ({ success: true as const, data })),
            Effect.catchTag("ReservedEvent", (e) =>
              Effect.fail(
                new InvalidRequest({
                  field: "event",
                  message: `Event name "${e.event}" is reserved for system use.`,
                }),
              ),
            ),
            Effect.catchTag("DatabaseError", Effect.die),
          )
          return yield* idempotent(caller, "track", headers["idempotency-key"], payload, run)
        }),
      ),
    })
  }),
)

const summarizeKey = (row: {
  id: string
  name: string
  kind: "secret" | "public"
  purpose: "api" | "mcp"
  prefix: string
  scopes: ReadonlyArray<string>
  createdBy: string | null
  lastUsedAt: number | null
  revokedAt: number | null
  createdAt: number
}): typeof ApiKeySummary.Type => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  purpose: row.purpose,
  prefix: row.prefix,
  scopes: [...row.scopes],
  createdBy: row.createdBy,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
})

export const ApiKeysHandlers = HttpApiBuilder.group(
  MailApi,
  "apiKeys",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("admin", "keys.manage").pipe(
          Effect.andThen(listKeys(query.purpose)),
          Effect.flatMap((rows) =>
            query.include === "usage"
              ? requests24h(rows.map((r) => r.id)).pipe(
                  Effect.map((usage) => ({
                    keys: rows.map((r) => ({ ...summarizeKey(r), requests24h: usage.get(r.id) ?? 0 })),
                  })),
                )
              : Effect.succeed({ keys: rows.map(summarizeKey) }),
          ),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin", "keys.manage").pipe(
          Effect.tap(() =>
            payload.kind === "public" && payload.purpose === "mcp"
              ? Effect.fail(
                  new InvalidRequest({
                    field: "purpose",
                    message: "Public keys can only track events, so /mcp refuses them. Use a secret key.",
                  }),
                )
              : Effect.void,
          ),
          Effect.flatMap((caller) =>
            createKey({
              name: payload.name,
              kind: payload.kind,
              scopes: payload.scopes,
              purpose: payload.purpose,
              createdBy: caller.keyId,
            }),
          ),
          Effect.map(({ key, record }) => ({ key, apiKey: summarizeKey(record) })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      rotate: p(({ params, payload }) =>
        requireScope("admin", "keys.manage").pipe(
          Effect.flatMap((caller) => rotateKey(params.id, payload.graceSeconds ?? 0, caller.keyId)),
          Effect.map(({ key, record, previous }) => ({ key, apiKey: summarizeKey(record), previous })),
          Effect.catchTags({
            KeyNotFound: (e) => Effect.fail(new NotFound({ message: `No active API key ${e.id}.` })),
            DatabaseError: Effect.die,
          }),
        ),
      ),
      revoke: p(({ params }) =>
        requireScope("admin", "keys.manage").pipe(
          Effect.andThen(revokeKey(params.id)),
          // An OAuth client's key ends its grant too, so it leaves Integrations (HAL-3462).
          Effect.tap((row) =>
            row
              ? grantForKey(row.id).pipe(
                  Effect.flatMap((g) => (g ? revokeGrant(g.id, "key-revoked", "keys") : Effect.void)),
                )
              : Effect.void,
          ),
          Effect.flatMap((row) =>
            row
              ? Effect.succeed(summarizeKey(row))
              : Effect.fail(new NotFound({ message: `API key ${params.id} not found.` })),
          ),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
    })
  }),
)

const SOURCE = {
  transactional: "api",
  campaign: "campaign",
  automation: "automation",
  reply: "mailbox",
  mailbox: "mailbox",
  test: "test",
  system: "system",
} as const

/** An API send's key is stored as `apiKeyId:key:recipientIndex` to keep rows unique; show the caller's own. */
const clientIdempotencyKey = (row: typeof messagesOut.$inferSelect) =>
  row.idempotencyKey && row.stream === "transactional" && row.apiKeyId
    ? row.idempotencyKey.slice(row.apiKeyId.length + 1).replace(/:\d+$/, "")
    : row.idempotencyKey

const summarizeMessage = (row: typeof messagesOut.$inferSelect) => ({
  id: row.id,
  stream: row.stream,
  source: SOURCE[row.stream],
  recipient: row.recipient,
  sender: row.sender,
  subject: row.subject,
  status: row.status,
  bounceType: row.bounceType,
  provider: row.provider,
  error: row.error,
  attempts: row.attempts,
  cfMessageId: row.cfMessageId,
  templateId: row.templateId,
  templateVersion: row.templateVersion,
  apiKeyId: row.apiKeyId,
  campaignId: row.campaignId,
  tracked: row.tracked,
  firstOpenedAt: row.firstOpenedAt,
  firstClickedAt: row.firstClickedAt,
  opens: row.opens,
  clicks: row.clicks,
  machineOpens: row.machineOpens,
  machineClicks: row.machineClicks,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const _originOfUrl = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return ""
  }
}

const party = (p: { email: string; name?: string }) => (p.name ? `${p.name} <${p.email}>` : p.email)

export const MessagesHandlers = HttpApiBuilder.group(
  MailApi,
  "messages",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    const database = yield* Database
    const store = yield* BlobStore
    return handlers.handleAll({
      list: p(({ query }) =>
        Effect.gen(function* () {
          yield* requireScope("read", "analytics.read")
          const limit = query.limit ?? 50
          const [cursorAt, cursorId] = query.cursor ? query.cursor.split(":") : []
          const rows = yield* database
            .query("messages.list", (db) =>
              db
                .select()
                .from(messagesOut)
                .where(
                  and(
                    query.status ? eq(messagesOut.status, query.status) : undefined,
                    query.recipient ? eq(messagesOut.recipient, query.recipient.toLowerCase()) : undefined,
                    query.stream ? eq(messagesOut.stream, query.stream) : undefined,
                    query.templateId ? eq(messagesOut.templateId, query.templateId) : undefined,
                    query.from !== undefined ? gte(messagesOut.createdAt, query.from) : undefined,
                    query.to !== undefined ? lt(messagesOut.createdAt, query.to) : undefined,
                    // Each branch is an index lookup: the primary key, the Cloudflare id, a recipient range.
                    query.q
                      ? or(
                          eq(messagesOut.id, query.q.trim()),
                          eq(messagesOut.cfMessageId, query.q.trim()),
                          and(
                            gte(messagesOut.recipient, query.q.trim().toLowerCase()),
                            lt(messagesOut.recipient, `${query.q.trim().toLowerCase()}\uffff`),
                          ),
                        )
                      : undefined,
                    cursorAt && cursorId
                      ? or(
                          lt(messagesOut.createdAt, Number(cursorAt)),
                          and(eq(messagesOut.createdAt, Number(cursorAt)), lt(messagesOut.id, cursorId)),
                        )
                      : undefined,
                  ),
                )
                .orderBy(desc(messagesOut.createdAt), desc(messagesOut.id))
                .limit(limit + 1)
                .all(),
            )
            .pipe(Effect.orDie)
          const page = rows.slice(0, limit)
          const last = page.at(-1)
          return {
            messages: page.map(summarizeMessage),
            nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
          }
        }),
      ),
      get: p(({ params }) =>
        Effect.gen(function* () {
          yield* requireScope("read", "analytics.read")
          const row = yield* database
            .query("messages.get", (db) =>
              db.select().from(messagesOut).where(eq(messagesOut.id, params.id)).get(),
            )
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFound({ message: `Message ${params.id} not found.` })
          const blob = row.renderedKey ? yield* store.get(row.renderedKey).pipe(Effect.orDie) : Option.none()
          const rendered = Option.match(blob, {
            onNone: () => null,
            onSome: ({ body }) => {
              const m = decodeRendered(new TextDecoder().decode(body))
              return {
                from: party(m.from),
                to: m.to.map(party),
                subject: m.subject,
                html: m.html ?? null,
                text: m.text ?? null,
                attachments: (m.attachments ?? []).map((a) => ({
                  filename: a.filename,
                  type: a.type,
                  size: a.content.length,
                })),
              }
            },
          })
          const trail = yield* database
            .query("messages.events", (db) =>
              db
                .select()
                .from(messageEvents)
                .where(eq(messageEvents.messageId, row.id))
                .orderBy(messageEvents.at, messageEvents.id)
                .all(),
            )
            .pipe(Effect.orDie)
          const sent = Option.isSome(blob) ? decodeRendered(new TextDecoder().decode(blob.value.body)) : null
          return {
            ...summarizeMessage(row),
            smtpResponse: row.smtpResponse,
            idempotencyKey: clientIdempotencyKey(row),
            nextAttemptAt: row.nextAttemptAt,
            events: trail.map((e) => ({
              type: e.type,
              at: e.at,
              attempt: e.attempt,
              provider: e.provider,
              bounceType: e.bounceType,
              smtpResponse: e.smtpResponse,
              detail: e.detail,
            })),
            headers: sent ? sentHeaders(sent, row.cfMessageId) : [],
            rendered,
          }
        }),
      ),
    })
  }),
)

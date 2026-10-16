import { and, desc, eq, lt, or } from "drizzle-orm"
import { type Context, Effect, Layer, Option, Redacted } from "effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import pkg from "../../package.json" with { type: "json" }
import { Bindings } from "../Bindings.ts"
import { messagesOut } from "../db/schema.ts"
import { authenticate, type Caller, createKey, listKeys, revokeKey, type Scope } from "../domain/apiKeys.ts"
import { track } from "../domain/events.ts"
import { claim, complete, release } from "../domain/idempotency.ts"
import { decodeRendered, sendTransactional } from "../domain/outbox.ts"
import type { SecretBox, WebhookQueue } from "../domain/webhooks.ts"
import { BlobStore, type Ids, type Sender } from "../kit/index.ts"
import type { CloudflareEmail } from "../services/CloudflareEmail.ts"
import { Database } from "../services/Database.ts"
import type { SendQueue } from "../services/SendQueue.ts"
import {
  type ApiKeySummary,
  IdempotencyConflict,
  InvalidRequest,
  MailApi,
  NotFound,
  type SendPayload,
  Unhealthy,
  Unprocessable,
} from "./Api.ts"
import { ApiKeyAuth, CurrentCaller, Forbidden, Unauthorized } from "./Auth.ts"

export const ApiKeyAuthLive = Layer.effect(
  ApiKeyAuth,
  Effect.gen(function* () {
    const database = yield* Database
    const bindings = yield* Bindings
    return ApiKeyAuth.of({
      bearer: (httpEffect, { credential }) =>
        authenticate(Redacted.value(credential)).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Bindings, bindings),
          Effect.catchTag("InvalidKey", (e) => Effect.fail(new Unauthorized({ message: e.reason }))),
          Effect.flatMap((caller) => Effect.provideService(httpEffect, CurrentCaller, caller)),
        ),
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
  Database | Bindings | BlobStore | Ids | Sender | SendQueue | WebhookQueue | SecretBox | CloudflareEmail
>()

export const requireScope = (scope: Scope) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    if (!caller.scopes.includes(scope)) {
      return yield* new Forbidden({ message: `This key lacks the "${scope}" scope.` })
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
const idempotent = <A, E, R>(
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
      send: p(({ payload, headers }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("send")
          const from =
            payload.from === undefined
              ? undefined
              : typeof payload.from === "string"
                ? { email: payload.from, name: payload.name }
                : { email: payload.from.email, name: payload.from.name ?? payload.name }
          const run = sendTransactional({
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
            apiKeyId: caller.keyId,
            idempotencyKey: headers["idempotency-key"],
          }).pipe(
            Effect.map((emails) => ({
              success: true as const,
              data: { emails, timestamp: new Date().toISOString() },
            })),
            Effect.catchTags({
              SendRequestInvalid: (e) =>
                Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
              TemplateMissing: (e) =>
                Effect.fail(new NotFound({ message: `Template ${e.template}: ${e.reason}.` })),
              InvalidMessage: (e) => Effect.fail(new Unprocessable({ message: e.reason })),
            }),
            Effect.catchTags({ DatabaseError: Effect.die, BlobStoreError: Effect.die }),
          )
          return yield* idempotent(caller, "send", headers["idempotency-key"], payload, run)
        }),
      ),
      track: p(({ payload, headers }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("track")
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
      list: p(() =>
        requireScope("admin").pipe(
          Effect.andThen(listKeys()),
          Effect.map((rows) => ({ keys: rows.map(summarizeKey) })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) =>
            createKey({
              name: payload.name,
              kind: payload.kind,
              scopes: payload.scopes,
              createdBy: caller.keyId,
            }),
          ),
          Effect.map(({ key, record }) => ({ key, apiKey: summarizeKey(record) })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
      ),
      revoke: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.andThen(revokeKey(params.id)),
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

const summarizeMessage = (row: typeof messagesOut.$inferSelect) => ({
  id: row.id,
  stream: row.stream,
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
  apiKeyId: row.apiKeyId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

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
          yield* requireScope("read")
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
          yield* requireScope("read")
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
          return { ...summarizeMessage(row), smtpResponse: row.smtpResponse, rendered }
        }),
      ),
    })
  }),
)

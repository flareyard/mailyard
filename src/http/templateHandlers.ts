import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Schema from "effect/Schema"
import { checkSend } from "../domain/agents.ts"
import { describeAlertSettings, getAlertSettings, putAlertSettings } from "../domain/alertChannels.ts"
import { recordAudit } from "../domain/audit.ts"
import { listAudit } from "../domain/auditLog.ts"
import {
  BrandSettings,
  brandContrastProblem,
  getBrand,
  getBrandSettings,
  putBrandSettings,
  storeLogo,
} from "../domain/brand.ts"
import { describeLane, putLane } from "../domain/mailEvents.ts"
import {
  archiveTemplate,
  createTemplate,
  getTemplate,
  listTemplates,
  publishTemplate,
  resolveForSend,
  rollbackTemplate,
  saveDraft,
  type TemplateMissing,
  type TemplateRejected,
  templateUsage,
  testTemplate,
} from "../domain/templates.ts"
import { MAX_MESSAGE_BYTES } from "../kit/index.ts"
import type { DatabaseError } from "../services/Database.ts"
import {
  missingVariables,
  renderTemplate,
  type TemplateSource,
  templateTexts,
  validateTemplate,
  variablesOf,
} from "../templates/render.ts"
import { InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { CurrentCaller } from "./Auth.ts"
import { agentConflict, appContext, notWhileDeleting, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

const summary = (t: {
  id: string
  name: string
  kind: "html" | "blocks"
  publishedVersion: number | null
  latestVersion: number
  archivedAt: number | null
  updatedAt: number
  createdAt: number
}) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  publishedVersion: t.publishedVersion,
  latestVersion: t.latestVersion,
  hasUnpublishedChanges: t.publishedVersion !== t.latestVersion,
  archived: t.archivedAt !== null,
  updatedAt: t.updatedAt,
  createdAt: t.createdAt,
})

const notFound = <A, E, R>(self: Effect.Effect<A, E | TemplateMissing, R>) =>
  Effect.catchTag(self, "TemplateMissing", (e) =>
    Effect.fail(
      new NotFound({
        message: `Template ${(e as TemplateMissing).template}: ${(e as TemplateMissing).reason}.`,
      }),
    ),
  ) as Effect.Effect<A, Exclude<E, TemplateMissing> | NotFound, R>

const rejected = <A, E, R>(self: Effect.Effect<A, E | TemplateRejected, R>) =>
  Effect.catchTag(self, "TemplateRejected", (e) =>
    Effect.fail(new InvalidRequest({ field: "source", message: (e as TemplateRejected).message })),
  ) as Effect.Effect<A, Exclude<E, TemplateRejected> | InvalidRequest, R>

const dbDies = <A, E, R>(self: Effect.Effect<A, E | DatabaseError, R>) =>
  Effect.catchTag(self, "DatabaseError", Effect.die) as Effect.Effect<A, Exclude<E, DatabaseError>, R>

/** Renders and reports size, variables used and which required ones the data didn't supply. */
export const renderReport = (source: TemplateSource, data: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const brand = yield* getBrand()
    const vars = { email: "preview@example.com", name: "Preview", ...data, data }
    const rendered = yield* Effect.try({
      try: () => renderTemplate(source, vars, brand),
      catch: (e) =>
        new InvalidRequest({ field: "source", message: e instanceof Error ? e.message : String(e) }),
    })
    const variables = variablesOf(...templateTexts(source))
    return {
      ...rendered,
      withinLimit: rendered.size <= MAX_MESSAGE_BYTES,
      variables: { ...variables, missing: missingVariables(variables.required, vars) },
    }
  })

export const TemplatesHandlers = HttpApiBuilder.group(
  MailApi,
  "templates",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read", "templates.read").pipe(
          Effect.andThen(listTemplates(query.archived === "true")),
          Effect.flatMap((rows) =>
            query.include === "usage"
              ? templateUsage(rows.map((r) => r.id)).pipe(
                  Effect.map((usage) => ({
                    templates: rows.map((r) => ({
                      ...summary(r),
                      usage: usage.get(r.id) ?? { sends30d: 0, usedBy: [] },
                    })),
                  })),
                )
              : Effect.succeed({ templates: rows.map(summary) }),
          ),
          dbDies,
        ),
      ),
      create: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "templates.write")
          return yield* createTemplate({
            name: payload.name,
            kind: payload.kind,
            subject: payload.subject,
            source: payload.source,
            text: payload.text ?? undefined,
            publish: payload.publish,
            createdBy: caller.keyId,
          })
        }).pipe(notFound, rejected, dbDies),
      ),
      get: p(({ params }) =>
        requireScope("read", "templates.read").pipe(Effect.andThen(getTemplate(params.id)), notFound, dbDies),
      ),
      saveDraft: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "templates.write")
          return yield* saveDraft(params.id, { ...payload, by: caller.keyId })
        }).pipe(notFound, rejected, dbDies),
      ),
      publish: p(({ params }) =>
        requireScope("admin", "templates.write").pipe(
          Effect.andThen(publishTemplate(params.id)),
          notFound,
          dbDies,
        ),
      ),
      rollback: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "templates.write")
          return yield* rollbackTemplate(params.id, payload.version, caller.keyId)
        }).pipe(notFound, dbDies),
      ),
      archive: p(({ params }) =>
        requireScope("admin", "templates.write").pipe(
          Effect.andThen(archiveTemplate(params.id)),
          notFound,
          dbDies,
        ),
      ),
      test: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("send", "templates.write")
          yield* notWhileDeleting
          yield* checkSend(caller, {
            recipients: payload.to,
            messages: payload.to.length,
            holdable: false,
            what: "a test send",
          }).pipe(Effect.catchTag("AgentLimited", (e) => Effect.fail(agentConflict(e))))
          return yield* testTemplate(params.id, payload)
        }).pipe(
          Effect.catchTags({
            TemplateTestInvalid: (e) =>
              Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            InvalidMessage: (e) => Effect.fail(new InvalidRequest({ field: "message", message: e.message })),
            BlobStoreError: Effect.die,
            TrackingKeyMissing: Effect.die,
          }),
          notFound,
          rejected,
          dbDies,
        ),
      ),
      render: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireScope("read", "templates.read")
          const { source } = yield* resolveForSend(params.id, payload.version ?? "published")
          return yield* renderReport(source, payload.data ?? {})
        }).pipe(notFound, rejected, dbDies),
      ),
      preview: p(({ payload }) =>
        Effect.gen(function* () {
          yield* requireScope("read", "templates.read")
          const source: TemplateSource = {
            kind: payload.kind,
            subject: payload.subject,
            source: payload.source,
            text: payload.text,
          }
          const problem = validateTemplate(source)
          if (problem) return yield* new InvalidRequest({ field: "source", message: problem })
          return yield* renderReport(source, payload.data ?? {})
        }).pipe(dbDies),
      ),
    })
  }),
)

export const SettingsHandlers = HttpApiBuilder.group(
  MailApi,
  "settings",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      getMailEvents: p(() =>
        requireScope("read", "settings.read").pipe(Effect.andThen(describeLane()), dbDies),
      ),
      putMailEvents: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "settings.write")
          const { before, after } = yield* putLane(payload).pipe(
            Effect.catchTag("LaneInvalid", (e) =>
              Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            ),
          )
          yield* recordAudit({
            actor: caller.keyId,
            action: "settings.mail_events",
            target: "mail_events",
            before,
            after: { enabled: after.enabled, mailboxIds: after.mailboxIds, types: after.types },
          })
          return after
        }).pipe(dbDies),
      ),
      getAlertSettings: p(() =>
        requireScope("read", "settings.read").pipe(Effect.andThen(describeAlertSettings()), dbDies),
      ),
      putAlertSettings: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "settings.write")
          const before = yield* getAlertSettings()
          const saved = yield* putAlertSettings(payload).pipe(
            Effect.catchTag("AlertSettingsInvalid", (e) =>
              Effect.fail(new InvalidRequest({ field: e.field, message: e.message })),
            ),
          )
          yield* recordAudit({
            actor: caller.keyId,
            action: "settings.alerts",
            target: "alerts",
            before,
            after: { channels: saved.channels, defaultEmail: saved.defaultEmail },
          })
          return saved
        }).pipe(dbDies),
      ),
      getBrand: p(() =>
        requireScope("read", "settings.read").pipe(Effect.andThen(getBrandSettings()), dbDies),
      ),
      putBrand: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "settings.write")
          const { logoUploadId, ...fields } = payload
          const value = yield* Schema.decodeUnknownEffect(BrandSettings)(fields).pipe(
            Effect.mapError((e) => new InvalidRequest({ field: "brand", message: e.message })),
          )
          const problem = brandContrastProblem(value)
          if (problem) return yield* new InvalidRequest(problem)
          const logoUrl = logoUploadId
            ? yield* storeLogo(logoUploadId, originOf(request) ?? "").pipe(
                Effect.catchTag("LogoInvalid", (e) =>
                  Effect.fail(new InvalidRequest({ field: "logoUploadId", message: e.message })),
                ),
              )
            : undefined
          const before = yield* getBrandSettings()
          const saved = yield* putBrandSettings(logoUrl ? { ...value, logoUrl } : value)
          yield* recordAudit({
            actor: caller.keyId,
            action: "settings.brand",
            target: "brand",
            before,
            after: saved,
          })
          return saved
        }).pipe(Effect.catchTag("BlobStoreError", Effect.die), dbDies),
      ),
      audit: p(({ query }) =>
        requireScope("admin", "settings.write").pipe(
          Effect.andThen(
            listAudit({
              actor: query.actor,
              action: query.action,
              target: query.target,
              from: query.from,
              to: query.to,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
          dbDies,
        ),
      ),
    })
  }),
)

export { CurrentCaller }

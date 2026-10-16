import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { BrandSettings, getBrand, getBrandSettings, putBrandSettings } from "../domain/brand.ts"
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
import { appContext, provideTo, requireScope } from "./handlers.ts"

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
const renderReport = (source: TemplateSource, data: Readonly<Record<string, unknown>>) =>
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
        requireScope("read").pipe(
          Effect.andThen(listTemplates(query.archived === "true")),
          Effect.map((rows) => ({ templates: rows.map(summary) })),
          dbDies,
        ),
      ),
      create: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin")
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
        requireScope("read").pipe(Effect.andThen(getTemplate(params.id)), notFound, dbDies),
      ),
      saveDraft: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin")
          return yield* saveDraft(params.id, { ...payload, by: caller.keyId })
        }).pipe(notFound, rejected, dbDies),
      ),
      publish: p(({ params }) =>
        requireScope("admin").pipe(Effect.andThen(publishTemplate(params.id)), notFound, dbDies),
      ),
      rollback: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin")
          return yield* rollbackTemplate(params.id, payload.version, caller.keyId)
        }).pipe(notFound, dbDies),
      ),
      archive: p(({ params }) =>
        requireScope("admin").pipe(Effect.andThen(archiveTemplate(params.id)), notFound, dbDies),
      ),
      render: p(({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireScope("read")
          const { source } = yield* resolveForSend(params.id, payload.version ?? "published")
          return yield* renderReport(source, payload.data ?? {})
        }).pipe(notFound, rejected, dbDies),
      ),
      preview: p(({ payload }) =>
        Effect.gen(function* () {
          yield* requireScope("read")
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
      getBrand: p(() => requireScope("read").pipe(Effect.andThen(getBrandSettings()), dbDies)),
      putBrand: p(({ payload }) =>
        Effect.gen(function* () {
          yield* requireScope("admin")
          const value = yield* Schema.decodeUnknownEffect(BrandSettings)(payload).pipe(
            Effect.mapError((e) => new InvalidRequest({ field: "brand", message: e.message })),
          )
          return yield* putBrandSettings(value)
        }).pipe(dbDies),
      ),
    })
  }),
)

export { CurrentCaller }

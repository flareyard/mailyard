import { and, desc, eq, isNull } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { templates, templateVersions } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { type TemplateSource, templateTexts, validateTemplate, variablesOf } from "../templates/render.ts"

export class TemplateMissing extends Schema.TaggedError<TemplateMissing>()("TemplateMissing", {
  template: Schema.String,
  reason: Schema.String,
}) {}

export class TemplateRejected extends Schema.TaggedError<TemplateRejected>()("TemplateRejected", {
  message: Schema.String,
}) {}

type TemplateRow = typeof templates.$inferSelect
type VersionRow = typeof templateVersions.$inferSelect

export const describeTemplate = (t: TemplateRow, v: VersionRow | undefined) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  publishedVersion: t.publishedVersion,
  latestVersion: t.latestVersion,
  hasUnpublishedChanges: t.publishedVersion !== t.latestVersion,
  archived: t.archivedAt !== null,
  updatedAt: t.updatedAt,
  createdAt: t.createdAt,
  latest: v
    ? {
        version: v.version,
        subject: v.subject,
        source: v.source,
        text: v.text,
        publishedAt: v.publishedAt,
        variables: variablesOf(
          ...templateTexts({ kind: t.kind, subject: v.subject, source: v.source, text: v.text }),
        ),
      }
    : null,
})

const findTemplate = Effect.fn("templates.find")(function* (idOrName: string) {
  const database = yield* Database
  const row = yield* database.query("templates.find", (db) =>
    db.select().from(templates).where(eq(templates.id, idOrName)).get(),
  )
  const byName =
    row ??
    (yield* database.query("templates.findByName", (db) =>
      db.select().from(templates).where(eq(templates.name, idOrName)).get(),
    ))
  if (!byName) return yield* new TemplateMissing({ template: idOrName, reason: "not found" })
  return byName
})

const findVersion = Effect.fn("templates.version")(function* (templateId: string, version: number) {
  const database = yield* Database
  const row = yield* database.query("templateVersions.find", (db) =>
    db
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.version, version)))
      .get(),
  )
  if (!row)
    return yield* new TemplateMissing({ template: templateId, reason: `version ${version} not found` })
  return row
})

const check = (source: TemplateSource) => {
  const problem = validateTemplate(source)
  return problem ? Effect.fail(new TemplateRejected({ message: problem })) : Effect.void
}

export const listTemplates = Effect.fn("templates.list")(function* (includeArchived: boolean) {
  const database = yield* Database
  return yield* database.query("templates.list", (db) =>
    db
      .select()
      .from(templates)
      .where(includeArchived ? undefined : isNull(templates.archivedAt))
      .orderBy(desc(templates.updatedAt))
      .all(),
  )
})

export const getTemplate = Effect.fn("templates.get")(function* (idOrName: string) {
  const t = yield* findTemplate(idOrName)
  const v = yield* findVersion(t.id, t.latestVersion)
  const database = yield* Database
  const versions = yield* database.query("templateVersions.list", (db) =>
    db
      .select({
        version: templateVersions.version,
        subject: templateVersions.subject,
        publishedAt: templateVersions.publishedAt,
        createdBy: templateVersions.createdBy,
        createdAt: templateVersions.createdAt,
      })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, t.id))
      .orderBy(desc(templateVersions.version))
      .all(),
  )
  return { ...describeTemplate(t, v), versions }
})

export const createTemplate = Effect.fn("templates.create")(function* (input: {
  readonly name: string
  readonly kind: "html" | "blocks"
  readonly subject: string
  readonly source: string
  readonly text?: string | undefined
  readonly publish?: boolean | undefined
  readonly createdBy: string
}) {
  yield* check(input)
  const database = yield* Database
  const existing = yield* database.query("templates.nameTaken", (db) =>
    db.select({ id: templates.id }).from(templates).where(eq(templates.name, input.name)).get(),
  )
  if (existing)
    return yield* new TemplateRejected({ message: `A template named "${input.name}" already exists.` })
  const id = yield* (yield* Ids).next
  const now = Date.now()
  yield* database.query("templates.insert", (db) =>
    db.batch([
      db.insert(templates).values({
        id,
        name: input.name,
        kind: input.kind,
        latestVersion: 1,
        publishedVersion: input.publish ? 1 : null,
        updatedAt: now,
      }),
      db.insert(templateVersions).values({
        templateId: id,
        version: 1,
        subject: input.subject,
        source: input.source,
        text: input.text ?? null,
        publishedAt: input.publish ? now : null,
        createdBy: input.createdBy,
      }),
    ]),
  )
  return yield* getTemplate(id)
})

/**
 * Saves edits as the draft. If the latest version is already published, the edit starts a new version,
 * so the published one stays exactly as sent.
 */
export const saveDraft = Effect.fn("templates.saveDraft")(function* (
  idOrName: string,
  input: {
    readonly subject: string
    readonly source: string
    readonly text?: string | null | undefined
    readonly by: string
  },
) {
  const t = yield* findTemplate(idOrName)
  yield* check({ kind: t.kind, ...input })
  const database = yield* Database
  const latest = yield* findVersion(t.id, t.latestVersion)
  const now = Date.now()
  if (latest.publishedAt === null) {
    yield* database.query("templateVersions.updateDraft", (db) =>
      db.batch([
        db
          .update(templateVersions)
          .set({
            subject: input.subject,
            source: input.source,
            text: input.text ?? null,
            createdBy: input.by,
          })
          .where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, latest.version))),
        db.update(templates).set({ updatedAt: now }).where(eq(templates.id, t.id)),
      ]),
    )
  } else {
    const version = t.latestVersion + 1
    yield* database.query("templateVersions.newDraft", (db) =>
      db.batch([
        db.insert(templateVersions).values({
          templateId: t.id,
          version,
          subject: input.subject,
          source: input.source,
          text: input.text ?? null,
          createdBy: input.by,
        }),
        db.update(templates).set({ latestVersion: version, updatedAt: now }).where(eq(templates.id, t.id)),
      ]),
    )
  }
  return yield* getTemplate(t.id)
})

export const publishTemplate = Effect.fn("templates.publish")(function* (idOrName: string) {
  const t = yield* findTemplate(idOrName)
  const database = yield* Database
  const now = Date.now()
  yield* database.query("templates.publish", (db) =>
    db.batch([
      db
        .update(templateVersions)
        .set({ publishedAt: now })
        .where(
          and(
            eq(templateVersions.templateId, t.id),
            eq(templateVersions.version, t.latestVersion),
            isNull(templateVersions.publishedAt),
          ),
        ),
      db
        .update(templates)
        .set({ publishedVersion: t.latestVersion, updatedAt: now })
        .where(eq(templates.id, t.id)),
    ]),
  )
  return yield* getTemplate(t.id)
})

/** Publishes a copy of an earlier version as a new version: history only ever grows. */
export const rollbackTemplate = Effect.fn("templates.rollback")(function* (
  idOrName: string,
  toVersion: number,
  by: string,
) {
  const t = yield* findTemplate(idOrName)
  const old = yield* findVersion(t.id, toVersion)
  const database = yield* Database
  const version = t.latestVersion + 1
  const now = Date.now()
  yield* database.query("templates.rollback", (db) =>
    db.batch([
      db.insert(templateVersions).values({
        templateId: t.id,
        version,
        subject: old.subject,
        source: old.source,
        text: old.text,
        publishedAt: now,
        createdBy: by,
      }),
      db
        .update(templates)
        .set({ latestVersion: version, publishedVersion: version, updatedAt: now })
        .where(eq(templates.id, t.id)),
    ]),
  )
  return yield* getTemplate(t.id)
})

export const archiveTemplate = Effect.fn("templates.archive")(function* (idOrName: string) {
  const t = yield* findTemplate(idOrName)
  const database = yield* Database
  yield* database.query("templates.archive", (db) =>
    db
      .update(templates)
      .set({ archivedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(templates.id, t.id))
      .run(),
  )
  return yield* getTemplate(t.id)
})

/** The version a send uses: the published one, or a specific version for previews and tests. */
export const resolveForSend = Effect.fn("templates.resolveForSend")(function* (
  idOrName: string,
  which: "published" | "latest" | number = "published",
) {
  const t = yield* findTemplate(idOrName)
  if (t.archivedAt !== null && which === "published") {
    return yield* new TemplateMissing({ template: idOrName, reason: "archived" })
  }
  const version = which === "published" ? t.publishedVersion : which === "latest" ? t.latestVersion : which
  if (version === null)
    return yield* new TemplateMissing({ template: idOrName, reason: "has no published version" })
  const v = yield* findVersion(t.id, version)
  return {
    template: t,
    version: v,
    source: { kind: t.kind, subject: v.subject, source: v.source, text: v.text } as TemplateSource,
  }
})

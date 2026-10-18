import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import {
  apiKeys,
  automations,
  automationVersions,
  campaigns,
  templateDaily,
  templates,
  templateVersions,
} from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import {
  renderTemplate,
  type TemplateSource,
  templateTexts,
  validateTemplate,
  variablesOf,
} from "../templates/render.ts"
import { getBrand } from "./brand.ts"
import { parseParty, sendBulkMessage } from "./outbox.ts"

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
        /** When the draft was last saved, and by which key (HAL-3415). */
        updatedAt: v.updatedAt ?? v.createdAt,
        updatedBy: v.createdBy,
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
        updatedAt: now,
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
            updatedAt: now,
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
          updatedAt: now,
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
        updatedAt: now,
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

// ---------------------------------------------------------------------------------------------
// Usage and test sends (HAL-3415)
// ---------------------------------------------------------------------------------------------

export type TemplateUsage = {
  readonly sends30d: number
  readonly usedBy: ReadonlyArray<{
    readonly type: "automation" | "campaign" | "apiKey"
    readonly id: string
    readonly name: string
  }>
}

const graphTemplates = (graph: unknown): ReadonlyArray<string> => {
  const nodes = (graph as { nodes?: ReadonlyArray<{ type?: string; config?: { templateId?: unknown } }> })
    ?.nodes
  return (nodes ?? []).flatMap((n) =>
    n.type === "send" && typeof n.config?.templateId === "string" ? [n.config.templateId] : [],
  )
}

/**
 * Per template: sends in the last 30 days (the daily rollup), and what uses it: automations whose
 * draft or live graph sends it, campaigns that name it, and API keys that sent it in those 30 days.
 * Automations are read whole (people write them, a few dozen at most) and their graphs searched here.
 */
export const templateUsage = Effect.fn("templates.usage")(function* (
  templateIds: ReadonlyArray<string>,
  now = Date.now(),
) {
  const usage = new Map<string, { sends30d: number; usedBy: Array<TemplateUsage["usedBy"][number]> }>(
    templateIds.map((id) => [id, { sends30d: 0, usedBy: [] }]),
  )
  if (templateIds.length === 0) return usage as ReadonlyMap<string, TemplateUsage>
  const database = yield* Database
  const since = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10)
  const daily = yield* queryIn("templates.usageDaily", [...templateIds], (db, chunk) =>
    db
      .select({
        templateId: templateDaily.templateId,
        apiKeyId: templateDaily.apiKeyId,
        sends: sql<number>`sum(${templateDaily.sends})`,
      })
      .from(templateDaily)
      .where(and(inArray(templateDaily.templateId, chunk), gte(templateDaily.day, since)))
      .groupBy(templateDaily.templateId, templateDaily.apiKeyId)
      .all(),
  )
  const keyIds = [...new Set(daily.map((d) => d.apiKeyId).filter((k) => k !== ""))]
  const keyNames = yield* queryIn("templates.usageKeys", keyIds, (db, chunk) =>
    db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(inArray(apiKeys.id, chunk)).all(),
  )
  for (const d of daily) {
    const u = usage.get(d.templateId)
    if (!u) continue
    u.sends30d += Number(d.sends)
    if (d.apiKeyId)
      u.usedBy.push({
        type: "apiKey",
        id: d.apiKeyId,
        name: keyNames.find((k) => k.id === d.apiKeyId)?.name ?? d.apiKeyId,
      })
  }
  const usedCampaigns = yield* queryIn("templates.usageCampaigns", [...templateIds], (db, chunk) =>
    db
      .select({ id: campaigns.id, name: campaigns.name, templateId: campaigns.templateId })
      .from(campaigns)
      .where(inArray(campaigns.templateId, chunk))
      .all(),
  )
  for (const c of usedCampaigns)
    if (c.templateId) usage.get(c.templateId)?.usedBy.push({ type: "campaign", id: c.id, name: c.name })
  const autos = yield* database.query("templates.usageAutomations", (db) =>
    db
      .select({ id: automations.id, name: automations.name, graph: automations.graph })
      .from(automations)
      .all(),
  )
  const live = yield* database.query("templates.usageLive", (db) =>
    db
      .select({ automationId: automationVersions.automationId, graph: automationVersions.graph })
      .from(automationVersions)
      .innerJoin(
        automations,
        and(
          eq(automations.id, automationVersions.automationId),
          eq(automations.publishedVersion, automationVersions.version),
        ),
      )
      .all(),
  )
  for (const a of autos) {
    const used = new Set([
      ...graphTemplates(a.graph),
      ...live.filter((l) => l.automationId === a.id).flatMap((l) => graphTemplates(l.graph)),
    ])
    for (const id of used) usage.get(id)?.usedBy.push({ type: "automation", id: a.id, name: a.name })
  }
  return usage as ReadonlyMap<string, TemplateUsage>
})

export class TemplateTestInvalid extends Schema.TaggedError<TemplateTestInvalid>()("TemplateTestInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * `POST /v1/templates/{id}/test`: renders a version (the latest by default, so a draft can be tried)
 * with the given data and sends it to up to five addresses, marked [Test], on the `test` stream:
 * outside the template's numbers and the bulk quota share.
 */
export const testTemplate = Effect.fn("templates.test")(function* (
  idOrName: string,
  input: {
    readonly to: ReadonlyArray<string>
    readonly data?: Readonly<Record<string, unknown>> | undefined
    readonly version?: number | "latest" | "published" | undefined
    readonly from?: string | undefined
  },
) {
  if (input.to.length === 0 || input.to.length > 5)
    return yield* new TemplateTestInvalid({ field: "to", message: "Send a test to 1 to 5 addresses." })
  const bad = input.to.find((t) => !EMAIL_PATTERN.test(t.trim()))
  if (bad) return yield* new TemplateTestInvalid({ field: "to", message: `${bad} isn't an email address.` })
  const { DEFAULT_FROM } = yield* Bindings
  const fromRaw = input.from ?? DEFAULT_FROM
  if (!fromRaw)
    return yield* new TemplateTestInvalid({
      field: "from",
      message: "Say who the test comes from (from), or set DEFAULT_FROM.",
    })
  const from = parseParty(fromRaw)
  const resolved = yield* resolveForSend(idOrName, input.version ?? "latest")
  const brand = yield* getBrand()
  const stamp = Date.now()
  const sent: Array<{ email: string; messageId: string; status: string }> = []
  for (const raw of input.to) {
    const email = raw.trim().toLowerCase()
    const rendered = yield* Effect.try({
      try: () =>
        renderTemplate(
          resolved.source,
          { ...input.data, data: input.data ?? {}, trigger: input.data ?? {}, email, name: null },
          brand,
        ),
      catch: (e) =>
        new TemplateTestInvalid({ field: "template", message: e instanceof Error ? e.message : String(e) }),
    })
    const result = yield* sendBulkMessage({
      stream: "test",
      message: {
        from: from.name ? { email: from.email, name: from.name } : { email: from.email },
        to: [{ email }],
        subject: `[Test] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
      },
      contactId: null,
      campaignId: null,
      templateId: resolved.template.id,
      templateVersion: resolved.version.version,
      idempotencyKey: `test:${resolved.template.id}:${email}:${stamp}`,
    })
    sent.push({ email, messageId: result.id, status: result.status })
  }
  return { version: resolved.version.version, sent }
})

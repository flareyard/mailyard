import { asc, count, desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { campaigns, contacts, segments } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import {
  compile,
  customFields,
  LIMITS,
  type Rule,
  Rule as RuleSchema,
  toQuery,
  validate,
} from "../segments/rules.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { describeContact } from "./contacts.ts"

export class SegmentNotFound extends Schema.TaggedError<SegmentNotFound>()("SegmentNotFound", {
  id: Schema.String,
}) {}
export class SegmentInvalid extends Schema.TaggedError<SegmentInvalid>()("SegmentInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class SegmentInUse extends Schema.TaggedError<SegmentInUse>()("SegmentInUse", {
  message: Schema.String,
}) {}

type SegmentRow = typeof segments.$inferSelect

const describe = (s: SegmentRow) => ({
  id: s.id,
  name: s.name,
  filter: s.filter as Rule,
  count: s.lastCount,
  countedAt: s.lastComputedAt,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
})
export type SegmentView = ReturnType<typeof describe>

/** Decodes and checks a rule tree, and compiles it; a bad tree is the caller's 400 with the path at fault. */
export const prepare = Effect.fn("segments.prepare")(function* (raw: unknown) {
  const rule = yield* Schema.decodeUnknownEffect(RuleSchema)(raw).pipe(
    Effect.mapError((e) => new SegmentInvalid({ field: "filter", message: e.message })),
  )
  const problem = validate(rule)
  if (problem) return yield* new SegmentInvalid({ field: problem.path, message: problem.message })
  const condition = compile(rule)
  const query = toQuery(condition)
  if (query.params.length > LIMITS.params) {
    return yield* new SegmentInvalid({
      field: "filter",
      message: "This segment is too complex; split it into smaller ones.",
    })
  }
  return { rule, condition, query }
})

/**
 * Gives each custom field a saved segment filters on an expression index, up to 20 fields. The
 * field name passed validation, so it is safe as an identifier and a literal.
 */
const indexFields = (rule: Rule) =>
  Effect.gen(function* () {
    const uses = customFields(rule)
    if (uses.length === 0) return
    const { DB } = yield* Bindings
    const existing = yield* Effect.promise(() =>
      DB.prepare("select name from sqlite_master where type = 'index' and name like 'contacts_field_%'").all<{
        name: string
      }>(),
    )
    const have = new Set(existing.results.map((r) => r.name))
    let room = LIMITS.fieldIndexes - have.size
    for (const { field, text, plain } of uses) {
      const base = `contacts_field_${field.toLowerCase()}`
      const wanted = [
        ...(plain ? [{ name: base, expr: `json_extract(fields, '$.${field}')` }] : []),
        ...(text ? [{ name: `${base}_ci`, expr: `json_extract(fields, '$.${field}') collate nocase` }] : []),
      ]
      for (const index of wanted) {
        if (have.has(index.name)) continue
        if (room <= 0) {
          yield* Effect.logWarning(
            `segments: not indexing ${field}, already ${LIMITS.fieldIndexes} field indexes`,
          )
          return
        }
        yield* Effect.promise(() =>
          DB.prepare(`create index if not exists ${index.name} on contacts (${index.expr})`).run(),
        )
        have.add(index.name)
        room--
      }
    }
  })

const countOf = (condition: ReturnType<typeof compile>) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("segments.count", (db) =>
      db.select({ n: count() }).from(contacts).where(condition).get(),
    )
    return row?.n ?? 0
  })

/** What a filter matches right now: the count, 20 of the newest matches, and the SQL it runs. */
export const previewSegment = Effect.fn("segments.preview")(function* (filter: unknown) {
  const { condition, query } = yield* prepare(filter)
  const database = yield* Database
  const [n, sample] = yield* Effect.all(
    [
      countOf(condition),
      database.query("segments.sample", (db) =>
        db
          .select()
          .from(contacts)
          .where(condition)
          .orderBy(desc(contacts.createdAt), desc(contacts.id))
          .limit(20)
          .all(),
      ),
    ],
    { concurrency: "unbounded" },
  )
  const now = Date.now()
  return {
    count: n,
    sample: sample.map((c) => describeContact(c, [], now)),
    sql: query.sql,
    params: query.params,
  }
})

export const findSegment = Effect.fn("segments.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("segments.get", (db) =>
    db.select().from(segments).where(eq(segments.id, id)).get(),
  )
  if (!row) return yield* new SegmentNotFound({ id })
  return row
})

export const listSegments = Effect.fn("segments.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("segments.list", (db) =>
    db.select().from(segments).orderBy(asc(segments.name)).all(),
  )
  return rows.map(describe)
})

/** A segment, with its count recomputed: counts are cheap and a stale one misleads. */
export const getSegment = Effect.fn("segments.getView")(function* (id: string) {
  const row = yield* findSegment(id)
  // A saved filter passed validation when it was saved; failing now would be our fault, not the caller's.
  const { condition } = yield* prepare(row.filter).pipe(Effect.orDie)
  const n = yield* countOf(condition)
  const database = yield* Database
  const now = Date.now()
  const updated = yield* database.query("segments.recount", (db) =>
    db
      .update(segments)
      .set({ lastCount: n, lastComputedAt: now })
      .where(eq(segments.id, id))
      .returning()
      .get(),
  )
  return describe(updated ?? row)
})

const checkName = (name: string) =>
  Effect.gen(function* () {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 100) {
      return yield* new SegmentInvalid({ field: "name", message: "A segment name is 1 to 100 characters." })
    }
    return trimmed
  })

export const createSegment = Effect.fn("segments.create")(function* (
  input: { readonly name: string; readonly filter: unknown },
  actor: string,
) {
  const name = yield* checkName(input.name)
  const { rule, condition, query } = yield* prepare(input.filter)
  yield* indexFields(rule)
  const n = yield* countOf(condition)
  const database = yield* Database
  const id = `seg_${yield* (yield* Ids).next}`
  const now = Date.now()
  const row = yield* database.query("segments.insert", (db) =>
    db
      .insert(segments)
      .values({
        id,
        name,
        filter: rule,
        compiledSql: query.sql,
        compiledParams: [...query.params],
        lastCount: n,
        lastComputedAt: now,
        updatedAt: now,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "segment.create", target: id, after: { name, filter: rule } })
  return describe(row)
})

export const updateSegment = Effect.fn("segments.update")(function* (
  id: string,
  input: { readonly name?: string | undefined; readonly filter?: unknown },
  actor: string,
) {
  const before = yield* findSegment(id)
  const name = input.name === undefined ? undefined : yield* checkName(input.name)
  const prepared = input.filter === undefined ? undefined : yield* prepare(input.filter)
  if (prepared) yield* indexFields(prepared.rule)
  const n = prepared ? yield* countOf(prepared.condition) : before.lastCount
  const database = yield* Database
  const now = Date.now()
  const row = yield* database.query("segments.update", (db) =>
    db
      .update(segments)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(prepared
          ? {
              filter: prepared.rule,
              compiledSql: prepared.query.sql,
              compiledParams: [...prepared.query.params],
              lastCount: n,
              lastComputedAt: now,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(segments.id, id))
      .returning()
      .get(),
  )
  yield* recordAudit({
    actor,
    action: "segment.update",
    target: id,
    before: { name: before.name, filter: before.filter },
    after: { name: row?.name, filter: row?.filter },
  })
  return describe(row ?? before)
})

/** A segment a campaign was built on stays: the campaign's report still points at it. */
export const deleteSegment = Effect.fn("segments.delete")(function* (id: string, actor: string) {
  const row = yield* findSegment(id)
  const database = yield* Database
  const used = yield* database.query("segments.usedBy", (db) =>
    db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.segmentId, id))
      .limit(1)
      .get(),
  )
  if (used) return yield* new SegmentInUse({ message: `Campaign "${used.name}" uses this segment.` })
  yield* database.query("segments.delete", (db) => db.delete(segments).where(eq(segments.id, id)).run())
  yield* recordAudit({
    actor,
    action: "segment.delete",
    target: id,
    before: { name: row.name, filter: row.filter },
  })
  return { id, deleted: true }
})

/**
 * A saved segment's condition, ready to put after `where` in raw SQL over `contacts`, with its
 * parameters. Campaign sends snapshot their audience with this.
 */
export const segmentCondition = Effect.fn("segments.condition")(function* (id: string) {
  const row = yield* findSegment(id)
  return { sql: row.compiledSql, params: row.compiledParams }
})

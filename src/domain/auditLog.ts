import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import {
  apiKeys,
  audit,
  automations,
  campaigns,
  domains,
  forms,
  mailboxes,
  segments,
  templates,
  topics,
} from "../db/schema.ts"
import { Database, queryIn } from "../services/Database.ts"

/**
 * The audit log as a reader sees it (HAL-3376): who did what to which thing, newest first, with
 * filters and a CSV form. Rows are what `recordAudit` wrote; the names around them (the key's name,
 * the target's label) are looked up when read, so a renamed campaign shows its current name.
 *
 * Not recorded, so always null: the caller's IP and location. `via` comes from the acting key's
 * purpose (an `mcp` key acts through the MCP server).
 */

const PREFIX_TYPES: Readonly<Record<string, string>> = {
  cmp: "campaign",
  mbx: "mailbox",
  dom: "domain",
  seg: "segment",
  top: "topic",
  frm: "form",
  aut: "automation",
  rul: "rule",
  imp: "import",
  exp: "export",
  alr: "alert",
  tst: "testSend",
  upl: "upload",
}

/** What kind of thing a target is: from its id's prefix, else the action's first word. */
export const targetType = (target: string | null, action: string) => {
  if (!target) return null
  const prefix = /^([a-z]{2,4})_/.exec(target)?.[1]
  if (prefix && PREFIX_TYPES[prefix]) return PREFIX_TYPES[prefix]
  if (target.includes("@")) return "address"
  return action.split(".")[0] ?? null
}

export interface AuditQuery {
  readonly actor?: string | undefined
  /** An exact action (`campaign.schedule`), or a family ending in `.` or `.*` (`campaign.`). */
  readonly action?: string | undefined
  readonly target?: string | undefined
  readonly from?: number | undefined
  readonly to?: number | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** `action=campaign.` or `campaign.*` matches every campaign action, through the index as a range. */
const actionFilter = (action: string) => {
  const family = action.endsWith(".*") ? action.slice(0, -1) : action.endsWith(".") ? action : null
  if (!family) return eq(audit.action, action)
  // Every string that starts with `family` sorts between it and the same with its last char bumped.
  const upper = `${family.slice(0, -1)}${String.fromCharCode(family.charCodeAt(family.length - 1) + 1)}`
  return and(gte(audit.action, family), lt(audit.action, upper))
}

export const listAudit = Effect.fn("audit.list")(function* (query: AuditQuery) {
  const database = yield* Database
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const [at, cursorId] = query.cursor ? query.cursor.split(":") : []
  const rows = yield* database.query("audit.list", (db) =>
    db
      .select()
      .from(audit)
      .where(
        and(
          query.actor ? eq(audit.actor, query.actor) : undefined,
          query.action ? actionFilter(query.action) : undefined,
          query.target ? eq(audit.target, query.target) : undefined,
          query.from !== undefined ? gte(audit.at, query.from) : undefined,
          query.to !== undefined ? lte(audit.at, query.to) : undefined,
          at && cursorId
            ? or(lt(audit.at, Number(at)), and(eq(audit.at, Number(at)), lt(audit.id, cursorId)))
            : undefined,
        ),
      )
      .orderBy(desc(audit.at), desc(audit.id))
      .limit(limit + 1)
      .all(),
  )
  const page = rows.slice(0, limit)
  const labels = yield* labelsFor(page)
  const actorIds = [...new Set(page.map((r) => r.actor))]
  const keys = yield* queryIn("audit.actors", actorIds, (db, chunk) =>
    db
      .select({ id: apiKeys.id, name: apiKeys.name, purpose: apiKeys.purpose })
      .from(apiKeys)
      .where(inArray(apiKeys.id, chunk))
      .all(),
  )
  const keyById = new Map(keys.map((k) => [k.id, k]))
  const last = page.at(-1)
  return {
    entries: page.map((r) => {
      const key = keyById.get(r.actor)
      const type = targetType(r.target, r.action)
      return {
        id: r.id,
        at: r.at,
        actor: {
          type: key ? ("key" as const) : r.actor === "root" ? ("root" as const) : ("system" as const),
          id: r.actor,
          name: key?.name ?? (r.actor === "root" ? "Admin key" : r.actor),
        },
        via: key ? (key.purpose === "mcp" ? ("mcp" as const) : ("api" as const)) : null,
        ip: null,
        location: null,
        action: r.action,
        target: r.target ? { type, id: r.target, label: labels.get(r.target) ?? null } : null,
        before: r.before ?? null,
        after: r.after ?? null,
      }
    }),
    nextCursor: rows.length > limit && last ? `${last.at}:${last.id}` : null,
  }
})

/** The current names of the things on a page of entries, one lookup per kind. */
const labelsFor = (rows: ReadonlyArray<{ readonly target: string | null; readonly action: string }>) =>
  Effect.gen(function* () {
    const byType = new Map<string, Array<string>>()
    for (const r of rows) {
      const type = targetType(r.target, r.action)
      if (!r.target || !type) continue
      byType.set(type, [...(byType.get(type) ?? []), r.target])
    }
    const labels = new Map<string, string>()
    const look = <T extends { readonly id: string; readonly label: string }>(
      name: string,
      ids: ReadonlyArray<string> | undefined,
      run: Parameters<typeof queryIn<string, T>>[2],
    ) =>
      ids?.length
        ? queryIn(`audit.labels.${name}`, [...new Set(ids)], run).pipe(
            Effect.tap((found) =>
              Effect.sync(() => {
                for (const f of found) labels.set(f.id, f.label)
              }),
            ),
          )
        : Effect.succeed([])
    yield* look("campaigns", byType.get("campaign"), (db, chunk) =>
      db
        .select({ id: campaigns.id, label: campaigns.name })
        .from(campaigns)
        .where(inArray(campaigns.id, chunk))
        .all(),
    )
    yield* look("mailboxes", byType.get("mailbox"), (db, chunk) =>
      db
        .select({ id: mailboxes.id, label: mailboxes.address })
        .from(mailboxes)
        .where(inArray(mailboxes.id, chunk))
        .all(),
    )
    yield* look("domains", byType.get("domain"), (db, chunk) =>
      db
        .select({ id: domains.id, label: domains.name })
        .from(domains)
        .where(inArray(domains.id, chunk))
        .all(),
    )
    yield* look("segments", byType.get("segment"), (db, chunk) =>
      db
        .select({ id: segments.id, label: segments.name })
        .from(segments)
        .where(inArray(segments.id, chunk))
        .all(),
    )
    yield* look("topics", byType.get("topic"), (db, chunk) =>
      db.select({ id: topics.id, label: topics.name }).from(topics).where(inArray(topics.id, chunk)).all(),
    )
    yield* look("forms", byType.get("form"), (db, chunk) =>
      db.select({ id: forms.id, label: forms.name }).from(forms).where(inArray(forms.id, chunk)).all(),
    )
    yield* look("automations", byType.get("automation"), (db, chunk) =>
      db
        .select({ id: automations.id, label: automations.name })
        .from(automations)
        .where(inArray(automations.id, chunk))
        .all(),
    )
    yield* look("templates", byType.get("template"), (db, chunk) =>
      db
        .select({ id: templates.id, label: templates.name })
        .from(templates)
        .where(inArray(templates.id, chunk))
        .all(),
    )
    yield* look("keys", [...(byType.get("apiKey") ?? []), ...(byType.get("api_key") ?? [])], (db, chunk) =>
      db
        .select({ id: apiKeys.id, label: apiKeys.name })
        .from(apiKeys)
        .where(inArray(apiKeys.id, chunk))
        .all(),
    )
    return labels
  })

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)
  // A leading = + - @ would run as a formula in a spreadsheet; a quote keeps it text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** The same entries as CSV, at most `max` of them, newest first. */
export const auditCsv = Effect.fn("audit.csv")(function* (query: AuditQuery, max = 10_000) {
  const lines = [
    "at,actor_type,actor_id,actor_name,via,action,target_type,target_id,target_label,before,after",
  ]
  let cursor: string | undefined = query.cursor
  let count = 0
  do {
    const page = yield* listAudit({ ...query, cursor, limit: 200 })
    for (const e of page.entries) {
      if (count >= max) break
      lines.push(
        [
          new Date(e.at).toISOString(),
          e.actor.type,
          e.actor.id,
          e.actor.name,
          e.via,
          e.action,
          e.target?.type,
          e.target?.id,
          e.target?.label,
          e.before,
          e.after,
        ]
          .map(cell)
          .join(","),
      )
      count++
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor && count < max)
  return { csv: `${lines.join("\n")}\n`, rows: count, truncated: Boolean(cursor) }
})

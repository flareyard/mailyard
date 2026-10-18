import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { mailboxes, settings } from "../db/schema.ts"
import { createWorkspaceExport } from "../exports/workspaceExport.ts"
import { fileUrl, signFileToken } from "../mail/files.ts"
import { Database } from "../services/Database.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import { type Caller, ROOT } from "./apiKeys.ts"
import { recordAudit } from "./audit.ts"
import { HOLDS_MAIL } from "./mailboxes.ts"
import { parseParty, sendBulkMessage } from "./outbox.ts"
import { currentWorkspace, workspaceSetting } from "./sessions.ts"

/**
 * Deleting the workspace (HAL-3448), as proposed there and built on the founder's go-ahead of
 * 2026-10-18: the owner (or the admin key, before anyone owns it) types the workspace's name, a
 * full export starts at once, and nothing is deleted for 7 days. During those days sending stops,
 * receiving goes on, every response says when the end comes, and `POST /v1/workspace/restore`
 * calls it off. At the end a Workflow empties the mailboxes, R2 and every table, and leaves a
 * tombstone. The deletion export's files stay in R2, reachable from the tombstone, until the
 * platform removes the bucket with the app; the Worker, the database and the bucket themselves are
 * the platform's to remove.
 */

const DAY = 86_400_000
export const DELETION_GRACE_MS = 7 * DAY

export const DeletionRecord = Schema.Struct({
  requestedAt: Schema.Number,
  requestedBy: Schema.String,
  deletesAt: Schema.Number,
  exportId: Schema.String,
  /** Set while the Workflow is emptying things, then on the tombstone. */
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
})
export type DeletionRecord = typeof DeletionRecord.Type

const PENDING_KEY = "workspace_deletion"
const TOMBSTONE_KEY = "workspace_deleted"

export class DeletionRefused extends Schema.TaggedError<DeletionRefused>()("DeletionRefused", {
  reason: Schema.Literals(["not-owner", "name-mismatch", "already-deleting", "not-deleting", "deleted"]),
  message: Schema.String,
}) {}

/** The 409 answer to a send while the workspace is being deleted. */
export class WorkspaceDeleting extends Schema.TaggedError<WorkspaceDeleting>()("WorkspaceDeleting", {
  deletesAt: Schema.Number,
}) {}

export const DELETING_ERROR = "WorkspaceDeleting: the workspace is being deleted, so nothing more is sent"

const readSetting = Effect.fn("deletion.read")(function* (key: string) {
  const database = yield* Database
  const row = yield* database.query("settings.deletion", (db) =>
    db.select().from(settings).where(eq(settings.key, key)).get(),
  )
  const decoded = Schema.decodeUnknownOption(DeletionRecord)(row?.value)
  return decoded._tag === "Some" ? decoded.value : null
})

const writeSetting = Effect.fn("deletion.write")(function* (key: string, value: DeletionRecord) {
  const database = yield* Database
  const now = Date.now()
  yield* database.query("settings.deletion.put", (db) =>
    db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run(),
  )
})

// The pending deletion, cached per isolate for 30 seconds: every response and every send asks.
let cache: { readonly at: number; readonly value: DeletionRecord | null } | null = null
const CACHE_MS = 30_000

/** Forgets the cached state, after this isolate requested or cancelled a deletion. */
export const forgetDeletionCache = () => {
  cache = null
}

/** The deletion in progress, if any (cached for 30 seconds per isolate). */
export const pendingDeletion = Effect.fn("deletion.pending")(function* (now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.value
  const value = yield* readSetting(PENDING_KEY).pipe(Effect.orElseSucceed(() => null))
  cache = { at: now, value }
  return value
})

/** Fails with WorkspaceDeleting while a deletion is pending: for the endpoints that send. */
export const refuseWhileDeleting = Effect.fn("deletion.refuse")(function* () {
  const pending = yield* pendingDeletion()
  if (pending) return yield* new WorkspaceDeleting({ deletesAt: pending.deletesAt })
})

/** Only the owner, or the admin key while nobody owns the workspace. */
const requireOwner = Effect.fn("deletion.requireOwner")(function* (caller: Caller) {
  if (caller.member?.role === "owner") return
  if (caller.keyId === ROOT.keyId && !caller.member) {
    const setting = yield* workspaceSetting()
    if (setting.claimedAt === undefined) return
    return yield* new DeletionRefused({
      reason: "not-owner",
      message: "This workspace has an owner now; only they can delete it.",
    })
  }
  return yield* new DeletionRefused({
    reason: "not-owner",
    message: "Only the workspace's owner can delete it.",
  })
})

/** Tells the person who asked, if they're a person: when it happens, and where the export is. */
const mailRequester = Effect.fn("deletion.mail")(function* (
  caller: Caller,
  record: DeletionRecord,
  workspaceName: string,
  origin: string,
  kind: "scheduled" | "restored",
) {
  if (!caller.member) return
  const env = yield* Bindings
  const raw = env.MAILYARD_SYSTEM_FROM ?? env.DEFAULT_FROM
  if (!raw) return
  const from = parseParty(raw)
  const when = new Date(record.deletesAt).toUTCString()
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const subject =
    kind === "scheduled" ? `${workspaceName} will be deleted on ${when}` : `${workspaceName} won't be deleted`
  const html =
    kind === "scheduled"
      ? `<p>You asked to delete ${esc(workspaceName)}. Everything in it will be deleted on ${esc(when)}.</p><p>A full export is being made now. Download it from <a href="${esc(origin)}/settings/workspace">the workspace settings</a> (or <code>GET /v1/exports/${esc(record.exportId)}</code>) before then.</p><p>Until then nothing more is sent, mail still arrives, and you can call it off from the same page.</p>`
      : `<p>The deletion of ${esc(workspaceName)} was called off. Sending is back on.</p>`
  const text =
    kind === "scheduled"
      ? `You asked to delete ${workspaceName}. Everything in it will be deleted on ${when}.\n\nA full export is being made now. Download it from ${origin}/settings/workspace (or GET /v1/exports/${record.exportId}) before then.\n\nUntil then nothing more is sent, mail still arrives, and you can call it off from the same page.\n`
      : `The deletion of ${workspaceName} was called off. Sending is back on.\n`
  yield* sendBulkMessage({
    stream: "system",
    message: {
      from: from.name ? { email: from.email, name: from.name } : { email: from.email },
      to: [{ email: caller.member.email, name: caller.member.name }],
      subject,
      html,
      text,
    },
    contactId: null,
    campaignId: null,
    idempotencyKey: `workspace-deletion:${kind}:${record.requestedAt}`,
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("deletion notice not sent", cause)))
})

/**
 * `DELETE /v1/workspace { confirm }`: schedules the deletion 7 days out, after the exact workspace
 * name is typed, and starts the export at once. `startExport` and `startDeletion` start the two
 * Workflows; the deletion one sleeps until `deletesAt`.
 */
export const requestDeletion = Effect.fn("deletion.request")(function* (
  caller: Caller,
  confirm: string,
  origin: string,
  start: {
    readonly export: (exportId: string) => Promise<void>
    readonly deletion: (record: DeletionRecord) => Promise<void>
  },
  now = Date.now(),
) {
  yield* requireOwner(caller)
  if (yield* readSetting(TOMBSTONE_KEY))
    return yield* new DeletionRefused({
      reason: "deleted",
      message: "This workspace has already been deleted.",
    })
  const pending = yield* readSetting(PENDING_KEY)
  if (pending)
    return yield* new DeletionRefused({
      reason: "already-deleting",
      message: `The workspace is already being deleted, on ${new Date(pending.deletesAt).toUTCString()}.`,
    })
  const workspace = yield* currentWorkspace(origin)
  if (confirm !== workspace.name)
    return yield* new DeletionRefused({
      reason: "name-mismatch",
      message: `Type the workspace's name exactly (${workspace.name}) to delete it.`,
    })
  const exportId = yield* createWorkspaceExport(caller.keyId, start.export)
  const record: DeletionRecord = {
    requestedAt: now,
    requestedBy: caller.keyId,
    deletesAt: now + DELETION_GRACE_MS,
    exportId,
  }
  yield* writeSetting(PENDING_KEY, record)
  forgetDeletionCache()
  yield* Effect.tryPromise({ try: () => start.deletion(record), catch: (cause) => cause }).pipe(
    // The hourly sweep starts it if this didn't (`ensureDeletionWorkflow`).
    Effect.catchCause((cause) => Effect.logError("workspace deletion: workflow did not start", cause)),
  )
  yield* recordAudit({
    actor: caller.keyId,
    action: "workspace.delete.request",
    target: workspace.id,
    after: record,
  })
  yield* mailRequester(caller, record, workspace.name, origin, "scheduled")
  return record
})

/** `POST /v1/workspace/restore`: calls the deletion off; sending is back on at once. */
export const restoreWorkspace = Effect.fn("deletion.restore")(function* (
  caller: Caller,
  origin: string,
  stop: () => Promise<void>,
) {
  yield* requireOwner(caller)
  const pending = yield* readSetting(PENDING_KEY)
  if (!pending)
    return yield* new DeletionRefused({
      reason: "not-deleting",
      message: "The workspace isn't being deleted.",
    })
  if (pending.startedAt !== undefined)
    return yield* new DeletionRefused({
      reason: "deleted",
      message: "The deletion has already started; it can't be called off.",
    })
  const database = yield* Database
  yield* database.query("settings.deletion.clear", (db) =>
    db.delete(settings).where(eq(settings.key, PENDING_KEY)).run(),
  )
  forgetDeletionCache()
  // The Workflow re-checks before deleting anything, so a failed stop is harmless.
  yield* Effect.tryPromise({ try: stop, catch: (cause) => cause }).pipe(Effect.ignore)
  const workspace = yield* currentWorkspace(origin)
  yield* recordAudit({
    actor: caller.keyId,
    action: "workspace.delete.restore",
    target: workspace.id,
    before: pending,
  })
  yield* mailRequester(caller, pending, workspace.name, origin, "restored")
  return { restored: true as const }
})

/**
 * `GET /v1/workspace/deletion`: whether the workspace is being deleted or was, and (to the owner,
 * after it was) fresh links to the export made when it was asked for.
 */
export const deletionStatus = Effect.fn("deletion.status")(function* (caller: Caller, origin: string) {
  const tombstone = yield* readSetting(TOMBSTONE_KEY)
  const pending = tombstone ? null : yield* readSetting(PENDING_KEY)
  const record = tombstone ?? pending
  if (!record) return { status: "none" as const, deletion: null, files: [] }
  const status = tombstone
    ? ("deleted" as const)
    : pending?.startedAt !== undefined
      ? ("deleting" as const)
      : ("scheduled" as const)
  const owner = caller.member?.role === "owner" || caller.keyId === ROOT.keyId
  const files =
    tombstone && owner
      ? yield* Effect.gen(function* () {
          const { STORE } = yield* Bindings
          const listed = yield* Effect.promise(() =>
            STORE.list({ prefix: `exports/${tombstone.exportId}/`, limit: 200 }),
          )
          const out: Array<{ name: string; url: string }> = []
          for (const key of listed.objects.map((o) => o.key)) {
            const name = key.slice(`exports/${tombstone.exportId}/`.length)
            const token = yield* signFileToken(
              { k: key, n: name.replaceAll("/", "-"), t: "application/octet-stream", d: "attachment" },
              86_400,
            )
            out.push({ name, url: fileUrl(origin, token) })
          }
          return out
        })
      : []
  return { status, deletion: record, files }
})

// ---------------------------------------------------------------------------------------------
// The Workflow's steps
// ---------------------------------------------------------------------------------------------

/** Whether to go ahead: still requested (not restored) and due. Marks it started. */
export const beginDeletion = Effect.fn("deletion.begin")(function* (now = Date.now()) {
  const pending = yield* readSetting(PENDING_KEY)
  if (!pending) return null
  if (now < pending.deletesAt) return null
  const started = { ...pending, startedAt: pending.startedAt ?? now }
  yield* writeSetting(PENDING_KEY, started)
  forgetDeletionCache()
  return started
})

/** Every mailbox whose Durable Object holds mail. */
export const mailboxesToErase = Effect.fn("deletion.mailboxes")(function* () {
  const database = yield* Database
  const rows = yield* database.query("deletion.mailboxes", (db) =>
    db.select({ id: mailboxes.id, kind: mailboxes.kind }).from(mailboxes).all(),
  )
  return rows.filter((m) => HOLDS_MAIL.has(m.kind)).map((m) => m.id)
})

export const eraseMailbox = Effect.fn("deletion.eraseMailbox")(function* (mailboxId: string) {
  yield* (yield* Mailboxes).erase(mailboxId)
})

/**
 * Deletes one page of R2 objects (up to 1000), keeping the deletion export's files. Returns the
 * cursor for the next page, or null when the bucket has nothing else.
 */
export const wipeObjectsPage = Effect.fn("deletion.wipeObjects")(function* (
  keepExportId: string,
  cursor: string | null,
) {
  const { STORE } = yield* Bindings
  const keep = `exports/${keepExportId}/`
  const page = yield* Effect.promise(() => STORE.list({ limit: 1000, ...(cursor ? { cursor } : {}) }))
  const doomed = page.objects.map((o) => o.key).filter((k) => !k.startsWith(keep))
  if (doomed.length > 0) yield* Effect.promise(() => STORE.delete(doomed))
  return { deleted: doomed.length, cursor: page.truncated ? page.cursor : null }
})

/** Tables never emptied: D1's own, SQLite's, and Drizzle's migration record. */
const SYSTEM_TABLE = /^(sqlite_|_cf_|d1_migrations$|__drizzle)/

/** Every application table, for the wipe. */
export const tablesToWipe = Effect.fn("deletion.tables")(function* () {
  const { DB } = yield* Bindings
  const rows = yield* Effect.promise(() =>
    DB.prepare("select name from sqlite_master where type = 'table' order by name").all<{ name: string }>(),
  )
  return rows.results.map((r) => r.name).filter((n) => !SYSTEM_TABLE.test(n))
})

/**
 * Deletes up to 2000 rows of a table; the Workflow calls it until it reports 0. `settings` keeps
 * the workspace's id and the deletion record, which becomes the tombstone. A table a foreign key
 * still points into is retried after the others.
 */
export const wipeTablePage = Effect.fn("deletion.wipeTable")(function* (table: string) {
  const { DB } = yield* Bindings
  if (SYSTEM_TABLE.test(table) || !/^[a-z0-9_]+$/.test(table)) return { deleted: 0, blocked: false }
  const keep =
    table === "settings" ? ` where key not in ('workspace', '${PENDING_KEY}', '${TOMBSTONE_KEY}')` : ""
  const result = yield* Effect.tryPromise({
    try: () =>
      DB.prepare(
        `delete from "${table}" where rowid in (select rowid from "${table}"${keep} limit 2000)`,
      ).run(),
    catch: (cause) => cause,
  }).pipe(Effect.result)
  if (result._tag === "Failure") {
    const message = String((result.failure as Error)?.message ?? result.failure)
    if (/FOREIGN KEY/i.test(message)) return { deleted: 0, blocked: true }
    return yield* Effect.die(result.failure)
  }
  return { deleted: result.success.meta.changes ?? 0, blocked: false }
})

/** Writes the tombstone: when, by whom, and the export kept. The workspace is gone. */
export const finishDeletion = Effect.fn("deletion.finish")(function* (now = Date.now()) {
  const pending = yield* readSetting(PENDING_KEY)
  if (!pending) return null
  const tombstone = { ...pending, completedAt: now }
  yield* writeSetting(TOMBSTONE_KEY, tombstone)
  const database = yield* Database
  yield* database.query("settings.deletion.done", (db) =>
    db.delete(settings).where(eq(settings.key, PENDING_KEY)).run(),
  )
  forgetDeletionCache()
  return tombstone
})

/**
 * The hourly backstop: a deletion that's due but whose Workflow never started (the request's start
 * failed, or it was lost) is started now. Starting it twice is harmless: the instance id is fixed
 * and the Workflow re-checks before deleting anything.
 */
export const ensureDeletionStarted = Effect.fn("deletion.ensure")(function* (
  start: (requestedAt: number, deletesAt: number) => Promise<void>,
  now = Date.now(),
) {
  const pending = yield* readSetting(PENDING_KEY)
  if (!pending || pending.startedAt !== undefined || now < pending.deletesAt) return false
  yield* Effect.tryPromise({
    try: () => start(pending.requestedAt, pending.deletesAt),
    catch: (cause) => cause,
  }).pipe(
    // Already running under that id: nothing to do.
    Effect.ignore,
  )
  return true
})

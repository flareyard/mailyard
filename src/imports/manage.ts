import { and, desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { mailboxExports, mailboxImports } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { SecretBox } from "../domain/webhooks.ts"
import { ImapClient } from "../imap/client.ts"
import { Ids } from "../kit/index.ts"
import { fileUrl, LARGE_ATTACHMENT_LINK_TTL_SECONDS, signFileToken } from "../mail/files.ts"
import { Database } from "../services/Database.ts"
import { mapFolder } from "./folders.ts"
import { ImapConnector, notifyProgress } from "./importer.ts"
import { importView } from "./view.ts"

export class TransferInvalid extends Schema.TaggedError<TransferInvalid>()("TransferInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class TransferNotFound extends Schema.TaggedError<TransferNotFound>()("TransferNotFound", {
  id: Schema.String,
}) {}

/** Releases an RPC stub such as a Workflow instance handle, when the runtime gives it a disposer. */
const dispose = (stub: unknown) => {
  const disposer = (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(stub)
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i

type ImportRow = typeof mailboxImports.$inferSelect
type ExportRow = typeof mailboxExports.$inferSelect

const describeImport = (r: ImportRow) => importView(r)

export type ImportSummary = ReturnType<typeof describeImport>

export interface ImapImportInput {
  readonly source: "imap"
  readonly host: string
  readonly port?: number | undefined
  readonly username: string
  readonly password: string
  readonly folders?: ReadonlyArray<string> | undefined
  readonly mode?: "full" | "catchup" | undefined
}

export interface MboxImportInput {
  readonly source: "mbox"
  /** An upload of this mailbox (POST /uploads), or an earlier export (of any mailbox the key may read). */
  readonly uploadKey?: string | undefined
  readonly exportId?: string | undefined
}

/**
 * Starts an import. The IMAP password is sealed (AES-GCM under a deploy secret) for as long as the
 * Workflow runs and wiped when it ends; it is never returned or logged.
 */
export const createImport = Effect.fn("imports.create")(function* (
  mailboxId: string,
  input: ImapImportInput | MboxImportInput,
  actor: string,
  retry?: { readonly retryOf: string; readonly uids: Record<string, ReadonlyArray<number>> },
) {
  const database = yield* Database
  const id = `imx_${yield* (yield* Ids).next}`
  if (input.source === "imap") {
    const host = input.host.trim().toLowerCase()
    if (!HOSTNAME.test(host))
      return yield* new TransferInvalid({ field: "host", message: `${input.host} is not a host name.` })
    const port = input.port ?? 993
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return yield* new TransferInvalid({ field: "port", message: "A port is 1 to 65535." })
    if (port === 143)
      return yield* new TransferInvalid({
        field: "port",
        message: "Imports use implicit TLS (993); plain IMAP on 143 isn't offered.",
      })
    if (!input.username.trim() || !input.password)
      return yield* new TransferInvalid({
        field: "username",
        message: "An IMAP import needs a username and password.",
      })
    const sealed = yield* (yield* SecretBox).seal(input.password)
    yield* database.query("imports.insert", (db) =>
      db
        .insert(mailboxImports)
        .values({
          id,
          mailboxId,
          source: "imap",
          mode: input.mode ?? "full",
          host,
          port,
          username: input.username.trim(),
          secretCiphertext: sealed,
          folders: input.folders?.length ? [...input.folders] : null,
          status: "pending",
          createdBy: actor,
          ...(retry ? { retryOf: retry.retryOf, uids: retry.uids } : {}),
        })
        .run(),
    )
  } else {
    let objectKey: string
    if (input.exportId) {
      const exported = yield* database.query("imports.exportSource", (db) =>
        db
          .select()
          .from(mailboxExports)
          .where(eq(mailboxExports.id, input.exportId as string))
          .get(),
      )
      if (exported?.status !== "complete" || !exported.r2Key) {
        return yield* new TransferInvalid({
          field: "exportId",
          message: `Export ${input.exportId} isn't complete.`,
        })
      }
      objectKey = exported.r2Key
    } else if (input.uploadKey?.startsWith(`upl/${mailboxId}/`)) {
      objectKey = input.uploadKey
    } else {
      return yield* new TransferInvalid({
        field: "uploadKey",
        message: "Name an upload of this mailbox, or an export.",
      })
    }
    yield* database.query("imports.insertMbox", (db) =>
      db
        .insert(mailboxImports)
        .values({
          id,
          mailboxId,
          source: "mbox",
          mode: "full",
          objectKey,
          status: "pending",
          createdBy: actor,
        })
        .run(),
    )
  }
  const { IMPORT_WORKFLOW } = yield* Bindings
  const workflowId = yield* Effect.tryPromise({
    try: async () => {
      // The instance handle is an RPC stub: read what's needed and dispose of it straight away.
      const instance = await IMPORT_WORKFLOW.create({ id, params: { importId: id } })
      try {
        return instance.id
      } finally {
        dispose(instance)
      }
    },
    catch: (cause) =>
      new TransferInvalid({
        field: "workflow",
        message: `Could not start the import: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  yield* database.query("imports.workflow", (db) =>
    db.update(mailboxImports).set({ workflowId }).where(eq(mailboxImports.id, id)).run(),
  )
  yield* recordAudit({
    actor,
    action: "import.started",
    target: id,
    after: { mailboxId, source: input.source, host: input.source === "imap" ? input.host : null },
  })
  return yield* getImport(mailboxId, id)
})

const findImport = (mailboxId: string, id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("imports.get", (db) =>
      db
        .select()
        .from(mailboxImports)
        .where(and(eq(mailboxImports.id, id), eq(mailboxImports.mailboxId, mailboxId)))
        .get(),
    )
    if (!row) return yield* new TransferNotFound({ id })
    return row
  })

export const getImport = Effect.fn("imports.get")(function* (mailboxId: string, id: string) {
  return describeImport(yield* findImport(mailboxId, id))
})

export const listImports = Effect.fn("imports.list")(function* (mailboxId: string) {
  const database = yield* Database
  const rows = yield* database.query("imports.list", (db) =>
    db
      .select()
      .from(mailboxImports)
      .where(eq(mailboxImports.mailboxId, mailboxId))
      .orderBy(desc(mailboxImports.createdAt))
      .limit(50)
      .all(),
  )
  return rows.map(describeImport)
})

/** Stops an import: its Workflow is ended and the credentials are wiped at once. */
export const cancelImport = Effect.fn("imports.cancel")(function* (
  mailboxId: string,
  id: string,
  actor: string,
) {
  const row = yield* findImport(mailboxId, id)
  if (row.status === "complete" || row.status === "failed" || row.status === "cancelled")
    return describeImport(row)
  const database = yield* Database
  yield* database.query("imports.cancel", (db) =>
    db
      .update(mailboxImports)
      .set({ status: "cancelled", secretCiphertext: null, finishedAt: Date.now() })
      .where(eq(mailboxImports.id, id))
      .run(),
  )
  const { IMPORT_WORKFLOW } = yield* Bindings
  yield* Effect.tryPromise(async () => {
    const instance = await IMPORT_WORKFLOW.get(row.workflowId ?? id)
    try {
      await instance.terminate()
    } finally {
      dispose(instance)
    }
  }).pipe(Effect.ignore)
  yield* recordAudit({ actor, action: "import.cancelled", target: id })
  return yield* getImport(mailboxId, id)
})

const workflowOf = (row: ImportRow) =>
  Effect.gen(function* () {
    const { IMPORT_WORKFLOW } = yield* Bindings
    return { IMPORT_WORKFLOW, id: row.workflowId ?? row.id }
  })

/** Pauses a running import between batches; nothing is lost, and resume carries on from there. */
export const pauseImport = Effect.fn("imports.pause")(function* (
  mailboxId: string,
  id: string,
  actor: string,
) {
  const row = yield* findImport(mailboxId, id)
  if (row.status !== "running" && row.status !== "pending")
    return yield* new TransferInvalid({
      field: "status",
      message: `The import is ${row.status}; only a running one pauses.`,
    })
  const database = yield* Database
  yield* database.query("imports.pause", (db) =>
    db
      .update(mailboxImports)
      .set({ status: "paused", pausedAt: Date.now() })
      .where(eq(mailboxImports.id, id))
      .run(),
  )
  yield* recordAudit({ actor, action: "import.paused", target: id })
  yield* notifyProgress(id)
  return yield* getImport(mailboxId, id)
})

export const resumeImport = Effect.fn("imports.resume")(function* (
  mailboxId: string,
  id: string,
  actor: string,
) {
  const row = yield* findImport(mailboxId, id)
  if (row.status !== "paused")
    return yield* new TransferInvalid({
      field: "status",
      message: `The import is ${row.status}, not paused.`,
    })
  const now = Date.now()
  const database = yield* Database
  yield* database.query("imports.resume", (db) =>
    db
      .update(mailboxImports)
      .set({
        status: row.startedAt ? "running" : "pending",
        pausedAt: null,
        pausedMs: row.pausedMs + (row.pausedAt ? now - row.pausedAt : 0),
      })
      .where(eq(mailboxImports.id, id))
      .run(),
  )
  const { IMPORT_WORKFLOW, id: workflowId } = yield* workflowOf(row)
  // A batch that saw the pause is waiting for this; one that hadn't reached it yet just carries on.
  yield* Effect.tryPromise(async () => {
    const instance = await IMPORT_WORKFLOW.get(workflowId)
    try {
      await instance.sendEvent({ type: "resume", payload: { by: actor } })
    } finally {
      dispose(instance)
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning(`imports: resume event for ${id} not delivered`, cause)),
  )
  yield* recordAudit({ actor, action: "import.resumed", target: id })
  yield* notifyProgress(id)
  return yield* getImport(mailboxId, id)
})

/**
 * Starts a new import of just the messages another one failed on, by UID. The source password was
 * wiped when that import ended, so it's given again; only IMAP imports keep their UIDs.
 */
export const retryFailed = Effect.fn("imports.retryFailed")(function* (
  mailboxId: string,
  id: string,
  password: string,
  actor: string,
) {
  const row = yield* findImport(mailboxId, id)
  if (row.source !== "imap" || !row.host || !row.username)
    return yield* new TransferInvalid({
      field: "source",
      message: "Only IMAP imports keep the failed messages' UIDs.",
    })
  if (row.status === "running" || row.status === "pending" || row.status === "paused")
    return yield* new TransferInvalid({ field: "status", message: "Wait for the import to finish first." })
  const uids = Object.fromEntries(
    (row.progress ?? [])
      .filter((p) => (p.failedUids ?? []).length > 0)
      .map((p) => [p.raw, p.failedUids ?? []]),
  )
  if (Object.keys(uids).length === 0)
    return yield* new TransferInvalid({
      field: "id",
      message: "Nothing in this import failed with a UID to retry.",
    })
  const created = yield* createImport(
    mailboxId,
    { source: "imap", host: row.host, port: row.port ?? 993, username: row.username, password, mode: "full" },
    actor,
    { retryOf: id, uids },
  )
  return created
})

/**
 * Looks at an IMAP account before importing: each folder, how many messages it holds, and where it
 * would land (or that it's skipped). The password is used for this one connection and kept nowhere.
 */
export const probeImap = Effect.fn("imports.probe")(function* (input: {
  readonly host: string
  readonly port?: number | undefined
  readonly username: string
  readonly password: string
}) {
  const host = input.host.trim().toLowerCase()
  if (!HOSTNAME.test(host))
    return yield* new TransferInvalid({ field: "host", message: `${input.host} is not a host name.` })
  const port = input.port ?? 993
  if (port === 143)
    return yield* new TransferInvalid({
      field: "port",
      message: "Imports use implicit TLS (993); plain IMAP on 143 isn't offered.",
    })
  const transport = yield* (yield* ImapConnector)
    .open(host, port)
    .pipe(Effect.mapError((e) => new TransferInvalid({ field: "host", message: e.message })))
  const client = new ImapClient(transport)
  const folders = yield* Effect.tryPromise({
    try: async () => {
      {
        await client.greet()
        await client.login(input.username.trim(), input.password)
        const listed = await client.list()
        const out: Array<{
          name: string
          messages: number | null
          folder: string | null
          label: string | null
          skipped: boolean
          skipReason: string | null
        }> = []
        for (const f of listed) {
          const mapping = mapFolder(f.name, f.flags)
          const info = mapping.skip ? null : await client.examine(f)
          out.push({
            name: f.name,
            messages: info ? info.exists : null,
            folder: mapping.skip ? null : mapping.folder,
            label: mapping.skip ? null : mapping.label,
            skipped: mapping.skip !== null,
            skipReason: mapping.skip,
          })
        }
        await client.logout()
        return out
      }
    },
    catch: (e) =>
      new TransferInvalid({
        field: "username",
        message: `IMAP: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })
  return { host, port, folders }
})

const describeExport = (
  r: ExportRow,
  links: { readonly mbox: string | null; readonly zip: string | null; readonly expiresAt: number | null },
) => ({
  id: r.id,
  status: r.status,
  format: r.format,
  messageCount: r.messageCount,
  size: r.size,
  zipSize: r.zipSize,
  error: r.error,
  downloads: { mbox: links.mbox, zip: links.zip },
  /** When these download links stop working; a fresh pair comes with every read of the export. */
  downloadsExpireAt: links.expiresAt,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
})

/** Links that work for a week without a key; a fresh pair on every read. */
const linksFor = (r: ExportRow, origin: string | null) =>
  Effect.gen(function* () {
    if (r.status !== "complete" || !origin) return { mbox: null, zip: null, expiresAt: null }
    const sign = (key: string | null, name: string, type: string) =>
      key
        ? signFileToken(
            { k: key, n: name, t: type, d: "attachment" },
            LARGE_ATTACHMENT_LINK_TTL_SECONDS,
          ).pipe(Effect.map((t) => fileUrl(origin, t)))
        : Effect.succeed(null)
    return {
      mbox: yield* sign(r.r2Key, `${r.mailboxId}.mbox`, "application/mbox"),
      zip: yield* sign(r.zipKey, `${r.mailboxId}.zip`, "application/zip"),
      expiresAt: Date.now() + LARGE_ATTACHMENT_LINK_TTL_SECONDS * 1000,
    }
  })

export const createExport = Effect.fn("exports.create")(function* (
  mailboxId: string,
  actor: string,
  origin: string | null,
) {
  const database = yield* Database
  const id = `exp_${yield* (yield* Ids).next}`
  yield* database.query("exports.insert", (db) =>
    db.insert(mailboxExports).values({ id, mailboxId, status: "pending", format: "both" }).run(),
  )
  const { EXPORT_WORKFLOW } = yield* Bindings
  yield* Effect.tryPromise({
    try: async () => dispose(await EXPORT_WORKFLOW.create({ id, params: { exportId: id } })),
    catch: (cause) =>
      new TransferInvalid({
        field: "workflow",
        message: `Could not start the export: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  yield* recordAudit({ actor, action: "export.started", target: id, after: { mailboxId } })
  return yield* getExport(mailboxId, id, origin)
})

export const getExport = Effect.fn("exports.get")(function* (
  mailboxId: string,
  id: string,
  origin: string | null,
) {
  const database = yield* Database
  const row = yield* database.query("exports.get", (db) =>
    db
      .select()
      .from(mailboxExports)
      .where(and(eq(mailboxExports.id, id), eq(mailboxExports.mailboxId, mailboxId)))
      .get(),
  )
  if (!row) return yield* new TransferNotFound({ id })
  return describeExport(row, yield* linksFor(row, origin))
})

export const listExports = Effect.fn("exports.list")(function* (mailboxId: string) {
  const database = yield* Database
  const rows = yield* database.query("exports.list", (db) =>
    db
      .select()
      .from(mailboxExports)
      .where(eq(mailboxExports.mailboxId, mailboxId))
      .orderBy(desc(mailboxExports.createdAt))
      .limit(50)
      .all(),
  )
  return rows.map((r) => describeExport(r, { mbox: null, zip: null, expiresAt: null }))
})

import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { mailboxExports, mailboxImports } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { SecretBox } from "../domain/webhooks.ts"
import { Ids } from "../kit/index.ts"
import { fileUrl, LARGE_ATTACHMENT_LINK_TTL_SECONDS, signFileToken } from "../mail/files.ts"
import { Database } from "../services/Database.ts"

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

/** An import as the API shows it: never the password, and totals summed across folders. */
const describeImport = (r: ImportRow) => {
  const progress = r.progress ?? []
  const sum = (key: "source" | "imported" | "duplicates" | "failed" | "skipped") =>
    progress.reduce((n, p) => n + (p[key] ?? 0), 0)
  return {
    id: r.id,
    source: r.source,
    mode: r.mode,
    host: r.host,
    port: r.port,
    username: r.username,
    status: r.status,
    error: r.error,
    folders: progress.map(({ raw: _, ...p }) => p),
    totals: {
      source: sum("source"),
      imported: sum("imported"),
      duplicates: sum("duplicates"),
      failed: sum("failed"),
      skipped: sum("skipped"),
    },
    /** Every message the source listed was imported, was already here, or is accounted for as failed or skipped. */
    accountedFor:
      r.status === "complete" &&
      sum("source") === sum("imported") + sum("duplicates") + sum("failed") + sum("skipped"),
    credentialsHeld: r.secretCiphertext !== null,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }
}

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

const describeExport = (
  r: ExportRow,
  links: { readonly mbox: string | null; readonly zip: string | null },
) => ({
  id: r.id,
  status: r.status,
  format: r.format,
  messageCount: r.messageCount,
  size: r.size,
  zipSize: r.zipSize,
  error: r.error,
  downloads: links,
  createdAt: r.createdAt,
  completedAt: r.completedAt,
})

/** Links that work for a week without a key; a fresh pair on every read. */
const linksFor = (r: ExportRow, origin: string | null) =>
  Effect.gen(function* () {
    if (r.status !== "complete" || !origin) return { mbox: null, zip: null }
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
  return rows.map((r) => describeExport(r, { mbox: null, zip: null }))
})

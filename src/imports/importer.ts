import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Bindings } from "../Bindings.ts"
import { type ImportFolderProgress, mailboxes, mailboxImports } from "../db/schema.ts"
import { SecretBox } from "../domain/webhooks.ts"
import { ImapClient, type Transport } from "../imap/client.ts"
import { tlsTransport } from "../imap/transport.ts"
import { parseMessage, sha256Hex } from "../inbound/parse.ts"
import { deliveryFrom, rawKeyOf, storeParsedParts } from "../inbound/pipeline.ts"
import { BlobStore } from "../kit/index.ts"
import { callMailbox } from "../mail/rpc.ts"
import type { Folder } from "../mailbox/types.ts"
import { Database } from "../services/Database.ts"
import { mapFolder } from "./folders.ts"
import { mboxMessage } from "./mbox.ts"

/**
 * Batch limits for one Workflow step: a step reconnects, fetches the batch and files it, so a batch
 * must fit comfortably in a step's 30 s of CPU and an isolate's memory. Spike S5 (HAL-3118) measures
 * these against Spacemail from a deployed Worker.
 */
export const IMPORT_BATCH = { maxMessages: 50, maxBytes: 10 * 1024 * 1024 } as const
/** UIDs per size-only FETCH while planning, to keep each response small. */
const PLAN_FETCH_CHUNK = 500

export class ImportNotFound extends Schema.TaggedError<ImportNotFound>()("ImportNotFound", {
  id: Schema.String,
}) {}
export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  message: Schema.String,
}) {}

/** Opens IMAP connections: TLS through Workers `connect()` on Cloudflare; a scripted server in tests. */
export class ImapConnector extends Context.Service<
  ImapConnector,
  { open(host: string, port: number): Effect.Effect<Transport, ImportFailed> }
>()("mailyard/ImapConnector") {
  static readonly layer = Layer.succeed(
    ImapConnector,
    ImapConnector.of({
      open: (host, port) =>
        Effect.tryPromise({
          try: () => tlsTransport(host, port),
          catch: (cause) =>
            new ImportFailed({
              message: `Could not connect to ${host}:${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }),
    }),
  )
}

type ImportRow = typeof mailboxImports.$inferSelect

/** A batch: UIDs of one IMAP folder, or byte ranges of an mbox file. */
type Batch =
  | { readonly uids: ReadonlyArray<number> }
  | { readonly ranges: ReadonlyArray<{ readonly offset: number; readonly length: number }> }

interface Plan {
  readonly folders: ReadonlyArray<ImportFolderProgress & { readonly batchList: ReadonlyArray<Batch> }>
}

const planKey = (importId: string) => `imports/${importId}/plan.json`

const loadImport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("imports.find", (db) =>
      db.select().from(mailboxImports).where(eq(mailboxImports.id, id)).get(),
    )
    if (!row) return yield* new ImportNotFound({ id })
    return row
  })

const saveImport = (id: string, set: Partial<typeof mailboxImports.$inferInsert>) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("imports.update", (db) =>
      db.update(mailboxImports).set(set).where(eq(mailboxImports.id, id)).run(),
    )
  })

const errorText = (e: unknown) =>
  e instanceof Error
    ? e.message
    : typeof e === "object" && e && "message" in e
      ? String(e.message)
      : String(e)

/** Connects and logs in. The password is unsealed only here, inside the step that needs it. */
const connect = Effect.fn("imports.connect")(function* (row: ImportRow) {
  if (!row.host || !row.username || !row.secretCiphertext)
    return yield* new ImportFailed({ message: "This import has no IMAP credentials left." })
  const password = yield* (yield* SecretBox).open(row.secretCiphertext)
  const transport = yield* (yield* ImapConnector).open(row.host, row.port ?? 993)
  const client = new ImapClient(transport)
  yield* Effect.tryPromise({
    try: async () => {
      await client.greet()
      await client.login(row.username as string, password)
    },
    catch: (e) => new ImportFailed({ message: `IMAP login failed: ${errorText(e)}` }),
  })
  return client
})

const imap = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (e) => new ImportFailed({ message: `IMAP ${what}: ${errorText(e)}` }),
  })

/** Splits items into batches no larger than IMPORT_BATCH by count and by bytes. */
const batchBySize = <T>(items: ReadonlyArray<T>, size: (t: T) => number) => {
  const batches: Array<Array<T>> = []
  let current: Array<T> = []
  let bytes = 0
  for (const item of items) {
    const n = size(item)
    if (
      current.length > 0 &&
      (current.length >= IMPORT_BATCH.maxMessages || bytes + n > IMPORT_BATCH.maxBytes)
    ) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += n
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** For a catch-up: where the last complete import from the same account and mailbox got to. */
const previousProgress = Effect.fn("imports.previous")(function* (row: ImportRow) {
  const database = yield* Database
  const last = yield* database.query("imports.previous", (db) =>
    db
      .select({ progress: mailboxImports.progress })
      .from(mailboxImports)
      .where(
        and(
          eq(mailboxImports.mailboxId, row.mailboxId),
          eq(mailboxImports.source, "imap"),
          eq(mailboxImports.status, "complete"),
          eq(mailboxImports.host, row.host ?? ""),
          eq(mailboxImports.username, row.username ?? ""),
        ),
      )
      .orderBy(desc(mailboxImports.createdAt))
      .get(),
  )
  return new Map((last?.progress ?? []).map((p) => [p.raw, p]))
})

/** Scans an mbox stream for message boundaries without holding the file in memory. */
const scanMbox = async (stream: ReadableStream<Uint8Array>) => {
  const fromLines: Array<{ readonly start: number; readonly body: number }> = []
  let offset = 0
  let atLineStart = true
  let probe = "" // the start of the current line, up to 5 bytes, to recognise "From "
  let lineStart = 0
  let pendingFrom = -1
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (let i = 0; i < value.length; i++) {
      const b = value[i] as number
      const position = offset + i
      if (atLineStart) {
        lineStart = position
        probe = ""
        atLineStart = false
      }
      if (probe.length < 5) {
        probe += String.fromCharCode(b)
        if (probe === "From ") pendingFrom = lineStart
      }
      if (b === 0x0a) {
        if (pendingFrom >= 0) {
          fromLines.push({ start: pendingFrom, body: position + 1 })
          pendingFrom = -1
        }
        atLineStart = true
      }
    }
    offset += value.length
  }
  return fromLines.map((f, k) => {
    const next = fromLines[k + 1]?.start ?? offset
    // The blank line before the next From line is the separator, not the message.
    const length = Math.max(0, next - f.body - 1)
    return { offset: f.body, length }
  })
}

/**
 * The first step: works out what to import and in which batches, and stores the plan in R2 (it can be
 * larger than a step's result may be). For IMAP: every importable folder, from UID 1, or for a
 * catch-up from where the last import from the same account stopped (unless UIDVALIDITY changed).
 */
export const planImport = Effect.fn("imports.plan")(function* (importId: string) {
  const row = yield* loadImport(importId)
  if (row.status === "cancelled") return { folders: [], batches: 0, source: row.source }
  yield* saveImport(importId, { status: "running", error: null })
  const folders: Array<Plan["folders"][number]> = []
  if (row.source === "imap") {
    const client = yield* connect(row)
    const previous =
      row.mode === "catchup" ? yield* previousProgress(row) : new Map<string, ImportFolderProgress>()
    const listed = yield* imap("LIST", () => client.list())
    for (const f of listed) {
      const mapping = mapFolder(f.name, f.flags)
      if (mapping.skip) continue
      if (row.folders && !row.folders.some((name) => name === f.name || name === f.raw)) continue
      const info = yield* imap(`EXAMINE ${f.name}`, () => client.examine(f))
      const before = previous.get(f.raw)
      const from = before && before.uidValidity === info.uidValidity ? before.lastUid + 1 : 1
      const uids = info.exists === 0 ? [] : yield* imap(`UID SEARCH ${f.name}`, () => client.searchUids(from))
      const sized: Array<{ uid: number; size: number }> = []
      for (let i = 0; i < uids.length; i += PLAN_FETCH_CHUNK) {
        const chunk = yield* imap(`UID FETCH sizes ${f.name}`, () =>
          client.fetch(uids.slice(i, i + PLAN_FETCH_CHUNK), { body: false }),
        )
        for (const m of chunk) sized.push({ uid: m.uid, size: m.size ?? 0 })
      }
      const batchList = batchBySize(sized, (m) => m.size).map((b) => ({ uids: b.map((m) => m.uid) }))
      folders.push({
        name: f.name,
        raw: f.raw,
        folder: mapping.folder,
        label: mapping.label,
        uidValidity: info.uidValidity,
        source: sized.length,
        imported: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0,
        lastUid: before && before.uidValidity === info.uidValidity ? before.lastUid : 0,
        batches: batchList.length,
        batchesDone: 0,
        batchList,
      })
    }
    yield* Effect.promise(() => client.logout())
  } else {
    if (!row.objectKey) return yield* new ImportFailed({ message: "This mbox import names no file." })
    const { STORE } = yield* Bindings
    const object = yield* Effect.tryPromise({
      try: () => STORE.get(row.objectKey as string),
      catch: (e) => new ImportFailed({ message: `Reading the mbox: ${errorText(e)}` }),
    })
    if (!object) return yield* new ImportFailed({ message: `No mbox at ${row.objectKey}.` })
    const ranges = yield* Effect.promise(() => scanMbox(object.body))
    const batchList = batchBySize(ranges, (r) => r.length).map((b) => ({ ranges: b }))
    folders.push({
      name: "mbox",
      raw: "mbox",
      folder: "inbox",
      label: null,
      uidValidity: null,
      source: ranges.length,
      imported: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      lastUid: 0,
      batches: batchList.length,
      batchesDone: 0,
      batchList,
    })
  }
  yield* (yield* BlobStore).put(
    planKey(importId),
    new TextEncoder().encode(JSON.stringify({ folders } satisfies Plan)),
    "application/json",
  )
  yield* saveImport(importId, { progress: folders.map(({ batchList: _, ...p }) => p) })
  return {
    folders: folders.map((f) => ({ name: f.name, batches: f.batches, source: f.source })),
    batches: folders.reduce((n, f) => n + f.batches, 0),
    source: row.source,
  }
})

type Outcome = "imported" | "duplicates" | "failed"

/**
 * Files one message into the mailbox: raw to R2 first (so nothing is lost), then parsed and delivered
 * under a content-derived id, so a repeated batch stores nothing twice. A Message-ID the mailbox already
 * holds is a duplicate; the copy's folder label is added to the message already there.
 */
export const fileImported = Effect.fn("imports.file")(function* (input: {
  readonly mailboxId: string
  readonly mailboxAddress: string
  readonly raw: Uint8Array
  readonly folder: Folder
  readonly labelIds: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
  readonly receivedAt: number | null
}) {
  const sha256 = yield* Effect.promise(() => sha256Hex(input.raw))
  const id = `imp_${sha256.slice(0, 32)}`
  yield* (yield* BlobStore).put(rawKeyOf(sha256), input.raw, "message/rfc822")
  const parsed = yield* Effect.result(parseMessage(input.raw))
  if (parsed._tag === "Failure") return { outcome: "failed" as Outcome, reason: parsed.failure.reason }
  const message = parsed.success
  if (message.messageId) {
    const holder = yield* callMailbox(input.mailboxId, (s) => s.messageIdHolder(message.messageId as string))
    if (holder) {
      // Already here (the same message filed in another folder, or a re-run batch): it gains this
      // folder's label rather than a second copy.
      if (input.labelIds.length)
        yield* callMailbox(input.mailboxId, (s) => s.addLabelsToMessage(holder, input.labelIds))
      return { outcome: "duplicates" as Outcome, reason: null }
    }
  }
  yield* storeParsedParts(sha256, message)
  const flags = new Set(input.flags.map((f) => f.toLowerCase()))
  const delivery = deliveryFrom(
    {
      id,
      receivedAt: input.receivedAt ?? message.date ?? Date.now(),
      envelopeFrom: message.from?.address ?? "",
      envelopeTo: input.mailboxAddress,
      via: "mailbox",
      tag: null,
      sha256,
      size: input.raw.byteLength,
    },
    message,
  )
  const result = yield* callMailbox(input.mailboxId, (s) =>
    s.deliver(delivery, {
      folder: input.folder,
      labelIds: input.labelIds,
      seen: flags.has("\\seen") || input.folder === "sent",
      starred: flags.has("\\flagged"),
      answered: flags.has("\\answered"),
    }),
  )
  return { outcome: (result.stored ? "imported" : "duplicates") as Outcome, reason: null }
})

/** One batch, one step: reconnect, fetch, file each message, and record progress. */
export const runBatch = Effect.fn("imports.batch")(function* (
  importId: string,
  folderIndex: number,
  batchIndex: number,
) {
  const row = yield* loadImport(importId)
  if (row.status === "cancelled") return { imported: 0, duplicates: 0, failed: 0, skipped: true }
  const blob = yield* (yield* BlobStore).get(planKey(importId))
  if (Option.isNone(blob)) return yield* new ImportFailed({ message: "The import plan is missing." })
  const plan = JSON.parse(new TextDecoder().decode(blob.value.body)) as Plan
  const folder = plan.folders[folderIndex]
  const batch = folder?.batchList[batchIndex]
  if (!folder || !batch)
    return yield* new ImportFailed({ message: `No batch ${folderIndex}.${batchIndex} in the plan.` })
  const database = yield* Database
  const mailbox = yield* database.query("imports.mailbox", (db) =>
    db.select().from(mailboxes).where(eq(mailboxes.id, row.mailboxId)).get(),
  )
  if (!mailbox) return yield* new ImportFailed({ message: "The mailbox no longer exists." })
  const labelIds = folder.label
    ? [(yield* callMailbox(row.mailboxId, (s) => s.ensureLabel(folder.label as string))).id]
    : []
  const counts = { imported: 0, duplicates: 0, failed: 0, skipped: 0 }
  let lastUid = folder.lastUid
  const file = (raw: Uint8Array, flags: ReadonlyArray<string>, receivedAt: number | null) =>
    fileImported({
      mailboxId: row.mailboxId,
      mailboxAddress: mailbox.address,
      raw,
      folder: folder.folder as Folder,
      labelIds,
      flags,
      receivedAt,
    }).pipe(Effect.tap((r) => Effect.sync(() => counts[r.outcome]++)))
  if ("uids" in batch) {
    const client = yield* connect(row)
    yield* imap(`EXAMINE ${folder.name}`, () =>
      client.examine({ name: folder.name, raw: folder.raw, delimiter: null, flags: [] }),
    )
    const messages = yield* imap(`UID FETCH ${folder.name}`, () => client.fetch(batch.uids, { body: true }))
    // A UID the search found but the fetch didn't return was expunged meanwhile: nothing to import.
    counts.skipped += batch.uids.filter((uid) => !messages.some((m) => m.uid === uid)).length
    for (const m of messages) {
      // \Deleted messages are waiting to be expunged on the source; they aren't part of the mailbox.
      if (m.flags.some((f) => f.toLowerCase() === "\\deleted")) {
        counts.skipped++
        lastUid = Math.max(lastUid, m.uid)
        continue
      }
      if (!m.body) {
        counts.failed++
        continue
      }
      yield* file(m.body, m.flags, m.internalDate)
      lastUid = Math.max(lastUid, m.uid)
    }
    yield* Effect.promise(() => client.logout())
  } else {
    const { STORE } = yield* Bindings
    for (const range of batch.ranges) {
      const part = yield* Effect.tryPromise({
        try: async () => {
          const object = await STORE.get(row.objectKey as string, {
            range: { offset: range.offset, length: range.length },
          })
          return object ? new Uint8Array(await object.arrayBuffer()) : null
        },
        catch: (e) => new ImportFailed({ message: `Reading the mbox: ${errorText(e)}` }),
      })
      if (!part) {
        counts.failed++
        continue
      }
      yield* file(mboxMessage(part), [], null)
    }
  }
  // Steps run one at a time, so progress is read, updated and written without a race.
  const current = yield* loadImport(importId)
  const progress = (current.progress ?? []).map((p, i) =>
    i === folderIndex
      ? {
          ...p,
          imported: p.imported + counts.imported,
          duplicates: p.duplicates + counts.duplicates,
          failed: p.failed + counts.failed,
          skipped: p.skipped + counts.skipped,
          lastUid: Math.max(p.lastUid, lastUid),
          batchesDone: p.batchesDone + 1,
        }
      : p,
  )
  yield* saveImport(importId, { progress })
  return { ...counts, skipped: false }
})

/** The last step: the import is complete and its credentials are wiped. */
export const finishImport = Effect.fn("imports.finish")(function* (importId: string) {
  const row = yield* loadImport(importId)
  if (row.status === "cancelled") {
    yield* saveImport(importId, { secretCiphertext: null })
    return row.progress ?? []
  }
  yield* saveImport(importId, {
    status: "complete",
    secretCiphertext: null,
    finishedAt: Date.now(),
    error: null,
  })
  yield* (yield* BlobStore).delete(planKey(importId))
  return row.progress ?? []
})

/** When a step gave up: the import failed, and its credentials are wiped all the same. */
export const failImport = Effect.fn("imports.fail")(function* (importId: string, message: string) {
  yield* saveImport(importId, {
    status: "failed",
    error: message.slice(0, 1000),
    secretCiphertext: null,
    finishedAt: Date.now(),
  })
})

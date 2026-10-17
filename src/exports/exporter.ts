import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { mailboxExports } from "../db/schema.ts"
import { raiseAlert } from "../domain/alerts.ts"
import { mboxEntry } from "../imports/mbox.ts"
import { BlobStore } from "../kit/index.ts"
import { callMailbox } from "../mail/rpc.ts"
import { Database } from "../services/Database.ts"
import { type CentralEntry, centralDirectory, localEntry } from "./zip.ts"

/**
 * Mailbox export: an mboxrd file and a zip of `.eml` files, written to R2 a part at a time across
 * Workflow steps (multipart uploads), so a mailbox of any size exports without holding it in memory.
 * R2 needs every part but the last to be the same size, at least 5 MiB (measured in its docs,
 * 2026-10-17: error 10048 otherwise). So parts are exactly PART_SIZE: each step tops up a buffer from
 * what the last step left over (kept in R2), uploads only whole parts, and leaves the rest for the next.
 */
export const PART_SIZE = 8 * 1024 * 1024
const PAGE = 100

export class ExportNotFound extends Schema.TaggedError<ExportNotFound>()("ExportNotFound", {
  id: Schema.String,
}) {}
export class ExportFailed extends Schema.TaggedError<ExportFailed>()("ExportFailed", {
  message: Schema.String,
}) {}

interface UploadState {
  readonly uploadId: string
  readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>
}

interface ExportState extends Record<string, unknown> {
  readonly mbox: UploadState
  readonly zip: UploadState & { readonly offset: number; readonly cdChunks: number }
  readonly cursor: string | null
  readonly done: boolean
  readonly messages: number
  readonly missing: number
}

export const exportKeys = (exportId: string) => ({
  mbox: `exports/${exportId}/mailbox.mbox`,
  zip: `exports/${exportId}/mailbox.zip`,
  cd: (n: number) => `exports/${exportId}/cd-${n}.json`,
  carry: (file: "mbox" | "zip") => `exports/${exportId}/carry-${file}.bin`,
})

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const r2 = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (e) => new ExportFailed({ message: `R2 ${what}: ${errorText(e)}` }) })

const loadExport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("exports.find", (db) =>
      db.select().from(mailboxExports).where(eq(mailboxExports.id, id)).get(),
    )
    if (!row) return yield* new ExportNotFound({ id })
    return row
  })

const saveExport = (id: string, set: Partial<typeof mailboxExports.$inferInsert>) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.query("exports.update", (db) =>
      db.update(mailboxExports).set(set).where(eq(mailboxExports.id, id)).run(),
    )
  })

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

/** The first step: starts both multipart uploads. */
export const planExport = Effect.fn("exports.plan")(function* (exportId: string) {
  const row = yield* loadExport(exportId)
  const { STORE } = yield* Bindings
  const keys = exportKeys(exportId)
  const total = yield* callMailbox(row.mailboxId, (s) => s.count())
  if (total === 0) {
    // Nothing to stream: an empty mbox, and a zip that is only its (empty) central directory.
    const zipBytes = centralDirectory([], 0)
    yield* r2("empty mbox", () =>
      STORE.put(keys.mbox, new Uint8Array(0), { httpMetadata: { contentType: "application/mbox" } }),
    )
    yield* r2("empty zip", () =>
      STORE.put(keys.zip, zipBytes, { httpMetadata: { contentType: "application/zip" } }),
    )
    yield* saveExport(exportId, {
      status: "complete",
      r2Key: keys.mbox,
      zipKey: keys.zip,
      size: 0,
      zipSize: zipBytes.length,
      messageCount: 0,
      completedAt: Date.now(),
      state: null,
      error: null,
    })
    return { total, complete: true }
  }
  const mbox = yield* r2("start mbox", () =>
    STORE.createMultipartUpload(keys.mbox, { httpMetadata: { contentType: "application/mbox" } }),
  )
  const zip = yield* r2("start zip", () =>
    STORE.createMultipartUpload(keys.zip, { httpMetadata: { contentType: "application/zip" } }),
  )
  const state: ExportState = {
    mbox: { uploadId: mbox.uploadId, parts: [] },
    zip: { uploadId: zip.uploadId, parts: [], offset: 0, cdChunks: 0 },
    cursor: null,
    done: false,
    messages: 0,
    missing: 0,
  }
  yield* saveExport(exportId, { status: "running", state, error: null })
  return { total, complete: false }
})

/**
 * One step: tops up both files from the next messages (newest first, a page at a time) until each has
 * at least one whole part to upload, uploads every whole part, and leaves the remainder in R2 for the
 * next step. When the mailbox runs out, the remainders (and the zip's central directory, whose entries
 * earlier steps kept in R2) go up as the final parts.
 */
export const exportChunk = Effect.fn("exports.chunk")(function* (exportId: string) {
  const row = yield* loadExport(exportId)
  const state = row.state as ExportState | null
  if (!state) return yield* new ExportFailed({ message: "The export hasn't been planned." })
  if (state.done) return { done: true, messages: state.messages }
  const { STORE } = yield* Bindings
  const blobs = yield* BlobStore
  const keys = exportKeys(exportId)
  const carried = (file: "mbox" | "zip") =>
    blobs
      .get(keys.carry(file))
      .pipe(Effect.map((b) => (Option.isSome(b) ? [b.value.body] : ([] as Array<Uint8Array>))))
  const mboxChunks = yield* carried("mbox")
  const zipChunks = yield* carried("zip")
  const size = (chunks: ReadonlyArray<Uint8Array>) => chunks.reduce((n, c) => n + c.length, 0)
  const entries: Array<CentralEntry> = []
  let zipOffset = state.zip.offset
  let cursor = state.cursor
  let messages = state.messages
  let missing = state.missing
  let exhausted = false
  while (size(mboxChunks) < PART_SIZE || size(zipChunks) < PART_SIZE) {
    const page = yield* callMailbox(row.mailboxId, (s) => s.messages({ limit: PAGE, cursor }))
    for (const m of page.messages) {
      const raw = yield* blobs.get(m.rawKey)
      if (Option.isNone(raw)) {
        missing++
        continue
      }
      mboxChunks.push(mboxEntry(raw.value.body, m.envelopeFrom, m.receivedAt))
      const day = new Date(m.date ?? m.receivedAt).toISOString().slice(0, 10)
      const local = localEntry(
        `${m.folder}/${day}-${m.id}.eml`,
        raw.value.body,
        zipOffset,
        m.date ?? m.receivedAt,
      )
      zipChunks.push(local.bytes)
      entries.push(local.entry)
      zipOffset += local.bytes.length
      messages++
    }
    cursor = page.nextCursor
    if (!page.nextCursor) {
      exhausted = true
      break
    }
  }
  if (exhausted) {
    const all: Array<CentralEntry> = []
    for (let n = 0; n < state.zip.cdChunks; n++) {
      const blob = yield* blobs.get(keys.cd(n))
      if (Option.isSome(blob))
        all.push(...(JSON.parse(new TextDecoder().decode(blob.value.body)) as Array<CentralEntry>))
    }
    all.push(...entries)
    zipChunks.push(centralDirectory(all, zipOffset))
  } else if (entries.length > 0) {
    yield* blobs.put(
      keys.cd(state.zip.cdChunks),
      new TextEncoder().encode(JSON.stringify(entries)),
      "application/json",
    )
  }
  /**
   * Uploads whole parts of `bytes` and keeps the rest for the next step. At the end the rest is the
   * final part (the one part allowed to be shorter), so a part is held back only while more may follow.
   */
  const flush = (file: "mbox" | "zip", upload: UploadState, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const multipart = STORE.resumeMultipartUpload(file === "mbox" ? keys.mbox : keys.zip, upload.uploadId)
      const parts = [...upload.parts]
      const send = (slice: Uint8Array) =>
        r2(`${file} part`, () => multipart.uploadPart(parts.length + 1, slice)).pipe(
          Effect.tap((part) =>
            Effect.sync(() => parts.push({ partNumber: part.partNumber, etag: part.etag })),
          ),
        )
      let at = 0
      const more = (left: number) => (exhausted ? left > PART_SIZE : left >= PART_SIZE)
      while (more(bytes.length - at)) {
        yield* send(bytes.subarray(at, at + PART_SIZE))
        at += PART_SIZE
      }
      if (exhausted && at < bytes.length) {
        yield* send(bytes.subarray(at))
        at = bytes.length
      }
      if (at < bytes.length) yield* blobs.put(keys.carry(file), bytes.slice(at), "application/octet-stream")
      else yield* blobs.delete(keys.carry(file))
      return parts
    })
  const mboxParts = yield* flush("mbox", state.mbox, concat(mboxChunks))
  const zipParts = yield* flush("zip", state.zip, concat(zipChunks))
  const next: ExportState = {
    mbox: { uploadId: state.mbox.uploadId, parts: mboxParts },
    zip: {
      uploadId: state.zip.uploadId,
      parts: zipParts,
      offset: zipOffset,
      cdChunks: exhausted || entries.length === 0 ? state.zip.cdChunks : state.zip.cdChunks + 1,
    },
    cursor,
    done: exhausted,
    messages,
    missing,
  }
  yield* saveExport(exportId, { state: next })
  return { done: exhausted, messages }
})

/** The last step: completes both uploads and marks the export complete. */
export const finishExport = Effect.fn("exports.finish")(function* (exportId: string) {
  const row = yield* loadExport(exportId)
  const state = row.state as ExportState | null
  if (!state?.done) return yield* new ExportFailed({ message: "The export isn't finished writing." })
  const { STORE } = yield* Bindings
  const keys = exportKeys(exportId)
  const mbox = yield* r2("complete mbox", () =>
    STORE.resumeMultipartUpload(keys.mbox, state.mbox.uploadId).complete([...state.mbox.parts]),
  )
  const zip = yield* r2("complete zip", () =>
    STORE.resumeMultipartUpload(keys.zip, state.zip.uploadId).complete([...state.zip.parts]),
  )
  const blobs = yield* BlobStore
  for (let n = 0; n < state.zip.cdChunks; n++) yield* blobs.delete(keys.cd(n))
  yield* saveExport(exportId, {
    status: "complete",
    r2Key: keys.mbox,
    zipKey: keys.zip,
    size: mbox.size,
    zipSize: zip.size,
    messageCount: state.messages,
    error:
      state.missing > 0
        ? `${state.missing} message${state.missing === 1 ? " was" : "s were"} missing their original and left out.`
        : null,
    completedAt: Date.now(),
    state: null,
  })
  yield* raiseAlert({
    key: `export_ready:${exportId}`,
    kind: "export_ready",
    severity: "info",
    title: "A mailbox export is ready",
    detail: `${state.messages} message${state.messages === 1 ? "" : "s"}, as mbox and zip. Download them from the mailbox's export screen.`,
    subject: { type: "mailbox_export", id: exportId },
  })
  return { messages: state.messages, missing: state.missing, size: mbox.size, zipSize: zip.size }
})

/** When a step gave up: the uploads are abandoned and the export is marked failed. */
export const failExport = Effect.fn("exports.fail")(function* (exportId: string, message: string) {
  const row = yield* loadExport(exportId)
  const state = row.state as ExportState | null
  if (state) {
    const { STORE } = yield* Bindings
    const keys = exportKeys(exportId)
    yield* Effect.promise(() =>
      STORE.resumeMultipartUpload(keys.mbox, state.mbox.uploadId)
        .abort()
        .catch(() => {}),
    )
    yield* Effect.promise(() =>
      STORE.resumeMultipartUpload(keys.zip, state.zip.uploadId)
        .abort()
        .catch(() => {}),
    )
  }
  yield* saveExport(exportId, { status: "failed", error: message.slice(0, 1000), state: null })
})

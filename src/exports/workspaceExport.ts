import { desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { redactGraph } from "../automations/secrets.ts"
import { Bindings } from "../Bindings.ts"
import {
  apiKeys,
  automations,
  automationVersions,
  campaigns,
  type ExportPart,
  exports,
  forms,
  mailboxExports,
  mailboxes,
  segments,
  settings,
  templates,
  templateVersions,
  topics,
  webhookEndpoints,
} from "../db/schema.ts"
import { raiseAlert } from "../domain/alerts.ts"
import { recordAudit } from "../domain/audit.ts"
import { auditCsv } from "../domain/auditLog.ts"
import { HOLDS_MAIL } from "../domain/mailboxes.ts"
import { createExport as createMailboxExport } from "../imports/manage.ts"
import { BlobStore, Ids } from "../kit/index.ts"
import { fileUrl, signFileToken } from "../mail/files.ts"
import { Database } from "../services/Database.ts"
import { Governor } from "../services/Governor.ts"
import { Mailboxes } from "../services/Mailboxes.ts"
import { ExportNotFound } from "./contactExport.ts"

/**
 * The whole workspace in one export (HAL-3451). WorkspaceExportWorkflow writes each part on its own
 * step, so a retry redoes only the part that failed:
 *
 * - `mail`: each mailbox holding mail, through that mailbox's own export (mbox and a zip of .eml);
 * - `contacts`: every contact as CSV, through the contacts export's paged multipart writer;
 * - `templates`: every template with every version, as JSON;
 * - `lists`: topics, segments, forms, automations (each version) and campaigns, as JSON;
 * - `settings`: brand, compliance and sending, plus webhook endpoints and API keys as metadata;
 * - `audit`: the audit log as CSV;
 * - `manifest`: what's in it, written last.
 *
 * Nothing secret goes in: webhook signing secrets and key hashes are left out, and automation steps'
 * secret fields are redacted as they are in the API.
 */

const LINK_TTL_SECONDS = 24 * 60 * 60

type ExportRow = typeof exports.$inferSelect

const findWorkspaceExport = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* database.query("workspaceExport.get", (db) =>
      db.select().from(exports).where(eq(exports.id, id)).get(),
    )
    if (!row || row.kind !== "workspace") return yield* new ExportNotFound({ id })
    return row
  })

const setBundle = (id: string, bundle: ReadonlyArray<ExportPart>) =>
  Database.use((d) =>
    d.query("workspaceExport.bundle", (db) =>
      db
        .update(exports)
        .set({ bundle: [...bundle] })
        .where(eq(exports.id, id))
        .run(),
    ),
  )

/** Replaces the part matching `match` and saves the bundle. */
const updatePart = (row: ExportRow, match: (p: ExportPart) => boolean, next: Partial<ExportPart>) =>
  setBundle(
    row.id,
    (row.bundle ?? []).map((p) => (match(p) ? ({ ...p, ...next } as ExportPart) : p)),
  )

/** Starts a workspace export; the Workflow does the rest. */
export const createWorkspaceExport = Effect.fn("workspaceExport.create")(function* (
  actor: string,
  startWorkflow: (exportId: string) => Promise<void>,
) {
  const database = yield* Database
  const id = `exp_${yield* (yield* Ids).next}`
  const stamp = new Date().toISOString().slice(0, 10)
  yield* database.query("workspaceExport.insert", (db) =>
    db
      .insert(exports)
      .values({
        id,
        kind: "workspace",
        filter: {},
        fields: [],
        key: `exports/${id}/manifest.json`,
        filename: `mailyard-workspace-${stamp}.json`,
        bundle: [],
        createdBy: actor,
      })
      .run(),
  )
  yield* recordAudit({ actor, action: "workspace.export", target: id })
  yield* Effect.tryPromise({ try: () => startWorkflow(id), catch: (cause) => cause }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("workspace export: workflow did not start", cause).pipe(
        Effect.andThen(failWorkspaceExport(id, "The export couldn't start; try again.")),
      ),
    ),
  )
  return id
})

/** Step 1: which parts there will be. Mailboxes with no mail get no part. */
export const planWorkspaceExport = Effect.fn("workspaceExport.plan")(function* (id: string) {
  const row = yield* findWorkspaceExport(id)
  if (row.bundle && row.bundle.length > 0) return row.bundle
  const database = yield* Database
  const store = yield* Mailboxes
  const all = yield* database.query("workspaceExport.mailboxes", (db) =>
    db.select({ id: mailboxes.id, address: mailboxes.address, kind: mailboxes.kind }).from(mailboxes).all(),
  )
  const mail: Array<ExportPart> = []
  for (const m of all.filter((m) => HOLDS_MAIL.has(m.kind))) {
    const held = yield* store.count(m.id)
    if (held > 0)
      mail.push({
        kind: "mail",
        format: "mbox",
        filename: `mail/${m.address}.mbox`,
        key: null,
        items: held,
        bytes: 0,
        status: "pending",
        mailboxId: m.id,
      })
  }
  const file = (kind: ExportPart["kind"], format: ExportPart["format"], filename: string): ExportPart => ({
    kind,
    format,
    filename,
    key: null,
    items: 0,
    bytes: 0,
    status: "pending",
  })
  const bundle: ReadonlyArray<ExportPart> = [
    ...mail,
    file("contacts", "csv", "contacts.csv"),
    file("templates", "json", "templates.json"),
    file("lists", "json", "lists.json"),
    file("settings", "json", "settings.json"),
    file("audit", "csv", "audit.csv"),
  ]
  yield* setBundle(id, bundle)
  return bundle
})

/** A mail part: starts that mailbox's export (once) and remembers its id. */
export const startMailPart = Effect.fn("workspaceExport.startMail")(function* (
  id: string,
  mailboxId: string,
) {
  const row = yield* findWorkspaceExport(id)
  const part = row.bundle?.find((p) => p.kind === "mail" && p.mailboxId === mailboxId)
  if (!part || part.mailboxExportId) return
  const started = yield* createMailboxExport(mailboxId, row.createdBy, null)
  yield* updatePart(row, (p) => p.kind === "mail" && p.mailboxId === mailboxId, {
    mailboxExportId: started.id,
  })
})

/**
 * Checks the mailbox exports: a finished one gives its part the mbox's key and size. True once every
 * mail part is complete or failed.
 */
export const checkMailParts = Effect.fn("workspaceExport.checkMail")(function* (id: string) {
  const row = yield* findWorkspaceExport(id)
  const database = yield* Database
  let bundle = row.bundle ?? []
  for (const part of bundle.filter((p) => p.kind === "mail" && p.status === "pending" && p.mailboxExportId)) {
    const m = yield* database.query("workspaceExport.mailboxExport", (db) =>
      db
        .select()
        .from(mailboxExports)
        .where(eq(mailboxExports.id, part.mailboxExportId as string))
        .get(),
    )
    if (!m || m.status === "pending" || m.status === "running") continue
    const next: Partial<ExportPart> =
      m.status === "complete"
        ? { status: "complete", key: m.r2Key, bytes: m.size, items: m.messageCount }
        : { status: "failed", error: m.error ?? "The mailbox export failed." }
    bundle = bundle.map((p) => (p === part ? ({ ...p, ...next } as ExportPart) : p))
  }
  yield* setBundle(id, bundle)
  return bundle.every((p) => p.kind !== "mail" || p.status !== "pending")
})

/** Records the contacts part from its finished child export. */
export const recordContactsPart = Effect.fn("workspaceExport.contacts")(function* (
  id: string,
  childId: string,
) {
  const row = yield* findWorkspaceExport(id)
  const database = yield* Database
  const child = yield* database.query("workspaceExport.child", (db) =>
    db.select().from(exports).where(eq(exports.id, childId)).get(),
  )
  if (!child) return
  const { STORE } = yield* Bindings
  const object = yield* Effect.promise(() => STORE.head(child.key))
  yield* updatePart(
    row,
    (p) => p.kind === "contacts",
    child.status === "completed"
      ? { status: "complete", key: child.key, items: child.rows, bytes: object?.size ?? 0 }
      : { status: "failed", error: child.error ?? "The contacts export failed." },
  )
})
/** The contacts part's child export: a contacts export of everyone, owned by this one. */
export const contactsChild = Effect.fn("workspaceExport.contactsChild")(function* (id: string) {
  const row = yield* findWorkspaceExport(id)
  const database = yield* Database
  const existing = yield* database.query("workspaceExport.findChild", (db) =>
    db.select({ id: exports.id }).from(exports).where(eq(exports.parentId, id)).get(),
  )
  if (existing) return existing.id
  const childId = `exp_${yield* (yield* Ids).next}`
  yield* database.query("workspaceExport.insertChild", (db) =>
    db
      .insert(exports)
      .values({
        id: childId,
        kind: "contacts",
        filter: {},
        fields: [],
        key: `exports/${id}/contacts.csv`,
        filename: "contacts.csv",
        parentId: id,
        createdBy: row.createdBy,
      })
      .run(),
  )
  return childId
})

const put = (key: string, body: string, type: string) =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(body)
    yield* (yield* BlobStore).put(key, bytes, type)
    return bytes.byteLength
  })

/** Writes one of the JSON or CSV parts. */
export const writeDataPart = Effect.fn("workspaceExport.data")(function* (
  id: string,
  kind: "templates" | "lists" | "settings" | "audit",
) {
  const row = yield* findWorkspaceExport(id)
  const part = row.bundle?.find((p) => p.kind === kind)
  if (!part || part.status === "complete") return
  const database = yield* Database
  const key = `exports/${id}/${part.filename}`
  let items = 0
  let bytes = 0
  if (kind === "templates") {
    const list = yield* database.query("workspaceExport.templates", (db) => db.select().from(templates).all())
    const versions = yield* database.query("workspaceExport.templateVersions", (db) =>
      db.select().from(templateVersions).orderBy(templateVersions.templateId, templateVersions.version).all(),
    )
    items = list.length
    bytes = yield* put(
      key,
      JSON.stringify(
        list.map((t) => ({ ...t, versions: versions.filter((v) => v.templateId === t.id) })),
        null,
        2,
      ),
      "application/json",
    )
  } else if (kind === "lists") {
    const [topicRows, segmentRows, formRows, automationRows, versionRows, campaignRows] = yield* Effect.all([
      database.query("workspaceExport.topics", (db) => db.select().from(topics).all()),
      database.query("workspaceExport.segments", (db) => db.select().from(segments).all()),
      database.query("workspaceExport.forms", (db) => db.select().from(forms).all()),
      database.query("workspaceExport.automations", (db) => db.select().from(automations).all()),
      database.query("workspaceExport.automationVersions", (db) =>
        db.select().from(automationVersions).all(),
      ),
      database.query("workspaceExport.campaigns", (db) =>
        db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all(),
      ),
    ])
    // Steps' secret fields (an API token in a webhook step, say) are redacted, as in the API.
    const redact = <T extends { readonly graph: unknown }>(r: T) => ({
      ...r,
      graph: r.graph ? redactGraph(r.graph as Parameters<typeof redactGraph>[0]).graph : r.graph,
    })
    const data = {
      topics: topicRows,
      segments: segmentRows,
      forms: formRows,
      automations: automationRows.map((a) => ({
        ...redact(a),
        versions: versionRows.filter((v) => v.automationId === a.id).map(redact),
      })),
      campaigns: campaignRows,
    }
    items =
      topicRows.length + segmentRows.length + formRows.length + automationRows.length + campaignRows.length
    bytes = yield* put(key, JSON.stringify(data, null, 2), "application/json")
  } else if (kind === "settings") {
    const rows = yield* database.query("workspaceExport.settings", (db) => db.select().from(settings).all())
    const webhooks = yield* database.query("workspaceExport.webhooks", (db) =>
      db
        .select({
          id: webhookEndpoints.id,
          url: webhookEndpoints.url,
          description: webhookEndpoints.description,
          events: webhookEndpoints.events,
          enabled: webhookEndpoints.enabled,
        })
        .from(webhookEndpoints)
        .all(),
    )
    const keys = yield* database.query("workspaceExport.keys", (db) =>
      db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          kind: apiKeys.kind,
          purpose: apiKeys.purpose,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .all(),
    )
    const sending = yield* Governor.use((g) => g.overview).pipe(
      Effect.map((o) => o.config),
      Effect.orElseSucceed(() => null),
    )
    const data = {
      // Credentials stay home: the push signing key (sealed) and an open claim link (HAL-3587).
      settings: Object.fromEntries(
        rows.filter((r) => !PRIVATE_SETTINGS.has(r.key)).map((r) => [r.key, r.value]),
      ),
      sending,
      webhookEndpoints: webhooks,
      apiKeys: keys,
      note: "Webhook signing secrets and API key hashes are left out: create new ones after an import.",
    }
    items = rows.filter((r) => !PRIVATE_SETTINGS.has(r.key)).length + webhooks.length + keys.length
    bytes = yield* put(key, JSON.stringify(data, null, 2), "application/json")
  } else {
    const result = yield* auditCsv({}, 1_000_000)
    items = result.rows
    bytes = yield* put(key, result.csv, "text/csv; charset=utf-8")
  }
  yield* updatePart(row, (p) => p.kind === kind, { status: "complete", key, items, bytes })
})

/** Settings that are credentials, never exported: the VAPID key pair and the claim link's hash. */
export const PRIVATE_SETTINGS: ReadonlySet<string> = new Set(["vapid", "claim"])

/** The last step: the manifest, the export marked completed, and the alert that it's ready. */
export const finishWorkspaceExport = Effect.fn("workspaceExport.finish")(function* (id: string) {
  const row = yield* findWorkspaceExport(id)
  if (row.status !== "running") return
  const bundle = row.bundle ?? []
  const manifest = {
    app: "mailyard",
    export: id,
    createdAt: new Date(row.createdAt).toISOString(),
    finishedAt: new Date().toISOString(),
    parts: bundle.map(({ key: _key, ...p }) => p),
  }
  const bytes = yield* put(row.key, JSON.stringify(manifest, null, 2), "application/json")
  const complete = bundle.filter((p) => p.status === "complete")
  const failed = bundle.filter((p) => p.status === "failed")
  const database = yield* Database
  yield* database.query("workspaceExport.done", (db) =>
    db
      .update(exports)
      .set({
        status: "completed",
        rows: complete.reduce((n, p) => n + p.items, 0),
        bundle: [
          ...bundle,
          {
            kind: "manifest",
            format: "json",
            filename: "manifest.json",
            key: row.key,
            items: bundle.length,
            bytes,
            status: "complete",
          },
        ],
        error: failed.length
          ? `${failed.length} part${failed.length === 1 ? "" : "s"} failed: ${failed.map((p) => p.filename).join(", ")}`
          : null,
        finishedAt: Date.now(),
      })
      .where(eq(exports.id, id))
      .run(),
  )
  yield* raiseAlert({
    key: `export_ready:${id}`,
    kind: "export_ready",
    severity: failed.length ? "warning" : "info",
    title: failed.length ? "The workspace export finished with gaps" : "The workspace export is ready",
    detail: `${complete.length} of ${bundle.length} parts. Each download link lasts a day from when you open the export.`,
    subject: { type: "export", id },
  })
})

export const failWorkspaceExport = (id: string, message: string) =>
  Database.use((d) =>
    d.query("workspaceExport.fail", (db) =>
      db
        .update(exports)
        .set({ status: "failed", error: message, finishedAt: Date.now() })
        .where(eq(exports.id, id))
        .run(),
    ),
  ).pipe(Effect.asVoid)

/** Each finished part with a link good for a day, for `GET /v1/exports/{id}`. */
export const partsWithLinks = Effect.fn("workspaceExport.links")(function* (
  row: ExportRow,
  origin: string | null,
) {
  return yield* Effect.forEach(row.bundle ?? [], (p) =>
    Effect.gen(function* () {
      const url =
        p.status === "complete" && p.key && origin
          ? fileUrl(
              origin,
              yield* signFileToken(
                {
                  k: p.key,
                  n: p.filename.replaceAll("/", "-"),
                  t:
                    p.format === "json"
                      ? "application/json"
                      : p.format === "csv"
                        ? "text/csv; charset=utf-8"
                        : p.format === "mbox"
                          ? "application/mbox"
                          : "application/zip",
                  d: "attachment",
                },
                LINK_TTL_SECONDS,
              ),
            )
          : null
      return {
        kind: p.kind,
        format: p.format,
        filename: p.filename,
        items: p.items,
        bytes: p.bytes,
        status: p.status,
        error: p.error ?? null,
        mailboxId: p.mailboxId ?? null,
        url,
      }
    }).pipe(
      Effect.orElseSucceed(() => ({
        ...p,
        error: p.error ?? null,
        mailboxId: p.mailboxId ?? null,
        url: null,
      })),
    ),
  )
})

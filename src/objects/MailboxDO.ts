import { DurableObject } from "cloudflare:workers"
import type { Env } from "../Bindings.ts"
import type { AuthResults } from "../inbound/auth.ts"
import type { Party } from "../inbound/parse.ts"

/** One attachment as the mailbox stores it; the bytes are in R2 under `r2Key` (content-addressed). */
export interface DeliveredAttachment {
  readonly id: string
  readonly filename: string | null
  readonly mimeType: string
  readonly disposition: string | null
  readonly contentId: string | null
  readonly related: boolean
  readonly size: number
  readonly sha256: string
  readonly r2Key: string
}

/** Everything the inbound pipeline hands a mailbox. Serialisable, so it crosses the RPC boundary. */
export interface InboundDelivery {
  /** The inbound ledger id. Delivering the same id twice stores the message once. */
  readonly id: string
  readonly receivedAt: number
  readonly envelopeFrom: string
  /** The envelope recipient as it arrived, `+tag` included. */
  readonly envelopeTo: string
  readonly via: "mailbox" | "alias" | "group" | "catch_all"
  readonly tag: string | null
  readonly rawKey: string
  /** R2 key of `{ text, html, headers }` for rendering the message in full. */
  readonly bodyKey: string
  readonly size: number
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: ReadonlyArray<string>
  readonly subject: string
  readonly date: number | null
  readonly from: Party | null
  readonly sender: Party | null
  readonly replyTo: ReadonlyArray<Party>
  readonly to: ReadonlyArray<Party>
  readonly cc: ReadonlyArray<Party>
  readonly snippet: string
  /** Plain text, capped at BODY_TEXT_LIMIT characters, for search. The full body is at `bodyKey`. */
  readonly bodyText: string
  readonly hasHtml: boolean
  readonly auth: AuthResults
  readonly automated: boolean
  readonly listId: string | null
  readonly listUnsubscribe: string | null
  readonly attachments: ReadonlyArray<DeliveredAttachment>
}

export const BODY_TEXT_LIMIT = 256 * 1024

export interface StoredMessage extends Omit<InboundDelivery, "bodyText"> {
  readonly storedAt: number
}

/**
 * The mailbox's schema, one entry per version. Never edit a shipped entry: append a new one.
 * Each runs once, in order, inside the constructor's blockConcurrencyWhile.
 */
export const MAILBOX_MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      stored_at INTEGER NOT NULL,
      envelope_from TEXT NOT NULL,
      envelope_to TEXT NOT NULL,
      via TEXT NOT NULL,
      tag TEXT,
      raw_key TEXT NOT NULL,
      body_key TEXT NOT NULL,
      size INTEGER NOT NULL,
      message_id TEXT,
      in_reply_to TEXT,
      refs TEXT NOT NULL,
      subject TEXT NOT NULL,
      date INTEGER,
      from_name TEXT,
      from_address TEXT,
      sender TEXT,
      reply_to TEXT NOT NULL,
      to_list TEXT NOT NULL,
      cc_list TEXT NOT NULL,
      snippet TEXT NOT NULL,
      body_text TEXT NOT NULL,
      has_html INTEGER NOT NULL,
      has_attachments INTEGER NOT NULL,
      auth TEXT NOT NULL,
      automated INTEGER NOT NULL,
      list_id TEXT,
      list_unsubscribe TEXT
    )`,
    "CREATE INDEX messages_received ON messages (received_at DESC, id DESC)",
    "CREATE INDEX messages_message_id ON messages (message_id)",
    `CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      filename TEXT,
      mime_type TEXT NOT NULL,
      disposition TEXT,
      content_id TEXT,
      related INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      r2_key TEXT NOT NULL
    )`,
    "CREATE INDEX attachments_message ON attachments (message_id, position)",
  ],
]

type Row = Record<string, SqlStorageValue>

const json = (value: unknown) => JSON.stringify(value)
type Cell = SqlStorageValue | undefined
const parse = <T>(value: Cell): T => JSON.parse(String(value)) as T
const str = (value: Cell) => (value === null || value === undefined ? null : String(value))
const num = (value: Cell) => (value === null || value === undefined ? null : Number(value))

/**
 * One mailbox: a single writer over its own SQLite. This version stores what the inbound pipeline
 * files; threads, flags, labels, search and live push build on these tables (HAL-3150).
 */
export class MailboxDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => this.migrate())
  }

  private migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)")
    const current =
      this.sql.exec<{ version: number }>("SELECT version FROM _schema").toArray()[0]?.version ?? 0
    if (current >= MAILBOX_MIGRATIONS.length) return
    this.ctx.storage.transactionSync(() => {
      for (const statements of MAILBOX_MIGRATIONS.slice(current)) {
        for (const statement of statements) this.sql.exec(statement)
      }
      this.sql.exec("DELETE FROM _schema")
      this.sql.exec("INSERT INTO _schema (version) VALUES (?)", MAILBOX_MIGRATIONS.length)
    })
  }

  /** The schema version this mailbox is on. */
  schemaVersion(): number {
    return this.sql.exec<{ version: number }>("SELECT version FROM _schema").one().version
  }

  /** Files one message. Idempotent on `delivery.id`: a retried delivery reports `stored: false`. */
  deliver(delivery: InboundDelivery): { readonly id: string; readonly stored: boolean } {
    const existing = this.sql.exec("SELECT 1 FROM messages WHERE id = ?", delivery.id).toArray()
    if (existing.length > 0) return { id: delivery.id, stored: false }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO messages (id, received_at, stored_at, envelope_from, envelope_to, via, tag, raw_key,
          body_key, size, message_id, in_reply_to, refs, subject, date, from_name, from_address, sender,
          reply_to, to_list, cc_list, snippet, body_text, has_html, has_attachments, auth, automated,
          list_id, list_unsubscribe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        delivery.id,
        delivery.receivedAt,
        Date.now(),
        delivery.envelopeFrom,
        delivery.envelopeTo,
        delivery.via,
        delivery.tag,
        delivery.rawKey,
        delivery.bodyKey,
        delivery.size,
        delivery.messageId,
        delivery.inReplyTo,
        json(delivery.references),
        delivery.subject,
        delivery.date,
        delivery.from?.name ?? null,
        delivery.from?.address ?? null,
        delivery.sender ? json(delivery.sender) : null,
        json(delivery.replyTo),
        json(delivery.to),
        json(delivery.cc),
        delivery.snippet,
        delivery.bodyText.slice(0, BODY_TEXT_LIMIT),
        delivery.hasHtml ? 1 : 0,
        delivery.attachments.some((a) => !a.related) ? 1 : 0,
        json(delivery.auth),
        delivery.automated ? 1 : 0,
        delivery.listId,
        delivery.listUnsubscribe,
      )
      delivery.attachments.forEach((a, position) => {
        this.sql.exec(
          `INSERT INTO attachments (id, message_id, position, filename, mime_type, disposition, content_id,
            related, size, sha256, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          a.id,
          delivery.id,
          position,
          a.filename,
          a.mimeType,
          a.disposition,
          a.contentId,
          a.related ? 1 : 0,
          a.size,
          a.sha256,
          a.r2Key,
        )
      })
    })
    return { id: delivery.id, stored: true }
  }

  private toMessage(row: Row): StoredMessage {
    const attachments = this.sql
      .exec("SELECT * FROM attachments WHERE message_id = ? ORDER BY position", row.id)
      .toArray()
      .map(
        (a): DeliveredAttachment => ({
          id: String(a.id),
          filename: str(a.filename),
          mimeType: String(a.mime_type),
          disposition: str(a.disposition),
          contentId: str(a.content_id),
          related: a.related === 1,
          size: Number(a.size),
          sha256: String(a.sha256),
          r2Key: String(a.r2_key),
        }),
      )
    const fromAddress = str(row.from_address)
    return {
      id: String(row.id),
      receivedAt: Number(row.received_at),
      storedAt: Number(row.stored_at),
      envelopeFrom: String(row.envelope_from),
      envelopeTo: String(row.envelope_to),
      via: String(row.via) as InboundDelivery["via"],
      tag: str(row.tag),
      rawKey: String(row.raw_key),
      bodyKey: String(row.body_key),
      size: Number(row.size),
      messageId: str(row.message_id),
      inReplyTo: str(row.in_reply_to),
      references: parse(row.refs),
      subject: String(row.subject),
      date: num(row.date),
      from: fromAddress ? { name: str(row.from_name), address: fromAddress } : null,
      sender: row.sender === null ? null : parse(row.sender),
      replyTo: parse(row.reply_to),
      to: parse(row.to_list),
      cc: parse(row.cc_list),
      snippet: String(row.snippet),
      hasHtml: row.has_html === 1,
      auth: parse(row.auth),
      automated: row.automated === 1,
      listId: str(row.list_id),
      listUnsubscribe: str(row.list_unsubscribe),
      attachments,
    }
  }

  message(id: string): StoredMessage | null {
    const row = this.sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0]
    return row ? this.toMessage(row) : null
  }

  /** Newest first. `cursor` is the `nextCursor` of the previous page. */
  messages(options: { readonly limit?: number; readonly cursor?: string | null } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const [at, id] = options.cursor ? options.cursor.split(":") : []
    const rows =
      at && id
        ? this.sql
            .exec(
              `SELECT * FROM messages WHERE received_at < ? OR (received_at = ? AND id < ?)
               ORDER BY received_at DESC, id DESC LIMIT ?`,
              Number(at),
              Number(at),
              id,
              limit + 1,
            )
            .toArray()
        : this.sql
            .exec("SELECT * FROM messages ORDER BY received_at DESC, id DESC LIMIT ?", limit + 1)
            .toArray()
    const page = rows.slice(0, limit).map((r) => this.toMessage(r))
    const last = page.at(-1)
    return {
      messages: page,
      nextCursor: rows.length > limit && last ? `${last.receivedAt}:${last.id}` : null,
    }
  }

  count(): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages").one().n
  }
}

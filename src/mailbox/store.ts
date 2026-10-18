import { planAttachments } from "../mail/attachmentPlan.ts"
import { type Rule, ruleMatches } from "../rules/engine.ts"
import { FOLDER_COUNT_TABLES, MAILBOX_MIGRATIONS } from "./schema.ts"
import { HIGHLIGHT_END, HIGHLIGHT_START, parseSearch, SEARCH_WEIGHTS } from "./search.ts"
import { linkIds, SUBJECT_WINDOW_MS, subjectKey } from "./threading.ts"
import {
  BODY_TEXT_LIMIT,
  type DeliveredAttachment,
  type Draft,
  type DraftAttachment,
  type DraftInput,
  type DraftTracking,
  type FilingOptions,
  FOLDERS,
  type Folder,
  type FolderCount,
  type InboundDelivery,
  LABEL_COLORS,
  type Label,
  type MailboxEvent,
  type MessagePatch,
  type MessageSummary,
  mailboxError,
  nearestLabelColor,
  type Party,
  type SearchHit,
  type StoredMessage,
  type ThreadFilter,
  type ThreadSummary,
} from "./types.ts"

type Row = Record<string, SqlStorageValue>
type Cell = SqlStorageValue | undefined

const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: Cell): T => JSON.parse(String(value)) as T
const str = (value: Cell) => (value === null || value === undefined ? null : String(value))
const num = (value: Cell) => (value === null || value === undefined ? null : Number(value))
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ")

/** At most this many participants are kept on a thread summary. */
export const MAX_PARTICIPANTS = 8

const newId = (prefix: string) => {
  const random = crypto.getRandomValues(new Uint8Array(8))
  return `${prefix}_${Date.now().toString(36).padStart(9, "0")}${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

const partiesText = (parties: ReadonlyArray<Party>) =>
  parties.map((p) => [p.name, p.address].filter(Boolean).join(" ")).join(", ")

const clampLimit = (limit: number | undefined, fallback = 50) => Math.min(Math.max(limit ?? fallback, 1), 200)

/** Accepts only a known folder, so nothing from a request reaches SQL unchecked. */
const assertFolder = (folder: string): Folder => {
  if (!(FOLDERS as ReadonlyArray<string>).includes(folder))
    throw mailboxError("invalid", `Unknown folder ${folder}`)
  return folder as Folder
}

/**
 * Everything one mailbox stores, over the Durable Object's SQLite. Synchronous on purpose: each call
 * runs to completion inside one transaction, so a reader never sees a half-filed message or a
 * half-merged thread. Mutations return the events open clients should receive.
 */
export class MailboxStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------------------------

  migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)")
    const current = this.schemaVersion()
    if (current >= MAILBOX_MIGRATIONS.length) return
    this.transaction(() => {
      for (const statement of FOLDER_COUNT_TABLES) this.sql.exec(statement)
      for (const migration of MAILBOX_MIGRATIONS.slice(current)) {
        for (const statement of migration.statements) this.sql.exec(statement)
        if (migration.after === "threadAndIndexExisting") this.threadAndIndexExisting()
        if (migration.after === "rebuildFolderCounts") this.rebuildFolderCounts()
        if (migration.after === "rebuildCorrespondents") this.rebuildCorrespondents()
        if (migration.after === "paletteLabels") this.paletteLabels()
      }
      this.sql.exec("DELETE FROM _schema")
      this.sql.exec("INSERT INTO _schema (version) VALUES (?)", MAILBOX_MIGRATIONS.length)
    })
  }

  schemaVersion(): number {
    return this.sql.exec<{ version: number }>("SELECT version FROM _schema").toArray()[0]?.version ?? 0
  }

  /** v2: fill in the threading facts and search rows for messages v1 stored, then thread them in send order. */
  private threadAndIndexExisting() {
    const rows = this.sql.exec("SELECT * FROM messages ORDER BY received_at, id").toArray()
    for (const row of rows) {
      const facts = subjectKey(String(row.subject))
      const refs = parse<Array<string>>(row.refs)
      this.sql.exec(
        "UPDATE messages SET subject_key = ?, reply_subject = ?, headerless = ?, sent_at = ? WHERE id = ?",
        facts.key,
        facts.reply ? 1 : 0,
        row.in_reply_to === null && refs.length === 0 ? 1 : 0,
        num(row.date) ?? Number(row.received_at),
        row.id,
      )
      this.index(String(row.id))
    }
    const threads = new Set<string>()
    for (const row of this.sql.exec("SELECT id FROM messages ORDER BY sent_at, id").toArray()) {
      const { threadId, merged } = this.assignThread(String(row.id))
      threads.add(threadId)
      for (const id of merged) threads.delete(id)
    }
    for (const threadId of threads) this.refresh(threadId)
  }

  // ---------------------------------------------------------------------------------------------
  // Delivery and threading
  // ---------------------------------------------------------------------------------------------

  /** Files one message. Idempotent on `delivery.id`: a retried delivery reports `stored: false`. */
  deliver(delivery: InboundDelivery, filing: Folder | FilingOptions = "inbox") {
    const options: FilingOptions = typeof filing === "string" ? { folder: filing } : filing
    const folder = options.folder ?? "inbox"
    return this.transaction(() => {
      const existing = this.sql.exec("SELECT thread_id FROM messages WHERE id = ?", delivery.id).toArray()[0]
      if (existing) {
        return {
          id: delivery.id,
          stored: false,
          threadId: String(existing.thread_id),
          events: [] as Array<MailboxEvent>,
        }
      }
      const facts = subjectKey(delivery.subject)
      const now = this.now()
      this.sql.exec(
        `INSERT INTO messages (id, received_at, stored_at, envelope_from, envelope_to, via, tag, raw_key,
          body_key, size, message_id, in_reply_to, refs, subject, date, from_name, from_address, sender,
          reply_to, to_list, cc_list, snippet, body_text, has_html, has_attachments, auth, automated,
          list_id, list_unsubscribe, folder, seen, subject_key, reply_subject, headerless, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        delivery.id,
        delivery.receivedAt,
        now,
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
        folder,
        folder === "sent" || options.seen ? 1 : 0,
        facts.key,
        facts.reply ? 1 : 0,
        delivery.inReplyTo === null && delivery.references.length === 0 ? 1 : 0,
        delivery.date ?? delivery.receivedAt,
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
      this.sql.exec(
        "UPDATE messages SET spam_score = ?, spam_reasons = ?, rules_matched = ?, starred = ?, answered = ? WHERE id = ?",
        delivery.spam?.score ?? null,
        json(delivery.spam?.reasons ?? []),
        json(delivery.rulesMatched ?? []),
        options.starred ? 1 : 0,
        options.answered ? 1 : 0,
        delivery.id,
      )
      // Labels a rule applied; one that no longer exists is skipped rather than failing the delivery.
      for (const labelId of options.labelIds ?? []) {
        this.sql.exec(
          "INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ?",
          delivery.id,
          labelId,
        )
      }
      this.index(delivery.id)
      this.noteCorrespondents(folder, delivery)
      const { threadId, merged } = this.assignThread(delivery.id)
      // New mail in a snoozed conversation brings it back, as every mail client does.
      const snoozed = this.threadRow(threadId)?.snoozed_until
      if (folder === "inbox" && snoozed !== null && snoozed !== undefined) this.wake(threadId, false)
      let thread = this.refresh(threadId)
      if (options.assignee && thread && !thread.assignee) {
        this.sql.exec("UPDATE threads SET assignee = ? WHERE id = ?", options.assignee, threadId)
        thread = this.refresh(threadId)
      }
      if (!thread) throw new Error("thread vanished after delivery")
      const message = this.summaryOf(delivery.id)
      const events: Array<MailboxEvent> = [
        { type: "message.added", message, thread, removedThreadIds: merged, counts: this.folderCounts() },
      ]
      return { id: delivery.id, stored: true, threadId, events }
    })
  }

  /** Writes a message's search row. Its rowid is the message's, so purging removes it by rowid. */
  private index(id: string) {
    const row = this.sql
      .exec(
        "SELECT rowid AS rid, subject, from_name, from_address, to_list, cc_list, body_text FROM messages WHERE id = ?",
        id,
      )
      .one()
    this.sql.exec("DELETE FROM search WHERE rowid = ?", row.rid)
    this.sql.exec(
      "INSERT INTO search (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
      row.rid,
      row.subject,
      [str(row.from_name), str(row.from_address)].filter(Boolean).join(" "),
      partiesText([...parse<Array<Party>>(row.to_list), ...parse<Array<Party>>(row.cc_list)]),
      row.body_text,
    )
  }

  /**
   * Puts a message in the thread it belongs to, merging every thread it connects. The survivor is the
   * smallest thread id, so the outcome doesn't depend on which side arrived first.
   */
  private assignThread(id: string) {
    const m = this.sql
      .exec(
        "SELECT thread_id, message_id, in_reply_to, refs, subject_key, reply_subject, headerless, sent_at FROM messages WHERE id = ?",
        id,
      )
      .one()
    const ids = linkIds({
      messageId: str(m.message_id),
      inReplyTo: str(m.in_reply_to),
      references: parse<Array<string>>(m.refs),
    })
    const candidates = new Set<string>()
    // Rethreading a message already in a thread (its Message-ID arrived late) merges that thread too.
    if (m.thread_id !== null) candidates.add(String(m.thread_id))
    if (ids.length > 0) {
      for (const r of this.sql
        .exec(
          `SELECT DISTINCT thread_id FROM thread_refs WHERE message_id IN (${placeholders(ids.length)})`,
          ...ids,
        )
        .toArray()) {
        candidates.add(String(r.thread_id))
      }
    }
    const key = String(m.subject_key)
    if (key !== "") {
      const sentAt = Number(m.sent_at)
      const selfFallback = Number(m.reply_subject) === 1 && Number(m.headerless) === 1 ? 1 : 0
      for (const r of this.sql
        .exec(
          `SELECT DISTINCT thread_id FROM messages
           WHERE subject_key = ? AND id != ? AND thread_id IS NOT NULL AND sent_at BETWEEN ? AND ?
             AND (? = 1 OR (reply_subject = 1 AND headerless = 1))`,
          key,
          id,
          sentAt - SUBJECT_WINDOW_MS,
          sentAt + SUBJECT_WINDOW_MS,
          selfFallback,
        )
        .toArray()) {
        candidates.add(String(r.thread_id))
      }
    }
    const ordered = [...candidates].sort()
    const threadId = ordered[0] ?? newId("thr")
    const merged = ordered.slice(1)
    for (const other of merged) {
      this.sql.exec("UPDATE messages SET thread_id = ? WHERE thread_id = ?", threadId, other)
      this.sql.exec("UPDATE thread_refs SET thread_id = ? WHERE thread_id = ?", threadId, other)
      this.sql.exec("UPDATE drafts SET thread_id = ? WHERE thread_id = ?", threadId, other)
      this.sql.exec("UPDATE thread_notes SET thread_id = ? WHERE thread_id = ?", threadId, other)
      this.sql.exec("DELETE FROM schedule WHERE kind = 'snooze' AND target = ?", other)
      this.sql.exec("DELETE FROM threads WHERE id = ?", other)
      // Its messages now belong to threadId, whose refresh counts them; the old thread counts no more.
      this.syncFolders(other, false)
    }
    this.sql.exec("UPDATE messages SET thread_id = ? WHERE id = ?", threadId, id)
    for (const ref of ids) {
      this.sql.exec(
        "INSERT INTO thread_refs (message_id, thread_id) VALUES (?, ?) ON CONFLICT (message_id) DO UPDATE SET thread_id = excluded.thread_id",
        ref,
        threadId,
      )
    }
    return { threadId, merged }
  }

  /**
   * Brings a conversation's folder rows, and the per-folder totals, in line with its messages. Called
   * by every refresh, so each change to a message's folder or seen flag reaches the counts; reads only
   * that conversation's messages (messages_thread). Returns the folders it's in, sorted.
   */
  private syncFolders(threadId: string, present: boolean): Array<string> {
    const before = new Map(
      this.sql
        .exec<{ folder: string; unread: number }>(
          "SELECT folder, unread FROM thread_folders WHERE thread_id = ?",
          threadId,
        )
        .toArray()
        .map((r) => [String(r.folder), Number(r.unread)]),
    )
    const after = new Map(
      present
        ? this.sql
            .exec<{ folder: string; unread: number }>(
              "SELECT folder, max(seen = 0) AS unread FROM messages WHERE thread_id = ? GROUP BY folder",
              threadId,
            )
            .toArray()
            .map((r) => [String(r.folder), Number(r.unread)])
        : [],
    )
    // "all" (All mail): in any folder but spam and trash; unread if unread in one of those.
    const allOf = (m: Map<string, number>) => {
      const kept = [...m].filter(([f]) => f !== "spam" && f !== "trash" && f !== "all")
      return kept.length ? Math.max(...kept.map(([, u]) => u)) : undefined
    }
    const allBefore = allOf(before)
    const allAfter = allOf(after)
    if (allBefore !== allAfter)
      this.sql.exec(
        `INSERT INTO folder_counts (folder, threads, unread) VALUES ('all', ?, ?)
         ON CONFLICT (folder) DO UPDATE SET threads = threads + excluded.threads, unread = unread + excluded.unread`,
        (allAfter === undefined ? 0 : 1) - (allBefore === undefined ? 0 : 1),
        (allAfter ?? 0) - (allBefore ?? 0),
      )
    let changed = before.size !== after.size
    for (const folder of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(folder)
      const now = after.get(folder)
      const dThreads = (now === undefined ? 0 : 1) - (was === undefined ? 0 : 1)
      const dUnread = (now ?? 0) - (was ?? 0)
      if (dThreads === 0 && dUnread === 0) continue
      changed = true
      this.sql.exec(
        `INSERT INTO folder_counts (folder, threads, unread) VALUES (?, ?, ?)
         ON CONFLICT (folder) DO UPDATE SET threads = threads + excluded.threads, unread = unread + excluded.unread`,
        folder,
        dThreads,
        dUnread,
      )
    }
    if (changed) {
      this.sql.exec("DELETE FROM thread_folders WHERE thread_id = ?", threadId)
      for (const [folder, unread] of after)
        this.sql.exec(
          "INSERT INTO thread_folders (thread_id, folder, unread) VALUES (?, ?, ?)",
          threadId,
          folder,
          unread,
        )
    }
    return [...after.keys()].sort()
  }

  // ---------------------------------------------------------------------------------------------
  // The live socket's catch-up log
  // ---------------------------------------------------------------------------------------------

  /** Numbers and keeps the frames the socket is about to send; the newest 1,000 or a day are kept. */
  logEvents(frames: ReadonlyArray<string>): Array<{ seq: number; frame: string }> {
    const now = this.now()
    const logged = frames.map((frame) => {
      const seq = Number(
        this.sql
          .exec<{ seq: number }>(
            "INSERT INTO live_events (at, frame) VALUES (?, ?) RETURNING seq",
            now,
            frame,
          )
          .one().seq,
      )
      const numbered = this.sql
        .exec<{ frame: string }>(
          "UPDATE live_events SET frame = json_set(frame, '$.seq', seq) WHERE seq = ? RETURNING frame",
          seq,
        )
        .one().frame
      return { seq, frame: String(numbered) }
    })
    const last = logged.at(-1)?.seq
    if (last !== undefined && last % 50 === 0)
      this.sql.exec(
        "DELETE FROM live_events WHERE seq <= ? OR at < ?",
        last - LIVE_LOG_SIZE,
        now - LIVE_LOG_MS,
      )
    return logged
  }

  latestSeq(): number {
    return Number(
      this.sql.exec<{ seq: number | null }>("SELECT max(seq) AS seq FROM live_events").one().seq ?? 0,
    )
  }

  /**
   * The frames after `since`, or null when they're no longer all kept: the client must refetch.
   * At most LIVE_LOG_SIZE frames, read through the primary key.
   */
  eventsSince(since: number): Array<{ seq: number; frame: string }> | null {
    const oldest = this.sql.exec<{ seq: number | null }>("SELECT min(seq) AS seq FROM live_events").one().seq
    const latest = this.latestSeq()
    if (since >= latest) return []
    if (oldest === null || since < Number(oldest) - 1) return null
    return this.sql
      .exec<{ seq: number; frame: string }>(
        "SELECT seq, frame FROM live_events WHERE seq > ? ORDER BY seq LIMIT ?",
        since,
        LIVE_LOG_SIZE,
      )
      .toArray()
      .map((r) => ({ seq: Number(r.seq), frame: String(r.frame) }))
  }

  // ---------------------------------------------------------------------------------------------
  // Correspondents
  // ---------------------------------------------------------------------------------------------

  /** Received mail counts its sender; a sent copy counts its recipients. Spam and trash count nobody. */
  private noteCorrespondents(folder: Folder, delivery: InboundDelivery) {
    if (folder === "spam" || folder === "trash") return
    const parties =
      folder === "sent"
        ? [...delivery.to, ...delivery.cc]
        : delivery.from && !delivery.automated
          ? [delivery.from]
          : []
    const column = folder === "sent" ? "sent" : "received"
    for (const p of parties) {
      const address = p.address.trim().toLowerCase()
      if (!address.includes("@")) continue
      this.sql.exec(
        `INSERT INTO correspondents (address, name, ${column}, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (address) DO UPDATE SET name = coalesce(excluded.name, correspondents.name),
           ${column} = correspondents.${column} + 1, last_at = max(correspondents.last_at, excluded.last_at)`,
        address,
        p.name?.trim() || null,
        delivery.receivedAt,
      )
    }
  }

  /** Builds the correspondents from the mail already stored: the migration's backfill. */
  rebuildCorrespondents() {
    this.sql.exec("DELETE FROM correspondents")
    for (const row of this.sql
      .exec(
        "SELECT folder, from_name, from_address, to_list, cc_list, automated, received_at FROM messages ORDER BY received_at",
      )
      .toArray()) {
      const folder = String(row.folder) as Folder
      this.noteCorrespondents(folder, {
        from: row.from_address ? { name: str(row.from_name), address: String(row.from_address) } : null,
        to: parse<Array<Party>>(row.to_list),
        cc: parse<Array<Party>>(row.cc_list),
        automated: Number(row.automated) === 1,
        receivedAt: Number(row.received_at),
      } as unknown as InboundDelivery)
    }
  }

  /**
   * For the composer's To field: people whose address or name starts with `q` (or any word of the
   * name does), most recent first; everyone recent when `q` is empty.
   */
  correspondents(q: string, limit = 10) {
    const term = q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`)
    const rows = term
      ? this.sql
          .exec(
            `SELECT * FROM correspondents
             WHERE address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'
             ORDER BY last_at DESC LIMIT ?`,
            `${term}%`,
            `${term}%`,
            `% ${term}%`,
            Math.min(Math.max(limit, 1), 50),
          )
          .toArray()
      : this.sql
          .exec(
            "SELECT * FROM correspondents ORDER BY last_at DESC LIMIT ?",
            Math.min(Math.max(limit, 1), 50),
          )
          .toArray()
    return rows.map((r) => ({
      address: String(r.address),
      name: str(r.name),
      received: Number(r.received),
      sent: Number(r.sent),
      lastAt: Number(r.last_at),
    }))
  }

  /** Recounts folder totals from the messages: the migration's backfill, and a repair path. */
  rebuildFolderCounts() {
    this.sql.exec("DELETE FROM thread_folders")
    this.sql.exec("DELETE FROM folder_counts")
    this.sql.exec(
      `INSERT INTO thread_folders (thread_id, folder, unread)
       SELECT thread_id, folder, max(seen = 0) FROM messages WHERE thread_id IS NOT NULL GROUP BY thread_id, folder`,
    )
    this.sql.exec(
      "INSERT INTO folder_counts (folder, threads, unread) SELECT folder, count(*), sum(unread) FROM thread_folders GROUP BY folder",
    )
    this.sql.exec(
      `INSERT INTO folder_counts (folder, threads, unread)
       SELECT 'all', count(*), coalesce(sum(u), 0) FROM (
         SELECT thread_id, max(unread) AS u FROM thread_folders WHERE folder NOT IN ('spam', 'trash') GROUP BY thread_id)`,
    )
  }

  /**
   * The views beside the folders (HAL-3405), each read through an index or a kept count: starred,
   * assigned to a key, scheduled sends, and All mail.
   */
  views(assignee: string | null) {
    const n = (sql: string, ...args: Array<SqlStorageValue>) =>
      Number(this.sql.exec<{ n: number }>(sql, ...args).one().n)
    const all = this.sql
      .exec<{ threads: number; unread: number }>(
        "SELECT threads, unread FROM folder_counts WHERE folder = 'all'",
      )
      .toArray()[0]
    return {
      starred: n("SELECT count(*) AS n FROM threads WHERE starred = 1"),
      assignedToMe: assignee ? n("SELECT count(*) AS n FROM threads WHERE assignee = ?", assignee) : 0,
      scheduled: n("SELECT count(*) AS n FROM drafts WHERE status = 'scheduled'"),
      all: { threads: Number(all?.threads ?? 0), unreadThreads: Number(all?.unread ?? 0) },
    }
  }

  /** The counts recounted from the messages, for checking the kept ones. */
  recountFolders(): Array<{ folder: string; threads: number; unread: number }> {
    return this.sql
      .exec(
        `SELECT folder, count(DISTINCT thread_id) AS threads, count(DISTINCT CASE WHEN seen = 0 THEN thread_id END) AS unread
         FROM messages GROUP BY folder ORDER BY folder`,
      )
      .toArray()
      .map((r) => ({ folder: String(r.folder), threads: Number(r.threads), unread: Number(r.unread) }))
  }

  private threadRow(id: string) {
    return this.sql.exec("SELECT * FROM threads WHERE id = ?", id).toArray()[0]
  }

  /** Recomputes a thread's summary from its messages. Deletes it, and returns null, when none are left. */
  private refresh(threadId: string): ThreadSummary | null {
    const agg = this.sql
      .exec(
        `SELECT count(*) AS n,
           coalesce(sum(CASE WHEN seen = 0 AND folder NOT IN ('trash', 'spam') THEN 1 ELSE 0 END), 0) AS unread,
           coalesce(max(starred), 0) AS starred, coalesce(max(has_attachments), 0) AS att,
           min(received_at) AS first_at, max(received_at) AS last_at
         FROM messages WHERE thread_id = ?`,
        threadId,
      )
      .one()
    if (Number(agg.n) === 0) {
      this.syncFolders(threadId, false)
      this.sql.exec("DELETE FROM thread_notes WHERE thread_id = ?", threadId)
      this.sql.exec("DELETE FROM threads WHERE id = ?", threadId)
      this.sql.exec("DELETE FROM thread_refs WHERE thread_id = ?", threadId)
      this.sql.exec("DELETE FROM schedule WHERE kind = 'snooze' AND target = ?", threadId)
      return null
    }
    const first = this.sql
      .exec(
        "SELECT subject FROM messages WHERE thread_id = ? ORDER BY sent_at, received_at, id LIMIT 1",
        threadId,
      )
      .one()
    const latest = this.sql
      .exec(
        "SELECT id, snippet FROM messages WHERE thread_id = ? ORDER BY received_at DESC, id DESC LIMIT 1",
        threadId,
      )
      .one()
    const participants: Array<Party> = []
    const seen = new Set<string>()
    for (const p of this.sql
      .exec(
        "SELECT from_name, from_address FROM messages WHERE thread_id = ? AND from_address IS NOT NULL ORDER BY sent_at, id",
        threadId,
      )
      .toArray()) {
      const address = String(p.from_address)
      if (seen.has(address) || participants.length >= MAX_PARTICIPANTS) continue
      seen.add(address)
      participants.push({ name: str(p.from_name), address })
    }
    const folders = this.syncFolders(threadId, true)
    const labelIds = this.sql
      .exec(
        `SELECT DISTINCT ml.label_id FROM message_labels ml JOIN messages m ON m.id = ml.message_id
         WHERE m.thread_id = ? ORDER BY ml.label_id`,
        threadId,
      )
      .toArray()
      .map((r) => String(r.label_id))
    const previous = this.threadRow(threadId)
    const wokenAt = num(previous?.woken_at)
    const snoozedUntil = num(previous?.snoozed_until)
    const lastAt = Number(agg.last_at)
    this.sql.exec(
      `INSERT INTO threads (id, subject, snippet, latest_message_id, message_count, unread_count, starred,
         has_attachments, participants, folders, label_ids, first_at, last_at, sort_at, woken_at, snoozed_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET subject = excluded.subject, snippet = excluded.snippet,
         latest_message_id = excluded.latest_message_id, message_count = excluded.message_count,
         unread_count = excluded.unread_count, starred = excluded.starred, has_attachments = excluded.has_attachments,
         participants = excluded.participants, folders = excluded.folders, label_ids = excluded.label_ids,
         first_at = excluded.first_at, last_at = excluded.last_at, sort_at = excluded.sort_at,
         woken_at = excluded.woken_at, snoozed_until = excluded.snoozed_until`,
      threadId,
      first.subject,
      latest.snippet,
      latest.id,
      agg.n,
      agg.unread,
      agg.starred,
      agg.att,
      json(participants),
      json(folders),
      json(labelIds),
      agg.first_at,
      lastAt,
      Math.max(lastAt, wokenAt ?? 0),
      wokenAt,
      snoozedUntil,
    )
    return this.toThread(this.threadRow(threadId) as Row)
  }

  private toThread(row: Row): ThreadSummary {
    return {
      id: String(row.id),
      subject: String(row.subject),
      snippet: String(row.snippet),
      latestMessageId: String(row.latest_message_id),
      messageCount: Number(row.message_count),
      unreadCount: Number(row.unread_count),
      starred: Number(row.starred) === 1,
      hasAttachments: Number(row.has_attachments) === 1,
      participants: parse(row.participants),
      folders: parse(row.folders),
      labelIds: parse(row.label_ids),
      firstAt: Number(row.first_at),
      lastAt: Number(row.last_at),
      sortAt: Number(row.sort_at),
      snoozedUntil: num(row.snoozed_until),
      assignee: str(row.assignee),
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------------------------

  private attachmentsOf(messageId: string): Array<DeliveredAttachment> {
    return this.sql
      .exec("SELECT * FROM attachments WHERE message_id = ? ORDER BY position", messageId)
      .toArray()
      .map((a) => ({
        id: String(a.id),
        filename: str(a.filename),
        mimeType: String(a.mime_type),
        disposition: str(a.disposition),
        contentId: str(a.content_id),
        related: Number(a.related) === 1,
        size: Number(a.size),
        sha256: String(a.sha256),
        r2Key: String(a.r2_key),
      }))
  }

  private toMessage(row: Row): StoredMessage {
    const fromAddress = str(row.from_address)
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      folder: String(row.folder) as Folder,
      seen: Number(row.seen) === 1,
      starred: Number(row.starred) === 1,
      answered: Number(row.answered) === 1,
      labelIds: this.sql
        .exec("SELECT label_id FROM message_labels WHERE message_id = ? ORDER BY label_id", row.id)
        .toArray()
        .map((r) => String(r.label_id)),
      receivedAt: Number(row.received_at),
      storedAt: Number(row.stored_at),
      envelopeFrom: String(row.envelope_from),
      envelopeTo: String(row.envelope_to),
      via: String(row.via) as StoredMessage["via"],
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
      hasHtml: Number(row.has_html) === 1,
      auth: parse(row.auth),
      automated: Number(row.automated) === 1,
      listId: str(row.list_id),
      listUnsubscribe: str(row.list_unsubscribe),
      attachments: this.attachmentsOf(String(row.id)),
      spamScore: num(row.spam_score),
      spamReasons: row.spam_reasons ? parse(row.spam_reasons) : [],
      rulesMatched: row.rules_matched ? parse(row.rules_matched) : [],
    }
  }

  private summaryOf(id: string): MessageSummary {
    const row = this.sql
      .exec(
        "SELECT id, thread_id, subject, from_name, from_address, snippet, received_at, folder, seen FROM messages WHERE id = ?",
        id,
      )
      .one()
    const address = str(row.from_address)
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      subject: String(row.subject),
      from: address ? { name: str(row.from_name), address } : null,
      snippet: String(row.snippet),
      receivedAt: Number(row.received_at),
      folder: String(row.folder) as Folder,
      seen: Number(row.seen) === 1,
    }
  }

  message(id: string): StoredMessage | null {
    const row = this.sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0]
    return row ? this.toMessage(row) : null
  }

  /** Newest first. `cursor` is the `nextCursor` of the previous page. */
  messages(options: { readonly limit?: number; readonly cursor?: string | null } = {}) {
    const limit = clampLimit(options.limit)
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

  /** What the mailbox keeps in R2 (HAL-3421): each message's original and its extracted attachments. */
  storage(): { readonly messages: number; readonly bytes: number } {
    const m = this.sql
      .exec<{ n: number; bytes: number }>(
        "SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM messages",
      )
      .one()
    const a = this.sql
      .exec<{ bytes: number }>("SELECT coalesce(sum(size), 0) AS bytes FROM attachments")
      .one()
    return { messages: m.n, bytes: m.bytes + a.bytes }
  }

  /** Threads newest first, filtered by folder, label, unread or starred. */
  threads(filter: ThreadFilter = {}) {
    const limit = clampLimit(filter.limit)
    const where: Array<string> = []
    const args: Array<SqlStorageValue> = []
    if (filter.folder === "all") {
      where.push(
        "EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.thread_id = t.id AND tf.folder NOT IN ('spam', 'trash'))",
      )
    } else if (filter.folder) {
      where.push("EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = ?)")
      args.push(assertFolder(filter.folder))
    }
    if (filter.labelId) {
      where.push(
        "EXISTS (SELECT 1 FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = t.id AND ml.label_id = ?)",
      )
      args.push(filter.labelId)
    }
    if (filter.unread) where.push("t.unread_count > 0")
    if (filter.starred) where.push("t.starred = 1")
    if (filter.assignee === "none") where.push("t.assignee IS NULL")
    else if (filter.assignee) {
      where.push("t.assignee = ?")
      args.push(filter.assignee)
    }
    const [at, id] = filter.cursor ? filter.cursor.split(":") : []
    if (at && id) {
      where.push("(t.sort_at < ? OR (t.sort_at = ? AND t.id < ?))")
      args.push(Number(at), Number(at), id)
    }
    const spam = filter.folder === "spam"
    const rows = this.sql
      .exec(
        `SELECT t.*,
           (SELECT min(d.send_at) FROM drafts d WHERE d.thread_id = t.id AND d.status = 'scheduled') AS scheduled_send_at
           ${spam ? ", (SELECT max(m.spam_score) FROM messages m WHERE m.thread_id = t.id AND m.folder = 'spam') AS spam_score_max" : ""}
         FROM threads t ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY t.sort_at DESC, t.id DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray()
    const page = rows.slice(0, limit).map((r) => ({
      ...this.toThread(r),
      scheduledSendAt: num(r.scheduled_send_at),
      ...(spam ? { spamScore: num(r.spam_score_max) } : {}),
    }))
    const last = page.at(-1)
    // The total is free when the list is a whole folder: the kept counts already hold it.
    const plain = !filter.labelId && !filter.unread && !filter.starred && !filter.assignee
    const total =
      plain && filter.folder
        ? Number(
            this.sql
              .exec<{ threads: number }>("SELECT threads FROM folder_counts WHERE folder = ?", filter.folder)
              .toArray()[0]?.threads ?? 0,
          )
        : null
    return {
      threads: page,
      total,
      nextCursor: rows.length > limit && last ? `${last.sortAt}:${last.id}` : null,
    }
  }

  /** A thread with its messages in conversation order and any drafts replying in it. */
  thread(id: string) {
    const row = this.threadRow(id)
    if (!row) return null
    const messages = this.sql
      .exec("SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at, received_at, id", id)
      .toArray()
      .map((r) => this.toMessage(r))
    const drafts = this.sql
      .exec("SELECT * FROM drafts WHERE thread_id = ? ORDER BY updated_at", id)
      .toArray()
      .map((r) => this.toDraft(r))
    return { thread: this.toThread(row), messages, drafts, notes: this.notes(id) }
  }

  /** Threads and unread threads per folder, plus the number of drafts. */
  folderCounts(): Array<FolderCount> {
    // Kept on write by syncFolders: one row per folder, whatever the mailbox's size (HAL-3394).
    const rows = new Map(
      this.sql
        .exec("SELECT folder, threads, unread FROM folder_counts")
        .toArray()
        .map((r) => [String(r.folder), r]),
    )
    const counts: Array<FolderCount> = FOLDERS.map((folder) => ({
      folder,
      threads: Number(rows.get(folder)?.threads ?? 0),
      unreadThreads: Number(rows.get(folder)?.unread ?? 0),
    }))
    const drafts = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM drafts").one().n
    counts.push({ folder: "drafts", threads: drafts, unreadThreads: 0 })
    return counts
  }

  /**
   * What needs a person in this mailbox (HAL-3362), each count read through an index:
   * - unread conversations in the inbox (messages_folder);
   * - conversations whose latest message is in the inbox and older than `olderThan`: waiting for a
   *   reply, since anything answered has a newer sent copy;
   * - snoozed conversations coming back between now and `until` (schedule_due);
   * - inbox conversations assigned to `assignee` (threads_assignee).
   */
  attention(input: { readonly olderThan: number; readonly until: number; readonly assignee: string | null }) {
    const now = this.now()
    const unread = this.sql
      .exec<{ n: number }>(
        "SELECT count(DISTINCT thread_id) AS n FROM messages WHERE folder = 'inbox' AND seen = 0",
      )
      .one().n
    const waiting = this.sql
      .exec<{ n: number; oldest: number | null }>(
        `SELECT count(*) AS n, min(t.last_at) AS oldest FROM messages m JOIN threads t ON t.latest_message_id = m.id
         WHERE m.folder = 'inbox' AND t.last_at < ?`,
        input.olderThan,
      )
      .one()
    const snoozed = this.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM schedule WHERE kind = 'snooze' AND due_at > ? AND due_at <= ?",
        now,
        input.until,
      )
      .one().n
    const assigned = input.assignee
      ? this.sql
          .exec<{ n: number }>(
            `SELECT count(*) AS n FROM threads t WHERE t.assignee = ?
             AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = 'inbox')`,
            input.assignee,
          )
          .one().n
      : 0
    return {
      unread,
      waitingForReply: waiting.n,
      oldestWaitingAt: waiting.oldest ?? null,
      snoozedReturning: snoozed,
      assignedToMe: assigned,
    }
  }

  /**
   * First-response times for conversations that started between `from` and `to`, by assignee: from
   * the first message received to the first reply sent after it. Conversations still unanswered are
   * counted, not timed. Reads the range's threads and their messages through messages_thread.
   */
  responseTimes(input: { readonly from: number; readonly to: number }) {
    const rows = this.sql
      .exec<{ assignee: string | null; first_in: number | null; first_reply: number | null }>(
        `SELECT t.assignee AS assignee,
           (SELECT min(m.received_at) FROM messages m WHERE m.thread_id = t.id AND m.folder != 'sent') AS first_in,
           (SELECT min(r.received_at) FROM messages r WHERE r.thread_id = t.id AND r.folder = 'sent'
              AND r.received_at > (SELECT min(m.received_at) FROM messages m WHERE m.thread_id = t.id AND m.folder != 'sent')) AS first_reply
         FROM threads t WHERE t.first_at >= ? AND t.first_at < ?`,
        input.from,
        input.to,
      )
      .toArray()
    const by = new Map<string | null, { threads: number; replied: Array<number> }>()
    for (const r of rows) {
      if (r.first_in === null) continue
      const entry = by.get(r.assignee) ?? { threads: 0, replied: [] }
      entry.threads++
      if (r.first_reply !== null) entry.replied.push(r.first_reply - r.first_in)
      by.set(r.assignee, entry)
    }
    return [...by.entries()].map(([assignee, e]) => ({
      assignee,
      threads: e.threads,
      answered: e.replied.length,
      firstResponseMedianMs: median(e.replied),
      firstResponseP90Ms: percentile(e.replied, 0.9),
    }))
  }

  // ---------------------------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------------------------

  /**
   * Full-text search over subject, sender, recipients and body, best match first. Trash and spam are
   * left out unless the query names them with `in:`. Matches are wrapped in HIGHLIGHT_START/END.
   */
  search(query: string, options: { readonly limit?: number; readonly sort?: "recent" | "relevance" } = {}) {
    const limit = clampLimit(options.limit, 25)
    const sort = options.sort ?? "recent"
    const { match, filters, parsed } = parseSearch(query)
    if (
      !match &&
      !filters.folder &&
      !filters.labelName &&
      !filters.unread &&
      !filters.starred &&
      !filters.hasAttachment &&
      filters.before === null &&
      filters.after === null
    ) {
      return { hits: [] as Array<SearchHit>, threads: [] as Array<ThreadSummary>, parsed, sort }
    }
    const where: Array<string> = []
    const args: Array<SqlStorageValue> = []
    if (filters.folder) {
      where.push("m.folder = ?")
      args.push(filters.folder)
    } else {
      where.push("m.folder NOT IN ('trash', 'spam')")
    }
    if (filters.labelName !== null) {
      where.push(
        "EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.name = ? COLLATE NOCASE)",
      )
      args.push(filters.labelName)
    }
    if (filters.unread) where.push("m.seen = 0")
    if (filters.starred) where.push("m.starred = 1")
    if (filters.hasAttachment) where.push("m.has_attachments = 1")
    if (filters.before !== null) {
      where.push("m.received_at < ?")
      args.push(filters.before)
    }
    if (filters.after !== null) {
      where.push("m.received_at >= ?")
      args.push(filters.after)
    }
    const select = `m.id, m.thread_id, m.folder, m.from_name, m.from_address, m.received_at, m.subject`
    const rows = match
      ? this.sql
          .exec(
            `SELECT ${select},
               highlight(search, 0, ?, ?) AS subject_hl,
               snippet(search, 3, ?, ?, '…', 16) AS excerpt,
               bm25(search, ${SEARCH_WEIGHTS.join(", ")}) AS rank
             FROM search JOIN messages m ON m.rowid = search.rowid
             WHERE search MATCH ? AND ${where.join(" AND ")}
             ORDER BY ${sort === "relevance" ? "rank, m.received_at DESC" : "m.received_at DESC, rank"} LIMIT ?`,
            HIGHLIGHT_START,
            HIGHLIGHT_END,
            HIGHLIGHT_START,
            HIGHLIGHT_END,
            match,
            ...args,
            limit,
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT ${select}, m.subject AS subject_hl, m.snippet AS excerpt, 0 AS rank
             FROM messages m WHERE ${where.join(" AND ")}
             ORDER BY m.received_at DESC LIMIT ?`,
            ...args,
            limit,
          )
          .toArray()
    const hits: Array<SearchHit> = rows.map((r) => {
      const address = str(r.from_address)
      return {
        messageId: String(r.id),
        threadId: String(r.thread_id),
        folder: String(r.folder) as Folder,
        from: address ? { name: str(r.from_name), address } : null,
        receivedAt: Number(r.received_at),
        subject: String(r.subject),
        subjectHighlighted: String(r.subject_hl),
        excerpt: String(r.excerpt),
        rank: Number(r.rank),
      }
    })
    const threadIds = [...new Set(hits.map((h) => h.threadId))]
    const threads = threadIds.flatMap((id) => {
      const row = this.threadRow(id)
      return row ? [this.toThread(row)] : []
    })
    return { hits, threads, parsed, sort }
  }

  // ---------------------------------------------------------------------------------------------
  // Internal notes: for the team, never sent
  // ---------------------------------------------------------------------------------------------

  notes(threadId: string) {
    return this.sql
      .exec("SELECT * FROM thread_notes WHERE thread_id = ? ORDER BY created_at, id", threadId)
      .toArray()
      .map((r) => ({
        id: String(r.id),
        threadId: String(r.thread_id),
        author: String(r.author),
        body: String(r.body),
        createdAt: Number(r.created_at),
      }))
  }

  addNote(threadId: string, author: string, body: string) {
    return this.transaction(() => {
      if (!this.threadRow(threadId)) throw mailboxError("not_found", `No thread ${threadId}`)
      const text = body.trim()
      if (!text || text.length > 10_000) throw mailboxError("invalid", "A note is 1 to 10,000 characters")
      const id = newId("nte")
      this.sql.exec(
        "INSERT INTO thread_notes (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        threadId,
        author,
        text,
        this.now(),
      )
      const notes = this.notes(threadId)
      return {
        note: notes.find((n) => n.id === id),
        events: [{ type: "notes.changed", threadId, notes } as MailboxEvent],
      }
    })
  }

  /** Removes a note: its author, or anyone the caller says may (admins and owners). */
  deleteNote(noteId: string, by: string, anyone: boolean) {
    return this.transaction(() => {
      const row = this.sql.exec("SELECT * FROM thread_notes WHERE id = ?", noteId).toArray()[0]
      if (!row) throw mailboxError("not_found", `No note ${noteId}`)
      if (!anyone && String(row.author) !== by)
        throw mailboxError("forbidden", "Only a note's author, the mailbox's owner or an admin can delete it")
      this.sql.exec("DELETE FROM thread_notes WHERE id = ?", noteId)
      const threadId = String(row.thread_id)
      return {
        deleted: noteId,
        events: [{ type: "notes.changed", threadId, notes: this.notes(threadId) } as MailboxEvent],
      }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Smart folders: saved searches
  // ---------------------------------------------------------------------------------------------

  smartFolders() {
    return this.sql
      .exec("SELECT * FROM smart_folders ORDER BY position, created_at")
      .toArray()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        q: String(r.q),
        createdAt: Number(r.created_at),
      }))
  }

  /** Creates or renames a saved search. The query must be one search understands, at most 50 a mailbox. */
  saveSmartFolder(input: { readonly id?: string | undefined; readonly name: string; readonly q: string }) {
    return this.transaction(() => {
      const name = input.name.trim()
      const q = input.q.trim()
      if (!name || name.length > 60)
        throw mailboxError("invalid", "A smart folder's name is 1 to 60 characters")
      if (!q || q.length > 500)
        throw mailboxError("invalid", "A smart folder needs a search, at most 500 characters")
      const parsed = parseSearch(q)
      if (!parsed.match && Object.values(parsed.filters).every((v) => v === null || v === false))
        throw mailboxError("invalid", "That search has nothing to look for")
      const clash = this.sql
        .exec("SELECT id FROM smart_folders WHERE name = ? COLLATE NOCASE AND id != ?", name, input.id ?? "")
        .toArray()[0]
      if (clash) throw mailboxError("label_exists", `A smart folder named "${name}" already exists`)
      if (input.id) {
        const updated = this.sql
          .exec("UPDATE smart_folders SET name = ?, q = ? WHERE id = ? RETURNING id", name, q, input.id)
          .toArray()
        if (updated.length === 0) throw mailboxError("not_found", `No smart folder ${input.id}`)
        return this.smartFolders().find((f) => f.id === input.id)
      }
      const count = Number(this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM smart_folders").one().n)
      if (count >= 50) throw mailboxError("invalid", "A mailbox has at most 50 smart folders")
      const id = newId("sf")
      this.sql.exec(
        "INSERT INTO smart_folders (id, name, q, position, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        name,
        q,
        count,
        this.now(),
      )
      return this.smartFolders().find((f) => f.id === id)
    })
  }

  deleteSmartFolder(id: string) {
    return this.transaction(() => {
      const gone = this.sql.exec("DELETE FROM smart_folders WHERE id = ? RETURNING id", id).toArray()
      if (gone.length === 0) throw mailboxError("not_found", `No smart folder ${id}`)
      return { deleted: id }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Flags, folders and labels
  // ---------------------------------------------------------------------------------------------

  private assertLabels(ids: ReadonlyArray<string>) {
    if (ids.length === 0) return
    const found = this.sql
      .exec(`SELECT id FROM labels WHERE id IN (${placeholders(ids.length)})`, ...ids)
      .toArray()
      .map((r) => String(r.id))
    const missing = ids.filter((id) => !found.includes(id))
    if (missing.length > 0) throw mailboxError("unknown_label", `No label ${missing.join(", ")}`)
  }

  private applyPatch(ids: ReadonlyArray<string>, patch: MessagePatch) {
    if (ids.length === 0) return
    const marks = placeholders(ids.length)
    if (patch.seen !== undefined)
      this.sql.exec(`UPDATE messages SET seen = ? WHERE id IN (${marks})`, patch.seen ? 1 : 0, ...ids)
    if (patch.starred !== undefined) {
      this.sql.exec(`UPDATE messages SET starred = ? WHERE id IN (${marks})`, patch.starred ? 1 : 0, ...ids)
    }
    if (patch.answered !== undefined) {
      this.sql.exec(`UPDATE messages SET answered = ? WHERE id IN (${marks})`, patch.answered ? 1 : 0, ...ids)
    }
    if (patch.folder !== undefined) {
      this.sql.exec(
        `UPDATE messages SET folder = ? WHERE id IN (${marks})`,
        assertFolder(patch.folder),
        ...ids,
      )
    }
    for (const label of patch.addLabels ?? []) {
      for (const id of ids)
        this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)", id, label)
    }
    for (const label of patch.removeLabels ?? []) {
      this.sql.exec(
        `DELETE FROM message_labels WHERE label_id = ? AND message_id IN (${marks})`,
        label,
        ...ids,
      )
    }
  }

  /** A thread whose snoozed messages were all moved elsewhere is no longer snoozed. */
  private settleSnooze(threadId: string) {
    const row = this.threadRow(threadId)
    if (!row || row.snoozed_until === null) return
    const left = this.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM messages WHERE thread_id = ? AND folder = 'snoozed'",
        threadId,
      )
      .one().n
    if (left > 0) return
    this.sql.exec("UPDATE threads SET snoozed_until = NULL WHERE id = ?", threadId)
    this.sql.exec("DELETE FROM schedule WHERE kind = 'snooze' AND target = ?", threadId)
  }

  private changed(threadIds: Iterable<string>): Extract<MailboxEvent, { type: "threads.changed" }> {
    const threads: Array<ThreadSummary> = []
    const removed: Array<string> = []
    for (const id of new Set(threadIds)) {
      this.settleSnooze(id)
      const thread = this.refresh(id)
      if (thread) threads.push(thread)
      else removed.push(id)
    }
    return { type: "threads.changed", threads, removedThreadIds: removed, counts: this.folderCounts() }
  }

  private threadsOfMessages(ids: ReadonlyArray<string>) {
    if (ids.length === 0) return []
    return this.sql
      .exec(`SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(ids.length)})`, ...ids)
      .toArray()
      .map((r) => String(r.thread_id))
  }

  /** Marks, moves or labels individual messages. Unknown ids are ignored. */
  updateMessages(ids: ReadonlyArray<string>, patch: MessagePatch) {
    return this.transaction(() => {
      this.assertLabels([...(patch.addLabels ?? []), ...(patch.removeLabels ?? [])])
      const existing = ids.length
        ? this.sql
            .exec(`SELECT id FROM messages WHERE id IN (${placeholders(ids.length)})`, ...ids)
            .toArray()
            .map((r) => String(r.id))
        : []
      this.applyPatch(existing, patch)
      return { updated: existing.length, events: [this.changed(this.threadsOfMessages(existing))] }
    })
  }

  /**
   * Runs one rule over mail already in the mailbox (`POST …/rules/{id}/apply`), newest first, a page
   * at a time. Only actions that make sense after the fact apply: labels, moves, mark read, star and
   * assign. Forwards, auto-replies and webhooks are left out, so applying a rule never sends anything.
   * Matching reads the stored text, the same fields a delivery is matched on.
   */
  applyRule(
    rule: Rule,
    options: {
      readonly folder?: Folder | null | undefined
      readonly cursor?: string | null | undefined
      readonly limit?: number | undefined
    },
  ) {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)
    const where: Array<string> = []
    const args: Array<SqlStorageValue> = []
    if (options.folder) {
      where.push("folder = ?")
      args.push(assertFolder(options.folder))
    } else where.push("folder NOT IN ('trash', 'spam', 'sent')")
    const [at, id] = options.cursor ? options.cursor.split(":") : []
    if (at && id) {
      where.push("(received_at < ? OR (received_at = ? AND id < ?))")
      args.push(Number(at), Number(at), id)
    }
    const rows = this.sql
      .exec(
        `SELECT id, thread_id, received_at, from_name, from_address, to_list, cc_list, subject, list_id, tag,
           body_text, has_attachments, automated FROM messages WHERE ${where.join(" AND ")}
         ORDER BY received_at DESC, id DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray()
    const page = rows.slice(0, limit)
    const matched = page.filter((r) =>
      ruleMatches(rule, {
        from: r.from_address ? { name: str(r.from_name), address: String(r.from_address) } : null,
        to: parse<Array<Party>>(r.to_list),
        cc: parse<Array<Party>>(r.cc_list),
        subject: String(r.subject),
        listId: str(r.list_id),
        tag: str(r.tag),
        body: String(r.body_text).slice(0, 20_000),
        hasAttachment: Number(r.has_attachments) === 1,
        automated: Number(r.automated) === 1,
      }),
    )
    const ids = matched.map((r) => String(r.id))
    const events: Array<MailboxEvent> = []
    let changed = 0
    if (ids.length > 0) {
      const patch: MessagePatch = {}
      const labels: Array<string> = []
      let folder: Folder | undefined
      let seen: boolean | undefined
      let starred: boolean | undefined
      let assignee: string | null = null
      for (const action of rule.actions) {
        if (action.type === "label") labels.push(action.labelId)
        else if (action.type === "archive" || action.type === "trash" || action.type === "spam")
          folder = action.type
        else if (action.type === "markRead") seen = true
        else if (action.type === "star") starred = true
        else if (action.type === "assign") assignee = action.assignee
      }
      const known = new Set(this.labels().map((l) => l.id))
      const addLabels = labels.filter((l) => known.has(l))
      const full: MessagePatch = {
        ...patch,
        ...(addLabels.length ? { addLabels } : {}),
        ...(folder ? { folder } : {}),
        ...(seen !== undefined ? { seen } : {}),
        ...(starred !== undefined ? { starred } : {}),
      }
      if (Object.keys(full).length > 0) {
        const result = this.updateMessages(ids, full)
        events.push(...result.events)
        changed = result.updated
      }
      if (assignee) {
        const threads = [...new Set(matched.map((r) => String(r.thread_id)))]
        const result = this.assign(threads, assignee)
        events.push(...result.events)
        changed = Math.max(changed, ids.length)
      }
    }
    const last = page.at(-1)
    return {
      examined: page.length,
      matched: ids.length,
      changed,
      skippedActions: [
        ...new Set(
          rule.actions
            .map((a) => a.type)
            .filter((t) => t === "forward" || t === "autoReply" || t === "webhook"),
        ),
      ],
      nextCursor: rows.length > limit && last ? `${last.received_at}:${last.id}` : null,
      events,
    }
  }

  /**
   * Applies a change to whole conversations, the way a mail client's toolbar does. Moving to the
   * archive takes what is in the inbox (or snoozed); back to the inbox takes what was archived, spam
   * or trash; trash takes everything; spam takes everything but your own sent copies. Starring stars
   * the newest message; unstarring clears every star.
   */
  updateThreads(threadIds: ReadonlyArray<string>, patch: MessagePatch) {
    return this.transaction(() => {
      this.assertLabels([...(patch.addLabels ?? []), ...(patch.removeLabels ?? [])])
      const threads = threadIds.filter((id) => this.threadRow(id))
      for (const threadId of threads) {
        const all = this.sql
          .exec(
            "SELECT id, folder FROM messages WHERE thread_id = ? ORDER BY received_at DESC, id DESC",
            threadId,
          )
          .toArray()
          .map((r) => ({ id: String(r.id), folder: String(r.folder) as Folder }))
        const ids = all.map((m) => m.id)
        const { folder, starred, ...rest } = patch
        this.applyPatch(ids, rest)
        if (starred === true && all[0]) this.applyPatch([all[0].id], { starred: true })
        if (starred === false) this.applyPatch(ids, { starred: false })
        if (folder !== undefined) {
          const target = assertFolder(folder)
          const from: ReadonlyArray<Folder> =
            target === "archive"
              ? ["inbox", "snoozed"]
              : target === "inbox"
                ? ["archive", "spam", "trash", "snoozed"]
                : target === "trash"
                  ? ["inbox", "archive", "sent", "spam", "snoozed"]
                  : target === "spam"
                    ? ["inbox", "archive", "trash", "snoozed"]
                    : target === "sent"
                      ? []
                      : ["inbox"]
          this.applyPatch(
            all.filter((m) => from.includes(m.folder)).map((m) => m.id),
            { folder: target },
          )
        }
      }
      return { updated: threads.length, events: [this.changed(threads)] }
    })
  }

  /**
   * Deletes messages for good, their search rows and labels with them. Returns the R2 keys they used so
   * the caller can delete any no other mailbox still references.
   */
  purge(ids: ReadonlyArray<string>) {
    return this.transaction(() => {
      if (ids.length === 0)
        return { purged: 0, blobKeys: [] as Array<string>, events: [] as Array<MailboxEvent> }
      const marks = placeholders(ids.length)
      const rows = this.sql
        .exec(
          `SELECT rowid AS rid, id, thread_id, raw_key, body_key FROM messages WHERE id IN (${marks})`,
          ...ids,
        )
        .toArray()
      if (rows.length === 0)
        return { purged: 0, blobKeys: [] as Array<string>, events: [] as Array<MailboxEvent> }
      const found = rows.map((r) => String(r.id))
      const keys = new Set<string>()
      for (const r of rows) {
        keys.add(String(r.raw_key))
        keys.add(String(r.body_key))
        this.sql.exec("DELETE FROM search WHERE rowid = ?", r.rid)
      }
      for (const a of this.sql
        .exec(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders(found.length)})`, ...found)
        .toArray()) {
        keys.add(String(a.r2_key))
      }
      const foundMarks = placeholders(found.length)
      this.sql.exec(`DELETE FROM attachments WHERE message_id IN (${foundMarks})`, ...found)
      this.sql.exec(`DELETE FROM message_labels WHERE message_id IN (${foundMarks})`, ...found)
      this.sql.exec(`DELETE FROM messages WHERE id IN (${foundMarks})`, ...found)
      const event = this.changed(rows.map((r) => String(r.thread_id)))
      return { purged: found.length, blobKeys: [...keys].sort(), events: [event] }
    })
  }

  /** Purges everything in trash or spam. */
  emptyFolder(folder: "trash" | "spam") {
    const ids = this.sql
      .exec("SELECT id FROM messages WHERE folder = ?", folder)
      .toArray()
      .map((r) => String(r.id))
    return this.purge(ids)
  }

  /** Moves colours stored as hex onto the palette: the nearest of its six. */
  private paletteLabels() {
    for (const row of this.sql.exec("SELECT id, color FROM labels WHERE color IS NOT NULL").toArray()) {
      const color = String(row.color)
      if ((LABEL_COLORS as ReadonlyArray<string>).includes(color)) continue
      this.sql.exec("UPDATE labels SET color = ? WHERE id = ?", nearestLabelColor(color), row.id)
    }
  }

  labels(): Array<Label> {
    return this.sql
      .exec(
        `SELECT l.id, l.name, l.color, l.created_at,
           count(DISTINCT m.thread_id) AS threads,
           count(DISTINCT CASE WHEN m.seen = 0 THEN m.thread_id END) AS unread
         FROM labels l
         LEFT JOIN message_labels ml ON ml.label_id = l.id
         LEFT JOIN messages m ON m.id = ml.message_id
         GROUP BY l.id ORDER BY l.name COLLATE NOCASE`,
      )
      .toArray()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        color: str(r.color) as Label["color"],
        threads: Number(r.threads),
        unreadThreads: Number(r.unread),
        createdAt: Number(r.created_at),
      }))
  }

  private checkLabelName(name: string, exceptId?: string) {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 100)
      throw mailboxError("invalid", "A label name is 1 to 100 characters")
    const clash = this.sql
      .exec("SELECT id FROM labels WHERE name = ? COLLATE NOCASE", trimmed)
      .toArray()
      .find((r) => String(r.id) !== exceptId)
    if (clash) throw mailboxError("label_exists", `A label named "${trimmed}" already exists`)
    return trimmed
  }

  private checkColor(color: string | null | undefined) {
    if (color === null || color === undefined) return null
    const name = color.trim().toLowerCase()
    if (!(LABEL_COLORS as ReadonlyArray<string>).includes(name))
      throw mailboxError("invalid", `A label color is one of ${LABEL_COLORS.join(", ")}`)
    return name
  }

  createLabel(input: { readonly name: string; readonly color?: string | null | undefined }) {
    return this.transaction(() => {
      const name = this.checkLabelName(input.name)
      const id = newId("lbl")
      this.sql.exec(
        "INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)",
        id,
        name,
        this.checkColor(input.color),
        this.now(),
      )
      const labels = this.labels()
      const label = labels.find((l) => l.id === id) as Label
      return { label, events: [{ type: "labels.changed", labels } as MailboxEvent] }
    })
  }

  updateLabel(
    id: string,
    input: { readonly name?: string | undefined; readonly color?: string | null | undefined },
  ) {
    return this.transaction(() => {
      if (!this.sql.exec("SELECT 1 FROM labels WHERE id = ?", id).toArray()[0]) {
        throw mailboxError("not_found", `No label ${id}`)
      }
      if (input.name !== undefined)
        this.sql.exec("UPDATE labels SET name = ? WHERE id = ?", this.checkLabelName(input.name, id), id)
      if (input.color !== undefined)
        this.sql.exec("UPDATE labels SET color = ? WHERE id = ?", this.checkColor(input.color), id)
      const labels = this.labels()
      return {
        label: labels.find((l) => l.id === id) as Label,
        events: [{ type: "labels.changed", labels } as MailboxEvent],
      }
    })
  }

  deleteLabel(id: string) {
    return this.transaction(() => {
      if (!this.sql.exec("SELECT 1 FROM labels WHERE id = ?", id).toArray()[0]) {
        throw mailboxError("not_found", `No label ${id}`)
      }
      const threads = this.sql
        .exec(
          "SELECT DISTINCT m.thread_id FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = ?",
          id,
        )
        .toArray()
        .map((r) => String(r.thread_id))
      this.sql.exec("DELETE FROM message_labels WHERE label_id = ?", id)
      this.sql.exec("DELETE FROM labels WHERE id = ?", id)
      const events: Array<MailboxEvent> = [{ type: "labels.changed", labels: this.labels() }]
      if (threads.length > 0) events.push(this.changed(threads))
      return { deleted: id, events }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Snooze and the schedule
  // ---------------------------------------------------------------------------------------------

  /** Hides a conversation until `until`, then brings it back to the top of the inbox, unread. */
  snooze(threadId: string, until: number) {
    return this.transaction(() => {
      if (!this.threadRow(threadId)) throw mailboxError("not_found", `No thread ${threadId}`)
      if (!(until > this.now())) throw mailboxError("invalid", "A snooze ends in the future")
      this.sql.exec(
        "UPDATE messages SET folder = 'snoozed' WHERE thread_id = ? AND folder IN ('inbox', 'archive', 'snoozed')",
        threadId,
      )
      this.sql.exec("UPDATE threads SET snoozed_until = ? WHERE id = ?", until, threadId)
      this.sql.exec(
        "INSERT INTO schedule (kind, target, due_at) VALUES ('snooze', ?, ?) ON CONFLICT (kind, target) DO UPDATE SET due_at = excluded.due_at",
        threadId,
        until,
      )
      const thread = this.refresh(threadId)
      return {
        thread,
        events: [
          {
            type: "threads.changed",
            threads: thread ? [thread] : [],
            removedThreadIds: [],
            counts: this.folderCounts(),
          } as MailboxEvent,
        ],
      }
    })
  }

  /** Ends a snooze now, without marking anything unread. */
  unsnooze(threadId: string) {
    return this.transaction(() => {
      if (!this.threadRow(threadId)) throw mailboxError("not_found", `No thread ${threadId}`)
      this.wake(threadId, false)
      return { events: [this.changed([threadId])] }
    })
  }

  /** Returns a snoozed thread to the inbox. When the alarm ends it, the newest message is unread again. */
  private wake(threadId: string, byAlarm: boolean) {
    this.sql.exec("UPDATE messages SET folder = 'inbox' WHERE thread_id = ? AND folder = 'snoozed'", threadId)
    this.sql.exec("DELETE FROM schedule WHERE kind = 'snooze' AND target = ?", threadId)
    this.sql.exec(
      "UPDATE threads SET snoozed_until = NULL, woken_at = CASE WHEN ? THEN ? ELSE woken_at END WHERE id = ?",
      byAlarm ? 1 : 0,
      this.now(),
      threadId,
    )
    if (byAlarm) {
      this.sql.exec(
        `UPDATE messages SET seen = 0 WHERE id = (SELECT id FROM messages WHERE thread_id = ? AND folder = 'inbox'
           ORDER BY received_at DESC, id DESC LIMIT 1)`,
        threadId,
      )
    }
  }

  /** When the next scheduled thing is due, or null when nothing is scheduled. */
  nextDue(): number | null {
    return num(this.sql.exec("SELECT min(due_at) AS due FROM schedule").one().due)
  }

  /** Runs everything due by now: wakes snoozed threads and marks scheduled drafts due. */
  runDue() {
    return this.transaction(() => {
      const now = this.now()
      const due = this.sql
        .exec("SELECT kind, target FROM schedule WHERE due_at <= ? ORDER BY due_at, kind, target", now)
        .toArray()
      const events: Array<MailboxEvent> = []
      const woken: Array<string> = []
      const dueDrafts: Array<string> = []
      for (const item of due) {
        const target = String(item.target)
        if (item.kind === "snooze") {
          if (this.threadRow(target)) {
            this.wake(target, true)
            woken.push(target)
          } else {
            this.sql.exec("DELETE FROM schedule WHERE kind = 'snooze' AND target = ?", target)
          }
        } else if (item.kind === "send") {
          this.sql.exec("DELETE FROM schedule WHERE kind = 'send' AND target = ?", target)
          this.sql.exec(
            "UPDATE drafts SET status = 'due', updated_at = ? WHERE id = ? AND status = 'scheduled'",
            now,
            target,
          )
          const draft = this.draft(target)
          if (draft?.status === "due") {
            events.push({ type: "draft.due", draft })
            dueDrafts.push(draft.id)
          }
        }
      }
      if (woken.length > 0) events.unshift(this.changed(woken))
      return { ran: due.length, dueDrafts, events }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------------------------

  private toDraft(row: Row): Draft {
    return {
      id: String(row.id),
      threadId: str(row.thread_id),
      inReplyTo: str(row.in_reply_to),
      references: parse(row.refs),
      from: str(row.from_address),
      to: parse(row.to_list),
      cc: parse(row.cc_list),
      bcc: parse(row.bcc_list),
      subject: String(row.subject),
      bodyText: String(row.body_text),
      bodyHtml: str(row.body_html),
      attachments: withDelivery(String(row.body_text), str(row.body_html), parse(row.attachments)),
      status: String(row.status) as Draft["status"],
      sendAt: num(row.send_at),
      replyMode: str(row.reply_mode) as Draft["replyMode"],
      sourceMessageId: str(row.source_message_id),
      lastError: str(row.last_error),
      blockedReason: str(row.blocked_reason) as Draft["blockedReason"],
      track: row.track ? (JSON.parse(String(row.track)) as Draft["track"]) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  draft(id: string): Draft | null {
    const row = this.sql.exec("SELECT * FROM drafts WHERE id = ?", id).toArray()[0]
    return row ? this.toDraft(row) : null
  }

  drafts(options: { readonly status?: Draft["status"] | undefined; readonly limit?: number } = {}) {
    const limit = clampLimit(options.limit)
    const rows = options.status
      ? this.sql
          .exec(
            "SELECT * FROM drafts WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
            options.status,
            limit,
          )
          .toArray()
      : this.sql.exec("SELECT * FROM drafts ORDER BY updated_at DESC, id DESC LIMIT ?", limit).toArray()
    return rows.map((r) => this.toDraft(r))
  }

  /**
   * Creates or updates a draft. Editing a scheduled draft takes it off the schedule, as Gmail does; a
   * draft already due is being sent and can't change.
   */
  saveDraft(input: DraftInput) {
    return this.transaction(() => {
      const now = this.now()
      const existing = input.id ? this.draft(input.id) : null
      if (input.id && !existing) throw mailboxError("not_found", `No draft ${input.id}`)
      if (existing?.status === "due") throw mailboxError("draft_locked", `Draft ${existing.id} is being sent`)
      const threadId = input.threadId === undefined ? (existing?.threadId ?? null) : input.threadId
      if (threadId !== null && !this.threadRow(threadId))
        throw mailboxError("not_found", `No thread ${threadId}`)
      const id = existing?.id ?? newId("drf")
      const merged = {
        threadId,
        inReplyTo: input.inReplyTo === undefined ? (existing?.inReplyTo ?? null) : input.inReplyTo,
        references: input.references ?? existing?.references ?? [],
        from: input.from === undefined ? (existing?.from ?? null) : input.from,
        to: input.to ?? existing?.to ?? [],
        cc: input.cc ?? existing?.cc ?? [],
        bcc: input.bcc ?? existing?.bcc ?? [],
        subject: input.subject ?? existing?.subject ?? "",
        bodyText: input.bodyText ?? existing?.bodyText ?? "",
        bodyHtml: input.bodyHtml === undefined ? (existing?.bodyHtml ?? null) : input.bodyHtml,
        attachments: input.attachments ?? existing?.attachments ?? [],
        replyMode: input.replyMode === undefined ? (existing?.replyMode ?? null) : input.replyMode,
        sourceMessageId:
          input.sourceMessageId === undefined ? (existing?.sourceMessageId ?? null) : input.sourceMessageId,
      }
      this.sql.exec(
        `INSERT INTO drafts (id, thread_id, in_reply_to, refs, from_address, to_list, cc_list, bcc_list, subject,
           body_text, body_html, attachments, status, send_at, created_at, updated_at, reply_mode, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, in_reply_to = excluded.in_reply_to,
           refs = excluded.refs, from_address = excluded.from_address, to_list = excluded.to_list,
           cc_list = excluded.cc_list, bcc_list = excluded.bcc_list, subject = excluded.subject,
           body_text = excluded.body_text, body_html = excluded.body_html, attachments = excluded.attachments,
           status = 'draft', send_at = NULL, updated_at = excluded.updated_at, reply_mode = excluded.reply_mode,
           source_message_id = excluded.source_message_id, last_error = NULL, blocked_reason = NULL, track = NULL`,
        id,
        merged.threadId,
        merged.inReplyTo,
        json(merged.references),
        merged.from,
        json(merged.to),
        json(merged.cc),
        json(merged.bcc),
        merged.subject,
        merged.bodyText,
        merged.bodyHtml,
        json(merged.attachments),
        existing?.createdAt ?? now,
        now,
        merged.replyMode,
        merged.sourceMessageId,
      )
      this.sql.exec("DELETE FROM schedule WHERE kind = 'send' AND target = ?", id)
      const draft = this.draft(id) as Draft
      return {
        draft,
        events: [{ type: "drafts.changed", drafts: [draft], removedDraftIds: [] } as MailboxEvent],
      }
    })
  }

  /** Puts a draft on the schedule. At `sendAt` the alarm marks it `due` for the sender. */
  scheduleDraft(id: string, sendAt: number, track: DraftTracking | null = null) {
    return this.transaction(() => {
      const draft = this.draft(id)
      if (!draft) throw mailboxError("not_found", `No draft ${id}`)
      if (draft.status === "due") throw mailboxError("draft_locked", `Draft ${id} is being sent`)
      if (!(sendAt > this.now())) throw mailboxError("invalid", "A scheduled send is in the future")
      if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
        throw mailboxError("invalid", "A scheduled draft needs at least one recipient")
      }
      this.sql.exec(
        "UPDATE drafts SET status = 'scheduled', send_at = ?, track = ?, updated_at = ? WHERE id = ?",
        sendAt,
        track && (track.opens || track.clicks)
          ? JSON.stringify({ opens: track.opens, clicks: track.clicks })
          : null,
        this.now(),
        id,
      )
      this.sql.exec(
        "INSERT INTO schedule (kind, target, due_at) VALUES ('send', ?, ?) ON CONFLICT (kind, target) DO UPDATE SET due_at = excluded.due_at",
        id,
        sendAt,
      )
      const updated = this.draft(id) as Draft
      return {
        draft: updated,
        events: [{ type: "drafts.changed", drafts: [updated], removedDraftIds: [] } as MailboxEvent],
      }
    })
  }

  unscheduleDraft(id: string) {
    return this.transaction(() => {
      const draft = this.draft(id)
      if (!draft) throw mailboxError("not_found", `No draft ${id}`)
      if (draft.status === "due") throw mailboxError("draft_locked", `Draft ${id} is being sent`)
      this.sql.exec(
        "UPDATE drafts SET status = 'draft', send_at = NULL, track = NULL, updated_at = ? WHERE id = ?",
        this.now(),
        id,
      )
      this.sql.exec("DELETE FROM schedule WHERE kind = 'send' AND target = ?", id)
      const updated = this.draft(id) as Draft
      return {
        draft: updated,
        events: [{ type: "drafts.changed", drafts: [updated], removedDraftIds: [] } as MailboxEvent],
      }
    })
  }

  /** Deletes a draft. Returns its uploads' R2 keys so the caller can delete them. */
  deleteDraft(id: string) {
    return this.transaction(() => {
      const draft = this.draft(id)
      if (!draft) throw mailboxError("not_found", `No draft ${id}`)
      this.sql.exec("DELETE FROM drafts WHERE id = ?", id)
      this.sql.exec("DELETE FROM schedule WHERE kind = 'send' AND target = ?", id)
      return {
        blobKeys: draft.attachments.map((a) => a.key),
        events: [{ type: "drafts.changed", drafts: [], removedDraftIds: [id] } as MailboxEvent],
      }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Shared inboxes, sending, and the mailbox's own facts
  // ---------------------------------------------------------------------------------------------

  /** Assigns conversations to an API key, or unassigns them with null. */
  assign(threadIds: ReadonlyArray<string>, assignee: string | null) {
    return this.transaction(() => {
      const threads = threadIds.filter((id) => this.threadRow(id))
      for (const id of threads) this.sql.exec("UPDATE threads SET assignee = ? WHERE id = ?", assignee, id)
      return { updated: threads.length, threadIds: threads, events: [this.changed(threads)] }
    })
  }

  /**
   * Records the Message-ID a sent copy finally got. Email Service assigns it (a custom one is refused),
   * and a send deferred on its first attempt only learns it on the retry. Rethreads, because replies
   * will name this id.
   */
  setMessageId(id: string, messageId: string) {
    return this.transaction(() => {
      const row = this.sql.exec("SELECT message_id, thread_id FROM messages WHERE id = ?", id).toArray()[0]
      if (!row) throw mailboxError("not_found", `No message ${id}`)
      if (row.message_id === messageId) return { changed: false, events: [] as Array<MailboxEvent> }
      this.sql.exec("UPDATE messages SET message_id = ? WHERE id = ?", messageId, id)
      const { threadId, merged } = this.assignThread(id)
      // Rethreading can move the message out of its old conversation, which then needs refreshing too.
      const left =
        row.thread_id !== null &&
        String(row.thread_id) !== threadId &&
        !merged.includes(String(row.thread_id))
      const event = this.changed(left ? [threadId, String(row.thread_id)] : [threadId])
      return {
        changed: true,
        events: [{ ...event, removedThreadIds: [...event.removedThreadIds, ...merged] }],
      }
    })
  }

  /** Puts a due draft back on the schedule, for when handing it to the sender failed. */
  requeueDraft(id: string, at: number) {
    return this.transaction(() => {
      const draft = this.draft(id)
      if (draft?.status !== "due") return { requeued: false, events: [] as Array<MailboxEvent> }
      this.sql.exec(
        "UPDATE drafts SET status = 'scheduled', send_at = ?, updated_at = ? WHERE id = ?",
        at,
        this.now(),
        id,
      )
      this.sql.exec(
        "INSERT INTO schedule (kind, target, due_at) VALUES ('send', ?, ?) ON CONFLICT (kind, target) DO UPDATE SET due_at = excluded.due_at",
        id,
        at,
      )
      return { requeued: true, events: [] as Array<MailboxEvent> }
    })
  }

  getMeta(key: string): string | null {
    return str(this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value)
  }

  setMeta(key: string, value: string) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    )
  }

  /** A send that failed for good: the draft returns to the drafts folder with the reason. */
  failDraft(id: string, error: string, blockedReason: string | null = null) {
    return this.transaction(() => {
      if (!this.draft(id)) return { events: [] as Array<MailboxEvent> }
      this.sql.exec(
        "UPDATE drafts SET status = 'draft', send_at = NULL, last_error = ?, blocked_reason = ?, updated_at = ? WHERE id = ?",
        error.slice(0, 1000),
        blockedReason,
        this.now(),
        id,
      )
      this.sql.exec("DELETE FROM schedule WHERE kind = 'send' AND target = ?", id)
      const draft = this.draft(id) as Draft
      return { events: [{ type: "drafts.changed", drafts: [draft], removedDraftIds: [] } as MailboxEvent] }
    })
  }

  /** Whether an R2 attachment key belongs to a message in this mailbox, so a draft may reuse it. */
  hasAttachmentKey(key: string): boolean {
    return this.sql.exec("SELECT 1 FROM attachments WHERE r2_key = ? LIMIT 1", key).toArray().length > 0
  }

  // ---------------------------------------------------------------------------------------------
  // Import support
  // ---------------------------------------------------------------------------------------------

  /** The message holding this Message-ID, so an import doesn't store a message twice. */
  messageIdHolder(messageId: string): string | null {
    const row = this.sql.exec("SELECT id FROM messages WHERE message_id = ? LIMIT 1", messageId).toArray()[0]
    return row ? String(row.id) : null
  }

  /** The label with this name, created if it doesn't exist yet. Names compare case-insensitively. */
  ensureLabel(name: string) {
    return this.transaction(() => {
      const trimmed = name.trim().slice(0, 100)
      const found = this.sql.exec("SELECT id FROM labels WHERE name = ? COLLATE NOCASE", trimmed).toArray()[0]
      if (found) return { id: String(found.id), created: false, events: [] as Array<MailboxEvent> }
      const id = newId("lbl")
      this.sql.exec(
        "INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, NULL, ?)",
        id,
        trimmed,
        this.now(),
      )
      return {
        id,
        created: true,
        events: [{ type: "labels.changed", labels: this.labels() } as MailboxEvent],
      }
    })
  }

  /** Adds labels to an existing message: the same message found in another imported folder. */
  addLabelsToMessage(id: string, labelIds: ReadonlyArray<string>) {
    return this.transaction(() => {
      const row = this.sql.exec("SELECT thread_id FROM messages WHERE id = ?", id).toArray()[0]
      if (!row || labelIds.length === 0) return { events: [] as Array<MailboxEvent> }
      for (const labelId of labelIds) {
        this.sql.exec(
          "INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ?",
          id,
          labelId,
        )
      }
      return { events: [this.changed([String(row.thread_id)])] }
    })
  }
}

const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null
}
const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** How much the live socket can replay to a client that reconnects. */
export const LIVE_LOG_SIZE = 1000
export const LIVE_LOG_MS = 24 * 3_600_000

const withDelivery = (
  bodyText: string,
  bodyHtml: string | null,
  attachments: ReadonlyArray<DraftAttachment>,
): Array<DraftAttachment> => {
  const plan = planAttachments({ bodyText, bodyHtml, attachments })
  return attachments.map((a) => ({ ...a, delivery: plan.get(a.key) ?? "inline" }))
}

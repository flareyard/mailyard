/**
 * The mailbox's SQLite schema, one entry per version, applied in order inside the Durable Object's
 * constructor. Never edit a shipped entry: append a new one. `after` runs in the same transaction,
 * for data a statement alone can't move (v2 threads and indexes the messages v1 stored).
 */
export interface MailboxMigration {
  readonly statements: ReadonlyArray<string>
  readonly after?: "threadAndIndexExisting"
}

export const MAILBOX_MIGRATIONS: ReadonlyArray<MailboxMigration> = [
  {
    statements: [
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
  },
  {
    statements: [
      "ALTER TABLE messages ADD COLUMN thread_id TEXT",
      "ALTER TABLE messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox'",
      "ALTER TABLE messages ADD COLUMN seen INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0",
      // Threading facts (src/mailbox/threading.ts), stored so the subject fallback is one indexed query.
      "ALTER TABLE messages ADD COLUMN subject_key TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE messages ADD COLUMN reply_subject INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN headerless INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE messages ADD COLUMN sent_at INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX messages_thread ON messages (thread_id, sent_at)",
      "CREATE INDEX messages_folder ON messages (folder, thread_id)",
      "CREATE INDEX messages_subject ON messages (subject_key, sent_at)",
      `CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        latest_message_id TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        unread_count INTEGER NOT NULL,
        starred INTEGER NOT NULL,
        has_attachments INTEGER NOT NULL,
        participants TEXT NOT NULL,
        folders TEXT NOT NULL,
        label_ids TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        sort_at INTEGER NOT NULL,
        woken_at INTEGER,
        snoozed_until INTEGER
      )`,
      "CREATE INDEX threads_sort ON threads (sort_at DESC, id DESC)",
      // Every message-id a message links through, including ancestors that never arrived, mapped to
      // the thread that holds them. A later message naming any of them joins that thread.
      "CREATE TABLE thread_refs (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL)",
      "CREATE INDEX thread_refs_thread ON thread_refs (thread_id)",
      `CREATE TABLE labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE message_labels (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, label_id)
      )`,
      "CREATE INDEX message_labels_label ON message_labels (label_id)",
      `CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        in_reply_to TEXT,
        refs TEXT NOT NULL,
        from_address TEXT,
        to_list TEXT NOT NULL,
        cc_list TEXT NOT NULL,
        bcc_list TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        body_html TEXT,
        attachments TEXT NOT NULL,
        status TEXT NOT NULL,
        send_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      "CREATE INDEX drafts_thread ON drafts (thread_id)",
      "CREATE INDEX drafts_updated ON drafts (updated_at DESC, id DESC)",
      // What the alarm wakes for: snoozed threads and scheduled drafts.
      `CREATE TABLE schedule (
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        PRIMARY KEY (kind, target)
      )`,
      "CREATE INDEX schedule_due ON schedule (due_at)",
      // rowid = messages.rowid. remove_diacritics so "cafe" finds "café".
      "CREATE VIRTUAL TABLE search USING fts5(subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2')",
    ],
    after: "threadAndIndexExisting",
  },
  {
    statements: [
      // Shared inboxes: who is handling a conversation (an API key id), or nobody.
      "ALTER TABLE threads ADD COLUMN assignee TEXT",
      "CREATE INDEX threads_assignee ON threads (assignee, sort_at DESC)",
      // How a draft relates to the message it answers: a reply, a reply to all, or a forward.
      "ALTER TABLE drafts ADD COLUMN reply_mode TEXT",
      "ALTER TABLE drafts ADD COLUMN source_message_id TEXT",
      // Why the last send of this draft failed, shown on the draft until it is edited.
      "ALTER TABLE drafts ADD COLUMN last_error TEXT",
      // Facts about the mailbox itself, such as its id, which the alarm needs to dispatch due drafts.
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ],
  },
]

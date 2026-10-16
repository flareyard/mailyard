import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * The account-wide D1 database. Per-mailbox data (threads, messages, search) lives in each
 * MailboxDO's own SQLite, not here. Data model: docs/plans/email-platform.html#data.
 * Times are Unix milliseconds. Ids are time-ordered strings from src/kit/Ids.ts.
 */

const createdAt = () => integer("created_at").notNull().default(sql`(unixepoch('subsec') * 1000)`)

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    zoneId: text("zone_id"),
    sendingEnabled: integer("sending_enabled", { mode: "boolean" }).notNull().default(false),
    routingEnabled: integer("routing_enabled", { mode: "boolean" }).notNull().default(false),
    /** What happens to mail for an address with no mailbox: bounce it, or keep it in the catch-all mailbox. */
    catchAll: text("catch_all", { enum: ["bounce", "keep"] })
      .notNull()
      .default("bounce"),
    lastCheckedAt: integer("last_checked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("domains_name").on(t.name)],
)

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id),
    address: text("address").notNull(),
    displayName: text("display_name"),
    kind: text("kind", { enum: ["user", "shared", "group", "alias", "catch_all"] }).notNull(),
    /** For aliases and groups: the mailbox ids this address delivers to, as JSON. */
    targets: text("targets", { mode: "json" }).$type<ReadonlyArray<string>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mailboxes_address").on(t.address), index("mailboxes_domain").on(t.domainId)],
)

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    status: text("status", {
      enum: ["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained", "suppressed"],
    })
      .notNull()
      .default("unconfirmed"),
    lastActivityAt: integer("last_activity_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contacts_email").on(t.email), index("contacts_status").on(t.status)],
)

export const topics = sqliteTable("topics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  doubleOptIn: integer("double_opt_in", { mode: "boolean" }).notNull().default(true),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
})

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id),
    state: text("state", { enum: ["subscribed", "unconfirmed", "unsubscribed"] }).notNull(),
    /** How the state last changed: form, import, api, unsubscribe link, one-click header, admin. */
    source: text("source").notNull(),
    changedAt: integer("changed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.topicId] }),
    index("subscriptions_topic").on(t.topicId, t.state),
  ],
)

/** Events a contact did, sent through `track()`, used by segments and automation triggers. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    at: integer("at").notNull(),
  },
  (t) => [index("events_contact").on(t.contactId, t.at), index("events_name").on(t.name, t.at)],
)

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  filter: text("filter", { mode: "json" }).$type<unknown>().notNull(),
  compiledSql: text("compiled_sql").notNull(),
  lastCount: integer("last_count"),
  lastComputedAt: integer("last_computed_at"),
  createdAt: createdAt(),
})

/**
 * A template and its versions. Sends and campaigns use the latest published version; editing writes a
 * draft, so a live template never changes under a send in flight.
 */
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** `html`: an HTML document with placeholders. `blocks`: a JSON document of kit blocks, laid out in the brand. */
    kind: text("kind", { enum: ["html", "blocks"] }).notNull(),
    publishedVersion: integer("published_version"),
    latestVersion: integer("latest_version").notNull(),
    archivedAt: integer("archived_at"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("templates_name").on(t.name)],
)

export const templateVersions = sqliteTable(
  "template_versions",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    subject: text("subject").notNull(),
    /** HTML for `html` templates; the blocks document as JSON for `blocks` templates. */
    source: text("source").notNull(),
    /** Optional hand-written text part; otherwise it is derived from the HTML. */
    text: text("text"),
    publishedAt: integer("published_at"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
)

/** Workspace settings as JSON documents by key: `brand` (the theme templates are laid out in), and more later. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "scheduled", "sending", "paused", "sent", "cancelled"] })
      .notNull()
      .default("draft"),
    segmentId: text("segment_id").references(() => segments.id),
    topicId: text("topic_id").references(() => topics.id),
    templateId: text("template_id").references(() => templates.id),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    subjectB: text("subject_b"),
    sendAt: integer("send_at"),
    workflowId: text("workflow_id"),
    audienceSize: integer("audience_size"),
    createdAt: createdAt(),
  },
  (t) => [index("campaigns_status").on(t.status)],
)

/**
 * Every outbound message: written before the send, then updated from Email Sending events. The
 * delivery ledger behind the message log, campaign reports and the contact timeline.
 */
export const messagesOut = sqliteTable(
  "messages_out",
  {
    id: text("id").primaryKey(),
    stream: text("stream", { enum: ["transactional", "campaign", "automation", "reply"] }).notNull(),
    cfMessageId: text("cf_message_id"),
    idempotencyKey: text("idempotency_key"),
    apiKeyId: text("api_key_id"),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id),
    automationRunId: text("automation_run_id"),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    recipient: text("recipient").notNull(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    status: text("status", {
      enum: ["queued", "sent", "delivered", "deferred", "bounced", "failed", "rejected", "complained"],
    })
      .notNull()
      .default("queued"),
    bounceType: text("bounce_type", { enum: ["hard", "soft"] }),
    provider: text("provider"),
    smtpResponse: text("smtp_response"),
    /** Why the last attempt failed, in the sender's words (a typed error tag and its message). */
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** R2 key of the rendered message as sent, for the message log and for retries. */
    renderedKey: text("rendered_key"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at"),
  },
  (t) => [
    uniqueIndex("messages_out_idempotency").on(t.idempotencyKey),
    uniqueIndex("messages_out_cf_message").on(t.cfMessageId),
    index("messages_out_recipient").on(t.recipient, t.createdAt),
    index("messages_out_campaign").on(t.campaignId, t.status),
    index("messages_out_created").on(t.createdAt),
  ],
)

/** Processed Email Sending event ids, so a redelivered queue message is applied once. */
export const processedEvents = sqliteTable("processed_events", {
  eventId: text("event_id").primaryKey(),
  at: integer("at").notNull(),
})

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  trigger: text("trigger", { mode: "json" }).$type<unknown>().notNull(),
  graph: text("graph", { mode: "json" }).$type<unknown>().notNull(),
  version: integer("version").notNull().default(1),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
})

export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id),
    version: integer("version").notNull(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    state: text("state", { enum: ["running", "waiting", "completed", "exited", "failed"] }).notNull(),
    currentStep: text("current_step"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("automation_runs_automation").on(t.automationId, t.state),
    index("automation_runs_contact").on(t.contactId),
  ],
)

export const suppressions = sqliteTable("suppressions", {
  email: text("email").primaryKey(),
  reason: text("reason", { enum: ["hard_bounce", "complaint", "unsubscribe", "manual"] }).notNull(),
  source: text("source", { enum: ["cloudflare", "events", "manual", "import"] }).notNull(),
  syncedToCloudflare: integer("synced_to_cloudflare", { mode: "boolean" }).notNull().default(false),
  at: integer("at").notNull(),
})

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * `secret` keys (sk_…) can send and manage; `public` keys (pk_…) can only track events, so they
     * are safe in a browser. Same split as Plunk, so its SDKs work unchanged.
     */
    kind: text("kind", { enum: ["secret", "public"] }).notNull(),
    /** The first characters of the key, shown in the UI so people can tell keys apart. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key. The key itself is shown once and never stored. */
    hash: text("hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    createdBy: text("created_by"),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.hash)],
)

export const audit = sqliteTable(
  "audit",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    before: text("before", { mode: "json" }).$type<unknown>(),
    after: text("after", { mode: "json" }).$type<unknown>(),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_at").on(t.at), index("audit_target").on(t.target)],
)

/** Daily rollups written by the events consumer; the source for Overview and Analytics charts. */
export const dailyStats = sqliteTable(
  "daily_stats",
  {
    day: text("day").notNull(),
    stream: text("stream").notNull(),
    provider: text("provider").notNull().default(""),
    sent: integer("sent").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    deferred: integer("deferred").notNull().default(0),
    bouncedHard: integer("bounced_hard").notNull().default(0),
    bouncedSoft: integer("bounced_soft").notNull().default(0),
    complained: integer("complained").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    failed: integer("failed").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.stream, t.provider] })],
)

/**
 * Idempotency-Key records. A repeat with the same key and the same body replays the stored response;
 * the same key with a different body is refused with 409, as Plunk does. Kept for 24 hours.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    apiKeyId: text("api_key_id").notNull(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    response: text("response"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.key] }), index("idempotency_keys_expires").on(t.expiresAt)],
)

/** Where webhooks go. The signing secret is stored AES-GCM-encrypted under WEBHOOK_SIGNING_KEY. */
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  description: text("description"),
  /** Event types this endpoint receives, or ["*"] for all. */
  events: text("events", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastSuccessAt: integer("last_success_at"),
  lastFailureAt: integer("last_failure_at"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull(),
})

/** One attempt-tracked delivery of one event to one endpoint: the delivery log and the dead-letter store. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "retrying", "dead"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    lastDurationMs: integer("last_duration_ms"),
    lastAttemptAt: integer("last_attempt_at"),
    nextAttemptAt: integer("next_attempt_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_deliveries_endpoint").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_status").on(t.status),
  ],
)

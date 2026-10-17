import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { RecordCheck } from "../domain/dnsChecks.ts"
import type { Action, Condition } from "../rules/engine.ts"

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
    /** The last DNS record check (src/domain/dnsChecks.ts), as shown on the domain detail screen. */
    checks: text("checks", { mode: "json" }).$type<ReadonlyArray<RecordCheck>>(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(0),
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
    signature: text("signature", { mode: "json" }).$type<{
      readonly text: string
      readonly html: string | null
    }>(),
    /** Out-of-office reply; sent by the rules engine (HAL-3153). */
    autoReply: text("auto_reply", { mode: "json" }).$type<{
      readonly enabled: boolean
      readonly subject: string
      readonly body: string
      readonly startsAt: number | null
      readonly endsAt: number | null
    }>(),
    /** Forward a copy of every message; carried out by the rules engine (HAL-3153). */
    forwarding: text("forwarding", { mode: "json" }).$type<{
      readonly enabled: boolean
      readonly to: ReadonlyArray<string>
      readonly keepCopy: boolean
    }>(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(0),
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
    /** Latest tracked event, open and click: together they set the contact's engagement. */
    lastEventAt: integer("last_event_at"),
    lastOpenedAt: integer("last_opened_at"),
    lastClickedAt: integer("last_clicked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contacts_email").on(t.email),
    index("contacts_status").on(t.status),
    index("contacts_created").on(t.createdAt),
    index("contacts_activity").on(t.lastActivityAt),
  ],
)

export const topics = sqliteTable("topics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  doubleOptIn: integer("double_opt_in", { mode: "boolean" }).notNull().default(true),
  /** Who confirmation mail for this topic comes from ("Name <address>"); DEFAULT_FROM when unset. */
  sender: text("sender"),
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

/** Clicks per link per campaign, people and machines apart, for the report's link table. */
export const campaignLinks = sqliteTable(
  "campaign_links",
  {
    campaignId: text("campaign_id").notNull(),
    url: text("url").notNull(),
    clicks: integer("clicks").notNull().default(0),
    machineClicks: integer("machine_clicks").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.url] })],
)

/** Every change to a contact's subscription to a topic, for the timeline and for consent records. */
export const subscriptionChanges = sqliteTable(
  "subscription_changes",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id),
    from: text("from", { enum: ["subscribed", "unconfirmed", "unsubscribed"] }),
    to: text("to", { enum: ["subscribed", "unconfirmed", "unsubscribed"] }).notNull(),
    source: text("source").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("subscription_changes_contact").on(t.contactId, t.at)],
)

/** A public signup form: whoever submits it is added to its topics, confirming by email where the topic asks. */
export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  topicIds: text("topic_ids", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
  /** Custom fields the form may set, beyond email and name. Anything else submitted is dropped. */
  fields: text("fields", { mode: "json" }).$type<ReadonlyArray<string>>().notNull().default(sql`'[]'`),
  redirectUrl: text("redirect_url"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
})

/**
 * Things that need a person: a campaign paused for its bounce rate, a domain failing its checks.
 * One open alert per `key`, so a condition that persists doesn't pile up duplicates.
 */
export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    /** What the alert is about, unique among open alerts: `campaign.paused:<id>`. */
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    subject: text("subject", { mode: "json" }).$type<{ readonly type: string; readonly id: string } | null>(),
    createdAt: createdAt(),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [index("alerts_open").on(t.resolvedAt, t.createdAt), index("alerts_key").on(t.key, t.resolvedAt)],
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
  /** The filter as a condition over `contacts`, with `?` placeholders for `compiledParams`. */
  compiledSql: text("compiled_sql").notNull(),
  compiledParams: text("compiled_params", { mode: "json" })
    .$type<ReadonlyArray<unknown>>()
    .notNull()
    .default(sql`'[]'`),
  lastCount: integer("last_count"),
  lastComputedAt: integer("last_computed_at"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at"),
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
    /** The template version a send uses, frozen when it's scheduled; null while a draft. */
    templateVersion: integer("template_version"),
    /** Inline content, for a campaign written without a template. */
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    fromAddress: text("from_address").notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    subjectB: text("subject_b"),
    preheader: text("preheader"),
    /** A/B subject test: the share of the audience that tests, and when the winner is picked. */
    ab: text("ab", { mode: "json" }).$type<{
      readonly percent: number
      readonly waitHours: number
      readonly metric: "clicks" | "opens"
    } | null>(),
    sendAt: integer("send_at"),
    workflowId: text("workflow_id"),
    audienceSize: integer("audience_size"),
    pausedReason: text("paused_reason"),
    /** Opens (a pixel) and clicks (redirected links) for this campaign; both on unless switched off. */
    trackOpens: integer("track_opens", { mode: "boolean" }).notNull().default(true),
    trackClicks: integer("track_clicks", { mode: "boolean" }).notNull().default(true),
    /** The subject that won the A/B test, once picked; the rest of the audience gets it. */
    abWinner: text("ab_winner", { enum: ["a", "b"] }),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at"),
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
    /** `test`: a campaign test send to the seed list, outside the quota and the campaign's numbers. */
    stream: text("stream", {
      enum: ["transactional", "campaign", "automation", "reply", "mailbox", "test"],
    }).notNull(),
    cfMessageId: text("cf_message_id"),
    /** For mail sent from a mailbox: the mailbox, and the id of the sent copy filed in it. */
    mailboxId: text("mailbox_id"),
    mailboxMessageId: text("mailbox_message_id"),
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
    /** Which subject an A/B campaign message carried. */
    variant: text("variant", { enum: ["a", "b"] }),
    /** First human open and click, from tracking (HAL-3277); segments filter on them. */
    firstOpenedAt: integer("first_opened_at"),
    firstClickedAt: integer("first_clicked_at"),
    /** Whether the message carried a tracking pixel and tracked links. */
    tracked: integer("tracked", { mode: "boolean" }).notNull().default(false),
    /** Hits that look like people, and hits that look like machines (privacy proxies, link scanners). */
    opens: integer("opens").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    machineOpens: integer("machine_opens").notNull().default(0),
    machineClicks: integer("machine_clicks").notNull().default(0),
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

/**
 * Every message Email Routing handed to `email()`, one row per envelope recipient. The raw `.eml` is in
 * R2 under `rawKey` before this row exists, so a row that never reaches `filed` can always be reprocessed.
 */
export const inboundMessages = sqliteTable(
  "inbound_messages",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the raw bytes; the same message to two recipients shares one R2 object. */
    sha256: text("sha256").notNull(),
    rawKey: text("raw_key").notNull(),
    size: integer("size").notNull(),
    envelopeFrom: text("envelope_from").notNull(),
    envelopeTo: text("envelope_to").notNull(),
    messageId: text("message_id"),
    /** The Message-ID it answers, so a campaign report can count the replies its mail drew. */
    inReplyTo: text("in_reply_to"),
    subject: text("subject"),
    fromAddress: text("from_address"),
    /**
     * `received`: stored, not yet filed. `filed`: in every target mailbox. `rejected`: bounced at the door.
     * `held`: stored, but no mailbox takes it any more. `failed`: an attempt broke; a retry job is queued.
     */
    /** `consumed`: handled by Mailyard itself (a mailto unsubscribe), not filed in a mailbox. */
    status: text("status", {
      enum: ["received", "filed", "rejected", "held", "failed", "consumed"],
    }).notNull(),
    /** Where the recipient resolved to, fixed at first resolution so a retry files into the same mailboxes. */
    resolution: text("resolution", { mode: "json" }).$type<{
      readonly via: "mailbox" | "alias" | "group" | "catch_all"
      readonly matched: { readonly id: string; readonly address: string }
      readonly tag: string | null
      readonly mailboxIds: ReadonlyArray<string>
    }>(),
    /** The mailbox ids the message is already in; a retry skips them. */
    deliveredTo: text("delivered_to", { mode: "json" })
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default(sql`'[]'`),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: integer("received_at").notNull(),
    filedAt: integer("filed_at"),
  },
  (t) => [
    uniqueIndex("inbound_messages_recipient").on(t.sha256, t.envelopeTo),
    index("inbound_messages_status").on(t.status, t.receivedAt),
    index("inbound_messages_received").on(t.receivedAt),
  ],
)

/** Which API keys may read a mailbox, and send as it. Root and admin keys need no row. */
export const mailboxMembers = sqliteTable(
  "mailbox_members",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** `owner` and `member` read and send; `viewer` only reads. */
    role: text("role", { enum: ["owner", "member", "viewer"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.apiKeyId] }), index("mailbox_members_key").on(t.apiKeyId)],
)

/**
 * Exports of a mailbox's mail to R2 (HAL-3154). A mailbox holding mail can only be removed once one
 * of these is complete, so removing never destroys the only copy.
 */
export const mailboxExports = sqliteTable(
  "mailbox_exports",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id").notNull(),
    status: text("status", { enum: ["pending", "running", "complete", "failed"] }).notNull(),
    format: text("format", { enum: ["mbox", "eml-zip", "both"] }).notNull(),
    /** The mbox file. */
    r2Key: text("r2_key"),
    /** The zip of .eml files, when the export made one. */
    zipKey: text("zip_key"),
    zipSize: integer("zip_size").notNull().default(0),
    /** Multipart upload state between Workflow steps. */
    state: text("state", { mode: "json" }).$type<Record<string, unknown>>(),
    messageCount: integer("message_count").notNull().default(0),
    size: integer("size").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("mailbox_exports_mailbox").on(t.mailboxId, t.createdAt)],
)

/** Inbox rules, run in `position` order on every message a mailbox receives (src/rules/engine.ts). */
export const mailboxRules = sqliteTable(
  "mailbox_rules",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    match: text("match", { enum: ["all", "any"] })
      .notNull()
      .default("all"),
    conditions: text("conditions", { mode: "json" }).$type<ReadonlyArray<Condition>>().notNull(),
    actions: text("actions", { mode: "json" }).$type<ReadonlyArray<Action>>().notNull(),
    stop: integer("stop", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("mailbox_rules_order").on(t.mailboxId, t.position)],
)

/**
 * Senders a mailbox always accepts (`allow`: marking a message "not spam" adds its sender) or always
 * files as spam (`block`). `value` is an address, or `@domain` for a whole domain.
 */
export const mailboxSenders = sqliteTable(
  "mailbox_senders",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    list: text("list", { enum: ["allow", "block"] }).notNull(),
    source: text("source", { enum: ["user", "not_spam", "spam"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.value] })],
)

/** When a mailbox last auto-replied to an address: RFC 3834 asks for at most one reply per sender per period. */
export const autoReplies = sqliteTable(
  "auto_replies",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** Which reply: the mailbox's out-of-office, or a rule's. */
    source: text("source").notNull(),
    sentAt: integer("sent_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.address, t.source] })],
)

/** Per-folder import progress, kept so a later import catches up from where this one stopped. */
export interface ImportFolderProgress {
  readonly name: string
  readonly raw: string
  readonly folder: string
  readonly label: string | null
  readonly uidValidity: number | null
  /** Messages the source reported for the part being imported. */
  readonly source: number
  readonly imported: number
  readonly duplicates: number
  readonly failed: number
  /** Flagged \Deleted on the source, or expunged between planning and fetching. */
  readonly skipped: number
  readonly lastUid: number
  readonly batches: number
  readonly batchesDone: number
}

/**
 * A mailbox import: from an IMAP server (MailboxImport Workflow) or an mbox file in R2. The source
 * password is sealed while the import runs and wiped the moment it ends, whatever the outcome.
 */
export const mailboxImports = sqliteTable(
  "mailbox_imports",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["imap", "mbox"] }).notNull(),
    /** `catchup` fetches only what arrived since the last import from the same account. */
    mode: text("mode", { enum: ["full", "catchup"] }).notNull(),
    host: text("host"),
    port: integer("port"),
    username: text("username"),
    secretCiphertext: text("secret_ciphertext"),
    /** For an mbox import: the R2 key of the file. */
    objectKey: text("object_key"),
    /** Folders asked for, or null for every importable one. */
    folders: text("folders", { mode: "json" }).$type<ReadonlyArray<string>>(),
    progress: text("progress", { mode: "json" }).$type<ReadonlyArray<ImportFolderProgress>>(),
    status: text("status", { enum: ["pending", "running", "complete", "failed", "cancelled"] }).notNull(),
    error: text("error"),
    workflowId: text("workflow_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("mailbox_imports_mailbox").on(t.mailboxId, t.createdAt)],
)

/** Files uploaded for an import (`POST /v1/uploads`), kept in R2 under `key`. */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("uploads_created").on(t.createdAt)],
)

/** A contact CSV import, run by ContactImportWorkflow in 5,000-row steps from a byte offset. */
export const contactImports = sqliteTable(
  "contact_imports",
  {
    id: text("id").primaryKey(),
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploads.id),
    /** Column header → `email`, `name`, `status`, `fields.<key>` or `ignore`. */
    mapping: text("mapping", { mode: "json" }).$type<Record<string, string>>().notNull(),
    topicIds: text("topic_ids", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    onConflict: text("on_conflict", { enum: ["update", "skip"] }).notNull(),
    defaultStatus: text("default_status", { enum: ["subscribed", "unsubscribed"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] })
      .notNull()
      .default("queued"),
    headers: text("headers", { mode: "json" }).$type<ReadonlyArray<string>>(),
    /** Where the next step reads from: a byte offset into the file, and the line it starts on. */
    offset: integer("offset").notNull().default(0),
    line: integer("line").notNull().default(1),
    rows: integer("rows").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    invalid: integer("invalid").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    suppressed: integer("suppressed").notNull().default(0),
    /** The first 100 row errors, with their line numbers. */
    errors: text("errors", { mode: "json" })
      .$type<ReadonlyArray<{ readonly line: number; readonly message: string }>>()
      .notNull()
      .default(sql`'[]'`),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("contact_imports_created").on(t.createdAt)],
)

/**
 * A CSV export of contacts (`POST /v1/exports`). Small ones are written at once; past 10,000 rows
 * ContactExportWorkflow pages through by contact id and uploads to R2 in multipart parts.
 */
export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["contacts"] }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    /** The list's filters: q, status, topicId, engagement, segmentId, field, event. */
    filter: text("filter", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Custom fields to add as columns, in order. */
    fields: text("fields", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    rows: integer("rows").notNull().default(0),
    /** Multipart progress for large exports: the upload id, the parts so far, the last contact id written. */
    uploadId: text("upload_id"),
    parts: text("parts", { mode: "json" })
      .$type<ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>>()
      .notNull()
      .default(sql`'[]'`),
    after: text("after"),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("exports_created").on(t.createdAt)],
)

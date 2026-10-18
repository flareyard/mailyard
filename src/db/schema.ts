import { sql } from "drizzle-orm"
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { RecordCheck } from "../domain/dnsChecks.ts"
import type { ZoneInfo } from "../domain/zoneInfo.ts"
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
    /** When every record first passed: `domain_activated` is raised once, and `dns_drift` watches after. */
    activatedAt: integer("activated_at"),
    /** The last DNS record check (src/domain/dnsChecks.ts), as shown on the domain detail screen. */
    checks: text("checks", { mode: "json" }).$type<ReadonlyArray<RecordCheck>>(),
    /** What the zone said at the last recheck (HAL-3365): status, nameservers, registrar, DNSSEC, complaints. */
    zone: text("zone", { mode: "json" }).$type<ZoneInfo>(),
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
    /** Spam points at or above which mail goes to spam; null for the default (5). */
    spamThreshold: real("spam_threshold"),
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
    /** When the contact confirmed (double opt-in) or was first subscribed: the consent on record (HAL-3422). */
    confirmedAt: integer("confirmed_at"),
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
  (t) => [
    index("subscription_changes_contact").on(t.contactId, t.at),
    index("subscription_changes_to").on(t.to, t.at),
  ],
)

/** A public signup form: whoever submits it is added to its topics, confirming by email where the topic asks. */
export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  topicIds: text("topic_ids", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
  /** Custom fields the form may set, beyond email and name. Anything else submitted is dropped. */
  fields: text("fields", { mode: "json" }).$type<ReadonlyArray<string>>().notNull().default(sql`'[]'`),
  redirectUrl: text("redirect_url"),
  /** A line under the heading on the hosted page (GET /f/:id). */
  description: text("description"),
  /** Cloudflare Turnstile site key; with TURNSTILE_SECRET set, submissions must pass the challenge. */
  turnstileSiteKey: text("turnstile_site_key"),
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
    /** How many times it happened while open: failed runs, dead deliveries, repeat raises. */
    count: integer("count").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: integer("updated_at"),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("alerts_open").on(t.resolvedAt, t.createdAt),
    index("alerts_key").on(t.key, t.resolvedAt),
    index("alerts_created").on(t.createdAt),
  ],
)

/** Events a contact did, sent through `track()`, used by segments and automation triggers. */
/**
 * Every custom field contacts have (HAL-3422): its key, a label people can change, and a type
 * inferred from the first value written (string, number, boolean, date). A trigger on `contacts`
 * (migration 0033) adds new keys as any writer sets them, so imports, forms, the API and automations
 * all register theirs.
 */
export const contactFields = sqliteTable("contact_fields", {
  key: text("key").primaryKey(),
  label: text("label"),
  type: text("type", { enum: ["string", "number", "boolean", "date"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
})

/**
 * A bulk action over a filter too big for one request (HAL-3422): ContactBulkWorkflow pages through
 * the matching contacts by id, 500 at a time, and keeps the counts here.
 */
export const contactBulkJobs = sqliteTable("contact_bulk_jobs", {
  id: text("id").primaryKey(),
  filter: text("filter", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  action: text("action", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull(),
  /** Matching contacts when the job was created. */
  total: integer("total").notNull(),
  processed: integer("processed").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  /** The first 100 errors. */
  errors: text("errors", { mode: "json" }).$type<Array<{ id: string; message: string }>>().notNull(),
  /** The last contact id processed: the next page starts after it. */
  cursor: text("cursor"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
})

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
    /** Who last saved this version: its creator, or whoever saved the draft since. */
    createdBy: text("created_by"),
    createdAt: createdAt(),
    /** When the draft was last saved (HAL-3415); the creation time for versions saved once. */
    updatedAt: integer("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
)

/**
 * Sends per template per UTC day and API key (`""` for campaigns, automations and mailboxes), kept by
 * a trigger on `messages_out` (migration 0028), so a template's 30-day count and the keys sending it
 * are a read of at most 30 days × senders, however much mail it sent (HAL-3415). Test sends aren't counted.
 */
export const templateDaily = sqliteTable(
  "template_daily",
  {
    templateId: text("template_id").notNull(),
    day: text("day").notNull(),
    apiKeyId: text("api_key_id").notNull().default(""),
    sends: integer("sends").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.day, t.apiKeyId] })],
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
  (t) => [index("campaigns_status").on(t.status), index("campaigns_template").on(t.templateId)],
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
    /** When Mailyard's own retry of a deferred send is due; null when none is queued (HAL-3413). */
    nextAttemptAt: integer("next_attempt_at"),
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
    index("messages_out_stream").on(t.stream, t.createdAt),
    index("messages_out_template").on(t.templateId, t.createdAt),
    /** Segment campaign rules and the dry run read a contact's campaign mail (HAL-3423). */
    index("messages_out_contact").on(t.contactId, t.createdAt),
  ],
)

/**
 * A message's trail (HAL-3413): accepted, every status change and retry, the first human open and
 * click. Written by triggers on `messages_out` (migration 0025), so every writer (the outbox, the
 * events consumer, tracking, campaigns) is covered without each one remembering to.
 */
export const messageEvents = sqliteTable(
  "message_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id").notNull(),
    type: text("type", {
      enum: [
        "accepted",
        "sent",
        "deferred",
        "delivered",
        "bounced",
        "complained",
        "failed",
        "rejected",
        "suppressed",
        "opened",
        "clicked",
      ],
    }).notNull(),
    at: integer("at").notNull(),
    attempt: integer("attempt"),
    provider: text("provider"),
    bounceType: text("bounce_type"),
    smtpResponse: text("smtp_response"),
    detail: text("detail"),
  },
  (t) => [index("message_events_message").on(t.messageId, t.at)],
)

/** Processed Email Sending event ids, so a redelivered queue message is applied once. */
export const processedEvents = sqliteTable("processed_events", {
  eventId: text("event_id").primaryKey(),
  at: integer("at").notNull(),
})

export const automations = sqliteTable(
  "automations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** The draft's trigger (a copy of the graph's trigger node config, for indexing which automations an event starts). */
    trigger: text("trigger", { mode: "json" }).$type<unknown>().notNull(),
    /** The draft graph (src/automations/graph.ts); published versions are frozen in automation_versions. */
    graph: text("graph", { mode: "json" }).$type<unknown>().notNull(),
    /** The draft's settings: sender, topic, re-entry, cadence cap, stop events. */
    settings: text("settings", { mode: "json" }).$type<unknown>(),
    /** The draft's version number: one more than the last published. */
    version: integer("version").notNull().default(1),
    /** The version new runs enter, or null before the first publish. */
    publishedVersion: integer("published_version"),
    /** What starts new runs, denormalised from the published version: `event:<name>`, `created`, `segment:<id>`, `topic:<id>`, `date`. */
    triggerKey: text("trigger_key"),
    status: text("status", { enum: ["draft", "live", "paused"] })
      .notNull()
      .default("draft"),
    /** The API origin captured at publish: the base of the unsubscribe and tracking links runs send. */
    origin: text("origin"),
    /** Kept for the first schema; `status` is what counts. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at"),
    updatedBy: text("updated_by"),
  },
  (t) => [index("automations_trigger").on(t.triggerKey, t.status)],
)

/** A published version: frozen, so a run that entered on it finishes on it. */
export const automationVersions = sqliteTable(
  "automation_versions",
  {
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    graph: text("graph", { mode: "json" }).$type<unknown>().notNull(),
    settings: text("settings", { mode: "json" }).$type<unknown>().notNull(),
    note: text("note"),
    publishedBy: text("published_by").notNull(),
    publishedAt: integer("published_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.version] })],
)

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
    /** When a waiting run next wakes (a wait's end, or a wait_event's timeout). */
    nextAt: integer("next_at"),
    /** The event a `wait_event` step is waiting for; a tracked event with this name wakes the run. */
    waitingEvent: text("waiting_event"),
    /** The step sequence the run has reached, so a retried run carries on numbering its history. */
    seq: integer("seq").notNull().default(0),
    /** What started it: the event's data, for templates and webhooks. */
    triggerData: text("trigger_data", { mode: "json" }).$type<Record<string, unknown> | null>(),
    exitedBy: text("exited_by"),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("automation_runs_automation").on(t.automationId, t.state),
    index("automation_runs_contact").on(t.contactId),
    index("automation_runs_started").on(t.automationId, t.startedAt),
  ],
)

/** Every step a run took: the history the run page shows, and the node counts on the builder. */
export const automationRunSteps = sqliteTable(
  "automation_run_steps",
  {
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    automationId: text("automation_id").notNull(),
    nodeId: text("node_id").notNull(),
    outcome: text("outcome", {
      enum: ["passed", "waiting", "sent", "skipped", "exited", "failed"],
    }).notNull(),
    port: text("port"),
    detail: text("detail").notNull(),
    messageId: text("message_id"),
    at: integer("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    index("automation_run_steps_node").on(t.automationId, t.nodeId),
  ],
)

/** Automation sends per contact, across every automation: what the cadence cap counts. */
export const automationSends = sqliteTable(
  "automation_sends",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    runId: text("run_id").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("automation_sends_contact").on(t.contactId, t.at)],
)

/**
 * Addresses Mailyard won't send to (HAL-3372). A row blocks every stream, or only bulk mail
 * (campaigns and automations) when `bulkOnly`: how a complaint can still get a password reset.
 */
export const suppressions = sqliteTable(
  "suppressions",
  {
    email: text("email").primaryKey(),
    reason: text("reason", { enum: ["hard_bounce", "complaint", "unsubscribe", "manual"] }).notNull(),
    source: text("source", { enum: ["cloudflare", "events", "manual", "import"] }).notNull(),
    syncedToCloudflare: integer("synced_to_cloudflare", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    /** The message whose bounce or complaint added it. */
    messageId: text("message_id"),
    bulkOnly: integer("bulk_only", { mode: "boolean" }).notNull().default(false),
    /** The contact's status before it was blocked, restored when the suppression is removed. */
    contactStatusBefore: text("contact_status_before"),
    /** The matching entry on Cloudflare's Email Sending suppression list, as the last sync found it. */
    cloudflareId: text("cloudflare_id"),
    /** When a sync last looked for this address on Cloudflare's list; null until one has. */
    cloudflareCheckedAt: integer("cloudflare_checked_at"),
    at: integer("at").notNull(),
    updatedAt: integer("updated_at"),
  },
  (t) => [index("suppressions_at").on(t.at, t.email), index("suppressions_reason").on(t.reason, t.at)],
)

/** A CSV of addresses to suppress (`POST /v1/suppressions/import`), read in steps like a contact import. */
export const suppressionImports = sqliteTable(
  "suppression_imports",
  {
    id: text("id").primaryKey(),
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploads.id),
    /** The reason for rows without a reason column (or with an empty cell). */
    reason: text("reason", { enum: ["hard_bounce", "complaint", "unsubscribe", "manual"] }).notNull(),
    note: text("note"),
    emailColumn: text("email_column"),
    reasonColumn: text("reason_column"),
    noteColumn: text("note_column"),
    /** Also add each new address to Cloudflare's suppression list. */
    push: integer("push", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] })
      .notNull()
      .default("queued"),
    headers: text("headers", { mode: "json" }).$type<ReadonlyArray<string>>(),
    offset: integer("offset").notNull().default(0),
    line: integer("line").notNull().default(1),
    rows: integer("rows").notNull().default(0),
    added: integer("added").notNull().default(0),
    existing: integer("existing").notNull().default(0),
    invalid: integer("invalid").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    pushed: integer("pushed").notNull().default(0),
    errors: text("errors", { mode: "json" })
      .$type<ReadonlyArray<{ readonly line: number; readonly message: string }>>()
      .notNull()
      .default(sql`'[]'`),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("suppression_imports_created").on(t.createdAt)],
)

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
    /**
     * What the key is for: `api` (code calling the API) or `mcp` (an agent connected to /mcp). A label
     * for the Integrations and API keys screens, never a permission: scopes and mailbox memberships
     * decide what a key can do (HAL-3410).
     */
    purpose: text("purpose", { enum: ["api", "mcp"] })
      .notNull()
      .default("api"),
    /** The first characters of the key, shown in the UI so people can tell keys apart. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key. The key itself is shown once and never stored. */
    hash: text("hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    createdBy: text("created_by"),
    /** Touched at most once a minute; `api_key_usage` counts every request. */
    lastUsedAt: integer("last_used_at"),
    /** When it stopped (or, after a rotation with a grace period, will stop) working. */
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.hash)],
)

/**
 * Requests per key per UTC hour (HAL-3414), counted as each request authenticates: one upsert, so
 * `requests24h` is a read of at most 24 rows per key. Rows older than 30 days are pruned hourly.
 */
export const apiKeyUsage = sqliteTable(
  "api_key_usage",
  {
    keyId: text("key_id").notNull(),
    /** Epoch hour: milliseconds / 3,600,000, floored. */
    hour: integer("hour").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.hour] }), index("api_key_usage_hour").on(t.hour)],
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
 * Messages first handed to Email Service, per UTC hour, stream (the governor's four: transactional,
 * campaign, automation, mailbox) and campaign (`""` for none), kept by a trigger on `messages_out`
 * (migration 0030) so the 24-hour chart and a campaign's send rate read at most a few dozen rows
 * (HAL-3419). Test sends aren't counted. Pruned after 8 days.
 */
export const hourlyStats = sqliteTable(
  "hourly_stats",
  {
    /** Epoch hour: milliseconds / 3,600,000, floored. */
    hour: integer("hour").notNull(),
    stream: text("stream").notNull(),
    campaignId: text("campaign_id").notNull().default(""),
    sent: integer("sent").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.hour, t.stream, t.campaignId] }),
    index("hourly_stats_campaign").on(t.campaignId, t.hour),
  ],
)

/**
 * How long Email Service took to deliver, from a message's last `sent` event to its `delivered` one,
 * as a histogram per UTC day (HAL-3420). Bucket i holds times under DELIVERY_BUCKETS_MS[i]; the last
 * bucket is a day or more. Kept by a trigger on `message_events` (migration 0031).
 */
export const deliveryTimes = sqliteTable(
  "delivery_times",
  {
    day: text("day").notNull(),
    bucket: integer("bucket").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.bucket] })],
)

/**
 * Deferrals per UTC day, provider, SMTP status and reason (HAL-3420), kept by a trigger on
 * `message_events`: Email Service's deferrals carry the receiving server's response; Mailyard's own
 * (its retry queue) carry the sender's error.
 */
export const deferralDaily = sqliteTable(
  "deferral_daily",
  {
    day: text("day").notNull(),
    provider: text("provider").notNull().default(""),
    smtpStatus: text("smtp_status").notNull().default(""),
    reason: text("reason").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.provider, t.smtpStatus, t.reason] })],
)

/**
 * Each campaign's engagement, counted as it happens by triggers on `messages_out` and `events`
 * (migration 0032), so comparing campaigns reads one row each rather than their mail (HAL-3421).
 * `machineOpens` counts messages with any machine open (privacy proxies, scanners).
 */
export const campaignEngagement = sqliteTable("campaign_engagement", {
  campaignId: text("campaign_id").primaryKey(),
  delivered: integer("delivered").notNull().default(0),
  uniqueOpens: integer("unique_opens").notNull().default(0),
  machineOpens: integer("machine_opens").notNull().default(0),
  uniqueClicks: integer("unique_clicks").notNull().default(0),
  unsubscribed: integer("unsubscribed").notNull().default(0),
})

/** First human opens and clicks of bulk mail (campaigns and automations) per UTC day and hour (HAL-3421). */
export const engagementHourly = sqliteTable(
  "engagement_hourly",
  {
    day: text("day").notNull(),
    hour: integer("hour").notNull(),
    opens: integer("opens").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.hour] })],
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
    index("webhook_deliveries_endpoint_status").on(t.endpointId, t.status, t.createdAt),
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
    /** The contact timeline's replies (HAL-3422). */
    index("inbound_messages_from").on(t.fromAddress, t.receivedAt),
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
    /** Messages this rule matched as they arrived (not counting `apply` runs), and the latest. */
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedAt: integer("last_matched_at"),
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
  /** UIDs that couldn't be imported (the first 1,000), for `retry-failed`; IMAP only. */
  readonly failedUids?: ReadonlyArray<number> | undefined
  /** Why the latest failure in this folder failed. */
  readonly lastError?: string | null | undefined
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
    status: text("status", {
      enum: ["pending", "running", "paused", "complete", "failed", "cancelled"],
    }).notNull(),
    error: text("error"),
    workflowId: text("workflow_id"),
    /** When planning finished and messages started to move; with pausedMs, what the rate is over. */
    startedAt: integer("started_at"),
    pausedAt: integer("paused_at"),
    pausedMs: integer("paused_ms").notNull().default(0),
    /** A catch-up: the import it continues from, and when that one finished (what "since" means). */
    catchupOf: text("catchup_of"),
    since: integer("since"),
    /** A retry of another import's failed messages, and those UIDs per folder (raw name). */
    retryOf: text("retry_of"),
    uids: text("uids", { mode: "json" }).$type<Record<string, ReadonlyArray<number>>>(),
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

/**
 * Each mailbox an inbound message was filed into, and the folder it went to (HAL-3362): what the
 * inbound stats count per mailbox and as spam. Written once per delivery; rows from before this
 * table existed were backfilled with folder null (not recorded).
 */
export const inboundDeliveries = sqliteTable(
  "inbound_deliveries",
  {
    inboundId: text("inbound_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    folder: text("folder"),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.inboundId, t.mailboxId] }), index("inbound_deliveries_at").on(t.at)],
)

/**
 * Inbound counts for closed days (UTC), computed once and read by key: a closed day never changes.
 * `mailbox_id` "" is the whole workspace (every message received, rejected and held); the other rows
 * are per mailbox (deliveries, and those filed as spam).
 */
export const inboundDaily = sqliteTable(
  "inbound_daily",
  {
    day: text("day").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    received: integer("received").notNull().default(0),
    spam: integer("spam").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    held: integer("held").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.mailboxId] })],
)

/** The 50 busiest senders of each closed day, for top senders over a range. */
export const inboundDailySenders = sqliteTable(
  "inbound_daily_senders",
  {
    day: text("day").notNull(),
    address: text("address").notNull(),
    received: integer("received").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.address] })],
)

/** The audience by status, snapshotted by the hourly cron: the Overview reads it instead of counting contacts. */
export const audienceDaily = sqliteTable("audience_daily", {
  day: text("day").primaryKey(),
  total: integer("total").notNull(),
  subscribed: integer("subscribed").notNull(),
  unconfirmed: integer("unconfirmed").notNull(),
  unsubscribed: integer("unsubscribed").notNull(),
  bounced: integer("bounced").notNull(),
  complained: integer("complained").notNull(),
  suppressed: integer("suppressed").notNull(),
  at: integer("at").notNull(),
})

/**
 * Each recipient of a mailbox send and how its delivery went (HAL-3408): one Email Sending message
 * goes to everyone on it, but each recipient gets their own events. Seeded when the send goes out;
 * delivery events move each row forward, the same way the message's own status moves.
 */
export const messageRecipients = sqliteTable(
  "message_recipients",
  {
    messageId: text("message_id").notNull(),
    recipient: text("recipient").notNull(),
    kind: text("kind", { enum: ["to", "cc", "bcc"] }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "sent",
        "delivered",
        "deferred",
        "bounced",
        "failed",
        "rejected",
        "complained",
        "suppressed",
      ],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    smtpResponse: text("smtp_response"),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.recipient] })],
)

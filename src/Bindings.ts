import * as Context from "effect/Context"
import type { InboundJob } from "./inbound/pipeline.ts"
import type { SendEmailBinding } from "./kit/index.ts"
import type { MailboxDO } from "./objects/MailboxDO.ts"
import type { SendGovernorDO } from "./objects/SendGovernorDO.ts"
import type { SendJob } from "./services/SendQueue.ts"

/** The Worker's bindings, as declared in wrangler.jsonc and, later, in alchemy.run.ts. */
export interface Env {
  readonly DB: D1Database
  readonly STORE: R2Bucket
  readonly SEND_QUEUE: Queue<SendJob>
  readonly WEBHOOK_QUEUE: Queue<{ readonly deliveryId: string }>
  /** Inbound messages whose filing failed after the raw copy was stored; the consumer retries them. */
  readonly INBOUND_QUEUE: Queue<InboundJob>
  /** Drafts whose send time has come, handed from a mailbox's alarm to the sender. */
  readonly MAILBOX_SEND_QUEUE: Queue<{
    readonly mailboxId: string
    readonly draftId: string
    readonly origin: string | null
  }>
  /** Signs links to attachments and large files (GET /v1/files/{token}). Deploy-time secret. */
  readonly FILE_SIGNING_KEY?: string
  /** Seconds a send waits so it can be undone. 10 unless set; tests shorten it. */
  readonly MAILYARD_UNDO_SECONDS?: string
  /** New campaigns track opens and clicks unless these are "false" (manifest settings). */
  readonly MAILYARD_TRACK_OPENS?: string
  readonly MAILYARD_TRACK_CLICKS?: string
  /** Spam classifier: `off` (default), `workers-ai` (needs AI) or `openai` (CLASSIFIER_URL and _MODEL). */
  readonly MAILYARD_CLASSIFIER?: "off" | "workers-ai" | "openai"
  /** Workers AI, only bound when the classifier uses it. */
  readonly AI?: Ai
  readonly CLASSIFIER_URL?: string
  readonly CLASSIFIER_MODEL?: string
  readonly CLASSIFIER_API_KEY?: string
  /** Imports a mailbox from IMAP or an mbox (src/workflows/mailbox.ts). */
  readonly IMPORT_WORKFLOW: Workflow<{ readonly importId: string }>
  /** Sends a campaign: snapshot, then governor-paced chunks (src/workflows/campaign.ts). */
  readonly CAMPAIGN_WORKFLOW: Workflow<{ readonly campaignId: string; readonly origin: string }>
  /** Automation triggers, fanned out to runs (src/automations/runs.ts). */
  readonly AUTOMATION_QUEUE: Queue<import("./automations/runs.ts").AutomationTriggerJob>
  /** One automation run: walks a published graph for one contact (src/workflows/automation.ts). */
  readonly AUTOMATION_WORKFLOW: Workflow<{ readonly runId: string }>
  /** Imports a contact CSV in 5,000-row steps (src/workflows/contactImport.ts). */
  readonly CONTACT_IMPORT_WORKFLOW: Workflow<{ readonly importId: string }>
  /** Imports a suppression-list CSV in 5,000-row steps (src/workflows/suppressionImport.ts). */
  readonly SUPPRESSION_IMPORT_WORKFLOW: Workflow<{ readonly importId: string }>
  /** Writes contact exports past 10,000 rows as a multipart CSV (src/workflows/contactExport.ts). */
  readonly CONTACT_EXPORT_WORKFLOW: Workflow<{ readonly exportId: string }>
  /** The whole workspace in one export (src/workflows/workspaceExport.ts). */
  readonly WORKSPACE_EXPORT_WORKFLOW: Workflow<{ readonly exportId: string }>
  readonly CONTACT_BULK_WORKFLOW: Workflow<{ readonly jobId: string }>
  /** Tests only: the multipart part size for contact exports (6 MiB unless set; R2 refuses under 5 MiB). */
  readonly MAILYARD_EXPORT_PART_BYTES?: string
  /** Cloudflare Turnstile secret; forms with a site key require a passed challenge when it's set. */
  readonly TURNSTILE_SECRET?: string
  /** Exports a mailbox to an mbox and a zip of .eml files. */
  readonly EXPORT_WORKFLOW: Workflow<{ readonly exportId: string }>
  /** One Durable Object per mailbox: its messages, threads and search. */
  readonly MAILBOX: DurableObjectNamespace<MailboxDO>
  /** The account's bulk-send scheduler (src/objects/SendGovernorDO.ts): one instance, named "account". */
  readonly SEND_GOVERNOR: DurableObjectNamespace<SendGovernorDO>
  /** Deploy-time secret that encrypts webhook endpoint secrets at rest (manifest secret). */
  readonly WEBHOOK_SIGNING_KEY?: string
  /** Cloudflare Email Service. Absent only when MAILYARD_SENDER says otherwise (tests, local dev). */
  readonly EMAIL?: SendEmailBinding
  /** Root key generated at deploy time (manifest secret ADMIN_KEY). */
  readonly ADMIN_KEY?: string
  /** `memory` swaps Email Service for the in-memory sender: tests and local development only. */
  readonly MAILYARD_SENDER?: "cloudflare" | "memory"
  /** Optional, read-only: lets the Overview show the account's Email Sending quota and reputation. */
  readonly CLOUDFLARE_ACCOUNT_ID?: string
  readonly CLOUDFLARE_EMAIL_READ_TOKEN?: string
  /**
   * Optional, Email Sending: Edit: lets Mailyard add to and remove from Cloudflare's suppression
   * list (`POST /v1/suppressions/{email}/push`, removals, imports with `push`). Without it, only
   * Mailyard's own list changes.
   */
  readonly CLOUDFLARE_EMAIL_WRITE_TOKEN?: string
  /**
   * Optional (HAL-3365): a token for the zones Mailyard's domains live in. Zone: Read, DNS: Read and
   * Email Sending: Read let the domain screens show zone status, nameservers, registrar, DNSSEC,
   * complaints and the account's other zones; Email Routing: Edit and Email Sending: Edit add the
   * Fix records button. Without it those fields are null and fixing is refused with a reason.
   */
  readonly CLOUDFLARE_DNS_TOKEN?: string
  /** The Worker Email Routing hands mail to, when it isn't "mailyard-api": a rule pointing at it is ours. */
  readonly MAILYARD_WORKER_NAME?: string
  /** Hours a conversation may wait for a reply before the Overview counts it as waiting; 24 by default. */
  readonly MAILYARD_REPLY_TARGET_HOURS?: string
  /** The queue Email Sending's delivery events arrive on; `mailyard-email-events` unless renamed. */
  readonly MAILYARD_EVENTS_QUEUE?: string
  /**
   * Signs consent links: double opt-in confirmations now, unsubscribe and preference links with
   * HAL-3297. Deploy-time secret; the links stop working if it changes.
   */
  readonly UNSUBSCRIBE_KEY?: string
  /** Signs tracking links; FILE_SIGNING_KEY when unset. */
  readonly TRACKING_KEY?: string
  /** Raw open and click hits (Analytics Engine); optional, the D1 rollups work without it. */
  readonly TRACK_EVENTS?: AnalyticsEngineDataset
  /** Rate limit for public signup forms, per IP and form (wrangler `ratelimits`). */
  readonly FORM_LIMITER?: RateLimit
  /** Failed authentications per address: 20 a minute, then 429 (src/http/handlers.ts). */
  readonly AUTH_LIMITER?: RateLimit
  /** Used when a send names no sender and its template has none. */
  readonly DEFAULT_FROM?: string
  /** Optional SMTP fallback when Email Service can't take a message. */
  readonly SMTP_HOST?: string
  readonly SMTP_PORT?: string
  readonly SMTP_USERNAME?: string
  readonly SMTP_PASSWORD?: string
}

export class Bindings extends Context.Service<Bindings, Env>()("mailyard/Bindings") {}

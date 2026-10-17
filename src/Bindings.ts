import { Context } from "effect"
import type { InboundJob } from "./inbound/pipeline.ts"
import type { SendEmailBinding } from "./kit/index.ts"
import type { MailboxDO } from "./objects/MailboxDO.ts"
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
  /** Spam classifier: `off` (default), `workers-ai` (needs AI) or `openai` (CLASSIFIER_URL and _MODEL). */
  readonly MAILYARD_CLASSIFIER?: "off" | "workers-ai" | "openai"
  /** Workers AI, only bound when the classifier uses it. */
  readonly AI?: Ai
  readonly CLASSIFIER_URL?: string
  readonly CLASSIFIER_MODEL?: string
  readonly CLASSIFIER_API_KEY?: string
  /** Imports a mailbox from IMAP or an mbox (src/workflows/mailbox.ts). */
  readonly IMPORT_WORKFLOW: Workflow<{ readonly importId: string }>
  /** Exports a mailbox to an mbox and a zip of .eml files. */
  readonly EXPORT_WORKFLOW: Workflow<{ readonly exportId: string }>
  /** One Durable Object per mailbox: its messages, threads and search. */
  readonly MAILBOX: DurableObjectNamespace<MailboxDO>
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
  /** Used when a send names no sender and its template has none. */
  readonly DEFAULT_FROM?: string
  /** Optional SMTP fallback when Email Service can't take a message. */
  readonly SMTP_HOST?: string
  readonly SMTP_PORT?: string
  readonly SMTP_USERNAME?: string
  readonly SMTP_PASSWORD?: string
}

export class Bindings extends Context.Service<Bindings, Env>()("mailyard/Bindings") {}

import { Context } from "effect"
import type { SendEmailBinding } from "./kit/index.ts"
import type { SendJob } from "./services/SendQueue.ts"

/** The Worker's bindings, as declared in wrangler.jsonc and, later, in alchemy.run.ts. */
export interface Env {
  readonly DB: D1Database
  readonly STORE: R2Bucket
  readonly SEND_QUEUE: Queue<SendJob>
  readonly WEBHOOK_QUEUE: Queue<{ readonly deliveryId: string }>
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

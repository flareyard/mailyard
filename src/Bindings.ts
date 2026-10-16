import type { SendEmailBinding } from "@flareyard/kit"
import { Context } from "effect"
import type { SendJob } from "./services/SendQueue.ts"

/** The Worker's bindings, as declared in wrangler.jsonc and, later, in alchemy.run.ts. */
export interface Env {
  readonly DB: D1Database
  readonly STORE: R2Bucket
  readonly SEND_QUEUE: Queue<SendJob>
  /** Cloudflare Email Service. Absent only when MAILFLARE_SENDER says otherwise (tests, local dev). */
  readonly EMAIL?: SendEmailBinding
  /** Root key generated at deploy time (manifest secret ADMIN_KEY). */
  readonly ADMIN_KEY?: string
  /** `memory` swaps Email Service for the in-memory sender: tests and local development only. */
  readonly MAILFLARE_SENDER?: "cloudflare" | "memory"
  /** Used when a send names no sender and its template has none. */
  readonly DEFAULT_FROM?: string
  /** Optional SMTP fallback when Email Service can't take a message. */
  readonly SMTP_HOST?: string
  readonly SMTP_PORT?: string
  readonly SMTP_USERNAME?: string
  readonly SMTP_PASSWORD?: string
}

export class Bindings extends Context.Service<Bindings, Env>()("@flareyard/mailflare/Bindings") {}

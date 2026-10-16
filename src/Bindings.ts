import { Context } from "effect"

/** The Worker's bindings, as declared in wrangler.jsonc and, later, in alchemy.run.ts. */
export interface Env {
  readonly DB: D1Database
  readonly STORE: R2Bucket
}

export class Bindings extends Context.Service<Bindings, Env>()("@flareyard/mailflare/Bindings") {}

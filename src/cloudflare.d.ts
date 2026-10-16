import type { Env as MailEnv } from "./Bindings.ts"

// Tells the Workers types what `env` and `exports` hold in this app, so `cloudflare:workers` imports
// are typed without casts.
declare global {
  namespace Cloudflare {
    interface Env extends MailEnv {
      /** Test-only: D1 migrations read by vitest.config.ts. */
      readonly TEST_MIGRATIONS?: ReadonlyArray<import("cloudflare:test").D1Migration>
    }
    interface GlobalProps {
      mainModule: typeof import("./workers/api.ts")
    }
  }
}

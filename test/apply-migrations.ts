import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

if (!env.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding missing: check vitest.config.ts")
await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS])

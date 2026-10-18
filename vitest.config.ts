import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

/** Pure functions (sender mapping, retry policy, email blocks) don't need the Workers runtime. */
const UNIT = [
  "test/kit/**/*.test.ts",
  "test/templates/kit.test.ts",
  "test/templates/library.test.ts",
  "test/d1Params.test.ts",
  "test/automations/triggerData.test.ts",
  "test/live/**/*.test.ts",
  "test/contracts/**/*.test.ts",
]

/**
 * wrangler.jsonc without its queue consumers. Tests drive consumers by hand with createMessageBatch;
 * a bound consumer would also deliver queued jobs in the background and race them (HAL-3218). Miniflare
 * merges consumer options additively, so they can only be left out of the config, not overridden.
 * test/queues.test.ts checks the real file still binds every consumer.
 */
const testWranglerConfig = () => {
  const root = import.meta.dirname
  const source = readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
  const config = JSON.parse(
    source.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, s: string | undefined) => s ?? ""),
  )
  delete config.queues.consumers
  // The web app's static assets aren't part of the Worker under test, and web/dist only exists after a build.
  delete config.assets
  // Workers AI runs remotely; tests swap the DocumentText service instead (HAL-3459).
  delete config.ai
  config.main = path.join(root, config.main)
  for (const db of config.d1_databases ?? []) db.migrations_dir = path.join(root, db.migrations_dir)
  const dir = path.join(root, ".wrangler", "vitest")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "wrangler.json")
  writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: UNIT, environment: "node" } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: testWranglerConfig() },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
                ADMIN_KEY: "test-admin-key",
                MAILYARD_SENDER: "memory",
                WEBHOOK_SIGNING_KEY: "test-webhook-signing-key",
                FILE_SIGNING_KEY: "test-file-signing-key",
                UNSUBSCRIBE_KEY: "test-unsubscribe-key",
                // BENCH=1 bun run test runs the timing benchmarks, which a loaded shared run can't time fairly.
                BENCH: process.env.BENCH ?? "",
                // The undo window, shortened so tests watch the alarm hand a send over.
                MAILYARD_UNDO_SECONDS: "0.5",
                // The public origin is the test host; requests through api.mailyard.test check link building (HAL-3483).
                MAILYARD_PUBLIC_ORIGIN: "https://mailyard.test",
                // Who sign-in links and invitations come from (HAL-3361).
                MAILYARD_SYSTEM_FROM: "Mailyard <hello@people.mailyard.test>",
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: UNIT,
          setupFiles: ["./test/apply-migrations.ts"],
          // Worker tests make many requests each, across isolates running side by side; 5 s was set
          // for a far smaller suite and now times out busy machines, not slow code.
          testTimeout: 20_000,
        },
      },
    ],
  },
})

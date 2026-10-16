import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

/** Pure functions (sender mapping, retry policy, email blocks) don't need the Workers runtime. */
const UNIT = ["test/kit/**/*.test.ts", "test/templates/kit.test.ts"]

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: UNIT, environment: "node" } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
                ADMIN_KEY: "test-admin-key",
                MAILFLARE_SENDER: "memory",
                WEBHOOK_SIGNING_KEY: "test-webhook-signing-key",
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: UNIT,
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
    ],
  },
})

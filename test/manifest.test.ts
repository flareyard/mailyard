import { describe, expect, it } from "vitest"
import manifestText from "../cloudflare-app.json?raw"
import { trackingDefaults } from "../src/campaigns/campaigns.ts"
import type { Manifest } from "../tools/manifest/Manifest.ts"
import { parseJsonc, resourceProblems, type WranglerConfig } from "../tools/manifest/resources.ts"
import wranglerText from "../wrangler.jsonc?raw"
import { ADMIN, call } from "./helpers.ts"

const manifest = JSON.parse(manifestText) as Manifest
const config = parseJsonc(wranglerText) as WranglerConfig

describe("cloudflare-app.json against wrangler.jsonc", () => {
  it("requires every scope the bindings need, and every consumer has a dead-letter queue", () => {
    expect(resourceProblems(manifest, config)).toEqual([])
    const scopes = manifest.scopes.required.map((s) => s.scope)
    expect(scopes).toEqual(
      expect.arrayContaining([
        "workers-scripts.write",
        "d1.write",
        "workers-r2.write",
        "queues.write",
        "email-sending.write",
      ]),
    )
  })

  it("reports a missing scope, a missing dead-letter queue and a resource id", () => {
    const broken: WranglerConfig = {
      ...config,
      d1_databases: [{ binding: "DB", database_name: "mailyard", database_id: "abc" }],
      queues: { consumers: [{ queue: "q" }] },
      kv_namespaces: [{ binding: "CACHE", id: "123" }],
    }
    const without = {
      ...manifest,
      scopes: {
        ...manifest.scopes,
        required: manifest.scopes.required.slice(1) as unknown as Manifest["scopes"]["required"],
      },
    }
    expect(resourceProblems(without, broken)).toEqual([
      expect.stringContaining("workers-scripts.write"),
      expect.stringContaining("workers-kv-storage.write"),
      "Queue consumer q has no dead_letter_queue.",
      expect.stringContaining("database_id"),
      expect.stringContaining("KV CACHE has an id"),
    ])
  })

  it("strips JSONC comments without touching strings", () => {
    expect(parseJsonc('{ "a": "x // not a comment", /* b */ "c": [1, 2,], // d\n }')).toEqual({
      a: "x // not a comment",
      c: [1, 2],
    })
  })

  it("answers the health check without a key, and the status route only with one", async () => {
    const health = await call(manifest.health)
    expect(health.status).toBe(200)
    expect(manifest.status?.path).toBe("/v1/health")
    expect((await call(manifest.status?.path ?? "")).status).toBe(401)
    expect((await call(manifest.status?.path ?? "", { key: ADMIN })).status).toBe(200)
  })
})

describe("settings", () => {
  it('default campaign tracking to on, and switch it off only for "false"', () => {
    expect(trackingDefaults({})).toEqual({ trackOpens: true, trackClicks: true })
    expect(trackingDefaults({ MAILYARD_TRACK_OPENS: "false", MAILYARD_TRACK_CLICKS: " FALSE " })).toEqual({
      trackOpens: false,
      trackClicks: false,
    })
    expect(trackingDefaults({ MAILYARD_TRACK_OPENS: "true", MAILYARD_TRACK_CLICKS: "0" })).toEqual({
      trackOpens: true,
      trackClicks: true,
    })
    const setting = (name: string) => manifest.settings?.find((s) => s.name === name)
    expect(setting("MAILYARD_TRACK_OPENS")).toMatchObject({ type: "boolean", default: true })
    expect(setting("MAILYARD_UNDO_SECONDS")).toMatchObject({ type: "integer", default: 10, min: 0, max: 30 })
  })
})

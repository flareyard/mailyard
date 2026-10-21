import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { isWorkerPath } from "../../src/public/origin.ts"

/**
 * The Worker's own paths and `assets.run_worker_first` must agree (HAL-3774). A path the Worker serves
 * but the assets binding answers first gets the web app's index.html with a 200: /llms.txt and /docs
 * did exactly that on 0.3.2, so an agent asking for the docs read an empty app shell instead.
 */

const root = path.join(import.meta.dirname, "../..")
const wrangler = JSON.parse(
  readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (_, s: string | undefined) => s ?? "",
  ),
) as { assets: { run_worker_first: Array<string>; not_found_handling?: string } }

const patterns = wrangler.assets.run_worker_first
const runsWorkerFirst = (p: string) =>
  patterns.some((pattern) => (pattern.endsWith("/*") ? p.startsWith(pattern.slice(0, -1)) : p === pattern))

/** Paths the Worker answers, one or more per route family. */
const WORKER = [
  "/v1/me",
  "/v1/send",
  "/healthz",
  "/openapi.json",
  "/mcp",
  "/t/o/x.gif",
  "/u/token",
  "/p/request",
  "/c/token",
  "/f/token",
  "/v/token",
  "/brand/logo/x.png",
  "/oauth/authorize",
  "/oauth/token",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/docs",
  "/docs.md",
  "/docs/",
  "/docs/agents",
  "/docs/agents.md",
  "/docs/index.md",
  "/docs/api",
  "/docs/nope",
  "/llms.txt",
  "/llms-full.txt",
]

/** Paths the web app answers. */
const APP = ["/", "/inbox", "/mail/abc", "/settings/keys", "/agents", "/assets/app.js", "/ui/fonts/x.woff2"]

describe("which paths reach the Worker (HAL-3774)", () => {
  it("sends every Worker path past the assets", () => {
    for (const p of WORKER) {
      expect(isWorkerPath(p), `isWorkerPath(${p})`).toBe(true)
      expect(runsWorkerFirst(p), `run_worker_first covers ${p}`).toBe(true)
    }
  })

  it("leaves the web app's paths to the assets", () => {
    for (const p of APP) {
      expect(isWorkerPath(p), `isWorkerPath(${p})`).toBe(false)
      expect(runsWorkerFirst(p), `run_worker_first skips ${p}`).toBe(false)
    }
  })

  it("never lets the app's fallback answer a text, Markdown or JSON file the Worker owns", () => {
    expect(wrangler.assets.not_found_handling).toBe("single-page-application")
    const files = WORKER.filter((p) => /\.(txt|md|json)$/.test(p))
    expect(files.length).toBeGreaterThan(4)
    for (const p of files) expect(runsWorkerFirst(p), p).toBe(true)
  })
})

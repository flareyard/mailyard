#!/usr/bin/env bun
// A copy of the Flareyard platform's manifest validator (flareyard/flareyard packages/manifest, contract
// v1.3 with GraphQL, synced 2026-10-18 at 17378ee), kept here so Mailyard can check its own cloudflare-app.json without
// depending on the platform repo. Mailyard adds the wrangler.jsonc check (resources.ts).
import { Exit } from "effect"
import { crossFieldProblems } from "./check.ts"
import { decodeManifestExit } from "./Manifest.ts"
import { parseJsonc, resourceProblems, type WranglerConfig } from "./resources.ts"

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error("usage: flareyard-manifest <cloudflare-app.json> [...]")
  process.exit(2)
}

let failed = false
for (const path of paths) {
  const exit = decodeManifestExit(await Bun.file(path).json())
  if (Exit.isFailure(exit)) {
    failed = true
    console.error(`✗ ${path}\n${String(exit.cause)}`)
    continue
  }
  // The wrangler config beside the manifest must agree with it (bindings, scopes, dead-letter queues).
  const wrangler = Bun.file(path.replace(/[^/]*$/, "wrangler.jsonc"))
  const config = (await wrangler.exists()) ? (parseJsonc(await wrangler.text()) as WranglerConfig) : undefined
  const problems = [
    ...crossFieldProblems(exit.value),
    ...(config ? resourceProblems(exit.value, config) : []),
  ]
  if (problems.length > 0) {
    failed = true
    console.error(`✗ ${path}\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    continue
  }
  console.log(`✓ ${path} (${exit.value.id} ${exit.value.version})`)
}
process.exit(failed ? 1 : 0)

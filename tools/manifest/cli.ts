#!/usr/bin/env bun
// A copy of the Flareyard platform's manifest validator (flareyard/flareyard packages/manifest), kept here so
// Mailflare can check its own cloudflare-app.json without depending on the platform repo.
import { Exit } from "effect"
import { crossFieldProblems } from "./check.ts"
import { decodeManifestExit } from "./Manifest.ts"

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
  const problems = crossFieldProblems(exit.value)
  if (problems.length > 0) {
    failed = true
    console.error(`✗ ${path}\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    continue
  }
  console.log(`✓ ${path} (${exit.value.id} ${exit.value.version})`)
}
process.exit(failed ? 1 : 0)

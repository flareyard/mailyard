/**
 * Pulls the contract-checked fixtures out of the OpenDesign screens into src/fixtures/fixtures.json.
 *
 * Every design screen embeds the exact response each panel renders as
 * <script type="application/json" data-fixture="GET /v1/…">. `_build/contract/check.py` validates those
 * blocks against the live OpenAPI, so fixture mode serves data the real API could have returned.
 *
 *   MAILYARD_DESIGNS=~/dev/tools/open-design/.od/projects/b1698bbb-… bun scripts/extract-fixtures.ts
 *
 * Output: { "<METHOD> <path template>": { screen, query, body }[] }, first variant = the default.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = process.env.MAILYARD_DESIGNS
if (!root) throw new Error("Set MAILYARD_DESIGNS to the OpenDesign project directory.")
const screens = path.join(root, "screens")

/** Screens whose fixtures win when several screens embed the same endpoint: the healthy, owner, 7d views. */
const PREFERRED = [/overview\/overview-7d\.html$/, /mail\/inbox\.html$/, /audience\/contacts\.html$/]

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : []
  })

type Variant = { screen: string; path: string; query: string; body: unknown }
const out: Record<string, Variant[]> = {}
const FIX = /<script type="application\/json" data-fixture="([^"]+)">([\s\S]*?)<\/script>/g
const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const files = walk(screens).sort((a, b) => {
  const rank = (f: string) => {
    const i = PREFERRED.findIndex((r) => r.test(f))
    return i === -1 ? PREFERRED.length : i
  }
  return rank(a) - rank(b) || a.localeCompare(b)
})

let blocks = 0
for (const file of files) {
  const html = readFileSync(file, "utf8")
  for (const m of html.matchAll(FIX)) {
    const label = decode(m[1] ?? "")
    // "GET /v1/stats/delivery?range=7d (built)" → method, path, query; markers and notes after a space are dropped.
    const head = label.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(\/\S+)/)
    if (!head) continue
    const [, method, target] = head
    const [p = "", query = ""] = (target ?? "").split("?")
    // Ids are prefixed (dom_…, con_…, drf_…): any such segment becomes {id}, and the raw path is kept so a
    // request for that exact entity gets its own fixture.
    const template = p
      .split("/")
      .map((seg) => (/^[a-z]{2,6}_[A-Za-z0-9_]+$/.test(seg) ? "{id}" : seg))
      .join("/")
    let body: unknown
    try {
      body = JSON.parse(decode(m[2] ?? "").trim())
    } catch {
      continue
    }
    const key = `${method} ${template}`
    const list = out[key] ?? []
    out[key] = list
    if (
      !list.some((v) => v.path === p && v.query === query && JSON.stringify(v.body) === JSON.stringify(body))
    ) {
      list.push({ screen: path.relative(screens, file), path: p, query, body })
      blocks++
    }
  }
}

const dest = path.join(import.meta.dirname, "..", "src", "fixtures", "fixtures.json")
writeFileSync(dest, `${JSON.stringify(out)}\n`)
console.log(
  `${Object.keys(out).length} endpoints, ${blocks} variants → ${path.relative(process.cwd(), dest)}`,
)

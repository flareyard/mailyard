import type { Manifest } from "./Manifest.ts"

/**
 * Checks that `cloudflare-app.json` and `wrangler.jsonc` agree: every binding's scope is required
 * (the mapping in the platform's docs/apps-contract.md), every queue consumer has a dead-letter
 * queue, and the config names its resources without identifying them. Plain TypeScript with no
 * dependencies, so both the CLI and the Worker tests can run it.
 */

type Named = { readonly binding?: string; readonly name?: string }
export type WranglerConfig = {
  readonly name?: string
  readonly d1_databases?: ReadonlyArray<
    Named & { readonly database_name?: string; readonly database_id?: string }
  >
  readonly r2_buckets?: ReadonlyArray<Named & { readonly bucket_name?: string }>
  readonly kv_namespaces?: ReadonlyArray<Named & { readonly id?: string }>
  readonly send_email?: ReadonlyArray<Named>
  readonly ai?: Named
  readonly vectorize?: ReadonlyArray<Named>
  readonly browser?: Named
  readonly queues?: {
    readonly producers?: ReadonlyArray<{ readonly binding: string; readonly queue: string }>
    readonly consumers?: ReadonlyArray<{ readonly queue: string; readonly dead_letter_queue?: string }>
  }
  readonly durable_objects?: {
    readonly bindings?: ReadonlyArray<{ readonly name: string; readonly class_name: string }>
  }
  readonly migrations?: ReadonlyArray<{
    readonly tag: string
    readonly new_sqlite_classes?: ReadonlyArray<string>
  }>
  readonly workflows?: ReadonlyArray<{
    readonly name: string
    readonly binding: string
    readonly class_name: string
  }>
  readonly vars?: Readonly<Record<string, unknown>>
  readonly account_id?: string
}

/** The scope each kind of binding needs, as the platform's release CLI checks it. */
const BINDING_SCOPES: ReadonlyArray<readonly [string, (c: WranglerConfig) => boolean]> = [
  ["workers-scripts.edit", () => true],
  ["d1.write", (c) => (c.d1_databases?.length ?? 0) > 0],
  ["workers-r2.write", (c) => (c.r2_buckets?.length ?? 0) > 0],
  ["workers-kv-storage.write", (c) => (c.kv_namespaces?.length ?? 0) > 0],
  ["queues.write", (c) => (c.queues?.producers?.length ?? 0) > 0 || (c.queues?.consumers?.length ?? 0) > 0],
  ["email-sending.write", (c) => (c.send_email?.length ?? 0) > 0],
  ["ai.write", (c) => c.ai !== undefined],
  ["vectorize.write", (c) => (c.vectorize?.length ?? 0) > 0],
  ["browser-rendering.write", (c) => c.browser !== undefined],
]

export const resourceProblems = (m: Manifest, config: WranglerConfig): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const required = new Set(m.scopes.required.map((s) => s.scope))
  const optional = new Set(m.scopes.optional.map((s) => s.scope))
  for (const [scope, needed] of BINDING_SCOPES) {
    if (!needed(config) || required.has(scope)) continue
    problems.push(
      optional.has(scope)
        ? `Scope ${scope} is optional, but a binding in wrangler.jsonc needs it on every deploy: move it to required.`
        : `A binding in wrangler.jsonc needs scope ${scope}; add it to scopes.required.`,
    )
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (!consumer.dead_letter_queue)
      problems.push(`Queue consumer ${consumer.queue} has no dead_letter_queue.`)
  }
  if (config.account_id)
    problems.push("wrangler.jsonc sets account_id; the platform deploys to whichever account installs.")
  for (const d of config.d1_databases ?? []) {
    if (d.database_id)
      problems.push(`D1 ${d.database_name ?? d.binding} has a database_id; name it, don't identify it.`)
  }
  for (const k of config.kv_namespaces ?? []) {
    if (k.id) problems.push(`KV ${k.binding} has an id; the platform names it <worker>-<binding>.`)
  }
  // Every Durable Object class needs a migration that creates it, or the upload is refused.
  const migrated = new Set((config.migrations ?? []).flatMap((x) => x.new_sqlite_classes ?? []))
  for (const d of config.durable_objects?.bindings ?? []) {
    if (!migrated.has(d.class_name))
      problems.push(`Durable Object ${d.class_name} has no migration creating it.`)
  }
  // A setting is a var the platform sets; one also named in wrangler.jsonc would be overwritten there.
  const secrets = new Set(m.secrets.map((s) => s.name))
  for (const s of m.settings ?? []) {
    if (config.vars && s.name in config.vars)
      problems.push(`Setting ${s.name} is also a var in wrangler.jsonc.`)
    if (secrets.has(s.name)) problems.push(`${s.name} is both a setting and a secret.`)
  }
  return problems
}

/** JSONC to JSON: drops `//` and block comments outside strings, and trailing commas. */
export const parseJsonc = (text: string): unknown => {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      i = i < 0 ? text.length : i + 2
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

#!/usr/bin/env bun
/**
 * `bun run deploy`: puts Mailyard into the Cloudflare account Wrangler is signed in to, with nothing
 * pasted (HAL-3587). Safe to run again: each step only does what's missing.
 *
 * 1. Builds the web app.
 * 2. Creates any queue wrangler.jsonc names that doesn't exist yet (and its dead-letter queue).
 * 3. Deploys the Worker; Wrangler provisions the D1 database and the R2 bucket by name.
 * 4. Applies the D1 migrations.
 * 5. Sets the internal signing secrets that aren't set yet, each a fresh random value piped straight
 *    to Wrangler: they're never printed, written to disk, or known to anyone.
 * 6. On a workspace nobody has claimed, prints a one-time claim link: the way in, instead of an
 *    admin key. `bun run claim-link` prints a new one (and voids the last).
 *
 * The Deploy to Cloudflare button runs this as the deploy command.
 */
import { parseJsonc } from "../tools/manifest/resources.ts"

const ROOT = new URL("..", import.meta.url).pathname
/** Secrets Mailyard signs and seals with. Generated when missing; never shown. */
const GENERATED = ["UNSUBSCRIBE_KEY", "WEBHOOK_SIGNING_KEY", "FILE_SIGNING_KEY"] as const

const step = (n: number, text: string) => console.log(`\n${n}. ${text}`)

const run = async (
  cmd: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly stdin?: string; readonly quiet?: boolean } = {},
) => {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? ROOT,
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (!options.quiet && code !== 0) process.stderr.write(err || out)
  return { code, out, err }
}

const wrangler = (args: ReadonlyArray<string>, options: Parameters<typeof run>[1] = {}) =>
  run(["bunx", "wrangler", ...args], options)

const random = (bytes = 32) => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let s = ""
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

type Config = {
  name: string
  vars?: Record<string, string>
  d1_databases?: Array<{ database_name: string }>
  queues?: {
    producers?: Array<{ queue: string }>
    consumers?: Array<{ queue: string; dead_letter_queue?: string }>
  }
}

const config = parseJsonc(await Bun.file(`${ROOT}/wrangler.jsonc`).text()) as Config
const database = config.d1_databases?.[0]?.database_name ?? "mailyard"

/** The D1 database's rows for a query, through Wrangler. */
const d1 = async (sql: string) => {
  const result = await wrangler(["d1", "execute", database, "--remote", "--json", "--command", sql], {
    quiet: true,
  })
  if (result.code !== 0) throw new Error(result.err || result.out)
  const parsed = JSON.parse(result.out) as Array<{ results?: Array<Record<string, unknown>> }>
  return parsed[0]?.results ?? []
}

/** Stores a fresh claim token's hash and returns the link, when the workspace is still unclaimed. */
const mintClaimLink = async (origin: string) => {
  const rows = await d1("select value from settings where key = 'workspace'")
  const workspace = rows[0]?.value ? (JSON.parse(String(rows[0].value)) as { claimedAt?: number }) : {}
  if (workspace.claimedAt !== undefined) return null
  const token = random(32)
  const value = JSON.stringify({ tokenHash: await sha256(token), createdAt: Date.now() })
  const now = Date.now()
  await d1(
    `insert into settings (key, value, updated_at) values ('claim', '${value}', ${now}) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  )
  return `${origin}/claim#token=${token}`
}

/** The deployment's address: MAILYARD_PUBLIC_ORIGIN when set, else the workers.dev URL Wrangler printed. */
const originFrom = (deployOutput: string) => {
  const configured = config.vars?.MAILYARD_PUBLIC_ORIGIN?.trim()
  if (configured) return configured.replace(/\/+$/, "")
  return deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0] ?? null
}

const claimOnly = process.argv.includes("--claim-link")

if (claimOnly) {
  const origin = process.argv.find((a) => a.startsWith("https://")) ?? config.vars?.MAILYARD_PUBLIC_ORIGIN
  if (!origin) {
    console.error("usage: bun run claim-link https://<your Mailyard's address>")
    process.exit(2)
  }
  const link = await mintClaimLink(origin.replace(/\/+$/, ""))
  console.log(
    link
      ? `\nClaim your Mailyard (works once; running this again replaces it):\n\n  ${link}\n`
      : "\nThis workspace is already claimed: sign in with an emailed link instead.\n",
  )
  process.exit(0)
}

step(1, "Building the web app")
if (!(await Bun.file(`${ROOT}/web/node_modules/.bin/vite`).exists())) {
  const installed = await run(["bun", "install", "--frozen-lockfile"], { cwd: `${ROOT}/web` })
  if (installed.code !== 0) process.exit(1)
}
if ((await run(["bun", "run", "build"], { cwd: `${ROOT}/web` })).code !== 0) process.exit(1)

step(2, "Queues")
const queues = new Set<string>()
for (const p of config.queues?.producers ?? []) queues.add(p.queue)
for (const c of config.queues?.consumers ?? []) {
  queues.add(c.queue)
  if (c.dead_letter_queue) queues.add(c.dead_letter_queue)
}
for (const queue of [...queues].sort()) {
  const made = await wrangler(["queues", "create", queue], { quiet: true })
  const text = `${made.out}\n${made.err}`
  if (made.code === 0) console.log(`   created ${queue}`)
  else if (/already (exists|taken)|11009/i.test(text)) console.log(`   ${queue} exists`)
  else {
    process.stderr.write(text)
    process.exit(1)
  }
}

step(3, "Deploying the Worker")
const deployed = await wrangler(["deploy"])
if (deployed.code !== 0) process.exit(1)
const origin = originFrom(deployed.out)
console.log(`   deployed ${config.name}${origin ? ` at ${origin}` : ""}`)

step(4, "Database migrations")
if ((await wrangler(["d1", "migrations", "apply", database, "--remote"])).code !== 0) process.exit(1)

step(5, "Signing secrets")
const listed = await wrangler(["secret", "list", "--format", "json"], { quiet: true })
const present = new Set(
  listed.code === 0 ? (JSON.parse(listed.out) as Array<{ name: string }>).map((s) => s.name) : [],
)
const missing = GENERATED.filter((name) => !present.has(name))
if (missing.length === 0) console.log("   all set")
else {
  const values = Object.fromEntries(missing.map((name) => [name, random(32)]))
  const put = await wrangler(["secret", "bulk"], { stdin: JSON.stringify(values), quiet: true })
  if (put.code !== 0) {
    console.error(`   couldn't set ${missing.join(", ")}: ${put.err.split("\n")[0]}`)
    process.exit(1)
  }
  console.log(`   generated ${missing.join(", ")}`)
}

step(6, "Claiming")
if (!origin) console.log("   Run `bun run claim-link https://<your address>` to get your claim link.")
else {
  try {
    const link = await mintClaimLink(origin)
    console.log(
      link
        ? `\n   Claim your Mailyard here. The link works once, and only this output shows it:\n\n   ${link}\n`
        : "   Already claimed: sign in with an emailed link.",
    )
  } catch (error) {
    console.log(
      `   Couldn't mint a claim link (${String(error).split("\n")[0]}). Run \`bun run claim-link ${origin}\`.`,
    )
  }
}

/**
 * The production smoke test (HAL-3468): proves each endpoint answers as designed, not just that it
 * exists. Driven by the API's own definition (`MailApi`):
 *
 * - every GET, plus the read-only POSTs in DRY_RUN_POSTS, is called with the admin key;
 * - path ids come from the matching list endpoint (the first item's `id`), left to right;
 * - each answer must be 200, decode with that endpoint's own success schema, and carry `x-request-id`.
 *
 * It never writes: anything but a GET or a listed dry run is refused before a request is made.
 *
 *   bun run smoke:prod [--base https://…] [--report path.json] [--designed contract.json]
 *
 * The key comes from MAILYARD_ADMIN_KEY in `.env` (or the environment) and is never printed.
 * `--designed` takes the design project's endpoint list (`[{ method, path }]` or `{ endpoints: […] }`)
 * and reports designed endpoints the API doesn't define.
 */
import { readFileSync, writeFileSync } from "node:fs"
import * as Exit from "effect/Exit"
import * as HttpApi from "effect/http-api/HttpApi"
import * as Schema from "effect/Schema"
import { MailApi } from "../../src/http/Api.ts"

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const BASE = (
  arg("base") ??
  process.env.MAILYARD_URL ??
  "https://mailyard-api.halleluyaholudele.workers.dev"
).replace(/\/$/, "")
const KEY =
  process.env.MAILYARD_ADMIN_KEY ??
  (() => {
    try {
      return /^MAILYARD_ADMIN_KEY=(.*)$/m.exec(readFileSync(".env", "utf8"))?.[1]?.trim()
    } catch {
      return undefined
    }
  })()
if (!KEY) {
  console.error("No MAILYARD_ADMIN_KEY in the environment or .env.")
  process.exit(2)
}

/** POSTs that read and change nothing: previews and counts. Each gets a fixed body. */
const DRY_RUN_POSTS: Readonly<Record<string, unknown>> = {
  "/v1/campaigns/:id/audience/preview": undefined,
  "/v1/segments/preview": { filter: { type: "all", rules: [] } },
}
/** Values for required query parameters the smoke test can't guess. */
const QUERY: Readonly<Record<string, Record<string, string>>> = {
  "/v1/usage/forecast": { recipients: "1000" },
  "/v1/search": { q: "mailyard" },
  "/v1/search/mail": { q: "mailyard" },
  "/v1/mailboxes/:id/search": { q: "mailyard" },
  "/v1/campaigns/:id/resend-non-openers": { countMachineOpensAsOpened: "false" },
}
/** Served outside the API on purpose: the live socket is a WebSocket upgrade OpenAPI can't describe. */
const RAW_ROUTES = new Set(["GET /v1/mailboxes/:p/live"])

/** Endpoints that don't answer JSON, or that a smoke test shouldn't hold open. */
const SKIP = new Set(["/v1/live"])

type Probe = { method: string; path: string; schema: Schema.Top | undefined; params: ReadonlyArray<string> }
const probes: Array<Probe> = []
HttpApi.reflect(MailApi, {
  onGroup: () => {},
  onEndpoint: ({ endpoint, successes }) => {
    const method = endpoint.method.toUpperCase()
    if (method !== "GET" && !(endpoint.path in DRY_RUN_POSTS)) return
    if (SKIP.has(endpoint.path)) return
    probes.push({
      method,
      path: endpoint.path,
      schema: successes.get(200)?.[0],
      params: [...endpoint.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string),
    })
  },
})

type Result = {
  method: string
  path: string
  url: string | null
  status: number | null
  ms: number | null
  ok: boolean
  skipped?: string
  problem?: string
}

const headers = { authorization: `Bearer ${KEY}`, accept: "application/json" }
const listCache = new Map<string, unknown>()

/** Calls a path with this module's guard: GETs and the listed dry runs only. */
const request = async (method: string, template: string, url: string) => {
  if (method !== "GET" && !(template in DRY_RUN_POSTS))
    throw new Error(`refused: ${method} ${template} writes`)
  const body = method === "GET" ? undefined : DRY_RUN_POSTS[template]
  return fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** The ids in the first array of objects in a JSON body: `id`, or the field a `:param` names (`:email`). */
const idsIn = (body: unknown, param: string): Array<string> => {
  if (!body || typeof body !== "object") return []
  const arrays = Array.isArray(body) ? [body] : Object.values(body).filter(Array.isArray)
  const key = param === "email" ? "email" : "id"
  for (const a of arrays) {
    const ids = (a as Array<unknown>)
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined))
      .filter((v): v is string => typeof v === "string")
    if (ids.length) return ids
  }
  return []
}

const list = async (path: string) => {
  let body = listCache.get(path)
  if (body === undefined) {
    const res = await request("GET", path, `${BASE}${path}`)
    body = res.ok ? await res.json().catch(() => null) : null
    listCache.set(path, body)
  }
  return body
}

/**
 * Where ids come from when the path above them isn't a list: a mailbox's messages are listed in its
 * threads; a test send is found by the audit entry that started it.
 */
const SOURCES_BY_SUFFIX: ReadonlyArray<readonly [RegExp, (filled: string) => Promise<Array<string>>]> = [
  [
    /^\/v1\/mailboxes\/[^/]+\/messages$/,
    async (filled) => {
      const mailbox = filled.slice(0, -"/messages".length)
      for (const threadId of idsIn(await list(`${mailbox}/threads`), "id").slice(0, BRANCH)) {
        const thread = (await list(`${mailbox}/threads/${encodeURIComponent(threadId)}`)) as {
          messages?: Array<{ id?: unknown }>
        } | null
        const ids = (thread?.messages ?? [])
          .map((m) => m.id)
          .filter((v): v is string => typeof v === "string")
        if (ids.length) return ids
      }
      return []
    },
  ],
  [
    /^\/v1\/test-send$/,
    async () => {
      const audit = (await list("/v1/audit?action=test_send.start&limit=5")) as {
        entries?: Array<{ target?: { id?: unknown } | null }>
      } | null
      return (audit?.entries ?? []).map((e) => e.target?.id).filter((v): v is string => typeof v === "string")
    },
  ],
]

/** How many of a list's items to try when the first one has nothing beneath it. */
const BRANCH = 8

/**
 * Fills `:params` left to right from list endpoints: `/v1/x/:id/y/:yid` lists `/v1/x`, then
 * `/v1/x/<id>/y`. When an item has nothing under it (a mailbox with no mail), the next is tried.
 */
const resolve = async (path: string): Promise<{ url: string } | { skipped: string }> => {
  const segments = path.split("/").slice(1)
  const walk = async (i: number, filled: string): Promise<string | null> => {
    if (i === segments.length) return filled
    const segment = segments[i] as string
    if (!segment.startsWith(":")) return walk(i + 1, `${filled}/${segment}`)
    const candidates = SOURCES_BY_SUFFIX.find(([pattern]) => pattern.test(filled))?.[1]
    const ids = candidates ? await candidates(filled) : idsIn(await list(filled), segment.slice(1))
    for (const id of ids.slice(0, BRANCH)) {
      const done = await walk(i + 1, `${filled}/${encodeURIComponent(id)}`)
      if (done) return done
    }
    return null
  }
  const filled = await walk(0, "")
  if (!filled) return { skipped: "nothing in production to fill its ids from (the lists it needs are empty)" }
  const query = QUERY[path]
  return { url: `${BASE}${filled}${query ? `?${new URLSearchParams(query)}` : ""}` }
}

const results: Array<Result> = []
for (const probe of probes.sort((a, b) => a.path.localeCompare(b.path))) {
  const target = await resolve(probe.path)
  if ("skipped" in target) {
    results.push({
      method: probe.method,
      path: probe.path,
      url: null,
      status: null,
      ms: null,
      ok: true,
      skipped: target.skipped,
    })
    continue
  }
  const started = performance.now()
  const res = await request(probe.method, probe.path, target.url)
  const ms = Math.round(performance.now() - started)
  const result: Result = {
    method: probe.method,
    path: probe.path,
    url: target.url.replace(BASE, ""),
    status: res.status,
    ms,
    ok: false,
  }
  const text = await res.text()
  if (res.status !== 200) result.problem = `status ${res.status}: ${text.slice(0, 200)}`
  else if (!res.headers.get("x-request-id")) result.problem = "no x-request-id header"
  else if ((res.headers.get("content-type") ?? "").includes("json") && probe.schema) {
    const decoded = Schema.decodeUnknownExit(
      Schema.toCodecJson(probe.schema as Schema.Codec<unknown, unknown>),
    )(JSON.parse(text))
    if (Exit.isFailure(decoded))
      result.problem = `doesn't match its schema: ${String(decoded.cause).slice(0, 400)}`
    else result.ok = true
  } else result.ok = true
  results.push(result)
}

// Designed endpoints the API doesn't define, when the design project's list is given.
const designedPath = arg("designed")
const missing: Array<string> = []
if (designedPath) {
  const raw = JSON.parse(readFileSync(designedPath, "utf8")) as unknown
  const list = (Array.isArray(raw) ? raw : ((raw as { endpoints?: unknown }).endpoints ?? [])) as Array<{
    method?: string
    path?: string
  }>
  const known = new Set<string>()
  HttpApi.reflect(MailApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) =>
      known.add(`${endpoint.method.toUpperCase()} ${endpoint.path.replace(/:[A-Za-z]+/g, ":p")}`),
  })
  for (const e of list) {
    const norm = `${(e.method ?? "GET").toUpperCase()} ${(e.path ?? "").replace(/\{[^}]+\}|:[A-Za-z]+/g, ":p")}`
    if (known.has(norm)) continue
    if (RAW_ROUTES.has(norm)) console.log(`raw route, outside the spec on purpose: ${norm}`)
    else missing.push(norm)
  }
}

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
const report = {
  base: BASE,
  at: new Date().toISOString(),
  checked: results.length - skipped.length,
  passed: results.length - skipped.length - failed.length,
  failed: failed.length,
  skipped: skipped.length,
  missingFromApi: missing,
  results,
}
const out = arg("report")
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
for (const f of failed) console.log(`FAIL ${f.method} ${f.path} → ${f.problem}`)
for (const s of skipped) console.log(`skip ${s.method} ${s.path}: ${s.skipped}`)
for (const m of missing) console.log(`designed but not in the API: ${m}`)
console.log(
  `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped of ${results.length} read endpoints against ${BASE}`,
)
process.exit(failed.length || missing.length ? 1 : 0)

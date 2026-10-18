/**
 * Fixture mode: the app runs on the designs' fixtures instead of the API, so every screen can be built and
 * audited without a backend. Those fixtures are the exact responses the design screens render, validated
 * against the live OpenAPI by the design repo's contract check.
 *
 * On with `VITE_FIXTURES=1` (bun run dev:fixtures) or `?fixtures=1`, which sticks for the tab. `?fixtures=0`
 * turns it off. Fixture mode never runs against a real session: requests never leave the page.
 */
import { findOverride } from "./overrides.ts"

type Variant = { screen: string; path: string; query: string; body: unknown }
type Table = Record<string, Variant[]>

/** Loaded on first use, so the 600 KB of fixtures never reach a session that isn't in fixture mode. */
let table: Promise<Table> | null = null
const load = () => {
  table ??= import("./fixtures.json").then((m) => m.default as Table)
  return table
}

const KEY = "mailyard-fixtures"

export function fixturesEnabled(): boolean {
  if (import.meta.env.VITE_FIXTURES === "1") return true
  if (typeof window === "undefined") return false
  const q = new URLSearchParams(window.location.search).get("fixtures")
  try {
    if (q === "1") sessionStorage.setItem(KEY, "1")
    if (q === "0") sessionStorage.removeItem(KEY)
    return sessionStorage.getItem(KEY) === "1"
  } catch {
    return q === "1"
  }
}

const ID = /^[a-z]{2,6}_[A-Za-z0-9_]+$/
const template = (path: string) =>
  path
    .split("/")
    .map((s) => (ID.test(s) ? "{id}" : s))
    .join("/")

const STATE_SCREEN = /(empty|error|loading|fail|offline|expired|revoked|denied|unreachable|limited|none|zero)/

/** Picks the variant for a request: same exact path first, then the query with the most matching pairs. */
/** A fixture key matching by shape: same method and segment count, literal segments equal, `{…}` matches any. */
function wildcardKey(t: Table, method: string, path: string): string | undefined {
  const want = path.split("/")
  return Object.keys(t).find((k) => {
    const [m, p = ""] = k.split(" ")
    const have = p.split("/")
    return (
      m === method && have.length === want.length && have.every((s, i) => s.startsWith("{") || s === want[i])
    )
  })
}

export function findFixture(t: Table, method: string, url: URL): Variant | undefined {
  const exact = `${method} ${template(url.pathname)}`
  const list = t[exact] ?? t[wildcardKey(t, method, url.pathname) ?? ""]
  if (!list?.length) return undefined
  const want = [...url.searchParams.entries()].filter(([k]) => k !== "fixtures")
  const score = (v: Variant) => {
    const have = new URLSearchParams(v.query)
    const q = want.reduce((n, [k, val]) => n + (have.get(k) === val ? 2 : have.has(k) ? 0 : -1), 0)
    // The healthy, populated view is the default; a design's empty, error or failing variants only answer when
    // nothing else does, so a list never comes back empty because its empty-state screen sorted first.
    const state = STATE_SCREEN.test(v.screen) ? -50 : 0
    return (v.path === url.pathname ? 100 : 0) + q + state
  }
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

/** A fetch that answers from the fixture table, shaped like the real API's responses. */
export async function fixtureFetch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // Routes whose design fixtures predate the live contract answer from hand-written, typed overrides first.
  const override = await findOverride(request)
  if (override) {
    await new Promise((r) => setTimeout(r, 120))
    return Response.json(override.body, {
      status: override.status,
      headers: { "x-fixture-screen": "override" },
    })
  }
  const hit = findFixture(await load(), request.method, url)
  await new Promise((r) => setTimeout(r, 120))
  if (!hit) {
    if (request.method !== "GET") return new Response(null, { status: 204 })
    return Response.json(
      {
        _tag: "NotFound",
        message: `No fixture for ${request.method} ${url.pathname} in fixture mode.`,
        requestId: "fixture",
      },
      { status: 404 },
    )
  }
  // Some design screens embed every entity of a detail endpoint as one array (the Overview's health strip
  // holds both domains under GET /v1/domains/{id}); answer with the one whose id was asked for.
  const last = url.pathname.split("/").pop()
  const body =
    Array.isArray(hit.body) && hit.body.every((x) => x && typeof x === "object" && "id" in x)
      ? (hit.body.find((x: { id: string }) => x.id === last) ?? hit.body[0])
      : hit.body
  return Response.json(body, { status: 200, headers: { "x-fixture-screen": hit.screen } })
}

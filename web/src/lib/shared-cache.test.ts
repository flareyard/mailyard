/**
 * The founder's crash, replayed (2026-10-21): "can't access property 'length', e.domains is undefined" and
 * "… e.state.data.imports is undefined" on the live app, after the first-run checklist had loaded. Screens
 * share one QueryClient; first-run cached the bare list under keys other screens read as the whole response.
 * Here the real query definitions run in the order the app ran them, against one cache.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

// openapi-fetch keeps the fetch it finds when the client is created, so the stub is in place before imports.
vi.hoisted(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    if (path === "/v1/domains") return Response.json({ domains: [{ id: "dom_1", name: "flareyard.dev" }] })
    if (path === "/v1/mailboxes/mbx_1/imports")
      return Response.json({ imports: [{ id: "imp_1", status: "running" }] })
    if (path === "/v1/topics")
      return Response.json({
        topics: [
          { id: "top_1", name: "News", archived: false },
          { id: "top_2", archived: true },
        ],
      })
    if (path === "/v1/identities")
      return Response.json({ identities: [{ id: "idn_1", address: "hi@flareyard.dev" }] })
    return Response.json({ error: "no stub" }, { status: 404 })
  }) as typeof fetch
})

const {
  domainsQuery: firstRunDomains,
  mailImportsQuery,
  topicsQuery,
} = await import("../first-run/queries.ts")
const { domainsQuery: overviewDomains } = await import("../overview/queries.ts")
const { domainsQuery: domainsPage } = await import("../domains/queries.ts")
const { domainsQuery: settingsDomains, identitiesQuery: settingsIdentities } = await import(
  "../settings/queries.ts"
)
const { identitiesQuery: kitIdentities } = await import("../audience/kit/queries.ts")
const { domainsQuery: transactionalDomains } = await import("../transactional/queries.ts")

/** What a mounted `useQuery(options)` would hand its component, `select` included. */
const read = async <T>(qc: QueryClient, options: object): Promise<T> => {
  // Subscribed, like a mounted component, so the observer applies `select` to what the cache holds.
  const observer = new QueryObserver(qc, options as never)
  const stop = observer.subscribe(() => {})
  // A screen's first render uses what's already cached; only an empty cache waits for the network.
  const key = (options as { queryKey: readonly unknown[] }).queryKey
  if (qc.getQueryData(key) === undefined) await qc.fetchQuery(options as never)
  const data = observer.getCurrentResult().data as T
  stop()
  return data
}

describe("one cache shared by every screen", () => {
  it("first-run, then Overview, Domains, Settings and Transactional read domains as { domains }", async () => {
    const qc = new QueryClient()
    expect(await read(qc, firstRunDomains)).toEqual([{ id: "dom_1", name: "flareyard.dev" }])
    for (const options of [overviewDomains, domainsPage, settingsDomains, transactionalDomains]) {
      const data = await read<{ domains: unknown[] }>(qc, options)
      expect(data.domains).toHaveLength(1)
    }
  })

  it("first-run's mail import step, then Mail's folder pane, read imports as { imports }", async () => {
    const qc = new QueryClient()
    expect(await read(qc, mailImportsQuery("mbx_1"))).toHaveLength(1)
    const cached = qc.getQueryData<{ imports: { status: string }[] }>(["mailboxes", "mbx_1", "imports"])
    expect(cached?.imports.some((i) => i.status === "running")).toBe(true)
  })

  it("first-run's topics hide archived ones without hiding them from everyone else", async () => {
    const qc = new QueryClient()
    expect(await read<unknown[]>(qc, topicsQuery)).toHaveLength(1)
    expect(qc.getQueryData<{ topics: unknown[] }>(["topics"])?.topics).toHaveLength(2)
  })

  it("Audience's identity list and Settings' identities share one cached response", async () => {
    const qc = new QueryClient()
    expect(await read<unknown[]>(qc, kitIdentities)).toHaveLength(1)
    expect((await read<{ identities: unknown[] }>(qc, settingsIdentities)).identities).toHaveLength(1)
  })
})

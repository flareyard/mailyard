// @vitest-environment jsdom
/**
 * The DMARC policy sheet: it previews with `dryRun=1` as it opens, shows the record before and after, writes
 * only on the explicit confirm, and keeps the preview beside a 409 no_dns_token so the record can be set by hand.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Reply = { status: number; body: unknown }
let reply: (method: string, url: URL, body: unknown) => Reply = () => ({ status: 404, body: {} })
const calls: { method: string; url: string; body: unknown }[] = []
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(req.url)
    const text = req.method === "GET" ? "" : await req.clone().text()
    const body = text ? JSON.parse(text) : null
    calls.push({ method: req.method, url: url.pathname + url.search, body })
    const r = reply(req.method, url, body)
    return Response.json(r.body, { status: r.status })
  }),
)

const { DmarcPolicySheet } = await import("./DmarcPolicySheet.tsx")

const before = "v=DMARC1; p=none; rua=mailto:dmarc@in.flareyard.dev"
const after = "v=DMARC1; p=quarantine; rua=mailto:dmarc@in.flareyard.dev"
const preview = { name: "_dmarc.coursified.app", before, after, applied: false, changed: true }

beforeEach(() => {
  calls.length = 0
})
afterEach(() => cleanup())
afterAll(() => vi.unstubAllGlobals())

const wait = (ms = 400) => act(async () => new Promise((r) => setTimeout(r, ms)))

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <DmarcPolicySheet
        domainId="dom_01"
        domainName="coursified.app"
        initial={{ p: "quarantine", pct: null }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return onClose
}

describe("DMARC policy change", () => {
  it("previews with a dry run, then writes only on confirm", async () => {
    reply = (_m, url) =>
      url.searchParams.get("dryRun") === "1"
        ? { status: 200, body: preview }
        : { status: 200, body: { ...preview, applied: true } }
    mount()
    await wait()
    expect(calls).toEqual([
      { method: "PATCH", url: "/v1/domains/dom_01/dmarc?dryRun=1", body: { p: "quarantine", pct: null } },
    ])
    expect(screen.getByText(before)).toBeTruthy()
    expect(screen.getByText(after)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Write the record/ }))
    await wait(50)
    expect(calls[1]).toEqual({
      method: "PATCH",
      url: "/v1/domains/dom_01/dmarc",
      body: { p: "quarantine", pct: null },
    })
    expect(screen.getByRole("heading", { name: "DMARC policy changed" })).toBeTruthy()
  })

  it("previews again when the choice changes, and never writes a preview that changes nothing", async () => {
    reply = (_m, _u, body) => {
      const p = (body as { p: string }).p
      return {
        status: 200,
        body: { ...preview, after: p === "none" ? before : after, changed: p !== "none" },
      }
    }
    mount()
    await wait()
    fireEvent.click(screen.getByRole("button", { name: "none" }))
    await wait()
    expect(calls.map((c) => c.url)).toEqual([
      "/v1/domains/dom_01/dmarc?dryRun=1",
      "/v1/domains/dom_01/dmarc?dryRun=1",
    ])
    const write = screen.getByRole("button", { name: /Write the record/ })
    expect(write.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(write)
    await wait(50)
    expect(calls).toHaveLength(2)
  })

  it("shows a 409 no_dns_token inline with the record to set by hand", async () => {
    reply = (_m, url) =>
      url.searchParams.get("dryRun") === "1"
        ? { status: 200, body: preview }
        : {
            status: 409,
            body: {
              _tag: "DmarcRefused",
              reason: "no_dns_token",
              message: "Mailyard has no CLOUDFLARE_DNS_TOKEN.",
            },
          }
    mount()
    await wait()
    fireEvent.click(screen.getByRole("button", { name: /Write the record/ }))
    await wait(50)
    expect(screen.getByRole("alert").textContent).toContain(
      "Mailyard can’t write DNS until a zone token is set.",
    )
    expect(screen.getAllByText(after).length).toBeGreaterThan(1)
    expect(screen.getByText("Set it by hand at your DNS provider")).toBeTruthy()
  })
})

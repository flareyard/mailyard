// @vitest-environment jsdom
/**
 * Settings behaviour in jsdom: the routing-conflict flow when creating a mailbox, the brand's contrast check
 * holding Save before the API would refuse it, and reordering rules from the keyboard.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#settings" className={className}>
      {children}
    </a>
  ),
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }),
  useNavigate: () => vi.fn(),
}))
vi.mock("../auth/capabilities.ts", () => ({
  useCapabilities: () => ({ ready: true, reachable: true, has: () => true }),
}))

type Handler = (req: Request, body: unknown) => Response | undefined
let handler: Handler = () => undefined
const calls: { method: string; path: string; body: unknown }[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const path = new URL(req.url).pathname
      const text = req.method === "GET" ? "" : await req.clone().text()
      const body = text ? JSON.parse(text) : null
      calls.push({ method: req.method, path, body })
      return (
        handler(req, body) ?? Response.json({ message: `unhandled ${req.method} ${path}` }, { status: 404 })
      )
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
const path = (req: Request) => `${req.method} ${new URL(req.url).pathname}`

describe("New mailbox", () => {
  it("shows Cloudflare's rule on 409 routing-rule-exists, then repoints it with replaceRoutingRule", async () => {
    handler = (req, body) => {
      const p = path(req)
      if (p === "GET /v1/domains")
        return Response.json({ domains: [{ id: "dom_01", name: "coursified.app", receiving: true }] })
      if (p === "GET /v1/mailboxes") return Response.json({ mailboxes: [] })
      if (p === "POST /v1/mailboxes") {
        const b = body as { replaceRoutingRule?: boolean; address: string; kind: string }
        if (!b.replaceRoutingRule)
          return Response.json(
            {
              _tag: "Conflict",
              message: "Cloudflare already routes admissions@coursified.app to tolu@gmail.com.",
              reason: "routing-rule-exists",
              ruleDestination: "tolu@gmail.com",
              ruleAction: "forward",
              ruleId: "a1b2c3d4e5f6478a",
            },
            { status: 409 },
          )
        return Response.json({ id: "mbx_new", address: b.address, kind: b.kind, routing: "replaced" })
      }
      return undefined
    }
    const { CreateMailbox } = await import("./mailboxes/CreateMailbox.tsx")
    wrap(<CreateMailbox onClose={() => {}} />)
    await screen.findByRole("option", { name: "coursified.app" })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "admissions" } })
    fireEvent.click(screen.getByRole("button", { name: /Create mailbox/ }))
    expect(await screen.findByRole("dialog", { name: "This address is already routed" })).toBeTruthy()
    expect(screen.getAllByText("tolu@gmail.com").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: /Point it at Mailyard instead/ }))
    expect(await screen.findByText("Cloudflare’s rule now points here.")).toBeTruthy()
    const posts = calls.filter((c) => c.method === "POST")
    expect(
      posts.map((c) => (c.body as { replaceRoutingRule?: boolean }).replaceRoutingRule ?? false),
    ).toEqual([false, true])
    expect((posts[1]?.body as { address?: string } | undefined)?.address).toBe("admissions@coursified.app")
  })

  it("refuses an address that isn't one before calling the API", async () => {
    handler = (req) => {
      const p = path(req)
      if (p === "GET /v1/domains")
        return Response.json({ domains: [{ id: "dom_01", name: "coursified.app", receiving: true }] })
      if (p === "GET /v1/mailboxes") return Response.json({ mailboxes: [] })
      return undefined
    }
    const { CreateMailbox } = await import("./mailboxes/CreateMailbox.tsx")
    wrap(<CreateMailbox onClose={() => {}} />)
    await screen.findByRole("option", { name: "coursified.app" })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "not an address" } })
    fireEvent.click(screen.getByRole("button", { name: /Create mailbox/ }))
    expect(await screen.findByText(/Use letters, numbers/)).toBeTruthy()
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })
})

describe("Brand", () => {
  it("holds Save while a contrast pair fails, and saves the merged colours once it passes", async () => {
    let saved: unknown = null
    handler = (req, body) => {
      const p = path(req)
      if (p === "GET /v1/settings/brand")
        return Response.json({
          name: "Coursified",
          siteUrl: "https://coursified.app",
          tagline: "Learn",
          colors: { indigo: "#C6F432" },
        })
      if (p === "GET /v1/settings/compliance")
        return Response.json({ postalAddress: null, linkAllowlist: [], seedAddresses: [] })
      if (p === "PUT /v1/settings/brand") {
        saved = body
        return Response.json(body)
      }
      return undefined
    }
    const { BrandPage } = await import("./brand/Brand.tsx")
    wrap(<BrandPage />)
    const accent = await screen.findByLabelText(/Accent \(buttons, links\)/)
    expect(screen.getAllByText(/White text on the accent is 1\.3:1; AA needs 4\.5:1/).length).toBeGreaterThan(
      0,
    )
    const save = screen.getByRole("button", { name: "Save brand" })
    expect(save.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(save)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
    fireEvent.change(accent, { target: { value: "#2E5BFF" } })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save brand" }).getAttribute("aria-disabled")).toBeNull(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }))
    await waitFor(() => expect(saved).not.toBeNull())
    expect((saved as { colors: Record<string, string> }).colors).toEqual({ indigo: "#2E5BFF" })
  })
})

describe("Rules", () => {
  it("moves a rule with Alt+ArrowDown on its grip and saves the new order", async () => {
    handler = (req) => {
      const p = path(req)
      if (p.startsWith("PUT /v1/mailboxes/mbx_support/rules/order")) return Response.json({ rules: [] })
      if (p.startsWith("GET ")) return Response.json({ labels: [], webhooks: [], members: [], people: [] })
      return undefined
    }
    const rule = (id: string, name: string) => ({
      id,
      name,
      enabled: true,
      match: "all" as const,
      conditions: [{ field: "subject" as const, op: "contains" as const, value: "x" }],
      actions: [{ type: "archive" as const }],
      stop: false,
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      matchCount: 0,
      lastMatchedAt: null,
    })
    const { RuleList } = await import("./rules/RulesPage.tsx")
    wrap(
      <RuleList
        mailboxId="mbx_support"
        rules={[rule("rul_a", "First"), rule("rul_b", "Second")]}
        openId={null}
        onEdit={() => {}}
        onApply={() => {}}
      />,
    )
    const grip = screen.getByRole("button", { name: /Move First/ })
    await act(async () => {
      fireEvent.keyDown(grip, { key: "ArrowDown", altKey: true })
    })
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true))
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ ruleIds: ["rul_b", "rul_a"] })
    expect(screen.getByRole("status").textContent).toBe("First moved to position 2 of 2.")
    const names = [...document.querySelectorAll(".rule-name")].map((n) => n.textContent)
    expect(names).toEqual(["Second", "First"])
  })
})

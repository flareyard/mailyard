// @vitest-environment jsdom
/**
 * The Domains sheets in jsdom: turning sending off waits for the exact name, Fix records shows each refusal
 * and each kind of action, Add a domain keeps receiving off for a zone whose mail goes elsewhere, and the
 * section locks for roles that can't open it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Domain } from "./logic.ts"

const navigate = vi.fn()
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className} href="/">
      {children}
    </a>
  ),
}))

type Reply = { status: number; body: unknown }
let reply: (method: string, path: string, body: unknown) => Reply = () => ({ status: 404, body: {} })
const calls: { method: string; path: string; body: unknown }[] = []
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    const text = req.method === "GET" ? "" : await req.clone().text()
    const body = text ? JSON.parse(text) : null
    calls.push({ method: req.method, path, body })
    const r = reply(req.method, path, body)
    return Response.json(r.body, { status: r.status })
  }),
)

const { DisableSendingSheet } = await import("./DisableSendingSheet.tsx")
const { FixSheet } = await import("./FixSheet.tsx")
const { AddDomainSheet } = await import("./AddDomainSheet.tsx")
const { DomainsGate } = await import("./DomainsGate.tsx")

const domain = {
  id: "dom_01",
  name: "coursified.app",
  zoneId: null,
  receiving: true,
  sending: true,
  catchAll: "bounce",
  mailboxCount: 3,
  lastCheckedAt: 1,
  checkStatus: "fail",
  zoneStatus: "active",
  createdAt: 1,
  updatedAt: 1,
  zoneName: "coursified.app",
  nameservers: null,
  currentNameservers: null,
  registrar: null,
  dnssec: null,
  complaints30d: null,
  returnPath: null,
  zoneCheckedAt: null,
  checks: [
    {
      id: "dmarc",
      purpose: "sending",
      name: "_dmarc.coursified.app",
      type: "TXT",
      expected: "v=DMARC1; p=none",
      actual: ["v=DMARC1; p=reject"],
      status: "fail",
      detail: "Different",
    },
  ],
  expectedRecords: [],
  mailboxes: [],
} satisfies Domain

beforeEach(() => {
  calls.length = 0
  navigate.mockReset()
})
afterEach(() => {
  cleanup()
})
afterAll(() => {
  vi.unstubAllGlobals()
})

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe("turning sending off", () => {
  it("stays off until the domain is typed exactly, then PATCHes sending: false", async () => {
    reply = () => ({ status: 200, body: { ...domain, sending: false } })
    const onClose = vi.fn()
    wrap(<DisableSendingSheet domain={domain} onClose={onClose} />)
    const go = screen.getByRole("button", { name: "Turn off sending" })
    expect(go.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(go)
    await flush()
    expect(calls).toHaveLength(0)
    fireEvent.change(screen.getByLabelText(/to turn sending off/), { target: { value: "coursified.ap" } })
    expect(go.getAttribute("aria-disabled")).toBe("true")
    fireEvent.change(screen.getByLabelText(/to turn sending off/), { target: { value: "coursified.app" } })
    expect(go.getAttribute("aria-disabled")).toBe("false")
    fireEvent.click(go)
    await flush()
    expect(calls).toEqual([{ method: "PATCH", path: "/v1/domains/dom_01", body: { sending: false } }])
    expect(onClose).toHaveBeenCalled()
  })
  it("closes on Escape without writing", async () => {
    reply = () => ({ status: 200, body: domain })
    const onClose = vi.fn()
    wrap(<DisableSendingSheet domain={domain} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe("fix records", () => {
  const refuse = (reason: string) => () => ({
    status: 409,
    body: { _tag: "FixRefused", reason, message: `refused: ${reason}` },
  })
  it.each([
    ["no_dns_token", "Fix records needs a zone token"],
    ["zone_not_found", "Zone not found"],
    ["nothing_to_fix", "Every record matches"],
  ])("explains a 409 %s", async (reason, title) => {
    reply = refuse(reason)
    wrap(<FixSheet domain={domain} onClose={() => {}} />)
    await flush()
    expect(screen.getByRole("heading", { name: title })).toBeTruthy()
    expect(calls.filter((c) => c.path === "/v1/domains/dom_01/fix")).toHaveLength(1)
  })
  it("lists done, failed and by-hand actions", async () => {
    reply = () => ({
      status: 200,
      body: {
        domain,
        actions: [
          { checks: ["mx", "spf"], action: "enable_routing", ok: true, detail: "Routing back on." },
          { checks: ["dmarc"], action: "manual", ok: false, detail: "Set it by hand." },
        ],
      },
    })
    wrap(<FixSheet domain={domain} onClose={() => {}} />)
    await flush()
    expect(screen.getByText("Turn Email Routing back on")).toBeTruthy()
    expect(screen.getByText("Set by hand: DMARC")).toBeTruthy()
    expect(screen.getByText("v=DMARC1; p=reject")).toBeTruthy()
    expect(screen.getByText("v=DMARC1; p=none")).toBeTruthy()
  })
})

describe("adding a domain", () => {
  it("defaults receiving off for a zone that already receives mail", async () => {
    reply = (method) =>
      method === "GET"
        ? {
            status: 200,
            body: {
              connected: true,
              candidates: [
                {
                  name: "hallelx.dev",
                  zoneId: "z1",
                  zoneStatus: "active",
                  nameservers: [],
                  registrar: null,
                  inWorkspace: false,
                  workspaceDomains: [],
                  existingMx: ["aspmx.l.google.com"],
                },
              ],
            },
          }
        : { status: 200, body: { ...domain, id: "dom_new", name: "hallelx.dev" } }
    wrap(<AddDomainSheet onClose={() => {}} />)
    await flush()
    fireEvent.click(screen.getByRole("radio"))
    const receiving = screen.getByLabelText("Receiving mail (routing)") as HTMLInputElement
    expect(receiving.checked).toBe(false)
    expect(screen.getByText(/already receives mail elsewhere/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Add domain/ }))
    await flush()
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "hallelx.dev",
      receiving: false,
      sending: true,
      zoneId: "z1",
    })
    expect(navigate).toHaveBeenCalledWith({ to: "/domains/$id", params: { id: "dom_new" } })
  })
  it("refuses a name that isn't a domain before any request", async () => {
    reply = () => ({ status: 200, body: { connected: false, candidates: [] } })
    wrap(<AddDomainSheet onClose={() => {}} />)
    await flush()
    fireEvent.change(screen.getByLabelText("Type your domain"), { target: { value: "not a domain" } })
    fireEvent.click(screen.getByRole("button", { name: /Add domain/ }))
    await flush()
    expect(screen.getByRole("alert").textContent).toMatch(/isn’t a domain name/)
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })
})

describe("the section gate", () => {
  const me = (role: string | null, scopes: string[]) => ({
    user: null,
    workspace: { id: "ws", name: "Coursified", logoUrl: null, url: "", host: "", claimed: true },
    role,
    via: role ? "session-member" : "session-key",
    key: null,
    scopes,
    permissions: [],
    mailboxes: null,
    workspaces: [],
    session: null,
  })
  it("locks Domains for a sender", async () => {
    reply = () => ({ status: 200, body: me("sender", []) })
    wrap(
      <DomainsGate>
        <p>inside</p>
      </DomainsGate>,
    )
    await flush()
    expect(screen.getByText("Domains isn’t part of the sender role")).toBeTruthy()
    expect(screen.queryByText("inside")).toBeNull()
  })
  it("opens for an admin key", async () => {
    reply = () => ({ status: 200, body: me(null, ["admin"]) })
    wrap(
      <DomainsGate>
        <p>inside</p>
      </DomainsGate>,
    )
    await flush()
    expect(screen.getByText("inside")).toBeTruthy()
  })
})

// @vitest-environment jsdom
/**
 * The key and webhook sheets in jsdom: a public key narrows to track and refuses mcp before any round trip,
 * the secret shows once after creation, revoking waits for the typed name, and replaying dead letters loops
 * while the API says some remain.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

type Call = { method: string; path: string; body: unknown }
const calls: Call[] = []
let handler: (c: Call) => Response = () => Response.json({})

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const text = req.method === "GET" ? "" : await req.clone().text()
      const c = { method: req.method, path: new URL(req.url).pathname, body: text ? JSON.parse(text) : null }
      calls.push(c)
      return handler(c)
    }),
  )
})
beforeEach(() => {
  calls.length = 0
})
afterEach(() => cleanup())

const wrap = (node: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const apiKey = {
  id: "key_new",
  name: "Signup form",
  kind: "public",
  purpose: "api",
  prefix: "pk_AbCdEf1",
  scopes: ["track"],
  createdBy: "Ada",
  lastUsedAt: null,
  revokedAt: null,
  createdAt: 1,
}

describe("CreateKeySheet", () => {
  it("narrows a public key to track, keeps mcp off, and shows the key once", async () => {
    handler = () => Response.json({ key: "pk_AbCdEf1secretsecret", apiKey })
    const { CreateKeySheet } = await import("./KeySheets.tsx")
    wrap(<CreateKeySheet onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Signup form" } })
    fireEvent.click(screen.getByRole("button", { name: "Public · pk_" }))
    const send = screen.getByRole("checkbox", { name: /Send/ }) as HTMLInputElement
    expect(send.disabled).toBe(true)
    expect(send.checked).toBe(false)
    expect((screen.getByRole("checkbox", { name: /Track/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole("button", { name: "mcp" }).getAttribute("aria-disabled")).toBe("true")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create key/ }))
    })
    await screen.findByText("Key created")
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Signup form",
      kind: "public",
      scopes: ["track"],
      purpose: "api",
    })
    expect(screen.getByText("pk_AbCdEf1secretsecret")).toBeTruthy()
    expect(screen.getByText("MAILYARD_KEY=pk_AbCdEf1secretsecret")).toBeTruthy()
  })

  it("names the missing name before calling the API", async () => {
    const { CreateKeySheet } = await import("./KeySheets.tsx")
    wrap(<CreateKeySheet onClose={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create key/ }))
    })
    expect(screen.getByRole("alert").textContent).toMatch(/Give the key a name/)
    expect(calls).toHaveLength(0)
  })
})

describe("RevokeSheet", () => {
  it("stays off until the key's name is typed exactly", async () => {
    handler = () => Response.json({ ...apiKey, revokedAt: 2 })
    const onClose = vi.fn()
    const { RevokeSheet } = await import("./KeySheets.tsx")
    const k = {
      ...apiKey,
      name: "Billing worker",
      kind: "secret" as const,
      purpose: "api" as const,
      requests24h: 94,
    }
    wrap(<RevokeSheet k={k} loading={false} onClose={onClose} />)
    const go = screen.getByRole("button", { name: "Revoke key" })
    expect(go.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(go)
    expect(calls).toHaveLength(0)
    fireEvent.change(screen.getByLabelText(/to revoke it/), { target: { value: "Billing worke" } })
    expect(go.getAttribute("aria-disabled")).toBe("true")
    fireEvent.change(screen.getByLabelText(/to revoke it/), { target: { value: "Billing worker" } })
    expect(go.getAttribute("aria-disabled")).toBe("false")
    await act(async () => {
      fireEvent.click(go)
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/v1/api-keys/key_new" })
  })
})

describe("ReplaySheet", () => {
  const hook = { id: "whk_1", url: "https://x.dev/h", description: null, events: ["*"], enabled: true }
  it("loops while dead letters remain, one call per 500", async () => {
    const answers = [
      { replayed: 500, remaining: 812 },
      { replayed: 500, remaining: 312 },
      { replayed: 312, remaining: 0 },
    ]
    handler = () => Response.json(answers.shift() ?? { replayed: 0, remaining: 0 })
    const { ReplaySheet } = await import("../webhooks/WebhookSheets.tsx")
    wrap(<ReplaySheet hook={{ ...hook, deadLetters: 1312 }} onClose={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay all 1,312/ }))
    })
    await screen.findByText("Dead letters replayed")
    expect(calls.filter((c) => c.path === "/v1/webhooks/whk_1/deliveries/replay")).toHaveLength(3)
    expect(calls[0]?.body).toEqual({ status: "dead" })
    expect(screen.getByText(/Replayed 1,312, 0 remaining/)).toBeTruthy()
  })

  it("replays a small backlog straight away and closes", async () => {
    handler = () => Response.json({ replayed: 3, remaining: 0 })
    const onClose = vi.fn()
    const { ReplaySheet } = await import("../webhooks/WebhookSheets.tsx")
    wrap(<ReplaySheet hook={{ ...hook, deadLetters: 3 }} onClose={onClose} />)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calls).toHaveLength(1)
  })
})

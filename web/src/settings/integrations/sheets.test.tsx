// @vitest-environment jsdom
/**
 * Behaviour that matters in the agent sheets: revoking is typed-confirmed (the button stays aria-disabled and
 * sends nothing until the key's name is typed), and the allowed-domains field turns typing into chips.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LimitsFields } from "./common.tsx"
import { RevokeKeySheet } from "./KeySheets.tsx"
import { DEFAULT_LIMITS, type Limits } from "./logic.ts"

// openapi-fetch keeps the fetch it finds when the client is created, so the stub is in place before imports.
const { calls } = vi.hoisted(() => {
  const calls: { method: string; path: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    calls.push({ method: req.method, path })
    if (req.method === "GET" && path === "/v1/api-keys")
      return Response.json({
        keys: [
          {
            id: "key_1",
            name: "Claude Code (Tolu)",
            kind: "secret",
            purpose: "mcp",
            prefix: "sk_Rm7cK2w",
            scopes: ["read"],
            createdBy: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: 1,
          },
        ],
      })
    return Response.json({ id: "key_1" })
  }) as typeof fetch
  return { calls }
})

beforeEach(() => {
  calls.length = 0
})
afterEach(() => {
  cleanup()
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  )

describe("revoke", () => {
  it("sends DELETE only after the name is typed exactly", async () => {
    const onClose = vi.fn()
    wrap(<RevokeKeySheet keyId="key_1" onClose={onClose} />)
    await screen.findByText(/Revoke “Claude Code \(Tolu\)”\?/)
    const go = screen.getByRole("button", { name: "Revoke key" })
    expect(go.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(go)
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "Claude Code (Tolu)" } })
    expect(go.getAttribute("aria-disabled")).toBe("false")
    fireEvent.click(go)
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: "/v1/api-keys/key_1" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

function Limited({ onValue }: { onValue: (l: Limits) => void }) {
  const [v, setV] = useState<Limits>({ ...DEFAULT_LIMITS, recipients: "domains" })
  return (
    <LimitsFields
      value={v}
      onChange={(l) => {
        setV(l)
        onValue(l)
      }}
      showErrors
      idPrefix="t"
    />
  )
}

describe("allowed domains", () => {
  it("adds chips on Enter, flags bad ones, and removes with Backspace", () => {
    let last: Limits = DEFAULT_LIMITS
    wrap(<Limited onValue={(l) => (last = l)} />)
    const input = screen.getByPlaceholderText("Add a domain")
    fireEvent.change(input, { target: { value: "Gmail.com, nope" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(last.allowDomains).toEqual(["gmail.com"])
    expect(screen.getByText("Not a domain: nope.")).toBeTruthy()
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.keyDown(input, { key: "Backspace" })
    expect(last.allowDomains).toEqual([])
    expect(screen.getByText(/Add at least one domain/)).toBeTruthy()
  })
})

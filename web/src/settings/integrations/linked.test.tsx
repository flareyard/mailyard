// @vitest-environment jsdom
/**
 * Linked apps (HAL-3466): with `keys.manage` the MCP keys are listed with their agents; without it the API
 * answers `keys: null`, and the card shows the counts and says why, with no key names anywhere.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#x">{children}</a>,
}))
vi.mock("../../auth/capabilities.ts", () => ({
  useCapabilities: () => ({ ready: true, reachable: true, has: () => false }),
}))

const { state } = vi.hoisted(() => {
  const state = { keys: true }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const key = {
      id: "key_1",
      name: "Hermes key",
      prefix: "sk_Hm4",
      scopes: ["read"],
      lastUsedAt: null,
      createdAt: 1,
      agent: { id: "agt_1", name: "Hermes", mailboxId: "mbx_1", address: "hermes@x.com" },
    }
    if (new URL(req.url).pathname === "/v1/integrations")
      return Response.json({
        mcp: {
          endpoint: "https://m.x/mcp",
          keyCount: 1,
          agentCount: 1,
          lastUsedAt: null,
          keys: state.keys ? [key] : null,
        },
        webhooks: {
          count: 1,
          enabled: 1,
          paused: 0,
          failing: 1,
          deadLetters: 2,
          held: 0,
          failingEndpoints: [
            { id: "whk_1", url: "https://h.x/a", deadLetters: 2, lastFailureAt: null, lastSuccessAt: null },
          ],
        },
        hermes: { connected: false, lane: null, mailboxes: [], since: null },
        siblings: [
          {
            app: "support-inbox",
            name: "Support Inbox",
            via: "mcp",
            connected: true,
            keyId: null,
            lastUsedAt: null,
          },
        ],
      })
    return Response.json({})
  }) as typeof fetch
  return { state }
})

import { LinkedApps } from "./LinkedApps.tsx"

afterEach(() => cleanup())
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LinkedApps />
    </QueryClientProvider>,
  )

describe("linked apps", () => {
  it("lists keys and their agents for key managers", async () => {
    state.keys = true
    mount()
    expect(await screen.findByText("Hermes key")).toBeTruthy()
    expect(screen.getByText("1 of 1 failing")).toBeTruthy()
    expect(screen.getByText("2 dead")).toBeTruthy()
    expect(screen.queryByText(/you see the counts/)).toBeNull()
  })
  it("shows counts only when keys is null", async () => {
    state.keys = false
    mount()
    expect(await screen.findByText(/you see the counts/)).toBeTruthy()
    expect(screen.queryByText("Hermes key")).toBeNull()
    expect(screen.getByText(/Its key shows to people who can manage keys/)).toBeTruthy()
    // The Hermes lane switch waits on HAL-3306 and stays disabled with its reason.
    expect(screen.getByRole("button", { name: "Turn the lane on" }).getAttribute("aria-disabled")).toBe(
      "true",
    )
  })
})

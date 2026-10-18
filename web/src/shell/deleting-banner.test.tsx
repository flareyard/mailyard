// @vitest-environment jsdom
/**
 * The workspace-deleting banner (HAL-3448): any API response carrying `x-workspace-deleting` raises it with the
 * countdown; the owner restores from it (POST /v1/workspace/restore) and it goes; anyone else sees Restore
 * disabled with the reason.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

const deletesAt = Date.now() + (6 * 1440 + 23 * 60 + 30) * 60_000
const iso = new Date(deletesAt).toISOString()
const calls: string[] = []
let deleting = true

const me = (role: "owner" | "admin") => ({
  user: { id: "usr_1", name: "Halleluyah", email: "h@coursified.app", timeZone: "UTC" },
  workspace: { id: "ws_1", name: "Coursified", logoUrl: null, url: "", host: "", claimed: true },
  role,
  via: "session-member",
  key: null,
  scopes: [],
  permissions: [],
  mailboxes: [],
  workspaces: [],
  session: null,
})

beforeEach(() => {
  calls.length = 0
  deleting = true
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (path === "/v1/workspace/restore") deleting = false
      const headers: Record<string, string> = deleting ? { "x-workspace-deleting": iso } : {}
      if (path === "/v1/workspace/restore") return Response.json({ restored: true }, { headers })
      if (path === "/v1/usage")
        return Response.json({ today: { source: "cloudflare", overQuota: false } }, { headers })
      return Response.json({ alerts: [], open: { total: 0 } }, { headers })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(role: "owner" | "admin") {
  const { api } = await import("../api/client.ts")
  const { Banners } = await import("./Banners.tsx")
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(["me"], me(role))
  render(
    <QueryClientProvider client={qc}>
      <Banners />
    </QueryClientProvider>,
  )
  // Any API response announces the deletion.
  await act(async () => {
    await api.GET("/v1/alerts")
  })
}

describe("workspace-deleting banner", () => {
  it("shows the countdown from the header, and the owner restores", async () => {
    await mount("owner")
    const banner = await screen.findByRole("alert")
    expect(banner.textContent).toContain("Coursified is being deleted in 6 days 23 hours")
    expect(banner.textContent).toContain("UTC")
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }))
    await waitFor(() => expect(calls).toContain("POST /v1/workspace/restore"))
    await waitFor(() => expect(screen.queryByText(/is being deleted/)).toBeNull())
  })

  it("keeps Restore visible but disabled, with the reason, for an admin", async () => {
    await mount("admin")
    await screen.findByText(/is being deleted/)
    const restore = screen.getByRole("button", { name: /Restore/ })
    expect(restore.getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("tooltip").textContent).toContain("Only the owner can restore the workspace")
    fireEvent.click(restore)
    expect(calls).not.toContain("POST /v1/workspace/restore")
  })
})

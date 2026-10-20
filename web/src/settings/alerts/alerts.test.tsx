// @vitest-environment jsdom
/**
 * Settings → Alerts in jsdom: the save bar names what's unsaved, and a 400 `{ field: "channels[1].target" }`
 * lands on row 2's target field (aria-invalid, described by the API's message), not on the page.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

// openapi-fetch keeps the fetch it finds when the client is created, so the stub is in place before imports.
const { calls } = vi.hoisted(() => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const settings = {
    channels: [
      { kind: "email", target: "ops@coursified.app", minSeverity: "warning" },
      { kind: "webhook", target: "whk_gone", minSeverity: "critical" },
    ],
    defaultEmail: null,
    effective: { criticalEmail: "owner@coursified.app", note: null },
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    const body = req.method === "GET" ? null : await req.clone().json()
    calls.push({ method: req.method, path, body })
    if (path === "/v1/me")
      return Response.json({
        via: "admin-key",
        role: null,
        scopes: ["admin"],
        permissions: [],
        key: null,
        user: null,
      })
    if (path === "/v1/webhooks")
      return Response.json({
        webhooks: [{ id: "whk_1", url: "https://hooks.x/alerts", description: "Ops hook", enabled: true }],
      })
    if (path === "/v1/settings/alerts" && req.method === "GET") return Response.json(settings)
    if (path === "/v1/settings/alerts")
      return Response.json(
        {
          _tag: "InvalidRequest",
          message: "No webhook endpoint whk_gone.",
          field: "channels[1].target",
          requestId: "r1",
        },
        { status: 400 },
      )
    return Response.json({})
  }) as typeof fetch
  return { calls }
})

import { AlertsPage } from "./AlertsPage.tsx"

afterEach(() => cleanup())

describe("alerts", () => {
  it("puts a refused target on its own row", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AlertsPage />
      </QueryClientProvider>,
    )
    await screen.findByText("Nothing to save.")
    fireEvent.change(screen.getAllByLabelText("Lowest severity")[0] as HTMLElement, {
      target: { value: "info" },
    })
    expect(screen.getByText("Unsaved: 1 channel changed.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save channels" }))
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true))
    const put = calls.find((c) => c.method === "PUT")?.body as
      | { channels: { minSeverity: string }[] }
      | undefined
    expect(put?.channels[0]?.minSeverity).toBe("info")
    const targets = await screen.findAllByLabelText("Webhook endpoint")
    const field = targets[0] as HTMLElement
    await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"))
    const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "")
    expect(hint?.textContent).toBe("No webhook endpoint whk_gone.")
    expect(screen.getByLabelText("Email address").getAttribute("aria-invalid")).toBeNull()
  })
})

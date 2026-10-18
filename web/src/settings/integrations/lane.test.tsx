// @vitest-environment jsdom
/**
 * The Hermes lane (HAL-3306): "all mailboxes" saves as null, a picked list as ids, and a 400 on `mailboxIds`
 * lands on the mailbox picker. Without a bound queue the switch is disabled with the reason.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { state } = vi.hoisted(() => {
  const state = { available: true, refuse: false, puts: [] as unknown[] }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    const lane = {
      enabled: false,
      mailboxIds: null,
      types: null,
      since: null,
      queue: "mailyard-mail-events",
      version: 1,
      available: state.available,
    }
    if (path === "/v1/me")
      return Response.json({
        via: "admin-key",
        role: null,
        scopes: ["admin"],
        permissions: [],
        key: null,
        user: null,
      })
    if (path === "/v1/mailboxes")
      return Response.json({
        mailboxes: [
          { id: "mbx_1", address: "support@x.com", holdsMail: true, kind: "shared", targetIds: [] },
        ],
      })
    if (path === "/v1/settings/mail-events" && req.method === "PUT") {
      const body = await req.clone().json()
      state.puts.push(body)
      if (state.refuse)
        return Response.json(
          { _tag: "InvalidRequest", message: "No mailbox mbx_1.", field: "mailboxIds", requestId: "r" },
          { status: 400 },
        )
      return Response.json({ ...lane, ...body, version: 2 })
    }
    if (path === "/v1/settings/mail-events") return Response.json(lane)
    return Response.json({})
  }) as typeof fetch
  return { state }
})

import { HermesLane } from "./HermesLane.tsx"

afterEach(() => cleanup())
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HermesLane />
    </QueryClientProvider>,
  )

describe("Hermes lane", () => {
  it("saves all as null and a picked list as ids, and shows a 400 on the picker", async () => {
    state.available = true
    state.refuse = false
    state.puts.length = 0
    mount()
    fireEvent.click(await screen.findByLabelText("Send mail events to Hermes"))
    fireEvent.click(screen.getByRole("button", { name: "Save lane" }))
    await waitFor(() => expect(state.puts).toEqual([{ enabled: true, mailboxIds: null, types: null }]))
    cleanup()

    state.refuse = true
    mount()
    fireEvent.click(await screen.findByLabelText("Send mail events to Hermes"))
    fireEvent.click(screen.getByRole("button", { name: "Pick mailboxes" }))
    fireEvent.click(await screen.findByLabelText("support@x.com"))
    fireEvent.click(screen.getByRole("button", { name: "Save lane" }))
    await waitFor(() =>
      expect(state.puts.at(-1)).toEqual({ enabled: true, mailboxIds: ["mbx_1"], types: null }),
    )
    expect(await screen.findByText("No mailbox mbx_1.")).toBeTruthy()
    expect(document.getElementById("lane-mbx-hint")?.className).toBe("field-error")
  })
  it("disables the switch with the reason when no queue is bound", async () => {
    state.available = false
    mount()
    const sw = await screen.findByText("Send mail events to Hermes")
    expect(sw.closest("label")?.getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText(/queue isn’t bound in this deploy/)).toBeTruthy()
  })
})

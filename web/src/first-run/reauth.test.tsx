// @vitest-environment jsdom
/**
 * The re-auth sheet end to end in jsdom: a 401 from any API call opens it over the page, the key is exchanged
 * with POST /v1/session, and it closes without navigating. The Gated pattern keeps a refused control focusable.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigate = vi.fn()
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))
vi.mock("../auth/capabilities.ts", () => ({
  useCapabilities: () => ({ ready: true, reachable: true, has: () => true }),
}))

const me = {
  user: null,
  workspace: { id: "ws_1", name: "Coursified", host: null },
  role: null,
  via: "session-key",
  key: { id: "key_1", name: "Dashboard", prefix: "sk_live" },
  scopes: ["read", "admin"],
  permissions: [],
  workspaces: [],
}

const calls: Array<{ method: string; path: string; body: string | null }> = []
let answer401 = true

beforeEach(() => {
  calls.length = 0
  answer401 = true
  navigate.mockReset()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const path = new URL(req.url).pathname
      calls.push({ method: req.method, path, body: req.method === "GET" ? null : await req.clone().text() })
      if (path === "/v1/session") return Response.json(me)
      if (answer401)
        return Response.json(
          {
            _tag: "Unauthorized",
            message: "Session ended",
            reason: "session-expired",
            requestId: "8d3f-LHR",
          },
          { status: 401 },
        )
      return Response.json({ domains: [] })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount() {
  const { ReauthSheet } = await import("../auth/ReauthSheet.tsx")
  const { api } = await import("../api/client.ts")
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <button type="button">Where I was</button>
      <ReauthSheet kept="Your draft to ada@x.com is saved on this device" />
    </QueryClientProvider>,
  )
  return { api, qc }
}

describe("ReauthSheet", () => {
  it("stays closed until a 401, then opens over the page with the reason", async () => {
    const { api } = await mount()
    expect(screen.queryByRole("dialog")).toBeNull()
    await act(async () => {
      await api.GET("/v1/domains").catch(() => {})
    })
    const dialog = screen.getByRole("dialog", { name: "Sign in again to keep going" })
    expect(dialog.textContent).toMatch(/Your session ended at \d\d:\d\d UTC\./)
    expect(dialog.textContent).toContain("Your draft to ada@x.com is saved on this device")
    expect(document.activeElement).toBe(screen.getByLabelText("Access key"))
    expect(navigate).not.toHaveBeenCalled()
  })

  it("checks the key's shape before a round trip", async () => {
    const { api } = await mount()
    await act(async () => {
      await api.GET("/v1/domains").catch(() => {})
    })
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "nope" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with key" }))
    })
    expect(screen.getByRole("alert").textContent).toMatch(/isn’t a key Mailyard recognises/)
    expect(screen.getByLabelText("Access key").getAttribute("aria-invalid")).toBe("true")
    expect(calls.some((c) => c.path === "/v1/session")).toBe(false)
  })

  it("signs in with the key and closes without leaving the page", async () => {
    const { api } = await mount()
    await act(async () => {
      await api.GET("/v1/domains").catch(() => {})
    })
    answer401 = false
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "sk_live_abcdefghijklmnop" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with key" }))
    })
    const post = calls.find((c) => c.path === "/v1/session")
    expect(post?.method).toBe("POST")
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ key: "sk_live_abcdefghijklmnop" })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).not.toBe("Access key")
  })

  it("offers signing out instead", async () => {
    const { api } = await mount()
    await act(async () => {
      await api.GET("/v1/domains").catch(() => {})
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out instead" }))
    })
    expect(navigate).toHaveBeenCalledWith({ to: "/signed-out" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("Gated", () => {
  it("keeps a refused control focusable, says why, and swallows the click", async () => {
    const { Gated } = await import("../auth/NoPermission.tsx")
    const onClick = vi.fn()
    render(
      <Gated
        allowed={false}
        reason="You can’t pause campaigns"
        who="Owners, admins and senders can pause a campaign."
      >
        <button type="button" onClick={onClick}>
          Pause
        </button>
      </Gated>,
    )
    const btn = screen.getByRole("button", { name: "Pause" })
    expect(btn.getAttribute("aria-disabled")).toBe("true")
    expect(btn.hasAttribute("disabled")).toBe(false)
    const tip = screen.getByRole("tooltip")
    expect(btn.getAttribute("aria-describedby")).toContain(tip.id)
    expect(tip.textContent).toBe("You can’t pause campaignsOwners, admins and senders can pause a campaign.")
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("renders the control untouched when allowed", async () => {
    const { Gated } = await import("../auth/NoPermission.tsx")
    const onClick = vi.fn()
    render(
      <Gated allowed reason="x">
        <button type="button" onClick={onClick}>
          Pause
        </button>
      </Gated>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("words who can from roles", async () => {
    const { whoCan, roleAllows } = await import("../auth/NoPermission.tsx")
    expect(whoCan(["owner", "admin", "sender"], "pause a campaign")).toBe(
      "Owners, admins and senders can pause a campaign.",
    )
    expect(whoCan(["owner"], "delete the workspace")).toBe("Owners can delete the workspace.")
    expect(roleAllows(me as never, ["owner", "admin"], "admin")).toBe(true)
    expect(roleAllows({ ...me, scopes: ["read"] } as never, ["owner", "admin"], "admin")).toBe(false)
    expect(roleAllows({ ...me, role: "viewer" } as never, ["owner", "admin"], "admin")).toBe(false)
    expect(roleAllows({ ...me, via: "admin-key", scopes: [] } as never, ["owner"], "admin")).toBe(true)
  })
})

// @vitest-environment jsdom
/**
 * The export sheet in jsdom: every chart starts picked, the range rewrites each path (volume by hour for 24h,
 * the 30-day charts clamped at 90d), unticking a chart drops it, and Download fetches exactly the picked files.
 * Also the CSV gate: a key without read is refused with its own name in the reason.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const downloads: string[] = []
vi.mock("../ops/download.ts", () => ({
  download: vi.fn(async (path: string) => {
    downloads.push(path)
    return new Headers()
  }),
}))

const { ExportSheet } = await import("./ExportSheet.tsx")
const { csvAccess } = await import("./shared.tsx")

beforeEach(() => {
  downloads.length = 0
})
afterEach(cleanup)

describe("ExportSheet", () => {
  it("lists all nine charts for the current range", () => {
    render(<ExportSheet initial="7d" onClose={() => {}} />)
    expect(screen.getAllByRole("checkbox")).toHaveLength(9)
    expect(screen.getByText("/v1/stats/volume.csv?range=7d&by=day")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Download 9 CSVs/ })).toBeTruthy()
  })

  it("rewrites the paths when the range changes", () => {
    render(<ExportSheet initial="7d" onClose={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "24h" }))
    expect(screen.getByText("/v1/stats/volume.csv?range=24h&by=hour")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "90d" }))
    expect(screen.getByText("/v1/stats/inbound.csv?range=90d")).toBeTruthy()
    expect(screen.getByText("/v1/stats/providers.csv?range=30d")).toBeTruthy()
    expect(screen.getByText(/Only inbound and audience go back 90 days/)).toBeTruthy()
  })

  it("downloads only the picked charts, then closes", async () => {
    const onClose = vi.fn()
    render(<ExportSheet initial="30d" onClose={onClose} />)
    const boxes = screen.getAllByRole("checkbox")
    for (const b of boxes.slice(2)) fireEvent.click(b)
    const go = screen.getByRole("button", { name: /Download 2 CSVs/ })
    await act(async () => {
      fireEvent.click(go)
    })
    expect(downloads).toEqual([
      "/v1/stats/volume.csv?range=30d&by=day",
      "/v1/stats/delivery.csv?range=30d&by=day",
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it("closes on Escape", () => {
    const onClose = vi.fn()
    render(<ExportSheet initial="7d" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })
})

describe("csvAccess", () => {
  const base = {
    user: null,
    workspace: { id: "ws", name: "C", logoUrl: null, url: "", host: "", claimed: true },
    via: "session-key" as const,
    permissions: [],
    mailboxes: null,
    workspaces: [],
    session: null,
  }
  it("refuses a key without read and names it", () => {
    const r = csvAccess({
      ...base,
      role: null,
      key: { id: "k", name: "Ops tablet", prefix: "sk_" },
      scopes: ["admin"],
    })
    expect(r.ok).toBe(false)
    expect(r.why).toContain("Ops tablet")
    expect(r.why).toContain("admin scope but not read")
  })
  it("allows a key with read, the admin key and any role", () => {
    expect(csvAccess({ ...base, role: null, key: null, scopes: ["read"] }).ok).toBe(true)
    expect(csvAccess({ ...base, via: "admin-key", role: null, key: null, scopes: [] }).ok).toBe(true)
    expect(csvAccess({ ...base, via: "session-member", role: "viewer", key: null, scopes: [] }).ok).toBe(true)
  })
})

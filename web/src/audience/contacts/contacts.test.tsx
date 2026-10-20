// @vitest-environment jsdom
/**
 * The contacts list's URL state in jsdom: chips remove only their own value, the status chip's multi-select
 * writes one comma list, the filter sheet writes `field=` and `event=` exactly as the API parses them, and a
 * bulk action over the whole view sends the filter, never ids.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/audience/contacts", searchStr: "" }),
}))

const posts: Array<{ path: string; body: unknown }> = []
beforeEach(() => {
  posts.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const path = new URL(req.url).pathname
      if (req.method === "POST") {
        posts.push({ path, body: await req.clone().json() })
        if (path === "/v1/contacts/bulk")
          return Response.json({ mode: "async", job: { id: "bulk_1", status: "queued" } })
      }
      if (path === "/v1/contacts")
        return Response.json({ contacts: [], total: 12, count: 0, nextCursor: null })
      return Response.json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  )

const names = {
  topic: (id: string) => id,
  segment: (id: string) => id,
  field: (k: string) => (k === "plan" ? "Plan" : k),
}

describe("ContactsToolbar", () => {
  it("removing a field chip keeps the other field and the status list", async () => {
    const { ContactsToolbar } = await import("./ContactsToolbar.tsx")
    const { chipsOf } = await import("./logic.ts")
    const go = vi.fn()
    const search = { status: "subscribed,unconfirmed", field: ["plan:eq:pro", "country:eq:NG"] }
    wrap(
      <ContactsToolbar
        search={search}
        go={go}
        chips={chipsOf(search, names)}
        invalid={new Set()}
        columns={[]}
        fields={[]}
        canExport
        exportWho=""
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Plan is pro" }))
    expect(go).toHaveBeenCalledWith({ status: "subscribed,unconfirmed", field: ["country:eq:NG"] })
  })

  it("the status chip's menu writes one comma list in the canonical order", async () => {
    const { ContactsToolbar } = await import("./ContactsToolbar.tsx")
    const { chipsOf } = await import("./logic.ts")
    const go = vi.fn()
    const search = { status: "unconfirmed" }
    wrap(
      <ContactsToolbar
        search={search}
        go={go}
        chips={chipsOf(search, names)}
        invalid={new Set()}
        columns={[]}
        fields={[]}
        canExport
        exportWho=""
      />,
    )
    const open = screen.getByRole("button", { expanded: false, name: /Status is/ })
    fireEvent.click(open)
    expect(open.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(screen.getByRole("checkbox", { name: "Subscribed" }))
    expect(go).toHaveBeenLastCalledWith({ status: "subscribed,unconfirmed" })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })
})

describe("FilterSheet", () => {
  it("writes field= and event= as the API parses them and closes the sheet", async () => {
    const { FilterSheet } = await import("./FilterSheet.tsx")
    const onApply = vi.fn()
    wrap(
      <FilterSheet
        search={{ status: "subscribed", sheet: "filter" }}
        fields={[{ key: "courses_completed", label: "Courses completed", type: "number" } as never]}
        segments={[]}
        topics={[]}
        onApply={onApply}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText("Field"), { target: { value: "courses_completed" } })
    fireEvent.change(screen.getByLabelText("Is"), { target: { value: "gte" } })
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "3" } })
    expect(screen.getByText("field=courses_completed:gte:3")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("They"), { target: { value: "didnt" } })
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "lesson_completed" } })
    fireEvent.change(screen.getByLabelText("In the last"), { target: { value: "30" } })
    expect(screen.getAllByText("event=!lesson_completed:30").some((el) => el.closest(".urlline"))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "subscribed",
        field: ["courses_completed:gte:3"],
        event: ["!lesson_completed:30"],
        sheet: undefined,
      }),
    )
  })

  it("holds Add filter while the days are out of range", async () => {
    const { FilterSheet } = await import("./FilterSheet.tsx")
    wrap(
      <FilterSheet search={{}} fields={[]} segments={[]} topics={[]} onApply={() => {}} onClose={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "x" } })
    fireEvent.change(screen.getByLabelText("In the last"), { target: { value: "9999" } })
    expect(screen.getByText("Days are 1 to 3650.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Add filter" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("BulkSheet", () => {
  it("over the whole view it sends the filter and opens the job", async () => {
    const { BulkSheet } = await import("./Bulk.tsx")
    const onDone = vi.fn()
    wrap(
      <BulkSheet
        kind="addTopic"
        target={{ kind: "filter", search: { status: "subscribed,unconfirmed", sort: "email" } }}
        count={4486}
        topics={[{ id: "top_live", name: "Live sessions", archived: false, doubleOptIn: false } as never]}
        search={{ status: "subscribed,unconfirmed" }}
        onDone={onDone}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/runs as a background job/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Add 4,486 contacts" }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ mode: "async", jobId: "bulk_1" }))
    expect(posts[0]).toEqual({
      path: "/v1/contacts/bulk",
      body: {
        filter: { status: "subscribed,unconfirmed" },
        action: { action: "addTopic", topicId: "top_live" },
      },
    })
  })
})

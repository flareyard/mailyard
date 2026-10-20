// @vitest-environment jsdom
/**
 * Audience → Imports in jsdom: a workbook is caught before anything uploads; a CSV is read in the browser,
 * mapped against the field registry with its bad cells marked, uploaded, and started with consent sent only
 * when it's ticked.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigate = vi.fn()
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/audience/imports", searchStr: "" }),
}))

const calls: Array<{ method: string; path: string; body: unknown }> = []
beforeEach(() => {
  calls.length = 0
  navigate.mockReset()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const path = new URL(req.url).pathname
      const body = req.method === "POST" && path !== "/v1/uploads" ? await req.clone().json() : null
      calls.push({ method: req.method, path, body })
      if (path === "/v1/me")
        return Response.json({
          role: null,
          via: "admin-key",
          scopes: ["admin"],
          permissions: [],
          workspace: { name: "Coursified" },
        })
      if (path === "/v1/contact-fields")
        return Response.json({ fields: [{ key: "courses", label: "Courses", type: "number" }] })
      if (path === "/v1/topics")
        return Response.json({
          topics: [{ id: "top_1", name: "Product updates", archived: false, doubleOptIn: false }],
        })
      if (path === "/v1/uploads")
        return Response.json({ id: "upl_1", filename: "a.csv", size: 10 }, { status: 201 })
      if (path === "/v1/imports/contacts") return Response.json({ id: "imp_1", status: "queued" })
      if (path === "/v1/imports") return Response.json({ imports: [], nextCursor: null })
      if (path === "/v1/contacts")
        return Response.json({ contacts: [], total: 0, count: 0, nextCursor: null })
      return Response.json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount() {
  const { meQuery } = await import("../../auth/session.ts")
  const { ImportsPage } = await import("./ImportsPage.tsx")
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(meQuery.queryKey, {
    role: null,
    via: "admin-key",
    scopes: ["admin"],
    permissions: [],
    workspace: { name: "Coursified" },
  } as never)
  render(
    <QueryClientProvider client={qc}>
      <ImportsPage />
    </QueryClientProvider>,
  )
}

const pick = (file: File) =>
  fireEvent.change(document.getElementById("import-file") as HTMLInputElement, { target: { files: [file] } })

describe("ImportsPage", () => {
  it("catches a workbook in the browser, so nothing uploads", async () => {
    await mount()
    pick(
      new File(["x"], "leads.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    )
    expect(await screen.findByText("Mailyard reads CSV only.")).toBeTruthy()
    expect(calls.some((c) => c.path === "/v1/uploads")).toBe(false)
  })

  it("maps, marks bad cells, uploads and starts with consent only when ticked", async () => {
    await mount()
    pick(
      new File(["Email Address,Courses\nada@x.com,4\nnot-an-email,lots\n"], "leads.csv", {
        type: "text/csv",
      }),
    )
    expect(await screen.findByText("Map columns")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("2 cells won’t import", { exact: false })).toBeTruthy())
    const map = screen.getByLabelText("Map Courses to") as HTMLSelectElement
    expect(map.value).toBe("fields.courses")
    await waitFor(() => expect(screen.getByText(/Uploaded/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    const start = calls.find((c) => c.path === "/v1/imports/contacts")
    expect(start?.body).toEqual({
      uploadId: "upl_1",
      mapping: { "Email Address": "email", Courses: "fields.courses" },
      topicIds: [],
      onConflict: "update",
      defaultStatus: "subscribed",
    })
  })

  it("sends the attestation and its statement when ticked", async () => {
    await mount()
    pick(new File(["email\nada@x.com\n"], "a.csv", { type: "text/csv" }))
    await screen.findByText("Map columns")
    // A refused control is wrapped by Gated; once it's allowed it's a fresh element, so query it again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start import" }).getAttribute("aria-disabled")).toBeNull(),
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /agreed to receive email from Coursified/ }))
    fireEvent.change(screen.getByLabelText(/How they agreed/), {
      target: { value: "Signed up on our site." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Start import" }))
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/imports/contacts")).toBe(true))
    expect(calls.find((c) => c.path === "/v1/imports/contacts")?.body).toMatchObject({
      consent: { attested: true, statement: "Signed up on our site." },
    })
  })
})

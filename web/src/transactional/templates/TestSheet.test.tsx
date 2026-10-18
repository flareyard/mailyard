// @vitest-environment jsdom
/**
 * Send a test in jsdom: the form refuses bad input before a round trip, posts exactly what the API takes
 * (`to`, `version`, `data`, `from`), and shows each recipient's result linked to its message.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: Record<string, string> }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search)}` : ""}`}>{children}</a>
  ),
}))

const t = {
  id: "tpl_reset",
  name: "password-reset",
  kind: "html" as const,
  publishedVersion: 5,
  latestVersion: 6,
  hasUnpublishedChanges: true,
  archived: false,
  updatedAt: 1,
  createdAt: 1,
  latest: {
    version: 6,
    subject: "Reset your password",
    source: "<p>{{name}}</p>",
    text: null,
    publishedAt: null,
    updatedAt: 1,
    updatedBy: "root",
    variables: { used: ["name"], required: ["name"] },
  },
  versions: [],
}

const posts: Array<{ path: string; body: unknown }> = []

// The API client keeps the fetch it was created with, so the stub is in place before it loads.
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const body = JSON.parse(await req.clone().text()) as { to: string[] }
    posts.push({ path: new URL(req.url).pathname, body })
    return Response.json({
      version: 6,
      sent: body.to.map((email, i) => ({ email, messageId: `msg_${i}`, status: i ? "rejected" : "sent" })),
    })
  }),
)
const { TestSheet } = await import("./TestSheet.tsx")

beforeEach(() => {
  posts.length = 0
})
afterEach(() => {
  cleanup()
})

function mount() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <TestSheet t={t} samples={{ name: "Ada" }} used={["name"]} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

describe("TestSheet", () => {
  it("prefills test data from the samples and refuses a bad address without calling the API", async () => {
    mount()
    expect((screen.getByLabelText(/Test data/) as HTMLTextAreaElement).value).toContain('"name": "Ada"')
    fireEvent.change(screen.getByLabelText("Recipient 1"), { target: { value: "not-an-address" } })
    fireEvent.click(screen.getByRole("button", { name: /Send 1 test/ }))
    expect(await screen.findByText("not-an-address isn’t an email address.")).toBeTruthy()
    expect(posts).toHaveLength(0)
  })

  it("adds recipients up to five, posts the body and shows each result", async () => {
    mount()
    fireEvent.change(screen.getByLabelText("Recipient 1"), { target: { value: "ada@x.com" } })
    fireEvent.click(screen.getByRole("button", { name: /Add a recipient/ }))
    fireEvent.change(screen.getByLabelText("Recipient 2"), { target: { value: "lola@x.com" } })
    fireEvent.click(screen.getByRole("radio", { name: /Published/ }))
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "Coursified <no-reply@x.app>" } })
    fireEvent.click(screen.getByRole("button", { name: /Send 2 tests/ }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      path: "/v1/templates/tpl_reset/test",
      body: {
        to: ["ada@x.com", "lola@x.com"],
        version: "published",
        data: { name: "Ada" },
        from: "Coursified <no-reply@x.app>",
      },
    })
    expect(await screen.findByText("Tests sent")).toBeTruthy()
    expect(screen.getByRole("link", { name: "msg_0" }).getAttribute("href")).toBe(
      "/transactional/messages?q=msg_0",
    )
    expect(screen.getByText("Rejected")).toBeTruthy()
  })

  it("closes on Escape", () => {
    const { onClose } = mount()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })
})

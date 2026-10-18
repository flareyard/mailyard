// @vitest-environment jsdom
/**
 * The campaign editor's saving and the resend sheet, in jsdom against a stubbed API: edits save on their own
 * with `ifMatch`, a stale 409 stops saving and keeps the edits (never retried over), reloading takes theirs;
 * the resend dry run is asked again when the machine-opens toggle flips, and a limited key's 409 is shown.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { push: vi.fn() } }),
  useLocation: () => ({ pathname: "/", searchStr: "" }),
  Link: ({ children }: { children: unknown }) => children,
}))

const me = {
  user: null,
  workspace: { id: "ws_1", name: "Coursified", host: "x" },
  role: null,
  via: "session-key",
  key: { id: "key_1", name: "Dashboard", prefix: "sk_live" },
  scopes: ["read", "send", "admin"],
  permissions: [],
  workspaces: [],
}

const campaign = {
  id: "cmp_1",
  name: "Data foundations",
  status: "draft",
  segmentId: null,
  topicId: "top_1",
  templateId: null,
  templateVersion: null,
  bodyHtml: null,
  bodyText: null,
  bodyBlocks: null,
  fromAddress: "news@x.co",
  replyTo: null,
  subject: "Enrolment is open",
  subjectB: null,
  preheader: null,
  ab: null,
  trackOpens: true,
  trackClicks: true,
  sendAt: null,
  audienceSize: null,
  pausedReason: null,
  pausedBy: null,
  heldUntil: null,
  heldBy: null,
  timezone: null,
  lastTest: null,
  exclude: null,
  updatedBy: "key_1",
  abWinner: null,
  startedAt: null,
  finishedAt: null,
  createdAt: 1,
  updatedAt: 1000,
}

type Call = { method: string; path: string; search: string; body: Record<string, unknown> | null }
const calls: Call[] = []
let patchAnswer: () => Response

beforeEach(() => {
  calls.length = 0
  patchAnswer = () => Response.json({ ...campaign, subject: "New subject", updatedAt: 2000 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      const text = req.method === "GET" ? "" : await req.clone().text()
      calls.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body: text ? JSON.parse(text) : null,
      })
      if (url.pathname === "/v1/me") return Response.json(me)
      if (url.pathname === "/v1/campaigns/cmp_1" && req.method === "PATCH") return patchAnswer()
      if (url.pathname === "/v1/campaigns/cmp_1")
        return Response.json({ ...campaign, subject: "Theirs", updatedAt: 3000 })
      if (url.pathname === "/v1/campaigns/cmp_1/resend-non-openers" && req.method === "GET") {
        const on = url.searchParams.get("countMachineOpensAsOpened") === "true"
        return Response.json({
          recipients: on ? 704 : 860,
          sendable: on ? 689 : 842,
          countMachineOpensAsOpened: on,
        })
      }
      if (url.pathname === "/v1/campaigns/cmp_1/resend-non-openers")
        return Response.json(
          {
            _tag: "Conflict",
            reason: "agent_limit",
            message: "Keys with send limits can't send campaigns; a person schedules those.",
            requestId: "req_9",
          },
          { status: 409 },
        )
      return Response.json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })

async function mountEditor() {
  const { CampaignEditorProvider, useCampaign, useEditor } = await import("./editor/EditorContext.tsx")
  // As the route does: the provider reads the campaign from the query cache, so a reload lands in it.
  function Host({ children }: { children: ReactNode }) {
    const q = useCampaign("cmp_1")
    return q.data ? <CampaignEditorProvider campaign={q.data}>{children}</CampaignEditorProvider> : null
  }
  function Probe() {
    const ed = useEditor()
    return (
      <div>
        <input
          aria-label="Subject"
          value={ed.draft.subject}
          onChange={(e) => ed.set({ subject: e.target.value })}
        />
        <span data-testid="state">{ed.state}</span>
        <span data-testid="conflict">{ed.conflict?.message ?? ""}</span>
        <button type="button" onClick={() => void ed.reloadTheirs()}>
          Reload
        </button>
      </div>
    )
  }
  const qc = client()
  qc.setQueryData(["campaigns", "cmp_1"], campaign)
  render(
    <QueryClientProvider client={qc}>
      <Host>
        <Probe />
      </Host>
    </QueryClientProvider>,
  )
  await screen.findByLabelText("Subject")
}

describe("saving a campaign", () => {
  it("saves on its own with ifMatch set to the version it loaded", async () => {
    await mountEditor()
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "New subject" } })
    expect(screen.getByTestId("state").textContent).toBe("dirty")
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("saved"), { timeout: 3000 })
    const patches = calls.filter((c) => c.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).toEqual({ subject: "New subject", ifMatch: 1000 })
  })

  it("stops on a stale 409, keeps the edits, never retries, and reloads theirs on request", async () => {
    patchAnswer = () =>
      Response.json(
        {
          _tag: "Conflict",
          reason: "stale",
          message: "Someone saved this campaign after you opened it.",
          updatedAt: 3000,
          updatedBy: "key_2",
        },
        { status: 409 },
      )
    await mountEditor()
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Mine" } })
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("conflict"), { timeout: 3000 })
    expect(screen.getByTestId("conflict").textContent).toBe(
      "Someone saved this campaign after you opened it.",
    )
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Mine")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600))
    })
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1)
    // Typing more doesn't send it over theirs either.
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Mine, again" } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600))
    })
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1)
    await act(async () => {
      fireEvent.click(screen.getByText("Reload"))
    })
    await waitFor(() => expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Theirs"))
    expect(screen.getByTestId("state").textContent).toBe("saved")
  }, 10_000)
})

describe("resend to non-openers", () => {
  it("asks the dry run again when the toggle flips, and shows a limited key's refusal", async () => {
    const { ResendSheet } = await import("./report/ResendSheet.tsx")
    render(
      <QueryClientProvider client={client()}>
        <ResendSheet campaign={{ ...campaign, status: "sent" } as never} report={null} onClose={() => {}} />
      </QueryClientProvider>,
    )
    await screen.findByText("842")
    expect(calls.some((c) => c.search === "?countMachineOpensAsOpened=false")).toBe(true)
    fireEvent.click(screen.getByLabelText(/Count machine-only opens as opened/))
    await screen.findByText("689")
    expect(calls.some((c) => c.method === "GET" && c.search === "?countMachineOpensAsOpened=true")).toBe(true)
    const create = await screen.findByRole("button", { name: "Create the draft for 689" })
    await act(async () => {
      fireEvent.click(create)
    })
    const post = calls.find((c) => c.method === "POST")
    expect(post?.body).toEqual({ countMachineOpensAsOpened: true })
    expect(await screen.findByText(/Keys with send limits can't send campaigns/)).toBeTruthy()
    expect(screen.getByText("409 agent_limit")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Create the draft for 689" }).getAttribute("aria-disabled"),
    ).toBe("true")
  })
})

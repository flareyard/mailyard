// @vitest-environment jsdom
/**
 * The composer in jsdom: the undo countdown and Undo, a held send waiting for approval, a blocked draft's
 * Send refused with its reason, and choosing a suggestion with the keyboard.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Draft } from "../types.ts"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))
vi.mock("../../auth/capabilities.ts", () => ({
  useCapabilities: () => ({ ready: true, reachable: true, has: () => false }),
}))
const api = vi.hoisted(() => ({
  getDraft: vi.fn(),
  saveDraft: vi.fn(),
  createDraft: vi.fn(),
  sendDraft: vi.fn(),
  cancelSend: vi.fn(),
  discardDraft: vi.fn(),
  uploadFile: vi.fn(),
}))
vi.mock("./api.ts", () => api)

const { Composer } = await import("./Composer.tsx")
const { RecipientRow } = await import("./Recipients.tsx")
const { MailToasts, resetToasts } = await import("../toasts.tsx")
const { mailKeys } = await import("../queries.ts")
const { resetCompose } = await import("./store.ts")

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "drf_1",
  threadId: null,
  inReplyTo: null,
  references: [],
  from: "support@coursified.app",
  to: [{ name: "Ada Okafor", address: "ada.okafor@gmail.com" }],
  cc: [],
  bcc: [],
  subject: "Your payment link",
  bodyText: "Hi Ada",
  bodyHtml: null,
  attachments: [],
  status: "draft",
  sendAt: null,
  replyMode: null,
  sourceMessageId: null,
  lastError: null,
  blockedReason: null,
  track: null,
  createdAt: 1,
  updatedAt: 2,
  ...over,
})

function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  qc.setQueryData(["identities"], {
    identities: [
      {
        address: "support@coursified.app",
        displayName: "Coursified support",
        mailboxId: "mbx_support",
        kind: "shared",
        via: "member",
        signature: { text: "Coursified support", html: null },
      },
    ],
    anyAddressOn: [],
  })
  qc.setQueryData(["mailboxes"], {
    mailboxes: [
      {
        id: "mbx_support",
        address: "support@coursified.app",
        domainId: "dom_01",
        kind: "shared",
        displayName: "Coursified support",
        holdsMail: true,
        targetIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  qc.setQueryData(["agents"], { agents: [] })
  qc.setQueryData(["reputation"], { levels: { bounce: "ok", complaint: "ok", spamRejection: "ok" } })
  return qc
}

function mount(node: ReactNode, qc = client()) {
  return render(
    <QueryClientProvider client={qc}>
      {node}
      <MailToasts />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  resetToasts()
  resetCompose()
  api.saveDraft.mockImplementation(async () => draft())
  api.cancelSend.mockImplementation(async () => draft())
})
afterEach(() => cleanup())

describe("Send with the 10 s undo window", () => {
  it("counts down in the toast, and Undo cancels the send", async () => {
    api.getDraft.mockResolvedValue(draft())
    const until = Date.now() + 10_000
    api.sendDraft.mockResolvedValue({
      draft: draft({ status: "scheduled" }),
      sendAt: until,
      undoUntil: until,
      approval: null,
    })
    mount(<Composer request={{ mailboxId: "mbx_support", mode: "new", draftId: "drf_1" }} variant="window" />)
    await screen.findByRole("button", { name: "Remove ada.okafor@gmail.com" })
    const send = screen.getByRole("button", { name: "Send" })
    await act(async () => fireEvent.click(send))
    await screen.findByText("Sending to ada.okafor@gmail.com")
    expect(api.sendDraft).toHaveBeenCalledWith(
      "mbx_support",
      "drf_1",
      { undoSeconds: 10, track: { opens: false, clicks: false } },
      expect.any(String),
    )
    expect(screen.getByText(/Sending in \d+ s/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })))
    await waitFor(() => expect(api.cancelSend).toHaveBeenCalledWith("mbx_support", "drf_1"))
    await screen.findByText("Send undone")
  })
})

describe("a held send (HAL-3460)", () => {
  it("says it's waiting for approval, with no countdown", async () => {
    api.getDraft.mockResolvedValue(draft())
    api.sendDraft.mockResolvedValue({
      draft: draft({ status: "scheduled" }),
      sendAt: null,
      undoUntil: null,
      approval: { id: "apr_1", status: "pending" },
    })
    mount(<Composer request={{ mailboxId: "mbx_support", mode: "new", draftId: "drf_1" }} variant="window" />)
    await screen.findByRole("button", { name: "Remove ada.okafor@gmail.com" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })))
    await screen.findByText("Waiting for approval")
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
  })
})

describe("a blocked draft", () => {
  it("keeps Send focusable but refused, labelled with the reason", async () => {
    api.getDraft.mockResolvedValue(draft({ blockedReason: "quota_exhausted" }))
    mount(<Composer request={{ mailboxId: "mbx_support", mode: "new", draftId: "drf_1" }} variant="window" />)
    const send = await screen.findByRole("button", { name: "Quota used" })
    expect(send.getAttribute("aria-disabled")).toBe("true")
    expect(
      screen.getAllByRole("tooltip").some((t) => /The daily quota is used/.test(t.textContent ?? "")),
    ).toBe(true)
    fireEvent.click(send)
    expect(api.sendDraft).not.toHaveBeenCalled()
  })

  it("names a 409 agent_limit from Send", async () => {
    const { ApiError } = await import("../../api/client.ts")
    api.getDraft.mockResolvedValue(draft())
    api.sendDraft.mockRejectedValue(
      new ApiError(409, {
        _tag: "Conflict",
        reason: "agent_limit",
        limit: 20,
        sentToday: 20,
        resetsAt: Date.now() + 3_600_000,
      }),
    )
    mount(<Composer request={{ mailboxId: "mbx_support", mode: "new", draftId: "drf_1" }} variant="window" />)
    await screen.findByRole("button", { name: "Remove ada.okafor@gmail.com" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })))
    await screen.findByText("This key’s send limit is reached.")
  })
})

describe("suggestions", () => {
  it("chooses with ↓ and ↵", async () => {
    const qc = client()
    qc.setQueryData(mailKeys.correspondents("mbx_support", "ad"), {
      correspondents: [
        { address: "ada.okafor@gmail.com", name: "Ada Okafor", received: 3, sent: 1, lastAt: Date.now() },
        { address: "adaeze.n@outlook.com", name: "Adaeze Nwankwo", received: 2, sent: 2, lastAt: Date.now() },
      ],
    })
    const onChange = vi.fn()
    mount(
      <RecipientRow
        label="To"
        kind="to"
        mailboxId="mbx_support"
        local="support@"
        value={[]}
        onChange={onChange}
      />,
      qc,
    )
    const input = screen.getByRole("combobox")
    fireEvent.change(input, { target: { value: "ad" } })
    await screen.findByRole("option", { name: /Adaeze Nwankwo/ })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByRole("option", { name: /Adaeze Nwankwo/ }).getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith([{ name: "Adaeze Nwankwo", address: "adaeze.n@outlook.com" }])
  })
})

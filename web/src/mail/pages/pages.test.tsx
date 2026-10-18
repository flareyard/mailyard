// @vitest-environment jsdom
/**
 * The mailbox pages where behaviour matters: reordering rules from the keyboard, making a rule from a message
 * (prefilled, tested, saved), and retrying a failed import, which asks for the password again.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The typed client keeps the fetch it was created with, so the stub goes in before any module loads.
const net = vi.hoisted(() => {
  const state: { handler: (req: Request) => Promise<Response> } = {
    handler: async () => new Response(null, { status: 404 }),
  }
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    state.handler(input instanceof Request ? input : new Request(String(input), init))
  return state
})

const navigate = vi.fn()
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...p }: { children: ReactNode }) => (
    <a href="#x" {...(p as object)}>
      {children}
    </a>
  ),
}))

const access = {
  read: true,
  write: true,
  manage: true,
  writeReason: "",
  writeWho: "",
  manageReason: "You can’t manage this mailbox",
  manageWho: "Owners and admins can.",
  mailboxAccess: null,
}
vi.mock("../context.tsx", () => ({
  useMail: () => ({
    mailboxId: "mbx_support",
    address: "support@coursified.app",
    local: "support@",
    labels: [
      { id: "lbl_billing", name: "billing", color: "blue", threads: 18, unreadThreads: 2, createdAt: 1 },
    ],
    labelById: new Map([["lbl_billing", { id: "lbl_billing", name: "billing", color: "blue" }]]),
    folders: undefined,
    access,
    openFolders: () => {},
  }),
}))

import { RULES } from "./fixtures.ts"
import { RetrySheet } from "./ImportPage.tsx"
import { RuleSheet } from "./RuleSheet.tsx"
import { RuleRows } from "./RulesPage.tsx"
import type { MailImport } from "./types.ts"

const calls: { method: string; path: string; body: unknown }[] = []
const message = {
  id: "msg_01_3",
  threadId: "thr_01",
  folder: "inbox",
  seen: true,
  starred: false,
  answered: false,
  labelIds: [],
  receivedAt: 1,
  envelopeFrom: "ada.okafor@gmail.com",
  envelopeTo: "support@coursified.app",
  via: "mailbox",
  tag: null,
  size: 1,
  messageId: null,
  inReplyTo: null,
  references: [],
  subject: "Payment didn’t go through",
  date: 1,
  from: { name: "Ada Okafor", address: "ada.okafor@gmail.com" },
  replyTo: [],
  to: [{ name: null, address: "support@coursified.app" }],
  cc: [],
  snippet: "It still fails",
  hasHtml: false,
  automated: false,
  listId: null,
  listUnsubscribe: null,
  auth: { source: "cloudflare", spf: "pass", dmarc: "pass", dkim: [], arc: null },
  attachments: [],
  spamScore: null,
  spamReasons: [],
  rulesMatched: [],
  body: { text: "It still fails at the last step.", html: null },
  rawUrl: "/v1/files/x",
  attachmentUrls: {},
  delivery: null,
}

beforeEach(() => {
  calls.length = 0
  navigate.mockReset()
  net.handler = async (req: Request) => {
    const path = new URL(req.url).pathname
    const body =
      req.method === "GET"
        ? null
        : await req
            .clone()
            .json()
            .catch(() => null)
    calls.push({ method: req.method, path, body })
    if (path.endsWith("/messages/msg_01_3")) return Response.json(message)
    if (path.endsWith("/rules/test"))
      return Response.json({
        matched: [{ id: "rul_01", name: "Billing questions" }],
        outcome: {
          matched: ["rul_01"],
          folder: null,
          labelIds: ["lbl_billing"],
          markRead: false,
          star: false,
          skipSpamCheck: false,
          forwards: [],
          autoReplies: [],
          webhooks: [],
          assignee: null,
          stoppedAt: null,
        },
        authScore: { score: 0.4, reasons: [] },
        filedWith: { folder: "inbox", spamScore: 0.4, spamReasons: [], rulesMatched: ["rul_01"] },
      })
    if (path.endsWith("/rules") && req.method === "GET") return Response.json(RULES)
    if (path.endsWith("/rules") && req.method === "POST")
      return Response.json({
        ...(body as object),
        id: "rul_new",
        position: 5,
        matchCount: 0,
        lastMatchedAt: null,
        createdAt: 1,
        updatedAt: 1,
      })
    if (path === "/v1/mailboxes/mbx_support")
      return Response.json({
        members: [{ apiKeyId: "key_01JA4B7M", name: "Kemi Bello", role: "member", revoked: false }],
        people: [],
      })
    if (path === "/v1/webhooks") return Response.json({ webhooks: [] })
    if (path.endsWith("/retry-failed"))
      return Response.json({ ...failed, id: "imp_retry", status: "running", retryOf: failed.id })
    return Response.json({}, { status: 404 })
  }
})
afterEach(() => {
  cleanup()
})

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  )

describe("rules reorder from the keyboard", () => {
  it("moves a rule with Alt ↓ and Alt ↑ on its grip, and nothing without Alt", () => {
    const onMove = vi.fn()
    wrap(
      <RuleRows
        rules={RULES.rules}
        onMove={onMove}
        onToggle={() => {}}
        onApply={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    const grip = screen.getByRole("button", { name: /Reorder Billing questions, position 1 of 5/ })
    fireEvent.keyDown(grip, { key: "ArrowDown", altKey: true })
    expect(onMove).toHaveBeenLastCalledWith(0, 1)
    fireEvent.keyDown(grip, { key: "ArrowUp", altKey: true })
    // Already first: there's nowhere up to go.
    expect(onMove).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole("button", { name: /Reorder Out-of-office replies/ }), {
      key: "ArrowUp",
      altKey: true,
    })
    expect(onMove).toHaveBeenLastCalledWith(4, 3)
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(onMove).toHaveBeenCalledTimes(2)
  })
  it("reads each rule in words with its match count", () => {
    wrap(
      <RuleRows
        rules={RULES.rules}
        onMove={() => {}}
        onToggle={() => {}}
        onApply={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(screen.getAllByText("subject contains").length).toBe(2)
    expect(screen.getByText("212 matches")).toBeTruthy()
    expect(screen.getByText("never matched")).toBeTruthy()
  })
})

describe("a rule from a message", () => {
  it("is filled in from the message, tested, and saved with POST …/rules", async () => {
    const onClose = vi.fn()
    wrap(<RuleSheet messageId="msg_01_3" onClose={onClose} />)
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement
    expect(name.value).toBe("Payment from Ada Okafor")
    expect(await screen.findByText(/^Matches “Payment didn’t go through”/)).toBeTruthy()
    // Saving without an action says what's missing and sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(await screen.findByText("Add at least one action.")).toBeTruthy()
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/rules"))).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: /Add action/ }))
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "lbl_billing" } })
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/mailboxes/mbx_support/rules")
    expect(post?.body).toMatchObject({
      name: "Payment from Ada Okafor",
      match: "all",
      conditions: [
        { field: "from", op: "equals", value: "ada.okafor@gmail.com" },
        { field: "subject", op: "contains", value: "payment" },
      ],
      actions: [{ type: "label", labelId: "lbl_billing" }],
    })
    expect(
      calls.some(
        (c) => c.path.endsWith("/rules/test") && (c.body as { messageId: string }).messageId === "msg_01_3",
      ),
    ).toBe(true)
  })
})

const failed: MailImport = {
  id: "imp_failed",
  source: "imap",
  mode: "full",
  host: "imap.gmail.com",
  port: 993,
  username: "support.coursified@gmail.com",
  status: "failed",
  error: "Connection reset",
  folders: [
    {
      name: "[Gmail]/Sent Mail",
      folder: "sent",
      label: null,
      uidValidity: 1,
      source: 2186,
      imported: 1688,
      duplicates: 0,
      failed: 17,
      skipped: 0,
      lastUid: 1,
      batches: 22,
      batchesDone: 17,
      lastError: "reset",
      retryable: 14,
    },
  ],
  totals: { source: 2186, imported: 1688, duplicates: 0, failed: 17, skipped: 0 },
  accountedFor: false,
  ratePerMinute: null,
  etaAt: null,
  startedAt: 1,
  pausedAt: null,
  catchupOf: null,
  since: null,
  retryOf: null,
  credentialsHeld: false,
  createdAt: 1,
  finishedAt: 2,
}

describe("retry failed", () => {
  it("asks for the password again and sends it only with the retry", async () => {
    wrap(<RetrySheet imp={failed} onClose={() => {}} />)
    expect(screen.getByText(/password was dropped when the import stopped/)).toBeTruthy()
    const go = screen.getByRole("button", { name: "Retry 14" }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "abcdabcdabcdabcd" } })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    const post = calls.find((c) => c.path.endsWith("/imports/imp_failed/retry-failed"))
    expect(post?.body).toEqual({ password: "abcdabcdabcdabcd" })
    expect(navigate.mock.calls[0]?.[0]).toMatchObject({ params: { importId: "imp_retry" } })
  })
})

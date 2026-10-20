// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useBulk } from "./actions.ts"
import { mailKeys } from "./queries.ts"
import { getToasts, resetToasts } from "./toasts.tsx"
import type { Thread, ThreadPage } from "./types.ts"

const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({
    id,
    subject: id,
    snippet: "",
    latestMessageId: `m_${id}`,
    messageCount: 1,
    unreadCount: 1,
    starred: false,
    hasAttachments: false,
    participants: [],
    folders: ["inbox"],
    labelIds: [],
    firstAt: 1,
    lastAt: 1,
    sortAt: 1,
    snoozedUntil: null,
    assignee: null,
    ...over,
  }) as Thread

// openapi-fetch takes `fetch` when the client is created, so the stub is in place before any import runs.
const net = vi.hoisted(() => {
  const state = { calls: [] as unknown[], respond: (_b: unknown) => new Response(null, { status: 204 }) }
  globalThis.fetch = (async (req: Request) => {
    const body = await req.clone().json()
    state.calls.push(body)
    return state.respond(body)
  }) as typeof fetch
  return state
})

function setup(respond: (body: unknown) => Response) {
  net.calls = []
  net.respond = respond
  const calls = net.calls
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = mailKeys.threads("mbx", {})
  qc.setQueryData(key, {
    pages: [{ threads: [thread("a"), thread("b")], total: 2, nextCursor: null } as ThreadPage],
    pageParams: [undefined],
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useBulk("mbx"), { wrapper })
  const rows = () => qc.getQueryData<{ pages: ThreadPage[] }>(key)?.pages[0]?.threads.map((t) => t.id)
  return { calls, run: result.current, rows }
}

beforeEach(() => resetToasts())

describe("useBulk", () => {
  it("moves rows first, sends one bulk call, and offers Undo that puts them back", async () => {
    const { calls, run, rows } = setup(() => Response.json({ updated: 1 }))
    await act(async () => {
      await run("archive", ["a"])
    })
    expect(rows()).toEqual(["b"])
    expect(calls[0]).toEqual({ threadIds: ["a"], action: "archive" })
    const t = getToasts()[0]
    expect(t?.title).toBe("Archived conversation")
    await act(async () => {
      t?.action?.onClick()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(calls[1]).toEqual({ threadIds: ["a"], action: "move", folder: "inbox" })
    expect(rows()?.sort()).toEqual(["a", "b"])
  })

  it("puts everything back and says why when the server refuses", async () => {
    const { run, rows } = setup(() =>
      Response.json(
        { _tag: "Forbidden", message: "You can only read this mailbox.", requestId: "req_1" },
        { status: 403 },
      ),
    )
    let ok = true
    await act(async () => {
      ok = await run("trash", ["a", "b"])
    })
    expect(ok).toBe(false)
    expect(rows()).toEqual(["a", "b"])
    expect(getToasts()[0]).toMatchObject({ title: "That didn’t go through", tone: "error" })
    expect(getToasts()[0]?.sub).toMatch(/403: You can only read this mailbox\. · req_1/)
  })
})

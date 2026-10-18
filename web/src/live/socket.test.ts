// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backoffCap, type LiveFrame, MailboxSocket } from "./socket.ts"

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(s: string) {
    this.sent.push(s)
  }
  close(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) })
  }
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", FakeSocket)
  vi.spyOn(Math, "random").mockReturnValue(0.999)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("backoffCap", () => {
  it("doubles from 1 s and stops at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffCap)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe("MailboxSocket", () => {
  it("connects over wss/ws to the mailbox's live path", () => {
    const s = new MailboxSocket("mbx_1", "https://mail.example.com")
    expect(FakeSocket.all[0]?.url).toBe("wss://mail.example.com/v1/mailboxes/mbx_1/live")
    s.close()
  })

  it("delivers frames and resumes from the last seq after a drop", () => {
    const s = new MailboxSocket("mbx_1", "http://localhost:5173")
    const got: LiveFrame[] = []
    s.onFrame((f) => got.push(f))
    const first = FakeSocket.all[0]
    first?.open()
    first?.frame({ type: "hello", seq: 7, counts: [] })
    first?.frame({ type: "message.added", seq: 9 })
    expect(got.map((f) => f.type)).toEqual(["hello", "message.added"])
    first?.close(1006)
    expect(s.status).toBe("reconnecting")
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all[1]?.url).toBe("ws://localhost:5173/v1/mailboxes/mbx_1/live?since=9")
    s.close()
  })

  it("backs off further on each failed attempt", () => {
    const s = new MailboxSocket("mbx_1", "http://x")
    FakeSocket.all[0]?.close(1006)
    // Full jitter: random() is pinned at 0.999, so attempt n waits 0.999 × its cap.
    vi.advanceTimersByTime(998)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(2)
    FakeSocket.all[1]?.close(1006)
    vi.advanceTimersByTime(1997)
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(3)
    s.close()
  })

  it("stops retrying on a policy refusal (1008), which another try with the same cookie can't fix", () => {
    const s = new MailboxSocket("mbx_1", "http://x")
    FakeSocket.all[0]?.close(1008)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(s.status).toBe("closed")
  })

  it("pings every 25 s while open and asks for counts on demand", () => {
    const s = new MailboxSocket("mbx_1", "http://x")
    const ws = FakeSocket.all[0]
    ws?.open()
    vi.advanceTimersByTime(25_000)
    s.requestCounts()
    expect(ws?.sent).toEqual(["ping", JSON.stringify({ type: "counts" })])
    s.close()
  })
})

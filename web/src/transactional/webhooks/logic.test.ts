import { describe, expect, it } from "vitest"
import {
  attemptTrail,
  type DeliveryLike,
  deliveryHeaders,
  EMPTY_FILTER,
  filterBody,
  filterSummary,
  groupEvents,
  replayAll,
  retryDelay,
  testableEvents,
  toFilter,
  toggleEvent,
  validateWebhookUrl,
  webhookHealth,
} from "./logic.ts"

const t0 = Date.UTC(2026, 9, 17, 14, 5)
const dlv = (over: Partial<DeliveryLike>): DeliveryLike => ({
  id: "dlv_1",
  eventId: "evt_1",
  eventType: "message.delivered",
  status: "dead",
  attempts: 8,
  lastStatusCode: 500,
  lastError: "Internal Server Error",
  lastDurationMs: 10_000,
  lastAttemptAt: t0 + 3_810_000,
  nextAttemptAt: null,
  createdAt: t0,
  payload: { id: "evt_JAF001" },
  ...over,
})

describe("schedule", () => {
  it("matches the backend's backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([30, 60, 120, 240, 480, 960, 1920])
    expect(retryDelay(20)).toBe(21600)
  })
})

describe("health", () => {
  it("reads disabled, failing, healthy and waiting", () => {
    const base = { enabled: true, lastSuccessAt: 10, lastFailureAt: null, deadLetters: 0 }
    expect(webhookHealth({ ...base, enabled: false })).toBe("disabled")
    expect(webhookHealth({ ...base, lastFailureAt: 20 })).toBe("failing")
    expect(webhookHealth(base)).toBe("healthy")
    expect(webhookHealth({ ...base, lastSuccessAt: null })).toBe("waiting")
  })
})

describe("events", () => {
  it("groups the API's list and keeps unknown ones", () => {
    const g = groupEvents([
      "message.sent",
      "email.opened",
      "contact.created",
      "mail.received",
      "approval.pending",
      "x.y",
    ])
    expect(g.map((x) => x.label)).toEqual([
      "Sending",
      "Engagement",
      "Contacts",
      "Events, campaigns and mail",
      "Agent approvals",
      "Other",
    ])
  })
  it("treats * as exclusive", () => {
    expect(toggleEvent(["message.sent"], "*")).toEqual(["*"])
    expect(toggleEvent(["*"], "message.sent")).toEqual(["message.sent"])
    expect(toggleEvent(["a", "b"], "a")).toEqual(["b"])
  })
  it("validates the URL", () => {
    expect(validateWebhookUrl("https://x.dev/h")).toBeNull()
    expect(validateWebhookUrl("http://x.dev/h")).toMatch(/HTTPS/)
    expect(validateWebhookUrl("nope")).toMatch(/isn’t a URL/)
    expect(validateWebhookUrl("")).toMatch(/Enter/)
  })
})

describe("attempt trail", () => {
  it("marks only the last attempt as exact", () => {
    const tr = attemptTrail(dlv({}))
    expect(tr).toHaveLength(8)
    expect(tr[0]).toMatchObject({ n: 1, at: t0, exact: false, outcome: "unknown" })
    expect(tr[1]?.at).toBe(t0 + 30_000)
    expect(tr[7]).toMatchObject({ n: 8, exact: true, outcome: "fail", title: "Attempt 8 · 500" })
  })
  it("adds the next attempt while retrying", () => {
    const tr = attemptTrail(dlv({ status: "retrying", attempts: 4, nextAttemptAt: t0 + 1e6 }))
    expect(tr.at(-1)).toMatchObject({ n: 5, outcome: "next", title: "Attempt 5 of 8" })
  })
  it("names a timeout", () => {
    const tr = attemptTrail(dlv({ attempts: 1, lastStatusCode: null, lastError: "Timed out after 10 s" }))
    expect(tr[0]?.title).toBe("Attempt 1 · timeout")
  })
  it("builds the headers from the payload id", () => {
    expect(deliveryHeaders(dlv({}))).toContain("webhook-id: evt_JAF001")
  })
})

describe("replay loop", () => {
  it("calls while remaining > 0", async () => {
    const answers = [
      { replayed: 500, remaining: 812 },
      { replayed: 500, remaining: 312 },
      { replayed: 312, remaining: 0 },
    ]
    const steps: number[] = []
    const r = await replayAll(
      async () => answers.shift() ?? { replayed: 0, remaining: 0 },
      (s) => steps.push(s.remaining),
    )
    expect(steps).toEqual([812, 312, 0])
    expect(r).toEqual({ replayed: 1312, remaining: 0, calls: 3, stopped: false })
  })
  it("stops after the call in flight", async () => {
    let stop = false
    const r = await replayAll(
      async () => ({ replayed: 500, remaining: 812 }),
      () => {
        stop = true
      },
      () => stop,
    )
    expect(r).toEqual({ replayed: 500, remaining: 812, calls: 1, stopped: true })
  })
  it("never spins when nothing replays", async () => {
    const r = await replayAll(
      async () => ({ replayed: 0, remaining: 5 }),
      () => {},
    )
    expect(r.calls).toBe(1)
  })
})

describe("filters", () => {
  it("round-trips the API's filter and clears when empty", () => {
    expect(toFilter(null)).toEqual(EMPTY_FILTER)
    const f = toFilter({ mailboxIds: ["mbx_1"], streams: ["transactional"] })
    expect(filterBody(f)).toEqual({ mailboxIds: ["mbx_1"], streams: ["transactional"] })
    expect(filterBody(EMPTY_FILTER)).toBeNull()
  })
  it("summarises with names", () => {
    expect(
      filterSummary({ mailboxIds: ["mbx_1"], streams: ["transactional"] }, { mailbox: () => "support@" }),
    ).toBe("support@ · transactional stream")
    expect(filterSummary(null)).toBeNull()
  })
  it("lists testable events", () => {
    expect(testableEvents(["*"], ["a", "b"])).toEqual(["a", "b"])
    expect(testableEvents(["a", "x"], ["a", "b"])).toEqual(["a"])
  })
  it("reads paused before failing", () => {
    expect(
      webhookHealth({ enabled: true, paused: true, lastSuccessAt: 1, lastFailureAt: 2, deadLetters: 0 }),
    ).toBe("paused")
  })
})

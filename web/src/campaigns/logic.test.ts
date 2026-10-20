import { describe, expect, it } from "vitest"
import { ApiError } from "../api/client.ts"
import { duplicateBlock, insertBlock, mapDocTexts, moveBlock, newBlock, removeBlock } from "./blocks.ts"
import {
  activitySummary,
  activityTitle,
  agentRefusal,
  audienceLine,
  campaignHref,
  checksSummary,
  errorTarget,
  fillActivity,
  fixHref,
  fixPermission,
  forecastBars,
  funnelRows,
  goesOutAsTyped,
  isEditable,
  isTimeZone,
  landingFor,
  linkPill,
  mergeFields,
  niceMax,
  parsePlaceholders,
  parseRecentDays,
  previewBuckets,
  readySentence,
  recipientsCsv,
  sendTimeLabel,
  sentPct,
  setFallback,
  staleRefusal,
  statusSub,
  unsavedChanges,
  utcToZoned,
  zonedToUtc,
} from "./logic.ts"

const NOW = Date.UTC(2026, 9, 17, 15, 0)

describe("where a campaign opens", () => {
  it("routes each status to its view", () => {
    expect(landingFor("draft")).toBe("content")
    expect(landingFor("scheduled")).toBe("schedule")
    expect(landingFor("sending")).toBe("sending")
    expect(landingFor("paused")).toBe("sending")
    expect(landingFor("sent")).toBe("report")
    expect(landingFor("cancelled")).toBe("report")
    expect(campaignHref("cmp_1", "sending")).toBe("/campaigns/cmp_1")
    expect(campaignHref("cmp_1", "draft")).toBe("/campaigns/cmp_1/content")
  })
  it("only lets a draft be edited, as the API does", () => {
    expect(isEditable("draft")).toBe(true)
    expect(isEditable("scheduled")).toBe(false)
  })
})

describe("the list row", () => {
  const base = {
    sendAt: null,
    startedAt: null,
    finishedAt: null,
    pausedBy: null,
    heldBy: null,
    heldUntil: null,
    audienceSize: 1240,
  }
  it("says when it sends or sent", () => {
    expect(sendTimeLabel({ ...base, status: "draft" }, NOW)).toBe("Not scheduled")
    expect(sendTimeLabel({ ...base, status: "scheduled", sendAt: Date.UTC(2026, 9, 20, 9) }, NOW)).toBe(
      "Tue 20 Oct, 09:00 UTC",
    )
    expect(sendTimeLabel({ ...base, status: "sending", startedAt: Date.UTC(2026, 9, 17, 9, 2) }, NOW)).toBe(
      "Started 09:02 UTC",
    )
    expect(sendTimeLabel({ ...base, status: "sent", finishedAt: Date.UTC(2026, 8, 30, 11, 14) }, NOW)).toBe(
      "30 Sep, 11:14 UTC",
    )
    expect(
      sendTimeLabel({ ...base, status: "cancelled", finishedAt: Date.UTC(2026, 8, 12, 8, 4) }, NOW),
    ).toBe("Cancelled 12 Sep, 08:04 UTC")
  })
  it("treats a hold as sending, not paused, and names a pause by its code", () => {
    const held = { ...base, status: "sending" as const, heldUntil: Date.UTC(2026, 9, 18), heldBy: "quota" }
    expect(statusSub(held)).toBe("Held until 00:00 UTC · daily quota")
    expect(statusSub({ ...held, heldBy: "warmup" })).toBe("Held until 00:00 UTC · warm-up cap")
    expect(statusSub({ ...base, status: "paused", pausedBy: "bounce_rate" })).toBe("bounce rate")
    expect(statusSub({ ...base, status: "sending" })).toBeNull()
  })
  it("draws progress against the audience", () => {
    expect(sentPct(862, 1240)).toBe(69.5)
    expect(sentPct(10, 0)).toBe(0)
    expect(sentPct(2000, 1000)).toBe(100)
  })
  it("names the audience", () => {
    expect(audienceLine({ segmentId: "s", topicId: "t" }, { segment: "Dormant", topic: "News" })).toBe(
      "Segment · Dormant",
    )
    expect(audienceLine({ segmentId: null, topicId: "t" }, { topic: "News" })).toBe("Topic · News")
  })
})

describe("placeholders and fallbacks", () => {
  it("reads values, fallbacks, helpers and what won't parse", () => {
    const p = parsePlaceholders(
      `Hi {{ first_name ?? "there" }}, {{#if plan}}{{ plan }}{{/if}} {{ city | "Lagos" }}`,
    )
    expect(p.map((x) => [x.key, x.fallback, x.helper, x.unparsed])).toEqual([
      ["first_name", "there", false, false],
      ["plan", null, true, false],
      ["plan", null, false, false],
      ["if", null, true, false],
      [`city | "Lagos"`, null, false, true],
    ])
    expect(parsePlaceholders("{{ name ?? 'you' }}")[0]?.fallback).toBe("you")
  })
  it("lists merge fields once, knowing which exist", () => {
    const f = mergeFields(
      ["{{ first_name }} {{ first_nme }}", '{{ first_name ?? "there" }} {{ view_url }}'],
      ["first_name"],
    )
    expect(f).toEqual([
      { key: "first_name", fallback: "there", count: 2, known: true },
      { key: "first_nme", fallback: null, count: 1, known: false },
      { key: "view_url", fallback: null, count: 1, known: true },
    ])
    expect(mergeFields(["{{ plan }}"], null)[0]?.known).toBeNull()
  })
  it("finds what would go out as typed", () => {
    expect(goesOutAsTyped(['{{ first_nme }} {{ city | "Lagos" }} {{ first_name }}'], ["first_name"])).toEqual(
      ["{{ first_nme }}", '{{ city | "Lagos" }}'],
    )
  })
  it("writes a fallback into every use, and removes it when empty", () => {
    expect(setFallback("Hi {{ first_name }}, bye {{first_name ?? 'x'}}", "first_name", "there")).toBe(
      'Hi {{ first_name ?? "there" }}, bye {{ first_name ?? "there" }}',
    )
    expect(setFallback('{{ a ?? "b" }}', "a", "")).toBe("{{ a }}")
    expect(setFallback("{{ a }}", "a", 'say "hi"')).toBe(`{{ a ?? 'say "hi"' }}`)
    expect(setFallback("{{ b }}", "a", "x")).toBe("{{ b }}")
  })
})

describe("which string a 400 names", () => {
  it("maps the API's field path to what the editor marks", () => {
    expect(errorTarget("bodyBlocks.blocks[4].text")).toEqual({
      kind: "block",
      index: 4,
      path: "bodyBlocks.blocks[4].text",
    })
    expect(errorTarget("bodyBlocks.footer.reason")).toEqual({
      kind: "footer",
      path: "bodyBlocks.footer.reason",
    })
    expect(errorTarget("bodyBlocks")).toEqual({ kind: "blocks", path: "bodyBlocks" })
    expect(errorTarget("subject")).toEqual({ kind: "field", field: "subject", path: "subject" })
    expect(errorTarget("exclude.recentlySentDays")).toEqual({
      kind: "field",
      field: "exclude",
      path: "exclude.recentlySentDays",
    })
    expect(errorTarget(null)).toBeNull()
  })
})

describe("checks", () => {
  it("routes each fix by its target", () => {
    expect(fixHref("cmp_1", { label: "x", target: "content", field: "subject" })).toBe(
      "/campaigns/cmp_1/content?focus=subject",
    )
    expect(fixHref("cmp_1", { label: "x", target: "audience" })).toBe("/campaigns/cmp_1/audience")
    expect(fixHref("cmp_1", { label: "x", target: "settings.compliance", field: "postalAddress" })).toBe(
      "/settings/tracking?field=postalAddress",
    )
    expect(fixHref("cmp_1", { label: "x", target: "domains", domainId: "dom_02" })).toBe("/domains/dom_02")
    expect(fixHref("cmp_1", { label: "x", target: "domains" })).toBe("/domains?add=1")
    expect(fixPermission({ label: "x", target: "domains" })).toBe("domains.manage")
    expect(fixPermission({ label: "x", target: "settings.compliance" })).toBe("settings.write")
    expect(fixPermission({ label: "x", target: "content" })).toBe("campaigns.write")
  })
  it("says ready or blocked in the design's words", () => {
    const s = checksSummary([{ status: "pass" }, { status: "warn" }, { status: "warn" }, { status: "pass" }])
    expect(s).toEqual({ pass: 2, warn: 2, fail: 0, ready: true })
    expect(readySentence(s).title).toBe("Ready to send")
    expect(readySentence(s).sub).toMatch(/^2 checks pass and 2 are worth a look/)
    expect(readySentence({ pass: 9, warn: 1, fail: 3 }).title).toBe("Can’t send yet: 3 checks fail")
    expect(readySentence({ pass: 9, warn: 0, fail: 1 }).title).toBe("Can’t send yet: 1 check fails")
  })
})

describe("who gets it", () => {
  const p = {
    matching: 3860,
    sendable: 3400,
    excluded: {
      blocked: 61,
      unsubscribed: 88,
      unconfirmed: 63,
      notOnTopic: 0,
      bySegment: [
        { segmentId: "seg_7", name: "Team plan admins", count: 140 },
        { segmentId: "seg_5", name: "Dormant 90 days", count: 12 },
      ],
      recentlySent: 96,
    },
  }
  it("keeps the API's order and adds up to the match", () => {
    const b = previewBuckets(p, { topicName: "New courses", recentlySentDays: 3 })
    expect(b.buckets.map((x) => x.label)).toEqual([
      "Suppressed or blocked",
      "Unsubscribed",
      "Not yet confirmed (double opt-in)",
      "Not on New courses",
      "In Team plan admins",
      "In Dormant 90 days",
      "Mailed by another campaign in the last 3 days",
    ])
    expect(b.leftOut).toBe(460)
    expect(b.addsUp).toBe(true)
  })
  it("leaves the recently-sent row out when it isn't set", () => {
    const b = previewBuckets({ ...p, excluded: { ...p.excluded, recentlySent: 0, bySegment: [] } }, {})
    expect(b.buckets.some((x) => x.key === "recentlySent")).toBe(false)
  })
  it("checks recently-sent days as the API does", () => {
    expect(parseRecentDays("")).toEqual({ value: null })
    expect(parseRecentDays("3")).toEqual({ value: 3 })
    expect(parseRecentDays("0")).toHaveProperty("error")
    expect(parseRecentDays("91")).toHaveProperty("error")
    expect(parseRecentDays("2.5")).toHaveProperty("error")
  })
})

describe("time zones", () => {
  it("knows an IANA name", () => {
    expect(isTimeZone("Africa/Lagos")).toBe(true)
    expect(isTimeZone("Lagos")).toBe(false)
    expect(isTimeZone("")).toBe(false)
  })
  it("turns a wall clock in a zone into UTC and back", () => {
    expect(zonedToUtc("2026-10-20", "10:00", "Africa/Lagos")).toBe(Date.UTC(2026, 9, 20, 9))
    expect(utcToZoned(Date.UTC(2026, 9, 20, 9), "Africa/Lagos")).toEqual({
      date: "2026-10-20",
      time: "10:00",
    })
    // Across a DST change: 01:30 in New York on 2 Nov 2026 is after the switch back (EST, UTC−5).
    expect(zonedToUtc("2026-11-02", "01:30", "America/New_York")).toBe(Date.UTC(2026, 10, 2, 6, 30))
    expect(zonedToUtc("2026-10-20", "10:00", "Mars/Olympus")).toBeNull()
  })
})

describe("forecast", () => {
  it("stacks queued, this campaign and free inside each day's bulk share", () => {
    const bars = forecastBars([
      { day: "2026-10-17", available: 438, queued: 438, thisCampaign: 0 },
      { day: "2026-10-20", available: 850, queued: 0, thisCampaign: 850 },
      { day: "2026-10-18", available: 850, queued: 110, thisCampaign: 0 },
    ])
    expect(bars[0]).toMatchObject({ label: "Sat 17", queued: 438, mine: 0, free: 0, heightPct: 52 })
    expect(bars[1]).toMatchObject({ label: "Tue 20", mine: 850, free: 0, heightPct: 100 })
    expect(bars[2]).toMatchObject({ queued: 110, free: 740 })
    expect(bars[2]?.aria).toBe("Sun 18: 850 available, 110 queued ahead, 0 this campaign")
  })
})

describe("report", () => {
  it("fills 168 hourly columns from the API's buckets", () => {
    const pts = fillActivity([
      { hour: 0, opens: 50, clicks: 11 },
      { hour: 30, opens: 9, clicks: 2 },
      { hour: 400, opens: 1, clicks: 0 },
    ])
    expect(pts).toHaveLength(168)
    expect(pts[0]).toEqual({ hour: 0, opens: 50, clicks: 11 })
    expect(pts[1]).toEqual({ hour: 1, opens: 0, clicks: 0 })
    const s = activitySummary(pts)
    expect(s.total).toBe(59)
    expect(s.days[0]).toBe(50)
    expect(s.days[1]).toBe(9)
    expect(s.firstDayShare).toBe(85)
    expect(s.peak.hour).toBe(0)
  })
  it("labels a column by day and hour after the start, with its clock time", () => {
    expect(activityTitle({ hour: 25, opens: 3, clicks: 1 }, Date.UTC(2026, 8, 30, 9, 1))).toBe(
      "Day 2, hour 1 · from Thu 1 Oct, 10:01 UTC · 3 opens, 1 clicks",
    )
  })
  it("rounds the chart's top", () => {
    expect(niceMax(50)).toBe(60)
    expect(niceMax(52)).toBe(60)
    expect(niceMax(7)).toBe(8)
    expect(niceMax(2)).toBe(4)
  })
  const report = {
    audience: 1230,
    sent: 1214,
    delivered: 1198,
    opened: 494,
    machineOnlyOpens: 156,
    clicked: 109,
    replied: 7,
    unsubscribed: 5,
    bounced: { hard: 9, soft: 5 },
    complained: 1,
    failed: 2,
    insufficientData: false,
    machineOpenShare: 0.316,
    rates: {
      delivery: 0.9868,
      open: 0.4124,
      click: 0.091,
      clickToOpen: 0.22,
      bounce: 0.0115,
      complaint: 0.0008,
      unsubscribe: 0.0042,
    },
  }
  it("shows machine-only opens apart and measures complaints against deliveries", () => {
    const rows = funnelRows(report, "hello@coursified.app")
    const opened = rows.find((r) => r.key === "opened")
    expect(opened?.sub).toBe("· 338 people · 156 machine")
    expect(opened?.width).toBe(28.21)
    expect(opened?.machine).toBe(13.02)
    expect(opened?.pct).toBe("41.2%")
    expect(rows.find((r) => r.key === "replied")?.sub).toBe("· landed in hello@")
    expect(rows.find((r) => r.key === "complained")?.width).toBe(0.08)
    expect(rows.find((r) => r.key === "hard")?.width).toBe(0.74)
  })
  it("shows no percentage anywhere under 100 sends", () => {
    const rows = funnelRows({ ...report, insufficientData: true, rates: { ...report.rates, open: null } })
    expect(rows.filter((r) => r.key !== "audience").every((r) => r.pct === "—")).toBe(true)
  })
  it("pills each link by what the links check stored", () => {
    expect(linkPill({ status: 200, error: null })).toEqual({ cls: "pill-pass", label: "200", mono: true })
    expect(linkPill({ status: 301, error: null }).cls).toBe("pill-pass")
    expect(linkPill({ status: 404, error: null }).cls).toBe("pill-fail")
    expect(linkPill({ status: null, error: "timed out" })).toEqual({
      cls: "pill-warn",
      label: "Timed out",
      mono: false,
    })
    expect(linkPill({ status: null, error: null }).label).toBe("Not checked yet")
  })
  it("exports recipients as formula-safe CSV", () => {
    const csv = recipientsCsv([
      {
        email: "a@x.co",
        name: "=HYPERLINK(1)",
        status: "opened",
        bounceType: null,
        provider: "gmail",
        variant: "b",
        opens: 2,
        machineOpens: 1,
        clicks: 0,
        unsubscribed: false,
        sentAt: Date.UTC(2026, 8, 30, 9),
        openedAt: null,
        clickedAt: null,
      },
    ])
    expect(csv.startsWith("﻿email,name,status")).toBe(true)
    expect(csv).toContain("a@x.co,'=HYPERLINK(1),opened,,gmail,b,2,1,0,false,2026-09-30T09:00:00.000Z,,")
  })
})

describe("saving", () => {
  it("lists what a stale save would have lost, in words", () => {
    const changes = unsavedChanges(
      { subject: "Old", preheader: "p", trackOpens: true, bodyBlocks: { blocks: [] } },
      { subject: "New subject", trackOpens: false, bodyBlocks: { blocks: [{}, {}] } },
    )
    expect(changes).toEqual([
      { field: "subject", label: "Subject A", yours: "“New subject”" },
      { field: "bodyBlocks", label: "Body (blocks)", yours: "2 blocks" },
      { field: "trackOpens", label: "Track opens", yours: "off" },
    ])
  })
  it("recognises the stale refusal and nothing else", () => {
    const e = new ApiError(409, {
      _tag: "Conflict",
      reason: "stale",
      message: "Someone saved…",
      updatedAt: 5,
      updatedBy: "key_1",
    })
    expect(staleRefusal(e)).toEqual({ message: "Someone saved…", updatedAt: 5, updatedBy: "key_1" })
    expect(staleRefusal(new ApiError(409, { reason: "agent_limit", message: "x" }))).toBeNull()
    expect(staleRefusal(new Error("x"))).toBeNull()
  })
  it("recognises a limited key's refusals", () => {
    const e = new ApiError(409, {
      reason: "agent_limit",
      message: "Keys with send limits can't send campaigns; a person schedules those.",
      requestId: "req_1",
    })
    expect(agentRefusal(e)).toMatchObject({ reason: "agent_limit", notAllowed: [], requestId: "req_1" })
    const r = agentRefusal(
      new ApiError(409, { reason: "recipient_not_allowed", message: "m", notAllowed: ["a@b.c"] }),
    )
    expect(r?.notAllowed).toEqual(["a@b.c"])
    expect(agentRefusal(new ApiError(400, { reason: "agent_limit", message: "m" }))).toBeNull()
  })
})

describe("blocks", () => {
  const blocks = [newBlock("heading"), newBlock("paragraph"), newBlock("button")]
  it("moves, duplicates, removes and inserts", () => {
    expect(moveBlock(blocks, 0, 1).map((b) => b.type)).toEqual(["paragraph", "heading", "button"])
    expect(moveBlock(blocks, 0, -1).map((b) => b.type)).toEqual(["heading", "paragraph", "button"])
    expect(duplicateBlock(blocks, 1).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "button",
    ])
    expect(removeBlock(blocks, 1).map((b) => b.type)).toEqual(["heading", "button"])
    expect(insertBlock(blocks, 99, newBlock("note")).map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "button",
      "note",
    ])
  })
  it("duplicates a copy, not the same object", () => {
    const d = duplicateBlock(blocks, 0)
    expect(d[1]).not.toBe(d[0])
    expect(d[1]).toEqual(d[0])
  })
  it("rewrites text everywhere but leaves links and styles alone", () => {
    const doc = {
      preheader: "{{ a }}",
      label: "",
      blocks: [
        { type: "button" as const, label: "{{ a }}", url: "https://x/{{ a }}", style: "primary" as const },
      ],
      footer: { reason: "{{ a }}" },
    }
    const out = mapDocTexts(doc, (s) => s.replace("{{ a }}", "A"))
    expect(out.preheader).toBe("A")
    expect(out.footer.reason).toBe("A")
    expect(out.blocks[0]).toEqual({ type: "button", label: "A", url: "https://x/{{ a }}", style: "primary" })
  })
})

import { describe, expect, it } from "vitest"
import {
  actionTitle,
  checkPurpose,
  cleanDomain,
  countdown,
  defaultReceiving,
  domainState,
  eventsMissing,
  firstFailure,
  fixRefusal,
  foundLine,
  hasFixable,
  nameserverMatch,
  parentZone,
  recordCounts,
  reputationState,
  suspensionAt,
  thresholdGeometry,
  toBind,
  zoneState,
} from "./logic.ts"

const base = { id: "dom_01", sending: true, checkStatus: "pass" as const, lastCheckedAt: 1, zoneStatus: null }
const events = [
  {
    domainId: "dom_02",
    domain: "news.x",
    subscribed: false,
    withEvents: 0,
    silent: 280,
    status: "warn" as const,
    detail: "no sub",
  },
  {
    domainId: "dom_01",
    domain: "x",
    subscribed: true,
    withEvents: 9,
    silent: 0,
    status: "ok" as const,
    detail: "ok",
  },
]

describe("domainState", () => {
  it("orders checking, failing, no events, pending, warn, never checked, healthy", () => {
    expect(domainState({ ...base, checkStatus: "checking" }).label).toBe("Checking")
    expect(domainState({ ...base, checks: [{ status: "checking" }] }).spinner).toBe(true)
    expect(domainState({ ...base, checkStatus: "fail" }).label).toBe("Records failing")
    expect(domainState({ ...base, id: "dom_02" }, events)).toEqual({
      tone: "fail",
      label: "No delivery events",
    })
    expect(domainState({ ...base, zoneStatus: "pending" }).label).toBe("Pending nameservers")
    expect(domainState({ ...base, zoneStatus: "pending", checkStatus: "fail" }).label).toBe(
      "Pending nameservers",
    )
    expect(domainState({ ...base, checkStatus: "warn" }).tone).toBe("warn")
    expect(domainState({ ...base, checkStatus: null, lastCheckedAt: null }).label).toBe("Not checked yet")
    expect(domainState(base, events)).toEqual({ tone: "pass", label: "Healthy" })
  })
  it("ignores delivery events on a domain that doesn't send", () => {
    expect(eventsMissing({ id: "dom_02", sending: false }, events)).toBeNull()
    expect(eventsMissing({ id: "dom_02", sending: true }, events)?.silent).toBe(280)
  })
})

describe("zone and nameservers", () => {
  it("can't know the zone without a token", () => {
    expect(zoneState("active", false)).toBeNull()
    expect(zoneState("active", true)?.label).toBe("Active")
    expect(zoneState("pending", true)?.tone).toBe("warn")
    expect(zoneState(null, true)?.label).toBe("Not on this account")
  })
  it("compares nameservers as sets, case and trailing dot aside", () => {
    expect(
      nameserverMatch(
        ["ada.ns.cloudflare.com", "rob.ns.cloudflare.com"],
        ["ROB.ns.cloudflare.com.", "ada.ns.cloudflare.com"],
      ),
    ).toBe("match")
    expect(nameserverMatch(["ada.ns.cloudflare.com"], ["ns1.dns-parking.com"])).toBe("mismatch")
    expect(nameserverMatch(null, ["a"])).toBe("unknown")
  })
  it("finds the parent zone", () => {
    expect(parentZone("news.coursified.app")).toBe("coursified.app")
    expect(parentZone("coursified.app")).toBe("coursified.app")
  })
})

describe("records", () => {
  const checks = [
    { id: "mx", purpose: "receiving", status: "pass" },
    { id: "dkim", purpose: "sending", status: "fail" },
    { id: "bounce-mx", purpose: "sending", status: "warn" },
  ] as const
  it("counts and knows what's fixable", () => {
    expect(recordCounts(checks)).toMatchObject({ passing: 1, total: 3, failing: 1, warning: 1 })
    expect(hasFixable(checks)).toBe(true)
    expect(hasFixable([{ status: "pass" }])).toBe(false)
  })
  it("labels purposes", () => {
    expect(checkPurpose(checks[0])).toBe("Receiving")
    expect(checkPurpose(checks[1])).toBe("Sending")
    expect(checkPurpose(checks[2])).toBe("Return path")
  })
  it("says what public DNS found", () => {
    expect(foundLine({ status: "pass", expected: "a", actual: ["a"] })).toEqual({
      text: "Found: the same value",
      ok: true,
    })
    expect(foundLine({ status: "fail", expected: "a", actual: [] }).text).toBe("Found: nothing at this name")
    expect(foundLine({ status: "fail", expected: "a", actual: ["b", "c"] }).text).toBe("Found: b · c")
    expect(foundLine({ status: "checking", expected: "a", actual: [] }).text).toBe("Asking public DNS…")
  })
  it("picks the first failure", () => {
    const c = [
      { id: "mx", status: "warn" },
      { id: "dkim", status: "fail" },
    ] as never
    expect(firstFailure(c)?.id).toBe("dkim")
  })
  it("writes a BIND fragment", () => {
    const bind = toBind([
      {
        purpose: "receiving",
        type: "MX",
        name: "coursified.app",
        value: "route1.mx.cloudflare.net (priority 13)",
      },
      { purpose: "sending", type: "TXT", name: "_dmarc.coursified.app", value: 'v=DMARC1; p=none; x="y"' },
    ])
    expect(bind).toContain("coursified.app.\t3600\tIN\tMX\t13 route1.mx.cloudflare.net.")
    expect(bind).toContain('_dmarc.coursified.app.\t3600\tIN\tTXT\t"v=DMARC1; p=none; x=\\"y\\""')
  })
})

describe("fix", () => {
  it("names actions", () => {
    expect(actionTitle({ action: "fix_sending", checks: ["dkim"] })).toBe("Re-apply the sending records")
    expect(actionTitle({ action: "manual", checks: ["dmarc"] })).toBe("Set by hand: DMARC")
  })
  it("reads refusals", () => {
    expect(fixRefusal({ reason: "no_dns_token" })).toBe("no_dns_token")
    expect(fixRefusal({ reason: "other" })).toBeNull()
    expect(fixRefusal(undefined)).toBeNull()
  })
})

describe("adding a domain", () => {
  it("cleans what was typed", () => {
    expect(cleanDomain(" https://www.Coursified.app/path ")).toBe("coursified.app")
    expect(cleanDomain("news.coursified.app.")).toBe("news.coursified.app")
    expect(cleanDomain("not a domain")).toBeNull()
    expect(cleanDomain("localhost")).toBeNull()
  })
  it("keeps receiving off where mail already goes elsewhere", () => {
    expect(defaultReceiving({ existingMx: ["aspmx.l.google.com"] })).toBe(false)
    expect(defaultReceiving({ existingMx: [] })).toBe(true)
    expect(defaultReceiving(null)).toBe(true)
  })
})

describe("reputation", () => {
  it("places the lines", () => {
    const g = thresholdGeometry(0.0095, 0.02, 0.05)
    expect(g.fill).toBeCloseTo(11.875)
    expect(g.warning).toBeCloseTo(25)
    expect(g.risk).toBe(62.5)
    expect(thresholdGeometry(null, 0.001, 0.002).fill).toBeNull()
    expect(thresholdGeometry(0.5, 0.02, 0.05).fill).toBe(100)
  })
  it("reads the status", () => {
    expect(reputationState({ status: "at_risk", source: "cloudflare" }).label).toBe("At risk")
    expect(reputationState({ status: "healthy", source: "cloudflare" }).tone).toBe("pass")
    expect(reputationState({ status: null, source: "not-connected" }).label).toBe("Not connected")
  })
  it("counts down to suspension", () => {
    const at = suspensionAt({
      graceStartedAt: "2026-10-16T21:40:00Z",
      statusSince: null,
      policy: { suspension_after_hours: 168 } as never,
    })
    expect(at).toBe(Date.parse("2026-10-23T21:40:00Z"))
    expect(countdown(Date.parse("2026-10-23T21:40:00Z"), Date.parse("2026-10-17T17:48:00Z"))).toBe(
      "147 h 52 min left",
    )
    expect(countdown(0, 10)).toBe("Suspension due now")
  })
})

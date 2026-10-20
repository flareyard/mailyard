import { describe, expect, it } from "vitest"
import {
  authLines,
  canConfirm,
  type PolicyChange,
  type PolicyFlow,
  policyStep,
  refusalLine,
  ruaWith,
  share,
  sortSources,
  sourceName,
  sourceState,
  stepLabel,
} from "./dmarc.ts"

const src = (over: Partial<Parameters<typeof sortSources>[0][number]>) => ({
  ip: "1.1.1.1",
  ptr: null,
  provider: null,
  label: null,
  messages: 10,
  dmarcPass: 10,
  known: true,
  ...over,
})

describe("sources", () => {
  it("names a source by label, provider, reverse DNS, then address", () => {
    expect(sourceName(src({ label: "Old contact form", provider: "Hostinger" }))).toBe("Old contact form")
    expect(sourceName(src({ label: "  ", provider: "Hostinger" }))).toBe("Hostinger")
    expect(sourceName(src({ ptr: "mail-sor-f41.google.com" }))).toBe("mail-sor-f41.google.com")
    expect(sourceName(src({}))).toBe("1.1.1.1")
  })
  it("reads passing, partly failing and failing; known never reads red", () => {
    expect(sourceState(src({})).label).toBe("Passing")
    expect(sourceState(src({ dmarcPass: 4, known: false })).label).toBe("Partly failing")
    expect(sourceState(src({ dmarcPass: 0, known: false })).tone).toBe("fail")
    expect(sourceState(src({ dmarcPass: 0, known: true })).tone).toBe("warn")
    expect(sourceState(src({ messages: 0, dmarcPass: 0 })).label).toBe("Passing")
  })
  it("sorts unknown failing first, then known failing, then passing, each by messages", () => {
    const sorted = sortSources([
      src({ ip: "a", messages: 3655, dmarcPass: 3655 }),
      src({ ip: "b", messages: 33, dmarcPass: 18, known: false }),
      src({ ip: "c", messages: 96, dmarcPass: 0, known: false }),
      src({ ip: "d", messages: 128, dmarcPass: 100, known: true }),
      src({ ip: "e", messages: 3655, dmarcPass: 3655, label: "Billing" }),
    ])
    expect(sorted.map((s) => s.ip)).toEqual(["c", "b", "d", "a", "e"])
  })
  it("lists auth domains", () => {
    expect(authLines({ "coursified.app": "pass", "gmail.com": "fail" })).toEqual([
      "coursified.app (pass)",
      "gmail.com (fail)",
    ])
  })
  it("computes shares", () => {
    expect(share(3802, 3912)).toBeCloseTo(0.9719)
    expect(share(1, 0)).toBeNull()
  })
})

describe("rua", () => {
  it("adds Mailyard's address once, keeping what's there", () => {
    expect(ruaWith(["postmaster@hostinger-mail.com"], "dmarc@in.flareyard.dev")).toBe(
      "rua=mailto:postmaster@hostinger-mail.com,mailto:dmarc@in.flareyard.dev",
    )
    expect(ruaWith(["mailto:DMARC@in.flareyard.dev"], "dmarc@in.flareyard.dev")).toBe(
      "rua=mailto:dmarc@in.flareyard.dev",
    )
    expect(ruaWith([], "dmarc@in.flareyard.dev")).toBe("rua=mailto:dmarc@in.flareyard.dev")
  })
  it("labels steps", () => {
    expect(stepLabel({ p: "quarantine", pct: 25 })).toBe("quarantine at 25%")
    expect(stepLabel({ p: "reject", pct: null })).toBe("reject")
    expect(stepLabel(null)).toBeNull()
  })
})

describe("the policy flow", () => {
  const change: PolicyChange = {
    name: "_dmarc.coursified.app",
    before: "v=DMARC1; p=none",
    after: "v=DMARC1; p=quarantine",
    applied: false,
    changed: true,
  }
  const start: PolicyFlow = { step: "previewing" }

  it("never writes before a preview", () => {
    expect(policyStep(start, { type: "confirm" })).toEqual(start)
    expect(canConfirm(start)).toBe(false)
  })
  it("previews, then confirms, then applies", () => {
    const seen = policyStep(start, { type: "previewed", change })
    expect(seen.step).toBe("preview")
    expect(canConfirm(seen)).toBe(true)
    const applying = policyStep(seen, { type: "confirm" })
    expect(applying.step).toBe("applying")
    expect(policyStep(applying, { type: "preview" })).toBe(applying)
    const done = policyStep(applying, { type: "applied", change: { ...change, applied: true } })
    expect(done).toEqual({ step: "applied", change: { ...change, applied: true } })
  })
  it("won't confirm a preview that changes nothing", () => {
    const same = policyStep(start, { type: "previewed", change: { ...change, changed: false } })
    expect(canConfirm(same)).toBe(false)
    expect(policyStep(same, { type: "confirm" })).toBe(same)
  })
  it("keeps the preview beside a refusal", () => {
    const seen = policyStep(start, { type: "previewed", change })
    const applying = policyStep(seen, { type: "confirm" })
    const refused = policyStep(applying, {
      type: "refused",
      refusal: { reason: "no_dns_token", message: "no token" },
    })
    expect(refused).toEqual({
      step: "refused",
      refusal: { reason: "no_dns_token", message: "no token" },
      change,
    })
    expect(policyStep(refused, { type: "preview" })).toEqual({ step: "previewing" })
  })
  it("explains refusals", () => {
    expect(refusalLine({ reason: "no_dns_token", message: "" })).toBe(
      "Mailyard can’t write DNS until a zone token is set.",
    )
    expect(refusalLine({ reason: "other", message: "" })).toMatch(/didn’t change/)
  })
})

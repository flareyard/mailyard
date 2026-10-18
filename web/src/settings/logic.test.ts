import { describe, expect, it } from "vitest"
import {
  autoReplyWindow,
  changedFields,
  cleanColors,
  conditionText,
  contrastPairs,
  contrastProblem,
  fromPercentInput,
  hostOrigin,
  inviteStatus,
  logoProblem,
  mailboxAddress,
  mergedColors,
  move,
  moveTo,
  normaliseDomain,
  originHost,
  privacyUrlProblem,
  refieldCondition,
  retypeAction,
  ruleProblem,
  sessionEnds,
  sessionEndsWhy,
  shortAddresses,
  toPercentInput,
  unsavedLine,
} from "./logic.ts"

const coursified = {
  bg: "#F4F4F2",
  surface: "#EEF2FF",
  fg: "#0E0E0E",
  muted: "#71717A",
  border: "#E4E4E7",
  indigo: "#2E5BFF",
  white: "#FFFFFF",
}

describe("brand contrast", () => {
  it("checks the backend's six pairs on the colours merged over the defaults", () => {
    const pairs = contrastPairs(coursified)
    expect(pairs.map((p) => p.what)).toEqual([
      "White text on the accent",
      "Heading text on the page background",
      "Body text on the page background",
      "Muted text on the page background",
      "Heading text on the card",
      "Muted text on the card",
    ])
    expect(pairs.map((p) => p.ratio.toFixed(1))).toEqual(["5.2", "17.5", "10.3", "4.4", "19.3", "4.8"])
    expect(pairs.filter((p) => !p.ok).map((p) => p.field)).toEqual(["colors.muted"])
  })
  it("words the first problem exactly as the API's 400", () => {
    expect(contrastProblem({ indigo: "#C6F432" })).toEqual({
      field: "colors.indigo",
      message: "White text on the accent is 1.3:1; AA needs 4.5:1. Darken or lighten one of them.",
    })
    expect(contrastProblem({})).toBeNull()
  })
  it("ignores empty and invalid values, which use the default", () => {
    expect(mergedColors({ bg: "#zzz", fg: "" }).bg).toBe("#fcfcfc")
    expect(cleanColors({ bg: " #ffffff ", fg: "nope", body: "" })).toEqual({ bg: "#ffffff" })
  })
  it("refuses SVG and big logos with the backend's wording", () => {
    expect(logoProblem({ name: "mark.svg", type: "image/svg+xml", size: 4000 })).toBe(
      "A logo is a PNG, JPEG, WebP or GIF image.",
    )
    expect(logoProblem({ name: "banner.png", type: "image/png", size: 2.4 * 1024 * 1024 })).toBe(
      "A logo is at most 1 MiB.",
    )
    expect(logoProblem({ name: "mark.png", type: "image/png", size: 18_000 })).toBeNull()
  })
})

describe("save bars", () => {
  it("lists what changed", () => {
    const labels = { a: "signature", b: "auto-reply dates", c: "auto-reply dates" }
    expect(changedFields({ a: 1, b: 2, c: 3 }, { a: 2, b: 2, c: 4 }, labels)).toEqual([
      "signature",
      "auto-reply dates",
    ])
    expect(unsavedLine([])).toBe("No unsaved changes")
    expect(unsavedLine(["signature"])).toBe("1 unsaved change: signature")
    expect(unsavedLine(["auto-reply dates", "signature"])).toBe(
      "2 unsaved changes: auto-reply dates, signature",
    )
  })
})

describe("compliance", () => {
  it("allows only https privacy links, or none", () => {
    expect(privacyUrlProblem("")).toBeNull()
    expect(privacyUrlProblem("https://coursified.app/privacy")).toBeNull()
    expect(privacyUrlProblem("http://coursified.app/privacy")).toMatch(/https:\/\//)
    expect(privacyUrlProblem("https://")).toBe("That isn’t a full web address.")
  })
  it("converts the tracking origin and link domains", () => {
    expect(originHost("https://t.coursified.app/")).toBe("t.coursified.app")
    expect(hostOrigin("t.coursified.app")).toBe("https://t.coursified.app")
    expect(hostOrigin(" ")).toBeNull()
    expect(normaliseDomain("https://YouTube.com/watch")).toBe("youtube.com")
    expect(normaliseDomain("nope")).toBeNull()
  })
  it("round-trips percentages", () => {
    expect(toPercentInput(0.2)).toBe("20")
    expect(toPercentInput(0.001)).toBe("0.1")
    expect(fromPercentInput("0.1")).toBe(0.001)
    expect(fromPercentInput("")).toBeNull()
  })
})

describe("mailboxes", () => {
  it("builds addresses", () => {
    expect(mailboxAddress(" Admissions ", "coursified.app", "shared")).toBe("admissions@coursified.app")
    expect(mailboxAddress("x", "coursified.app", "catch_all")).toBe("*@coursified.app")
  })
  it("says when an auto-reply runs", () => {
    const s = Date.UTC(2026, 9, 24, 17)
    const e = Date.UTC(2026, 9, 28, 8)
    expect(autoReplyWindow({ enabled: true, startsAt: s, endsAt: e })).toBe("24 – 28 Oct")
    expect(autoReplyWindow({ enabled: false, startsAt: s, endsAt: e })).toBeNull()
    expect(autoReplyWindow({ enabled: true, startsAt: null, endsAt: null })).toBe("On")
  })
})

describe("rules", () => {
  it("describes conditions", () => {
    expect(conditionText({ field: "subject", op: "contains", value: "refund" })).toEqual({
      text: "Subject contains",
      value: "refund",
    })
    expect(conditionText({ field: "automated", value: true })).toEqual({
      text: "Automated mail: yes",
      value: null,
    })
  })
  it("switches shapes when the field or action type changes", () => {
    expect(refieldCondition({ field: "subject", op: "contains", value: "x" }, "automated")).toEqual({
      field: "automated",
      value: true,
    })
    expect(refieldCondition({ field: "automated", value: true }, "from")).toEqual({
      field: "from",
      op: "contains",
      value: "",
    })
    expect(retypeAction({ type: "archive" }, "label", { labelId: "lbl_1" })).toEqual({
      type: "label",
      labelId: "lbl_1",
    })
    expect(retypeAction({ type: "forward", to: ["a@b.co"] }, "forward", {})).toEqual({
      type: "forward",
      to: ["a@b.co"],
    })
  })
  it("refuses incomplete rules", () => {
    const ok = {
      name: "R",
      conditions: [{ field: "subject" as const, op: "contains" as const, value: "x" }],
      actions: [{ type: "archive" as const }],
    }
    expect(ruleProblem(ok)).toBeNull()
    expect(ruleProblem({ ...ok, name: " " })).toBe("Give the rule a name.")
    expect(ruleProblem({ ...ok, actions: [{ type: "forward", to: [] }] })).toBe(
      "Add an address to forward to.",
    )
  })
  it("reorders", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"])
    expect(move(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"])
    expect(moveTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"])
  })
})

describe("sessions and invites", () => {
  it("says why a session ends", () => {
    expect(sessionEndsWhy({ expiresAt: 10, absoluteExpiresAt: 20 })).toBe("14 days after last use")
    expect(sessionEndsWhy({ expiresAt: 20, absoluteExpiresAt: 20 })).toBe("30-day cap")
    expect(sessionEnds({ expiresAt: 30, absoluteExpiresAt: 20 })).toBe(20)
  })
  it("labels invites", () => {
    const now = Date.UTC(2026, 9, 17, 17, 48)
    expect(inviteStatus({ status: "sent", expiresAt: now + 5.5 * 86_400_000 }, now)).toEqual({
      label: "Pending · 6 days left",
      tone: "info",
    })
    expect(inviteStatus({ status: "sent", expiresAt: now - 1 }, now).label).toBe("Expired")
    expect(inviteStatus({ status: "draft", expiresAt: now + 1 }, now).label).toBe("Draft · not sent")
    expect(shortAddresses(["hello@coursified.app", "support@coursified.app"])).toBe("hello@, support@")
  })
})

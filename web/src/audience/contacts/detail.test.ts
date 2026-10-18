import { describe, expect, it } from "vitest"
import {
  consentParts,
  dataLine,
  dayLabel,
  deliveryTone,
  deliveryVerb,
  groupByDay,
  highlightField,
  inputValue,
  parseKinds,
  typedInput,
} from "./detail.ts"

const NOW = Date.UTC(2026, 9, 18, 15, 0) // Sun 18 Oct 2026

describe("timeline", () => {
  it("labels days in UTC", () => {
    expect(dayLabel(Date.UTC(2026, 9, 18, 1), NOW)).toBe("Today")
    expect(dayLabel(Date.UTC(2026, 9, 17, 23), NOW)).toBe("Yesterday")
    expect(dayLabel(Date.UTC(2026, 9, 14, 12), NOW)).toBe("Wed 14 Oct")
    expect(dayLabel(Date.UTC(2025, 2, 11, 12), NOW)).toBe("Tue 11 Mar 2025")
  })
  it("groups newest-first items under their days, keeping the order", () => {
    const g = groupByDay(
      [{ at: Date.UTC(2026, 9, 18, 9) }, { at: Date.UTC(2026, 9, 18, 8) }, { at: Date.UTC(2026, 9, 14, 8) }],
      NOW,
    )
    expect(g.map((x) => [x.day, x.items.length])).toEqual([
      ["Today", 2],
      ["Wed 14 Oct", 1],
    ])
  })
  it("reads kinds from ?kind= in the canonical order", () => {
    expect(parseKinds("reply,delivery,nope")).toEqual(["delivery", "reply"])
    expect(parseKinds(undefined)).toEqual([])
  })
  it("words delivery events and colours the bad ones", () => {
    expect(deliveryVerb("email.clicked")).toBe("Clicked")
    expect(deliveryVerb("email.complained")).toBe("Marked as spam")
    expect(deliveryTone("email.bounced")).toBe("is-fail")
    expect(deliveryTone("email.deferred")).toBe("is-warn")
    expect(deliveryTone("email.opened")).toBe("is-pass")
  })
  it("puts an event's data on one line", () => {
    expect(dataLine({ course: "Data foundations", lesson: 6, nested: { a: 1 } })).toBe(
      "course Data foundations · lesson 6",
    )
    expect(dataLine(null)).toBeNull()
  })
})

describe("consent", () => {
  it("says how and when, and the double opt-in", () => {
    const p = consentParts(
      {
        topicId: "t",
        name: "New courses",
        state: "subscribed",
        changedAt: Date.UTC(2026, 2, 12),
        source: "confirmation link",
        confirmedAt: Date.UTC(2026, 2, 12),
      },
      NOW,
    )
    expect(p).toEqual({
      text: "Subscribed 12 Mar",
      source: "confirmation link",
      confirmed: "confirmed by double opt-in on 12 Mar 2026 UTC",
    })
  })
  it("a recent change reads as an age, and no row reads never subscribed", () => {
    expect(
      consentParts({ topicId: "t", name: "x", state: "subscribed", changedAt: NOW - 4 * 86_400_000 }, NOW)
        .text,
    ).toBe("Subscribed 4 d ago")
    expect(consentParts(undefined).text).toBe("Never subscribed")
  })
})

describe("profile fields", () => {
  it("only highlights a registered key", () => {
    expect(highlightField("first_name", ["first_name"])).toBe("first_name")
    expect(highlightField("evil", ["first_name"])).toBeNull()
  })
  it("types what was typed as the API stores it", () => {
    expect(typedInput("number", "1,200")).toEqual({ value: 1200 })
    expect(typedInput("number", "lots")).toMatchObject({ error: expect.any(String) })
    expect(typedInput("boolean", "Yes")).toEqual({ value: true })
    expect(typedInput("date", "2026-03-11")).toEqual({ value: "2026-03-11" })
    expect(typedInput("string", "  ")).toEqual({ value: null })
  })
  it("shows stored values in the input's words", () => {
    expect(inputValue(false, "boolean")).toBe("no")
    expect(inputValue("2026-03-11T00:00:00.000Z", "date")).toBe("2026-03-11")
    expect(inputValue(null, "string")).toBe("")
  })
})

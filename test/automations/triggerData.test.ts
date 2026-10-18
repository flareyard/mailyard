import { describe, expect, it } from "vitest"
import { dateTriggerData, dayOf, unsuppliedTriggerKeys } from "../../src/automations/triggerData.ts"

describe("trigger data (HAL-3411)", () => {
  it("reads a contact's date field as a day, whatever its form", () => {
    expect(dayOf("1990-10-17")).toBe("1990-10-17")
    expect(dayOf("1990-10-17T22:30:00Z")).toBe("1990-10-17")
    expect(dayOf(Date.UTC(1990, 9, 17))).toBe("1990-10-17")
    expect(dayOf("October 17, 1990 UTC")).toBe("1990-10-17")
    expect(dayOf("soon")).toBeNull()
    expect(dayOf(null)).toBeNull()
  })

  it("counts years to the anniversary the run is about, offset included", () => {
    const birthday = { kind: "date", field: "birthday", offsetDays: 0, hour: 9, repeat: "yearly" } as const
    const at = Date.UTC(2026, 9, 17, 9)
    expect(dateTriggerData(birthday, "1990-10-17", at)).toEqual({
      field: "birthday",
      date: "1990-10-17",
      offsetDays: 0,
      years: 36,
    })
    // A week before a New Year's Day birthday, the run is about the coming year's.
    const weekBefore = { ...birthday, offsetDays: -7 }
    expect(dateTriggerData(weekBefore, "2000-01-01", Date.UTC(2026, 11, 25, 9)).years).toBe(27)
    expect(dateTriggerData(birthday, "not a date", at)).toMatchObject({ date: null, years: null })
  })

  it("names the trigger keys a kind can't supply; an event can supply any", () => {
    expect(unsuppliedTriggerKeys("date", ["name", "trigger.years", "trigger.offer_url"])).toEqual([
      "offer_url",
    ])
    expect(unsuppliedTriggerKeys("created", ["trigger.plan", "trigger.plan"])).toEqual(["plan"])
    expect(unsuppliedTriggerKeys("topic", ["trigger.topicName"])).toEqual([])
    expect(unsuppliedTriggerKeys("event", ["trigger.anything"])).toEqual([])
  })
})

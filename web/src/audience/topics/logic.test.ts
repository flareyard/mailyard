import { describe, expect, it } from "vitest"
import { growthText, NOT_ENOUGH, signed, topicBody, unsubText, validateTopic } from "./logic.ts"

describe("topic stats", () => {
  it("reads rates as fractions with a sign for growth", () => {
    expect(growthText({ insufficientData: false, growthRate: 0.049 })).toBe("+4.9%")
    expect(growthText({ insufficientData: false, growthRate: -0.012 })).toBe("−1.2%")
    expect(unsubText({ insufficientData: false, unsubscribeRate: 0.0083 })).toBe("0.83%")
  })
  it("never shows a percentage without enough subscribers", () => {
    expect(growthText({ insufficientData: true, growthRate: 0.5 })).toBeNull()
    expect(unsubText({ insufficientData: true, unsubscribeRate: 0.1 })).toBeNull()
    expect(NOT_ENOUGH(100)).toBe("Not enough subscribers yet (100 needed)")
  })
  it("signs joined and left", () => {
    expect(signed(214, "+")).toBe("+214")
    expect(signed("31", "−")).toBe("−31")
    expect(signed(0, "+")).toBe("0")
  })
})

describe("topic sheet", () => {
  const d = { name: " New courses ", description: "", sender: "", doubleOptIn: true }
  it("needs a name", () => {
    expect(validateTopic(d)).toBeNull()
    expect(validateTopic({ ...d, name: " " })?.field).toBe("name")
  })
  it("sends blanks as null", () => {
    expect(topicBody(d)).toEqual({ name: "New courses", description: null, sender: null, doubleOptIn: true })
  })
})

import { describe, expect, it } from "vitest"
import { fieldPatch, fieldsMeta, isNamed, phoneSub, typeChangeWarning } from "./logic.ts"

const plan = {
  key: "plan",
  label: "Plan",
  type: "string" as const,
  usedBy: [
    { type: "segment" as const, id: "seg_1", name: "Trial ends this week" },
    { type: "segment" as const, id: "seg_2", name: "Team plan admins" },
  ],
}
const company = { key: "company", label: "company", type: "string" as const, usedBy: [] }

describe("the field registry", () => {
  it("reads a label equal to the key as not named", () => {
    expect(isNamed(plan)).toBe(true)
    expect(isNamed(company)).toBe(false)
    expect(fieldsMeta([plan, company])).toBe("2 fields · 1 not named")
    expect(fieldsMeta([plan])).toBe("1 field")
  })
  it("words the phone row", () => {
    expect(phoneSub(plan)).toBe("Text · 2 used by Trial ends this week, Team plan admins")
    expect(phoneSub(company)).toBe("Text · not used")
  })
  it("warns about a type change, naming who uses the field", () => {
    expect(typeChangeWarning(plan, "string")).toBeNull()
    const w = typeChangeWarning(plan, "number")
    expect(w?.title).toBe("2 segments use this field.")
    expect(w?.body).toMatch(/as numbers instead of text/)
    expect(w?.body).toMatch(/aren’t converted/)
    expect(typeChangeWarning(company, "date")?.title).toBe("Nothing uses this field yet.")
  })
  it("patches only what changed, and an emptied label goes back to the key", () => {
    expect(fieldPatch(plan, "Plan", "string")).toBeNull()
    expect(fieldPatch(plan, "", "string")).toEqual({ label: null })
    expect(fieldPatch(company, "Company", "string")).toEqual({ label: "Company" })
    expect(fieldPatch(plan, "Plan", "number")).toEqual({ type: "number" })
  })
})

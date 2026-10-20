import { describe, expect, it } from "vitest"
import {
  addDef,
  bars,
  countingSince,
  defIndex,
  type FieldDef,
  formBody,
  isLegacy,
  labelFor,
  moveDef,
  resolveDefs,
  turnstileState,
  updateDef,
  validateDefs,
  validateDraft,
  validateKey,
} from "./logic.ts"

const defs: FieldDef[] = [
  { key: "first_name", label: "First name", type: "text", required: true },
  { key: "role", label: "What do you do?", type: "select", required: true, options: ["Student", "Analyst"] },
  { key: "company", label: "Company", type: "text", required: false },
]

describe("field definitions", () => {
  it("reads old plain fields as optional text", () => {
    expect(resolveDefs({ fields: ["country"], fieldDefs: [] })).toEqual([
      { key: "country", label: "Country", type: "text", required: false },
    ])
    expect(labelFor("years_experience")).toBe("Years experience")
    expect(
      isLegacy({
        fields: ["country"],
        fieldDefs: [{ key: "country", label: "Country", type: "text", required: false }],
      }),
    ).toBe(true)
    expect(isLegacy({ fields: [], fieldDefs: defs })).toBe(false)
  })
  it("reorders by drag or arrows, keeping the rest in order", () => {
    expect(moveDef(defs, 0, 2).map((d) => d.key)).toEqual(["role", "company", "first_name"])
    expect(moveDef(defs, 2, 1).map((d) => d.key)).toEqual(["first_name", "company", "role"])
    expect(moveDef(defs, 0, 5).map((d) => d.key)).toEqual(["first_name", "role", "company"])
  })
  it("drops options when a choice list becomes something else, and starts them empty the other way", () => {
    expect("options" in (updateDef(defs, 1, { type: "text" })[1] as FieldDef)).toBe(false)
    expect(updateDef(defs, 2, { type: "select" })[2]?.options).toEqual([])
  })
  it("checks new keys like the API", () => {
    expect(validateKey("email", defs)).toBe("Email and name are always on the form.")
    expect(validateKey("2x", defs)).toMatch(/letters, digits and underscores/)
    expect(validateKey("role", defs)).toBe("role is already on the form.")
    expect(validateKey("country", defs)).toBeNull()
    expect(addDef(defs, " country ").at(-1)).toEqual({
      key: "country",
      label: "Country",
      type: "text",
      required: false,
    })
  })
  it("refuses a choice list without options, on that row", () => {
    const bad = updateDef(defs, 1, { options: [] })
    expect(validateDefs(bad)).toEqual({
      field: "fieldDefs[1].options",
      message: "A select has 1 to 50 options.",
    })
    expect(defIndex("fieldDefs[1].options")).toBe(1)
    expect(defIndex("name")).toBeNull()
  })
})

describe("the draft", () => {
  const draft = {
    name: "Weekly",
    description: "",
    redirectUrl: "",
    topicIds: ["top_a"],
    topicChoice: "all" as const,
    fieldDefs: defs,
    turnstileSiteKey: " ",
  }
  it("validates the heading, redirect and topics with the API's words", () => {
    expect(validateDraft(draft)).toBeNull()
    expect(validateDraft({ ...draft, name: " " })?.field).toBe("name")
    expect(validateDraft({ ...draft, redirectUrl: "http://x.io" })).toEqual({
      field: "redirectUrl",
      message: "The redirect must be an https URL.",
    })
    expect(validateDraft({ ...draft, topicIds: [] })?.field).toBe("topicIds")
  })
  it("sends blanks as null and definitions instead of fields", () => {
    const b = formBody(draft)
    expect(b.description).toBeNull()
    expect(b.turnstileSiteKey).toBeNull()
    expect(b.fieldDefs[1]).toEqual({
      key: "role",
      label: "What do you do?",
      type: "select",
      required: true,
      options: ["Student", "Analyst"],
    })
    expect("options" in (b.fieldDefs[0] ?? {})).toBe(false)
  })
})

describe("turnstile and stats", () => {
  it("is green only when the deploy has the secret", () => {
    expect(turnstileState({ enabled: false, siteKey: null, configured: true })).toBe("off")
    expect(turnstileState({ enabled: true, siteKey: "0x", configured: false })).toBe("unchecked")
    expect(turnstileState({ enabled: true, siteKey: "0x", configured: true })).toBe("verified")
  })
  it("scales bars to the busiest day", () => {
    const b = bars([
      { day: "2026-10-01", submissions: 10, subscribed: 4, confirm: 5, refused: 1 },
      { day: "2026-10-02", submissions: "5", subscribed: 5, confirm: 0, refused: 0 },
    ])
    expect(b.map((x) => x.height)).toEqual([100, 50])
    expect(b[0]?.label).toBe("2026-10-01: 10 submissions, 4 subscribed, 5 awaiting confirmation, 1 refused")
    expect(
      bars([{ day: "2026-10-01", submissions: 0, subscribed: 0, confirm: 0, refused: 0 }])[0]?.height,
    ).toBe(0)
  })
  it("says counting began on 18 Oct when the range is all zeros from before it", () => {
    const zero = { submissions: 0, subscribed: 0, confirm: 0, refused: 0 }
    expect(
      countingSince([
        { day: "2026-09-18", ...zero },
        { day: "2026-10-18", ...zero },
      ]),
    ).toBe(true)
    expect(countingSince([{ day: "2026-09-18", ...zero, submissions: 1 }])).toBe(false)
  })
})

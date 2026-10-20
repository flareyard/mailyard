import { describe, expect, it } from "vitest"
import {
  apiQuery,
  ariaSort,
  bulkBody,
  bulkDoneTitle,
  chipsOf,
  clean,
  colsParam,
  columnsOf,
  DEFAULT_COLUMNS,
  describeView,
  exportFilter,
  invalidChips,
  moveColumn,
  type Names,
  nextSort,
  parseContactsSearch,
  parseEventFilter,
  parseFieldFilter,
  readAction,
  toggleColumn,
  viewFilter,
  withAdded,
  withList,
  withoutChip,
  writeEventFilter,
  writeFieldFilter,
} from "./logic.ts"

const names: Names = {
  topic: (id) => ({ top_updates: "Product updates" })[id] ?? id,
  segment: (id) => ({ seg_01JA4: "Engaged course buyers, West Africa" })[id] ?? id,
  field: (k) => ({ plan: "Plan", courses_completed: "Courses completed", email: "Email" })[k] ?? k,
}

describe("the URL mirrors GET /v1/contacts", () => {
  it("reads repeated field and event params, comma lists and the sort", () => {
    const s = parseContactsSearch({
      status: "subscribed,unconfirmed",
      field: ["plan:eq:pro", "country:eq:NG"],
      event: "lesson_completed:30",
      sort: "-createdAt",
      bogus: "x",
      sheet: "export",
    })
    expect(s).toEqual({
      status: "subscribed,unconfirmed",
      field: ["plan:eq:pro", "country:eq:NG"],
      event: ["lesson_completed:30"],
      sort: "-createdAt",
      sheet: "export",
    })
  })
  it("drops an unknown sort and empty values", () => {
    expect(parseContactsSearch({ sort: "name", q: "  ", field: [""] })).toEqual({})
  })
  it("builds the API query with the default sort and no app-only keys", () => {
    expect(apiQuery({ status: "bounced", cols: "status", sheet: "filter" })).toEqual({
      status: "bounced",
      sort: "-lastActivityAt",
    })
  })
  it("the filter for bulk and export leaves out sort, cursor and columns", () => {
    expect(viewFilter({ q: "ada", sort: "email", cursor: "c1", cols: "x", topicId: "t" })).toEqual({
      q: "ada",
      topicId: "t",
    })
  })
  it("clean drops undefined and empty values", () => {
    expect(clean({ a: 1, b: undefined, c: "" })).toEqual({ a: 1 })
  })
})

describe("field= and event= are read the way the API reads them", () => {
  it("takes the value as everything after the second colon", () => {
    expect(parseFieldFilter("note:contains:a:b")).toEqual({ key: "note", op: "contains", value: "a:b" })
  })
  it("refuses a missing value with the API's words", () => {
    expect(parseFieldFilter("courses_completed:gte")).toEqual({
      error: "The gte filter on courses_completed needs a value.",
    })
  })
  it("refuses an unknown op", () => {
    expect(parseFieldFilter("plan:like:pro")).toMatchObject({
      error: expect.stringMatching(/^Write a field filter/),
    })
  })
  it("exists and missing take no value", () => {
    expect(parseFieldFilter("company:exists")).toEqual({ key: "company", op: "exists" })
    expect(writeFieldFilter({ key: "company", op: "missing" })).toBe("company:missing")
    expect(writeFieldFilter({ key: "plan", op: "eq", value: "pro" })).toBe("plan:eq:pro")
  })
  it("reads events with ! and days, and refuses days out of range", () => {
    expect(parseEventFilter("!lesson_completed:30")).toEqual({
      name: "lesson_completed",
      did: false,
      days: 30,
    })
    expect(parseEventFilter("signed_up")).toEqual({ name: "signed_up", did: true })
    expect(parseEventFilter("x:4000")).toEqual({ error: "Days are 1 to 3650." })
    expect(parseEventFilter("!")).toEqual({ error: "Write an event filter as [!]name[:days]." })
    expect(writeEventFilter({ name: "a", did: false, days: 7 })).toBe("!a:7")
  })
})

describe("chips", () => {
  const s = {
    segmentId: "seg_01JA4",
    status: "subscribed,unconfirmed",
    topicId: "top_updates",
    field: ["plan:eq:pro", "courses_completed:gte"],
    event: ["lesson_completed:30"],
  }
  it("one chip per value, labelled from the registry", () => {
    const chips = chipsOf(s, names)
    expect(chips.map((c) => [c.label, c.text])).toEqual([
      ["In segment", "Engaged course buyers, West Africa"],
      ["Status is any of", "subscribed, unconfirmed"],
      ["Topic is", "Product updates"],
      ["Plan is", "pro"],
      ["Courses completed at least", "no value"],
      ["Did", "lesson_completed in 30 d"],
    ])
    expect(chips.find((c) => c.text === "no value")?.invalid).toBe(
      "The gte filter on courses_completed needs a value.",
    )
  })
  it("a single status reads “is”, not “is any of”", () => {
    expect(chipsOf({ status: "complained" }, names)[0]?.label).toBe("Status is")
  })
  it("removing a field chip drops only its value; removing status clears the list", () => {
    expect(withoutChip(s, { key: "field", value: "plan:eq:pro" }).field).toEqual(["courses_completed:gte"])
    expect(withoutChip(s, { key: "status", value: s.status }).status).toBeUndefined()
    expect(withoutChip({ field: ["a:exists"], cursor: "c" }, { key: "field", value: "a:exists" })).toEqual({})
  })
  it("writes multi-selects in the canonical order and clears an empty one", () => {
    expect(withList({}, "status", ["unconfirmed", "subscribed"]).status).toBe("subscribed,unconfirmed")
    expect(withList({ status: "bounced" }, "status", []).status).toBeUndefined()
  })
  it("adds a field filter once", () => {
    expect(withAdded({ field: ["a:exists"] }, "field", "a:exists").field).toEqual(["a:exists"])
  })
  it("a 400 marks the locally invalid chip, or every chip of the kind it names", () => {
    const chips = chipsOf(s, names)
    expect([...invalidChips(chips, "field")]).toEqual(["field:courses_completed:gte"])
    const clean = chipsOf({ event: ["a:3"] }, names)
    expect([...invalidChips(clean, "event")]).toEqual(["event:a:3"])
  })
  it("describes a view in words", () => {
    expect(
      describeView({ status: "subscribed", topicId: "top_updates", field: ["plan:eq:pro"] }, names),
    ).toBe("status is subscribed, topic is Product updates, plan is pro")
    expect(describeView({}, names)).toBe("every contact")
  })
})

describe("columns", () => {
  it("defaults, then cols= in order, dropping unknown ids", () => {
    expect(columnsOf(undefined, [])).toEqual(DEFAULT_COLUMNS)
    expect(columnsOf("f.plan,status,nope,f.gone", ["plan"])).toEqual(["f.plan", "status"])
  })
  it("leaves the default set out of the URL", () => {
    expect(colsParam([...DEFAULT_COLUMNS])).toBeUndefined()
    expect(colsParam(["status"])).toBe("status")
  })
  it("toggles and moves", () => {
    expect(toggleColumn(["status"], "f.plan", true)).toEqual(["status", "f.plan"])
    expect(toggleColumn(["status", "topics"], "status", false)).toEqual(["topics"])
    expect(moveColumn(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"])
    expect(moveColumn(["a", "b"], "a", -1)).toEqual(["a", "b"])
  })
  it("sorts descending first, contact by email A to Z first", () => {
    expect(nextSort("-lastActivityAt", "lastActivityAt")).toBe("lastActivityAt")
    expect(nextSort("-lastActivityAt", "createdAt")).toBe("-createdAt")
    expect(nextSort("-lastActivityAt", "contact")).toBe("email")
    expect(nextSort("-lastActivityAt", "status")).toBeNull()
    expect(ariaSort("email", "contact")).toBe("ascending")
  })
})

describe("bulk", () => {
  it("sends ids, or the view's filter", () => {
    expect(bulkBody({ kind: "ids", ids: ["a"] }, { action: "delete" })).toEqual({
      ids: ["a"],
      action: { action: "delete" },
    })
    expect(
      bulkBody({ kind: "filter", search: { status: "subscribed", sort: "email" } }, { action: "delete" }),
    ).toEqual({
      filter: { status: "subscribed" },
      action: { action: "delete" },
    })
  })
  it("titles a finished action", () => {
    expect(bulkDoneTitle({ action: "addTopic", topicId: "t" }, 2, 3, "Live sessions")).toBe(
      "Added 2 of 3 to Live sessions",
    )
    expect(bulkDoneTitle({ action: "setStatus", status: "unsubscribed" }, 4354, 4486)).toBe(
      "Unsubscribed 4,354 of 4,486",
    )
  })
  it("reads a job's stored action defensively", () => {
    expect(readAction({ action: "addTopic", topicId: "top_live" })).toEqual({
      action: "addTopic",
      topicId: "top_live",
    })
    expect(readAction({ action: "setStatus", status: "weird" })).toBeNull()
    expect(readAction(null)).toBeNull()
  })
})

describe("export", () => {
  it("passes a single status through", () => {
    expect(exportFilter({ status: "subscribed", field: ["plan:eq:pro"] })).toEqual({
      filter: { status: "subscribed", field: ["plan:eq:pro"] },
    })
  })
  it("refuses several statuses, which the export filter can't carry", () => {
    expect(exportFilter({ status: "subscribed,unconfirmed" })).toMatchObject({
      refused: expect.stringMatching(/one status/),
    })
  })
})

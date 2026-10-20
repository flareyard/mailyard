import { describe, expect, it } from "vitest"
import {
  actionName,
  actorLabel,
  apiQuery,
  diffLines,
  targetRoute,
  validateAudit,
  viewString,
} from "./logic.ts"

describe("filters", () => {
  it("keeps only valid search values", () => {
    expect(validateAudit({ actor: "key_1", from: "2026-10-01", to: "nope", action: "", extra: 1 })).toEqual({
      actor: "key_1",
      from: "2026-10-01",
    })
  })
  it("turns dates into whole UTC days in ms", () => {
    const q = apiQuery({ from: "2026-10-01", to: "2026-10-17", action: "settings." })
    expect(q.from).toBe(String(Date.UTC(2026, 9, 1)))
    expect(q.to).toBe(String(Date.UTC(2026, 9, 17, 23, 59, 59, 999)))
    expect(q.limit).toBe("50")
    expect(apiQuery({ cursor: "c1", actor: "root" }, "csv")).toEqual({ actor: "root", format: "csv" })
  })
  it("echoes the view without paging", () => {
    expect(viewString({ from: "2026-10-01", cursor: "x" })).toBe("?from=2026-10-01")
    expect(viewString({})).toBe("(every entry)")
  })
})

describe("names and links", () => {
  it("names known and unknown actions", () => {
    expect(actionName("settings.brand")).toBe("Changed the brand")
    expect(actionName("segment.create")).toBe("Segment create")
  })
  it("links targets", () => {
    expect(targetRoute({ type: "campaign", id: "cmp_1" })).toBe("/campaigns/cmp_1")
    expect(targetRoute({ type: "settings", id: "compliance" })).toBe("/settings/tracking")
    expect(targetRoute({ type: "address", id: "a@b.c" })).toBeNull()
    expect(targetRoute(null)).toBeNull()
  })
  it("labels actors", () => {
    expect(actorLabel({ type: "root", id: "root", name: "" }).name).toBe("Admin key")
    expect(actorLabel({ type: "key", id: "key_1", name: "Ops laptop" })).toEqual({
      name: "Ops laptop",
      sub: "key · key_1",
    })
  })
})

describe("diffs", () => {
  it("lists changed keys only", () => {
    expect(diffLines({ trackClicksDefault: null, a: 1 }, { trackClicksDefault: true, a: 1 })).toEqual([
      { key: "trackClicksDefault", from: "null", to: "true" },
    ])
  })
  it("marks new and removed", () => {
    expect(diffLines(undefined, { to: "ada@x.com" })).toEqual([{ key: "to", from: "new", to: '"ada@x.com"' }])
    expect(diffLines({ a: 1 }, null)).toEqual([{ key: "a", from: "1", to: "removed" }])
    expect(diffLines(null, null)).toEqual([])
    expect(diffLines("x", "y")).toEqual([{ key: "value", from: '"x"', to: '"y"' }])
  })
})

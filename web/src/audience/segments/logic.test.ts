import { describe, expect, it } from "vitest"
import {
  addValue,
  appendTo,
  canNestAt,
  coerce,
  forContact,
  type Group,
  getAt,
  leafText,
  numberParams,
  parsePath,
  pathString,
  type Rule,
  removeAt,
  ruleSummary,
  ruleText,
  tokenizeSql,
  updateAt,
  validate,
  withOp,
  withoutLast,
} from "./logic.ts"

const tree: Group = {
  type: "all",
  rules: [
    { type: "topic", topicId: "top_courses", state: "subscribed" },
    {
      type: "any",
      rules: [
        { type: "engagement", in: ["active"] },
        { type: "event", name: "lesson_completed", withinDays: 7 },
        { type: "campaign", activity: "clicked", withinDays: 30 },
      ],
    },
    { type: "field", field: "country", op: "in", value: ["NG", "GH", "KE"] },
  ],
}

describe("paths", () => {
  it("round-trips the API's path format", () => {
    expect(pathString([1, 0])).toBe("filter.rules[1].rules[0]")
    expect(parsePath("filter.rules[1].rules[0]")).toEqual([1, 0])
    expect(parsePath("filter")).toEqual([])
    expect(parsePath("name")).toBeNull()
    expect(parsePath("filter.rules[x]")).toBeNull()
  })
  it("reads, updates and removes by path without touching the original", () => {
    expect(getAt(tree, [1, 1])).toEqual({ type: "event", name: "lesson_completed", withinDays: 7 })
    const next = updateAt(tree, [1, 0], () => ({ type: "engagement", in: [] }))
    expect((getAt(next, [1, 0]) as { in: string[] }).in).toEqual([])
    expect((getAt(tree, [1, 0]) as { in: string[] }).in).toEqual(["active"])
    const fewer = removeAt(tree, [1]) as Group
    expect(fewer.rules).toHaveLength(2)
    expect(tree.rules).toHaveLength(3)
    const more = appendTo(tree, [1], { type: "created", withinDays: 3 }) as Group
    expect((more.rules[1] as Group).rules).toHaveLength(4)
  })
  it("stops nesting at four deep", () => {
    expect(canNestAt([])).toBe(true)
    expect(canNestAt([0, 0])).toBe(true)
    expect(canNestAt([0, 0, 0])).toBe(false)
  })
})

describe("validate mirrors the API", () => {
  it("accepts a good tree", () => expect(validate(tree)).toBeNull())
  it("names the empty list with the API's message and path", () => {
    const bad = updateAt(tree, [1, 0], () => ({ type: "engagement", in: [] }))
    expect(validate(bad)).toEqual({ path: "filter.rules[1].rules[0]", message: "Pick at least one value." })
  })
  it("checks in lists, operator values and text operators", () => {
    const f = (r: Rule) => validate({ type: "all", rules: [r] })?.message
    expect(f({ type: "field", field: "plan", op: "in", value: [] })).toBe(
      'The "in" operator takes a list of 1 to 50 values.',
    )
    expect(f({ type: "field", field: "plan", op: "eq" })).toBe('The "eq" operator needs a value.')
    expect(f({ type: "field", field: "plan", op: "eq", value: ["a"] })).toBe(
      'Only the "in" operator takes a list.',
    )
    expect(f({ type: "field", field: "n", op: "contains", value: 3 })).toBe(
      'The "contains" operator compares text.',
    )
    expect(f({ type: "field", field: "9bad", op: "exists" })).toBe('"9bad" isn\'t a field name.')
    expect(f({ type: "created" })).toBe("Give withinDays, olderThanDays or both.")
    expect(f({ type: "event", name: "" })).toBe("An event name is 1 to 100 characters.")
    expect(f({ type: "campaign", activity: "received", includeMachine: true })).toBe(
      "includeMachine goes with opened or clicked.",
    )
  })
  it("caps depth and leaves", () => {
    const deep: Rule = {
      type: "all",
      rules: [
        {
          type: "all",
          rules: [{ type: "all", rules: [{ type: "all", rules: [{ type: "any", rules: [] }] }] }],
        },
      ],
    }
    expect(validate(deep)?.message).toBe("Groups nest at most 4 deep.")
    const many: Rule = {
      type: "all",
      rules: Array.from({ length: 51 }, () => ({ type: "created" as const, withinDays: 1 })),
    }
    expect(validate(many)).toEqual({ path: "filter.rules[50]", message: "At most 50 rules in a segment." })
  })
})

describe("values", () => {
  it("adds chips trimmed, without repeats ignoring case, 50 at most", () => {
    expect(addValue(["NG"], "gh, ng ,KE")).toEqual(["NG", "gh", "KE"])
    expect(addValue([], "1,250", "number")).toEqual([1, 250])
    expect(
      addValue(
        Array.from({ length: 50 }, (_, i) => `v${i}`),
        "x",
      ),
    ).toHaveLength(50)
  })
  it("coerces by field type", () => {
    expect(coerce("1,250", "number")).toBe(1250)
    expect(coerce("abc", "number")).toBe("abc")
    expect(coerce("true", "boolean")).toBe(true)
  })
  it("keeps a value in the shape each operator takes", () => {
    const r = { type: "field" as const, field: "plan", op: "eq" as const, value: "pro" }
    expect(withOp(r, "in").value).toEqual(["pro"])
    expect(withOp({ ...r, op: "in", value: ["a", "b"] }, "eq").value).toBe("a")
    expect("value" in withOp(r, "exists")).toBe(false)
  })
})

describe("words", () => {
  const names = { topic: (id: string) => (id === "top_courses" ? "New courses" : undefined) }
  it("reads leaves as sentences", () => {
    expect(leafText({ type: "campaign", activity: "clicked", withinDays: 30 })).toBe(
      "clicked any campaign in the last 30 days",
    )
    expect(leafText({ type: "topic", topicId: "top_courses", is: false }, names)).toBe(
      "topic New courses isn’t subscribed",
    )
    expect(leafText({ type: "field", field: "country", op: "in", value: ["NG", "GH"] })).toBe(
      "country is any of NG, GH",
    )
  })
  it("reads a tree with its conjunctions", () => {
    const s = ruleText(tree, names)
    expect(s.text).toBe("all")
    expect(s.children?.[1]?.conj).toBe("and")
    expect(s.children?.[1]?.children?.[1]?.conj).toBe("or")
    expect(ruleSummary(tree, names)).toMatch(
      /^Topic New courses is subscribed · engagement is active, or did/,
    )
  })
})

describe("previews", () => {
  it("drops the last rule to say what nothing-matches would be without it", () => {
    expect((withoutLast(tree) as Group).rules).toHaveLength(2)
    expect(withoutLast({ type: "any", rules: tree.rules })).toBeNull()
  })
  it("tests one contact by adding email = address", () => {
    expect(forContact(tree, " ada@x.io ")).toEqual({
      type: "all",
      rules: [tree, { type: "field", field: "email", op: "eq", value: "ada@x.io" }],
    })
  })
  it("numbers placeholders and splits SQL into tokens", () => {
    expect(numberParams("a = ? AND b = ?")).toBe("a = ?1 AND b = ?2")
    expect(numberParams("a = ?1")).toBe("a = ?1")
    const t = tokenizeSql("SELECT c.* FROM contacts c WHERE c.id = ?1")
    expect(t.filter((x) => x.t === "kw").map((x) => x.s)).toEqual(["SELECT", "FROM", "WHERE"])
    expect(t.filter((x) => x.t === "pm").map((x) => x.s)).toEqual(["?1"])
    expect(t.map((x) => x.s).join("")).toBe("SELECT c.* FROM contacts c WHERE c.id = ?1")
  })
})

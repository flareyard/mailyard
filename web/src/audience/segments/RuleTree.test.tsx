// @vitest-environment jsdom
/**
 * The rule tree in jsdom: a 400's `field` path outlines exactly that rule with its message, edits go through
 * immutably with the tree's shape kept, and the value-chip box takes Enter, comma and Backspace.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Group } from "./logic.ts"
import { RuleTree, type TreeCtx } from "./RuleTree.tsx"
import { ValueChips } from "./ValueChips.tsx"

afterEach(cleanup)

const last = (fn: ReturnType<typeof vi.fn>): Group => {
  const call = fn.mock.lastCall
  if (!call) throw new Error("onChange wasn’t called")
  return call[0] as Group
}

const tree: Group = {
  type: "all",
  rules: [
    { type: "topic", topicId: "top_courses", state: "subscribed" },
    {
      type: "any",
      rules: [
        { type: "engagement", in: [] },
        { type: "event", name: "lesson_completed", withinDays: 7 },
      ],
    },
  ],
}
const ctx = (error: TreeCtx["error"] = null): TreeCtx => ({
  topics: [{ id: "top_courses", name: "New courses" }],
  campaigns: [],
  fields: [{ key: "country", label: "Country", type: "string" }],
  error,
})

function Harness({
  initial,
  error,
  onChange,
}: {
  initial: Group
  error?: TreeCtx["error"]
  onChange?: (g: Group) => void
}) {
  const [g, setG] = useState(initial)
  return (
    <RuleTree
      root={g}
      ctx={ctx(error ?? null)}
      onChange={(n) => {
        setG(n)
        onChange?.(n)
      }}
    />
  )
}

describe("RuleTree", () => {
  it("outlines only the rule a 400 names, with the message and the path", () => {
    const { container } = render(
      <Harness
        initial={tree}
        error={{ path: "filter.rules[1].rules[0]", message: "Pick at least one value." }}
      />,
    )
    const bad = container.querySelectorAll(".rule.is-error")
    expect(bad).toHaveLength(1)
    expect(bad[0]?.getAttribute("data-path")).toBe("filter.rules[1].rules[0]")
    expect(bad[0]?.getAttribute("aria-invalid")).toBe("true")
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Pick at least one value.")
    expect(alert.textContent).toContain("filter.rules[1].rules[0]")
  })

  it("switches a group between all and any, and adds and removes rules", () => {
    const onChange = vi.fn()
    const { container } = render(<Harness initial={tree} onChange={onChange} />)
    const group = container.querySelector('[data-od-id="rule-group"]') as HTMLElement
    fireEvent.click(within(group).getByRole("button", { name: "all" }))
    expect(last(onChange).rules[1]).toMatchObject({ type: "all" })
    fireEvent.click(within(group).getAllByRole("button", { name: /Rule$/ })[0] as HTMLElement)
    expect((last(onChange).rules[1] as Group).rules).toHaveLength(3)
    fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[0] as HTMLElement)
    expect(last(onChange).rules).toHaveLength(1)
  })

  it("changes what a rule is on, starting it with sensible values", () => {
    const onChange = vi.fn()
    render(
      <Harness
        initial={{ type: "all", rules: [{ type: "status", in: ["subscribed"] }] }}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText("Rule on"), { target: { value: "field:country" } })
    expect(last(onChange).rules[0]).toEqual({
      type: "field",
      field: "country",
      op: "eq",
      value: "",
    })
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "in" } })
    expect(last(onChange).rules[0]).toEqual({
      type: "field",
      field: "country",
      op: "in",
      value: [],
    })
  })
})

describe("ValueChips", () => {
  function Chips({ choices }: { choices?: string[] }) {
    const [v, setV] = useState<(string | number | boolean)[]>(["NG"])
    return <ValueChips label="Values" values={v} onChange={setV} {...(choices ? { choices } : {})} />
  }
  it("adds on Enter and comma, removes the last on Backspace, and by the chip's button", () => {
    render(<Chips />)
    const box = screen.getByLabelText("Add a value")
    fireEvent.change(box, { target: { value: "GH" } })
    fireEvent.keyDown(box, { key: "Enter" })
    fireEvent.change(box, { target: { value: "ke" } })
    fireEvent.keyDown(box, { key: "," })
    expect(
      screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Remove NG", "Remove GH", "Remove ke"])
    fireEvent.keyDown(box, { key: "Backspace" })
    expect(screen.queryByRole("button", { name: "Remove ke" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Remove NG" }))
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1)
  })
  it("with choices, accepts only those values", () => {
    render(<Chips choices={["active", "cooling", "dormant", "ng"]} />)
    const box = screen.getByLabelText("Add a value")
    fireEvent.change(box, { target: { value: "bogus" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1)
    fireEvent.change(box, { target: { value: "cooling" } })
    expect(screen.getByRole("button", { name: "Remove cooling" })).toBeTruthy()
  })
})

// @vitest-environment jsdom
/** Field definitions in jsdom: reordering by arrows and by drag, adding by key, and a 400 marked on its row. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({ Link: () => null }))

import { FieldsSection } from "./FormEditor.tsx"
import type { FieldDef } from "./logic.ts"

afterEach(cleanup)

const start: FieldDef[] = [
  { key: "first_name", label: "First name", type: "text", required: true },
  { key: "role", label: "Role", type: "select", required: true, options: [] },
  { key: "company", label: "Company", type: "text", required: false },
]

function Harness({ problem = null }: { problem?: { field: string; message: string } | null }) {
  const [defs, setDefs] = useState(start)
  return (
    <>
      <FieldsSection
        defs={defs}
        legacy={false}
        badRow={problem ? 1 : null}
        problem={problem}
        onChange={setDefs}
      />
      <output data-testid="order">{defs.map((d) => d.key).join(",")}</output>
    </>
  )
}
const order = () => screen.getByTestId("order").textContent

describe("FieldsSection", () => {
  it("moves rows with the arrows, which stop at the ends", () => {
    render(<Harness />)
    expect((screen.getByRole("button", { name: "Move first_name up" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole("button", { name: "Move first_name down" }))
    expect(order()).toBe("role,first_name,company")
    fireEvent.click(screen.getByRole("button", { name: "Move company up" }))
    expect(order()).toBe("role,company,first_name")
  })
  it("moves a row by dragging it onto another", () => {
    const { container } = render(<Harness />)
    const rows = container.querySelectorAll("li[draggable]")
    const dataTransfer = { effectAllowed: "", setData: () => {} }
    fireEvent.dragStart(rows[2] as Element, { dataTransfer })
    fireEvent.dragOver(rows[0] as Element, { dataTransfer })
    fireEvent.drop(rows[0] as Element, { dataTransfer })
    expect(order()).toBe("company,first_name,role")
  })
  it("adds a field by key and refuses a reserved or repeated one", () => {
    render(<Harness />)
    const box = screen.getByLabelText("New field key")
    fireEvent.change(box, { target: { value: "email" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByRole("alert").textContent).toContain("Email and name are always on the form.")
    fireEvent.change(box, { target: { value: "country" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(order()).toBe("first_name,role,company,country")
  })
  it("marks the row a 400 names, with the message and path", () => {
    const { container } = render(
      <Harness problem={{ field: "fieldDefs[1].options", message: "A select has 1 to 50 options." }} />,
    )
    const bad = container.querySelectorAll(".fd-row.is-error")
    expect(bad).toHaveLength(1)
    expect(bad[0]?.getAttribute("data-path")).toBe("fieldDefs[1]")
    expect(bad[0]?.textContent).toContain("A select has 1 to 50 options.")
    expect(bad[0]?.textContent).toContain("fieldDefs[1].options")
  })
})

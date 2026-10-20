// @vitest-environment jsdom
/**
 * The canvas by keyboard (HANDOFF-audience §7): every step is a button in drawing order so Tab reaches it and
 * Enter opens it; `+`, `−` and `0` zoom and fit; Esc closes the inspector; arrow keys pan the canvas.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Canvas } from "./Canvas.tsx"
import { type Graph, layoutGraph } from "./logic.ts"

const graph: Graph = {
  nodes: [
    { id: "n_trigger", type: "trigger", config: { kind: "event", event: "signed_up" } },
    { id: "n_wait", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
    {
      id: "n_cond",
      type: "branch",
      label: "Viewed a course?",
      config: { kind: "event", event: "course_viewed" },
    },
    { id: "n_yes", type: "exit", config: {} },
    {
      id: "n_no",
      type: "send",
      label: "Did you see this?",
      config: { templateId: "tpl", version: "published" },
    },
    { id: "n_end", type: "exit", config: {} },
  ],
  edges: [
    { from: "n_trigger", to: "n_wait" },
    { from: "n_wait", to: "n_cond" },
    { from: "n_cond", to: "n_yes", port: "yes" },
    { from: "n_cond", to: "n_no", port: "no" },
    { from: "n_no", to: "n_end" },
  ],
}

function setup(over: Partial<Parameters<typeof Canvas>[0]> = {}) {
  const onSelect = vi.fn()
  const onZoom = vi.fn()
  const onInsert = vi.fn()
  const canvasRef = createRef<HTMLElement>()
  const innerRef = createRef<HTMLDivElement>()
  render(
    <Canvas
      layout={layoutGraph(graph)}
      names={{}}
      selected={null}
      onSelect={onSelect}
      issues={new Map([["n_no", [{ nodeId: "n_no", code: "missing_content", message: "Pick a template." }]]])}
      counts={{ n_wait: { here: 23, passed: 1181, failed: 0 } }}
      overlay={null}
      editable
      redacted={false}
      onInsert={onInsert}
      zoom={1}
      onZoom={onZoom}
      canvasRef={canvasRef}
      innerRef={innerRef}
      {...over}
    />,
  )
  return { onSelect, onZoom, onInsert, canvas: () => canvasRef.current as HTMLElement }
}

afterEach(cleanup)

describe("Canvas", () => {
  it("draws every step as a button, in drawing order, with its state classes", () => {
    setup()
    const nodes = [...document.querySelectorAll<HTMLButtonElement>("button[data-node]")]
    expect(nodes.map((n) => n.dataset.node)).toEqual([
      "n_trigger",
      "n_wait",
      "n_cond",
      "n_yes",
      "n_no",
      "n_end",
    ])
    expect(nodes[0]?.className).toContain("is-trigger")
    expect(nodes[4]?.className).toContain("is-invalid")
    expect(screen.getByText("Pick a template.")).toBeTruthy()
    expect(screen.getByText("23 here").className).toBe("ncount is-here")
    expect(screen.getByText("Yes")).toBeTruthy()
    expect(screen.getByText("No")).toBeTruthy()
  })

  it("opens a step on click (and so on Enter, as a button)", () => {
    const { onSelect } = setup()
    fireEvent.click(screen.getByText("Viewed a course?").closest("button") as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith("n_cond")
  })

  it("zooms with + and −, fits with 0", () => {
    const { onZoom, canvas } = setup()
    fireEvent.keyDown(canvas(), { key: "+" })
    fireEvent.keyDown(canvas(), { key: "-" })
    fireEvent.keyDown(canvas(), { key: "0" })
    expect(onZoom.mock.calls).toEqual([[1.1], [0.9], ["fit"]])
  })

  it("closes the inspector on Esc only when a step is open", () => {
    const closed = setup()
    fireEvent.keyDown(closed.canvas(), { key: "Escape" })
    expect(closed.onSelect).not.toHaveBeenCalled()
    cleanup()
    const open = setup({ selected: "n_wait" })
    const sel = document.querySelector('[data-node="n_wait"]') as HTMLElement
    expect(sel.getAttribute("aria-pressed")).toBe("true")
    fireEvent.keyDown(sel, { key: "Escape" })
    expect(open.onSelect).toHaveBeenCalledWith(null)
  })

  it("pans with the arrow keys when the canvas itself has focus", () => {
    const { canvas } = setup()
    const el = canvas()
    el.scrollBy = vi.fn() as unknown as typeof el.scrollBy
    fireEvent.keyDown(el, { key: "ArrowRight" })
    fireEvent.keyDown(el, { key: "ArrowUp" })
    expect(el.scrollBy).toHaveBeenNthCalledWith(1, { left: 48, top: 0 })
    expect(el.scrollBy).toHaveBeenNthCalledWith(2, { left: 0, top: -48 })
  })

  it("offers to add a step on an edge when editable, and not when read-only", () => {
    const { onInsert } = setup()
    const adds = screen.getAllByRole("button", { name: "Add a step here" })
    expect(adds.length).toBeGreaterThan(0)
    fireEvent.click(adds[0] as HTMLElement)
    expect(onInsert).toHaveBeenCalledWith("n_trigger", undefined)
    cleanup()
    setup({ editable: false })
    expect(screen.queryAllByRole("button", { name: "Add a step here" })).toHaveLength(0)
  })

  it("draws a dry run: the path numbered, skipped steps dashed, the rest not taken", () => {
    setup({
      overlay: {
        order: new Map([
          ["n_trigger", 1],
          ["n_wait", 2],
          ["n_cond", 3],
          ["n_no", 4],
        ]),
        skipped: new Set(["n_no"]),
        failed: new Set(),
        ports: new Set(["n_cond:no"]),
        why: new Map([["n_no", "first_name"]]),
      },
    })
    const no = document.querySelector('[data-node="n_no"]') as HTMLElement
    expect(no.className).toContain("is-skipped")
    expect(no.className).not.toContain("is-path")
    expect(screen.getByText("Skipped · no first_name")).toBeTruthy()
    expect((document.querySelector('[data-node="n_wait"]') as HTMLElement).className).toContain("is-path")
    expect((document.querySelector('[data-node="n_yes"]') as HTMLElement).className).toContain("is-off")
    expect(screen.queryAllByRole("button", { name: "Add a step here" })).toHaveLength(0)
  })
})

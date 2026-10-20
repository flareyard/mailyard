// @vitest-environment jsdom
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { FlareyardMark } from "./FlareyardMark.tsx"

describe("FlareyardMark (HAL-3494)", () => {
  it("draws the ink in currentColor so it follows the theme, and keeps one ember square", () => {
    const { container } = render(<FlareyardMark />)
    const rects = [...container.querySelectorAll("rect")]
    expect(rects).toHaveLength(6)
    expect(rects.filter((r) => r.getAttribute("fill") === "currentColor")).toHaveLength(5)
    const flare = rects.filter((r) => r.classList.contains("fy-flare"))
    expect(flare).toHaveLength(1)
    expect(flare[0]?.getAttribute("fill")).toBeNull()
    expect(container.querySelector("svg")?.classList.contains("fy-mark")).toBe(true)
    // No fixed ink colour anywhere: the old <img> carried #171717, invisible on a dark background.
    expect(container.innerHTML).not.toMatch(/#171717/i)
  })
})

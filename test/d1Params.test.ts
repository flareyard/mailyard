import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * HAL-3425: D1 binds at most 100 parameters a statement, so an `inArray` over a list that can grow
 * fails in production with an empty error. Every `inArray` in src must take a chunk (`queryIn`,
 * `chunksOf`, a `slice` of at most 90), a literal list, or carry a `d1: bounded` comment within the
 * three lines above it saying why the list stays small.
 */
const root = path.join(import.meta.dirname, "../src")
const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []
  })

const SAFE = [
  /inArray\([^,]+,\s*chunk\b/, // queryIn / chunksOf
  /inArray\([^,]+,\s*\[\s*["']/, // a literal list
  /inArray\([^,]+,\s*(\[\.\.\.)?(part|slice)\b/, // a loop over slices of 90
  /inArray\([^,]+,\s*[\w.]+\.slice\(\s*(0|i)\s*,\s*(90|i \+ 90|i \+ ID_SLICE)\s*\)/, // an explicit slice
]

describe("D1's 100-parameter limit (HAL-3425)", () => {
  it("every inArray in src is chunked, literal, or marked bounded", () => {
    const flagged: Array<string> = []
    for (const file of files(root)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!line.includes("inArray(")) return
        // The call may wrap: read it with the next two lines.
        const call = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(" ").replace(/\s+/g, " ")
        if (SAFE.some((re) => re.test(call))) return
        const above = lines.slice(Math.max(0, i - 3), i + 1).join("\n")
        if (/d1: bounded/.test(above)) return
        if (/^\s*(import|\/\/|\*)/.test(line)) return
        flagged.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(flagged).toEqual([])
  })
})

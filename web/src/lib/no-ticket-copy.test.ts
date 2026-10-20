/**
 * People using Mailyard never read a ticket number (HAL-3737). The founder found "Built · HAL-…",
 * "Planned · HAL-…" and "arrives with HAL-…" across the app, and many of those claims had gone stale. Ticket
 * ids may live in comments, `data-endpoint` / `data-issue` attributes and the `issue` / `built` props of the
 * design-review markers (which render only in sample-data and dev mode); anywhere else in a component, a
 * `HAL-1234` would reach the screen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = path.join(import.meta.dirname, "..")

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return name === "fixtures" ? [] : files(p)
    // Components and the .ts modules that hold their sentences; tests, fixtures and generated types aside.
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|fixture|\.d\.ts$/i.test(name) ? [p] : []
  })

/** Places a ticket id is allowed: never shown, or shown only to reviewers. */
const ALLOWED = [
  /^\s*(\/\/|\*|\/\*|\{\/\*)/, // comments
  /data-endpoint=|data-issue=|data-od-id=|\bendpoint=/,
  /\b(issue|built)=["{]/,
  /\b(issue|built): ?["`]/,
  /\bENDPOINT\b/,
  /\((built|planned)[,:][^)]*HAL-\d+/, // endpoint annotations: "(built, HAL-3416, HAL-3464)"
]

describe("no ticket numbers in what people read", () => {
  it("keeps HAL-#### out of user-facing copy", () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!/HAL-\d{3,}/.test(line)) return
        if (ALLOWED.some((re) => re.test(line))) return
        offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

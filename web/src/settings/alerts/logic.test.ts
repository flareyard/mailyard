import { describe, expect, it } from "vitest"
import {
  ALERT_KINDS,
  fieldTarget,
  kindsLabel,
  newRow,
  rowProblems,
  toBody,
  toRows,
  unsavedLine,
} from "./logic.ts"

describe("rows and body", () => {
  it("round-trips channels, dropping kinds when it's every kind", () => {
    const rows = toRows([
      { kind: "email", target: " ops@x.com ", minSeverity: "warning" },
      { kind: "webhook", target: "whk_1", kinds: ["quota_100"], minSeverity: "critical" },
    ])
    expect(rows[0]?.kinds).toEqual([])
    expect(toBody(rows, "  ")).toEqual({
      channels: [
        { kind: "email", target: "ops@x.com", minSeverity: "warning" },
        { kind: "webhook", target: "whk_1", kinds: ["quota_100"], minSeverity: "critical" },
      ],
      defaultEmail: null,
    })
  })
})

describe("unsaved", () => {
  const saved = {
    channels: [{ kind: "email" as const, target: "ops@x.com", minSeverity: "warning" as const }],
    defaultEmail: null,
  }
  it("says nothing when nothing changed, kind order aside", () => {
    expect(unsavedLine(saved, toRows(saved.channels), "")).toBeNull()
    const s2 = {
      channels: [
        {
          kind: "email" as const,
          target: "a@x.com",
          kinds: ["quota_80", "dns_drift"] as never,
          minSeverity: "info" as const,
        },
      ],
      defaultEmail: null,
    }
    const rows = toRows(s2.channels)
    if (rows[0]) rows[0].kinds = ["dns_drift", "quota_80"]
    expect(unsavedLine(s2, rows, "")).toBeNull()
  })
  it("names what changed", () => {
    const rows = [...toRows(saved.channels), newRow()]
    expect(unsavedLine(saved, rows, "")).toBe("Unsaved: 1 channel added.")
    const edited = toRows(saved.channels)
    if (edited[0]) edited[0].minSeverity = "critical"
    expect(unsavedLine(saved, edited, "boss@x.com")).toBe(
      "Unsaved: 1 channel changed, the default address changed.",
    )
    expect(unsavedLine(saved, [], "")).toBe("Unsaved: 1 channel removed.")
  })
})

describe("problems and refusals", () => {
  it("checks targets before saving", () => {
    const rows = [
      newRow("email"),
      { ...newRow("email"), target: "nope" },
      newRow("webhook"),
      { ...newRow(), target: "a@b.co" },
    ]
    const p = rowProblems(rows)
    expect(p.get(0)).toMatch(/Enter an email/)
    expect(p.get(1)).toMatch(/isn’t an email/)
    expect(p.get(2)).toMatch(/webhook endpoint/)
    expect(p.has(3)).toBe(false)
  })
  it("maps a 400 field to its row", () => {
    expect(fieldTarget("channels[2].target")).toEqual({ row: 2, key: "target" })
    expect(fieldTarget("channels[10].minSeverity")).toEqual({ row: 10, key: "minSeverity" })
    expect(fieldTarget("defaultEmail")).toEqual({ defaultEmail: true })
    expect(fieldTarget("channels.target")).toBeNull()
    expect(fieldTarget(undefined)).toBeNull()
  })
  it("labels kinds", () => {
    expect(ALERT_KINDS).toHaveLength(15)
    expect(kindsLabel([])).toBe("Every kind")
    expect(kindsLabel(["quota_80", "dns_drift"])).toBe("2 of 15")
  })
})

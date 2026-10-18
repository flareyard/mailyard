import { readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_THEME } from "../../src/templates/kit.ts"
import { LIBRARY, toSource } from "../../src/templates/library/index.ts"
import {
  missingVariables,
  renderTemplate,
  validateTemplate,
  variablesOf,
} from "../../src/templates/render.ts"

/**
 * HAL-3304: every template in the repo's library renders with its own sample data, the way a real
 * send would. A new template is covered by adding it to LIBRARY; nothing here needs editing.
 */
const brand = { theme: DEFAULT_THEME, siteUrl: "https://example.com", tagline: "Sent with Mailyard." }
const dir = path.join(import.meta.dirname, "../../src/templates/library")

describe("the template library", () => {
  it("lists every template file once, under its own slug", () => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "types.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort()
    expect(LIBRARY.map((t) => t.slug).sort()).toEqual(files)
    expect(new Set(LIBRARY.map((t) => t.name)).size).toBe(LIBRARY.length)
    for (const t of LIBRARY) expect(t.slug, t.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  for (const t of LIBRARY) {
    describe(t.slug, () => {
      const source = toSource(t)

      it("is a valid template", () => {
        expect(validateTemplate(source)).toBeUndefined()
        expect(t.description.length).toBeGreaterThan(0)
      })

      it("has a sample for every required placeholder", () => {
        const { required } = variablesOf(source.subject, source.source, source.text ?? "")
        expect(missingVariables(required, t.sample)).toEqual([])
      })

      it("renders its sample with nothing left unfilled", () => {
        const out = renderTemplate(source, t.sample, brand)
        expect(out.subject.length).toBeGreaterThan(0)
        for (const part of [out.subject, out.html, out.text]) expect(part).not.toContain("{{")
        expect(out.text.trim().length).toBeGreaterThan(0)
        expect(out.html).toContain("<html")
      })
    })
  }
})

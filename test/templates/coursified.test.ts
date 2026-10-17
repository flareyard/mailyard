import { describe, expect, it } from "vitest"
import { DEFAULT_BRAND, toBrand } from "../../src/domain/brand.ts"
import { renderTemplate, validateTemplate } from "../../src/templates/render.ts"
import expected from "../../tools/coursified/generated/expected.json"
import templates from "../../tools/coursified/generated/templates.json"

/**
 * HAL-3383: Coursified's lifecycle emails, ported by tools/coursified/port.ts from Coursified's own
 * render functions. For every sample, Mailyard renders the ported template with the data Coursified
 * would track (tools/coursified/data.ts) and must produce exactly what Coursified's function does.
 */
type Out = { subject: string; html: string; text: string }
const ported = templates as Record<string, { name: string } & Out>
const brand = toBrand(DEFAULT_BRAND)

describe("Coursified lifecycle templates ported to Mailyard", () => {
  it("are valid Mailyard templates", () => {
    for (const [key, t] of Object.entries(ported))
      expect(
        validateTemplate({ kind: "html", subject: t.subject, source: t.html, text: t.text }),
        key,
      ).toBeUndefined()
  })

  for (const [i, sample] of (
    expected as Array<{ key: string; data: Record<string, unknown>; expected: Out }>
  ).entries()) {
    it(`render ${sample.key} #${i} exactly as Coursified does`, () => {
      const t = ported[sample.key]
      if (!t) throw new Error(`no ported template for ${sample.key}`)
      const out = renderTemplate(
        { kind: "html", subject: t.subject, source: t.html, text: t.text },
        // What an automation send passes: the tracked event's data, and the unsubscribe link
        // (here Coursified's settings page, the link its own footer carries).
        { trigger: sample.data, unsubscribe_url: "https://coursified.app/settings" },
        brand,
      )
      expect(out.subject).toBe(sample.expected.subject)
      expect(out.html).toBe(sample.expected.html)
      expect(out.text).toBe(sample.expected.text)
    })
  }
})

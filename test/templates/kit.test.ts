import { describe, expect, it } from "vitest"
import { createKit, MBPREP_THEME } from "../../src/templates/kit.ts"
import golden from "../fixtures/mbprep-kit/golden.json" with { type: "json" }
import scenarios from "../fixtures/mbprep-kit/scenarios.json" with { type: "json" }

// golden.json is MBPrep's own kit output for scenarios.json (tools/gen-mbprep-golden.ts).
describe("the kit with MBPrep's theme", () => {
  const kit = createKit(MBPREP_THEME) as unknown as Record<string, (...args: Array<unknown>) => unknown>

  it.each(scenarios.map(([name, args], i) => [name as string, args as Array<unknown>, i] as const))(
    "%s renders byte for byte what MBPrep sends",
    (name, args, i) => {
      expect(kit[name]?.(...args)).toEqual(golden.blocks[i])
    },
  )

  it("lays out a whole message byte for byte", () => {
    const blocks = scenarios
      .map(([name, args]) => kit[name as string]?.(...(args as Array<unknown>)))
      .filter((b): b is { html: string; text: string } => typeof b === "object" && b !== null)
    const layout = kit.layout?.({
      preheader: "Your sign-in code <inside>",
      label: "Week 38 · UI MB4",
      blocks,
      footer: {
        reason: "You asked to sign in.",
        links: [{ label: "Preferences", url: "https://mbprep.app/p?x=1&y=2" }],
      },
      siteUrl: "https://mbprep.app",
      tagline: "Every past question for your MB, solved.",
    })
    expect(layout).toEqual(golden.layout)
  })
})

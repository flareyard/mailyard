// Regenerates test/fixtures/mbprep-kit/golden.json from MBPrep's own kit, for the byte-for-byte test.
// Usage: bun tools/gen-mbprep-golden.ts <path to MBPrep's apps/api/src/emails/kit.ts>
import scenarios from "../test/fixtures/mbprep-kit/scenarios.json" with { type: "json" }

const kitPath = process.argv[2]
if (!kitPath) throw new Error("usage: bun tools/gen-mbprep-golden.ts <MBPrep kit.ts>")
const kit = (await import(kitPath)) as Record<string, (...args: Array<unknown>) => unknown>
const blocks = scenarios.map(([name, args]) => {
  const fn = kit[name as string]
  if (!fn) throw new Error(`MBPrep's kit has no ${name}`)
  return fn(...(args as Array<unknown>))
})
const layout = (kit.layout as (l: unknown) => unknown)({
  preheader: "Your sign-in code <inside>",
  label: "Week 38 · UI MB4",
  blocks: blocks.filter((b): b is { html: string; text: string } => typeof b === "object" && b !== null),
  footer: {
    reason: "You asked to sign in.",
    links: [{ label: "Preferences", url: "https://mbprep.app/p?x=1&y=2" }],
  },
  siteUrl: "https://mbprep.app",
  tagline: "Every past question for your MB, solved.",
})
await Bun.write(
  new URL("../test/fixtures/mbprep-kit/golden.json", import.meta.url),
  `${JSON.stringify({ blocks, layout }, null, 1)}\n`,
)
console.log(`wrote ${blocks.length} blocks and a layout`)

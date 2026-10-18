/**
 * Renders every state of the public pages (HAL-3377) to static HTML for the responsive audit:
 * `bun tools/public/preview.ts <dir>`, then serve <dir> and run the audit over the files. The pages
 * are built by the same functions the Worker uses (src/public/pages.ts), in Flareyard's look and in
 * a sender's brand, with long names and the compliance footer so the narrow sizes are tested hard.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrandSettings } from "../../src/domain/brand.ts"
import { invalidLinkPage, type Look, type Prefs, preferencePage, resultPage } from "../../src/public/pages.ts"
import { pageTheme } from "../../src/public/shell.ts"

const dir = process.argv[2] ?? "public-preview"
mkdirSync(dir, { recursive: true })

const brand: BrandSettings = {
  name: "Coursified Learning Platform",
  siteUrl: "https://coursified.example",
  tagline: "Learn",
  colors: { indigo: "#0a7d55" },
}
const looks: Record<string, Look> = {
  flareyard: {
    theme: pageTheme(null),
    postalAddress: "Suite 4, 12 Admiralty Way, Lekki Phase 1, Lagos 106104, Nigeria",
    privacyUrl: "https://example.org/privacy",
  },
  brand: { theme: pageTheme(brand), postalAddress: null, privacyUrl: null },
}

const topics: Prefs["topics"] = [
  {
    id: "t1",
    name: "Weekly product updates and release notes",
    description: "Every Monday: what shipped, what's next, and the occasional long read about how we build.",
    subscribed: true,
  },
  { id: "t2", name: "Offers", description: null, subscribed: false },
  { id: "t3", name: "Webinars", description: "Live sessions, a few times a quarter.", subscribed: true },
]
const base: Prefs = {
  email: "ad••••••••••••••@verylongcompanydomainname.example",
  unsubscribedFromAll: false,
  resubscribeUntil: null,
  blocked: false,
  focusTopicId: "t1",
  topics,
}

const states: Record<string, (look: Look) => Response> = {
  "u-focus": (l) => preferencePage(l, base, null),
  "u-saved": (l) => preferencePage(l, base, { kind: "success", html: "Your choices are saved." }),
  "u-all": (l) =>
    preferencePage(
      l,
      {
        ...base,
        unsubscribedFromAll: true,
        resubscribeUntil: Date.UTC(2026, 9, 19, 9, 30),
        topics: topics.map((t) => ({ ...t, subscribed: false })),
      },
      {
        kind: "success",
        html: "You're unsubscribed from everything. You won't get any more of these emails.",
      },
    ),
  "u-all-later": (l) =>
    preferencePage(
      l,
      {
        ...base,
        focusTopicId: null,
        unsubscribedFromAll: true,
        resubscribeUntil: Date.UTC(2026, 9, 19, 9, 30),
      },
      null,
    ),
  "u-blocked": (l) => preferencePage(l, { ...base, blocked: true }, null),
  "u-none": (l) => preferencePage(l, { ...base, topics: [], focusTopicId: null }, null),
  "u-invalid": (l) => invalidLinkPage(l),
  "c-confirmed": (l) =>
    resultPage(
      l,
      200,
      "You're subscribed",
      "Thanks: you'll now receive Weekly product updates and release notes.",
      {
        kind: "success",
        redirect: { url: "https://example.org/thanks", after: 3 },
      },
    ),
  "c-expired": (l) =>
    resultPage(l, 410, "This link has expired", "Sign up again and we'll send a fresh link."),
  "f-check-inbox": (l) =>
    resultPage(l, 200, "Check your inbox", "We've sent you a link to confirm your subscription.", {
      kind: "info",
    }),
  "f-error": (l) =>
    resultPage(l, 400, "Check your email address", "Enter a valid email address.", { kind: "danger" }),
}

const pages: Array<string> = []
for (const [lookName, look] of Object.entries(looks))
  for (const [state, build] of Object.entries(states)) {
    const name = `${state}-${lookName}`
    const html = await build(look)
      .text()
      // The redirect would leave the page mid-audit.
      .then((h) => h.replace(/<meta http-equiv="refresh"[^>]*>/, ""))
    writeFileSync(join(dir, `${name}.html`), html)
    pages.push(`${name}.html`)
  }
writeFileSync(join(dir, "pages.txt"), `${pages.join("\n")}\n`)
console.log(`${pages.length} pages in ${dir}`)

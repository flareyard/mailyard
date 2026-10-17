#!/usr/bin/env bun
/**
 * Ports Coursified's lifecycle templates (B1–B6) into Mailyard templates (HAL-3383), from
 * Coursified's own render functions rather than by hand:
 *
 * 1. Render each template with every prop set to a `{{trigger.name}}` sentinel, so the output is the
 *    Mailyard source.
 * 2. Optional parts become `{{#if}}…{{else}}…{{/if}}`: render with the prop and without, and wrap
 *    where the two differ. Lists become `{{#each}}`: render with one sentinel item and with none.
 * 3. A few spots Coursified computes (a number as a word, a plural, a clamped percentage) get a named
 *    patch to the data `data.ts` sends ready-made; each patch must match exactly once.
 * 4. The unsubscribe link becomes `{{unsubscribe_url}}`.
 *
 * It also renders the samples in data.ts with Coursified's functions, as the expected output the
 * snapshot test compares Mailyard's rendering with.
 *
 *   COURSIFIED_DIR=~/dev/coursified bun tools/coursified/port.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { dataFor, type LifecycleKey, SAMPLES } from "./data.ts"

type Out = { subject: string; html: string; text: string }
// biome-ignore lint/suspicious/noExplicitAny: Coursified's template functions, loaded from its repo.
type Fn = (props: any) => Out

const root = process.env.COURSIFIED_DIR ?? path.join(import.meta.dirname, "../../../coursified")
const load = async (name: LifecycleKey): Promise<Fn> => {
  const mod = (await import(path.join(root, "packages/emails/src/templates", `${name}.ts`))) as Record<
    string,
    Fn
  >
  const fn = mod[name]
  if (!fn) throw new Error(`${name} isn't exported by Coursified's ${name}.ts`)
  return fn
}

const t = (name: string) => `{{trigger.${name}}}`
const FIELDS = ["subject", "html", "text"] as const

const commonPrefix = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
const commonSuffix = (a: string, b: string, max: number) => {
  let i = 0
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/** Wraps where `on` and `off` differ in `{{#if cond}}on{{else}}off{{/if}}` (or `{{#each}}` for a list). */
const wrap = (on: string, off: string, open: string, close: string, withElse: boolean) => {
  if (on === off) return on
  const p = commonPrefix(on, off)
  const s = commonSuffix(on, off, Math.min(on.length, off.length) - p)
  const a = on.slice(p, on.length - s)
  const b = off.slice(p, off.length - s)
  return `${on.slice(0, p)}${open}${a}${withElse && b ? `{{else}}${b}` : ""}${close}${on.slice(on.length - s)}`
}

const patch = (out: Out, field: (typeof FIELDS)[number], from: string, to: string) => {
  const count = out[field].split(from).length - 1
  if (count !== 1) throw new Error(`patch "${from}" matches ${count} times in ${field}`)
  out[field] = out[field].replace(from, to)
}

/** Applies a two-way variant to every field: render with and without, and wrap the difference. */
const variant = (with_: Out, without: Out, open: string, close: string, withElse = true): Out => ({
  subject: wrap(with_.subject, without.subject, open, close, withElse),
  html: wrap(with_.html, without.html, open, close, withElse),
  text: wrap(with_.text, without.text, open, close, withElse),
})

const UNSUBSCRIBE = /href="https:\/\/coursified\.app\/settings"/g

/**
 * What Coursified means to send, where its layout escapes twice (HAL-3384): `renderEmail` escapes
 * the footer that welcome and retakeUnlocked already escaped, and `listRows` escapes the markup
 * activationNudge puts in its rows. One extra layer of escaping is undone, and the row markup
 * (`<b>`, and `<span style="…">`) restored. Applied the same way to the ported template and to
 * Coursified's expected output, so the test still compares the two exactly.
 */
export const intended = (html: string) =>
  html
    .replace(/&amp;(#39|amp|lt|gt|quot);/g, "&$1;")
    .replace(/&lt;(\/?)b&gt;/g, "<$1b>")
    .replace(/&lt;span style=&quot;([^&<>]*)&quot;&gt;/g, '<span style="$1">')
    .replace(/&lt;\/span&gt;/g, "</span>")

const finish = (out: Out): Out => ({
  ...out,
  html: intended(out.html).replace(UNSUBSCRIBE, 'href="{{unsubscribe_url}}"'),
  // Coursified joins text-part lists with newlines.
  text: out.text.replace(/\{\{\/each\}\}/g, "{{#unless @last}}\n{{/unless}}{{/each}}"),
})

const port: { [K in LifecycleKey]: (fn: Fn) => Out } = {
  welcome: (fn) =>
    variant(
      fn({ name: t("firstName"), planLine: t("planLine") }),
      fn({ name: t("firstName") }),
      "{{#if trigger.planLine}}",
      "{{/if}}",
    ),
  activationNudge: (fn) => {
    const base = { createUrl: t("createUrl"), exploreUrl: t("exploreUrl") }
    const item = { title: "{{title}}", metaLine: "{{metaLine}}", cloneLabel: "{{cloneLabel}}" }
    // The list first (goal set in both), then the goal (list in both).
    const listed = variant(
      fn({ ...base, goal: t("goal"), suggestions: [item] }),
      fn({ ...base, goal: t("goal"), suggestions: [] }),
      "{{#each trigger.suggestions}}",
      "{{/each}}",
      false,
    )
    const withoutGoal = variant(
      fn({ ...base, suggestions: [item] }),
      fn({ ...base, suggestions: [] }),
      "{{#each trigger.suggestions}}",
      "{{/each}}",
      false,
    )
    return variant(listed, withoutGoal, "{{#if trigger.goal}}", "{{/if}}")
  },
  streakRescue: (fn) => {
    const props = {
      streakDays: t("streakDays"),
      shortestModuleMinutes: t("shortestModuleMinutes"),
      resumeUrl: t("resumeUrl"),
    }
    const out = variant(
      fn({ ...props, personalBest: true }),
      fn({ ...props, personalBest: false }),
      "{{#if trigger.personalBest}}",
      "{{/if}}",
    )
    // numberWord(streakDays) in the paragraph: a word, which Coursified sends as streakWord.
    for (const field of ["html", "text"] as const)
      patch(out, field, `${t("streakDays")} days is `, `${t("streakWord")} days is `)
    return out
  },
  retakeUnlocked: (fn) => {
    const props = {
      courseTitle: t("courseTitle"),
      score: t("score"),
      passMark: t("passMark"),
      rewatchMinutes: t("rewatchMinutes"),
      rewatchUrl: t("rewatchUrl"),
      retakeUrl: t("retakeUrl"),
    }
    // "one module" / "N modules" is computed from the list's length: Coursified sends modulesLabel.
    const label = (out: Out, from: string) => {
      for (const field of ["html", "text"] as const) patch(out, field, from, t("modulesLabel"))
      return out
    }
    const one = label(
      fn({ ...props, clips: [{ title: "{{title}}", metaLine: "{{metaLine}}" }] }),
      "one module",
    )
    const none = label(fn({ ...props, clips: [] }), "0 modules")
    return variant(one, none, "{{#each trigger.clips}}", "{{/each}}", false)
  },
  winBack: (fn) => {
    const props = {
      courseTitle: t("courseTitle"),
      progressPct: t("progressPct"),
      moduleTitle: t("moduleTitle"),
      minutesLeft: t("minutesLeft"),
      resumeUrl: t("resumeUrl"),
    }
    const all = {
      ...props,
      quizAvgPct: t("quizAvgPct"),
      pathwayCount: t("pathwayCount"),
      shrinkUrl: t("shrinkUrl"),
    }
    let out = variant(
      fn(all),
      fn({ ...all, pathwayCount: undefined }),
      "{{#if trigger.pathwayCount}}",
      "{{/if}}",
    )
    out = variant(
      out,
      variant(
        fn({ ...all, quizAvgPct: undefined }),
        fn({ ...all, quizAvgPct: undefined, pathwayCount: undefined }),
        "{{#if trigger.pathwayCount}}",
        "{{/if}}",
      ),
      "{{#if trigger.hasQuizAvg}}",
      "{{/if}}",
    )
    const noShrink = { ...all, shrinkUrl: undefined }
    out = variant(
      out,
      variant(
        variant(
          fn(noShrink),
          fn({ ...noShrink, pathwayCount: undefined }),
          "{{#if trigger.pathwayCount}}",
          "{{/if}}",
        ),
        variant(
          fn({ ...noShrink, quizAvgPct: undefined }),
          fn({ ...noShrink, quizAvgPct: undefined, pathwayCount: undefined }),
          "{{#if trigger.pathwayCount}}",
          "{{/if}}",
        ),
        "{{#if trigger.hasQuizAvg}}",
        "{{/if}}",
      ),
      "{{#if trigger.shrinkUrl}}",
      "{{/if}}",
    )
    // The plural, and continueCard's clamped, rounded bar width: sent ready-made.
    patch(out, "subject", `${t("pathwayCount")} courses long`, `${t("pathwayCourses")} long`)
    patch(out, "html", 'width="NaN%"', `width="${t("progressBarPct")}%"`)
    return out
  },
  upgradeToPro: (fn) => {
    const props = {
      used: t("used"),
      limit: t("limit"),
      resetDateLabel: t("resetDateLabel"),
      upgradeUrl: t("upgradeUrl"),
    }
    const out = variant(
      fn({ ...props, priceLabel: t("priceLabel") }),
      fn(props),
      "{{#if trigger.priceLabel}}",
      "{{/if}}",
    )
    // countWord(used) and countWord(limit).toLowerCase(): words, sent ready-made.
    for (const field of ["html", "text"] as const)
      patch(out, field, `${t("used")} for ${t("limit")}.`, `${t("usedWord")} for ${t("limitWord")}.`)
    return out
  },
}

const NAMES: Record<LifecycleKey, string> = {
  welcome: "Coursified B1 · Welcome",
  activationNudge: "Coursified B2 · Activation nudge",
  streakRescue: "Coursified B3 · Streak rescue",
  retakeUnlocked: "Coursified B4 · Retake unlocked",
  winBack: "Coursified B5 · Win-back",
  upgradeToPro: "Coursified B6 · Upgrade to Pro",
}

const templates: Record<string, { name: string } & Out> = {}
const expected: Array<{ key: LifecycleKey; data: Record<string, unknown>; expected: Out }> = []
for (const key of Object.keys(port) as Array<LifecycleKey>) {
  const fn = await load(key)
  templates[key] = { name: NAMES[key], ...finish(port[key](fn)) }
  for (const sample of SAMPLES[key]) {
    const rendered = fn(sample)
    expected.push({
      key,
      data: (dataFor[key] as (p: unknown) => Record<string, unknown>)(sample),
      expected: { ...rendered, html: intended(rendered.html) },
    })
  }
}
const out = path.join(import.meta.dirname, "generated")
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, "templates.json"), `${JSON.stringify(templates, null, 2)}\n`)
writeFileSync(path.join(out, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`)
console.log(`ported ${Object.keys(templates).length} templates, ${expected.length} samples → ${out}`)

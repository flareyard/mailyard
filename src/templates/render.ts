import * as Exit from "effect/Exit"
import { htmlToText, placeholdersOf, render, TemplateSyntaxError } from "../domain/render.ts"
import { type BlockSpec, decodeBlocksDocument } from "./document.ts"
import { createKit, type Theme } from "./kit.ts"

export interface TemplateSource {
  readonly kind: "html" | "blocks"
  readonly subject: string
  readonly source: string
  readonly text?: string | null | undefined
}

export interface Brand {
  readonly theme: Theme
  readonly siteUrl: string
  readonly tagline: string
}

export interface Rendered {
  readonly subject: string
  readonly html: string
  readonly text: string
  /** UTF-8 bytes of subject, HTML and text: a lower bound on the message size. */
  readonly size: number
}

export class TemplateInvalid extends Error {
  override readonly name = "TemplateInvalid"
}

/** Every placeholder a template uses, and which are required (outside sections, with no `??` fallback). */
export const variablesOf = (...sources: ReadonlyArray<string>) => {
  const used = new Set<string>()
  const required = new Set<string>()
  for (const source of sources) {
    const found = placeholdersOf(source)
    for (const name of found.used) used.add(name)
    for (const name of found.required) required.add(name)
  }
  return { used: [...used].sort(), required: [...required].sort() }
}

const lookup = (vars: Readonly<Record<string, unknown>>, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      vars,
    )

/** Required placeholders with no value in `vars`. */
export const missingVariables = (required: ReadonlyArray<string>, vars: Readonly<Record<string, unknown>>) =>
  required.filter((name) => {
    const v = lookup(vars, name)
    return v === undefined || v === null || v === ""
  })

const fill = (s: string, vars: Readonly<Record<string, unknown>>) => render(s, vars, { escape: false })

const block = (
  kit: ReturnType<typeof createKit>,
  spec: BlockSpec,
  vars: Readonly<Record<string, unknown>>,
) => {
  const f = (s: string) => fill(s, vars)
  switch (spec.type) {
    case "heading":
      return kit.heading(f(spec.text))
    case "subheading":
      return kit.subheading(f(spec.text))
    case "paragraph":
      return kit.para(f(spec.text))
    case "note":
      return kit.note(f(spec.text))
    case "warn":
      return kit.warn(f(spec.text))
    case "button":
      return kit.button(f(spec.label), f(spec.url), spec.style ?? "primary")
    case "buttons":
      return kit.buttons(
        spec.items.map((i) => ({ label: f(i.label), url: f(i.url), ...(i.style ? { style: i.style } : {}) })),
      )
    case "stats":
      return kit.stats(spec.items.map((i) => ({ label: f(i.label), value: f(i.value) })))
    case "list":
      return kit.list(
        spec.items.map((i) => ({
          title: f(i.title),
          ...(i.sub ? { sub: f(i.sub) } : {}),
          ...(i.url ? { url: f(i.url) } : {}),
        })),
      )
    case "steps":
      return kit.steps(spec.items.map((i) => ({ title: f(i.title), ...(i.sub ? { sub: f(i.sub) } : {}) })))
    case "meta":
      return kit.meta(spec.items.map((i) => ({ label: f(i.label), value: f(i.value) })))
    case "receipt":
      return kit.receipt(
        spec.lines.map((l) => ({ label: f(l.label), value: f(l.value) })),
        { label: f(spec.total.label), value: f(spec.total.value) },
      )
    case "otp":
      return kit.otp(f(spec.code))
    case "progress":
      return kit.progress(spec.stages.map(f), spec.done)
    case "feedback":
      return kit.feedback(
        f(spec.label),
        f(spec.question),
        spec.answers.map((a) => ({ label: f(a.label), url: f(a.url) })),
      )
    case "file":
      return kit.file(f(spec.tag), f(spec.name), f(spec.sub))
    case "question":
      return kit.questionCard(
        f(spec.label),
        f(spec.stem),
        spec.answers.map((a) => ({ label: f(a.label), url: f(a.url) })),
      )
    case "html":
      return {
        html: render(spec.html, vars, { escape: true }),
        text: spec.text ? f(spec.text) : htmlToText(spec.html),
      }
  }
}

const encoder = new TextEncoder()

/** Renders a template against one recipient's data, in the sender's brand. */
export const renderTemplate = (
  template: TemplateSource,
  vars: Readonly<Record<string, unknown>>,
  brand: Brand,
): Rendered => {
  const subject = fill(template.subject, vars).replace(/[\r\n]+/g, " ")
  let html: string
  let text: string
  if (template.kind === "html") {
    html = render(template.source, vars, { escape: true })
    text = template.text ? fill(template.text, vars) : htmlToText(html)
  } else {
    const exit = decodeBlocksDocument(JSON.parse(template.source))
    if (Exit.isFailure(exit))
      throw new TemplateInvalid(`The blocks document is invalid: ${String(exit.cause)}`)
    const doc = exit.value
    const kit = createKit(brand.theme)
    const laid = kit.layout({
      preheader: fill(doc.preheader, vars),
      label: fill(doc.label, vars),
      blocks: doc.blocks.map((b) => block(kit, b, vars)),
      footer: {
        reason: fill(doc.footer.reason, vars),
        ...(doc.footer.links
          ? { links: doc.footer.links.map((k) => ({ label: fill(k.label, vars), url: fill(k.url, vars) })) }
          : {}),
      },
      siteUrl: brand.siteUrl,
      tagline: brand.tagline,
    })
    html = laid.html
    text = template.text ? fill(template.text, vars) : laid.text
  }
  return {
    subject,
    html,
    text,
    size: encoder.encode(subject).length + encoder.encode(html).length + encoder.encode(text).length,
  }
}

/** Every text a template is made of: for blocks templates, the strings inside the parsed document. */
export const templateTexts = (template: TemplateSource): ReadonlyArray<string> => {
  const texts = [template.subject, template.text ?? ""]
  if (template.kind === "html") return [...texts, template.source]
  const walk = (v: unknown): Array<string> =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(walk)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(walk)
          : []
  try {
    return [...texts, ...walk(JSON.parse(template.source))]
  } catch {
    return [...texts, template.source]
  }
}

/** Checks a template can be rendered at all (valid blocks JSON), before it's saved. */
export const validateTemplate = (template: TemplateSource): string | undefined => {
  // Sections must open and close properly in every part: subject, body, text, and each block's strings.
  for (const text of templateTexts(template)) {
    try {
      placeholdersOf(text)
    } catch (e) {
      if (e instanceof TemplateSyntaxError) return e.message
      throw e
    }
  }
  if (template.kind === "html") return template.source.trim() ? undefined : "An html template needs a body."
  try {
    const exit = decodeBlocksDocument(JSON.parse(template.source))
    return Exit.isFailure(exit) ? `The blocks document is invalid: ${String(exit.cause)}` : undefined
  } catch (e) {
    return `The blocks document is not JSON: ${e instanceof Error ? e.message : String(e)}`
  }
}

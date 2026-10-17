/**
 * The template language: `{{ name }}`, `{{ data.plan }}` and `{{ name ?? "there" }}` placeholders,
 * plus logic-less sections, Handlebars-style:
 *
 * - `{{#each items}}…{{else}}…{{/each}}`: `{{ this }}` or `{{ this.title }}` (or just `{{ title }}`)
 *   for the item, `{{ @index }}`, `{{ @first }}`, `{{ @last }}`; the else part when the list is empty.
 * - `{{#if x}}…{{else}}…{{/if}}` and `{{#unless x}}…{{/unless}}`: false for missing, null, false,
 *   0, "" and [].
 *
 * Still not a programming language: no expressions or helpers. The source is parsed once into a
 * tree and values are inserted as text (HTML-escaped in bodies), never parsed again, so a
 * contact's own data can't add template syntax (the line Plunk draws for inline content).
 */

export class TemplateSyntaxError extends Error {
  override readonly name = "TemplateSyntaxError"
}

type Node =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "var"; readonly path: string; readonly fallback: string | undefined }
  | {
      readonly type: "section"
      readonly kind: "each" | "if" | "unless"
      readonly path: string
      readonly body: ReadonlyArray<Node>
      readonly otherwise: ReadonlyArray<Node>
    }

const PATH = String.raw`(?:this|@index|@first|@last|[A-Za-z_][\w]*)(?:\.[A-Za-z_][\w]*)*`
const TAG = new RegExp(
  String.raw`\{\{\s*(?:(#)(each|if|unless)\s+(${PATH})|(\/)(each|if|unless)|(else)|(${PATH})\s*(?:\?\?\s*(?:"([^"]*)"|'([^']*)'))?)\s*\}\}`,
  "g",
)

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length

/** Parses a template into its tree; a section that isn't closed, or closed wrongly, is an error with its line. */
export const parseTemplate = (source: string): ReadonlyArray<Node> => {
  type Frame = {
    kind: "each" | "if" | "unless"
    path: string
    at: number
    body: Array<Node>
    otherwise: Array<Node>
    inElse: boolean
  }
  const root: Array<Node> = []
  const stack: Array<Frame> = []
  const target = () => {
    const top = stack.at(-1)
    return top ? (top.inElse ? top.otherwise : top.body) : root
  }
  let last = 0
  for (const m of source.matchAll(TAG)) {
    const index = m.index ?? 0
    if (index > last) target().push({ type: "text", text: source.slice(last, index) })
    last = index + m[0].length
    if (m[1]) {
      stack.push({
        kind: m[2] as Frame["kind"],
        path: m[3] as string,
        at: index,
        body: [],
        otherwise: [],
        inElse: false,
      })
    } else if (m[4]) {
      const top = stack.pop()
      if (!top) throw new TemplateSyntaxError(`Line ${lineOf(source, index)}: {{/${m[5]}}} closes nothing.`)
      if (top.kind !== m[5])
        throw new TemplateSyntaxError(
          `Line ${lineOf(source, index)}: {{/${m[5]}}} closes {{#${top.kind} ${top.path}}} from line ${lineOf(source, top.at)}.`,
        )
      target().push({
        type: "section",
        kind: top.kind,
        path: top.path,
        body: top.body,
        otherwise: top.otherwise,
      })
    } else if (m[6]) {
      const top = stack.at(-1)
      if (!top) throw new TemplateSyntaxError(`Line ${lineOf(source, index)}: {{else}} outside a section.`)
      if (top.inElse)
        throw new TemplateSyntaxError(`Line ${lineOf(source, index)}: a second {{else}} in {{#${top.kind}}}.`)
      top.inElse = true
    } else {
      target().push({ type: "var", path: m[7] as string, fallback: m[8] ?? m[9] })
    }
  }
  if (last < source.length) target().push({ type: "text", text: source.slice(last) })
  const open = stack.at(-1)
  if (open)
    throw new TemplateSyntaxError(
      `Line ${lineOf(source, open.at)}: {{#${open.kind} ${open.path}}} is never closed.`,
    )
  return root
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const dig = (value: unknown, parts: ReadonlyArray<string>): unknown => {
  let current = value
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** One level of an `each`: the item and where it is in the list. */
type Scope = { readonly item: unknown; readonly index: number; readonly length: number }

const lookup = (
  vars: Readonly<Record<string, unknown>>,
  scopes: ReadonlyArray<Scope>,
  path: string,
): unknown => {
  const [head = "", ...rest] = path.split(".")
  const inner = scopes.at(-1)
  if (head === "this") return inner ? dig(inner.item, rest) : dig(vars, rest)
  if (head === "@index") return inner?.index
  if (head === "@first") return inner ? inner.index === 0 : undefined
  if (head === "@last") return inner ? inner.index === inner.length - 1 : undefined
  // A plain name inside a loop is the item's field when it has one, else the outer data's.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const item = scopes[i]?.item
    if (item !== null && typeof item === "object" && head in (item as object))
      return dig(item, [head, ...rest])
  }
  return dig(vars, [head, ...rest])
}

const truthy = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === 0 ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  )

const toText = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

const renderNodes = (
  nodes: ReadonlyArray<Node>,
  vars: Readonly<Record<string, unknown>>,
  scopes: ReadonlyArray<Scope>,
  escaped: boolean,
): string => {
  let out = ""
  for (const node of nodes) {
    if (node.type === "text") out += node.text
    else if (node.type === "var") {
      const value = toText(lookup(vars, scopes, node.path)) ?? node.fallback ?? ""
      out += escaped ? escapeHtml(value) : value
    } else {
      const value = lookup(vars, scopes, node.path)
      if (node.kind === "each") {
        const items = Array.isArray(value) ? value : []
        if (items.length === 0) out += renderNodes(node.otherwise, vars, scopes, escaped)
        else
          items.forEach((item, index) => {
            out += renderNodes(node.body, vars, [...scopes, { item, index, length: items.length }], escaped)
          })
      } else {
        const yes = node.kind === "if" ? truthy(value) : !truthy(value)
        out += renderNodes(yes ? node.body : node.otherwise, vars, scopes, escaped)
      }
    }
  }
  return out
}

export const render = (
  source: string,
  vars: Readonly<Record<string, unknown>>,
  options: { readonly escape: boolean },
): string => renderNodes(parseTemplate(source), vars, [], options.escape)

/**
 * The placeholders a template uses: every name, and those that are required (outside any section,
 * without a fallback). A section's own name is used but not required: a list may be empty and a
 * condition false. Names inside a loop that refer to the item aren't the data's at all.
 */
export const placeholdersOf = (source: string) => {
  const used = new Set<string>()
  const required = new Set<string>()
  const walk = (nodes: ReadonlyArray<Node>, depth: number, inLoop: boolean) => {
    for (const node of nodes) {
      if (node.type === "var") {
        if (node.path.startsWith("this") || node.path.startsWith("@")) continue
        if (inLoop) continue
        used.add(node.path)
        if (depth === 0 && node.fallback === undefined) required.add(node.path)
      } else if (node.type === "section") {
        if (!node.path.startsWith("this") && !(inLoop && !node.path.includes("."))) used.add(node.path)
        walk(node.body, depth + 1, inLoop || node.kind === "each")
        walk(node.otherwise, depth + 1, inLoop)
      }
    }
  }
  walk(parseTemplate(source), 0, false)
  return { used, required }
}

/** Plain text from HTML, for the text part of a message that only came with HTML. */
export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

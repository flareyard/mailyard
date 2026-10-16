/**
 * Placeholder rendering for subjects and bodies: `{{ name }}`, `{{ data.plan }}` and
 * `{{ name ?? "there" }}`. Values are HTML-escaped in bodies. Deliberately not a template language:
 * no loops, no expressions, nothing a contact's own data could use to run code (the same line Plunk
 * draws for inline content).
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*(?:\?\?\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/g

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const lookup = (vars: Readonly<Record<string, unknown>>, path: string): unknown => {
  let current: unknown = vars
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const toText = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

export const render = (
  source: string,
  vars: Readonly<Record<string, unknown>>,
  options: { readonly escape: boolean },
): string =>
  source.replace(PLACEHOLDER, (_match, path: string, doubleQuoted?: string, singleQuoted?: string) => {
    const value = toText(lookup(vars, path)) ?? doubleQuoted ?? singleQuoted ?? ""
    return options.escape ? escapeHtml(value) : value
  })

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

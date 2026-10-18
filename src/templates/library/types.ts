import type { BlocksDocument } from "../document.ts"
import type { TemplateSource } from "../render.ts"

/**
 * A template that ships with the repo (HAL-3304). The library is code so that `bun run check` proves
 * every one renders; `bun run templates:install` puts them into a running Mailyard through the API,
 * matched by name, so editing one here and installing again updates it in place.
 */
export type LibraryTemplate = {
  /** The file name, kebab-case: `birthday` lives in `birthday.ts`. */
  readonly slug: string
  /** The name it's installed under; installs are matched by it. */
  readonly name: string
  /** One line: what it's for and when it's sent. */
  readonly description: string
  readonly subject: string
  /** Plain-text part. Left out, it's derived from the HTML. */
  readonly text?: string
  /**
   * What a real send would pass: contact fields, `name`, `email`, `unsubscribe_url`, `preferences_url`,
   * and `trigger` (the tracked event's data) in automations or `data` (the request's data) from `POST /v1/send`. The test renders with it and fails on a
   * required placeholder it doesn't cover.
   */
  readonly sample: Readonly<Record<string, unknown>>
} & (
  | { readonly kind: "blocks"; readonly document: BlocksDocument }
  | { readonly kind: "html"; readonly html: string }
)

/** The shape the renderer and the templates API take. */
export const toSource = (t: LibraryTemplate): TemplateSource => ({
  kind: t.kind,
  subject: t.subject,
  source: t.kind === "blocks" ? JSON.stringify(t.document) : t.html,
  text: t.text ?? null,
})

import type { ConsentEvidence } from "../db/schema.ts"
import { sha256 } from "./crypto.ts"

/**
 * Consent evidence from the request the person made (HAL-3426): their IP and browser, and the page
 * they acted on. `page` is the origin plus a fixed path: the confirmation and preference links carry
 * their token in the path, and a token kept as evidence would be a working link. A form embedded on
 * someone's site posts from that page, so with `referer` the page is the Referer, without its query.
 */
export const requestEvidence = (
  request: Request,
  page: string,
  options: { readonly referer?: boolean } = {},
): ConsentEvidence => {
  const ip = request.headers.get("cf-connecting-ip")?.trim()
  const userAgent = request.headers.get("user-agent")?.trim()
  const fallback = `${new URL(request.url).origin}${page}`
  let where = fallback
  const referer = options.referer ? request.headers.get("referer") : null
  if (referer) {
    try {
      const url = new URL(referer)
      if (url.protocol === "https:" || url.protocol === "http:") where = `${url.origin}${url.pathname}`
    } catch {
      where = fallback
    }
  }
  return {
    ...(ip ? { ip: ip.slice(0, 64) } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
    page: where.slice(0, 500),
  }
}

/**
 * A short hash of what a signup form showed when someone used it: its name, description, topics,
 * fields and topic choice. Forms aren't versioned, so this stands in for "which version of the form":
 * two signups with the same hash saw the same form.
 */
export const formVersion = async (form: {
  readonly name: string
  readonly description: string | null
  readonly topicIds: ReadonlyArray<string>
  readonly fields: ReadonlyArray<string>
  readonly fieldDefs: unknown
  readonly topicChoice: string
}) =>
  (
    await sha256(
      JSON.stringify([
        form.name,
        form.description,
        form.topicIds,
        form.fields,
        form.fieldDefs ?? null,
        form.topicChoice,
      ]),
    )
  ).slice(0, 16)

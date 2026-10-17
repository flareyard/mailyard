/**
 * Which of a draft's attachments go in the message and which go as expiring links (HAL-3398). Email
 * Service sends at most 5 MiB with MIME (measured 2026-10-16), so the smallest files fill what the
 * body leaves, base64 counted, and the rest are linked. Pure, so the send and the draft the composer
 * shows agree.
 */

export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024
/** Room kept for headers, the body and multipart boundaries when deciding what fits. */
export const ENVELOPE_ALLOWANCE = 256 * 1024

const utf8 = new TextEncoder()
/** base64 costs 4/3 plus line breaks. */
const encoded = (n: number) => Math.ceil((n * 4) / 3) + Math.ceil(n / 57) * 2

export const planAttachments = (draft: {
  readonly bodyText: string
  readonly bodyHtml: string | null
  readonly attachments: ReadonlyArray<{ readonly key: string; readonly size: number }>
}): ReadonlyMap<string, "inline" | "link"> => {
  const bodyBytes = utf8.encode(draft.bodyText).length + utf8.encode(draft.bodyHtml ?? "").length * 2
  const budget = MAX_MESSAGE_BYTES - ENVELOPE_ALLOWANCE - bodyBytes
  const plan = new Map<string, "inline" | "link">()
  let used = 0
  for (const a of [...draft.attachments].sort((x, y) => x.size - y.size)) {
    if (used + encoded(a.size) <= budget) {
      plan.set(a.key, "inline")
      used += encoded(a.size)
    } else plan.set(a.key, "link")
  }
  return plan
}

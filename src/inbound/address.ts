/** An envelope address split into the parts routing cares about. */
export interface RecipientAddress {
  /** Lowercased, trimmed, as received: `sam+news@acme.com`. */
  readonly address: string
  readonly local: string
  readonly domain: string
  /** The address without its `+tag`: `sam@acme.com`. Equal to `address` when there is no tag. */
  readonly base: string
  /** `news` for `sam+news@acme.com`, null when there is no subaddress. */
  readonly tag: string | null
}

/**
 * Normalises an envelope address. Local parts are case-insensitive in practice (RFC 5321 allows
 * otherwise, but no mail system we interoperate with relies on it), and domains always are.
 * Returns null for anything that is not `local@domain`.
 */
export const parseRecipient = (raw: string): RecipientAddress | null => {
  const address = raw.trim().replace(/^<|>$/g, "").toLowerCase()
  const at = address.lastIndexOf("@")
  if (at <= 0 || at === address.length - 1) return null
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  const plus = local.indexOf("+")
  // A leading "+" ("+tag@x") has no base to fall back to, so it is not a subaddress.
  if (plus <= 0) return { address, local, domain, base: address, tag: null }
  const tag = local.slice(plus + 1)
  return { address, local, domain, base: `${local.slice(0, plus)}@${domain}`, tag: tag || null }
}

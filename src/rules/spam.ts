import type { AuthResults } from "../inbound/auth.ts"

/**
 * The spam score: points from what the receiving MTA found when it authenticated the message, plus
 * what a classifier thinks when one is configured. At SPAM_THRESHOLD or above the message goes to spam.
 * Email Routing already rejected mail failing the sender's DMARC policy and mail failing both SPF and
 * DKIM, so what reaches here is the subtler rest: p=none failures, softfails, unaligned signatures.
 */
export const SPAM_THRESHOLD = 5

/** Classifier verdicts only matter where authentication alone leaves doubt. */
export const CLASSIFY_BETWEEN = { low: 1, high: 5 } as const

/** How much a classifier's probability can add: certainty of spam is worth this many points. */
export const CLASSIFIER_WEIGHT = 6

export interface SpamReason {
  readonly rule: string
  readonly points: number
}

export const authScore = (auth: AuthResults, input: { readonly fromDomain: string | null }) => {
  const reasons: Array<SpamReason> = []
  const add = (rule: string, points: number) => reasons.push({ rule, points })
  if (auth.dmarc === "fail") add("dmarc=fail", 5)
  if (auth.spf === "fail") add("spf=fail", 2.5)
  else if (auth.spf === "softfail") add("spf=softfail", 1)
  else if (auth.spf === "none" || auth.spf === "neutral") add(`spf=${auth.spf}`, 0.5)
  const passes = auth.dkim.filter((d) => d.result === "pass")
  if (auth.dkim.length > 0 && passes.length === 0) add("dkim=fail", 1.5)
  if (auth.dkim.length === 0 && auth.source !== "none") add("dkim=none", 0.5)
  // A DKIM pass for the From domain is strong evidence the mail is what it claims to be.
  const fromDomain = input.fromDomain?.toLowerCase() ?? null
  if (
    fromDomain &&
    passes.some((d) => d.domain && (d.domain === fromDomain || fromDomain.endsWith(`.${d.domain}`)))
  ) {
    add("dkim=pass aligned", -1.5)
  }
  if (auth.dmarc === "pass") add("dmarc=pass", -1)
  if (auth.source === "none") add("no authentication results", 1)
  const score = Math.round(reasons.reduce((sum, r) => sum + r.points, 0) * 10) / 10
  return { score, reasons }
}

export const classifierPoints = (probability: number) =>
  Math.round(Math.min(Math.max(probability, 0), 1) * CLASSIFIER_WEIGHT * 10) / 10

/**
 * Topics with their stats, as pure functions (design: topics*.html; GAPS-audience A2.1). Rates are fractions
 * over the subscribers at the start of the range; under `minimumSubscribers` there's nothing to say.
 */
import { fmtInt, num } from "../../lib/format.ts"
import { pct } from "../kit/format.ts"

export type Range = "7d" | "30d" | "90d"
export const RANGES: readonly Range[] = ["7d", "30d", "90d"]
export const isRange = (v: unknown): v is Range => v === "7d" || v === "30d" || v === "90d"
export const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 }

type N = number | string | null | undefined

export type TopicStat = {
  topicId: string
  subscribers: N
  joined: N
  left: N
  subscribersAtStart: N
  insufficientData: boolean
  growthRate: N
  unsubscribeRate: N
}

export const NOT_ENOUGH = (min: N) => `Not enough subscribers yet (${fmtInt(num(min) ?? 100)} needed)`

/** "+4.9%" / "−1.2%" for growth; null when there isn't enough data. */
export function growthText(s: Pick<TopicStat, "insufficientData" | "growthRate">): string | null {
  if (s.insufficientData) return null
  const g = num(s.growthRate)
  if (g === null) return null
  const t = pct(Math.abs(g))
  return g > 0 ? `+${t}` : g < 0 ? `−${t}` : t
}

export function unsubText(s: Pick<TopicStat, "insufficientData" | "unsubscribeRate">): string | null {
  if (s.insufficientData) return null
  const u = num(s.unsubscribeRate)
  return u === null ? null : pct(u, 2)
}

/** "+214", "−31", "0". */
export function signed(v: N, sign: "+" | "−"): string {
  const n = num(v) ?? 0
  return n === 0 ? "0" : `${sign}${fmtInt(n)}`
}

export type TopicDraft = { name: string; description: string; sender: string; doubleOptIn: boolean }

export function validateTopic(d: TopicDraft): { field: "name" | "description"; message: string } | null {
  const name = d.name.trim()
  if (!name) return { field: "name", message: "Give the topic a name people will recognise." }
  if (name.length > 100) return { field: "name", message: "A topic name is 100 characters at most." }
  if (d.description.length > 500)
    return { field: "description", message: "A description is 500 characters at most." }
  return null
}

/** The body for POST /v1/topics or PATCH /v1/topics/{id}: blanks are null, never empty strings. */
export function topicBody(d: TopicDraft) {
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    sender: d.sender || null,
    doubleOptIn: d.doubleOptIn,
  }
}

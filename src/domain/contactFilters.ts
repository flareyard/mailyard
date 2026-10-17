import type { SQL } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { FIELD_OPS, type FieldOp, type Rule } from "../segments/rules.ts"
import { findSegment, prepare, SegmentInvalid } from "./segments.ts"

/**
 * The contacts list's segment, field and event filters (HAL-3316). Each compiles through the segment
 * rule tree, so `GET /v1/contacts?field=plan:eq:pro` matches exactly what a segment with that one
 * rule matches. Several filters are ANDed together with the list's own (status, topic, search).
 *
 * - `segmentId`: a saved segment's rule tree.
 * - `field=key:op[:value]`: `email`, `name` or a custom field; `op` is a segment field op
 *   (`eq`, `contains`, `gt`, `exists`, …). The value is everything after the second colon.
 * - `event=[!]name[:days]`: did the event (within the last `days`), or with `!`, didn't.
 */
export interface ContactFilters {
  readonly segmentId?: string | undefined
  readonly field?: string | ReadonlyArray<string> | undefined
  readonly event?: string | ReadonlyArray<string> | undefined
}

const list = (v: string | ReadonlyArray<string> | undefined) =>
  v === undefined ? [] : typeof v === "string" ? [v] : v
const NUMERIC_OPS: ReadonlyArray<FieldOp> = ["gt", "gte", "lt", "lte"]

export const parseFieldFilter = (raw: string) =>
  Effect.gen(function* () {
    const first = raw.indexOf(":")
    const second = first < 0 ? -1 : raw.indexOf(":", first + 1)
    const field = (first < 0 ? raw : raw.slice(0, first)).trim()
    const op = (first < 0 ? "" : second < 0 ? raw.slice(first + 1) : raw.slice(first + 1, second)).trim()
    const value = second < 0 ? undefined : raw.slice(second + 1)
    if (!field || !FIELD_OPS.includes(op as FieldOp))
      return yield* new SegmentInvalid({
        field: "field",
        message: `Write a field filter as key:op:value, with op one of ${FIELD_OPS.join(", ")}.`,
      })
    const needsValue = op !== "exists" && op !== "missing"
    if (needsValue && value === undefined)
      return yield* new SegmentInvalid({
        field: "field",
        message: `The ${op} filter on ${field} needs a value.`,
      })
    const typed =
      value !== undefined &&
      NUMERIC_OPS.includes(op as FieldOp) &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
        ? Number(value)
        : value
    return {
      type: "field" as const,
      field,
      op: op as FieldOp,
      ...(needsValue && typed !== undefined ? { value: typed } : {}),
    }
  })

export const parseEventFilter = (raw: string) =>
  Effect.gen(function* () {
    const negated = raw.startsWith("!")
    const body = negated ? raw.slice(1) : raw
    const at = body.lastIndexOf(":")
    const days = at >= 0 && /^\d+$/.test(body.slice(at + 1)) ? Number(body.slice(at + 1)) : undefined
    const name = (days === undefined ? body : body.slice(0, at)).trim()
    if (!name)
      return yield* new SegmentInvalid({
        field: "event",
        message: "Write an event filter as [!]name[:days].",
      })
    if (days !== undefined && (days < 1 || days > 3650))
      return yield* new SegmentInvalid({ field: "event", message: "Days are 1 to 3650." })
    return {
      type: "event" as const,
      name,
      ...(negated ? { did: false } : {}),
      ...(days !== undefined ? { withinDays: days } : {}),
    }
  })

/** The rule tree for the filters given, or null when there are none. */
export const filterRule = Effect.fn("contacts.filterRule")(function* (filters: ContactFilters) {
  const rules: Array<Rule> = []
  if (filters.segmentId) rules.push((yield* findSegment(filters.segmentId)).filter as Rule)
  for (const f of list(filters.field)) rules.push(yield* parseFieldFilter(f))
  for (const e of list(filters.event)) rules.push(yield* parseEventFilter(e))
  return rules.length === 0 ? null : ({ type: "all", rules } as Rule)
})

/** The filters as one SQL condition over `contacts`, checked like any segment; undefined when none. */
export const filterCondition = Effect.fn("contacts.filterCondition")(function* (filters: ContactFilters) {
  const rule = yield* filterRule(filters)
  if (!rule) return undefined as SQL | undefined
  return (yield* prepare(rule)).condition as SQL | undefined
})

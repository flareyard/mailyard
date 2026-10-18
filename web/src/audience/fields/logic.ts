/**
 * The contact-field registry, as pure functions (design: fields*.html; GAPS-audience A1.3). Labels, the
 * "not named yet" rule, type words, and what a type change would do to the segments and automations using it.
 */
import { andList } from "../kit/format.ts"

export type FieldType = "string" | "number" | "boolean" | "date"
export type UsedBy = { type: "segment" | "automation"; id: string; name: string }
export type FieldLike = { key: string; label: string; type: FieldType; usedBy: readonly UsedBy[] }

export const TYPE_WORD: Record<FieldType, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes or no",
  date: "Date",
}

/** A field is named once its label differs from its key (the API returns the key until it's named). */
export const isNamed = (f: Pick<FieldLike, "key" | "label">) => f.label.trim() !== "" && f.label !== f.key

export function namedCount(fields: readonly FieldLike[]) {
  const unnamed = fields.filter((f) => !isNamed(f)).length
  return { total: fields.length, unnamed }
}

/** "7 fields · 2 not named". */
export function fieldsMeta(fields: readonly FieldLike[]): string {
  const { total, unnamed } = namedCount(fields)
  const base = `${total} field${total === 1 ? "" : "s"}`
  return unnamed ? `${base} · ${unnamed} not named` : base
}

/** "Text · 2 used by Trial ends this week, Team plan admins", the phone row's second line. */
export function phoneSub(f: FieldLike): string {
  if (!f.usedBy.length) return `${TYPE_WORD[f.type]} · not used`
  return `${TYPE_WORD[f.type]} · ${f.usedBy.length} used by ${f.usedBy.map((u) => u.name).join(", ")}`
}

const COMPARE: Record<FieldType, string> = {
  string: "as text",
  number: "as numbers",
  boolean: "as yes or no",
  date: "as dates",
}

/**
 * The warning a type change carries, or null when nothing would change: values aren't converted, and every
 * segment or automation using the field starts comparing it the new way.
 */
export function typeChangeWarning(f: FieldLike, next: FieldType): { title: string; body: string } | null {
  if (next === f.type) return null
  const segs = f.usedBy.filter((u) => u.type === "segment").length
  const autos = f.usedBy.filter((u) => u.type === "automation").length
  const parts = [
    segs ? `${segs} segment${segs === 1 ? "" : "s"}` : null,
    autos ? `${autos} automation${autos === 1 ? "" : "s"}` : null,
  ].filter((x): x is string => Boolean(x))
  const conversion =
    next === "number"
      ? "Values already stored aren’t converted: text stays text, and a number rule won’t match it."
      : "Values already stored aren’t converted; only how they’re compared changes."
  if (!parts.length)
    return {
      title: "Nothing uses this field yet.",
      body: `Changing its type changes how new rules compare it (${COMPARE[next]} instead of ${COMPARE[f.type].replace(/^as /, "")}). ${conversion}`,
    }
  const n = segs + autos
  return {
    title: `${andList(parts)} ${n === 1 ? "uses" : "use"} this field.`,
    body: `Changing its type changes how ${n === 1 ? "its rules compare" : "their rules compare"} it (${COMPARE[next]} instead of ${COMPARE[f.type].replace(/^as /, "")}, here). ${conversion}`,
  }
}

/** The PATCH body for the edit sheet: only what changed; an emptied label goes back to the key (null). */
export function fieldPatch(
  f: Pick<FieldLike, "key" | "label" | "type">,
  label: string,
  type: FieldType,
): { label?: string | null; type?: FieldType } | null {
  const out: { label?: string | null; type?: FieldType } = {}
  const l = label.trim()
  const current = isNamed(f) ? f.label : ""
  if (l !== current) out.label = l === "" ? null : l
  if (type !== f.type) out.type = type
  return Object.keys(out).length ? out : null
}

export type DateTrigger = { automationId: string; automation: string; field: string }

/**
 * Automations whose date trigger reads a field. `usedBy` doesn't count triggers or `wait_until` fields yet
 * (HAL-3426), so the row says so from the automations list.
 */
export function triggersReading(
  key: string,
  automations: readonly {
    id: string
    name: string
    trigger: { kind: string; field?: string } | null
  }[],
): DateTrigger[] {
  return automations
    .filter((a) => a.trigger?.kind === "date" && a.trigger.field === key)
    .map((a) => ({ automationId: a.id, automation: a.name, field: key }))
}

/**
 * Signup forms, as pure functions (design: form*.html; GAPS-audience A4.1–A4.6, rules from the API's
 * `src/domain/forms.ts`): field definitions and their edits, the save body, the stats bars, and how
 * Turnstile reads. Messages match the API's, so a local check and a 400 say the same thing.
 */
import { fmtInt, num } from "../../lib/format.ts"

export type FieldDefType = "text" | "number" | "date" | "checkbox" | "select" | "tel" | "url"
export type FieldDef = {
  key: string
  label: string
  type: FieldDefType
  required: boolean
  options?: string[]
}

export const TYPE_LABEL: Record<FieldDefType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  select: "Choice list",
  tel: "Phone",
  url: "Web address",
}
export const FIELD_DEF_TYPES = Object.keys(TYPE_LABEL) as FieldDefType[]

export const LIMITS = { fields: 30, options: 50, name: 100, description: 500 } as const
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const RESERVED = new Set(["email", "name"])

/** "first_name" → "First name", the label a plain field gets. */
export function labelFor(key: string): string {
  const s = key.replace(/_/g, " ").trim()
  return s ? s[0]?.toUpperCase() + s.slice(1) : key
}

/**
 * The definitions to edit: `fieldDefs` when the form has them (the API always resolves them on read), else the
 * old plain `fields` as optional text.
 */
export function resolveDefs(form: { fields: readonly string[]; fieldDefs: readonly FieldDef[] }): FieldDef[] {
  if (form.fieldDefs.length)
    return form.fieldDefs.map((d) => ({ ...d, ...(d.options ? { options: [...d.options] } : {}) }))
  return form.fields.map((key) => ({ key, label: labelFor(key), type: "text" as const, required: false }))
}

/** A form made before field definitions: plain `fields` and no definitions beyond optional text. */
export const isLegacy = (form: { fields: readonly string[]; fieldDefs: readonly FieldDef[] }) =>
  form.fields.length > 0 &&
  form.fieldDefs.every((d) => d.type === "text" && !d.required && d.label === labelFor(d.key))

export function validateKey(raw: string, existing: readonly FieldDef[]): string | null {
  const key = raw.trim()
  if (!key) return "Type the field’s key, like country."
  if (RESERVED.has(key)) return "Email and name are always on the form."
  if (!KEY.test(key))
    return "A field key uses letters, digits and underscores, starting with a letter or underscore."
  if (existing.some((d) => d.key === key)) return `${key} is already on the form.`
  if (existing.length >= LIMITS.fields) return `A form has ${LIMITS.fields} fields at most.`
  return null
}

export function addDef(defs: readonly FieldDef[], key: string): FieldDef[] {
  return [...defs, { key: key.trim(), label: labelFor(key.trim()), type: "text", required: false }]
}

/** Moves the definition at `from` to `to`, keeping the rest in order. */
export function moveDef(defs: readonly FieldDef[], from: number, to: number): FieldDef[] {
  if (from === to || from < 0 || to < 0 || from >= defs.length || to >= defs.length) return [...defs]
  const out = [...defs]
  const [d] = out.splice(from, 1)
  if (d) out.splice(to, 0, d)
  return out
}

export function updateDef(defs: readonly FieldDef[], i: number, patch: Partial<FieldDef>): FieldDef[] {
  return defs.map((d, j) => {
    if (j !== i) return d
    const next = { ...d, ...patch }
    if (next.type !== "select") {
      const { options: _o, ...rest } = next
      return rest
    }
    return { ...next, options: next.options ?? [] }
  })
}

/** The first problem with the definitions, as the API words it and with its `field` path. */
export function validateDefs(defs: readonly FieldDef[]): { field: string; message: string } | null {
  if (defs.length > LIMITS.fields)
    return { field: "fieldDefs", message: `A form has ${LIMITS.fields} fields at most.` }
  for (const [i, d] of defs.entries()) {
    if (d.type === "select" && (!d.options || d.options.length < 1 || d.options.length > LIMITS.options))
      return { field: `fieldDefs[${i}].options`, message: "A select has 1 to 50 options." }
    if (d.label.length > 100)
      return { field: `fieldDefs[${i}].label`, message: "A label is 100 characters at most." }
  }
  return null
}

export type FormDraft = {
  name: string
  description: string
  redirectUrl: string
  topicIds: string[]
  topicChoice: "all" | "pick"
  fieldDefs: FieldDef[]
  turnstileSiteKey: string
}

export function validateDraft(d: FormDraft): { field: string; message: string } | null {
  const name = d.name.trim()
  if (!name || name.length > LIMITS.name)
    return { field: "name", message: "A form’s heading is 1 to 100 characters." }
  if (d.description.length > LIMITS.description)
    return { field: "description", message: "The description is 500 characters at most." }
  const url = d.redirectUrl.trim()
  if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url))
    return { field: "redirectUrl", message: "The redirect must be an https URL." }
  if (!d.topicIds.length) return { field: "topicIds", message: "Pick at least one topic." }
  return validateDefs(d.fieldDefs)
}

/** The PATCH (or POST) body: definitions replace plain fields, blanks are null. */
export function formBody(d: FormDraft) {
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    redirectUrl: d.redirectUrl.trim() || null,
    topicIds: d.topicIds,
    topicChoice: d.topicChoice,
    fieldDefs: d.fieldDefs.map((f) => ({
      key: f.key,
      label: f.label.trim() || labelFor(f.key),
      type: f.type,
      required: f.required,
      ...(f.type === "select" ? { options: f.options ?? [] } : {}),
    })),
    turnstileSiteKey: d.turnstileSiteKey.trim() || null,
  }
}

/** Which definition row a 400's `field` names (`fieldDefs[1].options` → 1), if any. */
export function defIndex(field: string | null | undefined): number | null {
  const m = field?.match(/^fieldDefs\[(\d+)\]/)
  return m ? Number(m[1]) : null
}

export type Turnstile = { enabled: boolean; siteKey: string | null; configured: boolean }
export type TurnstileState = "off" | "unchecked" | "verified"

/** Off without a site key; shown but unchecked while the deploy has no secret; verified once it has. */
export const turnstileState = (t: Turnstile): TurnstileState =>
  !t.enabled ? "off" : t.configured ? "verified" : "unchecked"

export const TURNSTILE_PILL: Record<TurnstileState, { cls: string; label: string }> = {
  off: { cls: "pill-neutral", label: "Off" },
  unchecked: { cls: "pill-warn", label: "Shown, not checked" },
  verified: { cls: "pill-pass", label: "Verified" },
}

export const TURNSTILE_UNCHECKED =
  "Turnstile shows on the form but nothing is checked until TURNSTILE_SECRET is set."

type N = number | string | null | undefined
export type Day = { day: string; submissions: N; subscribed: N; confirm: N; refused: N }

/** Each day's bar: its height against the busiest day, and the three stacked parts. */
export function bars(days: readonly Day[]) {
  const max = Math.max(0, ...days.map((d) => num(d.submissions) ?? 0))
  return days.map((d) => {
    const total = num(d.submissions) ?? 0
    return {
      day: d.day,
      height: max ? Math.round((total / max) * 100) : 0,
      sub: num(d.subscribed) ?? 0,
      conf: num(d.confirm) ?? 0,
      ref: num(d.refused) ?? 0,
      label: `${d.day}: ${fmtInt(total)} submissions, ${fmtInt(d.subscribed)} subscribed, ${fmtInt(d.confirm)} awaiting confirmation, ${fmtInt(d.refused)} refused`,
    }
  })
}

/** Stats began on 18 Oct 2026 (HAL-3424); a range that starts earlier reads 0 before that day. */
export const STATS_SINCE = "2026-10-18"
export const countingSince = (days: readonly Day[]) =>
  days.length > 0 &&
  days[0] !== undefined &&
  days[0].day < STATS_SINCE &&
  days.every((d) => (num(d.submissions) ?? 0) === 0)

/** The keys a form asks for, in order, for the list: email, name and its definitions. */
export const fieldKeys = (defs: readonly FieldDef[]) => ["email", "name", ...defs.map((d) => d.key)]

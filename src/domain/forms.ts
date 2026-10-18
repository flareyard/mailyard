import { and, asc, eq, gte, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import type { ConsentEvidence } from "../db/schema.ts"
import { type FormFieldDef, formDaily, forms, topics } from "../db/schema.ts"
import { labelOf } from "../forms/page.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { getBrand } from "./brand.ts"
import { formVersion } from "./consentEvidence.ts"
import { ContactInvalid, normalizeEmail, upsertContact } from "./contacts.ts"
import { subscribe } from "./subscriptions.ts"

export class FormNotFound extends Schema.TaggedError<FormNotFound>()("FormNotFound", { id: Schema.String }) {}
export class FormInvalid extends Schema.TaggedError<FormInvalid>()("FormInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

type FormRow = typeof forms.$inferSelect

/** The form's fields as asked: its definitions, or for older forms, each key as optional text. */
export const defsOf = (f: Pick<FormRow, "fields" | "fieldDefs">): ReadonlyArray<FormFieldDef> =>
  f.fieldDefs ?? f.fields.map((key) => ({ key, label: labelOf(key), type: "text" as const, required: false }))

const describe = (f: FormRow, turnstileConfigured = false) => ({
  id: f.id,
  name: f.name,
  topicIds: f.topicIds,
  topicChoice: f.topicChoice,
  fields: f.fields,
  fieldDefs: defsOf(f),
  redirectUrl: f.redirectUrl,
  description: f.description,
  turnstileSiteKey: f.turnstileSiteKey,
  /** Turnstile: on when the form has a site key; enforced only where the deploy has TURNSTILE_SECRET. */
  turnstile: {
    enabled: f.turnstileSiteKey !== null,
    siteKey: f.turnstileSiteKey,
    configured: turnstileConfigured,
  },
  archived: f.archived,
  createdAt: f.createdAt,
})

const configured = Effect.map(Bindings, (env) => Boolean(env.TURNSTILE_SECRET))

const FIELD_TYPES = ["text", "number", "date", "checkbox", "select", "tel", "url"] as const
type FieldDefInput = {
  readonly key: string
  readonly label?: string | undefined
  readonly type?: (typeof FIELD_TYPES)[number] | undefined
  readonly required?: boolean | undefined
  readonly options?: ReadonlyArray<string> | undefined
}

/** Field definitions, checked and given defaults: a label from the key, text, optional. */
const normalizeDefs = (defs: ReadonlyArray<FieldDefInput>) =>
  Effect.gen(function* () {
    if (defs.length > 30) return yield* new FormInvalid({ field: "fieldDefs", message: "At most 30 fields." })
    const seen = new Set<string>()
    const out: Array<FormFieldDef> = []
    for (const [i, d] of defs.entries()) {
      if (!FIELD.test(d.key) || d.key === "email" || d.key === "name" || seen.has(d.key))
        return yield* new FormInvalid({
          field: `fieldDefs[${i}].key`,
          message: `"${d.key}" can't be a custom form field, or it's listed twice.`,
        })
      seen.add(d.key)
      const type = d.type ?? "text"
      const options = d.options?.map((o) => o.trim()).filter(Boolean) ?? []
      if (type === "select" && (options.length === 0 || options.length > 50))
        return yield* new FormInvalid({
          field: `fieldDefs[${i}].options`,
          message: "A select has 1 to 50 options.",
        })
      const label = (d.label ?? "").trim() || labelOf(d.key)
      if (label.length > 100)
        return yield* new FormInvalid({
          field: `fieldDefs[${i}].label`,
          message: "A label is at most 100 characters.",
        })
      out.push({
        key: d.key,
        label,
        type,
        required: d.required ?? false,
        ...(type === "select" ? { options } : {}),
      })
    }
    return out
  })
export type FormView = ReturnType<typeof describe>

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const checkInput = (input: {
  readonly name?: string | undefined
  readonly topicIds?: ReadonlyArray<string> | undefined
  readonly fields?: ReadonlyArray<string> | undefined
  readonly redirectUrl?: string | null | undefined
  readonly description?: string | null | undefined
  readonly turnstileSiteKey?: string | null | undefined
}) =>
  Effect.gen(function* () {
    if (input.description && input.description.length > 500)
      return yield* new FormInvalid({
        field: "description",
        message: "A description is at most 500 characters.",
      })
    if (input.turnstileSiteKey && !/^[0-9A-Za-z_-]{8,100}$/.test(input.turnstileSiteKey))
      return yield* new FormInvalid({
        field: "turnstileSiteKey",
        message: "That isn't a Turnstile site key.",
      })
    if (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 100)) {
      return yield* new FormInvalid({ field: "name", message: "A form name is 1 to 100 characters." })
    }
    const topicIds = input.topicIds
    if (topicIds !== undefined) {
      if (topicIds.length === 0) {
        return yield* new FormInvalid({
          field: "topicIds",
          message: "A form subscribes to at least one topic.",
        })
      }
      const found = yield* queryIn("forms.topics", [...topicIds], (db, chunk) =>
        db
          .select({ id: topics.id, archived: topics.archived })
          .from(topics)
          .where(inArray(topics.id, chunk))
          .all(),
      )
      const missing = topicIds.filter((id) => !found.some((t) => t.id === id && !t.archived))
      if (missing.length) {
        return yield* new FormInvalid({
          field: "topicIds",
          message: `Unknown or archived topic: ${missing.join(", ")}.`,
        })
      }
    }
    for (const f of input.fields ?? []) {
      if (!FIELD.test(f) || f === "email" || f === "name") {
        return yield* new FormInvalid({ field: "fields", message: `"${f}" can't be a custom form field.` })
      }
    }
    if (input.redirectUrl) {
      const ok = (() => {
        try {
          return new URL(input.redirectUrl).protocol === "https:"
        } catch {
          return false
        }
      })()
      if (!ok)
        return yield* new FormInvalid({ field: "redirectUrl", message: "The redirect must be an https URL." })
    }
  })

export const findForm = Effect.fn("forms.find")(function* (id: string) {
  const database = yield* Database
  const row = yield* database.query("forms.get", (db) =>
    db.select().from(forms).where(eq(forms.id, id)).get(),
  )
  if (!row) return yield* new FormNotFound({ id })
  return row
})

export const listForms = Effect.fn("forms.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("forms.list", (db) =>
    db.select().from(forms).orderBy(asc(forms.archived), asc(forms.name)).all(),
  )
  const on = yield* configured
  return rows.map((r) => describe(r, on))
})

export const getForm = Effect.fn("forms.getView")(function* (id: string) {
  return describe(yield* findForm(id), yield* configured)
})

export const createForm = Effect.fn("forms.create")(function* (
  input: {
    readonly name: string
    readonly topicIds: ReadonlyArray<string>
    readonly fields?: ReadonlyArray<string> | undefined
    readonly fieldDefs?: ReadonlyArray<FieldDefInput> | undefined
    readonly topicChoice?: "all" | "pick" | undefined
    readonly redirectUrl?: string | null | undefined
    readonly description?: string | null | undefined
    readonly turnstileSiteKey?: string | null | undefined
  },
  actor: string,
) {
  yield* checkInput(input)
  const defs = input.fieldDefs ? yield* normalizeDefs(input.fieldDefs) : null
  const database = yield* Database
  const id = `frm_${yield* (yield* Ids).next}`
  const row = yield* database.query("forms.insert", (db) =>
    db
      .insert(forms)
      .values({
        id,
        name: input.name.trim(),
        topicIds: [...input.topicIds],
        fields: defs ? defs.map((d) => d.key) : [...(input.fields ?? [])],
        fieldDefs: defs,
        topicChoice: input.topicChoice ?? "all",
        redirectUrl: input.redirectUrl ?? null,
        description: input.description?.trim() || null,
        turnstileSiteKey: input.turnstileSiteKey || null,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "form.create", target: id, after: row })
  return describe(row, yield* configured)
})

export const updateForm = Effect.fn("forms.update")(function* (
  id: string,
  input: {
    readonly name?: string | undefined
    readonly topicIds?: ReadonlyArray<string> | undefined
    readonly fields?: ReadonlyArray<string> | undefined
    readonly fieldDefs?: ReadonlyArray<FieldDefInput> | undefined
    readonly topicChoice?: "all" | "pick" | undefined
    readonly redirectUrl?: string | null | undefined
    readonly description?: string | null | undefined
    readonly turnstileSiteKey?: string | null | undefined
    readonly archived?: boolean | undefined
  },
  actor: string,
) {
  const before = yield* findForm(id)
  yield* checkInput(input)
  const defs = input.fieldDefs ? yield* normalizeDefs(input.fieldDefs) : undefined
  const database = yield* Database
  const row = yield* database.query("forms.update", (db) =>
    db
      .update(forms)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.topicIds !== undefined ? { topicIds: [...input.topicIds] } : {}),
        // Field definitions replace the plain list; a plain list on its own clears old definitions.
        ...(defs !== undefined
          ? { fields: defs.map((d) => d.key), fieldDefs: defs }
          : input.fields !== undefined
            ? { fields: [...input.fields], fieldDefs: null }
            : {}),
        ...(input.topicChoice !== undefined ? { topicChoice: input.topicChoice } : {}),
        ...(input.redirectUrl !== undefined ? { redirectUrl: input.redirectUrl } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.turnstileSiteKey !== undefined ? { turnstileSiteKey: input.turnstileSiteKey || null } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      })
      .where(eq(forms.id, id))
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "form.update", target: id, before, after: row })
  return describe(row ?? before, yield* configured)
})

/** What the hosted page shows: the form, its live topics in its order, and the sender's brand. */
export const formPage = Effect.fn("forms.page")(function* (id: string) {
  const form = yield* findForm(id)
  if (form.archived) return yield* new FormNotFound({ id })
  const rows = yield* queryIn("forms.pageTopics", [...form.topicIds], (db, chunk) =>
    db
      .select({
        id: topics.id,
        name: topics.name,
        description: topics.description,
        archived: topics.archived,
      })
      .from(topics)
      .where(inArray(topics.id, chunk))
      .all(),
  )
  const live = form.topicIds.flatMap((t) => rows.filter((r) => r.id === t && !r.archived))
  const brand = yield* getBrand()
  return {
    form: describe(form, yield* configured),
    topics: live.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    brand,
  }
})

/**
 * Somebody filled in a public form. The answer never says whether the address was already
 * known, so a form can't be used to find out who is on the list.
 */
export const submitForm = Effect.fn("forms.submit")(function* (
  formId: string,
  input: {
    readonly email: string
    readonly name?: string | undefined
    readonly fields: Readonly<Record<string, unknown>>
    /** With `topicChoice: "pick"`: the topics the visitor ticked. */
    readonly topics?: ReadonlyArray<string> | undefined
  },
  origin: string,
  /** The submitting request's IP, browser and page (HAL-3426). */
  evidence?: ConsentEvidence | undefined,
) {
  const form = yield* findForm(formId)
  if (form.archived) return yield* new FormNotFound({ id: formId })
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/.test(email)) {
    return yield* new ContactInvalid({ field: "email", message: "Enter a valid email address." })
  }
  // Each field as its definition asks: required ones present, numbers numbers, a select one of its options.
  const allowed: Record<string, unknown> = {}
  for (const def of defsOf(form)) {
    const raw = input.fields[def.key]
    const text = raw === undefined || raw === null ? "" : String(raw).trim()
    if (def.type === "checkbox") {
      const on = raw === true || ["on", "true", "1", "yes"].includes(text.toLowerCase())
      if (def.required && !on)
        return yield* new ContactInvalid({ field: def.key, message: `Tick "${def.label}" to sign up.` })
      if (raw !== undefined) allowed[def.key] = on
      continue
    }
    if (text === "") {
      if (def.required)
        return yield* new ContactInvalid({ field: def.key, message: `Fill in "${def.label}".` })
      continue
    }
    if (def.type === "number") {
      const n = Number(text)
      if (!Number.isFinite(n))
        return yield* new ContactInvalid({ field: def.key, message: `"${def.label}" is a number.` })
      allowed[def.key] = n
    } else if (def.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)))
        return yield* new ContactInvalid({
          field: def.key,
          message: `"${def.label}" is a date (YYYY-MM-DD).`,
        })
      allowed[def.key] = text
    } else if (def.type === "select") {
      if (!(def.options ?? []).includes(text))
        return yield* new ContactInvalid({
          field: def.key,
          message: `Choose one of the options for "${def.label}".`,
        })
      allowed[def.key] = text
    } else allowed[def.key] = text.slice(0, 500)
  }
  // Which topics: all of the form's, or the ones the visitor ticked from them.
  const chosen =
    form.topicChoice === "pick"
      ? form.topicIds.filter((t) => (input.topics ?? []).includes(t))
      : form.topicIds
  if (chosen.length === 0)
    return yield* new ContactInvalid({ field: "topics", message: "Choose at least one list to join." })
  const { contact } = yield* upsertContact({
    email,
    name: input.name?.trim().slice(0, 200) || undefined,
    data: allowed,
    whenNew: "unconfirmed",
  })
  const signup: ConsentEvidence = {
    ...evidence,
    formId: form.id,
    formVersion: yield* Effect.promise(() => formVersion(form)),
  }
  const states: Array<"subscribed" | "unconfirmed"> = []
  for (const topicId of chosen) {
    const result = yield* Effect.result(
      subscribe(contact.id, topicId, { source: `form:${form.id}`, origin, evidence: signup }),
    )
    // A blocked or archived target is skipped quietly: the person sees the same answer either way.
    if (result._tag === "Success") states.push(result.success.state)
    else if ((result.failure as { _tag?: string })._tag === "DatabaseError")
      return yield* Effect.die(result.failure)
  }
  return {
    status: states.includes("unconfirmed") ? ("confirm" as const) : ("subscribed" as const),
    redirectUrl: form.redirectUrl,
  }
})

// ---------------------------------------------------------------------------------------------
// Submission stats (HAL-3424)
// ---------------------------------------------------------------------------------------------

export type FormOutcome = "subscribed" | "confirm" | "refused"

/** One signup's outcome, counted for its form and day. Never fails the visitor's request. */
export const recordFormOutcome = (formId: string, outcome: FormOutcome) =>
  Effect.gen(function* () {
    const database = yield* Database
    const day = new Date().toISOString().slice(0, 10)
    yield* database.query("forms.outcome", (db) =>
      db
        .insert(formDaily)
        .values({ formId, day, submissions: 1, [outcome]: 1 })
        .onConflictDoUpdate({
          target: [formDaily.formId, formDaily.day],
          set: {
            submissions: sql`${formDaily.submissions} + 1`,
            [outcome]: sql`${formDaily[outcome]} + 1`,
          },
        })
        .run(),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("forms: could not count a submission", cause)))

const STATS_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const

/** `GET /v1/forms/{id}/stats`: submissions by outcome, in total and per day, zeros included. */
export const formStats = Effect.fn("forms.stats")(function* (id: string, range: keyof typeof STATS_DAYS) {
  yield* findForm(id)
  const database = yield* Database
  const days = Array.from({ length: STATS_DAYS[range] }, (_, i) =>
    new Date(Date.now() - (STATS_DAYS[range] - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  )
  const rows = yield* database.query("forms.stats", (db) =>
    db
      .select()
      .from(formDaily)
      .where(and(eq(formDaily.formId, id), gte(formDaily.day, days[0] as string)))
      .all(),
  )
  const byDay = days.map((day) => {
    const r = rows.find((x) => x.day === day)
    return {
      day,
      submissions: r?.submissions ?? 0,
      subscribed: r?.subscribed ?? 0,
      confirm: r?.confirm ?? 0,
      refused: r?.refused ?? 0,
    }
  })
  const total = (k: "submissions" | "subscribed" | "confirm" | "refused") =>
    byDay.reduce((a, d) => a + d[k], 0)
  return {
    range,
    submissions: total("submissions"),
    subscribed: total("subscribed"),
    confirm: total("confirm"),
    refused: total("refused"),
    days: byDay,
  }
})

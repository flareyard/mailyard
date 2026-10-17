import { asc, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { forms, topics } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { recordAudit } from "./audit.ts"
import { ContactInvalid, normalizeEmail, upsertContact } from "./contacts.ts"
import { subscribe } from "./subscriptions.ts"

export class FormNotFound extends Schema.TaggedError<FormNotFound>()("FormNotFound", { id: Schema.String }) {}
export class FormInvalid extends Schema.TaggedError<FormInvalid>()("FormInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}

type FormRow = typeof forms.$inferSelect

const describe = (f: FormRow) => ({
  id: f.id,
  name: f.name,
  topicIds: f.topicIds,
  fields: f.fields,
  redirectUrl: f.redirectUrl,
  archived: f.archived,
  createdAt: f.createdAt,
})
export type FormView = ReturnType<typeof describe>

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const checkInput = (input: {
  readonly name?: string | undefined
  readonly topicIds?: ReadonlyArray<string> | undefined
  readonly fields?: ReadonlyArray<string> | undefined
  readonly redirectUrl?: string | null | undefined
}) =>
  Effect.gen(function* () {
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
      const database = yield* Database
      const found = yield* database.query("forms.topics", (db) =>
        db
          .select({ id: topics.id, archived: topics.archived })
          .from(topics)
          .where(inArray(topics.id, [...topicIds]))
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
  return rows.map(describe)
})

export const getForm = Effect.fn("forms.getView")(function* (id: string) {
  return describe(yield* findForm(id))
})

export const createForm = Effect.fn("forms.create")(function* (
  input: {
    readonly name: string
    readonly topicIds: ReadonlyArray<string>
    readonly fields?: ReadonlyArray<string> | undefined
    readonly redirectUrl?: string | null | undefined
  },
  actor: string,
) {
  yield* checkInput(input)
  const database = yield* Database
  const id = `frm_${yield* (yield* Ids).next}`
  const row = yield* database.query("forms.insert", (db) =>
    db
      .insert(forms)
      .values({
        id,
        name: input.name.trim(),
        topicIds: [...input.topicIds],
        fields: [...(input.fields ?? [])],
        redirectUrl: input.redirectUrl ?? null,
      })
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "form.create", target: id, after: row })
  return describe(row)
})

export const updateForm = Effect.fn("forms.update")(function* (
  id: string,
  input: {
    readonly name?: string | undefined
    readonly topicIds?: ReadonlyArray<string> | undefined
    readonly fields?: ReadonlyArray<string> | undefined
    readonly redirectUrl?: string | null | undefined
    readonly archived?: boolean | undefined
  },
  actor: string,
) {
  const before = yield* findForm(id)
  yield* checkInput(input)
  const database = yield* Database
  const row = yield* database.query("forms.update", (db) =>
    db
      .update(forms)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.topicIds !== undefined ? { topicIds: [...input.topicIds] } : {}),
        ...(input.fields !== undefined ? { fields: [...input.fields] } : {}),
        ...(input.redirectUrl !== undefined ? { redirectUrl: input.redirectUrl } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      })
      .where(eq(forms.id, id))
      .returning()
      .get(),
  )
  yield* recordAudit({ actor, action: "form.update", target: id, before, after: row })
  return describe(row ?? before)
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
  },
  origin: string,
) {
  const form = yield* findForm(formId)
  if (form.archived) return yield* new FormNotFound({ id: formId })
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/.test(email)) {
    return yield* new ContactInvalid({ field: "email", message: "Enter a valid email address." })
  }
  const allowed: Record<string, unknown> = {}
  for (const f of form.fields) if (f in input.fields) allowed[f] = String(input.fields[f]).slice(0, 500)
  const { contact } = yield* upsertContact({
    email,
    name: input.name?.trim().slice(0, 200) || undefined,
    data: allowed,
    whenNew: "unconfirmed",
  })
  const states: Array<"subscribed" | "unconfirmed"> = []
  for (const topicId of form.topicIds) {
    const result = yield* Effect.result(subscribe(contact.id, topicId, { source: `form:${form.id}`, origin }))
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

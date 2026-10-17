import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { filterCondition } from "../domain/contactFilters.ts"
import {
  type ContactConflict,
  type ContactInvalid,
  type ContactNotFound,
  contactTimeline,
  createContact,
  deleteContacts,
  eraseContact,
  exportContact,
  getContact,
  listContacts,
  updateContact,
} from "../domain/contacts.ts"
import {
  createForm,
  type FormInvalid,
  type FormNotFound,
  getForm,
  listForms,
  updateForm,
} from "../domain/forms.ts"
import type { SendRequestInvalid } from "../domain/outbox.ts"
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  previewSegment,
  type SegmentInUse,
  type SegmentInvalid,
  type SegmentNotFound,
  updateSegment,
} from "../domain/segments.ts"
import { bulkContacts, subscribe, unsubscribe } from "../domain/subscriptions.ts"
import {
  createTopic,
  getTopic,
  listTopics,
  type TopicInvalid,
  type TopicNotFound,
  updateTopic,
} from "../domain/topics.ts"
import { unsubscribeToken, unsubscribeUrl } from "../domain/unsubscribe.ts"
import { Conflict, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

type Faults = {
  readonly _tag:
    | "DatabaseError"
    | "BlobStoreError"
    | "ConsentKeyMissing"
    | "SenderError"
    | "TemplateMissing"
    | "TrackingKeyMissing"
}

/** Each audience error to its HTTP error; distributive, so a handler lists only what it can return. */
type AudienceHttp<E> = E extends ContactNotFound | TopicNotFound | FormNotFound | SegmentNotFound
  ? NotFound
  : E extends
        | ContactInvalid
        | TopicInvalid
        | FormInvalid
        | SegmentInvalid
        | SendRequestInvalid
        | { readonly _tag: "InvalidMessage" }
    ? InvalidRequest
    : E extends ContactConflict | SegmentInUse
      ? Conflict
      : E extends Faults
        ? never
        : E

const FAULTS = new Set([
  "TrackingKeyMissing",
  "DatabaseError",
  "BlobStoreError",
  "ConsentKeyMissing",
  "SenderError",
  "TemplateMissing",
])
const tagOf = (e: unknown) => (typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "")

/**
 * Not found is 404, bad input 400, a duplicate 409. Storage failures, a missing signing key and a
 * sender fault are the operator's to fix, so they surface as 500s rather than as the caller's error.
 */
export const audienceErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf((e): e is E => FAULTS.has(tagOf(e)), Effect.die),
    Effect.mapError((e) => {
      const err = e as { _tag: string; id?: string; field?: string; message?: string }
      switch (err._tag) {
        case "ContactNotFound":
          return new NotFound({ message: `Contact ${err.id} not found.` })
        case "TopicNotFound":
          return new NotFound({ message: `Topic ${err.id} not found.` })
        case "FormNotFound":
          return new NotFound({ message: `Form ${err.id} not found.` })
        case "SegmentNotFound":
          return new NotFound({ message: `Segment ${err.id} not found.` })
        case "ContactInvalid":
        case "TopicInvalid":
        case "FormInvalid":
        case "SegmentInvalid":
        case "SendRequestInvalid":
        case "InvalidMessage":
          return new InvalidRequest({
            field: err.field ?? "request",
            message: err.message ?? "Invalid request.",
          })
        case "ContactConflict":
        case "SegmentInUse":
          return new Conflict({ message: err.message ?? "Conflict." })
        default:
          return e
      }
    }),
  ) as unknown as Effect.Effect<A, AudienceHttp<E>, R>

export const ContactsHandlers = HttpApiBuilder.group(
  MailApi,
  "contacts",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) =>
        requireScope("read").pipe(
          Effect.andThen(filterCondition(query)),
          Effect.flatMap((extra) => listContacts(query, extra)),
          audienceErrors,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createContact(payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(Effect.andThen(getContact(params.id)), audienceErrors),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateContact(params.id, payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteContacts([params.id], caller.keyId)),
          Effect.flatMap((n) =>
            n === 0
              ? Effect.fail(new NotFound({ message: `Contact ${params.id} not found.` }))
              : Effect.succeed({ id: params.id, deleted: true }),
          ),
          audienceErrors,
        ),
      ),
      timeline: p(({ params, query }) =>
        requireScope("read").pipe(Effect.andThen(contactTimeline(params.id, query)), audienceErrors),
      ),
      setTopic: p(({ params, payload, request }) =>
        Effect.gen(function* () {
          yield* requireScope("admin")
          const result =
            payload.state === "subscribed"
              ? yield* subscribe(params.id, params.topicId, {
                  confirmed: payload.confirmed,
                  source: "api",
                  origin: originOf(request),
                })
              : { ...(yield* unsubscribe(params.id, params.topicId, "api")), confirmationSent: false }
          const contact = yield* getContact(params.id)
          return { contact, state: result.state, confirmationSent: result.confirmationSent }
        }).pipe(audienceErrors),
      ),
      bulk: p(({ payload, request }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) =>
            bulkContacts(payload.ids, payload.action, caller.keyId, originOf(request)),
          ),
          audienceErrors,
        ),
      ),
      export: p(({ params }) =>
        requireScope("admin").pipe(Effect.andThen(exportContact(params.id)), audienceErrors),
      ),
      preferencesLink: p(({ params, query, request }) =>
        Effect.gen(function* () {
          yield* requireScope("admin")
          yield* getContact(params.id)
          const token = yield* unsubscribeToken({
            contactId: params.id,
            topicId: query.topicId ?? null,
            campaignId: null,
          })
          return { url: unsubscribeUrl(originOf(request) ?? "", token) }
        }).pipe(audienceErrors),
      ),
      erase: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => eraseContact(params.id, caller.keyId)),
          audienceErrors,
        ),
      ),
    })
  }),
)

export const TopicsHandlers = HttpApiBuilder.group(
  MailApi,
  "topics",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("read").pipe(
          Effect.andThen(listTopics()),
          Effect.map((topics) => ({ topics })),
          audienceErrors,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createTopic(payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      get: p(({ params }) => requireScope("read").pipe(Effect.andThen(getTopic(params.id)), audienceErrors)),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateTopic(params.id, payload, caller.keyId)),
          audienceErrors,
        ),
      ),
    })
  }),
)

export const FormsHandlers = HttpApiBuilder.group(
  MailApi,
  "forms",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("read").pipe(
          Effect.andThen(listForms()),
          Effect.map((forms) => ({ forms })),
          audienceErrors,
        ),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createForm(payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      get: p(({ params }) => requireScope("read").pipe(Effect.andThen(getForm(params.id)), audienceErrors)),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateForm(params.id, payload, caller.keyId)),
          audienceErrors,
        ),
      ),
    })
  }),
)

export const SegmentsHandlers = HttpApiBuilder.group(
  MailApi,
  "segments",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(() =>
        requireScope("read").pipe(
          Effect.andThen(listSegments()),
          Effect.map((segments) => ({ segments })),
          audienceErrors,
        ),
      ),
      preview: p(({ payload }) =>
        requireScope("read").pipe(Effect.andThen(previewSegment(payload.filter)), audienceErrors),
      ),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createSegment(payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(Effect.andThen(getSegment(params.id)), audienceErrors),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateSegment(params.id, payload, caller.keyId)),
          audienceErrors,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteSegment(params.id, caller.keyId)),
          audienceErrors,
        ),
      ),
    })
  }),
)

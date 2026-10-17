import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  type CampaignInvalid,
  type CampaignLocked,
  type CampaignNotFound,
  campaignAudience,
  campaignChecks,
  createCampaign,
  deleteCampaign,
  describeCampaign,
  findCampaign,
  listCampaigns,
  renderCampaign,
  testCampaign,
  updateCampaign,
} from "../campaigns/campaigns.ts"
import { getCompliance, putCompliance } from "../campaigns/compliance.ts"
import type { CampaignContentInvalid } from "../campaigns/content.ts"
import { recordAudit } from "../domain/audit.ts"
import { Conflict, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

type Faults = {
  readonly _tag:
    | "DatabaseError"
    | "BlobStoreError"
    | "ConsentKeyMissing"
    | "SenderError"
    | "GovernorUnavailable"
}
type CampaignHttp<E> = E extends CampaignNotFound | { readonly _tag: "SegmentNotFound" }
  ? NotFound
  : E extends
        | CampaignInvalid
        | CampaignContentInvalid
        | { readonly _tag: "InvalidMessage" | "TemplateMissing" }
    ? InvalidRequest
    : E extends CampaignLocked
      ? Conflict
      : E extends Faults
        ? never
        : E

const FAULTS = new Set([
  "DatabaseError",
  "BlobStoreError",
  "ConsentKeyMissing",
  "SenderError",
  "GovernorUnavailable",
])
const tagOf = (e: unknown) => (typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "")

/** Unknown campaign 404, bad input or content 400, wrong state 409; storage and keys are 500s. */
export const campaignErrors = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf((e): e is E => FAULTS.has(tagOf(e)), Effect.die),
    Effect.mapError((e) => {
      const err = e as {
        _tag: string
        id?: string
        field?: string
        message?: string
        reason?: string
        template?: string
      }
      switch (err._tag) {
        case "CampaignNotFound":
          return new NotFound({ message: `Campaign ${err.id} not found.` })
        case "SegmentNotFound":
          return new NotFound({ message: `Segment ${err.id} not found.` })
        case "CampaignInvalid":
        case "CampaignContentInvalid":
          return new InvalidRequest({
            field: err.field ?? "request",
            message: err.message ?? "Invalid request.",
          })
        case "InvalidMessage":
          return new InvalidRequest({
            field: "content",
            message: err.reason ?? err.message ?? "The message is invalid.",
          })
        case "TemplateMissing":
          return new InvalidRequest({
            field: "templateId",
            message: `Template ${err.template} ${err.reason ?? "is missing"}.`,
          })
        case "CampaignLocked":
          return new Conflict({ message: err.message ?? "Conflict." })
        default:
          return e
      }
    }),
  ) as unknown as Effect.Effect<A, CampaignHttp<E>, R>

export const CampaignsHandlers = HttpApiBuilder.group(
  MailApi,
  "campaigns",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      list: p(({ query }) => requireScope("read").pipe(Effect.andThen(listCampaigns(query)), campaignErrors)),
      create: p(({ payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => createCampaign(payload, caller.keyId)),
          campaignErrors,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read").pipe(
          Effect.andThen(findCampaign(params.id)),
          Effect.map(describeCampaign),
          campaignErrors,
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => updateCampaign(params.id, payload, caller.keyId)),
          campaignErrors,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin").pipe(
          Effect.flatMap((caller) => deleteCampaign(params.id, caller.keyId)),
          campaignErrors,
        ),
      ),
      render: p(({ params, payload, request }) =>
        requireScope("read").pipe(
          Effect.andThen(renderCampaign(params.id, payload, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      test: p(({ params, payload, request }) =>
        requireScope("admin").pipe(
          Effect.andThen(testCampaign(params.id, payload.to, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      checks: p(({ params, request }) =>
        requireScope("read").pipe(
          Effect.andThen(campaignChecks(params.id, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      audiencePreview: p(({ params }) =>
        requireScope("read").pipe(Effect.andThen(campaignAudience(params.id)), campaignErrors),
      ),
      getCompliance: p(() => requireScope("read").pipe(Effect.andThen(getCompliance()), campaignErrors)),
      putCompliance: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin")
          const before = yield* getCompliance()
          const after = yield* putCompliance(payload)
          yield* recordAudit({
            actor: caller.keyId,
            action: "settings.compliance",
            target: "compliance",
            before,
            after,
          })
          return after
        }).pipe(campaignErrors),
      ),
    })
  }),
)

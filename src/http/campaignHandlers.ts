import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
  type CampaignInvalid,
  type CampaignLocked,
  type CampaignNotFound,
  campaignAudience,
  campaignChecks,
  campaignCounts,
  createCampaign,
  deleteCampaign,
  describeCampaign,
  findCampaign,
  listCampaigns,
  renderCampaign,
  testCampaign,
  updateCampaign,
} from "../campaigns/campaigns.ts"
import { getCompliance, putCompliance, recheckTrackingOrigin } from "../campaigns/compliance.ts"
import type { CampaignContentInvalid } from "../campaigns/content.ts"
import { campaignRecipients, campaignReport, resendDryRun, resendToNonOpeners } from "../campaigns/report.ts"
import {
  campaignSentCount,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
} from "../campaigns/send.ts"
import { refuseCampaignForLimitedKey } from "../domain/agents.ts"
import { recordAudit } from "../domain/audit.ts"
import { campaignRatePerHour } from "../domain/insights.ts"
import { parseParty } from "../domain/outbox.ts"
import { Governor } from "../services/Governor.ts"
import { Conflict, GovernorUnreachable, InvalidRequest, MailApi, NotFound } from "./Api.ts"
import { agentConflict, appContext, notWhileDeleting, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

type Faults = {
  readonly _tag:
    | "DatabaseError"
    | "BlobStoreError"
    | "ConsentKeyMissing"
    | "SenderError"
    | "GovernorUnavailable"
    | "TrackingKeyMissing"
}
type CampaignHttp<E> = E extends CampaignNotFound | { readonly _tag: "SegmentNotFound" }
  ? NotFound
  : E extends
        | CampaignInvalid
        | CampaignContentInvalid
        | { readonly _tag: "InvalidMessage" | "TemplateMissing" }
    ? InvalidRequest
    : E extends CampaignLocked | { readonly _tag: "CampaignStale" }
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
        case "CampaignStale": {
          const stale = e as unknown as {
            updatedAt: number | null
            updatedBy: string | null
            message: string
          }
          return new Conflict({
            message: stale.message,
            reason: "stale",
            updatedAt: stale.updatedAt,
            updatedBy: stale.updatedBy,
          })
        }
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
      list: p(({ query }) =>
        requireScope("read", "campaigns.read").pipe(Effect.andThen(listCampaigns(query)), campaignErrors),
      ),
      counts: p(() =>
        requireScope("read", "campaigns.read").pipe(Effect.andThen(campaignCounts()), campaignErrors),
      ),
      create: p(({ payload }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) => createCampaign(payload, caller.keyId)),
          campaignErrors,
        ),
      ),
      get: p(({ params }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(findCampaign(params.id)),
          Effect.map(describeCampaign),
          campaignErrors,
        ),
      ),
      update: p(({ params, payload }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) =>
            updateCampaign(
              params.id,
              { ...payload, ifMatch: payload.ifMatch === null ? undefined : payload.ifMatch },
              caller.keyId,
            ),
          ),
          campaignErrors,
        ),
      ),
      remove: p(({ params }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) => deleteCampaign(params.id, caller.keyId)),
          campaignErrors,
        ),
      ),
      render: p(({ params, payload, request }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(renderCampaign(params.id, payload, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      test: p(({ params, payload, request }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.tap(() => notWhileDeleting),
          Effect.tap((caller) =>
            refuseCampaignForLimitedKey(caller).pipe(
              Effect.catchTag("AgentLimited", (e) => Effect.fail(agentConflict(e))),
            ),
          ),
          Effect.andThen(testCampaign(params.id, payload.to, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      checks: p(({ params, request }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(campaignChecks(params.id, originOf(request) ?? "")),
          campaignErrors,
        ),
      ),
      audiencePreview: p(({ params }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(campaignAudience(params.id)),
          campaignErrors,
        ),
      ),
      schedule: p(({ params, payload, request }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.tap(() => notWhileDeleting),
          Effect.tap((caller) =>
            refuseCampaignForLimitedKey(caller).pipe(
              Effect.catchTag("AgentLimited", (e) => Effect.fail(agentConflict(e))),
            ),
          ),
          Effect.flatMap((caller) =>
            scheduleCampaign(params.id, payload, caller.keyId, originOf(request) ?? ""),
          ),
          campaignErrors,
        ),
      ),
      pause: p(({ params }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) => pauseCampaign(params.id, caller.keyId)),
          campaignErrors,
        ),
      ),
      resume: p(({ params }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) => resumeCampaign(params.id, caller.keyId)),
          campaignErrors,
        ),
      ),
      cancel: p(({ params }) =>
        requireScope("admin", "campaigns.write").pipe(
          Effect.flatMap((caller) => cancelCampaign(params.id, caller.keyId)),
          campaignErrors,
        ),
      ),
      pace: p(({ params }) =>
        Effect.gen(function* () {
          yield* requireScope("read", "campaigns.read")
          const campaign = yield* findCampaign(params.id)
          const sent = yield* campaignSentCount(params.id)
          const remaining = Math.max(0, (campaign.audienceSize ?? 0) - sent)
          const from = parseParty(campaign.fromAddress).email
          const pace = yield* Governor.use((g) =>
            g.campaign({
              campaignId: params.id,
              sendingDomain: from.slice(from.lastIndexOf("@") + 1),
              remaining,
            }),
          )
          const ratePerHour =
            pace.paused || campaign.status === "paused" ? null : yield* campaignRatePerHour(params.id)
          return { ...pace, remaining, ratePerHour }
        }).pipe(
          Effect.catchTag("GovernorUnavailable", () =>
            Effect.fail(
              new GovernorUnreachable({ message: "The send scheduler didn't answer; try again shortly." }),
            ),
          ),
          campaignErrors,
        ),
      ),
      report: p(({ params }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(campaignReport(params.id)),
          campaignErrors,
        ),
      ),
      recipients: p(({ params, query }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(campaignRecipients(params.id, query)),
          campaignErrors,
        ),
      ),
      resendNonOpeners: p(({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "campaigns.write")
          yield* notWhileDeleting
          yield* refuseCampaignForLimitedKey(caller).pipe(
            Effect.catchTag("AgentLimited", (e) => Effect.fail(agentConflict(e))),
          )
          const options = payload ?? {}
          const draft = yield* resendToNonOpeners(params.id, caller.keyId, options)
          yield* recordAudit({
            actor: caller.keyId,
            action: "campaign.resend",
            target: draft.id,
            after: {
              from: params.id,
              segmentId: draft.segmentId,
              countMachineOpensAsOpened: options.countMachineOpensAsOpened ?? false,
            },
          })
          return draft
        }).pipe(campaignErrors),
      ),
      resendNonOpenersDryRun: p(({ params, query }) =>
        requireScope("read", "campaigns.read").pipe(
          Effect.andThen(
            resendDryRun(params.id, {
              countMachineOpensAsOpened:
                query.countMachineOpensAsOpened === "true" || query.countMachineOpensAsOpened === "1",
            }),
          ),
          campaignErrors,
        ),
      ),
      getCompliance: p(() =>
        requireScope("read", "settings.read").pipe(Effect.andThen(getCompliance()), campaignErrors),
      ),
      recheckTracking: p(() =>
        requireScope("admin", "settings.write").pipe(Effect.andThen(recheckTrackingOrigin()), campaignErrors),
      ),
      putCompliance: p(({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "settings.write")
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

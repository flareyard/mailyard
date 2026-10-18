import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings } from "../Bindings.ts"
import {
  type DeletionRefused,
  deletionStatus,
  requestDeletion,
  restoreWorkspace,
} from "../domain/workspaceDeletion.ts"
import { deletionInstanceId } from "../workflows/workspaceDeletion.ts"
import { Conflict, InvalidRequest, MailApi } from "./Api.ts"
import { CurrentCaller, Forbidden } from "./Auth.ts"
import { appContext, provideTo, requireScope } from "./handlers.ts"
import { originOf } from "./mailHandlers.ts"

const released = (value: unknown) => {
  ;(value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]?.()
}

/** A refused deletion over HTTP: the wrong person 403, the wrong name 400, the wrong state 409. */
const refused = (e: DeletionRefused) =>
  Effect.fail(
    e.reason === "not-owner"
      ? new Forbidden({ message: e.message, reason: "owner" })
      : e.reason === "name-mismatch"
        ? new InvalidRequest({ field: "confirm", message: e.message })
        : new Conflict({ reason: e.reason, message: e.message }),
  )

/** Deleting the workspace, and calling it off (HAL-3448). */
export const WorkspaceHandlers = HttpApiBuilder.group(
  MailApi,
  "workspace",
  Effect.fn(function* (handlers) {
    const p = provideTo(yield* appContext)
    return handlers.handleAll({
      delete: p(({ payload, request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "workspace.owner")
          const { WORKSPACE_DELETION_WORKFLOW, WORKSPACE_EXPORT_WORKFLOW } = yield* Bindings
          return yield* requestDeletion(caller, payload.confirm, originOf(request) ?? "https://localhost", {
            export: async (exportId) => {
              released(
                await WORKSPACE_EXPORT_WORKFLOW.create({
                  id: `workspace-export-${exportId}`,
                  params: { exportId },
                }),
              )
            },
            deletion: async (record) => {
              released(
                await WORKSPACE_DELETION_WORKFLOW.create({
                  id: deletionInstanceId(record.requestedAt),
                  params: { deletesAt: record.deletesAt },
                }),
              )
            },
          })
        }).pipe(Effect.catchTags({ DeletionRefused: refused, DatabaseError: Effect.die })),
      ),
      restore: p(({ request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("admin", "workspace.owner")
          const { WORKSPACE_DELETION_WORKFLOW } = yield* Bindings
          const status = yield* deletionStatus(caller, originOf(request) ?? "https://localhost")
          const requestedAt = status.deletion?.requestedAt
          return yield* restoreWorkspace(caller, originOf(request) ?? "https://localhost", async () => {
            if (requestedAt === undefined) return
            const instance = await WORKSPACE_DELETION_WORKFLOW.get(deletionInstanceId(requestedAt))
            await instance.terminate()
            released(instance)
          })
        }).pipe(
          Effect.catchTags({
            DeletionRefused: refused,
            DatabaseError: Effect.die,
            FileLinkInvalid: Effect.die,
          }),
        ),
      ),
      deletion: p(({ request }) =>
        Effect.gen(function* () {
          const caller = yield* requireScope("read", "settings.read")
          return yield* deletionStatus(caller, originOf(request) ?? "https://localhost")
        }).pipe(Effect.catchTags({ DatabaseError: Effect.die, FileLinkInvalid: Effect.die })),
      ),
    })
  }),
)

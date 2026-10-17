import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { requireMailbox } from "../mail/access.ts"
import { authorize, problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

export { LIVE_PROTOCOL } from "./auth.ts"

/** `GET /v1/mailboxes/{id}/live`: a WebSocket of the mailbox's changes. */
export const LIVE_PATH = /^\/v1\/mailboxes\/([^/]+)\/live$/

export const handleLive = async (request: Request, env: Env, mailboxId: string) => {
  if (request.method !== "GET") return problem(405, "Use GET with a WebSocket upgrade.")
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "This endpoint is a WebSocket: send Upgrade: websocket.")
  }
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  const granted = await runtimeFor(env).runPromise(
    Effect.result(requireMailbox(auth.caller, mailboxId, "read")),
  )
  if (granted._tag === "Failure") {
    const failure = granted.failure
    return failure._tag === "MailboxMissing"
      ? problem(404, `Mailbox ${mailboxId} not found.`)
      : failure._tag === "MailboxAccessDenied"
        ? problem(403, failure.message)
        : problem(500, "Could not check access.")
  }
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))
  return stub.fetch("https://mailbox/live", {
    headers: { upgrade: "websocket", ...(auth.protocol ? { "x-mailyard-protocol": auth.protocol } : {}) },
  })
}

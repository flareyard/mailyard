import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { requireMailbox } from "../mail/access.ts"
import { authorize, problem } from "./auth.ts"
import { runtimeFor } from "./inbound.ts"

export const WAIT_PATH = /^\/v1\/mailboxes\/([^/]+)\/wait$/

/** Seconds a long-poll may wait: under the 60 s most proxies and clients cut idle requests at. */
export const MAX_WAIT_SECONDS = 50
const DEFAULT_WAIT_SECONDS = 25

/**
 * `GET /v1/mailboxes/{id}/wait?since=<cursor>&timeout=<seconds>` (HAL-3461): an agent blocks on new
 * mail without running a receiver. Answers `200 { cursor, messages, reset }` as soon as mail newer
 * than the cursor is in the mailbox (at once if it already is), or `204` with `x-mailyard-cursor` at
 * the timeout. Wait again from the cursor given. Without `since` it waits for mail from now on.
 */
export const handleWait = async (request: Request, env: Env, mailboxId: string) => {
  if (request.method !== "GET") return problem(405, "Use GET.")
  const url = new URL(request.url)
  const rawSince = url.searchParams.get("since")
  const since = rawSince === null || rawSince === "" ? null : Number(rawSince)
  if (since !== null && (!Number.isInteger(since) || since < 0))
    return problem(400, "since is a cursor from an earlier answer: a whole number.", { field: "since" })
  const rawTimeout = url.searchParams.get("timeout")
  const timeout = rawTimeout === null || rawTimeout === "" ? DEFAULT_WAIT_SECONDS : Number(rawTimeout)
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_WAIT_SECONDS)
    return problem(400, `timeout is 0 to ${MAX_WAIT_SECONDS} seconds.`, { field: "timeout" })
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
  const answer = await stub.waitForMail(since, timeout * 1000)
  if (answer.timedOut)
    return new Response(null, {
      status: 204,
      headers: { "x-mailyard-cursor": String(answer.cursor), "cache-control": "no-store" },
    })
  return Response.json(
    { cursor: answer.cursor, messages: answer.messages, reset: answer.reset },
    { headers: { "x-mailyard-cursor": String(answer.cursor), "cache-control": "no-store" } },
  )
}

import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Effect } from "effect"
import type { Env } from "../Bindings.ts"
import { mailboxes } from "../db/schema.ts"
import { authenticate } from "../domain/apiKeys.ts"
import { runtimeFor } from "./inbound.ts"

/** `GET /v1/mailboxes/{id}/live`: a WebSocket of the mailbox's changes. */
export const LIVE_PATH = /^\/v1\/mailboxes\/([^/]+)\/live$/

/** The subprotocol a browser asks for; it carries the key as a second one, `bearer.<key>`. */
export const LIVE_PROTOCOL = "mailyard.v1"

const problem = (status: number, message: string) =>
  Response.json({ error: { status, message } }, { status, headers: { "cache-control": "no-store" } })

/**
 * Browsers can't set headers on a WebSocket, so besides `Authorization: Bearer` the key may come as
 * the subprotocol pair `mailyard.v1, bearer.<key>`. It never goes in the URL, where logs would keep it.
 */
const credentials = (request: Request) => {
  const header = request.headers.get("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) return { token: header.slice(7).trim(), protocol: null }
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const bearer = offered.find((p) => p.startsWith("bearer."))
  if (offered.includes(LIVE_PROTOCOL) && bearer) return { token: bearer.slice(7), protocol: LIVE_PROTOCOL }
  return null
}

/** Mailboxes that hold mail have a live feed; aliases and groups don't. */
const HOLDS_MAIL = new Set(["user", "shared", "catch_all"])

export const handleLive = async (request: Request, env: Env, mailboxId: string) => {
  if (request.method !== "GET") return problem(405, "Use GET with a WebSocket upgrade.")
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "This endpoint is a WebSocket: send Upgrade: websocket.")
  }
  const auth = credentials(request)
  if (!auth)
    return problem(401, `Send Authorization: Bearer, or the subprotocols ${LIVE_PROTOCOL} and bearer.<key>.`)
  const caller = await runtimeFor(env).runPromise(Effect.result(authenticate(auth.token)))
  if (caller._tag === "Failure") return problem(401, caller.failure.reason)
  if (!caller.success.scopes.includes("read")) return problem(403, 'This key lacks the "read" scope.')
  const mailbox = await drizzle(env.DB)
    .select({ kind: mailboxes.kind })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .get()
  if (!mailbox || !HOLDS_MAIL.has(mailbox.kind)) return problem(404, `Mailbox ${mailboxId} not found.`)
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))
  return stub.fetch("https://mailbox/live", {
    headers: { upgrade: "websocket", ...(auth.protocol ? { "x-mailyard-protocol": auth.protocol } : {}) },
  })
}

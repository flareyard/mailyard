import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { requestEvidence } from "../domain/consentEvidence.ts"
import {
  oneClickUnsubscribe,
  preferences,
  requestPreferencesLink,
  resubscribe,
  savePreferences,
} from "../domain/unsubscribe.ts"
import { publicLook } from "../public/look.ts"
import { linkOrigin } from "../public/origin.ts"
import { invalidLinkPage, page, preferencePage } from "../public/pages.ts"
import { glyph, type NoticeKind } from "../public/shell.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * `/u/{token}`. GET shows the preference page. POST is either RFC 8058's one-click (the body is
 * `List-Unsubscribe=One-Click`, sent by the mailbox provider itself) or the page's own form.
 */
export const handleUnsubscribe = async (request: Request, env: Env, token: string) => {
  const run = runtimeFor(env)
  const look = await run.runPromise(publicLook)
  if (request.method === "GET" || request.method === "HEAD") {
    const prefs = await run.runPromise(Effect.result(preferences(token)))
    return prefs._tag === "Success" ? preferencePage(look, prefs.success, null) : invalidLinkPage(look)
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } })
  const form = await request.formData().catch(() => null)
  const oneClick = form?.get("List-Unsubscribe") === "One-Click"
  if (oneClick || !form) {
    // A provider's one-click must succeed without a page; it wants a 2xx and nothing else.
    const done = await run.runPromise(Effect.result(oneClickUnsubscribe(token, "one-click")))
    if (done._tag === "Success") return new Response(null, { status: 200 })
    return new Response(null, {
      status: (done.failure as { _tag?: string })._tag === "ContactNotFound" ? 200 : 400,
    })
  }
  const action = form.get("action")
  let message: { kind: NoticeKind; html: string }
  if (action === "resubscribe") {
    const done = await run.runPromise(Effect.result(resubscribe(token)))
    if (done._tag === "Failure") {
      const tag = (done.failure as { _tag?: string })._tag
      if (tag !== "ResubscribeUnavailable") return invalidLinkPage(look)
      message = {
        kind: "warning",
        html: "It's too late to undo that from here. Tick the lists you'd like and save.",
      }
    } else message = { kind: "success", html: "Welcome back: you're subscribed again." }
  } else {
    const all = action === "all"
    const subscribed = form.getAll("topic").filter((v): v is string => typeof v === "string")
    const saved = await run.runPromise(
      Effect.result(savePreferences(token, { subscribed, all }, requestEvidence(request, "/u"))),
    )
    if (saved._tag === "Failure") return invalidLinkPage(look)
    message = all
      ? {
          kind: "success",
          html: "You're unsubscribed from everything. You won't get any more of these emails.",
        }
      : { kind: "success", html: "Your choices are saved." }
  }
  const prefs = await run.runPromise(Effect.result(preferences(token)))
  if (prefs._tag === "Failure") return invalidLinkPage(look)
  return preferencePage(look, prefs.success, message)
}

export const REQUEST_LINK_PATH = /^\/p\/request$/

/**
 * `POST /p/request { email }`: a fresh preference link by email. Rate limited by IP, and the page
 * says the same thing whether or not the address is on a list.
 */
export const handleRequestLink = async (request: Request, env: Env) => {
  const run = runtimeFor(env)
  const look = await run.runPromise(publicLook)
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } })
  if (env.FORM_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
    const { success } = await env.FORM_LIMITER.limit({ key: `prefs-link:${ip}` })
    if (!success)
      return page(
        look,
        "Too many tries",
        `${glyph(429)}<h1>Too many tries</h1><p class="muted">Wait a minute and try again.</p>`,
        429,
      )
  }
  const form = await request.formData().catch(() => null)
  const email = typeof form?.get("email") === "string" ? String(form?.get("email")) : ""
  await run.runPromise(
    requestPreferencesLink(email, linkOrigin(request.url) ?? new URL(request.url).origin).pipe(
      Effect.orElseSucceed(() => null),
    ),
  )
  return page(
    look,
    "Check your inbox",
    `${glyph(200, "info")}<h1>Check your inbox</h1><p class="muted">If that address is on one of our lists, a new link to your preferences is on its way. It can take a few minutes.</p>`,
  )
}

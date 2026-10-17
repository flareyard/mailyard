import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { findForm, formPage, submitForm } from "../domain/forms.ts"
import { confirmSubscription } from "../domain/subscriptions.ts"
import { pageCsp, renderFormPage } from "../forms/page.ts"
import { verifyTurnstile } from "../forms/turnstile.ts"
import { runtimeFor } from "./inbound.ts"

/**
 * Pages and endpoints people reach without an API key: the double opt-in link and signup form
 * posts. They answer in HTML for a browser and in JSON for a script, and never reveal whether an
 * address was already on a list.
 */
export const CONFIRM_PATH = /^\/c\/([^/]+)$/
export const FORM_SUBMIT_PATH = /^\/v1\/forms\/([^/]+)\/submit$/
export const FORM_PAGE_PATH = /^\/f\/([^/]+)$/

/** `GET /f/{formId}`: the hosted signup page, in the sender's brand. */
export const handleFormPage = async (request: Request, env: Env, formId: string) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 })
  const result = await runtimeFor(env).runPromise(Effect.result(formPage(formId)))
  if (result._tag === "Failure") {
    const tag = (result.failure as { _tag?: string })._tag
    return tag === "FormNotFound"
      ? page(404, "Form not found", "This signup form no longer exists.")
      : page(500, "Something went wrong", "Please try again in a moment.")
  }
  const { form, topics, brand } = result.success
  const html = renderFormPage({
    form,
    topics,
    theme: brand.theme,
    brandName: brand.theme.name,
    siteUrl: brand.siteUrl === "https://example.com" ? null : brand.siteUrl,
    action: `/v1/forms/${encodeURIComponent(form.id)}/submit`,
  })
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": pageCsp(brand.theme.fontsHref),
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  })
}

/** Field names bots fill in and people can't see. A filled one gets a success page and no subscription. */
const HONEYPOTS = ["_hp", "website"]

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const page = (status: number, title: string, message: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:28rem}h1{font-size:1.4rem;margin:0 0 .5rem}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  )

export const handleConfirm = async (env: Env, token: string) => {
  const result = await runtimeFor(env).runPromise(Effect.result(confirmSubscription(token)))
  if (result._tag === "Success") {
    if (result.success.blocked) {
      return page(
        200,
        "We can't send to this address",
        "Mail to this address bounced or was reported, so we've paused it.",
      )
    }
    return page(200, "You're subscribed", `Thanks: you'll now receive ${result.success.topic}.`)
  }
  const reason = (result.failure as { reason?: string; _tag?: string }).reason
  if (reason === "expired")
    return page(410, "This link has expired", "Sign up again and we'll send a fresh link.")
  if ((result.failure as { _tag?: string })._tag === "ConsentKeyMissing") {
    return page(503, "Something's not set up", "This mailing list can't confirm subscriptions right now.")
  }
  return page(400, "This link isn't valid", "Check you copied the whole link from the email.")
}

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const type = request.headers.get("content-type") ?? ""
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as unknown
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null
    }
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const form = await request.formData()
      const out: Record<string, unknown> = {}
      for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v
      return out
    }
  } catch {
    return null
  }
  return null
}

const wantsHtml = (request: Request) =>
  !(request.headers.get("content-type") ?? "").includes("application/json") &&
  (request.headers.get("accept") ?? "").includes("text/html")

export const handleFormSubmit = async (request: Request, env: Env, formId: string) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
      },
    })
  }
  const cors = { "access-control-allow-origin": "*" }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors })
  const html = wantsHtml(request)
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
  if (env.FORM_LIMITER) {
    const { success } = await env.FORM_LIMITER.limit({ key: `${formId}:${ip}` })
    if (!success) {
      return html
        ? page(429, "Too many tries", "Wait a minute and try again.")
        : Response.json({ error: "rate_limited" }, { status: 429, headers: { ...cors, "retry-after": "60" } })
    }
  }
  const body = await readBody(request)
  if (!body) return Response.json({ error: "invalid_body" }, { status: 400, headers: cors })
  const done = (status: "confirm" | "subscribed", redirectUrl: string | null) => {
    if (html && redirectUrl) return Response.redirect(redirectUrl, 303)
    if (html) {
      return status === "confirm"
        ? page(200, "Check your inbox", "We've sent you a link to confirm your subscription.")
        : page(200, "You're subscribed", "Thanks for signing up.")
    }
    return Response.json({ status }, { headers: cors })
  }
  if (HONEYPOTS.some((f) => typeof body[f] === "string" && body[f] !== "")) return done("confirm", null)
  // Turnstile, when this form has a site key and the deploy has the secret: checked before anything is written.
  if (env.TURNSTILE_SECRET) {
    const found = await runtimeFor(env).runPromise(Effect.result(findForm(formId)))
    const siteKey = found._tag === "Success" ? found.success.turnstileSiteKey : null
    if (siteKey) {
      const verdict = await verifyTurnstile({
        secret: env.TURNSTILE_SECRET,
        token: body["cf-turnstile-response"],
        ip: request.headers.get("cf-connecting-ip"),
      })
      if (!verdict.ok) {
        return html
          ? page(
              400,
              "Please try again",
              "We couldn't confirm you're a person. Go back, complete the check and sign up again.",
            )
          : Response.json({ error: "challenge" }, { status: 400, headers: cors })
      }
    }
  }
  const { email, name, "cf-turnstile-response": _token, ...fields } = body
  if (typeof email !== "string") {
    return html
      ? page(400, "Email needed", "Enter your email address to sign up.")
      : Response.json({ error: "invalid", field: "email" }, { status: 400, headers: cors })
  }
  const origin = new URL(request.url).origin
  const result = await runtimeFor(env).runPromise(
    Effect.result(
      submitForm(formId, { email, ...(typeof name === "string" ? { name } : {}), fields }, origin),
    ),
  )
  if (result._tag === "Success") return done(result.success.status, result.success.redirectUrl)
  const failure = result.failure as { _tag?: string; field?: string; message?: string }
  if (failure._tag === "FormNotFound") {
    return html
      ? page(404, "Form not found", "This signup form no longer exists.")
      : Response.json({ error: "not_found" }, { status: 404, headers: cors })
  }
  if (failure._tag === "ContactInvalid") {
    return html
      ? page(400, "Check your email address", failure.message ?? "Enter a valid email address.")
      : Response.json({ error: "invalid", field: failure.field ?? "email" }, { status: 400, headers: cors })
  }
  console.error("form submit failed", failure._tag)
  return html
    ? page(500, "Something went wrong", "Please try again in a moment.")
    : Response.json({ error: "internal" }, { status: 500, headers: cors })
}

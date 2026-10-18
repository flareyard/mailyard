import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { type FormOutcome, findForm, formPage, recordFormOutcome, submitForm } from "../domain/forms.ts"
import { confirmSubscription } from "../domain/subscriptions.ts"
import { type Filled, pageCsp, renderFormPage } from "../forms/page.ts"
import { verifyTurnstile } from "../forms/turnstile.ts"
import { publicLook } from "../public/look.ts"
import { linkOrigin } from "../public/origin.ts"
import { type ResultExtra, resultPage } from "../public/pages.ts"
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
  return formPageResponse(env, formId, { head: request.method === "HEAD" })
}

/**
 * The form page, fresh or (after a failed submit) with what was typed and the error beside its
 * field (HAL-3443), so nobody retypes a whole form for one mistake.
 */
const formPageResponse = async (
  env: Env,
  formId: string,
  options: { readonly head?: boolean; readonly filled?: Filled; readonly status?: number } = {},
) => {
  const result = await runtimeFor(env).runPromise(Effect.result(formPage(formId)))
  if (result._tag === "Failure") {
    const tag = (result.failure as { _tag?: string })._tag
    return tag === "FormNotFound"
      ? await page(env, 404, "Form not found", "This signup form no longer exists.")
      : await page(env, 500, "Something went wrong", "Please try again in a moment.")
  }
  const { form, topics } = result.success
  // The same look as /u, /c and /v: the workspace's brand or Flareyard's, and the compliance footer.
  const look = await runtimeFor(env).runPromise(publicLook)
  const html = renderFormPage({
    form,
    topics,
    theme: look.theme,
    postalAddress: look.postalAddress,
    privacyUrl: look.privacyUrl,
    action: `/v1/forms/${encodeURIComponent(form.id)}/submit`,
    filled: options.filled,
  })
  return new Response(options.head ? null : html, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": pageCsp(look.theme.fontsHref),
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  })
}

/** Field names bots fill in and people can't see. A filled one gets a success page and no subscription. */
const HONEYPOTS = ["_hp", "website"]

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** A result page in the sender's brand (or Flareyard's look), with the compliance footer. */
const page = async (env: Env, status: number, title: string, message: string, extra?: ResultExtra) =>
  resultPage(await runtimeFor(env).runPromise(publicLook), status, title, message, extra)

export const handleConfirm = async (env: Env, token: string) => {
  const result = await runtimeFor(env).runPromise(Effect.result(confirmSubscription(token)))
  if (result._tag === "Success") {
    if (result.success.blocked) {
      return await page(
        env,
        200,
        "We can't send to this address",
        "Mail to this address bounced or was reported, so we've paused it.",
      )
    }
    // From a signup form with a redirect: there, after a moment to read this (works without JavaScript).
    const form = result.success.formId
      ? await runtimeFor(env).runPromise(Effect.option(findForm(result.success.formId)))
      : null
    const redirectUrl = form && form._tag === "Some" ? form.value.redirectUrl : null
    return await page(env, 200, "You're subscribed", `Thanks: you'll now receive ${result.success.topic}.`, {
      kind: "success",
      ...(redirectUrl ? { redirect: { url: redirectUrl, after: 3 } } : {}),
    })
  }
  const reason = (result.failure as { reason?: string; _tag?: string }).reason
  if (reason === "expired")
    return await page(env, 410, "This link has expired", "Sign up again and we'll send a fresh link.")
  if ((result.failure as { _tag?: string })._tag === "ConsentKeyMissing") {
    return await page(
      env,
      503,
      "Something's not set up",
      "This mailing list can't confirm subscriptions right now.",
    )
  }
  return await page(env, 400, "This link isn't valid", "Check you copied the whole link from the email.")
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
      // Ticked topics arrive as a repeated field.
      const topics = form.getAll("topics").filter((v): v is string => typeof v === "string")
      if (topics.length) out.topics = topics
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
  // Every submission is counted by outcome, for the form's stats (HAL-3424).
  const count = (outcome: FormOutcome) => runtimeFor(env).runPromise(recordFormOutcome(formId, outcome))
  if (env.FORM_LIMITER) {
    const { success } = await env.FORM_LIMITER.limit({ key: `${formId}:${ip}` })
    if (!success) {
      await count("refused")
      return html
        ? await formPageResponse(env, formId, {
            status: 429,
            filled: { values: {}, field: null, message: "Too many tries. Wait a minute and try again." },
          })
        : Response.json({ error: "rate_limited" }, { status: 429, headers: { ...cors, "retry-after": "60" } })
    }
  }
  const body = await readBody(request)
  if (!body) return Response.json({ error: "invalid_body" }, { status: 400, headers: cors })
  const done = async (status: "confirm" | "subscribed", redirectUrl: string | null) => {
    if (html && redirectUrl) return Response.redirect(redirectUrl, 303)
    if (html) {
      return status === "confirm"
        ? await page(env, 200, "Check your inbox", "We've sent you a link to confirm your subscription.", {
            kind: "info",
          })
        : await page(env, 200, "You're subscribed", "Thanks for signing up.", { kind: "success" })
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
        await count("refused")
        return html
          ? await formPageResponse(env, formId, {
              status: 400,
              filled: {
                values: body,
                field: null,
                message: "We couldn't confirm you're a person. Complete the check and sign up again.",
              },
            })
          : Response.json({ error: "challenge" }, { status: 400, headers: cors })
      }
    }
  }
  const { email, name, "cf-turnstile-response": _token, topics: picked, ...fields } = body
  if (typeof email !== "string") {
    await count("refused")
    return html
      ? await formPageResponse(env, formId, {
          status: 400,
          filled: { values: body, field: "email", message: "Enter your email address to sign up." },
        })
      : Response.json({ error: "invalid", field: "email" }, { status: 400, headers: cors })
  }
  const origin = linkOrigin(request.url) ?? new URL(request.url).origin
  const result = await runtimeFor(env).runPromise(
    Effect.result(
      submitForm(
        formId,
        {
          email,
          ...(typeof name === "string" ? { name } : {}),
          fields,
          topics: Array.isArray(picked)
            ? picked.filter((t): t is string => typeof t === "string")
            : typeof picked === "string"
              ? [picked]
              : [],
        },
        origin,
      ),
    ),
  )
  if (result._tag === "Success") {
    await count(result.success.status === "confirm" ? "confirm" : "subscribed")
    return done(result.success.status, result.success.redirectUrl)
  }
  const failure = result.failure as { _tag?: string; field?: string; message?: string }
  if (failure._tag === "FormNotFound") {
    return html
      ? await page(env, 404, "Form not found", "This signup form no longer exists.")
      : Response.json({ error: "not_found" }, { status: 404, headers: cors })
  }
  if (failure._tag === "ContactInvalid") {
    await count("refused")
    return html
      ? await formPageResponse(env, formId, {
          status: 400,
          filled: {
            values: body,
            // Custom fields are named as the form names them; the error goes under that control.
            field: failure.field ? failure.field.replace(/^fields\./, "") : null,
            message: failure.message ?? "Enter a valid email address.",
          },
        })
      : Response.json({ error: "invalid", field: failure.field ?? "email" }, { status: 400, headers: cors })
  }
  console.error("form submit failed", failure._tag)
  return html
    ? await page(env, 500, "Something went wrong", "Please try again in a moment.")
    : Response.json({ error: "internal" }, { status: 500, headers: cors })
}

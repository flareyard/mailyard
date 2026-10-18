import { and, desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { Env } from "../Bindings.ts"
import { findCampaign } from "../campaigns/campaigns.ts"
import { renderFor } from "../campaigns/content.ts"
import { contacts, messagesOut } from "../db/schema.ts"
import { ConsentTokenInvalid, verifyConsent } from "../domain/consent.ts"
import { decodeRendered } from "../domain/outbox.ts"
import { BlobStore } from "../kit/index.ts"
import { publicLook } from "../public/look.ts"
import { linkOrigin } from "../public/origin.ts"
import { glyph, shellPage } from "../public/shell.ts"
import { Database } from "../services/Database.ts"
import { runtimeFor } from "./inbound.ts"

/** The open pixel, removed from the browser copy so reading it there isn't counted as an open. */
const PIXEL = /<img\b[^>]*\/t\/o\/[^>]*>/gi

/**
 * The HTML of a campaign as one recipient got it: the stored copy of their message when it was
 * sent, else (a test send, or not sent yet) a fresh render, with the recipient's merge fields when
 * there is one. The open pixel is stripped; tracked links still work.
 */
export const viewHtml = Effect.fn("view.html")(function* (token: string, origin: string) {
  const payload = yield* verifyConsent(token)
  if (payload.kind !== "view") return yield* new ConsentTokenInvalid({ reason: "kind" })
  const campaign = yield* findCampaign(payload.campaignId)
  const database = yield* Database
  if (payload.contactId) {
    const sent = yield* database.query("view.message", (db) =>
      db
        .select({ renderedKey: messagesOut.renderedKey })
        .from(messagesOut)
        .where(
          and(
            eq(messagesOut.contactId, payload.contactId as string),
            eq(messagesOut.campaignId, campaign.id),
            eq(messagesOut.stream, "campaign"),
          ),
        )
        .orderBy(desc(messagesOut.createdAt))
        .get(),
    )
    if (sent?.renderedKey) {
      const blob = yield* (yield* BlobStore).get(sent.renderedKey)
      if (Option.isSome(blob)) {
        const message = decodeRendered(new TextDecoder().decode(blob.value.body))
        if (message.html) return { subject: message.subject, html: message.html.replace(PIXEL, "") }
      }
    }
  }
  const contact = payload.contactId
    ? yield* database.query("view.contact", (db) =>
        db
          .select()
          .from(contacts)
          .where(eq(contacts.id, payload.contactId as string))
          .get(),
      )
    : undefined
  const { message } = yield* renderFor(
    campaign,
    contact
      ? { contactId: contact.id, email: contact.email, name: contact.name, fields: contact.fields }
      : { contactId: null, email: "preview@example.com", name: null, fields: {} },
    { origin },
  )
  return { subject: message.subject, html: (message.html ?? "").replace(PIXEL, "") }
})

/** No scripts, no frames, nothing posted: the email's own markup, images and styles only. */
const VIEW_CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** `GET /v/{token}`: "view in browser". */
export const handleView = async (request: Request, env: Env, token: string) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } })
  const run = runtimeFor(env)
  const result = await run.runPromise(
    Effect.result(viewHtml(token, linkOrigin(request.url) ?? new URL(request.url).origin)),
  )
  if (result._tag === "Success")
    return new Response(request.method === "HEAD" ? null : result.success.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "content-security-policy": VIEW_CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
      },
    })
  const tag = (result.failure as { _tag?: string })._tag
  const look = await run.runPromise(publicLook)
  const gone = tag === "CampaignNotFound"
  return shellPage({
    theme: look.theme,
    title: gone ? "Email not found" : "Link not valid",
    status: gone ? 404 : 400,
    postalAddress: look.postalAddress,
    privacyUrl: look.privacyUrl,
    body: gone
      ? `${glyph(404)}<h1>This email isn't available</h1><p class="muted">It may have been removed.</p>`
      : `${glyph(400)}<h1>This link isn't valid</h1><p class="muted">Check you opened the whole link from the email.</p>`,
  })
}

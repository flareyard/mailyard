import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type campaigns, topics } from "../db/schema.ts"
import { getBrand } from "../domain/brand.ts"
import { parseParty } from "../domain/outbox.ts"
import { resolveForSend } from "../domain/templates.ts"
import { unsubscribeHeaders } from "../domain/unsubscribe.ts"
import type { Outgoing } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { type Rendered, renderTemplate, type TemplateSource } from "../templates/render.ts"
import { getCompliance } from "./compliance.ts"

type CampaignRow = typeof campaigns.$inferSelect

export class CampaignContentInvalid extends Schema.TaggedError<CampaignContentInvalid>()(
  "CampaignContentInvalid",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export interface Recipient {
  /** null for a seed address that isn't a contact: its links work but change nothing. */
  readonly contactId: string | null
  readonly email: string
  readonly name: string | null
  readonly fields: Readonly<Record<string, unknown>>
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/**
 * What a campaign sends: its template at the version it will use (the frozen one once scheduled,
 * else the published one), or its inline HTML. The campaign's subject always wins.
 */
export const contentOf = Effect.fn("campaigns.content")(function* (campaign: CampaignRow) {
  if (campaign.templateId) {
    const resolved = yield* resolveForSend(campaign.templateId, campaign.templateVersion ?? "published")
    return {
      source: { ...resolved.source, subject: campaign.subject } as TemplateSource,
      templateId: resolved.template.id,
      templateVersion: resolved.version.version,
    }
  }
  if (!campaign.bodyHtml) {
    return yield* new CampaignContentInvalid({
      field: "bodyHtml",
      message: "A campaign needs a template or a body.",
    })
  }
  return {
    source: {
      kind: "html",
      subject: campaign.subject,
      source: campaign.bodyHtml,
      ...(campaign.bodyText ? { text: campaign.bodyText } : {}),
    } as TemplateSource,
    templateId: null,
    templateVersion: null,
  }
})

/** The footer bulk mail must have, added when the content doesn't already link to unsubscribe. */
export const footer = (input: {
  readonly reason: string
  readonly unsubscribeUrl: string
  readonly preferencesUrl: string
  readonly postalAddress: string | null
}) => ({
  html: `<div style="margin:24px auto 0;max-width:600px;padding:16px;font:12px/1.5 system-ui,sans-serif;color:#6b7280;text-align:center">${esc(input.reason)}<br><a href="${esc(input.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a> · <a href="${esc(input.preferencesUrl)}" style="color:#6b7280">Manage preferences</a>${input.postalAddress ? `<br>${esc(input.postalAddress)}` : ""}</div>`,
  text: `\n\n--\n${input.reason}\nUnsubscribe: ${input.unsubscribeUrl}\nManage preferences: ${input.preferencesUrl}${input.postalAddress ? `\n${input.postalAddress}` : ""}\n`,
})

export const withPreheader = (html: string, preheader: string | null) => {
  if (!preheader) return html
  const hidden = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>`
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => `${m}${hidden}`) : `${hidden}${html}`
}

export const withFooter = (html: string, block: string) =>
  /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`

/** Everything a campaign's messages share, loaded once per batch rather than once per recipient. */
export const prepareRender = Effect.fn("campaigns.prepareRender")(function* (campaign: CampaignRow) {
  const { source, templateId, templateVersion } = yield* contentOf(campaign)
  const brand = yield* getBrand()
  const compliance = yield* getCompliance()
  const database = yield* Database
  const topic = campaign.topicId
    ? yield* database.query("campaigns.topic", (db) =>
        db
          .select({ name: topics.name })
          .from(topics)
          .where(eq(topics.id, campaign.topicId as string))
          .get(),
      )
    : undefined
  const from = parseParty(campaign.fromAddress)
  return {
    campaign,
    source,
    templateId,
    templateVersion,
    brand,
    compliance,
    topicName: topic?.name ?? null,
    from,
    mailDomain: from.email.slice(from.email.lastIndexOf("@") + 1),
  }
})
export type RenderContext = Effect.Success<ReturnType<typeof prepareRender>>

/**
 * One recipient's message: merge fields, the unsubscribe and preference links (as `{{unsubscribe_url}}`
 * and `{{preferences_url}}` for templates that place them), the footer when a template doesn't,
 * the preheader, and the List-Unsubscribe headers.
 */
export const renderWith = Effect.fn("campaigns.renderWith")(function* (
  ctx: RenderContext,
  recipient: Recipient,
  options: { readonly origin: string; readonly variant?: "a" | "b"; readonly test?: boolean },
) {
  const { campaign, source, brand, compliance, from, mailDomain, topicName } = ctx
  const links = yield* unsubscribeHeaders({
    contactId: recipient.contactId ?? "test",
    topicId: campaign.topicId,
    campaignId: campaign.id,
    origin: options.origin,
    mailDomain,
    listName: topicName ?? undefined,
  })
  const preferences = yield* unsubscribeHeaders({
    contactId: recipient.contactId ?? "test",
    topicId: null,
    campaignId: campaign.id,
    origin: options.origin,
    mailDomain,
  })
  const subject = options.variant === "b" && campaign.subjectB ? campaign.subjectB : campaign.subject
  const vars = {
    ...recipient.fields,
    email: recipient.email,
    name: recipient.name,
    unsubscribe_url: links.url,
    preferences_url: preferences.url,
    campaign: { name: campaign.name },
    topic: topicName,
  }
  const rendered: Rendered = yield* Effect.try({
    try: () => renderTemplate({ ...source, subject }, vars, brand),
    catch: (e) =>
      new CampaignContentInvalid({ field: "template", message: e instanceof Error ? e.message : String(e) }),
  })
  const reason = topicName
    ? `You're receiving this because you subscribed to ${topicName} from ${brand.theme.name}.`
    : `You're receiving this because you're on ${brand.theme.name}'s mailing list.`
  const needsFooter = !rendered.html.includes(links.url) && !rendered.html.includes(preferences.url)
  const block = footer({
    reason,
    unsubscribeUrl: links.url,
    preferencesUrl: preferences.url,
    postalAddress: compliance.postalAddress,
  })
  const html = withPreheader(
    needsFooter ? withFooter(rendered.html, block.html) : rendered.html,
    campaign.preheader,
  )
  const text = needsFooter ? `${rendered.text}${block.text}` : rendered.text
  const message: Outgoing = {
    from: from.name ? { email: from.email, name: from.name } : { email: from.email },
    to: [recipient.name ? { email: recipient.email, name: recipient.name } : { email: recipient.email }],
    ...(campaign.replyTo ? { replyTo: { email: parseParty(campaign.replyTo).email } } : {}),
    subject: options.test ? `[Test] ${rendered.subject}` : rendered.subject,
    html,
    text,
    headers: links.headers,
  }
  return {
    message,
    unsubscribeUrl: links.url,
    footerAdded: needsFooter,
    size: new TextEncoder().encode(html).length,
  }
})

/** renderWith for a single message: the editor's preview and test sends. */
export const renderFor = Effect.fn("campaigns.renderFor")(function* (
  campaign: CampaignRow,
  recipient: Recipient,
  options: { readonly origin: string; readonly variant?: "a" | "b"; readonly test?: boolean },
) {
  return yield* renderWith(yield* prepareRender(campaign), recipient, options)
})

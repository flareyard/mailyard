import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { getCompliance } from "../campaigns/compliance.ts"
import { footer, withFooter } from "../campaigns/content.ts"
import { topics } from "../db/schema.ts"
import { getBrand } from "../domain/brand.ts"
import { parseParty } from "../domain/outbox.ts"
import { resolveForSend } from "../domain/templates.ts"
import { unsubscribeHeaders } from "../domain/unsubscribe.ts"
import type { Outgoing } from "../kit/index.ts"
import { Database } from "../services/Database.ts"
import { renderTemplate } from "../templates/render.ts"

/**
 * One automation email, rendered the way campaign mail is: the template at the version the step
 * names, the contact's fields as merge data (plus the trigger's data as `trigger.*`), unsubscribe
 * and preference links, the footer when the template doesn't link to them, and List-Unsubscribe.
 */
export const renderAutomationMail = Effect.fn("automations.renderMail")(function* (input: {
  readonly templateId: string
  readonly version: number | "published"
  readonly subject: string | null
  readonly fromAddress: string
  readonly topicId: string | null
  readonly origin: string
  readonly automationName: string
  readonly contact: {
    readonly id: string
    readonly email: string
    readonly name: string | null
    readonly fields: Readonly<Record<string, unknown>>
  }
  readonly triggerData: Readonly<Record<string, unknown>> | null
}) {
  const resolved = yield* resolveForSend(input.templateId, input.version)
  const brand = yield* getBrand()
  const compliance = yield* getCompliance()
  const database = yield* Database
  const topic = input.topicId
    ? yield* database.query("automations.mailTopic", (db) =>
        db
          .select({ name: topics.name })
          .from(topics)
          .where(eq(topics.id, input.topicId as string))
          .get(),
      )
    : undefined
  const from = parseParty(input.fromAddress)
  const mailDomain = from.email.slice(from.email.lastIndexOf("@") + 1)
  const links = yield* unsubscribeHeaders({
    contactId: input.contact.id,
    topicId: input.topicId,
    campaignId: null,
    origin: input.origin,
    mailDomain,
    listName: topic?.name ?? undefined,
  })
  const preferences = yield* unsubscribeHeaders({
    contactId: input.contact.id,
    topicId: null,
    campaignId: null,
    origin: input.origin,
    mailDomain,
  })
  const source = { ...resolved.source, ...(input.subject ? { subject: input.subject } : {}) }
  const rendered = yield* Effect.try({
    try: () =>
      renderTemplate(
        source,
        {
          ...input.contact.fields,
          email: input.contact.email,
          name: input.contact.name,
          unsubscribe_url: links.url,
          preferences_url: preferences.url,
          trigger: input.triggerData ?? {},
          automation: { name: input.automationName },
          topic: topic?.name ?? null,
        },
        brand,
      ),
    catch: (e) => new Error(`The template didn't render: ${e instanceof Error ? e.message : String(e)}`),
  })
  const needsFooter = !rendered.html.includes(links.url) && !rendered.html.includes(preferences.url)
  const block = footer({
    reason: topic
      ? `You're receiving this because you subscribed to ${topic.name} from ${brand.theme.name}.`
      : `You're receiving this because you're on ${brand.theme.name}'s list.`,
    unsubscribeUrl: links.url,
    preferencesUrl: preferences.url,
    postalAddress: compliance.postalAddress,
  })
  const message: Outgoing = {
    from: from.name ? { email: from.email, name: from.name } : { email: from.email },
    to: [
      input.contact.name
        ? { email: input.contact.email, name: input.contact.name }
        : { email: input.contact.email },
    ],
    subject: rendered.subject,
    html: needsFooter ? withFooter(rendered.html, block.html) : rendered.html,
    text: needsFooter ? `${rendered.text}${block.text}` : rendered.text,
    headers: links.headers,
  }
  return {
    message,
    templateId: resolved.template.id,
    templateVersion: resolved.version.version,
    compliance,
    preview: rendered.text.replace(/\s+/g, " ").trim().slice(0, 140),
  }
})

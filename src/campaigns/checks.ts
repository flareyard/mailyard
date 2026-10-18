import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { type campaigns, domains } from "../db/schema.ts"
import { getBrandSettings } from "../domain/brand.ts"
import { eventCoverage } from "../domain/eventCoverage.ts"
import { parseParty } from "../domain/outbox.ts"
import { Database } from "../services/Database.ts"
import { clickableHrefs } from "../tracking/track.ts"
import { getCompliance } from "./compliance.ts"
import { renderFor } from "./content.ts"
import { isBroken, linkStatuses, MAX_PROBED_LINKS } from "./links.ts"

type CampaignRow = typeof campaigns.$inferSelect

export type CheckStatus = "pass" | "warn" | "fail"

/** Where in the app a check is fixed (HAL-3430), so a "Fix" link goes to the field without hard-coding ids. */
export interface Fix {
  readonly label: string
  readonly target: "content" | "audience" | "settings.compliance" | "domains"
  /** The field to focus there: a campaign field for content, a compliance setting for settings. */
  readonly field?: string
  readonly domainId?: string
}

export interface Check {
  readonly id: string
  readonly status: CheckStatus
  readonly title: string
  readonly detail: string
  /** Null when there's nothing to fix (a check Mailyard always satisfies). */
  readonly fix: Fix | null
}

/** Links already followed this recently aren't followed again when the checks rerun. */
const LINK_RECHECK_MS = 5 * 60_000

/** Gmail clips a message past 102 KB and hides the rest, unsubscribe link included. */
const CLIP_BYTES = 102 * 1024
const WARN_BYTES = 100 * 1024
const SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "tiny.cc",
  "rb.gy",
  "t.ly",
  "lnkd.in",
])

/** Every clickable http(s) link in the message, minus our own unsubscribe, preference and view links. */
export const linksIn = (html: string, ownOrigin: string) => {
  const found = new Set<string>()
  for (const m of html.matchAll(clickableHrefs())) {
    const href = (m[3] ?? "").replaceAll("&amp;", "&").trim()
    if (!/^https?:\/\//i.test(href)) continue
    if (["/u/", "/c/", "/v/"].some((own) => href.startsWith(`${ownOrigin}${own}`))) continue
    found.add(href)
  }
  return [...found]
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Whether `host` is `domain` or one of its subdomains. */
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** The registrable part, roughly: the last two labels (three for a two-letter second level like co.uk). */
const apexOf = (host: string) => {
  const labels = host.split(".")
  const n =
    labels.length >= 3 && (labels.at(-2)?.length ?? 0) <= 3 && (labels.at(-1)?.length ?? 0) === 2 ? 3 : 2
  return labels.slice(-n).join(".")
}

/** Placeholders the renderer didn't recognise, left in the message as typed: `{{ first_name | "there" }}`. */
const UNRENDERED = /\{\{[^{}]{0,80}\}\}/g

/** The pre-flight checks the campaign editor shows before a send can be scheduled. */
export const checkCampaign = Effect.fn("campaigns.checks")(function* (campaign: CampaignRow, origin: string) {
  const checks: Array<Check> = []
  const compliance = yield* getCompliance()
  const brand = yield* getBrandSettings()
  const from = parseParty(campaign.fromAddress)
  const sendingDomain = from.email.slice(from.email.lastIndexOf("@") + 1).toLowerCase()
  const contentField = campaign.templateId ? "templateId" : campaign.bodyBlocks ? "bodyBlocks" : "bodyHtml"
  const content = (label: string, field: string = contentField): Fix => ({ label, target: "content", field })
  const settings = (label: string, field: string): Fix => ({ label, target: "settings.compliance", field })

  const database = yield* Database
  const domain = yield* database.query("checks.domain", (db) =>
    db.select().from(domains).where(eq(domains.name, sendingDomain)).get(),
  )
  const onDomain = (label: string): Fix =>
    domain ? { label, target: "domains", domainId: domain.id } : { label, target: "domains" }
  const dnsFailing = domain?.checks?.some((c) => c.purpose === "sending" && c.status === "fail") ?? false
  checks.push(
    !domain?.sendingEnabled
      ? {
          id: "sender",
          status: "fail",
          title: "Sending domain",
          detail: `${sendingDomain} isn't set up for sending in Mailyard.`,
          fix: domain ? onDomain("Turn on sending") : { label: "Add the domain", target: "domains" },
        }
      : dnsFailing
        ? {
            id: "sender",
            status: "fail",
            title: "Sending domain",
            detail: `${sendingDomain}'s sending records fail their check; recheck the domain.`,
            fix: onDomain("Fix the records"),
          }
        : {
            id: "sender",
            status: "pass",
            title: "Sending domain",
            detail: `Sends from ${sendingDomain}.`,
            fix: content("Change the sender", "fromAddress"),
          },
  )

  const subject = campaign.subject.trim()
  const subjectFix = content("Edit the subject", "subject")
  checks.push(
    subject.length === 0
      ? { id: "subject", status: "fail", title: "Subject", detail: "The subject is empty.", fix: subjectFix }
      : subject.length > 150
        ? {
            id: "subject",
            status: "warn",
            title: "Subject",
            detail: `${subject.length} characters; most inboxes show about 60.`,
            fix: subjectFix,
          }
        : /[a-z]/i.test(subject) && subject === subject.toUpperCase() && subject.length > 8
          ? {
              id: "subject",
              status: "warn",
              title: "Subject",
              detail: "An all-capitals subject reads as spam to filters and people.",
              fix: subjectFix,
            }
          : {
              id: "subject",
              status: "pass",
              title: "Subject",
              detail: `${subject.length} characters.`,
              fix: subjectFix,
            },
  )

  const rendered = yield* Effect.result(
    renderFor(
      campaign,
      { contactId: null, email: "preview@example.com", name: "Preview", fields: {} },
      { origin },
    ),
  )
  if (rendered._tag === "Failure") {
    const e = rendered.failure as { message?: string; reason?: string; _tag?: string }
    checks.push({
      id: "content",
      status: "fail",
      title: "Content",
      detail: e.message ?? e.reason ?? String(e._tag),
      fix: content("Fix the content"),
    })
    return { ready: false, checks }
  }
  const { message, size } = rendered.success
  checks.push(
    (message.text ?? "").trim().length > 0
      ? {
          id: "plain_text",
          status: "pass",
          title: "Plain-text part",
          detail: "Included, for clients and filters that read text.",
          fix: content("Edit the text part", "bodyText"),
        }
      : {
          id: "plain_text",
          status: "fail",
          title: "Plain-text part",
          detail: "The message has no plain-text part.",
          fix: content("Write a text part", "bodyText"),
        },
  )
  const leftover = [
    ...new Set(
      [...`${message.subject}\n${message.html ?? ""}\n${message.text ?? ""}`.matchAll(UNRENDERED)].map(
        (m) => m[0],
      ),
    ),
  ]
  checks.push(
    leftover.length
      ? {
          id: "merge_fields",
          // A warning, not a block: a message about templates may show braces on purpose.
          status: "warn",
          title: "Merge fields",
          detail: `Would go out as typed: ${leftover.slice(0, 3).join(", ")}. A fallback is written {{ name ?? "there" }}.`,
          fix: content("Fix the merge fields"),
        }
      : {
          id: "merge_fields",
          status: "pass",
          title: "Merge fields",
          detail: "Every placeholder renders.",
          fix: content("Edit the content"),
        },
  )
  checks.push(
    size > CLIP_BYTES
      ? {
          id: "size",
          status: "fail",
          title: "Size",
          detail: `${Math.round(size / 1024)} KB: Gmail clips past 102 KB and hides the rest, unsubscribe link included.`,
          fix: content("Shorten the content"),
        }
      : size > WARN_BYTES
        ? {
            id: "size",
            status: "warn",
            title: "Size",
            detail: `${Math.round(size / 1024)} KB: close to Gmail's 102 KB clipping point.`,
            fix: content("Shorten the content"),
          }
        : {
            id: "size",
            status: "pass",
            title: "Size",
            detail: `${Math.round(size / 1024)} KB.`,
            fix: content("Edit the content"),
          },
  )

  const links = linksIn(message.html ?? "", origin)
  const hosts = links.map(hostOf).filter((h): h is string => h !== null)
  const short = [...new Set(hosts.filter((h) => SHORTENERS.has(h)))]
  checks.push(
    short.length
      ? {
          id: "shorteners",
          status: "fail",
          title: "Link shorteners",
          detail: `Filters distrust shortened links: ${short.join(", ")}.`,
          fix: content("Replace the short links"),
        }
      : {
          id: "shorteners",
          status: "pass",
          title: "Link shorteners",
          detail: "None.",
          fix: content("Edit the links"),
        },
  )
  const siteHost = hostOf(brand.siteUrl)
  const trusted = [
    apexOf(sendingDomain),
    ...(siteHost ? [apexOf(siteHost)] : []),
    ...compliance.linkAllowlist,
  ]
  const foreign = [...new Set(hosts.filter((h) => !SHORTENERS.has(h) && !trusted.some((d) => within(h, d))))]
  checks.push(
    foreign.length
      ? {
          id: "link_domains",
          status: "warn",
          title: "Link domains",
          detail: `Links leave your domain for ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ` and ${foreign.length - 5} more` : ""}. Add them to the allowlist if they're yours.`,
          fix: settings("Add to the allowlist", "linkAllowlist"),
        }
      : {
          id: "link_domains",
          status: "pass",
          title: "Link domains",
          detail: links.length ? "Every link stays on your domains." : "No links.",
          fix: settings("Edit the allowlist", "linkAllowlist"),
        },
  )
  const probed = (yield* linkStatuses(links, { followOlderThan: LINK_RECHECK_MS })).slice(0, MAX_PROBED_LINKS)
  const broken = probed.filter(isBroken)
  const slow = probed.filter((p) => p.error === "timed out")
  checks.push(
    broken.length
      ? {
          id: "links_resolve",
          status: "fail",
          title: "Links work",
          detail: `${broken.length} broken: ${broken
            .slice(0, 3)
            .map((b) => `${b.url} (${b.status ?? b.error})`)
            .join(", ")}.`,
          fix: content("Fix the broken links"),
        }
      : slow.length
        ? {
            id: "links_resolve",
            status: "warn",
            title: "Links work",
            detail: `${slow.length} didn't answer within 5 s: ${slow
              .slice(0, 3)
              .map((x) => x.url)
              .join(", ")}.`,
            fix: content("Check the slow links"),
          }
        : {
            id: "links_resolve",
            status: "pass",
            title: "Links work",
            detail: links.length ? `All ${probed.length} answered.` : "No links to check.",
            fix: content("Edit the links"),
          },
  )
  const trackingHost = hostOf(compliance.trackingOrigin ?? origin) ?? ""
  checks.push(
    !campaign.trackOpens && !campaign.trackClicks
      ? {
          id: "tracking",
          status: "pass",
          title: "Tracking domain",
          detail: "Tracking is off: no pixel, and links go straight to their address.",
          fix: content("Turn tracking on", "trackClicks"),
        }
      : within(trackingHost, apexOf(sendingDomain))
        ? {
            id: "tracking",
            status: "pass",
            title: "Tracking domain",
            detail: `Tracking runs on ${trackingHost}, your own domain.`,
            fix: settings("Change the tracking domain", "trackingOrigin"),
          }
        : {
            id: "tracking",
            status: "warn",
            title: "Tracking domain",
            detail: `Tracked links go through ${trackingHost}, not your domain; filters trust links on the sender's own domain more. Point a subdomain of ${apexOf(sendingDomain)} at Mailyard and set it as the tracking origin.`,
            fix: settings("Set a tracking domain", "trackingOrigin"),
          },
  )

  const [events] = yield* eventCoverage(sendingDomain)
  if (events)
    checks.push({
      id: "delivery_events",
      status: events.status === "warn" ? "warn" : "pass",
      title: "Delivery events",
      detail: events.detail,
      fix: onDomain("Set up delivery events"),
    })

  const replyTo = (campaign.replyTo ? parseParty(campaign.replyTo).email : from.email).toLowerCase()
  checks.push(
    /^(no-?reply|do-?not-?reply|noreply)@/.test(replyTo)
      ? {
          id: "reply_to",
          status: "warn",
          title: "Reply-to",
          detail: `Replies go to ${replyTo}; a real address earns trust and catches answers.`,
          fix: content("Set a reply-to", "replyTo"),
        }
      : {
          id: "reply_to",
          status: "pass",
          title: "Reply-to",
          detail: `Replies go to ${replyTo}.`,
          fix: content("Change the reply-to", "replyTo"),
        },
  )
  checks.push({
    id: "unsubscribe",
    status: "pass",
    title: "Unsubscribe",
    detail: rendered.success.footerAdded
      ? "One-click headers on every message, and a footer with the links (your content has none)."
      : "One-click headers on every message, and your content links to the preference page.",
    // Mailyard always adds the headers, and the footer when the content has no link: nothing to fix.
    fix: null,
  })
  checks.push(
    compliance.postalAddress
      ? {
          id: "postal_address",
          status: "pass",
          title: "Postal address",
          detail: "In the footer.",
          fix: settings("Change the address", "postalAddress"),
        }
      : {
          id: "postal_address",
          status: "warn",
          title: "Postal address",
          detail: "Commercial mail needs a postal address (CAN-SPAM); set one in compliance settings.",
          fix: settings("Add a postal address", "postalAddress"),
        },
  )
  return { ready: !checks.some((c) => c.status === "fail"), checks }
})

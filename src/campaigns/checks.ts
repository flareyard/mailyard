import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { type campaigns, domains } from "../db/schema.ts"
import { getBrandSettings } from "../domain/brand.ts"
import { eventCoverage } from "../domain/eventCoverage.ts"
import { parseParty } from "../domain/outbox.ts"
import { Database } from "../services/Database.ts"
import { getCompliance } from "./compliance.ts"
import { renderFor } from "./content.ts"

type CampaignRow = typeof campaigns.$inferSelect

export type CheckStatus = "pass" | "warn" | "fail"
export interface Check {
  readonly id: string
  readonly status: CheckStatus
  readonly title: string
  readonly detail: string
}

/** Gmail clips a message past 102 KB and hides the rest, unsubscribe link included. */
const CLIP_BYTES = 102 * 1024
const WARN_BYTES = 100 * 1024
const MAX_LINKS = 30
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

/** Every http(s) link in the message, minus our own unsubscribe and preference links. */
export const linksIn = (html: string, ownOrigin: string) => {
  const found = new Set<string>()
  for (const m of html.matchAll(/href\s*=\s*"([^"]+)"|href\s*=\s*'([^']+)'/gi)) {
    const href = (m[1] ?? m[2] ?? "").replaceAll("&amp;", "&").trim()
    if (!/^https?:\/\//i.test(href)) continue
    if (href.startsWith(`${ownOrigin}/u/`) || href.startsWith(`${ownOrigin}/c/`)) continue
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

/** One link, followed through redirects: HEAD first, a one-byte GET where HEAD isn't allowed. */
const probe = (url: string) =>
  Effect.promise(async () => {
    const attempt = async (method: "HEAD" | "GET") =>
      fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: {
          "user-agent": "Mailyard link check (+https://flareyard.dev)",
          ...(method === "GET" ? { range: "bytes=0-0" } : {}),
        },
      })
    try {
      let response = await attempt("HEAD")
      if ([403, 405, 501].includes(response.status)) response = await attempt("GET")
      return { url, status: response.status, error: null as string | null }
    } catch (e) {
      return {
        url,
        status: 0,
        error: e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable",
      }
    }
  })

/** The pre-flight checks the campaign editor shows before a send can be scheduled. */
export const checkCampaign = Effect.fn("campaigns.checks")(function* (campaign: CampaignRow, origin: string) {
  const checks: Array<Check> = []
  const compliance = yield* getCompliance()
  const brand = yield* getBrandSettings()
  const from = parseParty(campaign.fromAddress)
  const sendingDomain = from.email.slice(from.email.lastIndexOf("@") + 1).toLowerCase()

  const database = yield* Database
  const domain = yield* database.query("checks.domain", (db) =>
    db.select().from(domains).where(eq(domains.name, sendingDomain)).get(),
  )
  const dnsFailing = domain?.checks?.some((c) => c.purpose === "sending" && c.status === "fail") ?? false
  checks.push(
    !domain?.sendingEnabled
      ? {
          id: "sender",
          status: "fail",
          title: "Sending domain",
          detail: `${sendingDomain} isn't set up for sending in Mailyard.`,
        }
      : dnsFailing
        ? {
            id: "sender",
            status: "fail",
            title: "Sending domain",
            detail: `${sendingDomain}'s sending records fail their check; recheck the domain.`,
          }
        : { id: "sender", status: "pass", title: "Sending domain", detail: `Sends from ${sendingDomain}.` },
  )

  const subject = campaign.subject.trim()
  checks.push(
    subject.length === 0
      ? { id: "subject", status: "fail", title: "Subject", detail: "The subject is empty." }
      : subject.length > 150
        ? {
            id: "subject",
            status: "warn",
            title: "Subject",
            detail: `${subject.length} characters; most inboxes show about 60.`,
          }
        : /[a-z]/i.test(subject) && subject === subject.toUpperCase() && subject.length > 8
          ? {
              id: "subject",
              status: "warn",
              title: "Subject",
              detail: "An all-capitals subject reads as spam to filters and people.",
            }
          : { id: "subject", status: "pass", title: "Subject", detail: `${subject.length} characters.` },
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
        }
      : {
          id: "plain_text",
          status: "fail",
          title: "Plain-text part",
          detail: "The message has no plain-text part.",
        },
  )
  checks.push(
    size > CLIP_BYTES
      ? {
          id: "size",
          status: "fail",
          title: "Size",
          detail: `${Math.round(size / 1024)} KB: Gmail clips past 102 KB and hides the rest, unsubscribe link included.`,
        }
      : size > WARN_BYTES
        ? {
            id: "size",
            status: "warn",
            title: "Size",
            detail: `${Math.round(size / 1024)} KB: close to Gmail's 102 KB clipping point.`,
          }
        : { id: "size", status: "pass", title: "Size", detail: `${Math.round(size / 1024)} KB.` },
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
        }
      : { id: "shorteners", status: "pass", title: "Link shorteners", detail: "None." },
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
        }
      : {
          id: "link_domains",
          status: "pass",
          title: "Link domains",
          detail: links.length ? "Every link stays on your domains." : "No links.",
        },
  )
  const probed = yield* Effect.forEach(links.slice(0, MAX_LINKS), probe, { concurrency: 5 })
  const broken = probed.filter((p) => p.status >= 400 || (p.status === 0 && p.error !== "timed out"))
  const slow = probed.filter((p) => p.error === "timed out")
  checks.push(
    broken.length
      ? {
          id: "links_resolve",
          status: "fail",
          title: "Links work",
          detail: `${broken.length} broken: ${broken
            .slice(0, 3)
            .map((b) => `${b.url} (${b.status || b.error})`)
            .join(", ")}.`,
        }
      : slow.length
        ? {
            id: "links_resolve",
            status: "warn",
            title: "Links work",
            detail: `${slow.length} didn't answer within 5 s: ${slow
              .slice(0, 3)
              .map((s) => s.url)
              .join(", ")}.`,
          }
        : {
            id: "links_resolve",
            status: "pass",
            title: "Links work",
            detail: links.length ? `All ${probed.length} answered.` : "No links to check.",
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
        }
      : within(trackingHost, apexOf(sendingDomain))
        ? {
            id: "tracking",
            status: "pass",
            title: "Tracking domain",
            detail: `Tracking runs on ${trackingHost}, your own domain.`,
          }
        : {
            id: "tracking",
            status: "warn",
            title: "Tracking domain",
            detail: `Tracked links go through ${trackingHost}, not your domain; filters trust links on the sender's own domain more. Point a subdomain of ${apexOf(sendingDomain)} at Mailyard and set it as the tracking origin.`,
          },
  )

  const [events] = yield* eventCoverage(sendingDomain)
  if (events)
    checks.push({
      id: "delivery_events",
      status: events.status === "warn" ? "warn" : "pass",
      title: "Delivery events",
      detail: events.detail,
    })

  const replyTo = (campaign.replyTo ? parseParty(campaign.replyTo).email : from.email).toLowerCase()
  checks.push(
    /^(no-?reply|do-?not-?reply|noreply)@/.test(replyTo)
      ? {
          id: "reply_to",
          status: "warn",
          title: "Reply-to",
          detail: `Replies go to ${replyTo}; a real address earns trust and catches answers.`,
        }
      : { id: "reply_to", status: "pass", title: "Reply-to", detail: `Replies go to ${replyTo}.` },
  )
  checks.push({
    id: "unsubscribe",
    status: "pass",
    title: "Unsubscribe",
    detail: rendered.success.footerAdded
      ? "One-click headers on every message, and a footer with the links (your content has none)."
      : "One-click headers on every message, and your content links to the preference page.",
  })
  checks.push(
    compliance.postalAddress
      ? { id: "postal_address", status: "pass", title: "Postal address", detail: "In the footer." }
      : {
          id: "postal_address",
          status: "warn",
          title: "Postal address",
          detail: "Commercial mail needs a postal address (CAN-SPAM); set one in compliance settings.",
        },
  )
  return { ready: !checks.some((c) => c.status === "fail"), checks }
})

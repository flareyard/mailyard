/**
 * Fixture-mode overrides for Domains (registered in src/fixtures/overrides.ts), typed against the generated
 * schema. The design's fixtures answer every request with 200, so the refusals (fix 409s, the list's 503) and
 * the zone-token variants need these to be reachable.
 *
 * The page's own query string picks the designed state (read from the tab's location, since API requests
 * don't carry it). Several can be combined: `?fx=token,failing`.
 *   fx=token        the zone token is connected (candidates, zone status, registrar, DNSSEC, complaints)
 *   fx=failing      news.coursified.app's DKIM and DMARC stopped matching (dom_02)
 *   fx=checking     coursified.app is being rechecked (dom_01)
 *   fx=routing      Email Routing was turned off for coursified.app (dom_01; its fix re-enables routing)
 *   fx=empty        no domains yet;  fx=error  the list answers 503
 *   fix=zone        the fix answers 409 zone_not_found;  fix=nothing  409 nothing_to_fix
 *                   (without fx=token every fix answers 409 no_dns_token, as production does today)
 *   rep=at-risk | not-connected | not-enough   the reputation states
 */
import type { Json, Override } from "../fixtures/overrides.ts"

type Domain = Json<"/v1/domains/{id}", "get">
type Check = Domain["checks"][number]
type Row = Json<"/v1/domains", "get">["domains"][number]
type Fix = Json<"/v1/domains/{id}/fix", "post">
type Rep = Json<"/v1/reputation", "get">
type Candidates = Json<"/v1/domains/candidates", "get">
type Events = Json<"/v1/sending/events", "get">

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function flags(): { fx: Set<string>; fix: string | null; rep: string | null } {
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search)
  return { fx: new Set((q.get("fx") ?? "").split(",").filter(Boolean)), fix: q.get("fix"), rep: q.get("rep") }
}

const DKIM = "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3…"
const BDKIM = "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq9…"
const MX = "route1.mx.cloudflare.net (priority 13)"
const SPF = "v=spf1 include:_spf.mx.cloudflare.net ~all"

/** The seven checks a domain gets, all passing; `patch` changes rows by id. */
function checksFor(name: string, patch: Partial<Record<Check["id"], Partial<Check>>> = {}): Check[] {
  const rows: Check[] = [
    {
      id: "mx",
      purpose: "receiving",
      name,
      type: "MX",
      expected: MX,
      actual: [MX],
      status: "pass",
      detail: "Matches the expected value.",
      changedAt: Date.now() - 17 * DAY,
    },
    {
      id: "spf",
      purpose: "receiving",
      name,
      type: "TXT",
      expected: SPF,
      actual: [SPF],
      status: "pass",
      detail: "Matches the expected value.",
      changedAt: Date.now() - 17 * DAY,
    },
    {
      id: "dkim",
      purpose: "sending",
      name: `cf2024-1._domainkey.${name}`,
      type: "TXT",
      expected: DKIM,
      actual: [DKIM],
      status: "pass",
      detail: "Matches the expected value.",
      changedAt: Date.now() - 17 * DAY,
    },
    {
      id: "dmarc",
      purpose: "sending",
      name: `_dmarc.${name}`,
      type: "TXT",
      expected: `v=DMARC1; p=none; rua=mailto:dmarc@${name}`,
      actual: [`v=DMARC1; p=none; rua=mailto:dmarc@${name}`],
      status: "pass",
      detail: "Matches the expected value.",
      changedAt: Date.now() - 2 * HOUR,
    },
    {
      id: "bounce-mx",
      purpose: "sending",
      name: `cf-bounce.${name}`,
      type: "MX",
      expected: MX,
      actual: [MX],
      status: "pass",
      detail: "Matches the expected value.",
    },
    {
      id: "bounce-spf",
      purpose: "sending",
      name: `cf-bounce.${name}`,
      type: "TXT",
      expected: SPF,
      actual: [SPF],
      status: "pass",
      detail: "Matches the expected value.",
    },
    {
      id: "bounce-dkim",
      purpose: "sending",
      name: `cf2024-1._domainkey.cf-bounce.${name}`,
      type: "TXT",
      expected: BDKIM,
      actual: [BDKIM],
      status: "pass",
      detail: "Matches the expected value.",
    },
  ]
  return rows.map((r) => ({ ...r, ...patch[r.id] }))
}

const records = (checks: Check[]): Domain["expectedRecords"] =>
  checks.map((c) => ({ purpose: c.purpose, type: c.type, name: c.name, value: c.expected }))

const CF_NS = ["ada.ns.cloudflare.com", "rob.ns.cloudflare.com"]

function domain(base: Partial<Domain> & Pick<Domain, "id" | "name">, token: boolean): Domain {
  const checks = base.checks ?? checksFor(base.name)
  const status = base.checkStatus !== undefined ? base.checkStatus : "pass"
  return {
    zoneId: null,
    receiving: true,
    sending: true,
    catchAll: "bounce",
    mailboxCount: 0,
    lastCheckedAt: Date.now() - 12 * MIN,
    zoneStatus: token ? "active" : null,
    createdAt: Date.now() - 46 * DAY,
    updatedAt: Date.now() - 12 * MIN,
    zoneName: base.name,
    nameservers: token ? CF_NS : null,
    currentNameservers: CF_NS,
    registrar: token ? "Hostinger" : null,
    dnssec: token ? "active" : null,
    complaints30d: token ? 3 : null,
    returnPath: `cf-bounce.${base.name}`,
    zoneCheckedAt: token ? Date.now() - 12 * MIN : null,
    mailboxes: [],
    ...base,
    checkStatus: status,
    checks,
    expectedRecords: records(checks),
  }
}

/** Switches flipped in this tab stick until reload, so the page answers the way the API would. */
const patched = new Map<string, Partial<Domain>>()

function domains(): Domain[] {
  const { fx } = flags()
  const token = fx.has("token")
  const app = domain(
    {
      id: "dom_01",
      name: "coursified.app",
      zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
      mailboxCount: 3,
      mailboxes: [
        { id: "mbx_hello", address: "hello@coursified.app", kind: "shared", displayName: "Coursified" },
        {
          id: "mbx_support",
          address: "support@coursified.app",
          kind: "shared",
          displayName: "Coursified support",
        },
        {
          id: "mbx_founder",
          address: "halleluyah@coursified.app",
          kind: "user",
          displayName: "Halleluyah Oludele",
        },
      ],
      ...(fx.has("checking")
        ? {
            checkStatus: "checking" as const,
            checks: checksFor("coursified.app", {
              "bounce-mx": { status: "checking" },
              "bounce-spf": { status: "checking" },
              "bounce-dkim": { status: "checking" },
            }),
          }
        : fx.has("routing")
          ? {
              checkStatus: "fail" as const,
              checks: checksFor("coursified.app", {
                mx: {
                  status: "fail",
                  actual: [],
                  detail: "Nothing at this name: Email Routing was turned off at Cloudflare.",
                  changedAt: Date.now() - 3 * HOUR,
                },
                spf: {
                  status: "fail",
                  actual: [],
                  detail: "Nothing at this name: Email Routing was turned off at Cloudflare.",
                  changedAt: Date.now() - 3 * HOUR,
                },
                dmarc: {
                  status: "fail",
                  actual: [],
                  detail: "No DMARC record.",
                  changedAt: Date.now() - 3 * HOUR,
                },
              }),
            }
          : {}),
    },
    token,
  )
  const news = domain(
    {
      id: "dom_02",
      name: "news.coursified.app",
      zoneId: "9a7806061c88ada191ed06f989cc3dac",
      receiving: false,
      zoneName: "coursified.app",
      complaints30d: token ? 2 : null,
      ...(fx.has("failing")
        ? {
            checkStatus: "fail" as const,
            checks: checksFor("news.coursified.app", {
              spf: { changedAt: Date.now() - 9 * DAY },
              dkim: {
                status: "fail",
                actual: ["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7…"],
                detail:
                  "The published key doesn't match the key Cloudflare signs with. It was changed at 08:12 UTC.",
                changedAt: Date.now() - 9 * HOUR,
              },
              dmarc: {
                status: "fail",
                actual: ["v=DMARC1; p=reject; rua=mailto:postmaster@hostinger-mail.com"],
                detail:
                  "A different DMARC record is already published. Mailyard won’t overwrite one you set; change it by hand.",
                changedAt: Date.now() - 9 * HOUR,
              },
            }),
          }
        : {}),
    },
    token,
  )
  const co = domain(
    {
      id: "dom_03",
      name: "coursified.co",
      zoneId: "6b1c4e5d1d8b4a2b9c0f1e2d3c4b5a69",
      receiving: false,
      sending: false,
      currentNameservers: ["ns1.dns-parking.com", "ns2.dns-parking.com"],
      complaints30d: null,
      ...(token
        ? {
            zoneStatus: "pending",
            dnssec: "off",
            checkStatus: "fail" as const,
            lastCheckedAt: Date.now() - 20 * MIN,
            checks: checksFor("coursified.co", {
              mx: {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              spf: {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              dkim: {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              dmarc: {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              "bounce-mx": {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              "bounce-spf": {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
              "bounce-dkim": {
                status: "fail",
                actual: [],
                detail: "Waiting for nameservers: Cloudflare can’t publish records until the zone is active.",
              },
            }),
          }
        : { checkStatus: null, lastCheckedAt: null, checks: [] }),
    },
    token,
  )
  return [app, news, co].map((d) => ({ ...d, ...patched.get(d.id) }))
}

const toRow = (d: Domain): Row => ({
  id: d.id,
  name: d.name,
  zoneId: d.zoneId,
  receiving: d.receiving,
  sending: d.sending,
  catchAll: d.catchAll,
  mailboxCount: d.mailboxCount,
  lastCheckedAt: d.lastCheckedAt,
  checkStatus: d.checkStatus,
  zoneStatus: d.zoneStatus,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
})

const ok = (body: unknown) => ({ status: 200, body })
const refusal = (status: number, tag: string, reason: string | undefined, message: string) => ({
  status,
  body: { _tag: tag, ...(reason ? { reason } : {}), message, requestId: "fixture-dom" },
})

const candidates = (): Candidates =>
  flags().fx.has("token")
    ? {
        connected: true,
        candidates: [
          {
            name: "coursified.app",
            zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
            zoneStatus: "active",
            nameservers: CF_NS,
            registrar: "Hostinger",
            inWorkspace: true,
            workspaceDomains: ["coursified.app", "news.coursified.app"],
            existingMx: ["route1.mx.cloudflare.net"],
          },
          {
            name: "coursified.co",
            zoneId: "6b1c4e5d1d8b4a2b9c0f1e2d3c4b5a69",
            zoneStatus: "pending",
            nameservers: CF_NS,
            registrar: "Hostinger",
            inWorkspace: true,
            workspaceDomains: ["coursified.co"],
            existingMx: [],
          },
          {
            name: "hallelx.dev",
            zoneId: "8f3a2c1d9e4b4f6a8c7d5e3b2a1f0c9d",
            zoneStatus: "active",
            nameservers: CF_NS,
            registrar: "Cloudflare",
            inWorkspace: false,
            workspaceDomains: [],
            existingMx: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"],
          },
          {
            name: "coursified.org",
            zoneId: "1d2e3f4a5b6c4d7e8f9a0b1c2d3e4f5a",
            zoneStatus: "active",
            nameservers: CF_NS,
            registrar: null,
            inWorkspace: false,
            workspaceDomains: [],
            existingMx: [],
          },
        ],
      }
    : { connected: false, candidates: [] }

const NO_EVENTS =
  'news.coursified.app has no delivery-events subscription, so its deliveries, bounces and complaints never reach Mailyard. Subscribe the events queue to news.coursified.app (README, "Delivery events").'
const events = (): Events => ({
  domains: [
    {
      domainId: "dom_01",
      domain: "coursified.app",
      subscribed: true,
      withEvents: 3612,
      silent: 0,
      status: "ok",
      detail: "Delivery events for coursified.app are subscribed.",
    },
    {
      domainId: "dom_02",
      domain: "news.coursified.app",
      subscribed: false,
      withEvents: 0,
      silent: 280,
      status: "warn",
      detail: NO_EVENTS,
    },
  ],
})

const POLICY: Rep["policy"] = {
  customer_bounce: { warning_at: 0.02, at_risk_at: 0.05, minimum_denominator: 100 },
  complaint: { warning_at: 0.001, at_risk_at: 0.002, minimum_denominator: 100 },
  spam_rejection: { warning_at: 0.01, at_risk_at: 0.03, minimum_denominator: 100 },
  suspension_after_hours: 168,
}
function reputation(): Rep {
  const rep = flags().rep
  const healthy: Rep = {
    status: "healthy",
    statusSince: new Date(Date.now() - 46 * DAY).toISOString(),
    graceStartedAt: null,
    evaluatedAt: new Date(Date.now() - 18 * MIN).toISOString(),
    source: "cloudflare",
    policySource: "account",
    policy: POLICY,
    window: "30d",
    totals: {
      sent: 6329,
      delivered: 6206,
      deferred: 38,
      bouncedHard: 25,
      bouncedSoft: 35,
      complained: 3,
      rejected: 18,
      failed: 7,
    },
    rates: {
      insufficientData: false,
      minimumSends: 100,
      bounceRate: 0.00948,
      complaintRate: 0.00048,
      rejectionRate: 0.00284,
      deliveryRate: 0.9806,
    },
    levels: { bounce: "ok", complaint: "ok", spamRejection: "ok" },
  }
  if (rep === "at-risk") {
    const since = new Date(Date.now() - 20 * HOUR - 8 * MIN).toISOString()
    return {
      ...healthy,
      status: "at_risk",
      statusSince: since,
      graceStartedAt: since,
      totals: {
        sent: 6329,
        delivered: 5887,
        deferred: 57,
        bouncedHard: 278,
        bouncedSoft: 76,
        complained: 8,
        rejected: 25,
        failed: 6,
      },
      rates: {
        insufficientData: false,
        minimumSends: 100,
        bounceRate: 0.05593,
        complaintRate: 0.00136,
        rejectionRate: 0.00395,
        deliveryRate: 0.9302,
      },
      levels: { bounce: "at-risk", complaint: "warning", spamRejection: "ok" },
    }
  }
  if (rep === "not-connected")
    return {
      ...healthy,
      status: null,
      statusSince: null,
      evaluatedAt: null,
      source: "not-connected",
      policySource: "measured-2026-10-16",
    }
  if (rep === "not-enough")
    return {
      ...healthy,
      totals: {
        sent: 48,
        delivered: 47,
        deferred: 0,
        bouncedHard: 1,
        bouncedSoft: 0,
        complained: 0,
        rejected: 0,
        failed: 0,
      },
      rates: {
        insufficientData: true,
        minimumSends: 100,
        bounceRate: null,
        complaintRate: null,
        rejectionRate: null,
        deliveryRate: null,
      },
      levels: {
        bounce: "insufficient-data",
        complaint: "insufficient-data",
        spamRejection: "insufficient-data",
      },
    }
  return healthy
}

function fix(d: Domain): { status: number; body: unknown } {
  const { fx, fix: mode } = flags()
  if (!fx.has("token"))
    return refusal(
      409,
      "FixRefused",
      "no_dns_token",
      "Mailyard has no CLOUDFLARE_DNS_TOKEN, so it can't change DNS. Add the records shown, or give it a zone token.",
    )
  if (mode === "zone")
    return refusal(
      409,
      "FixRefused",
      "zone_not_found",
      `The token can't see a zone for ${d.name}. Is the domain on this Cloudflare account?`,
    )
  const failing = d.checks.filter((c) => c.status === "fail" || c.status === "warn")
  if (mode === "nothing" || failing.length === 0)
    return refusal(
      409,
      "FixRefused",
      "nothing_to_fix",
      "Every record passed at the last check. Recheck first if DNS changed since.",
    )
  const fixed: Domain = {
    ...d,
    checks: d.checks.map((c) =>
      c.id === "dmarc" && c.actual.length > 0
        ? c
        : {
            ...c,
            status: "pass",
            actual: [c.expected],
            detail: "Matches the expected value.",
            changedAt: Date.now(),
          },
    ),
  }
  fixed.checkStatus = fixed.checks.some((c) => c.status === "fail") ? "fail" : "pass"
  const body: Fix = {
    domain: fixed,
    actions:
      d.id === "dom_01"
        ? [
            {
              checks: ["mx", "spf"],
              action: "enable_routing",
              ok: true,
              detail: "Turned Email Routing back on; its MX and SPF records are published.",
            },
            {
              checks: ["dmarc"],
              action: "add_dmarc",
              ok: false,
              detail: "Cloudflare refused the new TXT record at _dmarc.coursified.app (403).",
            },
          ]
        : [
            {
              checks: ["dkim"],
              action: "fix_sending",
              ok: true,
              detail: `Re-applied the sending records: DKIM key cf2024-1._domainkey.${d.name}.`,
            },
            {
              checks: ["dmarc"],
              action: "manual",
              ok: false,
              detail: `A DMARC record already exists at _dmarc.${d.name} and doesn't match. Mailyard won't overwrite it; set it by hand.`,
            },
          ],
  }
  return ok(body)
}

/**
 * These answer only on the Domains pages, so the Overview, first run and shell keep the design fixtures they
 * were built against (they read some of the same routes). A RegExp whose match is null elsewhere.
 */
class OnDomains extends RegExp {
  override [Symbol.match](s: string): RegExpMatchArray | null {
    if (typeof window === "undefined" || !window.location.pathname.startsWith("/domains")) return null
    return super[Symbol.match](s)
  }
}
const on = (re: RegExp) => new OnDomains(re.source)

const byId = (id: string) => domains().find((d) => d.id === id)
const notFound = (id: string) => refusal(404, "NotFound", undefined, `No domain ${id}.`)

export const DOMAINS_OVERRIDES: readonly Override[] = [
  {
    method: "GET",
    path: on(/^\/v1\/domains$/),
    answer: () => {
      const { fx } = flags()
      if (fx.has("error")) return refusal(503, "ServiceUnavailable", undefined, "Service unavailable")
      return ok({ domains: fx.has("empty") ? [] : domains().map(toRow) })
    },
  },
  { method: "GET", path: on(/^\/v1\/domains\/candidates$/), answer: () => ok(candidates()) },
  {
    method: "GET",
    path: on(/^\/v1\/domains\/(dom_[A-Za-z0-9]+)$/),
    answer: ([, id = ""]) => {
      const d = byId(id)
      return d ? ok(d) : notFound(id)
    },
  },
  {
    method: "POST",
    path: on(/^\/v1\/domains\/(dom_[A-Za-z0-9]+)\/recheck$/),
    answer: ([, id = ""]) => {
      const d = byId(id)
      return d
        ? ok({
            ...d,
            lastCheckedAt: Date.now(),
            checkStatus: d.checkStatus === "checking" ? "pass" : d.checkStatus,
          })
        : notFound(id)
    },
  },
  {
    method: "POST",
    path: on(/^\/v1\/domains\/(dom_[A-Za-z0-9]+)\/fix$/),
    answer: ([, id = ""]) => {
      const d = byId(id)
      return d ? fix(d) : notFound(id)
    },
  },
  {
    method: "PATCH",
    path: on(/^\/v1\/domains\/(dom_[A-Za-z0-9]+)$/),
    answer: ([, id = ""], body) => {
      const d = byId(id)
      if (!d) return notFound(id)
      const b = (body ?? {}) as Partial<Pick<Domain, "receiving" | "sending" | "catchAll">>
      patched.set(id, { ...patched.get(id), ...b, updatedAt: Date.now() })
      return ok(byId(id))
    },
  },
  {
    method: "POST",
    path: on(/^\/v1\/domains$/),
    answer: (_, body) => {
      const b = (body ?? {}) as { name?: string; receiving?: boolean; sending?: boolean }
      const name = b.name ?? "example.com"
      if (domains().some((d) => d.name === name))
        return refusal(409, "Conflict", "exists", `${name} is already in this workspace.`)
      const d = domain(
        {
          id: "dom_new",
          name,
          receiving: b.receiving ?? true,
          sending: b.sending ?? true,
          lastCheckedAt: Date.now(),
          checkStatus: "fail",
          currentNameservers: [],
          checks: checksFor(name, {
            mx: { status: "fail", actual: [], detail: "Nothing at this name yet." },
            spf: { status: "fail", actual: [], detail: "Nothing at this name yet." },
            dkim: { status: "fail", actual: [], detail: "Nothing at this name yet." },
            dmarc: { status: "fail", actual: [], detail: "No DMARC record." },
            "bounce-mx": { status: "fail", actual: [], detail: "Nothing at this name yet." },
            "bounce-spf": { status: "fail", actual: [], detail: "Nothing at this name yet." },
            "bounce-dkim": { status: "fail", actual: [], detail: "Nothing at this name yet." },
          }),
        },
        flags().fx.has("token"),
      )
      return ok(d)
    },
  },
  { method: "GET", path: on(/^\/v1\/sending\/events$/), answer: () => ok(events()) },
  { method: "GET", path: on(/^\/v1\/reputation$/), answer: () => ok(reputation()) },
]

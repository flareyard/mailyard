/**
 * Fixture-mode overrides for Settings (S-A: mailboxes, rules, Gmail mode, sessions, members, brand, tracking,
 * sending), registered in src/fixtures/overrides.ts and typed against the generated schema so a contract change
 * breaks them at compile time. Bodies are the designs' sample data (settings/*.html), in the live shapes.
 *
 * `?fx=` on a Settings page picks a designed state, so every one is reachable by URL:
 *   mailboxes   empty · error · loading · conflict · conflict-drop · created · created-catch-all ·
 *               created-replaced · created-clear (with ?new=1, the sheet submits its sample draft)
 *   rules       empty · error
 *   gmail-mode  done · fail
 *   sessions    error
 *   members     owner · admin (the signed-in person) · error
 *   brand       default · refused · logo-uploaded
 *   tracking    check-failed · check-never · privacy-invalid
 *   sending     unreachable
 *   any page    sender · viewer (a person without Settings: the locked page)
 */
import type { Answer, Json, Override } from "../fixtures/overrides.ts"

const fx = () =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fx")
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const refusal = (
  status: number,
  tag: string,
  message: string,
  extra: Record<string, unknown> = {},
): Answer => ({
  status,
  body: { _tag: tag, message, requestId: "req_01JAFG2K7M4X", ...extra },
})
const hang = () => new Promise<Answer>(() => {}) as unknown as Answer
/** My pages only: other sections (Mail, first run, Integrations) keep their own fixtures for the same routes. */
const MY_PAGES = [
  "/settings/mailboxes",
  "/settings/rules",
  "/settings/gmail-mode",
  "/settings/sessions",
  "/settings/members",
  "/settings/brand",
  "/settings/tracking",
  "/settings/sending",
  "/settings/ai",
]
const here = () => (typeof window === "undefined" ? "" : window.location.pathname)
const onMyPages = () => MY_PAGES.some((p) => here() === p || here().startsWith(`${p}/`))
/** A route pattern that only matches while `when()` holds, so an override can step aside (overrides never fall through). */
class Scoped extends RegExp {
  constructor(
    re: RegExp,
    private readonly when: () => boolean,
  ) {
    super(re.source, re.flags)
  }
  override exec(s: string) {
    return this.when() ? super.exec(s) : null
  }
}
const mine = (re: RegExp) => new Scoped(re, onMyPages)
const json = (b: unknown) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {})

const DAY = 86_400_000
const T = 1792259280000 // the designs' clock: Sat 17 Oct 2026, 17:48 UTC

// ── Mailboxes ───────────────────────────────────────────────────────────────────────────────────────────────

type MailboxList = Json<"/v1/mailboxes", "get">
type MailboxBody = Json<"/v1/mailboxes/{id}", "get">
type Summary = MailboxList["mailboxes"][number]

const summary = (
  id: string,
  address: string,
  kind: Summary["kind"],
  displayName: string | null,
  targetIds: string[] = [],
): Summary => ({
  id,
  address,
  domainId: "dom_01",
  kind,
  displayName,
  holdsMail: kind === "user" || kind === "shared",
  targetIds,
  createdAt: 1788344400000,
  updatedAt: 1792000080000,
})

const MAILBOXES: Summary[] = [
  summary("mbx_hello", "hello@coursified.app", "shared", "Coursified"),
  summary("mbx_support", "support@coursified.app", "shared", "Coursified support"),
  summary("mbx_founder", "halleluyah@coursified.app", "user", "Halleluyah Oludele"),
  summary("mbx_billing", "billing@coursified.app", "alias", "Coursified billing", ["mbx_support"]),
  summary("mbx_help", "help@coursified.app", "alias", null, ["mbx_support"]),
  summary("mbx_team", "team@coursified.app", "group", "Coursified team", ["mbx_founder", "mbx_support"]),
  summary("mbx_catch", "*@coursified.app", "catch_all", null, ["mbx_hello"]),
]

const person = (
  memberId: string,
  name: string,
  email: string,
  access: "owner" | "member" | "viewer",
  role: "owner" | "admin" | "sender" | "agent" | "viewer",
) => ({
  memberId,
  name,
  email,
  access,
  role,
})

const detail = (s: Summary): MailboxBody => {
  const base: MailboxBody = {
    ...s,
    targets: s.targetIds.map((t) => {
      const m = MAILBOXES.find((x) => x.id === t)
      return { id: t, address: m?.address ?? null, kind: m?.kind ?? null }
    }),
    signature: null,
    autoReply: null,
    forwarding: null,
    spamThreshold: 5,
    spamThresholdIsDefault: true,
    members: [],
    people: [],
    messageCount: s.holdsMail ? 0 : null,
    lastExport: null,
  }
  if (s.id === "mbx_support")
    return {
      ...base,
      signature: { text: "Coursified support\nhttps://coursified.app/help", html: null },
      autoReply: {
        enabled: true,
        subject: "We got your message",
        body: "Thanks for writing to Coursified support. We answer within a working day. If it’s about a payment, include the email you paid with.",
        startsAt: 1792861200000,
        endsAt: 1793174400000,
      },
      forwarding: { enabled: true, to: ["kemi.bello.personal@gmail.com"], keepCopy: true },
      people: [
        person("usr_01JA3Q9C4T", "Halleluyah Oludele", "halleluyah@coursified.app", "owner", "owner"),
        person("usr_kemi", "Kemi Bello", "kemi@coursified.app", "member", "agent"),
        person("usr_ifeoma", "Ifeoma Nwosu", "ifeoma@coursified.app", "viewer", "viewer"),
      ],
      members: [
        { apiKeyId: "key_kemi", name: "Kemi Bello", role: "member", revoked: false },
        { apiKeyId: "key_01JA4B7Q", name: "Halleluyah Oludele", role: "owner", revoked: false },
        { apiKeyId: "key_01JAH1N6", name: "Hermes", role: "member", revoked: false },
      ],
      messageCount: 4210,
    }
  if (s.id === "mbx_hello")
    return {
      ...base,
      spamThreshold: 8,
      spamThresholdIsDefault: false,
      people: [
        person("usr_01JA3Q9C4T", "Halleluyah Oludele", "halleluyah@coursified.app", "owner", "owner"),
        person("usr_tolu", "Tolu Adeyemi", "tolu@coursified.app", "member", "admin"),
      ],
      messageCount: 1830,
    }
  if (s.id === "mbx_founder")
    return {
      ...base,
      people: [person("usr_01JA3Q9C4T", "Halleluyah Oludele", "halleluyah@coursified.app", "owner", "owner")],
      messageCount: 962,
    }
  return base
}

type CreatedBody = Json<"/v1/mailboxes", "post">
const created = (body: Record<string, unknown>, routing: CreatedBody["routing"]): CreatedBody => {
  const kind = (body.kind as Summary["kind"]) ?? "shared"
  return {
    ...detail(
      summary(
        "mbx_admissions",
        String(body.address ?? "admissions@coursified.app"),
        kind,
        (body.displayName as string) ?? null,
        (body.targets as string[]) ?? [],
      ),
    ),
    routing,
    messageCount: kind === "user" || kind === "shared" ? 0 : null,
  }
}

const conflict = (drop: boolean, address: string) =>
  refusal(
    409,
    "Conflict",
    `Cloudflare already routes ${address} to ${drop ? "nowhere (drop)" : "tolu.adeyemi@gmail.com"}, so its mail wouldn't reach Mailyard.`,
    {
      reason: "routing-rule-exists",
      ruleDestination: drop ? "drop" : "tolu.adeyemi@gmail.com",
      ruleAction: drop ? "drop" : "forward",
      ruleId: drop ? "7c6b5a4d3e2f41009b8a7c6d5e4f3a2b" : "a1b2c3d4e5f6478a9b0c1d2e3f4a5b6c",
    },
  )

// ── Rules ───────────────────────────────────────────────────────────────────────────────────────────────────

type Rules = Json<"/v1/mailboxes/{id}/rules", "get">
const RULES: Rules = {
  rules: [
    {
      id: "rul_14",
      name: "Refunds to billing",
      enabled: true,
      match: "any",
      conditions: [
        { field: "subject", op: "contains", value: "refund" },
        { field: "body", op: "contains", value: "chargeback" },
      ],
      actions: [
        { type: "label", labelId: "lbl_billing" },
        { type: "forward", to: ["billing@coursified.app"] },
        { type: "assign", assignee: "key_kemi" },
      ],
      stop: true,
      position: 0,
      createdAt: 1792171680000,
      updatedAt: 1792171680000,
      matchCount: 18,
      lastMatchedAt: 1792241280000,
    },
    {
      id: "rul_09",
      name: "Paystack receipts",
      enabled: true,
      match: "all",
      conditions: [
        { field: "from", op: "endsWith", value: "@paystack.com" },
        { field: "automated", value: true },
      ],
      actions: [{ type: "label", labelId: "lbl_payments" }, { type: "archive" }, { type: "markRead" }],
      stop: false,
      position: 1,
      createdAt: 1790531280000,
      updatedAt: 1790531280000,
      matchCount: 142,
      lastMatchedAt: 1792256400000,
    },
    {
      id: "rul_05",
      name: "Course questions to Hermes",
      enabled: true,
      match: "all",
      conditions: [
        { field: "to", op: "equals", value: "support@coursified.app" },
        { field: "subject", op: "contains", value: "course" },
      ],
      actions: [
        { type: "webhook", endpointId: "whk_02" },
        { type: "label", labelId: "lbl_courses" },
      ],
      stop: false,
      position: 2,
      createdAt: 1790963280000,
      updatedAt: 1792086480000,
      matchCount: 63,
      lastMatchedAt: 1792253580000,
    },
    {
      id: "rul_03",
      name: "GitHub notifications",
      enabled: false,
      match: "all",
      conditions: [{ field: "from", op: "equals", value: "notifications@github.com" }],
      actions: [{ type: "archive" }, { type: "skipSpamCheck" }],
      stop: false,
      position: 3,
      createdAt: 1789667280000,
      updatedAt: 1791913680000,
      matchCount: 0,
      lastMatchedAt: null,
    },
  ],
}

type Labels = Json<"/v1/mailboxes/{id}/labels", "get">
const LABELS: Labels = {
  labels: [
    {
      id: "lbl_billing",
      name: "Billing",
      color: "blue",
      threads: 18,
      unreadThreads: 2,
      createdAt: 1788512400000,
    },
    {
      id: "lbl_payments",
      name: "Payments",
      color: "green",
      threads: 142,
      unreadThreads: 0,
      createdAt: 1788512400000,
    },
    {
      id: "lbl_courses",
      name: "Course questions",
      color: "amber",
      threads: 63,
      unreadThreads: 5,
      createdAt: 1788512400000,
    },
  ],
} as Labels

type Apply = Json<"/v1/mailboxes/{id}/rules/{ruleId}/apply", "post">

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────

type Sessions = Json<"/v1/sessions", "get">
const sessions = (): Sessions => {
  const now = Date.now()
  const key = (
    id: string,
    name: string,
    prefix: string,
    scopes: ("send" | "track" | "read" | "admin")[],
  ) => ({ id, name, prefix, scopes })
  return {
    sessions: [
      {
        id: "ses_01JAFS1",
        current: true,
        via: "session-key",
        key: key("key_S1", "Ops laptop", "sk_Lp8vQ2c", ["send", "track", "read", "admin"]),
        userAgent: "Firefox 131 on Linux",
        ip: "102.89.34.17",
        location: "Lagos, NG",
        createdAt: now - 3 * DAY,
        lastSeenAt: now,
        expiresAt: now + 14 * DAY,
        absoluteExpiresAt: now + 27 * DAY,
      },
      {
        id: "ses_01JAFS2",
        current: false,
        via: "session-key",
        key: key("key_S2", "Ops laptop", "sk_Lp8vQ2c", ["send", "track", "read", "admin"]),
        userAgent: "Safari on iPhone",
        ip: "102.89.40.2",
        location: "Lagos, NG",
        createdAt: now - 9 * DAY,
        lastSeenAt: now - 5 * 3_600_000,
        expiresAt: now + 14 * DAY - 5 * 3_600_000,
        absoluteExpiresAt: now + 21 * DAY,
      },
      {
        id: "ses_01JAFS3",
        current: false,
        via: "session-key",
        key: key("key_S3", "Support desk", "sk_Ab3kW9m", ["send", "read"]),
        userAgent: "Chrome 130 on Windows",
        ip: "197.210.53.9",
        location: "Ibadan, NG",
        createdAt: now - 26 * DAY,
        lastSeenAt: now - 6 * DAY,
        expiresAt: now + 8 * DAY,
        absoluteExpiresAt: now + 4 * DAY,
      },
    ],
  } as Sessions
}

// ── Members and invites ─────────────────────────────────────────────────────────────────────────────────────

type Members = Json<"/v1/members", "get">
type Invite = Members["invites"][number]
const box = (mailboxId: string, access: "owner" | "member" | "viewer", address: string) => ({
  mailboxId,
  access,
  address,
})
const members = (): Members => {
  const now = Date.now()
  const m = (
    id: string,
    name: string,
    email: string,
    role: Members["members"][number]["role"],
    mailboxes: ReturnType<typeof box>[],
    lastActive: number,
  ) => ({
    id,
    name,
    email,
    role,
    timeZone: "Africa/Lagos",
    createdAt: now - 40 * DAY,
    lastActiveAt: lastActive,
    mailboxes,
  })
  return {
    members: [
      m(
        "usr_01JA3Q9C4T",
        "Halleluyah Oludele",
        "halleluyah@coursified.app",
        "owner",
        [
          box("mbx_hello", "owner", "hello@coursified.app"),
          box("mbx_support", "owner", "support@coursified.app"),
          box("mbx_founder", "owner", "halleluyah@coursified.app"),
        ],
        now - 60_000,
      ),
      m(
        "usr_tolu",
        "Tolu Adeyemi",
        "tolu@coursified.app",
        "admin",
        [box("mbx_hello", "member", "hello@coursified.app")],
        now - 2 * 3_600_000,
      ),
      m(
        "usr_kemi",
        "Kemi Bello",
        "kemi@coursified.app",
        "agent",
        [box("mbx_support", "member", "support@coursified.app")],
        now - 22 * 60_000,
      ),
      m("usr_seun", "Seun Akande", "seun@coursified.app", "sender", [], now - 3 * DAY),
      m(
        "usr_ifeoma",
        "Ifeoma Nwosu",
        "ifeoma@coursified.app",
        "viewer",
        [box("mbx_support", "viewer", "support@coursified.app")],
        now - DAY,
      ),
    ],
    invites: [
      inviteBody("inv_01", "dayo@coursified.app", "agent", "sent", now - DAY, now + 5.5 * DAY),
      inviteBody("inv_02", "accountant@ledgerly.ng", "viewer", "expired", now - 8 * DAY, now - DAY),
      inviteBody("inv_03", "funmi@coursified.app", "sender", "draft", now - 600_000, now + 7 * DAY),
    ],
  }
}
function inviteBody(
  id: string,
  email: string,
  role: Invite["role"],
  status: Invite["status"],
  createdAt: number,
  expiresAt: number,
): Invite {
  return {
    id,
    email,
    role,
    mailboxes: role === "agent" ? [{ mailboxId: "mbx_support", access: "member" }] : [],
    message: null,
    invitedBy: id === "inv_02" ? "Tolu Adeyemi" : "Halleluyah Oludele",
    invitedById: id === "inv_02" ? "usr_tolu" : "usr_01JA3Q9C4T",
    createdAt,
    expiresAt,
    sentAt: status === "draft" ? null : createdAt,
    sendCount: status === "draft" ? 0 : 1,
    status,
  }
}

type Me = Json<"/v1/me", "get">
const ws = {
  id: "ws_01JA3Q8M2K",
  name: "Coursified",
  logoUrl: null,
  url: "https://mail.coursified.app",
  host: "mail.coursified.app",
  claimed: true,
}
const meAs = (role: NonNullable<Me["role"]>): Me => {
  const who: Record<string, [string, string, string]> = {
    owner: ["usr_01JA3Q9C4T", "Halleluyah Oludele", "halleluyah@coursified.app"],
    admin: ["usr_tolu", "Tolu Adeyemi", "tolu@coursified.app"],
    sender: ["usr_seun", "Seun Akande", "seun@coursified.app"],
    viewer: ["usr_ifeoma", "Ifeoma Nwosu", "ifeoma@coursified.app"],
    agent: ["usr_kemi", "Kemi Bello", "kemi@coursified.app"],
  }
  const [id, name, email] = who[role] ?? who.owner ?? ["", "", ""]
  return {
    user: { id, name, email, timeZone: "Africa/Lagos" },
    workspace: ws,
    role,
    via: "session-member",
    key: null,
    scopes: [],
    permissions: [],
    mailboxes: [],
    workspaces: [ws],
    session: {
      id: "ses_01JAFS1",
      expiresAt: Date.now() + 14 * DAY,
      absoluteExpiresAt: Date.now() + 30 * DAY,
    },
  }
}

// ── Brand, compliance, sending ──────────────────────────────────────────────────────────────────────────────

type Brand = Json<"/v1/settings/brand", "get">
const COURSIFIED_MARK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512' width='512' height='512' role='img' aria-label='Coursified'%3E %3Cpath fill='%232E5BFF' d=' M 256 56 L 366 56 A 90 90 0 0 1 456 146 L 456 256 A 200 200 0 0 1 256 456 L 146 456 A 90 90 0 0 1 56 366 L 56 256 A 200 200 0 0 1 256 56 Z' /%3E %3C/svg%3E"
const BRAND: Brand = {
  name: "Coursified",
  siteUrl: "https://coursified.app",
  tagline: "Learn data skills in weeks, not years",
  // Coursified's real mark (screens/ops/assets/coursified), inline so fixture mode makes no outside request.
  logoUrl: COURSIFIED_MARK,
  fontsHref:
    "https://fonts.googleapis.com/css2?family=Outfit:wght@500&family=Figtree:wght@400;600&display=swap",
  colors: {
    bg: "#F4F4F2",
    surface: "#EEF2FF",
    fg: "#0E0E0E",
    muted: "#71717A",
    border: "#E4E4E7",
    indigo: "#2E5BFF",
    white: "#FFFFFF",
  },
  fonts: { display: "Outfit", body: "Figtree" },
}
const brand = (): Brand => {
  const s = fx()
  if (s === "default")
    return {
      name: "Coursified",
      siteUrl: "https://coursified.app",
      tagline: "Learn data skills in weeks, not years",
      colors: {},
    }
  if (s === "refused") return { ...BRAND, colors: { ...BRAND.colors, indigo: "#C6F432", muted: "#52525B" } }
  if (s === "logo-uploaded")
    return {
      ...BRAND,
      colors: { ...BRAND.colors, muted: "#52525B" },
      logoUrl:
        "https://mail.coursified.app/brand/logo/4f1c9b2e7a6d3058c1e9f2a4b7d60e3c5a8f9b1d2e4c6a7b9d0f1e3a5c7b9d2e.png",
    }
  return BRAND
}

type Compliance = Json<"/v1/settings/compliance", "get">
const compliance = (): Compliance => {
  const base: Compliance = {
    postalAddress: "Coursified Ltd, 14 Admiralty Way, Lekki Phase 1, Lagos, Nigeria",
    linkAllowlist: ["coursified.app", "learn.coursified.app", "youtube.com"],
    seedAddresses: ["seed.coursified@gmail.com", "seed.coursified@outlook.com", "seed.coursified@yahoo.com"],
    trackingOrigin: "https://t.coursified.app",
    privacyUrl: "https://coursified.app/privacy",
    trackOpensDefault: null,
    trackClicksDefault: true,
    doubleOptInDefault: null,
    preferencePage: { useBrand: true, showTopicDescriptions: true },
    trackingOriginCheck: {
      host: "t.coursified.app",
      cname: "mailyard-api.halleluyaholudele.workers.dev",
      certificate: "valid",
      routesHere: true,
      checkedAt: Date.now() - 2 * 3_600_000,
    },
  }
  const s = fx()
  if (s === "check-failed")
    return {
      ...base,
      trackingOriginCheck: {
        host: "t.coursified.app",
        cname: null,
        certificate: "failed",
        routesHere: false,
        checkedAt: Date.now() - 180_000,
      },
    }
  if (s === "check-never") return { ...base, trackingOriginCheck: null }
  if (s === "privacy-invalid") return { ...base, privacyUrl: "http://coursified.app/privacy" }
  return base
}

type Gmail = {
  address: string
  gmail: string
  steps: { id: string; title: string; status: string; detail: string; checkedAt: number | null }[]
}
const gmail = (): Gmail => {
  const s = fx()
  const smtp = s === "done" ? "pass" : s === "fail" ? "fail" : "running"
  return {
    address: "halleluyah@coursified.app",
    gmail: "halleluyah.oludele@gmail.com",
    steps: [
      {
        id: "verify",
        title: "Verify your Gmail address with Cloudflare",
        status: "pass",
        detail: "Cloudflare sent a link to halleluyah.oludele@gmail.com and it was clicked.",
        checkedAt: T - 1_260_000,
      },
      {
        id: "route",
        title: "Route halleluyah@coursified.app to Gmail",
        status: "pass",
        detail: "Email Routing rule forwards a copy to Gmail and keeps one in Mailyard.",
        checkedAt: T - 1_200_000,
      },
      {
        id: "smtp",
        title: "Add “Send mail as” in Gmail",
        status: smtp,
        detail:
          smtp === "fail"
            ? "Gmail couldn’t sign in to the SMTP server. It answered 535 5.7.8 authentication failed. The token needs the Email Sending: Send permission for coursified.app. Create a new one, paste it in Gmail, then check again."
            : "Waiting for Gmail’s confirmation email to arrive. We’ll tick this as soon as it does.",
        checkedAt: T - 20_000,
      },
      {
        id: "test",
        title: "Send a test from Gmail as halleluyah@coursified.app",
        status: s === "done" ? "pass" : "waiting",
        detail:
          s === "done"
            ? "SPF pass · DKIM pass, d=coursified.app · DMARC pass"
            : "We check SPF, DKIM and DMARC on the message Gmail sends.",
        checkedAt: s === "done" ? T : null,
      },
    ],
  }
}

// ── The overrides ───────────────────────────────────────────────────────────────────────────────────────────

const ROLE_FX = new Set(["owner", "admin", "sender", "viewer", "agent"])
const meOverride: Override = {
  method: "GET",
  path: new Scoped(/^\/v1\/me$/, () => here().startsWith("/settings") && ROLE_FX.has(fx() ?? "")),
  answer: () => ok(meAs(fx() as NonNullable<Me["role"]>)),
}

export const SETTINGS_OVERRIDES: readonly Override[] = [
  meOverride,
  // Mailboxes
  {
    method: "GET",
    path: mine(/^\/v1\/mailboxes$/),
    answer: (_, __, url) => {
      const s = fx()
      if (s === "loading") return hang()
      if (s === "error") return refusal(500, "InternalError", "Internal error")
      if (s === "empty") return ok({ mailboxes: [] } satisfies MailboxList)
      const kind = url.searchParams.get("kind")
      return ok({
        mailboxes: kind ? MAILBOXES.filter((m) => m.kind === kind) : MAILBOXES,
      } satisfies MailboxList)
    },
  },
  {
    method: "POST",
    path: mine(/^\/v1\/mailboxes$/),
    answer: (_, b) => {
      const body = json(b)
      const s = fx()
      const address = String(body.address ?? "")
      if (body.replaceRoutingRule) return ok(created(body, "replaced"))
      if (s === "conflict" || address.startsWith("taken@")) return conflict(false, address)
      if (s === "conflict-drop" || s === "created-replaced") return conflict(true, address)
      if (s === "created-clear") return ok(created(body, "clear"))
      if (s === "created-catch-all")
        return ok(
          created(
            { ...body, kind: "catch_all", address: "*@coursified.app", targets: ["mbx_hello"] },
            "unchecked",
          ),
        )
      return ok(created(body, "unchecked"))
    },
  },
  {
    method: "GET",
    path: mine(/^\/v1\/mailboxes\/(mbx_[A-Za-z0-9_]+)$/),
    answer: ([, id = ""]) => {
      if (id === "mbx_error") return refusal(500, "InternalError", "Internal error")
      const s = MAILBOXES.find((m) => m.id === id)
      return s ? ok(detail(s)) : refusal(404, "NotFound", `No mailbox ${id}.`)
    },
  },
  {
    method: "PATCH",
    path: mine(/^\/v1\/mailboxes\/(mbx_[A-Za-z0-9_]+)$/),
    answer: ([, id = ""], b) => {
      const s = MAILBOXES.find((m) => m.id === id) ?? MAILBOXES[1]
      const d = detail(s as Summary)
      const body = json(b)
      return ok({
        ...d,
        ...body,
        spamThreshold: body.spamThreshold ?? 5,
        spamThresholdIsDefault:
          body.spamThreshold === null || body.spamThreshold === undefined ? d.spamThresholdIsDefault : false,
        updatedAt: Date.now(),
      })
    },
  },
  {
    method: "PUT",
    path: mine(/^\/v1\/mailboxes\/(mbx_[A-Za-z0-9_]+)\/members$/),
    answer: ([, id = ""]) =>
      ok({
        ...detail((MAILBOXES.find((m) => m.id === id) ?? MAILBOXES[1]) as Summary),
        updatedAt: Date.now(),
      }),
  },
  // Rules
  {
    method: "GET",
    path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules$/),
    answer: ([, id]) => {
      const s = fx()
      if (s === "error") return refusal(500, "InternalError", "Internal error")
      if (s === "empty" || id !== "mbx_support") return ok({ rules: [] } satisfies Rules)
      return ok(RULES)
    },
  },
  { method: "GET", path: mine(/^\/v1\/mailboxes\/([^/]+)\/labels$/), answer: () => ok(LABELS) },
  {
    method: "POST",
    path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules\/([^/]+)\/apply$/),
    answer: (_, b) =>
      ok(
        (json(b).cursor
          ? { examined: 212, matched: 7, changed: 6, skippedActions: ["forward"], nextCursor: null }
          : {
              examined: 500,
              matched: 23,
              changed: 19,
              skippedActions: ["forward"],
              nextCursor: "cur_500",
            }) satisfies Apply,
      ),
  },
  {
    method: "PUT",
    path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules\/order$/),
    answer: (_, b) => {
      const ids = (json(b).ruleIds as string[]) ?? []
      return ok({
        rules: ids.map((id, i) => ({
          ...(RULES.rules.find((r) => r.id === id) ?? RULES.rules[0]),
          position: i,
        })),
      })
    },
  },
  {
    method: "POST",
    path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules$/),
    answer: (_, b) =>
      ok({
        ...RULES.rules[0],
        ...json(b),
        id: "rul_new",
        matchCount: 0,
        lastMatchedAt: null,
        position: RULES.rules.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  },
  {
    method: "PATCH",
    path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules\/([^/]+)$/),
    answer: ([, , rid], b) =>
      ok({ ...(RULES.rules.find((r) => r.id === rid) ?? RULES.rules[0]), ...json(b), updatedAt: Date.now() }),
  },
  { method: "DELETE", path: mine(/^\/v1\/mailboxes\/([^/]+)\/rules\/([^/]+)$/), answer: () => ok(null, 204) },
  // Gmail mode (planned, HAL-3314): the design's sample, so the planned screen renders in fixture mode
  { method: "GET", path: mine(/^\/v1\/gmail-mode$/), answer: () => ok(gmail()) },
  { method: "POST", path: mine(/^\/v1\/gmail-mode\/check$/), answer: () => ok(gmail()) },
  // Sessions
  {
    method: "GET",
    path: mine(/^\/v1\/sessions$/),
    answer: () => (fx() === "error" ? refusal(500, "InternalError", "Internal error") : ok(sessions())),
  },
  { method: "DELETE", path: mine(/^\/v1\/sessions$/), answer: () => ok({ ended: 2 }) },
  { method: "DELETE", path: mine(/^\/v1\/sessions\/([^/]+)$/), answer: () => ok(null, 204) },
  // Members and invites
  {
    method: "GET",
    path: mine(/^\/v1\/members$/),
    answer: () => (fx() === "error" ? refusal(500, "InternalError", "Internal error") : ok(members())),
  },
  {
    method: "PATCH",
    path: mine(/^\/v1\/members\/([^/]+)$/),
    answer: ([, id], b) =>
      ok({ ...(members().members.find((m) => m.id === id) ?? members().members[1]), ...json(b) }),
  },
  {
    method: "DELETE",
    path: mine(/^\/v1\/members\/([^/]+)$/),
    answer: ([, id]) => {
      const m = members().members.find((x) => x.id === id)
      if (m?.role === "owner")
        return refusal(409, "Conflict", "The owner can’t be removed. Transfer ownership first.", {
          reason: "owner",
        })
      const { mailboxes: _m, ...rest } = m ?? members().members[1] ?? ({} as Members["members"][number])
      return ok(rest)
    },
  },
  {
    method: "POST",
    path: mine(/^\/v1\/workspace\/transfer$/),
    answer: (_, b) => {
      const m = members().members.find((x) => x.id === json(b).memberId) ?? members().members[1]
      const { mailboxes: _m, ...rest } = m ?? ({} as Members["members"][number])
      return ok({ ...rest, role: "owner" })
    },
  },
  {
    method: "POST",
    path: mine(/^\/v1\/invites$/),
    answer: (_, b) => {
      const body = json(b)
      const email = String(body.email ?? "")
      if (email.endsWith("@coursified.app") && members().members.some((m) => m.email === email))
        return refusal(409, "Conflict", `${email} is already a member of Coursified.`, {
          reason: "already-member",
        })
      const invite: Invite = {
        ...inviteBody(
          "inv_new",
          email,
          (body.role as Invite["role"]) ?? "sender",
          "draft",
          Date.now(),
          Date.now() + 7 * DAY,
        ),
        mailboxes: (body.mailboxes as Invite["mailboxes"]) ?? [],
        message: (body.message as string) ?? null,
      }
      const text = `Halleluyah Oludele invited you to Coursified on Mailyard as ${invite.role}.\n\n${invite.message ? `${invite.message}\n\n` : ""}Accept: https://mail.coursified.app/invite/••••\n\nThe link works for 7 days.`
      return ok({
        invite,
        draft: {
          from: "Mailyard <no-reply@coursified.app>",
          to: email,
          subject: "Halleluyah Oludele invited you to Coursified",
          html: `<p>${text.replace(/\n\n/g, "</p><p>")}</p>`,
          text,
        },
      } satisfies Json<"/v1/invites", "post">)
    },
  },
  {
    method: "POST",
    path: mine(/^\/v1\/invites\/([^/]+)\/(send|resend)$/),
    answer: ([, id]) => {
      const i =
        members().invites.find((x) => x.id === id) ??
        inviteBody(String(id), "dayo@coursified.app", "sender", "draft", Date.now(), Date.now() + 7 * DAY)
      return ok({
        ...i,
        status: "sent",
        sentAt: Date.now(),
        sendCount: Number(i.sendCount) + 1,
        expiresAt: Date.now() + 7 * DAY,
      })
    },
  },
  {
    method: "DELETE",
    path: mine(/^\/v1\/invites\/([^/]+)$/),
    answer: ([, id]) =>
      ok({ ...(members().invites.find((x) => x.id === id) ?? members().invites[0]), status: "revoked" }),
  },
  // Brand
  { method: "GET", path: mine(/^\/v1\/settings\/brand$/), answer: () => ok(brand()) },
  {
    method: "PUT",
    path: mine(/^\/v1\/settings\/brand$/),
    answer: (_, b) => {
      const { logoUploadId, ...rest } = json(b)
      return ok({
        ...rest,
        ...(logoUploadId
          ? {
              logoUrl:
                "https://mail.coursified.app/brand/logo/4f1c9b2e7a6d3058c1e9f2a4b7d60e3c5a8f9b1d2e4c6a7b9d0f1e3a5c7b9d2e.png",
            }
          : {}),
      })
    },
  },
  // Tracking and compliance
  { method: "GET", path: mine(/^\/v1\/settings\/compliance$/), answer: () => ok(compliance()) },
  {
    method: "PUT",
    path: mine(/^\/v1\/settings\/compliance$/),
    answer: (_, b) => ok({ ...compliance(), ...json(b) }),
  },
  {
    method: "POST",
    path: mine(/^\/v1\/settings\/compliance\/tracking-check$/),
    answer: () =>
      ok({
        ...compliance(),
        trackingOriginCheck: {
          host: "t.coursified.app",
          cname: "mailyard-api.halleluyaholudele.workers.dev",
          certificate: "valid",
          routesHere: true,
          checkedAt: Date.now(),
        },
      }),
  },
  // Sending and the governor
  {
    method: "GET",
    path: new Scoped(
      /^\/v1\/(sending\/governor|settings\/sending)$/,
      () => onMyPages() && fx() === "unreachable",
    ),
    answer: () =>
      refusal(503, "GovernorUnreachable", "The sending governor didn’t answer.", {
        requestId: "req_01JAFF6B3N0Q",
      }),
  },
]

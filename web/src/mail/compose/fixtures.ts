/**
 * Fixture-mode answers for the composer, in the live shapes, so every designed composer state can be reached
 * without a backend. Drafts created in fixture mode live in memory for the tab.
 *
 * Draft ids that open in a designed state (GET …/drafts/{id}):
 *   drf_blocked_quota       → blockedReason quota_exhausted (compose-blocked-quota)
 *   drf_blocked_domain      → blockedReason domain_unhealthy (compose-blocked-domain)
 *   drf_blocked_suppressed  → blockedReason all_recipients_suppressed (compose-blocked-suppressed)
 *   drf_recipients          → 52 recipients, one invalid (compose-recipients)
 *   drf_attachments         → four attachments around the 5 MiB budget (compose-attachments)
 *
 * Recipients whose domain picks what Send answers (POST …/send):
 *   …@suppressed.example    → 409 SendBlocked all_recipients_suppressed
 *   …@quota.example         → 409 SendBlocked quota_exhausted (resets at the next 00:00 UTC)
 *   …@domain.example        → 409 SendBlocked domain_unhealthy (dom_01)
 *   …@limit.example         → 409 Conflict agent_limit (20 of 20 today)
 *   …@notallowed.example    → 409 Conflict recipient_not_allowed (those addresses)
 *   …@deleting.example      → 409 Conflict workspace-deleting
 *   …@approval.example      → 200 held: approval { status: pending }, sendAt null
 *   anyone else             → 200 with the undo window asked for (undoUntil), or sendAt when scheduled
 *
 * Uploads over 25 MiB answer 413; correspondents filter the design's people by q.
 */

import type { MailAnswer, MailOverride } from "../fixtures-core.ts"
import type { Draft, Upload } from "../types.ts"

const now = () => Date.now()
const drafts = new Map<string, Draft>()
let seq = 0

const P = (name: string | null, address: string) => ({ name, address })

const blank = (id: string, over: Partial<Draft> = {}): Draft => ({
  id,
  threadId: null,
  inReplyTo: null,
  references: [],
  from: "support@coursified.app",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  bodyText: "",
  bodyHtml: null,
  attachments: [],
  status: "draft",
  sendAt: null,
  replyMode: null,
  sourceMessageId: null,
  lastError: null,
  blockedReason: null,
  track: null,
  createdAt: now() - 600_000,
  updatedAt: now() - 60_000,
  ...over,
})

const nextMidnight = () => {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

const ada = P("Ada Okafor", "ada.okafor@gmail.com")
const PEOPLE = [
  ada,
  P("Adaeze Nwankwo", "adaeze.n@outlook.com"),
  P(null, "adamu.yusuf@gmail.com"),
  P("Chidi Eze", "chidi.eze@outlook.com"),
  P("Funke Adebayo", "funke.adebayo@yahoo.com"),
  P("Grace Nnamdi", "grace.nnamdi@gmail.com"),
  P("Ibrahim Musa", "ibrahim@musaanalytics.ng"),
  P("Kemi Bello", "kemi@coursified.app"),
  P("Sade Williams", "accounts@sadewilliams.co"),
]

const STATES: Record<string, () => Draft> = {
  drf_blocked_quota: () =>
    blank("drf_blocked_quota", {
      threadId: "thr_01",
      to: [ada],
      subject: "Re: Payment didn’t go through",
      bodyText: "Hi Ada,\n\nHere’s a manual payment link that takes cards and bank transfer.",
      replyMode: "reply",
      blockedReason: "quota_exhausted",
    }),
  drf_blocked_domain: () =>
    blank("drf_blocked_domain", {
      to: [ada],
      subject: "Your payment link",
      bodyText: "Hi Ada,\n\nFollowing up on your payment.",
      blockedReason: "domain_unhealthy",
    }),
  drf_blocked_suppressed: () =>
    blank("drf_blocked_suppressed", {
      to: [P(null, "accounts@sadewilliams.co")],
      subject: "Re: Bulk enrolment CSV",
      bodyText: "Hi Sade,\n\nThe corrected file is in.",
      blockedReason: "all_recipients_suppressed",
    }),
  drf_recipients: () =>
    blank("drf_recipients", {
      subject: "November cohort: your start date",
      to: [
        P(null, "ada.okafor@gmail.com"),
        P(null, "chidi.eze@outlook.com"),
        P(null, "funke.adebayo@yahoo.com"),
        P(null, "grace.nnamdi@gmail,com"),
        ...Array.from({ length: 48 }, (_, i) => P(null, `student${i + 1}@example.com`)),
      ],
      bodyText: "Hi all,\n\nThe November cohort starts on Monday 2 November.",
    }),
  drf_attachments: () =>
    blank("drf_attachments", {
      to: [ada],
      subject: "Course materials",
      bodyText: "Hi Ada,\n\nThe guide and the recording are attached.",
      attachments: [
        {
          key: "upl/mbx_support/guide",
          filename: "enrolment-guide.pdf",
          mimeType: "application/pdf",
          size: 1_258_291,
          delivery: "inline",
        },
        {
          key: "upl/mbx_support/photos",
          filename: "cohort-photos.zip",
          mimeType: "application/zip",
          size: 3_250_585,
          delivery: "inline",
        },
        {
          key: "upl/mbx_support/rec",
          filename: "module-3-recording.mp4",
          mimeType: "video/mp4",
          size: 48_339_763,
          delivery: "link",
        },
      ],
    }),
}

/** The message a reply answers, from the design fixtures (thread details). */
async function sourceMessage(messageId: string) {
  const table = (await import("../../fixtures/fixtures.json")).default as Record<string, { body: unknown }[]>
  for (const v of table["GET /v1/mailboxes/{id}/threads/{id}"] ?? []) {
    const msgs = (v.body as { messages?: Record<string, unknown>[] }).messages ?? []
    const m = msgs.find((x) => x.id === messageId)
    if (m)
      return m as {
        threadId: string
        subject: string
        snippet: string
        from: { name: string | null; address: string } | null
        to: { name: string | null; address: string }[]
        cc: { name: string | null; address: string }[]
        receivedAt: number
        messageId: string | null
      }
  }
  return null
}

const ours = (a: string) => a.endsWith("@coursified.app")
const fmt = (p: { name: string | null; address: string } | null) =>
  p ? (p.name ? `${p.name} <${p.address}>` : p.address) : "unknown sender"

async function fromReply(
  id: string,
  messageId: string,
  mode: "reply" | "replyAll" | "forward",
  text = "",
): Promise<Draft> {
  const src = await sourceMessage(messageId)
  const subject = src?.subject ?? "your message"
  const when = new Date(src?.receivedAt ?? now()).toUTCString()
  const quote =
    mode === "forward"
      ? `\n---------- Forwarded message ---------\nFrom: ${fmt(src?.from ?? null)}\nDate: ${when}\nSubject: ${subject}\nTo: ${(src?.to ?? []).map(fmt).join(", ")}\n\n${src?.snippet ?? ""}`
      : `\n\nOn ${when}, ${fmt(src?.from ?? null)} wrote:\n> ${src?.snippet ?? ""}`
  const author =
    src?.from && !ours(src.from.address) ? [src.from] : (src?.to ?? []).filter((p) => !ours(p.address))
  const to =
    mode === "forward"
      ? []
      : mode === "reply"
        ? author
        : [
            ...author,
            ...(src?.to ?? []).filter(
              (p) => !ours(p.address) && !author.some((a) => a.address === p.address),
            ),
          ]
  const cc = mode === "replyAll" ? (src?.cc ?? []).filter((p) => !ours(p.address)) : []
  return blank(id, {
    threadId: mode === "forward" ? null : (src?.threadId ?? null),
    replyMode: mode,
    sourceMessageId: messageId,
    to,
    cc,
    subject:
      mode === "forward"
        ? `Fwd: ${subject.replace(/^(re|fwd?):\s*/i, "")}`
        : /^re:/i.test(subject)
          ? subject
          : `Re: ${subject}`,
    bodyText: `${text}${quote}`,
    attachments:
      mode === "forward" && messageId === "msg_01_3"
        ? [
            {
              key: "att/msg_01_3/statement",
              filename: "statement-oct-17.pdf",
              mimeType: "application/pdf",
              size: 217_088,
            },
          ]
        : [],
    createdAt: now(),
    updatedAt: now(),
  })
}

const refuse = (status: number, body: Record<string, unknown>): MailAnswer => ({
  status,
  body: { requestId: "fixture", ...body },
})

function sendAnswer(d: Draft, body: { sendAt?: number; undoSeconds?: number }): MailAnswer {
  const all = [...d.to, ...d.cc, ...d.bcc].map((p) => p.address)
  const has = (dom: string) => all.filter((a) => a.endsWith(`@${dom}`))
  if (has("suppressed.example").length === all.length && all.length)
    return refuse(409, {
      _tag: "SendBlocked",
      reason: "all_recipients_suppressed",
      message: "Every recipient is suppressed.",
    })
  if (has("quota.example").length)
    return refuse(409, {
      _tag: "SendBlocked",
      reason: "quota_exhausted",
      message: "The daily quota of 1,000 is used.",
      resetsAt: nextMidnight(),
    })
  if (has("domain.example").length)
    return refuse(409, {
      _tag: "SendBlocked",
      reason: "domain_unhealthy",
      message: "DKIM on coursified.app stopped matching at 08:12 UTC.",
      domainId: "dom_01",
    })
  if (has("limit.example").length)
    return refuse(409, {
      _tag: "Conflict",
      reason: "agent_limit",
      message: "This key has sent 20 of its 20 messages today.",
      limit: 20,
      sentToday: 20,
      resetsAt: nextMidnight(),
    })
  if (has("notallowed.example").length)
    return refuse(409, {
      _tag: "Conflict",
      reason: "recipient_not_allowed",
      message: "Some recipients are outside this key’s allow-list.",
      notAllowed: has("notallowed.example"),
    })
  if (has("deleting.example").length)
    return refuse(409, {
      _tag: "Conflict",
      reason: "workspace-deleting",
      message: "The workspace is being deleted.",
      deletesAt: now() + 6 * 86_400_000,
    })
  if (has("approval.example").length) {
    const held = { ...d, status: "scheduled" as const, sendAt: null }
    drafts.set(d.id, held)
    return {
      status: 200,
      body: {
        draft: held,
        sendAt: null,
        undoUntil: null,
        approval: { id: `apr_${d.id}`, status: "pending" },
      },
    }
  }
  const sendAt = body.sendAt ?? now() + (body.undoSeconds ?? 0) * 1000
  const undoUntil = body.sendAt ? null : body.undoSeconds ? sendAt : null
  const sent = {
    ...d,
    status: body.sendAt || body.undoSeconds ? ("scheduled" as const) : ("due" as const),
    sendAt,
  }
  drafts.set(d.id, sent)
  return { status: 200, body: { draft: sent, sendAt, undoUntil, approval: null } }
}

const get = (id: string): Draft | undefined => drafts.get(id) ?? STATES[id]?.()

/** The identities the composer designs show (compose-identity, compose-attachments). */
const IDENTITIES = {
  identities: [
    {
      address: "support@coursified.app",
      displayName: "Coursified support",
      mailboxId: "mbx_support",
      kind: "shared",
      via: "member",
      signature: { text: "Coursified support\nsupport@coursified.app · coursified.app", html: null },
    },
    {
      address: "hello@coursified.app",
      displayName: "Coursified",
      mailboxId: "mbx_hello",
      kind: "shared",
      via: "member",
      signature: { text: "The Coursified team\ncoursified.app", html: null },
    },
    {
      address: "halleluyah@coursified.app",
      displayName: "Halleluyah Oludele",
      mailboxId: "mbx_founder",
      kind: "user",
      via: "admin",
      signature: null,
    },
    {
      address: "billing@coursified.app",
      displayName: "Coursified billing",
      mailboxId: "mbx_support",
      kind: "alias",
      via: "alias",
      signature: null,
    },
  ],
  anyAddressOn: ["coursified.app"],
}

export const COMPOSE_OVERRIDES: readonly MailOverride[] = [
  { method: "GET", path: /^\/v1\/identities$/, answer: () => ({ status: 200, body: IDENTITIES }) },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/[^/]+\/correspondents$/,
    answer: (_m, _b, url) => {
      const q = (url.searchParams.get("q") ?? "").toLowerCase()
      const list = PEOPLE.filter(
        (p) => !q || p.address.includes(q) || (p.name ?? "").toLowerCase().includes(q),
      ).map((p, i) => ({
        ...p,
        received: 3 - (i % 3),
        sent: i % 2,
        lastAt: now() - (i + 1) * 3_600_000 * (i + 1),
      }))
      return {
        status: 200,
        body: { correspondents: list.slice(0, Number(url.searchParams.get("limit") ?? 8)) },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/([^/]+)\/drafts$/,
    answer: async (_m, body) => {
      const b = (body ?? {}) as Partial<Draft> & {
        replyTo?: { messageId: string; mode: "reply" | "replyAll" | "forward" }
      }
      const id = `drf_fx${(++seq).toString(36)}${now().toString(36).slice(-4)}`
      const { replyTo, ...fields } = b
      const d = replyTo
        ? await fromReply(id, replyTo.messageId, replyTo.mode, fields.bodyText ?? "")
        : blank(id, { ...fields, createdAt: now(), updatedAt: now() } as Partial<Draft>)
      drafts.set(id, d)
      return { status: 200, body: d }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)$/,
    answer: ([, id = ""]) => {
      const d = get(id)
      return d ? { status: 200, body: d } : undefined
    },
  },
  {
    method: "PATCH",
    path: /^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)$/,
    answer: ([, id = ""], body) => {
      const d = get(id) ?? blank(id)
      const next = { ...d, ...(body as Partial<Draft>), updatedAt: now() }
      // A blocked reason clears once the cause is edited away (as the server re-checks on save).
      if (
        next.blockedReason === "all_recipients_suppressed" &&
        next.to.some((p) => p.address !== "accounts@sadewilliams.co")
      )
        next.blockedReason = null
      drafts.set(id, next)
      return { status: 200, body: next }
    },
  },
  {
    method: "DELETE",
    path: /^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)$/,
    answer: ([, id = ""]) => {
      drafts.delete(id)
      return { status: 200, body: { deleted: id } }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)\/send$/,
    answer: ([, id = ""], body) => {
      const d = get(id)
      if (!d) return refuse(404, { _tag: "NotFound", message: `No draft ${id}.` })
      if (d.blockedReason)
        return refuse(409, {
          _tag: "SendBlocked",
          reason: d.blockedReason,
          message: "This draft can’t send yet.",
          ...(d.blockedReason === "quota_exhausted" ? { resetsAt: nextMidnight() } : {}),
          ...(d.blockedReason === "domain_unhealthy" ? { domainId: "dom_01" } : {}),
        })
      return sendAnswer(d, (body ?? {}) as { sendAt?: number; undoSeconds?: number })
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/[^/]+\/drafts\/([^/]+)\/cancel$/,
    answer: ([, id = ""]) => {
      const d = get(id) ?? blank(id)
      const back = { ...d, status: "draft" as const, sendAt: null }
      drafts.set(id, back)
      return { status: 200, body: back }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/([^/]+)\/uploads$/,
    answer: ([, mailboxId = ""], body, url) => {
      const b = (body ?? {}) as { size?: number; type?: string }
      const size = Number(b.size ?? 0)
      if (size > 25 * 1024 * 1024)
        return refuse(413, { _tag: "PayloadTooLarge", message: "Each file can be up to 25 MiB." })
      const filename = url.searchParams.get("filename") ?? "file"
      const up: Upload = {
        key: `upl/${mailboxId}/${(++seq).toString(36)}${now().toString(36).slice(-5)}`,
        filename,
        mimeType: b.type || "application/octet-stream",
        size,
        sha256: "0".repeat(64),
      }
      return { status: 201, body: up }
    },
  },
]

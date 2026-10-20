/**
 * Mail's core fixture overrides (fixture mode only; see fixtures/overrides.ts). The design screens embed one
 * full thread and one message detail per screen, so the rest is derived from the embedded thread lists in
 * the live shapes: every listed thread opens, every message has a body, a raw source and signed-looking links.
 *
 * State-picking ids, so the audit can reach every designed state by URL:
 *   mailbox mbx_new     → an empty mailbox (inbox-empty, spam-empty, snoozed-empty all render from it)
 *   mailbox mbx_broken  → the thread list answers 503 (inbox-error); the folder pane still loads
 *   thread  thr_broken  → the thread answers 503 (thread-error); the list stays put
 *   mailbox mbx_hermes  → an agent's mailbox (ops/settings/agent-in-mail): the Agent badge and "Sent by Hermes"
 */
import type { paths } from "../api/schema"

export type MailAnswer = { status: number; body: unknown }
export type MailOverride = {
  method: string
  path: RegExp
  answer: (
    m: RegExpMatchArray,
    body: unknown,
    url: URL,
  ) => MailAnswer | Promise<MailAnswer | undefined> | undefined
}

type Ok<P extends keyof paths, M extends "get" | "post"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never
type ThreadT = Ok<"/v1/mailboxes/{id}/threads", "get">["threads"][number]
type Detail = Ok<"/v1/mailboxes/{id}/threads/{threadId}", "get">
type Msg = Detail["messages"][number]
type MsgDetail = Ok<"/v1/mailboxes/{id}/messages/{messageId}", "get">
type Variant = { screen: string; path: string; query: string; body: unknown }
type Table = Record<string, Variant[]>

let table: Promise<Table> | null = null
const load = () => {
  table ??= import("../fixtures/fixtures.json").then((m) => m.default as unknown as Table)
  return table
}

const NOW = 1792259280000 // Sat 17 Oct 2026, 17:48 UTC: the designs' "now"
const fail = (status: number, message: string): MailAnswer => ({
  status,
  body: { _tag: status >= 500 ? "Unavailable" : "NotFound", message, requestId: "req_fixture01JAFD4Q" },
})

/** Every thread summary any design list embeds, by id (the first copy wins). */
async function allThreads(): Promise<Map<string, ThreadT>> {
  const t = await load()
  const out = new Map<string, ThreadT>()
  for (const v of t["GET /v1/mailboxes/{id}/threads"] ?? [])
    for (const th of (v.body as { threads: ThreadT[] }).threads) if (!out.has(th.id)) out.set(th.id, th)
  return out
}

async function exactDetail(path: string): Promise<Detail | undefined> {
  const t = await load()
  return (t["GET /v1/mailboxes/{id}/threads/{id}"] ?? []).find((v) => v.path === path)?.body as
    | Detail
    | undefined
}

const auth = (domain: string): Msg["auth"] => ({
  source: "cloudflare",
  spf: "pass",
  dmarc: "pass",
  dkim: [{ result: "pass", domain, selector: "s1" }],
  arc: null,
})

/** A thread detail built from its list summary: one message per count, the newest carrying the snippet. */
function synthDetail(th: ThreadT, mailboxAddress: string): Detail {
  const n = Math.max(1, Number(th.messageCount) || 1)
  const them = th.participants.find((p) => p.address !== mailboxAddress) ??
    th.participants[0] ?? { name: null, address: "someone@example.com" }
  const us = th.participants.find((p) => p.address === mailboxAddress) ?? {
    name: "Coursified support",
    address: mailboxAddress,
  }
  const first = Number(th.firstAt) || NOW - 86_400_000
  const last = Number(th.lastAt) || NOW
  const sent = th.folders.includes("sent")
  const messages: Msg[] = Array.from({ length: n }, (_, i) => {
    const mine = sent ? i % 2 === (n % 2 === 0 ? 1 : 0) : i % 2 === 1
    const from = mine ? us : them
    const to = mine ? them : us
    const at = n === 1 ? last : Math.round(first + ((last - first) * i) / (n - 1))
    const isLast = i === n - 1
    return {
      id: `${th.latestMessageId.replace(/_\d+$/, "")}_${i + 1}`.replace(/^(msg_[^_]+)_\d+_(\d+)$/, "$1_$2"),
      threadId: th.id,
      folder: mine ? "sent" : ((th.folders[0] ?? "inbox") as Msg["folder"]),
      seen: !(isLast && Number(th.unreadCount) > 0),
      starred: th.starred && isLast,
      answered: !isLast,
      labelIds: isLast ? th.labelIds : [],
      receivedAt: at,
      envelopeFrom: from.address,
      envelopeTo: to.address,
      via: mine ? "cloudflare-email-sending" : "cloudflare-email-routing",
      tag: null,
      size: 4200 + i * 310,
      messageId: `<${th.id}_${i + 1}@${from.address.split("@")[1]}>`,
      inReplyTo: i ? `<${th.id}_${i}@${to.address.split("@")[1]}>` : null,
      references: [],
      subject: i ? `Re: ${th.subject.replace(/^re:\s*/i, "")}` : th.subject,
      date: at,
      from,
      replyTo: [],
      to: [to],
      cc: [],
      snippet: isLast
        ? th.snippet
        : mine
          ? "Thanks for writing in. We’ve looked into it and here’s where things stand."
          : `${th.subject.replace(/^re:\s*/i, "")}: a question for the team.`,
      hasHtml: false,
      automated: false,
      listId: null,
      listUnsubscribe: null,
      auth: auth(from.address.split("@")[1] ?? "example.com"),
      attachments:
        isLast && th.hasAttachments
          ? [
              {
                id: `att_${th.id}`,
                filename: `${th.subject
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .slice(0, 24)}.pdf`,
                mimeType: "application/pdf",
                disposition: "attachment",
                contentId: null,
                related: false,
                size: 94_208,
                sha256: "fixture",
              },
            ]
          : [],
      spamScore: th.folders.includes("spam") ? Number(th.spamScore) || 8.4 : null,
      spamReasons: th.folders.includes("spam")
        ? [
            { rule: "URIBL_BLOCKED", points: 4.1 },
            { rule: "FREEMAIL_FORGED_REPLYTO", points: 2.6 },
            { rule: "HTML_IMAGE_ONLY", points: 1.7 },
          ]
        : [],
      rulesMatched: [],
    }
  })
  return { thread: th, messages, drafts: [], notes: [] }
}

function bodyText(m: Msg): string {
  const first = (m.from?.name ?? m.from?.address ?? "").split(/\s+/)[0]
  const greet = (m.to[0]?.name ?? "there").split(/\s+/)[0]
  return `Hi ${greet},\n\n${m.snippet}\n\nThanks,\n${first}`
}

const RICH_HTML: Record<string, string> = {
  msg_01_3:
    '<p>Hi Kemi,</p><p>I tried again this afternoon and it still fails at the last step. The bank says the merchant declined it, so I don’t know who to ask. I’ve attached the statement page that shows the two payment attempts.</p><p>Thanks,<br>Ada</p><div style="color:#666;margin-top:16px">Ada Okafor · Data analyst</div><img src="https://mail.example.com/track/open.gif" width="1" height="1" alt="">',
}

const attachmentUrl = (name: string, mime: string) =>
  mime.startsWith("image/")
    ? `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#eee"/><text x="320" y="200" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#555">${name} (sample)</text></svg>`)}`
    : `/v1/files/fixture-${encodeURIComponent(name)}`

/** Parsed calendar invites by message (HAL-3369), as GET …/messages/{id} returns them. RSVPs update `myStatus`. */
const INVITES: Record<string, NonNullable<MsgDetail["invite"]>> = {
  msg_08_1: {
    method: "REQUEST",
    uid: "partner-sync-20261020@kumasitech.edu.gh",
    sequence: 0,
    summary: "Partner sync",
    description: "Monthly check-in on the Coursified rollout.",
    location: "https://meet.example.com/partner-sync",
    start: "2026-10-20T14:00:00Z",
    end: "2026-10-20T14:45:00Z",
    allDay: false,
    timeZone: "UTC",
    organizer: { address: "t.mensah@kumasitech.edu.gh", name: "Tunde Mensah" },
    attendees: [
      {
        address: "support@coursified.app",
        name: "Coursified Support",
        partstat: "NEEDS-ACTION",
        role: "REQ-PARTICIPANT",
      },
      { address: "ada@coursified.app", name: "Ada Okafor", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" },
      {
        address: "kemi@kumasitech.edu.gh",
        name: "Kemi Bello",
        partstat: "TENTATIVE",
        role: "OPT-PARTICIPANT",
      },
    ],
    myStatus: "NEEDS-ACTION",
    canRespond: true,
  },
}

function messageDetail(m: Msg, _mailboxId: string, extra: Partial<MsgDetail> = {}): MsgDetail {
  return {
    ...m,
    invite: INVITES[m.id] ?? null,
    body: { text: bodyText(m), html: RICH_HTML[m.id] ?? null },
    rawUrl: `/v1/files/fixture-${m.id}.eml`,
    attachmentUrls: Object.fromEntries(
      m.attachments.map((a) => [a.id, attachmentUrl(a.filename ?? a.id, a.mimeType)]),
    ),
    headers: [
      { name: "Return-Path", value: `<${m.envelopeFrom}>` },
      {
        name: "Received",
        value: `from mail.${m.from?.address.split("@")[1] ?? "example.com"} by mx.cloudflare.net with ESMTPS; ${new Date(Number(m.receivedAt)).toUTCString()}`,
      },
      {
        name: "Authentication-Results",
        value: `mx.cloudflare.net; dkim=${m.auth.dkim[0]?.result ?? "none"}; spf=${m.auth.spf ?? "none"}; dmarc=${m.auth.dmarc ?? "none"}`,
      },
      { name: "Message-ID", value: m.messageId ?? "" },
      { name: "Date", value: new Date(Number(m.receivedAt)).toUTCString() },
      { name: "From", value: `${m.from?.name ?? ""} <${m.from?.address ?? ""}>` },
      { name: "To", value: m.to.map((p) => p.address).join(", ") },
      { name: "Subject", value: m.subject },
      { name: "MIME-Version", value: "1.0" },
    ],
    delivery:
      m.folder === "sent"
        ? {
            messageId: `msg_log_${m.id.replace(/\D/g, "").slice(0, 4) || "8800"}`,
            status: "delivered",
            tracked: false,
            opens: 0,
            clicks: 0,
            machineOpens: 0,
            machineClicks: 0,
            firstOpenedAt: null,
            firstClickedAt: null,
            recipients: m.to.map((p) => ({
              recipient: p.address,
              kind: "to" as const,
              status: "delivered" as const,
              at: Number(m.receivedAt) + 60_000,
              attempts: 1,
              smtpResponse: "250 2.0.0 Ok: queued",
            })),
          }
        : null,
    ...extra,
  } as MsgDetail
}

function rawEml(m: MsgDetail): string {
  const head = (m.headers ?? []).map((h) => `${h.name}: ${h.value}`).join("\n")
  return `${head}\nContent-Type: text/plain; charset="UTF-8"\n\n${m.body.text}\n`
}

/** The agent's mailbox (agent-in-mail.html). */
const HERMES_THREAD: ThreadT = {
  id: "thr_inst",
  subject: "Can I pay in instalments?",
  snippet: "Perfect, thank you. Does the second one charge automatically?",
  latestMessageId: "msg_inst_3",
  messageCount: 3,
  unreadCount: 1,
  starred: false,
  hasAttachments: false,
  participants: [
    { name: "Tunde Adebayo", address: "tunde.a@gmail.com" },
    { name: "Hermes", address: "hermes@coursified.app" },
  ],
  folders: ["inbox"],
  labelIds: [],
  firstAt: NOW - 4 * 3600_000,
  lastAt: NOW - 2 * 3600_000,
  sortAt: NOW - 2 * 3600_000,
  snoozedUntil: null,
  assignee: null,
  assignedTo: null,
  scheduledSendAt: null,
}

async function threadFor(mailboxId: string, threadId: string, path: string): Promise<Detail | undefined> {
  const exact = await exactDetail(path)
  if (exact) return exact
  if (threadId === HERMES_THREAD.id) {
    const d = synthDetail(HERMES_THREAD, "hermes@coursified.app")
    d.messages = d.messages.map((m, i) => ({
      ...m,
      id: `msg_inst_${i + 1}`,
      snippet:
        [
          "Hi, can I pay for Data foundations in instalments? I can do half now.",
          "Hi Tunde, yes: Data foundations can be paid in two instalments, the first at enrolment and the second four weeks later.",
          "Perfect, thank you. Does the second one charge automatically?",
        ][i] ?? m.snippet,
    }))
    return d
  }
  const th = (await allThreads()).get(threadId)
  return th
    ? synthDetail(th, mailboxId === "mbx_hello" ? "hello@coursified.app" : "support@coursified.app")
    : undefined
}

export const CORE_OVERRIDES: readonly MailOverride[] = [
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/mbx_new$/,
    answer: async () => {
      const t = await load()
      const support = (t["GET /v1/mailboxes/{id}"] ?? [])[0]?.body as Record<string, unknown> | undefined
      if (!support) return undefined
      return {
        status: 200,
        body: {
          ...support,
          id: "mbx_new",
          address: "careers@coursified.app",
          displayName: "Coursified careers",
          members: [],
          people: [],
          messageCount: 0,
          lastExport: null,
          autoReply: null,
          forwarding: null,
        },
      }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes$/,
    answer: async (_m, _b, url) => {
      if (url.searchParams.get("kind")) return undefined
      const t = await load()
      const base = (t["GET /v1/mailboxes"] ?? []).find((v) => !v.query)?.body as
        | { mailboxes: unknown[] }
        | undefined
      if (!base?.mailboxes.length) return undefined
      return {
        status: 200,
        body: {
          mailboxes: [
            ...base.mailboxes,
            {
              id: "mbx_hermes",
              address: "hermes@coursified.app",
              domainId: "dom_01",
              kind: "shared",
              displayName: "Hermes",
              holdsMail: true,
              targetIds: [],
              createdAt: NOW - 30 * 86_400_000,
              updatedAt: NOW - 86_400_000,
            },
          ],
        },
      }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/agents$/,
    answer: () => ({
      status: 200,
      body: {
        agents: [
          {
            id: "agt_hermes",
            name: "Hermes",
            mailbox: { id: "mbx_hermes", address: "hermes@coursified.app" },
            key: {
              id: "key_hermes01",
              prefix: "sk_Hm3s",
              scopes: ["send", "read"],
              lastUsedAt: NOW - 600_000,
              revoked: false,
            },
            limits: { sendsPerDay: 200, recipients: "any", allowDomains: [], requireApproval: false },
            sentToday: 14,
            pendingApprovals: 0,
            createdAt: NOW - 30 * 86_400_000,
            removedAt: null,
          },
        ],
      },
    }),
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/(mbx_new|mbx_hermes)\/folders$/,
    answer: ([, id]) => ({
      status: 200,
      body: {
        folders: ["inbox", "archive", "sent", "spam", "trash", "snoozed", "drafts"].map((folder) => ({
          folder,
          threads: id === "mbx_hermes" && (folder === "inbox" || folder === "sent") ? 1 : 0,
          unreadThreads: id === "mbx_hermes" && folder === "inbox" ? 1 : 0,
        })),
        labels: [],
        smartFolders: [],
        views: {
          starred: 0,
          assignedToMe: 0,
          scheduled: 0,
          all: { threads: id === "mbx_hermes" ? 1 : 0, unreadThreads: id === "mbx_hermes" ? 1 : 0 },
        },
      },
    }),
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/([^/]+)\/threads$/,
    answer: ([, id], _b, url) => {
      if (id === "mbx_broken") return fail(503, "support@’s mailbox didn’t answer in time.")
      if (id === "mbx_new") return { status: 200, body: { threads: [], total: 0, nextCursor: null } }
      if (id === "mbx_hermes") {
        const folder = url.searchParams.get("folder") ?? "inbox"
        const threads = folder === "inbox" || folder === "all" ? [HERMES_THREAD] : []
        return { status: 200, body: { threads, total: threads.length, nextCursor: null } }
      }
      return undefined
    },
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/([^/]+)\/threads\/([^/]+)$/,
    answer: async ([path, id = "", threadId = ""]) => {
      if (threadId === "thr_broken") return fail(503, "The mailbox didn’t answer in time.")
      const d = await threadFor(id, threadId, path)
      return d ? { status: 200, body: d } : fail(404, `No thread ${threadId}`)
    },
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)$/,
    answer: async ([, id = "", messageId = ""]) => {
      const t = await load()
      const exact = (t["GET /v1/mailboxes/{id}/messages/{id}"] ?? []).find(
        (v) => v.path === `/v1/mailboxes/${id}/messages/${messageId}`,
      )
      const full = exact && (exact.body as { id?: string }).id ? (exact.body as MsgDetail) : undefined
      // Find the message in a thread we can build, then merge the design's own detail when it has one.
      const threadId =
        full?.threadId ??
        (messageId.startsWith("msg_inst") ? "thr_inst" : `thr_${messageId.split("_")[1] ?? ""}`)
      const d = await threadFor(id, threadId, `/v1/mailboxes/${id}/threads/${threadId}`)
      const m = d?.messages.find((x) => x.id === messageId)
      if (full)
        return {
          status: 200,
          body: {
            ...messageDetail((m ?? full) as Msg, id),
            ...full,
            body: {
              text: full.body.text.replace(/…$/, ""),
              html: RICH_HTML[full.id] ?? (full.body.html?.includes("…") ? null : full.body.html),
            },
          },
        }
      if (!m) return fail(404, `No message ${messageId}`)
      // The design's per-recipient delivery for the bounced reply (thread-delivery) rides on its own fixture.
      const delivery =
        exact && !(exact.body as { id?: string }).id ? (exact.body as MsgDetail["delivery"]) : undefined
      return { status: 200, body: messageDetail(m, id, delivery ? { delivery } : {}) }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/rsvp$/,
    answer: async ([, , messageId = ""], body) => {
      const invite = INVITES[messageId]
      const response = (body as { response?: string } | null)?.response
      if (!invite || !invite.canRespond) return fail(409, "This message has no invite that asks for a reply.")
      if (response !== "accepted" && response !== "tentative" && response !== "declined")
        return fail(400, "response must be accepted, tentative or declined")
      invite.myStatus =
        response === "accepted" ? "ACCEPTED" : response === "tentative" ? "TENTATIVE" : "DECLINED"
      return { status: 200, body: { response } }
    },
  },
  {
    method: "GET",
    path: /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/raw$/,
    answer: async ([, id = "", messageId = ""]) => {
      const threadId = messageId.startsWith("msg_inst") ? "thr_inst" : `thr_${messageId.split("_")[1] ?? ""}`
      const d = await threadFor(id, threadId, `/v1/mailboxes/${id}/threads/${threadId}`)
      const m = d?.messages.find((x) => x.id === messageId)
      return m ? { status: 200, body: rawEml(messageDetail(m, id)) } : fail(404, `No message ${messageId}`)
    },
  },
  {
    // The design's no-results search (search-empty) is an "empty" screen, which the table only answers when
    // nothing else does; answer it for its own query so the state renders.
    method: "GET",
    path: /^\/v1\/mailboxes\/[^/]+\/search$/,
    answer: async (_m, _b, url) => {
      const t = await load()
      const empty = (t["GET /v1/mailboxes/{id}/search"] ?? []).find((v) =>
        v.screen.endsWith("search-empty.html"),
      )
      const want = new URLSearchParams(empty?.query ?? "").get("q")
      return empty && want && url.searchParams.get("q") === want
        ? { status: 200, body: empty.body }
        : undefined
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/[^/]+\/threads\/bulk$/,
    answer: (_m, body) => ({
      status: 200,
      body: { updated: ((body as { threadIds?: string[] })?.threadIds ?? []).length },
    }),
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/[^/]+\/threads\/([^/]+)\/notes$/,
    answer: (_m, body) => ({
      status: 200,
      body: {
        id: `note_${Date.now().toString(36)}`,
        body: (body as { body?: string })?.body ?? "",
        author: { id: "key_01JA4B7Q2M", name: "Coursified dashboard" },
        createdAt: Date.now(),
      },
    }),
  },
  {
    method: "DELETE",
    path: /^\/v1\/mailboxes\/[^/]+\/notes\/([^/]+)$/,
    answer: ([, noteId]) => ({ status: 200, body: { deleted: noteId } }),
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/[^/]+\/folders\/(spam|trash)\/empty$/,
    answer: () => ({ status: 200, body: { purged: 4 } }),
  },
]

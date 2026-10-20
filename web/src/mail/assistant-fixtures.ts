/**
 * Fixture-mode answers for the mailbox helpers: `GET /v1/settings/assistant` (Workers AI on, summaries and
 * drafted replies on), a thread summary built from the thread the design fixtures return, and a drafted
 * reply saved through the composer's own draft store. Thread `thr_broken` refuses with `cap`, so the audit
 * reaches the refusal wording.
 */
import { COMPOSE_OVERRIDES } from "./compose/fixtures.ts"
import type { MailAnswer, MailOverride } from "./fixtures-core.ts"
import { CORE_OVERRIDES } from "./fixtures-core.ts"
import type { AssistantSettings, ThreadDetail } from "./types.ts"

const NOW = 1792259280000

export const ASSISTANT_SETTINGS: AssistantSettings = {
  summaries: true,
  drafts: true,
  categories: false,
  segments: false,
  dailyCallsPerMailbox: 200,
  provider: "workers-ai",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  available: true,
  today: {
    day: "2026-10-17",
    byFeature: [
      { feature: "summary", calls: 12, inputTokens: 18400, outputTokens: 2100, neurons: 1880 },
      { feature: "draft", calls: 3, inputTokens: 5200, outputTokens: 940, neurons: 610 },
    ],
  },
}

const refused = (reason: string, message: string): MailAnswer => ({
  status: 409,
  body: { _tag: "AssistantRefused", reason, message, requestId: "req_fixture01JAFD4Q" },
})

/** Runs another fixture route, as the page would reach it. */
const route = async (
  list: readonly MailOverride[],
  method: string,
  path: string,
  body: unknown = null,
): Promise<MailAnswer | undefined> => {
  for (const o of list) {
    if (o.method !== method) continue
    const m = path.match(o.path)
    if (m) return o.answer(m, body, new URL(`https://fixtures.local${path}`))
  }
  return undefined
}

const threadOf = async (id: string, threadId: string) => {
  const r = await route(CORE_OVERRIDES, "GET", `/v1/mailboxes/${id}/threads/${threadId}`)
  return r && r.status === 200 ? (r.body as ThreadDetail) : undefined
}

export const ASSISTANT_OVERRIDES: readonly MailOverride[] = [
  // GET/PUT /v1/settings/assistant are answered by settings/fixtures.ts, one shared state for every page.
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/([^/]+)\/threads\/([^/]+)\/summary$/,
    answer: async ([, id = "", threadId = ""], body) => {
      if (threadId === "thr_broken") return refused("cap", "This mailbox has used today's summaries.")
      const d = await threadOf(id, threadId)
      if (!d) return { status: 404, body: { _tag: "NotFound", message: `No thread ${threadId}` } }
      const people = [...new Set(d.messages.map((m) => m.from?.name ?? m.from?.address ?? "someone"))]
      const last = d.messages[d.messages.length - 1]
      const refresh = Boolean((body as { refresh?: boolean } | null)?.refresh)
      return {
        status: 200,
        body: {
          summary: `${people.slice(0, 3).join(", ")} on “${d.thread.subject}”: ${d.messages.length} message${d.messages.length === 1 ? "" : "s"}, the latest from ${last?.from?.name ?? last?.from?.address ?? "someone"}.`,
          bullets: d.messages
            .slice(-3)
            .map((m) => (m.snippet ?? "").slice(0, 120))
            .filter(Boolean),
          version: `${last?.id ?? "none"}:${d.messages.length}`,
          cached: !refresh,
          model: ASSISTANT_SETTINGS.model,
          generatedAt: refresh ? NOW : NOW - 40 * 60_000,
        },
      }
    },
  },
  {
    method: "POST",
    path: /^\/v1\/mailboxes\/([^/]+)\/threads\/([^/]+)\/draft$/,
    answer: async ([, id = "", threadId = ""]) => {
      if (threadId === "thr_broken") return refused("cap", "This mailbox has used today's drafted replies.")
      const d = await threadOf(id, threadId)
      const last = d?.messages[d.messages.length - 1]
      if (!last) return { status: 404, body: { _tag: "NotFound", message: `No thread ${threadId}` } }
      const made = await route(COMPOSE_OVERRIDES, "POST", `/v1/mailboxes/${id}/drafts`, {
        replyTo: { messageId: last.id, mode: "reply" },
        bodyText: `Hi ${last.from?.name?.split(" ")[0] ?? "there"},\n\nThanks for getting in touch. I’ve looked into this and will follow up shortly with the details.\n`,
      })
      if (!made || made.status !== 200) return made
      return { status: 200, body: { draft: made.body, model: ASSISTANT_SETTINGS.model } }
    },
  },
]

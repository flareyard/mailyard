import { and, asc, desc, eq, gte, isNull, like, lt, or } from "drizzle-orm"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { campaigns, contacts, domains, templates } from "../db/schema.ts"
import { callMailbox } from "../mail/rpc.ts"
import type { SearchUnderstanding } from "../mailbox/search.ts"
import type { SearchHit, ThreadSummary } from "../mailbox/types.ts"
import { Database } from "../services/Database.ts"
import type { Caller } from "./apiKeys.ts"
import { readableMailboxes } from "./overview.ts"

/**
 * Search across the workspace (HAL-3363): the command palette (`/v1/search`) and "search all mail"
 * (`/v1/search/mail`). Only what the caller can read: mail from the mailboxes it's a member of
 * (every mailbox for root and admin keys), the rest with the read scope. Each mailbox searches its own
 * full-text index in its Durable Object, all at once, within a time budget; one that doesn't answer
 * in time is listed as partial rather than holding the others up.
 */

export const RESULT_TYPES = ["thread", "contact", "campaign", "template", "mailbox", "domain"] as const
export type ResultType = (typeof RESULT_TYPES)[number]

/** How long each mailbox has to answer a search. */
const MAILBOX_BUDGET = Duration.millis(2_500)

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** The prefix range of an indexed text column: `col >= q AND col < q + max`, which an index serves. */
const prefixRange = (column: typeof contacts.email, q: string) => and(gte(column, q), lt(column, `${q}￿`))

type MailboxSearch = {
  hits: ReadonlyArray<SearchHit>
  threads: ReadonlyArray<ThreadSummary>
  parsed: SearchUnderstanding
}

export const searchMail = Effect.fn("search.mail")(function* (
  caller: Caller,
  q: string,
  options: { readonly limit?: number | undefined; readonly sort?: "recent" | "relevance" | undefined } = {},
) {
  const list = yield* readableMailboxes(caller)
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  const answers = yield* Effect.forEach(
    list,
    (m) =>
      callMailbox(
        m.id,
        (s) => s.search(q, { limit, sort: options.sort ?? "recent" }) as Promise<MailboxSearch>,
      ).pipe(
        Effect.timeoutOption(MAILBOX_BUDGET),
        Effect.map((r) => ({ mailbox: m, result: Option.getOrNull(r), timedOut: Option.isNone(r) })),
        Effect.catchCause((cause) =>
          Effect.logWarning(`search: mailbox ${m.id} failed`, cause).pipe(
            Effect.as({ mailbox: m, result: null as MailboxSearch | null, timedOut: false }),
          ),
        ),
      ),
    { concurrency: 10 },
  )
  const groups = answers
    .filter((a) => a.result && a.result.hits.length > 0)
    .map((a) => ({
      mailboxId: a.mailbox.id,
      address: a.mailbox.address,
      hits: (a.result as MailboxSearch).hits,
      threads: (a.result as MailboxSearch).threads,
    }))
  return {
    query: q,
    parsed: answers.find((a) => a.result)?.result?.parsed ?? null,
    groups,
    searched: answers.filter((a) => a.result).length,
    /** Mailboxes that didn't answer within the budget, or failed: their results are missing. */
    partial: answers
      .filter((a) => !a.result)
      .map((a) => ({
        mailboxId: a.mailbox.id,
        reason: a.timedOut ? ("timeout" as const) : ("error" as const),
      })),
  }
})

/** One line in the command palette. `url` is the web app's route for it. */
type Result = {
  type: ResultType
  id: string
  title: string
  subtitle: string | null
  url: string
  mailboxId?: string
}

export const searchWorkspace = Effect.fn("search.workspace")(function* (
  caller: Caller,
  input: {
    readonly q: string
    readonly types?: ReadonlyArray<ResultType> | undefined
    readonly limit?: number | undefined
  },
) {
  const q = input.q.trim()
  const want = new Set(input.types?.length ? input.types : RESULT_TYPES)
  const per = Math.min(Math.max(input.limit ?? 5, 1), 20)
  type Partial = { mailboxId: string; reason: "timeout" | "error" }
  if (!q) return { query: q, results: [] as Array<Result>, partial: [] as Array<Partial> }
  const lower = q.toLowerCase()
  const pattern = `%${escapeLike(lower)}%`
  const database = yield* Database
  const results: Array<Result> = []
  const readable = yield* readableMailboxes(caller)
  const canReadWorkspace =
    caller.keyId === "root" || caller.scopes.includes("read") || caller.scopes.includes("admin")

  if (want.has("mailbox")) {
    for (const m of readable.filter((x) => x.address.includes(lower)).slice(0, per))
      results.push({ type: "mailbox", id: m.id, title: m.address, subtitle: m.kind, url: `/mail/${m.id}` })
  }
  if (canReadWorkspace && want.has("contact")) {
    // Emails are stored lowercase and uniquely indexed: a prefix is a range on that index.
    const rows = yield* database.query("search.contacts", (db) =>
      db
        .select({ id: contacts.id, email: contacts.email, name: contacts.name, status: contacts.status })
        .from(contacts)
        .where(prefixRange(contacts.email, lower))
        .orderBy(asc(contacts.email))
        .limit(per)
        .all(),
    )
    for (const c of rows)
      results.push({
        type: "contact",
        id: c.id,
        title: c.name ?? c.email,
        subtitle: c.name ? c.email : c.status,
        url: `/audience/contacts/${c.id}`,
      })
  }
  if (canReadWorkspace && want.has("campaign")) {
    const rows = yield* database.query("search.campaigns", (db) =>
      db
        .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
        .from(campaigns)
        .where(like(campaigns.name, pattern))
        .orderBy(desc(campaigns.id))
        .limit(per)
        .all(),
    )
    for (const c of rows)
      results.push({
        type: "campaign",
        id: c.id,
        title: c.name,
        subtitle: c.status,
        url: `/campaigns/${c.id}`,
      })
  }
  if (canReadWorkspace && want.has("template")) {
    const rows = yield* database.query("search.templates", (db) =>
      db
        .select({ id: templates.id, name: templates.name })
        .from(templates)
        .where(and(like(templates.name, pattern), isNull(templates.archivedAt)))
        .orderBy(desc(templates.id))
        .limit(per)
        .all(),
    )
    for (const t of rows)
      results.push({
        type: "template",
        id: t.id,
        title: t.name,
        subtitle: null,
        url: `/transactional/templates/${t.id}`,
      })
  }
  if (canReadWorkspace && want.has("domain")) {
    const rows = yield* database.query("search.domains", (db) =>
      db
        .select({
          id: domains.id,
          name: domains.name,
          sending: domains.sendingEnabled,
          receiving: domains.routingEnabled,
        })
        .from(domains)
        .where(or(like(domains.name, pattern), eq(domains.id, q)))
        .orderBy(asc(domains.name))
        .limit(per)
        .all(),
    )
    for (const d of rows)
      results.push({
        type: "domain",
        id: d.id,
        title: d.name,
        subtitle:
          [d.receiving ? "receiving" : null, d.sending ? "sending" : null].filter(Boolean).join(" and ") ||
          "set up",
        url: `/domains/${d.id}`,
      })
  }
  let partial: Array<Partial> = []
  if (want.has("thread") && readable.length > 0) {
    const mail = yield* searchMail(caller, q, { limit: per })
    partial = mail.partial
    const threads = mail.groups.flatMap((g) =>
      g.threads.map((t) => ({ t, mailboxId: g.mailboxId, address: g.address })),
    )
    threads.sort((a, b) => b.t.sortAt - a.t.sortAt)
    for (const { t, mailboxId, address } of threads.slice(0, per))
      results.push({
        type: "thread",
        id: t.id,
        title: t.subject || "(no subject)",
        subtitle: `${t.participants[0]?.name ?? t.participants[0]?.address ?? ""} · ${address}`,
        url: `/mail/${mailboxId}/threads/${t.id}`,
        mailboxId,
      })
  }
  return { query: q, results, partial }
})

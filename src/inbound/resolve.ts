import { and, eq, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { domains, mailboxes } from "../db/schema.ts"
import { Database, queryIn } from "../services/Database.ts"
import { parseRecipient } from "./address.ts"

type MailboxRow = typeof mailboxes.$inferSelect

/** A mailbox kind that holds mail itself, as opposed to one that only points elsewhere. */
const HOLDS_MAIL = new Set<MailboxRow["kind"]>(["user", "shared", "catch_all"])

/** Aliases of groups of aliases stop expanding here; real setups are one or two levels deep. */
export const MAX_EXPANSION_DEPTH = 8

export interface Resolution {
  /** How the address matched: its own mailbox, an alias or group, or the domain's catch-all. */
  readonly via: "mailbox" | "alias" | "group" | "catch_all"
  /** The mailbox row the address matched before expansion. */
  readonly matched: { readonly id: string; readonly address: string }
  /**
   * The `+tag` of a subaddressed recipient, kept so rules and the UI can use it. Null when the address
   * matched a mailbox exactly; kept when it fell through to the catch-all.
   */
  readonly tag: string | null
  /** Every mailbox the message is filed into, deduplicated, in expansion order. */
  readonly mailboxIds: ReadonlyArray<string>
}

/** The message has nowhere to go. The handler bounces it at the door with `reason` as the SMTP text. */
export class Unroutable extends Schema.TaggedError<Unroutable>()("Unroutable", {
  code: Schema.Literals(["invalid_address", "unknown_domain", "unknown_address", "no_targets"]),
  reason: Schema.String,
}) {}

const expand = Effect.fn("inbound.expand")(function* (start: MailboxRow) {
  const delivered: Array<string> = []
  const seen = new Set<string>([start.id])
  let frontier: Array<MailboxRow> = [start]
  for (let depth = 0; frontier.length > 0 && depth <= MAX_EXPANSION_DEPTH; depth++) {
    const next: Array<string> = []
    for (const row of frontier) {
      if (HOLDS_MAIL.has(row.kind)) {
        delivered.push(row.id)
        continue
      }
      for (const target of row.targets ?? []) {
        if (seen.has(target)) continue
        seen.add(target)
        next.push(target)
      }
    }
    if (next.length === 0) break
    const rows = yield* queryIn("inbound.expandTargets", next, (db, chunk) =>
      db.select().from(mailboxes).where(inArray(mailboxes.id, chunk)).all(),
    )
    // Keep the order the targets were listed in, and skip ids that no longer exist.
    const byId = new Map(rows.map((r) => [r.id, r]))
    frontier = next.flatMap((id) => byId.get(id) ?? [])
  }
  return delivered
})

/**
 * Resolves one envelope recipient. An exact address wins over its subaddress base, so a mailbox
 * literally named `a+b@` still gets its mail; otherwise `user+tag@` goes to `user@` with the tag kept.
 * An unknown address goes to the domain's catch-all mailbox when its policy is `keep`.
 */
export const resolveRecipient = Effect.fn("inbound.resolve")(function* (envelopeTo: string) {
  const recipient = parseRecipient(envelopeTo)
  if (!recipient) {
    return yield* new Unroutable({
      code: "invalid_address",
      reason: `Invalid recipient address ${envelopeTo}`,
    })
  }
  const database = yield* Database
  const domain = yield* database.query("inbound.domain", (db) =>
    db.select().from(domains).where(eq(domains.name, recipient.domain)).get(),
  )
  if (!domain) {
    return yield* new Unroutable({
      code: "unknown_domain",
      reason: `This server does not accept mail for ${recipient.domain}`,
    })
  }
  const candidates = yield* database.query("inbound.mailbox", (db) =>
    db
      .select()
      .from(mailboxes)
      // d1: bounded: an address and its base, two values.
      .where(inArray(mailboxes.address, [...new Set([recipient.address, recipient.base])]))
      .all(),
  )
  const exact = candidates.find((m) => m.address === recipient.address)
  const base = candidates.find((m) => m.address === recipient.base)
  let matched = exact ?? base
  let via: Resolution["via"] | undefined
  if (matched) {
    via = matched.kind === "alias" ? "alias" : matched.kind === "group" ? "group" : "mailbox"
  } else if (domain.catchAll === "keep") {
    matched = yield* database.query("inbound.catchAll", (db) =>
      db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.kind, "catch_all")))
        .get(),
    )
    via = "catch_all"
  }
  if (!matched || !via) {
    return yield* new Unroutable({
      code: "unknown_address",
      reason: `No mailbox here for ${recipient.address}`,
    })
  }
  const mailboxIds = yield* expand(matched)
  if (mailboxIds.length === 0) {
    return yield* new Unroutable({
      code: "no_targets",
      reason: `${recipient.address} does not deliver to any mailbox`,
    })
  }
  return {
    via,
    matched: { id: matched.id, address: matched.address },
    tag: exact ? null : recipient.tag,
    mailboxIds,
  } satisfies Resolution
})

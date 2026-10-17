import { runInDurableObject } from "cloudflare:test"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { MailboxStore } from "../../src/mailbox/store.ts"
import type { Folder } from "../../src/mailbox/types.ts"
import type { MailboxDO } from "../../src/objects/MailboxDO.ts"
import { delivery, freshMailbox } from "./deliveries.ts"

/**
 * HAL-3394: folder counts are kept on write. Whatever happens to a mailbox's messages (arrivals that
 * thread and merge, moves, read and unread, snoozes, purges, rethreading), the kept counts must equal
 * a recount from the messages.
 */

const FOLDERS: ReadonlyArray<Folder> = ["inbox", "archive", "sent", "trash", "spam"]

type Op =
  | { kind: "deliver"; replyTo: number | null; folder: Folder; seen: boolean }
  | { kind: "move"; target: number; folder: Folder }
  | { kind: "seen"; target: number; seen: boolean }
  | { kind: "moveThread"; target: number; folder: Folder }
  | { kind: "snooze"; target: number }
  | { kind: "unsnooze"; target: number }
  | { kind: "purge"; target: number }
  | { kind: "rethread"; target: number; to: number }

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("deliver" as const),
      replyTo: fc.option(fc.nat(30), { nil: null }),
      folder: fc.constantFrom(...FOLDERS),
      seen: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      target: fc.nat(30),
      folder: fc.constantFrom(...FOLDERS),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("seen" as const), target: fc.nat(30), seen: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("moveThread" as const),
      target: fc.nat(30),
      folder: fc.constantFrom(...FOLDERS),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("snooze" as const), target: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unsnooze" as const), target: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("purge" as const), target: fc.nat(30) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("rethread" as const), target: fc.nat(30), to: fc.nat(30) }),
  },
)

const kept = (store: MailboxStore) =>
  store
    .folderCounts()
    .filter((c) => c.folder !== "drafts")
    .map((c) => ({ folder: c.folder, threads: c.threads, unread: c.unreadThreads }))
    .filter((c) => c.threads > 0 || c.unread > 0)
    .sort((a, b) => a.folder.localeCompare(b.folder))

describe("kept folder counts", () => {
  it("always equal a recount from the messages", async () => {
    await runInDurableObject(freshMailbox(), (_i: MailboxDO, state) => {
      let clock = 1_000_000
      const store = new MailboxStore(
        state.storage.sql,
        (fn) => state.storage.transactionSync(fn),
        () => clock,
      )
      store.migrate()
      let n = 0
      fc.assert(
        fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
          // Each run starts from an empty mailbox.
          for (const m of store.messages({ limit: 200 }).messages) store.purge([m.id])
          const ids: Array<string> = []
          const msgIds: Array<string> = []
          const pick = (i: number) => (ids.length ? ids[i % ids.length] : undefined)
          for (const o of ops) {
            clock += 60_000
            try {
              if (o.kind === "deliver") {
                const parent =
                  o.replyTo !== null && msgIds.length ? msgIds[o.replyTo % msgIds.length] : undefined
                const messageId = `<p${++n}@x>`
                const d = delivery({
                  messageId,
                  inReplyTo: parent ?? null,
                  references: parent ? [parent] : [],
                  subject: parent ? "Re: Thing" : `Thing ${n}`,
                  receivedAt: clock,
                })
                store.deliver(d, { folder: o.folder, seen: o.seen })
                ids.push(d.id)
                msgIds.push(messageId)
              } else if (o.kind === "move") {
                const id = pick(o.target)
                if (id) store.updateMessages([id], { folder: o.folder })
              } else if (o.kind === "seen") {
                const id = pick(o.target)
                if (id) store.updateMessages([id], { seen: o.seen })
              } else if (o.kind === "moveThread") {
                const id = pick(o.target)
                const thread = id ? store.message(id)?.threadId : undefined
                if (thread) store.updateThreads([thread], { folder: o.folder })
              } else if (o.kind === "snooze") {
                const id = pick(o.target)
                const thread = id ? store.message(id)?.threadId : undefined
                if (thread) store.snooze(thread, clock + 3_600_000)
              } else if (o.kind === "unsnooze") {
                const id = pick(o.target)
                const thread = id ? store.message(id)?.threadId : undefined
                if (thread) store.unsnooze(thread)
              } else if (o.kind === "purge") {
                const id = pick(o.target)
                if (id) {
                  store.purge([id])
                  ids.splice(ids.indexOf(id), 1)
                }
              } else if (o.kind === "rethread") {
                const id = pick(o.target)
                const to = msgIds.length ? msgIds[o.to % msgIds.length] : undefined
                if (id && to) store.setMessageId(id, `${to.slice(0, -1)}-copy>`)
              }
            } catch {
              // A refusal (an invalid move, a snooze of nothing) changes nothing; the counts must still hold.
            }
            expect(kept(store)).toEqual(store.recountFolders().filter((c) => c.threads > 0 || c.unread > 0))
            // All mail (HAL-3405): threads with a message outside spam and trash, kept the same way.
            const all = state.storage.sql
              .exec<{ threads: number; unread: number }>(
                `SELECT count(*) AS threads, coalesce(sum(u), 0) AS unread FROM (
                   SELECT thread_id, max(seen = 0) AS u FROM messages WHERE folder NOT IN ('spam', 'trash') GROUP BY thread_id)`,
              )
              .one()
            expect(store.views(null).all).toEqual({
              threads: Number(all.threads),
              unreadThreads: Number(all.unread),
            })
          }
        }),
        { numRuns: 60 },
      )
    })
  })

  it("reads one row per folder, however big the mailbox", async () => {
    await runInDurableObject(freshMailbox(), (_i: MailboxDO, state) => {
      const store = new MailboxStore(state.storage.sql, (fn) => state.storage.transactionSync(fn))
      store.migrate()
      for (let i = 0; i < 2000; i++)
        store.deliver(
          delivery({ messageId: `<bulk${i}@x>`, subject: `Bulk ${i}`, receivedAt: 1000 + i }),
          i % 3 ? "inbox" : "archive",
        )
      const kept = state.storage.sql.exec("SELECT folder, threads, unread FROM folder_counts")
      kept.toArray()
      const recount = state.storage.sql.exec(
        "SELECT folder, count(DISTINCT thread_id), count(DISTINCT CASE WHEN seen = 0 THEN thread_id END) FROM messages GROUP BY folder",
      )
      recount.toArray()
      console.log(`rows read: kept counts ${kept.rowsRead}, recount ${recount.rowsRead} (2,000 messages)`)
      expect(kept.rowsRead).toBeLessThanOrEqual(8)
      expect(recount.rowsRead).toBeGreaterThanOrEqual(2000)
      expect(store.folderCounts().find((c) => c.folder === "inbox")?.threads).toBe(1333)
    })
  })

  it("rebuilds from the messages, for a migration or a repair", async () => {
    await runInDurableObject(freshMailbox(), (_i: MailboxDO, state) => {
      const store = new MailboxStore(state.storage.sql, (fn) => state.storage.transactionSync(fn))
      store.migrate()
      store.deliver(delivery({ messageId: "<r1@x>", receivedAt: 1 }))
      store.deliver(delivery({ messageId: "<r2@x>", receivedAt: 2 }), { folder: "archive", seen: true })
      state.storage.sql.exec("UPDATE folder_counts SET threads = 99")
      store.rebuildFolderCounts()
      expect(kept(store)).toEqual(store.recountFolders())
    })
  })
})

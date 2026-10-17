import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { handleEmail } from "../src/workers/inbound.ts"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"
import { delivery, freshMailbox } from "./mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)

describe("a mailbox's attention and response times (store)", () => {
  it("counts unread, waiting, snoozed and assigned through its indexes", async () => {
    const box = freshMailbox()
    const now = Date.now()
    // a: received two days ago, never answered.
    const a = await box.deliver(
      delivery({ messageId: "<a@x>", subject: "Invoice", receivedAt: now - 48 * HOUR }),
    )
    // b: received 30 hours ago, answered an hour later.
    await box.deliver(delivery({ messageId: "<b@x>", subject: "Question", receivedAt: now - 30 * HOUR }))
    await box.deliver(
      delivery({
        messageId: "<b-reply@us>",
        inReplyTo: "<b@x>",
        references: ["<b@x>"],
        subject: "Re: Question",
        from: { name: "Sam", address: "sam@acme.test" },
        receivedAt: now - 29 * HOUR,
      }),
      "sent",
    )
    // c: an hour old, within the reply target.
    const c = await box.deliver(delivery({ messageId: "<c@x>", subject: "Hi", receivedAt: now - HOUR }))

    const ask = () => box.attention({ olderThan: now - 24 * HOUR, until: now + DAY, assignee: "key_me" })
    expect(await ask()).toMatchObject({ unread: 3, waitingForReply: 1, snoozedReturning: 0, assignedToMe: 0 })
    expect((await ask()).oldestWaitingAt).toBe(now - 48 * HOUR)

    const threadOf = async (r: unknown) => (r as { threadId: string }).threadId
    await box.assign([await threadOf(c)], "key_me")
    await box.snooze(await threadOf(a), now + HOUR)
    // Snoozed out of the inbox: no longer waiting or unread there, but coming back today.
    expect(await ask()).toMatchObject({ unread: 2, waitingForReply: 0, snoozedReturning: 1, assignedToMe: 1 })

    const times = await box.responseTimes({ from: now - 3 * DAY, to: now })
    const unassigned = times.find((t) => t.assignee === null)
    expect(unassigned).toMatchObject({ threads: 2, answered: 1, firstResponseMedianMs: HOUR })
    expect(times.find((t) => t.assignee === "key_me")).toMatchObject({
      threads: 1,
      answered: 0,
      firstResponseMedianMs: null,
    })
  })
})

describe("the Overview endpoints", () => {
  const setup = async () => {
    const domain = `ov-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const box = await json<{ id: string; address: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `team@${domain}`, kind: "shared" },
      }),
    )
    return { domain, box }
  }
  const receive = async (to: string, from: string, subject: string) => {
    const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello.\r\n`
    const bytes = new TextEncoder().encode(raw)
    const outcome = await handleEmail(
      {
        from,
        to,
        headers: new Headers(),
        raw: new Blob([bytes]).stream(),
        rawSize: bytes.byteLength,
        canBeForwarded: true,
        setReject: () => {},
        forward: async () => {},
        reply: async () => {},
      } as unknown as ForwardableEmailMessage,
      env,
    )
    if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
    return outcome.id
  }

  it("GET /v1/mail/attention adds up the caller's mailboxes", async () => {
    const { box } = await setup()
    await receive(box.address, "ada@example.org", "One")
    await receive(box.address, "grace@example.org", "Two")
    const res = await call("/v1/mail/attention?replyTargetHours=2", { key: ADMIN })
    expect(res.status).toBe(200)
    const body = await json<{
      replyTargetHours: number
      unread: Array<{ mailboxId: string; count: number }>
      mailboxes: Array<{ mailboxId: string; unread: number; waitingForReply: number }>
      unavailable: Array<string>
    }>(res)
    expect(body.replyTargetHours).toBe(2)
    expect(body.unread.find((u) => u.mailboxId === box.id)?.count).toBe(2)
    expect(body.mailboxes.find((m) => m.mailboxId === box.id)).toMatchObject({
      unread: 2,
      waitingForReply: 0,
    })
    expect(body.unavailable).toEqual([])

    // A key that's a member of nothing sees nothing.
    const outsider = await json<{ key: string }>(
      await call("/v1/api-keys", {
        method: "POST",
        key: ADMIN,
        json: { name: "outsider", kind: "secret", scopes: ["read"] },
      }),
    )
    const theirs = await json<{ mailboxes: Array<unknown> }>(
      await call("/v1/mail/attention", { key: outsider.key }),
    )
    expect(theirs.mailboxes).toEqual([])

    const times = await json<{
      mailboxes: Array<{ mailboxId: string; assignees: Array<{ threads: number }> }>
    }>(await call("/v1/stats/response-times?range=7d", { key: ADMIN }))
    expect(times.mailboxes.find((m) => m.mailboxId === box.id)?.assignees[0]).toMatchObject({ threads: 2 })
  })

  it("GET /v1/stats/inbound counts today live and stores closed days once", async () => {
    const { box } = await setup()
    const sender = `sender-${uid()}@example.org`
    await receive(box.address, sender, "Live one")
    // A closed day, two days ago: three messages to the box, one of them spam, one rejected at the door.
    const old = Date.now() - 2 * DAY
    const day = dayKey(old)
    for (const [i, folder] of ["inbox", "inbox", "spam"].entries()) {
      const id = `inb_old_${uid()}${i}`
      await env.DB.prepare(
        "insert into inbound_messages (id, sha256, raw_key, size, envelope_from, envelope_to, from_address, status, received_at) values (?, ?, 'k', 10, ?, ?, ?, 'filed', ?)",
      )
        .bind(id, id, sender, box.address, sender, old)
        .run()
      await env.DB.prepare(
        "insert into inbound_deliveries (inbound_id, mailbox_id, folder, at) values (?, ?, ?, ?)",
      )
        .bind(id, box.id, folder, old)
        .run()
    }
    await env.DB.prepare(
      "insert into inbound_messages (id, sha256, raw_key, size, envelope_from, envelope_to, status, received_at) values (?, ?, 'k', 10, 'x@y.z', 'nobody@nowhere.test', 'rejected', ?)",
    )
      .bind(`inb_rej_${uid()}`, uid(), old)
      .run()

    type Inbound = {
      received: number
      rejected: { total: number; dmarcFail: number | null }
      spam: number
      byMailbox: Array<{ mailboxId: string; received: number; spam: number; address: string | null }>
      days: Array<{ day: string; received: number }>
      topSenders: Array<{ address: string; received: number }>
    }
    const first = await json<Inbound>(await call("/v1/stats/inbound?range=7d", { key: ADMIN }))
    const mine = first.byMailbox.find((m) => m.mailboxId === box.id)
    expect(mine).toMatchObject({ received: 4, spam: 1, address: box.address })
    expect(first.rejected.total).toBeGreaterThanOrEqual(1)
    expect(first.rejected.dmarcFail).toBeNull()
    expect(first.days).toHaveLength(7)
    expect(first.topSenders.find((s) => s.address === sender)?.received).toBe(4)
    const stored = await env.DB.prepare("select * from inbound_daily where day = ? and mailbox_id = ?")
      .bind(day, box.id)
      .first()
    expect(stored).toMatchObject({ received: 3, spam: 1 })

    // The closed day is read from the store now: changing its source rows changes nothing.
    await env.DB.prepare("delete from inbound_deliveries where mailbox_id = ? and at = ?")
      .bind(box.id, old)
      .run()
    const again = await json<Inbound>(await call("/v1/stats/inbound?range=7d", { key: ADMIN }))
    expect(again.byMailbox.find((m) => m.mailboxId === box.id)?.received).toBe(4)

    // 24h is a live window.
    const recent = await json<Inbound>(await call("/v1/stats/inbound?range=24h", { key: ADMIN }))
    expect(recent.byMailbox.find((m) => m.mailboxId === box.id)?.received).toBe(1)
  })

  it("GET /v1/stats/audience reads the snapshot and counts the range", async () => {
    const tag = uid()
    for (const status of ["subscribed", "subscribed", "unsubscribed", "bounced"])
      await env.DB.prepare("insert into contacts (id, email, status) values (?, ?, ?)")
        .bind(`con_${uid()}${uid()}`, `${tag}-${uid()}@example.net`, status)
        .run()
    const body = await json<{
      asOf: number
      total: number
      byStatus: Record<string, number>
      new: number
      totalByDay: Array<{ day: string; total: number | null }>
    }>(await call("/v1/stats/audience?range=7d", { key: ADMIN }))
    expect(body.byStatus.subscribed).toBeGreaterThanOrEqual(2)
    expect(body.total).toBe(Object.values(body.byStatus).reduce((a, b) => a + b, 0))
    expect(body.new).toBeGreaterThanOrEqual(4)
    expect(body.totalByDay).toHaveLength(7)
    expect(body.totalByDay.at(-1)?.total).toBe(body.total)
    // The snapshot is reused: a contact added now shows after the next snapshot, not this read.
    await env.DB.prepare("insert into contacts (id, email, status) values (?, ?, 'subscribed')")
      .bind(`con_${uid()}${uid()}`, `${tag}-late@example.net`)
      .run()
    const again = await json<{ asOf: number; total: number }>(
      await call("/v1/stats/audience", { key: ADMIN }),
    )
    expect(again).toMatchObject({ asOf: body.asOf, total: body.total })
  })

  it("GET /v1/activity merges the audit log, alerts and delivery trouble, newest first, in pages", async () => {
    const name = `feed-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name } })
    const contactId = `con_${uid()}${uid()}`
    await env.DB.prepare("insert into contacts (id, email, status) values (?, ?, 'bounced')")
      .bind(contactId, `${uid()}@bounce.test`)
      .run()
    await env.DB.prepare("insert into events (id, contact_id, name, at) values (?, ?, 'email.bounced', ?)")
      .bind(`evt_${uid()}`, contactId, Date.now() + 5)
      .run()
    type Feed = {
      events: Array<{
        id: string
        kind: string
        text: string
        at: number
        actor: { name: string | null } | null
      }>
      nextCursor: string | null
    }
    const page = await json<Feed>(await call("/v1/activity?limit=5", { key: ADMIN }))
    expect(page.events.length).toBeLessThanOrEqual(5)
    const ats = page.events.map((e) => e.at)
    expect([...ats].sort((x, y) => y - x)).toEqual(ats)
    expect(page.events[0]?.kind).toBe("email.bounced")
    const created = page.events.find((e) => e.kind === "audit.domain.created" && e.text.includes(name))
    expect(created?.text).toBe(`Domain "${name}" created`)
    expect(created?.actor?.name).toBe("Admin key")

    // Pages don't repeat or skip.
    const seen = new Set(page.events.map((e) => e.id))
    let cursor = page.nextCursor
    for (let i = 0; i < 3 && cursor; i++) {
      const next: Feed = await json<Feed>(
        await call(`/v1/activity?limit=5&cursor=${encodeURIComponent(cursor)}`, { key: ADMIN }),
      )
      for (const e of next.events) {
        expect(seen.has(e.id)).toBe(false)
        seen.add(e.id)
      }
      cursor = next.nextCursor
    }
  })

  it("reads rows bounded by the answer, not the table", async () => {
    // 2,000 old inbound rows, then today's few: the live part of the stats reads only today's.
    const old = Date.now() - 20 * DAY
    const statements = Array.from({ length: 2000 }, (_, i) =>
      env.DB.prepare(
        "insert into inbound_messages (id, sha256, raw_key, size, envelope_from, envelope_to, status, received_at) values (?, ?, 'k', 1, 'a@b.c', 'x@y.z', 'filed', ?)",
      ).bind(`inb_bulk_${uid()}_${i}`, `bulk-${uid()}-${i}`, old + i),
    )
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
    const today = Date.parse(`${dayKey(Date.now())}T00:00:00Z`)
    const live = await env.DB.prepare(
      "select status, count(*) as n from inbound_messages where received_at >= ? and received_at < ? group by status",
    )
      .bind(today, Date.now() + 1)
      .run()
    const todays = await env.DB.prepare("select count(*) as n from inbound_messages where received_at >= ?")
      .bind(today)
      .first<{ n: number }>()
    // An index range read plus the grouping: a few rows per row of today, never the 2,000 old ones.
    console.log(`rows read: today's live inbound ${live.meta.rows_read} for ${todays?.n} rows today`)
    expect(live.meta.rows_read).toBeLessThanOrEqual(2 * (todays?.n ?? 0) + 5)
    expect(live.meta.rows_read).toBeLessThan(100)
    // Every statement the Overview runs is an index search, never a scan of a growing table.
    const plans: Array<[string, Array<unknown>]> = [
      [
        "select status, count(*) as n from inbound_messages where received_at >= ? and received_at < ? group by status",
        [0, 1],
      ],
      [
        "select mailbox_id, count(*) as n, sum(folder = 'spam') as spam from inbound_deliveries where at >= ? and at < ? group by mailbox_id",
        [0, 1],
      ],
      ["select count(*) as n from contacts where created_at >= ?", [0]],
      [
        "select count(distinct contact_id) as n from events where name = 'email.unsubscribed' and at >= ?",
        [0],
      ],
      ["select count(*) as n from suppressions where at >= ?", [0]],
      ["select * from alerts order by created_at desc, id desc limit 31", []],
      ["select * from inbound_daily where day in (?, ?)", ["a", "b"]],
    ]
    for (const [statement, args] of plans) {
      const plan = await env.DB.prepare(`explain query plan ${statement}`)
        .bind(...args)
        .all<{ detail: string }>()
      const details = plan.results.map((r) => r.detail).join(" | ")
      expect(details, statement).not.toMatch(
        /SCAN (inbound_messages|inbound_deliveries|contacts|events|suppressions|alerts|inbound_daily)\b(?! USING)/,
      )
      expect(details, statement).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|PRIMARY KEY/)
    }
    const feed = await env.DB.prepare("select * from audit order by at desc, id desc limit 31").run()
    expect(feed.meta.rows_read).toBeLessThanOrEqual(31 + 1)
  })
})

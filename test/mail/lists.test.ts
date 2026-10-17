import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { delivery } from "../mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

type Thread = {
  id: string
  subject: string
  assignee: string | null
  assignedTo: { id: string; name: string } | null
  scheduledSendAt: number | null
  spamScore?: number | null
}
type List = { threads: Array<Thread>; total: number | null; nextCursor: string | null }

describe("mail lists (HAL-3405)", () => {
  it("lists All mail, shows spam scores and scheduled sends, totals, views and the assignee's name", async () => {
    const domain = `lists-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const box = await json<{ id: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `sam@${domain}`, kind: "user" },
      }),
    )
    const base = `/v1/mailboxes/${box.id}`
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const inbox = await stub.deliver(
      delivery({ messageId: `<i${uid()}@x>`, subject: "Inbox one", receivedAt: 1000 }),
    )
    await stub.deliver(
      delivery({ messageId: `<a${uid()}@x>`, subject: "Archived", receivedAt: 2000 }),
      "archive",
    )
    await stub.deliver(
      delivery({
        messageId: `<s${uid()}@x>`,
        subject: "Spammy",
        receivedAt: 3000,
        spam: { score: 7.5, reasons: [] },
      }),
      "spam",
    )
    await stub.deliver(delivery({ messageId: `<t${uid()}@x>`, subject: "Binned", receivedAt: 4000 }), "trash")
    await stub.deliver(delivery({ messageId: `<st${uid()}@x>`, subject: "Starred", receivedAt: 5000 }), {
      folder: "inbox",
      starred: true,
    })

    const all = await json<List>(await call(`${base}/threads?folder=all`, { key: ADMIN }))
    expect(all.threads.map((t) => t.subject).sort()).toEqual(["Archived", "Inbox one", "Starred"])
    expect(all.total).toBe(3)
    const spam = await json<List>(await call(`${base}/threads?folder=spam`, { key: ADMIN }))
    expect(spam.threads[0]).toMatchObject({ subject: "Spammy", spamScore: 7.5 })
    expect((await json<List>(await call(`${base}/threads?folder=inbox`, { key: ADMIN }))).total).toBe(2)
    expect(
      (await json<List>(await call(`${base}/threads?folder=inbox&unread=true`, { key: ADMIN }))).total,
    ).toBeNull()

    // A scheduled reply shows on its conversation.
    const threadId = (inbox as { threadId: string }).threadId
    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: ADMIN,
        json: { threadId, to: [{ address: "ada@example.org" }], subject: "Re: Inbox one", bodyText: "Later" },
      }),
    )
    const sendAt = Date.now() + 86_400_000
    await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: ADMIN, json: { sendAt } })
    // Assigned to a named key.
    const agent = await createKey("secret", ["read"])
    await stub.assign([threadId], agent.apiKey.id)
    const listed = await json<List>(await call(`${base}/threads?folder=inbox`, { key: ADMIN }))
    const row = listed.threads.find((t) => t.id === threadId)
    expect(row).toMatchObject({ scheduledSendAt: sendAt, assignee: agent.apiKey.id })
    expect(row?.assignedTo).toEqual({ id: agent.apiKey.id, name: "secret test key" })
    const one = await json<{ thread: Thread }>(await call(`${base}/threads/${threadId}`, { key: ADMIN }))
    expect(one.thread.assignedTo?.id).toBe(agent.apiKey.id)

    const folders = await json<{
      views: {
        starred: number
        assignedToMe: number
        scheduled: number
        all: { threads: number; unreadThreads: number }
      }
    }>(await call(`${base}/folders`, { key: ADMIN }))
    expect(folders.views).toMatchObject({
      starred: 1,
      scheduled: 1,
      assignedToMe: 0,
      all: { threads: 3, unreadThreads: 3 },
    })
  })
})

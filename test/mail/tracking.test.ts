import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import worker from "../../src/workers/api.ts"
import { ADMIN, call, json } from "../helpers.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

const setup = async () => {
  const domain = `trk-mbx-${crypto.randomUUID().slice(0, 8)}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const sam = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `sam@${domain}`, kind: "user", displayName: "Sam" },
    }),
  )
  return { sam, base: `/v1/mailboxes/${sam.id}` }
}

const draftOf = async (base: string) =>
  json<{ id: string; threadId: string }>(
    await call(`${base}/drafts`, {
      method: "POST",
      key: ADMIN,
      json: {
        to: [{ address: "ada@example.org" }],
        subject: "The proposal",
        bodyText: "See https://shop.test/proposal",
        bodyHtml: '<p>See <a href="https://shop.test/proposal">the proposal</a>.</p>',
      },
    }),
  )

/** Waits out the undo window, then runs the mailbox-send queue for the draft, as the alarm would. */
const dispatch = async (mailboxId: string, draftId: string) => {
  await sleep(900)
  const batch = createMessageBatch("mailyard-mailbox-send", [
    {
      id: `ms-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body: { mailboxId, draftId, origin: "https://mailyard.test" },
    },
  ])
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  await getQueueResult(batch, ctx)
  return env.DB.prepare(
    "select id, tracked, rendered_key, mailbox_message_id from messages_out where mailbox_id = ? order by created_at desc limit 1",
  )
    .bind(mailboxId)
    .first<{ id: string; tracked: number; rendered_key: string; mailbox_message_id: string }>()
}

const renderedHtml = async (key: string) =>
  (((await (await env.STORE.get(key))?.json()) ?? {}) as { html?: string }).html ?? ""

type Detail = {
  delivery: null | {
    tracked: boolean
    opens: number
    clicks: number
    firstOpenedAt: number | null
    status: string
  }
}

describe("tracking a mailbox send, per message", () => {
  it("tracks only when asked, never instruments the sender's own copy, and shows the counts on it", async () => {
    const { sam, base } = await setup()
    const draft = await draftOf(base)
    const sent = await json<{ draft: { track: unknown } }>(
      await call(`${base}/drafts/${draft.id}/send`, {
        method: "POST",
        key: ADMIN,
        json: { track: { opens: true, clicks: true } },
      }),
    )
    expect(sent.draft.track).toEqual({ opens: true, clicks: true })
    const row = await dispatch(sam.id, draft.id)
    expect(row?.tracked).toBe(1)
    const html = await renderedHtml(row?.rendered_key ?? "")
    const pixel = /<img src="https:\/\/mailyard\.test(\/t\/o\/[^"]+)"/.exec(html)?.[1]
    const click = /href="https:\/\/mailyard\.test(\/t\/c\/[^"]+)"/.exec(html)?.[1]
    expect(pixel).toBeDefined()
    expect(click).toBeDefined()

    // The copy in Sent is what the sender wrote: no pixel, the original link.
    const copyRaw = await (
      await call(`${base}/messages/${row?.mailbox_message_id}/raw`, { key: ADMIN })
    ).text()
    expect(copyRaw).not.toContain("/t/o/")
    expect(copyRaw).toContain("https://shop.test/proposal")

    // A person opens and clicks an hour later; the sent copy shows it.
    await env.DB.prepare("update messages_out set created_at = created_at - 3600000 where id = ?")
      .bind(row?.id)
      .run()
    await call(pixel ?? "", { headers: { "user-agent": CHROME } })
    await sleep(300)
    await call(click ?? "", { headers: { "user-agent": CHROME }, redirect: "manual" })
    const detail = await json<Detail>(
      await call(`${base}/messages/${row?.mailbox_message_id}`, { key: ADMIN }),
    )
    expect(detail.delivery).toMatchObject({ tracked: true, opens: 1, clicks: 1 })
    expect(detail.delivery?.firstOpenedAt).not.toBeNull()
  })

  it("is off by default, for replies too", async () => {
    const { sam, base } = await setup()
    const draft = await draftOf(base)
    const sent = await json<{ draft: { track: unknown } }>(
      await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: ADMIN, json: {} }),
    )
    expect(sent.draft.track).toBeNull()
    const row = await dispatch(sam.id, draft.id)
    expect(row?.tracked).toBe(0)
    const html = await renderedHtml(row?.rendered_key ?? "")
    expect(html).not.toContain("/t/o/")
    expect(html).toContain('href="https://shop.test/proposal"')
    const detail = await json<Detail>(
      await call(`${base}/messages/${row?.mailbox_message_id}`, { key: ADMIN }),
    )
    expect(detail.delivery).toMatchObject({ tracked: false, opens: 0 })
  })

  it("forgets the choice when the send is undone or the draft edited", async () => {
    const { sam, base } = await setup()
    const draft = await draftOf(base)
    await call(`${base}/drafts/${draft.id}/send`, {
      method: "POST",
      key: ADMIN,
      json: { undoSeconds: 5, track: { opens: true } },
    })
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(sam.id))
    expect((await stub.draft(draft.id))?.track).toEqual({ opens: true, clicks: false })
    await call(`${base}/drafts/${draft.id}/cancel`, { method: "POST", key: ADMIN })
    expect((await stub.draft(draft.id))?.track).toBeNull()

    await call(`${base}/drafts/${draft.id}/send`, {
      method: "POST",
      key: ADMIN,
      json: { undoSeconds: 5, track: { clicks: true } },
    })
    await call(`${base}/drafts/${draft.id}/cancel`, { method: "POST", key: ADMIN })
    await call(`${base}/drafts`, { method: "POST", key: ADMIN, json: { id: draft.id, subject: "Edited" } })
    expect((await stub.draft(draft.id))?.track).toBeNull()
    // Neither box ticked means not tracked at all.
    await call(`${base}/drafts/${draft.id}/send`, {
      method: "POST",
      key: ADMIN,
      json: { track: { opens: false, clicks: false } },
    })
    expect((await stub.draft(draft.id))?.track).toBeNull()
  })
})

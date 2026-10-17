import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { HIGHLIGHT_END, HIGHLIGHT_START } from "../../src/mailbox/search.ts"
import worker from "../../src/workers/api.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import attachments from "../fixtures/eml/attachments.eml?raw"
import alternative from "../fixtures/eml/multipart-alternative.eml?raw"
import { ADMIN, call, createKey, json } from "../helpers.ts"

installDohFixture()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for the mailbox's alarm to hand a sent draft over (status "due"), however long a loaded run
 * takes; a fixed sleep made these tests flaky under the full parallel suite (HAL-3391).
 */
const untilDue = async (mailboxId: string, draftId: string, timeoutMs = 10_000) => {
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await stub.draft(draftId))?.status === "due") return
    await sleep(50)
  }
  throw new Error(`draft ${draftId} never became due`)
}
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, key: ADMIN })

let member = { key: "", id: "" }
let viewer = { key: "", id: "" }
let outsider = ""
beforeAll(async () => {
  const m = await createKey("secret", ["send", "read"])
  member = { key: m.key, id: m.apiKey.id }
  const v = await createKey("secret", ["send", "read"])
  viewer = { key: v.key, id: v.apiKey.id }
  outsider = (await createKey("secret", ["send", "read"])).key
})

/** A fresh domain with sam@ (members: `member` and `viewer`), plus an alias hi@ pointing at it. */
const setup = async () => {
  const domain = `mail-${crypto.randomUUID().slice(0, 8)}.test`
  await admin("/v1/domains", { method: "POST", json: { name: domain } })
  const sam = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", {
      method: "POST",
      json: { address: `sam@${domain}`, kind: "user", displayName: "Sam" },
    }),
  )
  await admin("/v1/mailboxes", {
    method: "POST",
    json: { address: `hi@${domain}`, kind: "alias", targets: [sam.id] },
  })
  await admin(`/v1/mailboxes/${sam.id}/members`, {
    method: "PUT",
    json: {
      members: [
        { apiKeyId: member.id, role: "member" },
        { apiKeyId: viewer.id, role: "viewer" },
      ],
    },
  })
  const base = `/v1/mailboxes/${sam.id}`
  return { domain, sam, base }
}

/** Mail arriving through Email Routing, through the real email() pipeline. */
const receive = async (raw: string, to: string) => {
  const bytes = new TextEncoder().encode(raw)
  const message = {
    from: "bounce@example.org",
    to,
    headers: new Headers(),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    setReject: () => {},
    forward: async () => {
      throw new Error("unused")
    },
    reply: async () => {
      throw new Error("unused")
    },
  } as unknown as ForwardableEmailMessage
  const outcome = await handleEmail(message, env)
  if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
  return outcome.id
}

const runMailboxSendQueue = async (
  jobs: ReadonlyArray<{ mailboxId: string; draftId: string; origin: string | null }>,
) => {
  const batch = createMessageBatch(
    "mailyard-mailbox-send",
    jobs.map((body, i) => ({
      id: `ms${i}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const mailboxSends = (mailboxId: string) =>
  env.DB.prepare("select * from messages_out where mailbox_id = ? order by created_at").bind(mailboxId).all<{
    id: string
    status: string
    mailbox_message_id: string
    cf_message_id: string | null
    rendered_key: string
    stream: string
  }>()

const rendered = async (key: string) =>
  (await (await env.STORE.get(key))?.json()) as {
    to: Array<{ email: string }>
    cc?: Array<{ email: string }>
    bcc?: Array<{ email: string }>
    subject: string
    text: string
    html: string
    headers?: Record<string, string>
    attachments?: Array<{ filename: string }>
  }

describe("reading mail", () => {
  it("lists folders, threads and a thread; reads a message with its body and signed links", async () => {
    const { sam, base } = await setup()
    const id = await receive(alternative, sam.address)
    const folders = await json<{
      folders: Array<{ folder: string; threads: number; unreadThreads: number }>
      labels: unknown[]
    }>(await call(`${base}/folders`, { key: member.key }))
    expect(folders.folders.find((f) => f.folder === "inbox")).toEqual({
      folder: "inbox",
      threads: 1,
      unreadThreads: 1,
    })

    const list = await json<{
      threads: Array<{ id: string; subject: string; unreadCount: number }>
      nextCursor: string | null
    }>(await call(`${base}/threads?folder=inbox&unread=true`, { key: viewer.key }))
    expect(list.threads.map((t) => t.subject)).toEqual(["Re: Engine design notes"])
    const threadId = list.threads[0]?.id ?? ""
    const thread = await json<{
      thread: { id: string }
      messages: Array<{ id: string; from: unknown }>
      drafts: unknown[]
    }>(await call(`${base}/threads/${threadId}`, { key: viewer.key }))
    expect(thread.messages.map((m) => m.id)).toEqual([id])

    const message = await json<{
      body: { text: string; html: string | null }
      rawUrl: string
      attachmentUrls: Record<string, string>
      auth: { spf: string; dmarc: string }
    }>(await call(`${base}/messages/${id}`, { key: viewer.key }))
    expect(message.body.text).toContain("the diagrams help")
    expect(message.body.html).toContain("<blockquote>")
    expect(message.auth).toMatchObject({ spf: "pass", dmarc: "pass" })
    // The signed raw link works without a key, and not once tampered with.
    const raw = await exports.default.fetch(new Request(message.rawUrl))
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-type")).toBe("message/rfc822")
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await raw.text()).toContain("Subject: Re: Engine design notes")
    const tampered = `${message.rawUrl.slice(0, -3)}${message.rawUrl.endsWith("A") ? "B" : "A"}aa`
    expect((await exports.default.fetch(new Request(tampered))).status).toBe(403)
    expect(
      (await exports.default.fetch(new Request("https://mailyard.test/v1/files/not.a.token"))).status,
    ).toBe(403)

    // The authenticated raw route returns the same bytes.
    const direct = await call(`${base}/messages/${id}/raw`, { key: viewer.key })
    expect(direct.status).toBe(200)
    expect(await direct.text()).toContain("Message-ID: <reply-2@example.org>")
  })

  it("serves attachments through the API and through signed links", async () => {
    const { sam, base } = await setup()
    const id = await receive(attachments, `sam+invoices@${sam.address.split("@")[1]}`)
    const message = await json<{
      attachments: Array<{ id: string; filename: string }>
      attachmentUrls: Record<string, string>
    }>(await call(`${base}/messages/${id}`, { key: member.key }))
    const csv = message.attachments.find((a) => a.filename === "usage.csv")
    expect(csv).toBeDefined()
    const viaApi = await call(`${base}/messages/${id}/attachments/${csv?.id}`, { key: member.key })
    expect(viaApi.headers.get("content-disposition")).toBe(
      `attachment; filename="usage.csv"; filename*=UTF-8''usage.csv`,
    )
    expect(await viaApi.text()).toBe("name,amount\r\nAda,10\r\nGrace,20")
    const viaLink = await exports.default.fetch(new Request(message.attachmentUrls[csv?.id ?? ""] ?? ""))
    expect(await viaLink.text()).toBe("name,amount\r\nAda,10\r\nGrace,20")
    const pdf = message.attachments.find((a) => a.filename?.endsWith(".pdf"))
    const pdfResponse = await call(`${base}/messages/${id}/attachments/${pdf?.id}`, { key: member.key })
    expect(pdfResponse.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''r%C3%A9sum%C3%A9%20invoice.pdf",
    )
    expect((await call(`${base}/messages/${id}/attachments/att_missing`, { key: member.key })).status).toBe(
      404,
    )
  })

  it("searches the mailbox", async () => {
    const { sam, base } = await setup()
    await receive(alternative, sam.address)
    const result = await json<{ hits: Array<{ subject: string }>; threads: unknown[] }>(
      await call(`${base}/search?q=${encodeURIComponent("from:ada engine")}`, { key: viewer.key }),
    )
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.subject).toBe(`Re: ${HIGHLIGHT_START}Engine${HIGHLIGHT_END} design notes`)
  })

  it("keeps out keys that aren't members, and viewers out of anything that changes the mailbox", async () => {
    const { sam, base } = await setup()
    await receive(alternative, sam.address)
    expect((await call(`${base}/threads`, { key: outsider })).status).toBe(403)
    expect((await call(`${base}/messages/x/raw`, { key: outsider })).status).toBe(403)
    expect(
      (await call(`${base}/drafts`, { method: "POST", key: viewer.key, json: { subject: "x" } })).status,
    ).toBe(403)
    expect(
      (await call(`${base}/labels`, { method: "POST", key: viewer.key, json: { name: "x" } })).status,
    ).toBe(403)
    expect((await call("/v1/mailboxes/mbx_missing/threads", { key: ADMIN })).status).toBe(404)
  })
})

describe("changing mail", () => {
  it("applies every bulk action, with Gmail-like folder rules", async () => {
    const { sam, base } = await setup()
    const id = await receive(alternative, sam.address)
    const threadId =
      (await json<{ threads: Array<{ id: string }> }>(await call(`${base}/threads`, { key: member.key })))
        .threads[0]?.id ?? ""
    const bulk = (body: Record<string, unknown>, key = member.key) =>
      call(`${base}/threads/bulk`, { method: "POST", key, json: { threadIds: [threadId], ...body } })
    const thread = async () =>
      (
        await json<{
          thread: {
            folders: string[]
            unreadCount: number
            starred: boolean
            labelIds: string[]
            snoozedUntil: number | null
            assignee: string | null
          }
        }>(await call(`${base}/threads/${threadId}`, { key: member.key }))
      ).thread

    expect((await bulk({ action: "read" })).status).toBe(200)
    expect((await thread()).unreadCount).toBe(0)
    await bulk({ action: "star" })
    expect((await thread()).starred).toBe(true)
    await bulk({ action: "archive" })
    expect((await thread()).folders).toEqual(["archive"])
    await bulk({ action: "inbox" })
    await bulk({ action: "spam" })
    expect((await thread()).folders).toEqual(["spam"])
    await bulk({ action: "notSpam" })
    expect((await thread()).folders).toEqual(["inbox"])

    const label = await json<{ id: string }>(
      await call(`${base}/labels`, { method: "POST", key: member.key, json: { name: "Engines" } }),
    )
    await bulk({ action: "label", labelId: label.id })
    expect((await thread()).labelIds).toEqual([label.id])
    await bulk({ action: "unlabel", labelId: label.id })
    expect((await bulk({ action: "label" })).status).toBe(400)

    await bulk({ action: "snooze", until: Date.now() + 3_600_000 })
    expect((await thread()).folders).toEqual(["snoozed"])
    await bulk({ action: "unsnooze" })
    expect((await thread()).folders).toEqual(["inbox"])

    await bulk({ action: "assign", assignee: member.id })
    expect((await thread()).assignee).toBe(member.id)
    expect(
      (
        await json<{ threads: unknown[] }>(
          await call(`${base}/threads?assignee=${member.id}`, { key: member.key }),
        )
      ).threads,
    ).toHaveLength(1)
    expect((await bulk({ action: "assign", assignee: viewer.id })).status).toBe(403)
    await bulk({ action: "assign", assignee: viewer.id }, ADMIN)
    expect((await thread()).assignee).toBe(viewer.id)
    await bulk({ action: "assign", assignee: null })
    expect((await thread()).assignee).toBeNull()

    // Delete forever only takes what is already in the trash.
    expect(await json(await bulk({ action: "delete" }))).toEqual({ updated: 0 })
    await bulk({ action: "trash" })
    expect(await json(await bulk({ action: "delete" }))).toEqual({ updated: 1 })
    expect((await call(`${base}/messages/${id}`, { key: member.key })).status).toBe(404)
  })

  it("patches one message, manages labels, and empties the trash", async () => {
    const { sam, base } = await setup()
    const id = await receive(alternative, sam.address)
    expect(
      await json(
        await call(`${base}/messages/${id}`, {
          method: "PATCH",
          key: member.key,
          json: { seen: true, starred: true },
        }),
      ),
    ).toMatchObject({
      seen: true,
      starred: true,
    })
    const created = await call(`${base}/labels`, {
      method: "POST",
      key: member.key,
      json: { name: "Work", color: "#3366ff" },
    })
    const label = await json<{ id: string }>(created)
    expect(
      (await call(`${base}/labels`, { method: "POST", key: member.key, json: { name: "work" } })).status,
    ).toBe(409)
    expect(
      await json(
        await call(`${base}/labels/${label.id}`, {
          method: "PATCH",
          key: member.key,
          json: { name: "Office" },
        }),
      ),
    ).toMatchObject({ name: "Office" })
    expect(await json(await call(`${base}/labels`, { key: member.key }))).toMatchObject({
      labels: [{ name: "Office" }],
    })
    expect((await call(`${base}/labels/${label.id}`, { method: "DELETE", key: member.key })).status).toBe(200)
    expect((await call(`${base}/labels/${label.id}`, { method: "DELETE", key: member.key })).status).toBe(404)
    await call(`${base}/messages/${id}`, { method: "PATCH", key: member.key, json: { folder: "trash" } })
    expect(
      await json(await call(`${base}/folders/trash/empty`, { method: "POST", key: member.key })),
    ).toEqual({ purged: 1 })
    expect(
      (await call(`${base}/messages/${id}`, { method: "PATCH", key: member.key, json: { seen: true } }))
        .status,
    ).toBe(404)
  })
})

describe("composing and sending", () => {
  it("drafts a reply with the right recipients, subject, threading headers and quote", async () => {
    const { sam, base } = await setup()
    const id = await receive(alternative, sam.address)
    const draft = await json<{
      id: string
      to: Array<{ address: string }>
      cc: Array<{ address: string }>
      subject: string
      inReplyTo: string
      references: string[]
      bodyText: string
      threadId: string
      from: string
      replyMode: string
    }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { replyTo: { messageId: id, mode: "replyAll" }, bodyText: "Sounds good." },
      }),
    )
    expect(draft.from).toBe(sam.address)
    expect(draft.subject).toBe("Re: Engine design notes")
    expect(draft.inReplyTo).toBe("<reply-2@example.org>")
    expect(draft.references).toEqual(["<thread-0@acme.test>", "<note-1@acme.test>", "<reply-2@example.org>"])
    // Reply-To wins over From. The fixture's acme.test addresses aren't this mailbox, so reply-all keeps
    // them (test/mail/compose.test.ts covers leaving the mailbox's own addresses out).
    expect(draft.to.map((p) => p.address)).toEqual(["replies@example.org", "sam@acme.test", "team@acme.test"])
    expect(draft.cc.map((p) => p.address)).toEqual(["grace@example.org"])
    expect(draft.bodyText.startsWith("Sounds good.\n\nOn ")).toBe(true)
    expect(draft.bodyText).toContain("> Thanks, the diagrams help")
    expect(draft.replyMode).toBe("replyAll")
    const thread = await json<{ drafts: Array<{ id: string }> }>(
      await call(`${base}/threads/${draft.threadId}`, { key: member.key }),
    )
    expect(thread.drafts.map((d) => d.id)).toEqual([draft.id])
  })

  it("undo inside the window means nothing is sent", async () => {
    const { base, sam } = await setup()
    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { to: [{ address: "ada@example.org" }], subject: "Oops", bodyText: "Wrong" },
      }),
    )
    // A 5 s window, so the cancel can't lose a race with the alarm however loaded the machine is.
    const sent = await json<{ draft: { status: string }; undoUntil: number | null; sendAt: number }>(
      await call(`${base}/drafts/${draft.id}/send`, {
        method: "POST",
        key: member.key,
        json: { undoSeconds: 5 },
      }),
    )
    expect(sent.draft.status).toBe("scheduled")
    expect(sent.undoUntil).toBe(sent.sendAt)
    expect(sent.sendAt - Date.now()).toBeGreaterThan(3_000)
    const undone = await json<{ status: string; sendAt: number | null }>(
      await call(`${base}/drafts/${draft.id}/cancel`, { method: "POST", key: member.key }),
    )
    expect(undone).toMatchObject({ status: "draft", sendAt: null })
    const tooLong = await call(`${base}/drafts/${draft.id}/send`, {
      method: "POST",
      key: member.key,
      json: { undoSeconds: 31 },
    })
    expect(tooLong.status).toBe(400)
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(sam.id))
    expect(await stub.draft(draft.id)).toMatchObject({ status: "draft" })
    expect(await stub.alarmAt()).toBeNull()
    expect((await mailboxSends(sam.id)).results).toHaveLength(0)
  })

  it("sends a reply after the undo window: one message, threaded headers, a sent copy in the thread", async () => {
    const { sam, base } = await setup()
    const id = await receive(alternative, sam.address)
    const draft = await json<{ id: string; threadId: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: {
          replyTo: { messageId: id, mode: "reply" },
          bodyText: "Agreed.",
          bcc: [{ address: "archive@example.org" }],
        },
      }),
    )
    await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: member.key, json: {} })
    await untilDue(sam.id, draft.id)
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(sam.id))
    expect(await stub.draft(draft.id)).toMatchObject({ status: "due" })

    const result = await runMailboxSendQueue([
      { mailboxId: sam.id, draftId: draft.id, origin: "https://mailyard.test" },
    ])
    expect(result.explicitAcks).toHaveLength(1)
    const sends = (await mailboxSends(sam.id)).results
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ stream: "mailbox", status: "sent" })
    const message = await rendered(sends[0]?.rendered_key ?? "")
    expect(message.to.map((t) => t.email)).toEqual(["replies@example.org"])
    expect(message.bcc?.map((t) => t.email)).toEqual(["archive@example.org"])
    expect(message.subject).toBe("Re: Engine design notes")
    expect(message.headers).toEqual({
      "In-Reply-To": "<reply-2@example.org>",
      References: "<thread-0@acme.test> <note-1@acme.test> <reply-2@example.org>",
    })

    // The sent copy is in the same thread, in Sent, with Email Service's Message-ID; the draft is gone.
    const thread = await json<{
      messages: Array<{ id: string; folder: string; messageId: string | null }>
      drafts: unknown[]
    }>(await call(`${base}/threads/${draft.threadId}`, { key: member.key }))
    expect(thread.messages.map((m) => m.folder)).toEqual(["inbox", "sent"])
    expect(thread.messages[1]?.id).toBe(sends[0]?.mailbox_message_id)
    expect(thread.messages[1]?.messageId).toBe(sends[0]?.cf_message_id)
    expect(thread.drafts).toEqual([])
    expect(await stub.draft(draft.id)).toBeNull()
    expect((await stub.message(id))?.answered).toBe(true)
    const raw = await (
      await call(`${base}/messages/${thread.messages[1]?.id}/raw`, { key: member.key })
    ).text()
    expect(raw).toContain("In-Reply-To: <reply-2@example.org>")
    expect(raw).toContain("Bcc: archive@example.org")

    // A redelivered job is a no-op.
    await runMailboxSendQueue([{ mailboxId: sam.id, draftId: draft.id, origin: null }])
    expect((await mailboxSends(sam.id)).results).toHaveLength(1)
  })

  it("schedules a send for later and cancels it", async () => {
    const { base } = await setup()
    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { to: [{ address: "ada@example.org" }], subject: "Later" },
      }),
    )
    const sendAt = Date.now() + 86_400_000
    const scheduled = await json<{ draft: { status: string; sendAt: number }; undoUntil: number | null }>(
      await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: member.key, json: { sendAt } }),
    )
    expect(scheduled).toMatchObject({ draft: { status: "scheduled", sendAt }, undoUntil: null })
    expect(
      (
        await call(`${base}/drafts/${draft.id}/send`, {
          method: "POST",
          key: member.key,
          json: { sendAt: Date.now() - 1 },
        })
      ).status,
    ).toBe(400)
    expect(
      await json(await call(`${base}/drafts/${draft.id}/cancel`, { method: "POST", key: member.key })),
    ).toMatchObject({ status: "draft" })
    expect(await json(await call(`${base}/drafts?status=draft`, { key: member.key }))).toMatchObject({
      drafts: [{ id: draft.id }],
    })
  })

  it("refuses sends with no recipient, too many, or from an address the key may not use", async () => {
    const { base, domain } = await setup()
    const empty = await json<{ id: string }>(
      await call(`${base}/drafts`, { method: "POST", key: member.key, json: { subject: "x" } }),
    )
    expect(
      (await call(`${base}/drafts/${empty.id}/send`, { method: "POST", key: member.key, json: {} })).status,
    ).toBe(400)
    const many = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { to: Array.from({ length: 51 }, (_, i) => ({ address: `r${i}@example.org` })) },
      }),
    )
    expect(
      (await call(`${base}/drafts/${many.id}/send`, { method: "POST", key: member.key, json: {} })).status,
    ).toBe(400)
    const spoof = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { from: `ceo@${domain}`, to: [{ address: "ada@example.org" }] },
      }),
    )
    expect(
      (await call(`${base}/drafts/${spoof.id}/send`, { method: "POST", key: member.key, json: {} })).status,
    ).toBe(400)
    const alias = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: { from: `hi@${domain}`, to: [{ address: "ada@example.org" }] },
      }),
    )
    expect(
      (await call(`${base}/drafts/${alias.id}/send`, { method: "POST", key: member.key, json: {} })).status,
    ).toBe(200)
    expect(
      (await call(`${base}/drafts/${alias.id}/send`, { method: "POST", key: viewer.key, json: {} })).status,
    ).toBe(403)
  })

  it("uploads attachments, sends small ones inline and large ones as expiring links", async () => {
    const { sam, base } = await setup()
    const upload = async (name: string, bytes: Uint8Array, type: string) =>
      json<{ key: string; filename: string; mimeType: string; size: number }>(
        await call(`${base}/uploads?filename=${encodeURIComponent(name)}`, {
          method: "POST",
          key: member.key,
          body: bytes,
          headers: { "content-type": type },
        }),
      )
    const small = await upload("notes.txt", new TextEncoder().encode("small notes"), "text/plain")
    expect(small).toMatchObject({ filename: "notes.txt", mimeType: "text/plain", size: 11 })
    expect(small.key.startsWith(`upl/${sam.id}/`)).toBe(true)
    const big = await upload(
      "video.bin",
      new Uint8Array(4.5 * 1024 * 1024).fill(7),
      "application/octet-stream",
    )
    expect(
      (await call(`${base}/uploads?filename=a/b`, { method: "POST", key: member.key, body: "x" })).status,
    ).toBe(400)
    expect(
      (await call(`${base}/uploads?filename=x`, { method: "POST", key: viewer.key, body: "x" })).status,
    ).toBe(403)

    // A key from another mailbox, or a made-up one, can't be attached.
    const foreign = await call(`${base}/drafts`, {
      method: "POST",
      key: member.key,
      json: {
        to: [{ address: "ada@example.org" }],
        attachments: [{ key: "upl/mbx_other/x", filename: "x", mimeType: "text/plain", size: 1 }],
      },
    })
    expect(foreign.status).toBe(400)

    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, {
        method: "POST",
        key: member.key,
        json: {
          to: [{ address: "ada@example.org" }],
          subject: "Files",
          bodyText: "Two files.",
          attachments: [small, big],
        },
      }),
    )
    await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: member.key, json: {} })
    await untilDue(sam.id, draft.id)
    await runMailboxSendQueue([{ mailboxId: sam.id, draftId: draft.id, origin: "https://mailyard.test" }])
    const send = (await mailboxSends(sam.id)).results[0]
    const message = await rendered(send?.rendered_key ?? "")
    expect(message.attachments?.map((a) => a.filename)).toEqual(["notes.txt"])
    expect(message.text).toContain("Attachments too large to send by email")
    const link = /https:\/\/mailyard\.test\/v1\/files\/\S+/.exec(message.text)?.[0] ?? ""
    const downloaded = await exports.default.fetch(new Request(link))
    expect(downloaded.status).toBe(200)
    expect((await downloaded.arrayBuffer()).byteLength).toBe(4.5 * 1024 * 1024)

    // Uploads become content-addressed attachments of the sent copy.
    const copy = await env.MAILBOX.get(env.MAILBOX.idFromName(sam.id)).message(send?.mailbox_message_id ?? "")
    expect(copy?.attachments.map((a) => [a.filename, a.r2Key.startsWith("att/")])).toEqual([
      ["notes.txt", true],
      ["video.bin", true],
    ])
    expect(await env.STORE.head(small.key)).toBeNull()
  })

  it("edits and deletes drafts; a send that fails for good returns the draft with the reason", async () => {
    const { sam, base } = await setup()
    const draft = await json<{ id: string }>(
      await call(`${base}/drafts`, { method: "POST", key: member.key, json: { subject: "One" } }),
    )
    expect(
      await json(
        await call(`${base}/drafts/${draft.id}`, {
          method: "PATCH",
          key: member.key,
          json: { subject: "Two", to: [{ address: "Ada@Example.org", name: " Ada " }] },
        }),
      ),
    ).toMatchObject({
      subject: "Two",
      to: [{ address: "ada@example.org", name: "Ada" }],
    })
    expect(await json(await call(`${base}/drafts/${draft.id}`, { key: viewer.key }))).toMatchObject({
      subject: "Two",
    })

    // An upload deleted before the send: the draft comes back with why.
    const gone = await json<{ key: string }>(
      await call(`${base}/uploads?filename=gone.txt`, {
        method: "POST",
        key: member.key,
        body: "x",
        headers: { "content-type": "text/plain" },
      }),
    )
    await call(`${base}/drafts/${draft.id}`, {
      method: "PATCH",
      key: member.key,
      json: { attachments: [{ key: gone.key, filename: "gone.txt", mimeType: "text/plain", size: 1 }] },
    })
    await env.STORE.delete(gone.key)
    await call(`${base}/drafts/${draft.id}/send`, { method: "POST", key: member.key, json: {} })
    await untilDue(sam.id, draft.id)
    await runMailboxSendQueue([{ mailboxId: sam.id, draftId: draft.id, origin: null }])
    expect(await json(await call(`${base}/drafts/${draft.id}`, { key: member.key }))).toMatchObject({
      status: "draft",
      lastError: "gone.txt is no longer stored.",
    })
    expect((await call(`${base}/drafts/${draft.id}`, { method: "DELETE", key: member.key })).status).toBe(200)
    expect((await call(`${base}/drafts/${draft.id}`, { key: member.key })).status).toBe(404)
  })
})

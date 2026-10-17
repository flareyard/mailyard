import { evictDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { MAILBOX_MIGRATIONS } from "../../src/mailbox/schema.ts"
import { LIVE_PROTOCOL } from "../../src/workers/live.ts"
import { ADMIN, createKey } from "../helpers.ts"
import { delivery } from "./deliveries.ts"

let reader = ""
let publicKey = ""
beforeAll(async () => {
  reader = (await createKey("secret", ["read"])).key
  publicKey = (await createKey("public")).key
})

const mailbox = async (kind: "user" | "alias" = "user") => {
  const name = `live-${crypto.randomUUID().slice(0, 8)}.test`
  const domainId = `dom_${crypto.randomUUID()}`
  const id = `mbx_${crypto.randomUUID()}`
  await env.DB.prepare("insert into domains (id, name) values (?, ?)").bind(domainId, name).run()
  await env.DB.prepare("insert into mailboxes (id, domain_id, address, kind) values (?, ?, ?, ?)")
    .bind(id, domainId, `sam@${name}`, kind)
    .run()
  return { id, stub: env.MAILBOX.get(env.MAILBOX.idFromName(id)) }
}

const open = (mailboxId: string, headers: Record<string, string>) =>
  exports.default.fetch(
    new Request(`https://mailyard.test/v1/mailboxes/${mailboxId}/live`, {
      headers: { upgrade: "websocket", ...headers },
    }),
  )

/** A connected client that collects frames, so a test can wait for the next one or check none came. */
const connect = async (
  mailboxId: string,
  headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` },
) => {
  const response = await open(mailboxId, headers)
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error("no WebSocket on the response")
  socket.accept()
  const frames: Array<string> = []
  const waiters: Array<(frame: string) => void> = []
  socket.addEventListener("message", (event) => {
    const frame = String(event.data)
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else frames.push(frame)
  })
  const next = (timeoutMs = 2000) =>
    new Promise<Record<string, unknown> | string>((resolve, reject) => {
      const parse = (frame: string) => {
        try {
          return JSON.parse(frame) as Record<string, unknown>
        } catch {
          return frame
        }
      }
      const queued = frames.shift()
      if (queued !== undefined) return resolve(parse(queued))
      const timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs)
      waiters.push((frame) => {
        clearTimeout(timer)
        resolve(parse(frame))
      })
    })
  const quiet = async (ms = 150) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return frames.length === 0
  }
  return { socket, response, next, quiet }
}

describe("GET /v1/mailboxes/{id}/live", () => {
  it("refuses requests that aren't an authorised WebSocket upgrade to a real mailbox", async () => {
    const { id } = await mailbox()
    const plain = await exports.default.fetch(new Request(`https://mailyard.test/v1/mailboxes/${id}/live`))
    expect(plain.status).toBe(426)
    expect((await open(id, {})).status).toBe(401)
    expect((await open(id, { authorization: "Bearer sk_wrong" })).status).toBe(401)
    expect((await open(id, { authorization: `Bearer ${publicKey}` })).status).toBe(403)
    // A read key that isn't a member of the mailbox sees nothing.
    expect((await open(id, { authorization: `Bearer ${reader}` })).status).toBe(403)
    expect((await open("mbx_missing", { authorization: `Bearer ${ADMIN}` })).status).toBe(404)
    const alias = await mailbox("alias")
    expect((await open(alias.id, { authorization: `Bearer ${ADMIN}` })).status).toBe(404)
  })

  it("greets with counts, then pushes each new message as exactly one frame", async () => {
    const { id, stub } = await mailbox()
    const client = await connect(id)
    const hello = (await client.next()) as {
      type: string
      counts: Array<{ folder: string }>
      schemaVersion: number
    }
    expect(hello).toMatchObject({ type: "hello", schemaVersion: MAILBOX_MIGRATIONS.length })
    expect(hello.counts.map((c) => c.folder)).toContain("inbox")
    expect(await stub.liveConnections()).toBe(1)

    await stub.deliver(delivery({ id: "inb_live1", subject: "Live one" }))
    const frame = (await client.next()) as {
      type: string
      message: { id: string }
      thread: { subject: string }
    }
    expect(frame).toMatchObject({
      type: "message.added",
      message: { id: "inb_live1" },
      thread: { subject: "Live one" },
    })
    expect(await client.quiet()).toBe(true)

    // A redelivery stores nothing and pushes nothing.
    await stub.deliver(delivery({ id: "inb_live1", subject: "Live one" }))
    expect(await client.quiet()).toBe(true)
    client.socket.close(1000, "done")
  })

  it("keeps the socket across hibernation: evicted, the object still pushes the next message", async () => {
    const { id, stub } = await mailbox()
    const client = await connect(id)
    await client.next()
    await evictDurableObject(stub)
    await stub.deliver(delivery({ id: "inb_after_evict", subject: "After eviction" }))
    expect(await client.next()).toMatchObject({ type: "message.added", message: { id: "inb_after_evict" } })
    expect(await stub.liveConnections()).toBe(1)
    client.socket.close(1000, "done")
  })

  it("answers ping without waking the object, and counts on request", async () => {
    const { id } = await mailbox()
    const client = await connect(id)
    await client.next()
    client.socket.send("ping")
    expect(await client.next()).toBe("pong")
    client.socket.send(JSON.stringify({ type: "counts" }))
    expect(await client.next()).toMatchObject({ type: "counts" })
    client.socket.send("nonsense")
    expect(await client.next()).toMatchObject({ type: "error" })
    client.socket.close(1000, "done")
  })

  it("pushes thread, label and draft changes", async () => {
    const { id, stub } = await mailbox()
    await stub.deliver(delivery({ id: "inb_chg" }))
    const client = await connect(id)
    await client.next()
    const threadId = (await stub.message("inb_chg"))?.threadId ?? ""
    await stub.updateThreads([threadId], { seen: true })
    expect(await client.next()).toMatchObject({
      type: "threads.changed",
      threads: [{ id: threadId, unreadCount: 0 }],
    })
    await stub.createLabel({ name: "Live" })
    expect(await client.next()).toMatchObject({ type: "labels.changed", labels: [{ name: "Live" }] })
    await stub.saveDraft({ subject: "Draft" })
    expect(await client.next()).toMatchObject({ type: "drafts.changed", drafts: [{ subject: "Draft" }] })
    client.socket.close(1000, "done")
  })

  it("accepts the key as a subprotocol, since browsers can't set headers on a WebSocket", async () => {
    const { id } = await mailbox()
    const client = await connect(id, { "sec-websocket-protocol": `${LIVE_PROTOCOL}, bearer.${ADMIN}` })
    expect(client.response.headers.get("sec-websocket-protocol")).toBe(LIVE_PROTOCOL)
    expect(await client.next()).toMatchObject({ type: "hello" })
    client.socket.close(1000, "done")
  })
})

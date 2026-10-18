import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { fromB64url } from "../../src/push/webPush.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { decrypt, subscriber } from "./subscriber.ts"

/**
 * HAL-3369: Web Push end to end. Real filing and assignment send to a fake push service on
 * https://push.test, and each body is decrypted with the subscribing browser's own keys.
 */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

type Sub = Awaited<ReturnType<typeof subscriber>>
const browsers = new Map<string, Sub>()
const received: Array<{ endpoint: string; headers: Record<string, string>; body: Uint8Array }> = []
let status = 201
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "push.test") return realFetch(input, init)
  received.push({
    endpoint: request.url,
    headers: Object.fromEntries(request.headers),
    body: new Uint8Array(await request.arrayBuffer()),
  })
  return new Response(null, { status })
}) as typeof fetch
afterEach(() => {
  received.length = 0
  status = 201
})

/** What each browser was sent, decrypted. */
const notifications = async () =>
  Promise.all(
    received.map(async (r) => {
      const sub = browsers.get(r.endpoint)
      if (!sub) throw new Error(`no browser for ${r.endpoint}`)
      return {
        endpoint: r.endpoint,
        ...(JSON.parse((await decrypt(r.body, sub)).text) as Record<string, string>),
      }
    }),
  )

const subscribe = async (key: string, device = "Test browser") => {
  const sub = await subscriber()
  const endpoint = `https://push.test/send/${uid()}`
  browsers.set(endpoint, sub)
  const res = await call("/v1/push/subscriptions", {
    method: "POST",
    key,
    json: { endpoint, keys: { p256dh: sub.p256dh, auth: sub.authB64 }, device },
  })
  expect(res.status).toBe(200)
  return { endpoint, id: (await json<{ id: string }>(res)).id }
}

const setup = async () => {
  const domain = `pu-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain })
  const box = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", "POST", { address: `team@${domain}`, kind: "shared" }),
  )
  return { domain, box }
}

const receive = async (to: string, subject: string) => {
  const raw = `From: Ada Lovelace <ada@example.org>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello\r\n`
  const bytes = new TextEncoder().encode(raw)
  await handleEmail(
    {
      from: "ada@example.org",
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
}

describe("Web Push (HAL-3369)", () => {
  it("serves a stable VAPID key and signs each push with it", async () => {
    const a = await json<{ publicKey: string }>(await admin("/v1/push/vapid-key"))
    const b = await json<{ publicKey: string }>(await admin("/v1/push/vapid-key"))
    expect(a.publicKey).toBe(b.publicKey)
    expect(fromB64url(a.publicKey).length).toBe(65)
    const { endpoint } = await subscribe(ADMIN)
    const test = await json<{ sent: number }>(await admin("/v1/push/test", "POST"))
    expect(test.sent).toBeGreaterThanOrEqual(1)
    const mine = received.find((r) => r.endpoint === endpoint)
    expect(mine?.headers.authorization).toMatch(
      new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^,]+, k=${a.publicKey}$`),
    )
    expect(mine?.headers["content-encoding"]).toBe("aes128gcm")
    expect(mine?.headers.ttl).toBe("86400")
    expect((await notifications()).find((n) => n.endpoint === endpoint)).toMatchObject({
      type: "test",
      body: "Notifications work.",
    })
  })

  it("tells the people who read a mailbox about new mail, as they asked", async () => {
    const { box } = await setup()
    // A reader of this mailbox only, and a key that can't read it.
    const reader = await createKey("secret", ["read"])
    await admin(`/v1/mailboxes/${box.id}/members`, "PUT", {
      members: [{ apiKeyId: reader.apiKey.id, role: "viewer" }],
    })
    const outsider = await createKey("secret", ["read"])
    const readerSub = await subscribe(reader.key, "Reader's laptop")
    const outsiderSub = await subscribe(outsider.key)
    await receive(box.address, "Refund for order #42")
    const got = await notifications()
    expect(got.find((n) => n.endpoint === readerSub.endpoint)).toMatchObject({
      type: "mail",
      title: "Ada Lovelace",
      body: "Refund for order #42",
      mailboxId: box.id,
    })
    expect(got.find((n) => n.endpoint === outsiderSub.endpoint)).toBeUndefined()

    // Content hidden, then the mailbox turned off.
    received.length = 0
    await call("/v1/push/preferences", {
      method: "PUT",
      key: reader.key,
      json: { mailboxes: [], alerts: false, hideContent: true },
    })
    await receive(box.address, "Second message")
    expect((await notifications()).find((n) => n.endpoint === readerSub.endpoint)).toMatchObject({
      title: "New mail",
      body: "Open Mailyard to read it.",
    })
    received.length = 0
    await call("/v1/push/preferences", {
      method: "PUT",
      key: reader.key,
      json: { mailboxes: [{ mailboxId: box.id, notify: "off" }], alerts: false, hideContent: false },
    })
    await receive(box.address, "Third message")
    expect(received.find((r) => r.endpoint === readerSub.endpoint)).toBeUndefined()
  })

  it("tells someone a conversation was handed to them, even when they only want assigned mail", async () => {
    const { box } = await setup()
    const agent = await createKey("secret", ["read", "send"])
    await admin(`/v1/mailboxes/${box.id}/members`, "PUT", {
      members: [{ apiKeyId: agent.apiKey.id, role: "member" }],
    })
    const sub = await subscribe(agent.key)
    await call("/v1/push/preferences", {
      method: "PUT",
      key: agent.key,
      json: { mailboxes: [{ mailboxId: box.id, notify: "assigned" }], alerts: false, hideContent: false },
    })
    await receive(box.address, "Unassigned question")
    expect(received.find((r) => r.endpoint === sub.endpoint)).toBeUndefined()
    const thread = (
      await json<{ threads: Array<{ id: string }> }>(await admin(`/v1/mailboxes/${box.id}/threads`))
    ).threads[0]
    await admin(`/v1/mailboxes/${box.id}/threads/bulk`, "POST", {
      threadIds: [thread?.id],
      action: "assign",
      assignee: agent.apiKey.id,
    })
    expect((await notifications()).find((n) => n.endpoint === sub.endpoint)).toMatchObject({
      type: "assigned",
      title: "Assigned to you",
      body: "Unassigned question",
      threadId: thread?.id,
    })
  })

  it("drops a subscription the push service says is gone, and lets an owner remove only their own", async () => {
    const mine = await createKey("secret", ["read"])
    const theirs = await createKey("secret", ["read"])
    const a = await subscribe(mine.key)
    const b = await subscribe(theirs.key)
    expect((await call(`/v1/push/subscriptions/${b.id}`, { method: "DELETE", key: mine.key })).status).toBe(
      404,
    )
    const listed = await json<{ subscriptions: Array<{ id: string; service: string; device: string }> }>(
      await call("/v1/push/subscriptions", { key: mine.key }),
    )
    expect(listed.subscriptions).toEqual([
      expect.objectContaining({ id: a.id, service: "push.test", device: "Test browser" }),
    ])
    status = 410
    expect(await json(await call("/v1/push/test", { method: "POST", key: mine.key }))).toMatchObject({
      gone: 1,
    })
    expect(
      (await json<{ subscriptions: unknown[] }>(await call("/v1/push/subscriptions", { key: mine.key })))
        .subscriptions,
    ).toEqual([])
    expect(
      (
        await call("/v1/push/subscriptions", {
          method: "POST",
          key: mine.key,
          json: { endpoint: "http://insecure.example/x", keys: { p256dh: "x", auth: "y" } },
        })
      ).status,
    ).toBe(400)
  })
})

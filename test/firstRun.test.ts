import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test"
import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Env } from "../src/Bindings.ts"
import { createMailbox } from "../src/domain/mailboxes.ts"
import { rawKeyOf } from "../src/inbound/pipeline.ts"
import { CloudflareEmail } from "../src/services/CloudflareEmail.ts"
import worker from "../src/workers/api.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "./dns.ts"
import { ADMIN, call, json } from "./helpers.ts"

/** HAL-3378: the first-run helpers. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

/** Cloudflare's API as the tokens see it: routing rules per zone, destination addresses, every write kept. */
const writes: Array<{ method: string; path: string; body: unknown }> = []
const rulesByZone = new Map<string, Array<unknown>>()
let addresses: { status: number; result: Array<{ email: string; verified: string | null }> } = {
  status: 200,
  result: [],
}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname !== "api.cloudflare.com") return realFetch(input, init)
  const path = url.pathname.replace("/client/v4", "")
  const ok = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result, result_info: { total_pages: 1 } })
  if (request.method !== "GET") {
    writes.push({ method: request.method, path, body: await request.json().catch(() => null) })
    return ok({})
  }
  if (path === "/accounts/acc/email/routing/addresses") {
    if (addresses.status !== 200)
      return Response.json(
        { success: false, errors: [{ message: "Unauthorized" }] },
        { status: addresses.status },
      )
    // Cloudflare filters with ?verified=true; this fake returns everything, so the code must filter too.
    return ok(addresses.result)
  }
  const m = /^\/zones\/([^/]+)\/email\/routing\/rules$/.exec(path)
  if (m) return ok(rulesByZone.get(m[1] ?? "") ?? [])
  return Response.json({ success: false, errors: [{ message: "not faked" }] }, { status: 404 })
}) as typeof fetch

const receivingDomain = async () => {
  const name = `first-${uid()}.test`
  setDns(goodDomain(name))
  const r = await call("/v1/domains", {
    method: "POST",
    key: ADMIN,
    json: { name, sending: true, receiving: true },
  })
  if (r.status !== 200) throw new Error(`domain: ${await r.text()}`)
  return { name, id: (await json<{ id: string }>(r)).id }
}

/** Delivers raw mail to `to` through the inbound queue, as Email Routing would. */
const arrive = async (to: string, headers: string) => {
  const raw = new TextEncoder().encode(
    `${headers}From: news@sender.test\r\nTo: ${to}\r\nSubject: Mailyard test send\r\nMessage-ID: <${uid()}@sender.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nTest\r\n`,
  )
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
  await env.STORE.put(rawKeyOf(sha256), raw)
  const batch = createMessageBatch("mailyard-inbound", [
    {
      id: `in-${uid()}`,
      timestamp: new Date(),
      attempts: 1,
      body: {
        sha256,
        size: raw.byteLength,
        envelopeFrom: "bounce@sender.test",
        envelopeTo: to,
        receivedAt: Date.now(),
      },
    },
  ])
  await worker.queue(batch, env)
  await getQueueResult(batch, createExecutionContext())
}

type TestSend = {
  id: string
  to: string
  probe: boolean
  status: string
  messageId: string | null
  deliveryTimeMs: number | null
  authentication: Record<string, string | null> | null
}

describe("test send", () => {
  it("measures a probe send: the receiving side's verdicts, the sender's policy, the time it took", async () => {
    const { name } = await receivingDomain()
    // A catch-all must not swallow the probe.
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `all@${name}`, kind: "catch_all" },
    })
    const started = await call("/v1/test-send", {
      method: "POST",
      key: ADMIN,
      json: { from: `News <news@${name}>` },
    })
    expect(started.status).toBe(200)
    const t = await json<TestSend>(started)
    expect(t).toMatchObject({ to: `mailyard-test@${name}`, probe: true, authentication: null })
    expect(["sending", "sent"]).toContain(t.status)

    await arrive(
      t.to,
      `X-Mailyard-Test: ${t.id}\r\nAuthentication-Results: mx.cloudflare.net; spf=none smtp.helo=out.test; spf=pass smtp.mailfrom=cf-bounce.${name}; dkim=pass header.d=other.test header.s=x; dkim=pass header.d=${name} header.s=cf2024; dmarc=pass header.from=${name}\r\n`,
    )
    const got = await json<TestSend>(await call(`/v1/test-send/${t.id}`, { key: ADMIN }))
    expect(got.status).toBe("received")
    // MAIL FROM's SPF wins over HELO's; the sender's own DKIM signature over another; p= from DNS.
    expect(got.authentication).toEqual({
      spf: "pass",
      spfDomain: `cf-bounce.${name}`,
      dkim: "pass",
      dkimDomain: name,
      dmarc: "pass",
      dmarcPolicy: "quarantine",
    })
    expect(got.deliveryTimeMs).toBeGreaterThanOrEqual(0)
    // Consumed, never filed: the catch-all holds nothing.
    const row = await env.DB.prepare(
      "select status, delivered_to from inbound_messages where envelope_to = ? order by received_at desc",
    )
      .bind(t.to)
      .first<{ status: string; delivered_to: string }>()
    expect(row).toMatchObject({ status: "consumed", delivered_to: "[]" })
  })

  it("reports delivery only for an address the person gives, and refuses a non-sending sender", async () => {
    const { name } = await receivingDomain()
    const t = await json<TestSend>(
      await call("/v1/test-send", {
        method: "POST",
        key: ADMIN,
        json: { from: `news@${name}`, to: "Me@Example.org" },
      }),
    )
    expect(t).toMatchObject({ to: "me@example.org", probe: false })
    // A delivery event marks the message delivered; the trail's trigger records when.
    await env.DB.prepare("update messages_out set status = 'delivered' where id = ?").bind(t.messageId).run()
    const event = await env.DB.prepare(
      "select min(at) as at from message_events where message_id = ? and type = 'delivered'",
    )
      .bind(t.messageId)
      .first<{ at: number | null }>()
    expect(event?.at).not.toBeNull()
    const got = await json<TestSend & { sentAt: number }>(await call(`/v1/test-send/${t.id}`, { key: ADMIN }))
    expect(got).toMatchObject({ status: "delivered", authentication: null })
    expect(got.deliveryTimeMs).toBe(Math.max(0, (event?.at ?? 0) - got.sentAt))

    const refused = await call("/v1/test-send", {
      method: "POST",
      key: ADMIN,
      json: { from: "someone@not-ours.test" },
    })
    expect(refused.status).toBe(400)
    expect(await json<{ field: string }>(refused)).toMatchObject({ field: "from" })
    expect(
      (await call("/v1/test-send", { method: "POST", key: ADMIN, json: { from: `a@${name}`, to: "nope" } }))
        .status,
    ).toBe(400)
    expect((await call("/v1/test-send/tst_nope", { key: ADMIN })).status).toBe(404)
  })

  it("leaves other mail to the probe address alone", async () => {
    const { name, id } = await receivingDomain()
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `all@${name}`, kind: "catch_all" },
    })
    await call(`/v1/domains/${id}`, { method: "PATCH", key: ADMIN, json: { catchAll: "keep" } })
    await arrive(`mailyard-test@${name}`, "X-Mailyard-Test: tst_not_ours\r\n")
    const row = await env.DB.prepare("select status from inbound_messages where envelope_to = ?")
      .bind(`mailyard-test@${name}`)
      .first<{ status: string }>()
    expect(row?.status).not.toBe("consumed")
  })
})

describe("verified addresses", () => {
  const withEmail = <A>(effect: Effect.Effect<A, never, CloudflareEmail>, extra: Partial<Env>) =>
    runtimeFor({ ...env, ...extra } as Env).runPromise(effect)
  const read = CloudflareEmail.use((c) => c.verifiedAddresses)

  it("lists only the verified ones, and says why when it can't", async () => {
    addresses = {
      status: 200,
      result: [
        { email: "Me@Example.org", verified: "2026-10-01T10:00:00Z" },
        { email: "pending@example.org", verified: null },
      ],
    }
    expect(
      await withEmail(read, { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_READ_TOKEN: "tok" }),
    ).toEqual({
      available: true,
      addresses: [{ email: "me@example.org", verifiedAt: Date.parse("2026-10-01T10:00:00Z") }],
    })
    addresses = { status: 403, result: [] }
    expect(
      await withEmail(read, { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_READ_TOKEN: "tok" }),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("Email Routing Addresses: Read"),
    })
    // The test env has no Cloudflare credentials: the endpoint says so.
    expect(await json(await call("/v1/verified-addresses", { key: ADMIN }))).toMatchObject({
      available: false,
    })
  })
})

describe("routing-rule conflicts on mailbox create", () => {
  const zoned = { CLOUDFLARE_DNS_TOKEN: "zone-token" } as Partial<Env>
  const create = (address: string, replaceRoutingRule?: boolean) =>
    runtimeFor({ ...env, ...zoned } as Env).runPromise(
      createMailbox(
        { address, kind: "user", ...(replaceRoutingRule ? { replaceRoutingRule } : {}) },
        "test",
      ).pipe(Effect.result),
    )
  const setup = async () => {
    const { name, id } = await receivingDomain()
    const zoneId = `zone-${uid()}`
    await env.DB.prepare("update domains set zone_id = ? where id = ?").bind(zoneId, id).run()
    return { name, zoneId }
  }

  it("refuses an address Cloudflare routes elsewhere, and repoints the rule when asked", async () => {
    const { name, zoneId } = await setup()
    rulesByZone.set(zoneId, [
      {
        id: "rule-fwd",
        name: "Forward hello",
        enabled: true,
        priority: 3,
        matchers: [{ type: "literal", field: "to", value: `Hello@${name}` }],
        actions: [{ type: "forward", value: ["me@gmail.com"] }],
      },
      // Disabled rules and rules already pointing at Mailyard are no conflict.
      {
        id: "rule-off",
        enabled: false,
        matchers: [{ type: "literal", field: "to", value: `off@${name}` }],
        actions: [{ type: "drop" }],
      },
      {
        id: "rule-ours",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: `ours@${name}` }],
        actions: [{ type: "worker", value: ["mailyard-api"] }],
      },
    ])
    const refused = await create(`hello@${name}`)
    expect(refused._tag).toBe("Failure")
    expect(refused._tag === "Failure" && refused.failure).toMatchObject({
      _tag: "RoutingRuleExists",
      ruleId: "rule-fwd",
      ruleDestination: "me@gmail.com",
      ruleAction: "forward",
    })
    for (const free of ["off", "ours", "plain"]) {
      const r = await create(`${free}@${name}`)
      expect(r._tag === "Success" && r.success.routing, free).toBe("clear")
    }
    const before = writes.length
    const replaced = await create(`hello@${name}`, true)
    expect(replaced._tag === "Success" && replaced.success.routing).toBe("replaced")
    expect(writes.slice(before)).toEqual([
      {
        method: "PUT",
        path: `/zones/${zoneId}/email/routing/rules/rule-fwd`,
        body: {
          name: "Forward hello",
          enabled: true,
          priority: 3,
          matchers: [{ type: "literal", field: "to", value: `Hello@${name}` }],
          actions: [{ type: "worker", value: ["mailyard-api"] }],
        },
      },
    ])
  })

  it("is unchecked without a zone token", async () => {
    const { name } = await receivingDomain()
    const r = await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `x@${name}`, kind: "user" },
    })
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ routing: "unchecked" })
  })
})

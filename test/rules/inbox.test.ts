import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { handleEmail } from "../../src/workers/inbound.ts"
import { installDohFixture } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { simpleMessage } from "../inbound/messages.ts"

installDohFixture()

/** A fake OpenAI-compatible classifier at classifier.test, answering whatever probability the test sets. */
let classifierAnswer: number | "error" = 0
let classifierCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  if (new URL(request.url).hostname !== "classifier.test") return realFetch(input, init)
  classifierCalls++
  if (classifierAnswer === "error") return new Response("down", { status: 503 })
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ spam_probability: classifierAnswer }) } }],
  })
}) as typeof fetch

const withClassifier = {
  ...env,
  MAILYARD_CLASSIFIER: "openai",
  CLASSIFIER_URL: "https://classifier.test/v1",
  CLASSIFIER_MODEL: "fake",
} as unknown as Env

let owner = { key: "", id: "" }
let member = { key: "", id: "" }
beforeAll(async () => {
  const o = await createKey("secret", ["send", "read"])
  owner = { key: o.key, id: o.apiKey.id }
  const m = await createKey("secret", ["send", "read"])
  member = { key: m.key, id: m.apiKey.id }
})

const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, key: ADMIN })

const setup = async (settings: Record<string, unknown> = {}) => {
  const domain = `rules-${crypto.randomUUID().slice(0, 8)}.test`
  await admin("/v1/domains", { method: "POST", json: { name: domain } })
  const sam = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", {
      method: "POST",
      json: { address: `sam@${domain}`, kind: "user", displayName: "Sam", ...settings },
    }),
  )
  await admin(`/v1/mailboxes/${sam.id}/members`, {
    method: "PUT",
    json: {
      members: [
        { apiKeyId: owner.id, role: "owner" },
        { apiKeyId: member.id, role: "member" },
      ],
    },
  })
  return { domain, sam, base: `/v1/mailboxes/${sam.id}` }
}

const deliver = async (raw: Uint8Array, to: string, from = "ada@example.org", bindings: Env = env) => {
  const message = {
    from,
    to,
    headers: new Headers(),
    raw: new Blob([raw]).stream(),
    rawSize: raw.byteLength,
    canBeForwarded: true,
    setReject: () => {},
    forward: async () => {
      throw new Error("unused")
    },
    reply: async () => {
      throw new Error("unused")
    },
  } as unknown as ForwardableEmailMessage
  const outcome = await handleEmail(message, bindings)
  if (outcome?.outcome !== "filed") throw new Error(`not filed: ${JSON.stringify(outcome)}`)
  return outcome.id
}

const stored = (mailboxId: string, id: string) =>
  env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)).message(id)

const auth = (spf: string, dkim: string, dmarc: string) =>
  `Authentication-Results: mx.cloudflare.net; spf=${spf} smtp.mailfrom=ada@example.org; dkim=${dkim} header.d=example.org; dmarc=${dmarc} header.from=example.org`

const outgoing = async (mailboxId: string) => {
  const { results } = await env.DB.prepare(
    "select rendered_key, recipient, subject, status from messages_out where mailbox_id = ? order by created_at",
  )
    .bind(mailboxId)
    .all<{ rendered_key: string; recipient: string; subject: string; status: string }>()
  return Promise.all(
    results.map(async (r) => ({
      ...r,
      message: (await (await env.STORE.get(r.rendered_key))?.json()) as {
        from: { email: string; name?: string }
        to: Array<{ email: string }>
        replyTo?: { email: string }
        subject: string
        text: string
        headers?: Record<string, string>
        attachments?: Array<{ filename: string }>
      },
    })),
  )
}

describe("rules on delivery", () => {
  it("labels, archives and marks read what matches, and records why", async () => {
    const { sam, base } = await setup()
    const label = await json<{ id: string }>(
      await call(`${base}/labels`, { method: "POST", key: owner.key, json: { name: "CI" } }),
    )
    const created = await call(`${base}/rules`, {
      method: "POST",
      key: owner.key,
      json: {
        name: "CI noise",
        conditions: [
          { field: "from", op: "endsWith", value: "@github.com" },
          { field: "subject", op: "contains", value: "build" },
        ],
        actions: [{ type: "label", labelId: label.id }, { type: "archive" }, { type: "markRead" }],
      },
    })
    expect(created.status).toBe(200)
    const rule = await json<{ id: string }>(created)
    const id = await deliver(
      simpleMessage({
        from: "GitHub <notifications@github.com>",
        to: sam.address,
        subject: "Build failed",
        headers: auth("pass", "pass", "pass"),
      }),
      sam.address,
      "notifications@github.com",
    )
    expect(await stored(sam.id, id)).toMatchObject({
      folder: "archive",
      seen: true,
      labelIds: [label.id],
      rulesMatched: [rule.id],
    })
    const other = await deliver(
      simpleMessage({ to: sam.address, subject: "Lunch?", headers: auth("pass", "pass", "pass") }),
      sam.address,
    )
    expect(await stored(sam.id, other)).toMatchObject({ folder: "inbox", seen: false, rulesMatched: [] })
  })

  it("files failed authentication as spam with its reasons; allow and block lists override", async () => {
    const { sam, base } = await setup()
    const spam = await deliver(
      simpleMessage({ to: sam.address, subject: "You won", headers: auth("fail", "fail", "fail") }),
      sam.address,
    )
    const filed = await stored(sam.id, spam)
    expect(filed).toMatchObject({ folder: "spam", spamScore: 9 })
    expect(filed?.spamReasons.map((r) => r.rule)).toEqual(["dmarc=fail", "spf=fail", "dkim=fail"])

    // "Not spam" allowlists the sender, and their next message lands in the inbox.
    await call(`${base}/threads/bulk`, {
      method: "POST",
      key: member.key,
      json: { threadIds: [filed?.threadId], action: "notSpam" },
    })
    expect(await json(await call(`${base}/senders?list=allow`, { key: member.key }))).toMatchObject({
      senders: [{ value: "ada@example.org", list: "allow", source: "not_spam" }],
    })
    const again = await deliver(
      simpleMessage({ to: sam.address, subject: "Really", headers: auth("fail", "fail", "fail") }),
      sam.address,
    )
    expect(await stored(sam.id, again)).toMatchObject({ folder: "inbox", spamScore: 0 })

    // A blocked domain sends to spam however well it authenticates.
    await call(`${base}/senders`, {
      method: "POST",
      key: member.key,
      json: { value: "@spammy.test", list: "block" },
    })
    const blocked = await deliver(
      simpleMessage({ from: "x@spammy.test", to: sam.address, headers: auth("pass", "pass", "pass") }),
      sam.address,
      "x@spammy.test",
    )
    expect(await stored(sam.id, blocked)).toMatchObject({ folder: "spam" })
    expect(
      (
        await call(`${base}/senders`, {
          method: "POST",
          key: member.key,
          json: { value: "not an address", list: "block" },
        })
      ).status,
    ).toBe(400)
    expect(
      await json(
        await call(`${base}/senders/${encodeURIComponent("@spammy.test")}`, {
          method: "DELETE",
          key: member.key,
        }),
      ),
    ).toEqual({ removed: "@spammy.test" })
  })

  it("asks the classifier only when authentication leaves doubt, and survives it failing", async () => {
    const { sam } = await setup()
    classifierCalls = 0
    classifierAnswer = 0.95
    // spf=softfail and no DKIM: 1.5 points, in the doubtful band.
    const doubtful = simpleMessage({
      to: sam.address,
      headers: "Authentication-Results: mx.cloudflare.net; spf=softfail smtp.mailfrom=ada@example.org",
    })
    const id = await deliver(doubtful, sam.address, "ada@example.org", withClassifier)
    const filed = await stored(sam.id, id)
    expect(filed?.folder).toBe("spam")
    expect(filed?.spamReasons.at(-1)).toEqual({ rule: "openai classifier p=0.95", points: 5.7 })
    expect(classifierCalls).toBe(1)

    // Clear passes never reach the classifier.
    await deliver(
      simpleMessage({ to: sam.address, headers: auth("pass", "pass", "pass") }),
      sam.address,
      "ada@example.org",
      withClassifier,
    )
    expect(classifierCalls).toBe(1)

    // A classifier outage means no opinion: the message is filed on authentication alone.
    classifierAnswer = "error"
    const second = simpleMessage({
      to: sam.address,
      subject: "Again",
      headers: "Authentication-Results: mx.cloudflare.net; spf=softfail smtp.mailfrom=ada@example.org",
    })
    const kept = await deliver(second, sam.address, "ada@example.org", withClassifier)
    expect(await stored(sam.id, kept)).toMatchObject({ folder: "inbox", spamScore: 1.5 })
  })
})

describe("auto-reply", () => {
  const away = {
    enabled: true,
    subject: "Away until Monday",
    body: "I'm out of the office.",
    startsAt: null,
    endsAt: null,
  }

  it("answers a person once a week, with RFC 3834 headers", async () => {
    const { sam } = await setup({ autoReply: away })
    await deliver(
      simpleMessage({
        to: sam.address,
        messageId: "<q1@example.org>",
        headers: auth("pass", "pass", "pass"),
      }),
      sam.address,
    )
    await deliver(simpleMessage({ to: sam.address, headers: auth("pass", "pass", "pass") }), sam.address)
    const sent = await outgoing(sam.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message).toMatchObject({
      from: { email: sam.address, name: "Sam" },
      to: [{ email: "ada@example.org" }],
      subject: "Away until Monday",
      text: "I'm out of the office.",
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        "In-Reply-To": "<q1@example.org>",
        References: "<q1@example.org>",
      },
    })
  })

  it.each([
    ["automated mail", { headers: "Auto-Submitted: auto-generated" }, "ada@example.org"],
    ["bulk mail", { headers: "Precedence: bulk" }, "ada@example.org"],
    ["another auto-reply", { headers: "Auto-Submitted: auto-replied" }, "ada@example.org"],
    ["a mailing list", { headers: "List-Id: Team <team.example.org>" }, "ada@example.org"],
    ["a bounce", {}, ""],
    ["a machine", { from: "MAILER-DAEMON@example.org" }, "mailer-daemon@example.org"],
    ["a no-reply sender", { from: "no-reply@example.org" }, "no-reply@example.org"],
    ["a Bcc copy", { to: "someone-else@example.org" }, "ada@example.org"],
  ] as const)("never answers %s", async (_, fields, envelopeFrom) => {
    const { sam } = await setup({ autoReply: away })
    await deliver(simpleMessage({ to: sam.address, ...fields }), sam.address, envelopeFrom)
    expect(await outgoing(sam.id)).toEqual([])
  })

  it("never answers spam, and stays quiet outside its dates", async () => {
    const { sam } = await setup({ autoReply: away })
    await deliver(simpleMessage({ to: sam.address, headers: auth("fail", "fail", "fail") }), sam.address)
    expect(await outgoing(sam.id)).toEqual([])
    const later = await setup({ autoReply: { ...away, startsAt: Date.now() + 86_400_000 } })
    await deliver(simpleMessage({ to: later.sam.address }), later.sam.address)
    expect(await outgoing(later.sam.id)).toEqual([])
  })
})

describe("forwarding", () => {
  it("forwards from the mailbox's own address, archives when not keeping a copy, and stops loops", async () => {
    const { sam } = await setup({
      forwarding: { enabled: true, to: ["me@elsewhere.example"], keepCopy: false },
    })
    const id = await deliver(
      simpleMessage({ to: sam.address, subject: "Invoice", body: "Please pay." }),
      sam.address,
    )
    expect((await stored(sam.id, id))?.folder).toBe("archive")
    const [forward] = await outgoing(sam.id)
    expect(forward?.message).toMatchObject({
      from: { email: sam.address },
      to: [{ email: "me@elsewhere.example" }],
      replyTo: { email: "ada@example.org" },
      subject: "Fwd: Invoice",
      headers: { "X-Mailyard-Forwarded": sam.id },
    })
    expect(forward?.message.text).toContain("---------- Forwarded message ---------")
    expect(forward?.message.text).toContain("Please pay.")

    // A message this mailbox already forwarded (it came back round) isn't forwarded again.
    await deliver(
      simpleMessage({
        to: sam.address,
        subject: "Looped",
        headers: `X-Mailyard-Forwarded: mbx_other, ${sam.id}`,
      }),
      sam.address,
    )
    expect(await outgoing(sam.id)).toHaveLength(1)
  })

  it("runs rule forwards and rule webhooks, once, even when filing is retried", async () => {
    const { sam, base } = await setup()
    const hook = await json<{ endpoint: { id: string } }>(
      await admin("/v1/webhooks", {
        method: "POST",
        json: { url: "https://hooks.test/rules", events: ["message.sent"] },
      }),
    )
    await call(`${base}/rules`, {
      method: "POST",
      key: owner.key,
      json: {
        name: "Escalate",
        conditions: [{ field: "subject", op: "contains", value: "urgent" }],
        actions: [
          { type: "forward", to: ["oncall@example.org"] },
          { type: "webhook", endpointId: hook.endpoint.id },
          { type: "star" },
        ],
      },
    })
    const raw = simpleMessage({
      to: sam.address,
      subject: "URGENT: site down",
      messageId: "<urgent@example.org>",
    })
    const id = await deliver(raw, sam.address)
    // The same message arriving again is a duplicate: no second forward, no second webhook.
    const again = await handleEmail(
      {
        from: "ada@example.org",
        to: sam.address,
        headers: new Headers(),
        raw: new Blob([raw]).stream(),
        rawSize: raw.byteLength,
        setReject: () => {},
      } as unknown as ForwardableEmailMessage,
      env,
    )
    expect(again).toEqual({ outcome: "duplicate", id })
    expect((await stored(sam.id, id))?.starred).toBe(true)
    const sent = await outgoing(sam.id)
    expect(sent.map((s) => s.recipient)).toEqual(["oncall@example.org"])
    const { results } = await env.DB.prepare(
      "select event_type, payload from webhook_deliveries where endpoint_id = ? and event_type = 'mail.rule_matched'",
    )
      .bind(hook.endpoint.id)
      .all<{ event_type: string; payload: string }>()
    expect(results).toHaveLength(1)
    expect(JSON.parse(results[0]?.payload ?? "{}").data).toMatchObject({
      id,
      mailboxId: sam.id,
      subject: "URGENT: site down",
    })
    await admin(`/v1/webhooks/${hook.endpoint.id}`, { method: "DELETE" })
  })
})

describe("/v1/mailboxes/{id}/rules", () => {
  it("creates, lists, edits, reorders, tests and deletes rules; owners only", async () => {
    const { sam, base } = await setup()
    const body = (name: string) => ({
      name,
      conditions: [{ field: "subject", op: "contains", value: name }],
      actions: [{ type: "archive" }],
    })
    expect((await call(`${base}/rules`, { method: "POST", key: member.key, json: body("x") })).status).toBe(
      403,
    )
    const a = await json<{ id: string; position: number }>(
      await call(`${base}/rules`, { method: "POST", key: owner.key, json: body("alpha") }),
    )
    const b = await json<{ id: string; position: number }>(
      await call(`${base}/rules`, { method: "POST", key: owner.key, json: body("beta") }),
    )
    expect([a.position, b.position]).toEqual([0, 1])
    expect(await json(await call(`${base}/rules`, { key: member.key }))).toMatchObject({
      rules: [{ name: "alpha" }, { name: "beta" }],
    })

    const reordered = await json<{ rules: Array<{ id: string }> }>(
      await call(`${base}/rules/order`, { method: "PUT", key: owner.key, json: { ruleIds: [b.id, a.id] } }),
    )
    expect(reordered.rules.map((r) => r.id)).toEqual([b.id, a.id])
    expect(
      (await call(`${base}/rules/order`, { method: "PUT", key: owner.key, json: { ruleIds: [b.id] } }))
        .status,
    ).toBe(400)

    expect(
      await json(
        await call(`${base}/rules/${a.id}`, {
          method: "PATCH",
          key: owner.key,
          json: { enabled: false, name: "Alpha" },
        }),
      ),
    ).toMatchObject({
      enabled: false,
      name: "Alpha",
    })

    const id = await deliver(simpleMessage({ to: sam.address, subject: "beta release" }), sam.address)
    const test = await json<{ matched: Array<{ name: string }>; outcome: { folder: string } }>(
      await call(`${base}/rules/test`, { method: "POST", key: member.key, json: { messageId: id } }),
    )
    expect(test.matched.map((m) => m.name)).toEqual(["beta"])
    expect(test.outcome.folder).toBe("archive")

    expect((await call(`${base}/rules/${a.id}`, { method: "DELETE", key: owner.key })).status).toBe(200)
    expect((await call(`${base}/rules/${a.id}`, { method: "DELETE", key: owner.key })).status).toBe(404)
  })

  it("refuses rules that can't work", async () => {
    const { sam, base } = await setup()
    const bad = async (rule: Record<string, unknown>) =>
      expect(
        (
          await call(`${base}/rules`, {
            method: "POST",
            key: owner.key,
            json: { name: "r", conditions: [], ...rule },
          })
        ).status,
      ).toBe(400)
    await bad({ actions: [] })
    await bad({ actions: [{ type: "label", labelId: "lbl_missing" }] })
    await bad({ actions: [{ type: "webhook", endpointId: "wh_missing" }] })
    await bad({ actions: [{ type: "forward", to: ["not-an-address"] }] })
    await bad({ actions: [{ type: "forward", to: [sam.address] }] })
    await bad({ actions: [{ type: "archive" }, { type: "trash" }] })
    await bad({
      actions: [{ type: "archive" }],
      conditions: [{ field: "subject", op: "matches", value: ".*" }],
    })
    await bad({ name: " ", actions: [{ type: "archive" }] })
  })
})

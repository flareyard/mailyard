import { env } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { delivery } from "../mailbox/deliveries.ts"

installDohFixture()

let reader = ""
let sender = { key: "", id: "" }
let viewer = { key: "", id: "" }
let publicKey = { key: "", id: "" }
beforeAll(async () => {
  reader = (await createKey("secret", ["read"])).key
  const s = await createKey("secret", ["send", "read"])
  sender = { key: s.key, id: s.apiKey.id }
  const v = await createKey("secret", ["send", "read"])
  viewer = { key: v.key, id: v.apiKey.id }
  const p = await createKey("public")
  publicKey = { key: p.key, id: p.apiKey.id }
})

const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, key: ADMIN })

let n = 0
const freshName = () => `d${++n}-${crypto.randomUUID().slice(0, 6)}.test`

const addDomain = async (body: Record<string, unknown> = {}) => {
  const name = (body.name as string | undefined) ?? freshName()
  const response = await admin("/v1/domains", { method: "POST", json: { name, ...body } })
  expect(response.status).toBe(200)
  return { name, ...(await json<{ id: string }>(response)) }
}

const addMailbox = async (body: Record<string, unknown>) => {
  const response = await admin("/v1/mailboxes", { method: "POST", json: body })
  if (response.status !== 200) throw new Error(`create mailbox: ${response.status} ${await response.text()}`)
  return await json<{ id: string; address: string }>(response)
}

describe("/v1/domains", () => {
  it("adds a domain, checks its DNS, and lists the records it needs", async () => {
    const name = freshName()
    setDns(goodDomain(name))
    const response = await admin("/v1/domains", {
      method: "POST",
      json: { name: `  ${name.toUpperCase()}. ` },
    })
    expect(response.status).toBe(200)
    const body = await json<{
      id: string
      name: string
      receiving: boolean
      sending: boolean
      catchAll: string
      checkStatus: string
      checks: Array<{ id: string; status: string }>
      expectedRecords: Array<{ type: string; name: string }>
    }>(response)
    expect(body).toMatchObject({
      name,
      receiving: true,
      sending: true,
      catchAll: "bounce",
      checkStatus: "pass",
    })
    expect(body.checks.map((c) => [c.id, c.status])).toEqual([
      ["mx", "pass"],
      ["spf", "pass"],
      ["dkim", "pass"],
      ["bounce-mx", "pass"],
      ["bounce-spf", "pass"],
      ["bounce-dkim", "pass"],
      ["dmarc", "pass"],
    ])
    expect(body.expectedRecords.filter((r) => r.type === "MX" && r.name === name)).toHaveLength(3)

    const list = await json<{ domains: Array<{ id: string; mailboxCount: number }> }>(
      await call("/v1/domains", { key: reader }),
    )
    expect(list.domains.find((d) => d.id === body.id)).toMatchObject({ mailboxCount: 0 })
  })

  it("reports a domain whose mail still goes elsewhere, and re-checks after the DNS changes", async () => {
    const name = freshName()
    setDns({
      [`MX ${name}`]: ["10 mx1.spacemail.com."],
      [`TXT ${name}`]: ["v=spf1 include:spf.spacemail.com ~all"],
    })
    const domain = await addDomain({ name, sending: false })
    const detail = await json<{
      checkStatus: string
      checks: Array<{ id: string; status: string; detail: string }>
    }>(await call(`/v1/domains/${domain.id}`, { key: reader }))
    expect(detail.checkStatus).toBe("fail")
    expect(detail.checks.find((c) => c.id === "mx")?.detail).toContain("mx1.spacemail.com")
    setDns(goodDomain(name))
    const rechecked = await json<{ checkStatus: string }>(
      await admin(`/v1/domains/${domain.id}/recheck`, { method: "POST" }),
    )
    expect(rechecked.checkStatus).toBe("pass")
  })

  it("refuses bad names, duplicates, and keeping unknown mail before a catch-all exists", async () => {
    expect((await admin("/v1/domains", { method: "POST", json: { name: "not a domain" } })).status).toBe(400)
    expect((await admin("/v1/domains", { method: "POST", json: { name: "localhost" } })).status).toBe(400)
    const domain = await addDomain()
    expect((await admin("/v1/domains", { method: "POST", json: { name: domain.name } })).status).toBe(409)
    expect(
      (await admin("/v1/domains", { method: "POST", json: { name: freshName(), catchAll: "keep" } })).status,
    ).toBe(400)
    expect(
      (await admin(`/v1/domains/${domain.id}`, { method: "PATCH", json: { catchAll: "keep" } })).status,
    ).toBe(400)
    await addMailbox({ address: `catchall@${domain.name}`, kind: "catch_all" })
    const kept = await admin(`/v1/domains/${domain.id}`, { method: "PATCH", json: { catchAll: "keep" } })
    expect(await json(kept)).toMatchObject({ catchAll: "keep" })
  })

  it("removes only an empty domain; needs admin to change anything", async () => {
    const domain = await addDomain()
    const box = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    expect((await admin(`/v1/domains/${domain.id}`, { method: "DELETE" })).status).toBe(409)
    expect(
      (await call("/v1/domains", { method: "POST", key: reader, json: { name: freshName() } })).status,
    ).toBe(403)
    expect((await call(`/v1/domains/${domain.id}`, { method: "DELETE", key: reader })).status).toBe(403)
    await admin(`/v1/mailboxes/${box.id}`, { method: "DELETE" })
    expect((await admin(`/v1/domains/${domain.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await admin(`/v1/domains/${domain.id}`)).status).toBe(404)
    const audit = await env.DB.prepare("select action from audit where target = ? order by at")
      .bind(domain.id)
      .all<{ action: string }>()
    expect(audit.results.map((r) => r.action)).toEqual(["domain.created", "domain.deleted"])
  })
})

describe("/v1/mailboxes", () => {
  it("creates every kind, and resolves alias and group targets in the detail", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `Sam@${domain.name}`, kind: "user", displayName: "Sam" })
    expect(sam.address).toBe(`sam@${domain.name}`)
    const support = await addMailbox({ address: `support@${domain.name}`, kind: "shared" })
    const hello = await addMailbox({ address: `hello@${domain.name}`, kind: "alias", targets: [sam.id] })
    const team = await addMailbox({
      address: `team@${domain.name}`,
      kind: "group",
      targets: [hello.id, support.id],
    })
    await addMailbox({ address: `catchall@${domain.name}`, kind: "catch_all" })

    const detail = await json<{
      targets: Array<{ address: string }>
      messageCount: number | null
      holdsMail: boolean
    }>(await call(`/v1/mailboxes/${team.id}`, { key: reader }))
    expect(detail).toMatchObject({ holdsMail: false, messageCount: null })
    expect(detail.targets.map((t) => t.address)).toEqual([`hello@${domain.name}`, `support@${domain.name}`])
    expect(await json(await call(`/v1/mailboxes/${sam.id}`, { key: reader }))).toMatchObject({
      holdsMail: true,
      messageCount: 0,
      lastExport: null,
      members: [],
      displayName: "Sam",
    })
    const listed = await json<{ mailboxes: Array<{ address: string }> }>(
      await call(`/v1/mailboxes?domainId=${domain.id}&kind=user`, { key: reader }),
    )
    expect(listed.mailboxes.map((m) => m.address)).toEqual([`sam@${domain.name}`])
  })

  it("refuses addresses and targets that can't work", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    const bad = async (body: Record<string, unknown>, status = 400) =>
      expect((await admin("/v1/mailboxes", { method: "POST", json: body })).status).toBe(status)
    await bad({ address: "no-at-sign", kind: "user" })
    await bad({ address: `.dot@${domain.name}`, kind: "user" })
    await bad({ address: `a..b@${domain.name}`, kind: "user" })
    await bad({ address: "sam@unknown-domain.test", kind: "user" })
    await bad({ address: `sam@${domain.name}`, kind: "user" }, 409)
    await bad({ address: `two@${domain.name}`, kind: "alias", targets: [sam.id, sam.id] })
    await bad({ address: `empty@${domain.name}`, kind: "group", targets: [] })
    await bad({ address: `ghost@${domain.name}`, kind: "alias", targets: ["mbx_missing"] })
    await bad({ address: `own@${domain.name}`, kind: "user", targets: [sam.id] })
    await addMailbox({ address: `catchall@${domain.name}`, kind: "catch_all" })
    await bad({ address: `catchall2@${domain.name}`, kind: "catch_all" }, 409)
    // A group of groups that never reaches a real mailbox.
    const lonely = await addMailbox({ address: `lonely@${domain.name}`, kind: "group", targets: [sam.id] })
    await admin(`/v1/mailboxes/${lonely.id}`, { method: "PATCH", json: { targets: [lonely.id] } }).then((r) =>
      expect(r.status).toBe(400),
    )
  })

  it("updates settings with validation; owners may change their own settings but not targets", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    const alias = await addMailbox({ address: `hi@${domain.name}`, kind: "alias", targets: [sam.id] })
    const patch = (key: string, id: string, body: unknown) =>
      call(`/v1/mailboxes/${id}`, { method: "PATCH", key, json: body })

    const autoReply = { enabled: true, subject: "Away", body: "Back Monday.", startsAt: 1000, endsAt: 2000 }
    const forwarding = { enabled: true, to: ["Me@Example.org"], keepCopy: true }
    const signature = { text: "— Sam", html: "<p>— Sam</p>" }
    const updated = await json(
      await patch(ADMIN, sam.id, { displayName: "Sam S", autoReply, forwarding, signature }),
    )
    expect(updated).toMatchObject({
      displayName: "Sam S",
      autoReply,
      signature,
      forwarding: { ...forwarding, to: ["me@example.org"] },
    })

    expect((await patch(ADMIN, sam.id, { autoReply: { ...autoReply, subject: " " } })).status).toBe(400)
    expect((await patch(ADMIN, sam.id, { autoReply: { ...autoReply, endsAt: 500 } })).status).toBe(400)
    expect((await patch(ADMIN, sam.id, { forwarding: { ...forwarding, to: ["nope"] } })).status).toBe(400)
    expect((await patch(ADMIN, sam.id, { forwarding: { ...forwarding, to: [sam.address] } })).status).toBe(
      400,
    )
    expect((await patch(ADMIN, sam.id, { targets: [alias.id] })).status).toBe(400)

    expect((await patch(sender.key, sam.id, { displayName: "Hijack" })).status).toBe(403)
    await call(`/v1/mailboxes/${sam.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: sender.id, role: "owner" }] },
    })
    expect(await json(await patch(sender.key, sam.id, { displayName: "Sam (owner edit)" }))).toMatchObject({
      displayName: "Sam (owner edit)",
    })
    expect((await patch(sender.key, alias.id, { targets: [sam.id] })).status).toBe(403)
  })

  it("sets members: active secret keys only", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    const put = (members: unknown) =>
      call(`/v1/mailboxes/${sam.id}/members`, { method: "PUT", key: ADMIN, json: { members } })
    const ok = await json<{ members: Array<{ apiKeyId: string; role: string }> }>(
      await put([
        { apiKeyId: sender.id, role: "member" },
        { apiKeyId: viewer.id, role: "viewer" },
      ]),
    )
    expect(ok.members.map((m) => m.role).sort()).toEqual(["member", "viewer"])
    expect((await put([{ apiKeyId: publicKey.id, role: "member" }])).status).toBe(400)
    expect((await put([{ apiKeyId: "key_missing", role: "member" }])).status).toBe(400)
    expect(
      (
        await put([
          { apiKeyId: sender.id, role: "member" },
          { apiKeyId: sender.id, role: "owner" },
        ])
      ).status,
    ).toBe(400)
    const revoked = await createKey("secret")
    await call(`/v1/api-keys/${revoked.apiKey.id}`, { method: "DELETE", key: ADMIN })
    expect((await put([{ apiKeyId: revoked.apiKey.id, role: "member" }])).status).toBe(400)
    expect(
      (await call(`/v1/mailboxes/${sam.id}/members`, { method: "PUT", key: reader, json: { members: [] } }))
        .status,
    ).toBe(403)
  })

  it("removes a mailbox holding mail only after a complete export, and erases its store", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    const alias = await addMailbox({ address: `hi@${domain.name}`, kind: "alias", targets: [sam.id] })
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(sam.id))
    await stub.deliver(delivery({ id: "inb_keepme" }))

    const referenced = await admin(`/v1/mailboxes/${sam.id}`, { method: "DELETE" })
    expect(referenced.status).toBe(409)
    // The danger sheet can say which aliases break (HAL-3376).
    expect(await json(referenced)).toMatchObject({
      reason: "alias-targets",
      aliasIds: [alias.id],
      message: expect.stringContaining(`hi@${domain.name}`),
    })
    expect((await admin(`/v1/mailboxes/${alias.id}`, { method: "DELETE" })).status).toBe(200)

    const unexported = await admin(`/v1/mailboxes/${sam.id}`, { method: "DELETE" })
    expect(unexported.status).toBe(409)
    expect(await json(unexported)).toMatchObject({
      reason: "no-recent-export",
      message: expect.stringContaining("holds 1 message"),
    })
    // An export taken before that mail arrived doesn't cover it.
    await env.DB.prepare(
      "insert into mailbox_exports (id, mailbox_id, status, format, r2_key, message_count, size, completed_at) values (?, ?, 'complete', 'mbox', 'exports/old.mbox', 0, 0, ?)",
    )
      .bind(`exp_${crypto.randomUUID()}`, sam.id, Date.now() - 86_400_000)
      .run()
    expect(await json(await admin(`/v1/mailboxes/${sam.id}`, { method: "DELETE" }))).toMatchObject({
      reason: "no-recent-export",
    })
    await env.DB.prepare(
      "insert into mailbox_exports (id, mailbox_id, status, format, r2_key, message_count, size, completed_at) values (?, ?, 'complete', 'mbox', 'exports/x.mbox', 1, 10, ?)",
    )
      .bind(`exp_${crypto.randomUUID()}`, sam.id, Date.now())
      .run()
    expect((await admin(`/v1/mailboxes/${sam.id}`, { method: "DELETE" })).status).toBe(200)
    expect(await stub.count()).toBe(0)
    expect((await admin(`/v1/mailboxes/${sam.id}`)).status).toBe(404)
  })

  it("keeps the catch-all while the domain keeps unknown mail", async () => {
    const domain = await addDomain()
    const catchAll = await addMailbox({ address: `catchall@${domain.name}`, kind: "catch_all" })
    await admin(`/v1/domains/${domain.id}`, { method: "PATCH", json: { catchAll: "keep" } })
    const kept = await admin(`/v1/mailboxes/${catchAll.id}`, { method: "DELETE" })
    expect(kept.status).toBe(409)
    expect(await json(kept)).toMatchObject({ reason: "catch-all-keeps" })
    await admin(`/v1/domains/${domain.id}`, { method: "PATCH", json: { catchAll: "bounce" } })
    expect((await admin(`/v1/mailboxes/${catchAll.id}`, { method: "DELETE" })).status).toBe(200)
  })
})

describe("/v1/identities", () => {
  it("lists every address for admin keys, and memberships and their aliases for others", async () => {
    const domain = await addDomain()
    const sam = await addMailbox({ address: `sam@${domain.name}`, kind: "user" })
    const other = await addMailbox({ address: `other@${domain.name}`, kind: "user" })
    await addMailbox({ address: `hi@${domain.name}`, kind: "alias", targets: [sam.id] })
    await call(`/v1/mailboxes/${sam.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: sender.id, role: "member" }] },
    })
    await call(`/v1/mailboxes/${other.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: viewer.id, role: "viewer" }] },
    })

    const forAdmin = await json<{
      identities: Array<{ address: string; via: string }>
      anyAddressOn: Array<string>
    }>(await call("/v1/identities", { key: ADMIN }))
    expect(forAdmin.identities.filter((i) => i.address.endsWith(domain.name)).map((i) => i.via)).toEqual([
      "admin",
      "admin",
      "admin",
    ])
    expect(forAdmin.anyAddressOn).toContain(domain.name)

    const forSender = await json<{
      identities: Array<{ address: string; via: string }>
      anyAddressOn: Array<string>
    }>(await call("/v1/identities", { key: sender.key }))
    expect(forSender.identities.filter((i) => i.address.endsWith(domain.name))).toEqual([
      expect.objectContaining({ address: `hi@${domain.name}`, via: "alias" }),
      expect.objectContaining({ address: `sam@${domain.name}`, via: "member" }),
    ])
    expect(forSender.anyAddressOn).toEqual([])

    const forViewer = await json<{ identities: Array<{ address: string }> }>(
      await call("/v1/identities", { key: viewer.key }),
    )
    expect(forViewer.identities.filter((i) => i.address.endsWith(domain.name))).toEqual([])
    expect((await call("/v1/identities", { key: reader })).status).toBe(403)
  })
})

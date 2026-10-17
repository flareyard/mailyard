import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"
import { delivery } from "./mailbox/deliveries.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)

type Workspace = {
  results: Array<{
    type: string
    id: string
    title: string
    subtitle: string | null
    url: string
    mailboxId?: string
  }>
  partial: Array<unknown>
}
type Mail = {
  groups: Array<{ mailboxId: string; hits: Array<{ subject: string }> }>
  searched: number
  partial: Array<unknown>
}

describe("search across the workspace (HAL-3363)", () => {
  it("searches every mailbox the caller can read, and only those", async () => {
    const tag = `zebra${uid()}`
    const domain = `ws-${uid()}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const mk = async (local: string) =>
      json<{ id: string; address: string }>(
        await call("/v1/mailboxes", {
          method: "POST",
          key: ADMIN,
          json: { address: `${local}@${domain}`, kind: "user" },
        }),
      )
    const sales = await mk("sales")
    const support = await mk("support")
    await env.MAILBOX.get(env.MAILBOX.idFromName(sales.id)).deliver(
      delivery({ messageId: `<s${uid()}@x>`, subject: `Quote ${tag}` }),
    )
    await env.MAILBOX.get(env.MAILBOX.idFromName(support.id)).deliver(
      delivery({ messageId: `<t${uid()}@x>`, subject: `Ticket ${tag}` }),
    )
    const member = await createKey("secret", ["read"])
    await call(`/v1/mailboxes/${sales.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: { members: [{ apiKeyId: member.apiKey.id, role: "viewer" }] },
    })

    const all = await json<Mail>(await call(`/v1/search/mail?q=${tag}`, { key: ADMIN }))
    const mine = all.groups.filter((g) => g.mailboxId === sales.id || g.mailboxId === support.id)
    expect(mine.map((g) => g.hits[0]?.subject).sort()).toEqual([`Quote ${tag}`, `Ticket ${tag}`])
    expect(all.partial).toEqual([])
    const theirs = await json<Mail>(await call(`/v1/search/mail?q=${tag}`, { key: member.key }))
    expect(theirs.groups.map((g) => g.mailboxId)).toEqual([sales.id])
    expect(theirs.searched).toBe(1)

    // The palette, threads included, by the same access.
    const palette = await json<Workspace>(await call(`/v1/search?q=${tag}&types=thread`, { key: member.key }))
    expect(palette.results.map((r) => r.title)).toEqual([`Quote ${tag}`])
    expect(palette.results[0]).toMatchObject({ type: "thread", mailboxId: sales.id })
    expect(palette.results[0]?.url).toContain(`/mail/${sales.id}/threads/`)
  })

  it("finds contacts by email prefix, campaigns, templates, mailboxes and domains", async () => {
    const tag = `quokka${uid()}`
    await call("/v1/contacts", {
      method: "POST",
      key: ADMIN,
      json: { email: `${tag}@example.net`, name: "Quinn Okka" },
    })
    const domain = `${tag}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `${tag}@${domain}`, kind: "user" },
    })
    await call("/v1/campaigns", {
      method: "POST",
      key: ADMIN,
      json: { name: `Launch ${tag}`, subject: "Hi", fromAddress: `news@${domain}` },
    })
    await call("/v1/templates", {
      method: "POST",
      key: ADMIN,
      json: { name: `Welcome ${tag}`, kind: "html", subject: "Hi", source: "<p>Hi</p>" },
    })
    const found = await json<Workspace>(await call(`/v1/search?q=${tag}`, { key: ADMIN }))
    const types = new Set(found.results.map((r) => r.type))
    for (const t of ["contact", "mailbox", "domain", "campaign", "template"]) expect(types, t).toContain(t)
    expect(found.results.find((r) => r.type === "contact")).toMatchObject({
      title: "Quinn Okka",
      subtitle: `${tag}@example.net`,
    })

    const only = await json<Workspace>(await call(`/v1/search?q=${tag}&types=contact,domain`, { key: ADMIN }))
    expect([...new Set(only.results.map((r) => r.type))].sort()).toEqual(["contact", "domain"])
    expect((await call(`/v1/search?q=${tag}&types=planet`, { key: ADMIN })).status).toBe(400)
    expect((await json<Workspace>(await call("/v1/search?q=%20", { key: ADMIN }))).results).toEqual([])

    // Keys without the read scope see no workspace records; public keys can't search.
    const sender = await createKey("secret", ["send"])
    const blind = await json<Workspace>(await call(`/v1/search?q=${tag}`, { key: sender.key }))
    expect(blind.results).toEqual([])
    // The contact prefix is an index range, not a scan of every contact.
    const plan = await env.DB.prepare(
      "explain query plan select id from contacts where email >= ? and email < ? order by email limit 5",
    )
      .bind("a", "a\uffff")
      .all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(/USING (COVERING )?INDEX contacts_email/)
    const pub = await createKey("public")
    expect((await call(`/v1/search?q=${tag}`, { key: pub.key })).status).toBe(403)
  })
})

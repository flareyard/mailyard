import { introspectWorkflowInstance } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { pickWinner } from "../../src/campaigns/send.ts"
import { classify, instrument } from "../../src/tracking/track.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

/** The pre-flight link check fetches every link; here every host but DoH answers 200. */
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(new Request(input, init).url).hostname
  return host === "cloudflare-dns.com" ? realFetch(input, init) : new Response(null, { status: 200 })
}) as typeof fetch

const uid = () => crypto.randomUUID().slice(0, 8)
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"

describe("tracking rules", () => {
  it("tells people from machines", () => {
    const base = { ip: "203.0.113.5", sentAt: 0, at: 3_600_000, humanOpenSeen: false }
    expect(classify({ ...base, kind: "open", userAgent: GMAIL_PROXY })).toBe("human")
    expect(classify({ ...base, kind: "open", userAgent: CHROME })).toBe("human")
    // Apple Mail Privacy Protection: a bare UA, or Apple's own network.
    expect(classify({ ...base, kind: "open", userAgent: "Mozilla/5.0" })).toBe("machine")
    expect(classify({ ...base, kind: "open", userAgent: CHROME, ip: "17.58.0.1" })).toBe("machine")
    expect(classify({ ...base, kind: "open", userAgent: CHROME, at: 1_000 })).toBe("machine")
    expect(classify({ ...base, kind: "click", userAgent: "Mimecast Security Scanner" })).toBe("machine")
    // A click seconds after sending, with no open first, is a scanner; after an open it's a person.
    expect(classify({ ...base, kind: "click", userAgent: CHROME, at: 5_000 })).toBe("machine")
    expect(classify({ ...base, kind: "click", userAgent: CHROME, at: 5_000, humanOpenSeen: true })).toBe(
      "human",
    )
  })

  it("rewrites links through the redirect, but never the unsubscribe links, and adds the pixel", async () => {
    const message = {
      from: { email: "a@b.co" },
      to: [{ email: "c@d.co" }] as [{ email: string }],
      subject: "s",
      html: `<html><body><a href="https://shop.test/a?x=1&amp;y=2">a</a> <a href='https://shop.test/b'>b</a> <a href="https://api.test/u/tok">unsub</a> <a href="mailto:x@y.z">m</a></body></html>`,
    }
    const out = await runtimeFor(env).runPromise(
      instrument(message, { messageId: "m1", origin: "https://api.test", opens: true, clicks: true }),
    )
    expect(out.html).toMatch(/href="https:\/\/api\.test\/t\/c\/[^"]+">a<\/a>/)
    expect(out.html).toMatch(/href='https:\/\/api\.test\/t\/c\/[^']+'>b<\/a>/)
    expect(out.html).toContain('href="https://api.test/u/tok"')
    expect(out.html).toContain('href="mailto:x@y.z"')
    expect(out.html).toMatch(/<img src="https:\/\/api\.test\/t\/o\/[^"]+\.gif"[^>]*><\/body>/)
    const none = await runtimeFor(env).runPromise(
      instrument(message, { messageId: "m1", origin: "https://api.test", opens: false, clicks: false }),
    )
    expect(none.html).toBe(message.html)
  })
})

const pathOf = (url: string | undefined) => (url ? new URL(url).pathname : "")

/** A tracked campaign sent to `n` subscribers, sleeps disabled; returns its messages. */
const sendTracked = async (n: number, extra: Record<string, unknown> = {}) => {
  const domain = `trk-${uid()}.test`
  setDns(goodDomain(domain))
  await call("/v1/domains", {
    method: "POST",
    key: ADMIN,
    json: { name: domain, sending: true, receiving: false },
  })
  await env.SEND_GOVERNOR.get(env.SEND_GOVERNOR.idFromName("account")).configure({
    dailyQuota: 100_000,
    establishedDomains: [domain],
  })
  const topic = await json<{ id: string }>(
    await call("/v1/topics", {
      method: "POST",
      key: ADMIN,
      json: { name: `T ${uid()}`, doubleOptIn: false },
    }),
  )
  for (let i = 0; i < n; i++) {
    const c = await json<{ id: string }>(
      await call("/v1/contacts", {
        method: "POST",
        key: ADMIN,
        json: { email: `t${i}-${uid()}@example.net` },
      }),
    )
    await call(`/v1/contacts/${c.id}/topics/${topic.id}`, {
      method: "PUT",
      key: ADMIN,
      json: { state: "subscribed" },
    })
  }
  const campaign = await json<{ id: string }>(
    await call("/v1/campaigns", {
      method: "POST",
      key: ADMIN,
      json: {
        name: "Tracked",
        fromAddress: `news@${domain}`,
        subject: "A",
        bodyHtml: '<html><body><a href="https://shop.test/sale">Sale</a></body></html>',
        topicId: topic.id,
        ...extra,
      },
    }),
  )
  await using instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `campaign-${campaign.id}`)
  await instance.modify(async (m) => {
    await m.disableSleeps()
  })
  const scheduled = await call(`/v1/campaigns/${campaign.id}/schedule`, {
    method: "POST",
    key: ADMIN,
    json: {},
  })
  if (scheduled.status !== 200) throw new Error(`schedule: ${await scheduled.text()}`)
  for (let i = 0; i < 100; i++) {
    const st = await (await env.CAMPAIGN_WORKFLOW.get(`campaign-${campaign.id}`)).status()
    if (st.status === "errored") throw new Error(`workflow errored: ${JSON.stringify(st).slice(0, 800)}`)
    if (st.status === "complete") break
    await new Promise((r) => setTimeout(r, 200))
  }
  await instance.waitForStatus("complete")
  // As if sent an hour ago, so hits now aren't mistaken for prefetches.
  await env.DB.prepare("update messages_out set created_at = created_at - 3600000 where campaign_id = ?")
    .bind(campaign.id)
    .run()
  const rows = await env.DB.prepare(
    "select id, contact_id, rendered_key, variant from messages_out where campaign_id = ? and stream = 'campaign'",
  )
    .bind(campaign.id)
    .all<{ id: string; contact_id: string; rendered_key: string; variant: string | null }>()
  const out = []
  for (const r of rows.results) {
    const { html } = ((await (await env.STORE.get(r.rendered_key))?.json()) ?? { html: "" }) as {
      html: string
    }
    out.push({
      ...r,
      pixel: pathOf(/<img src="([^"]+)"/.exec(html)?.[1]),
      click: pathOf(/href="(https:\/\/mailyard\.test\/t\/c\/[^"]+)"/.exec(html)?.[1]),
    })
  }
  return { campaignId: campaign.id, messages: out }
}

const stats = (id: string) =>
  env.DB.prepare(
    "select tracked, opens, clicks, machine_opens, machine_clicks, first_opened_at, first_clicked_at from messages_out where id = ?",
  )
    .bind(id)
    .first<{
      tracked: number
      opens: number
      clicks: number
      machine_opens: number
      machine_clicks: number
      first_opened_at: number | null
      first_clicked_at: number | null
    }>()

describe("tracked campaign mail", () => {
  it("counts a person's open and click, keeps machines apart, and never redirects a forged link", async () => {
    const { campaignId, messages } = await sendTracked(1)
    const m = messages[0]
    if (!m) throw new Error("no message")
    expect((await stats(m.id))?.tracked).toBe(1)

    const proxy = await call(m.pixel, { headers: { "user-agent": "Mozilla/5.0" } })
    expect(proxy.status).toBe(200)
    expect(proxy.headers.get("content-type")).toBe("image/gif")
    expect(proxy.headers.get("cache-control")).toContain("no-store")
    expect((await proxy.arrayBuffer()).byteLength).toBe(43)
    await call(m.pixel, { headers: { "user-agent": GMAIL_PROXY } })
    // The open is recorded after the response; give it a moment.
    await new Promise((r) => setTimeout(r, 300))
    let s = await stats(m.id)
    expect(s).toMatchObject({ opens: 1, machine_opens: 1 })
    expect(s?.first_opened_at).not.toBeNull()

    const head = await call(m.click, { method: "HEAD", redirect: "manual" })
    expect(head.status).toBe(302)
    const scanner = await call(m.click, {
      headers: { "user-agent": "Proofpoint URL Defense" },
      redirect: "manual",
    })
    expect(scanner.headers.get("location")).toBe("https://shop.test/sale")
    const person = await call(m.click, { headers: { "user-agent": CHROME }, redirect: "manual" })
    expect(person.status).toBe(302)
    expect(person.headers.get("location")).toBe("https://shop.test/sale")
    s = await stats(m.id)
    expect(s).toMatchObject({ clicks: 1, machine_clicks: 1 })
    expect(s?.first_clicked_at).not.toBeNull()

    const contact = await json<{
      lastOpenedAt: number | null
      lastClickedAt: number | null
      engagement: string
    }>(await call(`/v1/contacts/${m.contact_id}`, { key: ADMIN }))
    expect(contact.lastClickedAt).not.toBeNull()
    expect(contact.engagement).toBe("active")
    const firsts = await env.DB.prepare(
      "select name from events where contact_id = ? and name in ('email.opened', 'email.clicked') order by name",
    )
      .bind(m.contact_id)
      .all<{ name: string }>()
    expect(firsts.results.map((r) => r.name)).toEqual(["email.clicked", "email.opened"])

    // The message log shows it all; segments can find who clicked.
    const logged = await json<{
      opens: number
      clicks: number
      machineOpens: number
      machineClicks: number
      tracked: boolean
    }>(await call(`/v1/messages/${m.id}`, { key: ADMIN }))
    expect(logged).toMatchObject({ tracked: true, opens: 1, clicks: 1, machineOpens: 1, machineClicks: 1 })
    const clicked = await json<{ count: number }>(
      await call("/v1/segments/preview", {
        method: "POST",
        key: ADMIN,
        json: { filter: { type: "campaign", campaignId, activity: "clicked" } },
      }),
    )
    expect(clicked.count).toBe(1)

    // Forged and edited tokens.
    expect((await call(`${m.click.slice(0, -4)}AAAA`, { redirect: "manual" })).status).toBe(404)
    expect(
      (
        await call("/t/c/eyJtIjoieCIsImsiOjAsInUiOiJodHRwczovL2V2aWwudGVzdCJ9.AAAAAAAAAAAAAAAAAAAAAA", {
          redirect: "manual",
        })
      ).status,
    ).toBe(404)
    // A broken pixel token still answers with the image.
    expect((await call("/t/o/nonsense.gif")).headers.get("content-type")).toBe("image/gif")
  }, 60_000)

  it("doesn't track a campaign with tracking switched off", async () => {
    const { messages } = await sendTracked(1, { trackOpens: false, trackClicks: false })
    const m = messages[0]
    if (!m) throw new Error("no message")
    expect((await stats(m.id))?.tracked).toBe(0)
  }, 60_000)

  it("picks an A/B winner on opens when that's the metric", async () => {
    const { campaignId, messages } = await sendTracked(6, {
      subjectB: "B",
      ab: { percent: 50, waitHours: 1, metric: "opens" },
    })
    for (const m of messages.filter((x) => x.variant === "b"))
      await call(m.pixel, { headers: { "user-agent": GMAIL_PROXY } })
    await new Promise((r) => setTimeout(r, 300))
    const result = await runtimeFor(env).runPromise(pickWinner(campaignId))
    expect(result.metric).toBe("opens")
    expect(result.winner).toBe("b")
  }, 60_000)
})

describe("tracked transactional mail and the tracking check", () => {
  it("tracks a transactional send only when asked", async () => {
    const send = async (track?: Record<string, boolean>) => {
      const r = await json<{ data: { emails: Array<{ email: string }> } }>(
        await call("/v1/send", {
          method: "POST",
          key: ADMIN,
          json: {
            to: `tx-${uid()}@example.net`,
            from: "hi@mailyard.test",
            subject: "Code",
            body: '<p><a href="https://shop.test/x">x</a></p>',
            ...(track ? { track } : {}),
          },
        }),
      )
      return r.data.emails[0]?.email ?? ""
    }
    const plain = await send()
    expect((await stats(plain))?.tracked).toBe(0)
    const tracked = await send({ clicks: true })
    expect((await stats(tracked))?.tracked).toBe(1)
    const key = await env.DB.prepare("select rendered_key from messages_out where id = ?")
      .bind(tracked)
      .first<{ rendered_key: string }>()
    const { html } = ((await (await env.STORE.get(key?.rendered_key ?? ""))?.json()) ?? { html: "" }) as {
      html: string
    }
    expect(html).toContain("/t/c/")
    expect(html).not.toContain("/t/o/")
  })

  it("warns when tracked links leave the sender's domain, and passes on its own subdomain", async () => {
    const domain = `chk-${uid()}.test`
    setDns(goodDomain(domain))
    await call("/v1/domains", {
      method: "POST",
      key: ADMIN,
      json: { name: domain, sending: true, receiving: false },
    })
    const campaign = await json<{ id: string }>(
      await call("/v1/campaigns", {
        method: "POST",
        key: ADMIN,
        json: { name: "C", fromAddress: `news@${domain}`, subject: "S", bodyHtml: "<p>Hi</p>" },
      }),
    )
    const tracking = async () =>
      (
        await json<{ checks: Array<{ id: string; status: string }> }>(
          await call(`/v1/campaigns/${campaign.id}/checks`, { key: ADMIN }),
        )
      ).checks.find((c) => c.id === "tracking")?.status
    expect(await tracking()).toBe("warn")
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: {
        postalAddress: null,
        linkAllowlist: [],
        seedAddresses: [],
        trackingOrigin: `https://links.${domain}`,
      },
    })
    expect(await tracking()).toBe("pass")
    await call("/v1/settings/compliance", {
      method: "PUT",
      key: ADMIN,
      json: { postalAddress: null, linkAllowlist: [], seedAddresses: [], trackingOrigin: null },
    })
  })
})

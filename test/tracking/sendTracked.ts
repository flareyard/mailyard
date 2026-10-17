import { introspectWorkflowInstance } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { goodDomain, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

const uid = () => crypto.randomUUID().slice(0, 8)

const pathOf = (url: string | undefined) => (url ? new URL(url).pathname : "")

/** A tracked campaign sent to `n` subscribers, sleeps disabled; returns its messages. */
export const sendTracked = async (n: number, extra: Record<string, unknown> = {}) => {
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
    "select id, contact_id, cf_message_id, rendered_key, variant from messages_out where campaign_id = ? and stream = 'campaign'",
  )
    .bind(campaign.id)
    .all<{
      id: string
      contact_id: string
      cf_message_id: string | null
      rendered_key: string
      variant: string | null
    }>()
  const out = []
  for (const r of rows.results) {
    const { html } = ((await (await env.STORE.get(r.rendered_key))?.json()) ?? { html: "" }) as {
      html: string
    }
    out.push({
      ...r,
      pixel: pathOf(/<img src="([^"]+)"/.exec(html)?.[1]),
      click: pathOf(/href="(https:\/\/mailyard\.test\/t\/c\/[^"]+)"/.exec(html)?.[1]),
      links: [...html.matchAll(/href="(https:\/\/mailyard\.test\/t\/c\/[^"]+)"/g)].map((x) => pathOf(x[1])),
    })
  }
  return { campaignId: campaign.id, messages: out }
}

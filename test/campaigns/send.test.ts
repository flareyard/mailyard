import { introspectWorkflowInstance } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { nextMidnight } from "../../src/campaigns/governor.ts"
import { pickWinner, sendChunk } from "../../src/campaigns/send.ts"
import { runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const governor = () => env.SEND_GOVERNOR.get(env.SEND_GOVERNOR.idFromName("account"))

/** A sending domain, a topic, and `n` subscribed contacts on it, written straight to D1. */
const audience = async (n: number, opts: { quota?: number } = {}) => {
  const domain = `send-${uid()}.test`
  setDns(goodDomain(domain))
  await call("/v1/domains", {
    method: "POST",
    key: ADMIN,
    json: { name: domain, sending: true, receiving: false },
  })
  await governor().configure({
    dailyQuota: opts.quota ?? 100_000,
    transactionalReserve: 0,
    providerPerMinute: { gmail: 100_000, microsoft: 100_000, yahoo: 100_000, apple: 100_000, other: 100_000 },
    establishedDomains: [domain],
  })
  const topic = await json<{ id: string }>(
    await call("/v1/topics", {
      method: "POST",
      key: ADMIN,
      json: { name: `Send ${uid()}`, doubleOptIn: false },
    }),
  )
  const tag = uid()
  const statements: Array<D1PreparedStatement> = []
  for (let i = 0; i < n; i++) {
    const id = `c_${tag}_${String(i).padStart(5, "0")}`
    statements.push(
      env.DB.prepare(
        "insert into contacts (id, email, name, fields, status) values (?, ?, ?, ?, 'subscribed')",
      ).bind(id, `p${i}-${tag}@example.net`, `Person ${i}`, JSON.stringify({ tag })),
      env.DB.prepare(
        "insert into subscriptions (contact_id, topic_id, state, source, changed_at) values (?, ?, 'subscribed', 'seed', ?)",
      ).bind(id, topic.id, Date.now()),
    )
  }
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
  return { domain, topicId: topic.id, tag }
}

const createCampaign = async (body: Record<string, unknown>) => {
  const response = await call("/v1/campaigns", { method: "POST", key: ADMIN, json: body })
  if (response.status !== 200) throw new Error(`campaign: ${response.status} ${await response.text()}`)
  return json<{ id: string }>(response)
}

const campaignRow = (id: string) =>
  env.DB.prepare(
    "select status, audience_size, started_at, finished_at, ab_winner, template_version from campaigns where id = ?",
  )
    .bind(id)
    .first<{
      status: string
      audience_size: number
      started_at: number | null
      finished_at: number | null
      ab_winner: string | null
      template_version: number | null
    }>()

/**
 * Waits until the instance has recorded `n` step results. Locally a sleeping or event-waiting
 * instance reports "running", so step progress is what shows it reached the wait.
 */
const untilSteps = async (campaignId: string, n: number) => {
  for (let i = 0; i < 200; i++) {
    const handle = await env.CAMPAIGN_WORKFLOW.get(`campaign-${campaignId}`)
    const status = (await handle.status()) as { __LOCAL_DEV_STEP_OUTPUTS?: Array<unknown> }
    if ((status.__LOCAL_DEV_STEP_OUTPUTS?.length ?? 0) >= n) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`instance never reached ${n} steps`)
}

const messages = async (campaignId: string) =>
  (
    await env.DB.prepare(
      "select contact_id, subject, variant, rendered_key from messages_out where campaign_id = ? and stream = 'campaign'",
    )
      .bind(campaignId)
      .all<{ contact_id: string; subject: string; variant: string | null; rendered_key: string }>()
  ).results

describe("CampaignSend", () => {
  it("spreads an audience over the daily quota, one day at a time, with no duplicate", async () => {
    const { domain, topicId } = await audience(250, { quota: 100 })
    const campaign = await createCampaign({
      name: "Big",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    await using instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `campaign-${campaign.id}`)
    await instance.modify(async (m) => {
      await m.disableSleeps()
    })
    const today = Date.now()
    expect(
      (await call(`/v1/campaigns/${campaign.id}/schedule`, { method: "POST", key: ADMIN, json: {} })).status,
    ).toBe(200)
    await instance.waitForStatus("complete")
    const sent = await messages(campaign.id)
    expect(sent).toHaveLength(250)
    expect(new Set(sent.map((m) => m.contact_id)).size).toBe(250)
    // Each UTC day got its quota's worth and no more: 100, 100, then the last 50.
    const day = async (at: number) => (await governor().overview({ now: at })).sent.campaign
    expect(await day(today)).toBe(100)
    expect(await day(nextMidnight(today) + 1)).toBe(100)
    expect(await day(nextMidnight(nextMidnight(today) + 1) + 1)).toBe(50)
    expect(await campaignRow(campaign.id)).toMatchObject({ status: "sent", audience_size: 250 })
  }, 120_000)

  it("sends the template version frozen at scheduling, with unsubscribe headers on every message", async () => {
    const { domain, topicId } = await audience(5)
    const template = await json<{ id: string }>(
      await call("/v1/templates", {
        method: "POST",
        key: ADMIN,
        json: { name: `Frozen ${uid()}`, kind: "html", subject: "x", source: "<p>Version one, {{name}}</p>" },
      }),
    )
    await call(`/v1/templates/${template.id}/publish`, { method: "POST", key: ADMIN })
    const campaign = await createCampaign({
      name: "Frozen",
      fromAddress: `News <news@${domain}>`,
      subject: "News",
      templateId: template.id,
      topicId,
    })
    await using instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `campaign-${campaign.id}`)
    await instance.modify(async (m) => {
      await m.disableSleeps()
    })
    await call(`/v1/campaigns/${campaign.id}/schedule`, {
      method: "POST",
      key: ADMIN,
      json: { sendAt: Date.now() + 3_600_000 },
    })
    // Version two is published after scheduling; the campaign still sends version one.
    await call(`/v1/templates/${template.id}/draft`, {
      method: "PUT",
      key: ADMIN,
      json: { subject: "x", source: "<p>Version two</p>" },
    })
    await call(`/v1/templates/${template.id}/publish`, { method: "POST", key: ADMIN })
    await instance.waitForStatus("complete")
    const sent = await messages(campaign.id)
    expect(sent).toHaveLength(5)
    const stored = (await (await env.STORE.get(sent[0]?.rendered_key ?? ""))?.json()) as {
      html: string
      headers: Record<string, string>
    }
    expect(stored.html).toContain("Version one")
    expect(stored.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(stored.headers["List-Id"]).toContain(`.${domain}>`)
    expect(await campaignRow(campaign.id)).toMatchObject({ status: "sent", template_version: 1 })
  }, 60_000)

  it("waits while paused and carries on when resumed", async () => {
    const { domain, topicId } = await audience(3)
    const campaign = await createCampaign({
      name: "Pause",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    await using instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `campaign-${campaign.id}`)
    await instance.modify(async (m) => {
      await m.disableSleeps()
      // As if the governor paused it at the first chunk.
      await m.mockStepResult({ name: "send main 0.0" }, { state: "paused", sent: 0, skipped: 0 })
    })
    await call(`/v1/campaigns/${campaign.id}/schedule`, { method: "POST", key: ADMIN, json: {} })
    // plan, one snapshot page, then the mocked paused chunk: now it waits for the resume event.
    await untilSteps(campaign.id, 3)
    await env.DB.prepare("update campaigns set status = 'paused' where id = ?").bind(campaign.id).run()
    expect(await messages(campaign.id)).toHaveLength(0)
    const resumed = await json<{ status: string }>(
      await call(`/v1/campaigns/${campaign.id}/resume`, { method: "POST", key: ADMIN }),
    )
    expect(resumed.status).toBe("sending")
    await instance.waitForStatus("complete")
    expect(await messages(campaign.id)).toHaveLength(3)
  }, 60_000)

  it("cancels a campaign waiting for its time, and nothing goes out", async () => {
    const { domain, topicId } = await audience(3)
    const campaign = await createCampaign({
      name: "Cancel",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    // No introspection here: disposing it waits on an instance that is never going to finish.
    await call(`/v1/campaigns/${campaign.id}/schedule`, {
      method: "POST",
      key: ADMIN,
      json: { sendAt: Date.now() + 3_600_000 },
    })
    // The plan step is done, so it is asleep until the send time.
    await untilSteps(campaign.id, 1)
    const cancelled = await json<{ status: string }>(
      await call(`/v1/campaigns/${campaign.id}/cancel`, { method: "POST", key: ADMIN }),
    )
    expect(cancelled.status).toBe("cancelled")
    // The introspection helper doesn't settle on "terminated"; the instance's own status does.
    const handle = await env.CAMPAIGN_WORKFLOW.get(`campaign-${campaign.id}`)
    for (let i = 0; i < 100 && (await handle.status()).status !== "terminated"; i++)
      await new Promise((r) => setTimeout(r, 100))
    expect((await handle.status()).status).toBe("terminated")
    expect(await messages(campaign.id)).toHaveLength(0)
    expect((await call(`/v1/campaigns/${campaign.id}/cancel`, { method: "POST", key: ADMIN })).status).toBe(
      409,
    )
  }, 60_000)

  it("A/B tests the subject on a slice spread over the audience, then sends the rest the winner", async () => {
    const { domain, topicId } = await audience(20)
    const campaign = await createCampaign({
      name: "AB",
      fromAddress: `news@${domain}`,
      subject: "Subject A",
      subjectB: "Subject B",
      ab: { percent: 50, waitHours: 2, metric: "clicks" },
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    await using instance = await introspectWorkflowInstance(env.CAMPAIGN_WORKFLOW, `campaign-${campaign.id}`)
    await instance.modify(async (m) => {
      await m.disableSleeps()
    })
    await call(`/v1/campaigns/${campaign.id}/schedule`, { method: "POST", key: ADMIN, json: {} })
    await instance.waitForStatus("complete")
    const sent = await messages(campaign.id)
    expect(sent).toHaveLength(20)
    const count = (v: string, s: string) => sent.filter((m) => m.variant === v && m.subject === s).length
    // 10 in the test (5 each), and with no clicks yet the tie goes to A for the other 10.
    expect(count("b", "Subject B")).toBe(5)
    expect(count("a", "Subject A")).toBe(15)
    expect((await campaignRow(campaign.id))?.ab_winner).toBe("a")
  }, 60_000)

  it("picks the subject with more clicks", async () => {
    const id = `cmp_win_${uid()}`
    await env.DB.prepare(
      "insert into campaigns (id, name, from_address, subject, status) values (?, 'W', 'a@b.co', 'A', 'sending')",
    )
      .bind(id)
      .run()
    for (const [i, variant, clicked] of [
      [1, "a", true],
      [2, "b", true],
      [3, "b", true],
      [4, "a", false],
    ] as const) {
      await env.DB.prepare(
        "insert into messages_out (id, stream, campaign_id, recipient, sender, subject, status, variant, first_clicked_at) values (?, 'campaign', ?, ?, 'a@b.co', 'S', 'delivered', ?, ?)",
      )
        .bind(`${id}_${i}`, id, `r${i}@example.net`, variant, clicked ? Date.now() : null)
        .run()
    }
    const result = await runtimeFor(env).runPromise(pickWinner(id))
    expect(result).toEqual({ winner: "b", metric: "clicks", tally: { a: 1, b: 2 } })
    expect((await campaignRow(id))?.ab_winner).toBe("b")
  })

  it("skips anyone who stopped being eligible after the snapshot, and never sends twice", async () => {
    const { domain, topicId, tag } = await audience(4)
    const campaign = await createCampaign({
      name: "Elig",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    await env.DB.prepare("update campaigns set status = 'sending' where id = ?").bind(campaign.id).run()
    const ids = [0, 1, 2, 3].map((i) => `c_${tag}_${String(i).padStart(5, "0")}`)
    const chunk = ids.map((contactId) => ({ contactId, domain: "example.net", variant: null }))
    await env.STORE.put(`campaigns/${campaign.id}/audience/main/0.json`, JSON.stringify(chunk))
    await env.DB.prepare("update contacts set status = 'unsubscribed' where id = ?").bind(ids[1]).run()
    await env.DB.prepare("update subscriptions set state = 'unsubscribed' where contact_id = ?")
      .bind(ids[2])
      .run()
    const run = () =>
      runtimeFor(env).runPromise(
        sendChunk(campaign.id, "main", 0, { origin: "https://mailyard.test", notBefore: 0 }),
      )
    expect(await run()).toEqual({ state: "done", sent: 2, skipped: 2 })
    expect(await run()).toEqual({ state: "done", sent: 0, skipped: 2 })
    expect((await messages(campaign.id)).map((m) => m.contact_id).sort()).toEqual([ids[0], ids[3]])
  })

  it("leaves out excluded segments at send time, even ones binding 80 values beside a full chunk", async () => {
    const { domain, topicId, tag } = await audience(85)
    const segment = async (name: string, filter: unknown) =>
      json<{ id: string }>(await call("/v1/segments", { method: "POST", key: ADMIN, json: { name, filter } }))
    const everyone = await segment(`All ${tag}`, { type: "field", field: "tag", op: "eq", value: tag })
    // Two lists of 40 addresses, one of them in the audience: the lookup binds 82 parameters before
    // any contact id, which with the old fixed slice of 80 ids went past D1's 100.
    const list = (name: string, first: string) =>
      segment(name, {
        type: "field",
        field: "email",
        op: "in",
        value: [first, ...Array.from({ length: 39 }, (_, i) => `${name}-${i}@example.net`)],
      })
    const listed = await list(`listed-${tag}`, `p0-${tag}@example.net`)
    const other = await list(`other-${tag}`, `nobody-${tag}@example.net`)
    const campaign = await createCampaign({
      name: "Excl",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
      segmentId: everyone.id,
      exclude: { segmentIds: [listed.id, other.id], recentlySentDays: null },
    })
    await env.DB.prepare("update campaigns set status = 'sending' where id = ?").bind(campaign.id).run()
    const ids = Array.from({ length: 85 }, (_, i) => `c_${tag}_${String(i).padStart(5, "0")}`)
    const chunk = ids.map((contactId) => ({ contactId, domain: "example.net", variant: null }))
    await env.STORE.put(`campaigns/${campaign.id}/audience/main/0.json`, JSON.stringify(chunk))
    const result = await runtimeFor(env).runPromise(
      sendChunk(campaign.id, "main", 0, { origin: "https://mailyard.test", notBefore: 0 }),
    )
    expect(result).toEqual({ state: "done", sent: 84, skipped: 1 })
    expect((await messages(campaign.id)).map((m) => m.contact_id)).not.toContain(ids[0])
  }, 60_000)

  it("shows a quota hold on the campaign, still sending, and clears it once mail flows (HAL-3431)", async () => {
    const { domain, topicId, tag } = await audience(4, { quota: 2 })
    const campaign = await createCampaign({
      name: "Held",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId,
    })
    await env.DB.prepare("update campaigns set status = 'sending' where id = ?").bind(campaign.id).run()
    const ids = [0, 1, 2, 3].map((i) => `c_${tag}_${String(i).padStart(5, "0")}`)
    await env.STORE.put(
      `campaigns/${campaign.id}/audience/main/0.json`,
      JSON.stringify(ids.map((contactId) => ({ contactId, domain: "example.net", variant: null }))),
    )
    const run = () =>
      runtimeFor(env).runPromise(
        sendChunk(campaign.id, "main", 0, { origin: "https://mailyard.test", notBefore: 0 }),
      )
    const view = async () =>
      json<{ status: string; pausedBy: string | null; heldUntil: number | null; heldBy: string | null }>(
        await call(`/v1/campaigns/${campaign.id}`, { key: ADMIN }),
      )
    const first = await run()
    expect(first.state).toBe("wait")
    expect(await view()).toEqual(
      expect.objectContaining({
        status: "sending",
        pausedBy: null,
        heldBy: "quota",
        heldUntil: nextMidnight(Date.now()),
      }),
    )
    // Not a pause: the Paused tab doesn't count it.
    const counts = await json<{ paused: number; sending: number }>(
      await call("/v1/campaigns/counts", { key: ADMIN }),
    )
    expect(counts.sending).toBeGreaterThan(0)

    await governor().configure({ dailyQuota: 100_000 })
    expect((await run()).state).toBe("done")
    expect(await view()).toEqual(expect.objectContaining({ heldBy: null, heldUntil: null }))
  })

  it("refuses to schedule what would fail, reach nobody, or already went", async () => {
    const { domain, topicId } = await audience(1)
    const shortened = await createCampaign({
      name: "Bad",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: '<a href="https://bit.ly/x">x</a>',
      topicId,
    })
    const bad = await call(`/v1/campaigns/${shortened.id}/schedule`, { method: "POST", key: ADMIN, json: {} })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ field: "checks" })
    const empty = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `Empty ${uid()}`, doubleOptIn: false },
      }),
    )
    const nobody = await createCampaign({
      name: "Nobody",
      fromAddress: `news@${domain}`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      topicId: empty.id,
    })
    const none = await call(`/v1/campaigns/${nobody.id}/schedule`, { method: "POST", key: ADMIN, json: {} })
    expect(await json(none)).toMatchObject({ field: "audience" })
    await env.DB.prepare("update campaigns set status = 'sent' where id = ?").bind(nobody.id).run()
    expect(
      (await call(`/v1/campaigns/${nobody.id}/schedule`, { method: "POST", key: ADMIN, json: {} })).status,
    ).toBe(409)
  })
})

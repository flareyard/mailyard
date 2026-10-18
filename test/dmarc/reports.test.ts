import { env } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Env } from "../../src/Bindings.ts"
import { changePolicy } from "../../src/dmarc/reports.ts"
import { handleEmail, runtimeFor } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { google, gzip, microsoft, zip } from "./fixtures.ts"

installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const b64 = (bytes: Uint8Array) => {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/.{76}/g, "$&\r\n")
}

/** A report mail as receivers send them: a short text part and the report attached. */
const reportMail = (
  to: string,
  from: string,
  attachment: { name: string; type: string; bytes: Uint8Array },
) =>
  [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: Report domain: ${to.split("@")[1]} Submitter: ${from.split("@")[1]} Report-ID: ${uid()}`,
    `Message-ID: <${uid()}@${from.split("@")[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is an aggregate report.",
    "--b1",
    `Content-Type: ${attachment.type}; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(attachment.bytes),
    "--b1--",
    "",
  ].join("\r\n")

const deliver = async (to: string, raw: string) => {
  const bytes = new TextEncoder().encode(raw)
  return handleEmail(
    {
      from: "noreply-dmarc-support@google.com",
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

type View = {
  receiving: { address: string; inRua: boolean; routed: boolean }
  reports: number
  reportDays: number
  reporters: Array<{ org: string; reports: number; messages: number }>
  policy: { record: string | null; p: string | null; rua: string[] }
  totals: { messages: number; dmarcPass: number; dkimPass: number; spfPass: number }
  sources: Array<{
    ip: string
    ptr: string | null
    provider: string | null
    messages: number
    dmarcPass: number
    known: boolean
    markedKnown: boolean
    reason: string
  }>
  recommendation: {
    safeToQuarantine: boolean
    blockers: Array<{ kind: string; ip?: string }>
    nextRecord: string | null
  }
}

const setup = async () => {
  const name = `dm-${uid()}.test`
  setDns({
    ...goodDomain(name),
    [`TXT _dmarc.${name}`]: [`v=DMARC1; p=none; rua=mailto:dmarc@${name}; fo=1`],
    "PTR 11.0.30.104.in-addr.arpa": ["mail.cloudflare-email.net."],
    "PTR 50.113.0.203.in-addr.arpa": ["mx.unknown-sender.example."],
  })
  const d = await json<{ id: string }>(await admin("/v1/domains", "POST", { name }))
  return { name, id: d.id }
}

const DAY = 86_400
const today = () => Math.floor(Date.now() / 1000 / DAY) * DAY

describe("DMARC aggregate reports (HAL-3375)", () => {
  it("reads Google's and Microsoft's reports at dmarc@, adds them up, and names the sources", async () => {
    const { name, id } = await setup()
    const begin = today() - 2 * DAY
    const g = await deliver(
      `dmarc@${name}`,
      reportMail(`dmarc@${name}`, "noreply-dmarc-support@google.com", {
        name: `google.com!${name}!${begin}!${begin + DAY - 1}.zip`,
        type: "application/zip",
        bytes: await zip(`google.com!${name}!${begin}!${begin + DAY - 1}.xml`, google(name, begin)),
      }),
    )
    expect(g).toMatchObject({ outcome: "consumed" })
    const m = await deliver(
      `dmarc@${name}`,
      reportMail(`dmarc@${name}`, "dmarcreport@microsoft.com", {
        name: `enterprise.protection.outlook.com!${name}!${begin}!${begin + DAY}.xml.gz`,
        type: "application/gzip",
        bytes: await gzip(microsoft(name, begin)),
      }),
    )
    expect(m).toMatchObject({ outcome: "consumed" })
    // The same report sent again counts once.
    await deliver(
      `dmarc@${name}`,
      reportMail(`dmarc@${name}`, "noreply-dmarc-support@google.com", {
        name: "again.zip",
        type: "application/zip",
        bytes: await zip("again.xml", google(name, begin)),
      }),
    )

    const res = await admin(`/v1/domains/${id}/dmarc?range=7d`)
    expect(res.status).toBe(200)
    const view = await json<View>(res)
    expect(view.receiving).toMatchObject({ address: `dmarc@${name}`, inRua: true })
    expect(view.reports).toBe(2)
    expect(view.reporters.map((r) => r.org).sort()).toEqual(["Enterprise Outlook", "google.com"])
    expect(view.policy).toMatchObject({ p: "none", rua: [`dmarc@${name}`] })
    expect(view.totals).toMatchObject({ messages: 165, dmarcPass: 160 })
    const byIp = Object.fromEntries(view.sources.map((s) => [s.ip, s]))
    expect(byIp["104.30.0.11"]).toMatchObject({
      messages: 160,
      dmarcPass: 160,
      known: true,
      markedKnown: false,
      ptr: "mail.cloudflare-email.net",
      provider: "Cloudflare",
      reason: "Passes DMARC with SPF and DKIM.",
    })
    expect(byIp["203.0.113.50"]?.known).toBe(false)
    expect(byIp["203.0.113.50"]?.reason).toContain("no DKIM signature")
    expect(byIp["203.0.113.50"]?.reason).toContain("SPF passes for mail.unknown-sender.example")
    expect(byIp["2a01:111:f400:fe5a::7"]?.reason).toContain("signed by lists.partner.example")
    expect(byIp["2a01:111:f400:fe5a::7"]?.reason).toContain("receiver noted forwarded")
    // One day of reports so far: too early, and 5 of 165 unknown and failing is too many anyway.
    expect(view.recommendation.safeToQuarantine).toBe(false)
    expect(view.recommendation.blockers.map((b) => b.kind)).toContain("collecting")
    expect(view.recommendation.blockers.filter((b) => b.kind === "unknown_source").map((b) => b.ip)).toEqual([
      "203.0.113.50",
      "2a01:111:f400:fe5a::7",
    ])

    // Mail to dmarc@ that isn't a report isn't consumed.
    const plain = await deliver(
      `dmarc@${name}`,
      `From: someone@example.org\r\nTo: dmarc@${name}\r\nSubject: hi\r\nMessage-ID: <${uid()}@example.org>\r\n\r\nhello\r\n`,
    )
    expect(plain?.outcome).not.toBe("consumed")
  })

  it("clears a blocker once its source is marked known, and recommends the next record after a week", async () => {
    const { name, id } = await setup()
    for (let d = 8; d >= 1; d--) {
      const begin = today() - d * DAY
      await deliver(
        `dmarc@${name}`,
        reportMail(`dmarc@${name}`, "noreply-dmarc-support@google.com", {
          name: `g${d}.zip`,
          type: "application/zip",
          bytes: await zip(`g${d}.xml`, google(name, begin, `r-${d}`)),
        }),
      )
    }
    const before = await json<View>(await admin(`/v1/domains/${id}/dmarc?range=30d`))
    expect(before.reportDays).toBe(8)
    expect(before.recommendation.blockers.map((b) => b.ip)).toEqual(["203.0.113.50"])

    const reader = await createKey("secret", ["read"])
    expect(
      (
        await call(`/v1/domains/${id}/dmarc/sources/203.0.113.50/known`, {
          method: "POST",
          key: reader.key,
          json: {},
        })
      ).status,
    ).toBe(403)
    expect((await admin(`/v1/domains/${id}/dmarc/sources/not-an-ip/known`, "POST", {})).status).toBe(400)
    const marked = await admin(`/v1/domains/${id}/dmarc/sources/203.0.113.50/known`, "POST", {
      label: "Our help desk",
    })
    expect(await json(marked)).toMatchObject({ ip: "203.0.113.50", known: true, label: "Our help desk" })
    const after = await json<View>(await admin(`/v1/domains/${id}/dmarc?range=30d`))
    expect(after.recommendation).toMatchObject({
      safeToQuarantine: true,
      blockers: [],
      nextRecord: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${name}; fo=1`,
    })
    expect(after.sources.find((s) => s.ip === "203.0.113.50")?.reason).toContain(
      "marked known: Our help desk",
    )
    const unmarked = await json<{ known: boolean }>(
      await admin(`/v1/domains/${id}/dmarc/sources/203.0.113.50/known`, "DELETE"),
    )
    expect(unmarked.known).toBe(false)
  })

  it("previews a policy change, and applies it through the zone token only when asked", async () => {
    const { name, id } = await setup()
    const preview = await admin(`/v1/domains/${id}/dmarc?dryRun=1`, "PATCH", { p: "quarantine", pct: 50 })
    expect(preview.status).toBe(200)
    expect(await json(preview)).toEqual({
      name: `_dmarc.${name}`,
      before: `v=DMARC1; p=none; rua=mailto:dmarc@${name}; fo=1`,
      after: `v=DMARC1; p=quarantine; pct=50; rua=mailto:dmarc@${name}; fo=1`,
      applied: false,
      changed: true,
    })
    // Without a zone token, applying is refused and nothing changes.
    const refused = await admin(`/v1/domains/${id}/dmarc`, "PATCH", { p: "quarantine" })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ reason: "no_dns_token" })

    // With one, the existing record is updated in place.
    const seen: Array<{ method: string; path: string; body: unknown }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname !== "api.cloudflare.com") return realFetch(input, init)
      const body = request.method === "GET" ? null : await request.json()
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
      if (url.pathname.endsWith("/zones"))
        return Response.json({ success: true, result: [{ id: "zone1", name, status: "active" }] })
      if (url.pathname.endsWith("/dns_records") && request.method === "GET")
        return Response.json({
          success: true,
          result: [
            {
              id: "rec1",
              type: "TXT",
              name: `_dmarc.${name}`,
              content: `"v=DMARC1; p=none; rua=mailto:dmarc@${name}; fo=1"`,
            },
          ],
        })
      return Response.json({ success: true, result: {} })
    }) as typeof fetch
    try {
      const bindings = { ...env, CLOUDFLARE_DNS_TOKEN: "tok" } as Env
      const done = await runtimeFor(bindings).runPromise(
        changePolicy({ domainId: id, p: "quarantine", pct: null, dryRun: false, actor: "root" }).pipe(
          Effect.orDie,
        ),
      )
      expect(done).toMatchObject({
        applied: true,
        after: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${name}; fo=1`,
      })
    } finally {
      globalThis.fetch = realFetch
    }
    const patch = seen.find((s) => s.method === "PATCH")
    expect(patch?.path).toContain("/zones/zone1/dns_records/rec1")
    expect(patch?.body).toMatchObject({
      type: "TXT",
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${name}; fo=1`,
    })
    const audit = await json<{ entries: Array<{ action: string }> }>(
      await admin("/v1/audit?action=dmarc.policy"),
    )
    expect(audit.entries.length).toBeGreaterThan(0)
  })

  it("refuses to choose between several DMARC records", async () => {
    const { name, id } = await setup()
    setDns({ [`TXT _dmarc.${name}`]: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] })
    const res = await admin(`/v1/domains/${id}/dmarc?dryRun=1`, "PATCH", { p: "quarantine" })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ reason: "several_records" })
    expect((await admin("/v1/domains/dom_nope/dmarc")).status).toBe(404)
  })
})

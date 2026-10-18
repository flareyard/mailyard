import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { brandContrastProblem, contrastRatio, DEFAULT_BRAND } from "../../src/domain/brand.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"

/** HAL-3376: the brand's contrast and logo, the audit log, and the compliance defaults. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { key: ADMIN, ...init })

// The tracking-origin check fetches /healthz on the hostname: these answer as Mailyard or not.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(new Request(input, init).url)
  if (url.hostname === "cloudflare-dns.com") return realFetch(input, init)
  if (url.hostname === "t.ours.test") return Response.json({ status: "ok", app: "mailyard" })
  if (url.hostname === "t.elsewhere.test") return new Response("<html>", { status: 200 })
  throw new TypeError("fetch failed")
}) as typeof fetch

const brand = { name: "Yard", siteUrl: "https://yard.example", tagline: "Hi" }

describe("brand (HAL-3376)", () => {
  it("measures contrast the way WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1)
    // The defaults themselves pass, so a brand that sets no colours is always accepted.
    expect(brandContrastProblem(DEFAULT_BRAND)).toBeNull()
  })

  it("refuses colours that fail AA, naming the colour to change", async () => {
    const yellow = await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, colors: { indigo: "#ffd400" } },
    })
    expect(yellow.status).toBe(400)
    expect(await json(yellow)).toMatchObject({
      field: "colors.indigo",
      message: expect.stringMatching(/^White text on the accent is 1\.\d:1; AA needs 4\.5:1/),
    })
    const pale = await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, colors: { muted: "#c0c0c0" } },
    })
    expect(await json(pale)).toMatchObject({ field: "colors.muted" })
    const fine = await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, colors: { indigo: "#0a7d55" } },
    })
    expect(fine.status).toBe(200)
    // A bad hex is the schema's to refuse.
    expect(
      (await admin("/v1/settings/brand", { method: "PUT", json: { ...brand, colors: { indigo: "green" } } }))
        .status,
    ).toBe(400)
  })

  it("keeps an uploaded logo and serves it, refusing anything that isn't a raster image", async () => {
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      uid().length,
    ])
    const upload = async (bytes: Uint8Array, filename: string, type: string) =>
      json<{ id: string }>(
        await admin(`/v1/uploads?filename=${filename}`, {
          method: "POST",
          headers: { "content-type": type },
          body: bytes,
        }),
      )
    const logo = await upload(png, "logo.png", "image/png")
    const saved = await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, logoUploadId: logo.id },
    })
    expect(saved.status).toBe(200)
    const { logoUrl } = await json<{ logoUrl: string }>(saved)
    expect(logoUrl).toMatch(/^https:\/\/mailyard\.test\/brand\/logo\/[a-f0-9]{64}\.png$/)
    const served = await call(new URL(logoUrl).pathname)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(served.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)

    // An SVG (it can carry script) and text are refused, by their bytes, whatever they're called.
    const svg = await upload(
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      "logo.png",
      "image/png",
    )
    const refused = await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, logoUploadId: svg.id },
    })
    expect(refused.status).toBe(400)
    expect(await json(refused)).toMatchObject({ field: "logoUploadId" })
    expect((await call("/brand/logo/" + "0".repeat(64) + ".png")).status).toBe(404)
  })
})

describe("audit log (HAL-3376)", () => {
  it("lists who did what, filters it, names the actor and the target, and pages", async () => {
    const tag = uid()
    const key = await createKey("secret", ["admin", "read"])
    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: key.key,
        json: { name: `Audit ${tag}`, doubleOptIn: false },
      }),
    )
    await call(`/v1/topics/${topic.id}`, { method: "PATCH", key: key.key, json: { description: "Edited" } })
    await admin("/v1/settings/brand", { method: "PUT", json: { ...brand, tagline: tag } })

    type Entry = {
      action: string
      actor: { type: string; id: string; name: string }
      via: string | null
      ip: null
      target: { type: string | null; id: string; label: string | null } | null
      after: unknown
    }
    const list = async (q: string) =>
      json<{ entries: Array<Entry>; nextCursor: string | null }>(await admin(`/v1/audit?${q}`))

    const byTarget = await list(`target=${topic.id}`)
    expect(byTarget.entries.length).toBeGreaterThanOrEqual(1)
    for (const e of byTarget.entries) {
      expect(e.actor).toMatchObject({ type: "key", id: key.apiKey.id })
      expect(e.via).toBe("api")
      expect(e.ip).toBeNull()
      expect(e.target).toEqual({ type: "topic", id: topic.id, label: `Audit ${tag}` })
    }
    const brandChange = (await list("action=settings.brand")).entries[0]
    expect(brandChange).toMatchObject({ actor: { type: "root", name: "Admin key" }, via: null })
    expect((brandChange?.after as { tagline?: string } | undefined)?.tagline).toBe(tag)
    // An action family, as a prefix.
    expect((await list("action=settings.")).entries.every((e) => e.action.startsWith("settings."))).toBe(true)
    expect((await list(`actor=${key.apiKey.id}`)).entries.every((e) => e.actor.id === key.apiKey.id)).toBe(
      true,
    )
    expect((await list(`from=${Date.now() + 60_000}`)).entries).toEqual([])

    const first = await list("limit=1")
    expect(first.entries).toHaveLength(1)
    const second = await list(`limit=1&cursor=${first.nextCursor}`)
    expect(second.entries[0]).not.toEqual(first.entries[0])

    // Read and admin keys differ: the log is the admin's.
    const reader = await createKey("secret", ["read"])
    expect((await call("/v1/audit", { key: reader.key })).status).toBe(403)
  })

  it("exports the same entries as CSV, safe to open in a spreadsheet", async () => {
    await admin("/v1/settings/brand", { method: "PUT", json: { ...brand, tagline: "=HYPERLINK(1)" } })
    const res = await admin("/v1/audit?format=csv&action=settings.brand")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(res.headers.get("x-truncated")).toBe("false")
    const csv = await res.text()
    const [header, row] = csv.split("\n")
    expect(header).toBe(
      "at,actor_type,actor_id,actor_name,via,action,target_type,target_id,target_label,before,after",
    )
    expect(row).toMatch(/^\d{4}-\d\d-\d\dT[^,]+,root,root,Admin key,,settings\.brand,settings,brand,,/)
    // JSON cells are quoted; nothing reaches a cell starting with "=".
    expect(csv).not.toMatch(/,=/)
    const reader = await createKey("secret", ["read"])
    expect((await call("/v1/audit?format=csv", { key: reader.key })).status).toBe(403)
  })
})

describe("compliance defaults (HAL-3376)", () => {
  const putCompliance = (body: Record<string, unknown>) =>
    admin("/v1/settings/compliance", {
      method: "PUT",
      json: { postalAddress: null, linkAllowlist: [], seedAddresses: [], ...body },
    })

  it("starts new campaigns and topics from the workspace's defaults", async () => {
    const domain = `cd-${uid()}.test`
    setDns(goodDomain(domain))
    await admin("/v1/domains", { method: "POST", json: { name: domain, sending: true, receiving: false } })
    await putCompliance({ trackOpensDefault: false, trackClicksDefault: true, doubleOptInDefault: false })
    const campaign = await json<{ trackOpens: boolean; trackClicks: boolean }>(
      await admin("/v1/campaigns", {
        method: "POST",
        json: { name: "D", fromAddress: `news@${domain}`, subject: "S", bodyHtml: "<p>x</p>" },
      }),
    )
    expect(campaign).toMatchObject({ trackOpens: false, trackClicks: true })
    const topic = await json<{ doubleOptIn: boolean }>(
      await admin("/v1/topics", { method: "POST", json: { name: `T ${uid()}` } }),
    )
    expect(topic.doubleOptIn).toBe(false)
    // Said in the request, the request wins.
    const explicit = await json<{ doubleOptIn: boolean }>(
      await admin("/v1/topics", { method: "POST", json: { name: `T ${uid()}`, doubleOptIn: true } }),
    )
    expect(explicit.doubleOptIn).toBe(true)
    // Back to the deploy's defaults.
    await putCompliance({})
    const back = await json<{ trackOpens: boolean }>(
      await admin("/v1/campaigns", {
        method: "POST",
        json: { name: "D2", fromAddress: `news@${domain}`, subject: "S", bodyHtml: "<p>x</p>" },
      }),
    )
    expect(back.trackOpens).toBe(true)
  })

  it("checks the tracking hostname live: CNAME, HTTPS, and whether it reaches Mailyard", async () => {
    setDns({ "CNAME t.ours.test": ["mailyard-api.example.workers.dev."] })
    const ours = await json<{ trackingOriginCheck: Record<string, unknown> }>(
      await putCompliance({ trackingOrigin: "https://t.ours.test" }),
    )
    expect(ours.trackingOriginCheck).toMatchObject({
      host: "t.ours.test",
      cname: "mailyard-api.example.workers.dev",
      certificate: "valid",
      routesHere: true,
    })
    const elsewhere = await json<{ trackingOriginCheck: Record<string, unknown> }>(
      await putCompliance({ trackingOrigin: "https://t.elsewhere.test" }),
    )
    expect(elsewhere.trackingOriginCheck).toMatchObject({
      cname: null,
      certificate: "valid",
      routesHere: false,
    })
    const broken = await json<{ trackingOriginCheck: Record<string, unknown> }>(
      await putCompliance({ trackingOrigin: "https://t.nothing.test" }),
    )
    expect(broken.trackingOriginCheck).toMatchObject({ certificate: "failed", routesHere: false })
    // Recheck on demand; and no tracking origin, no check.
    const again = await admin("/v1/settings/compliance/tracking-check", { method: "POST" })
    expect(again.status).toBe(200)
    expect(
      (await json<{ trackingOriginCheck: unknown }>(await putCompliance({}))).trackingOriginCheck,
    ).toBeNull()
  })

  it("lets the preference page keep Flareyard's look and hide topic descriptions", async () => {
    await admin("/v1/settings/brand", {
      method: "PUT",
      json: { ...brand, colors: { indigo: "#0a7d55" } },
    })
    await putCompliance({ preferencePage: { useBrand: false, showTopicDescriptions: false } })
    const res = await call("/u/v1.bad.bad")
    const html = await res.text()
    expect(html).toContain("Funnel Display")
    expect(html).not.toContain("#0a7d55")
    await putCompliance({})
  })
})

import { describe, expect, it } from "vitest"
import { DmarcParseError, looksLikeReport, parseReport, unpack } from "../../src/dmarc/parse.ts"
import { nextStep, parseRecord, policyOf, recommend, ruaOf, withPolicy } from "../../src/dmarc/policy.ts"
import { providerOf, reverseName } from "../../src/dmarc/providers.ts"
import { google, gzip, microsoft, zip } from "./fixtures.ts"

const BEGIN = 1_792_281_600 // 2026-10-17T00:00:00Z

describe("unpacking and reading aggregate reports (HAL-3375)", () => {
  it("reads Google's zipped report", async () => {
    const xml = await unpack(
      await zip("google.com!acme.test!1792281600!1792367999.xml", google("acme.test", BEGIN)),
    )
    const report = parseReport(xml)
    expect(report).toMatchObject({
      orgName: "google.com",
      email: "noreply-dmarc-support@google.com",
      reportId: "17294612310000000001",
      begin: BEGIN,
      end: BEGIN + 86_399,
      policy: { domain: "acme.test", p: "none", sp: "none", pct: 100, adkim: "r", aspf: "r" },
    })
    expect(report.records).toEqual([
      expect.objectContaining({
        sourceIp: "104.30.0.11",
        count: 120,
        disposition: "none",
        dkimAligned: true,
        spfAligned: true,
        headerFrom: "acme.test",
        dkim: [{ domain: "acme.test", result: "pass", selector: "cf2024-1" }],
        spf: [{ domain: "cf-bounce.acme.test", result: "pass" }],
      }),
      expect.objectContaining({
        sourceIp: "203.0.113.50",
        count: 3,
        dkimAligned: false,
        spfAligned: false,
        dkim: [],
      }),
    ])
  })

  it("reads Microsoft's gzipped report, with its namespaces, IPv6 sources and override reasons", async () => {
    const report = parseReport(await unpack(await gzip(microsoft("acme.test", BEGIN))))
    expect(report.orgName).toBe("Enterprise Outlook")
    expect(report.records[1]).toMatchObject({
      sourceIp: "2a01:111:f400:fe5a::7",
      count: 2,
      envelopeFrom: "lists.partner.example",
      overrides: ["forwarded"],
      spf: [{ domain: "lists.partner.example", result: "softfail" }],
    })
  })

  it("reads plain and stored-zip XML, DMARCbis prefixes, CDATA and entities", async () => {
    const plain = google("acme.test", BEGIN).replace("google.com</org_name>", "Google &amp; Co</org_name>")
    expect(parseReport(await unpack(new TextEncoder().encode(plain))).orgName).toBe("Google & Co")
    expect(parseReport(await unpack(await zip("r.xml", google("acme.test", BEGIN), 0))).records).toHaveLength(
      2,
    )
    const bis = google("acme.test", BEGIN)
      .replace("<feedback>", '<dmarc:feedback xmlns:dmarc="urn:ietf:params:xml:ns:dmarc-2.0">')
      .replace("</feedback>", "</dmarc:feedback>")
      .replaceAll("<record>", "<dmarc:record>")
      .replaceAll("</record>", "</dmarc:record>")
      .replace("<report_id>17294612310000000001</report_id>", "<report_id><![CDATA[abc<1>]]></report_id>")
    const report = parseReport(bis)
    expect(report.reportId).toBe("abc<1>")
    expect(report.records).toHaveLength(2)
  })

  it("refuses what isn't a report, and a zip without one", async () => {
    expect(() => parseReport("<html><body>hello</body></html>")).toThrow(DmarcParseError)
    expect(() => parseReport("<feedback><report_metadata></report_metadata></feedback>")).toThrow(/org_name/)
    await expect(unpack(await zip("readme.txt", "hello"))).rejects.toThrow(/no .xml/)
  })

  it("knows a report attachment by its name or type", () => {
    expect(looksLikeReport({ filename: "google.com!acme.test!1!2.zip", mimeType: "application/zip" })).toBe(
      true,
    )
    expect(looksLikeReport({ filename: "x.xml.gz", mimeType: "application/octet-stream" })).toBe(true)
    expect(looksLikeReport({ filename: null, mimeType: "application/gzip" })).toBe(true)
    expect(looksLikeReport({ filename: "invoice.pdf", mimeType: "application/pdf" })).toBe(false)
  })
})

describe("the policy record and the next step (HAL-3375)", () => {
  it("changes p and pct, keeping every other tag in place", () => {
    const record = parseRecord("v=DMARC1; p=none; rua=mailto:dmarc@acme.test,mailto:x@y.test!10m; fo=1")
    expect(policyOf(record)).toBe("none")
    expect(ruaOf(record)).toEqual(["dmarc@acme.test", "x@y.test"])
    expect(withPolicy(record, "quarantine", 25)).toBe(
      "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@acme.test,mailto:x@y.test!10m; fo=1",
    )
    expect(withPolicy(parseRecord("v=DMARC1; p=quarantine; pct=25"), "reject", 100)).toBe(
      "v=DMARC1; p=reject",
    )
    expect(withPolicy(null, "none", null)).toBe("v=DMARC1; p=none")
  })

  it("steps none, quarantine, reject", () => {
    expect(nextStep("none", null)).toEqual({ p: "quarantine", pct: null })
    expect(nextStep("quarantine", 50)).toEqual({ p: "quarantine", pct: null })
    expect(nextStep("quarantine", null)).toEqual({ p: "reject", pct: null })
    expect(nextStep("reject", null)).toBeNull()
  })

  it("recommends tightening only with a week of reports and almost no unknown failures", () => {
    const sources = [
      { ip: "1.1.1.1", messages: 10_000, dmarcPass: 10_000, known: true },
      { ip: "2.2.2.2", messages: 30, dmarcPass: 0, known: false },
    ]
    expect(recommend({ policy: "none", pct: null, days: 3, messages: 10_030, sources })).toMatchObject({
      safeToQuarantine: false,
      blockers: [expect.objectContaining({ kind: "collecting" })],
      next: null,
    })
    expect(recommend({ policy: "none", pct: null, days: 10, messages: 10_030, sources })).toMatchObject({
      safeToQuarantine: true,
      next: { p: "quarantine", pct: null },
    })
    const worse = [...sources, { ip: "3.3.3.3", messages: 500, dmarcPass: 0, known: false }]
    const verdict = recommend({ policy: "none", pct: null, days: 10, messages: 10_530, sources: worse })
    expect(verdict.safeToQuarantine).toBe(false)
    expect(verdict.blockers.map((b) => b.ip)).toEqual(["3.3.3.3", "2.2.2.2"])
    // Marking the failing source known clears it.
    const marked = worse.map((s) => (s.ip === "3.3.3.3" ? { ...s, known: true } : s))
    expect(
      recommend({ policy: "quarantine", pct: null, days: 10, messages: 10_530, sources: marked }),
    ).toMatchObject({
      safeToReject: true,
      next: { p: "reject" },
    })
  })
})

describe("sending sources (HAL-3375)", () => {
  it("builds reverse names for IPv4 and IPv6", () => {
    expect(reverseName("209.85.220.41")).toBe("41.220.85.209.in-addr.arpa")
    expect(reverseName("2a01:111:f400:fe5a::7")).toBe(
      "7.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.a.5.e.f.0.0.4.f.1.1.1.0.1.0.a.2.ip6.arpa",
    )
    expect(reverseName("not an ip")).toBeNull()
  })

  it("names well-known senders from their reverse name", () => {
    expect(providerOf("mail-sor-f41.google.com.")).toBe("Google")
    expect(providerOf("mail-db8eur05on2041.outbound.protection.outlook.com")).toBe("Microsoft")
    expect(providerOf("a8-30.smtp-out.amazonses.com")).toBe("Amazon SES")
    expect(providerOf("host.example.net")).toBeNull()
    expect(providerOf(null)).toBeNull()
  })
})

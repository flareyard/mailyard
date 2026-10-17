import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  checkDkim,
  checkDmarc,
  checkDomain,
  checkMx,
  checkSpf,
  routingDkimNames,
} from "../../src/domain/dnsChecks.ts"
import { Dns, DnsError, unquoteTxt } from "../../src/services/Dns.ts"
import { goodDomain } from "../dns.ts"

const ok = (data: ReadonlyArray<string>) =>
  ({
    _tag: "Success",
    success: { status: 0, answers: data.map((d) => ({ name: "x", type: "TXT", data: d })) },
  }) as never
const down = {
  _tag: "Failure",
  failure: new DnsError({ name: "x", type: "MX", message: "timeout" }),
} as never

describe("record checks (fixtures)", () => {
  it("MX: all three Cloudflare hosts pass; a foreign host fails; a missing one warns", () => {
    expect(
      checkMx(
        "mx",
        "a.test",
        ok(["1 route1.mx.cloudflare.net.", "2 route2.mx.cloudflare.net.", "3 route3.mx.cloudflare.net."]),
      ).status,
    ).toBe("pass")
    const spacemail = checkMx("mx", "a.test", ok(["10 mx1.spacemail.com.", "20 mx2.spacemail.com."]))
    expect(spacemail).toMatchObject({
      status: "fail",
      detail:
        "MX points to mx1.spacemail.com, mx2.spacemail.com: that provider receives this mail, not Mailyard.",
    })
    expect(checkMx("mx", "a.test", ok(["1 route1.mx.cloudflare.net."])).status).toBe("warn")
    expect(checkMx("mx", "a.test", ok([])).status).toBe("fail")
    expect(checkMx("mx", "a.test", down)).toMatchObject({ status: "error", detail: "Lookup failed: timeout" })
  })

  it("SPF: one record including Cloudflare; two records or a missing include fail; +all warns", () => {
    expect(
      checkSpf(
        "spf",
        "a.test",
        ok(["v=spf1 include:_spf.mx.cloudflare.net ~all", "google-site-verification=x"]),
      ).status,
    ).toBe("pass")
    expect(checkSpf("spf", "a.test", ok(["v=spf1 include:spf.spacemail.com ~all"])).status).toBe("fail")
    expect(
      checkSpf("spf", "a.test", ok(["v=spf1 include:_spf.mx.cloudflare.net ~all", "v=spf1 -all"])).detail,
    ).toContain("More than one SPF")
    expect(checkSpf("spf", "a.test", ok(["v=spf1 include:_spf.mx.cloudflare.net +all"])).status).toBe("warn")
    expect(checkSpf("spf", "a.test", ok([])).status).toBe("fail")
  })

  it("DKIM: a published key passes; none or a revoked (empty p=) key fails", () => {
    expect(checkDkim("dkim", "s._domainkey.a.test", ok(["v=DKIM1; k=rsa; p=MIIB"])).status).toBe("pass")
    expect(checkDkim("dkim", "s._domainkey.a.test", ok(["v=DKIM1; k=rsa; p="])).detail).toContain("revoked")
    expect(checkDkim("dkim", "s._domainkey.a.test", ok([])).status).toBe("fail")
  })

  it("DMARC: quarantine and reject pass, none warns, missing or duplicate fails", () => {
    expect(checkDmarc("_dmarc.a.test", ok(["v=DMARC1; p=reject; rua=mailto:d@a.test"])).status).toBe("pass")
    expect(checkDmarc("_dmarc.a.test", ok(["v=DMARC1; p=none"])).status).toBe("warn")
    expect(checkDmarc("_dmarc.a.test", ok([])).status).toBe("fail")
    expect(checkDmarc("_dmarc.a.test", ok(["v=DMARC1; p=none", "v=DMARC1; p=reject"])).status).toBe("fail")
    expect(checkDmarc("_dmarc.a.test", ok(["v=DMARC1; rua=mailto:x@a.test"])).status).toBe("fail")
  })

  it("checks only what the domain is used for, and reports the worst status", async () => {
    const run = (
      purposes: { receiving: boolean; sending: boolean },
      records: Record<string, ReadonlyArray<string>>,
    ) => Effect.runPromise(checkDomain("good.test", purposes).pipe(Effect.provide(Dns.layerFixture(records))))
    const both = await run({ receiving: true, sending: true }, goodDomain("good.test"))
    expect(both.status).toBe("pass")
    expect(both.checks.map((c) => c.id)).toEqual([
      "mx",
      "spf",
      "dkim",
      "bounce-mx",
      "bounce-spf",
      "bounce-dkim",
      "dmarc",
    ])
    const sendingOnly = await run({ receiving: false, sending: true }, goodDomain("good.test"))
    expect(sendingOnly.checks.map((c) => c.id)).toEqual(["bounce-mx", "bounce-spf", "bounce-dkim", "dmarc"])
    const noDmarc = { ...goodDomain("good.test"), "TXT _dmarc.good.test": ["v=DMARC1; p=none"] }
    expect((await run({ receiving: true, sending: true }, noDmarc)).status).toBe("warn")
  })

  it("finds Email Routing's DKIM key at the zone apex when the domain is a subdomain", async () => {
    const run = (records: Record<string, ReadonlyArray<string>>) =>
      Effect.runPromise(
        checkDomain("in.good.test", { receiving: true, sending: false }).pipe(
          Effect.provide(Dns.layerFixture(records)),
        ),
      )
    const sub = goodDomain("in.good.test")
    const apexKey = sub["TXT cf2024-1._domainkey.in.good.test"]
    const { ["TXT cf2024-1._domainkey.in.good.test"]: _moved, ...withoutSubKey } = sub
    const atApex = await run({ ...withoutSubKey, "TXT cf2024-1._domainkey.good.test": apexKey ?? [] })
    expect(atApex.checks.find((c) => c.id === "dkim")).toMatchObject({
      status: "pass",
      name: "cf2024-1._domainkey.good.test",
    })
    const nowhere = await run(withoutSubKey)
    expect(nowhere.checks.find((c) => c.id === "dkim")).toMatchObject({
      status: "fail",
      name: "cf2024-1._domainkey.in.good.test",
    })
    expect(routingDkimNames("a.in.good.test")).toEqual([
      "cf2024-1._domainkey.a.in.good.test",
      "cf2024-1._domainkey.in.good.test",
      "cf2024-1._domainkey.good.test",
    ])
  })

  it("joins multi-string TXT answers the way DoH returns them", () => {
    expect(unquoteTxt('"v=DKIM1; k=rsa; p=AAAA" "BBBB"')).toBe("v=DKIM1; k=rsa; p=AAAABBBB")
    expect(unquoteTxt('"say \\"hi\\""')).toBe('say "hi"')
  })
})

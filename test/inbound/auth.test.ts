import { describe, expect, it } from "vitest"
import { parseRecipient } from "../../src/inbound/address.ts"
import { parseAuthenticationResults, readAuthResults } from "../../src/inbound/auth.ts"

const h = (key: string, value: string) => ({ key, value })

describe("readAuthResults", () => {
  it("uses the newest Authentication-Results header, with every DKIM signature", () => {
    const auth = readAuthResults([
      h(
        "authentication-results",
        "mx.cloudflare.net; dkim=pass header.d=a.example header.s=one; dkim=fail (body hash) header.i=@b.example; spf=softfail smtp.mailfrom=x@a.example; dmarc=fail header.from=a.example",
      ),
      h("authentication-results", "older.example; spf=pass smtp.mailfrom=y@other.example"),
    ])
    expect(auth).toEqual({
      source: "authentication-results",
      authservId: "mx.cloudflare.net",
      spf: "softfail",
      spfDomain: "a.example",
      dkim: [
        { result: "pass", domain: "a.example", selector: "one" },
        { result: "fail", domain: "b.example", selector: null },
      ],
      dmarc: "fail",
      dmarcDomain: "a.example",
      arc: null,
    })
  })

  it("falls back to the highest ARC instance when no Authentication-Results is present", () => {
    const auth = readAuthResults([
      h("arc-authentication-results", "i=1; first.example; spf=fail smtp.mailfrom=a@x.example"),
      h(
        "arc-authentication-results",
        "i=2; mx.google.com; dkim=pass header.d=x.example; spf=pass smtp.mailfrom=a@x.example; dmarc=pass header.from=x.example; arc=pass",
      ),
    ])
    expect(auth.source).toBe("arc-authentication-results")
    expect(auth.authservId).toBe("mx.google.com")
    expect([auth.spf, auth.dmarc, auth.arc]).toEqual(["pass", "pass", "pass"])
  })

  it("reads a bare Received-SPF, and maps the legacy hardfail to fail", () => {
    const auth = readAuthResults([
      h(
        "received-spf",
        'hardfail (mx: domain does not designate) client-ip=192.0.2.1; envelope-from="a@spoof.example";',
      ),
    ])
    expect(auth).toMatchObject({ source: "received-spf", spf: "fail", spfDomain: "spoof.example" })
  })

  it("reports nothing when the message carries no verdicts", () => {
    expect(readAuthResults([h("subject", "hi")]).source).toBe("none")
  })

  it("ignores comments, including nested ones and ones containing method-like text", () => {
    const parsed = parseAuthenticationResults(
      "mx.example 1; spf=pass (sender (really) says spf=fail) smtp.mailfrom=a@b.example; dkim=none",
    )
    expect(parsed.authservId).toBe("mx.example")
    expect(parsed.results.map((r) => [r.method, r.result])).toEqual([
      ["spf", "pass"],
      ["dkim", "none"],
    ])
  })

  it("handles a header with no authserv-id and an unknown verdict", () => {
    const parsed = parseAuthenticationResults("spf=weird")
    expect(parsed.authservId).toBeNull()
    expect(parsed.results[0]?.result).toBe("unknown")
  })
})

describe("parseRecipient", () => {
  it("normalises case, brackets and whitespace", () => {
    expect(parseRecipient("  <Sam@ACME.test> ")).toEqual({
      address: "sam@acme.test",
      local: "sam",
      domain: "acme.test",
      base: "sam@acme.test",
      tag: null,
    })
  })

  it("splits a subaddress at the first plus", () => {
    expect(parseRecipient("sam+news+daily@acme.test")).toMatchObject({
      base: "sam@acme.test",
      tag: "news+daily",
    })
    expect(parseRecipient("sam+@acme.test")).toMatchObject({ base: "sam@acme.test", tag: null })
  })

  it("does not treat a leading plus as a subaddress", () => {
    expect(parseRecipient("+tag@acme.test")).toMatchObject({ base: "+tag@acme.test", tag: null })
  })

  it("rejects anything that is not local@domain", () => {
    expect(parseRecipient("nobody")).toBeNull()
    expect(parseRecipient("@acme.test")).toBeNull()
    expect(parseRecipient("sam@")).toBeNull()
  })
})

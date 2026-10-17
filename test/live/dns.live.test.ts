import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { checkDomain } from "../../src/domain/dnsChecks.ts"
import { Dns } from "../../src/services/Dns.ts"

/**
 * Reads bridgehook.dev's real DNS through Cloudflare's DoH resolver. Read-only, and opt-in so CI never
 * depends on the network: `LIVE_DNS=1 bunx vitest run --project unit test/live`.
 * Expected as measured 2026-10-17: sending is fully set up (cf-bounce MX/SPF/DKIM, DMARC p=none),
 * while receiving still points at Spacemail, so the MX and SPF checks fail with that reason.
 */
describe.skipIf(!process.env.LIVE_DNS)("bridgehook.dev, live", () => {
  it("reads the real records and judges them", async () => {
    const result = await Effect.runPromise(
      checkDomain("bridgehook.dev", { receiving: true, sending: true }).pipe(Effect.provide(Dns.layerDoh())),
    )
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
    console.log(
      JSON.stringify(
        result.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
        null,
        2,
      ),
    )
    expect(byId["bounce-mx"]?.status).toBe("pass")
    expect(byId["bounce-spf"]?.status).toBe("pass")
    expect(byId["bounce-dkim"]?.status).toBe("pass")
    expect(byId.dmarc?.status).toBe("warn")
    expect(byId.mx).toMatchObject({ status: "fail" })
    expect(byId.mx?.detail).toContain("spacemail.com")
    expect(byId.spf?.status).toBe("fail")
    expect(byId.dkim?.status).toBe("fail")
  }, 30_000)
})

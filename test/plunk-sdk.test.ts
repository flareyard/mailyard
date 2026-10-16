import { exports } from "cloudflare:workers"
import Plunk from "@plunk/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createKey } from "./helpers.ts"

// The real Plunk SDK, unchanged, with only its baseUrl pointed at Mailyard. Its fetch calls are
// routed to the Worker under test.
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    exports.default.fetch(new Request(input, init))) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

describe("@plunk/node 3.0.3 against Mailyard", () => {
  it("sends an email and tracks an event", async () => {
    const { key } = await createKey("secret")
    const plunk = new Plunk(key, { baseUrl: "https://mailyard.test/v1/" })

    const sent = (await plunk.emails.send({
      to: "sdk@example.net",
      subject: "From the Plunk SDK",
      body: "<p>Hello from @plunk/node</p>",
      from: "hello@mailyard.test",
      name: "Mailyard",
    })) as { success: boolean; data: { emails: Array<{ status: string }> } }
    expect(sent.success).toBe(true)
    expect(sent.data.emails[0]?.status).toBe("sent")

    const tracked = (await plunk.events.track({ event: "sdk-test", email: "sdk@example.net" })) as {
      success: boolean
    }
    expect(tracked.success).toBe(true)
  })

  it("surfaces a bad key as the SDK's TokenError", async () => {
    const plunk = new Plunk("sk_wrong", { baseUrl: "https://mailyard.test/v1/" })
    await expect(
      plunk.emails.send({ to: "x@example.net", subject: "s", body: "b", from: "hello@mailyard.test" }),
    ).rejects.toThrow()
  })
})

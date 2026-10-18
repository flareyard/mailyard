import { describe, expect, it } from "vitest"
import { findFixture } from "./mode.ts"

const v = (path: string, query: string, body: unknown) => ({ screen: "s.html", path, query, body })
const table = {
  "GET /v1/stats/delivery": [
    v("/v1/stats/delivery", "range=7d", "7d"),
    v("/v1/stats/delivery", "range=24h", "24h"),
  ],
  "GET /v1/domains/{id}": [v("/v1/domains/dom_a", "", "a"), v("/v1/domains/dom_b", "", "b")],
}

describe("findFixture", () => {
  it("prefers the variant whose query matches", () => {
    expect(findFixture(table, "GET", new URL("http://x/v1/stats/delivery?range=24h"))?.body).toBe("24h")
    expect(findFixture(table, "GET", new URL("http://x/v1/stats/delivery?range=7d"))?.body).toBe("7d")
  })
  it("matches prefixed ids to the template and prefers the exact entity", () => {
    expect(findFixture(table, "GET", new URL("http://x/v1/domains/dom_b"))?.body).toBe("b")
    expect(findFixture(table, "GET", new URL("http://x/v1/domains/dom_zzz"))?.body).toBe("a")
  })
  it("prefers populated screens over empty or error variants", () => {
    const t = {
      "GET /v1/domains": [
        { screen: "first-run/domains-empty.html", path: "/v1/domains", query: "", body: "empty" },
        { screen: "overview/overview-7d.html", path: "/v1/domains", query: "", body: "full" },
      ],
    }
    expect(findFixture(t, "GET", new URL("http://x/v1/domains"))?.body).toBe("full")
  })
  it("matches path parameters that aren't prefixed ids, like an invite token", () => {
    const t = {
      "GET /v1/invites/{token}": [
        { screen: "auth/invite-valid.html", path: "/v1/invites/inv_x", query: "", body: "inv" },
      ],
    }
    expect(findFixture(t, "GET", new URL("http://x/v1/invites/Zq81-abc"))?.body).toBe("inv")
  })
  it("ignores the fixtures switch itself and misses unknown endpoints", () => {
    expect(findFixture(table, "GET", new URL("http://x/v1/stats/delivery?range=24h&fixtures=1"))?.body).toBe(
      "24h",
    )
    expect(findFixture(table, "GET", new URL("http://x/v1/nope"))).toBeUndefined()
  })
})

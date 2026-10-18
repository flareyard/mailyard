import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { canonicalRedirect, configurePublicOrigin, isWorkerPath, linkOrigin } from "../src/public/origin.ts"
import { ADMIN, json } from "./helpers.ts"

/** A request to another of the deployment's hostnames (as api.mail.flareyard.dev is to mail.…). */
const viaApiHost = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`https://api.mailyard.test${path}`, { redirect: "manual", ...init }))

describe("the public origin (HAL-3483)", () => {
  it("builds links on MAILYARD_PUBLIC_ORIGIN whichever hostname the request used", async () => {
    const created = await viaApiHost("/v1/contacts", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "origin@example.com" }),
    })
    expect(created.status).toBeLessThan(300)
    const { id } = await json<{ id: string }>(created)
    const link = await viaApiHost(`/v1/contacts/${id}/preferences-link`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(link.status).toBe(200)
    expect((await json<{ url: string }>(link)).url).toMatch(/^https:\/\/mailyard\.test\/u\//)
  })

  it("names the workspace's url and host in /v1/me", async () => {
    const me = await json<{ workspace: { url: string; host: string } }>(
      await viaApiHost("/v1/me", { headers: { authorization: `Bearer ${ADMIN}` } }),
    )
    expect(me.workspace).toMatchObject({ url: "https://mailyard.test", host: "mailyard.test" })
  })

  it("sends app pages on another hostname to the public origin, and never the API", async () => {
    const page = await viaApiHost("/inbox/threads?folder=sent", { headers: { accept: "text/html" } })
    expect(page.status).toBe(308)
    expect(page.headers.get("location")).toBe("https://mailyard.test/inbox/threads?folder=sent")
    expect((await viaApiHost("/healthz")).status).toBe(200)
    expect((await viaApiHost("/v1/contacts")).status).toBe(401)
    expect((await viaApiHost("/openapi.json")).status).toBe(200)
    // A POST is never redirected.
    expect((await viaApiHost("/somewhere", { method: "POST" })).status).not.toBe(308)
    // On the public origin itself an app path is not redirected.
    const home = await exports.default.fetch(
      new Request("https://mailyard.test/inbox", { redirect: "manual" }),
    )
    expect(home.status).not.toBe(308)
    expect(env.MAILYARD_PUBLIC_ORIGIN).toBe("https://mailyard.test")
  })

  it("knows which paths the Worker owns", () => {
    for (const path of [
      "/v1/me",
      "/mcp",
      "/healthz",
      "/openapi.json",
      "/t/o/x.gif",
      "/u/x",
      "/p/request",
      "/c/x",
      "/f/x",
      "/v/x",
      "/brand/logo/x.png",
      "/oauth/authorize",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ])
      expect(isWorkerPath(path)).toBe(true)
    for (const path of ["/", "/inbox", "/settings/keys", "/assets/app.js", "/v1x", "/mcpx", "/.well-known/security.txt"])
      expect(isWorkerPath(path)).toBe(false)
  })

  it("falls back to the request's origin when unset, and ignores a malformed value", () => {
    try {
      configurePublicOrigin(undefined)
      expect(linkOrigin("https://a.example/v1/x")).toBe("https://a.example")
      expect(canonicalRedirect(new Request("https://a.example/inbox"))).toBeNull()
      configurePublicOrigin("not a url")
      expect(linkOrigin("https://a.example/v1/x")).toBe("https://a.example")
      configurePublicOrigin("https://mail.example.com/some/path ")
      expect(linkOrigin("https://a.example/v1/x")).toBe("https://mail.example.com")
    } finally {
      configurePublicOrigin(env.MAILYARD_PUBLIC_ORIGIN)
    }
  })
})

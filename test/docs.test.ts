import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { absoluteLinks, DOC_PAGES } from "../src/docs/serve.ts"
import { TOOLS } from "../src/mcp/tools.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

/** The test Worker's public origin (vitest.config.ts: MAILYARD_PUBLIC_ORIGIN). */
const ORIGIN = "https://mailyard.test"
const get = (path: string, host = ORIGIN) =>
  exports.default.fetch(new Request(`${host}${path}`, { redirect: "manual" }))

const METHODS = ["get", "post", "put", "patch", "delete"] as const

describe("the docs (HAL-3773)", () => {
  it("serves /llms.txt as plain text, listing every page by its Markdown address on this origin", async () => {
    const res = await get("/llms.txt")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const body = await res.text()
    expect(body.startsWith("# Mailyard\n\n> ")).toBe(true)
    for (const page of DOC_PAGES) expect(body).toContain(`](${ORIGIN}/docs/${page.slug || "index"}.md)`)
    expect(body).toContain(`${ORIGIN}/openapi.json`)
    expect(body).toContain(`${ORIGIN}/llms-full.txt`)
    expect(body).not.toContain("{{origin}}")
  })

  it("builds every link on the public origin, whichever hostname was asked", async () => {
    const body = await (await get("/llms.txt", "https://api.mailyard.test")).text()
    expect(body).toContain(`${ORIGIN}/docs/getting-started.md`)
    expect(body).not.toContain("api.mailyard.test")
  })

  it("serves /llms-full.txt with every page, examples filled in for this install", async () => {
    const res = await get("/llms-full.txt")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const body = await res.text()
    for (const page of DOC_PAGES) expect(body).toContain(`<!-- ${ORIGIN}/docs/${page.slug || "index"}.md -->`)
    expect(body).toContain(`curl ${ORIGIN}/v1/send`)
    expect(body).not.toContain("{{origin}}")
    // Site-relative links are made absolute, so an agent reading the file can follow them.
    expect(body).not.toMatch(/\]\(\/(?!\/)/)
  })

  it("serves every page as HTML for people and as Markdown for agents", async () => {
    for (const page of DOC_PAGES) {
      const path = page.slug ? `/docs/${page.slug}` : "/docs"
      const html = await get(path)
      expect(html.status, path).toBe(200)
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
      const csp = html.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("default-src 'none'")
      const text = await html.text()
      expect(text).toContain("<h1>")
      expect(text).not.toContain("{{origin}}")
      // The page's own nav entry is marked current, and its script carries the CSP's nonce.
      expect(text).toMatch(new RegExp(`href="${path}" aria-current="page"`))
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
      expect(text).toContain(`<script nonce="${nonce}">`)

      const md = await get(`/docs/${page.slug || "index"}.md`)
      expect(md.status, `${path}.md`).toBe(200)
      expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
      expect((await md.text()).startsWith("# ")).toBe(true)
    }
  })

  it("gives each page one address", async () => {
    const slash = await get("/docs/agents/")
    expect(slash.status).toBe(308)
    expect(slash.headers.get("location")).toBe("/docs/agents")
    expect((await get("/docs/")).headers.get("location")).toBe("/docs")
    expect((await get("/docs/index")).headers.get("location")).toBe("/docs")
    expect((await get("/docs.md")).status).toBe(200)
  })

  it("answers 404 for a page that doesn't exist, in the form asked for", async () => {
    const html = await get("/docs/nope")
    expect(html.status).toBe(404)
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await html.text()).toContain('href="/docs/getting-started"')
    const md = await get("/docs/nope.md")
    expect(md.status).toBe(404)
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect((await get("/docs/Agents")).status).toBe(404)
    expect((await get("/docs/agents/more")).status).toBe(404)
  })

  it("only reads", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/docs`, { method: "POST", body: "x" }))
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET, HEAD")
  })

  it("documents every operation in /openapi.json", async () => {
    const doc = await json<{ paths: Record<string, Record<string, unknown>> }>(await call("/openapi.json"))
    const md = await (await get("/docs/api.md")).text()
    const headings = new Set([...md.matchAll(/^### ([A-Z]+ \S+)$/gm)].map((m) => m[1]))
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`),
    )
    expect(operations.length).toBeGreaterThan(200)
    expect([...headings].sort()).toEqual([...operations].sort())
    expect(md).toContain(`${operations.length} operations`)
    // The send endpoint's body is documented field by field, with the descriptions from the schema.
    const send = md.slice(md.indexOf("### POST /v1/send"), md.indexOf("### POST /v1/track"))
    expect(send).toContain("| `to` |")
    expect(send).toContain("| `idempotency-key` | header |")
    expect(send).toMatch(/Errors: .*`409` IdempotencyConflict/)
  })

  it("documents every MCP tool, with the scope it needs", async () => {
    const md = await (await get("/docs/mcp-tools.md")).text()
    const headings = [...md.matchAll(/^## (\S+)$/gm)].map((m) => m[1])
    expect(headings).toEqual(TOOLS.map((t) => t.name))
    for (const t of TOOLS) expect(md).toContain(`Needs the \`${t.scope}\` scope.`)
    const send = md.slice(md.indexOf("## send_email"))
    expect(send).toContain("| `confirm` |")
  })

  it("links within the docs resolve", async () => {
    const slugs = new Set(DOC_PAGES.map((p) => p.slug))
    for (const page of DOC_PAGES) {
      const text = await (await get(page.slug ? `/docs/${page.slug}` : "/docs")).text()
      for (const [, slug] of text.matchAll(/href="\/docs(?:\/([a-z0-9-]+))?"/g))
        expect(slugs.has(slug ?? ""), `${page.slug || "index"} links to /docs/${slug}`).toBe(true)
      // Every in-page anchor link has its target on the page.
      const ids = new Set([...text.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
      for (const [, id] of text.matchAll(/href="#([^"]+)"/g))
        expect(ids.has(id), `${page.slug || "index"} #${id}`).toBe(true)
    }
  })

  it("makes site links absolute and points docs pages at their Markdown", () => {
    expect(
      absoluteLinks("[a](/docs/agents) [b](/docs) [c](/openapi.json) [d](/docs/api#actions)", ORIGIN),
    ).toBe(
      `[a](${ORIGIN}/docs/agents.md) [b](${ORIGIN}/docs/index.md) [c](${ORIGIN}/openapi.json) [d](${ORIGIN}/docs/api.md#actions)`,
    )
    expect(absoluteLinks("[x](https://example.com/docs) `](/kept)`", ORIGIN)).toContain(
      "https://example.com/docs",
    )
  })

  it("never puts ticket numbers in front of people", async () => {
    for (const path of ["/llms-full.txt", "/openapi.json", "/docs", "/docs/api", "/docs/mcp-tools"]) {
      const body = await (await get(path)).text()
      expect(body, path).not.toMatch(/\bHAL-\d+/)
    }
  })
})

describe("an agent with only /llms.txt and a key (HAL-3773)", () => {
  it("finds Get started and sends an email by running its example as written", async () => {
    const index = await (await get("/llms.txt")).text()
    const guideUrl = /\[Get started\]\(([^)]+)\)/.exec(index)?.[1]
    expect(guideUrl).toBe(`${ORIGIN}/docs/getting-started.md`)
    const guide = await (await exports.default.fetch(new Request(guideUrl ?? ""))).text()

    // The first shell example, read the way an agent would: the URL, the headers and the JSON body.
    const example = /```sh\n([\s\S]*?)```/.exec(guide)?.[1] ?? ""
    const url = /curl (\S+)/.exec(example)?.[1]
    const headers = [...example.matchAll(/-H "([^:]+): ([^"]+)"/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    )
    const body = /-d '([\s\S]*?)'/.exec(example)?.[1]
    expect(url).toBe(`${ORIGIN}/v1/send`)
    expect(body).toBeDefined()

    const { key } = await createKey("secret", ["send"])
    const sent = await exports.default.fetch(
      new Request(url ?? "", {
        method: "POST",
        headers: headers.map(([name, value]): [string, string] => [
          name,
          value.replace("$MAILYARD_KEY", key),
        ]),
        body: body ?? "",
      }),
    )
    expect(sent.status, await sent.clone().text()).toBe(200)
    const answer = await json<{ success: boolean; data: { emails: Array<{ status: string }> } }>(sent)
    // The guide's description of the answer matches what came back.
    expect(answer.success).toBe(true)
    expect(answer.data.emails).toHaveLength(1)
    expect(["sent", "deferred"]).toContain(answer.data.emails[0]?.status)
  })
})

describe("the docs over MCP (HAL-3773)", () => {
  const rpc = async (key: string, method: string, params?: unknown) => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      }),
    )
    expect(res.status).toBe(200)
    return await json<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>(res)
  }

  it("says it has resources", async () => {
    const init = await rpc(ADMIN, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })
    expect(init.result?.capabilities).toMatchObject({ resources: { listChanged: false } })
  })

  it("lists every page and reads one, to any key that can connect", async () => {
    const { key } = await createKey("secret", ["read"])
    const list = await rpc(key, "resources/list")
    const resources = (list.result?.resources ?? []) as Array<{ uri: string; mimeType: string }>
    expect(resources.map((r) => r.uri)).toEqual(DOC_PAGES.map((p) => `mailyard://docs/${p.slug || "index"}`))
    const read = await rpc(key, "resources/read", { uri: "mailyard://docs/getting-started" })
    const [content] = (read.result?.contents ?? []) as Array<{ uri: string; mimeType: string; text: string }>
    expect(content?.mimeType).toBe("text/markdown")
    expect(content?.text).toContain(`curl ${ORIGIN}/v1/send`)
    expect(content?.text).toContain(`(${ORIGIN}/docs/agents.md)`)
  })

  it("refuses a resource it doesn't have", async () => {
    for (const uri of ["mailyard://docs/nope", "file:///etc/passwd", ""]) {
      const read = await rpc(ADMIN, "resources/read", { uri })
      expect(read.error?.code).toBe(-32002)
    }
  })
})

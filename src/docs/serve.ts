import { inputSchemaOf } from "../mcp/schema.ts"
import { TOOLS } from "../mcp/tools.ts"
import { GUIDES } from "./content.gen.ts"
import { apiReferenceMarkdown, mcpToolsMarkdown, type OpenApiDoc, type ToolDoc } from "./reference.ts"
import { docsCsp, docsPage, type NavItem } from "./render.ts"

/**
 * Mailyard's docs, served by every install (HAL-3773), readable signed out:
 *
 * - `/docs` and `/docs/<page>`: HTML for people;
 * - `/docs/<page>.md` (and `/docs/index.md`): the same page as Markdown, with absolute links;
 * - `/llms.txt`: the index, per the llms.txt convention; `/llms-full.txt`: every page in one file.
 *
 * Guides are hand-written (docs/site, built into content.gen.ts); the HTTP API and MCP tool pages are
 * written from this Worker's own OpenAPI document and tool list on each request. `{{origin}}` in a guide
 * becomes this install's origin, so every example runs as written against it.
 */

export interface DocsSources {
  /** This Worker's OpenAPI document, as `/openapi.json` serves it. */
  readonly openapi: () => Promise<OpenApiDoc>
}

export interface DocPage {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly group: NavItem["group"]
}

const START = new Set(["", "getting-started", "agents", "mcp"])

/** Every page, in reading order: the guides, then the two generated references. */
export const DOC_PAGES: ReadonlyArray<DocPage> = [
  ...GUIDES.map((g) => ({
    slug: g.slug,
    title: g.slug === "" ? "Overview" : g.title,
    summary: g.summary,
    group: START.has(g.slug) ? ("Start here" as const) : ("Guides" as const),
  })),
  {
    slug: "api",
    title: "HTTP API",
    summary: "Every endpoint this Mailyard serves, written from its own OpenAPI document.",
    group: "Reference",
  },
  {
    slug: "mcp-tools",
    title: "MCP tools",
    summary: "Every tool the MCP server offers, with its inputs and the scope it needs.",
    group: "Reference",
  },
]

/** The MCP tools as the docs describe them. */
export const toolDocs = (): ReadonlyArray<ToolDoc> =>
  TOOLS.map((t) => ({
    name: t.name,
    title: t.annotations.title,
    description: t.description,
    scope: t.scope,
    readOnly: t.annotations.readOnlyHint,
    destructive: t.annotations.destructiveHint,
    inputSchema: inputSchemaOf(t) as ToolDoc["inputSchema"],
  }))

/** A page's Markdown with `{{origin}}` filled in; links stay site-relative (`/docs/…`). */
const pageMarkdown = async (slug: string, origin: string, sources: DocsSources) => {
  if (slug === "api") return apiReferenceMarkdown(await sources.openapi(), origin)
  if (slug === "mcp-tools") return mcpToolsMarkdown(toolDocs(), origin)
  const guide = GUIDES.find((g) => g.slug === slug)
  return guide ? guide.markdown.replaceAll("{{origin}}", origin) : null
}

/**
 * Markdown for reading outside the site: every site-relative link made absolute, and links to other
 * docs pages pointed at their `.md`, so an agent can follow them without parsing HTML.
 */
export const absoluteLinks = (markdown: string, origin: string) =>
  markdown.replace(/\]\((\/[^)\s]*)\)/g, (_, target: string) => {
    const [path = "", hash] = target.split("#", 2)
    const page = /^\/docs(?:\/([a-z0-9-]+))?\/?$/.exec(path)
    const to = page ? `/docs/${page[1] ?? "index"}.md` : path
    return `](${origin}${to}${hash ? `#${hash}` : ""})`
  })

/** A docs page as Markdown for agents (`.md`, `llms-full.txt`, the MCP resource). */
export const docMarkdown = async (slug: string, origin: string, sources: DocsSources) => {
  const md = await pageMarkdown(slug, origin, sources)
  return md === null ? null : absoluteLinks(md, origin)
}

export const llmsTxt = (origin: string) => {
  const line = (p: DocPage) => `- [${p.title}](${origin}/docs/${p.slug || "index"}.md): ${p.summary}`
  const groups = (["Start here", "Guides", "Reference"] as const).map((g) => ({
    g,
    pages: DOC_PAGES.filter((p) => p.group === g),
  }))
  return `# Mailyard

> Email on your own Cloudflare account: mailboxes that people and AI agents read and write, transactional sending with a Plunk-compatible API, contacts, campaigns and automations. This install answers at ${origin}.

Authenticate with an API key as \`Authorization: Bearer sk_…\`. The MCP server is at ${origin}/mcp. Every page below is Markdown; the same pages are HTML without the \`.md\`.

${groups.map(({ g, pages }) => `## ${g}\n\n${pages.map(line).join("\n")}`).join("\n\n")}
- [OpenAPI document](${origin}/openapi.json): the machine-readable contract for the HTTP API.

## Optional

- [Every page in one file](${origin}/llms-full.txt): all of the above, for loading in one go.
`
}

export const llmsFullTxt = async (origin: string, sources: DocsSources) => {
  const pages = await Promise.all(
    DOC_PAGES.map(async (p) => {
      const md = await docMarkdown(p.slug, origin, sources)
      return `<!-- ${origin}/docs/${p.slug || "index"}.md -->\n\n${md ?? ""}`.trimEnd()
    }),
  )
  return `${pages.join("\n\n---\n\n")}\n`
}

const DOCS_PATH = /^\/docs(?:\/([a-z0-9-]*?))?(\.md)?\/?$/

/** Whether the docs answer this path. Keep in step with `run_worker_first` in wrangler.jsonc. */
export const isDocsPath = (path: string) =>
  path === "/llms.txt" ||
  path === "/llms-full.txt" ||
  path === "/docs" ||
  path === "/docs.md" ||
  path.startsWith("/docs/")

const text = (body: string, type: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  })

const nonceOf = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))

const html = (page: Parameters<typeof docsPage>[0], status = 200) =>
  new Response(docsPage(page), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": docsCsp(page.nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  })

const NAV: ReadonlyArray<NavItem> = DOC_PAGES.map(({ slug, title, group }) => ({ slug, title, group }))

const notFound = (wantsMarkdown: boolean, origin: string) => {
  const list = DOC_PAGES.map((p) => `- [${p.title}](/docs${p.slug ? `/${p.slug}` : ""})`).join("\n")
  const markdown = `# Not found\n\nThere's no docs page here. These are the pages:\n\n${list}\n`
  if (wantsMarkdown) return text(absoluteLinks(markdown, origin), "text/markdown", 404)
  return html(
    {
      title: "Not found",
      description: "No docs page here.",
      slug: null,
      markdown,
      nav: NAV,
      nonce: nonceOf(),
    },
    404,
  )
}

/** Answers a docs path, or null when the path isn't one (see `isDocsPath`). */
export const handleDocs = async (
  request: Request,
  origin: string,
  sources: DocsSources,
): Promise<Response | null> => {
  const url = new URL(request.url)
  const path = url.pathname
  if (!isDocsPath(path)) return null
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
  if (path === "/llms.txt") return text(llmsTxt(origin), "text/plain")
  if (path === "/llms-full.txt") return text(await llmsFullTxt(origin, sources), "text/plain")
  const match = DOCS_PATH.exec(path)
  if (!match) return notFound(path.endsWith(".md"), origin)
  const raw = match[1] ?? ""
  const markdown = match[2] === ".md"
  const slug = raw === "index" ? "" : raw
  // One address per page: /docs/agents/ and /docs/index go to /docs/agents and /docs.
  if (!markdown && (path.endsWith("/") || raw === "index") && path !== "/docs/") {
    return new Response(null, {
      status: 308,
      headers: { location: `/docs${slug ? `/${slug}` : ""}${url.search}` },
    })
  }
  if (!markdown && path === "/docs/")
    return new Response(null, { status: 308, headers: { location: "/docs" } })
  const page = DOC_PAGES.find((p) => p.slug === slug)
  if (!page) return notFound(markdown, origin)
  if (markdown) {
    const md = await docMarkdown(slug, origin, sources)
    return md === null ? notFound(true, origin) : text(md, "text/markdown")
  }
  const md = await pageMarkdown(slug, origin, sources)
  if (md === null) return notFound(false, origin)
  return html({
    title: slug === "" ? "Mailyard docs" : page.title,
    description: page.summary,
    slug,
    markdown: md,
    nav: NAV,
    nonce: nonceOf(),
  })
}

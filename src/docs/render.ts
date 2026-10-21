import { Marked, type Tokens } from "marked"
import { TOKENS_CSS } from "./content.gen.ts"

/**
 * The docs' HTML (HAL-3773): Markdown rendered with `marked`, in a page that uses the app's own tokens
 * and fonts, light and dark, phone first. Headings get ids, so every section can be linked; code blocks
 * get a copy button. The sources are this repo's guides and documents generated from its own code.
 */

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** A heading's id: lower-case words joined by hyphens. reference.ts links to the same ids. */
export const anchorOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

export interface Rendered {
  readonly html: string
  /** The page's sections (its `##` headings), for "On this page". */
  readonly sections: ReadonlyArray<{ readonly id: string; readonly text: string }>
}

export const renderMarkdown = (markdown: string): Rendered => {
  const sections: Array<{ id: string; text: string }> = []
  const seen = new Map<string, number>()
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(
        this: { parser: { parseInline: (t: Tokens.Heading["tokens"]) => string } },
        token: Tokens.Heading,
      ) {
        const inner = this.parser.parseInline(token.tokens)
        const base = anchorOf(token.text) || "section"
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n === 0 ? base : `${base}-${n}`
        if (token.depth === 2) sections.push({ id, text: token.text.replace(/`/g, "") })
        if (token.depth === 1) return `<h1>${inner}</h1>\n`
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${token.depth}>\n`
      },
      code(token: Tokens.Code) {
        const lang = (token.lang ?? "").split(/\s/)[0] ?? ""
        return `<div class="code"><pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(token.text)}</code></pre><button type="button" class="copy" data-copy>Copy</button></div>\n`
      },
      table(
        this: { parser: { parseInline: (t: Tokens.TableCell["tokens"]) => string } },
        token: Tokens.Table,
      ) {
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("")
        const rows = token.rows
          .map(
            (row) => `<tr>${row.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`,
          )
          .join("\n")
        return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`
      },
    },
  })
  return { html: marked.parse(markdown, { async: false }) as string, sections }
}

const MARK = `<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><mask id="moat" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><rect x="12" y="13" width="8" height="8" fill="#000"/></mask><g mask="url(#moat)"><path fill="currentColor" fill-rule="evenodd" d="M6.5 7H25.5A4.5 4.5 0 0 1 30 11.5V20.5A4.5 4.5 0 0 1 25.5 25H6.5A4.5 4.5 0 0 1 2 20.5V11.5A4.5 4.5 0 0 1 6.5 7ZM6.5 10H25.5A1.5 1.5 0 0 1 27 11.5V20.5A1.5 1.5 0 0 1 25.5 22H6.5A1.5 1.5 0 0 1 5 20.5V11.5A1.5 1.5 0 0 1 6.5 10Z"/><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M4.379 9.379L16 17L27.621 9.379"/></g><rect x="13" y="14" width="6" height="6" fill="var(--ember-700)"/></svg>`

const DOCS_CSS = `
@font-face{font-family:"Funnel Display";src:url(/ui/fonts/FunnelDisplay-Variable.woff2) format("woff2");font-weight:300 800;font-display:swap}
@font-face{font-family:"Funnel Sans";src:url(/ui/fonts/FunnelSans-Variable.woff2) format("woff2");font-weight:300 800;font-display:swap}
@font-face{font-family:"Departure Mono";src:url(/ui/fonts/DepartureMono-Regular.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/ui/fonts/GeistMono-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--background-200);color:var(--gray-1000);font:400 16px/1.65 var(--font-sans);overflow-wrap:break-word}
a{color:inherit;text-decoration-color:var(--gray-600);text-underline-offset:3px}
a:hover{text-decoration-color:var(--gray-1000)}
:focus-visible{outline:2px solid var(--ember-700);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;z-index:10;background:var(--background-100);padding:8px 12px;border-radius:8px}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;background:color-mix(in oklch,var(--background-100) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--gray-400)}
header.top .brand{display:flex;align-items:center;gap:8px;text-decoration:none;font:600 17px/1 var(--font-display);letter-spacing:-0.01em;min-height:44px}
header.top .brand span{color:var(--gray-900);font-weight:500}
header.top nav{margin-left:auto;display:flex;gap:4px;align-items:center}
header.top nav a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:8px;text-decoration:none;font-size:14px;color:var(--gray-900)}
header.top nav a:hover{background:var(--gray-200);color:var(--gray-1000)}
header.top nav a.primary{background:var(--gray-1000);color:var(--background-100)}
header.top nav a.primary:hover{background:color-mix(in oklch,var(--gray-1000) 84%,var(--background-100))}
.layout{display:grid;grid-template-columns:minmax(0,1fr);max-width:1240px;margin:0 auto;padding:0 16px}
.side .wide{display:none}
.side details{margin:16px 0 0;border:1px solid var(--gray-400);border-radius:12px;background:var(--background-100)}
.side summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;min-height:44px;padding:0 14px;font-weight:500}
.side summary::-webkit-details-marker{display:none}
.side summary::after{content:"";width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .15s}
.side details[open] summary::after{transform:rotate(-135deg) translateY(-2px)}
.side ul{list-style:none;margin:0;padding:4px 8px 10px}
.side li a{display:flex;align-items:center;min-height:36px;padding:0 10px;border-radius:8px;text-decoration:none;color:var(--gray-900);font-size:15px}
.side li a:hover{background:var(--gray-200);color:var(--gray-1000)}
.side li a[aria-current=page]{background:var(--gray-200);color:var(--gray-1000);font-weight:500;box-shadow:inset 2px 0 0 var(--ember-700)}
.side .label{padding:10px 10px 2px;font-size:13px;color:var(--gray-900)}
main{min-width:0;padding:24px 0 64px}
article{max-width:760px}
article h1{font:600 32px/1.2 var(--font-display);letter-spacing:-0.025em;margin:8px 0 12px}
article h2{font:600 22px/1.3 var(--font-display);letter-spacing:-0.015em;margin:44px 0 10px;padding-top:4px}
article h3{font:600 17px/1.4 var(--font-sans);margin:32px 0 8px}
article h3 code{font-size:15px}
article h2,article h3{position:relative;scroll-margin-top:72px}
.anchor{position:absolute;left:-0.9em;width:0.9em;color:var(--gray-700);text-decoration:none;opacity:0;font-weight:400}
h2:hover .anchor,h3:hover .anchor,.anchor:focus{opacity:1}
article p,article ul,article ol{margin:0 0 14px}
article li{margin:4px 0}
article strong{font-weight:600}
code{font-family:var(--font-mono);font-size:0.86em;background:var(--gray-200);border:1px solid var(--gray-300);border-radius:5px;padding:1px 5px}
.code{position:relative;margin:0 0 18px}
pre{margin:0;padding:14px 16px;overflow-x:auto;background:var(--background-100);border:1px solid var(--gray-400);border-radius:10px;font:400 13.5px/1.6 var(--font-mono);-webkit-overflow-scrolling:touch}
pre code{background:none;border:0;padding:0;font-size:inherit}
.copy{position:absolute;top:8px;right:8px;min-height:32px;padding:0 10px;border-radius:7px;border:1px solid var(--gray-400);background:var(--background-100);color:var(--gray-900);font:500 12px/1 var(--font-sans);cursor:pointer;opacity:0;transition:opacity .15s}
.code:hover .copy,.copy:focus-visible{opacity:1}
@media (hover:none){.copy{opacity:1}}
.table{overflow-x:auto;margin:0 0 18px;border:1px solid var(--gray-400);border-radius:10px;background:var(--background-100);-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--gray-300)}
th{font-weight:600;background:var(--gray-100);white-space:nowrap}
tr:last-child td{border-bottom:0}
td:first-child{min-width:7.5em}
td:first-child code{white-space:nowrap}
td{min-width:6em}
td:last-child{min-width:14em}
td:not(:first-child)>code:only-child{display:inline-block;min-width:10em}
.toc{display:none}
.toc .label{font-size:13px;color:var(--gray-900);margin:0 0 6px}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--gray-400)}
.toc a{display:block;padding:4px 0 4px 12px;margin-left:-1px;border-left:1px solid transparent;text-decoration:none;font-size:13.5px;color:var(--gray-900)}
.toc a:hover{color:var(--gray-1000);border-left-color:var(--gray-1000)}
.pagefoot{max-width:760px;margin-top:48px;padding-top:16px;border-top:1px solid var(--gray-400);display:flex;flex-wrap:wrap;gap:8px 20px;font-size:14px;color:var(--gray-900)}
.pagefoot a{display:inline-flex;align-items:center;min-height:44px}
@media (min-width:900px){
  .layout{grid-template-columns:232px minmax(0,1fr);gap:40px;padding:0 24px}
  .side{position:sticky;top:56px;align-self:start;max-height:calc(100dvh - 56px);overflow-y:auto;padding:20px 0 32px}
  .side details{display:none}
  .side .wide{display:block}
  .side ul{padding:0}
  main{padding:40px 0 80px}
  article h1{font-size:40px}
}
@media (min-width:1200px){
  .layout{grid-template-columns:232px minmax(0,1fr) 200px}
  .toc{display:block;position:sticky;top:56px;align-self:start;padding:44px 0 32px;max-height:calc(100dvh - 56px);overflow-y:auto}
}
@media (max-width:420px){header.top nav a:not(.primary){display:none}}
@media print{header.top,.side,.toc,.copy{display:none}.layout{display:block}}
`

/** Copy buttons, and the theme the app stored: `mailyard-theme` (light, dark, or follow the system). */
const SCRIPT = `try{var t=new URLSearchParams(location.search).get("theme")||localStorage.getItem("mailyard-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}
document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;var c=b.parentNode.querySelector("code");if(!c||!navigator.clipboard)return;navigator.clipboard.writeText(c.textContent).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})})`

export interface NavItem {
  readonly slug: string
  readonly title: string
  readonly group: "Start here" | "Guides" | "Reference"
}

export const docsCsp = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")

export const docsPage = (input: {
  readonly title: string
  readonly description: string
  readonly slug: string | null
  readonly markdown: string
  readonly nav: ReadonlyArray<NavItem>
  readonly nonce: string
}) => {
  const { html, sections } = renderMarkdown(input.markdown)
  const href = (slug: string) => (slug ? `/docs/${slug}` : "/docs")
  const groups = (["Start here", "Guides", "Reference"] as const).map((g) => ({
    g,
    items: input.nav.filter((n) => n.group === g),
  }))
  const navList = groups
    .map(
      ({ g, items }) =>
        `<li class="label">${g}</li>${items
          .map(
            (n) =>
              `<li><a href="${href(n.slug)}"${n.slug === input.slug ? ' aria-current="page"' : ""}>${esc(n.title)}</a></li>`,
          )
          .join("")}`,
    )
    .join("")
  const current = input.nav.find((n) => n.slug === input.slug)
  const toc =
    sections.length > 1
      ? `<aside class="toc" aria-label="On this page"><p class="label">On this page</p><ul>${sections
          .map((s) => `<li><a href="#${s.id}">${esc(s.text)}</a></li>`)
          .join("")}</ul></aside>`
      : ""
  const mdHref = input.slug === null ? null : input.slug ? `/docs/${input.slug}.md` : "/docs/index.md"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(input.title === "Mailyard docs" ? input.title : `${input.title} · Mailyard docs`)}</title>
<meta name="description" content="${esc(input.description)}">
<link rel="icon" href="/ui/brand/favicon.svg" type="image/svg+xml">
${mdHref ? `<link rel="alternate" type="text/markdown" href="${mdHref}">` : ""}
<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt">
<link rel="preload" href="/ui/fonts/FunnelSans-Variable.woff2" as="font" type="font/woff2" crossorigin>
<script nonce="${input.nonce}">${SCRIPT}</script>
<style nonce="${input.nonce}">${TOKENS_CSS}${DOCS_CSS}</style>
</head>
<body>
<a class="skip" href="#content">Skip to the page</a>
<header class="top">
<a class="brand" href="/docs">${MARK}Mailyard <span>docs</span></a>
<nav aria-label="Elsewhere"><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a class="primary" href="/">Open Mailyard</a></nav>
</header>
<div class="layout">
<div class="side"><details class="narrow"><summary>${esc(current?.title ?? "Pages")}</summary><nav aria-label="Docs"><ul>${navList}</ul></nav></details><nav class="wide" aria-label="Docs"><ul>${navList}</ul></nav></div>
<main id="content">
<article class="prose">
${html}
</article>
<footer class="pagefoot">${mdHref ? `<a href="${mdHref}">This page as Markdown</a>` : ""}<a href="/llms-full.txt">Every page in one file</a></footer>
</main>
${toc}
</div>
</body>
</html>`
}

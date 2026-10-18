import type { BrandSettings } from "../domain/brand.ts"
import { toBrand } from "../domain/brand.ts"

/**
 * The look of the pages people reach from an email without logging in (HAL-3377): the preference
 * page, the confirmation and signup result pages, and "view in browser". A workspace with its own
 * brand gets its colours, logo and fonts; one without gets Flareyard's tokens (design/tokens in the
 * platform repo): Funnel Display and Sans, gray-1000 actions, light and dark. Phone first: one
 * column, 16px type, 44px targets, no horizontal scroll.
 */

/** Text and double-quoted attributes: every attribute here is written in double quotes. */
const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** Flareyard's fonts, both SIL OFL and on Google Fonts. */
export const FLAREYARD_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500..700&family=Funnel+Sans:wght@400..600&display=swap"

type Palette = {
  readonly bg: string
  readonly surface: string
  readonly fg: string
  readonly body: string
  readonly muted: string
  readonly border: string
  readonly accent: string
  readonly onAccent: string
  readonly emphasis: string
  /** Emphasis as text: dark enough for 4.5:1 at small sizes (ember-900 on white). */
  readonly emphasisText: string
  readonly success: readonly [bg: string, fg: string]
  readonly warning: readonly [bg: string, fg: string]
  readonly danger: readonly [bg: string, fg: string]
}

/** Flareyard's token values, light and dark (tokens.css, 2026-10-17). */
const FLAREYARD_LIGHT: Palette = {
  bg: "#fafafa", // background-200
  surface: "#ffffff", // background-100
  fg: "#171717", // gray-1000
  body: "#171717",
  muted: "#717171", // gray-900
  border: "#e4e4e4", // gray-400
  accent: "#171717", // actions are gray-1000
  onAccent: "#ffffff",
  emphasis: "#e84e10", // ember-700
  emphasisText: "#ae3100", // ember-900
  success: ["#f2fef3", "#057836"], // green-100 / green-900
  warning: ["#fff9ec", "#8f5400"], // amber-100 / amber-900
  danger: ["#fff4f2", "#b32429"], // red-100 / red-900
}
const FLAREYARD_DARK: Palette = {
  bg: "#000000",
  surface: "#0a0a0a",
  fg: "#f2f2f2",
  body: "#f2f2f2",
  muted: "#a4a4a4",
  border: "#2b2b2b",
  accent: "#f2f2f2",
  onAccent: "#171717",
  emphasis: "#f96736", // ember-800 in dark
  emphasisText: "#ff9c7a", // ember-900 in dark
  success: ["#071b0c", "#87d297"],
  warning: ["#201301", "#e8b367"],
  danger: ["#2a0a09", "#ff958d"],
}
/** A custom brand keeps its accent in dark mode; the neutrals turn dark around it. */
const BRAND_DARK_NEUTRALS = {
  bg: "#0f1012",
  surface: "#17181b",
  fg: "#f2f3f5",
  body: "#d5d8dc",
  muted: "#9aa0a8",
  border: "#2a2d31",
}

export interface PageTheme {
  readonly name: string
  readonly logoUrl: string | null
  readonly siteUrl: string | null
  readonly fontsHref: string | undefined
  readonly fonts: { readonly display: string; readonly body: string }
  readonly light: Palette
  readonly dark: Palette
}

/** The page theme for a workspace: its brand when it has set one, else Flareyard's. */
export const pageTheme = (brand: BrandSettings | null): PageTheme => {
  if (!brand)
    return {
      name: "Mailing preferences",
      logoUrl: null,
      siteUrl: null,
      fontsHref: FLAREYARD_FONTS_HREF,
      fonts: {
        display: '"Funnel Display","Funnel Sans",system-ui,sans-serif',
        body: '"Funnel Sans","Geist",system-ui,sans-serif',
      },
      light: FLAREYARD_LIGHT,
      dark: FLAREYARD_DARK,
    }
  const t = toBrand(brand).theme
  const c = t.colors
  const light: Palette = {
    bg: c.bg,
    surface: c.white,
    fg: c.fg,
    body: c.body,
    muted: c.muted,
    border: c.border,
    accent: c.indigo,
    onAccent: "#ffffff",
    emphasis: c.indigo,
    emphasisText: c.indigo,
    success: FLAREYARD_LIGHT.success,
    warning: FLAREYARD_LIGHT.warning,
    danger: [FLAREYARD_LIGHT.danger[0], c.red],
  }
  return {
    name: brand.name,
    logoUrl: t.logoUrl ?? null,
    siteUrl: brand.siteUrl === "https://example.com" ? null : brand.siteUrl,
    fontsHref: t.fontsHref,
    fonts: { display: t.fonts.display, body: t.fonts.body },
    light,
    dark: {
      ...light,
      ...BRAND_DARK_NEUTRALS,
      success: FLAREYARD_DARK.success,
      warning: FLAREYARD_DARK.warning,
      danger: FLAREYARD_DARK.danger,
    },
  }
}

const vars = (p: Palette) =>
  `--bg:${p.bg};--surface:${p.surface};--fg:${p.fg};--body:${p.body};--muted:${p.muted};--border:${p.border};--accent:${p.accent};--on-accent:${p.onAccent};--em:${p.emphasis};--em-text:${p.emphasisText};--ok-bg:${p.success[0]};--ok:${p.success[1]};--warn-bg:${p.warning[0]};--warn:${p.warning[1]};--bad-bg:${p.danger[0]};--bad:${p.danger[1]}`

export type NoticeKind = "success" | "warning" | "danger" | "info"
export const notice = (kind: NoticeKind, html: string) =>
  `<div class="notice ${kind}" role="${kind === "danger" ? "alert" : "status"}">${html}</div>`

/** The CSP for these pages: inline styles, the fonts' own hosts, images from anywhere https. */
export const shellCsp = (fontsHref: string | undefined) => {
  const fonts = fontsHref ? new URL(fontsHref).origin : ""
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${fonts}`.trim(),
    `font-src ${fonts ? "https://fonts.gstatic.com" : "'none'"}`,
    "img-src https: data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/**
 * A whole page: the card, the brand at the top, and a footer with the sender's postal address and
 * privacy link when compliance has them. `body` is trusted HTML built by the caller.
 */
export const shellPage = (input: {
  readonly theme: PageTheme
  readonly title: string
  readonly body: string
  readonly status?: number
  readonly postalAddress?: string | null
  readonly privacyUrl?: string | null
  /** Seconds, then a redirect: the `Refresh` header and a meta refresh, so it works without JavaScript. */
  readonly redirect?: { readonly url: string; readonly after: number } | null
}) => {
  const { theme } = input
  const brandMark = theme.logoUrl
    ? `<img class="logo" src="${esc(theme.logoUrl)}" alt="${esc(theme.name)}" height="32">`
    : `<p class="brand">${esc(theme.name)}</p>`
  const footerBits = [
    input.postalAddress ? `<span>${esc(input.postalAddress)}</span>` : "",
    input.privacyUrl ? `<a href="${esc(input.privacyUrl)}">Privacy</a>` : "",
    theme.siteUrl ? `<a href="${esc(theme.siteUrl)}">${esc(theme.name)}</a>` : "",
  ].filter(Boolean)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${input.redirect ? `<meta http-equiv="refresh" content="${input.redirect.after};url=${esc(input.redirect.url)}">` : ""}
<title>${esc(input.title)} · ${esc(theme.name)}</title>
${theme.fontsHref ? `<link rel="stylesheet" href="${esc(theme.fontsHref)}">` : ""}
<style>
:root{${vars(theme.light)};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(theme.dark)}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.55 ${theme.fonts.body};min-height:100vh;padding:clamp(16px,6vw,64px) 16px}
.wrap{max-width:34rem;margin:0 auto}
main{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:clamp(20px,5vw,36px);overflow-wrap:anywhere}
.logo{display:block;height:32px;width:auto;max-width:100%;margin:0 0 24px}
.brand{margin:0 0 20px;font:600 15px/1.2 ${theme.fonts.display};color:var(--fg)}
h1{margin:0 0 8px;font:600 clamp(1.4rem,4.5vw,1.75rem)/1.2 ${theme.fonts.display};color:var(--fg)}
h2{margin:0 0 8px;font:600 1rem/1.3 ${theme.fonts.display};color:var(--fg)}
p{margin:0 0 16px}.muted{color:var(--muted)}
a{color:var(--fg)}
.notice{padding:12px 16px;border-radius:10px;margin:0 0 20px;border:1px solid transparent}
.notice.success{background:var(--ok-bg);color:var(--ok)}.notice.warning{background:var(--warn-bg);color:var(--warn)}
.notice.danger{background:var(--bad-bg);color:var(--bad)}.notice.info{background:var(--bg);border-color:var(--border);color:var(--body)}
.notice form{margin:8px 0 0}.notice button{width:auto}
fieldset{border:1px solid var(--border);border-radius:12px;padding:4px 16px;margin:0 0 20px}
legend{padding:0 6px;font-weight:600;color:var(--fg)}
label.topic{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer}
label.topic:last-of-type{border-bottom:0}
label.topic input{width:22px;height:22px;margin:2px 0 0;accent-color:var(--accent);flex:none}
label.topic span{display:block;color:var(--fg)}label.topic small{display:block;color:var(--muted)}
label.topic span.tag{display:inline-block;color:var(--em-text)}
.tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;font-size:.75rem;line-height:1.6;color:var(--em-text);border:1px solid currentColor;vertical-align:1px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
button,.button{font:500 16px/1 ${theme.fonts.body};min-height:44px;padding:12px 18px;border-radius:10px;border:1px solid var(--accent);cursor:pointer;background:var(--accent);color:var(--on-accent);text-decoration:none;display:inline-flex;align-items:center}
button.secondary{background:transparent;color:var(--fg);border-color:var(--border)}
button.link{background:none;border:0;padding:0;min-height:24px;color:inherit;text-decoration:underline;font-weight:600}
input[type=email]{font:inherit;font-size:16px;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg);margin:0 0 12px}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--em);outline-offset:2px}
footer{margin:16px 4px 0;font-size:.8rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 16px}
footer a{color:inherit;display:inline-flex;align-items:center;min-height:24px}
@media (pointer:coarse){footer a,button.link{min-height:44px}}
</style>
</head>
<body><div class="wrap"><main>
${brandMark}
${input.body}
</main>${footerBits.length ? `<footer>${footerBits.join("")}</footer>` : ""}</div></body>
</html>`
  return new Response(html, {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": shellCsp(theme.fontsHref),
      ...(input.redirect ? { refresh: `${input.redirect.after};url=${input.redirect.url}` } : {}),
    },
  })
}

export { esc as escapeHtml }

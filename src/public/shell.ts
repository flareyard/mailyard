import type { BrandSettings } from "../domain/brand.ts"
import { toBrand } from "../domain/brand.ts"
import { PUBLIC_CSS } from "./style.ts"

/**
 * The look of the pages people reach from an email without logging in (HAL-3377): the preference
 * page, the confirmation and signup result pages, and "view in browser". A workspace with its own
 * brand gets its colours, logo and fonts; one without gets Flareyard's tokens (design/tokens in the
 * platform repo): Funnel Display and Sans, gray-1000 actions, light and dark.
 * Phone first: one column, 16px type, 44px targets, no horizontal scroll. v2 (public-v2 design):
 * a Card with a header and a body on a dot grid, shadcn-style controls, the CSS in style.ts.
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
/** WCAG relative luminance and contrast, for the brand's dark-mode colours below. */
const channel = (hex: string, i: number) => {
  const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const mixWhite = (hex: string, t: number) =>
  `#${[0, 1, 2]
    .map((i) => {
      const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
      return Math.round(c + (255 - c) * t)
        .toString(16)
        .padStart(2, "0")
    })
    .join("")}`
/** The brand colour lifted toward white just far enough to reach `ratio` against a dark surface. */
const readableOn = (color: string, surface: string, ratio: number) => {
  let t = 0
  let out = color
  while (contrast(out, surface) < ratio && t < 1) {
    t = Math.round((t + 0.05) * 100) / 100
    out = mixWhite(color, t)
  }
  return out
}

/** A custom brand keeps its accent in dark mode; the neutrals turn dark around it. */
const darkAccent = (color: string) => {
  const surface = "#17181b" // BRAND_DARK_NEUTRALS.surface
  const accent = readableOn(color, surface, 3)
  return {
    accent,
    onAccent: contrast("#ffffff", accent) >= 4.5 ? "#ffffff" : "#0f1012",
    emphasis: readableOn(color, surface, 3),
    emphasisText: readableOn(color, surface, 5),
  }
}
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
      // On near-black a dark accent disappears: lift the button to 3:1 against the card (keeping a light
      // label while it reads at 4.5:1), the focus ring and glow to 3:1, and the badge text to 5:1, since
      // it sits on a 7% tint of the accent. #2E5BFF keeps its button and ring; its badge text is #6284ff.
      ...darkAccent(c.indigo),
      success: FLAREYARD_DARK.success,
      warning: FLAREYARD_DARK.warning,
      danger: FLAREYARD_DARK.danger,
    },
  }
}

/** The palette as custom properties. `--accent-far` is the pole away from the text on the accent, so
 * hovering a button moves its background away from its label and contrast only ever goes up. */
const vars = (p: Palette, fonts: PageTheme["fonts"]) =>
  `--bg:${p.bg};--surface:${p.surface};--fg:${p.fg};--body:${p.body};--muted:${p.muted};--border:${p.border};--accent:${p.accent};--on-accent:${p.onAccent};--em:${p.emphasis};--em-text:${p.emphasisText};--ok-bg:${p.success[0]};--ok:${p.success[1]};--warn-bg:${p.warning[0]};--warn:${p.warning[1]};--bad-bg:${p.danger[0]};--bad:${p.danger[1]};--accent-far:${luminance(p.onAccent) > 0.5 ? "#000000" : "#ffffff"};--font-display:${fonts.display};--font-body:${fonts.body}`

/** The page's whole <style>: the palette, light and dark, then the shared CSS. */
export const pageStyle = (theme: PageTheme) =>
  `<style>
:root{${vars(theme.light, theme.fonts)};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(theme.dark, theme.fonts)}}}
${PUBLIC_CSS}
</style>`

/** The card header: the brand's logo and name, or the page's name. The Mailyard mark joins here once
 * brand/mailyard-v2 lands (HAL-3473). */
export const brandHeader = (theme: PageTheme) =>
  theme.logoUrl
    ? `<p class="brand"><img class="logo" src="${esc(theme.logoUrl)}" alt="" height="28"><span>${esc(theme.name)}</span></p>`
    : `<p class="brand"><span>${esc(theme.name)}</span></p>`

/** The footer under the card: the brand's logo, then the postal address, privacy and the site. */
export const pageFooter = (theme: PageTheme, postalAddress?: string | null, privacyUrl?: string | null) => {
  const bits = [
    postalAddress ? `<span>${esc(postalAddress)}</span>` : "",
    privacyUrl ? `<a href="${esc(privacyUrl)}">Privacy</a>` : "",
    theme.siteUrl ? `<a href="${esc(theme.siteUrl)}">${esc(theme.name)}</a>` : "",
  ].filter(Boolean)
  const mark = theme.logoUrl
    ? `<span class="foot-brand"><img src="${esc(theme.logoUrl)}" alt="" height="16"></span>`
    : ""
  return mark || bits.length ? `<footer>${mark}${bits.join("")}</footer>` : ""
}

/** The glyph above a result page's heading, from the status and the notice kind it already has. */
export const glyph = (status: number, kind?: NoticeKind) => {
  const k =
    kind === "success"
      ? "success i-check"
      : kind === "info"
        ? "i-mail"
        : kind === "warning"
          ? "warning i-alert"
          : kind === "danger"
            ? "danger i-alert"
            : ((
                {
                  200: "warning i-ban",
                  400: "i-link",
                  404: "i-gone",
                  410: "warning i-clock",
                  429: "warning i-wait",
                  500: "danger i-alert",
                  503: "warning i-wrench",
                } as Record<number, string>
              )[status] ?? "i-alert")
  return `<span class="glyph ${k}" aria-hidden="true"></span>`
}

export type NoticeKind = "success" | "warning" | "danger" | "info"
export const notice = (kind: NoticeKind, html: string) =>
  `<div class="notice ${kind}" role="${kind === "danger" ? "alert" : "status"}">${html}</div>`

/** The CSP for these pages: inline styles, the fonts' own hosts, images from anywhere https. */
export const shellCsp = (fontsHref: string | undefined, formAction: ReadonlyArray<string> = []) => {
  const fonts = fontsHref ? new URL(fontsHref).origin : ""
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${fonts}`.trim(),
    `font-src ${fonts ? "https://fonts.gstatic.com" : "'none'"}`,
    "img-src https: data:",
    // A form's redirect counts too: a consent page lists where it may send the person (HAL-3462).
    ["form-action 'self'", ...formAction].join(" "),
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
  /** Extra `form-action` sources: where a form on the page may redirect after posting. */
  readonly formAction?: ReadonlyArray<string>
}) => {
  const { theme } = input
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${input.redirect ? `<meta http-equiv="refresh" content="${input.redirect.after};url=${esc(input.redirect.url)}">` : ""}
<title>${esc(input.title)} · ${esc(theme.name)}</title>
${theme.fontsHref ? `<link rel="stylesheet" href="${esc(theme.fontsHref)}">` : ""}
${pageStyle(theme)}
</head>
<body><div class="wrap"><main>
<header class="head">${brandHeader(theme)}</header>
<div class="body">
${input.body}
</div>
</main>${pageFooter(theme, input.postalAddress, input.privacyUrl)}</div></body>
</html>`
  return new Response(html, {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": shellCsp(theme.fontsHref, input.formAction),
      ...(input.redirect ? { refresh: `${input.redirect.after};url=${input.redirect.url}` } : {}),
    },
  })
}

export { esc as escapeHtml }

/**
 * A preview of the public recipient pages in a brand, as a standalone document for a sandboxed iframe. It
 * follows the live page's look (src/workers/public pages: one card, the brand inside it, notices, the footer
 * with the postal address) using the colours merged over the defaults. Every value is escaped.
 */
import { type Colors, mergedColors } from "../logic.ts"

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const safeUrl = (u: string | undefined) => (u && /^https:\/\//i.test(u) ? u : null)
const font = (f: string | undefined, fallback: string) =>
  f ? `${f.replace(/[;{}<>"]/g, "")}, ${fallback}` : fallback

export type PreviewBrand = {
  name: string
  logoUrl?: string | undefined
  fontsHref?: string | undefined
  colors: Colors
  fonts?: { display?: string | undefined; body?: string | undefined } | undefined
  postalAddress?: string | null | undefined
  privacyUrl?: string | null | undefined
}

export function previewDoc(b: PreviewBrand, page: "preferences" | "signup"): string {
  const c = mergedColors(b.colors)
  const fontsHref = safeUrl(b.fontsHref)
  const logo = safeUrl(b.logoUrl)
  const display = font(b.fonts?.display, "system-ui, sans-serif")
  const body = font(b.fonts?.body, "system-ui, sans-serif")
  const head = logo ? `<img src="${esc(logo)}" alt="" width="32" height="32">` : ""
  const topics = ["Course announcements", "Weekly data tips", "Product updates"]
  const main =
    page === "preferences"
      ? `<p class="lede">You’re getting <b>Weekly data tips</b> at <span class="mono">ad••@gmail.com</span>.</p>
<fieldset><legend>Lists</legend>${topics
          .map(
            (t, i) =>
              `<label class="row${i === 1 ? " focus" : ""}"><input type="checkbox" ${i < 2 ? "checked" : ""}> ${esc(t)}${i === 1 ? ' <span class="tag">From this email</span>' : ""}</label>`,
          )
          .join("")}</fieldset>
<button class="primary">Save choices</button><button class="secondary">Unsubscribe from everything</button>`
      : `<p class="lede">Join the list. You’ll get all of these:</p><ul>${topics.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<label class="field">Email<input value="ada@example.com"></label><label class="field">Name (optional)<input></label>
<button class="primary block">Sign up</button><p class="fine">You can unsubscribe at any time.</p>`
  return `<!doctype html><html><head><meta charset="utf-8">${fontsHref ? `<link rel="stylesheet" href="${esc(fontsHref)}">` : ""}
<style>
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:${c.bg};color:${c.body};font:15px/1.5 ${body}}
.card{max-width:520px;margin:0 auto;background:${c.white};border:1px solid ${c.border};border-radius:12px;padding:24px}
.brand{display:flex;align-items:center;gap:10px;font:600 18px/24px ${display};color:${c.fg};margin-bottom:16px}
h1{font:600 22px/28px ${display};color:${c.fg};margin:0 0 8px}.lede{margin:0 0 16px}.mono{font-family:ui-monospace,monospace}
fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:600;color:${c.fg};margin-bottom:8px}
.row{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid ${c.border};border-radius:8px;margin-bottom:8px}
.row.focus{outline:2px solid ${c.indigo}}.tag{margin-left:auto;font-size:12px;border:1px solid currentColor;border-radius:999px;padding:0 8px;color:${c.indigo}}
button{font:600 15px/1 ${body};padding:12px 16px;border-radius:8px;margin:0 8px 8px 0;cursor:pointer}
.primary{background:${c.indigo};color:${c.white};border:0}.secondary{background:transparent;color:${c.fg};border:1px solid ${c.border}}.block{width:100%}
.field{display:block;margin-bottom:12px;color:${c.fg};font-weight:600}.field input{display:block;width:100%;margin-top:4px;padding:10px;border:1px solid ${c.border};border-radius:8px;font:inherit;font-weight:400}
ul{margin:0 0 16px;padding-left:20px}.fine{font-size:13px;color:${c.muted}}
.notice{background:${c.surface};border-radius:8px;padding:10px 12px;margin-bottom:16px}
footer{max-width:520px;margin:16px auto 0;font-size:12.8px;color:${c.muted};text-align:center}
</style></head><body><main class="card"><div class="brand">${head}${esc(b.name || "Mailing preferences")}</div>
<h1>${page === "preferences" ? "Your email preferences" : "Sign up"}</h1>${main}</main>
<footer>${esc(b.postalAddress ?? "Your postal address shows here")}${safeUrl(b.privacyUrl ?? undefined) ? " · Privacy" : ""}</footer></body></html>`
}

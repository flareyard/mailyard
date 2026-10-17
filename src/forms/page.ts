import type { Theme } from "../templates/kit.ts"

/**
 * The hosted signup page (`GET /f/:formId`) and the embed snippet. Plain HTML that works without
 * JavaScript: the form posts to `/v1/forms/:id/submit`, which answers with a page (or the form's
 * redirect). Styled from the sender's brand (the template kit's theme), light and dark, and sized
 * for phones first: one column, 16px inputs so iOS doesn't zoom, 44px targets, and no horizontal
 * scroll at any width.
 */

export type PageForm = {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly fields: ReadonlyArray<string>
  readonly turnstileSiteKey: string | null
}
export type PageTopic = { readonly name: string; readonly description: string | null }

export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js"

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/** `first_name` → "First name": a label for a custom field. */
export const labelOf = (field: string) => {
  const words = field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Fields whose names say what they hold get the browser's autofill and keyboard. */
const hintsFor = (field: string): { type: string; autocomplete: string } => {
  const f = field.toLowerCase()
  if (/^(first_?name|given_?name)$/.test(f)) return { type: "text", autocomplete: "given-name" }
  if (/^(last_?name|family_?name|surname)$/.test(f)) return { type: "text", autocomplete: "family-name" }
  if (/^(phone|mobile|tel|telephone)$/.test(f)) return { type: "tel", autocomplete: "tel" }
  if (/^(company|organisation|organization)$/.test(f)) return { type: "text", autocomplete: "organization" }
  if (/^(city|town)$/.test(f)) return { type: "text", autocomplete: "address-level2" }
  if (/^country$/.test(f)) return { type: "text", autocomplete: "country-name" }
  if (/^(website|url|site)$/.test(f)) return { type: "url", autocomplete: "url" }
  return { type: "text", autocomplete: "off" }
}

export const pageCsp = (fontsHref: string | undefined) => {
  const fonts = fontsHref ? new URL(fontsHref).origin : ""
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${fonts}`.trim(),
    `font-src ${fonts ? "https://fonts.gstatic.com" : "'none'"}`,
    "img-src https: data:",
    "script-src https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors *",
  ].join("; ")
}

export const renderFormPage = (input: {
  readonly form: PageForm
  readonly topics: ReadonlyArray<PageTopic>
  readonly theme: Theme
  readonly brandName: string
  readonly siteUrl: string | null
  /** Where the form posts: `/v1/forms/:id/submit` on this origin. */
  readonly action: string
  /** Shown when the page is reloaded after a failed submit. */
  readonly error?: string | undefined
}) => {
  const { form, topics, theme } = input
  const c = theme.colors
  const custom = form.fields.filter((f) => f !== "email" && f !== "name")
  const field = (
    name: string,
    label: string,
    opts: { type: string; autocomplete: string; required?: boolean },
  ) =>
    `<div class="field"><label for="f-${esc(name)}">${esc(label)}${opts.required ? "" : ' <span class="opt">(optional)</span>'}</label>
<input id="f-${esc(name)}" name="${esc(name)}" type="${opts.type}" autocomplete="${opts.autocomplete}"${opts.required ? " required" : ""}${opts.type === "email" ? ' inputmode="email" spellcheck="false" autocapitalize="off"' : ""} maxlength="${opts.type === "email" ? 254 : 200}"></div>`
  const topicList =
    topics.length === 0
      ? ""
      : `<section class="topics" aria-labelledby="topics-h"><h2 id="topics-h">${topics.length === 1 ? "You'll get" : "You'll get all of these"}</h2><ul>${topics
          .map(
            (t) =>
              `<li><strong>${esc(t.name)}</strong>${t.description ? `<span>${esc(t.description)}</span>` : ""}</li>`,
          )
          .join("")}</ul></section>`
  const logo = theme.logoUrl
    ? `<img class="logo" src="${esc(theme.logoUrl)}" alt="${esc(input.brandName)}" height="32">`
    : `<p class="brand">${esc(input.brandName)}</p>`
  const turnstile = form.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${esc(form.turnstileSiteKey)}" data-size="flexible"></div>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(form.name)} · ${esc(input.brandName)}</title>
${theme.fontsHref ? `<link rel="stylesheet" href="${esc(theme.fontsHref)}">` : ""}
${form.turnstileSiteKey ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>` : ""}
<style>
:root{--bg:${c.bg};--surface:${c.white};--fg:${c.fg};--body:${c.body};--muted:${c.muted};--border:${c.border};--accent:${c.indigo};--on-accent:#ffffff;--danger:${c.red};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--surface:#17181b;--fg:#f2f3f5;--body:#d5d8dc;--muted:#9aa0a8;--border:#2a2d31}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.55 ${theme.fonts.body};min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:clamp(16px,6vw,64px) 16px}
main{width:100%;max-width:30rem;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:clamp(20px,5vw,36px)}
.logo{display:block;height:32px;width:auto;max-width:100%;margin:0 0 24px}
.brand{margin:0 0 20px;font:600 14px/1 ${theme.fonts.display};color:var(--muted)}
h1{margin:0 0 8px;font:600 clamp(1.4rem,4.5vw,1.75rem)/1.2 ${theme.fonts.display};color:var(--fg);overflow-wrap:anywhere}
.lede{margin:0 0 20px;overflow-wrap:anywhere}
.topics h2{margin:0 0 8px;font:600 .875rem/1.3 ${theme.fonts.body};color:var(--fg)}
.topics ul{margin:0 0 20px;padding:0;list-style:none;display:grid;gap:8px}
.topics li{padding:10px 12px;border:1px solid var(--border);border-radius:10px;display:grid;gap:2px;overflow-wrap:anywhere}
.topics li strong{color:var(--fg);font-weight:600}
.topics li span{font-size:.9rem;color:var(--muted)}
form{display:grid;gap:14px}
.field{display:grid;gap:6px}
label{font-weight:600;color:var(--fg);font-size:.95rem}
.opt{font-weight:400;color:var(--muted)}
input{font:inherit;font-size:16px;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg)}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{font:600 16px/1 ${theme.fonts.body};min-height:48px;padding:0 20px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);cursor:pointer;width:100%}
button:hover{filter:brightness(1.08)}
.error{margin:0;padding:10px 12px;border-radius:10px;border:1px solid var(--danger);color:var(--danger)}
.fine{margin:4px 0 0;font-size:.8rem;color:var(--muted)}
.fine a{color:inherit}
</style>
</head>
<body>
<main>
${logo}
<h1>${esc(form.name)}</h1>
${form.description ? `<p class="lede">${esc(form.description)}</p>` : ""}
${topicList}
<form method="post" action="${esc(input.action)}" accept-charset="utf-8">
${input.error ? `<p class="error" role="alert">${esc(input.error)}</p>` : ""}
${field("email", "Email", { type: "email", autocomplete: "email", required: true })}
${field("name", "Name", { type: "text", autocomplete: "name" })}
${custom.map((f) => field(f, labelOf(f), hintsFor(f))).join("\n")}
<div class="hp" aria-hidden="true"><label for="f-hp">Leave this empty</label><input id="f-hp" name="_hp" type="text" tabindex="-1" autocomplete="off"></div>
${turnstile}
<button type="submit">Sign up</button>
<p class="fine">You can unsubscribe at any time from any email we send.${input.siteUrl ? ` <a href="${esc(input.siteUrl)}">${esc(input.brandName)}</a>` : ""}</p>
</form>
</main>
</body>
</html>`
}

/**
 * A snippet to paste into another site: the same fields, posted with fetch so the visitor stays on
 * the page. The submit endpoint allows any origin (CORS), and without JavaScript the form still
 * posts normally and lands on the hosted result page.
 */
export const embedSnippet = (input: { readonly form: PageForm; readonly origin: string }) => {
  const { form, origin } = input
  const action = `${origin}/v1/forms/${encodeURIComponent(form.id)}/submit`
  const id = `mailyard-${form.id.replace(/[^A-Za-z0-9_-]/g, "")}`
  const custom = form.fields.filter((f) => f !== "email" && f !== "name")
  const input_ = (name: string, label: string, type: string, autocomplete: string, required: boolean) =>
    `  <label>${esc(label)}<input name="${esc(name)}" type="${type}" autocomplete="${autocomplete}"${required ? " required" : ""}></label>`
  return `<form id="${id}" class="mailyard-form" method="post" action="${esc(action)}">
${input_("email", "Email", "email", "email", true)}
${input_("name", "Name", "text", "name", false)}
${custom.map((f) => input_(f, labelOf(f), hintsFor(f).type, hintsFor(f).autocomplete, false)).join("\n")}
  <input name="_hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-10000px">
${form.turnstileSiteKey ? `  <div class="cf-turnstile" data-sitekey="${esc(form.turnstileSiteKey)}"></div>\n` : ""}  <button type="submit">Sign up</button>
  <p class="mailyard-message" role="status" aria-live="polite"></p>
</form>
${form.turnstileSiteKey ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>\n` : ""}<script>
(function () {
  var form = document.getElementById(${JSON.stringify(id)});
  if (!form || !window.fetch) return;
  var message = form.querySelector(".mailyard-message");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var button = form.querySelector("button");
    button.disabled = true;
    var body = {};
    new FormData(form).forEach(function (value, key) { body[key] = value; });
    fetch(form.action, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        if (r.ok) {
          message.textContent = r.body.status === "confirm" ? "Check your inbox to confirm." : "You're subscribed. Thank you!";
          form.reset();
        } else {
          message.textContent = r.body.error === "rate_limited" ? "Too many tries; wait a minute." : r.body.error === "challenge" ? "Please complete the check and try again." : "Check your email address and try again.";
        }
      })
      .catch(function () { message.textContent = "Something went wrong. Please try again."; })
      .then(function () { button.disabled = false; if (window.turnstile) window.turnstile.reset(); });
  });
})();
</script>`
}

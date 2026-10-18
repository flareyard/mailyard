import type { Theme } from "../templates/kit.ts"

/**
 * The hosted signup page (`GET /f/:formId`) and the embed snippet. Plain HTML that works without
 * JavaScript: the form posts to `/v1/forms/:id/submit`, which answers with a page (or the form's
 * redirect). Styled from the sender's brand (the template kit's theme), light and dark, and sized
 * for phones first: one column, 16px inputs so iOS doesn't zoom, 44px targets, and no horizontal
 * scroll at any width.
 */

export type PageField = {
  readonly key: string
  readonly label: string
  readonly type: "text" | "number" | "date" | "checkbox" | "select" | "tel" | "url"
  readonly required: boolean
  readonly options?: ReadonlyArray<string> | undefined
}
export type PageForm = {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly fields: ReadonlyArray<string>
  /** How each custom field is asked (HAL-3424); without them, `fields` are asked as optional text. */
  readonly fieldDefs?: ReadonlyArray<PageField> | undefined
  /** `pick`: the visitor ticks which topics to join. */
  readonly topicChoice?: "all" | "pick" | undefined
  readonly turnstileSiteKey: string | null
}
export type PageTopic = { readonly id?: string; readonly name: string; readonly description: string | null }

const defsOfPage = (form: PageForm): ReadonlyArray<PageField> =>
  form.fieldDefs ??
  form.fields
    .filter((f) => f !== "email" && f !== "name")
    .map((key) => ({ key, label: labelOf(key), type: "text" as const, required: false }))

/** What the visitor typed, and the error to show, when the page comes back after a failed submit. */
export type Filled = {
  readonly values: Readonly<Record<string, unknown>>
  /** The field the error is about, shown under it; null for one about the whole form. */
  readonly field: string | null
  readonly message: string
}

const typedValue = (filled: Filled | undefined, key: string) => {
  const v = filled?.values[key]
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""
}

/** The error under a field, and the attributes that tie it to the control (HAL-3443). */
const errorFor = (filled: Filled | undefined, key: string, id: string) =>
  filled?.field === key
    ? {
        attrs: ` aria-invalid="true" aria-describedby="${id}-error" autofocus`,
        note: `<p class="field-error" id="${id}-error">${esc(filled.message)}</p>`,
      }
    : { attrs: "", note: "" }

/** One custom field's control, as its definition asks; types and autofill from the definition or the name. */
const controlFor = (d: PageField, idPrefix: string, filled?: Filled) => {
  const id = `${idPrefix}${esc(d.key)}`
  const opt = d.required ? "" : ' <span class="opt">(optional)</span>'
  const req = d.required ? " required" : ""
  const value = typedValue(filled, d.key)
  const err = errorFor(filled, d.key, id)
  if (d.type === "checkbox")
    return `<div class="field check"><input id="${id}" name="${esc(d.key)}" type="checkbox" value="true"${req}${value === "true" ? " checked" : ""}${err.attrs}><label for="${id}">${esc(d.label)}${opt}</label>${err.note}</div>`
  if (d.type === "select")
    return `<div class="field"><label for="${id}">${esc(d.label)}${opt}</label><select id="${id}" name="${esc(d.key)}"${req}${err.attrs}><option value="">Choose…</option>${(d.options ?? []).map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>${err.note}</div>`
  const hints = hintsFor(d.key)
  const type = d.type === "text" ? hints.type : d.type
  return `<div class="field"><label for="${id}">${esc(d.label)}${opt}</label><input id="${id}" name="${esc(d.key)}" type="${type}" autocomplete="${hints.autocomplete}"${req}${type === "number" ? ' inputmode="decimal"' : ""} maxlength="200"${value ? ` value="${esc(value)}"` : ""}${err.attrs}>${err.note}</div>`
}

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
  /** After a failed submit: what was typed and what went wrong, shown on the form itself (HAL-3443). */
  readonly filled?: Filled | undefined
}) => {
  const { form, topics, theme, filled } = input
  const c = theme.colors
  const pick = form.topicChoice === "pick" && topics.length > 0
  const field = (
    name: string,
    label: string,
    opts: { type: string; autocomplete: string; required?: boolean },
  ) => {
    const value = typedValue(filled, name)
    const err = errorFor(filled, name, `f-${esc(name)}`)
    return `<div class="field"><label for="f-${esc(name)}">${esc(label)}${opts.required ? "" : ' <span class="opt">(optional)</span>'}</label>
<input id="f-${esc(name)}" name="${esc(name)}" type="${opts.type}" autocomplete="${opts.autocomplete}"${opts.required ? " required" : ""}${opts.type === "email" ? ' inputmode="email" spellcheck="false" autocapitalize="off"' : ""} maxlength="${opts.type === "email" ? 254 : 200}"${value ? ` value="${esc(value)}"` : ""}${err.attrs}>${err.note}</div>`
  }
  const picked = new Set(
    (Array.isArray(filled?.values.topics) ? filled.values.topics : [filled?.values.topics]).filter(
      (t): t is string => typeof t === "string",
    ),
  )
  const topicPicker = pick
    ? `<fieldset class="topics pick"${filled?.field === "topics" ? ' aria-invalid="true" aria-describedby="topics-error"' : ""}><legend>Choose what you'd like</legend>${filled?.field === "topics" ? `<p class="field-error" id="topics-error">${esc(filled.message)}</p>` : ""}${topics
        .map(
          (t, i) =>
            `<div class="field check"><input id="t-${i}" name="topics" type="checkbox" value="${esc(t.id ?? "")}"${topics.length === 1 || (t.id && picked.has(t.id)) ? " checked" : ""}><label for="t-${i}"><strong>${esc(t.name)}</strong>${t.description ? `<span>${esc(t.description)}</span>` : ""}</label></div>`,
        )
        .join("")}</fieldset>`
    : ""
  const topicList =
    topics.length === 0 || pick
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
input,select{font:inherit;font-size:16px;width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--fg)}
.check{grid-template-columns:auto 1fr;align-items:start;gap:10px}
.check input{width:24px;min-height:24px;height:24px;margin:2px 0 0;accent-color:var(--accent)}
.check label{font-weight:400;display:grid;gap:2px;min-height:28px;align-content:center}
@media (pointer:coarse){.check label{min-height:44px}.check input{width:28px;height:28px;min-height:28px}}
.check label strong{font-weight:600}
.check label span{font-size:.9rem;color:var(--muted)}
fieldset.pick{border:0;margin:0;padding:0;display:grid;gap:10px}
fieldset.pick legend{font-weight:600;color:var(--fg);margin:0 0 6px;padding:0}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{font:600 16px/1 ${theme.fonts.body};min-height:48px;padding:0 20px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);cursor:pointer;width:100%}
button:hover{filter:brightness(1.08)}
.error{margin:0;padding:10px 12px;border-radius:10px;border:1px solid var(--danger);color:var(--danger)}
.field-error{margin:0;font-size:.9rem;color:var(--danger)}
[aria-invalid="true"]{border-color:var(--danger);outline:1px solid var(--danger)}
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
${filled ? `<p class="error" role="alert">${esc(filled.field ? "Check the highlighted field." : filled.message)}</p>` : ""}
${field("email", "Email", { type: "email", autocomplete: "email", required: true })}
${field("name", "Name", { type: "text", autocomplete: "name" })}
${defsOfPage(form)
  .map((d) => controlFor(d, "f-", filled))
  .join("\n")}
${topicPicker}
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
export const embedSnippet = (input: {
  readonly form: PageForm
  readonly origin: string
  readonly topics?: ReadonlyArray<PageTopic> | undefined
}) => {
  const { form, origin } = input
  const action = `${origin}/v1/forms/${encodeURIComponent(form.id)}/submit`
  const id = `mailyard-${form.id.replace(/[^A-Za-z0-9_-]/g, "")}`
  const pick = form.topicChoice === "pick" ? (input.topics ?? []) : []
  const input_ = (name: string, label: string, type: string, autocomplete: string, required: boolean) =>
    `  <label>${esc(label)}<input name="${esc(name)}" type="${type}" autocomplete="${autocomplete}"${required ? " required" : ""}></label>`
  return `<form id="${id}" class="mailyard-form" method="post" action="${esc(action)}">
${input_("email", "Email", "email", "email", true)}
${input_("name", "Name", "text", "name", false)}
${defsOfPage(form)
  .map((d) =>
    d.type === "select"
      ? `  <label>${esc(d.label)}<select name="${esc(d.key)}"${d.required ? " required" : ""}><option value="">Choose…</option>${(d.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>`
      : d.type === "checkbox"
        ? `  <label><input name="${esc(d.key)}" type="checkbox" value="true"${d.required ? " required" : ""}> ${esc(d.label)}</label>`
        : input_(
            d.key,
            d.label,
            d.type === "text" ? hintsFor(d.key).type : d.type,
            hintsFor(d.key).autocomplete,
            d.required,
          ),
  )
  .join("\n")}
${pick.map((t) => `  <label><input name="topics" type="checkbox" value="${esc(t.id ?? "")}"> ${esc(t.name)}</label>`).join("\n")}
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
    new FormData(form).forEach(function (value, key) {
      if (key === "topics") (body.topics = body.topics || []).push(value);
      else body[key] = value;
    });
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

/**
 * The hosted page in an iframe (HAL-3424): no script on the host page, the visitor stays on it, and
 * the challenge, validation and result all happen inside the frame. The page allows any ancestor.
 */
export const iframeSnippet = (input: {
  readonly form: PageForm
  readonly origin: string
  readonly height?: number
}) =>
  `<iframe src="${esc(`${input.origin}/f/${encodeURIComponent(input.form.id)}`)}" title="${esc(input.form.name)}" loading="lazy" style="width:100%;max-width:32rem;height:${input.height ?? 640}px;border:0;color-scheme:normal" referrerpolicy="strict-origin-when-cross-origin"></iframe>`

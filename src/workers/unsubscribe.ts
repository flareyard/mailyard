import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { toBrand } from "../domain/brand.ts"
import { oneClickUnsubscribe, preferences, savePreferences } from "../domain/unsubscribe.ts"
import { runtimeFor } from "./inbound.ts"

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

type Prefs = Effect.Success<ReturnType<typeof preferences>>

const shell = (brand: Prefs["brand"] | null, title: string, body: string, status = 200) => {
  const theme = brand ? toBrand(brand).theme : null
  const c = theme?.colors
  const name = brand?.name ?? "Mailing preferences"
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(name)}</title>
<style>
:root{--bg:${c?.bg ?? "#fcfcfc"};--surface:${c?.surface ?? "#ebedef"};--fg:${c?.fg ?? "#0c0c0c"};--muted:${c?.muted ?? "#5c5f66"};--border:${c?.border ?? "#d5d8dc"};--accent:${c?.indigo ?? "#2f5bd8"};color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:32px 16px 48px}header{display:flex;align-items:center;gap:12px;margin-bottom:24px}header img{height:32px;width:auto}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
fieldset{border:1px solid var(--border);border-radius:12px;padding:8px 16px;margin:0 0 20px;background:#fff0}legend{padding:0 6px;font-weight:600}
label.topic{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer}label.topic:last-of-type{border-bottom:0}
label.topic input{width:20px;height:20px;margin:2px 0 0;accent-color:var(--accent);flex:none}label.topic span{display:block}label.topic small{display:block;color:var(--muted)}
label.topic.focus{outline:2px solid var(--accent);outline-offset:4px;border-radius:6px}
.actions{display:flex;flex-wrap:wrap;gap:12px}button{font:inherit;min-height:44px;padding:10px 18px;border-radius:10px;border:1px solid var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:#fff}button.secondary{background:transparent;color:var(--fg);border-color:var(--border)}
button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.notice{padding:12px 16px;border-radius:10px;background:var(--surface);color:var(--fg);margin:0 0 20px}
</style></head><body><main>
<header>${theme?.logoUrl ? `<img src="${esc(theme.logoUrl)}" alt="${esc(name)}">` : `<strong>${esc(name)}</strong>`}</header>
${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  )
}

const preferencePage = (prefs: Prefs, notice: string | null) => {
  const topics = prefs.topics
    .map(
      (t) =>
        `<label class="topic${t.id === prefs.focusTopicId ? " focus" : ""}"><input type="checkbox" name="topic" value="${esc(t.id)}"${t.subscribed ? " checked" : ""}><span>${esc(t.name)}${t.description ? `<small>${esc(t.description)}</small>` : ""}</span></label>`,
    )
    .join("")
  const body = `<h1>Your email preferences</h1>
<p>For ${esc(prefs.email)}. Choose what you'd like to hear about.</p>
${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}
${prefs.blocked ? `<div class="notice" role="status">Mail to this address bounced or was reported, so we've stopped sending to it.</div>` : ""}
<form method="post">
${prefs.topics.length ? `<fieldset><legend>Lists</legend>${topics}</fieldset>` : "<p>You aren't on any lists.</p>"}
<div class="actions"><button class="primary" type="submit" name="action" value="save">Save choices</button>
<button class="secondary" type="submit" name="action" value="all">Unsubscribe from everything</button></div>
</form>`
  return shell(prefs.brand, "Email preferences", body)
}

const invalid = () =>
  shell(
    null,
    "Link not valid",
    "<h1>This link isn't valid</h1><p>Use the link from the most recent email we sent you.</p>",
    400,
  )

/**
 * `/u/{token}`. GET shows the preference page. POST is either RFC 8058's one-click (the body is
 * `List-Unsubscribe=One-Click`, sent by the mailbox provider itself) or the page's own form.
 */
export const handleUnsubscribe = async (request: Request, env: Env, token: string) => {
  const run = runtimeFor(env)
  if (request.method === "GET" || request.method === "HEAD") {
    const prefs = await run.runPromise(Effect.result(preferences(token)))
    return prefs._tag === "Success" ? preferencePage(prefs.success, null) : invalid()
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } })
  const form = await request.formData().catch(() => null)
  const oneClick = form?.get("List-Unsubscribe") === "One-Click"
  if (oneClick || !form) {
    // A provider's one-click must succeed without a page; it wants a 2xx and nothing else.
    const done = await run.runPromise(Effect.result(oneClickUnsubscribe(token, "one-click")))
    if (done._tag === "Success") return new Response(null, { status: 200 })
    return new Response(null, {
      status: (done.failure as { _tag?: string })._tag === "ContactNotFound" ? 200 : 400,
    })
  }
  const all = form.get("action") === "all"
  const subscribed = form.getAll("topic").filter((v): v is string => typeof v === "string")
  const saved = await run.runPromise(Effect.result(savePreferences(token, { subscribed, all })))
  if (saved._tag === "Failure") return invalid()
  const prefs = await run.runPromise(Effect.result(preferences(token)))
  if (prefs._tag === "Failure") return invalid()
  return preferencePage(
    prefs.success,
    all
      ? "You're unsubscribed from everything. You won't get any more of these emails."
      : "Your choices are saved.",
  )
}

import type { PageTheme } from "./shell.ts"
import { escapeHtml as esc, glyph, type NoticeKind, notice, shellPage } from "./shell.ts"

/**
 * The public pages' bodies (the preference page, its link-not-valid page, and the one-message
 * result pages: confirmed, check your inbox, errors), built from plain data so they render the same
 * in the Worker and in the responsive preview (tools/public/preview.ts).
 */
export interface Look {
  readonly theme: PageTheme
  readonly postalAddress: string | null
  readonly privacyUrl: string | null
  /** Whether the preference page shows each topic's description (Settings → Compliance). */
  readonly showTopicDescriptions?: boolean
}

export interface Prefs {
  readonly email: string
  readonly unsubscribedFromAll: boolean
  readonly resubscribeUntil: number | null
  readonly blocked: boolean
  readonly focusTopicId: string | null
  readonly topics: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description: string | null
    readonly subscribed: boolean
  }>
}

export const page = (look: Look, title: string, body: string, status = 200) =>
  shellPage({
    theme: look.theme,
    title,
    body,
    status,
    postalAddress: look.postalAddress,
    privacyUrl: look.privacyUrl,
  })

const timeOf = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  })

export const preferencePage = (
  look: Look,
  prefs: Prefs,
  message: { kind: NoticeKind; html: string } | null,
) => {
  const focus = prefs.topics.find((t) => t.id === prefs.focusTopicId) ?? null
  const topics = prefs.topics
    .map(
      (t) =>
        `<label class="topic"><input type="checkbox" role="switch" name="topic" value="${esc(t.id)}"${t.subscribed ? " checked" : ""}><span>${esc(t.name)}${t.id === focus?.id ? '<span class="tag">From this email</span>' : ""}${t.description && look.showTopicDescriptions !== false ? `<small>${esc(t.description)}</small>` : ""}</span></label>`,
    )
    .join("")
  const undo =
    prefs.resubscribeUntil !== null
      ? `<form method="post"><button class="link" type="submit" name="action" value="resubscribe">Undo: resubscribe me</button> <span>(until ${esc(timeOf(prefs.resubscribeUntil))} UTC)</span></form>`
      : ""
  const status = message
    ? notice(
        message.kind,
        `${message.html}${message.kind === "success" && prefs.unsubscribedFromAll ? undo : ""}`,
      )
    : prefs.blocked
      ? notice("warning", "Mail to this address bounced or was reported, so we've stopped sending to it.")
      : prefs.unsubscribedFromAll
        ? notice(
            "info",
            `You're unsubscribed from everything, so we won't send you these emails. Tick a list below to hear from it again.${undo}`,
          )
        : ""
  const lede = focus
    ? `<p class="muted">For ${esc(prefs.email)}. This email came from <strong>${esc(focus.name)}</strong>: untick it to stop just that list, or choose below.</p>`
    : `<p class="muted">For ${esc(prefs.email)}. Choose what you'd like to hear about.</p>`
  const body = `<h1>Your email preferences</h1>
${lede}
${status}
<form method="post">
${prefs.topics.length ? `<fieldset><legend>Lists</legend>${topics}</fieldset>` : `<p class="muted">You aren't on any lists.</p>`}
<div class="actions"><button type="submit" name="action" value="save">Save choices</button>
<button class="secondary" type="submit" name="action" value="all">Unsubscribe from everything</button></div>
</form>`
  return page(look, "Email preferences", body)
}

const requestForm = `<form method="post" action="/p/request"><label for="r-email">Your email address</label>
<input id="r-email" name="email" type="email" autocomplete="email" inputmode="email" spellcheck="false" autocapitalize="off" required maxlength="254">
<button type="submit">Email me a new link</button></form>`

export const invalidLinkPage = (look: Look) =>
  page(
    look,
    "Link not valid",
    `${glyph(400)}<h1>This link isn't valid</h1><p class="muted">It may be from an old email. We can send a fresh one to the address on our list.</p>${requestForm}`,
    400,
  )

export type ResultExtra = {
  readonly kind?: NoticeKind
  readonly redirect?: { readonly url: string; readonly after: number }
}

/** A page with one message: a glyph (coloured by `kind` or the status), the heading, the message, and a redirect. */
export const resultPage = (
  look: Look,
  status: number,
  title: string,
  message: string,
  extra?: ResultExtra,
) => {
  const continueLink = extra?.redirect
    ? `<div class="redirect"><a class="button" href="${esc(extra.redirect.url)}">Continue</a><p class="countdown">Taking you there in ${extra.redirect.after} seconds.<span class="countdown-bar" style="--after:${extra.redirect.after}s" aria-hidden="true"></span></p></div>`
    : ""
  return shellPage({
    theme: look.theme,
    title,
    status,
    postalAddress: look.postalAddress,
    privacyUrl: look.privacyUrl,
    redirect: extra?.redirect ?? null,
    body: `${glyph(status, extra?.kind)}<h1>${esc(title)}</h1><p class="lede">${esc(message)}</p>${continueLink}`,
  })
}

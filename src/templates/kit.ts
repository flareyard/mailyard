/**
 * Email-safe building blocks and the message layout, ported from MBPrep's `apps/api/src/emails/kit.ts`
 * (2026-10-16). Email clients are not browsers: Gmail and Outlook drop flexbox, grid, SVG and most
 * <style> selectors, so every block is a table with inline styles. Each block has a plain-text twin, so
 * the text part of a message says the same thing.
 *
 * MBPrep's version hard-coded its colours, fonts, logo and name; here they come from a Theme, so every
 * Mailyard sender gets the same quality in their own brand. With MBPREP_THEME the output is byte for
 * byte what MBPrep sends (test/templates/kit.test.ts checks it against fixtures from MBPrep's kit).
 */

export interface Theme {
  /** Sender brand name: the <title>, the logo alt text and the footer line. */
  readonly name: string
  /** Logo URL; defaults to `${siteUrl}/brand/logo-lime-1024.png`, MBPrep's path. */
  readonly logoUrl?: string | undefined
  /** A stylesheet for web fonts (Google Fonts), or none. */
  readonly fontsHref?: string | undefined
  /** Prefix of the two CSS classes the mobile media query targets. */
  readonly classPrefix: string
  readonly colors: {
    readonly bg: string
    readonly surface: string
    readonly fg: string
    readonly muted: string
    readonly border: string
    /** Accent on dark (button text, highlights). */
    readonly lime: string
    /** Second accent (links, progress, bars). */
    readonly indigo: string
    readonly body: string
    readonly red: string
    readonly white: string
  }
  readonly fonts: { readonly display: string; readonly body: string; readonly mono: string }
}

export const MBPREP_THEME: Theme = {
  name: "MBPrep",
  fontsHref:
    "https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Geist+Mono&family=Inter:wght@400;500;600&display=swap",
  classPrefix: "mb",
  colors: {
    bg: "#fcfcfc",
    surface: "#ebedef",
    fg: "#0c0c0c",
    muted: "#6a6f76",
    border: "#dee0e1",
    lime: "#c5fb41",
    indigo: "#414fd2",
    body: "#3a3a3a",
    red: "#cc272e",
    white: "#ffffff",
  },
  fonts: {
    display: `Geist,'Helvetica Neue',Helvetica,Arial,sans-serif`,
    body: `Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
    mono: `'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`,
  },
}

/** Mailyard's own neutral default, for senders who haven't set a brand. */
export const DEFAULT_THEME: Theme = {
  ...MBPREP_THEME,
  name: "Mailyard",
  classPrefix: "mf",
  colors: { ...MBPREP_THEME.colors, lime: "#ffffff", indigo: "#2f5bd8" },
}

/** A piece of an email: its HTML and its plain-text rendering. */
export type Block = { html: string; text: string }

export type ButtonStyle = "primary" | "ghost" | "danger"

export type Layout = {
  /** Hidden inbox preview line. */
  preheader: string
  /** Mono caps label, top right ("Week 38 · UI MB4"). */
  label: string
  blocks: Block[]
  /** Why this person gets this email, and the way out. */
  footer: { reason: string; links?: { label: string; url: string }[] }
  siteUrl: string
  tagline: string
}

export const createKit = (t: Theme) => {
  const esc = (s: string | number) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")

  const b = (html: string, text: string): Block => ({ html, text })

  /**
   * Inline rich text: `**bold**`, `==lime highlight==`, `~~indigo~~`, `__link text__(url)`, `\n` for a line break.
   * Everything else is escaped, and links must be http(s). Wrap user data in lit() so it can't form markers.
   */
  /** Makes data safe to drop into a rich() string: breaks up any doubled marker characters. */
  const lit = (s: string | number) => String(s).replace(/([*=~_])(?=\1)/g, "$1\u200b")

  function rich(src: string): Block {
    let html = esc(src)
    let text = src
    html = html.replace(
      /__((?:(?!__).)+?)__\((https?:\/\/[^\s)]+)\)/g,
      (_m, t, u) => `<a href="${u}" style="color:inherit;text-decoration:underline">${t}</a>`,
    )
    text = text.replace(
      /__((?:(?!__).)+?)__\((https?:\/\/[^\s)]+)\)/g,
      (_m, t, u) => `${t} (${u.replace(/&amp;/g, "&")})`,
    )
    html = html
      .replace(/\*\*(.+?)\*\*/g, `<b style="font-weight:600;color:${t.colors.fg}">$1</b>`)
      .replace(
        /==(.+?)==/g,
        `<span style="background:${t.colors.lime};border-radius:999px;padding:0 10px;color:${t.colors.fg}">$1</span>`,
      )
      .replace(/~~(.+?)~~/g, `<span style="color:${t.colors.indigo}">$1</span>`)
      .replace(/\n/g, "<br>")
    text = text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/==(.+?)==/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
    return { html, text }
  }

  const row = (inner: string, pad = "0 0 14px") => `<tr><td style="padding:${pad}">${inner}</td></tr>`

  function heading(src: string): Block {
    const r = rich(src)
    return b(
      row(
        `<h1 style="margin:0;font-family:${t.fonts.display};font-weight:400;font-size:34px;line-height:1.05;letter-spacing:-1.6px;color:${t.colors.fg}">${r.html}</h1>`,
        "4px 0 14px",
      ),
      r.text.replace(/\n/g, " "),
    )
  }

  function subheading(src: string): Block {
    return b(
      row(
        `<h2 style="margin:0;font-family:${t.fonts.display};font-weight:400;font-size:20px;line-height:1.2;letter-spacing:-0.6px;color:${t.colors.fg}">${esc(src)}</h2>`,
        "6px 0 10px",
      ),
      `\n${src}`,
    )
  }

  function para(src: string): Block {
    const r = rich(src)
    return b(
      row(
        `<p style="margin:0;font-family:${t.fonts.body};font-size:14.5px;line-height:1.55;color:${t.colors.body}">${r.html}</p>`,
      ),
      r.text,
    )
  }

  /** Small grey line under a button ("Proud of it? Share your stat card…"). */
  function note(src: string): Block {
    const r = rich(src)
    return b(
      row(
        `<p style="margin:0;font-family:${t.fonts.body};font-size:13px;line-height:1.5;color:${t.colors.muted}">${r.html}</p>`,
      ),
      r.text,
    )
  }

  /** Outlined grey box for security caveats. */
  function warn(src: string): Block {
    const r = rich(src)
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${t.colors.border};border-radius:12px"><tr><td style="padding:10px 12px;font-family:${t.fonts.body};font-size:13px;line-height:1.5;color:${t.colors.muted}">${r.html}</td></tr></table>`,
      ),
      r.text,
    )
  }

  const BTN: Record<ButtonStyle, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.colors.fg, fg: t.colors.lime, border: t.colors.fg },
    ghost: { bg: t.colors.bg, fg: t.colors.fg, border: t.colors.fg },
    danger: { bg: t.colors.red, fg: t.colors.white, border: t.colors.red },
  }

  const pill = (label: string, url: string, style: ButtonStyle) => {
    const s = BTN[style]
    return `<a href="${esc(url)}" style="display:inline-block;background:${s.bg};color:${s.fg};border:1.5px solid ${s.border};border-radius:999px;padding:14px 22px;font-family:${t.fonts.body};font-weight:600;font-size:15px;line-height:18px;text-decoration:none;mso-padding-alt:0">${esc(label)}</a>`
  }

  function button(label: string, url: string, style: ButtonStyle = "primary"): Block {
    return b(row(pill(label, url, style), "4px 0 14px"), `${label.replace(/\s*→$/, "")}: ${url}`)
  }

  /** Two pills side by side ("It was me" / "Sign it out"). */
  function buttons(items: { label: string; url: string; style?: ButtonStyle }[]): Block {
    return b(
      row(
        items
          .map((i) => pill(i.label, i.url, i.style ?? "primary"))
          .join(`<span style="display:inline-block;width:8px"></span>`),
        "4px 0 14px",
      ),
      items.map((i) => `${i.label}: ${i.url}`).join("\n"),
    )
  }

  /** Stat tiles: Answers 412 · Streak 12 days · Rank #6. */
  function stats(items: { label: string; value: string }[]): Block {
    const cells = items
      .map(
        (i) =>
          `<td width="${Math.floor(100 / items.length)}%" style="background:${t.colors.surface};border-radius:12px;padding:10px" valign="top"><div style="font-family:${t.fonts.mono};font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;color:${t.colors.muted}">${esc(i.label)}</div><div style="font-family:${t.fonts.display};font-size:22px;line-height:1.2;letter-spacing:-0.6px;color:${t.colors.fg}">${esc(i.value)}</div></td>`,
      )
      .join("")
    // Gaps by border-spacing (the board's 6px), pulled back to the column edges by a negative margin.
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;margin:0 -6px;width:calc(100% + 12px)"><tr>${cells}</tr></table>`,
      ),
      items.map((i) => `${i.label}: ${i.value}`).join(" · "),
    )
  }

  /** Seven daily bars, indigo, today in ink. `values` are 0–1. */
  function bars(days: { label: string; value: number }[]): Block {
    const H = 90
    const cells = days
      .map((d, i) => {
        const h = Math.max(4, Math.round(Math.min(1, Math.max(0, d.value)) * (H - 18)))
        const colour = i === days.length - 1 ? t.colors.fg : t.colors.indigo
        return `<td valign="bottom" align="center" style="padding:0 4px;height:${H}px"><div style="height:${h}px;line-height:${h}px;font-size:0;background:${colour};border-radius:6px 6px 2px 2px">&nbsp;</div><div style="padding-top:4px;font-family:${t.fonts.mono};font-size:10px;color:${t.colors.muted}">${esc(d.label)}</div></td>`
      })
      .join("")
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tr>${cells}</tr></table>`,
      ),
      `This week: ${days.map((d) => `${d.label} ${Math.round(d.value * 100)}%`).join(", ")}`,
    )
  }

  const outlined = (inner: string) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${t.colors.border};border-radius:12px"><tr><td style="padding:10px 12px">${inner}</td></tr></table>`
  const titleSub = (title: string, sub?: string) =>
    `<div style="font-family:${t.fonts.body};font-weight:500;font-size:14px;line-height:1.4;color:${t.colors.fg}">${esc(title)}</div>${sub ? `<div style="font-family:${t.fonts.body};font-size:12.5px;line-height:1.4;color:${t.colors.muted}">${esc(sub)}</div>` : ""}`

  /** Outlined rows with a bold line and a grey line ("Nephrology · 52% / Your weakest system…"). Optional links. */
  function list(items: { title: string; sub?: string; url?: string }[]): Block {
    const html = items
      .map((i) => {
        const inner = outlined(titleSub(i.title, i.sub))
        return `<tr><td style="padding:0 0 6px">${i.url ? `<a href="${esc(i.url)}" style="text-decoration:none;color:inherit;display:block">${inner}</a>` : inner}</td></tr>`
      })
      .join("")
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`,
        "0 0 8px",
      ),
      items.map((i) => `- ${i.title}${i.sub ? ` (${i.sub})` : ""}${i.url ? `: ${i.url}` : ""}`).join("\n"),
    )
  }

  /** Numbered onboarding steps, ink tiles with lime digits. */
  function steps(items: { title: string; sub?: string }[]): Block {
    const html = items
      .map(
        (i, n) =>
          `<tr><td style="padding:0 0 6px">${outlined(
            `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="30" valign="middle"><div style="width:30px;height:30px;line-height:30px;border-radius:9px;background:${t.colors.fg};color:${t.colors.lime};text-align:center;font-family:${t.fonts.mono};font-size:12px">${n + 1}</div></td><td style="padding-left:10px" valign="middle">${titleSub(i.title, i.sub)}</td></tr></table>`,
          )}</td></tr>`,
      )
      .join("")
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`,
        "0 0 8px",
      ),
      items.map((i, n) => `${n + 1}. ${i.title}${i.sub ? ` (${i.sub})` : ""}`).join("\n"),
    )
  }

  /** Grey key/value rows: "Requested from · Chrome on Android". */
  function meta(items: { label: string; value: string }[]): Block {
    const html = items
      .map(
        (i) =>
          `<tr><td style="padding:0 0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.colors.surface};border-radius:12px"><tr><td style="padding:10px 12px;font-family:${t.fonts.body};font-size:13.5px;color:${t.colors.muted}">${esc(i.label)}</td><td align="right" style="padding:10px 12px;font-family:${t.fonts.body};font-size:13.5px;font-weight:500;color:${t.colors.fg}">${esc(i.value)}</td></tr></table></td></tr>`,
      )
      .join("")
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`,
        "0 0 8px",
      ),
      items.map((i) => `${i.label}: ${i.value}`).join("\n"),
    )
  }

  /** A receipt: lines, and a bold total line. */
  function receipt(
    lines: { label: string; value: string }[],
    total: { label: string; value: string },
  ): Block {
    const tr = (l: string, v: string, last: boolean) =>
      `<tr><td style="padding:10px 0;${last ? "" : `border-bottom:1px solid ${t.colors.border};`}font-family:${t.fonts.body};font-size:14px;${last ? "font-weight:600;" : ""}color:${t.colors.fg}">${esc(l)}</td><td align="right" style="padding:10px 0;${last ? "" : `border-bottom:1px solid ${t.colors.border};`}font-family:${t.fonts.display};font-size:${last ? 22 : 16}px;color:${t.colors.fg}">${esc(v)}</td></tr>`
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines.map((l) => tr(l.label, l.value, false)).join("")}${tr(total.label, total.value, true)}</table>`,
      ),
      [...lines, total].map((l) => `${l.label}: ${l.value}`).join("\n"),
    )
  }

  /** The six-digit sign-in code, one tile per digit. */
  function otp(code: string): Block {
    const cells = code
      .split("")
      .map(
        (d) =>
          `<td align="center" width="16%" style="background:${t.colors.surface};border-radius:12px;height:60px;font-family:${t.fonts.mono};font-size:30px;color:${t.colors.fg}">${esc(d)}</td>`,
      )
      .join("")
    return b(
      row(
        `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;margin:0 -6px;max-width:372px;width:100%"><tr>${cells}</tr></table>`,
      ),
      `Your code: ${code.slice(0, 3)} ${code.slice(3)}`,
    )
  }

  /** A question on an ink card with answer buttons that deep-link into the app. */
  function questionCard(label: string, stem: string, answers: { label: string; url: string }[]): Block {
    const btns = answers
      .map(
        (a) =>
          `<td align="center" style="background:#2a2a2a;border-radius:12px;height:42px"><a href="${esc(a.url)}" style="display:block;line-height:42px;color:${t.colors.white};font-family:${t.fonts.body};font-weight:600;font-size:14px;text-decoration:none">${esc(a.label)}</a></td>`,
      )
      .join(`<td width="6" style="font-size:0">&nbsp;</td>`)
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.colors.fg};border-radius:18px"><tr><td style="padding:16px"><div style="font-family:${t.fonts.mono};font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:${t.colors.lime}">${esc(label)}</div><div style="padding:10px 0;font-family:${t.fonts.display};font-size:19px;line-height:1.25;color:${t.colors.bg}">${esc(stem)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${btns}</tr></table></td></tr></table>`,
      ),
      `${label}\n${stem}\n${answers.map((a) => `${a.label}: ${a.url}`).join("\n")}`,
    )
  }

  /** Four-stage progress rail (waitlist): stages up to `done` are indigo. */
  function progress(stages: string[], done: number): Block {
    const cells = stages
      .map((s, i) => {
        const on = i < done
        return `<td valign="top" width="${Math.floor(100 / stages.length)}%" style="border-top:4px solid ${on ? t.colors.indigo : t.colors.border};padding:10px 8px 8px 0;font-family:${t.fonts.body};font-size:11.5px;line-height:1.3;color:${on ? t.colors.fg : t.colors.muted};${on ? "font-weight:500;" : ""}">${esc(s)}</td>`
      })
      .join(`<td width="4" style="font-size:0">&nbsp;</td>`)
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`,
      ),
      stages.map((s, i) => `[${i < done ? "x" : " "}] ${s}`).join("\n"),
    )
  }

  /** One-tap survey chips; each answer is a link. */
  function feedback(label: string, question: string, answers: { label: string; url: string }[]): Block {
    const chips = answers
      .map(
        (a) =>
          `<a href="${esc(a.url)}" style="display:inline-block;margin:0 6px 6px 0;padding:7px 12px;border-radius:999px;background:${t.colors.bg};border:1px solid ${t.colors.border};font-family:${t.fonts.body};font-size:12.5px;color:${t.colors.fg};text-decoration:none">${esc(a.label)}</a>`,
      )
      .join("")
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.colors.surface};border-radius:14px"><tr><td style="padding:14px"><div style="font-family:${t.fonts.body};font-size:11.5px;color:${t.colors.muted}">${esc(label)}</div><div style="padding:4px 0 10px;font-family:${t.fonts.body};font-weight:500;font-size:14.5px;color:${t.colors.fg}">${esc(question)}</div>${chips}</td></tr></table>`,
      ),
      `${question}\n${answers.map((a) => `- ${a.label}: ${a.url}`).join("\n")}`,
    )
  }

  /** A file tile (data export). */
  function file(tag: string, name: string, sub: string): Block {
    return b(
      row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.colors.surface};border-radius:14px"><tr><td width="44" style="padding:12px 0 12px 12px"><div style="width:44px;height:44px;line-height:44px;border-radius:12px;background:${t.colors.fg};color:${t.colors.lime};text-align:center;font-family:${t.fonts.mono};font-size:11px">${esc(tag)}</div></td><td style="padding:12px">${titleSub(name, sub)}</td></tr></table>`,
      ),
      `${name} (${sub})`,
    )
  }

  /** Options as outlined rows that each link somewhere ("Try the card again", "Pay by bank transfer"…). */
  const options = list

  /** The whole message: head, preheader, logo row, blocks, footer. Returns HTML and text. */
  function layout(l: Layout): { html: string; text: string } {
    const logo = t.logoUrl ?? `${l.siteUrl}/brand/logo-lime-1024.png`
    const links = (l.footer.links ?? [])
      .map(
        (k) =>
          `<a href="${esc(k.url)}" style="color:${t.colors.muted};text-decoration:underline">${esc(k.label)}</a>`,
      )
      .join(" · ")
    // Pads the preheader so clients don't pull body text into the inbox preview.
    const pad = "&#847;&zwnj;&nbsp;".repeat(60)
    const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(t.name)}</title>
${t.fontsHref ? `<link href="${t.fontsHref}" rel="stylesheet">` : ""}
<style>
  body{margin:0;padding:0;background:${t.colors.surface}}
  a{color:inherit}
  @media (max-width:560px){.${t.classPrefix}-card{border-radius:0!important}.${t.classPrefix}-pad{padding:20px 18px!important}}
</style>
</head>
<body style="margin:0;padding:0;background:${t.colors.surface}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(l.preheader)}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.colors.surface}"><tr><td align="center" style="padding:24px 0">
<table role="presentation" class="${t.classPrefix}-card" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:100%;background:${t.colors.bg};border-radius:22px">
<tr><td class="${t.classPrefix}-pad" style="padding:24px 28px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="34"><a href="${esc(l.siteUrl)}"><img src="${logo}" width="34" height="34" alt="${esc(t.name)}" style="display:block;border:0;border-radius:10px"></a></td>
<td align="right" style="font-family:${t.fonts.mono};font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:${t.colors.muted}">${esc(l.label)}</td>
</tr></table></td></tr>
${l.blocks.map((x) => x.html).join("\n")}
<tr><td style="padding:14px 0 0;border-top:1px solid ${t.colors.border};font-family:${t.fonts.body};font-size:11.5px;line-height:1.6;color:${t.colors.muted}">${esc(t.name)} · ${esc(l.tagline)}<br>${esc(l.footer.reason)}${links ? ` ${links}` : ""}</td></tr>
</table>
</td></tr></table>
</td></tr></table>
</body>
</html>`
    const text = [
      ...l.blocks.map((x) => x.text).filter(Boolean),
      "—",
      `${t.name} · ${l.tagline}`,
      l.footer.reason,
      ...(l.footer.links ?? []).map((k) => `${k.label}: ${k.url}`),
    ].join("\n\n")
    return { html, text }
  }

  return {
    esc,
    lit,
    rich,
    heading,
    subheading,
    para,
    note,
    warn,
    button,
    buttons,
    stats,
    bars,
    list,
    steps,
    meta,
    receipt,
    otp,
    questionCard,
    progress,
    feedback,
    file,
    options,
    layout,
  }
}

export type Kit = ReturnType<typeof createKit>

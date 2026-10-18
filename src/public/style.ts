/** The public pages' CSS (public-v2 design, css/public-v2.css). shell.ts inlines it after the palette;
 * every colour comes from the palette's custom properties, so a workspace's own accent drops in. */
export const PUBLIC_CSS = `/* Mailyard public pages v2: /u preferences, /c confirm, /f signup, /v view in browser, /p request.
   This file is the <style> block shellPage() and renderFormPage() inline, after the palette line
   that vars() writes (--bg … --bad, plus --font-display, --font-body and --accent-far).
   Server-rendered, no JavaScript, phone first: one column, 16px inputs, 44px targets.
   Every colour below derives from the palette, so a workspace's own AA-valid accent drops in.
   Icons are lucide paths in CSS masks (data: URIs, allowed by img-src), so the markup stays as is. */

/* ---------- derived tokens ---------- */
:root{
  --r-card:12px;--r-ctl:8px;--r-sm:6px;
  --t:150ms ease;
  --subtle:color-mix(in oklab,var(--bg) 60%,var(--surface));
  --input:color-mix(in oklab,var(--border),var(--fg) 9%);
  --input-hover:color-mix(in oklab,var(--border),var(--fg) 26%);
  --control:color-mix(in oklab,var(--muted) 85%,var(--surface));
  --ring:var(--em);
  --ring-soft:color-mix(in oklab,var(--em) 22%,transparent);
  --accent-hover:color-mix(in oklab,var(--accent),var(--accent-far) 16%);
  --accent-tint:color-mix(in oklab,var(--accent) 6%,var(--surface));
  --dot:color-mix(in oklab,var(--fg) 12%,transparent);
  --glow:color-mix(in oklab,var(--em) 9%,transparent);
  --shadow-card:0 1px 2px rgb(0 0 0/.04),0 16px 32px -20px rgb(0 0 0/.16);
  --shadow-ctl:0 1px 2px rgb(0 0 0/.05);
  --mark-ember:#e84e10;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:var(--bg)}

/* ---------- page: dot grid, one faint glow, never a wash ---------- */
body{
  margin:0;min-height:100vh;min-height:100dvh;color:var(--body);
  font:400 16px/1.5 var(--font-body);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
  background:
    radial-gradient(44rem 22rem at 50% -7rem,var(--glow),transparent 72%) no-repeat,
    radial-gradient(90rem 44rem at 50% 0,transparent 25%,var(--bg) 78%) no-repeat,
    radial-gradient(circle,var(--dot) 1px,transparent 1.4px) 0 0/20px 20px,
    var(--bg);
}
.wrap{width:100%;max-width:31rem;margin:0 auto;padding:clamp(16px,8vh,96px) 12px 32px;display:flex;flex-direction:column;gap:24px}

/* ---------- Card ---------- */
main{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-card);box-shadow:var(--shadow-card);overflow-wrap:anywhere;min-width:0}
.head{display:flex;align-items:center;gap:10px;min-height:56px;padding:12px 20px;border-bottom:1px solid var(--border)}
.body{padding:24px 20px;display:flex;flex-direction:column;gap:20px}
@media (min-width:480px){.head{padding:12px 28px}.body{padding:28px}}
.brand{display:flex;align-items:center;gap:10px;margin:0;min-width:0;font:600 15px/20px var(--font-display);letter-spacing:-.01em;color:var(--fg)}
.brand span{min-width:0;overflow-wrap:anywhere}
.logo{display:block;height:28px;width:auto;max-width:160px;flex:none}
.mark{display:block;width:24px;height:24px;flex:none}
.mark .mk-i{fill:var(--fg)}.mark .mk-e{fill:var(--mark-ember)}

/* ---------- type ---------- */
h1{margin:0;font:600 24px/30px var(--font-display);letter-spacing:-.025em;color:var(--fg);text-wrap:balance}
@media (min-width:480px){h1{font-size:28px;line-height:34px;letter-spacing:-.03em}}
h1+p,h1+.lede{margin-top:-12px}
h2{margin:0;font:600 14px/20px var(--font-body);color:var(--fg)}
p{margin:0}
.muted,.lede{color:var(--muted);font-size:15px;line-height:22px;text-wrap:pretty}
.lede strong,.muted strong{color:var(--fg);font-weight:600}
a{color:var(--fg);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:color-mix(in oklab,var(--fg) 35%,transparent);transition:text-decoration-color var(--t),box-shadow var(--t);border-radius:2px}
a:hover{text-decoration-color:currentColor}

/* ---------- status glyph (result pages) ---------- */
.glyph{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--border);background:var(--subtle);color:var(--fg);flex:none}
.glyph::before{content:"";width:20px;height:20px;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.glyph.success{background:var(--ok-bg);color:var(--ok);border-color:color-mix(in oklab,var(--ok) 22%,var(--ok-bg))}
.glyph.warning{background:var(--warn-bg);color:var(--warn);border-color:color-mix(in oklab,var(--warn) 22%,var(--warn-bg))}
.glyph.danger{background:var(--bad-bg);color:var(--bad);border-color:color-mix(in oklab,var(--bad) 22%,var(--bad-bg))}
.glyph.i-check{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'/%3E%3C/svg%3E")}.glyph.i-mail{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M22%2013V6a2%202%200%200%200-2-2H4a2%202%200%200%200-2%202v12c0%201.1.9%202%202%202h8'/%3E%3Cpath%20d='m22%207-8.97%205.7a1.94%201.94%200%200%201-2.06%200L2%207'/%3E%3Cpath%20d='m16%2019%202%202%204-4'/%3E%3C/svg%3E")}.glyph.i-clock{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%206v6l4%202'/%3E%3C/svg%3E")}
.glyph.i-link{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M9%2017H7A5%205%200%200%201%207%207'/%3E%3Cpath%20d='M15%207h2a5%205%200%200%201%204%208'/%3E%3Cpath%20d='M8%2012h4'/%3E%3Cpath%20d='m2%202%2020%2020'/%3E%3C/svg%3E")}.glyph.i-ban{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='m4.9%204.9%2014.2%2014.2'/%3E%3C/svg%3E")}.glyph.i-wrench{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M14.7%206.3a1%201%200%200%200%200%201.4l1.6%201.6a1%201%200%200%200%201.4%200l3.77-3.77a6%206%200%200%201-7.94%207.94l-6.91%206.91a2.12%202.12%200%200%201-3-3l6.91-6.91a6%206%200%200%201%207.94-7.94l-3.76%203.76z'/%3E%3C/svg%3E")}
.glyph.i-wait{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M5%2022h14'/%3E%3Cpath%20d='M5%202h14'/%3E%3Cpath%20d='M17%2022v-4.172a2%202%200%200%200-.586-1.414L12%2012l-4.414%204.414A2%202%200%200%200%207%2017.828V22'/%3E%3Cpath%20d='M7%202v4.172a2%202%200%200%200%20.586%201.414L12%2012l4.414-4.414A2%202%200%200%200%2017%206.172V2'/%3E%3C/svg%3E")}.glyph.i-gone{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M15%202H6a2%202%200%200%200-2%202v16a2%202%200%200%200%202%202h12a2%202%200%200%200%202-2V7Z'/%3E%3Cpath%20d='M14%202v4a2%202%200%200%200%202%202h4'/%3E%3Cpath%20d='m14.5%2012.5-5%205'/%3E%3Cpath%20d='m9.5%2012.5%205%205'/%3E%3C/svg%3E")}.glyph.i-alert{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E")}
.glyph+h1{margin-top:-4px}

/* ---------- Alert (notice) ---------- */
.notice{position:relative;text-wrap:pretty;padding:12px 14px 12px 42px;border-radius:var(--r-ctl);border:1px solid var(--border);background:var(--subtle);color:var(--body);font-size:14px;line-height:20px}
.notice::before{content:"";position:absolute;left:14px;top:14px;width:16px;height:16px;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.notice.info{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%2016v-4'/%3E%3Cpath%20d='M12%208h.01'/%3E%3C/svg%3E")}.notice.info::before{background:var(--muted)}
.notice.success{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='m9%2012%202%202%204-4'/%3E%3C/svg%3E");background:var(--ok-bg);color:var(--ok);border-color:color-mix(in oklab,var(--ok) 24%,var(--ok-bg))}
.notice.warning{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='m21.73%2018-8-14a2%202%200%200%200-3.48%200l-8%2014A2%202%200%200%200%204%2021h16a2%202%200%200%200%201.73-3'/%3E%3Cpath%20d='M12%209v4'/%3E%3Cpath%20d='M12%2017h.01'/%3E%3C/svg%3E");background:var(--warn-bg);color:var(--warn);border-color:color-mix(in oklab,var(--warn) 24%,var(--warn-bg))}
.notice.danger{--i:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E");background:var(--bad-bg);color:var(--bad);border-color:color-mix(in oklab,var(--bad) 24%,var(--bad-bg))}
.notice form{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 0 0}
.notice form span{font-size:13px;line-height:18px;opacity:1}
/* "Undo: resubscribe me" is button.link in the markup; inside an alert it reads as a compact outline button */
.notice button.link{height:32px;min-height:32px;padding:0 12px;font:500 14px/1 var(--font-body);background:var(--surface);color:var(--fg);border:1px solid var(--input);border-radius:var(--r-sm);text-decoration:none;box-shadow:var(--shadow-ctl)}
.notice button.link:hover{background:var(--surface);border-color:var(--input-hover)}

/* ---------- Badge ---------- */
.tag,label.topic span.tag{display:inline-flex;align-items:center;height:20px;margin-left:8px;padding:0 8px;border-radius:999px;font:500 12px/1 var(--font-body);letter-spacing:0;color:var(--em-text);background:color-mix(in oklab,var(--em) 7%,var(--surface));border:1px solid color-mix(in oklab,var(--em) 30%,var(--surface));vertical-align:2px;white-space:nowrap}

/* ---------- forms: shared ---------- */
form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:flex;flex-direction:column;gap:8px;min-width:0}
label{font:500 14px/20px var(--font-body);color:var(--fg)}
.opt{font-weight:400;color:var(--muted)}
form > label{margin-bottom:-8px}

/* Input with ring focus */
input[type=email],input[type=text],input[type=tel],input[type=url],input[type=number],input[type=date],select{
  font:400 16px/1.25 var(--font-body);width:100%;height:44px;margin:0;padding:0 12px;
  border:1px solid var(--input);border-radius:var(--r-ctl);background:var(--surface);color:var(--fg);
  box-shadow:var(--shadow-ctl);-webkit-appearance:none;appearance:none;
  transition:border-color var(--t),box-shadow var(--t)}
input::placeholder{color:var(--muted);opacity:1}
input[type=email]:hover,input[type=text]:hover,input[type=tel]:hover,input[type=url]:hover,input[type=number]:hover,input[type=date]:hover,select:hover{border-color:var(--input-hover)}
select{padding-right:40px;background:var(--surface) url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%238a8a8a'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='m6%209%206%206%206-6'/%3E%3C/svg%3E") no-repeat right 12px center/16px 16px;cursor:pointer}
input:focus-visible,select:focus-visible{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px var(--ring-soft)}
[aria-invalid="true"]:not(fieldset){border-color:var(--bad)}
input[aria-invalid="true"]:focus-visible,select[aria-invalid="true"]:focus-visible{border-color:var(--bad);box-shadow:0 0 0 3px color-mix(in oklab,var(--bad) 20%,transparent)}

/* field error and the summary Alert */
.field-error{display:flex;gap:6px;margin:0;font-size:13px;line-height:18px;color:var(--bad)}
.field-error::before{content:"";flex:none;width:14px;height:14px;margin-top:2px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E") center/contain no-repeat}
.error{position:relative;margin:0;padding:12px 14px 12px 42px;border-radius:var(--r-ctl);border:1px solid color-mix(in oklab,var(--bad) 24%,var(--bad-bg));background:var(--bad-bg);color:var(--bad);font-size:14px;line-height:20px}
.error::before{content:"";position:absolute;left:14px;top:14px;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Ccircle%20cx='12'%20cy='12'%20r='10'/%3E%3Cpath%20d='M12%208v4'/%3E%3Cpath%20d='M12%2016h.01'/%3E%3C/svg%3E") center/contain no-repeat}

/* ---------- Checkbox ---------- */
.check input[type=checkbox]{
  -webkit-appearance:none;appearance:none;flex:none;display:grid;place-items:center;
  width:20px;height:20px;margin:2px 0 0;border:1px solid var(--control);border-radius:5px;background:var(--surface);
  box-shadow:var(--shadow-ctl);cursor:pointer;transition:background-color var(--t),border-color var(--t),box-shadow var(--t)}
.check input[type=checkbox]::before{content:"";width:14px;height:14px;background:var(--on-accent);-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'%20stroke-width='3'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'%20stroke-width='3'/%3E%3C/svg%3E") center/contain no-repeat;transform:scale(.4);opacity:0;transition:transform var(--t),opacity var(--t)}
.check input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}
.check input[type=checkbox]:checked::before{transform:scale(1);opacity:1}
.check input[type=checkbox]:hover{border-color:var(--fg)}
.check input[type=checkbox]:checked:hover{border-color:var(--accent-hover);background:var(--accent-hover)}
.check input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--ring)}
.check input[aria-invalid="true"]{border-color:var(--bad)}
.field.check{display:grid;grid-template-columns:auto 1fr;column-gap:12px;row-gap:6px;align-items:start}
.field.check label{display:block;padding:1px 0;font-weight:400;font-size:15px;line-height:22px;cursor:pointer}
.field.check label strong,.field.check label span:not(.opt){display:block}
.field.check .field-error{grid-column:2}
.field.check{position:relative}
.field.check label::after{content:"";position:absolute;inset:0;border-radius:inherit}
@media (max-width:480px),(pointer:coarse){.check input[type=checkbox]{width:24px;height:24px;margin:0}.field.check:not(fieldset.pick .field.check){padding:10px 0;margin:-10px 0}}

/* topic picker: checkbox cards */
fieldset.pick{border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:8px}
fieldset.pick legend{float:left;width:100%;padding:0;margin:0 0 8px;font:500 14px/20px var(--font-body);color:var(--fg)}
fieldset.pick legend+*{clear:both}
fieldset.pick .field.check{position:relative;padding:14px 16px;border:1px solid var(--border);border-radius:var(--r-ctl);background:var(--surface);transition:border-color var(--t),box-shadow var(--t),background-color var(--t)}
fieldset.pick .field.check:hover{border-color:var(--input-hover)}
fieldset.pick .field.check:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
fieldset.pick .field.check label{margin:0;padding:0}
fieldset.pick label strong{font-weight:500;color:var(--fg)}
fieldset.pick label span,.field.check label span:not(.opt){font-size:14px;line-height:20px;color:var(--muted)}
fieldset.pick[aria-invalid="true"] .field.check{border-color:color-mix(in oklab,var(--bad) 55%,var(--border))}
fieldset.pick .field-error{margin:-4px 0 0}

/* "You'll get" list */
.topics h2{margin:0 0 8px}
.topics ul{margin:0;padding:0;list-style:none;border:1px solid var(--border);border-radius:var(--r-ctl);background:var(--subtle)}
.topics li{position:relative;display:flex;flex-direction:column;gap:2px;padding:12px 16px 12px 42px;overflow-wrap:anywhere}
.topics li+li{border-top:1px solid var(--border)}
.topics li::before{content:"";position:absolute;left:16px;top:15px;width:14px;height:14px;background:var(--fg);-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'%20stroke-width='3'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'%20stroke-width='3'/%3E%3C/svg%3E") center/contain no-repeat}
.topics li strong{font-weight:500;color:var(--fg);font-size:15px;line-height:22px}
.topics li span{font-size:14px;line-height:20px;color:var(--muted)}

/* ---------- /u topic rows: Switch ---------- */
fieldset{margin:0;padding:0;border:0;min-width:0}
fieldset:not(.pick) legend{float:left;width:100%;padding:0;margin:0 0 8px;font:500 14px/20px var(--font-body);color:var(--fg)}
fieldset:not(.pick) legend+*{clear:both}
label.topic{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;min-height:64px;padding:14px 16px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-weight:400}
label.topic+label.topic{border-top:0}
legend+label.topic{border-radius:var(--r-ctl) var(--r-ctl) 0 0}
label.topic:last-child{border-radius:0 0 var(--r-ctl) var(--r-ctl)}
legend+label.topic:last-child{border-radius:var(--r-ctl)}
label.topic>span{grid-column:1;grid-row:1;display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;min-width:0;font:500 15px/22px var(--font-body);color:var(--fg)}
label.topic small{flex-basis:100%;display:block;margin-top:-2px;font:400 14px/20px var(--font-body);color:var(--muted)}
label.topic span.tag{margin-left:0}
label.topic input{grid-column:2;grid-row:1;-webkit-appearance:none;appearance:none;position:relative;flex:none;width:40px;height:24px;margin:0;border-radius:999px;background:var(--control);cursor:pointer;transition:background-color var(--t),box-shadow var(--t)}
label.topic input::before{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.25);transition:transform var(--t),background-color var(--t)}
label.topic input:checked{background:var(--accent)}
label.topic input:checked::before{transform:translateX(16px);background:var(--on-accent)}
label.topic:hover input:not(:checked){background:color-mix(in oklab,var(--control),var(--fg) 14%)}
label.topic:hover input:checked{background:var(--accent-hover)}
label.topic input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--ring)}

/* ---------- Button: primary, secondary, ghost ---------- */
button,.button{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 18px;margin:0;
  border-radius:var(--r-ctl);border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);
  font:500 15px/1 var(--font-body);text-decoration:none;white-space:nowrap;cursor:pointer;
  box-shadow:var(--shadow-ctl);transition:background-color var(--t),border-color var(--t),box-shadow var(--t),transform var(--t)}
button:hover,.button:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--on-accent)}
button:active,.button:active{transform:translateY(1px)}
button.secondary{background:var(--surface);color:var(--fg);border-color:var(--input)}
button.secondary:hover{background:var(--surface);color:var(--fg);border-color:var(--input-hover)}
button.ghost{background:transparent;color:var(--fg);border-color:transparent;box-shadow:none;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px}
button.ghost:hover{background:transparent;color:var(--fg);border-color:transparent;text-decoration-color:currentColor}
button:focus-visible,.button:focus-visible,a:focus-visible{outline:none;box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--ring)}
button.link{background:none;border:0;padding:0;height:auto;min-height:24px;color:inherit;box-shadow:none;text-decoration:underline;font-weight:600}
.body>form>button{width:100%}

/* /u actions: the card footer (Separator + subtle band), bled to the card's edges */
.actions{display:flex;flex-direction:column;gap:8px;margin:8px -20px -24px;padding:16px 20px;border-top:1px solid var(--border);background:var(--subtle);border-radius:0 0 var(--r-card) var(--r-card)}
.actions button{width:100%}
@media (min-width:480px){.actions{flex-direction:row-reverse;justify-content:flex-start;margin:8px -28px -28px;padding:16px 28px}.actions button{width:auto}}

/* Continue, and the 3-second countdown (the Refresh header does the redirect; this only shows it) */
.redirect{display:flex;flex-direction:column;gap:12px}
.redirect .button{width:100%}
.countdown{display:flex;align-items:center;gap:10px;font-size:13px;line-height:18px;color:var(--muted)}
.countdown-bar{position:relative;flex:1;height:2px;border-radius:2px;background:var(--border);overflow:hidden}
.countdown-bar::after{content:"";position:absolute;inset:0;background:var(--fg);transform-origin:left;transform:scaleX(0);animation:countdown var(--after,3s) linear forwards}
@keyframes countdown{to{transform:scaleX(1)}}

/* Separator */
hr,.sep{height:1px;border:0;margin:0;background:var(--border)}

/* Turnstile: reserve the widget's height so nothing jumps when it loads */
.cf-turnstile{min-height:65px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.fine{margin:0;font-size:13px;line-height:18px;color:var(--muted);text-align:center;text-wrap:balance}
.fine a{color:inherit}

/* ---------- footer: mark or logo, postal address, privacy, site ---------- */
footer{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:2px 16px;padding:0 8px;font-size:13px;line-height:18px;color:color-mix(in oklab,var(--muted),var(--fg) 22%);text-align:center}
footer>span:not(.foot-brand){text-wrap:balance}
footer .foot-brand{flex-basis:100%;display:flex;justify-content:center;margin-bottom:6px}
footer .foot-brand svg,footer .foot-brand img{display:block;width:auto;height:16px}
footer .foot-brand .mk-i{fill:var(--muted)}footer .foot-brand .mk-e{fill:var(--mark-ember)}
footer a{color:inherit;display:inline-flex;align-items:center;min-height:24px;text-decoration-color:color-mix(in oklab,currentColor 40%,transparent)}
footer a:hover{color:var(--fg)}
@media (max-width:480px),(pointer:coarse){footer a,button.link{min-height:44px}footer a{min-width:44px;justify-content:center}.notice button.link{height:44px;min-height:44px}footer{row-gap:0}}

/* ---------- motion ---------- */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition-duration:0s!important;animation:none!important}
  .countdown-bar{display:none}
}`

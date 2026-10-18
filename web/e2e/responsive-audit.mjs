#!/usr/bin/env node
// Responsive audit of any web app (the responsive-web skill).
//
// Visits each page at phone, tablet and desktop sizes (or at browser zoom levels) and records, per page and size:
// screen-sized frames down the page, horizontal overflow and the element causing it, crushed text (a run of words
// squeezed into a column a few letters wide), tap targets under 44px and under 24px (WCAG 2.2 AA), counting ::after
// hit areas and wrapping labels, text under 12px, and fixed chrome. Optionally records walkthrough videos.
//
//   node responsive-audit.mjs --base https://app.example.com --pages dashboard,settings,auth --out audit/before
//     [--cookie session] [--zoom] [--engine chromium|webkit] [--anon] [--video] [--assert]
//
// --cookie NAME   sign in by setting cookie NAME on the base host; its value comes from $AUDIT_COOKIE_VALUE (so it
//                 never appears in a command line or a log).
// --pages-file F  one path per line instead of --pages.
// --assert        exit 1 when any page has overflow, crushed text, or (on touch sizes) a target under 24px.
// --engine webkit needs system libraries some Linux distributions lack; run it in Microsoft's image:
//   docker run --rm --network host --ipc=host -e AUDIT_COOKIE_VALUE -v "$PWD:/w" -w /w \
//     mcr.microsoft.com/playwright:v<your @playwright/test version>-noble node responsive-audit.mjs --engine webkit ...
// Needs @playwright/test installed where it runs. Keep the output private when screens show paid or personal data.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
if (!args.base) throw new Error("--base https://… is required");
const BASE = String(args.base).replace(/\/$/, "");
const OUT = resolve(args.out || "responsive-audit");
// chromium (Android Chrome, desktop) or webkit (iPhone and iPad Safari). WebKit needs system libraries Arch
// lacks; run it in Microsoft's image: docker run --rm --network host -v "$PWD/../..:/repo" -w /repo/apps/web
// mcr.microsoft.com/playwright:v1.63.0-noble node scripts/responsive-audit.mjs --engine webkit ...
const ENGINE = args.engine === "webkit" ? "webkit" : "chromium";
// --pages a,b?x=1  audits exactly these paths (no discovery); --anon visits them signed out (sign-in, public pages).
const PAGES = (args["pages-file"] ? readFileSync(String(args["pages-file"]), "utf8").split("\n") : String(args.pages ?? "").split(","))
  .map((p) => p.trim().replace(/^\//, ""))
  .filter((p, i, all) => p !== "" || (all.length === 1 && i === 0));
if (!args.pages && !args["pages-file"]) throw new Error("say which pages: --pages a,b or --pages-file F ('' is the home page)");
const COOKIE = typeof args.cookie === "string" ? args.cookie : null;
const ANON = Boolean(args.anon);
const ZOOM = Boolean(args.zoom);
const ASSERT = Boolean(args.assert);

function cookieValue() {
  const v = process.env.AUDIT_COOKIE_VALUE;
  if (!v) throw new Error("--cookie needs the value in $AUDIT_COOKIE_VALUE");
  return v;
}

// Sizes people actually hold: small and common phones, a phone on its side, small and large tablets in both
// orientations (touch), laptops and desktops (mouse).
export const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 780, mobile: true },
  { name: "phone-390", width: 390, height: 844, mobile: true },
  { name: "phone-414", width: 414, height: 896, mobile: true },
  { name: "phone-land-844", width: 844, height: 390, mobile: true },
  { name: "tablet-600", width: 600, height: 960, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: true },
  { name: "tablet-820", width: 820, height: 1180, mobile: true },
  { name: "tablet-1024", width: 1024, height: 1366, mobile: true },
  { name: "tablet-land-1180", width: 1180, height: 820, mobile: true },
  { name: "tablet-land-1280", width: 1280, height: 800, mobile: true }, // Android tablets in landscape
  { name: "laptop-1280", width: 1280, height: 800, mobile: false },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];

// Browser zoom (--zoom): a screen at N% zoom lays the page out in a window N% smaller, at N% the pixel density, and
// keeps its pointer. A 1440x900 laptop at 150% is a 960x600 page with a mouse: widths and heights between the
// layouts' breakpoints, where "things fall apart". Phones and tablets have a page zoom setting too.
const ZOOM_SCREENS = [
  { base: "laptop-1280", width: 1280, height: 800, mobile: false, zooms: [110, 125, 150, 175, 200] },
  { base: "desktop-1440", width: 1440, height: 900, mobile: false, zooms: [110, 125, 150, 175, 200] },
  { base: "desktop-1920", width: 1920, height: 1080, mobile: false, zooms: [125, 150, 200] },
  { base: "phone-390", width: 390, height: 844, mobile: true, zooms: [115, 130, 150] },
  { base: "tablet-820", width: 820, height: 1180, mobile: true, zooms: [125, 150] },
];
export const ZOOM_VIEWPORTS = ZOOM_SCREENS.flatMap((z) =>
  z.zooms.map((pct) => ({
    name: `${z.base}@${pct}`,
    width: Math.round((z.width * 100) / pct),
    height: Math.round((z.height * 100) / pct),
    mobile: z.mobile,
    scale: ((z.mobile ? 2 : 1) * pct) / 100,
  })),
);

/** The sizes this run visits: the device set, or the zoom set with --zoom. */
const SIZES = () => (ZOOM ? ZOOM_VIEWPORTS : VIEWPORTS);



// Measured inside the page. Returns plain data only.
function measure() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      const cls = [...e.classList].slice(0, 2).join(".");
      if (cls) p += `.${cls}`;
      parts.unshift(p);
      if (e.id) break;
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    // Off-canvas drawers and panels parked beside the screen are closed, not visible.
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw;
  };
  // Inside a container that scrolls or clips sideways on purpose (tables, chip rails).
  const clippedSideways = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };

  const docOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  const all = [...document.body.querySelectorAll("*")];
  const offenders = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clippedSideways(el)) {
      // Keep the outermost offender only.
      if (offenders.some((o) => o.el.contains(el))) continue;
      offenders.push({ el, over: Math.round(Math.max(r.right - vw, -r.left)), w: Math.round(r.width) });
    }
  }
  const sidewaysScrollers = all
    .filter((el) => visible(el) && ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ sel: path(el), hidden: el.scrollWidth - el.clientWidth }));

  const tapSel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], summary, label[for]';
  const small = [];
  for (const el of document.querySelectorAll(tapSel)) {
    if (!visible(el)) continue;
    if (el.closest("p, li > span, .prose")) continue; // inline links in running text
    // Exempt by design (touch.css says why): the study calendar's day squares, a dense data grid.
    if (el.closest(".hm-grid")) continue;
    // A label beside its own full-size field: the field is the target (tapping the label only focuses it).
    if (el.matches("label[for]")) {
      const field = document.getElementById(el.htmlFor);
      if (field && field.getBoundingClientRect().height >= 40) continue;
    }
    // A control inside its <label> takes taps anywhere on the label.
    const r = (el.matches("input, select, textarea") && el.closest("label")?.getBoundingClientRect()) || el.getBoundingClientRect();
    // The area that takes the tap: the box, or an invisible ::after hit area that overhangs it.
    let w = r.width;
    let h = r.height;
    const after = getComputedStyle(el, "::after");
    if (after.content !== "none" && after.position === "absolute") {
      w = Math.max(w, Number.parseFloat(after.width) || 0);
      h = Math.max(h, Number.parseFloat(after.height) || 0);
    }
    if (el.matches(".sr-only, [class*=sr-only]") || (r.width <= 2 && r.height <= 2)) continue;
    if (w < 44 || h < 44) {
      // Many controls are legitimately compact on desktop; only count on touch-size screens.
      small.push({ sel: path(el), w: Math.round(w), h: Math.round(h), aa: w < 24 || h < 24, text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30) });
    }
  }
  small.sort((a, b) => Number(b.aa) - Number(a.aa));
  const tiny = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const fs = Number.parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) tiny.push({ sel: path(el), size: fs, text: t.slice(0, 30) });
  }
  // Crushed text: a run of words squeezed into a column a few characters wide, so it reads a letter or a word a
  // line (a label beside a control that took the row). Long text, narrow box, many lines.
  const crushed = [];
  for (const el of seen) {
    const t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    if (t.length < 12 || Number.parseFloat(getComputedStyle(el).fontSize) < 1) continue; // hidden by font-size:0
    const r = el.getBoundingClientRect();
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || Number.parseFloat(getComputedStyle(el).fontSize) * 1.3;
    if (r.width < 80 && r.height > lh * 3.5 && getComputedStyle(el).writingMode.startsWith("horizontal")) {
      crushed.push({ sel: path(el), w: Math.round(r.width), lines: Math.round(r.height / lh), text: t.slice(0, 40) });
    }
  }
  const fixed = all
    .filter((el) => visible(el) && ["fixed", "sticky"].includes(getComputedStyle(el).position))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { sel: path(el), h: Math.round(Math.min(r.bottom, vh) - Math.max(r.top, 0)), top: Math.round(r.top) };
    })
    .filter((f) => f.h > 0);
  const fixedShare = Math.round((fixed.reduce((n, f) => n + f.h, 0) / vh) * 100);

  return {
    vw,
    vh,
    docOverflow,
    pageHeight: document.documentElement.scrollHeight,
    offenders: offenders.slice(0, 12).map((o) => ({ sel: path(o.el), over: o.over, w: o.w })),
    sidewaysScrollers: sidewaysScrollers.slice(0, 12),
    smallTargets: { count: small.length, aa: small.filter((x) => x.aa).length, samples: small.slice(0, 15) },
    tinyText: { count: tiny.length, samples: tiny.slice(0, 10) },
    crushed: crushed.slice(0, 10),
    fixed,
    fixedShare,
    title: document.title,
  };
}

async function contextFor(browser, vp, extra = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.scale ?? (vp.mobile ? 2 : 1),
    isMobile: vp.mobile && (vp.width < 1100 || vp.height < 500),
    hasTouch: vp.mobile,
    userAgent: vp.mobile ? devices[ENGINE === "webkit" ? (Math.min(vp.width, vp.height) < 500 ? "iPhone 14" : "iPad Pro 11") : Math.min(vp.width, vp.height) < 500 ? "Pixel 7" : "Galaxy Tab S4"].userAgent : undefined,
    ...extra,
  });
  const url = new URL(BASE);
  if (COOKIE && !ANON) await ctx.addCookies([{ name: COOKIE, value: cookieValue(), domain: url.hostname, path: "/", httpOnly: true, secure: url.protocol === "https:", sameSite: "Lax" }]);
  return ctx;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  // Popups and tours would cover the page: close what announces itself as closable.
  for (const sel of ['[data-tour] button[aria-label*="lose" i]', '[role=dialog] button[aria-label*="lose" i]', 'button:has-text("Skip")', 'button:has-text("Not now")', 'button:has-text("Got it")']) {
    const b = await page.$(sel).catch(() => null);
    if (b && (await b.isVisible().catch(() => false))) await b.click({ timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
}

async function audit(browser) {
  mkdirSync(join(OUT, "shots"), { recursive: true });
  const pages = PAGES;
  const results = [];
  for (const vp of SIZES()) {
    const ctx = await contextFor(browser, vp);
    const page = await ctx.newPage();
    for (const p of pages) {
      const name = `${p.replace(/[/?=&]/g, "_")}__${vp.name}`;
      try {
        await page.goto(`${BASE}/${p}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await settle(page);
        const m = await page.evaluate(measure);
        // Screen-sized frames down the page, as a person sees it: a full-page capture stretches the
        // window, which moves fixed chrome mid-page and reveals off-screen sheets.
        const frames = [];
        const maxY = Math.max(0, m.pageHeight - vp.height);
        const step = Math.round(vp.height * 0.85);
        for (let y = 0, i = 0; i < 6; y += step, i++) {
          await page.evaluate((v) => window.scrollTo(0, v), Math.min(y, maxY));
          await page.waitForTimeout(250);
          const f = `shots/${name}__${i}.png`;
          await page.screenshot({ path: join(OUT, f), timeout: 30000 });
          frames.push(f);
          if (y >= maxY) break;
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        results.push({ page: p, viewport: vp.name, width: vp.width, mobile: vp.mobile, url: page.url(), shot: frames[0], frames, ...m });
        process.stdout.write(`${vp.name.padEnd(17)} ${p.padEnd(24)} overflow=${m.docOverflow} offenders=${m.offenders.length} crushed=${m.crushed.length} under24=${m.smallTargets.aa} small=${m.smallTargets.count} tiny=${m.tinyText.count} fixed=${m.fixedShare}%\n`);
      } catch (e) {
        results.push({ page: p, viewport: vp.name, width: vp.width, error: String(e.message || e) });
        process.stdout.write(`${vp.name.padEnd(17)} ${p.padEnd(24)} ERROR ${e.message}\n`);
      }
    }
    await ctx.close();
  }
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), viewports: SIZES(), results }, null, 2));
  writeReport(results);
  return pages;
}

// A walkthrough as a person would do it: land, scroll, open the menu, visit each section, scroll.
async function walkthrough(browser, vp, pages) {
  const dir = join(OUT, "video");
  mkdirSync(dir, { recursive: true });
  const ctx = await contextFor(browser, vp, { recordVideo: { dir, size: { width: vp.width, height: vp.height } } });
  const page = await ctx.newPage();
  const slowScroll = async () => {
    const h = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    for (let y = 0; y <= h; y += Math.round(vp.height * 0.6)) {
      await page.evaluate((v) => window.scrollTo({ top: v, behavior: "smooth" }), y);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(500);
  };
  for (const p of pages) {
    await page.goto(`${BASE}/${p}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await settle(page);
    await page.waitForTimeout(800);
    // Try the navigation once per page: whatever opens the menu on this size.
    if (p === pages[0]) {
      for (const sel of ['button[aria-label*="menu" i]', 'button[aria-label*="navigation" i]', ".dock", "nav"]) {
        const b = await page.$(sel).catch(() => null);
        if (b && (await b.isVisible().catch(() => false))) {
          await b.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1200);
          await page.keyboard.press("Escape").catch(() => {});
          break;
        }
      }
    }
    await slowScroll();
  }
  const video = page.video();
  await ctx.close();
  const target = join(dir, `walkthrough__${vp.name}.webm`);
  if (video) renameSync(await video.path(), target);
  return target;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function writeReport(results) {
  const pages = [...new Set(results.map((r) => r.page))];
  // Touch rules (tap targets, small text) apply to screens held in the hand, whatever their CSS width.
  const touch = (r) => r.mobile ?? (r.width < 1100 || r.viewport.startsWith("phone"));
  const row = (r) => {
    if (r.error) return `<td class="bad">error</td>`;
    const bad = r.docOverflow > 0 || r.offenders.length || r.crushed?.length || (touch(r) && r.smallTargets.aa > 0);
    const warn = touch(r) && (r.smallTargets.count > 0 || r.tinyText.count > 0 || r.fixedShare > 25);
    const tip = [
      r.docOverflow > 0 ? `page ${r.docOverflow}px wider than screen` : "",
      ...r.offenders.slice(0, 4).map((o) => `${o.sel} +${o.over}px`),
      ...(r.crushed ?? []).slice(0, 4).map((c) => `crushed text ${c.w}px wide, ${c.lines} lines: ${c.sel} "${c.text}"`),
      touch(r) && r.smallTargets.aa ? `${r.smallTargets.aa} tap targets <24px (WCAG 2.2 AA)` : "",
      touch(r) && r.smallTargets.count ? `${r.smallTargets.count} tap targets <44px` : "",
      touch(r) && r.tinyText.count ? `${r.tinyText.count} text <12px` : "",
      touch(r) && r.fixedShare > 25 ? `fixed chrome ${r.fixedShare}% of screen` : "",
    ].filter(Boolean).join("\n");
    return `<td class="${bad ? "bad" : warn ? "warn" : "ok"}" title="${esc(tip)}"><a href="${r.shot}">${bad ? (r.docOverflow > 0 || r.offenders.length ? `+${r.docOverflow}` : r.crushed?.length ? "crushed" : `AA ${r.smallTargets.aa}`) : warn ? `${touch(r) ? r.smallTargets.count : ""}` : "ok"}</a></td>`;
  };
  const vps = SIZES().map((v) => v.name);
  const table = pages
    .map((p) => `<tr><th>${esc(p)}</th>${vps.map((v) => row(results.find((r) => r.page === p && r.viewport === v) || { error: "missing" })).join("")}</tr>`)
    .join("\n");
  const details = results
    .filter((r) => !r.error && (r.docOverflow > 0 || r.offenders.length || r.crushed?.length || (touch(r) && (r.smallTargets.count || r.tinyText.count || r.fixedShare > 25))))
    .map(
      (r) => `<section><h3>${esc(r.page)} · ${r.viewport}</h3>
<p>overflow ${r.docOverflow}px · small targets ${r.smallTargets.count} · tiny text ${r.tinyText.count} · fixed ${r.fixedShare}%</p>
<pre>${esc(
        [
          ...r.offenders.map((o) => `OVERFLOW ${o.sel}  +${o.over}px (w ${o.w})`),
          ...(r.crushed ?? []).map((c) => `CRUSHED ${c.w}px x ${c.lines} lines ${c.sel} "${c.text}"`),
          ...r.smallTargets.samples.map((s) => `TAP ${s.w}x${s.h} ${s.sel} "${s.text}"`),
          ...r.tinyText.samples.map((s) => `TEXT ${s.size}px ${s.sel} "${s.text}"`),
          ...r.fixed.map((f) => `FIXED ${f.sel} h=${f.h} top=${f.top}`),
        ].join("\n"),
      )}</pre><div class="frames">${r.frames.map((f) => `<a href="${f}"><img loading="lazy" src="${f}"></a>`).join("")}</div></section>`,
    )
    .join("\n");
  writeFileSync(
    join(OUT, "report.html"),
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Responsive audit</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}table{border-collapse:collapse}td,th{border:1px solid #333;padding:4px 8px;text-align:center}th{text-align:left}
.ok{background:#16351c}.warn{background:#4a3b10}.bad{background:#5a1717}a{color:inherit}img{max-height:420px;border:1px solid #333}.frames{display:flex;gap:6px;overflow-x:auto}pre{white-space:pre-wrap;font-size:12px;background:#1b1b1b;padding:8px}section{margin:24px 0}</style>
<h1>Responsive audit · ${ENGINE} · ${esc(BASE)} · ${new Date().toISOString()}</h1>
<p>Red: the page is wider than the screen (number = extra px), text is crushed into a column a few letters wide, or on touch sizes a control is under 24px (WCAG 2.2 AA). Amber: on touch sizes, controls under 44px, text under 12px or fixed chrome over 25% (number = small targets). Hover a cell for details; click for the screenshot.</p>
<table><tr><th>page</th>${vps.map((v) => `<th>${v}</th>`).join("")}</tr>${table}</table>${details}`,
  );
}

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
try {
  const pages = args["video-only"] ? PAGES : await audit(browser);
  if (args.video || args["video-only"]) {
    const walk = pages;
    for (const vp of [VIEWPORTS[1], VIEWPORTS[4]]) console.log("video", await walkthrough(browser, vp, walk));
  }
  if (!args["video-only"]) console.log(`report: ${join(OUT, "report.html")}`);
  if (ASSERT && !args["video-only"]) {
    const { results } = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8"));
    const failed = results.filter(
      (r) => r.error || r.docOverflow > 0 || r.offenders.length || r.crushed?.length || (r.mobile && r.smallTargets.aa > 0),
    );
    for (const r of failed) {
      console.error(`FAIL ${r.viewport} /${r.page}: ${r.error ?? [r.docOverflow > 0 ? `${r.docOverflow}px wider than the screen` : "", r.offenders.length ? `${r.offenders[0].sel} sticks out` : "", r.crushed?.length ? `crushed text "${r.crushed[0].text}"` : "", r.mobile && r.smallTargets.aa ? `${r.smallTargets.aa} tap targets under 24px` : ""].filter(Boolean).join("; ")}`);
    }
    if (failed.length) process.exitCode = 1;
    else console.log(`pass: ${results.length} page × size checks`);
  }
} finally {
  await browser.close();
}

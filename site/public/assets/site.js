/* Mailyard page UI: works in both layouts. The 3D scene (scene.js) is loaded after first paint, only for the scroll story. */
(function () {
  'use strict';
  const root = document.documentElement;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = {};
  const MY = (window.MY = {
    on: (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn),
    emit: (ev, d) => (listeners[ev] || []).forEach((fn) => fn(d)),
    still: root.classList.contains('still'),
    story: () => root.classList.contains('story'),
    sceneActive: false,
    card: { tpl: 'transactional', share: 45 },
    setChip: null,
  });
  const pref = () => { try { return localStorage.getItem('mailyard-motion'); } catch (e) { return null; } };
  const savePref = (v) => { try { localStorage.setItem('mailyard-motion', v); } catch (e) {} };

  /* ---------- mode: the scroll story needs room, and motion unless asked for ---------- */
  const wantsStory = () => innerWidth >= 768 && innerHeight >= 560 && (!RM.matches || pref() === 'on');
  let loading = false;
  function loadScene() {
    if (loading) return; loading = true;
    const srcs = ['assets/vendor/gsap.min.js', 'assets/vendor/ScrollTrigger.min.js', 'assets/vendor/three.min.js', 'assets/scene.js'];
    const next = () => { const src = srcs.shift(); if (!src) return; const s = document.createElement('script'); s.src = src; s.onload = next; document.body.appendChild(s); };
    next();
  }
  function afterPaint(fn) {
    const go = () => requestAnimationFrame(() => setTimeout(fn, 0));
    if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  }
  function setMode() {
    const was = MY.story(), want = wantsStory();
    if (was !== want) { root.classList.toggle('story', want); if (!want) root.classList.remove('ready'); MY.emit('mode', want); }
    if (want) afterPaint(loadScene);
    syncChipsStatic();
  }
  let rT; addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(setMode, 150); });
  RM.addEventListener('change', () => { if (!pref()) setStill(RM.matches, false); setMode(); });

  /* ---------- motion toggle ---------- */
  const motionBtn = $('#motion');
  function setStill(v, save) {
    MY.still = v;
    root.classList.toggle('still', v);
    motionBtn.setAttribute('aria-pressed', String(v));
    $('.sr', motionBtn).textContent = v ? 'Resume motion' : 'Pause motion';
    if (save) savePref(v ? 'off' : 'on');
    MY.emit('still', v);
  }
  motionBtn.addEventListener('click', () => { setStill(!MY.still, true); setMode(); });
  setStill(MY.still, false);

  /* ---------- navigation ---------- */
  $$('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const id = b.dataset.go;
    const el = MY.story() && document.getElementById(id + '-wrap') || document.getElementById(id);
    window.scrollTo({ top: el.getBoundingClientRect().top + scrollY + 1, behavior: MY.still || RM.matches ? 'auto' : 'smooth' });
    const target = document.getElementById(id);
    if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  }));
  const chips = $$('.chip');
  let chipOn = 0;
  // n = -1: no chapter on screen (the yard and the footer)
  MY.setChip = (n) => { if (n === chipOn) return; chipOn = n; chips.forEach((c, i) => { c.classList.toggle('on', i === n); if (i === n) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current'); }); };
  const secs = ['hero', 'fold', 'tunnel', 'flight', 'agents', 'yard'].map((id) => document.getElementById(id));
  function syncChipsStatic() {
    if (MY.sceneActive && MY.story()) return;
    const mid = innerHeight * 0.5; let n = 0;
    secs.forEach((s, i) => { if (s.getBoundingClientRect().top <= mid) n = i; });
    MY.setChip(n === 5 ? -1 : n);
  }
  addEventListener('scroll', syncChipsStatic, { passive: true });

  /* ---------- header ---------- */
  const top = $('#top'), runsBtn = $('.runs-btn'), runsList = $('#runs-list');
  const closeRuns = () => { runsBtn.setAttribute('aria-expanded', 'false'); runsList.hidden = true; };
  runsBtn.addEventListener('click', () => { const o = runsBtn.getAttribute('aria-expanded') !== 'true'; runsBtn.setAttribute('aria-expanded', String(o)); runsList.hidden = !o; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !runsList.hidden) { closeRuns(); runsBtn.focus(); } });
  document.addEventListener('click', (e) => { if (!runsList.hidden && !e.target.closest('.runs')) closeRuns(); });
  let lastY = scrollY;
  addEventListener('scroll', () => { const y = scrollY; if (y > lastY + 2 && y > 4) { top.classList.add('away'); closeRuns(); } else if (y < lastY - 6 || y < 4) top.classList.remove('away'); lastY = y; }, { passive: true });
  top.addEventListener('focusin', () => top.classList.remove('away'));

  /* ---------- send card ---------- */
  const quota = $('#quota'), qOut = $('#quota-out'), sendBtn = $('#send'), sendHelp = $('#send-help');
  const SEND_HELP = sendHelp.textContent;
  $$('input[name=tpl]').forEach((r) => r.addEventListener('change', () => { MY.card.tpl = r.value; MY.emit('tpl', r.value); }));
  function onQuota() {
    MY.card.share = +quota.value;
    qOut.textContent = MY.card.share + '%';
    quota.style.setProperty('--p', ((MY.card.share - 5) / 95 * 100) + '%');
    MY.emit('share', MY.card.share);
  }
  quota.addEventListener('input', onQuota); onQuota();
  const log = [];
  sendBtn.addEventListener('click', () => {
    const at = new Date();
    log.push({ template: MY.card.tpl, shareOfDailyQuota: MY.card.share + '%', events: ['queued', 'sent', 'delivered'].map((e, i) => ({ event: e, at: new Date(at.getTime() + i * 1200).toISOString() })) });
    sendHelp.textContent = 'Sent, in sample mode. Nothing left this page.';
    const done = () => { sendBtn.disabled = false; sendHelp.textContent = SEND_HELP; };
    if (MY.sceneActive && MY.story() && !MY.still) { sendBtn.disabled = true; MY.emit('send', done); } else setTimeout(done, 2600);
  });
  $('#receipt').addEventListener('click', () => {
    const body = { app: 'Mailyard', note: 'Sample data from the landing page. No email was sent.', generatedAt: new Date().toISOString(),
      plan: { template: MY.card.tpl, shareOfDailyQuota: MY.card.share + '%', dailyQuota: "your Cloudflare account's daily quota" }, sends: log };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
    a.download = 'mailyard-delivery-log.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------- agent mailbox ---------- */
  const approve = $('#approve'), approveHelp = $('#approve-help'), APPROVE_HELP = approveHelp.textContent;
  approve.addEventListener('click', () => {
    approve.disabled = true;
    $('span', approve).textContent = 'Approved';
    approveHelp.textContent = 'Approved by you. Sent from agent@yourdomain and written to the audit log. Sample data: nothing is sent.';
    const done = () => { approve.disabled = false; $('span', approve).textContent = 'Approve and send'; approveHelp.textContent = APPROVE_HELP; };
    if (MY.sceneActive && MY.story() && !MY.still) MY.emit('approve', () => setTimeout(done, 1800)); else setTimeout(done, 4000);
  });
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const text = document.getElementById(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents(document.getElementById(b.dataset.copy)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => (b.textContent = 'Copy'), 1800);
  }));

  setMode();
})();

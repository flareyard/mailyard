/* Mailyard scroll scene. Poses, ranges and colours come from reference/motion-spec.md;
   chapter 05 (your agent) extends the map past u 6.03. Loaded after first paint, story layout only. */
(function () {
  'use strict';
  const MY = window.MY;
  THREE.ColorManagement.legacyMode = false;
  const root = document.documentElement;

  /* ---------------- colours: resolved from the CSS tokens, per theme ---------------- */
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const swatch = document.createElement('i'); swatch.style.display = 'none'; document.body.appendChild(swatch);
  function cssColor(name) {
    swatch.style.color = 'var(--' + name + ')';
    probe.fillStyle = '#000'; probe.fillStyle = getComputedStyle(swatch).color;
    probe.clearRect(0, 0, 1, 1); probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const C = {};
  function readColors() {
    ['ground', 'ink', 'display', 'accent-d', 'small-acc', 'band', 'on-band', 'on-band-acc', 'paper-ember', 'paper-ink', 'ring-blue', 'ring-amber',
      'ember-700', 'blue-800', 'gray-100', 'gray-1000'].forEach((n) => (C[n] = cssColor(n)));
  }
  readColors();
  const hex = (h) => new THREE.Color(h);

  /* ---------------- state ---------------- */
  const S = { u: 0, still: MY.still, debugU: null, t0: performance.now(), on: MY.story() };
  MY.on('still', (v) => { S.still = v; });
  MY.on('mode', (v) => { S.on = v; if (v) { resize(); requestAnimationFrame(() => { ScrollTrigger.refresh(); measure(); syncChip(); }); } });

  /* ---------------- renderer ---------------- */
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: /[?&]capture/.test(location.search) });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const FOV = 35, CAMZ = 10, TAN = Math.tan((FOV / 2) * Math.PI / 180);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 260);
  camera.position.set(0, 0, CAMZ);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a4033, 0.42));
  const key = new THREE.DirectionalLight(0xffffff, 0.95); key.position.set(-3, 7, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff2e6, 0.22); fill.position.set(6, -3, 6); scene.add(fill);

  /* ---------------- paper: crease-split sheet ---------------- */
  // Sheet in its own flat frame: x ∈ [-1, 1], y ∈ [-H, H], front facing +z, nose at +y.
  const H = 1.4;
  const T8 = Math.tan(Math.PI / 8);
  const WING_X = 0.3; // wing crease reaches x = ±0.3 at the tail
  // a = corners to centre, b = edges to centre, d = wings, c = fold in half.
  const FOLDS = [
    { k: 'a', p: [0, H], q: [-1, H - 1], ref: [-0.9, H - 0.05], mag: Math.PI, dir: 1, flat: true, lift: 0.014 },
    { k: 'a', p: [0, H], q: [1, H - 1], ref: [0.9, H - 0.05], mag: Math.PI, dir: 1, flat: true, lift: 0.014 },
    { k: 'b', p: [0, H], q: [-1, H - 1 / T8], ref: [-0.6, 0.9], mag: Math.PI, dir: 1, flat: true, lift: 0.03 },
    { k: 'b', p: [0, H], q: [1, H - 1 / T8], ref: [0.6, 0.9], mag: Math.PI, dir: 1, flat: true, lift: 0.03 },
    { k: 'd', p: [0, H], q: [-WING_X, -H], ref: [-0.8, -1.25], mag: Math.PI / 2 * 0.9, dir: -1 },
    { k: 'd', p: [0, H], q: [WING_X, -H], ref: [0.8, -1.25], mag: Math.PI / 2 * 0.9, dir: -1 },
    { k: 'c', p: [0, -H], q: [0, H], ref: [-0.5, 0], mag: Math.PI / 2, dir: 1 },
    { k: 'c', p: [0, -H], q: [0, H], ref: [0.5, 0], mag: Math.PI / 2, dir: 1 },
  ];
  const cross2 = (u, v) => u[0] * v[1] - u[1] * v[0];
  const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
  function reflect(pt, f) {
    const d = sub2(f.q, f.p), L = Math.hypot(d[0], d[1]), ux = d[0] / L, uy = d[1] / L;
    const v = sub2(pt, f.p), t = v[0] * ux + v[1] * uy;
    const px = f.p[0] + ux * t, py = f.p[1] + uy * t;
    return [2 * px - pt[0], 2 * py - pt[1]];
  }
  FOLDS.forEach((f) => {
    const d = sub2(f.q, f.p); const L = Math.hypot(d[0], d[1]);
    f.u = [d[0] / L, d[1] / L];
    f.side = Math.sign(cross2(d, sub2(f.ref, f.p)));
    f.theta = f.mag * f.dir * f.side; // toward +z when dir = 1
  });
  // Split polygons along each crease, deciding membership in post-reflection (flat) coordinates.
  let polys = [{ pts: [[-1, -H], [1, -H], [1, H], [-1, H]], refl: [], mem: [] }];
  const cur = (poly, pt) => poly.refl.reduce((p, fi) => reflect(p, FOLDS[fi]), pt);
  const uncur = (poly, pt) => poly.refl.slice().reverse().reduce((p, fi) => reflect(p, FOLDS[fi]), pt);
  FOLDS.forEach((f, fi) => {
    const d = sub2(f.q, f.p), out = [];
    polys.forEach((poly) => {
      const c = poly.pts.map((pt) => cur(poly, pt));
      const s = c.map((pt) => cross2(d, sub2(pt, f.p)));
      const pos = s.some((v) => v > 1e-7), neg = s.some((v) => v < -1e-7);
      const parts = [];
      if (pos && neg) {
        const A = [], B = [];
        for (let i = 0; i < c.length; i++) {
          const j = (i + 1) % c.length, si = s[i], sj = s[j];
          if (si >= -1e-7) A.push(poly.pts[i]); if (si <= 1e-7) B.push(poly.pts[i]);
          if ((si > 1e-7 && sj < -1e-7) || (si < -1e-7 && sj > 1e-7)) {
            const t = si / (si - sj);
            const ip = uncur(poly, [c[i][0] + (c[j][0] - c[i][0]) * t, c[i][1] + (c[j][1] - c[i][1]) * t]);
            A.push(ip); B.push(ip);
          }
        }
        parts.push({ pts: A, sgn: 1 }, { pts: B, sgn: -1 });
      } else parts.push({ pts: poly.pts, sgn: pos ? 1 : -1 });
      parts.forEach((pa) => {
        if (pa.pts.length < 3) return;
        const moving = pa.sgn === f.side;
        out.push({ pts: pa.pts, refl: moving && f.flat ? poly.refl.concat(fi) : poly.refl.slice(), mem: moving ? poly.mem.concat(fi) : poly.mem.slice() });
      });
    });
    polys = out;
  });
  // Triangulate (all pieces are convex) into a non-indexed buffer.
  const tri = [];
  polys.forEach((poly) => { for (let i = 1; i < poly.pts.length - 1; i++) tri.push([poly.pts[0], poly.pts[i], poly.pts[i + 1], poly.mem]); });
  const NV = tri.length * 3;
  const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), vMem = [], vFlat = [];
  tri.forEach((t, i) => { for (let k = 0; k < 3; k++) { const p = t[k], vi = i * 3 + k; vFlat.push(p); vMem.push(t[3]); uv[vi * 2] = (p[0] + 1) / 2; uv[vi * 2 + 1] = (p[1] + H) / (2 * H); } });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const _v = new THREE.Vector3(), _ax = new THREE.Vector3(), _o = new THREE.Vector3();
  function foldPaper(pr) {
    for (let i = 0; i < NV; i++) {
      const fp = vFlat[i]; _v.set(fp[0], fp[1], 0);
      const mem = vMem[i];
      for (let m = 0; m < mem.length; m++) {
        const f = FOLDS[mem[m]], amt = pr[f.k];
        if (amt <= 0) continue;
        _o.set(f.p[0], f.p[1], 0); _ax.set(f.u[0], f.u[1], 0);
        _v.sub(_o).applyAxisAngle(_ax, f.theta * amt).add(_o);
        if (f.lift) _v.z += f.lift * amt;
      }
      pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  /* printed face: a letter */
  const alpha = (h, a) => { const c = hex(h); c.convertLinearToSRGB(); return 'rgba(' + [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(',') + ',' + a + ')'; };
  const papers = () => ({
    transactional: { paper: C['paper-ember'], ink: C['paper-ink'], faint: alpha(C['paper-ink'], 0.26) },
    broadcast: { paper: C.band, ink: C['on-band'], faint: alpha(C['on-band'], 0.24) },
    plain: { paper: C['gray-100'], ink: C['gray-1000'], faint: alpha(C['gray-1000'], 0.2) },
  });
  let PAPERS = papers();
  const tex = document.createElement('canvas'); tex.width = 1024; tex.height = 1434;
  const texture = new THREE.CanvasTexture(tex); texture.encoding = THREE.sRGBEncoding; texture.anisotropy = 8;
  function drawPrint(pp) {
    const g = tex.getContext('2d'), W = tex.width, Hh = tex.height;
    g.fillStyle = pp.paper; g.fillRect(0, 0, W, Hh);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.035)'; g.fillRect(rnd() * W, rnd() * Hh, 2, 2); }
    g.fillStyle = pp.faint; g.font = '500 30px "Funnel Sans"';
    const x0 = 330, y0 = 560;
    g.fillText('From   hello@yourdomain', x0, y0);
    g.fillText('To      you@inbox', x0, y0 + 46);
    g.fillText('Subject   Sent from your own yard', x0, y0 + 92);
    g.fillRect(x0, y0 + 122, 370, 2);
    [360, 330, 352, 250, 0, 340, 300, 180].forEach((w, i) => { if (w) roundRect(g, x0, y0 + 156 + i * 34, w, 12, 6); });
    g.fillStyle = pp.ink; g.font = '600 96px "Funnel Display"';
    [0.25, 0.75].forEach((cx) => {
      g.save(); g.translate(W * cx + 34, Hh * 0.885); g.rotate(-Math.PI / 2);
      g.fillText('mailyard', 0, 0);
      g.font = '500 22px "Funnel Sans"'; g.globalAlpha = 0.85; g.fillText('your domain · your account', 6, 40); g.globalAlpha = 1;
      g.font = '600 96px "Funnel Display"';
      g.restore();
      g.fillRect(W * cx - 112, Hh * 0.935, 224, 7);
    });
    texture.needsUpdate = true;
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.fill(); }
  const front = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.92, metalness: 0, side: THREE.FrontSide, flatShading: true, transparent: true });
  const back = new THREE.MeshStandardMaterial({ color: hex(PAPERS.transactional.paper), roughness: 0.95, metalness: 0, side: THREE.BackSide, flatShading: true, transparent: true });
  const foldFrame = new THREE.Group(); foldFrame.add(new THREE.Mesh(geo, front), new THREE.Mesh(geo, back));
  foldFrame.rotation.x = -Math.PI / 2;
  const plane = new THREE.Group(); plane.add(foldFrame); scene.add(plane);

  /* ---------------- rings: the delivery route ---------------- */
  const route = new THREE.Group(); scene.add(route);
  const RING_N = 14, RING_GAP = 5.2, RING_R = 3.25;
  const ringKeys = ['ring-blue', 'ember-700', 'ring-amber'];
  const ringGeo = new THREE.TorusGeometry(RING_R, 0.075, 18, 180);
  const rings = [];
  for (let i = 0; i < RING_N; i++) {
    const m = new THREE.MeshStandardMaterial({ color: hex(C[ringKeys[i % 3]]), roughness: 0.42, metalness: 0.05, transparent: true });
    const r = new THREE.Mesh(ringGeo, m); route.add(r); rings.push(r);
  }
  const AX = 0.14, AY = 0.25, AY0 = -1.3;
  const axisAt = (D, v) => v.set(AX * D, AY * D + AY0, CAMZ - D);
  const far = axisAt(90, new THREE.Vector3());
  const railKeys = ['ring-amber', 'blue-800', 'blue-800', 'ember-700'];
  const rails = [[-9.5, -6.5, 3], [-8.5, -7.5, 4.5], [11, -1.5, 2], [10, -4.5, 3.5]].map((a, i) => {
    const A = new THREE.Vector3(...a), dir = far.clone().sub(A), len = dir.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6, 1, true), new THREE.MeshBasicMaterial({ color: hex(C[railKeys[i]]), transparent: true }));
    mesh.position.copy(A).add(far).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    route.add(mesh); return mesh;
  });
  const TAGS = [['api Worker'], ['send Queue'], ['SendGovernorDO', 'mono'], ['Email Sending'], ['SPF'], ['DKIM'], ['DMARC'], ['the inbox']];
  const tagLayer = document.getElementById('tags');
  const tagEls = TAGS.map(([t, mono]) => { const el = document.createElement('span'); el.className = 'tag'; el.innerHTML = '<i></i><span class="' + (mono || '') + '">' + t + '</span>'; tagLayer.appendChild(el); return el; });
  const TAG_ANG = [2.45, 0.55, 2.3, 0.75, 2.55, 0.5, 2.2, 0.85];
  let tagW = []; const tagK = TAGS.map(() => 0);
  const keepEls = [...document.querySelectorAll('.sec-label, .chap h2, .eyebrow, .coords, .wind, .dest, .row-bottom, .cap-block, .fold-cap, .card, .note, .ag-lead, .ag-code, .mailbox, #top')];
  function keepOut() {
    if (!tagW.length || !tagW[0]) tagW = tagEls.map((el) => el.offsetWidth);
    const out = [];
    for (const el of keepEls) { const r = el.getBoundingClientRect(); if (r.bottom > 0 && r.top < VH && r.width) out.push(r); }
    return out;
  }

  /* ---------------- theme changes ---------------- */
  function applyTheme() {
    readColors(); PAPERS = papers();
    const pp = PAPERS[MY.card.tpl]; drawPrint(pp); back.color.set(pp.paper);
    rings.forEach((r, i) => r.material.color.set(C[ringKeys[i % 3]]));
    rails.forEach((m, i) => m.material.color.set(C[railKeys[i]]));
    okG = toOk(C.ground); okB = toOk(C.band); lastW = -1;
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(applyTheme));

  /* ---------------- pose keyframes (motion-spec.md, then chapter 05) ---------------- */
  // [u, fx, fy, z, scale, rx, ry, rz, a, b, c, d, mfx, mfy, ms]
  const KF = [
    [0.00, .723, .453, 0, 1.00, .85, 1.95, .42, 1, 1, 1, 1, .62, .64, .62],
    [0.13, .767, .420, 0, 1.00, .6, 1.62, .08, 1, 1, 1, 1, .62, .62, .62],
    [0.30, .776, .432, 0, 1.00, .95, 1.55, -.55, 1, 1, 1, 1, .62, .62, .62],
    [0.39, .784, .415, 0, 1.00, 1.15, 1.35, -.75, 1, 1, 1, .8, .62, .62, .6],
    [0.48, .779, .422, 0, 1.00, 1.25, 1.0, -.6, 1, 1, .9, .3, .62, .62, .58],
    [0.57, .750, .499, 0, 1.00, 1.3, .55, -.45, 1, .8, .7, 0, .62, .62, .56],
    [0.66, .724, .483, 0, 1.00, 1.32, .3, -.4, 1, .4, .45, 0, .62, .62, .55],
    [0.75, .714, .435, 0, 1.00, 1.3, .18, -.38, 1, 0, .2, 0, .62, .58, .5],
    [0.84, .711, .426, 0, 1.00, 1.27, .15, -.38, .75, 0, 0, 0, .62, .58, .5],
    [0.93, .713, .385, 0, .94, 1.10, .15, -.38, .2, 0, 0, 0, .62, .58, .5],
    [1.02, .712, .386, 0, .92, 1.10, .15, -.38, 0, 0, 0, 0, .62, .58, .5],
    [1.46, .712, .415, 0, .92, 1.10, .12, -.3, 0, 0, 0, 0, .62, .58, .5],
    [1.64, .709, .449, 0, .92, 1.12, .1, -.24, .5, 0, 0, 0, .62, .58, .5],
    [1.73, .704, .489, 0, .94, 1.12, .08, -.2, .95, 0, 0, 0, .62, .58, .5],
    [1.91, .695, .550, 0, 1.00, 1.12, .05, -.12, 1, .6, 0, 0, .62, .58, .5],
    [2.00, .694, .542, 0, 1.00, 1.05, .03, -.06, 1, 1, .1, 0, .62, .58, .5],
    [2.09, .683, .494, 0, 1.00, .85, 0, 0, 1, 1, .7, .2, .6, .58, .5],
    [2.18, .682, .485, 0, 1.00, .65, 0, 0, 1, 1, 1, .6, .58, .58, .5],
    [2.36, .684, .524, 0, 1.00, .48, 0, 0, 1, 1, 1, 1, .56, .6, .52],
    [2.63, .674, .531, 0, 1.00, .46, 0, .04, 1, 1, 1, 1, .55, .6, .52],
    [2.90, .645, .506, 3.6, 1.00, .46, 0, .1, 1, 1, 1, 1, .55, .6, .52],
    [3.26, .639, .531, 4.2, 1.00, .45, 0, -.16, 1, 1, 1, 1, .55, .6, .52],
    [3.44, .634, .567, 4.0, 1.00, .45, 0, .14, 1, 1, 1, 1, .55, .6, .52],
    [3.79, .652, .536, 3.7, 1.00, .44, -.05, -.04, 1, 1, 1, 1, .55, .6, .52],
    [4.03, .649, .542, 3.4, 1.00, .42, -.35, .22, 1, 1, 1, 1, .55, .6, .52],
    [4.19, .681, .546, 2.6, 1.00, .45, -.95, .32, 1, 1, 1, 1, .58, .58, .52],
    [4.41, .672, .546, 1.8, 1.00, .4, -1.45, .38, 1, 1, 1, 1, .6, .54, .52],
    [4.59, .538, .574, .6, 1.00, .12, -1.78, .3, 1, 1, 1, 1, .55, .48, .5],
    [4.68, .436, .606, .3, 1.00, .3, -1.85, .4, 1, 1, 1, 1, .52, .45, .5],
    [4.77, .380, .629, .1, .92, .6, -1.9, .6, 1, 1, 1, 1, .5, .43, .5],
    [4.86, .351, .635, 0, .88, .7, -1.9, .68, 1, 1, 1, 1, .5, .42, .5],
    [5.04, .313, .658, 0, .85, .78, -1.92, .72, 1, 1, 1, 1, .5, .42, .5],
    // 05: the letter leaves the send card, crosses the page and slips into the agent's mailbox.
    // It stays right of the agent copy column (which ends near 0.5 of the width) once that copy is on screen.
    [5.30, .313, .658, 0, .85, .78, -1.92, .72, 1, 1, 1, 1, .5, .42, .5],
    [5.55, .660, .520, 0, .72, .55, -1.80, .45, 1, 1, 1, 1, .5, .42, .5],
    [5.85, .720, .440, 0, .62, .40, -1.72, .25, 1, 1, 1, 1, .5, .42, .5],
    [6.20, .720, .360, 0, .42, .30, -1.64, .12, 1, 1, 1, 1, .5, .42, .5],
    [6.42, .730, .350, 0, .03, .30, -1.60, .08, 1, 1, 1, 1, .5, .42, .5],
    [8.00, .700, .350, 0, .03, .30, -1.60, .08, 1, 1, 1, 1, .5, .42, .5],
  ];
  const EUL = new THREE.Euler();
  KF.forEach((k) => { k.q = new THREE.Quaternion().setFromEuler(EUL.set(k[5], k[6], k[7], 'ZXY')); });
  const STILLS = [0, 1.02, 3.26, 5.04, 6.6];
  const ease = (t) => t * t * (3 - 2 * t);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const qTmp = new THREE.Quaternion();
  const NAMES = ['u', 'fx', 'fy', 'z', 's', 'rx', 'ry', 'rz', 'a', 'b', 'c', 'd', 'mfx', 'mfy', 'ms'];
  function poseAt(u) {
    u = clamp(u, 0, KF[KF.length - 1][0]);
    let i = 0; while (i < KF.length - 2 && KF[i + 1][0] < u) i++;
    const A = KF[i], B = KF[i + 1], t = ease(clamp((u - A[0]) / (B[0] - A[0]), 0, 1));
    const P = {}; NAMES.forEach((n, j) => (P[n] = lerp(A[j], B[j], t)));
    P.q = qTmp.copy(A.q).slerp(B.q, t);
    return P;
  }

  /* ---------------- scroll mapping ---------------- */
  let anchors = [];
  function measure() {
    if (!S.on) return;
    const vh = innerHeight, top = (el) => el.getBoundingClientRect().top + scrollY;
    const fw = document.getElementById('fold-wrap'), tw = document.getElementById('tunnel-wrap'), fl = document.getElementById('flight'), aw = document.getElementById('agents-wrap');
    const foldTop = top(fw), tunTop = top(tw), flTop = top(fl), agTop = top(aw), agEnd = agTop + aw.offsetHeight - vh;
    anchors = [
      [0, 0], [foldTop, 1.0], [foldTop + fw.offsetHeight - vh, 1.833], [tunTop, 2.833], [tunTop + tw.offsetHeight - vh, 4.033],
      [flTop, 5.033], [agTop, 6.033], [agEnd, 7.6], [Math.max(agEnd + 1, document.documentElement.scrollHeight - vh), 8.0],
    ];
  }
  function yToU(y) {
    for (let i = 0; i < anchors.length - 1; i++) {
      const [y0, u0] = anchors[i], [y1, u1] = anchors[i + 1];
      if (y <= y1) return u0 + (u1 - u0) * clamp((y - y0) / Math.max(1, y1 - y0), 0, 1);
    }
    return anchors.length ? anchors[anchors.length - 1][1] : 0;
  }
  gsap.registerPlugin(ScrollTrigger);
  const smooth = { y: scrollY };
  ScrollTrigger.create({
    trigger: document.documentElement, start: 0, end: 'max',
    onUpdate: (self) => { const y = self.scroll(); if (S.still) { gsap.killTweensOf(smooth); smooth.y = y; } else gsap.to(smooth, { y, duration: 0.45, ease: 'power3.out', overwrite: true }); },
    onRefresh: measure,
  });
  addEventListener('resize', () => { resize(); measure(); });
  // Dock: the same scroll position that moves the chapter copy. A chapter is current while it spans the viewport's middle line.
  const chipST = ['hero', 'fold-wrap', 'tunnel-wrap', 'flight', 'agents-wrap'].map((id, i) => ScrollTrigger.create({
    trigger: document.getElementById(id), start: 'top 50%', end: 'bottom 50%',
    onToggle: (self) => { if (self.isActive && S.on) MY.setChip(i); },
  }));
  chipST.push(ScrollTrigger.create({ trigger: document.getElementById('yard'), start: 'top 50%', end: 'max', onToggle: (self) => { if (self.isActive && S.on) MY.setChip(-1); } }));
  const syncChip = () => { const i = chipST.findIndex((t) => t.isActive); if (i >= 0) MY.setChip(i === 5 ? -1 : i); };

  /* ---------------- theme wash ---------------- */
  const pick = (k) => ({ display: C[k[0]], accent: C[k[1]], text: C[k[0]], soft: C[k[0]], small: C[k[2]] });
  const mix = (a, b, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
  function washAt(u) {
    if (u < 1.6) { const t = clamp((u - 0.69) / (1.015 - 0.69), 0, 1); return t * t; }
    return 1 - clamp((u - 2.33) / (2.85 - 2.33), 0, 1);
  }
  let lastW = -1;
  const groundEl = document.getElementById('ground');
  function applyWash(w) {
    if (Math.abs(w - lastW) < 0.002) return; lastW = w;
    const cG = pick(['display', 'accent-d', 'small-acc']), cB = pick(['on-band', 'on-band-acc', 'on-band-acc']), ink = C.ink;
    groundEl.style.background = w <= 0 ? '' : mixOk(w);
    if (w <= 0) root.style.removeProperty('--c-ground'); else root.style.setProperty('--c-ground', mixOk(w));
    const set = (k, n) => root.style.setProperty('--c-' + k, w <= 0 ? '' : w < 0.5 ? mix(cG[n], ink, ease(w * 2)) : mix(ink, cB[n], ease(w * 2 - 1)));
    set('display', 'display'); set('accent', 'accent'); set('text', 'text'); set('soft', 'soft'); set('small-accent', 'small');
    root.style.setProperty('--c-rule', w <= 0 ? '' : w < 0.5 ? 'color-mix(in oklab,' + mix(cG.display, ink, ease(w * 2)) + ' 55%,transparent)' : 'color-mix(in oklab,' + mix(ink, cB.display, ease(w * 2 - 1)) + ' 45%,transparent)');
  }
  function clearWash() { ['display', 'accent', 'text', 'soft', 'small-accent', 'rule', 'ground'].forEach((k) => root.style.removeProperty('--c-' + k)); groundEl.style.background = ''; lastW = -1; }
  function toOk(h) { const c = new THREE.Color(h); const r = c.r, g = c.g, b = c.b;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806675274 * g + 0.1073142663 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]; }
  function fromOk([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const c = new THREE.Color(); c.setRGB(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
    return '#' + c.getHexString(); }
  let okG = toOk(C.ground), okB = toOk(C.band);
  const mixOk = (t) => fromOk([0, 1, 2].map((i) => lerp(okG[i], okB[i], t)));

  /* ---------------- steps, mailbox ---------------- */
  const steps = [...document.querySelectorAll('#fold .steps li[data-step]')], stepFill = document.querySelector('#fold .steps .fill');
  const mailbox = document.getElementById('mailbox'), agSteps = [...mailbox.querySelectorAll('.ag-steps li[data-step]')], draftLines = [...mailbox.querySelectorAll('.dl')];
  let agStep = -1;
  function setAgent(u) {
    if (!S.on) { mailbox.dataset.step = '3'; draftLines.forEach((l) => l.style.removeProperty('--o')); return; }
    const st = u < 6.4 ? (u < 6.1 ? 0 : 1) : u < 6.95 ? 2 : 3;
    if (st !== agStep) { agStep = st; mailbox.dataset.step = String(st); agSteps.forEach((li, i) => li.classList.toggle('on', i + 1 === Math.max(1, st))); }
    const dr = S.still ? (st >= 2 ? 1 : 0) : clamp((u - 6.45) / 0.45, 0, 1);
    draftLines.forEach((l, i) => l.style.setProperty('--o', clamp(dr * 3 - i, 0, 1).toFixed(2)));
    mailbox.style.setProperty('--ag-fill', (clamp((u - 6.03) / (7.1 - 6.03), 0, 1) * 100).toFixed(1) + '%');
  }

  /* ---------------- send card + approval drive the plane ---------------- */
  MY.on('tpl', (v) => {
    const pp = PAPERS[v]; drawPrint(pp);
    const target = new THREE.Color(pp.paper);
    if (S.still) back.color.copy(target); else gsap.to(back.color, { r: target.r, g: target.g, b: target.b, duration: 0.5 });
  });
  const thr = { x: 0, y: 0, z: 0, rx: 0, rz: 0 };
  MY.on('send', (done) => {
    const k = 0.6 + MY.card.share / 100;
    gsap.timeline({ onComplete: done })
      .to(thr, { x: 9, y: 3.2 * k, z: -2, rz: 0.35, rx: -0.25, duration: 0.95, ease: 'power2.in' })
      .set(thr, { x: -10, y: -1.5, z: 0, rz: -0.2, rx: 0.15 })
      .to(thr, { x: 0, y: 0, z: 0, rz: 0, rx: 0, duration: 1.4, ease: 'power3.out' });
  });
  const reply = { p: 0 };
  const qReply = new THREE.Quaternion().setFromEuler(new THREE.Euler(.15, -1.25, -.25, 'ZXY'));
  MY.on('approve', (done) => {
    gsap.timeline({ onComplete: () => { reply.p = 0; done(); } })
      .fromTo(reply, { p: 0 }, { p: 1, duration: 1.6, ease: 'power2.in' });
  });

  /* ---------------- frame ---------------- */
  let VW = 1, VH = 1, portrait = false;
  function resize() {
    VW = innerWidth; VH = innerHeight; portrait = VW / VH < 0.85;
    renderer.setSize(VW, VH, false); camera.aspect = VW / VH; camera.updateProjectionMatrix();
  }
  const shadow = document.getElementById('shadow');
  const proj = new THREE.Vector3(), tmpV = new THREE.Vector3();
  const qIdle = new THREE.Quaternion();
  let wasOn = true;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!S.on) {
      if (wasOn) { wasOn = false; clearWash(); setAgent(0); shadow.style.opacity = '0'; tagEls.forEach((el) => (el.style.opacity = '0')); MY.sceneActive = false; }
      return;
    }
    if (!wasOn) { wasOn = true; agStep = -1; }
    MY.sceneActive = true;
    const t = (now - S.t0) / 1000;
    const u = S.debugU != null ? S.debugU : yToU(S.still ? scrollY : smooth.y);
    S.u = u;
    let up = u;
    if (S.still) up = u < 0.85 ? STILLS[0] : u < 2.6 ? STILLS[1] : u < 4.4 ? STILLS[2] : u < 5.9 ? STILLS[3] : STILLS[4];
    const P = poseAt(up);
    foldPaper({ a: P.a, b: P.b, c: P.c, d: P.d });
    let fx = portrait ? P.mfx : P.fx, fy = portrait ? P.mfy : P.fy, sc = (portrait ? P.ms : 1) * P.s, z = P.z;
    if (u > 5.3) {
      fx = P.fx; fy = P.fy; sc = P.s * (portrait ? 0.62 : 1);
      // portrait: the copy column is wider, so the plane keeps to the card's column
      if (portrait) { const k = clamp((u - 5.3) / 0.25, 0, 1); fx = lerp(P.fx, 0.8, k); fy = lerp(P.fy, Math.min(P.fy, 0.4), k); }
    }
    // approval: the reply leaves the mailbox, up and out to the right
    if (reply.p > 0) { const r = reply.p; fx = lerp(0.7, 1.25, r); fy = lerp(0.36, -0.1, r * r); sc = clamp(r / 0.15, 0, 1) * 0.6; }
    const D = CAMZ - z, hh = 2 * D * TAN, ww = hh * camera.aspect;
    const idle = S.still ? 0 : 1 - clamp(u / 0.35, 0, 1);
    const restLift = u > 4.6 && u < 5.7 ? (MY.card.share - 45) / 100 * 0.35 : 0;
    plane.position.set((fx - 0.5) * ww + thr.x, (0.5 - fy) * hh + Math.sin(t * 1.75) * 0.05 * idle + restLift + thr.y, z + thr.z);
    plane.scale.setScalar(1.18 * sc);
    plane.visible = sc > 0.04;
    // behind the mailbox card at reduced opacity
    const pOp = reply.p > 0 ? 1 : 1 - 0.55 * clamp((u - 5.9) / 0.3, 0, 1);
    front.opacity = back.opacity = pOp;
    qIdle.setFromEuler(EUL.set(Math.sin(t * 0.87) * 0.05 * idle + thr.rx, Math.sin(t * 0.87 + 1.2) * 0.09 * idle, thr.rz, 'ZXY'));
    if (reply.p > 0) plane.quaternion.copy(qReply); else plane.quaternion.copy(P.q).premultiply(qIdle);
    proj.copy(plane.position).project(camera);
    const sx = (proj.x * 0.5 + 0.5) * VW + 0.158 * VH * (portrait ? 0.5 : 1), sy = (-proj.y * 0.5 + 0.5) * VH + 0.38 * VH * (portrait ? 0.5 : 1);
    shadow.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
    shadow.style.opacity = (1 - clamp((u - 1.6) / 0.7, 0, 1)).toFixed(3);
    applyWash(S.still ? (u < 0.95 ? 0 : u < 2.6 ? 1 : 0) : washAt(u));
    const st = up < 1.55 ? 0 : up < 2.0 ? 1 : 2;
    steps.forEach((li, i) => li.classList.toggle('on', i === st));
    stepFill.style.width = (clamp((up - 1.0) / (2.35 - 1.0), 0, 1) * 100).toFixed(2) + '%';
    setAgent(u);
    const rIn = clamp((u - 2.33) / 0.42, 0, 1), rOut = (1 - 0.8 * clamp((u - 4.3) / 0.6, 0, 1)) * (1 - clamp((u - 5.6) / 0.5, 0, 1));
    const rOp = S.still ? (u > 2.6 ? (u > 5.9 ? 0 : u > 4.4 ? 0.2 : 1) : 0) : rIn * rOut;
    const travel = S.still ? 16 : clamp((u - 2.3) / (4.4 - 2.3), 0, 1) * 32 + clamp(u - 4.4, 0, 3) * 4;
    route.visible = rOp > 0.003 && !S.noRoute;
    rings.forEach((r, i) => {
      const Dd = 7.5 + i * RING_GAP - travel;
      axisAt(Dd, r.position);
      r.lookAt(tmpV.set(AX, AY, -1).add(r.position));
      const near = clamp((Dd - 0.4) / 1.2, 0, 1), farF = 1 - clamp((Dd - 38) / 18, 0, 1);
      r.visible = Dd > 0.35 && route.visible;
      r.material.opacity = rOp * near * farF;
    });
    rails.forEach((m) => (m.material.opacity = rOp * 0.9));
    const keep = keepOut();
    tagEls.forEach((el, i) => {
      const r = rings[i], Dd = 7.5 + i * RING_GAP - travel;
      const vis = route.visible && u > 2.5 && u < 4.6 && Dd > 1.6 && Dd < 24;
      if (!vis) { el.style.opacity = '0'; return; }
      const a = TAG_ANG[i]; tmpV.set(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0).applyQuaternion(r.quaternion).add(r.position).project(camera);
      const x = (tmpV.x * 0.5 + 0.5) * VW, y = (-tmpV.y * 0.5 + 0.5) * VH;
      const o = rOp * clamp((Dd - 1.6) / 1.5, 0, 1) * (1 - clamp((Dd - 16) / 8, 0, 1)) * clamp((4.5 - u) / 0.2, 0, 1);
      const hw = tagW[i] * 0.5 * clamp(9 / Dd, 0.75, 1.25) + 14, hh2 = 13 * clamp(9 / Dd, 0.75, 1.25) + 14;
      const hit = keep.some((r) => x + hw > r.left && x - hw < r.right && y + hh2 > r.top && y - hh2 < r.bottom);
      tagK[i] = hit ? 0 : Math.min(1, tagK[i] + 0.08);
      el.style.opacity = (o * tagK[i]).toFixed(3);
      el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%) scale(' + clamp(9 / Dd, 0.75, 1.25).toFixed(3) + ')';
    });
    renderer.render(scene, camera);
  }

  /* ---------------- boot ---------------- */
  resize(); measure();
  Promise.all([document.fonts.load('600 96px "Funnel Display"'), document.fonts.load('500 30px "Funnel Sans"')]).catch(() => {}).then(() => {
    drawPrint(PAPERS[MY.card.tpl]); back.color.set(PAPERS[MY.card.tpl].paper);
    ScrollTrigger.refresh(); measure(); syncChip();
    requestAnimationFrame((n) => { frame(n); requestAnimationFrame(() => root.classList.add('ready')); });
  });
  // Test hook for renders: window.__mailyard.setU(u) pins the choreography at u.
  geo.computeBoundingBox();
  function planeRect() {
    if (!plane.visible) return null;
    const bb = geo.boundingBox, v = new THREE.Vector3(); let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    foldFrame.updateWorldMatrix(true, false);
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(foldFrame.matrixWorld).project(camera);
      const x = (v.x * 0.5 + 0.5) * VW, y = (-v.y * 0.5 + 0.5) * VH; l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
    }
    return { left: l, top: t, right: r, bottom: b, opacity: front.opacity };
  }
  window.__mailyard = { setU: (u) => { S.debugU = u; }, state: S, anchors: () => anchors, route, planeRect };
})();

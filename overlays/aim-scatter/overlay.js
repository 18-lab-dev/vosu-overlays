// Copyright (c) 2026 18-LAB. MIT.
// Aim scatter: every osu! circle / slider-head hit as a dot at the cursor's offset from the
// object's centre (vosu `play.hitOffsets`, ENABLE_HIT_OFFSETS), coloured by timing error, with a
// running centroid, 1σ covariance ellipse, aim bias and on-centre share for the whole attempt.
// The page is the overlay's own box: hosts place and size it, and the layout re-flows to it
// (vertical column or horizontal strip, from the box's aspect or the `orientation` setting).
import { subscribe, settings, activeMode, mapPalette, applyPalette } from './vosu-overlay.js';

// Reference boxes the type scale is derived from (the default resolution is the vertical one).
const REF_V = { w: 280, h: 340 };
const REF_H = { w: 560, h: 124 };
const RING_RATIO = 104 / 288;     // hit-circle radius / target diameter
const CENTRE = 1 / 3;             // "on centre" = within R/3
const RECENT = 40;                // newest hits drawn bright on the live layer
const BUCKETS = 41;               // timing colour steps across ±great
const PLAYING = 2;
const RESULTS = 7;
const FALLBACK_RADIUS = 54.4 - 4.48 * 4;
const AMBER = '#ff963f';

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  offsets: '/play/hitOffsets',
  csConverted: '/beatmap/stats/cs/converted',
  csOriginal: '/beatmap/stats/cs/original',
  great: '/beatmap/stats/hitWindow/great',
  checksum: '/beatmap/checksum',
};

const $ = id => document.getElementById(id);
const aim = $('aim');
const readouts = $('readouts');
const canvases = { reticle: $('reticle'), trail: $('trail'), live: $('live') };
const ctx = {
  reticle: canvases.reticle.getContext('2d', { alpha: true }),
  trail: canvases.trail.getContext('2d', { alpha: true }),
  live: canvases.live.getContext('2d', { alpha: true }),
};
const el = {
  status: $('status'), statusText: $('status-text'),
  window: $('window'), bias: $('bias'), biasArrow: $('bias-arrow'), biasDir: $('bias-dir'),
  centre: $('centre'), centreSub: $('centre-sub'), spread: $('spread'), spreadSub: $('spread-sub'),
};

// ------------------------------------------------------------------ tokens & colour ramp
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const rgb = hex => { const v = parseInt(hex.replace('#', ''), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
const C = {
  early: rgb(token('--signal', '#7fa6cf')),
  mid: rgb(token('--fg', '#ebe8e1')),
  late: rgb(token('--accent', AMBER)),
  fg: rgb(token('--fg', '#ebe8e1')),
};
const mix = (a, b, t) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)} ${Math.round(a[1] + (b[1] - a[1]) * t)} ${Math.round(a[2] + (b[2] - a[2]) * t)})`;
// Early/late colours are fixed (they carry meaning). Steeper near zero (|t|^0.6) so a few ms
// early or late already reads as blue or amber.
const RAMP = Array.from({ length: BUCKETS }, (_, i) => {
  const t = i / (BUCKETS - 1) * 2 - 1;            // -1 early … +1 late
  const k = Math.abs(t) ** 0.6;
  return t < 0 ? mix(C.mid, C.early, k) : mix(C.mid, C.late, k);
});
const fgA = alpha => `rgb(${C.fg[0]} ${C.fg[1]} ${C.fg[2]} / ${alpha})`;
// Highlight (centroid, ellipse, bias) follows the map's tonal-spot accent, else 18-LAB amber.
let hl = AMBER;
let hlFill = 'rgb(255 150 63 / .08)';

// ------------------------------------------------------------------ target geometry (CSS px)
let VIEW = 220;                   // target diameter
let HALF = VIEW / 2;
let RING = VIEW * RING_RATIO;     // hit-circle radius on screen
let EDGE = HALF - 4;              // off-target hits pin to this radius
let DOT = 2.2;                    // dot radius
let K = VIEW / 288;               // detail scale (ticks, marks) relative to the 288 px design

function setDiameter(d) {
  VIEW = d; HALF = d / 2; RING = d * RING_RATIO; K = d / 288;
  EDGE = HALF - Math.max(2, 6 * K);
  DOT = Math.max(1.3, Math.min(2.8, d / 105));
}

// ------------------------------------------------------------------ attempt store (grows by doubling)
let cap = 2048;
let xs = new Float32Array(cap);
let ys = new Float32Array(cap);
let errs = new Float32Array(cap);
let bucket = new Uint8Array(cap);
let n = 0;
// Welford running moments of (x, y) and the on-centre count.
let mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0, inside = 0;
let radius = null;                // latched hit-circle radius (playfield px) for the held attempt
let cs = null;
let great = null;                 // latched ±great window (ms) for the colour scale

function grow() {
  cap *= 2;
  const nx = new Float32Array(cap); nx.set(xs); xs = nx;
  const ny = new Float32Array(cap); ny.set(ys); ys = ny;
  const ne = new Float32Array(cap); ne.set(errs); errs = ne;
  const nb = new Uint8Array(cap); nb.set(bucket); bucket = nb;
}

function bucketOf(error) {
  const t = Math.max(-1, Math.min(1, error / (great > 0 ? great : 50)));
  return Math.round((t + 1) / 2 * (BUCKETS - 1));
}

function resetAttempt() {
  n = 0; mx = my = sxx = syy = sxy = 0; inside = 0; baked = 0;
  dirty.trail = dirty.live = dirty.dom = true;
}

function push(x, y, error) {
  if (n === cap) grow();
  xs[n] = x; ys[n] = y; errs[n] = error; bucket[n] = bucketOf(error);
  n++;
  const dx = x - mx; mx += dx / n;
  const dy = y - my; my += dy / n;
  sxx += dx * (x - mx); syy += dy * (y - my); sxy += dx * (y - my);
  const r = (radius ?? FALLBACK_RADIUS) * CENTRE;
  if (x * x + y * y <= r * r) inside++;
}

function recount() {
  const r = (radius ?? FALLBACK_RADIUS) * CENTRE;
  inside = 0;
  for (let i = 0; i < n; i++) if (xs[i] * xs[i] + ys[i] * ys[i] <= r * r) inside++;
}

function rebucket() {
  for (let i = 0; i < n; i++) bucket[i] = bucketOf(errs[i]);
}

// ------------------------------------------------------------------ state
const options = { orientation: 'auto', align: 'center', dots: 'All hits', ellipse: true, results: true, backing: 'none', accent: 'map' };
let limit = Infinity;             // dots kept on the target; Infinity = all hits
let status = 'connecting';
let state;                        // /state/number
let mode = null;
let extension = 'unknown';        // 'on' | 'off' | 'unknown'
let prevState;
let checksum = null;
let view = '';
let small = false;                // half-size box (multiplayer cell): shorter labels
let baked = 0;                    // all-hits mode: dots already rasterised on the trail layer
let drawnN = -1;
const dirty = { size: true, reticle: true, trail: true, live: true, dom: true };
let raf = 0;
let pixel = 1;                    // device px per CSS px of the target canvas
let atlas = null;                 // pre-rendered dot sprites, one per colour bucket
let cell = 0;

function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

function onData(values, changed) {
  state = values[P.state];
  const playing = state === PLAYING;
  const nextMode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  if (nextMode !== mode) { mode = nextMode; dirty.dom = true; }

  // A new attempt starts whenever play is (re)entered; results hold the last one.
  if (playing && prevState !== PLAYING) resetAttempt();
  if (state !== prevState) dirty.dom = true;
  prevState = state;

  // Latch circle size and timing window while playing, or while nothing is held yet.
  if (playing || n === 0) {
    const nextCs = values[P.csConverted] ?? values[P.csOriginal];
    const csNumber = typeof nextCs === 'number' && Number.isFinite(nextCs) ? nextCs : null;
    if (csNumber !== cs) {
      cs = csNumber;
      radius = cs === null ? null : Math.max(1, 54.4 - 4.48 * cs);
      recount();
      dirty.reticle = dirty.trail = dirty.live = dirty.dom = true;
    }
    const nextGreat = values[P.great];
    const g = typeof nextGreat === 'number' && nextGreat > 0 ? nextGreat : null;
    if (g !== great) { great = g; rebucket(); dirty.trail = dirty.live = dirty.dom = true; }
    const sum = values[P.checksum] || null;
    if (sum !== checksum) { checksum = sum; loadPalette(); }
  }

  const offsets = values[P.offsets];
  const nextExtension = Array.isArray(offsets) ? 'on' : state === undefined ? 'unknown' : 'off';
  if (nextExtension !== extension) { extension = nextExtension; dirty.dom = true; }

  if (changed.has(P.offsets) && Array.isArray(offsets)) {
    const count = Math.floor(offsets.length / 3);
    if (count < n && playing) resetAttempt();      // retry: the attempt's array restarted
    if (count > n) {
      for (let i = n * 3, end = count * 3; i < end; i += 3) {
        const x = offsets[i], y = offsets[i + 1], e = offsets[i + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(e)) push(x, y, e);
      }
      dirty.live = dirty.dom = true;
    }
  }
  schedule();
}

function onStatus(next) {
  if (next === status) return;
  status = next;
  dirty.dom = true;
  schedule();
}

// ------------------------------------------------------------------ map tint (off the hot path)
function loadPalette() {
  const wanted = checksum;
  if (options.accent !== 'map' || !wanted) { setPalette(null); return; }
  mapPalette(wanted).then(result => { if (wanted === checksum && options.accent === 'map') setPalette(result); });
}

function setPalette(palette) {
  applyPalette(aim, palette);
  hl = palette?.accent || AMBER;
  const [r, g, b] = rgb(hl);
  hlFill = `rgb(${r} ${g} ${b} / .08)`;
  dirty.live = true;
  schedule();
}

// ------------------------------------------------------------------ box layout (resize / settings only)
/**
 * Re-flows to the page box: vertical column (status, target, legend, readouts) for upright boxes,
 * horizontal strip (target beside the text) for wide ones. Type scales with the box against the
 * reference size, labels floored so they stay legible in half-size multiplayer cells; the target
 * takes the space the text leaves. Pure arithmetic (no layout reads), so it gives the same answer
 * whichever view is showing.
 */
function layoutBox() {
  const w = innerWidth || REF_V.w;
  const h = innerHeight || REF_V.h;
  const orient = options.orientation === 'vertical' || options.orientation === 'horizontal'
    ? options.orientation : (h / w >= 0.75 ? 'vertical' : 'horizontal');
  const ref = orient === 'vertical' ? REF_V : REF_H;
  const s = Math.max(0.45, Math.min(3, Math.min(w / ref.w, h / ref.h)));
  const t = Math.max(0.8, s);
  if (aim.dataset.orient !== orient) aim.dataset.orient = orient;
  aim.style.setProperty('--s', s.toFixed(3));
  aim.style.setProperty('--t', t.toFixed(3));
  small = s < 0.8;
  aim.classList.toggle('is-small', small);
  dirty.dom = true;
  const pad = 6 * s;
  let d;
  if (orient === 'vertical') {
    // Text rows at this scale (line boxes from style.css): head, legend, readouts (rule, label,
    // number, sub line), plus the row gaps; the rest goes to the target.
    const sub = s < 0.8 ? 0 : 16 * t;
    const text = 14.4 * t + 12 * t + (11 * s + 14.4 * t + 30 * s + 2 + sub) + 4 * 6 * s + 4;
    d = Math.min(w - 2 * pad, h - 2 * pad - text);
  } else {
    d = Math.min(h - 2 * pad, w * 0.42);
  }
  d = Math.max(48, Math.floor(d));
  aim.style.setProperty('--d', `${d}px`);
  if (d !== VIEW) { setDiameter(d); dirty.size = true; }
  const next = devicePixelRatio || 1;
  if (Math.abs(next - pixel) > 1e-3) dirty.size = true;
  pixel = next;
  schedule();
}

function resize() {
  const side = Math.max(1, Math.round(VIEW * (devicePixelRatio || 1)));
  for (const canvas of Object.values(canvases)) { canvas.width = side; canvas.height = side; }
  pixel = side / VIEW;
  // Dot sprites: one filled disc per colour bucket, rasterised at the device scale.
  const r = DOT * pixel;
  cell = Math.ceil(r * 2 + 2);
  atlas = document.createElement('canvas');
  atlas.width = cell * BUCKETS;
  atlas.height = cell;
  const a = atlas.getContext('2d');
  for (let b = 0; b < BUCKETS; b++) {
    a.fillStyle = RAMP[b];
    a.beginPath();
    a.arc(b * cell + cell / 2, cell / 2, r, 0, Math.PI * 2);
    a.fill();
  }
  dirty.size = false;
  dirty.reticle = dirty.trail = dirty.live = true;
}

// ------------------------------------------------------------------ drawing
const scale = () => RING / (radius ?? FALLBACK_RADIUS);
const crisp = v => (Math.round(v * pixel) + 0.5) / pixel;

function drawReticle() {
  const c = ctx.reticle;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvases.reticle.width, canvases.reticle.height);
  c.setTransform(pixel, 0, 0, pixel, 0, 0);
  const hair = 1 / pixel;
  const mid = crisp(HALF);
  const full = VIEW >= 180;

  // Lens: a dark disc that fades out past the bezel, so dots and hairlines read over any map
  // background without a box. The panel backing brings its own surface.
  if (options.backing !== 'panel') {
    const lens = c.createRadialGradient(HALF, HALF, RING * 0.2, HALF, HALF, HALF);
    lens.addColorStop(0, 'rgb(8 9 10 / .62)');
    lens.addColorStop(RING / HALF, 'rgb(8 9 10 / .5)');
    lens.addColorStop(1, 'rgb(8 9 10 / 0)');
    c.fillStyle = lens;
    c.fillRect(0, 0, VIEW, VIEW);
  }

  c.lineWidth = hair;
  c.strokeStyle = fgA(0.12);
  c.beginPath();
  c.moveTo(HALF - RING - 18 * K, mid); c.lineTo(HALF + RING + 18 * K, mid);
  c.moveTo(mid, HALF - RING - 18 * K); c.lineTo(mid, HALF + RING + 18 * K);
  c.stroke();

  // Ruler ticks every 10 playfield px along both axes, inside the circle (large targets only).
  const s = scale();
  if (full) {
    c.strokeStyle = fgA(0.26);
    c.beginPath();
    for (let d = 10; d * s < RING - 2; d += 10) {
      for (const sign of [-1, 1]) {
        const p = crisp(HALF + sign * d * s);
        c.moveTo(p, mid - 3); c.lineTo(p, mid + 3);
        c.moveTo(mid - 3, p); c.lineTo(mid + 3, p);
      }
    }
    c.stroke();
  }

  // Centre zone (R/3), dashed.
  c.setLineDash([2, 3]);
  c.strokeStyle = fgA(0.34);
  c.beginPath(); c.arc(HALF, HALF, RING * CENTRE, 0, Math.PI * 2); c.stroke();
  c.setLineDash([]);

  // The hit circle.
  c.lineWidth = full ? 1.5 : 1.25;
  c.strokeStyle = fgA(0.72);
  c.beginPath(); c.arc(HALF, HALF, RING, 0, Math.PI * 2); c.stroke();

  // Bezel: 10° ticks, 30° majors, cardinal points brightest (30° only on small targets).
  c.lineWidth = hair * Math.max(1, Math.round(pixel * 0.9));
  for (let deg = 0; deg < 360; deg += full ? 10 : 30) {
    const major = deg % 30 === 0;
    const cardinal = deg % 90 === 0;
    const a = deg * Math.PI / 180;
    const r0 = RING + 5 * K + 1;
    const r1 = RING + (cardinal ? 14 : major ? 10 : 7) * K + 1;
    c.strokeStyle = fgA(cardinal ? 0.7 : major ? 0.42 : 0.22);
    c.beginPath();
    c.moveTo(HALF + Math.cos(a) * r0, HALF + Math.sin(a) * r0);
    c.lineTo(HALF + Math.cos(a) * r1, HALF + Math.sin(a) * r1);
    c.stroke();
  }
}

function sprite(c, i, alpha) {
  const s = scale();
  let x = xs[i] * s, y = ys[i] * s;
  const d = x * x + y * y;
  if (d > EDGE * EDGE) { const f = EDGE / Math.sqrt(d); x *= f; y *= f; }
  c.globalAlpha = alpha;
  c.drawImage(atlas, bucket[i] * cell, 0, cell, cell, (HALF + x) * pixel - cell / 2, (HALF + y) * pixel - cell / 2, cell, cell);
}

function drawTrail() {
  const c = ctx.trail;
  const recent = Math.min(RECENT, limit);
  const end = Math.max(0, n - recent);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (limit === Infinity) {
    // All hits: rasterise each dot once as it leaves the recent window; the layer accumulates.
    if (dirty.trail || end < baked) { c.clearRect(0, 0, canvases.trail.width, canvases.trail.height); baked = 0; }
    for (let i = baked; i < end; i++) sprite(c, i, 0.26);
    baked = end;
  } else if (dirty.trail || n !== drawnN) {
    c.clearRect(0, 0, canvases.trail.width, canvases.trail.height);
    const start = Math.max(0, n - limit);
    const span = Math.max(1, end - start);
    for (let i = start; i < end; i++) sprite(c, i, 0.12 + 0.3 * (i - start) / span);
  }
  c.globalAlpha = 1;
  drawnN = n;
  dirty.trail = false;
}

function drawLive() {
  const c = ctx.live;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvases.live.width, canvases.live.height);
  dirty.live = false;
  if (!n) return;
  const recent = Math.min(RECENT, limit, n);
  for (let i = n - recent; i < n; i++) sprite(c, i, 1 - 0.55 * (n - 1 - i) / recent);
  c.globalAlpha = 1;
  c.setTransform(pixel, 0, 0, pixel, 0, 0);
  const s = scale();

  // Newest hit: a ring in its own timing colour.
  let lx = xs[n - 1] * s, ly = ys[n - 1] * s;
  const ld = Math.hypot(lx, ly);
  if (ld > EDGE) { lx *= EDGE / ld; ly *= EDGE / ld; }
  c.lineWidth = 1.25;
  c.strokeStyle = RAMP[bucket[n - 1]];
  c.beginPath(); c.arc(HALF + lx, HALF + ly, DOT + 2.5, 0, Math.PI * 2); c.stroke();

  const cx = HALF + mx * s, cy = HALF + my * s;
  if (options.ellipse && n >= 3) {
    const a = sxx / n, b = sxy / n, d = syy / n;
    const half = (a + d) / 2;
    const root = Math.sqrt(((a - d) / 2) ** 2 + b * b);
    const major = Math.sqrt(Math.max(0, half + root)) * s;
    const minor = Math.sqrt(Math.max(0, half - root)) * s;
    const angle = 0.5 * Math.atan2(2 * b, a - d);
    c.beginPath();
    c.ellipse(cx, cy, Math.max(major, 0.5), Math.max(minor, 0.5), angle, 0, Math.PI * 2);
    c.fillStyle = hlFill;
    c.fill();
    c.lineWidth = 3; c.strokeStyle = 'rgb(8 9 10 / .6)'; c.stroke();
    c.lineWidth = 1.5; c.strokeStyle = hl; c.stroke();
  }

  // Bias vector from the circle's centre to the centroid, then the centroid mark.
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(HALF, HALF); c.lineTo(cx, cy);
  c.lineWidth = 3; c.strokeStyle = 'rgb(8 9 10 / .7)'; c.stroke();
  c.lineWidth = 1.25; c.strokeStyle = hl; c.stroke();
  const arm = Math.max(4.5, 6 * K), gap = Math.max(1.8, 2.5 * K);
  c.beginPath();
  c.moveTo(cx - arm, cy); c.lineTo(cx - gap, cy); c.moveTo(cx + gap, cy); c.lineTo(cx + arm, cy);
  c.moveTo(cx, cy - arm); c.lineTo(cx, cy - gap); c.moveTo(cx, cy + gap); c.lineTo(cx, cy + arm);
  c.lineWidth = 3.5; c.strokeStyle = 'rgb(8 9 10 / .8)'; c.stroke();
  c.lineWidth = 1.5; c.strokeStyle = hl; c.stroke();
  c.beginPath(); c.arc(cx, cy, Math.max(1.1, 1.6 * K), 0, Math.PI * 2); c.fillStyle = hl; c.fill();
  c.lineCap = 'butt';
}

// ------------------------------------------------------------------ DOM (write only on change)
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const shown = (node, visible) => { if (node.hasAttribute('hidden') === visible) node.toggleAttribute('hidden', !visible); };
const DIRECTIONS = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
const px = v => v.toFixed(1);
let arrowDeg = null;
// The circle the target is scaled to: converted CS and its radius in playfield px.
const circle = (withRadius = true) => cs === null ? 'CS —' : withRadius ? `CS ${cs.toFixed(1)} · R ${px(radius)} px` : `CS ${cs.toFixed(1)}`;

/**
 * What the box shows: `data` during osu! play; `summary` (readouts only, at the box's foot) on
 * results with a held attempt, so the target never covers the results screen's buttons;
 * `notice` when vosu runs without ENABLE_HIT_OFFSETS; `chip` for connection / no game; else
 * `none` (other rulesets, song select, menus: nothing to add there).
 */
function viewFor() {
  if (status !== 'live') return 'chip';
  if (state === undefined) return 'chip';
  if (mode !== 'osu') return 'none';
  if (state === PLAYING) return extension === 'off' ? 'notice' : 'data';
  if (state === RESULTS && options.results && n > 0) return 'summary';
  return 'none';
}

function updateDom() {
  dirty.dom = false;
  const next = viewFor();
  if (next !== view) { view = next; aim.dataset.view = view; }

  let tone = 'idle', label;
  if (status === 'connecting') { tone = 'busy'; label = 'Connecting'; }
  else if (status === 'offline') { tone = 'error'; label = 'vosu offline'; }
  else if (state === undefined) label = 'No game';
  else if (state === PLAYING) { tone = 'live'; label = extension === 'off' ? 'Playing' : circle(!small); }
  else label = `Results · ${circle(false)}`;
  if (el.status.dataset.tone !== tone) el.status.dataset.tone = tone;
  text(el.statusText, label);
  if (view !== 'data' && view !== 'summary') return;

  text(el.window, great === null ? '± — ms' : `±${Math.round(great * 10) / 10} ms`);

  const have = n > 0;
  readouts.classList.toggle('is-empty', !have);
  const bias = Math.hypot(mx, my);
  text(el.bias, have ? px(bias) : '—');
  if (have && bias >= 0.05) {
    const angle = Math.atan2(my, mx);
    const deg = Math.round(angle * 180 / Math.PI);
    if (deg !== arrowDeg) { arrowDeg = deg; el.biasArrow.style.transform = `rotate(${deg}deg)`; }
    shown(el.biasArrow, true);
    text(el.biasDir, DIRECTIONS[(Math.round(angle / (Math.PI / 4)) + 8) % 8]);
  } else {
    shown(el.biasArrow, false);
    text(el.biasDir, have ? 'centred' : '');
  }
  text(el.centre, have ? String(Math.round(inside / n * 100)) : '—');
  text(el.centreSub, have ? `${inside} of ${n}` : '');
  if (have && n >= 2) {
    const a = sxx / n, b = sxy / n, d = syy / n;
    const half = (a + d) / 2;
    const root = Math.sqrt(((a - d) / 2) ** 2 + b * b);
    text(el.spread, px(Math.sqrt(Math.max(0, a + d))));
    text(el.spreadSub, `${px(Math.sqrt(Math.max(0, half + root)))} × ${px(Math.sqrt(Math.max(0, half - root)))}`);
  } else {
    text(el.spread, '—');
    text(el.spreadSub, '');
  }
}

function frame() {
  raf = 0;
  if (dirty.size) resize();
  if (dirty.reticle) { drawReticle(); dirty.reticle = false; }
  drawTrail();
  if (dirty.live) drawLive();
  if (dirty.dom) updateDom();
}

// ------------------------------------------------------------------ settings & boot
const BACKINGS = new Set(['none', 'scrim', 'panel']);
const ALIGNS = new Set(['left', 'center', 'right']);

settings(options, next => {
  const backing = BACKINGS.has(next.backing) ? next.backing : 'none';
  const backingChanged = backing !== options.backing;
  const accentChanged = next.accent !== options.accent;
  Object.assign(options, next, { backing, align: ALIGNS.has(next.align) ? next.align : 'center' });
  const match = /(\d+)/.exec(options.dots);
  const nextLimit = /all/i.test(options.dots) || !match ? Infinity : Math.max(1, Number(match[1]));
  if (nextLimit !== limit) { limit = nextLimit; dirty.trail = true; }
  if (aim.dataset.backing !== backing) aim.dataset.backing = backing;
  if (aim.dataset.align !== options.align) aim.dataset.align = options.align;
  if (backingChanged) dirty.reticle = true;
  if (accentChanged) loadPalette();
  dirty.live = dirty.dom = true;
  layoutBox();
});

new ResizeObserver(layoutBox).observe(document.documentElement);
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', layoutBox);
document.fonts?.ready.then(layoutBox);
subscribe(Object.values(P), onData, { onStatus });
schedule();

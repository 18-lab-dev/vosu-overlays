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
// Reticle strokes: fixed foreground tints and dash patterns, built once.
const FG = { hair: fgA(0.12), tick: fgA(0.26), zone: fgA(0.34), ring: fgA(0.72), cardinal: fgA(0.7), major: fgA(0.42), minor: fgA(0.22) };
const DASH = [2, 3];
const SOLID = [];
const TAU = Math.PI * 2;
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
let unit = RING / FALLBACK_RADIUS; // screen px per playfield px: RING over the latched radius
// Mark sizes that change with the diameter only (newest-hit ring, centroid cross and pip).
let ringR = DOT + 2.5;
let arm = Math.max(4.5, 6 * K), gap = Math.max(1.8, 2.5 * K), pip = Math.max(1.1, 1.6 * K);

function setDiameter(d) {
  VIEW = d; HALF = d / 2; RING = d * RING_RATIO; K = d / 288;
  EDGE = HALF - Math.max(2, 6 * K);
  DOT = Math.max(1.3, Math.min(2.8, d / 105));
  ringR = DOT + 2.5;
  arm = Math.max(4.5, 6 * K); gap = Math.max(1.8, 2.5 * K); pip = Math.max(1.1, 1.6 * K);
  rescale();
}

function rescale() {
  const r = (radius ?? FALLBACK_RADIUS) * CENTRE;
  inner2 = r * r;
  unit = RING / (radius ?? FALLBACK_RADIUS);
  dirty.place = true;
}

// ------------------------------------------------------------------ attempt store (grows by doubling)
// The whole attempt stays in typed arrays sized once (doubling past 2048 hits): "All hits"
// re-rasterises every dot after a resize, and a CS or window change recounts and recolours them.
let cap = 2048;
let xs = new Float32Array(cap);
let ys = new Float32Array(cap);
let errs = new Float32Array(cap);
let bucket = new Uint8Array(cap);
let n = 0;
// Running statistics in plain object fields, seeded with null so V8 keeps them tagged: per-hit
// code runs about ten times a second, so it stays in V8's baseline tier for a long time, where
// every double it computes is already a heap number. Tagged fields store and hand those on as
// they are; a Float64Array would box each read again.
// Welford moments of (x, y), then what derive() takes from them once per hit: bias length,
// 1σ spread, the covariance ellipse's semi-axes and tilt (playfield px, radians).
const S = { mx: null, my: null, sxx: null, syy: null, sxy: null, bias: null, spread: null, major: null, minor: null, tilt: null };
S.mx = S.my = S.sxx = S.syy = S.sxy = S.bias = S.spread = S.major = S.minor = S.tilt = 0;
let inside = 0;                   // hits within the centre zone, R/3
let inner2 = (FALLBACK_RADIUS * CENTRE) * (FALLBACK_RADIUS * CENTRE);   // its radius², playfield px
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
  n = 0; S.mx = S.my = S.sxx = S.syy = S.sxy = 0; inside = 0; baked = 0;
  dirty.trail = dirty.live = dirty.dom = true;
}

/** Appends the hit at `offsets[i…i+2]` (x, y, timing error), read in place from vosu's array. */
function push(offsets, i) {
  const x = offsets[i], y = offsets[i + 1], e = offsets[i + 2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(e)) return;
  if (n === cap) grow();
  xs[n] = x; ys[n] = y; errs[n] = e; bucket[n] = bucketOf(e);
  place(n);
  n++;
  const dx = x - S.mx; S.mx += dx / n;
  const dy = y - S.my; S.my += dy / n;
  S.sxx += dx * (x - S.mx); S.syy += dy * (y - S.my); S.sxy += dx * (y - S.my);
  if (x * x + y * y <= inner2) inside++;
}

/** Bias, spread and ellipse from the moments: once per batch of new hits, for canvas and text. */
function derive() {
  S.bias = Math.hypot(S.mx, S.my);
  if (n < 2) return;
  const a = S.sxx / n, b = S.sxy / n, d = S.syy / n;
  const half = (a + d) / 2;
  const root = Math.sqrt(((a - d) / 2) ** 2 + b * b);
  S.spread = Math.sqrt(Math.max(0, a + d));
  S.major = Math.sqrt(Math.max(0, half + root));
  S.minor = Math.sqrt(Math.max(0, half - root));
  S.tilt = 0.5 * Math.atan2(2 * b, a - d);
}

function recount() {
  inside = 0;
  for (let i = 0; i < n; i++) if (xs[i] * xs[i] + ys[i] * ys[i] <= inner2) inside++;
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
const dirty = { size: true, reticle: true, trail: true, live: true, dom: true, place: true };
let raf = 0;
let pixel = 1;                    // device px per CSS px of the target canvas
let atlas = null;                 // pre-rendered dot sprites, one per colour bucket
let cell = 0;
let lens = null;                  // reticle lens gradient, rebuilt with the canvas size
// Status and legend strings, rebuilt only when CS or the timing window changes.
let csShort = 'CS —', csFull = 'CS —', resultsLabel = 'Results · CS —', windowLabel = '± — ms';

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
      rescale();
      recount();
      relabel();
      dirty.reticle = dirty.trail = dirty.live = dirty.dom = true;
    }
    const nextGreat = values[P.great];
    const g = typeof nextGreat === 'number' && nextGreat > 0 ? nextGreat : null;
    if (g !== great) {
      great = g;
      windowLabel = great === null ? '± — ms' : `±${Math.round(great * 10) / 10} ms`;
      rebucket();
      dirty.trail = dirty.live = dirty.dom = true;
    }
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
      for (let i = n * 3, end = count * 3; i < end; i += 3) push(offsets, i);
      derive();
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
  // The lens depends on the target's size only.
  lens = ctx.reticle.createRadialGradient(HALF, HALF, RING * 0.2, HALF, HALF, HALF);
  lens.addColorStop(0, 'rgb(8 9 10 / .62)');
  lens.addColorStop(RING / HALF, 'rgb(8 9 10 / .5)');
  lens.addColorStop(1, 'rgb(8 9 10 / 0)');
  dirty.size = false;
  dirty.place = dirty.reticle = dirty.trail = dirty.live = true;
}

// ------------------------------------------------------------------ drawing
// Dot sprite origins (device px) and fade alphas live in plain arrays of numbers on purpose: a
// stored number reaches drawImage / globalAlpha as the same boxed value every frame, where a
// freshly computed double costs V8 a heap allocation per call (drawImage has no fast path).
// Seeded with null so V8 keeps them as tagged arrays rather than unboxed double arrays.
const dotX = [null];
const dotY = [null];
const liveAlpha = [null];         // by age (0 = newest) across `liveFor` recent dots
let liveFor = 0;
const trailAlpha = [null];        // by position across a limited trail of `trailFor` dots
let trailFor = 0;

/** Sprite origin of dot `i` at the target's scale, pinned inside the bezel. */
function place(i) {
  let x = xs[i] * unit, y = ys[i] * unit;
  const d = x * x + y * y;
  if (d > EDGE * EDGE) { const f = EDGE / Math.sqrt(d); x *= f; y *= f; }
  dotX[i] = (HALF + x) * pixel - cell / 2;
  dotY[i] = (HALF + y) * pixel - cell / 2;
}

function placeAll() {
  for (let i = 0; i < n; i++) place(i);
  dirty.place = false;
}

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
    c.fillStyle = lens;
    c.fillRect(0, 0, VIEW, VIEW);
  }

  c.lineWidth = hair;
  c.strokeStyle = FG.hair;
  c.beginPath();
  c.moveTo(HALF - RING - 18 * K, mid); c.lineTo(HALF + RING + 18 * K, mid);
  c.moveTo(mid, HALF - RING - 18 * K); c.lineTo(mid, HALF + RING + 18 * K);
  c.stroke();

  // Ruler ticks every 10 playfield px along both axes, inside the circle (large targets only).
  const s = unit;
  if (full) {
    c.strokeStyle = FG.tick;
    c.beginPath();
    for (let d = 10; d * s < RING - 2; d += 10) {
      for (let sign = -1; sign <= 1; sign += 2) {
        const p = crisp(HALF + sign * d * s);
        c.moveTo(p, mid - 3); c.lineTo(p, mid + 3);
        c.moveTo(mid - 3, p); c.lineTo(mid + 3, p);
      }
    }
    c.stroke();
  }

  // Centre zone (R/3), dashed.
  c.setLineDash(DASH);
  c.strokeStyle = FG.zone;
  c.beginPath(); c.arc(HALF, HALF, RING * CENTRE, 0, TAU); c.stroke();
  c.setLineDash(SOLID);

  // The hit circle.
  c.lineWidth = full ? 1.5 : 1.25;
  c.strokeStyle = FG.ring;
  c.beginPath(); c.arc(HALF, HALF, RING, 0, TAU); c.stroke();

  // Bezel: 10° ticks, 30° majors, cardinal points brightest (30° only on small targets).
  c.lineWidth = hair * Math.max(1, Math.round(pixel * 0.9));
  for (let deg = 0; deg < 360; deg += full ? 10 : 30) {
    const major = deg % 30 === 0;
    const cardinal = deg % 90 === 0;
    const a = deg * Math.PI / 180;
    const r0 = RING + 5 * K + 1;
    const r1 = RING + (cardinal ? 14 : major ? 10 : 7) * K + 1;
    c.strokeStyle = cardinal ? FG.cardinal : major ? FG.major : FG.minor;
    c.beginPath();
    c.moveTo(HALF + Math.cos(a) * r0, HALF + Math.sin(a) * r0);
    c.lineTo(HALF + Math.cos(a) * r1, HALF + Math.sin(a) * r1);
    c.stroke();
  }
}

function blit(c, i) {
  c.drawImage(atlas, bucket[i] * cell, 0, cell, cell, dotX[i], dotY[i], cell, cell);
}

function drawTrail() {
  const c = ctx.trail;
  const recent = Math.min(RECENT, limit);
  const end = Math.max(0, n - recent);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (limit === Infinity) {
    // All hits: rasterise each dot once as it leaves the recent window; the layer accumulates.
    if (dirty.trail || end < baked) { c.clearRect(0, 0, canvases.trail.width, canvases.trail.height); baked = 0; }
    c.globalAlpha = 0.26;
    for (let i = baked; i < end; i++) blit(c, i);
    baked = end;
  } else if (dirty.trail || n !== drawnN) {
    c.clearRect(0, 0, canvases.trail.width, canvases.trail.height);
    const start = Math.max(0, n - limit);
    const span = Math.max(1, end - start);
    if (span !== trailFor) {
      trailFor = span;
      for (let k = 0; k < span; k++) trailAlpha[k] = 0.12 + 0.3 * k / span;
    }
    for (let i = start; i < end; i++) { c.globalAlpha = trailAlpha[i - start]; blit(c, i); }
  }
  c.globalAlpha = 1;
  drawnN = n;
  dirty.trail = false;
}

const centroid = { x: null, y: null };   // live layer: centroid on screen (CSS px)

function drawLive() {
  const c = ctx.live;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvases.live.width, canvases.live.height);
  dirty.live = false;
  if (!n) return;
  const recent = Math.min(RECENT, limit, n);
  if (recent !== liveFor) {
    liveFor = recent;
    for (let age = 0; age < recent; age++) liveAlpha[age] = 1 - 0.55 * age / recent;
  }
  for (let i = n - recent; i < n; i++) { c.globalAlpha = liveAlpha[n - 1 - i]; blit(c, i); }
  c.globalAlpha = 1;
  c.setTransform(pixel, 0, 0, pixel, 0, 0);
  const s = unit;

  // Newest hit: a ring in its own timing colour.
  let lx = xs[n - 1] * s, ly = ys[n - 1] * s;
  const ld = Math.hypot(lx, ly);
  if (ld > EDGE) { lx *= EDGE / ld; ly *= EDGE / ld; }
  c.lineWidth = 1.25;
  c.strokeStyle = RAMP[bucket[n - 1]];
  c.beginPath(); c.arc(HALF + lx, HALF + ly, ringR, 0, TAU); c.stroke();

  // The centroid goes to seven canvas calls; held in tagged fields it is boxed once per redraw
  // rather than once per call (see S).
  centroid.x = HALF + S.mx * s; centroid.y = HALF + S.my * s;
  const cx = centroid.x, cy = centroid.y;
  if (options.ellipse && n >= 3) {
    c.beginPath();
    c.ellipse(cx, cy, Math.max(S.major * s, 0.5), Math.max(S.minor * s, 0.5), S.tilt, 0, TAU);
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
  c.beginPath();
  c.moveTo(cx - arm, cy); c.lineTo(cx - gap, cy); c.moveTo(cx + gap, cy); c.lineTo(cx + arm, cy);
  c.moveTo(cx, cy - arm); c.lineTo(cx, cy - gap); c.moveTo(cx, cy + gap); c.lineTo(cx, cy + arm);
  c.lineWidth = 3.5; c.strokeStyle = 'rgb(8 9 10 / .8)'; c.stroke();
  c.lineWidth = 1.5; c.strokeStyle = hl; c.stroke();
  c.beginPath(); c.arc(cx, cy, pip, 0, TAU); c.fillStyle = hl; c.fill();
  c.lineCap = 'butt';
}

// ------------------------------------------------------------------ DOM (write only on change)
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const shown = (node, visible) => { if (node.hasAttribute('hidden') === visible) node.toggleAttribute('hidden', !visible); };
const DIRECTIONS = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
const OCTANT = Math.PI / 4;
// Every arrow rotation and centre percentage as a string, built once: most hits change one.
const ROTATE = Array.from({ length: 361 }, (_, i) => `rotate(${i - 180}deg)`);   // by deg + 180
const PERCENT = Array.from({ length: 101 }, (_, i) => String(i));
const px = v => v.toFixed(1);
let arrowDeg = null;
let tone = 'busy';                // status chip as last written (index.html starts it connecting)
let label = 'Connecting';
let shownWindow = '';
// Integer readouts as last written (-1 = no data; direction: DIRECTIONS index, -1 centred,
// -2 no hits), so a hit that changes none of them writes nothing.
const last = { have: null, dir: -3, centre: -2, n: -1, inside: -1 };

// The circle the target is scaled to: converted CS and its radius in playfield px.
function relabel() {
  csShort = cs === null ? 'CS —' : `CS ${cs.toFixed(1)}`;
  csFull = cs === null ? 'CS —' : `${csShort} · R ${px(radius)} px`;
  resultsLabel = `Results · ${csShort}`;
}

/**
 * A toFixed(1) readout's current tenth: values strictly between `lo` and `hi` print the text last
 * written, so a hit that moves no digit formats nothing. The bounds sit 1e-9 inside the tenth, so
 * rounding at an edge is always left to toFixed; null bounds match nothing (values are ≥ 0).
 */
const tenth = () => ({ lo: null, hi: null });
const R = { bias: tenth(), spread: tenth(), major: tenth(), minor: tenth() };
const inTenth = (r, v) => v > r.lo && v < r.hi;

function holdTenth(r, v) {
  const k = Math.round(v * 10);
  const lo = (k - 0.5) / 10 + 1e-9, hi = (k + 0.5) / 10 - 1e-9;
  if (v > lo && v < hi) { r.lo = lo; r.hi = hi; } else r.lo = r.hi = null;
}

function dropTenth(r) { r.lo = r.hi = null; }

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

  let nextTone = 'idle', nextLabel;
  if (status === 'connecting') { nextTone = 'busy'; nextLabel = 'Connecting'; }
  else if (status === 'offline') { nextTone = 'error'; nextLabel = 'vosu offline'; }
  else if (state === undefined) nextLabel = 'No game';
  else if (state === PLAYING) { nextTone = 'play'; nextLabel = extension === 'off' ? '' : small ? csShort : csFull; }
  else nextLabel = resultsLabel;
  if (nextTone !== tone) { tone = nextTone; el.status.dataset.tone = tone; }
  if (nextLabel !== label) { label = nextLabel; text(el.statusText, label); }
  if (view !== 'data' && view !== 'summary') return;

  if (windowLabel !== shownWindow) { shownWindow = windowLabel; text(el.window, windowLabel); }

  const have = n > 0;
  if (have !== last.have) { last.have = have; readouts.classList.toggle('is-empty', !have); }
  const bias = S.bias;
  if (!have) { dropTenth(R.bias); text(el.bias, '—'); }
  else if (!inTenth(R.bias, bias)) { holdTenth(R.bias, bias); text(el.bias, px(bias)); }
  let dir = have ? -1 : -2;
  if (have && bias >= 0.05) {
    const angle = Math.atan2(S.my, S.mx);
    const deg = Math.round(angle * 180 / Math.PI);
    if (deg !== arrowDeg) { arrowDeg = deg; el.biasArrow.style.transform = ROTATE[deg + 180]; }
    dir = (Math.round(angle / OCTANT) + 8) % 8;
  }
  if (dir !== last.dir) {
    last.dir = dir;
    shown(el.biasArrow, dir >= 0);
    text(el.biasDir, dir >= 0 ? DIRECTIONS[dir] : dir === -1 ? 'centred' : '');
  }
  const centre = have ? Math.round(inside / n * 100) : -1;
  if (centre !== last.centre) { last.centre = centre; text(el.centre, have ? PERCENT[centre] : '—'); }
  if (n !== last.n || inside !== last.inside) {
    last.n = n; last.inside = inside;
    // n changed, so the text did: write without reading the old one back. Integers print through
    // toFixed(0), the same text as String(n) without V8's number-string cache (a full GC flushes
    // it and the next miss rebuilds it as one 64 KB block).
    el.centreSub.textContent = have ? inside.toFixed(0) + ' of ' + n.toFixed(0) : '';
  }
  if (have && n >= 2) {
    if (!inTenth(R.spread, S.spread)) { holdTenth(R.spread, S.spread); text(el.spread, px(S.spread)); }
    if (!inTenth(R.major, S.major) || !inTenth(R.minor, S.minor)) {
      holdTenth(R.major, S.major); holdTenth(R.minor, S.minor);
      text(el.spreadSub, `${px(S.major)} × ${px(S.minor)}`);
    }
  } else {
    dropTenth(R.spread); dropTenth(R.major); dropTenth(R.minor);
    text(el.spread, '—');
    text(el.spreadSub, '');
  }
}

function frame() {
  raf = 0;
  if (dirty.size) resize();
  if (dirty.place) placeAll();
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

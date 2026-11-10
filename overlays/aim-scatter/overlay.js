// Copyright (c) 2026 18-LAB. MIT.
// Aim scatter: every osu! circle / slider-head hit as a dot at the cursor's offset from the
// object's centre (vosu `play.hitOffsets`, ENABLE_HIT_OFFSETS), with the attempt's spread ellipse
// and its aim bias (the vector to the hits' average), and that bias with its direction as the
// one readout.
// The page is the overlay's own box: hosts place and size it, and the layout re-flows to it
// (vertical column or horizontal strip, from the box's aspect or the `orientation` setting).
//
// Colour roles (docs/overlay-system.md): your hits and their statistics are neutral, the newest
// hit is "you" (amber), the hit circle is the map's (its CS, --map). No timing colours here: the
// timing distribution is results-card's.
//
// Motion: the newest hit lands (an amber ring, a compositor Web Animation restarted per hit), the
// bias vector and ellipse ease to each new average while a hit moves them visibly (an
// attempt's first hits), the readout's arrow turns to the new direction, and the box eases in and
// out with play.
import {
  subscribe, settings, activeMode, mapPalette, applyPalette, applyKitSettings, numberFormatter,
  DASH, MOTION_MS,
} from './vosu-overlay.js';

const REF = { w: 256, h: 240 };   // default box: --u = 1
const STRIP = { w: 416, h: 160 }; // strip box at --u = 1
const RING_RATIO = 104 / 288;     // hit-circle radius / target diameter
const RECENT = 40;                // newest hits drawn bright on the recent layer
const PLAYING = 2;
const RESULTS = 7;
const FALLBACK_RADIUS = 54.4 - 4.48 * 4;
const TAU = Math.PI * 2;
// Hits closer together than this (above ~15 a second) move the ring without landing it.
const SNAP_HIT_MS = 66;
// The stats layer draws in 1/Q CSS px integer units: integers reach canvas calls as small
// integers, so an optimised 60 fps ease boxes no coordinates.
const Q = 16;

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  offsets: '/play/hitOffsets',
  csConverted: '/beatmap/stats/cs/converted',
  csOriginal: '/beatmap/stats/cs/original',
  checksum: '/beatmap/checksum',
};

const $ = id => document.getElementById(id);
const aim = $('aim');
const canvases = { reticle: $('reticle'), trail: $('trail'), recent: $('recent'), stats: $('stats') };
const ctx = {
  reticle: canvases.reticle.getContext('2d', { alpha: true }),
  trail: canvases.trail.getContext('2d', { alpha: true }),
  recent: canvases.recent.getContext('2d', { alpha: true }),
  stats: canvases.stats.getContext('2d', { alpha: true }),
};
const el = { hit: $('hit'), ring: $('hit-ring'), bias: $('bias'), biasArrow: $('bias-arrow') };
const biasText = el.bias.firstChild;

// ------------------------------------------------------------------ colours (kit roles)
// Canvas strokes from the kit's roles, read on boot and when the map tone or mapTint changes.
// Fields seeded with null stay tagged, so a frame passes the stored string, never a new one.
const COL = { dot: null, hair: null, tick: null, minor: null, major: null, cardinal: null, circle: null, ellipse: null, fill: null, arrow: null, casing: null, lens: null };

function readColours() {
  const css = getComputedStyle(aim);
  const hex = (css.getPropertyValue('--text-1').trim() || '#efece5').replace('#', '');
  const v = parseInt(hex, 16);
  const t1 = `${v >> 16 & 255} ${v >> 8 & 255} ${v & 255}`;
  const back = css.getPropertyValue('--backing-rgb').trim() || '11 12 13';
  COL.dot = `rgb(${t1})`;
  COL.hair = `rgb(${t1} / .14)`;
  COL.tick = `rgb(${t1} / .28)`;
  COL.minor = `rgb(${t1} / .2)`;
  COL.major = `rgb(${t1} / .38)`;
  COL.cardinal = `rgb(${t1} / .62)`;
  COL.circle = css.getPropertyValue('--map').trim() || '#c9c4ba';
  COL.ellipse = css.getPropertyValue('--text-2').trim() || '#d3cfc6';
  COL.fill = `rgb(${t1} / .05)`;
  COL.arrow = `rgb(${t1})`;
  COL.casing = `rgb(${back} / .75)`;
  COL.lens = back;
  dirty.reticle = dirty.stats = true;
  schedule();
}

// ------------------------------------------------------------------ target geometry (CSS px)
let VIEW = 168;                   // target diameter
let HALF = VIEW / 2;
let RING = VIEW * RING_RATIO;     // hit-circle radius on screen
let EDGE = HALF - 4;              // off-target hits pin to this radius
let DOT = 2;                      // dot radius
let K = VIEW / 288;               // detail scale (ticks) relative to the 288 px design
let unit = RING / FALLBACK_RADIUS; // screen px per playfield px: RING over the latched radius
let ringR = DOT + 2.5;            // newest-hit ring radius

function setDiameter(d) {
  VIEW = d; HALF = d / 2; RING = d * RING_RATIO; K = d / 288;
  EDGE = HALF - Math.max(2, 6 * K);
  DOT = Math.max(1.3, Math.min(2.6, d / 96));
  ringR = DOT + 2.75;
  rescale();
}

function rescale() {
  unit = RING / (radius ?? FALLBACK_RADIUS);
  G.s = unit * Q;
  dirty.place = dirty.ring = dirty.stats = true;
}

// ------------------------------------------------------------------ attempt store (grows by doubling)
// The whole attempt stays in typed arrays sized once (doubling past 2048 hits): "All hits"
// re-rasterises every dot after a resize or a CS change.
let cap = 2048;
let xs = new Float32Array(cap);
let ys = new Float32Array(cap);
let n = 0;
// Running statistics in plain object fields, seeded with null so V8 keeps them tagged: per-hit
// code runs about ten times a second, so it stays in V8's baseline tier for a long time, where
// every double it computes is already a heap number. Tagged fields store and hand those on as
// they are; a Float64Array would box each read again.
// Welford moments of (x, y), then what derive() takes from them once per hit: bias length and the
// covariance ellipse's semi-axes and tilt (playfield px, radians).
const S = { mx: null, my: null, sxx: null, syy: null, sxy: null, bias: null, major: null, minor: null, tilt: null };
S.mx = S.my = S.sxx = S.syy = S.sxy = S.bias = S.major = S.minor = S.tilt = 0;
let radius = null;                // latched hit-circle radius (playfield px) for the held attempt
let cs = null;

function grow() {
  cap *= 2;
  const nx = new Float32Array(cap); nx.set(xs); xs = nx;
  const ny = new Float32Array(cap); ny.set(ys); ys = ny;
}

function resetAttempt() {
  n = 0; S.mx = S.my = S.sxx = S.syy = S.sxy = S.bias = S.major = S.minor = S.tilt = 0; baked = 0;
  sDeg = -1;
  // The next attempt's arrow and ellipse grow out of the centre.
  D.mx = D.my = D.major = D.minor = D.tilt = D.bias = 0;
  easing = false;
  dirty.trail = dirty.recent = dirty.stats = dirty.ring = dirty.dom = true;
}

/** Appends the hit at `offsets[i…i+2]` (x, y, timing error), read in place from vosu's array. */
function push(offsets, i) {
  const x = offsets[i], y = offsets[i + 1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (n === cap) grow();
  xs[n] = x; ys[n] = y;
  place(n);
  n++;
  const dx = x - S.mx; S.mx += dx / n;
  const dy = y - S.my; S.my += dy / n;
  S.sxx += dx * (x - S.mx); S.syy += dy * (y - S.my); S.sxy += dx * (y - S.my);
}

const DEG = 180 / Math.PI;

/** Whole degrees 0…359 of the direction (x, y), clockwise from +x as on screen. */
function directionOf(x, y) {
  const deg = Math.round(Math.atan2(y, x) * DEG);
  return deg < 0 ? deg + 360 : deg === 360 ? 0 : deg;
}

/** Bias and ellipse from the moments: once per batch of new hits, for canvas and text. */
function derive() {
  S.bias = Math.hypot(S.mx, S.my);
  sDeg = S.bias >= 0.05 ? directionOf(S.mx, S.my) : -1;
  if (n < 2) return;
  const a = S.sxx / n, b = S.sxy / n, d = S.syy / n;
  const half = (a + d) / 2;
  const root = Math.sqrt(((a - d) / 2) ** 2 + b * b);
  S.major = Math.sqrt(Math.max(0, half + root));
  S.minor = Math.sqrt(Math.max(0, half - root));
  S.tilt = 0.5 * Math.atan2(2 * b, a - d);
}

// ------------------------------------------------------------------ stats ease
// What the stats layer shows (D): the attempt's statistics (S), or between them while easing.
// Tagged fields (seeded null) so the per-hit snap passes S's numbers on without boxing new ones.
// The ease runs only for an attempt's first EASE_HITS hits, where each hit visibly moves the
// average; later a hit moves it by a fraction of a pixel and the layer snaps.
const D = { mx: null, my: null, major: null, minor: null, tilt: null, bias: null };
D.mx = D.my = D.major = D.minor = D.tilt = D.bias = 0;
let sDeg = -1;                    // S's bias direction in whole degrees, -1 when centred
const EASE_HITS = 64;
const EASE_MS = MOTION_MS.base;
// From and to values (x, y, semi-axes, tilt) and the ease's start time, unboxed.
const F = new Float64Array(5);
const T = new Float64Array(5);
const T0 = new Float64Array(1);
let easing = false;
const HALF_TURN = Math.PI;
const QUARTER_TURN = Math.PI / 2;
// Ellipse tilt by whole degree (0…179) as stored numbers: a frame passes the same boxed value.
const TILTS = [null];
for (let deg = 0; deg < 180; deg++) TILTS[deg] = deg / DEG;

function snapStats() {
  D.mx = S.mx; D.my = S.my; D.tilt = S.tilt; D.bias = S.bias;
  if (n >= 3) { D.major = S.major; D.minor = S.minor; } else D.major = D.minor = 0;
  easing = false;
}

/** Points the arrow and ellipse at the attempt's new statistics: eased early in the attempt. */
function retarget() {
  dirty.stats = true;
  if (level === 'off' || view !== 'data' || n > EASE_HITS) { snapStats(); return; }
  F[0] = D.mx; F[1] = D.my; F[2] = D.major; F[3] = D.minor; F[4] = D.tilt;
  T[0] = S.mx; T[1] = S.my;
  T[2] = n >= 3 ? S.major : 0; T[3] = n >= 3 ? S.minor : 0;
  // The ellipse is symmetric under a half turn: take the shorter way round.
  let turn = S.tilt - D.tilt;
  while (turn > QUARTER_TURN) turn -= HALF_TURN;
  while (turn < -QUARTER_TURN) turn += HALF_TURN;
  T[4] = D.tilt + turn;
  T0[0] = -1;
  easing = true;
}

/** Advances the ease to rAF time `now`; false once it has arrived. */
function stepEase(now) {
  if (T0[0] < 0) T0[0] = now;
  const k = (now - T0[0]) / EASE_MS;
  if (k >= 1) { snapStats(); return false; }
  const r = 1 - k;
  const p = 1 - r * r * r * r;     // ease-out (quart)
  const mx = F[0] + (T[0] - F[0]) * p, my = F[1] + (T[1] - F[1]) * p;
  D.mx = mx; D.my = my;
  D.major = F[2] + (T[2] - F[2]) * p;
  D.minor = F[3] + (T[3] - F[3]) * p;
  D.tilt = F[4] + (T[4] - F[4]) * p;
  D.bias = Math.sqrt(mx * mx + my * my);
  return true;
}

// ------------------------------------------------------------------ state
const options = { orientation: 'auto', align: 'center', dots: 'All hits', ellipse: true, results: true, motion: 'full', backing: 'scrim', mapTint: true };
let level = 'full';               // motion level
let limit = Infinity;             // dots kept on the target; Infinity = all hits
let status = 'connecting';
let state;                        // /state/number
let mode = null;
let extension = 'unknown';        // 'on' | 'off' | 'unknown'
let prevState;
let checksum = null;
let view = 'hidden';
let small = false;                // half-size box (renderer cell): no label
let baked = 0;                    // all-hits mode: dots already rasterised on the trail layer
let drawnN = -1;
const dirty = { size: true, reticle: true, trail: true, recent: true, stats: true, ring: true, dom: true, place: true };
let raf = 0;
let pixel = 1;                    // device px per CSS px of the target canvas
let atlas = null;                 // the dot sprite, rasterised at the device scale
let cell = 0;
let lens = null;                  // reticle lens gradient (backing none), rebuilt with the canvas size
let hitAt = -1e9;                 // page time of the last ring landing
let ringFor = -1;                 // hit count the ring was placed for

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

  // Latch circle size while playing, or while nothing is held yet.
  if (playing || n === 0) {
    const nextCs = values[P.csConverted] ?? values[P.csOriginal];
    const csNumber = typeof nextCs === 'number' && Number.isFinite(nextCs) ? nextCs : null;
    if (csNumber !== cs) {
      cs = csNumber;
      radius = cs === null ? null : Math.max(1, 54.4 - 4.48 * cs);
      rescale();
      dirty.reticle = dirty.trail = dirty.recent = dirty.stats = true;
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
      retarget();
      dirty.recent = dirty.ring = dirty.dom = true;
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

// ------------------------------------------------------------------ map tone (off the hot path)
function loadPalette() {
  const wanted = checksum;
  if (!options.mapTint || !wanted) { setPalette(null); return; }
  mapPalette(wanted).then(result => { if (wanted === checksum && options.mapTint) setPalette(result); });
}

function setPalette(palette) {
  applyPalette(aim, palette);
  readColours();
}

// ------------------------------------------------------------------ box layout (resize / settings only)
/**
 * Re-flows to the page box: a column (target over the bias line) for upright boxes, a strip
 * (target beside it) for wide ones. --u scales the kit against the default box, floored at 0.75
 * so the readout stays legible in half-size renderer cells; the target takes the space the text
 * leaves. Pure arithmetic (no layout reads), so it gives the same answer whichever view shows.
 */
function layoutBox() {
  const w = innerWidth || REF.w;
  const h = innerHeight || REF.h;
  const orient = options.orientation === 'vertical' || options.orientation === 'horizontal'
    ? options.orientation : (h / w >= 0.75 ? 'vertical' : 'horizontal');
  const s = orient === 'vertical' ? Math.min(w / REF.w, h / REF.h) : Math.min(w / STRIP.w, h / STRIP.h);
  const u = Math.max(0.75, Math.min(3, s));
  if (aim.dataset.orient !== orient) aim.dataset.orient = orient;
  aim.style.setProperty('--u', u.toFixed(3));
  small = s < 0.8;
  aim.classList.toggle('is-small', small);
  const pad = 16 * u;
  let d;
  if (orient === 'vertical') d = Math.min(w - 2 * pad, h - 2 * pad - 32 * u - 8 * u);
  else d = Math.min(h - 2 * pad, w - 2 * pad - 24 * u - (small ? 80 : 120) * u);
  d = Math.max(48, Math.floor(d));
  aim.style.setProperty('--d', `${d}px`);
  if (d !== VIEW) { setDiameter(d); dirty.size = true; }
  aim.style.setProperty('--ring', `${ringR.toFixed(2)}px`);
  const next = devicePixelRatio || 1;
  if (Math.abs(next - pixel) > 1e-3) dirty.size = true;
  pixel = next;
  dirty.dom = true;
  schedule();
}

// Ring positions as transform strings by half CSS px, built per target size: a hit only looks
// one up. X goes to `transform`, Y to the independent `translate` property of the same element.
let ringX = [];
let ringY = [];

function resize() {
  const side = Math.max(1, Math.round(VIEW * (devicePixelRatio || 1)));
  for (const key in canvases) { canvases[key].width = side; canvases[key].height = side; }
  pixel = side / VIEW;
  G.q = pixel / Q;
  G.half = HALF * Q;
  G.o = Math.round(HALF * Q);
  G.s = unit * Q;
  G.casing = Math.round(Math.max(3.5, 4 * K) * Q);
  G.line = Math.round(Math.max(1.5, 1.75 * K) * Q);
  G.ellipseCasing = Math.round(Math.max(3, 3.5 * K) * Q);
  G.ellipseLine = Math.round(Math.max(1.25, 1.5 * K) * Q);
  G.pip = Math.round(Math.max(1.6, 2.2 * K) * Q);
  // Dot sprite: one filled disc, rasterised at the device scale.
  const r = DOT * pixel;
  cell = Math.ceil(r * 2 + 2);
  atlas = document.createElement('canvas');
  atlas.width = cell;
  atlas.height = cell;
  const a = atlas.getContext('2d');
  a.fillStyle = COL.dot;
  a.beginPath();
  a.arc(cell / 2, cell / 2, r, 0, TAU);
  a.fill();
  lens = ctx.reticle.createRadialGradient(HALF, HALF, RING * 0.2, HALF, HALF, HALF);
  lens.addColorStop(0, `rgb(${COL.lens} / .62)`);
  lens.addColorStop(RING / HALF, `rgb(${COL.lens} / .5)`);
  lens.addColorStop(1, `rgb(${COL.lens} / 0)`);
  const slots = Math.ceil(VIEW * 2) + 1;
  ringX = new Array(slots);
  ringY = new Array(slots);
  for (let k = 0; k < slots; k++) { ringX[k] = `translateX(${k / 2}px)`; ringY[k] = `0 ${k / 2}px`; }
  ringFor = -1;
  dirty.size = false;
  dirty.place = dirty.reticle = dirty.trail = dirty.recent = dirty.stats = dirty.ring = true;
}

// ------------------------------------------------------------------ drawing
// Dot sprite origins (device px) and fade alphas live in plain arrays of numbers on purpose: a
// stored number reaches drawImage / globalAlpha as the same boxed value every frame, where a
// freshly computed double costs V8 a heap allocation per call (drawImage has no fast path).
// Seeded with null so V8 keeps them as tagged arrays rather than unboxed double arrays.
const dotX = [null];
const dotY = [null];
const recentAlpha = [null];       // by age (0 = newest) across `recentFor` recent dots
let recentFor = 0;
const trailAlpha = [null];        // by position across a limited trail of `trailFor` dots
let trailFor = 0;
// Stats-layer sizes in 1/Q px, set per target size; tagged for the same reason.
const G = { q: null, s: null, half: null, o: null, casing: null, line: null, ellipseCasing: null, ellipseLine: null, pip: null };
let ringKX = 0, ringKY = 0;       // the newest dot's ring slot (half CSS px)

/** Sprite origin of dot `i` at the target's scale, pinned inside the bezel. */
function place(i) {
  let x = xs[i] * unit, y = ys[i] * unit;
  const d = x * x + y * y;
  if (d > EDGE * EDGE) { const f = EDGE / Math.sqrt(d); x *= f; y *= f; }
  const px = HALF + x, py = HALF + y;
  dotX[i] = px * pixel - cell / 2;
  dotY[i] = py * pixel - cell / 2;
  // The ring's slot (half CSS px) for whichever dot was placed last: the newest.
  ringKX = Math.round(px * 2); ringKY = Math.round(py * 2);
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
  const full = VIEW >= 160;

  // Without a backing, a dark lens that fades out past the bezel keeps dots and hairlines
  // readable on the game; scrim and panel bring their own field.
  if (options.backing === 'none') {
    c.fillStyle = lens;
    c.fillRect(0, 0, VIEW, VIEW);
  }

  c.lineWidth = hair;
  c.strokeStyle = COL.hair;
  c.beginPath();
  c.moveTo(HALF - RING - 18 * K, mid); c.lineTo(HALF + RING + 18 * K, mid);
  c.moveTo(mid, HALF - RING - 18 * K); c.lineTo(mid, HALF + RING + 18 * K);
  c.stroke();

  // Ruler ticks every 10 playfield px along both axes, inside the circle (large targets only).
  const s = unit;
  if (full) {
    c.strokeStyle = COL.tick;
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

  // The map's hit circle (its CS), in the map tone.
  c.lineWidth = full ? 1.5 : 1.25;
  c.strokeStyle = COL.circle;
  c.globalAlpha = 0.8;
  c.beginPath(); c.arc(HALF, HALF, RING, 0, TAU); c.stroke();
  c.globalAlpha = 1;

  // Bezel: 10° ticks, 30° majors, cardinal points brightest (30° only on small targets).
  c.lineWidth = hair * Math.max(1, Math.round(pixel * 0.9));
  for (let deg = 0; deg < 360; deg += full ? 10 : 30) {
    const major = deg % 30 === 0;
    const cardinal = deg % 90 === 0;
    const a = deg * Math.PI / 180;
    const r0 = RING + 5 * K + 1;
    const r1 = RING + (cardinal ? 14 : major ? 10 : 7) * K + 1;
    c.strokeStyle = cardinal ? COL.cardinal : major ? COL.major : COL.minor;
    c.beginPath();
    c.moveTo(HALF + Math.cos(a) * r0, HALF + Math.sin(a) * r0);
    c.lineTo(HALF + Math.cos(a) * r1, HALF + Math.sin(a) * r1);
    c.stroke();
  }
}

function blit(c, i) {
  c.drawImage(atlas, 0, 0, cell, cell, dotX[i], dotY[i], cell, cell);
}

function drawTrail() {
  const c = ctx.trail;
  const recent = Math.min(RECENT, limit);
  const end = Math.max(0, n - recent);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (limit === Infinity) {
    // All hits: rasterise each dot once as it leaves the recent window; the layer accumulates.
    if (dirty.trail || end < baked) { c.clearRect(0, 0, canvases.trail.width, canvases.trail.height); baked = 0; }
    c.globalAlpha = 0.24;
    for (let i = baked; i < end; i++) blit(c, i);
    baked = end;
  } else if (dirty.trail || n !== drawnN) {
    c.clearRect(0, 0, canvases.trail.width, canvases.trail.height);
    const start = Math.max(0, n - limit);
    const span = Math.max(1, end - start);
    if (span !== trailFor) {
      trailFor = span;
      for (let k = 0; k < span; k++) trailAlpha[k] = 0.1 + 0.28 * k / span;
    }
    for (let i = start; i < end; i++) { c.globalAlpha = trailAlpha[i - start]; blit(c, i); }
  }
  c.globalAlpha = 1;
  drawnN = n;
  dirty.trail = false;
}

/** The newest RECENT dots, fading with age; once per batch of hits. */
function drawRecent() {
  const c = ctx.recent;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvases.recent.width, canvases.recent.height);
  dirty.recent = false;
  if (!n) return;
  const recent = Math.min(RECENT, limit, n);
  if (recent !== recentFor) {
    recentFor = recent;
    for (let age = 0; age < recent; age++) recentAlpha[age] = 0.92 - 0.5 * age / recent;
  }
  for (let i = n - recent; i < n; i++) { c.globalAlpha = recentAlpha[n - 1 - i]; blit(c, i); }
  c.globalAlpha = 1;
}

/**
 * Ellipse and bias at the shown statistics (D): once per hit, and every frame of an ease. Every
 * coordinate reaches the canvas as an integer in 1/Q px and sizes and colours come
 * from stored values, so a hit costs a handful of numbers and an optimised frame none.
 */
function drawStats() {
  const c = ctx.stats;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvases.stats.width, canvases.stats.height);
  dirty.stats = false;
  if (!n) return;
  c.setTransform(G.q, 0, 0, G.q, 0, 0);
  const cx = Math.round(G.half + D.mx * G.s);
  const cy = Math.round(G.half + D.my * G.s);

  if (options.ellipse && n >= 3) {
    let deg = Math.round(D.tilt * DEG) % 180;
    if (deg < 0) deg += 180;
    c.beginPath();
    c.ellipse(cx, cy, Math.max(8, Math.round(D.major * G.s)), Math.max(8, Math.round(D.minor * G.s)), TILTS[deg], 0, TAU);
    c.fillStyle = COL.fill;
    c.fill();
    c.lineWidth = G.ellipseCasing; c.strokeStyle = COL.casing; c.stroke();
    c.lineWidth = G.ellipseLine; c.strokeStyle = COL.ellipse; c.stroke();
  }

  // Bias: the vector from the circle's centre to the attempt's average at the plot's true scale
  // (a few px for most players), ending in a pip; the readout below gives its direction and size.
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  if (D.bias >= 0.05) { c.moveTo(G.o, G.o); c.lineTo(cx, cy); }
  c.moveTo(cx + G.pip, cy);
  c.arc(cx, cy, G.pip, 0, TAU);
  c.lineWidth = G.casing; c.strokeStyle = COL.casing; c.stroke();
  c.lineWidth = G.line; c.strokeStyle = COL.arrow; c.stroke();
  c.fillStyle = COL.arrow; c.fill();
  c.lineCap = 'butt';
  c.lineJoin = 'miter';
}

// ------------------------------------------------------------------ newest hit (DOM ring)
const LAND_KEYS = [{ transform: 'scale(2.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
const LAND_OPTIONS = { duration: MOTION_MS.fast, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const landing = el.ring.animate(LAND_KEYS, LAND_OPTIONS);
landing.cancel();
let shownKX = -1, shownKY = -1;

/** Moves the amber ring to the newest hit and lands it (full motion, hits not too dense). */
function placeRing(now) {
  dirty.ring = false;
  if (!n) {
    if (!el.hit.hidden) el.hit.hidden = true;
    ringFor = 0;
    return;
  }
  if (ringKX !== shownKX) { shownKX = ringKX; el.hit.style.transform = ringX[ringKX]; }
  if (ringKY !== shownKY) { shownKY = ringKY; el.hit.style.translate = ringY[ringKY]; }
  if (el.hit.hidden) el.hit.hidden = false;
  if (n === ringFor) return;       // re-placed after a resize or CS change: no new hit
  ringFor = n;
  if (level === 'full' && view === 'data' && now - hitAt >= SNAP_HIT_MS) {
    landing.currentTime = 0;
    landing.play();
  } else if (landing.playState === 'running') landing.finish();
  hitAt = now;
}

// ------------------------------------------------------------------ DOM (write only on change)
const fmtBias = numberFormatter('px');
let shownBias = DASH;
let arrowShown = false;
// The readout arrow turns the short way: its angle is kept unwrapped (whole degrees) and the
// rotate() strings are cached by angle, built once each.
const TURNS = 3600;
const ROTATE = new Array(2 * TURNS + 1).fill(null);
let arrowDeg = null;              // unwrapped degrees as last written
let biasDir = null;               // 0…359 as last computed

/**
 * What the box shows: `data` during osu! play, and on results with a held attempt ("Keep on
 * results"); `notice` when vosu runs without ENABLE_HIT_OFFSETS (and in the replay renderer);
 * `chip` for connection / no game; else `hidden` (other rulesets, song select, menus).
 */
function viewFor() {
  if (status !== 'live') return 'chip';
  if (state === undefined) return 'chip';
  if (mode !== 'osu') return 'hidden';
  if (state === PLAYING) return extension === 'off' ? 'notice' : 'data';
  if (state === RESULTS && options.results && n > 0) return 'data';
  return 'hidden';
}

function updateDom() {
  dirty.dom = false;
  const next = viewFor();
  if (next !== view) {
    view = next;
    // Hidden keeps the last content while it fades out; data-view only names what is shown.
    const out = view === 'hidden';
    if (out !== aim.hasAttribute('data-out')) aim.toggleAttribute('data-out', out);
    if (!out && aim.dataset.view !== view) aim.dataset.view = view;
  }

  if (view === 'chip') {
    const label = status === 'connecting' ? 'Connecting' : status === 'live' ? 'No game' : 'vosu offline';
    const node = $('status');
    if (node.textContent !== label) node.textContent = label;
    return;
  }
  if (view !== 'data') return;

  const have = n > 0;
  const text = have ? fmtBias(S.bias) : DASH;
  if (text !== shownBias) {
    if ((shownBias === DASH) !== (text === DASH)) el.bias.classList.toggle('kit-dash', text === DASH);
    shownBias = text;
    biasText.data = text;
  }
  const pointing = have && sDeg >= 0;
  if (pointing && sDeg !== biasDir) {
    biasDir = sDeg;
    let next = sDeg;
    if (arrowDeg !== null && arrowShown) {
      next = arrowDeg + (sDeg - ((arrowDeg % 360) + 360) % 360 + 540) % 360 - 180;
      if (next > TURNS || next < -TURNS) next = sDeg;   // after ten turns one way, start over
    }
    if (next !== arrowDeg) {
      arrowDeg = next;
      el.biasArrow.style.transform = ROTATE[next + TURNS] ??= `rotate(${next}deg)`;
    }
  }
  if (pointing !== arrowShown) { arrowShown = pointing; el.biasArrow.toggleAttribute('hidden', !pointing); }
}

function frame(now) {
  raf = 0;
  if (dirty.size) resize();
  if (dirty.place) placeAll();
  if (dirty.reticle) { drawReticle(); dirty.reticle = false; }
  drawTrail();
  if (dirty.recent) drawRecent();
  if (dirty.dom) updateDom();
  if (easing) { easing = stepEase(now); dirty.stats = true; }
  if (dirty.stats) drawStats();
  if (dirty.ring) placeRing(now);
  if (easing) schedule();
}

// ------------------------------------------------------------------ settings & boot
const ALIGNS = new Set(['left', 'center', 'right']);

settings(options, next => {
  const backingWas = options.backing;
  const tintWas = options.mapTint;
  Object.assign(options, next, { align: ALIGNS.has(next.align) ? next.align : 'center' });
  level = applyKitSettings(aim, options);
  options.backing = aim.dataset.backing;
  const match = /(\d+)/.exec(options.dots);
  const nextLimit = /all/i.test(options.dots) || !match ? Infinity : Math.max(1, Number(match[1]));
  if (nextLimit !== limit) { limit = nextLimit; dirty.trail = dirty.recent = true; }
  if (aim.dataset.align !== options.align) aim.dataset.align = options.align;
  if (options.backing !== backingWas) dirty.reticle = true;
  if (options.mapTint !== tintWas) loadPalette();
  if (level === 'off' && easing) snapStats();
  dirty.stats = dirty.dom = true;
  layoutBox();
});

readColours();
new ResizeObserver(layoutBox).observe(document.documentElement);
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', layoutBox);
document.fonts?.ready.then(layoutBox);
subscribe(Object.values(P), onData, { onStatus });
schedule();

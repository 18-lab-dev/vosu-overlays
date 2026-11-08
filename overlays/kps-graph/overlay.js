// Copyright (c) 2026 18-LAB. MIT.
// KPS graph: osu!mania keys per second. Live KPS is the sum of /keys/all count deltas over a
// rolling one-second (real time) window, drawn as a chart-recorder strip over the map's strain
// density. The page is content-sized and re-flows to the box its host gives it: vertical (time
// runs upward like the mania editor, density falls toward the now line, the trace trails below)
// or horizontal (time runs left → right). Results add the whole run; song select adds the map's
// density and note rate, which osu! does not show.
import { subscribe, settings, activeMode, isPlaying, formatDuration, mapPalette, applyPalette } from './vosu-overlay.js';

const BIN = 50;          // map ms per histogram bin
const ORIGIN = -10000;   // map time of bin 0, covers lead-in
const NOW_AT = 0.82;     // share of the strip that is history; the rest previews upcoming density
const HOLD = 250;        // ms the clock may run past the last vosu time sample (pauses stop it)
const GUTTER = 22;       // px kept free at the overview's far end for scale labels (style.css --gutter)
const SELECT = new Set([4, 5, 12, 13]);   // song select (edit, play, match setup, multi)
const RESULTS = new Set([7, 14, 18]);     // results (solo, vs, team)

const POINTERS = [
  '/state/number', '/play/mode/number', '/settings/mode/number', '/play/source',
  '/keys/all', '/beatmap/time/live', '/beatmap/time/rate', '/play/mods/rate',
  '/beatmap/time/firstObject', '/beatmap/time/lastObject', '/beatmap/time/mp3Length',
  '/beatmap/checksum', '/beatmap/stats/cs/converted', '/beatmap/stats/objects/total',
  '/performance/graph/series', '/performance/graph/xaxis',
];

const $ = id => document.getElementById(id);
const block = $('kps');
const chip = $('chip');
const canvas = $('chart');
const note = $('note');
const el = {
  chip: $('chipText'), phase: $('phase'),
  pLabel: $('pLabel'), pValue: $('pValue'), pUnit: $('pUnit'), aLabel: $('aLabel'), aValue: $('aValue'), bLabel: $('bLabel'), bValue: $('bValue'),
  axisL: $('axisL'), axisM: $('axisM'), axisN: $('axisN'), axisR: $('axisR'),
};
const ctx = canvas.getContext('2d', { alpha: true });

/** textContent only when the formatted string changed. */
function put(node, value) {
  if (node._text !== value) { node._text = value; node.textContent = value; }
}
function attr(node, name, value) {
  if (node._attrs?.[name] === value) return;
  (node._attrs ??= {})[name] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}

// ---------------------------------------------------------------- palette
function rgb(hex, fallback) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim()) || /^#([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m[1], 16);
  return `${n >> 16} ${(n >> 8) & 255} ${n & 255}`;
}
const css = getComputedStyle(document.documentElement);
const tok = (name, fallback) => rgb(css.getPropertyValue(name) || fallback, fallback);
const FG = tok('--fg', '#ebe8e1');
const FG_DIM = tok('--fg-dim', '#b8b5ad');
const ACCENT = '#ff963f';
const SIGNAL = '#7fa6cf';
const C = {
  gridMinor: `rgb(${FG} / .05)`,
  gridMajor: `rgb(${FG} / .11)`,
  gridH: `rgb(${FG} / .08)`,
  base: `rgb(${FG} / .55)`,
  now: `rgb(${FG} / .7)`,
  label: `rgb(${FG_DIM})`,
  under: 'rgb(0 0 0 / .45)',
  line: `rgb(${FG} / .97)`,
  ghost: `rgb(${FG} / .7)`,
  avg: `rgb(${FG} / .62)`,
  strainFill: '', strainEdge: '', strainFillStrong: '', strainEdgeStrong: '', peak: '', hl: '', halo: '',
};
let palette = null;
/** Highlight (peak, live head) follows the map's tonal spot; density takes its secondary role. */
function recolor() {
  const hl = rgb(palette?.accent ?? ACCENT, ACCENT);
  const soft = rgb(palette?.secondary ?? SIGNAL, SIGNAL);
  C.strainFill = `rgb(${soft} / .2)`;
  C.strainEdge = `rgb(${soft} / .62)`;
  C.strainFillStrong = `rgb(${soft} / .34)`;
  C.strainEdgeStrong = `rgb(${soft} / .95)`;
  C.peak = `rgb(${hl} / .9)`;
  C.hl = `rgb(${hl})`;
  C.halo = `rgb(${hl} / .25)`;
  dirty = true;
}
const DASH_AVG = [4, 3];
const DASH_PEAK = [1, 3];
const DASH_NONE = [];
let monoFont = '500 12px "IBM Plex Mono", ui-monospace, monospace';

// ---------------------------------------------------------------- settings (applied at the end of the module)
const DEFAULTS = { window: 20, strain: true, orientation: 'auto', align: 'left', backing: 'none', accent: 'map', menus: false };
let opt = DEFAULTS;
let spanS = 20;
const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
function applySettings(next) {
  const accentChanged = next.accent !== opt.accent;
  opt = next;
  spanS = Math.round(clamp(next.window, 5, 60, 20));
  attr(block, 'data-align', next.align === 'right' ? 'right' : 'left');
  attr(block, 'data-backing', ['scrim', 'panel'].includes(next.backing) ? next.backing : 'none');
  if (accentChanged) loadPalette();
  relayout();
  setView(decideView());
  axisDirty = true;
  dirty = true;
  kick();
}

// ---------------------------------------------------------------- re-flow to the host's box
// Hosts (OBS, vosulay, the replay renderer's per-player cells) size the page; the layout follows
// the box: horizontal when it is wider than tall (or forced by `orientation`), type and marks
// scaled from the box (1 = 232 px wide vertical, 150 px tall horizontal), never below legibility.
function relayout() {
  const W = innerWidth, H = innerHeight;
  const next = opt.orientation === 'horizontal' ? 'h' : opt.orientation === 'vertical' ? 'v' : W >= H ? 'h' : 'v';
  const u = next === 'v' ? clamp(W / 232, 0.5, 2, 1) : clamp(H / 150, 0.5, 2, 1);
  const lab = Math.max(10, Math.round(12 * u));
  const s = block.style;
  s.setProperty('--u', u.toFixed(3));
  s.setProperty('--lab', `${lab}px`);
  s.setProperty('--big', `${Math.max(34, Math.round(60 * u))}px`);
  s.setProperty('--stat', `${Math.max(20, Math.round(30 * u))}px`);
  s.setProperty('--axis', `${Math.max(30, Math.round(42 * u))}px`);
  s.setProperty('--gap', `${Math.max(6, Math.round(10 * u))}px`);
  // Narrow vertical boxes (multiplayer cells) stack PEAK · AVG under NOW.
  attr(block, 'data-compact', next === 'v' && W < 200 ? '' : null);
  monoFont = `500 ${lab}px "IBM Plex Mono", ui-monospace, monospace`;
  if (next !== orient) { orient = next; attr(block, 'data-orient', orient); }
  measure();
  axisDirty = dirty = true;
  kick();
}
addEventListener('resize', relayout);

// ---------------------------------------------------------------- map tint
let paletteFor = null;
function loadPalette() {
  const checksum = values['/beatmap/checksum'] ?? null;
  if (opt.accent !== 'map' || !checksum) {
    paletteFor = null; palette = null; applyPalette(block, null); recolor(); kick();
    return;
  }
  if (checksum === paletteFor) return;
  paletteFor = checksum;
  mapPalette(checksum).then(result => {
    if (paletteFor !== checksum) return;
    palette = result;
    applyPalette(block, result);
    recolor();
    kick();
  });
}

// ---------------------------------------------------------------- canvas sizing
// The chart is drawn in a virtual horizontal frame (cw = time length, ch = amplitude thickness).
// A vertical box rotates it onto the canvas (later time goes up, amplitude grows away from the
// stage side); a horizontal box uses it as is (orient 'h').
let cw = 0, ch = 0, nowX = 0, dpr = 1, half = 0.5, fillGrad = null, ghostGrad = null, orient = 'v';
let box = null;
new ResizeObserver(([entry]) => {
  box = entry.contentRect;
  dpr = window.devicePixelRatio || 1;
  half = Math.round(dpr) % 2 ? 0.5 : 0;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  measure();
  dirty = true;
  kick();
}).observe(canvas);
document.fonts?.load(monoFont).then(() => { dirty = true; kick(); }, () => {});

// A canvas call boxes every computed fractional number it is passed (a fresh heap number per
// argument, per call); integers, and numbers already boxed, pass free. So per-frame drawing hands
// the canvas integers (device pixels for crisp lines, bin times and window sums for the trace) and
// lets a transform scale them, and the fractional arguments that change only on resize, rescale
// or a new peak are computed once into G. Its fields start as null, so they keep numbers boxed
// and a call takes them as they are.
const G = {
  a: null, b: null, c: null, d: null, e: null, f: null, // virtual → canvas (the frame transform)
  ra: null, rb: null, rc: null, rd: null,               // its rotation alone, in device pixels
  xe: null, xf: null, ye: null, yf: null,               // + the half-pixel offset of crisp x / y lines
  dpr: null, cw: null, ch: null, base: null, baseCrisp: null,
  topD: null, baseD: null, cwD: null, plotD: null, nowD: null, nowXD: null,
  k: null, vc: null, tx: null, sShift: null, xMid: null, headY: null, peakY: null, peakDX: null,
};

/** Virtual dimensions, transforms and gradients for the current orientation (no layout reads). */
function measure() {
  if (!box) return;
  if (orient === 'h') { cw = box.width; ch = box.height; } else { ch = box.width; cw = box.height; }
  nowX = Math.round(cw * NOW_AT);
  // Virtual (x = time, y = amplitude from the top) → canvas, for the current orientation and side.
  let a = dpr, b = 0, c = 0, d = dpr, e = 0, f = 0;
  if (orient !== 'h') {
    const right = opt.align === 'right';
    a = 0; b = -dpr; c = right ? -dpr : dpr; d = 0; e = right ? ch * dpr : 0; f = cw * dpr;
  }
  G.a = a; G.b = b; G.c = c; G.d = d; G.e = e; G.f = f;
  G.ra = a / dpr; G.rb = b / dpr; G.rc = c / dpr; G.rd = d / dpr;
  G.xe = e + G.ra * half; G.xf = f + G.rb * half;
  G.ye = e + G.rc * half; G.yf = f + G.rd * half;
  G.dpr = dpr; G.cw = cw; G.ch = ch; G.base = ch - 1; G.baseCrisp = crisp(ch - 1);
  G.topD = chartTop * dpr; G.baseD = (ch - 1) * dpr; G.cwD = cw * dpr; G.plotD = (cw - GUTTER) * dpr;
  G.nowD = nowX * dpr; G.nowXD = Math.round(nowX * dpr);
  strainK = K.labelScale = K.vcScale = K.headScale = K.peakScale = NaN; // laid out for the old box
  frameTransform();
  fillGrad = ctx.createLinearGradient(0, 0, 0, ch);
  fillGrad.addColorStop(0, `rgb(${FG} / .3)`);
  fillGrad.addColorStop(1, `rgb(${FG} / .04)`);
  ghostGrad = ctx.createLinearGradient(0, 0, 0, ch);
  ghostGrad.addColorStop(0, `rgb(${FG} / .2)`);
  ghostGrad.addColorStop(1, `rgb(${FG} / .03)`);
}

function frameTransform() { if (box) ctx.setTransform(G.a, G.b, G.c, G.d, G.e, G.f); }
/** Device-pixel frames for crisp lines: an integer x (or y) lands exactly where crisp() puts it. */
function crispX() { ctx.setTransform(G.ra, G.rb, G.rc, G.rd, G.xe, G.xf); }
function crispY() { ctx.setTransform(G.ra, G.rb, G.rc, G.rd, G.ye, G.yf); }
const crisp = v => (Math.round(v * dpr) + half) / dpr;

// ---------------------------------------------------------------- attempt record
// counts[b]: presses in bin b. kps[b]: presses in the window ending with bin b (w bins = 1 real
// second), maintained incrementally so a press costs w adds and drawing reads it directly.
let counts = new Uint16Array(8192);
let kps = new Uint16Array(8192);
let used = 0, w = 20, total = 0, peak = 0, peakBin = -1, firstT = null;
const prev = new Int32Array(64).fill(-1);
let attemptChecksum = null;

function ensure(size) {
  if (size < counts.length) return;
  let next = counts.length;
  while (next <= size) next *= 2;
  const c = new Uint16Array(next); c.set(counts); counts = c;
  const k = new Uint16Array(next); k.set(kps); kps = k;
}

function resetAttempt() {
  counts.fill(0, 0, used + 1);
  kps.fill(0, 0, used + 1);
  used = 0; total = 0; peak = 0; peakBin = -1; firstT = null;
  w = Math.max(1, Math.round(1000 * rate / BIN));
  prev.fill(-1);
  attemptChecksum = values['/beatmap/checksum'] ?? null;
  baseline();
  dirty = true;
}

function baseline() {
  const keys = values['/keys/all'];
  if (!Array.isArray(keys)) return;
  for (let i = 0; i < keys.length && i < prev.length; i++) {
    const count = keys[i]?.count;
    prev[i] = Number.isInteger(count) && count >= 0 ? count : -1;
  }
}

const binOf = t => Math.max(0, Math.floor((t - ORIGIN) / BIN));
const timeOf = b => ORIGIN + (b + 1) * BIN; // a kps bin describes the window ending here

/** n presses in bin b (callers pass the bin: a fractional time argument would be boxed). */
function addPresses(b, n) {
  const end = b + w;
  ensure(end);
  counts[b] += n;
  for (let j = b; j < end; j++) {
    const v = (kps[j] += n);
    if (v > peak) { peak = v; peakBin = j; }
  }
  if (end - 1 > used) used = end - 1;
  total += n;
  dirty = true;
}

function takeKeys(now) {
  const keys = values['/keys/all'];
  if (!Array.isArray(keys)) return;
  estimate(now);
  const est = S.est;
  let shrank = false;
  for (let i = 0; i < keys.length && i < prev.length; i++) {
    const count = keys[i]?.count;
    if (Number.isInteger(count) && prev[i] >= 0 && count < prev[i]) shrank = true;
  }
  // A count going backwards is a retry: vosu restarts every column from zero.
  if (shrank) { resetAttempt(); prev.fill(0); }
  for (let i = 0; i < keys.length && i < prev.length; i++) {
    const key = keys[i];
    const count = key?.count;
    if (!Number.isInteger(count) || count < 0) continue;
    if (prev[i] < 0) { prev[i] = count; continue; }
    const delta = count - prev[i];
    prev[i] = count;
    if (delta <= 0 || est !== est) continue;
    // A single new press carries its exact gameplay timestamp; bursts between samples land now.
    const at = key.pressedAt;
    const exact = delta === 1 && typeof at === 'number' && at <= est + 500 && at >= est - 1000;
    const time = exact ? at : est;
    if (firstT === null || time < firstT) firstT = time;
    addPresses(Math.max(0, Math.floor((time - ORIGIN) / BIN)), delta);
  }
}

// ---------------------------------------------------------------- clock
// Numbers that change every frame or message live in S's number fields, which are written in
// place (a module `let` given a fractional number allocates a fresh one on every write).
// NaN stands for "no sample yet".
const S = { liveT: NaN, liveAt: 0, shownT: NaN, est: NaN, lastFrame: 0, dt: 16, scale: 10, avg: NaN, end: NaN };
let rate = 1;
/** S.est: the map time at `now`, run on from the last vosu sample for at most HOLD ms (NaN without one). */
function estimate(now) {
  S.est = S.liveT + Math.min(Math.max(0, now - S.liveAt), HOLD) * rate;
}

// ---------------------------------------------------------------- strain backdrop
let sx = new Float64Array(0), sy = new Float32Array(0), sn = 0, smax = 0;
function takeStrain() {
  sn = 0; smax = 0; strainK = NaN;
  const series = values['/performance/graph/series'];
  const xaxis = values['/performance/graph/xaxis'];
  if (!Array.isArray(series) || !Array.isArray(xaxis) || !xaxis.length) return;
  const data = (series.find(s => s?.name === 'strains') ?? series[0])?.data;
  if (!Array.isArray(data)) return;
  const n = Math.min(data.length, xaxis.length);
  if (sx.length < n) { sx = new Float64Array(n); sy = new Float32Array(n); }
  for (let i = 0; i < n; i++) {
    // xaxis is rate-adjusted (real) ms; padding samples are negative sentinels.
    sx[i] = xaxis[i] * rate;
    const v = data[i];
    sy[i] = typeof v === 'number' && v > 0 ? v : 0;
    if (sy[i] > smax) smax = sy[i];
  }
  sn = n;
}

// ---------------------------------------------------------------- state
let values = {};
let status = 'connecting';
let view = 'init';
let dirty = true, axisDirty = true;
let scaleTarget = 10;

function decideView() {
  if (status !== 'live') return 'offline';
  const state = values['/state/number'];
  const mode = activeMode(state, values['/play/mode/number'], values['/settings/mode/number']);
  if (state === undefined || mode === null) return 'empty';
  if (mode !== 'mania') return 'hidden';
  if (isPlaying(state)) return 'live';
  const sameMap = total > 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
  // Song select and results only on request: the page keeps its gameplay box, which on those
  // screens usually sits over osu!'s own panels (local ranking, results card, back button).
  if (!opt.menus) return 'hidden';
  // Results: osu! shows judgements, not keys per second; without a recorded run there is nothing to add.
  if (RESULTS.has(state)) return sameMap ? 'summary' : 'hidden';
  // Song select: the map's density and note rate (osu! shows neither), plus the last run on it.
  if (SELECT.has(state)) return sameMap || sn > 0 || mapRate() !== null ? 'select' : 'hidden';
  return 'hidden';
}

function setView(next) {
  if (next === view) return;
  const from = view;
  view = next;
  attr(block, 'data-view', next);
  if (next === 'live' && from !== 'live') { S.liveT = NaN; S.shownT = NaN; resetAttempt(); }
  chip.hidden = next !== 'offline' && next !== 'empty';
  if (next === 'offline') {
    attr(chip, 'data-state', status);
    put(el.chip, status === 'offline' ? 'vosu offline' : 'Connecting to vosu');
  } else if (next === 'empty') {
    attr(chip, 'data-state', 'idle');
    put(el.chip, 'osu! not running');
  }
  axisDirty = true;
  dirty = true;
  if (from === 'live' || from === 'summary' || from === 'select') {
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' });
  }
}

// ---------------------------------------------------------------- render loop
let raf = 0;
function kick() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  S.dt = 16;
  if (S.lastFrame) S.dt = Math.min(100, now - S.lastFrame);
  S.lastFrame = now;
  let again = false;
  if (view === 'live') again = renderLive(now);
  else if (dirty) renderStill();
  dirty = false;
  if (again) raf = requestAnimationFrame(frame);
  else S.lastFrame = 0;
}

function targetScale() {
  const want = Math.max(8, peak * 1.14);
  const step = want <= 12 ? 2 : want <= 30 ? 5 : want <= 60 ? 10 : 20;
  return (Math.ceil(want / step) * step) | 0; // an int32 return is passed unboxed
}

const chartTop = 6;
const yOf = v => ch - 1 - (v / S.scale) * (ch - 1 - chartTop);
/** The device row crisp(yOf(v)) lies on, for drawing in the crispY frame (v an integer). */
const rowOf = v => Math.round((ch - 1 - (v / S.scale) * (ch - 1 - chartTop)) * dpr) | 0;
/** rowOf(S.avg), read in place: passing the fractional average as an argument would box it. */
const avgRow = () => Math.round((ch - 1 - (S.avg / S.scale) * (ch - 1 - chartTop)) * dpr) | 0;

const NUMBERS = Array.from({ length: 401 }, (_, i) => String(i));
const STEPS = [2, 5, 10, 20, 50, 100];
/** Scale step for the strip's thickness: at least 30 px between lines so labels never crowd. */
function gridStep() {
  const usable = ch - 1 - chartTop;
  let i = S.scale <= 12 ? 0 : S.scale <= 30 ? 1 : S.scale <= 60 ? 2 : 3; // the scale's own nice step
  while (i < STEPS.length - 1 && (STEPS[i] / S.scale) * usable < 30) i++;
  return STEPS[i];
}
/** Scale lines from x 0 to x1D (device pixels). */
function drawGridH(x1D) {
  const step = gridStep();
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.gridH;
  ctx.beginPath();
  crispY();
  for (let v = step; v < S.scale + 0.001; v += step) {
    const row = rowOf(v);
    if ((row + half) / dpr < chartTop - 2) break;
    ctx.moveTo(0, row); ctx.lineTo(x1D, row);
  }
  frameTransform();
  ctx.stroke();
}

// KPS scale values at the strip's future end (the overview's gutter), always drawn upright. Laid
// out only when the scale or the box changes; LX/LY keep the positions boxed for the text calls.
const LT = new Array(64).fill(''), LX = new Array(64).fill(null), LY = new Array(64).fill(null);
let labelCount = 0;
function layoutLabels() {
  K.labelScale = S.scale;
  labelCount = 0;
  const step = gridStep();
  for (let v = step; v < S.scale + 0.001 && v < NUMBERS.length && labelCount < LT.length; v += step) {
    const y = yOf(v);
    if (y < 10) break;
    let x = cw - GUTTER / 2, top = y;
    if (orient !== 'h') { x = opt.align === 'right' ? ch - y : y; top = 3; }
    LT[labelCount] = NUMBERS[v]; LX[labelCount] = x; LY[labelCount] = top;
    labelCount++;
  }
}
function drawGridLabels() {
  if (K.labelScale !== S.scale) layoutLabels();
  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.font = monoFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = orient === 'h' ? 'middle' : 'top';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.under;
  ctx.fillStyle = C.label;
  for (let i = 0; i < labelCount; i++) {
    ctx.strokeText(LT[i], LX[i], LY[i]);
    ctx.fillText(LT[i], LX[i], LY[i]);
  }
  frameTransform();
}

function drawBase() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.base;
  ctx.beginPath();
  ctx.moveTo(0, G.baseCrisp); ctx.lineTo(G.cw, G.baseCrisp);
  ctx.stroke();
}

// The strain silhouette, built once per scale (k px per map ms) at absolute x = t·k; drawing
// translates it by −t0·k. The edge is its own path: it has no segments along the base.
let strainArea = null, strainEdge = null, strainK = NaN;
function buildStrain(k) {
  strainK = k;
  strainArea = strainEdge = null;
  if (sn < 2 || smax <= 0) return;
  const top = (ch - 1 - chartTop) * 0.92;
  const base = ch - 1;
  strainArea = new Path2D();
  strainEdge = new Path2D();
  strainArea.moveTo(sx[0] * k, base);
  for (let j = 0; j < sn; j++) {
    const x = sx[j] * k, y = base - (sy[j] / smax) * top;
    strainArea.lineTo(x, y);
    if (j === 0) strainEdge.moveTo(x, y); else strainEdge.lineTo(x, y);
  }
  strainArea.lineTo(sx[sn - 1] * k, base);
  strainArea.closePath();
}
/** The strain area under a transform already shifted by −t0·k; `strong` when it is the subject. */
function drawStrain(strong) {
  ctx.fillStyle = strong ? C.strainFillStrong : C.strainFill;
  ctx.fill(strainArea);
  ctx.lineWidth = 1;
  ctx.strokeStyle = strong ? C.strainEdgeStrong : C.strainEdge;
  ctx.stroke(strainEdge);
}

/** A level line at device row `row` from x 0 to x1D (device pixels). */
function drawLevel(row, color, dash, x1D) {
  ctx.setLineDash(dash);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.beginPath();
  crispY();
  ctx.moveTo(0, row); ctx.lineTo(x1D, row);
  frameTransform();
  ctx.stroke();
  ctx.setLineDash(DASH_NONE);
}

const PEAK_MARK = new Path2D();
PEAK_MARK.moveTo(-4.5, -9); PEAK_MARK.lineTo(4.5, -9); PEAK_MARK.lineTo(0, -3.5); PEAK_MARK.closePath();
/** The peak's marker, under a transform already moved to the peak. */
function drawPeakMark() {
  ctx.fillStyle = C.hl;
  ctx.fill(PEAK_MARK);
}

const TAU = Math.PI * 2;
const W_LIVE = 1.75, W_LIVE_UNDER = 4.25, W_GHOST = 1.5, W_GHOST_UNDER = 4;
/** Area + line through n points added by trace(n, area), with a dark underlay so it reads on any map. */
function drawCurve(trace, n, fill, stroke, width, under) {
  if (n < 2) return;
  ctx.beginPath();
  trace(n, true);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  trace(n, false);
  ctx.lineJoin = 'round';
  ctx.lineWidth = under;
  ctx.strokeStyle = C.under;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

// Results / song select: the whole attempt as straight segments through virtual points.
const px = new Float32Array(4096);
const py = new Float32Array(4096);
function stillTrace(n, area) {
  ctx.moveTo(px[0], py[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(px[i], py[i]);
  if (!area) return;
  const base = ch - 1;
  ctx.lineTo(px[n - 1], base);
  ctx.lineTo(px[0], base);
  ctx.closePath();
}

// Live trace: n − 1 points in the bin frame (x = map ms after the frame's reference bin end, y =
// twice the window sum, so every point and every quadratic midpoint is an integer), then the head
// at (nowX, headY) in the virtual frame. The bin frame maps x·k + tx and base + y·vc.
const TX = new Int32Array(4096);
const TY = new Int32Array(4096);
function binFrame() { ctx.transform(G.k, 0, 0, G.vc, G.tx, G.base); }
function liveTrace(n, area) {
  binFrame();
  ctx.moveTo(TX[0], TY[0]);
  if (n >= 3) {
    for (let i = 1; i < n - 2; i++) ctx.quadraticCurveTo(TX[i], TY[i], (TX[i] + TX[i + 1]) >> 1, (TY[i] + TY[i + 1]) >> 1);
    ctx.quadraticCurveTo(TX[n - 2], TY[n - 2], G.xMid, (TY[n - 2] >> 1) + headSum);
  }
  frameTransform();
  ctx.lineTo(nowX, G.headY);
  if (!area) return;
  ctx.lineTo(nowX, G.base);
  binFrame();
  ctx.lineTo(TX[0], 0);
  ctx.closePath();
  frameTransform();
}

const SMOOTH = 6; // bins (300 ms) of display smoothing; readouts stay exact
/** Sum of kps over the m bins ending at e (the trace shows its mean). */
function sumTo(e, m) {
  let sum = 0;
  for (let j = Math.max(0, e - m + 1); j <= e; j++) sum += kps[j];
  return sum;
}

// Boxed values in G recomputed only when what they depend on changes. The fractional keys sit in
// K's number fields (written in place); measure() resets the scales for the new box.
const K = { vcScale: NaN, headScale: NaN, peakScale: NaN, peakDXK: NaN, shiftK: NaN, labelScale: NaN };
let vcM = 0, headSum = -1, headDen = 0, peakFor = -1, peakDXBin = -1, peakDXRef = -1, shiftRef = -1;

function clearCanvas() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  frameTransform();
}

function renderLive(now) {
  estimate(now);
  let t = S.est;
  if (t < S.shownT && S.shownT - t < 400) t = S.shownT; // never jitter backwards
  S.shownT = t;
  scaleTarget = targetScale();
  S.scale += (scaleTarget - S.scale) * (1 - Math.exp(-S.dt / 140));
  if (Math.abs(scaleTarget - S.scale) < 0.01) S.scale = scaleTarget;
  const scaling = S.scale !== scaleTarget;

  clearCanvas();
  const keysPresent = Array.isArray(values['/keys/all']);
  if (t !== t || !cw) {
    drawBase();
    readouts(-1, keysPresent);
    return scaling;
  }
  const span = spanS * 1000 * rate;       // map ms of history
  const k = nowX / span;                  // px per map ms
  const t0 = t - span;
  const t1 = t + (cw - nowX) / k;
  if (k !== G.k) G.k = k;
  // The bin frame's reference: the end of the first trace slice that can be in view. Its offset
  // tx is the one fractional argument every frame needs.
  const stride = Math.max(1, Math.ceil(2.5 / (k * BIN)));
  let ref = Math.max(0, Math.floor((t0 - stride * BIN - ORIGIN) / BIN));
  ref -= ref % stride;
  const xRef = ORIGIN + (ref + stride) * BIN;
  G.tx = (xRef - t0) * k;

  // Chart-recorder grid anchored to time: 1 s minor, 5 s (or 10 s) major.
  const second = 1000 * rate;
  const major = spanS > 30 ? 10 : 5;
  ctx.lineWidth = 1;
  if (k * second >= 8) {
    ctx.strokeStyle = C.gridMinor;
    ctx.beginPath();
    crispX();
    for (let s = Math.ceil(t0 / second); s * second <= t1; s++) {
      if (s % major === 0) continue;
      const x = Math.round((s * second - t0) * k * dpr) | 0;
      ctx.moveTo(x, G.topD); ctx.lineTo(x, G.baseD);
    }
    frameTransform();
    ctx.stroke();
  }
  ctx.strokeStyle = C.gridMajor;
  ctx.beginPath();
  crispX();
  for (let s = Math.ceil(t0 / (second * major)); s * second * major <= t1; s++) {
    const x = Math.round((s * second * major - t0) * k * dpr) | 0;
    ctx.moveTo(x, G.topD); ctx.lineTo(x, G.baseD);
  }
  frameTransform();
  ctx.stroke();

  if (opt.strain) {
    if (k !== strainK) buildStrain(k);
    if (strainArea) {
      if (xRef !== shiftRef || k !== K.shiftK) { shiftRef = xRef; K.shiftK = k; G.sShift = -xRef * k; }
      ctx.translate(G.tx, 0); ctx.translate(G.sShift, 0); // −t0·k
      drawStrain(false);
      frameTransform();
    }
  }
  drawGridH(G.cwD);

  const nowBin = Math.max(0, Math.floor((t - ORIGIN) / BIN));
  const current = keysPresent && nowBin <= used ? kps[nowBin] : 0;
  average(false);
  if (keysPresent && S.avg === S.avg) drawLevel(avgRow(), C.avg, DASH_AVG, G.nowD);
  if (keysPresent && peak > 0) drawLevel(rowOf(peak), C.peak, DASH_PEAK, G.nowD);

  // The live head sits on the trace's last mean (or the bare window count before the first press).
  // G.headY / G.peakY change only with it or the scale; computed here rather than in helpers,
  // since renderLive is optimised long before a small helper is and unoptimised arithmetic boxes.
  const m = Math.max(stride, SMOOTH);
  const tracing = keysPresent && firstT !== null;
  if (keysPresent) {
    const num = tracing ? sumTo(nowBin, m) : current;
    const den = tracing ? m : 1;
    if (num !== headSum || den !== headDen || S.scale !== K.headScale) {
      headSum = num; headDen = den; K.headScale = S.scale;
      G.headY = ch - 1 - ((num / den) / S.scale) * (ch - 1 - chartTop);
    }
  }

  // KPS trace: points every `stride` bins, anchored to absolute bins so the shape never shimmers;
  // each point averages the last SMOOTH bins of window values so ±1 count flicker reads as a line.
  if (tracing) {
    let b = Math.max(0, Math.floor((Math.max(t0 - stride * BIN, firstT - 1000 * rate) - ORIGIN) / BIN));
    b -= b % stride;
    let n = 0;
    for (; b + stride <= nowBin && n < TX.length - 1; b += stride) {
      const e = b + stride - 1;
      TX[n] = ORIGIN + (e + 1) * BIN - xRef;
      TY[n] = 2 * sumTo(e, m);
      n++;
    }
    if (S.scale !== K.vcScale || m !== vcM) { K.vcScale = S.scale; vcM = m; G.vc = -(ch - 1 - chartTop) / (2 * m * S.scale); }
    if (n >= 2) G.xMid = (TX[n - 1] + (t - xRef)) / 2; // last point ↔ head
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, nowX, G.ch); ctx.clip();
    drawCurve(liveTrace, n + 1, fillGrad, C.line, W_LIVE, W_LIVE_UNDER);
    ctx.restore();
    if (peakBin >= 0) {
      const x = (timeOf(peakBin) - t0) * k;
      if (x >= 0 && x <= nowX) {
        if (peak !== peakFor || S.scale !== K.peakScale) {
          peakFor = peak; K.peakScale = S.scale;
          G.peakY = ch - 1 - (peak / S.scale) * (ch - 1 - chartTop);
        }
        if (peakBin !== peakDXBin || xRef !== peakDXRef || k !== K.peakDXK) {
          peakDXBin = peakBin; peakDXRef = xRef; K.peakDXK = k;
          G.peakDX = k * (timeOf(peakBin) - xRef);
        }
        ctx.translate(G.tx, G.peakY); ctx.translate(G.peakDX, 0);
        drawPeakMark();
        frameTransform();
      }
    }
  }

  // Now line and live head.
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.now;
  ctx.beginPath();
  crispX();
  ctx.moveTo(G.nowXD, 0); ctx.lineTo(G.nowXD, G.baseD);
  frameTransform();
  ctx.stroke();
  if (keysPresent) {
    ctx.fillStyle = C.halo;
    ctx.beginPath(); ctx.arc(nowX, G.headY, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = C.hl;
    ctx.beginPath(); ctx.arc(nowX, G.headY, 3, 0, TAU); ctx.fill();
  }
  drawBase();
  if (keysPresent) drawGridLabels();
  readouts(current, keysPresent);
  const advancing = S.liveT === S.liveT && now - S.liveAt < HOLD;
  return advancing || scaling;
}

/** S.avg: presses per real second since the first press, up to the shown time (or the end of the
 * map when `toEnd`); NaN while there is too little to say. */
function average(toEnd) {
  S.avg = NaN;
  if (firstT === null || total < 2) return;
  // Separate stores, not `toEnd ? Infinity : S.shownT`: that merge would box the shown time.
  if (toEnd) S.end = Infinity; else S.end = S.shownT;
  const lastObject = values['/beatmap/time/lastObject'];
  if (typeof lastObject === 'number' && lastObject + 500 < S.end) S.end = lastObject + 500;
  const seconds = (S.end - firstT) / rate / 1000;
  if (seconds >= 1) S.avg = total / seconds;
}

/** The map's average note rate in notes per real second (one press per mania object). */
function mapRate() {
  const objects = values['/beatmap/stats/objects/total'];
  const first = values['/beatmap/time/firstObject'];
  const last = values['/beatmap/time/lastObject'];
  if (typeof objects !== 'number' || typeof first !== 'number' || typeof last !== 'number' || last - first < 1000 || objects < 1) return null;
  return objects / ((last - first) / rate / 1000);
}

function renderStill() {
  clearCanvas();
  if (!cw || (view !== 'summary' && view !== 'select')) { readouts(-1, true); return; }
  const run = total > 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
  S.scale = scaleTarget = targetScale();
  const mp3 = values['/beatmap/time/mp3Length'];
  let t0 = sn ? Math.min(0, sx[0]) : 0;
  let t1 = typeof mp3 === 'number' && mp3 > 0 ? mp3 : 0;
  if (sn) t1 = Math.max(t1, sx[sn - 1]);
  if (run) { t0 = Math.min(t0, firstT - 1000); t1 = Math.max(t1, timeOf(used)); }
  if (t1 > t0) {
    // Time runs upward over the whole map; the top GUTTER px hold the KPS scale.
    const k = (cw - GUTTER) / (t1 - t0);
    if (opt.strain) {
      if (k !== strainK) buildStrain(k);
      if (strainArea) { ctx.translate(-t0 * k, 0); drawStrain(!run); frameTransform(); }
    }
    if (run) {
      drawGridH(G.plotD);
      average(true);
      if (S.avg === S.avg) drawLevel(avgRow(), C.avg, DASH_AVG, G.plotD);
      drawLevel(rowOf(peak), C.peak, DASH_PEAK, G.plotD);
      // Whole attempt, ~2 px per point: the highest window value in each slice, so the envelope
      // meets the peak marker exactly.
      const per = Math.max(1, Math.round(2 / (k * BIN)));
      let n = 0;
      let b = binOf(firstT - 1000 * rate);
      b -= b % per;
      for (; b <= used && n < px.length - 1; b += per) {
        let top = 0;
        for (let j = b; j < b + per; j++) if (kps[j] > top) top = kps[j];
        px[n] = (timeOf(b + per - 1) - t0) * k;
        py[n] = yOf(top);
        n++;
      }
      px[n] = px[n - 1] + 1; py[n] = ch - 1; n++; // the run ends on the baseline
      drawCurve(stillTrace, n, ghostGrad, C.ghost, W_GHOST, W_GHOST_UNDER);
      if (peakBin >= 0) {
        ctx.translate((timeOf(peakBin - (peakBin % per) + per - 1) - t0) * k, yOf(peak));
        drawPeakMark();
        frameTransform();
      }
    }
  }
  drawBase();
  if (run) drawGridLabels();
  if (axisDirty) {
    axisDirty = false;
    const has = t1 > t0;
    put(el.axisL, has ? formatDuration(Math.max(0, t0) / rate) : '');
    put(el.axisM, has ? formatDuration(Math.max(0, (t0 + t1) / 2) / rate) : '');
    put(el.axisR, has ? formatDuration(t1 / rate) : '');
    put(el.axisN, '');
  }
  readouts(-1, true);
}

// ---------------------------------------------------------------- DOM readouts
function columns() {
  const keys = values['/keys/all'];
  if (isPlaying(values['/state/number']) && Array.isArray(keys) && keys.length) return keys.length;
  const cs = values['/beatmap/stats/cs/converted'];
  return typeof cs === 'number' && cs > 0 ? Math.round(cs) : null;
}

const SOURCES = { replay: 'Replay', spectator: 'Spectating', watching: 'Watching', autoplay: 'Autoplay' };
const NONE = '—';
/** A readout value; placeholders render dimmed. */
function show(node, value) {
  if (node._text === value) return;
  put(node, value);
  attr(node, 'data-none', value === NONE ? '' : null);
}
const intText = v => (v >= 0 && v < NUMBERS.length ? NUMBERS[v] : String(v));
// One-decimal text cached by tenths per slot, so a steady value allocates nothing per frame.
// Callers pass tenths (an integer; negative for none): a fractional argument would be boxed.
function decimal(cache, key) {
  if (key < 0) return NONE;
  if (key !== cache.key) { cache.key = key; cache.text = (key / 10).toFixed(1); }
  return cache.text;
}
const avgTenths = () => (S.avg === S.avg ? Math.round(S.avg * 10) : -1);
function mapTenths() {
  const r = mapRate();
  return r === null ? -1 : Math.round(r * 10);
}
const avgText = { key: NaN, text: NONE };
const mapText = { key: NaN, text: NONE };
let phaseLabel = '', phaseColumns = -1, phaseRate = NaN;

function phase(label) {
  const keyCount = columns();
  if (label === phaseLabel && keyCount === phaseColumns && rate === phaseRate) return;
  phaseLabel = label; phaseColumns = keyCount; phaseRate = rate;
  const rateText = Math.abs(rate - 1) > 0.001 ? ` · ${rate.toFixed(2)}×` : '';
  put(el.phase, keyCount ? `${label} · ${keyCount}K${rateText}` : `${label}${rateText}`);
}

function labels(p, a, b, aKey, bKey, unit) {
  put(el.pLabel, p); put(el.aLabel, a); put(el.bLabel, b);
  attr(el.aLabel, 'data-key', aKey); attr(el.bLabel, 'data-key', bKey);
  put(el.pUnit, unit);
}

/** `current`: the live window's count, or −1 when there is none to show. */
function readouts(current, keysPresent) {
  if (view === 'live') {
    phase(SOURCES[values['/play/source']] ?? 'Live');
    labels('Now', 'Peak', 'Avg', 'peak', 'avg', 'kps');
    attr(el.aValue, 'data-peak', '');
    const live = keysPresent && current >= 0;
    show(el.pValue, live ? intText(current) : NONE);
    show(el.aValue, live && peak > 0 ? intText(peak) : NONE);
    show(el.bValue, live ? decimal(avgText, avgTenths()) : NONE);
    attr(block, 'data-hot', live && peak >= 5 && current === peak ? '' : null);
    if (note.hidden !== keysPresent) note.hidden = keysPresent;
    if (!keysPresent) put(note, 'No key data. Enable ENABLE_KEY_OVERLAY in vosu.');
    if (axisDirty) {
      axisDirty = false;
      put(el.axisL, `−${spanS}s`);
      put(el.axisM, `−${spanS / 2}s`);
      put(el.axisN, 'Now');
      const ahead = spanS * (1 - NOW_AT) / NOW_AT;
      put(el.axisR, `+${ahead < 10 ? ahead.toFixed(1) : Math.round(ahead)}s`);
    }
    return;
  }
  if (!note.hidden) note.hidden = true;
  attr(block, 'data-hot', null);
  attr(el.aValue, 'data-peak', null);
  if (view === 'summary') {
    phase('Result');
    labels('Peak', 'Avg', 'Keys', 'avg', 'none', 'kps');
    show(el.pValue, intText(peak));
    average(true);
    show(el.aValue, decimal(avgText, avgTenths()));
    show(el.bValue, intText(total));
    return;
  }
  if (view === 'select') {
    // osu! shows object counts and length, not the rate they add up to, nor where it peaks.
    const run = total > 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
    phase(RESULTS.has(values['/state/number']) ? 'Result' : 'Map');
    if (run) {
      labels('Map avg', 'Peak', 'Avg', 'peak', 'avg', 'nps');
      show(el.aValue, intText(peak));
      average(true);
      show(el.bValue, decimal(avgText, avgTenths()));
    } else {
      labels('Map avg', '', '', 'none', 'none', 'nps');
      put(el.aValue, ''); put(el.bValue, '');
    }
    show(el.pValue, decimal(mapText, mapTenths()));
  }
}

// ---------------------------------------------------------------- wiring
recolor();
settings(DEFAULTS, applySettings);
subscribe(POINTERS, (next, changed) => {
  values = next;
  const now = performance.now();
  if (changed.has('/beatmap/time/rate') || changed.has('/play/mods/rate')) {
    const r = values['/beatmap/time/rate'] ?? values['/play/mods/rate'];
    const fresh = typeof r === 'number' && r > 0 ? r : 1;
    if (fresh !== rate) { rate = fresh; takeStrain(); if (total === 0) w = Math.max(1, Math.round(1000 * rate / BIN)); dirty = axisDirty = true; }
  }
  if (changed.has('/performance/graph/series') || changed.has('/performance/graph/xaxis')) { takeStrain(); dirty = axisDirty = true; }
  setView(decideView());
  if (changed.has('/beatmap/time/live')) {
    const t = values['/beatmap/time/live'];
    if (typeof t === 'number') {
      // A large backwards jump during play is a retry or rewind.
      if (view === 'live' && t < S.liveT - 1500) { resetAttempt(); S.shownT = NaN; }
      S.liveT = t; S.liveAt = now;
    } else S.liveT = NaN;
  }
  if (view === 'live' && changed.has('/keys/all')) takeKeys(now);
  if (changed.has('/beatmap/checksum')) { loadPalette(); dirty = axisDirty = true; }
  if (changed.has('/beatmap/time/mp3Length') || changed.has('/beatmap/stats/objects/total') || changed.has('/beatmap/time/lastObject') || changed.has('/play/source')) dirty = axisDirty = true;
  if (view === 'live' || dirty) kick();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    setView(decideView());
    kick();
  },
});

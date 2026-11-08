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
let cw = 0, ch = 0, dpr = 1, half = 0.5, fillGrad = null, ghostGrad = null, orient = 'v';
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

/** Virtual dimensions and gradients for the current orientation (no layout reads). */
function measure() {
  if (!box) return;
  if (orient === 'h') { cw = box.width; ch = box.height; } else { ch = box.width; cw = box.height; }
  frameTransform();
  fillGrad = ctx.createLinearGradient(0, 0, 0, ch);
  fillGrad.addColorStop(0, `rgb(${FG} / .3)`);
  fillGrad.addColorStop(1, `rgb(${FG} / .04)`);
  ghostGrad = ctx.createLinearGradient(0, 0, 0, ch);
  ghostGrad.addColorStop(0, `rgb(${FG} / .2)`);
  ghostGrad.addColorStop(1, `rgb(${FG} / .03)`);
}

/** Virtual (x = time, y = amplitude from the top) → canvas, for the current orientation and side. */
function frameTransform() {
  if (orient === 'h') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else if (opt.align === 'right') ctx.setTransform(0, -dpr, -dpr, 0, ch * dpr, cw * dpr);
  else ctx.setTransform(0, -dpr, dpr, 0, 0, cw * dpr);
}
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

function addPresses(t, n) {
  const b = binOf(t);
  const end = b + w;
  ensure(end);
  counts[b] += n;
  for (let j = b; j < end; j++) {
    const v = (kps[j] += n);
    if (v > peak) { peak = v; peakBin = j; }
  }
  if (end - 1 > used) used = end - 1;
  total += n;
  if (firstT === null || t < firstT) firstT = t;
  dirty = true;
}

function takeKeys(now) {
  const keys = values['/keys/all'];
  if (!Array.isArray(keys)) return;
  const est = estimate(now);
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
    if (delta <= 0 || est === null) continue;
    // A single new press carries its exact gameplay timestamp; bursts between samples land now.
    const at = key.pressedAt;
    const exact = delta === 1 && typeof at === 'number' && at <= est + 500 && at >= est - 1000;
    addPresses(exact ? at : est, delta);
  }
}

// ---------------------------------------------------------------- clock
let liveT = null, liveAt = 0, shownT = null, rate = 1;
function estimate(now) {
  if (liveT === null) return null;
  return liveT + Math.min(Math.max(0, now - liveAt), HOLD) * rate;
}

// ---------------------------------------------------------------- strain backdrop
let sx = new Float64Array(0), sy = new Float32Array(0), sn = 0, smax = 0;
function takeStrain() {
  sn = 0; smax = 0;
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
function strainIndex(t) {
  let lo = 0, hi = sn;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sx[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---------------------------------------------------------------- state
let values = {};
let status = 'connecting';
let view = 'init';
let dirty = true, axisDirty = true;
let scale = 10, scaleTarget = 10, lastFrame = 0;

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
  if (next === 'live' && from !== 'live') { liveT = null; shownT = null; resetAttempt(); }
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
  const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
  lastFrame = now;
  let again = false;
  if (view === 'live') again = renderLive(now, dt);
  else if (dirty) renderStill();
  dirty = false;
  if (again) raf = requestAnimationFrame(frame);
  else lastFrame = 0;
}

function niceStep(top) { return top <= 12 ? 2 : top <= 30 ? 5 : top <= 60 ? 10 : 20; }
function targetScale() {
  const want = Math.max(8, peak * 1.14);
  const step = niceStep(want);
  return Math.ceil(want / step) * step;
}

const chartTop = 6;
const yOf = v => ch - 1 - (v / scale) * (ch - 1 - chartTop);

const NUMBERS = Array.from({ length: 401 }, (_, i) => String(i));
const STEPS = [2, 5, 10, 20, 50, 100];
/** Scale step for the strip's thickness: at least 30 px between lines so labels never crowd. */
function gridStep() {
  const usable = ch - 1 - chartTop;
  let i = STEPS.indexOf(niceStep(scale));
  while (i < STEPS.length - 1 && (STEPS[i] / scale) * usable < 30) i++;
  return STEPS[i];
}
function drawGridH(x0, x1) {
  const step = gridStep();
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.gridH;
  ctx.beginPath();
  for (let v = step; v < scale + 0.001; v += step) {
    const y = crisp(yOf(v));
    if (y < chartTop - 2) break;
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  }
  ctx.stroke();
}
/** KPS scale values at the strip's future end (the overview's gutter), always drawn upright. */
function drawGridLabels() {
  const step = gridStep();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = monoFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = orient === 'h' ? 'middle' : 'top';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.under;
  ctx.fillStyle = C.label;
  for (let v = step; v < scale + 0.001 && v < NUMBERS.length; v += step) {
    const y = yOf(v);
    if (y < 10) break;
    let x = cw - GUTTER / 2, top = y;
    if (orient !== 'h') { x = opt.align === 'right' ? ch - y : y; top = 3; }
    ctx.strokeText(NUMBERS[v], x, top);
    ctx.fillText(NUMBERS[v], x, top);
  }
  frameTransform();
}

function drawBase() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.base;
  ctx.beginPath();
  const y = crisp(ch - 1);
  ctx.moveTo(0, y); ctx.lineTo(cw, y);
  ctx.stroke();
}

/** Strain area for map times [t0, t1] mapped by x = (t - t0) * k; `strong` when it is the subject. */
function drawStrain(t0, t1, k, strong) {
  if (!opt.strain || !sn || smax <= 0) return;
  const top = (ch - 1 - chartTop) * 0.92;
  const i = Math.max(0, strainIndex(t0) - 1);
  const end = Math.min(sn, strainIndex(t1) + 2);
  if (end - i < 2) return;
  const base = ch - 1;
  ctx.beginPath();
  ctx.moveTo((sx[i] - t0) * k, base);
  for (let j = i; j < end; j++) ctx.lineTo((sx[j] - t0) * k, base - (sy[j] / smax) * top);
  ctx.lineTo((sx[end - 1] - t0) * k, base);
  ctx.closePath();
  ctx.fillStyle = strong ? C.strainFillStrong : C.strainFill;
  ctx.fill();
  ctx.beginPath();
  for (let j = i; j < end; j++) {
    const x = (sx[j] - t0) * k, y = base - (sy[j] / smax) * top;
    if (j === i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = strong ? C.strainEdgeStrong : C.strainEdge;
  ctx.stroke();
}

function drawLevel(v, color, dash, x0, x1) {
  const y = crisp(yOf(v));
  ctx.setLineDash(dash);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
}

function drawPeakMark(x) {
  const y = yOf(peak);
  ctx.fillStyle = C.hl;
  ctx.beginPath();
  ctx.moveTo(x - 4.5, y - 9); ctx.lineTo(x + 4.5, y - 9); ctx.lineTo(x, y - 3.5);
  ctx.closePath();
  ctx.fill();
}

// Point buffers reused by every frame (no per-frame allocation).
const px = new Float32Array(4096);
const py = new Float32Array(4096);
function tracePath(n, smooth) {
  ctx.moveTo(px[0], py[0]);
  if (!smooth || n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(px[i], py[i]); return; }
  for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[i + 1]) / 2, (py[i] + py[i + 1]) / 2);
  ctx.lineTo(px[n - 1], py[n - 1]);
}
/** Area + line through the first n buffered points, with a dark underlay so it reads on any map. */
function drawCurve(n, fill, stroke, width, smooth) {
  if (n < 2) return;
  const base = ch - 1;
  ctx.beginPath();
  tracePath(n, smooth);
  ctx.lineTo(px[n - 1], base);
  ctx.lineTo(px[0], base);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  tracePath(n, smooth);
  ctx.lineJoin = 'round';
  ctx.lineWidth = width + 2.5;
  ctx.strokeStyle = C.under;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

const SMOOTH = 6; // bins (300 ms) of display smoothing; readouts stay exact
/** Mean of kps over the m bins ending at e. */
function meanTo(e, m) {
  let sum = 0;
  for (let j = Math.max(0, e - m + 1); j <= e; j++) sum += kps[j];
  return sum / m;
}

function clearCanvas() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  frameTransform();
}

function renderLive(now, dt) {
  const est = estimate(now);
  let t = est;
  if (t !== null && shownT !== null && t < shownT && shownT - t < 400) t = shownT; // never jitter backwards
  shownT = t;
  scaleTarget = targetScale();
  scale += (scaleTarget - scale) * (1 - Math.exp(-dt / 140));
  if (Math.abs(scaleTarget - scale) < 0.01) scale = scaleTarget;
  const scaling = scale !== scaleTarget;

  clearCanvas();
  const nowX = Math.round(cw * NOW_AT);
  const keysPresent = Array.isArray(values['/keys/all']);
  if (t === null || !cw) {
    drawBase();
    readouts(null, keysPresent);
    return scaling;
  }
  const span = spanS * 1000 * rate;       // map ms of history
  const k = nowX / span;                  // px per map ms
  const t0 = t - span;
  const t1 = t + (cw - nowX) / k;

  // Chart-recorder grid anchored to time: 1 s minor, 5 s (or 10 s) major.
  const second = 1000 * rate;
  const major = spanS > 30 ? 10 : 5;
  ctx.lineWidth = 1;
  if (k * second >= 8) {
    ctx.strokeStyle = C.gridMinor;
    ctx.beginPath();
    for (let s = Math.ceil(t0 / second); s * second <= t1; s++) {
      if (s % major === 0) continue;
      const x = crisp((s * second - t0) * k);
      ctx.moveTo(x, chartTop); ctx.lineTo(x, ch - 1);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = C.gridMajor;
  ctx.beginPath();
  for (let s = Math.ceil(t0 / (second * major)); s * second * major <= t1; s++) {
    const x = crisp((s * second * major - t0) * k);
    ctx.moveTo(x, chartTop); ctx.lineTo(x, ch - 1);
  }
  ctx.stroke();

  drawStrain(t0, t1, k);
  drawGridH(0, cw);

  const nowBin = binOf(t);
  const current = keysPresent && nowBin <= used ? kps[nowBin] : 0;
  const avg = average(t);
  if (keysPresent && avg !== null) drawLevel(avg, C.avg, DASH_AVG, 0, nowX);
  if (keysPresent && peak > 0) drawLevel(peak, C.peak, DASH_PEAK, 0, nowX);

  // KPS trace: points every `stride` bins, anchored to absolute bins so the shape never shimmers;
  // each point averages the last SMOOTH bins of window values so ±1 count flicker reads as a line.
  let headY = yOf(current);
  if (keysPresent && firstT !== null) {
    const stride = Math.max(1, Math.ceil(2.5 / (k * BIN)));
    const m = Math.max(stride, SMOOTH);
    let b = binOf(Math.max(t0 - stride * BIN, firstT - 1000 * rate));
    b -= b % stride;
    let n = 0;
    for (; b + stride <= nowBin && n < px.length - 1; b += stride) {
      const e = b + stride - 1;
      px[n] = (timeOf(e) - t0) * k;
      py[n] = yOf(meanTo(e, m));
      n++;
    }
    headY = yOf(meanTo(nowBin, m));
    px[n] = nowX; py[n] = headY; n++;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, nowX, ch); ctx.clip();
    drawCurve(n, fillGrad, C.line, 1.75, true);
    ctx.restore();
    if (peakBin >= 0) {
      const x = (timeOf(peakBin) - t0) * k;
      if (x >= 0 && x <= nowX) drawPeakMark(x);
    }
  }

  // Now line and live head.
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.now;
  ctx.beginPath();
  const nx = crisp(nowX);
  ctx.moveTo(nx, 0); ctx.lineTo(nx, ch - 1);
  ctx.stroke();
  if (keysPresent) {
    ctx.fillStyle = C.halo;
    ctx.beginPath(); ctx.arc(nowX, headY, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.hl;
    ctx.beginPath(); ctx.arc(nowX, headY, 3, 0, Math.PI * 2); ctx.fill();
  }
  drawBase();
  if (keysPresent) drawGridLabels();
  readouts(current, keysPresent, avg);
  const advancing = liveT !== null && now - liveAt < HOLD;
  return advancing || scaling;
}

function average(t) {
  if (firstT === null || total < 2) return null;
  const lastObject = values['/beatmap/time/lastObject'];
  const end = typeof lastObject === 'number' ? Math.min(t, lastObject + 500) : t;
  const seconds = (end - firstT) / rate / 1000;
  return seconds >= 1 ? total / seconds : null;
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
  if (!cw || (view !== 'summary' && view !== 'select')) { readouts(null, true); return; }
  const run = total > 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
  scale = scaleTarget = targetScale();
  const mp3 = values['/beatmap/time/mp3Length'];
  let t0 = sn ? Math.min(0, sx[0]) : 0;
  let t1 = typeof mp3 === 'number' && mp3 > 0 ? mp3 : 0;
  if (sn) t1 = Math.max(t1, sx[sn - 1]);
  if (run) { t0 = Math.min(t0, firstT - 1000); t1 = Math.max(t1, timeOf(used)); }
  if (t1 > t0) {
    // Time runs upward over the whole map; the top GUTTER px hold the KPS scale.
    const k = (cw - GUTTER) / (t1 - t0);
    drawStrain(t0, t1, k, !run);
    if (run) {
      drawGridH(0, cw - GUTTER);
      const avg = average(Infinity);
      if (avg !== null) drawLevel(avg, C.avg, DASH_AVG, 0, cw - GUTTER);
      drawLevel(peak, C.peak, DASH_PEAK, 0, cw - GUTTER);
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
      drawCurve(n, ghostGrad, C.ghost, 1.5, false);
      if (peakBin >= 0) drawPeakMark((timeOf(peakBin - (peakBin % per) + per - 1) - t0) * k);
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
  readouts(null, true);
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
// One-decimal text cached by tenths per slot so a steady average allocates nothing per frame.
function decimal(cache, v) {
  if (v === null || v === undefined) return NONE;
  const key = Math.round(v * 10);
  if (key !== cache.key) { cache.key = key; cache.text = (key / 10).toFixed(1); }
  return cache.text;
}
const avgText = { key: NaN, text: NONE };
const mapText = { key: NaN, text: NONE };
let phaseKey = '';

function phase(label) {
  const keyCount = columns();
  const rateText = Math.abs(rate - 1) > 0.001 ? ` · ${rate.toFixed(2)}×` : '';
  const key = `${label}|${keyCount}|${rateText}`;
  if (key === phaseKey) return;
  phaseKey = key;
  put(el.phase, keyCount ? `${label} · ${keyCount}K${rateText}` : `${label}${rateText}`);
}

function labels(p, a, b, aKey, bKey, unit) {
  put(el.pLabel, p); put(el.aLabel, a); put(el.bLabel, b);
  attr(el.aLabel, 'data-key', aKey); attr(el.bLabel, 'data-key', bKey);
  put(el.pUnit, unit);
}

function readouts(current, keysPresent, avg) {
  if (view === 'live') {
    phase(SOURCES[values['/play/source']] ?? 'Live');
    labels('Now', 'Peak', 'Avg', 'peak', 'avg', 'kps');
    attr(el.aValue, 'data-peak', '');
    const live = keysPresent && current !== null;
    show(el.pValue, live ? intText(current) : NONE);
    show(el.aValue, live && peak > 0 ? intText(peak) : NONE);
    show(el.bValue, live ? decimal(avgText, avg) : NONE);
    attr(block, 'data-hot', live && peak >= 5 && current === peak ? '' : null);
    note.hidden = keysPresent;
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
  note.hidden = true;
  attr(block, 'data-hot', null);
  attr(el.aValue, 'data-peak', null);
  if (view === 'summary') {
    phase('Result');
    labels('Peak', 'Avg', 'Keys', 'avg', 'none', 'kps');
    show(el.pValue, intText(peak));
    show(el.aValue, decimal(avgText, average(Infinity)));
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
      show(el.bValue, decimal(avgText, average(Infinity)));
    } else {
      labels('Map avg', '', '', 'none', 'none', 'nps');
      put(el.aValue, ''); put(el.bValue, '');
    }
    show(el.pValue, decimal(mapText, mapRate()));
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
      if (view === 'live' && liveT !== null && t < liveT - 1500) { resetAttempt(); shownT = null; }
      liveT = t; liveAt = now;
    } else liveT = null;
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

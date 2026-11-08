// Copyright (c) 2026 18-LAB. MIT.
// KPS graph: osu!mania keys per second over the attempt. Live KPS is the sum of /keys/all count
// deltas over a rolling one-second (real time) window, plotted as a scrolling area chart over the
// map's strain density, with the attempt's peak and average. Results hold the whole attempt.
import { subscribe, settings, fit, activeMode, isPlaying, formatDuration } from './vosu-overlay.js';

const WIDTH = 480;
const HEIGHT = 276;     // panel = 132 px of chrome + chart (48–144 px)
const BIN = 50;         // map ms per histogram bin
const ORIGIN = -10000;  // map time of bin 0, covers lead-in
const NOW_AT = 0.82;    // share of the plot that is history; the rest previews upcoming density
const HOLD = 250;       // ms the clock may run past the last vosu time sample (pauses stop it)
const RESULTS = 7;
const GUTTER = 22;      // px kept free at the summary's right edge for scale labels

const POINTERS = [
  '/state/number', '/play/mode/number', '/settings/mode/number', '/play/source',
  '/keys/all', '/beatmap/time/live', '/beatmap/time/rate', '/play/mods/rate',
  '/beatmap/time/firstObject', '/beatmap/time/lastObject', '/beatmap/time/mp3Length',
  '/beatmap/checksum', '/beatmap/stats/cs/converted',
  '/performance/graph/series', '/performance/graph/xaxis',
];

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const chip = $('chip');
const canvas = $('chart');
const note = $('note');
const el = {
  chip: $('chipText'), meta: $('meta'), phase: $('phase'), brand: $('brand'),
  pLabel: $('pLabel'), pValue: $('pValue'), aLabel: $('aLabel'), aValue: $('aValue'), bLabel: $('bLabel'), bValue: $('bValue'),
  axisL: $('axisL'), axisM: $('axisM'), axisN: $('axisN'), axisR: $('axisR'), note,
};
const ctx = canvas.getContext('2d', { alpha: true });

fit(stage, WIDTH, HEIGHT);

/** textContent only when the formatted string changed. */
function put(node, value) {
  if (node._text !== value) { node._text = value; node.textContent = value; }
}
function attr(node, name, value) {
  if (node._attrs?.[name] === value) return;
  (node._attrs ??= {})[name] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}

// ---------------------------------------------------------------- palette (read once from tokens)
function rgb(hex, fallback) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim()) || /^#([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m[1], 16);
  return `${n >> 16} ${(n >> 8) & 255} ${n & 255}`;
}
const css = getComputedStyle(document.documentElement);
const tok = (name, fallback) => rgb(css.getPropertyValue(name) || fallback, fallback);
const FG = tok('--fg', '#ebe8e1');
const FG_DIM = tok('--fg-dim', '#b8b5ad');
const MUTED = tok('--muted', '#7e8288');
const ACCENT = tok('--accent', '#ff963f');
const SIGNAL = tok('--signal', '#7fa6cf');
const SUNKEN = tok('--bg-sunken', '#0b0c0d');
const C = {
  future: `rgb(${SUNKEN} / .42)`,
  gridMinor: `rgb(${FG} / .035)`,
  gridMajor: `rgb(${FG} / .075)`,
  gridH: `rgb(${FG} / .06)`,
  base: `rgb(${MUTED} / .55)`,
  now: `rgb(${FG_DIM} / .5)`,
  label: `rgb(${MUTED} / .95)`,
  strainFill: `rgb(${SIGNAL} / .2)`,
  strainEdge: `rgb(${SIGNAL} / .5)`,
  line: `rgb(${FG} / .95)`,
  ghost: `rgb(${FG} / .55)`,
  avg: `rgb(${FG_DIM} / .6)`,
  peak: `rgb(${ACCENT} / .85)`,
  accent: `rgb(${ACCENT})`,
  halo: `rgb(${ACCENT} / .22)`,
};
const DASH_AVG = [4, 3];
const DASH_PEAK = [1, 3];
const DASH_NONE = [];
const MONO = '10px "IBM Plex Mono", ui-monospace, monospace';

// ---------------------------------------------------------------- settings (applied at the end of the module)
const DEFAULTS = { window: 20, height: 96, strain: true, brand: true };
let opt = DEFAULTS;
let spanS = 20;
function applySettings(next) {
  opt = next;
  spanS = Math.min(60, Math.max(5, Math.round(next.window) || 20));
  const height = Math.min(144, Math.max(48, Math.round(next.height) || 96));
  panel.style.setProperty('--chart-h', `${height}px`);
  el.brand.hidden = !next.brand;
  axisDirty = true;
  dirty = true;
  kick();
}

// ---------------------------------------------------------------- canvas sizing
let cw = 0, ch = 0, dpr = 1, half = 0.5, fillGrad = null, ghostGrad = null;
new ResizeObserver(([entry]) => {
  const box = entry.contentRect;
  dpr = window.devicePixelRatio || 1;
  half = Math.round(dpr) % 2 ? 0.5 : 0;
  cw = box.width; ch = box.height;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fillGrad = ctx.createLinearGradient(0, 0, 0, ch);
  fillGrad.addColorStop(0, `rgb(${FG} / .24)`);
  fillGrad.addColorStop(1, `rgb(${FG} / .02)`);
  ghostGrad = ctx.createLinearGradient(0, 0, 0, ch);
  ghostGrad.addColorStop(0, `rgb(${FG} / .16)`);
  ghostGrad.addColorStop(1, `rgb(${FG} / .015)`);
  dirty = true;
  kick();
}).observe(canvas);
document.fonts?.load(MONO).then(() => { dirty = true; kick(); }, () => {});

const crisp = v => (Math.round(v * dpr) + half) / dpr;

// ---------------------------------------------------------------- attempt record
// counts[b]: presses in bin b. kps[b]: presses in the window ending with bin b (w bins = 1 real
// second), maintained incrementally so a press costs w adds and drawing reads it directly.
let counts = new Uint16Array(8192);
let kps = new Uint16Array(8192);
let used = 0, w = 20, total = 0, peak = 0, peakBin = -1, firstT = null, lastT = null;
const prev = new Int32Array(64).fill(-1);
let attemptChecksum = null;

function ensure(size) {
  if (size < counts.length) return;
  let length = counts.length;
  while (length <= size) length *= 2;
  const c = new Uint16Array(length); c.set(counts); counts = c;
  const k = new Uint16Array(length); k.set(kps); kps = k;
}

function resetAttempt() {
  counts.fill(0, 0, used + 1);
  kps.fill(0, 0, used + 1);
  used = 0; total = 0; peak = 0; peakBin = -1; firstT = null; lastT = null;
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
  if (lastT === null || t > lastT) lastT = t;
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
  if (mode !== null && mode !== 'mania') return 'hidden';
  if (state === undefined || mode === null) return 'empty';
  if (isPlaying(state)) return 'live';
  if (total > 0 && (state === RESULTS || attemptChecksum === values['/beatmap/checksum'])) return 'summary';
  return 'map';
}

function setView(next) {
  if (next === view) return;
  const from = view;
  view = next;
  attr(panel, 'data-view', next);
  if (next === 'live' && from !== 'live') { liveT = null; shownT = null; resetAttempt(); }
  if (next === 'offline') {
    attr(chip, 'data-state', status);
    put(el.chip, status === 'offline' ? 'vosu offline' : 'Connecting to vosu…');
  }
  chip.hidden = next !== 'offline';
  axisDirty = true;
  dirty = true;
  if ((from === 'live') !== (next === 'live') && from !== 'init' && from !== 'offline' && from !== 'hidden') {
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

const chartTop = 8;
const yOf = v => ch - 1 - (v / scale) * (ch - 1 - chartTop);

const NUMBERS = Array.from({ length: 401 }, (_, i) => String(i));
const STEPS = [2, 5, 10, 20, 50, 100];
/** Scale step for the current plot height: at least 16 px between lines so labels never crowd. */
function gridStep() {
  const usable = ch - 1 - chartTop;
  let i = STEPS.indexOf(niceStep(scale));
  while (i < STEPS.length - 1 && (STEPS[i] / scale) * usable < 16) i++;
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
/** KPS scale labels, right-aligned at the plot's edge (in the live view that is the calm future zone). */
function drawGridLabels() {
  const step = gridStep();
  ctx.fillStyle = C.label;
  ctx.font = MONO;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (let v = step; v < scale + 0.001 && v < NUMBERS.length; v += step) {
    const y = Math.round(yOf(v));
    if (y - 11 < 0) break;
    ctx.fillText(NUMBERS[v], cw - 3, y - 2);
  }
  ctx.textAlign = 'left';
}

function drawBase() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.base;
  ctx.beginPath();
  const y = crisp(ch - 1);
  ctx.moveTo(0, y); ctx.lineTo(cw, y);
  ctx.stroke();
}

/** Strain area for map times [t0, t1] mapped by x = (t - t0) * k. */
function drawStrain(t0, t1, k) {
  if (!opt.strain || !sn || smax <= 0) return;
  const top = (ch - 1 - chartTop) * 0.92;
  let i = Math.max(0, strainIndex(t0) - 1);
  const end = Math.min(sn, strainIndex(t1) + 2);
  if (end - i < 2) return;
  const base = ch - 1;
  ctx.beginPath();
  ctx.moveTo((sx[i] - t0) * k, base);
  for (let j = i; j < end; j++) ctx.lineTo((sx[j] - t0) * k, base - (sy[j] / smax) * top);
  ctx.lineTo((sx[end - 1] - t0) * k, base);
  ctx.closePath();
  ctx.fillStyle = C.strainFill;
  ctx.fill();
  ctx.beginPath();
  for (let j = i; j < end; j++) {
    const x = (sx[j] - t0) * k, y = base - (sy[j] / smax) * top;
    if (j === i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.strainEdge;
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
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 8); ctx.lineTo(x + 4, y - 8); ctx.lineTo(x, y - 3.5);
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
/** Area + line through the first n buffered points; `smooth` rounds through midpoints. */
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

function renderLive(now, dt) {
  const est = estimate(now);
  let t = est;
  if (t !== null && shownT !== null && t < shownT && shownT - t < 400) t = shownT; // never jitter backwards
  shownT = t;
  scaleTarget = targetScale();
  const easing = 1 - Math.exp(-dt / 140);
  scale += (scaleTarget - scale) * easing;
  if (Math.abs(scaleTarget - scale) < 0.01) scale = scaleTarget;
  const scaling = scale !== scaleTarget;

  ctx.clearRect(0, 0, cw, ch);
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

  // Future zone: the map's upcoming density, no player data yet.
  ctx.fillStyle = C.future;
  ctx.fillRect(nowX, 0, cw - nowX, ch);

  // Chart-recorder grid anchored to time: 1 s minor, 5 s (or 10 s) major.
  const second = 1000 * rate;
  const major = spanS > 30 ? 10 : 5;
  ctx.lineWidth = 1;
  if (k * second >= 7) {
    ctx.strokeStyle = C.gridMinor;
    ctx.beginPath();
    for (let s = Math.ceil(t0 / second); s * second <= t1; s++) {
      if (s % major === 0) continue;
      const x = crisp((s * second - t0) * k);
      ctx.moveTo(x, 0); ctx.lineTo(x, ch - 1);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = C.gridMajor;
  ctx.beginPath();
  for (let s = Math.ceil(t0 / (second * major)); s * second * major <= t1; s++) {
    const x = crisp((s * second * major - t0) * k);
    ctx.moveTo(x, 0); ctx.lineTo(x, ch - 1);
  }
  ctx.stroke();

  drawStrain(t0, t1, k);
  drawGridH(0, cw);

  const nowBin = binOf(t);
  const current = keysPresent && nowBin <= used ? kps[nowBin] : 0;
  const avg = average(t);
  if (avg !== null) drawLevel(avg, C.avg, DASH_AVG, 0, cw);
  if (peak > 0) drawLevel(peak, C.peak, DASH_PEAK, 0, cw);

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
    drawCurve(n, fillGrad, C.line, 1.5, true);
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
    const y = headY;
    ctx.fillStyle = C.halo;
    ctx.beginPath(); ctx.arc(nowX, y, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.arc(nowX, y, 2.75, 0, Math.PI * 2); ctx.fill();
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

function renderStill() {
  scale = scaleTarget = targetScale();
  ctx.clearRect(0, 0, cw, ch);
  if (!cw) return;
  const mp3 = values['/beatmap/time/mp3Length'];
  let t0 = sn ? Math.min(0, sx[0]) : 0;
  let t1 = typeof mp3 === 'number' && mp3 > 0 ? mp3 : 0;
  if (sn) t1 = Math.max(t1, sx[sn - 1]);
  const showRun = view === 'summary';
  if (showRun && total) { t0 = Math.min(t0, firstT - 1000); t1 = Math.max(t1, timeOf(used)); }
  if (view === 'map' || view === 'summary') {
    if (t1 > t0) {
      // The summary keeps a right gutter for the KPS scale so labels never sit on the trace.
      const k = (cw - (showRun ? GUTTER : 0)) / (t1 - t0);
      drawStrain(t0, t1, k);
      drawGridH(0, cw);
      if (showRun) {
        const avg = average(Infinity);
        if (avg !== null) drawLevel(avg, C.avg, DASH_AVG, 0, cw);
        drawLevel(peak, C.peak, DASH_PEAK, 0, cw);
        // Whole attempt, ~2 px per point: the column's highest window value, so the envelope
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
        drawCurve(n, ghostGrad, C.ghost, 1.25, false);
        if (peakBin >= 0) drawPeakMark((timeOf(peakBin - (peakBin % per) + per - 1) - t0) * k);
      }
    } else drawGridH(0, cw);
  } else if (view === 'empty') drawGridH(0, cw);
  drawBase();
  if (showRun) drawGridLabels();
  if (axisDirty) {
    axisDirty = false;
    const has = t1 > t0 && view !== 'empty';
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
  if (Array.isArray(keys) && keys.length) return keys.length;
  const cs = values['/beatmap/stats/cs/converted'];
  return typeof cs === 'number' && cs > 0 ? Math.round(cs) : null;
}

const SOURCES = { replay: 'Replay', spectator: 'Spectating', watching: 'Watching', autoplay: 'Autoplay' };

const NONE = '—';
/** A readout value; placeholders render muted. */
function show(node, value) {
  if (node._text === value) return;
  put(node, value);
  attr(node, 'data-none', value === NONE ? '' : null);
}
const intText = v => (v >= 0 && v < NUMBERS.length ? NUMBERS[v] : String(v));
// One-decimal text cached by tenths so a steady average allocates nothing per frame.
const tenths = { key: NaN, text: NONE };
function decimal(v) {
  if (v === null || v === undefined) return NONE;
  const key = Math.round(v * 10);
  if (key !== tenths.key) { tenths.key = key; tenths.text = (key / 10).toFixed(1); }
  return tenths.text;
}
let metaKey = '';

function readouts(current, keysPresent, avg) {
  const keyCount = view === 'empty' ? 0 : columns() ?? 0;
  if (metaKey !== keyCount * 1000 + rate) {
    metaKey = keyCount * 1000 + rate;
    const rateText = Math.abs(rate - 1) > 0.001 ? `${rate.toFixed(2)}×` : '';
    put(el.meta, keyCount ? (rateText ? `${keyCount}K · ${rateText}` : `${keyCount}K`) : rateText);
  }

  if (view === 'live') {
    put(el.phase, SOURCES[values['/play/source']] ?? 'Live');
    put(el.pLabel, 'Now'); put(el.aLabel, 'Peak'); put(el.bLabel, 'Avg');
    attr(el.aLabel, 'data-key', 'peak'); attr(el.bLabel, 'data-key', 'avg');
    attr(el.aValue, 'data-peak', '');
    const live = keysPresent && current !== null;
    show(el.pValue, live ? intText(current) : NONE);
    show(el.aValue, live && peak > 0 ? intText(peak) : NONE);
    show(el.bValue, live ? decimal(avg) : NONE);
    attr(panel, 'data-hot', live && peak >= 5 && current === peak ? '' : null);
    note.hidden = keysPresent;
    if (!keysPresent) put(note, 'No key data · enable ENABLE_KEY_OVERLAY in vosu');
    if (axisDirty) {
      axisDirty = false;
      put(el.axisL, `−${spanS} s`);
      put(el.axisM, `−${spanS / 2} s`);
      put(el.axisN, 'Now');
      const ahead = spanS * (1 - NOW_AT) / NOW_AT;
      put(el.axisR, `+${ahead < 10 ? ahead.toFixed(1) : Math.round(ahead)} s`);
    }
    return;
  }
  note.hidden = true;
  attr(panel, 'data-hot', null);
  const results = values['/state/number'] === RESULTS;
  if (view === 'summary') {
    put(el.phase, results ? 'Result' : 'Last run');
    put(el.pLabel, 'Peak'); put(el.aLabel, 'Avg'); put(el.bLabel, 'Keys');
    attr(el.aLabel, 'data-key', 'avg'); attr(el.bLabel, 'data-key', 'none');
    attr(el.aValue, 'data-peak', null);
    show(el.pValue, intText(peak));
    show(el.aValue, decimal(average(Infinity)));
    show(el.bValue, intText(total));
    return;
  }
  put(el.phase, view === 'map' ? (results ? 'Result' : 'Map') : 'Idle');
  put(el.pLabel, 'Now'); put(el.aLabel, 'Peak'); put(el.bLabel, 'Avg');
  attr(el.aLabel, 'data-key', 'peak'); attr(el.bLabel, 'data-key', 'avg');
  show(el.pValue, NONE); show(el.aValue, NONE); show(el.bValue, NONE);
}

// ---------------------------------------------------------------- wiring
settings(DEFAULTS, applySettings);
subscribe(POINTERS, (next, changed) => {
  values = next;
  const now = performance.now();
  if (changed.has('/beatmap/time/rate') || changed.has('/play/mods/rate')) {
    const r = values['/beatmap/time/rate'] ?? values['/play/mods/rate'];
    const fresh = typeof r === 'number' && r > 0 ? r : 1;
    if (fresh !== rate) { rate = fresh; takeStrain(); if (total === 0) w = Math.max(1, Math.round(1000 * rate / BIN)); }
  }
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
  if (changed.has('/performance/graph/series') || changed.has('/performance/graph/xaxis')) { takeStrain(); dirty = true; axisDirty = true; }
  if (changed.has('/beatmap/checksum') || changed.has('/beatmap/stats/cs/converted') || changed.has('/keys/all') || changed.has('/play/source')) dirty = true;
  if (changed.has('/beatmap/time/mp3Length') && view !== 'live') axisDirty = dirty = true;
  if (view === 'live' || dirty) kick();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    setView(decideView());
    kick();
  },
});

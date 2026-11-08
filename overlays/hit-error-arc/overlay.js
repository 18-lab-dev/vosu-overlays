// Copyright (c) 2026 18-LAB. MIT.
// Hit error arc: a precision dial. Judgement windows are arc segments, every hit is a fading tick,
// an amber needle follows the moving average and the play's unstable rate sits in the hollow.
import { subscribe, settings, fit, activeMode, MODE_LABELS } from './vosu-overlay.js';

const W = 400;
const H = 360;
const PLAY = 2;
const RESULTS = 7;
const SUPPORTED = new Set(['osu', 'taiko', 'mania']);

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const chip = $('chip');
const chipText = $('chip-text');
const brand = $('brand');
const modeEl = $('mode');
const readout = $('readout');
const urInt = $('ur-int');
const urFrac = $('ur-frac');
const meanEl = $('mean');
const canvases = [$('base'), $('hist'), $('live')];

// Render state lives above every handler that marks it dirty.
let raf = 0;
let domDirty = true;
let baseDirty = true;
let histDirty = true;
let textDirty = true;
let lastFrame = 0;
let shown = false;
const [bctx, hctx, lctx] = canvases.map(canvas => canvas.getContext('2d', { alpha: true }));

fit(stage, W, H);

// ------------------------------------------------------------------ tokens
let colors;
let monoFont = 'monospace';
function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim() || '#7e8288';
  colors = {
    fg: v('--fg'), fgDim: v('--fg-dim'), muted: v('--muted'), rule: v('--rule'), ruleStrong: v('--rule-strong'),
    accent: v('--accent'),
    // Class order: 0 max, 1 great, 2 good, 3 ok, 4 meh, 5 miss.
    judge: ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(v),
  };
  monoFont = v('--font-mono');
}
readTokens();

// ------------------------------------------------------------------ settings + geometry
const DEFAULTS = { sweep: 240, tickLife: 4, histogram: true, histogramHits: 400, averageHits: 20, size: 100, showBrand: true };
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
let cfg = { ...DEFAULTS };
const geo = { k: 1, w: 0, h: 0, cx: 0, cy: 0, half: 0, bandR: 0, bandW: 0, inner: 0, outer: 0, histR0: 0, histH: 0, needle0: 0 };

function layout() {
  const k = clamp(cfg.size, 60, 100) / 100;
  const half = clamp(cfg.sweep, 90, 270) * Math.PI / 360;
  const bandR = Math.round(138 * k);
  const bandW = Math.max(6, Math.round(8 * k));
  const inner = bandR - bandW / 2;
  const outer = bandR + bandW / 2;
  const histR0 = outer + Math.round(10 * k);
  const histH = Math.round(24 * k);
  const extent = cfg.histogram ? histR0 + histH : outer + 8;
  const halfW = half >= Math.PI / 2 ? extent : extent * Math.sin(half);
  // The footer (EARLY · mean · LATE) and corner labels need ~200 px whatever the sweep.
  const w = 2 * Math.round(Math.max(halfW + 14, 132 * k, 106));
  const cy = 14 + extent;
  const below = Math.max(0, -Math.cos(half)) * extent;
  const h = Math.round(cy + below + 34);
  Object.assign(geo, { k, w, h, cx: w / 2, cy, half, bandR, bandW, inner, outer, histR0, histH, needle0: Math.round(bandR * 0.64) });

  panel.style.width = `${w}px`;
  panel.style.height = `${h}px`;
  panel.style.left = `${Math.round((W - w - 2) / 2)}px`;
  panel.style.top = `${H - h - 3}px`;
  readout.style.left = `${w / 2}px`;
  readout.style.top = `${Math.round(cy - bandR * (half > 1.9 ? 0.2 : 0.3))}px`;
  readout.style.setProperty('--ur-size', `${Math.round(54 * k)}px`);
}

// ------------------------------------------------------------------ data model
// Last CAP hit errors of the attempt; histogram and moving average evict from it incrementally.
const CAP = 2048;
const MASK = CAP - 1;
const BINS = 51;
const recent = new Float64Array(CAP);
const bins = new Uint16Array(BINS);
let total = 0;
let sum = 0;
let sumSq = 0;
let avgSum = 0;

// Live ticks: ring of the newest hits with their arrival time and precomputed direction.
const TCAP = 1024;
const TMASK = TCAP - 1;
const tErr = new Float32Array(TCAP);
const tTime = new Float64Array(TCAP);
const tCos = new Float32Array(TCAP);
const tSin = new Float32Array(TCAP);
const tCls = new Uint8Array(TCAP);
let tickStart = 0;
let tickCount = 0;
const FRESH_MS = 180;
const BUCKETS = 12;

let segs = [];      // [{ edge, cls }] ascending |error| windows for the current ruleset
let range = 0;      // outermost hittable window (ms); 0 = no windows known
let scale = 100;    // ms at the arc ends (range, or a neutral fallback for the needle and ticks)

let conn = 'connecting';
let state;
let mode = null;
let lastLen = 0;
let firstValue;
let needle = 0;
let needleShown = false;

const phase = () => (state === PLAY ? 'play' : state === RESULTS ? 'results' : 'idle');
const angleOf = error => -Math.PI / 2 + clamp(error / scale, -1, 1) * geo.half;
const binOf = error => clamp(Math.floor((error + scale) / (2 * scale) * BINS), 0, BINS - 1);
const avgCount = () => Math.min(total, cfg.averageHits);

function classify(error) {
  const a = Math.abs(error);
  for (const seg of segs) if (a <= seg.edge) return seg.cls;
  return 5;
}

const WINDOW_CLASSES = {
  osu: [['great', 1], ['ok', 2], ['meh', 4]],
  taiko: [['great', 1], ['ok', 2]],
  mania: [['perfect', 0], ['great', 1], ['good', 2], ['ok', 3], ['meh', 4]],
};

function setWindows(hitWindow) {
  const next = [];
  for (const [key, cls] of WINDOW_CLASSES[mode] || []) {
    const edge = Number(hitWindow?.[key]);
    if (Number.isFinite(edge) && edge > 0 && edge > (next.at(-1)?.edge ?? 0)) next.push({ edge, cls });
  }
  const nextRange = next.at(-1)?.edge ?? 0;
  if (nextRange === range && next.length === segs.length && next.every((seg, i) => seg.edge === segs[i].edge && seg.cls === segs[i].cls)) return;
  segs = next;
  range = nextRange;
  scale = range || 100;
  rebuild();
  aimTicks();
  baseDirty = histDirty = true;
}

function resetData() {
  total = 0; sum = 0; sumSq = 0; avgSum = 0;
  bins.fill(0);
  tickStart = 0; tickCount = 0;
  needle = 0; needleShown = false;
  histDirty = textDirty = true;
}

/** Recomputes the windowed sums after the histogram/average length or the scale changed. */
function rebuild() {
  bins.fill(0);
  avgSum = 0;
  for (let i = Math.max(0, total - cfg.histogramHits); i < total; i++) bins[binOf(recent[i & MASK])]++;
  for (let i = Math.max(0, total - cfg.averageHits); i < total; i++) avgSum += recent[i & MASK];
  histDirty = textDirty = true;
}

function aimTicks() {
  for (let j = 0; j < tickCount; j++) {
    const i = (tickStart + j) & TMASK;
    const a = angleOf(tErr[i]);
    tCos[i] = Math.cos(a);
    tSin[i] = Math.sin(a);
    tCls[i] = classify(tErr[i]);
  }
}

function push(error) {
  const i = total++;
  recent[i & MASK] = error;
  sum += error;
  sumSq += error * error;
  avgSum += error;
  if (i >= cfg.averageHits) avgSum -= recent[(i - cfg.averageHits) & MASK];
  bins[binOf(error)]++;
  if (i >= cfg.histogramHits) bins[binOf(recent[(i - cfg.histogramHits) & MASK])]--;
}

function addTick(error, now) {
  let i;
  if (tickCount === TCAP) { i = tickStart; tickStart = (tickStart + 1) & TMASK; } else i = (tickStart + tickCount++) & TMASK;
  const a = angleOf(error);
  tErr[i] = error;
  tTime[i] = now;
  tCos[i] = Math.cos(a);
  tSin[i] = Math.sin(a);
  tCls[i] = classify(error);
}

function ingest(errors) {
  if (!Array.isArray(errors) || !SUPPORTED.has(mode)) {
    if (total || tickCount) resetData();
    lastLen = 0; firstValue = undefined;
    return;
  }
  if (phase() === 'idle') {
    // Menus may still carry the previous attempt's array: consume it without showing it, so a
    // later play only draws hits made after it started.
    if (total || tickCount) resetData();
    lastLen = errors.length; firstValue = errors[0];
    return;
  }
  if (errors.length < lastLen || (lastLen > 0 && errors[0] !== firstValue)) { resetData(); lastLen = 0; }
  firstValue = errors[0];
  const from = lastLen;
  lastLen = errors.length;
  if (from === errors.length) return;
  // A page opened mid-attempt (or at results) gets the history without a burst of ticks.
  const tickFrom = phase() === 'play' ? Math.max(from, errors.length - 32) : errors.length;
  const now = performance.now();
  for (let i = from; i < errors.length; i++) {
    const error = errors[i];
    if (typeof error !== 'number' || !Number.isFinite(error)) continue;
    push(error);
    if (i >= tickFrom) addTick(error, now);
  }
  if (!needleShown && total) needleShown = true;
  histDirty = textDirty = true;
}

// ------------------------------------------------------------------ vosu
const P_STATE = '/state/number';
const P_PLAY_MODE = '/play/mode/number';
const P_SETTINGS_MODE = '/settings/mode/number';
const P_ERRORS = '/play/hitErrorArray';
const P_WINDOW = '/beatmap/stats/hitWindow';

subscribe([P_STATE, P_PLAY_MODE, P_SETTINGS_MODE, P_ERRORS, P_WINDOW], (values, changed) => {
  const nextState = values[P_STATE];
  const nextMode = activeMode(nextState, values[P_PLAY_MODE], values[P_SETTINGS_MODE]);
  const moved = nextState !== state || nextMode !== mode;
  if (moved) { state = nextState; mode = nextMode; domDirty = true; }
  if (moved || changed.has(P_WINDOW)) setWindows(values[P_WINDOW]);
  if (moved || changed.has(P_ERRORS)) ingest(values[P_ERRORS]);
  schedule();
}, {
  onStatus(next) {
    if (next === conn) return;
    conn = next;
    domDirty = true;
    schedule();
  },
});

settings(DEFAULTS, next => {
  const previous = cfg;
  cfg = {
    ...next,
    sweep: clamp(Math.round(next.sweep), 90, 270),
    tickLife: clamp(next.tickLife, 0.5, 20),
    histogramHits: clamp(Math.round(next.histogramHits), 50, 2000),
    averageHits: clamp(Math.round(next.averageHits), 5, 200),
    size: clamp(next.size, 60, 100),
  };
  brand.hidden = !cfg.showBrand;
  layout();
  if (cfg.histogramHits !== previous.histogramHits || cfg.averageHits !== previous.averageHits) rebuild();
  aimTicks();
  baseDirty = histDirty = textDirty = true;
  schedule();
});

// ------------------------------------------------------------------ canvas sizing
let dpr = devicePixelRatio || 1;
function size() {
  dpr = devicePixelRatio || 1;
  const bw = Math.round(geo.w * dpr);
  const bh = Math.round(geo.h * dpr);
  for (const [i, canvas] of canvases.entries()) {
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    [bctx, hctx, lctx][i].setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  baseDirty = histDirty = true;
  schedule();
}
new ResizeObserver(size).observe(panel);
const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { size(); watchDpr(); }, { once: true });
watchDpr();
document.fonts.load(`500 10px ${monoFont}`).then(() => { readTokens(); baseDirty = true; schedule(); }, () => {});

// ------------------------------------------------------------------ render
function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  const dt = lastFrame && now - lastFrame < 100 ? now - lastFrame : 16;
  lastFrame = now;
  if (domDirty) applyDom();
  if (!shown) { lastFrame = 0; return; }
  if (baseDirty) drawBase();
  if (histDirty) drawHist();
  if (textDirty) writeText();
  if (drawLive(now, dt)) schedule();
  else lastFrame = 0;
}

let lastPhase = '';
let lastModeText = '';
let lastChip = '';
function applyDom() {
  domDirty = false;
  const live = conn === 'live';
  const next = live && mode !== 'fruits';
  if (next !== shown) {
    shown = next;
    panel.dataset.shown = String(next);
    if (next) baseDirty = histDirty = textDirty = true;
  }
  chip.dataset.shown = String(!live);
  const chipLabel = conn === 'offline' ? 'vosu offline' : 'Connecting to vosu';
  if (chipLabel !== lastChip) { lastChip = chipLabel; chipText.textContent = chipLabel; chip.dataset.state = conn; }
  const p = state === undefined ? 'idle' : phase();
  if (p !== lastPhase) { lastPhase = p; panel.dataset.phase = p; }
  const label = !SUPPORTED.has(mode) ? 'No game' : p === 'results' ? `${MODE_LABELS[mode]} · final` : MODE_LABELS[mode];
  if (label !== lastModeText) { lastModeText = label; modeEl.textContent = label; }
}

const MINUS = '\u2212';
const signed = (value, digits) => (value < 0 ? MINUS : value > 0 ? '+' : '') + Math.abs(value).toFixed(digits);
let lastUr = '';
let lastMean = '';
function writeText() {
  textDirty = false;
  let ur = '—';
  let mean = '—';
  if (total >= 2) {
    const m = sum / total;
    ur = (Math.sqrt(Math.max(0, sumSq / total - m * m)) * 10).toFixed(2);
    mean = signed(m, 1);
  }
  if (ur !== lastUr) {
    lastUr = ur;
    const dot = ur.indexOf('.');
    urInt.textContent = dot < 0 ? ur : ur.slice(0, dot);
    urFrac.textContent = dot < 0 ? '' : ur.slice(dot);
  }
  if (mean !== lastMean) {
    if ((mean === '—') !== (lastMean === '—')) panel.dataset.empty = String(mean === '—');
    lastMean = mean;
    meanEl.textContent = mean;
  }
}

function niceStep(span) {
  const target = span / 12;
  for (const step of [1, 2, 2.5, 5, 10, 20, 25, 50, 100]) if (step >= target) return step;
  return 200;
}

function radial(c, a, r0, r1) {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  c.moveTo(geo.cx + cos * r0, geo.cy + sin * r0);
  c.lineTo(geo.cx + cos * r1, geo.cy + sin * r1);
}

/** Text centred on a ray, pulled inward so its nearest edge keeps `gap` px from radius `r`. */
function rayLabel(c, text, a, r, gap) {
  const width = c.measureText(text).width;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const d = r - gap - (Math.abs(cos) * width / 2 + Math.abs(sin) * 4);
  c.fillText(text, Math.round(geo.cx + cos * d), Math.round(geo.cy + sin * d));
}

function drawBase() {
  baseDirty = false;
  const c = bctx;
  const { cx, cy, half, k, bandR, bandW, inner, outer } = geo;
  c.clearRect(0, 0, geo.w, geo.h);
  c.lineCap = 'butt';

  // Window bands: one arc segment per judgement on each side, separated by a 1 px gap.
  c.lineWidth = bandW;
  if (!segs.length) {
    c.globalAlpha = 1;
    c.strokeStyle = colors.rule;
    c.beginPath();
    c.arc(cx, cy, bandR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.stroke();
  } else {
    const gap = 0.5 / bandR;
    let prev = 0;
    c.globalAlpha = 0.42;
    for (const seg of segs) {
      const end = seg.edge === range ? 0 : gap;
      const start = prev ? gap : 0;
      c.strokeStyle = colors.judge[seg.cls];
      c.beginPath();
      c.arc(cx, cy, bandR, angleOf(prev) + start, angleOf(seg.edge) - end);
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, bandR, angleOf(-seg.edge) + end, angleOf(-prev) - start);
      c.stroke();
      prev = seg.edge;
    }
  }

  // Graduations inside the band: fine marks on a round step, longer marks on window edges.
  const g0 = inner - 2;
  c.lineWidth = 1;
  c.globalAlpha = 0.6;
  c.strokeStyle = colors.muted;
  c.beginPath();
  const step = niceStep(scale);
  for (let v = step; v < scale - step * 0.25; v += step) {
    radial(c, angleOf(v), g0, g0 - 4 * k);
    radial(c, angleOf(-v), g0, g0 - 4 * k);
  }
  c.stroke();
  c.globalAlpha = 0.9;
  c.strokeStyle = colors.fgDim;
  c.beginPath();
  for (const seg of segs) {
    radial(c, angleOf(seg.edge), g0, g0 - 8 * k);
    radial(c, angleOf(-seg.edge), g0, g0 - 8 * k);
  }
  if (!segs.length) {
    radial(c, angleOf(scale), g0, g0 - 8 * k);
    radial(c, angleOf(-scale), g0, g0 - 8 * k);
  }
  c.stroke();
  // Zero: the reference line crosses the band.
  c.globalAlpha = 1;
  c.strokeStyle = colors.fg;
  c.lineWidth = 1.5;
  c.beginPath();
  radial(c, -Math.PI / 2, outer + 3, g0 - 11 * k);
  c.stroke();

  // Histogram baseline.
  if (cfg.histogram) {
    c.lineWidth = 1;
    c.strokeStyle = colors.ruleStrong;
    c.beginPath();
    c.arc(cx, cy, geo.histR0 - 0.5, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.stroke();
  }

  // Scale labels: zero and the outermost window on each side.
  c.font = `500 10px ${monoFont}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = colors.muted;
  if (range) {
    const text = String(Math.round(range * 10) / 10);
    rayLabel(c, MINUS + text, angleOf(-range), g0, 9 * k);
    rayLabel(c, `+${text}`, angleOf(range), g0, 9 * k);
  }
  c.globalAlpha = 1;
}

function drawHist() {
  histDirty = false;
  const c = hctx;
  const { cx, cy, half, k, outer, histR0, histH } = geo;
  c.clearRect(0, 0, geo.w, geo.h);
  if (!total) return;

  // Session mean: a caret riding the outside of the band.
  const a = angleOf(sum / total);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const tipR = outer + 1.5;
  const baseR = outer + 1.5 + 5 * k;
  const w = 3 * k;
  c.globalAlpha = 1;
  c.fillStyle = colors.fgDim;
  c.beginPath();
  c.moveTo(cx + cos * tipR, cy + sin * tipR);
  c.lineTo(cx + cos * baseR - sin * w, cy + sin * baseR + cos * w);
  c.lineTo(cx + cos * baseR + sin * w, cy + sin * baseR - cos * w);
  c.closePath();
  c.fill();

  if (!cfg.histogram) return;
  let max = 0;
  let first = -1;
  let last = -1;
  for (let b = 0; b < BINS; b++) {
    if (!bins[b]) continue;
    if (bins[b] > max) max = bins[b];
    if (first < 0) first = b;
    last = b;
  }
  if (!max) return;
  const unit = histH / max;
  // A stepped envelope along the arc: a faint fill with a crisp top edge reads as one
  // distribution rather than a row of separate bars.
  c.beginPath();
  envelope(c, first, last, unit);
  c.arc(cx, cy, histR0, -Math.PI / 2 - half + (last + 1) * (2 * half) / BINS, -Math.PI / 2 - half + first * (2 * half) / BINS, true);
  c.closePath();
  c.fillStyle = colors.fgDim;
  c.globalAlpha = 0.2;
  c.fill();
  c.beginPath();
  envelope(c, first, last, unit);
  c.lineWidth = 1;
  c.lineJoin = 'miter';
  c.strokeStyle = colors.fgDim;
  c.globalAlpha = 0.85;
  c.stroke();
  c.globalAlpha = 1;
}

function envelope(c, first, last, unit) {
  const { cx, cy, half, histR0 } = geo;
  const binAngle = (2 * half) / BINS;
  const start = -Math.PI / 2 - half;
  const a0 = start + first * binAngle;
  const a1 = start + (last + 1) * binAngle;
  c.moveTo(cx + Math.cos(a0) * histR0, cy + Math.sin(a0) * histR0);
  for (let b = first; b <= last; b++) {
    const r = histR0 + (bins[b] ? Math.max(1.5, bins[b] * unit) : 0);
    c.arc(cx, cy, r, start + b * binAngle, start + (b + 1) * binAngle);
  }
  c.lineTo(cx + Math.cos(a1) * histR0, cy + Math.sin(a1) * histR0);
}

const fade = x => (1 - x) ** 1.6;

function drawLive(now, dt) {
  const c = lctx;
  const { cx, cy, k, inner, outer } = geo;
  c.clearRect(0, 0, geo.w, geo.h);
  const life = cfg.tickLife * 1000;
  while (tickCount && now - tTime[tickStart] >= life) { tickStart = (tickStart + 1) & TMASK; tickCount--; }

  // Ticks, oldest first. They are time-ordered, so each alpha bucket is a contiguous run that is
  // stroked once per judgement class instead of once per tick.
  const r0 = inner - 9 * k;
  const r1 = outer + 1;
  c.lineCap = 'butt';
  c.lineWidth = Math.max(1.5, 2 * k);
  let j = 0;
  for (let b = BUCKETS - 1; b >= 0 && j < tickCount; b--) {
    const minAge = (b * life) / BUCKETS;
    const from = j;
    let classes = 0;
    while (j < tickCount) {
      const i = (tickStart + j) & TMASK;
      if (now - tTime[i] < minAge || (b === 0 && now - tTime[i] < FRESH_MS)) break;
      classes |= 1 << tCls[i];
      j++;
    }
    if (j === from) continue;
    c.globalAlpha = fade((b + 0.5) / BUCKETS);
    for (let cls = 0; cls < 6; cls++) {
      if (!(classes & (1 << cls))) continue;
      c.strokeStyle = colors.judge[cls];
      c.beginPath();
      for (let n = from; n < j; n++) {
        const i = (tickStart + n) & TMASK;
        if (tCls[i] !== cls) continue;
        c.moveTo(cx + tCos[i] * r0, cy + tSin[i] * r0);
        c.lineTo(cx + tCos[i] * r1, cy + tSin[i] * r1);
      }
      c.stroke();
    }
  }
  // Fresh hits reach further inward for a moment, then settle into the band.
  c.globalAlpha = 1;
  for (; j < tickCount; j++) {
    const i = (tickStart + j) & TMASK;
    const t = (now - tTime[i]) / FRESH_MS;
    const reach = r0 - 8 * k * (1 - t) ** 2;
    c.strokeStyle = colors.judge[tCls[i]];
    c.beginPath();
    c.moveTo(cx + tCos[i] * reach, cy + tSin[i] * reach);
    c.lineTo(cx + tCos[i] * (r1 + 2 * (1 - t)), cy + tSin[i] * (r1 + 2 * (1 - t)));
    c.stroke();
  }

  // Needle: moving average of the last N hits, eased so it reads as a damped instrument.
  let moving = false;
  if (needleShown && total) {
    const target = avgSum / avgCount();
    needle += (target - needle) * (1 - Math.exp(-dt / 90));
    if (Math.abs(target - needle) < 0.02) needle = target;
    else moving = true;
    const a = angleOf(needle);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const n0 = geo.needle0;
    const n1 = inner - 12 * k;
    const w0 = 2.5 * k;
    const w1 = 0.6;
    c.fillStyle = colors.accent;
    c.beginPath();
    c.moveTo(cx + cos * n0 - sin * w0, cy + sin * n0 + cos * w0);
    c.lineTo(cx + cos * n1 - sin * w1, cy + sin * n1 + cos * w1);
    c.lineTo(cx + cos * n1 + sin * w1, cy + sin * n1 - cos * w1);
    c.lineTo(cx + cos * n0 + sin * w0, cy + sin * n0 - cos * w0);
    c.closePath();
    c.fill();
  }
  return moving || tickCount > 0;
}

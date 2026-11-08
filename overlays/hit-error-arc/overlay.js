// Copyright (c) 2026 18-LAB. MIT.
// Hit error arc: a precision dial floated into the empty space of osu!'s gameplay layout.
// Judgement windows are arc segments, every hit is a fading tick, a needle follows the moving
// average and the attempt's unstable rate sits in the hollow.
import { subscribe, settings, fit, activeMode, osuLayout, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const PLAY = 2;
const RESULTS = 7;
const SUPPORTED = new Set(['osu', 'taiko', 'mania']);
const MARGIN = 24;

const $ = id => document.getElementById(id);
const root = document.documentElement;
const stage = $('stage');
const dial = $('dial');
const chip = $('chip');
const chipText = $('chip-text');
const brand = $('brand');
const readout = $('readout');
const urInt = $('ur-int');
const urFrac = $('ur-frac');
const meanEl = $('mean');
const canvases = [$('base'), $('hist'), $('live')];
const finalEl = $('final');
const finalCanvas = $('final-hist');
const fctx = finalCanvas.getContext('2d', { alpha: true });
const finalUr = $('final-ur');
const finalMean = $('final-mean');
const finalRange = $('final-range');
const FINAL_W = 300;
const FINAL_H = 48;
const [bctx, hctx, lctx] = canvases.map(canvas => canvas.getContext('2d', { alpha: true }));

// Render state lives above every handler that marks it dirty.
let raf = 0;
let domDirty = true;
let placeDirty = true;
let baseDirty = true;
let histDirty = true;
let textDirty = true;
let lastFrame = 0;
let shown = false;
let finalShown = false;
let finalDirty = false;
let finalErrors = null;

fit(stage, W, H);

// ------------------------------------------------------------------ tokens
let colors;
let monoFont = 'monospace';
function readTokens() {
  const css = getComputedStyle(root);
  const v = name => css.getPropertyValue(name).trim() || '#7e8288';
  colors = {
    fg: v('--fg'), fgDim: v('--fg-dim'), muted: v('--muted'), ruleStrong: v('--rule-strong'),
    // --hl is the identity colour: the map's tonal accent, or 18-LAB amber (see style.css).
    hl: v('--hl'),
    // Class order: 0 max, 1 great, 2 good, 3 ok, 4 meh, 5 miss.
    judge: ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(v),
  };
  monoFont = v('--font-mono');
}
readTokens();

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  side: 'auto', offsetX: 0, offsetY: 0, scale: 100, backing: 'none', accent: 'map',
  sweep: 240, tickLife: 4, histogram: true, histogramHits: 400, averageHits: 20, showBrand: true,
  columnStart: 0, columnWidth: 0,
};
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
let cfg = { ...DEFAULTS };

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
let scale = 100;    // ms at the arc ends (range, or a neutral fallback)

let conn = 'connecting';
let state;
let mode = null;
let keys = 4;
let client = 'stable';
let checksum = '';
let skinName = '';
let maniaStage = null; // { columnStart, columnWidth[], columnSpacing[] } from the skin's skin.ini, or null
let lastLen = 0;
let firstValue;
let needle = 0;

const angleOf = error => -Math.PI / 2 + clamp(error / scale, -1, 1) * geo.half;
const binOf = error => clamp(Math.floor((error + scale) / (2 * scale) * BINS), 0, BINS - 1);

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
  needle = 0;
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
  if (state !== PLAY && state !== RESULTS) {
    // Menus may still carry the last attempt's array: consume it without showing it, so the
    // next play only draws hits made after it started.
    if (total || tickCount) resetData();
    lastLen = errors.length; firstValue = errors[0];
    return;
  }
  if (errors.length < lastLen || (lastLen > 0 && errors[0] !== firstValue)) { resetData(); lastLen = 0; }
  firstValue = errors[0];
  const from = lastLen;
  lastLen = errors.length;
  if (from === errors.length) return;
  // A page opened mid-attempt gets the history without a burst of ticks; results get none.
  const tickFrom = state === PLAY ? Math.max(from, errors.length - 32) : errors.length;
  const now = performance.now();
  for (let i = from; i < errors.length; i++) {
    const error = errors[i];
    if (typeof error !== 'number' || !Number.isFinite(error)) continue;
    push(error);
    if (i >= tickFrom) addTick(error, now);
  }
  histDirty = textDirty = true;
}

// ------------------------------------------------------------------ map tint
let paletteFor = null;
function loadPalette() {
  const want = cfg.accent === 'map' ? checksum : '';
  if (want === paletteFor) return;
  paletteFor = want;
  if (!want) { applyPalette(root, null); tintChanged(); return; }
  mapPalette(want).then(palette => {
    if (paletteFor !== want) return;
    applyPalette(root, palette);
    tintChanged();
  });
}
function tintChanged() {
  readTokens();
  schedule();
}

// ------------------------------------------------------------------ mania stage from the skin
let stageFor = null;
function loadManiaStage() {
  const want = mode === 'mania' ? `${keys}|${skinName}` : null;
  if (!want || want === stageFor) return;
  stageFor = want;
  maniaSkin(keys, skinName).then(skin => {
    if (stageFor !== want) return;
    maniaStage = skin;
    placeDirty = true;
    schedule();
  }, () => {});
}

// ------------------------------------------------------------------ vosu
const P_STATE = '/state/number';
const P_PLAY_MODE = '/play/mode/number';
const P_SETTINGS_MODE = '/settings/mode/number';
const P_ERRORS = '/play/hitErrorArray';
const P_WINDOW = '/beatmap/stats/hitWindow';
const P_KEYS = '/beatmap/stats/cs/converted';
const P_CLIENT = '/client';
const P_CHECKSUM = '/beatmap/checksum';
const P_SKIN = '/settings/skin/name';

subscribe([P_STATE, P_PLAY_MODE, P_SETTINGS_MODE, P_ERRORS, P_WINDOW, P_KEYS, P_CLIENT, P_CHECKSUM, P_SKIN], (values, changed) => {
  const nextState = values[P_STATE];
  const nextMode = activeMode(nextState, values[P_PLAY_MODE], values[P_SETTINGS_MODE]);
  const moved = nextState !== state || nextMode !== mode;
  if (moved) { state = nextState; mode = nextMode; domDirty = placeDirty = true; }
  const nextKeys = Math.round(Number(values[P_KEYS])) || 4;
  const nextClient = values[P_CLIENT] === 'lazer' ? 'lazer' : 'stable';
  if (nextKeys !== keys || nextClient !== client) { keys = nextKeys; client = nextClient; placeDirty = domDirty = true; }
  if (changed.has(P_SKIN)) skinName = values[P_SKIN] || '';
  loadManiaStage();
  if (moved || changed.has(P_WINDOW)) setWindows(values[P_WINDOW]);
  if (moved || changed.has(P_ERRORS)) {
    ingest(values[P_ERRORS]);
    finalErrors = state === RESULTS && Array.isArray(values[P_ERRORS]) ? values[P_ERRORS] : null;
    finalDirty = true;
  }
  if (changed.has(P_CHECKSUM)) { checksum = values[P_CHECKSUM] || ''; loadPalette(); }
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
    side: ['auto', 'left', 'right'].includes(next.side) ? next.side : 'auto',
    backing: ['none', 'scrim', 'panel'].includes(next.backing) ? next.backing : 'none',
    accent: next.accent === '18-lab' ? '18-lab' : 'map',
    scale: clamp(next.scale, 50, 150),
    columnStart: Math.max(0, next.columnStart),
    columnWidth: Math.max(0, next.columnWidth),
    sweep: clamp(Math.round(next.sweep), 90, 270),
    tickLife: clamp(next.tickLife, 0.5, 20),
    histogramHits: clamp(Math.round(next.histogramHits), 50, 2000),
    averageHits: clamp(Math.round(next.averageHits), 5, 200),
  };
  if (cfg.histogramHits !== previous.histogramHits || cfg.averageHits !== previous.averageHits) rebuild();
  loadPalette();
  placeDirty = baseDirty = histDirty = textDirty = domDirty = true;
  schedule();
});

// ------------------------------------------------------------------ placement + geometry
const geo = { k: 1, w: 0, h: 0, cx: 0, cy: 0, half: 0, bandR: 0, bandW: 0, inner: 0, outer: 0, histR0: 0, histH: 0, needle0: 0 };

/** Dial geometry at scale `k`: radii, and the box (w×h) holding arc, readout and footer. */
function geometry(k) {
  const half = cfg.sweep * Math.PI / 360;
  const bandR = Math.round(138 * k);
  const bandW = Math.max(6, Math.round(8 * k));
  const inner = bandR - bandW / 2;
  const outer = bandR + bandW / 2;
  const histR0 = outer + Math.round(10 * k);
  const histH = Math.round(24 * k);
  const extent = cfg.histogram ? histR0 + histH : outer + Math.round(8 * k);
  const halfW = half >= Math.PI / 2 ? extent : extent * Math.sin(half);
  // The footer (EARLY · mean · LATE) needs ~230 px whatever the sweep.
  const w = 2 * Math.round(Math.max(halfW + 12, 116));
  const cy = 18 + extent;
  const below = Math.max(0, -Math.cos(half)) * extent;
  const h = Math.round(cy + below + 36);
  return { k, w, h, cx: w / 2, cy, half, bandR, bandW, inner, outer, histR0, histH, needle0: Math.round(bandR * 0.62) };
}

/**
 * The free region of osu!'s layout the dial lives in, and how it sits there. osu!: the band
 * right of the playfield (left: under the leaderboard); mania: beside the stage, hugging it;
 * taiko: the empty area below the lane (centred, or at either end).
 */
function zone(m) {
  // Mania: the stage from the skin's skin.ini (vosu serves it), with the user's overrides on top.
  const stage = m === 'mania' ? { ...(maniaStage || {}) } : {};
  if (m === 'mania' && cfg.columnStart > 0) stage.columnStart = cfg.columnStart;
  if (m === 'mania' && cfg.columnWidth > 0) stage.columnWidth = cfg.columnWidth;
  const layout = osuLayout(m, { keys, client, ...stage });
  const { busy, hud } = layout;
  const top = hud.health.y + hud.health.h + MARGIN;
  if (m === 'taiko') {
    const y = busy.y + busy.h + MARGIN;
    const rect = { x: MARGIN, y, w: W - 2 * MARGIN, h: H - y - MARGIN };
    return { rect, h: cfg.side === 'left' ? 'start' : cfg.side === 'right' ? 'end' : 'center', v: 'start' };
  }
  const side = cfg.side === 'auto' ? (m === 'osu' ? 'right' : 'left') : cfg.side;
  if (side === 'left') {
    const y = m === 'osu' ? hud.leaderboard.y + hud.leaderboard.h + MARGIN : top;
    const bottom = hud.combo ? hud.combo.y - MARGIN : H - MARGIN;
    return { rect: { x: MARGIN, y, w: busy.x - 2 * MARGIN, h: bottom - y }, h: m === 'mania' ? 'end' : 'center', v: 'end' };
  }
  // Mania: stay clear of the HP bar that skins hang off the stage's right edge.
  const x = busy.x + busy.w + (m === 'mania' ? 112 : MARGIN);
  const y = hud.accuracy.y + hud.accuracy.h + MARGIN;
  const right = hud.keys ? hud.keys.x - MARGIN : W - MARGIN;
  return { rect: { x, y, w: right - x, h: H - MARGIN - y }, h: m === 'mania' ? 'start' : 'center', v: 'end' };
}

function place() {
  placeDirty = false;
  const { rect, h: alignX, v: alignY } = zone(SUPPORTED.has(mode) ? mode : 'osu');
  // The default size fits the zone (stable's 4K/7K area left of the stage is ~300 px wide);
  // the scale setting multiplies that fitted size, so users with roomier skins can grow it.
  const natural = geometry(1);
  const fitK = Math.min(1, rect.w / natural.w, rect.h / natural.h) * 0.995;
  const g = geometry(fitK * cfg.scale / 100);
  Object.assign(geo, g);
  const align = (mode, start, span, size) => start + (mode === 'start' ? 0 : mode === 'end' ? span - size : (span - size) / 2);
  const x = Math.round(align(alignX, rect.x, rect.w, g.w) + cfg.offsetX);
  const y = Math.round(align(alignY, rect.y, rect.h, g.h) + cfg.offsetY);

  dial.style.width = `${g.w}px`;
  dial.style.height = `${g.h}px`;
  dial.style.transform = `translate(${x}px, ${y}px)`;
  dial.dataset.backing = cfg.backing;
  const urSize = Math.max(26, Math.round(54 * g.k));
  const readoutY = Math.round(g.cy - g.bandR * (g.half > 1.9 ? 0.2 : 0.3));
  readout.style.left = `${g.w / 2}px`;
  readout.style.top = `${readoutY}px`;
  readout.style.setProperty('--ur-size', `${urSize}px`);
  // Brand tag sits in the hollow under the readout, level with the end labels when they are lower.
  const readoutBottom = readoutY + (14 + 0.9 * urSize) / 2;
  const endLabelY = g.cy - Math.cos(g.half) * (g.inner - 2 - 9 * g.k - 6);
  brand.style.left = `${g.w / 2}px`;
  brand.style.top = `${Math.round(Math.min(g.h - 34, Math.max(readoutBottom + 14, endLabelY)))}px`;
  chip.style.transform = `translate(${Math.round(x + g.w / 2)}px, ${y + g.h - 28}px) translateX(-50%)`;
  brand.hidden = !cfg.showBrand;
  size();
  aimTicks();
}

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
  const fw = Math.round(FINAL_W * dpr);
  const fh = Math.round(FINAL_H * dpr);
  if (finalCanvas.width !== fw || finalCanvas.height !== fh) { finalCanvas.width = fw; finalCanvas.height = fh; }
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  finalDirty = true;
}
const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { placeDirty = true; schedule(); watchDpr(); }, { once: true });
watchDpr();
document.fonts.load(`500 12px ${monoFont}`).then(() => { readTokens(); baseDirty = true; schedule(); }, () => {});

// ------------------------------------------------------------------ render
function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  const dt = lastFrame && now - lastFrame < 100 ? now - lastFrame : 16;
  lastFrame = now;
  if (placeDirty) place();
  if (domDirty) applyDom();
  if (finalDirty && finalShown) drawFinal();
  if (!shown) { lastFrame = 0; return; }
  if (baseDirty) drawBase();
  if (histDirty) drawHist();
  if (textDirty) writeText();
  if (drawLive(now, dt)) schedule();
  else lastFrame = 0;
}

let lastChip = '';
function applyDom() {
  domDirty = false;
  const live = conn === 'live';
  // The dial is for gameplay. Song select already shows OD; lazer's results show a timing
  // distribution and UR, stable's only on a graph hover, so stable results get the final strip.
  const next = live && state === PLAY && SUPPORTED.has(mode);
  if (next !== shown) {
    shown = next;
    dial.dataset.shown = String(next);
    if (next) baseDirty = histDirty = textDirty = true;
  }
  const nextFinal = live && state === RESULTS && SUPPORTED.has(mode) && client === 'stable' && total >= 2;
  if (nextFinal !== finalShown) {
    finalShown = nextFinal;
    finalEl.dataset.shown = String(nextFinal);
    if (nextFinal) finalDirty = true;
  }
  finalEl.dataset.backing = cfg.backing;
  const label = !live ? (conn === 'offline' ? 'vosu offline' : 'Connecting to vosu') : state === undefined ? 'Waiting for osu!' : '';
  chip.dataset.shown = String(Boolean(label));
  chip.dataset.state = live ? 'idle' : conn;
  if (label && label !== lastChip) { lastChip = label; chipText.textContent = label; }
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
    if ((mean === '—') !== (lastMean === '—')) dial.dataset.empty = String(mean === '—');
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
  const d = r - gap - (Math.abs(cos) * width / 2 + Math.abs(sin) * 5);
  c.fillText(text, Math.round(geo.cx + cos * d), Math.round(geo.cy + sin * d));
}

const SHADOW = 'rgb(0 0 0 / 0.7)';
function drawBase() {
  baseDirty = false;
  const c = bctx;
  const { cx, cy, half, k, bandR, bandW, inner, outer } = geo;
  const floating = cfg.backing !== 'panel';
  c.clearRect(0, 0, geo.w, geo.h);
  c.lineCap = 'butt';

  // Floating on the game: a soft dark ring under the band and tick lane keeps the colours
  // legible over bright maps without drawing a box. Static, so its blur costs nothing per frame.
  if (floating) {
    c.save();
    c.strokeStyle = 'rgb(5 6 7 / 0.42)';
    c.shadowColor = 'rgb(5 6 7 / 0.6)';
    c.shadowBlur = 14 * k;
    c.lineWidth = bandW + 16 * k;
    c.beginPath();
    c.arc(cx, cy, bandR - 5 * k, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.stroke();
    c.restore();
  }

  // Window bands: one arc segment per judgement on each side, separated by a 1 px gap.
  c.lineWidth = bandW;
  if (!segs.length) {
    c.globalAlpha = 0.5;
    c.strokeStyle = colors.muted;
    c.beginPath();
    c.arc(cx, cy, bandR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.stroke();
  } else {
    const gap = 0.5 / bandR;
    let prev = 0;
    c.globalAlpha = floating ? 0.55 : 0.42;
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

  if (floating) {
    c.shadowColor = SHADOW;
    c.shadowBlur = 2;
    c.shadowOffsetY = 1;
  }
  // Graduations inside the band: fine marks on a round step, longer marks on window edges.
  const g0 = inner - 2;
  c.lineWidth = 1;
  c.globalAlpha = 0.7;
  c.strokeStyle = colors.fgDim;
  c.beginPath();
  const step = niceStep(scale);
  for (let v = step; v < scale - step * 0.25; v += step) {
    radial(c, angleOf(v), g0, g0 - 4 * k);
    radial(c, angleOf(-v), g0, g0 - 4 * k);
  }
  c.stroke();
  c.globalAlpha = 1;
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
  c.strokeStyle = colors.fg;
  c.lineWidth = 1.5;
  c.beginPath();
  radial(c, -Math.PI / 2, outer + 3, g0 - 11 * k);
  c.stroke();

  // Histogram baseline.
  if (cfg.histogram) {
    c.lineWidth = 1;
    c.strokeStyle = floating ? colors.muted : colors.ruleStrong;
    c.beginPath();
    c.arc(cx, cy, geo.histR0 - 0.5, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.stroke();
  }

  // Scale labels: the outermost window on each side.
  if (range) {
    c.font = `500 12px ${monoFont}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = colors.fgDim;
    const text = String(Math.round(range * 10) / 10);
    rayLabel(c, MINUS + text, angleOf(-range), g0, 9 * k);
    rayLabel(c, `+${text}`, angleOf(range), g0, 9 * k);
  }
  c.shadowColor = 'transparent';
  c.shadowBlur = 0;
  c.shadowOffsetY = 0;
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
  const baseR = outer + 1.5 + 6 * k;
  const w = 3.5 * k;
  c.globalAlpha = 1;
  c.fillStyle = colors.fg;
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
  const binAngle = (2 * half) / BINS;
  const start = -Math.PI / 2 - half;
  // A stepped envelope along the arc: a faint fill with a crisp top edge reads as one
  // distribution rather than a row of separate bars.
  c.beginPath();
  envelope(c, first, last, unit);
  c.arc(cx, cy, histR0, start + (last + 1) * binAngle, start + first * binAngle, true);
  c.closePath();
  c.fillStyle = colors.fgDim;
  c.globalAlpha = 0.24;
  c.fill();
  c.beginPath();
  envelope(c, first, last, unit);
  c.lineWidth = 1.25;
  c.lineJoin = 'miter';
  c.strokeStyle = colors.fgDim;
  c.globalAlpha = 0.95;
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

// Results strip: the whole attempt's distribution as a flat profile over the window bands.
const FINAL_BINS = 61;
const finalBins = new Uint32Array(FINAL_BINS);
function drawFinal() {
  finalDirty = false;
  const c = fctx;
  c.clearRect(0, 0, FINAL_W, FINAL_H);
  finalBins.fill(0);
  let max = 0;
  if (finalErrors) {
    for (const error of finalErrors) {
      if (typeof error !== 'number' || !Number.isFinite(error)) continue;
      const b = clamp(Math.floor((error + scale) / (2 * scale) * FINAL_BINS), 0, FINAL_BINS - 1);
      if (++finalBins[b] > max) max = finalBins[b];
    }
  }
  const xOf = error => (clamp(error, -scale, scale) + scale) / (2 * scale) * FINAL_W;
  const base = FINAL_H - 6;
  // Window bands as a thin strip under the profile.
  c.globalAlpha = 0.75;
  let prev = 0;
  for (const seg of segs) {
    c.fillStyle = colors.judge[seg.cls];
    c.fillRect(xOf(prev), base + 2, xOf(seg.edge) - xOf(prev) - (seg.edge === range ? 0 : 1), 3);
    c.fillRect(xOf(-seg.edge) + (seg.edge === range ? 0 : 1), base + 2, xOf(-prev) - xOf(-seg.edge) - (seg.edge === range ? 0 : 1), 3);
    prev = seg.edge;
  }
  if (max) {
    const unit = (base - 2) / max;
    const step = FINAL_W / FINAL_BINS;
    c.beginPath();
    c.moveTo(0, base);
    for (let b = 0; b < FINAL_BINS; b++) {
      const y = base - finalBins[b] * unit;
      c.lineTo(b * step, y);
      c.lineTo((b + 1) * step, y);
    }
    c.lineTo(FINAL_W, base);
    c.closePath();
    c.fillStyle = colors.fgDim;
    c.globalAlpha = 0.24;
    c.fill();
    c.globalAlpha = 0.95;
    c.strokeStyle = colors.fgDim;
    c.lineWidth = 1.25;
    c.lineJoin = 'miter';
    c.stroke();
  }
  // Zero line and the attempt's mean.
  c.globalAlpha = 1;
  c.fillStyle = colors.fg;
  c.fillRect(Math.round(FINAL_W / 2), 0, 1, base + 5);
  if (total) {
    const x = xOf(sum / total);
    c.fillStyle = colors.hl;
    c.beginPath();
    c.moveTo(x, base - 7);
    c.lineTo(x - 4, base + 1);
    c.lineTo(x + 4, base + 1);
    c.closePath();
    c.fill();
  }
  const ur = total >= 2 ? (Math.sqrt(Math.max(0, sumSq / total - (sum / total) ** 2)) * 10).toFixed(2) : '—';
  const mean = total >= 2 ? signed(sum / total, 1) : '—';
  const span = range ? `±${Math.round(range * 10) / 10} ms` : '';
  if (finalUr.textContent !== ur) finalUr.textContent = ur;
  if (finalMean.textContent !== mean) finalMean.textContent = mean;
  if (finalRange.textContent !== span) finalRange.textContent = span;
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
  if (total) {
    const target = avgSum / Math.min(total, cfg.averageHits);
    needle += (target - needle) * (1 - Math.exp(-dt / 90));
    if (Math.abs(target - needle) < 0.02) needle = target;
    else moving = true;
    const a = angleOf(needle);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const n0 = geo.needle0;
    const n1 = inner - 12 * k;
    const w0 = 2.75 * k;
    const w1 = 0.6;
    c.fillStyle = colors.hl;
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

// Copyright (c) 2026 18-LAB. MIT.
// Timing drift: rolling mean hit error and rolling unstable rate across the attempt, so a
// player can see whether they slide early or late (and loosen up) as the map goes on.
// Floats in a free region of osu!'s own layout (osuLayout) instead of taking screen space.
import {
  subscribe, settings, fit, activeMode, isPlaying, formatDuration, osuLayout, mapPalette, applyPalette,
} from './vosu-overlay.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const RESULTS = 7;
const BLOCK_W = 288;        // content width of the cluster, CSS px at scale 1
const BLOCK_CHROME = 126;   // header + readouts + gaps + axis around the chart
const LANE_GAP = 8;
const MIN_POINTS = 10;      // a rolling value is drawn once this many hits back it
const BREAK_MS = 3000;      // silences longer than this (breaks) open the trace
const SYMLOG_MS = 4;        // the mean axis is ~linear inside ±4 ms, logarithmic beyond
const CHART_INTERVAL = 33;  // ms between chart redraws (≈30 Hz)
const TEXT_INTERVAL = 120;  // ms between readout updates: slow enough to read
const DASH = [3, 3];
const SOLID = [];

const P_STATE = '/state/number';
const P_PLAY_MODE = '/play/mode/number';
const P_SETTINGS_MODE = '/settings/mode/number';
const P_ERRORS = '/play/hitErrorArray';
const P_GREAT = '/beatmap/stats/hitWindow/great';
const P_LIVE = '/beatmap/time/live';
const P_FIRST = '/beatmap/time/firstObject';
const P_LAST = '/beatmap/time/lastObject';
const P_CHECKSUM = '/beatmap/checksum';
const POINTERS = [P_STATE, P_PLAY_MODE, P_SETTINGS_MODE, P_ERRORS, P_GREAT, P_LIVE, P_FIRST, P_LAST, P_CHECKSUM];

const $ = id => document.getElementById(id);
const stage = $('stage');
const block = $('block');
const canvas = $('chart');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  brand: $('brand'), phase: $('phase'), statusText: $('statusText'), meta: $('meta'),
  meanNow: $('meanNow'), meanValue: $('meanValue'), meanAll: $('meanAll'), dir: $('dir'),
  urNow: $('urNow'), urValue: $('urValue'), urAll: $('urAll'),
  empty: $('empty'), count: $('count'), t0: $('t0'), t1: $('t1'),
};

// ---------------------------------------------------------------- palette (vosu tokens)
const tokens = getComputedStyle(document.documentElement);
const token = (name, fallback) => tokens.getPropertyValue(name).trim() || fallback;
function rgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
const FG = token('--fg', '#ebe8e1');
const LATE = token('--accent', '#ff963f');
const EARLY = token('--signal', '#7fa6cf');
// Early/late colours carry meaning and stay fixed; only the live marker takes the map tint.
const C = {
  halo: 'rgba(0,0,0,0.45)',
  band: rgba(FG, 0.06),
  bandEdge: rgba(FG, 0.24),
  zero: rgba(FG, 0.6),
  grid: rgba(FG, 0.1),
  overall: rgba(token('--fg-dim', '#b8b5ad'), 0.75),
  label: token('--fg-dim', '#b8b5ad'),
  late: LATE, lateFill: rgba(LATE, 0.16), lateLabel: LATE,
  early: EARLY, earlyFill: rgba(EARLY, 0.16), earlyLabel: EARLY,
  ur: rgba(FG, 0.9), urFill: rgba(FG, 0.05),
};
let tint = LATE;            // live marker: the map's accent, or 18-LAB amber
const FONT = '500 12px "IBM Plex Mono", ui-monospace, monospace';

// ---------------------------------------------------------------- attempt store
// Per-hit history in preallocated typed arrays (grown by doubling, never per hit).
let capacity = 0;
let errors, times, rollMean, rollUr;
let count = 0;                     // hits ingested this attempt
let windowSize = 50;
let winSum = 0, winSq = 0;         // running sums over the last `windowSize` hits
let totSum = 0, totSq = 0;         // running sums over the whole attempt
let peakMean = 0, peakUr = 0;      // drawn-range extremes, for the axes
let held = false;                  // the attempt ended (song select keeps its curve)
let axisStart = NaN, axisEnd = NaN; // map time domain; NaN → hit-index axis
let byIndex = false;
let attemptMode = null;
let attemptGreat = NaN;
let live = undefined;              // latest map clock, stamps arriving hits

function ensure(size) {
  if (size <= capacity) return;
  let next = Math.max(4096, capacity);
  while (next < size) next *= 2;
  const grow = (old, Type) => {
    const array = new Type(next);
    if (old) array.set(old.subarray(0, count));
    return array;
  };
  errors = grow(errors, Float64Array);
  times = grow(times, Float64Array);
  rollMean = grow(rollMean, Float32Array);
  rollUr = grow(rollUr, Float32Array);
  capacity = next;
}

const minPoints = () => (windowSize < MIN_POINTS ? windowSize : MIN_POINTS);
const filled = i => (i + 1 < windowSize ? i + 1 : windowSize);

/** Rolling mean/UR at hit i from the running window sums (O(1) per hit). */
function roll(i) {
  const e = errors[i];
  winSum += e; winSq += e * e;
  if (i >= windowSize) { const old = errors[i - windowSize]; winSum -= old; winSq -= old * old; }
  const n = filled(i);
  const m = winSum / n;
  const variance = winSq / n - m * m;
  const ur = variance > 0 ? 10 * Math.sqrt(variance) : 0;
  rollMean[i] = m;
  rollUr[i] = ur;
  if (n >= minPoints()) {
    const a = m < 0 ? -m : m;
    if (a > peakMean) peakMean = a;
    if (ur > peakUr) peakUr = ur;
  }
}

function recomputeRolling() {
  winSum = winSq = peakMean = peakUr = 0;
  for (let i = 0; i < count; i++) roll(i);
}

function beginAttempt(values) {
  count = 0;
  winSum = winSq = totSum = totSq = peakMean = peakUr = 0;
  held = false;
  const first = values[P_FIRST];
  const last = values[P_LAST];
  byIndex = !(Number.isFinite(first) && Number.isFinite(last) && last > first);
  axisStart = byIndex ? 0 : first;
  axisEnd = byIndex ? 1 : last;
  clearColumns();
}

function errorAt(list, i) {
  const value = Number(list[i]);
  return Number.isFinite(value) ? value : 0;
}

/** True when `list` extends the stored history (spot-checks the middle and last stored hit). */
function continues(list) {
  const mid = count >> 1;
  return errorAt(list, mid) === errors[mid] && errorAt(list, count - 1) === errors[count - 1];
}

/**
 * Same attempt, but earlier entries changed (vosu itself only appends; the dev mock inserts
 * mania releases mid-array). Re-reads the stored range and keeps the arrival times.
 */
function rebase(list) {
  totSum = totSq = 0;
  for (let i = 0; i < count; i++) {
    const e = errorAt(list, i);
    errors[i] = e;
    totSum += e; totSq += e * e;
  }
  recomputeRolling();
  columnsStale = true;
  chartDirty = textDirty = true;
}

function ingest(values) {
  const list = values[P_ERRORS];
  const length = Array.isArray(list) ? list.length : 0;
  if (length === 0) {
    // vosu clears the arrays when the attempt is left; keep its curve as the last attempt.
    if (count > 0) held = true;
    return;
  }
  // A shrunk list or a different first hit is a new attempt (or a reconnect into one).
  if (length < count || held || count === 0 || errorAt(list, 0) !== errors[0]) beginAttempt(values);
  else if (!continues(list)) rebase(list);
  if (!held) {
    const mode = activeMode(values[P_STATE], values[P_PLAY_MODE], values[P_SETTINGS_MODE]);
    if (mode) attemptMode = mode;
    const great = values[P_GREAT];
    attemptGreat = Number.isFinite(great) && great > 0 ? great : NaN;
  }
  if (length === count) return;
  ensure(length);
  // A snapshot that already holds many hits (overlay opened mid-attempt or on results) has no
  // arrival times: spread them evenly up to the current clock.
  const backfill = count === 0 && length > 1 && !byIndex;
  const until = Number.isFinite(live) ? Math.min(Math.max(live, axisStart), axisEnd) : axisEnd;
  for (let i = count; i < length; i++) {
    const e = errorAt(list, i);
    errors[i] = e;
    totSum += e; totSq += e * e;
    if (byIndex) times[i] = i;
    else if (backfill) times[i] = axisStart + (until - axisStart) * (i + 1) / length;
    else {
      const now = Number.isFinite(live) ? live : i ? times[i - 1] : axisStart;
      times[i] = i && times[i - 1] > now ? times[i - 1] : now;
    }
    roll(i);
  }
  const from = count;
  count = length;
  if (byIndex) { axisEnd = Math.max(1, count - 1); columnsStale = true; }
  else for (let i = from; i < count; i++) place(i);
  chartDirty = textDirty = true;
}

// ---------------------------------------------------------------- pixel columns
// The chart keeps one value per CSS-pixel column (the latest hit landing there), so drawing
// costs O(width) no matter how long the map is. Flags: 1 has value, 2 warm-up, 4 opens a segment.
let columns = 0;
let colMean = new Float32Array(0), colUr = new Float32Array(0), colFlags = new Uint8Array(0);
let lastColumn = -1, firstFullColumn = -1, lastPlacedTime = NaN;
let columnsStale = false;

function clearColumns() {
  colFlags.fill(0);
  lastColumn = firstFullColumn = -1;
  lastPlacedTime = NaN;
}

function place(i) {
  const n = filled(i);
  if (n < minPoints() || columns === 0) return;
  const span = axisEnd - axisStart;
  let c = span > 0 ? Math.round((times[i] - axisStart) / span * (columns - 1)) : 0;
  if (c < 0) c = 0; else if (c >= columns) c = columns - 1;
  let flags = 1;
  if (n < windowSize) flags |= 2;
  else if (firstFullColumn < 0) firstFullColumn = c;
  if (c === lastColumn) flags |= colFlags[c] & 4;
  else if (!byIndex && times[i] - lastPlacedTime > BREAK_MS) flags |= 4;
  colFlags[c] = flags;
  colMean[c] = rollMean[i];
  colUr[c] = rollUr[i];
  lastColumn = c;
  lastPlacedTime = times[i];
}

function rebuildColumns() {
  clearColumns();
  for (let i = 0; i < count; i++) place(i);
  columnsStale = false;
}

// ---------------------------------------------------------------- canvas geometry
let cssW = 0, cssH = 0, scale = 1;
let chartH = 150, meanH = 88, urH = 54, showUr = true;
let userScale = 1;
let arrange = 'stack';     // stack: gameplay cluster; strip: results header band
const STRIP_W = 880;
const STRIP_CHART = 98;

function stageScale() {
  return Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H) || 1;
}

function resizeBacking() {
  if (!cssW || !cssH) return;
  scale = (devicePixelRatio || 1) * stageScale() * userScale;
  canvas.width = Math.max(1, Math.round(cssW * scale));
  canvas.height = Math.max(1, Math.round(cssH * scale));
  const next = Math.max(1, Math.round(cssW));
  if (next !== columns) {
    columns = next;
    colMean = new Float32Array(columns);
    colUr = new Float32Array(columns);
    colFlags = new Uint8Array(columns);
    columnsStale = true;
  }
  chartDirty = true;
  invalidate();
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  cssW = box.width;
  cssH = box.height;
  resizeBacking();
}).observe(canvas);
addEventListener('resize', resizeBacking);

/** Lane heights for the current arrangement; the CSS reads them back as custom properties. */
function setLanes() {
  const h = arrange === 'strip' ? STRIP_CHART : chartH;
  meanH = showUr ? Math.round((h - LANE_GAP) * 0.62) : h;
  urH = showUr ? h - LANE_GAP - meanH : 0;
  block.style.setProperty('--h', `${h}px`);
  block.style.setProperty('--mean-h', `${meanH}px`);
  chartDirty = true;
}

/** Snaps a coordinate to the centre of a device pixel so 1-device-px hairlines stay crisp. */
const crisp = v => (Math.round(v * scale - 0.5) + 0.5) / scale;

// ---------------------------------------------------------------- drawing
// Everything floats on the game: no wells; each mark gets a thin dark halo for contrast.
let meanMid = 0, meanHalf = 0, meanRange = 1, meanDenom = 1;
let urTop = 0, urBottom = 0, urMax = 100;
let tintLine = rgba(LATE, 0.6);

function ym(v) {
  const a = v < 0 ? -v : v;
  const d = Math.log1p((a < meanRange ? a : meanRange) / SYMLOG_MS) / meanDenom * meanHalf;
  return v < 0 ? meanMid + d : meanMid - d;
}
function yu(v) {
  return urBottom - 1 - (v < urMax ? v : urMax) / urMax * (urH - 4);
}

const PAD_X = 4; // keeps end dots clear of the chart edges
const colX = c => PAD_X + (c + 0.5) * (cssW - 2 * PAD_X) / columns;

/** Issues the trace (or its area down to `base`) from the column store into the context. */
function trace(ur, area, base) {
  ctx.beginPath();
  let open = false;
  let lastX = 0;
  for (let c = 0; c < columns; c++) {
    const flags = colFlags[c];
    if (!(flags & 1)) continue;
    const x = colX(c);
    const y = ur ? yu(colUr[c]) : ym(colMean[c]);
    if (!open || flags & 4) {
      if (open && area) { ctx.lineTo(lastX, base); ctx.closePath(); }
      if (area) { ctx.moveTo(x, base); ctx.lineTo(x, y); } else ctx.moveTo(x, y);
      open = true;
    } else ctx.lineTo(x, y);
    lastX = x;
  }
  if (open && area) { ctx.lineTo(lastX, base); ctx.closePath(); }
}

function paintTrace(ur, base, stroke, fill, width) {
  trace(ur, true, base);
  ctx.fillStyle = fill;
  ctx.fill();
  trace(ur, false, base);
  ctx.strokeStyle = C.halo;
  ctx.lineWidth = width + 2.5;
  ctx.stroke();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Paints a trace inside a clip band; warm-up columns (window not yet full) are faded. */
function paintClipped(ur, y0, h, base, stroke, fill, width) {
  const warmX = firstFullColumn < 0 ? cssW : colX(firstFullColumn) - 0.5;
  if (warmX > 0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, y0, warmX, h); ctx.clip();
    ctx.globalAlpha = 0.4;
    paintTrace(ur, base, stroke, fill, width);
    ctx.restore();
  }
  if (warmX < cssW) {
    ctx.save();
    ctx.beginPath(); ctx.rect(warmX, y0, cssW - warmX, h); ctx.clip();
    paintTrace(ur, base, stroke, fill, width);
    ctx.restore();
  }
}

function hline(y, color, dash, halo) {
  ctx.setLineDash(dash);
  ctx.lineWidth = 1 / scale;
  if (halo) {
    ctx.strokeStyle = C.halo;
    ctx.beginPath(); ctx.moveTo(0, crisp(y + 1)); ctx.lineTo(cssW, crisp(y + 1)); ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(0, crisp(y)); ctx.lineTo(cssW, crisp(y)); ctx.stroke();
}

function label(text, x, y, color, align) {
  ctx.textAlign = align;
  ctx.fillStyle = C.halo;
  ctx.fillText(text, x, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function dot(x, y, r, color) {
  ctx.fillStyle = C.halo;
  ctx.beginPath(); ctx.arc(x, y, r + 1.25, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

function niceUr(v) {
  const step = v <= 100 ? 20 : v <= 300 ? 50 : 100;
  return Math.ceil(v / step) * step;
}

// Axis label strings, rebuilt only when their value changes.
let greatKey = NaN, greatTop = '';
let urKey = NaN, urText = '';

/** Faint vertical hairlines at every minute of map time, so the trace reads against the clock. */
function minuteGrid(top, height) {
  const span = axisEnd - axisStart;
  if (byIndex || !(span > 0)) return;
  ctx.fillStyle = C.grid;
  for (let t = Math.ceil(axisStart / 60000) * 60000 || 60000; t < axisEnd; t += 60000) {
    const x = PAD_X + (t - axisStart) / span * (cssW - 2 * PAD_X);
    ctx.fillRect(crisp(x) - 0.5 / scale, top, 1 / scale, height);
  }
}

function draw(withCurve, livePhase) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = FONT;
  ctx.letterSpacing = '0.5px';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  if (columnsStale) rebuildColumns();
  const curve = withCurve && count > 0 && lastColumn >= 0;
  const overallMean = count ? totSum / count : 0;
  const overallVar = count ? totSq / count - overallMean * overallMean : 0;
  const overallUr = count > 1 && overallVar > 0 ? 10 * Math.sqrt(overallVar) : 0;

  // Mean lane: diverging around zero, LATE above, EARLY below, on a symmetric log scale so
  // millisecond drift reads clearly while the ±great window still fits.
  const great = withCurve ? attemptGreat : NaN;
  meanMid = meanH / 2;
  meanHalf = meanMid - 3;
  const fromData = (curve ? Math.max(peakMean, Math.abs(overallMean)) : 0) * 1.25;
  meanRange = Math.max(Number.isFinite(great) ? great * 1.3 : 20, fromData, 8);
  meanDenom = Math.log1p(meanRange / SYMLOG_MS);
  const zeroY = meanMid;
  if (Number.isFinite(great)) {
    const top = ym(great), bottom = ym(-great);
    ctx.fillStyle = C.band;
    ctx.fillRect(0, top, cssW, bottom - top);
    hline(top, C.bandEdge, SOLID, true);
    hline(bottom, C.bandEdge, SOLID, true);
    const g = Math.round(great);
    if (g !== greatKey) { greatKey = g; greatTop = `±${g}`; }
    label(greatTop, cssW, top + 12, C.label, 'right');
  }
  label('LATE', 0, 10, C.lateLabel, 'left');
  label('EARLY', 0, meanH - 2, C.earlyLabel, 'left');

  if (curve) {
    minuteGrid(0, meanH);
    paintClipped(false, 0, zeroY, zeroY, C.late, C.lateFill, 1.75);
    paintClipped(false, zeroY, meanH - zeroY, zeroY, C.early, C.earlyFill, 1.75);
  }
  hline(zeroY, C.zero, SOLID, true);
  if (curve) hline(ym(overallMean), C.overall, DASH, false);

  // UR lane: rolling unstable rate from zero.
  if (showUr) {
    urTop = meanH + LANE_GAP;
    urBottom = urTop + urH;
    urMax = niceUr(Math.max(curve ? Math.max(peakUr * 1.12, overallUr * 1.2) : 0, 60));
    hline(yu(urMax / 2), C.grid, SOLID, false);
    if (curve) {
      minuteGrid(urTop, urH);
      paintClipped(true, urTop, urH, urBottom - 1, C.ur, C.urFill, 1.5);
      hline(yu(overallUr), C.overall, DASH, false);
      if (urMax !== urKey) { urKey = urMax; urText = String(urMax); }
      label(urText, 0, urTop + 10, C.label, 'left');
    }
    hline(urBottom - 1, C.bandEdge, SOLID, true);
  }
  ctx.setLineDash(SOLID);

  if (curve) {
    const x = colX(lastColumn);
    if (livePhase) {
      ctx.fillStyle = tintLine;
      ctx.fillRect(crisp(x) - 0.5 / scale, 0, 1 / scale, cssH);
    }
    const m = colMean[lastColumn];
    dot(x, ym(m), 3, m < 0 ? C.early : C.late);
    if (showUr) dot(x, yu(colUr[lastColumn]), 2.5, FG);
  }
}

// ---------------------------------------------------------------- placement
// Gameplay: a cluster in a free region of osu!'s default layout for the ruleset (osuLayout):
// osu! the side band right of the playfield (left of the key counter), taiko under the lane,
// mania beside the stage. Results: a strip in the free right part of the header band.
// Zone, nudge and scale settings cover other skins.
let zone = 'auto', offsetX = 0, offsetY = 0;
let placedKey = '';

function placeBlock(mode, nextArrange) {
  const ruleset = mode === 'taiko' || mode === 'mania' ? mode : 'osu';
  const key = `${ruleset}${nextArrange}${zone}${offsetX},${offsetY},${userScale},${chartH},${showUr}`;
  if (key === placedKey) return;
  placedKey = key;
  if (nextArrange !== arrange) {
    arrange = nextArrange;
    block.dataset.arrange = arrange;
    setLanes();
  }
  const layout = osuLayout(ruleset);
  const { busy, hud } = layout;
  const strip = arrange === 'strip';
  const w = (strip ? STRIP_W : BLOCK_W) * userScale;
  const h = (strip ? STRIP_CHART + 20 : BLOCK_CHROME + chartH) * userScale;
  const side = zone === 'auto' ? (ruleset === 'taiko' ? 'left' : 'right') : zone;
  let x, y;
  if (strip) {
    // stable's results header: title/mapper on the left, free from x≈1000 to the right edge.
    x = side === 'left' ? 1000 : layout.width - 20 - w;
    y = 12;
  } else if (ruleset === 'taiko') {
    x = side === 'left' ? 160 : layout.width - 160 - w;
    y = busy.y + busy.h + 56;
  } else if (ruleset === 'mania') {
    x = side === 'left' ? 64 : layout.width - 64 - w;
    y = (layout.height - h) / 2;
  } else if (side === 'left') {
    x = busy.x - 40 - w;
    y = hud.combo.y - 24 - h;
  } else {
    x = Math.max(hud.keys.x - 24 - w, busy.x + busy.w + 16);
    y = layout.height - 64 - h;
  }
  x = Math.min(Math.max(0, x + offsetX), layout.width - w);
  y = Math.min(Math.max(0, y + offsetY), layout.height - h);
  block.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) scale(${userScale})`;
}

// ---------------------------------------------------------------- map tint
let accentMode = 'map';
let palette = null;
let paletteFor = null;
let paletteRequest = 0;

function applyTint() {
  const useMap = accentMode === 'map' && palette;
  applyPalette(block, useMap ? palette : null);
  tint = useMap ? palette.accent : LATE;
  tintLine = rgba(tint, 0.6);
  chartDirty = true;
  invalidate();
}

/** Loads the map's tonal palette off the hot path (cached per checksum by the shared client). */
function loadPalette(checksum) {
  if (accentMode !== 'map' || checksum === paletteFor) return;
  paletteFor = checksum;
  const request = ++paletteRequest;
  mapPalette(checksum).then(result => {
    if (request !== paletteRequest) return;
    palette = result;
    applyTint();
  }, () => {});
}

// ---------------------------------------------------------------- text and state
let status = 'connecting';
let sub = null;
let onResults = true;

function put(node, text) {
  if (node.__text !== text) { node.__text = text; node.textContent = text; }
}
function attr(node, name, value) {
  if (node.__attrs?.[name] !== value) {
    (node.__attrs ||= {})[name] = value;
    node.setAttribute(name, value);
  }
}
function signed(v) {
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}

function phaseOf(values) {
  if (status !== 'live') return 'offline';
  const state = values[P_STATE];
  if (state === undefined) return 'absent';
  if (isPlaying(state)) return 'live';
  if (state === RESULTS && count > 0 && !held) return 'results';
  return 'idle';
}

/**
 * full: gameplay, and results (neither client shows timing over the course of the attempt);
 * status: one tiny line when vosu or osu! is unavailable; hidden: menus, song select, catch.
 */
function viewOf(phase, mode) {
  if (mode === 'fruits') return 'hidden';
  if (phase === 'offline' || phase === 'absent') return 'status';
  if (phase === 'live' || (phase === 'results' && onResults)) return 'full';
  return 'hidden';
}

let curveShown = false;
let livePhase = false;

function applyText() {
  const values = sub ? sub.values : {};
  const phase = phaseOf(values);
  const mode = activeMode(values[P_STATE], values[P_PLAY_MODE], values[P_SETTINGS_MODE]);
  const view = viewOf(phase, mode);
  attr(block, 'data-view', view);
  attr(block, 'data-phase', phase);
  attr(block, 'data-status', phase === 'absent' ? 'absent' : status);
  if (view !== 'hidden') placeBlock(mode || attemptMode, phase === 'results' ? 'strip' : 'stack');
  put(el.statusText, phase === 'absent' ? 'osu! not running' : status === 'connecting' ? 'Connecting to vosu' : 'vosu offline');
  put(el.phase, phase === 'live' ? 'Live' : phase === 'results' ? 'Results' : '');
  put(el.meta, `Last ${windowSize}`);

  const shown = view === 'full' && count > 0 && !(phase === 'live' && held);
  const ready = shown && count >= minPoints();
  const m = ready ? rollMean[count - 1] : NaN;
  put(el.meanNow, ready ? signed(m) : '—');
  put(el.urNow, ready ? rollUr[count - 1].toFixed(1) : '—');
  attr(el.meanValue, 'data-empty', ready ? 'false' : 'true');
  attr(el.urValue, 'data-empty', ready ? 'false' : 'true');
  const overallMean = count ? totSum / count : 0;
  const overallVar = count ? totSq / count - overallMean * overallMean : 0;
  put(el.meanAll, shown ? signed(overallMean) : '—');
  put(el.urAll, shown && count > 1 ? (overallVar > 0 ? 10 * Math.sqrt(overallVar) : 0).toFixed(1) : '—');
  const dir = !ready ? 'none' : m <= -0.5 ? 'early' : m >= 0.5 ? 'late' : 'centre';
  attr(el.dir, 'data-dir', dir);
  put(el.dir, dir === 'early' ? 'Early' : dir === 'late' ? 'Late' : dir === 'centre' ? 'Centred' : '');

  put(el.count, shown ? `${count} ${count === 1 ? 'hit' : 'hits'}` : '');
  put(el.t0, shown ? (byIndex ? 'Hit 1' : formatDuration(axisStart)) : '');
  put(el.t1, shown ? (byIndex ? `Hit ${count}` : formatDuration(axisEnd)) : '');
  put(el.empty, phase === 'live' && !shown ? 'Waiting for the first hit' : phase === 'live' && !ready ? 'Collecting hits' : '');

  if (shown !== curveShown || (phase === 'live') !== livePhase) {
    curveShown = shown;
    livePhase = phase === 'live';
    chartDirty = true;
  }
}

// ---------------------------------------------------------------- frame loop
// One rAF loop that runs only while something is dirty; data handlers never draw.
let raf = 0;
let chartDirty = true, textDirty = true;
let lastChart = -Infinity, lastText = -Infinity;

function invalidate() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  if (textDirty && now - lastText >= TEXT_INTERVAL) {
    textDirty = false;
    lastText = now;
    applyText();
  }
  if (chartDirty && now - lastChart >= CHART_INTERVAL && cssW > 0 && columns > 0) {
    chartDirty = false;
    lastChart = now;
    draw(curveShown, livePhase);
  }
  if (textDirty || chartDirty) invalidate();
}

// ---------------------------------------------------------------- settings
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

settings({
  zone: 'auto', offsetX: 0, offsetY: 0, scale: 1, window: 50, height: 150, showUr: true,
  showOnResults: true, backing: 'none', accent: 'map', showBrand: true,
}, s => {
  const nextWindow = Math.round(clamp(s.window, 10, 500, 50));
  chartH = Math.round(clamp(s.height, 96, 200, 150));
  showUr = s.showUr;
  zone = ['left', 'right'].includes(s.zone) ? s.zone : 'auto';
  offsetX = Math.round(clamp(s.offsetX, -1920, 1920, 0));
  offsetY = Math.round(clamp(s.offsetY, -1080, 1080, 0));
  const nextScale = Math.round(clamp(s.scale, 0.6, 1.6, 1) * 100) / 100;
  onResults = s.showOnResults;
  block.dataset.ur = String(showUr);
  block.dataset.backing = ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  el.brand.hidden = !s.showBrand;
  setLanes();
  if (nextWindow !== windowSize) {
    windowSize = nextWindow;
    recomputeRolling();
    columnsStale = true;
  }
  if (nextScale !== userScale) {
    userScale = nextScale;
    resizeBacking();
  }
  const nextAccent = s.accent === '18-lab' ? '18-lab' : 'map';
  block.dataset.accent = nextAccent;
  if (nextAccent !== accentMode) {
    accentMode = nextAccent;
    if (accentMode === 'map') loadPalette(sub?.values[P_CHECKSUM]);
    applyTint();
  }
  placedKey = ''; // re-place with the new geometry
  chartDirty = textDirty = true;
  invalidate();
});

// ---------------------------------------------------------------- data
fit(stage, STAGE_W, STAGE_H);
document.fonts?.ready.then(() => { chartDirty = true; invalidate(); });

sub = subscribe(POINTERS, (values, changed) => {
  live = values[P_LIVE];
  if (changed.size === 1 && changed.has(P_LIVE)) return; // clock ticks only stamp hits
  if (changed.has(P_ERRORS)) ingest(values);
  if (changed.has(P_CHECKSUM)) loadPalette(values[P_CHECKSUM]);
  textDirty = true;
  invalidate();
}, {
  onStatus: state => {
    if (state === status) return;
    status = state;
    textDirty = true;
    invalidate();
  },
});

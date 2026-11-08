// Copyright (c) 2026 18-LAB. MIT.
// Catcher heatmap: where the osu!catch catcher spends its time this attempt, as a top-down
// 0–512 playfield strip. Time-weighted from vosu's /play/catcher samples on the map clock.
// The page is the overlay's box: hosts (OBS, vosulay, the replay renderer) place and size it,
// and the layout re-flows to that box (vertical column or horizontal band).
import {
  subscribe, settings, activeMode, isPlaying, formatDuration, mapPalette, applyPalette,
} from './vosu-overlay.js';

const FIELD = 512;
const BIN_CHOICES = [16, 32, 64, 128];
const MISSING_AFTER_MS = 1500;   // grace before calling /play/catcher absent during play
const MAX_STEP_MS = 3000;        // larger clock gaps are seeks/hitches: resync, don't smear
const RETRY_JUMP_MS = 1500;      // clock jumping back this far mid-play = a new attempt
const TEXT_INTERVAL_MS = 200;    // readouts don't need 60 Hz; keeps layout/style idle
const RESULTS = 7;
// Design boxes (u = 1): the vertical column, the band with 2×2 readouts, and the ticker band
// with readouts in one row.
const VERTICAL = { w: 240, h: 232 };
const BLOCK = { w: 420, h: 128 };
const TICKER = { w: 560, h: 96 };
const HORIZONTAL_ASPECT = 2;     // auto orientation: wider than 2:1 lays out as a band
const TICKER_ASPECT = 3.4;       // bands wider than this put the readouts in one row
const COMPACT_BELOW = 0.8;       // u below this drops non-data words (multiplayer cells)

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  x: '/play/catcher/x', dashing: '/play/catcher/dashing',
  live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject',
  isBreak: '/beatmap/isBreak', cs: '/beatmap/stats/cs/converted', checksum: '/beatmap/checksum',
};

const $ = id => document.getElementById(id);
const root = document.documentElement;
const hud = $('hud');
const plotBox = $('plotBox');
const canvas = $('plot');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  clock: $('clock'), dash: $('dash'),
  cog: $('cog'), cogSide: $('cogSide'), spread: $('spread'), dashShare: $('dashShare'),
  left: $('left'), right: $('right'), status: $('status'), statusText: $('statusText'),
};

// ---------------------------------------------------------------- attempt accumulator
// 1 px columns of the playfield; display bins are summed from these, so the bin setting
// can change live without losing history.
const HALF = FIELD / 2;
const hist = new Float64Array(FIELD);
// Sums live in object fields, which V8 updates in place; a module `let` would box a new heap
// number on every write.
const att = {
  total: 0,      // ms recorded
  sumX: 0,       // ∫x dt
  sumX2: 0,      // ∫x² dt
  dashTime: 0,
  leftTime: 0,   // ms in columns left of centre
};
let prevT = NaN;
let prevX = 0;
let prevDash = false;
// Columns accumulated since the display bins were last summed (touchLo > touchHi: none).
let touchLo = 0;
let touchHi = FIELD - 1;
let rebinAll = true;

function resetAttempt() {
  hist.fill(0);
  att.total = att.sumX = att.sumX2 = att.dashTime = att.leftTime = 0;
  prevT = NaN;
  rebinAll = true;
}

const clampX = x => (x < 0 ? 0 : x > FIELD ? FIELD : x);

/**
 * Adds the clock step t0→t1 of linear motion from a to b (playfield px) to the histogram and
 * moments. Shaped for optimised code: loop-carried values are integers (a double crossing a loop
 * edge is boxed), and the dash and left-half sums add on every call, scaled by 0 or 1, so a first
 * dash or first visit left of centre never meets an addition without type feedback (which would
 * drop the function back to the baseline tier, where every double is boxed).
 */
function accumulate(a, b, t0, t1, dashing) {
  const dt = t1 - t0;
  att.total += dt;
  att.sumX += dt * (a + b) / 2;
  att.sumX2 += dt * (a * a + a * b + b * b) / 3;
  att.dashTime += dt * (dashing ? 1 : 0);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const span = hi - lo;
  const first = Math.min(FIELD - 1, lo | 0);
  let column = first;
  if (span < 1e-6) {
    hist[column] += dt;
    att.leftTime += dt * (column < HALF ? 1 : 0);
  } else {
    // The first column from `lo`, then whole columns from their left edge up to `hi`.
    const rate = dt / span;
    const share = (Math.min(hi, column + 1) - lo) * rate;
    hist[column] += share;
    att.leftTime += share * (column < HALF ? 1 : 0);
    while (column < FIELD - 1 && column + 1 < hi) {
      column++;
      const part = (Math.min(hi, column + 1) - column) * rate;
      hist[column] += part;
      att.leftTime += part * (column < HALF ? 1 : 0);
    }
  }
  if (first < touchLo) touchLo = first;
  if (column > touchHi) touchHi = column;
}

// ---------------------------------------------------------------- live state
let status = 'connecting';
let statusDetail = '';
let state;
let mode = null;
let playing = false;
let checksum;
let catcherX = NaN;   // NaN = no live catcher sample
let dashingNow = false;
let catchHalf = 12;   // half the catch range in playfield px (24 px marker while unknown)
let playSince = 0;
let missing = false;
let dirty = false;
let raf = 0;
let textDue = true;
let textTimer = 0;
let lastTextAt = -TEXT_INTERVAL_MS;   // whole ms (rAF time | 0)
let layoutDue = true;

const opts = {
  orientation: 'auto', align: 'right', backing: 'none', accent: 'map',
  bins: 64, intensity: 1, showMarker: true, showOnResults: true,
};

/** osu!catch catch range (lazer Catcher.CalculateCatchWidth): 106.75 × CS scale × 0.8. */
function catchRange(cs) {
  return typeof cs === 'number' ? 106.75 * (1 - 0.7 * (cs - 5) / 5) * 0.8 : 0;
}

function onFrame(values, changed) {
  state = values[P.state];
  const nowPlaying = isPlaying(state);
  const nextMode = activeMode(state, values[P.playMode], values[P.selMode]);
  let visualChange = changed.has(P.state);

  if (changed.has(P.checksum)) {
    const next = values[P.checksum];
    if (next !== undefined && checksum !== undefined && next !== checksum) { resetAttempt(); visualChange = true; }
    if (next !== undefined && next !== checksum) { checksum = next; loadPalette(); }
  }
  if (state === undefined && att.total > 0) { resetAttempt(); visualChange = true; } // osu! closed
  if (nowPlaying && !playing) { resetAttempt(); playSince = performance.now(); missing = false; visualChange = true; }
  if (nextMode !== mode || nowPlaying !== playing) visualChange = true;
  playing = nowPlaying;
  mode = nextMode;
  if (changed.has(P.cs)) { catchHalf = (catchRange(values[P.cs]) || 24) / 2; visualChange = true; }

  const x = values[P.x];
  if (!playing || mode !== 'fruits' || typeof x !== 'number') {
    if (!Number.isNaN(catcherX)) { catcherX = NaN; dashingNow = false; visualChange = true; }
    prevT = NaN;
    const nowMissing = playing && mode === 'fruits' && performance.now() - playSince > MISSING_AFTER_MS;
    if (nowMissing !== missing) { missing = nowMissing; visualChange = true; }
    if (visualChange) markDirty(true);
    return;
  }
  if (missing) { missing = false; visualChange = true; }

  const cx = clampX(x);
  const dashing = values[P.dashing] === true;
  if (cx !== catcherX || dashing !== dashingNow) visualChange = true;
  catcherX = cx;
  dashingNow = dashing;

  const t = values[P.live];
  if (typeof t === 'number') {
    const dt = t - prevT;
    // NaN (no previous tick) or a gap too long; a comparison, not Number.isNaN(dt), so the
    // optimised code never boxes dt to pass it to a call.
    if (!(dt <= MAX_STEP_MS)) {
      prevT = t; prevX = cx; prevDash = dashing;
    } else if (dt < -RETRY_JUMP_MS) {
      resetAttempt(); visualChange = true;
      prevT = t; prevX = cx; prevDash = dashing;
    } else if (dt < 0) {
      prevT = t; prevX = cx; prevDash = dashing;
    } else if (dt > 0) {
      // Only gameplay counts: lead-in, outro and breaks would pile time onto wherever the catcher idles.
      const mid = prevT + dt / 2;
      const first = values[P.first];
      const last = values[P.last];
      const inMap = (typeof first !== 'number' || mid >= first) && (typeof last !== 'number' || last <= 0 || mid <= last);
      if (inMap && values[P.isBreak] !== true) { accumulate(prevX, cx, prevT, t, prevDash); visualChange = true; }
      prevT = t; prevX = cx; prevDash = dashing;
    }
    // dt === 0: position moved within one clock tick; the next tick carries the segment.
  }
  if (visualChange) markDirty(false);
}

function onStatus(next, detail) {
  statusDetail = detail;
  if (next === status) return;
  status = next;
  markDirty(true);
}

// ---------------------------------------------------------------- colour
// Cool steel heat ramp (graphite → --signal → --j-max): data, not identity. The live catcher and
// dash state carry the highlight colour (the map's tonal accent, or 18-LAB amber).
const RAMP = [[0, 30, 33, 37], [0.18, 38, 55, 74], [0.45, 63, 100, 140], [0.72, 127, 166, 207], [1, 235, 232, 225]];
const LUT = Array.from({ length: 256 }, (_, i) => {
  const u = i / 255;
  let s = 1;
  while (RAMP[s][0] < u) s++;
  const [u0, r0, g0, b0] = RAMP[s - 1];
  const [u1, r1, g1, b1] = RAMP[s];
  const f = (u - u0) / (u1 - u0 || 1);
  return `rgb(${Math.round(r0 + (r1 - r0) * f)} ${Math.round(g0 + (g1 - g0) * f)} ${Math.round(b0 + (b1 - b0) * f)})`;
});
const BAR_FLOOR = 46; // weakest bar still reads against the ground

const css = getComputedStyle(root);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const AMBER = token('--accent', '#ff963f');
const C = {
  hl: AMBER,
  hlSoft: 'rgb(255 150 63 / .22)',
  fg: token('--j-max', '#ebe8e1'),
  tick: 'rgb(235 232 225 / .55)',
  rail: 'rgb(235 232 225 / .3)',
  gridMajor: 'rgb(235 232 225 / .12)',
  gridMinor: 'rgb(235 232 225 / .05)',
  halo: 'rgb(10 11 12 / .8)',
};

function setHighlight(hex) {
  C.hl = hex;
  const n = Number.parseInt(hex.slice(1), 16);
  C.hlSoft = `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / .22)`;
}

// Map tint: loaded per checksum off the hot path; null (no usable background) keeps amber.
let paletteFor = null;
function loadPalette() {
  const want = opts.accent === 'map' && checksum ? checksum : null;
  if (want === paletteFor) return;
  paletteFor = want;
  if (!want) { applyPalette(root, null); setHighlight(AMBER); markDirty(false); return; }
  mapPalette(want).then(palette => {
    if (paletteFor !== want) return;
    applyPalette(root, palette);
    setHighlight(palette?.accent || AMBER);
    markDirty(false);
  });
}

// ---------------------------------------------------------------- layout (follows the page's box)
// Orientation from the box's aspect (or the setting); --u scales type and spacing so the design
// holds from its default size down to roughly half (multiplayer renderer cells).
let u = 1;
function layout() {
  const w = innerWidth;
  const h = innerHeight;
  const orient = opts.orientation === 'auto' ? (w / h > HORIZONTAL_ASPECT ? 'horizontal' : 'vertical') : opts.orientation;
  const ticker = orient === 'horizontal' && w / h > TICKER_ASPECT;
  const base = orient === 'vertical' ? VERTICAL : ticker ? TICKER : BLOCK;
  u = Math.min(3, Math.max(0.4, Math.min(w / base.w, h / base.h)));
  root.dataset.orient = orient;
  root.toggleAttribute('data-ticker', ticker);
  root.dataset.align = opts.align;
  root.dataset.accent = opts.accent;
  hud.dataset.backing = opts.backing;
  root.style.setProperty('--u', u.toFixed(3));
  root.toggleAttribute('data-compact', u < COMPACT_BELOW);
}
addEventListener('resize', () => { layoutDue = true; markDirty(true); });

// ---------------------------------------------------------------- canvas geometry
// Lanes in an 80-unit design height, scaled to the canvas: the strip stretches to its box.
const LANE = { cgTop: 0, cgBottom: 6, histTop: 9, histBottom: 56, bandTop: 59, bandBottom: 66, plateTop: 69, plateBottom: 75, tickBottom: 80 };
let k = 1;   // device px per hairline (DPR × type scale)
let cw = 0;
let ch = 0;

// Device-px geometry, derived on resize/settings so frames draw from integers only.
const MAX_BINS = BIN_CHOICES[BIN_CHOICES.length - 1];
const laneY = { ...LANE, tickMinor: 0 };          // lane edges in device px
const gridX = new Int32Array(FIELD / 64 + 1);      // every 64 playfield px
const binEdge = new Int32Array(MAX_BINS + 1);
let hair = 1;      // grid, ticks, halo, plate outline, bar gap, shortest bar, centre rule
let rule2 = 2;     // catcher rule
let cgHalf = 4;    // centre-of-gravity marker half width
let barGap = 0;

function size(entries) {
  const box = entries?.[0]?.contentRect;
  const dpr = devicePixelRatio || 1;
  k = dpr * Math.max(0.75, u);
  const w = Math.max(1, Math.round((box ? box.width : plotBox.clientWidth) * dpr));
  const h = Math.max(1, Math.round((box ? box.height : plotBox.clientHeight) * dpr));
  if (w !== cw || h !== ch) { cw = canvas.width = w; ch = canvas.height = h; }
  geometry();
  markDirty(false);
}
new ResizeObserver(size).observe(plotBox);

const Y = v => Math.round(v / LANE.tickBottom * ch);
const X = x => Math.round(x / FIELD * cw);

function geometry() {
  for (const lane in LANE) laneY[lane] = Y(LANE[lane]);
  laneY.tickMinor = Y(LANE.tickBottom - 2);
  hair = Math.max(1, Math.round(k));
  rule2 = Math.max(2, Math.round(k * 2));
  cgHalf = Math.round(4 * k);
  for (let i = 0; i < gridX.length; i++) gridX[i] = X(i * 64);
  const bins = opts.bins;
  for (let i = 0; i <= bins; i++) binEdge[i] = Math.round(i * cw / bins);
  barGap = cw / bins >= 4 * k ? hair : 0;
  reshadeAll = true;   // bar heights follow the strip height
}

/** Vertical rule (`lw` device px) centred on device x `cx` over the histogram and floor band, optionally dashed, with a dark halo. */
function vline(cx, colour, dashed, lw) {
  const px = Math.min(cw - lw, Math.max(0, cx - (lw >> 1)));
  const top = laneY.histTop;
  const bottom = laneY.bandBottom;
  ctx.fillStyle = C.halo;
  ctx.fillRect(px - hair, top, lw + hair * 2, bottom - top);
  ctx.fillStyle = colour;
  if (!dashed) { ctx.fillRect(px, top, lw, bottom - top); return; }
  for (let y = top; y < bottom; y += 5 * hair) ctx.fillRect(px, y, lw, Math.min(3 * hair, bottom - y));
}

function drawGrid() {
  const top = laneY.histTop;
  const bottom = laneY.histBottom;
  for (let i = 1; i < gridX.length - 1; i++) {
    ctx.fillStyle = i === 4 ? C.gridMajor : C.gridMinor;
    ctx.fillRect(gridX[i] - (hair >> 1), top, hair, bottom - top);
  }
  // Rail under the catcher lane, 64 px ticks, majors at the edges and centre.
  const rail = laneY.plateBottom + hair;
  ctx.fillStyle = C.rail;
  ctx.fillRect(0, rail, cw, hair);
  ctx.fillStyle = C.tick;
  for (let i = 0; i < gridX.length; i++) {
    const px = Math.min(cw - hair, Math.max(0, gridX[i] - (hair >> 1)));
    ctx.fillRect(px, rail, hair, (i % 4 === 0 ? laneY.tickBottom : laneY.tickMinor) - rail);
  }
}

// ---------------------------------------------------------------- heat (cached per bin)
// Bins are re-summed only where samples landed and re-shaded only when they or the peak change,
// so a frame that only moves the catcher (or a repaint for a palette or status) does no heat
// maths. A bin is always summed over its columns in order, exactly as a full rebin would.
// Running values live in typed arrays and object fields, not loop variables: optimised code
// boxes a double carried across a loop edge.
const view = new Float64Array(MAX_BINS);
const binShade = new Uint8Array(MAX_BINS);   // LUT index of each bin's floor band
const binBar = new Int32Array(MAX_BINS);     // bar height in device px, 0 = no time
const heat = { max: 0, gamma: 1 };
let reshadeAll = true;

function updateHeat() {
  const bins = opts.bins;
  const per = FIELD / bins;
  let lo = 0;
  let hi = bins - 1;
  if (rebinAll) heat.max = 0;
  else if (touchLo <= touchHi) { lo = (touchLo / per) | 0; hi = (touchHi / per) | 0; }
  else hi = -1;
  const peak = heat.max;
  // Time only grows within an attempt, so the peak of the re-summed bins and the old peak is the peak.
  for (let i = lo; i <= hi; i++) {
    view[i] = 0;
    for (let c = i * per, end = c + per; c < end; c++) view[i] += hist[c];
    if (view[i] > heat.max) heat.max = view[i];
  }
  rebinAll = false;
  touchLo = FIELD;
  touchHi = -1;
  if (reshadeAll || heat.max !== peak) { lo = 0; hi = bins - 1; reshadeAll = false; }
  const max = heat.max;
  const gamma = heat.gamma;
  const histH = laneY.histBottom - laneY.histTop;
  for (let i = lo; i <= hi; i++) {
    if (max > 0) {
      const v = view[i] / max;
      if (v > 0) {
        binShade[i] = Math.round(Math.pow(v, gamma) * 255);
        binBar[i] = Math.max(hair, Math.round(v * histH));
        continue;
      }
    }
    binShade[i] = 0;
    binBar[i] = 0;
  }
}

function drawHeat() {
  const bins = opts.bins;
  const histBottom = laneY.histBottom;
  const bandTop = laneY.bandTop;
  const bandH = laneY.bandBottom - bandTop;
  for (let i = 0; i < bins; i++) {
    const x0 = binEdge[i];
    const w = binEdge[i + 1] - x0;
    const shade = binShade[i];
    // Floor band: a continuous thermal strip; bars above carry the same bins as a profile.
    ctx.fillStyle = LUT[shade];
    ctx.fillRect(x0, bandTop, w, bandH);
    const h = binBar[i];
    if (h === 0) continue;
    ctx.fillStyle = LUT[shade > BAR_FLOOR ? shade : BAR_FLOOR];
    ctx.fillRect(x0, histBottom - h, w - (i < bins - 1 ? barGap : 0), h);
  }
}

function drawCentreOfGravity() {
  const cx = Math.round(att.sumX / att.total / FIELD * cw) | 0;
  vline(cx, C.fg, true, hair);
  ctx.fillStyle = C.fg;
  ctx.beginPath();
  ctx.moveTo(cx - cgHalf, laneY.cgTop);
  ctx.lineTo(cx + cgHalf, laneY.cgTop);
  ctx.lineTo(cx, laneY.cgBottom);
  ctx.closePath();
  ctx.fill();
}

function drawCatcher() {
  vline(Math.round(catcherX / FIELD * cw) | 0, C.hl, false, rule2);
  const x0 = Math.max(0, Math.round((catcherX - catchHalf) / FIELD * cw) | 0);
  const x1 = Math.min(cw, Math.round((catcherX + catchHalf) / FIELD * cw) | 0);
  const top = laneY.plateTop;
  const h = laneY.plateBottom - top;
  // Dashing fills the plate solid; otherwise a soft fill with an outline. One shared fill call,
  // so a first dash runs only code that has already run (no deopt back to the baseline tier).
  ctx.fillStyle = dashingNow ? C.hl : C.hlSoft;
  ctx.fillRect(x0, top, x1 - x0, h);
  if (dashingNow) return;
  ctx.fillStyle = C.hl;
  ctx.fillRect(x0, top, x1 - x0, hair);
  ctx.fillRect(x0, top + h - hair, x1 - x0, hair);
  ctx.fillRect(x0, top, hair, h);
  ctx.fillRect(x1 - hair, top, hair, h);
}

// ---------------------------------------------------------------- DOM readouts
// Each readout keeps the number it shows and writes only when that number changes. Every value is
// a whole number within the playfield (centre 0–512, σ ≤ 256, shares 0–100, side ±256), so the
// strings are built once here: no formatting, and no trip through V8's number-string cache.
const BLANK = -(2 ** 30);   // no number on screen: '—' (nothing for the clock and side)
const NUMBERS = Array.from({ length: FIELD + 1 }, (_, n) => String(n));
const SIDES = Array.from({ length: FIELD + 1 }, (_, i) => (i === HALF ? 'mid' : `${Math.abs(i - HALF)} ${i < HALF ? 'L' : 'R'}`));
const READS = [el.cog, el.spread, el.dashShare, el.left, el.right];
const COG = 0;
const SPREAD = 1;
const DASH_SHARE = 2;
const LEFT = 3;
const RIGHT = 4;
const shownRead = new Int32Array(READS.length).fill(BLANK);
let shownSecs = BLANK;
let shownSide = BLANK;
// The values as whole numbers, derived on every render: that runs at frame rate, so V8 optimises
// it within seconds and keeps its doubles unboxed, while writeText (≤ 5 Hz, left in the boxing
// baseline tier for minutes) only compares integers.
const readNum = new Int32Array(READS.length);
let readSecs = 0;
let readSide = 0;

function setRead(i, n) {
  if (shownRead[i] === n) return;
  shownRead[i] = n;
  READS[i].textContent = n === BLANK ? '—' : NUMBERS[n];
}

/** Readout numbers from the attempt sums (only while time is recorded). */
function deriveReadouts() {
  const total = att.total;
  const mean = att.sumX / total;
  const sigma = Math.sqrt(Math.max(0, att.sumX2 / total - mean * mean));
  const left = Math.round(att.leftTime / total * 100) | 0;
  readSecs = Math.floor(total / 1000) | 0;
  readSide = Math.round(mean - HALF) | 0;
  readNum[COG] = Math.round(mean) | 0;
  readNum[SPREAD] = Math.round(sigma) | 0;
  readNum[DASH_SHARE] = Math.round(att.dashTime / total * 100) | 0;
  readNum[LEFT] = left;
  readNum[RIGHT] = 100 - left;
}

/** What the box shows: the strip during catch play, the held attempt on results, else nothing. */
function currentView() {
  if (status !== 'live' || mode !== 'fruits') return 'hidden';
  if (playing) return missing ? 'hidden' : 'live';
  if (state === RESULTS && opts.showOnResults && att.total > 0) return 'held';
  return 'hidden';
}

/** The one tiny line for connection / no-data / missing-extension states. */
function statusLine() {
  if (status === 'offline') return 'offline';
  if (status === 'connecting') return 'connecting';
  if (state === undefined) return 'osu';
  if (playing && mode === 'fruits' && missing) return 'missing';
  return 'hidden';
}
const STATUS_TEXT = { offline: 'vosu offline', connecting: 'connecting', osu: 'osu! not running', missing: 'No catcher data — needs vosu', hidden: '' };
const STATUS_DOT = { offline: 'offline', connecting: 'connecting', osu: 'idle', missing: 'idle', hidden: 'hidden' };

function writeText(timed) {
  if (!timed) {
    if (shownSecs !== BLANK) { shownSecs = BLANK; el.clock.textContent = ''; }
    for (let i = 0; i < READS.length; i++) setRead(i, BLANK);
    if (shownSide !== BLANK) { shownSide = BLANK; el.cogSide.textContent = ''; }
    return;
  }
  // Whole seconds in, so formatDuration's floor lands on the same second.
  if (readSecs !== shownSecs) { shownSecs = readSecs; el.clock.textContent = formatDuration(readSecs * 1000); }
  if (readSide !== shownSide) { shownSide = readSide; el.cogSide.textContent = SIDES[readSide + HALF]; }
  for (let i = 0; i < READS.length; i++) setRead(i, readNum[i]);
}

// ---------------------------------------------------------------- render loop (runs only when dirty)
let viewName = '';
let lineName = '';
let dashOn = null;

function markDirty(text) {
  if (text) textDue = true;
  dirty = true;
  if (!raf) raf = requestAnimationFrame(render);
}

function flushText() {
  textTimer = 0;
  markDirty(true);
}

function render(now) {
  raf = 0;
  if (!dirty) return;
  dirty = false;
  const name = currentView();
  if (layoutDue) {
    // Only on resize/settings: never per data frame.
    layoutDue = false;
    layout();
    size();
  }
  if (name !== viewName) { viewName = name; hud.dataset.view = name; textDue = true; }
  const line = statusLine();
  if (line !== lineName) {
    lineName = line;
    el.status.dataset.state = STATUS_DOT[line];
    if (line !== 'hidden') el.statusText.textContent = STATUS_TEXT[line];
    el.status.title = statusDetail;
  }
  const on = name === 'live' && dashingNow;
  if (on !== dashOn) { dashOn = on; el.dash.toggleAttribute('data-on', on); }
  const timed = att.total > 0;
  if (name !== 'hidden' && cw > 0) {
    updateHeat();
    ctx.clearRect(0, 0, cw, ch);
    drawGrid();
    drawHeat();
    if (timed) drawCentreOfGravity();
    if (opts.showMarker && name === 'live' && !Number.isNaN(catcherX)) drawCatcher();
  }
  if (timed) deriveReadouts();
  // Text at ≤ 5 Hz; a trailing timer flushes the final values when samples stop (pause, results).
  // Whole milliseconds keep the throttle arithmetic in small integers.
  const ms = now | 0;
  if (textDue || ms - lastTextAt >= TEXT_INTERVAL_MS) {
    textDue = false;
    lastTextAt = ms;
    clearTimeout(textTimer);
    textTimer = 0;
    writeText(timed);
  } else if (!textTimer) {
    textTimer = setTimeout(flushText, TEXT_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------- wiring
subscribe(Object.values(P), onFrame, { onStatus });

// Numeric defaults (bins too) so both vosu's option strings and numeric pushes coerce.
settings({ ...opts }, s => {
  opts.orientation = ['horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = s.align === 'left' ? 'left' : 'right';
  opts.backing = ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  opts.accent = s.accent === '18-lab' ? '18-lab' : 'map';
  opts.bins = BIN_CHOICES.includes(s.bins) ? s.bins : 64;
  opts.intensity = Math.min(4, Math.max(0.25, s.intensity));
  heat.gamma = 1 / opts.intensity;
  rebinAll = true;   // the bin count may have changed; layout's geometry() re-shades
  opts.showMarker = s.showMarker;
  opts.showOnResults = s.showOnResults;
  layoutDue = true;
  loadPalette();
  markDirty(true);
});


// Copyright (c) 2026 18-LAB. MIT.
// Catcher heatmap: where the osu!catch catcher spends its time this attempt, as a top-down
// 0–512 playfield strip. Time-weighted from vosu's /play/catcher samples on the map clock.
// The page is the overlay's box: hosts (OBS, vosulay, the replay renderer) place and size it,
// and the layout re-flows to that box (vertical column or horizontal band). Built on the 18-LAB
// kit (docs/overlay-system.md): heat in neutrals, the catcher in amber ("you").
import {
  subscribe, settings, activeMode, isPlaying, numberFormatter, applyKitSettings, MOTION_MS, DASH,
} from './vosu-overlay.js';

const FIELD = 512;
const BIN_CHOICES = [16, 32, 64, 128];
const MISSING_AFTER_MS = 1500;   // grace before calling /play/catcher absent during play
const MAX_STEP_MS = 3000;        // larger clock gaps are seeks/hitches: resync, don't smear
const RETRY_JUMP_MS = 1500;      // clock jumping back this far mid-play = a new attempt
const TEXT_INTERVAL_MS = 200;    // readouts don't need 60 Hz; keeps layout/style idle
const RESULTS = 7;
// Design boxes (u = 1, padding included): the column (the R4 slot) and the band.
const VERTICAL = { w: 256, h: 240 };
const HORIZONTAL = { w: 420, h: 128 };
const HORIZONTAL_ASPECT = 2;     // auto orientation: wider than 2:1 lays out as a band
const COMPACT_BELOW = 0.8;       // u below this drops the dash-share line (multiplayer cells)
// Balance word over the hero: Even within EVEN_LEAN points of 50/50, heavy from HEAVY_LEAN points
// (56/44), leaning in between; a class changes only BALANCE_HOLD points past its boundary.
const EVEN_LEAN = 2;
const HEAVY_LEAN = 6;
const BALANCE_HOLD = 2;
// New hottest spot: the peak bin moved at least this far from the last acknowledged one, after
// the attempt settled, and not more often than every PEAK_GAP_MS.
const PEAK_SHIFT_PX = 48;
const PEAK_SETTLE_MS = 5000;
const PEAK_HALF_PX = 16;
const PEAK_GAP_MS = 1500;

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
  share: $('share'), dashShare: $('dashShare'), balance: $('balance'), status: $('status'),
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
  att.total = att.sumX = att.dashTime = att.leftTime = 0;
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
 * Dash share (the same rule as catcher-trail, its declared alternative): time of segments whose
 * start sample is dashing over all counted time.
 */
function accumulate(a, b, t0, t1, dashing) {
  const dt = t1 - t0;
  att.total += dt;
  att.sumX += dt * (a + b) / 2;
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
let dashEnded = false; // a dash ended since the last render (its afterglow starts there)
let catchHalf = 12;   // half the catch range in playfield px (24 px marker while unknown)
let playSince = 0;
let missing = false;
let dirty = false;
let raf = 0;
let textDue = true;
let textTimer = 0;
let lastTextAt = -TEXT_INTERVAL_MS;   // whole ms (rAF time | 0)
let layoutDue = true;
let motion = 'full';

const opts = {
  orientation: 'auto', align: 'right', motion: 'full', backing: 'scrim',
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
    if (next !== undefined) checksum = next;
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
  if (dashingNow && !dashing) dashEnded = true;
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
// Heat is data, not identity: a warm neutral ramp from graphite to --text-1, so no bin reads as a
// judgement (blue = 300, yellow = 50) or as the map. The catcher is you: --you (18-LAB amber),
// outlined while walking, solid while dashing.
const css = getComputedStyle(root);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const RAMP = [[0, 40, 39, 37], [0.35, 92, 90, 85], [0.7, 163, 160, 153], [1, 239, 236, 229]];
const LUT = Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  let s = 1;
  while (RAMP[s][0] < v) s++;
  const [v0, r0, g0, b0] = RAMP[s - 1];
  const [v1, r1, g1, b1] = RAMP[s];
  const f = (v - v0) / (v1 - v0 || 1);
  return `rgb(${Math.round(r0 + (r1 - r0) * f)} ${Math.round(g0 + (g1 - g0) * f)} ${Math.round(b0 + (b1 - b0) * f)})`;
});
const BAR_FLOOR = 56; // weakest bar still reads against the backing
const C = {
  you: token('--you', '#ff963f'),
  youSoft: 'rgb(255 150 63 / .22)',
  fg: token('--text-1', '#efece5'),
  tick: token('--hair-strong', 'rgb(239 236 229 / .4)'),
  rail: token('--hair', 'rgb(239 236 229 / .22)'),
  gridMajor: 'rgb(239 236 229 / .14)',
  gridMinor: 'rgb(239 236 229 / .06)',
  halo: 'rgb(11 12 13 / .8)',
};

// ---------------------------------------------------------------- layout (follows the page's box)
// Orientation from the box's aspect (or the setting); --u scales type and spacing so the design
// holds from its default size down to roughly half (multiplayer renderer cells).
let u = 1;
function layout() {
  const w = innerWidth;
  const h = innerHeight;
  const orient = opts.orientation === 'auto' ? (w / h > HORIZONTAL_ASPECT ? 'horizontal' : 'vertical') : opts.orientation;
  const base = orient === 'vertical' ? VERTICAL : HORIZONTAL;
  u = Math.min(3, Math.max(0.4, Math.min(w / base.w, h / base.h)));
  root.dataset.orient = orient;
  root.dataset.align = opts.align;
  hud.style.setProperty('--u', u.toFixed(3));
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
let rule2 = 2;     // catcher rule, peak cap
let cgHalf = 4;    // centre-of-gravity marker half width
let barGap = 0;
let peakHalf = 0; // hot-spot flash half width (PEAK_HALF_PX)

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
  peakHalf = X(PEAK_HALF_PX) | 0;
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
  // Rail under the catcher lane, 64 px ticks, majors at the edges and centre (the left/right split).
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
// so a frame that only moves the catcher (or a repaint for a status) does no heat maths. A bin is
// always summed over its columns in order, exactly as a full rebin would. Running values live in
// typed arrays and object fields, not loop variables: optimised code boxes a double carried across
// a loop edge.
const view = new Float64Array(MAX_BINS);
const binShade = new Uint8Array(MAX_BINS);   // LUT index of each bin's floor band
const binBar = new Int32Array(MAX_BINS);     // bar height in device px, 0 = no time
const heat = { max: 0, gamma: 1, peak: -1, rebinned: true };
let reshadeAll = true;

function updateHeat() {
  const bins = opts.bins;
  const per = FIELD / bins;
  let lo = 0;
  let hi = bins - 1;
  heat.rebinned = rebinAll;
  if (rebinAll) { heat.max = 0; heat.peak = -1; }
  else if (touchLo <= touchHi) { lo = (touchLo / per) | 0; hi = (touchHi / per) | 0; }
  else hi = -1;
  const peak = heat.max;
  // Time only grows within an attempt, so the peak of the re-summed bins and the old peak is the peak.
  for (let i = lo; i <= hi; i++) {
    view[i] = 0;
    for (let c = i * per, end = c + per; c < end; c++) view[i] += hist[c];
    if (view[i] > heat.max) { heat.max = view[i]; heat.peak = i; }
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

/** The catch-range plate's device-px edges for playfield x `at` (reused scratch, no allocation). */
const plate = { x0: 0, x1: 0 };
function plateAt(at) {
  plate.x0 = Math.max(0, Math.round((at - catchHalf) / FIELD * cw) | 0);
  plate.x1 = Math.min(cw, Math.round((at + catchHalf) / FIELD * cw) | 0);
}

/** The catcher at playfield x `at`: amber position rule and catch-range plate, outlined while walking, solid while dashing. */
function drawCatcher(at, solid) {
  vline(Math.round(at / FIELD * cw) | 0, C.you, false, rule2);
  plateAt(at);
  const x0 = plate.x0;
  const w = plate.x1 - x0;
  const top = laneY.plateTop;
  const h = laneY.plateBottom - top;
  // Dashing fills the plate solid; otherwise a soft fill with an outline. One shared fill call,
  // so a first dash runs only code that has already run (no deopt back to the baseline tier).
  ctx.fillStyle = solid ? C.you : C.youSoft;
  ctx.fillRect(x0, top, w, h);
  if (solid) return;
  ctx.fillStyle = C.you;
  ctx.fillRect(x0, top, w, hair);
  ctx.fillRect(x0, top + h - hair, w, hair);
  ctx.fillRect(x0, top, hair, h);
  ctx.fillRect(x0 + w - hair, top, hair, h);
}

/** The dash fill at `alpha` over the plate drawn by the last drawCatcher (the afterglow). */
function drawPlateFill(alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.you;
  ctx.fillRect(plate.x0, laneY.plateTop, plate.x1 - plate.x0, laneY.plateBottom - laneY.plateTop);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- motion (canvas)
// Everything runs on rAF timestamps (the replay renderer's virtual clock) and only while it is
// moving: render() asks for another frame while one of these is in flight, then stops.
//   dash afterglow  the solid plate fades back to the outline over --dur-fast after a dash (full)
//   catcher exit    the marker fades over --dur-base when the catcher leaves (results)  (full, reduced)
//   new hot spot    an amber cap over the new hottest spot fades over --dur-slow (full)
// Times are whole rAF milliseconds and each effect has an on flag, so a frame without one in
// flight does no floating-point work (no boxed doubles in code V8 has not optimised yet).
const fx = {
  glowOn: false,     // dash afterglow in flight
  dashEndAt: 0,      // rAF ms of the last dash end
  markerAt: NaN,     // playfield x last drawn (NaN: none on screen)
  fading: false,     // the marker is fading out
  goneAt: 0,         // rAF ms the marker left
  peakOn: false,     // hot-spot flash in flight
  peakAt: -100000,   // rAF ms of the last hot-spot flash
  peakBin: -1,       // bin flashed
  shownPeak: -1,     // peak bin last seen
  anchor: -1e4,      // playfield x of the last acknowledged hot spot
};
/** Alpha 1 → 0 over `duration` ms from `start`, along --ease-out (quart): (1 − progress)⁴. */
const fade = (ms, start, duration) => {
  const q = 1 - (ms - start) / duration;
  return q * q * q * q;
};

/** Notes a move of the hottest bin; flashes it when it is a real shift (full motion only). */
function trackPeak(ms) {
  const bin = heat.peak;
  if (bin === fx.shownPeak) return;
  fx.shownPeak = bin;
  if (bin < 0) return;
  const at = (bin + 0.5) * FIELD / opts.bins;
  const settled = !heat.rebinned && att.total >= PEAK_SETTLE_MS;
  const shift = Math.abs(at - fx.anchor) >= PEAK_SHIFT_PX;
  if (!settled || shift) fx.anchor = at;
  if (settled && shift && motion === 'full' && ms - fx.peakAt >= PEAK_GAP_MS) { fx.peakAt = ms; fx.peakBin = bin; fx.peakOn = true; }
}

/** Amber cap over the new hot spot (at least 32 playfield px wide, so it reads at any bin count) and
 *  a soft amber wash down to the floor, fading; clears fx.peakOn when done. */
function drawPeakFlash(ms) {
  const bin = fx.peakBin;
  if (ms - fx.peakAt >= MOTION_MS.slow || bin >= opts.bins || binBar[bin] === 0) { fx.peakOn = false; return; }
  const h = binBar[bin];
  const centre = (binEdge[bin] + binEdge[bin + 1]) >> 1;
  const half = Math.max((binEdge[bin + 1] - binEdge[bin]) >> 1, peakHalf);
  const x0 = Math.max(0, centre - half);
  const x1 = Math.min(cw, centre + half);
  const top = laneY.histBottom - h;
  ctx.globalAlpha = fade(ms, fx.peakAt, MOTION_MS.slow);
  ctx.fillStyle = C.youSoft;
  ctx.fillRect(x0, top, x1 - x0, h);
  ctx.fillStyle = C.you;
  ctx.fillRect(x0, Math.max(0, top - rule2), x1 - x0, rule2);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- DOM readouts
// Each readout keeps the number it shows and writes only when that number changes; the shared
// formatter returns the same string object until the shown value changes.
const BLANK = -1;
const fmtShare = numberFormatter('percent');
const fmtDash = numberFormatter('percent');
// Balance classes, ordered by lean (left share − 50): the hero is the heavier side's share.
const BALANCE = ['Right-heavy', 'Leaning right', 'Even', 'Leaning left', 'Left-heavy'];
const BALANCE_UNKNOWN = 'Balance';
const shown = new Int32Array(3).fill(-2);   // hero share, dash share, balance class
// Whole numbers derived on every render (frame rate, so V8 keeps them unboxed); writeText only compares.
const readNum = new Int32Array(3).fill(-1);
let empty = null;

// Re-shows the balance word when it changes; created once and restarted.
const balanceIn = el.balance.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS.base, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
balanceIn.cancel();

/** Balance class for a lean of `lean` points (left share − 50). */
const balanceOf = lean => (lean >= HEAVY_LEAN ? 4 : lean > EVEN_LEAN ? 3 : lean >= -EVEN_LEAN ? 2 : lean > -HEAVY_LEAN ? 1 : 0);

/** Readout numbers from the attempt sums (only while time is recorded). The balance word enters a
 *  class at its threshold but moves back toward Even only BALANCE_HOLD points past it, so it does
 *  not flicker on a boundary. */
function deriveReadouts() {
  const total = att.total;
  const left = Math.round(att.leftTime / total * 100) | 0;
  const lean = left - 50;
  const was = readNum[2];
  let cls = balanceOf(lean);
  if (was > 2 && cls < was) cls = Math.min(was, balanceOf(lean + BALANCE_HOLD));
  else if (was >= 0 && was < 2 && cls > was) cls = Math.max(was, balanceOf(lean - BALANCE_HOLD));
  readNum[0] = left >= 50 ? left : 100 - left;
  readNum[1] = Math.round(att.dashTime / total * 100) | 0;
  readNum[2] = cls;
}

function writeText(timed) {
  if (timed !== !empty) { empty = !timed; hud.toggleAttribute('data-empty', empty); }
  if (!timed) {
    if (shown[0] !== BLANK) {
      shown[0] = shown[1] = shown[2] = BLANK;
      readNum[2] = -1;
      el.share.textContent = DASH; el.dashShare.textContent = DASH;
      el.balance.textContent = BALANCE_UNKNOWN;
    }
    return;
  }
  if (readNum[0] !== shown[0]) { shown[0] = readNum[0]; el.share.textContent = fmtShare(readNum[0]); }
  if (readNum[1] !== shown[1]) { shown[1] = readNum[1]; el.dashShare.textContent = fmtDash(readNum[1]); }
  if (readNum[2] !== shown[2]) {
    const first = shown[2] < 0;
    shown[2] = readNum[2];
    el.balance.textContent = BALANCE[readNum[2]];
    if (!first && motion !== 'off') { balanceIn.currentTime = 0; balanceIn.play(); }
  }
}

/** What the box shows: the strip during catch play, the held attempt on results, else nothing. */
function currentView() {
  if (status !== 'live' || mode !== 'fruits') return 'hidden';
  if (playing) return missing ? 'hidden' : 'live';
  if (state === RESULTS && opts.showOnResults && att.total > 0) return 'held';
  return 'hidden';
}

/** The one line for connection / no-data / missing-extension states. */
function statusLine() {
  if (status === 'offline') return 'offline';
  if (status === 'connecting') return 'connecting';
  if (state === undefined) return 'osu';
  if (playing && mode === 'fruits' && missing) return 'missing';
  return 'hidden';
}
const STATUS_TEXT = { offline: 'vosu offline', connecting: 'Connecting', osu: 'osu! not running', missing: 'No catcher data (needs vosu)', hidden: '' };

// ---------------------------------------------------------------- render loop (runs only when dirty)
let viewName = '';
let lineName = '';

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
    el.status.dataset.state = line === 'hidden' ? 'hidden' : 'shown';
    if (line !== 'hidden') el.status.textContent = STATUS_TEXT[line];
    el.status.title = statusDetail;
  }
  // Whole milliseconds keep the timing arithmetic (text throttle, effects) in small integers.
  const ms = now | 0;
  if (dashEnded) { dashEnded = false; fx.dashEndAt = ms; fx.glowOn = motion === 'full'; }
  const timed = att.total > 0;
  let moving = false;
  if (name !== 'hidden' && cw > 0) {
    updateHeat();
    trackPeak(ms);
    ctx.clearRect(0, 0, cw, ch);
    drawGrid();
    drawHeat();
    if (fx.peakOn) { drawPeakFlash(ms); moving = fx.peakOn; }
    if (timed) drawCentreOfGravity();
    const live = opts.showMarker && name === 'live' && !Number.isNaN(catcherX);
    if (live) {
      if (dashingNow) { fx.glowOn = false; drawCatcher(catcherX, true); }
      else if (fx.glowOn && ms - fx.dashEndAt < MOTION_MS.fast) {
        // Afterglow: the solid fill fades back to the outline.
        drawCatcher(catcherX, false);
        drawPlateFill(fade(ms, fx.dashEndAt, MOTION_MS.fast));
        moving = true;
      } else { fx.glowOn = false; drawCatcher(catcherX, false); }
      fx.markerAt = catcherX;
      fx.fading = false;
    } else if (!Number.isNaN(fx.markerAt)) {
      // The catcher left (results, pause without samples): fade it out where it was.
      if (!fx.fading) { fx.fading = true; fx.goneAt = ms; }
      if (motion !== 'off' && ms - fx.goneAt < MOTION_MS.base) {
        ctx.globalAlpha = fade(ms, fx.goneAt, MOTION_MS.base);
        drawCatcher(fx.markerAt, false);
        ctx.globalAlpha = 1;
        moving = true;
      } else fx.markerAt = NaN;
    }
  }
  if (timed) deriveReadouts();
  // Text at ≤ 5 Hz; a trailing timer flushes the final values when samples stop (pause, results).
  if (textDue || ms - lastTextAt >= TEXT_INTERVAL_MS) {
    textDue = false;
    lastTextAt = ms;
    clearTimeout(textTimer);
    textTimer = 0;
    writeText(timed);
  } else if (!textTimer) {
    textTimer = setTimeout(flushText, TEXT_INTERVAL_MS);
  }
  if (moving) markDirty(false);
}

// ---------------------------------------------------------------- wiring
subscribe(Object.values(P), onFrame, { onStatus });

// Numeric defaults (bins too) so both vosu's option strings and numeric pushes coerce.
settings({ ...opts }, s => {
  opts.orientation = ['horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = s.align === 'left' ? 'left' : 'right';
  motion = applyKitSettings(hud, s);
  root.dataset.motion = motion;   // the status line sits outside the kit root
  opts.bins = BIN_CHOICES.includes(s.bins) ? s.bins : 64;
  opts.intensity = Math.min(4, Math.max(0.25, s.intensity));
  heat.gamma = 1 / opts.intensity;
  rebinAll = true;   // the bin count may have changed; layout's geometry() re-shades
  opts.showMarker = s.showMarker;
  opts.showOnResults = s.showOnResults;
  layoutDue = true;
  markDirty(true);
});

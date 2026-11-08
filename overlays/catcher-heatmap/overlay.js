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
const hist = new Float64Array(FIELD);
const view = new Float64Array(BIN_CHOICES[BIN_CHOICES.length - 1]);
let total = 0;        // ms recorded
let sumX = 0;         // ∫x dt
let sumX2 = 0;        // ∫x² dt
let dashTime = 0;
let prevT = NaN;
let prevX = 0;
let prevDash = false;

function resetAttempt() {
  hist.fill(0);
  total = sumX = sumX2 = dashTime = 0;
  prevT = NaN;
}

const clampX = x => (x < 0 ? 0 : x > FIELD ? FIELD : x);

/** Adds `dt` ms of linear motion from a to b (playfield px) to the histogram and moments. */
function accumulate(a, b, dt, dashing) {
  total += dt;
  sumX += dt * (a + b) / 2;
  sumX2 += dt * (a * a + a * b + b * b) / 3;
  if (dashing) dashTime += dt;
  let lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const span = hi - lo;
  if (span < 1e-6) { hist[Math.min(FIELD - 1, lo | 0)] += dt; return; }
  const rate = dt / span;
  while (lo < hi) {
    const column = Math.min(FIELD - 1, lo | 0);
    const edge = Math.min(hi, column + 1);
    hist[column] += (edge - lo) * rate;
    lo = edge;
    if (column === FIELD - 1) break;
  }
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
let catchWidth = 0;   // catch range in playfield px, 0 = unknown
let playSince = 0;
let missing = false;
let dirty = false;
let raf = 0;
let textDue = true;
let textTimer = 0;
let lastTextAt = -Infinity;
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
  if (state === undefined && total > 0) { resetAttempt(); visualChange = true; } // osu! closed
  if (nowPlaying && !playing) { resetAttempt(); playSince = performance.now(); missing = false; visualChange = true; }
  if (nextMode !== mode || nowPlaying !== playing) visualChange = true;
  playing = nowPlaying;
  mode = nextMode;
  if (changed.has(P.cs)) { catchWidth = catchRange(values[P.cs]); visualChange = true; }

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
    if (Number.isNaN(dt) || dt > MAX_STEP_MS) {
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
      if (inMap && values[P.isBreak] !== true) { accumulate(prevX, cx, dt, prevDash); visualChange = true; }
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

function size(entries) {
  const box = entries?.[0]?.contentRect;
  const dpr = devicePixelRatio || 1;
  k = dpr * Math.max(0.75, u);
  const w = Math.max(1, Math.round((box ? box.width : plotBox.clientWidth) * dpr));
  const h = Math.max(1, Math.round((box ? box.height : plotBox.clientHeight) * dpr));
  if (w !== cw || h !== ch) { cw = canvas.width = w; ch = canvas.height = h; }
  markDirty(false);
}
new ResizeObserver(size).observe(plotBox);

const Y = v => Math.round(v / LANE.tickBottom * ch);
const X = x => Math.round(x / FIELD * cw);

/** Vertical rule (`width` css px) at playfield x from y0..y1 (css px), optionally dashed, with a dark halo. */
function vline(x, y0, y1, colour, dashed, width) {
  const lw = Math.max(width, Math.round(k * width));
  const hw = Math.max(1, Math.round(k));
  const px = Math.min(cw - lw, Math.max(0, X(x) - (lw >> 1)));
  const top = Y(y0);
  const bottom = Y(y1);
  ctx.fillStyle = C.halo;
  ctx.fillRect(px - hw, top, lw + hw * 2, bottom - top);
  ctx.fillStyle = colour;
  if (!dashed) { ctx.fillRect(px, top, lw, bottom - top); return; }
  for (let y = top; y < bottom; y += 5 * hw) ctx.fillRect(px, y, lw, Math.min(3 * hw, bottom - y));
}

function drawGrid() {
  const lw = Math.max(1, Math.round(k));
  const top = Y(LANE.histTop);
  const bottom = Y(LANE.histBottom);
  for (let x = 64; x < FIELD; x += 64) {
    ctx.fillStyle = x === 256 ? C.gridMajor : C.gridMinor;
    ctx.fillRect(X(x) - (lw >> 1), top, lw, bottom - top);
  }
  // Rail under the catcher lane, 64 px ticks, majors at the edges and centre.
  const rail = Y(LANE.plateBottom) + lw;
  ctx.fillStyle = C.rail;
  ctx.fillRect(0, rail, cw, lw);
  ctx.fillStyle = C.tick;
  for (let x = 0; x <= FIELD; x += 64) {
    const px = Math.min(cw - lw, Math.max(0, X(x) - (lw >> 1)));
    ctx.fillRect(px, rail, lw, Y(x % 256 === 0 ? LANE.tickBottom : LANE.tickBottom - 2) - rail);
  }
}

function drawHeat() {
  const bins = opts.bins;
  view.fill(0, 0, bins);
  const per = FIELD / bins;
  for (let c = 0; c < FIELD; c++) view[(c / per) | 0] += hist[c];
  let max = 0;
  for (let i = 0; i < bins; i++) if (view[i] > max) max = view[i];
  const gap = cw / bins >= 4 * k ? Math.max(1, Math.round(k)) : 0;
  const histBottom = Y(LANE.histBottom);
  const histH = histBottom - Y(LANE.histTop);
  const bandTop = Y(LANE.bandTop);
  const bandH = Y(LANE.bandBottom) - bandTop;
  const minH = Math.max(1, Math.round(k));
  const gamma = 1 / opts.intensity;
  for (let i = 0; i < bins; i++) {
    const x0 = Math.round(i * cw / bins);
    const x1 = Math.round((i + 1) * cw / bins);
    const v = max > 0 ? view[i] / max : 0;
    const shade = v > 0 ? Math.round(Math.pow(v, gamma) * 255) : 0;
    // Floor band: a continuous thermal strip; bars above carry the same bins as a profile.
    ctx.fillStyle = LUT[shade];
    ctx.fillRect(x0, bandTop, x1 - x0, bandH);
    if (v <= 0) continue;
    const h = Math.max(minH, Math.round(v * histH));
    ctx.fillStyle = LUT[shade > BAR_FLOOR ? shade : BAR_FLOOR];
    ctx.fillRect(x0, histBottom - h, x1 - x0 - (i < bins - 1 ? gap : 0), h);
  }
}

function drawCentreOfGravity(cog) {
  vline(cog, LANE.histTop, LANE.bandBottom, C.fg, true, 1);
  const cx = X(cog);
  const half = Math.round(4 * k);
  ctx.fillStyle = C.fg;
  ctx.beginPath();
  ctx.moveTo(cx - half, Y(LANE.cgTop));
  ctx.lineTo(cx + half, Y(LANE.cgTop));
  ctx.lineTo(cx, Y(LANE.cgBottom));
  ctx.closePath();
  ctx.fill();
}

function drawCatcher() {
  vline(catcherX, LANE.histTop, LANE.bandBottom, C.hl, false, 2);
  const lw = Math.max(1, Math.round(k));
  const half = (catchWidth || 24) / 2;
  const x0 = Math.max(0, X(catcherX - half));
  const x1 = Math.min(cw, X(catcherX + half));
  const top = Y(LANE.plateTop);
  const h = Y(LANE.plateBottom) - top;
  if (dashingNow) {
    ctx.fillStyle = C.hl;
    ctx.fillRect(x0, top, x1 - x0, h);
  } else {
    ctx.fillStyle = C.hlSoft;
    ctx.fillRect(x0, top, x1 - x0, h);
    ctx.fillStyle = C.hl;
    ctx.fillRect(x0, top, x1 - x0, lw);
    ctx.fillRect(x0, top + h - lw, x1 - x0, lw);
    ctx.fillRect(x0, top, lw, h);
    ctx.fillRect(x1 - lw, top, lw, h);
  }
}

// ---------------------------------------------------------------- DOM readouts
const shown = new Map();
function setText(node, text) {
  if (shown.get(node) === text) return;
  shown.set(node, text);
  node.textContent = text;
}
const DASHES = [el.cog, el.spread, el.dashShare, el.left, el.right];

/** What the box shows: the strip during catch play, the held attempt on results, else nothing. */
function currentView() {
  if (status !== 'live' || mode !== 'fruits') return 'hidden';
  if (playing) return missing ? 'hidden' : 'live';
  if (state === RESULTS && opts.showOnResults && total > 0) return 'held';
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

function writeText() {
  setText(el.clock, total > 0 ? formatDuration(total) : '');
  if (!(total > 0)) {
    for (const node of DASHES) setText(node, '—');
    setText(el.cogSide, '');
    return;
  }
  const mean = sumX / total;
  const sigma = Math.sqrt(Math.max(0, sumX2 / total - mean * mean));
  const offset = Math.round(mean - FIELD / 2);
  setText(el.cog, String(Math.round(mean)));
  setText(el.cogSide, offset === 0 ? 'mid' : `${Math.abs(offset)} ${offset < 0 ? 'L' : 'R'}`);
  setText(el.spread, String(Math.round(sigma)));
  setText(el.dashShare, String(Math.round(dashTime / total * 100)));
  let leftTime = 0;
  for (let c = 0; c < FIELD / 2; c++) leftTime += hist[c];
  const left = Math.round(leftTime / total * 100);
  setText(el.left, String(left));
  setText(el.right, String(100 - left));
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
  if (name !== 'hidden' && cw > 0) {
    ctx.clearRect(0, 0, cw, ch);
    drawGrid();
    drawHeat();
    if (total > 0) drawCentreOfGravity(sumX / total);
    if (opts.showMarker && name === 'live' && !Number.isNaN(catcherX)) drawCatcher();
  }
  // Text at ≤ 5 Hz; a trailing timer flushes the final values when samples stop (pause, results).
  if (textDue || now - lastTextAt >= TEXT_INTERVAL_MS) {
    textDue = false;
    lastTextAt = now;
    clearTimeout(textTimer);
    textTimer = 0;
    writeText();
  } else if (!textTimer) {
    textTimer = setTimeout(() => { textTimer = 0; markDirty(true); }, TEXT_INTERVAL_MS);
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
  opts.showMarker = s.showMarker;
  opts.showOnResults = s.showOnResults;
  layoutDue = true;
  loadPalette();
  markDirty(true);
});


// Copyright (c) 2026 18-LAB. MIT.
// Catcher heatmap: where the osu!catch catcher spends its time this attempt, on a top-down
// 0–512 playfield strip. Time-weighted from vosu's /play/catcher samples on the map clock.
import { subscribe, settings, fit, activeMode, isPlaying, formatDuration } from './vosu-overlay.js';

const W = 640;
const H = 208;
const FIELD = 512;
const BIN_CHOICES = [16, 32, 64, 128];
const MISSING_AFTER_MS = 1500;   // grace before calling /play/catcher absent during play
const MAX_STEP_MS = 3000;        // larger clock gaps are seeks/hitches: resync, don't smear
const RETRY_JUMP_MS = 1500;      // clock jumping back this far mid-play = a new attempt
const TEXT_INTERVAL_MS = 200;    // readouts don't need 60 Hz; keeps layout/style idle

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  x: '/play/catcher/x', dashing: '/play/catcher/dashing',
  live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject',
  isBreak: '/beatmap/isBreak', cs: '/beatmap/stats/cs/converted', checksum: '/beatmap/checksum',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const canvas = $('plot');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  brand: $('brand'), clock: $('clock'), tag: $('tag'), dash: $('dash'), note: $('note'),
  cog: $('cog'), cogSide: $('cogSide'), spread: $('spread'), dashShare: $('dashShare'),
  left: $('left'), right: $('right'), travel: $('travel'), leftFill: $('leftFill'),
  status: $('status'), statusText: $('statusText'),
};

fit(stage, W, H);

// ---------------------------------------------------------------- attempt accumulator
// 1 px columns of the playfield; display bins are summed from these, so the bin setting
// can change live without losing history.
const hist = new Float64Array(FIELD);
const view = new Float64Array(BIN_CHOICES[BIN_CHOICES.length - 1]);
let total = 0;        // ms recorded
let sumX = 0;         // ∫x dt
let sumX2 = 0;        // ∫x² dt
let dashTime = 0;
let travel = 0;       // px moved
let prevT = NaN;
let prevX = 0;
let prevDash = false;

function resetAttempt() {
  hist.fill(0);
  total = sumX = sumX2 = dashTime = travel = 0;
  prevT = NaN;
}

const clampX = x => (x < 0 ? 0 : x > FIELD ? FIELD : x);

/** Adds `dt` ms of linear motion from a to b (playfield px) to the histogram and moments. */
function accumulate(a, b, dt, dashing) {
  total += dt;
  sumX += dt * (a + b) / 2;
  sumX2 += dt * (a * a + a * b + b * b) / 3;
  if (dashing) dashTime += dt;
  travel += Math.abs(b - a);
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
let mode = null;
let playing = false;
let resultsState = false;
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

const opts = { bins: 64, intensity: 1, showMarker: true, showBrand: true };

/** osu!catch catch range (lazer Catcher.CalculateCatchWidth): 106.75 × CS scale × 0.8. */
function catchRange(cs) {
  return typeof cs === 'number' ? 106.75 * (1 - 0.7 * (cs - 5) / 5) * 0.8 : 0;
}

function onFrame(values, changed) {
  const state = values[P.state];
  const nowPlaying = isPlaying(state);
  const nextMode = activeMode(state, values[P.playMode], values[P.selMode]);
  let visualChange = false;
  if ((state === 7) !== resultsState) { resultsState = state === 7; visualChange = true; }

  if (changed.has(P.checksum)) {
    const next = values[P.checksum];
    if (next !== undefined && checksum !== undefined && next !== checksum) { resetAttempt(); visualChange = true; }
    if (next !== undefined) checksum = next;
  }
  if (nextMode === null && total > 0 && state === undefined) { resetAttempt(); visualChange = true; } // osu! closed
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

let statusDetail = '';
function onStatus(next, detail) {
  statusDetail = detail;
  if (next === status) return;
  status = next;
  markDirty(true);
}

subscribe(Object.values(P), onFrame, { onStatus });

// `bins` defaults to a number so both vosu's option strings and numeric pushes coerce.
settings({ bins: 64, intensity: 1, showMarker: true, showBrand: true }, s => {
  opts.bins = BIN_CHOICES.includes(s.bins) ? s.bins : 64;
  opts.intensity = Math.min(4, Math.max(0.25, s.intensity));
  opts.showMarker = s.showMarker;
  opts.showBrand = s.showBrand;
  markDirty(true);
});

// ---------------------------------------------------------------- colour
// Cool steel heat ramp (graphite → --signal → --j-max) so the amber live marker stays the one
// warm thing on the strip. 256 precomputed CSS strings: no per-frame allocation.
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
const BAR_FLOOR = 46; // weakest bar still reads against the panel

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const C = {
  accent: token('--accent', '#ff963f'),
  accentSoft: 'rgb(255 150 63 / .22)',
  fg: token('--j-max', '#ebe8e1'),
  muted: token('--muted', '#7e8288'),
  rule: token('--rule-strong', '#3b3f45'),
  gridMajor: 'rgb(235 232 225 / .10)',
  gridMinor: 'rgb(235 232 225 / .045)',
  halo: 'rgb(17 18 20 / .8)',
};

// ---------------------------------------------------------------- canvas geometry (CSS px)
const LANE = { cgTop: 0, cgBottom: 6, histTop: 9, histBottom: 61, bandTop: 64, bandBottom: 71, plateTop: 74, plateBottom: 80, tickBottom: 86 };
let k = 1;   // device px per CSS px (DPR × stage scale)
let cw = 0;
let ch = 0;

function size() {
  const scale = Math.min(innerWidth / W, innerHeight / H) || 1;
  k = (devicePixelRatio || 1) * scale;
  const w = Math.max(1, Math.round(canvas.clientWidth * k));
  const h = Math.max(1, Math.round(canvas.clientHeight * k));
  if (w !== cw || h !== ch) { cw = canvas.width = w; ch = canvas.height = h; }
  markDirty(false);
}
new ResizeObserver(size).observe(canvas);
addEventListener('resize', size);

const Y = v => Math.round(v * k);
const X = x => Math.round(x / FIELD * cw);

/** Vertical rule (`width` css px) at playfield x from y0..y1 (css px), optionally dashed, with a dark halo. */
function vline(x, y0, y1, colour, dashed, halo, width) {
  const lw = Math.max(width, Math.round(k * width));
  const px = Math.min(cw - lw, Math.max(0, X(x) - (lw >> 1)));
  const top = Y(y0);
  const bottom = Y(y1);
  if (halo) { const hw = Math.max(1, Math.round(k)); ctx.fillStyle = C.halo; ctx.fillRect(px - hw, top, lw + hw * 2, bottom - top); }
  ctx.fillStyle = colour;
  if (!dashed) { ctx.fillRect(px, top, lw, bottom - top); return; }
  const on = 3 * Math.max(1, Math.round(k));
  const period = 5 * Math.max(1, Math.round(k));
  for (let y = top; y < bottom; y += period) ctx.fillRect(px, y, lw, Math.min(on, bottom - y));
}

function drawGrid() {
  const lw = Math.max(1, Math.round(k));
  const top = Y(LANE.histTop);
  const bottom = Y(LANE.histBottom);
  for (let x = 64; x < FIELD; x += 64) {
    ctx.fillStyle = x === 256 ? C.gridMajor : C.gridMinor;
    ctx.fillRect(X(x) - (lw >> 1), top, lw, bottom - top);
  }
  // Rail: hairline under the catcher lane with 64 px ticks, majors at the edges and centre.
  ctx.fillStyle = C.rule;
  ctx.fillRect(0, Y(LANE.plateBottom) + lw, cw, lw);
  ctx.fillStyle = C.muted;
  for (let x = 0; x <= FIELD; x += 64) {
    const major = x % 256 === 0;
    const px = Math.min(cw - lw, Math.max(0, X(x) - (lw >> 1)));
    ctx.fillRect(px, Y(LANE.plateBottom) + lw, lw, Y(major ? LANE.tickBottom : LANE.tickBottom - 2.5) - Y(LANE.plateBottom) - lw);
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
  const histTop = Y(LANE.histTop);
  const histBottom = Y(LANE.histBottom);
  const histH = histBottom - histTop;
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
  vline(cog, LANE.histTop, LANE.bandBottom, C.fg, true, true, 1);
  const cx = X(cog);
  const half = Y(4);
  ctx.fillStyle = C.fg;
  ctx.beginPath();
  ctx.moveTo(cx - half, Y(LANE.cgTop));
  ctx.lineTo(cx + half, Y(LANE.cgTop));
  ctx.lineTo(cx, Y(LANE.cgBottom));
  ctx.closePath();
  ctx.fill();
}

function drawCatcher() {
  vline(catcherX, LANE.histTop, LANE.bandBottom, C.accent, false, true, 2);
  const lw = Math.max(1, Math.round(k));
  const half = (catchWidth || 24) / 2;
  const x0 = Math.max(0, X(catcherX - half));
  const x1 = Math.min(cw, X(catcherX + half));
  const top = Y(LANE.plateTop);
  const h = Y(LANE.plateBottom) - top;
  if (dashingNow) {
    ctx.fillStyle = C.accent;
    ctx.fillRect(x0, top, x1 - x0, h);
  } else {
    ctx.fillStyle = C.accentSoft;
    ctx.fillRect(x0, top, x1 - x0, h);
    ctx.fillStyle = C.accent;
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
let leftScale = -1;
let viewName = '';
let dashOn = null;
let tagLive = null;

function compactPx(px) {
  return px >= 9999.5 ? `${(px / 1000).toFixed(px >= 99950 ? 0 : 1)}k px` : `${Math.round(px)} px`;
}

function currentView() {
  if (status !== 'live') return 'hidden';
  if (mode === null) return 'nodata';
  if (mode !== 'fruits') return 'hidden';
  if (playing) return 'live';
  return total > 0 ? 'held' : 'waiting';
}

function writeText(name) {
  const has = total > 0;
  setText(el.tag, name === 'held' || (name === 'waiting' && resultsState) ? (resultsState ? 'Result' : 'Last attempt') : TAGS[name]);
  const live = name === 'live';
  if (live !== tagLive) { tagLive = live; el.tag.toggleAttribute('data-live', live); }
  setText(el.clock, has ? formatDuration(total) : '');

  let note = '';
  if (name === 'nodata') note = 'Waiting for osu!';
  else if (name === 'waiting') note = resultsState ? 'No positions recorded for this attempt' : 'Waiting for a catch attempt';
  else if (live && missing) note = 'No catcher data — needs vosu (not tosu)';
  setText(el.note, note);
  if (el.note.hidden === !!note) el.note.hidden = !note;

  if (!has) {
    for (const node of [el.cog, el.spread, el.dashShare, el.left, el.right]) setText(node, '—');
    setText(el.cogSide, '');
    setText(el.travel, '');
    if (leftScale !== 0) { leftScale = 0; el.leftFill.style.transform = 'scaleX(0)'; }
    return;
  }
  const mean = sumX / total;
  const sigma = Math.sqrt(Math.max(0, sumX2 / total - mean * mean));
  const offset = Math.round(mean - FIELD / 2);
  setText(el.cog, String(Math.round(mean)));
  setText(el.cogSide, offset === 0 ? 'centred' : `${Math.abs(offset)} ${offset < 0 ? 'left' : 'right'}`);
  setText(el.spread, String(Math.round(sigma)));
  setText(el.dashShare, String(Math.round(dashTime / total * 100)));
  let leftTime = 0;
  for (let c = 0; c < FIELD / 2; c++) leftTime += hist[c];
  const left = Math.round(leftTime / total * 100);
  setText(el.left, String(left));
  setText(el.right, String(100 - left));
  setText(el.travel, `travel ${compactPx(travel)}`);
  const scale = Math.round(leftTime / total * 1000) / 1000;
  if (scale !== leftScale) { leftScale = scale; el.leftFill.style.transform = `scaleX(${scale})`; }
}

const TAGS = { live: 'Live', waiting: 'Idle', nodata: 'No data', hidden: '' };

// ---------------------------------------------------------------- render loop (runs only when dirty)
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
  if (name !== viewName) {
    viewName = name;
    panel.dataset.view = name;
    textDue = true;
  }
  if (status !== el.status.dataset.state) {
    el.status.dataset.state = status;
    el.statusText.textContent = status === 'offline' ? 'vosu offline' : status === 'connecting' ? 'connecting' : 'live';
    el.status.title = statusDetail;
  }
  if (el.brand.hidden === opts.showBrand) el.brand.hidden = !opts.showBrand;
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
    writeText(name);
  } else if (!textTimer) {
    textTimer = setTimeout(() => { textTimer = 0; markDirty(true); }, TEXT_INTERVAL_MS);
  }
}

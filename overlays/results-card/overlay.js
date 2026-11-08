// Copyright (c) 2026 18-LAB. MIT.
// Results timing: on the results screen only, adds what osu! leaves out there: UR, timing mean,
// early/late split and a hit-error histogram of the attempt just played, plus pp and the if-FC
// gap (stable's results screen shows no pp; lazer shows pp but no if-FC). Renders nothing in
// every other state.
//
// vosu re-sends `/play/hitErrorArray` whole on every hit, and still holds the finished attempt
// while the results screen shows (it clears it only on leaving for song select, menus or a
// retry). So the always-on subscription follows only what decides whether the card shows; the
// timing fields get their own subscription, opened on entering the results screen (its first
// frame carries the whole attempt) and closed on leaving it. Gameplay costs nothing.
//
// The page is content-sized: hosts (OBS, vosulay, the replay renderer) place and size it. The
// layout re-flows to the box it gets: a wide box (or orientation = horizontal) lays the readouts
// out in one row, a taller one stacks them; the design is then scaled to the box's height or
// width, whichever binds, and the spare length goes to the histogram.
import { subscribe, settings, mapPalette, applyPalette, MODES } from './vosu-overlay.js';

const RESULTS = 7;
const READY_FALLBACK_MS = 1500;
const BINS = 41;
const AMBER = '#ff963f';
// Design boxes (CSS px at scale 1) per orientation; metadata.txt's resolution is the horizontal one.
const DESIGN = { h: { w: 840, h: 112 }, v: { w: 320, h: 300 } };
// Wider than this aspect lays out in a row.
const ROW_ASPECT = 1.6;

const POINTERS = [
  '/state/number', '/resultsScreen/mode/number', '/play/mode/number', '/settings/mode/number',
  '/resultsScreen/score', '/resultsScreen/rank', '/resultsScreen/pp/current', '/resultsScreen/pp/fc',
  '/beatmap/checksum',
];
// Followed only while the results screen shows.
const TIMING_POINTERS = ['/play/hitErrorArray', '/beatmap/stats/hitWindow'];

// Hit-window scale per ruleset, innermost judgement first: colour key and hitWindow field.
const SCALE_COLORS = {
  osu: ['great', 'good', 'meh'],
  taiko: ['great', 'good'],
  mania: ['max', 'great', 'good', 'ok', 'meh'],
};
const SCALE_FIELDS = {
  osu: ['great', 'ok', 'meh'],
  taiko: ['great', 'ok'],
  mania: ['perfect', 'great', 'good', 'ok', 'meh'],
};
const NO_SCALE = [];

const $ = id => document.getElementById(id);
const box = $('frame');
const card = $('card');
const chip = $('chip');
const canvas = $('hist');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  ur: $('ur'), mean: $('mean'), early: $('early'), late: $('late'),
  perf: $('perf'), pp: $('pp'), ifFc: $('ifFc'), ppFc: $('ppFc'), ppGap: $('ppGap'), chipText: $('chipText'),
};

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const COLORS = {
  bar: token('--fg', '#ebe8e1'), axis: 'rgb(235 232 225 / .45)',
  max: '#ebe8e1', great: '#7fa6cf', good: '#6fbf8e', ok: '#b8b5ad', meh: '#e8b04a',
};
let highlight = AMBER;

// Page box and the layout derived from it (set from ResizeObserver, applied in rAF).
let pageWidth = innerWidth;
let pageHeight = innerHeight;
let orient = 'h';
let scale = 1;
let canvasCssWidth = 0;
let canvasCssHeight = 0;

// --------------------------------------------------------------------- hit-error capture
// Every timing event of the attempt, appended from the array's new tail only.
let errors = new Float32Array(4096);
let errorCount = 0;
let seenLength = 0;
let firstSeen = NaN;

function resetCapture() {
  errorCount = 0;
  seenLength = 0;
  firstSeen = NaN;
}

// Returns whether the capture changed.
function ingest(array) {
  if (!Array.isArray(array)) return false;
  const before = errorCount;
  let reset = false;
  // A shorter array or a different first event is a new attempt (quick retry).
  if (array.length < seenLength || (seenLength && array.length && array[0] !== firstSeen)) { resetCapture(); reset = true; }
  for (let i = seenLength; i < array.length; i++) {
    const value = array[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (errorCount === errors.length) {
      const grown = new Float32Array(errors.length * 2);
      grown.set(errors);
      errors = grown;
    }
    errors[errorCount++] = value;
  }
  if (array.length) firstSeen = array[0];
  seenLength = array.length;
  return reset || errorCount !== before;
}

// ------------------------------------------------------------------------- state
const DEFAULTS = { orientation: 'auto', align: 'right', backing: 'none', accent: 'map', showHistogram: true, showPp: true, hold: 0 };
let config = { ...DEFAULTS };
// Copied out of each frame (the shared client reuses its objects).
let connected = false;
let state;
let mode = 'osu';
let rank;
let score;
let pp = null;
let ppFc = null;
let checksum = '';
// Hit windows (ms, 0 when absent).
let windowPerfect = 0, windowGreat = 0, windowGood = 0, windowOk = 0, windowMeh = 0;

let timing = null;
let timingSeen = false;
let enteredAt = 0;
let holdTimer = 0;
let readyTimer = 0;
let expired = false;
let visible = false;
let textDirty = true;
let histDirty = true;
let classDirty = true;
let layoutDirty = true;
let frame = 0;
let chipTimer = 0;
let palette = null;

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function onResultsEntered() {
  enteredAt = performance.now();
  expired = false;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(updateVisibility, READY_FALLBACK_MS);
  armHold();
  resetCapture();
  timingSeen = false;
  textDirty = true;
  histDirty = true;
  timing = subscribe(TIMING_POINTERS, onTimingFrame);
}

function onResultsLeft() {
  clearTimeout(holdTimer);
  clearTimeout(readyTimer);
  if (timing) { timing.close(); timing = null; }
  timingSeen = false;
  resetCapture();
}

function onHoldExpired() {
  expired = true;
  updateVisibility();
}

function armHold() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  if (state !== RESULTS || !(config.hold > 0)) { expired = false; return; }
  const remaining = config.hold * 1000 - (performance.now() - enteredAt);
  if (remaining <= 0) { expired = true; return; }
  expired = false;
  holdTimer = setTimeout(onHoldExpired, remaining);
}

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const windowOf = value => (typeof value === 'number' && value > 0 ? value : 0);

// Waits for the score and the timing snapshot, so the card appears once, in its final layout.
function ready() {
  if (performance.now() - enteredAt >= READY_FALLBACK_MS) return true;
  return timingSeen && ((typeof rank === 'string' && rank !== '') || score > 0);
}

const hasTiming = () => errorCount >= 2;
const hasPp = () => config.showPp && pp !== null;

function updateVisibility() {
  // Nothing worth adding (catch without pp, a score opened from song select, …) renders nothing.
  const next = connected && state === RESULTS && !expired && ready() && (hasTiming() || hasPp());
  if (next === visible) return;
  visible = next;
  if (visible) { textDirty = true; histDirty = true; }
  classDirty = true;
  schedule();
}

function modeOf(v) {
  let number = v['/resultsScreen/mode/number'];
  if (!Number.isInteger(number)) number = v['/play/mode/number'];
  if (!Number.isInteger(number)) number = v['/settings/mode/number'];
  return MODES[number] ?? 'osu';
}

function onFrame(v, changed) {
  connected = true;
  const next = v['/state/number'];
  if (next !== state) {
    // Leaving the results screen ends the attempt; entering it fetches the attempt's timing.
    const was = state;
    state = next;
    if (was === RESULTS) onResultsLeft();
    if (state === RESULTS) onResultsEntered();
  }
  if (changed.has('/resultsScreen/mode/number') || changed.has('/play/mode/number') || changed.has('/settings/mode/number')) {
    const nextMode = modeOf(v);
    if (nextMode !== mode) { mode = nextMode; histDirty = true; }
  }
  if (changed.has('/resultsScreen/rank')) rank = v['/resultsScreen/rank'];
  if (changed.has('/resultsScreen/score')) score = v['/resultsScreen/score'];
  if (changed.has('/resultsScreen/pp/current')) { pp = num(v['/resultsScreen/pp/current']); textDirty = true; }
  if (changed.has('/resultsScreen/pp/fc')) { ppFc = num(v['/resultsScreen/pp/fc']); textDirty = true; }
  if (changed.has('/beatmap/checksum')) {
    const nextChecksum = typeof v['/beatmap/checksum'] === 'string' ? v['/beatmap/checksum'] : '';
    if (nextChecksum !== checksum) { checksum = nextChecksum; requestPalette(); }
  }
  updateVisibility();
  if (visible && (textDirty || histDirty)) schedule();
}

function onTimingFrame(v, changed) {
  if (state !== RESULTS) return;
  timingSeen = true;
  if (changed.has('/beatmap/stats/hitWindow')) {
    const w = v['/beatmap/stats/hitWindow'];
    const valid = w !== null && typeof w === 'object';
    windowPerfect = valid ? windowOf(w.perfect) : 0;
    windowGreat = valid ? windowOf(w.great) : 0;
    windowGood = valid ? windowOf(w.good) : 0;
    windowOk = valid ? windowOf(w.ok) : 0;
    windowMeh = valid ? windowOf(w.meh) : 0;
    histDirty = true;
  }
  if (changed.has('/play/hitErrorArray') && ingest(v['/play/hitErrorArray'])) {
    textDirty = true;
    histDirty = true;
  }
  updateVisibility();
  if (visible && (textDirty || histDirty)) schedule();
}

// Map tint: derived once per map off the hot path; the art itself is never shown.
function requestPalette() {
  palette = null;
  applyTint();
  if (config.accent !== 'map' || !checksum) return;
  const wanted = checksum;
  mapPalette(wanted).then(result => {
    if (wanted !== checksum) return;
    palette = result;
    applyTint();
  });
}

function applyTint() {
  const use = config.accent === 'map' ? palette : null;
  applyPalette(box, use);
  box.classList.toggle('tint', !!use);
  const next = use?.accent || AMBER;
  if (next !== highlight) { highlight = next; histDirty = true; schedule(); }
}

// The shared client reports 'live' on every frame, so this returns early unless the status changed.
let status = '';
function showChip() {
  chip.dataset.state = status;
  setText(el.chipText, status === 'offline' ? 'vosu offline' : 'connecting to vosu');
  chip.hidden = false;
}

function onStatus(next) {
  if (next === status) return;
  status = next;
  clearTimeout(chipTimer);
  if (next === 'live') { chip.hidden = true; return; }
  // Reconnect attempts after an outage keep reading "offline" rather than flickering.
  if (next === 'connecting' && !chip.hidden) return;
  // A brief connect on load is not worth a flash; a real outage is.
  if (next === 'connecting') chipTimer = setTimeout(showChip, 1500);
  else showChip();
}

settings(DEFAULTS, next => {
  const accentChanged = next.accent !== config.accent;
  config = { ...next, hold: Math.max(0, Number(next.hold) || 0) };
  classDirty = true;
  histDirty = true;
  textDirty = true;
  layoutDirty = true;
  armHold();
  if (accentChanged) requestPalette();
  if (connected) updateVisibility();
  schedule();
});

subscribe(POINTERS, onFrame, { onStatus });

// The page box decides orientation and scale; the canvas box its backing-store size.
new ResizeObserver(entries => {
  const rect = entries[0].contentRect;
  pageWidth = rect.width;
  pageHeight = rect.height;
  layoutDirty = true;
  schedule();
}).observe(document.documentElement);

new ResizeObserver(entries => {
  const rect = entries[0].contentRect;
  canvasCssWidth = rect.width;
  canvasCssHeight = rect.height;
  sizeCanvas();
}).observe(canvas);

// Backing store in device px: layout px × the frame's scale × devicePixelRatio.
function sizeCanvas() {
  const px = (devicePixelRatio || 1) * scale;
  const width = Math.round(canvasCssWidth * px);
  const height = Math.round(canvasCssHeight * px);
  if (width === canvas.width && height === canvas.height) return;
  canvas.width = width;
  canvas.height = height;
  histDirty = true;
  schedule();
}

// ------------------------------------------------------------------------ render
// Writes only changed strings; "—" (no data) marks the element empty so CSS can quiet it.
function setText(node, text) {
  if (node._text === text) return;
  if ((node._text === '—') !== (text === '—')) node.classList.toggle('empty', text === '—');
  node._text = text;
  node.textContent = text;
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function layout() {
  const width = pageWidth || DESIGN.h.w;
  const height = pageHeight || DESIGN.h.h;
  orient = config.orientation === 'horizontal' ? 'h' : config.orientation === 'vertical' ? 'v' : width / height >= ROW_ASPECT ? 'h' : 'v';
  const design = DESIGN[orient];
  // Scale to the binding dimension; the frame then spans the box in design px, so the other
  // dimension re-flows (histogram length) rather than letterboxing, up to a cap past which the
  // readouts would drift apart; any remaining space is left empty and `align` places the frame.
  scale = Math.min(width / design.w, height / design.h);
  let frameWidth = width / scale;
  let frameHeight = height / scale;
  if (orient === 'h') frameHeight = Math.min(frameHeight, design.h * 1.25);
  else { frameWidth = Math.min(frameWidth, design.w * 1.5); frameHeight = Math.min(frameHeight, design.h * 1.6); }
  const align = config.align === 'left' || config.align === 'center' ? config.align : 'right';
  const spare = width - frameWidth * scale;
  const x = align === 'left' ? 0 : align === 'center' ? spare / 2 : spare;
  box.dataset.orient = orient;
  box.dataset.align = align;
  box.style.width = `${frameWidth}px`;
  box.style.height = `${frameHeight}px`;
  box.style.transform = `translate(${Math.round(x)}px, 0) scale(${scale})`;
  // Mono labels and units stay at least 9 px on screen in small boxes.
  box.style.setProperty('--label', `${Math.max(12, 9 / scale).toFixed(2)}px`);
  box.classList.toggle('compact', scale < 0.75);
  sizeCanvas();
}

// Last formatted numbers (NaN = never shown), so strings are built only when a number changes.
let shownPp = NaN;
let shownPpFc = NaN;
let shownGap = NaN;
let shownUr = NaN;
let shownMean = NaN;
let shownEarly = NaN;
let shownLate = NaN;

function renderText() {
  box.classList.toggle('no-timing', !hasTiming());
  setHidden(el.perf, !hasPp());
  if (pp === null) { shownPp = NaN; setText(el.pp, '—'); }
  else {
    const rounded = Math.round(pp);
    if (rounded !== shownPp) { shownPp = rounded; setText(el.pp, integer.format(rounded)); }
  }
  const gap = pp !== null && ppFc !== null ? ppFc - pp : 0;
  setHidden(el.ifFc, !(gap >= 0.5));
  if (gap >= 0.5) {
    const fc = Math.round(ppFc);
    if (fc !== shownPpFc) { shownPpFc = fc; setText(el.ppFc, integer.format(fc)); }
    const shownDiff = fc - Math.round(pp);
    if (shownDiff !== shownGap) { shownGap = shownDiff; setText(el.ppGap, `+${integer.format(shownDiff)}`); }
  }
}

// Histogram scratch, reused for every draw.
const bins = new Uint32Array(BINS);

function windowField(field) {
  switch (field) {
    case 'perfect': return windowPerfect;
    case 'great': return windowGreat;
    case 'good': return windowGood;
    case 'ok': return windowOk;
    case 'meh': return windowMeh;
    default: return 0;
  }
}

function renderTiming() {
  const n = errorCount;
  if (n < 2) return;
  let sum = 0, early = 0, late = 0, extent = 0;
  for (let i = 0; i < n; i++) {
    const e = errors[i];
    sum += e;
    if (e < 0) early++; else if (e > 0) late++;
    const a = e < 0 ? -e : e;
    if (a > extent) extent = a;
  }
  const average = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) { const d = errors[i] - average; squares += d * d; }
  const sigma = Math.sqrt(squares / n);
  const ur = sigma * 10;
  if (ur !== shownUr) { shownUr = ur; setText(el.ur, ur.toFixed(2)); }
  if (average !== shownMean) {
    shownMean = average;
    setText(el.mean, `${average < 0 ? '−' : average > 0 ? '+' : ''}${Math.abs(average).toFixed(1)}`);
  }
  const earlyPercent = Math.round((early / n) * 100);
  if (earlyPercent !== shownEarly) { shownEarly = earlyPercent; setText(el.early, `${earlyPercent}%`); }
  const latePercent = Math.round((late / n) * 100);
  if (latePercent !== shownLate) { shownLate = latePercent; setText(el.late, `${latePercent}%`); }
  if (!config.showHistogram) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const colors = SCALE_COLORS[mode] || NO_SCALE;
  const fields = SCALE_FIELDS[mode] || NO_SCALE;
  let outer = 0;
  let great = 0;
  for (let i = 0; i < fields.length; i++) {
    const value = windowField(fields[i]);
    if (value > outer) outer = value;
    if (!great && colors[i] === 'great') great = value;
  }
  // Frame the distribution (±3.5σ around the mean), never tighter than the great window nor wider
  // than the outermost one, so a 300 px strip shows shape rather than one spike.
  const spread = Math.ceil((3.5 * sigma + Math.abs(average)) / 5) * 5;
  const range = outer ? Math.min(outer, Math.max(great, spread, 10)) : Math.max(20, Math.ceil(extent / 10) * 10);
  bins.fill(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((errors[i] + range) / (2 * range)) * BINS);
    if (b < 0 || b >= BINS) continue; // outliers stay in UR/mean, not on the frame's edge
    if (++bins[b] > peak) peak = bins[b];
  }

  const dpr = (devicePixelRatio || 1) * scale; // device px per design px
  const hair = Math.max(1, Math.round(dpr));
  const strip = Math.round(4 * dpr);
  const base = height - strip - Math.round(4 * dpr); // bar baseline (device px)
  const top = Math.round(6 * dpr);

  // Contrast over any map background: the same restrained shadow as the text.
  ctx.shadowColor = 'rgb(0 0 0 / .55)';
  ctx.shadowBlur = 2 * dpr;
  ctx.shadowOffsetY = dpr;

  // Hit-window scale under the bars: innermost judgement drawn last so it stays on top.
  for (let i = fields.length - 1; i >= 0; i--) {
    const value = windowField(fields[i]);
    if (!value) continue;
    ctx.fillStyle = COLORS[colors[i]];
    const x0 = Math.round(((range - value) / (2 * range)) * width);
    ctx.fillRect(x0, height - strip, Math.round(((value + range) / (2 * range)) * width) - x0, strip);
  }

  // Bars, pixel-snapped with a 1 device-px gutter.
  const step = width / BINS;
  ctx.fillStyle = COLORS.bar;
  ctx.globalAlpha = 0.92;
  for (let b = 0; b < BINS; b++) {
    if (!bins[b]) continue;
    const x0 = Math.round(b * step);
    const x1 = Math.round((b + 1) * step) - hair;
    const h = Math.max(hair, Math.round((bins[b] / peak) * (base - top)));
    ctx.fillRect(x0, base - h, Math.max(1, x1 - x0), h);
  }
  ctx.globalAlpha = 1;

  // Baseline and zero line (hairlines).
  ctx.fillStyle = COLORS.axis;
  ctx.fillRect(0, base, width, hair);
  ctx.fillRect(Math.round((range / (2 * range)) * width - hair / 2), 0, hair, base);

  // Mean marker in the highlight colour, with a small cap.
  const clamped = Math.max(-range, Math.min(range, average));
  const m = Math.round(((clamped + range) / (2 * range)) * width - hair / 2);
  ctx.fillStyle = highlight;
  ctx.fillRect(m, 0, hair * 2, base + hair);
  const cap = Math.round(4 * dpr);
  ctx.fillRect(m - cap, 0, cap * 2 + hair * 2, hair * 2);
  ctx.shadowColor = 'transparent';
}

function render() {
  frame = 0;
  if (layoutDirty) { layoutDirty = false; layout(); }
  if (classDirty) {
    classDirty = false;
    box.dataset.backing = config.backing;
    box.classList.toggle('no-hist', !config.showHistogram);
    card.classList.toggle('on', visible);
    card.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
  if (!connected || !visible) return;
  if (textDirty) { textDirty = false; renderText(); }
  if (histDirty) { histDirty = false; renderTiming(); }
}

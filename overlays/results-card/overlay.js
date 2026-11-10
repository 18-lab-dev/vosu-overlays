// Copyright (c) 2026 18-LAB. MIT.
// Results timing: on the results screen only, adds what osu! leaves out there: UR, timing mean,
// the early/late split and a hit-error histogram of the attempt just played, plus the If FC gap
// (neither client's results screen shows what a full combo would have given; lazer already shows
// the score's pp, so the card does not repeat it). Renders nothing in every other state, and
// nothing in a results screen it has nothing to add to (catch with a full combo).
//
// vosu re-sends `/play/hitErrorArray` whole on every hit, and still holds the finished attempt
// while the results screen shows (it clears it only on leaving for song select, menus or a
// retry). So the always-on subscription follows only what decides whether the card shows; the
// timing fields get their own subscription, opened on entering the results screen (its first
// frame carries the whole attempt) and closed on leaving it. Gameplay costs nothing.
//
// Motion (setting `motion`): on entering the results screen the card rises in, the histogram's
// bars grow from the zero line outward, the mean marker drops onto them and the numbers settle,
// once per results screen. Nothing runs afterwards; reduced keeps the card's enter/exit only.
//
// The page is the host's box (OBS, vosulay, the replay renderer size it); the card is
// content-sized inside it. A wide box (or orientation = horizontal) lays the readouts out in one
// row, a taller one stacks them; --u scales the design to the box.
import {
  subscribe, settings, MODES, known, isKnown, DASH, numberFormatter, mean, unstableRate,
  applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const RESULTS = 7;
const READY_FALLBACK_MS = 1500;
const BINS = 41;
const CENTRE_BIN = (BINS - 1) / 2;
// Design boxes per orientation (--u = 1); metadata.txt's resolution is the row.
const DESIGN = { h: { w: 840, h: 96 }, v: { w: 320, h: 300 } };
// Wider than this aspect lays out in a row.
const ROW_ASPECT = 1.6;

// Reveal timing (ms from the card's first frame). Bars: 300 ms each, 8 ms apart from the zero
// line outward; the mean marker after the central bars; the numbers settle in reading order.
const BAR_MS = 300;
const BAR_STAGGER_MS = 8;
const MARKER_DELAY_MS = 200;
const MARKER_MS = MOTION_MS.base;
const REVEAL_END_MS = Math.max(CENTRE_BIN * BAR_STAGGER_MS + BAR_MS, MARKER_DELAY_MS + MARKER_MS);
const SETTLE_MS = MOTION_MS.base;
const SETTLE_DELAYS = { ur: 140, mean: 180, split: 220, gap: 260 };
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'; // --ease-out
const SETTLE_FRAMES = [{ opacity: 0, transform: 'translateY(.16em)' }, { opacity: 1, transform: 'none' }];

const POINTERS = [
  '/state/number', '/resultsScreen/mode/number', '/play/mode/number', '/settings/mode/number',
  '/resultsScreen/score', '/resultsScreen/rank', '/resultsScreen/pp/current', '/resultsScreen/pp/fc',
];
// Followed only while the results screen shows.
const TIMING_POINTERS = ['/play/hitErrorArray', '/beatmap/stats/hitWindow'];

const $ = id => document.getElementById(id);
const box = $('frame');
const card = $('card');
const chip = $('chip');
const canvas = $('hist');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  ur: $('ur'), urFrac: $('urFrac'), mean: $('mean'), early: $('early'), late: $('late'),
  onTime: $('onTime'), onTimeCell: $('onTimeCell'), ifFc: $('ifFc'), gap: $('gap'), chipText: $('chipText'),
};

const css = getComputedStyle(card);
const token = name => css.getPropertyValue(name).trim();
const COLORS = { bar: token('--text-2'), axis: token('--hair-strong'), base: token('--hair'), mean: token('--you') };

// One settle animation per number group, created once and restarted for each reveal.
function settleAnimation(node, delay) {
  const animation = node.animate(SETTLE_FRAMES, { duration: SETTLE_MS, delay, easing: EASE_OUT, fill: 'backwards' });
  animation.cancel();
  return animation;
}
const settles = [];
for (const node of card.querySelectorAll('.settle')) {
  const delay = node.closest('.c-ur') ? SETTLE_DELAYS.ur : node.closest('.c-mean') ? SETTLE_DELAYS.mean
    : node.closest('.c-fc') ? SETTLE_DELAYS.gap : SETTLE_DELAYS.split;
  settles.push(settleAnimation(node, delay));
}
// The If FC gap can arrive after the reveal (pp is computed after the score); it settles alone.
const gapSettle = settleAnimation(el.gap.parentElement, 0);

// --------------------------------------------------------------------- hit-error capture
// Every timing event of the attempt, appended from the array's new tail only.
let errors = new Float64Array(4096);
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
      const grown = new Float64Array(errors.length * 2);
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
const DEFAULTS = { orientation: 'auto', align: 'right', motion: 'full', backing: 'scrim', marks: 'neutral', showHistogram: true, showPp: true, hold: 0 };
let config = { ...DEFAULTS };
let motion = 'full';
let shadowed = false; // backing = none: the histogram gets the text's contrast shadow
// Copied out of each frame (the shared client reuses its objects).
let connected = false;
let state;
let mode = 'osu';
let rank;
let score;
let pp = NaN;
let ppFc = NaN;
// Hit windows (ms, 0 when absent).
let windowPerfect = 0, windowGreat = 0, windowGood = 0, windowOk = 0, windowMeh = 0;

let timing = null;
let timingSeen = false;
let enteredAt = 0;
let holdTimer = 0;
let readyTimer = 0;
let expired = false;
let visible = false;
let revealed = false;     // the reveal ran for this results screen
let revealStart = -1;     // rAF time of the reveal's first frame; NaN = starts next frame; -1 = none
let textDirty = true;
let statsDirty = true;    // histogram bins and the split, from the capture and the windows
let drawDirty = true;     // canvas pixels
let classDirty = true;
let layoutDirty = true;
let frame = 0;
let chipTimer = 0;

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function onResultsEntered() {
  enteredAt = performance.now();
  expired = false;
  revealed = false;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(updateVisibility, READY_FALLBACK_MS);
  armHold();
  resetCapture();
  timingSeen = false;
  textDirty = true;
  statsDirty = true;
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

const windowOf = value => (typeof value === 'number' && value > 0 ? value : 0);

// Waits for the score and the timing snapshot, so the card appears once, in its final layout.
function ready() {
  if (performance.now() - enteredAt >= READY_FALLBACK_MS) return true;
  return timingSeen && ((typeof rank === 'string' && rank !== '') || score > 0);
}

const hasTiming = () => errorCount >= 2;
// pp the score lost to combo breaks; unknown when either side was not computed (0 = not computed).
const gapOf = () => (isKnown(pp) && isKnown(ppFc) ? ppFc - pp : NaN);
const hasGap = () => config.showPp && gapOf() >= 0.5;

function updateVisibility() {
  // Nothing worth adding (catch with a full combo, a score opened from song select, …) renders nothing.
  const next = connected && state === RESULTS && !expired && ready() && (hasTiming() || hasGap());
  if (next === visible) return;
  visible = next;
  if (visible) { textDirty = true; statsDirty = true; }
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
    if (nextMode !== mode) { mode = nextMode; statsDirty = true; }
  }
  if (changed.has('/resultsScreen/rank')) rank = v['/resultsScreen/rank'];
  if (changed.has('/resultsScreen/score')) score = v['/resultsScreen/score'];
  if (changed.has('/resultsScreen/pp/current')) { pp = known(v['/resultsScreen/pp/current'], true); textDirty = true; }
  if (changed.has('/resultsScreen/pp/fc')) { ppFc = known(v['/resultsScreen/pp/fc'], true); textDirty = true; }
  updateVisibility();
  if (visible && (textDirty || statsDirty)) schedule();
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
    statsDirty = true;
  }
  if (changed.has('/play/hitErrorArray') && ingest(v['/play/hitErrorArray'])) {
    textDirty = true;
    statsDirty = true;
  }
  updateVisibility();
  if (visible && (textDirty || statsDirty)) schedule();
}

// The shared client reports 'live' on every frame, so this returns early unless the status changed.
let status = '';
function showChip() {
  chip.dataset.state = status;
  setText(el.chipText, status === 'offline' ? 'vosu offline' : 'Connecting to vosu');
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
  config = { ...next, hold: Math.max(0, Number(next.hold) || 0) };
  motion = applyKitSettings(card, config);
  shadowed = card.dataset.backing === 'none';
  if (motion !== 'full') finishReveal();
  classDirty = true;
  statsDirty = true;
  textDirty = true;
  layoutDirty = true;
  armHold();
  if (connected) updateVisibility();
  schedule();
});

subscribe(POINTERS, onFrame, { onStatus });

// The page box decides orientation and --u; the canvas box its backing-store size.
let pageWidth = innerWidth;
let pageHeight = innerHeight;
new ResizeObserver(entries => {
  const rect = entries[0].contentRect;
  pageWidth = rect.width;
  pageHeight = rect.height;
  layoutDirty = true;
  schedule();
}).observe(document.documentElement);

let canvasCssWidth = 0;
let canvasCssHeight = 0;
new ResizeObserver(entries => {
  const rect = entries[0].contentRect;
  canvasCssWidth = rect.width;
  canvasCssHeight = rect.height;
  sizeCanvas();
}).observe(canvas);

// ------------------------------------------------------------------------ layout
let orient = '';
let unit = 0;

function layout() {
  const width = pageWidth || DESIGN.h.w;
  const height = pageHeight || DESIGN.h.h;
  const nextOrient = config.orientation === 'horizontal' ? 'h' : config.orientation === 'vertical' ? 'v'
    : width / height >= ROW_ASPECT ? 'h' : 'v';
  const design = DESIGN[nextOrient];
  const nextUnit = Math.round(Math.min(width / design.w, height / design.h) * 1000) / 1000;
  if (nextOrient !== orient) { orient = nextOrient; box.dataset.orient = orient; }
  const align = config.align === 'left' || config.align === 'center' ? config.align : 'right';
  if (box.dataset.align !== align) box.dataset.align = align;
  if (nextUnit !== unit) { unit = nextUnit; card.style.setProperty('--u', String(unit)); drawDirty = true; }
}

// Backing store in device px; the plot's geometry is derived from it in prepareBars().
function sizeCanvas() {
  const ratio = devicePixelRatio || 1;
  const width = Math.round(canvasCssWidth * ratio);
  const height = Math.round(canvasCssHeight * ratio);
  if (width === canvas.width && height === canvas.height) return;
  canvas.width = width;
  canvas.height = height;
  drawDirty = true;
  schedule();
}

// ------------------------------------------------------------------------ text
// Writes only changed strings (formatters return the same object for the same shown value).
function setText(node, text) {
  if (node._text === text) return;
  if ((node._text === DASH) !== (text === DASH)) node.classList.toggle('kit-dash', text === DASH);
  node._text = text;
  node.textContent = text;
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

const urWhole = numberFormatter('count');
const FRACTIONS = ['.0', '.1', '.2', '.3', '.4', '.5', '.6', '.7', '.8', '.9'];
const msFormat = numberFormatter('ms');
const gapFormat = numberFormatter('delta');
const earlyFormat = numberFormatter('percent');
const lateFormat = numberFormatter('percent');
const onTimeFormat = numberFormatter('percent');

let shownGap = false;

function renderText() {
  const timed = hasTiming();
  box.classList.toggle('no-timing', !timed);
  const gap = gapOf();
  const showGap = hasGap();
  setHidden(el.ifFc, !showGap);
  if (showGap) setText(el.gap, gapFormat(gap));
  // A gap that arrives after the reveal settles in on its own.
  if (showGap && !shownGap && revealed && motion === 'full' && visible) { gapSettle.currentTime = 0; gapSettle.play(); }
  shownGap = showGap;
}

// --------------------------------------------------------------------- statistics
const bins = new Uint32Array(BINS);
const barHeight = new Float32Array(BINS); // share of the tallest bar, 0…1
let average = 0;
let range = 20;

function computeStats() {
  const n = errorCount;
  if (n < 2) return;
  const capture = errors.subarray(0, n);
  const ur = known(unstableRate(capture));
  average = known(mean(capture));
  let early = 0, late = 0, extent = 0;
  for (let i = 0; i < n; i++) {
    const e = errors[i];
    if (e < 0) early++; else if (e > 0) late++;
    const a = e < 0 ? -e : e;
    if (a > extent) extent = a;
  }

  // UR as a hero with its decimal as a fraction: 130.2 → "130" + ".2".
  if (isKnown(ur)) {
    const key = Math.round(ur * 10);
    setText(el.ur, urWhole((key - key % 10) / 10));
    setText(el.urFrac, FRACTIONS[key % 10]);
  } else { setText(el.ur, DASH); setText(el.urFrac, ''); }
  setText(el.mean, msFormat(average));
  splitShares(early, n - early - late, late, n);
  setText(el.early, earlyFormat(shareEarly));
  setText(el.late, lateFormat(shareLate));
  setHidden(el.onTimeCell, shareOnTime === 0);
  if (shareOnTime) setText(el.onTime, onTimeFormat(shareOnTime));

  // Frame the distribution (±3.5σ around the mean), never tighter than the 300 window nor wider
  // than the outermost one, so the strip shows shape rather than one spike.
  const sigma = isKnown(ur) ? ur / 10 : 0;
  let outer = 0;
  if (mode === 'osu' || mode === 'taiko') outer = Math.max(windowGreat, windowOk, mode === 'osu' ? windowMeh : 0);
  else if (mode === 'mania') outer = Math.max(windowPerfect, windowGreat, windowGood, windowOk, windowMeh);
  const spread = Math.ceil((3.5 * sigma + Math.abs(average || 0)) / 5) * 5;
  range = outer ? Math.min(outer, Math.max(windowGreat, spread, 10)) : Math.max(20, Math.ceil(extent / 10) * 10);
  bins.fill(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((errors[i] + range) / (2 * range)) * BINS);
    if (b < 0 || b >= BINS) continue; // outliers stay in UR/mean, not on the frame's edge
    if (++bins[b] > peak) peak = bins[b];
  }
  for (let b = 0; b < BINS; b++) barHeight[b] = peak ? bins[b] / peak : 0;
}

// Early / on time / late as whole percentages that sum to 100 (largest remainder).
let shareEarly = 0, shareOnTime = 0, shareLate = 0;
function splitShares(early, onTime, late, n) {
  const e = (early * 100) / n, o = (onTime * 100) / n, l = (late * 100) / n;
  shareEarly = Math.floor(e); shareOnTime = Math.floor(o); shareLate = Math.floor(l);
  let re = e - shareEarly, ro = o - shareOnTime, rl = l - shareLate;
  for (let left = 100 - shareEarly - shareOnTime - shareLate; left > 0; left--) {
    if (re >= rl && re >= ro) { shareEarly++; re = -1; }
    else if (rl >= ro) { shareLate++; rl = -1; }
    else { shareOnTime++; ro = -1; }
  }
}

// ------------------------------------------------------------------------ drawing
// Everything a frame needs is precomputed in device px (prepareBars, on data, size or settings
// changes) and eased through integer tables, so a reveal frame runs on small integers only: no
// number boxing and no garbage, even in code the engine has not optimised yet (the reveal is
// over before it would be).
const EASE_ONE = 1024; // fixed-point 1.0 (>> 10)
// Expo-out (close to --ease-out) sampled per ms.
function easeTable(duration) {
  const table = new Uint16Array(duration + 1);
  for (let i = 0; i <= duration; i++) table[i] = i >= duration ? EASE_ONE : Math.round(EASE_ONE * (1 - Math.pow(2, (-10 * i) / duration)));
  return table;
}
const BAR_EASE = easeTable(BAR_MS);
const MARKER_EASE = easeTable(MARKER_MS);
const AT_REST = 1 << 20; // a reveal time past every delay
const SHADOW = 'rgb(0 0 0 / .6)';
const NO_SHADOW = 'transparent';
// Each bar starts BAR_STAGGER_MS after its inner neighbour: the zero line's bin first.
const barDelay = new Int32Array(BINS);
for (let b = 0; b < BINS; b++) barDelay[b] = (b < CENTRE_BIN ? CENTRE_BIN - b : b - CENTRE_BIN) * BAR_STAGGER_MS;
const barX = new Int32Array(BINS);
const barW = new Int32Array(BINS);
const barFull = new Int32Array(BINS); // full height; 0 = empty bin
let hair = 1;
let plotBase = 0;
let zeroX = 0, zeroTop = 0, zeroHeight = 0;
let hasMarker = false, markerX = 0, markerTop = 0, markerLength = 0, capX = 0, capWidth = 0;
let shadowBlur = 0, shadowOffset = 0;

// The plot in device px: bars rise from the numerals' baseline (6 design px above the canvas
// bottom: the zero tick hangs below it) to 6 px under the top, where the mean marker's cap sits.
function prepareBars() {
  const width = canvas.width;
  const height = canvas.height;
  const dpr = (devicePixelRatio || 1) * (unit || 1); // device px per design px
  hair = Math.max(1, Math.round(devicePixelRatio || 1));
  plotBase = height - Math.round(6 * dpr);
  const plotTop = Math.round(6 * dpr);
  const rows = Math.max(0, plotBase - plotTop);
  zeroX = Math.round(width / 2 - hair / 2);
  zeroTop = plotTop;
  zeroHeight = height - plotTop;
  // Pixel-snapped bars with a 1 device-px gutter.
  const step = width / BINS;
  for (let b = 0; b < BINS; b++) {
    const x0 = Math.round(b * step);
    barX[b] = x0;
    barW[b] = Math.max(1, Math.round((b + 1) * step) - hair - x0);
    barFull[b] = bins[b] ? Math.max(hair, Math.round(barHeight[b] * rows)) : 0;
  }
  hasMarker = errorCount >= 2 && isKnown(average);
  if (hasMarker) {
    const clamped = Math.max(-range, Math.min(range, average));
    markerX = Math.round(((clamped + range) / (2 * range)) * width - hair);
    markerTop = plotTop - Math.round(4 * dpr);
    markerLength = plotBase + hair - markerTop;
    const cap = Math.round(4 * dpr);
    capX = markerX - cap;
    capWidth = cap * 2 + hair * 2;
  }
  shadowBlur = 2 * dpr;
  shadowOffset = dpr;
}

// Draws the histogram `t` whole ms into the reveal (AT_REST = complete).
function drawHistogram(t) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (!width || !height || errorCount < 2 || !config.showHistogram) return;
  // Contrast over an undimmed map only without a backing (the scrim already gives it).
  if (shadowed) { ctx.shadowColor = SHADOW; ctx.shadowBlur = shadowBlur; ctx.shadowOffsetY = shadowOffset; }

  // Zero: a hairline behind the bars and a tick hanging below the baseline, where bars never reach.
  ctx.fillStyle = COLORS.axis;
  ctx.fillRect(zeroX, zeroTop, hair, zeroHeight);
  ctx.fillStyle = COLORS.base;
  ctx.fillRect(0, plotBase, width, hair);

  // Bars grow from the baseline, centre first.
  ctx.fillStyle = COLORS.bar;
  for (let b = 0; b < BINS; b++) {
    const full = barFull[b];
    if (!full) continue;
    let k = t - barDelay[b];
    if (k <= 0) continue;
    if (k > BAR_MS) k = BAR_MS;
    let h = (full * BAR_EASE[k]) >> 10;
    if (h < hair) h = hair;
    ctx.fillRect(barX[b], plotBase - h, barW[b], h);
  }

  // Mean marker in amber (your timing): its cap appears, then the line drops onto the bars.
  let k = t - MARKER_DELAY_MS;
  if (hasMarker && k > 0) {
    if (k > MARKER_MS) k = MARKER_MS;
    ctx.fillStyle = COLORS.mean;
    ctx.fillRect(capX, markerTop, capWidth, hair * 2);
    ctx.fillRect(markerX, markerTop, hair * 2, (markerLength * MARKER_EASE[k]) >> 10);
  }
  if (shadowed) ctx.shadowColor = NO_SHADOW;
}

// ------------------------------------------------------------------------ reveal
function startReveal() {
  revealed = true;
  if (motion !== 'full') return;
  revealStart = NaN;
  for (let i = 0; i < settles.length; i++) { settles[i].currentTime = 0; settles[i].play(); }
}

function finishReveal() {
  if (revealStart === -1) return;
  revealStart = -1;
  for (let i = 0; i < settles.length; i++) settles[i].cancel();
  drawDirty = true;
}

function render(now) {
  frame = 0;
  if (layoutDirty) { layoutDirty = false; layout(); }
  if (classDirty) {
    classDirty = false;
    box.classList.toggle('no-hist', !config.showHistogram);
    if (visible) card.removeAttribute('data-out'); else card.setAttribute('data-out', '');
    card.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) finishReveal();
  }
  if (!connected || !visible) return;
  if (textDirty) { textDirty = false; renderText(); }
  if (statsDirty) { statsDirty = false; computeStats(); drawDirty = true; }
  const dirty = drawDirty;
  if (dirty) { drawDirty = false; prepareBars(); }
  if (!revealed) startReveal();
  if (revealStart !== -1) {
    if (revealStart !== revealStart) revealStart = now; // NaN: the reveal's first frame
    const t = (now - revealStart) | 0;
    drawHistogram(t);
    if (t < REVEAL_END_MS) schedule(); else revealStart = -1;
    return;
  }
  if (dirty) drawHistogram(AT_REST);
}

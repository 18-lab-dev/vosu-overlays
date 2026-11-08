// Copyright (c) 2026 18-LAB. MIT.
// osu!mania judgement counter: MAX…MISS counts, proportional bar, MAX:300 ratio, accuracy,
// combo and key presses per second from /keys/all count deltas. The page is content-sized: a
// tall box gets the data column, a wide one the compact focus row (for over the stage, just above
// the receptors). Results keep only what osu!'s ranking screen lacks (ratio and peak KPS).
//
// Render path: every buffer is allocated at load or on resize. A frame formats a string only
// for a displayed number that changed (shares come from a table built once), writes the DOM
// only when that string differs, and redraws the bar only when a count changed.
import { subscribe, settings, activeMode, mapPalette, applyPalette, MODES } from './vosu-overlay.js';

// Base metrics (CSS px) each layout is designed at; the page scales them to its box.
const BASE = { vertical: { w: 260, h: 384 }, horizontal: { w: 600, h: 82 } };
const HORIZONTAL_ASPECT = 2; // auto orientation: boxes at least this wide per unit of height
const STATE_PLAY = 2;
const STATE_RESULTS = 7;
const KPS_WINDOW = 1000; // ms of wall clock
const KPS_JUMP = 64; // larger count jumps are attach/rewind baselines, not presses

// Row order: MAX, 300, 200, 100, 50, MISS.
const KEYS = ['geki', '300', 'katu', '100', '50', '0'];
const PLAY_HITS = KEYS.map(key => `/play/hits/${key}`);
const RESULT_HITS = KEYS.map(key => `/resultsScreen/hits/${key}`);
const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  resultsMode: '/resultsScreen/mode/number',
  source: '/play/source',
  accuracy: '/play/accuracy',
  combo: '/play/combo/current',
  keys: '/keys/all',
  keyCount: '/beatmap/stats/cs/converted',
  checksum: '/beatmap/checksum',
};

const $ = id => document.getElementById(id);
const hud = $('hud');
const chip = $('chip');
const canvas = $('bar');
const ctx = canvas.getContext('2d', { alpha: true });
const rows = [...hud.querySelectorAll('.row')].map(row => ({
  row,
  count: row.querySelector('.count'),
  share: row.querySelector('.share'),
  flash: null,
  flashTarget: row.querySelector('.flash'),
}));
const text = {
  status: $('status'), keys: $('keys'), ratio: $('ratio'), acc: $('acc'), combo: $('combo'),
  kps: $('kps'), peak: $('peak'), peakLabel: $('peak-label'), chip: $('chip-text'),
};
const note = $('note');

// ------------------------------------------------------------------ state
let socketStatus = 'connecting';
let feed = null; // subscribe()'s handle; its `values` object is the client's, updated in place
let previousState;
let peakValid = false; // results reached straight from our own play → its peak KPS applies
let options = null;

// Key presses: wall-clock timestamps of each counted down-edge in a ring buffer.
const RING = 1024;
const ring = new Float64Array(RING);
let ringHead = 0;
let ringSize = 0;
let keyBase = -1;
let peak = 0;
let decayTimer = 0;
// Ring time of the press the pending decay wake was armed for (NaN = none). A typed slot: a
// module `let` would box a fresh number on every store of a fractional time.
const decayFor = new Float64Array(1).fill(NaN);

// Last attempt, held so the results screen can show its ratio and peak.
const held = { has: false, counts: new Int32Array(6), peak: NaN };

const counts = new Int32Array(6);
const drawn = new Int32Array(6).fill(-1);
let drawnPhase = '';
let lastPhase = '';
let barDirty = true;
let pending = 0;

// Numbers behind the displayed text (NaN = '—', undefined = nothing shown yet).
const UNSET = -2147483648;
const shownCount = new Int32Array(6).fill(UNSET);
const shownShare = new Int32Array(6).fill(UNSET); // SHARE index, -1 = blank (no judgements)
let shownAcc;
let shownCombo;
let shownKps;
let shownPeak;
let shownKeyCount;
let shownMax = UNSET;
let shownGreat = UNSET;
let shownSum = UNSET; // the sum the shown shares were computed from

let paletteFor = '';
let unit = 1; // page px per base px
let orientation = 'vertical'; // mirrors hud[data-orient]

function resetKps() {
  ringHead = 0;
  ringSize = 0;
  keyBase = -1;
  peak = 0;
}

function evict(now) {
  const edge = now - KPS_WINDOW;
  while (ringSize && ring[ringHead] <= edge) {
    ringHead = (ringHead + 1) % RING;
    ringSize--;
  }
}

/** Counts new down-edges from the summed per-key counts; reads the parsed array in place. */
function countPresses(keys, now) {
  if (!Array.isArray(keys)) return;
  let total = 0;
  for (let i = 0; i < keys.length; i++) total += keys[i]?.count || 0;
  if (keyBase < 0 || total < keyBase || total - keyBase > KPS_JUMP) {
    // First frame, retry/rewind, or a gap we cannot attribute: take it as the new baseline.
    if (keyBase >= 0 && total < keyBase) { ringHead = 0; ringSize = 0; peak = 0; }
    keyBase = total;
    return;
  }
  for (let n = total - keyBase; n > 0; n--) {
    ring[(ringHead + ringSize) % RING] = now;
    if (ringSize < RING) ringSize++;
    else ringHead = (ringHead + 1) % RING;
  }
  keyBase = total;
  evict(now);
  if (ringSize > peak) peak = ringSize;
}

function onFrame(next, changed) {
  const state = next[P.state];
  if (state === STATE_PLAY && previousState !== STATE_PLAY) { resetKps(); peakValid = true; }
  if (state === STATE_RESULTS && previousState !== STATE_RESULTS && previousState !== STATE_PLAY) peakValid = false;
  if (state === STATE_PLAY && changed.has(P.keys)) countPresses(next[P.keys], performance.now());
  if (changed.has(P.checksum)) loadPalette();
  previousState = state;
  schedule();
}

function onStatus(state) {
  // Reconnect attempts report `connecting`; keep saying offline until one succeeds.
  if (state === socketStatus || (state === 'connecting' && socketStatus === 'offline')) return;
  socketStatus = state;
  schedule();
}

function schedule() {
  if (!pending) pending = requestAnimationFrame(render);
}

// Live KPS decays without new frames: one wake when the oldest press leaves the window.
function onDecay() {
  decayTimer = 0;
  decayFor[0] = NaN;
  schedule();
}
function cancelDecay() {
  if (!decayTimer) return;
  clearTimeout(decayTimer);
  decayTimer = 0;
  decayFor[0] = NaN;
}

// ------------------------------------------------------------------ box layout + tint
/**
 * Lays the cluster out for the page's box: orientation from the box's aspect (or the setting),
 * scale so the base design fits, and the cluster spans the box width in base units. Runs on
 * resize and settings changes only (it reads the window size, never inside a frame).
 */
function layout() {
  if (!options) return;
  const width = innerWidth || BASE.vertical.w;
  const height = innerHeight || BASE.vertical.h;
  const orient = options.orientation === 'horizontal' || options.orientation === 'vertical'
    ? options.orientation
    : width >= height * HORIZONTAL_ASPECT ? 'horizontal' : 'vertical';
  const base = BASE[orient];
  unit = Math.max(0.25, Math.min(width / base.w, height / base.h));
  const align = ['left', 'right', 'center'].includes(options.align) ? options.align : orient === 'horizontal' ? 'center' : 'left';
  orientation = orient;
  setAttr(hud, 'orient', orient);
  setAttr(hud, 'align', align);
  setAttr(chip, 'align', align);
  hud.style.setProperty('--u', String(unit));
  hud.style.setProperty('--w', `${width / unit}px`);
  hud.style.setProperty('--justify', align === 'left' ? 'start' : align === 'right' ? 'end' : 'center');
  // A new unit with an unchanged CSS box would not wake the ResizeObserver: size it here too.
  sizeCanvas(canvas.clientWidth, canvas.clientHeight);
}

function loadPalette() {
  const checksum = options?.accent === 'map' ? feed?.values[P.checksum] || '' : '';
  if (checksum === paletteFor) return;
  paletteFor = checksum;
  if (!checksum) { applyPalette(hud, null); return; }
  mapPalette(checksum).then(palette => { if (paletteFor === checksum) applyPalette(hud, palette); });
}

// ------------------------------------------------------------------ formatting
// Rewrites the existing text node in place (no node churn); only the first write creates one.
function setText(element, value) {
  if (element._text === value) return;
  element._text = value;
  const node = element.firstChild;
  if (value && node && node.nodeType === 3 && !node.nextSibling) node.nodeValue = value;
  else element.textContent = value;
}
// data-* writes go through a per-element mirror so an unchanged value never touches the DOM.
function setAttr(element, name, value) {
  const mirror = element._data || (element._data = {});
  if (mirror[name] === value) return;
  mirror[name] = value;
  if (element.dataset[name] !== value) element.dataset[name] = value;
}
const same = (a, b) => a === b || (a !== a && b !== b); // NaN-aware
const DASH = '—';
const NNBSP = '\u202f';
// "0"…"999" and "\u202f000"…"\u202f999": every integer below a thousand, and every thousands
// group, formatted once at load.
const SMALL = new Array(1000);
const GROUP3 = new Array(1000);
for (let n = 0; n < 1000; n++) {
  SMALL[n] = String(n);
  GROUP3[n] = NNBSP + String(n).padStart(3, '0');
}
const intText = n => (n >= 0 && n < 1000 && n === (n | 0) ? SMALL[n] : String(n));
/** Thousands grouped with narrow no-break spaces ("12 345"). */
function group(n) {
  if (n < 1000) return intText(n);
  if (Number.isInteger(n) && n < 1e12) { // n / 1000 floors exactly in this range
    const high = Math.floor(n / 1000);
    return group(high) + GROUP3[n - high * 1000];
  }
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += NNBSP;
    out += s[i];
  }
  return out;
}
const num = value => typeof value === 'number' && Number.isFinite(value);
const ratioText = (max, great) => (!max && !great ? DASH : great ? (max / great).toFixed(2) : '∞');

// Every row share is c/sum to one decimal: "0.0%"…"100.0%", formatted once. The index is the
// exact round-half-up of 1000·c/sum; at an exact tie the double c·100/sum lands on one side of
// it, which toFixed follows, so TIE_UP records that side per tie.
const SHARE = new Array(1001);
for (let n = 0; n <= 1000; n++) SHARE[n] = `${(n / 10).toFixed(1)}%`;
const TIE_UP = new Uint8Array(1000);
for (let k = 0; k < 1000; k++) TIE_UP[k] = ((2 * k + 1) / 20).toFixed(1) === ((k + 1) / 10).toFixed(1) ? 1 : 0;
const SHARE_BLANK = -1;
const SHARE_DIRECT = -2; // outside 0…sum: format directly (never seen in practice)
/** SHARE index for c of sum, in integers only, stepping from `from` (the row's last index). */
function shareIndex(c, sum, from) {
  if (!sum) return SHARE_BLANK;
  if (c < 0 || c > sum) return SHARE_DIRECT;
  // n = floor((2000·c + sum) / (2·sum)); a hit moves it by a few steps at most.
  const twice = 2 * sum;
  const q = c * 2000 + sum;
  let n = from >= 0 && from <= 1000 ? from : 0;
  while (n * twice > q) n--;
  while ((n + 1) * twice <= q) n++;
  if (n * twice === q && !TIE_UP[n - 1]) n--;
  return n;
}

const KEY_TEXT = [];
for (let k = 0; k <= 18; k++) KEY_TEXT[k] = `${k}K`;
function showKeyCount(keyCount) {
  if (keyCount === shownKeyCount) return;
  shownKeyCount = keyCount;
  setText(text.keys, KEY_TEXT[keyCount] ?? `${keyCount}K`);
}
function showPeak(value) {
  if (same(value, shownPeak)) return;
  shownPeak = value;
  setText(text.peak, value === value ? intText(value) : DASH);
}

function hide() {
  setAttr(hud, 'visible', 'false');
  lastPhase = 'hidden';
  cancelDecay();
}

// ------------------------------------------------------------------ render
function render() {
  pending = 0;
  if (!options) return;
  let now = 0; // read only while presses are in the KPS window
  const v = feed?.values;
  const state = v?.[P.state];

  // Connection and no-game states: one small chip in the box, nothing else.
  if (socketStatus !== 'live' || !v || state === undefined) {
    hide();
    setAttr(chip, 'shown', 'true');
    setAttr(chip, 'state', socketStatus === 'live' ? 'idle' : socketStatus);
    setText(text.chip, socketStatus === 'offline' ? 'vosu offline' : socketStatus === 'live' ? 'osu! not running' : 'Connecting to vosu');
    return;
  }
  setAttr(chip, 'shown', 'false');

  const mode = state === STATE_RESULTS && Number.isInteger(v[P.resultsMode])
    ? MODES[v[P.resultsMode]] ?? null
    : activeMode(state, v[P.playMode], v[P.settingsMode]);
  if (mode !== 'mania' || (state !== STATE_PLAY && state !== STATE_RESULTS)) { hide(); return; }

  const keys = v[P.keys];
  const cs = v[P.keyCount];
  const keyCount = state === STATE_PLAY && Array.isArray(keys) && keys.length
    ? keys.length
    : Number.isInteger(cs) && cs > 0 && cs <= 18 ? cs : 4;

  counts.fill(0);
  let phase;
  let total = 0;
  if (state === STATE_PLAY) {
    for (let i = 0; i < 6; i++) {
      const value = v[PLAY_HITS[i]];
      if (num(value)) counts[i] = value;
      total += counts[i];
    }
    phase = 'live';
    const source = v[P.source];
    setText(text.status, source === 'replay' ? 'Replay' : source === 'spectator' || source === 'watching' ? 'Spectating' : source === 'autoplay' ? 'Autoplay' : 'Live');
    showKeyCount(keyCount);
    setText(text.peakLabel, 'Peak');
    const accuracy = num(v[P.accuracy]) ? v[P.accuracy] : NaN;
    if (!same(accuracy, shownAcc)) { shownAcc = accuracy; setText(text.acc, accuracy === accuracy ? accuracy.toFixed(2) : DASH); }
    const combo = num(v[P.combo]) ? v[P.combo] : NaN;
    if (!same(combo, shownCombo)) { shownCombo = combo; setText(text.combo, combo === combo ? group(combo) : DASH); }
    const hasKeys = Array.isArray(keys);
    if (ringSize) now = performance.now();
    if (hasKeys) evict(now);
    const kps = hasKeys ? ringSize : NaN;
    if (!same(kps, shownKps)) { shownKps = kps; setText(text.kps, kps === kps ? intText(kps) : DASH); }
    showPeak(hasKeys ? peak : NaN);
    if (total > 0) {
      held.has = true;
      held.counts.set(counts);
      held.peak = hasKeys ? peak : NaN;
    }
    // Only claim the extension is missing once the attempt is clearly running without it.
    const missingKeys = !hasKeys && total > 16;
    if (note.hidden === missingKeys) note.hidden = !missingKeys;
  } else {
    for (let i = 0; i < 6; i++) {
      const value = v[RESULT_HITS[i]];
      if (num(value)) counts[i] = value;
      total += counts[i];
    }
    if (!total && held.has) { counts.set(held.counts); total = 1; }
    const resultPeak = peakValid && held.has ? held.peak : NaN;
    // Nothing osu!'s ranking screen lacks to add: stay off its screen.
    if (!total || (!options.showRatio && !(options.showKps && num(resultPeak)))) { hide(); return; }
    phase = 'results';
    setText(text.status, 'Result');
    showKeyCount(keyCount);
    setText(text.peakLabel, 'Peak KPS');
    showPeak(num(resultPeak) ? resultPeak : NaN);
    setAttr(hud, 'kps', options.showKps && num(resultPeak) ? 'true' : 'false');
  }
  if (phase === 'live') setAttr(hud, 'kps', options.showKps ? 'true' : 'false');
  setAttr(hud, 'phase', phase);
  setAttr(hud, 'visible', 'true');

  if (counts[0] !== shownMax || counts[1] !== shownGreat) {
    shownMax = counts[0];
    shownGreat = counts[1];
    setText(text.ratio, ratioText(shownMax, shownGreat));
  }
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += counts[i];
  const flashing = phase === 'live' && lastPhase === 'live';
  for (let i = 0; i < 6; i++) {
    const c = counts[i];
    const row = rows[i];
    const countChanged = c !== shownCount[i];
    if (countChanged) { shownCount[i] = c; setText(row.count, group(c)); }
    if (countChanged || sum !== shownSum) {
      const share = shareIndex(c, sum, shownShare[i]);
      if (share === SHARE_DIRECT) { shownShare[i] = share; setText(row.share, `${(c * 100 / sum).toFixed(1)}%`); }
      else if (share !== shownShare[i]) { shownShare[i] = share; setText(row.share, share === SHARE_BLANK ? '' : SHARE[share]); }
    }
    if (flashing && i >= 2 && drawn[i] >= 0 && c > drawn[i]) flash(row);
    if (c !== drawn[i]) { drawn[i] = c; barDirty = true; }
  }
  shownSum = sum;
  setAttr(rows[5].row, 'hot', counts[5] > 0 ? 'true' : 'false');

  if (phase !== drawnPhase) { drawnPhase = phase; barDirty = true; }
  if (barDirty && phase === 'live') drawBar(sum);
  lastPhase = phase;

  // Re-arm the decay wake only when the oldest press (and so its due time) changed.
  if (phase === 'live' && ringSize) {
    if (ring[ringHead] !== decayFor[0]) {
      clearTimeout(decayTimer);
      decayFor[0] = ring[ringHead];
      decayTimer = setTimeout(onDecay, ring[ringHead] + KPS_WINDOW - now + 1);
    }
  } else cancelDecay();
}

// Rows 200…MISS flash on a new judgement. Each keeps one Animation, created idle at load.
const FLASH_KEYFRAMES = [{ opacity: 0.28 }, { opacity: 0 }];
const FLASH_TIMING = { duration: 240, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' };
for (let i = 2; i < 6; i++) {
  rows[i].flash = rows[i].flashTarget.animate(FLASH_KEYFRAMES, FLASH_TIMING);
  rows[i].flash.cancel();
}
function flash(row) {
  row.flash.currentTime = 0;
  row.flash.play();
}

// ------------------------------------------------------------------ bar
const tokens = getComputedStyle(document.documentElement);
const COLORS = ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(name => tokens.getPropertyValue(name).trim());
const TRACK = 'rgb(8 9 10 / .55)';
const TICK = 'rgb(235 232 225 / .34)';
const TICK_MAJOR = 'rgb(235 232 225 / .7)';
let scale = 1; // device px per canvas CSS px (DPR × page unit)
// Device-pixel geometry, recomputed in sizeCanvas only.
let barHeight = 0;
let gap = 1; // between segments; also the tick line width
let tickTop = 0;
const tickX = new Int32Array(11);
const tickH = new Int32Array(11);

function drawBar(total) {
  barDirty = false;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = TRACK;
  ctx.fillRect(0, 0, w, barHeight);
  if (total > 0) {
    const den = 2 * total;
    let x = 0;
    let sum = 0;
    let last = 5;
    while (last > 0 && !counts[last]) last--;
    for (let i = 0; i <= last; i++) {
      if (!counts[i]) continue;
      sum += counts[i];
      // round(sum / total · w) in integers, stepping up from x (ends only grow); an exact .5
      // follows the double rounding the bar has always used.
      const q = 2 * sum * w + total;
      let end = x;
      while ((end + 1) * den <= q) end++;
      if (end * den === q) end = Math.round((sum / total) * w);
      if (end <= x) end = x + 1; // a non-zero share always shows
      if (end > w) end = w;
      const width = end - x - (i < last && end - x > gap + 1 ? gap : 0);
      ctx.fillStyle = COLORS[i];
      ctx.fillRect(x, 0, width, barHeight);
      x = end;
    }
  }
  if (orientation !== 'vertical') return;
  for (let k = 0; k <= 10; k++) {
    ctx.fillStyle = k % 5 === 0 ? TICK_MAJOR : TICK;
    ctx.fillRect(tickX[k], tickTop, gap, tickH[k]);
  }
}

/** Sizes the canvas backing store to its CSS box × DPR × page unit (the cluster is scaled by unit). */
function sizeCanvas(width, height) {
  scale = (devicePixelRatio || 1) * unit;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  barHeight = Math.min(h, Math.round(6 * scale));
  gap = Math.max(1, Math.round(scale));
  tickTop = barHeight + Math.round(3 * scale);
  for (let k = 0; k <= 10; k++) {
    tickX[k] = Math.min(w - gap, Math.round((k / 10) * w));
    tickH[k] = Math.round((k % 5 === 0 ? 5 : 3) * scale);
  }
  barDirty = true;
  drawnPhase = '';
  schedule();
}
new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  sizeCanvas(box.width, box.height);
}).observe(canvas);

// ------------------------------------------------------------------ settings + data
settings({ orientation: 'auto', align: 'auto', backing: 'none', accent: 'map', showRatio: true, showKps: true }, s => {
  options = s;
  setAttr(hud, 'backing', ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none');
  setAttr(hud, 'accent', s.accent === '18-lab' ? '18-lab' : 'map');
  setAttr(hud, 'ratio', String(s.showRatio));
  setAttr(hud, 'kps', String(s.showKps));
  loadPalette();
  layout();
});
addEventListener('resize', layout);

feed = subscribe([
  P.state, P.playMode, P.settingsMode, P.resultsMode, P.source,
  ...PLAY_HITS, P.accuracy, P.combo, P.keys,
  ...RESULT_HITS, P.keyCount, P.checksum,
], onFrame, { onStatus });

// Copyright (c) 2026 18-LAB. MIT.
// osu!mania judgement counter floating beside the stage: MAX…MISS counts, proportional bar,
// MAX:300 ratio, accuracy, combo and key presses per second from /keys/all count deltas.
// Results keep only what osu!'s ranking screen lacks (the ratio and the attempt's peak KPS).
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette, MODES } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const EDGE = 48; // px between the cluster and the screen edge of its band
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
  client: '/client',
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
const stage = $('stage');
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

fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------------ state
let socketStatus = 'connecting';
let values = null;
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

// Last attempt, held so the results screen can show its ratio and peak.
const held = { has: false, counts: new Int32Array(6), peak: NaN };

const counts = new Int32Array(6);
const drawn = new Int32Array(6).fill(-1);
let drawnPhase = '';
let lastPhase = '';
let barDirty = true;
let pending = 0;

// Placement inputs; the band is recomputed only when one of them changes.
let placedFor = '';
let paletteFor = '';

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
  values = next;
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

// ------------------------------------------------------------------ placement + tint
/** Puts the cluster in osu!'s free band on the chosen side of the mania stage, at the band's screen edge. */
function place(keyCount, client) {
  const key = `${options.side}|${keyCount}|${client}|${options.x}|${options.y}|${options.scale}`;
  if (key === placedFor) return;
  placedFor = key;
  const layout = osuLayout('mania', { keys: keyCount, client: client === 'lazer' ? 'lazer' : 'stable' });
  const left = options.side === 'left';
  const band = layout.free.find(r => (left ? r.x === 0 : r.x > 0)) || { y: 0, h: HEIGHT };
  const scale = Math.min(2, Math.max(0.5, options.scale || 1));
  stage.style.setProperty('--edge', `${EDGE}px`);
  stage.style.setProperty('--cy', `${Math.round(band.y + band.h / 2)}px`);
  stage.style.setProperty('--nx', `${Math.round(options.x)}px`);
  stage.style.setProperty('--ny', `${Math.round(options.y)}px`);
  stage.style.setProperty('--scale', String(scale));
  setAttr(hud, 'side', left ? 'left' : 'right');
  setAttr(chip, 'side', left ? 'left' : 'right');
}

function loadPalette() {
  const checksum = options?.accent === 'map' ? values?.[P.checksum] || '' : '';
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
function setAttr(element, name, value) {
  if (element.dataset[name] !== value) element.dataset[name] = value;
}
const NNBSP = '\u202f';
function group(n) {
  if (n < 1000) return String(n);
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += NNBSP;
    out += s[i];
  }
  return out;
}
const num = value => typeof value === 'number' && Number.isFinite(value);
const ratioText = (max, great) => (!max && !great ? '—' : great ? (max / great).toFixed(2) : '∞');

function hide() {
  setAttr(hud, 'visible', 'false');
  lastPhase = 'hidden';
  clearTimeout(decayTimer);
}

// ------------------------------------------------------------------ render
function render() {
  pending = 0;
  if (!options) return;
  const now = performance.now();
  const v = values;
  const state = v?.[P.state];

  // Connection and no-game states: one small chip in the zone, nothing else.
  if (socketStatus !== 'live' || !v || state === undefined) {
    hide();
    place(4, 'stable');
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
  place(keyCount, v[P.client]);

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
    setText(text.keys, `${keyCount}K`);
    setText(text.peakLabel, 'Peak');
    const accuracy = v[P.accuracy];
    const combo = v[P.combo];
    setText(text.acc, num(accuracy) ? accuracy.toFixed(2) : '—');
    setText(text.combo, num(combo) ? group(combo) : '—');
    const hasKeys = Array.isArray(keys);
    if (hasKeys) evict(now);
    setText(text.kps, hasKeys ? String(ringSize) : '—');
    setText(text.peak, hasKeys ? String(peak) : '—');
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
    const shownPeak = peakValid && held.has ? held.peak : NaN;
    // Nothing osu!'s ranking screen lacks to add: stay off its screen.
    if (!total || (!options.showRatio && !(options.showKps && num(shownPeak)))) { hide(); return; }
    phase = 'results';
    setText(text.status, 'Result');
    setText(text.keys, `${keyCount}K`);
    setText(text.peakLabel, 'Peak KPS');
    setText(text.peak, num(shownPeak) ? String(shownPeak) : '—');
    setAttr(hud, 'kps', String(options.showKps && num(shownPeak)));
  }
  if (phase === 'live') setAttr(hud, 'kps', String(options.showKps));
  setAttr(hud, 'phase', phase);
  setAttr(hud, 'visible', 'true');

  setText(text.ratio, ratioText(counts[0], counts[1]));
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += counts[i];
  const flashing = phase === 'live' && lastPhase === 'live';
  for (let i = 0; i < 6; i++) {
    const c = counts[i];
    const row = rows[i];
    setText(row.count, group(c));
    setText(row.share, sum ? `${(c * 100 / sum).toFixed(1)}%` : '');
    if (flashing && i >= 2 && drawn[i] >= 0 && c > drawn[i]) flash(row);
    if (c !== drawn[i]) { drawn[i] = c; barDirty = true; }
  }
  setAttr(rows[5].row, 'hot', counts[5] > 0 ? 'true' : 'false');

  if (phase !== drawnPhase) { drawnPhase = phase; barDirty = true; }
  if (barDirty && phase === 'live') drawBar(sum);
  lastPhase = phase;

  // Live KPS decays without new frames: wake once when the oldest press leaves the window.
  clearTimeout(decayTimer);
  if (phase === 'live' && ringSize) decayTimer = setTimeout(schedule, ring[ringHead] + KPS_WINDOW - now + 1);
}

function flash(row) {
  if (!row.flash) {
    row.flash = row.flashTarget.animate([{ opacity: 0.28 }, { opacity: 0 }], { duration: 240, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' });
  } else {
    row.flash.currentTime = 0;
    row.flash.play();
  }
}

// ------------------------------------------------------------------ bar
const tokens = getComputedStyle(document.documentElement);
const COLORS = ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(name => tokens.getPropertyValue(name).trim());
const TRACK = 'rgb(8 9 10 / .55)';
const TICK = 'rgb(235 232 225 / .34)';
const TICK_MAJOR = 'rgb(235 232 225 / .7)';
let scale = 1;

function drawBar(total) {
  barDirty = false;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const barHeight = Math.round(6 * scale);
  ctx.fillStyle = TRACK;
  ctx.fillRect(0, 0, w, barHeight);
  if (total > 0) {
    const gap = Math.max(1, Math.round(scale));
    let x = 0;
    let sum = 0;
    let last = 5;
    while (last > 0 && !counts[last]) last--;
    for (let i = 0; i <= last; i++) {
      if (!counts[i]) continue;
      sum += counts[i];
      let end = Math.round((sum / total) * w);
      if (end <= x) end = x + 1; // a non-zero share always shows
      if (end > w) end = w;
      const width = end - x - (i < last && end - x > gap + 1 ? gap : 0);
      ctx.fillStyle = COLORS[i];
      ctx.fillRect(x, 0, width, barHeight);
      x = end;
    }
  }
  const line = Math.max(1, Math.round(scale));
  const top = barHeight + Math.round(3 * scale);
  for (let k = 0; k <= 10; k++) {
    const major = k % 5 === 0;
    ctx.fillStyle = major ? TICK_MAJOR : TICK;
    const x = Math.min(w - line, Math.round((k / 10) * w));
    ctx.fillRect(x, top, line, Math.round((major ? 5 : 3) * scale));
  }
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  scale = devicePixelRatio || 1;
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  barDirty = true;
  drawnPhase = '';
  schedule();
}).observe(canvas);

// ------------------------------------------------------------------ settings + data
settings({ side: 'right', x: 0, y: 0, scale: 1, backing: 'none', accent: 'map', showRatio: true, showKps: true, showBrand: true }, s => {
  options = s;
  options.side = s.side === 'left' ? 'left' : 'right';
  setAttr(hud, 'backing', ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none');
  setAttr(hud, 'accent', s.accent === '18-lab' ? '18-lab' : 'map');
  setAttr(hud, 'ratio', String(s.showRatio));
  setAttr(hud, 'kps', String(s.showKps));
  setAttr(hud, 'brand', String(s.showBrand));
  placedFor = '';
  loadPalette();
  schedule();
});

subscribe([
  P.state, P.client, P.playMode, P.settingsMode, P.resultsMode, P.source,
  ...PLAY_HITS, P.accuracy, P.combo, P.keys,
  ...RESULT_HITS, P.keyCount, P.checksum,
], onFrame, { onStatus });

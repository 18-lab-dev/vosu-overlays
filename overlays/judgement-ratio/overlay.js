// Copyright (c) 2026 18-LAB. MIT.
// osu!mania judgement counter: MAX…MISS counts, proportional bar, MAX:300 ratio, accuracy,
// combo and key presses per second from /keys/all count deltas.
import { subscribe, settings, fit, activeMode, MODES } from './vosu-overlay.js';

const WIDTH = 1100;
const HEIGHT = 380;
const STATE_PLAY = 2;
const STATE_RESULTS = 7;
const STATE_SONG_SELECT = 5;
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
  maxCombo: '/play/combo/max',
  keys: '/keys/all',
  resultsAccuracy: '/resultsScreen/accuracy',
  resultsCombo: '/resultsScreen/maxCombo',
  keyCount: '/beatmap/stats/cs/converted',
};

const $ = id => document.getElementById(id);
const panel = $('panel');
const chip = $('chip');
const canvas = $('bar');
const ctx = canvas.getContext('2d', { alpha: true });
const rows = [...panel.querySelectorAll('.row')].map(row => ({
  row,
  count: row.querySelector('.count'),
  share: row.querySelector('.share'),
  flash: null,
  flashTarget: row.querySelector('.flash'),
}));
const text = {
  status: $('status'), keys: $('keys'), ratio: $('ratio'), acc: $('acc'), combo: $('combo'),
  comboLabel: panel.querySelector('.stat.combo .label'), kps: $('kps'), peak: $('peak'), chip: $('chip-text'),
};
const note = $('note');

fit($('stage'), WIDTH, HEIGHT);

// ------------------------------------------------------------------ state
let socketStatus = 'connecting';
let values = null;
let previousState;
let peakValid = false; // results reached straight from our own play → its peak KPS applies

// Key presses: wall-clock timestamps of each counted down-edge in a ring buffer.
const RING = 1024;
const ring = new Float64Array(RING);
let ringHead = 0;
let ringSize = 0;
let keyBase = -1;
let peak = 0;
let decayTimer = 0;

// Last finished/aborted attempt, held for results and song select.
const held = { has: false, counts: new Int32Array(6), accuracy: NaN, combo: NaN, peak: NaN };

const counts = new Int32Array(6);
const drawn = new Int32Array(6).fill(-1);
let drawnPhase = '';
let lastPhase = '';
let barDirty = true;
let pending = 0;

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

// ------------------------------------------------------------------ render
function render() {
  pending = 0;
  const now = performance.now();
  if (socketStatus !== 'live' || !values) {
    setAttr(panel, 'visible', 'false');
    setAttr(chip, 'shown', 'true');
    setAttr(chip, 'state', socketStatus);
    setText(text.chip, socketStatus === 'offline' ? 'vosu offline' : 'Connecting to vosu');
    return;
  }
  setAttr(chip, 'shown', 'false');

  const v = values;
  const state = v[P.state];
  const mode = state === STATE_RESULTS && Number.isInteger(v[P.resultsMode])
    ? MODES[v[P.resultsMode]] ?? null
    : activeMode(state, v[P.playMode], v[P.settingsMode]);
  if (mode && mode !== 'mania') {
    setAttr(panel, 'visible', 'false');
    lastPhase = 'hidden';
    return;
  }
  setAttr(panel, 'visible', 'true');

  let phase = 'none';
  let status = 'Waiting for osu!';
  let accuracy = NaN;
  let combo = NaN;
  let comboLabel = 'Combo';
  let kps = NaN;
  let shownPeak = NaN;
  let keyLabel = '';
  let missingKeys = false;
  counts.fill(0);

  if (state === STATE_PLAY && mode) {
    let present = false;
    for (let i = 0; i < 6; i++) {
      const value = v[PLAY_HITS[i]];
      if (num(value)) { counts[i] = value; present = true; }
    }
    phase = present ? 'live' : 'none';
    const source = v[P.source];
    status = source === 'replay' ? 'Replay' : source === 'spectator' || source === 'watching' ? 'Spectating' : source === 'autoplay' ? 'Autoplay' : 'Live';
    accuracy = v[P.accuracy];
    combo = v[P.combo];
    const keys = v[P.keys];
    if (Array.isArray(keys)) {
      evict(now);
      kps = ringSize;
      shownPeak = peak;
      if (keys.length) keyLabel = `${keys.length}K`;
    }
    let total = 0;
    for (let i = 0; i < 6; i++) total += counts[i];
    if (total > 0) {
      held.has = true;
      held.counts.set(counts);
      held.accuracy = accuracy;
      held.combo = v[P.maxCombo];
      held.peak = Array.isArray(keys) ? peak : NaN;
    }
    // Only claim the extension is missing once the attempt is clearly running without it.
    missingKeys = !Array.isArray(keys) && total > 16;
  } else if (state === STATE_RESULTS && mode) {
    let total = 0;
    for (let i = 0; i < 6; i++) {
      const value = v[RESULT_HITS[i]];
      if (num(value)) { counts[i] = value; total += value; }
    }
    if (total > 0) {
      phase = 'results';
      accuracy = v[P.resultsAccuracy];
      combo = v[P.resultsCombo];
      shownPeak = peakValid ? held.peak : NaN;
      held.has = true;
      held.counts.set(counts);
      held.accuracy = accuracy;
      held.combo = combo;
      held.peak = shownPeak;
    } else if (held.has) {
      phase = 'results';
      counts.set(held.counts);
      accuracy = held.accuracy;
      combo = held.combo;
      shownPeak = held.peak;
    }
    status = 'Result';
    comboLabel = 'Max combo';
  } else if (state !== undefined && mode) {
    if (held.has) {
      phase = 'held';
      counts.set(held.counts);
      accuracy = held.accuracy;
      combo = held.combo;
      shownPeak = held.peak;
      comboLabel = 'Max combo';
      status = 'Last play';
    } else {
      status = state === STATE_SONG_SELECT ? 'Song select' : 'Idle';
    }
  }
  if (note.hidden === missingKeys) note.hidden = !missingKeys;
  if (!keyLabel && mode) {
    const keyCount = v[P.keyCount];
    if (Number.isInteger(keyCount) && keyCount > 0 && keyCount <= 18) keyLabel = `${keyCount}K`;
  }

  setAttr(panel, 'phase', phase);
  setText(text.status, status);
  setText(text.keys, keyLabel);
  setText(text.comboLabel, comboLabel);

  let total = 0;
  for (let i = 0; i < 6; i++) total += counts[i];
  const empty = phase === 'none';
  const flashing = phase === 'live' && lastPhase === 'live';
  for (let i = 0; i < 6; i++) {
    const c = counts[i];
    const row = rows[i];
    setText(row.count, empty ? '—' : group(c));
    setText(row.share, empty || !total ? '' : `${(c * 100 / total).toFixed(1)}%`);
    if (flashing && i >= 2 && drawn[i] >= 0 && c > drawn[i]) flash(row);
    if (c !== drawn[i]) { drawn[i] = c; barDirty = true; }
  }
  setAttr(rows[5].row, 'hot', !empty && counts[5] > 0 ? 'true' : 'false');

  const max = counts[0];
  const great = counts[1];
  setText(text.ratio, empty || (!max && !great) ? '—' : great ? (max / great).toFixed(2) : '∞');
  setText(text.acc, !empty && num(accuracy) ? accuracy.toFixed(2) : '—');
  setText(text.combo, !empty && num(combo) ? group(combo) : '—');
  setText(text.kps, num(kps) ? String(kps) : '—');
  setText(text.peak, !empty && num(shownPeak) ? String(shownPeak) : '—');

  if (phase !== drawnPhase) { drawnPhase = phase; barDirty = true; }
  if (barDirty) drawBar(total, phase);
  lastPhase = phase;

  // Live KPS decays without new frames: wake once when the oldest press leaves the window.
  clearTimeout(decayTimer);
  if (phase === 'live' && ringSize) decayTimer = setTimeout(schedule, ring[ringHead] + KPS_WINDOW - now + 1);
}

function flash(row) {
  if (!row.flash) {
    row.flash = row.flashTarget.animate([{ opacity: 0.22 }, { opacity: 0 }], { duration: 240, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' });
  } else {
    row.flash.currentTime = 0;
    row.flash.play();
  }
}

// ------------------------------------------------------------------ bar
const tokens = getComputedStyle(document.documentElement);
const COLORS = ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(name => tokens.getPropertyValue(name).trim());
const TRACK = 'rgb(235 232 225 / .08)';
const TICK = tokens.getPropertyValue('--rule-strong').trim() || '#3b3f45';
const TICK_MID = tokens.getPropertyValue('--muted').trim() || '#7e8288';
let scale = 1;
let withTicks = true;

function drawBar(total, phase) {
  barDirty = false;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const barHeight = withTicks ? Math.round(6 * scale) : h;
  ctx.globalAlpha = phase === 'live' || phase === 'results' ? 1 : 0.6;
  ctx.fillStyle = TRACK;
  ctx.fillRect(0, 0, w, barHeight);
  if (total > 0 && phase !== 'none') {
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
  if (withTicks) {
    const line = Math.max(1, Math.round(scale));
    const top = barHeight + Math.round(2 * scale);
    for (let k = 0; k <= 10; k++) {
      const major = k % 5 === 0;
      ctx.fillStyle = major ? TICK_MID : TICK;
      const x = Math.min(w - line, Math.round((k / 10) * w));
      ctx.fillRect(x, top, line, Math.round((major ? 4 : 2) * scale));
    }
  }
  ctx.globalAlpha = 1;
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  scale = devicePixelRatio || 1;
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  withTicks = panel.dataset.layout !== 'horizontal';
  barDirty = true;
  schedule();
}).observe(canvas);

// ------------------------------------------------------------------ settings + data
settings({ layout: 'vertical', anchor: 'top-left', showRatio: true, showKps: true, showBrand: true }, s => {
  const layout = s.layout === 'horizontal' ? 'horizontal' : 'vertical';
  const anchor = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(s.anchor) ? s.anchor : 'top-left';
  setAttr(panel, 'layout', layout);
  setAttr(panel, 'anchor', anchor);
  setAttr(chip, 'anchor', anchor);
  setAttr(panel, 'ratio', String(s.showRatio));
  setAttr(panel, 'kps', String(s.showKps));
  setAttr(panel, 'brand', String(s.showBrand));
  withTicks = layout !== 'horizontal';
  barDirty = true;
  schedule();
});

subscribe([
  P.state, P.playMode, P.settingsMode, P.resultsMode, P.source,
  ...PLAY_HITS, P.accuracy, P.combo, P.maxCombo, P.keys,
  ...RESULT_HITS, P.resultsAccuracy, P.resultsCombo, P.keyCount,
], onFrame, { onStatus });

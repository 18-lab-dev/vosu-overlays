// Copyright (c) 2026 18-LAB. MIT.
// Key overlay: one scrolling tape lane per logical key (vosu `keys.all`), key caps with counts,
// live and peak keys per second. Bars are placed in gameplay time from pressedAt/releasedAt.
// It floats in the empty regions of osu!'s own layout (osuLayout) for the ruleset being played.
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const SW = 1920;
const SH = 1080;
const GAP = 4;          // between lanes
const RULER = 10;       // time ruler beside the tape
const INSET = 3;        // bar inset inside its lane
const READ_H = 36;      // readout row
const ROW_GAP = 4;      // readout ↔ tape, tape ↔ caps
const CAP_H = 44;       // caps (up)
const CAP_W = 64;       // caps (right)
const COL_GAP = 8;      // caps ↔ tape (right)
const MARGIN = 24;      // distance kept from screen edges and from osu!'s own elements
const RING = 256;       // remembered presses per lane
const KPS_RING = 2048;  // remembered press times across lanes
const MAX_STEP = 8;     // most presses one key can gain between two samples before it counts as missed data
const EXTRAPOLATE = 100; // ms of wall time the clock may run past its last sample
const SMOKE = '#b8b5ad';
const BED = 'rgba(11,12,13,0.5)';

const DEFAULTS = {
  zone: 'auto', direction: 'auto', offsetX: 0, offsetY: 0, scale: 1, length: 360,
  speed: 600, laneWidth: 40, showCounts: true, showKps: true, smokeLane: false,
  accent: 'map', colorOsu: '#ff963f', colorDon: '#ef6a4f', colorKat: '#7fa6cf', colorFruits: '#6fbf8e', colorMania: '#ebe8e1',
  columnStart: 136, columnWidth: 30, hitPosition: 402, backing: 'none', showBrand: true,
};

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', client: '/client',
  keys: '/keys/all', live: '/beatmap/time/live', rate: '/beatmap/time/rate', checksum: '/beatmap/checksum',
  modsRate: '/play/mods/rate', paused: '/game/paused', cs: '/beatmap/stats/cs/converted',
  osuK1: '/settings/keybinds/osu/k1', osuK2: '/settings/keybinds/osu/k2', osuSmoke: '/settings/keybinds/osu/smokeKey',
  taikoOL: '/settings/keybinds/taiko/outerLeft', taikoIL: '/settings/keybinds/taiko/innerLeft',
  taikoIR: '/settings/keybinds/taiko/innerRight', taikoOR: '/settings/keybinds/taiko/outerRight',
  catchK1: '/settings/keybinds/fruits/k1', catchK2: '/settings/keybinds/fruits/k2', catchDash: '/settings/keybinds/fruits/Dash',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const block = $('block');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const capsEl = $('caps');
const el = {
  read: $('read'), brand: $('brand'), kps: $('kps'), peak: $('peak'), note: $('note'),
  chip: $('chip'), chipText: $('chip-text'),
  summary: $('summary'), sumBrand: $('sum-brand'), sumAvg: $('sum-avg'), sumPeak: $('sum-peak'), sumKeys: $('sum-keys'),
};
fit(stage, SW, SH);

let cfg = { ...DEFAULTS };
let values = null;
let status = 'connecting';
let palette = null;     // map tonal-spot roles, or null

// ------------------------------------------------------------------ text helpers
const shown = new WeakMap();
function text(node, value) {
  if (shown.get(node) === value) return;
  shown.set(node, value);
  node.textContent = value;
}
function attr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

const KEY_NAMES = {
  Left: '←', Right: '→', Up: '↑', Down: '↓', Space: 'SPACE', Enter: 'ENTER', Tab: 'TAB', Back: 'BKSP', Escape: 'ESC',
  CapsLock: 'CAPS', LeftShift: 'LSHIFT', RightShift: 'RSHIFT', LeftControl: 'LCTRL', RightControl: 'RCTRL',
  LeftAlt: 'LALT', RightAlt: 'RALT', PageUp: 'PGUP', PageDown: 'PGDN', Insert: 'INS', Delete: 'DEL', Home: 'HOME', End: 'END',
};
/** A stable keybind name as a short cap label, or null when unbound/unknown. */
function keyLabel(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === 'None') return null;
  if (KEY_NAMES[trimmed]) return KEY_NAMES[trimmed];
  let match = /^D(\d)$/.exec(trimmed);
  if (match) return match[1];
  match = /^NumPad(\d)$/.exec(trimmed);
  if (match) return `N${match[1]}`;
  return trimmed.slice(0, 5).toUpperCase();
}

function formatCount(count, room) {
  const plain = String(count);
  if (plain.length * 7.3 <= room) return plain;
  if (count < 1e6) return `${(count / 1000).toFixed(count < 1e4 ? 1 : 0)}k`;
  return `${(count / 1e6).toFixed(1)}m`;
}

// ------------------------------------------------------------------ key tracks (one per keys.all entry)
function makeTrack() {
  return {
    count: 0, pressed: false, ever: false,
    starts: new Float64Array(RING), ends: new Float64Array(RING), head: 0, size: 0, open: false,
  };
}
const tracks = [];
function track(i) { return tracks[i] ??= makeTrack(); }

const kpsTimes = new Float64Array(KPS_RING);
let kpsHead = 0;
let kpsSize = 0;
let peakKps = 0;
let totalPresses = 0;
let firstPress = NaN;
let lastPress = NaN;
let baselined = false;  // first keys frame of this attempt seen
let observedEntry = false; // we saw the transition into play (counts start from zero)
let results = null;     // { avg, peak } held at the results screen

function resetAttempt() {
  for (const t of tracks) {
    if (!t) continue;
    t.count = 0; t.pressed = false; t.ever = false; t.head = 0; t.size = 0; t.open = false;
  }
  kpsHead = 0; kpsSize = 0; peakKps = 0; totalPresses = 0; firstPress = NaN; lastPress = NaN;
  baselined = false;
  results = null;
}

function pushBar(t, start, end) {
  const index = t.head;
  t.starts[index] = start;
  t.ends[index] = end;
  t.head = (index + 1) % RING;
  if (t.size < RING) t.size++;
  t.open = Number.isNaN(end);
}

function pushPress(time, rate) {
  kpsTimes[kpsHead] = time;
  kpsHead = (kpsHead + 1) % KPS_RING;
  if (kpsSize < KPS_RING) kpsSize++;
  totalPresses++;
  if (Number.isNaN(firstPress) || time < firstPress) firstPress = time;
  if (Number.isNaN(lastPress) || time > lastPress) lastPress = time;
  const n = countWindow(time, 1000 * rate);
  if (n > peakKps) peakKps = n;
}

/** Presses in (end - span, end]. Times are nearly ordered; a small tolerance absorbs cross-lane jitter. */
function countWindow(end, span) {
  const from = end - span;
  let n = 0;
  for (let k = 0, i = kpsHead; k < kpsSize; k++) {
    i = i === 0 ? KPS_RING - 1 : i - 1;
    const t = kpsTimes[i];
    if (t <= from - 250) break;
    if (t > from && t <= end) n++;
  }
  return n;
}

function ingestKeys(list, now, rate) {
  if (!Array.isArray(list)) return;
  if (!baselined) {
    baselined = true;
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      const t = track(i);
      const count = Number.isFinite(key?.count) ? key.count : 0;
      if (count > 0) t.ever = true;
      if (observedEntry) continue; // counts started at zero in front of us: the loop below draws them
      // Attached mid-attempt: earlier presses happened before we watched. Keep the count and show
      // only the latest press vosu still reports (it scrolls off if it is old); none enter KPS.
      t.count = count;
      const at = Number.isFinite(key?.pressedAt) ? key.pressedAt : null;
      if (count > 0 && at !== null && at <= now + 50) {
        const released = Number.isFinite(key.releasedAt) && key.releasedAt >= at ? key.releasedAt : at + 16;
        pushBar(t, at, key.isPressed === true ? NaN : released);
      }
    }
  }
  for (let i = 0; i < list.length; i++) {
    const key = list[i];
    if (!key || typeof key !== 'object') continue;
    const t = track(i);
    const count = Number.isFinite(key.count) ? key.count : 0;
    const pressedAt = Number.isFinite(key.pressedAt) ? key.pressedAt : null;
    const releasedAt = Number.isFinite(key.releasedAt) ? key.releasedAt : null;
    const pressed = key.isPressed === true;
    if (count < t.count) {
      // Retry/rewind restarted the attempt.
      resetAttempt();
      baselined = true;
      observedEntry = true;
      return ingestKeys(list, now, rate);
    }
    const delta = count - t.count;
    if (delta > 0) {
      t.ever = true;
      // More presses than can happen between two samples means missed data (stall, mode swap):
      // keep the count and the latest bar, but keep them out of KPS so no false peak appears.
      const burst = delta > MAX_STEP;
      const at = pressedAt ?? now;
      if (t.open) {
        const last = (t.head + RING - 1) % RING;
        t.ends[last] = releasedAt !== null && releasedAt <= at && releasedAt >= t.starts[last] ? releasedAt : at;
        t.open = false;
      }
      const end = pressed ? NaN : releasedAt !== null && releasedAt >= at ? releasedAt : at + 16;
      pushBar(t, at, end);
      // A count jump can include complete taps between samples; they count, but have no timestamps to draw.
      if (!burst) for (let k = 0; k < delta; k++) pushPress(at, rate);
      t.count = count;
    } else if (t.open && !pressed) {
      const last = (t.head + RING - 1) % RING;
      t.ends[last] = releasedAt !== null && releasedAt >= t.starts[last] ? releasedAt : Math.max(now, t.starts[last]);
      t.open = false;
    }
    t.pressed = pressed;
  }
}

function closeOpen() {
  for (const t of tracks) {
    if (!t || !t.open) continue;
    const last = (t.head + RING - 1) % RING;
    t.ends[last] = Math.max(t.starts[last], clockAt(performance.now()));
    t.open = false;
  }
}

// ------------------------------------------------------------------ gameplay clock
// Map clock samples arrive every few ms during play with delivery jitter; follow them smoothly and
// stop advancing when they stop (pause, freeze, stalled reader).
const clock = { base: 0, at: 0, prev: NaN, running: false, valid: false, rate: 1, paused: false };
function clockAt(t) {
  if (!clock.valid) return 0;
  if (!clock.running || clock.paused) return clock.base;
  return clock.base + Math.min(Math.max(0, t - clock.at), EXTRAPOLATE) * clock.rate;
}
function clockSample(live, t) {
  if (!clock.valid) {
    clock.valid = true; clock.base = live; clock.at = t; clock.prev = live; clock.running = false;
    return;
  }
  const predicted = clockAt(t);
  const error = live - predicted;
  clock.running = live > clock.prev;
  clock.base = !clock.running || Math.abs(error) > 60 ? live : predicted + error * 0.2;
  clock.at = t;
  clock.prev = live;
}

// ------------------------------------------------------------------ lanes
let lanes = [];         // { src, label, color, cap, lit, labelEl, countEl, room, shownPressed, shownCount }
let geometry = null;
let signature = '';
let currentMode = null;
let swapTimer = 0;
let view = 'none';      // 'play' | 'results' | 'idle' | 'nogame' | 'none'

/** Bar colour of a ruleset: the map's tonal accent when enabled (taiko keeps its don/kat meaning). */
function rulesetColor(mode) {
  if (cfg.accent === 'map' && palette?.accent && mode !== 'taiko') return palette.accent;
  return mode === 'osu' ? cfg.colorOsu : mode === 'fruits' ? cfg.colorFruits : cfg.colorMania;
}

function keyCount() {
  const list = values?.[P.keys];
  if (Array.isArray(list) && view === 'play') return list.length;
  const n = Math.round(Number(values?.[P.cs]));
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 4;
}

function laneSpec(mode) {
  const v = values;
  const bind = pointer => keyLabel(v[pointer]);
  if (mode === 'osu') {
    const c = rulesetColor('osu');
    const spec = [{ src: 0, label: bind(P.osuK1) ?? 'K1', color: c }, { src: 1, label: bind(P.osuK2) ?? 'K2', color: c }];
    if (cfg.smokeLane) spec.push({ src: 2, label: bind(P.osuSmoke) ?? 'SMK', color: SMOKE });
    return spec;
  }
  if (mode === 'taiko') {
    return [
      { src: 0, label: bind(P.taikoOL) ?? 'K', color: cfg.colorKat },
      { src: 1, label: bind(P.taikoIL) ?? 'D', color: cfg.colorDon },
      { src: 2, label: bind(P.taikoIR) ?? 'D', color: cfg.colorDon },
      { src: 3, label: bind(P.taikoOR) ?? 'K', color: cfg.colorKat },
    ];
  }
  if (mode === 'fruits') {
    // osu!stable never reports catch left/right, so those lanes only appear once they carry presses.
    const c = rulesetColor('fruits');
    const moves = v[P.client] === 'lazer' || tracks[0]?.ever || tracks[1]?.ever;
    const dash = { src: 2, label: bind(P.catchDash) ?? 'DASH', color: c };
    return moves
      ? [{ src: 0, label: bind(P.catchK1) ?? '←', color: c }, { src: 1, label: bind(P.catchK2) ?? '→', color: c }, dash]
      : [dash];
  }
  const c = rulesetColor('mania');
  const spec = [];
  for (let i = 0, n = keyCount(); i < n; i++) spec.push({ src: i, label: String(i + 1), color: c });
  return spec;
}

// ------------------------------------------------------------------ placement
function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

/**
 * Sizes the block and places it in a free region of osu!'s layout. Default zones: osu!/catch the
 * band left of the playfield, under the leaderboard (osu! draws its own key counter on the right
 * edge); taiko the empty area under the lane, beneath the drum; mania beside the stage, with the
 * caps on the hit-position line so presses leave where notes are judged.
 */
function computeGeometry(mode, n) {
  const layout = osuLayout(mode, {
    keys: n, columnWidth: cfg.columnWidth, columnStart: cfg.columnStart, client: values?.[P.client] === 'lazer' ? 'lazer' : 'stable',
  });
  const { busy, hud, unit } = layout;
  const zone = cfg.zone === 'auto'
    ? mode === 'taiko' ? 'below' : mode === 'mania' ? 'stage' : 'left'
    : cfg.zone;
  const up = cfg.direction === 'auto' ? mode === 'mania' : cfg.direction === 'up';
  const s = clamp(Number(cfg.scale) || 1, 0.5, 2);
  const tape = Math.round(clamp(cfg.length, 120, 900));
  const pad = cfg.backing === 'panel' ? 8 + 1 : 0; // padding + border
  let w = Math.round(clamp(cfg.laneWidth, 12, 96));

  // Room the lanes may take. The stage zone keeps to the left of the stage, where stable draws no
  // HUD (its mania HP bar, and many skins' panels, sit to the right); lanes shrink to fit.
  const stageLeft = busy.x - 2 * MARGIN;
  const stageRight = SW - (busy.x + busy.w) - 2 * MARGIN;
  const leftSide = stageLeft >= 140 || stageLeft >= stageRight;
  const across = (up && zone === 'stage' ? (leftSide ? stageLeft : stageRight) : 520) / s - RULER - pad * 2;
  w = Math.max(12, Math.min(w, Math.floor((across - (n - 1) * GAP) / n)));
  const lanesSpan = n * w + (n - 1) * GAP;
  const cssW = up ? RULER + lanesSpan : tape;
  const cssH = up ? tape : lanesSpan + RULER;
  const width = Math.round(((up ? cssW : CAP_W + COL_GAP + tape) + pad * 2) * s);
  const height = Math.round(((up ? READ_H + ROW_GAP + tape + ROW_GAP + CAP_H : READ_H + ROW_GAP + cssH)) * s + pad * 2 * s);

  let x;
  let y;
  if (zone === 'stage') {
    // Beside the stage, right-aligned against its left edge (its right edge only when the left is too narrow).
    x = leftSide ? busy.x - MARGIN - width : busy.x + busy.w + MARGIN;
    const capsTop = cfg.hitPosition * unit; // skin HitPosition, 480-line canvas
    y = up ? capsTop - (READ_H + ROW_GAP + tape + ROW_GAP + pad) * s : capsTop - height;
  } else if (zone === 'right') {
    x = SW - MARGIN - width;
    y = SH - MARGIN - height;
  } else if (zone === 'below') {
    x = mode === 'taiko' ? MARGIN : busy.x + (busy.w - width) / 2;
    y = busy.y + busy.h + MARGIN;
  } else {
    // left band, bottom-aligned above the combo counter
    x = MARGIN;
    y = (hud.combo ? hud.combo.y : SH) - MARGIN - height;
  }
  x = Math.round(clamp(x + cfg.offsetX, 0, SW - width));
  y = Math.round(clamp(y + cfg.offsetY, 0, SH - height));

  const pos = new Float64Array(n);
  for (let i = 0; i < n; i++) pos[i] = (up ? RULER : 0) + i * (w + GAP);
  return { up, n, w, tape, cssW, cssH, pos, x, y, s, width, height, dpr: 0 };
}

function buildLanes(mode) {
  const spec = laneSpec(mode);
  geometry = computeGeometry(mode, spec.length);
  const g = geometry;
  attr(block, 'data-dir', g.up ? 'up' : 'right');
  attr(block, 'data-kps', cfg.showKps ? '1' : '0');
  attr(block, 'data-brand', cfg.showBrand ? '1' : '0');
  attr(block, 'data-counts', cfg.showCounts ? '1' : '0');
  attr(block, 'data-backing', ['none', 'scrim', 'panel'].includes(cfg.backing) ? cfg.backing : 'none');
  block.style.setProperty('--w', `${g.w}px`);
  block.style.transform = `translate(${g.x}px, ${g.y}px) scale(${g.s})`;
  el.read.style.width = g.up ? `${g.cssW}px` : '';
  canvas.style.width = `${g.cssW}px`;
  canvas.style.height = `${g.cssH}px`;
  el.brand.hidden = !cfg.showBrand;
  el.chip.style.transform = `translate(${g.x}px, ${g.y + g.height - 24}px)`;

  const frag = document.createDocumentFragment();
  lanes = spec.map(s => {
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.style.setProperty('--k', s.color);
    const labelEl = document.createElement('b');
    labelEl.textContent = s.label;
    const countEl = document.createElement('span');
    countEl.textContent = '—';
    const lit = document.createElement('i');
    lit.className = 'lit';
    cap.append(lit, labelEl, countEl);
    const room = g.up ? g.w - 6 : CAP_W - 6;
    if (s.label.length * 7.8 > room) cap.classList.add('small');
    if (g.up ? g.w < 22 : g.w < 30) cap.classList.add('tight');
    frag.append(cap);
    return { ...s, cap, lit, labelEl, countEl, shownPressed: false, shownCount: null, room };
  });
  capsEl.replaceChildren(frag);
  resizeCanvas();
}

function resizeCanvas() {
  if (!geometry) return;
  const dpr = (window.devicePixelRatio || 1) * geometry.s;
  const g = geometry;
  const bw = Math.round(g.cssW * dpr);
  const bh = Math.round(g.cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  g.dpr = dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
  kick();
}
new ResizeObserver(resizeCanvas).observe(canvas);
matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.('change', resizeCanvas);

/** Rebuilds lanes when their structure changes; a ruleset change fades the block out and back. */
function syncLayout() {
  const mode = currentMode;
  if (!mode) return;
  const spec = laneSpec(mode);
  const sig = [mode, values?.[P.client], JSON.stringify(cfg), palette?.accent, ...spec.map(s => `${s.src}:${s.label}:${s.color}`)].join('|');
  if (sig === signature) return;
  const modeChanged = !signature.startsWith(`${mode}|`);
  const wasShown = signature !== '' && block.getAttribute('data-show') === '1';
  signature = sig;
  if (modeChanged && wasShown) {
    attr(block, 'data-show', '0');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => { swapTimer = 0; buildLanes(currentMode); dirty = true; updateVisibility(); kick(); }, 180);
  } else if (!swapTimer) {
    buildLanes(mode);
  }
  dirty = true;
}

// ------------------------------------------------------------------ state
let shownOnce = false;
/**
 * Gameplay shows the tape in its zone. Results show, in the free right part of the header band, what
 * osu!'s results screen lacks: per-key counts and balance, average and peak KPS (only for an attempt
 * this page watched). Song select and menus show nothing: a key overlay has nothing to add there.
 */
function updateVisibility() {
  const show = status === 'live' && view === 'play' && geometry !== null && !swapTimer;
  attr(block, 'data-show', show ? '1' : '0');
  if (show && !shownOnce) { shownOnce = true; setTimeout(() => block.removeAttribute('data-instant'), 400); }
  const summary = status === 'live' && view === 'results' && results !== null && totalPresses > 0;
  if (el.summary.hidden === summary) el.summary.hidden = !summary;
  // A tiny chip in the zone for connection and no-game states; nothing elsewhere.
  const chip = status !== 'live' ? (status === 'offline' ? 'vosu offline' : 'Connecting') : view === 'nogame' ? 'osu! not running' : '';
  el.chip.hidden = !chip;
  if (chip) { text(el.chipText, chip); attr(el.chip, 'data-state', status === 'live' ? 'idle' : status); }
}

/** Static results summary, built once when the attempt ends. */
function buildSummary() {
  let sum = 0;
  for (const lane of lanes) sum += tracks[lane.src]?.count ?? 0;
  el.sumBrand.hidden = !cfg.showBrand;
  el.sumAvg.textContent = results.avg === null ? '—' : results.avg.toFixed(1);
  el.sumPeak.textContent = String(results.peak);
  if (lanes.length > 9) el.summary.setAttribute('data-narrow', ''); else el.summary.removeAttribute('data-narrow');
  const frag = document.createDocumentFragment();
  for (const lane of lanes) {
    const count = tracks[lane.src]?.count ?? 0;
    const cell = document.createElement('div');
    cell.className = 'kc';
    cell.style.setProperty('--k', lane.color);
    cell.style.setProperty('--share', sum ? (count / sum).toFixed(4) : '0');
    const label = document.createElement('b');
    label.textContent = lane.label;
    const value = document.createElement('strong');
    value.textContent = String(count);
    const bar = document.createElement('i');
    const share = document.createElement('span');
    share.textContent = sum ? `${Math.round((count / sum) * 100)}%` : '—';
    cell.append(label, value, bar, share);
    frag.append(cell);
  }
  el.sumKeys.replaceChildren(frag);
}

let checksum = '';
function followPalette() {
  const next = cfg.accent === 'map' ? values?.[P.checksum] || '' : '';
  if (next === checksum) return;
  checksum = next;
  if (!next) { palette = null; applyPalette(document.documentElement, null); syncLayout(); return; }
  mapPalette(next).then(p => {
    if (checksum !== next) return;
    palette = p;
    applyPalette(document.documentElement, p);
    syncLayout();
    updateVisibility();
    kick();
  });
}

function onFrame(v, changed) {
  values = v;
  const now = performance.now();
  if (changed.has(P.paused)) clock.paused = v[P.paused] === true;
  const rate = Number(v[P.rate]) > 0 ? Number(v[P.rate]) : Number(v[P.modsRate]) > 0 ? Number(v[P.modsRate]) : 1;
  clock.rate = rate;

  const state = v[P.state];
  const nextView = !Number.isInteger(state) ? 'nogame' : state === 2 ? 'play' : state === 7 ? 'results' : 'idle';
  if (nextView !== view) {
    const prev = view;
    view = nextView;
    if (view === 'play') {
      resetAttempt();
      observedEntry = prev !== 'none';
      clock.valid = false;
    } else if (view === 'results' && prev === 'play') {
      closeOpen();
      const span = (lastPress - firstPress) / rate;
      results = { avg: totalPresses > 1 && span >= 1000 ? (totalPresses - 1) / (span / 1000) : null, peak: peakKps };
      if (totalPresses > 0) buildSummary();
    } else if (view !== 'results') {
      resetAttempt();
    }
  }

  if (changed.has(P.live) && Number.isFinite(v[P.live])) {
    const live = v[P.live];
    if (view === 'play' && clock.valid && live < clock.prev - 1000) {
      // Rewound (retry without a state change): the old tape no longer belongs to this attempt.
      resetAttempt();
      observedEntry = true;
    }
    clockSample(live, now);
  }

  if (view === 'play' && changed.has(P.playMode) && !changed.has(P.state) && tracks.length) {
    // Ruleset switched under a running attempt: start over as if attaching.
    resetAttempt();
    observedEntry = false;
  }
  if (view === 'play' && changed.has(P.keys)) ingestKeys(v[P.keys], clockAt(now), rate);

  // The map clock ticks constantly (song-select preview too); alone it only matters while the tape has content.
  if (changed.size === 1 && changed.has(P.live)) {
    if (view === 'play' && hasContent) kick();
    return;
  }
  if (changed.has(P.checksum)) followPalette();
  currentMode = activeMode(state, v[P.playMode], v[P.settingsMode]) ?? 'osu';
  syncLayout();
  updateVisibility();
  dirty = true;
  kick();
}

// ------------------------------------------------------------------ render (rAF only)
let raf = 0;
let dirty = true;
let hasContent = false; // the tape shows presses (or KPS is non-zero) that move with the clock
let lastLiveKps = -2;
document.fonts?.ready.then(() => { dirty = true; kick(); });

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame() {
  raf = 0;
  if (!geometry || !values || swapTimer) return; // fading out: keep the old ruleset's last frame
  const now = clockAt(performance.now());
  const animating = render(now);
  dirty = false;
  if (animating) kick();
}

/** Draws the tape and updates DOM readouts; returns whether another frame is needed. */
function render(now) {
  const g = geometry;
  const rate = clock.rate;
  const playing = view === 'play';
  const pxPerMs = cfg.speed / 1000 / rate; // gameplay ms → px
  let anyVisible = false;
  let anyHeld = false;

  ctx.clearRect(0, 0, g.cssW, g.cssH);
  drawLaneBeds(g);
  drawRuler(g);

  if (playing) {
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      const t = tracks[lane.src];
      if (!t || t.size === 0) continue;
      ctx.fillStyle = lane.color;
      for (let k = 0, i = t.head; k < t.size; k++) {
        i = i === 0 ? RING - 1 : i - 1;
        const start = t.starts[i];
        let end = t.ends[i];
        const held = Number.isNaN(end);
        if (held) { end = now; anyHeld = true; }
        const near = Math.max(0, (now - end) * pxPerMs);
        if (near >= g.tape) break;
        const far = Math.min(g.tape, Math.max(0, (now - start) * pxPerMs));
        anyVisible = true;
        drawBar(g, li, near, far, held);
      }
    }
  }
  ctx.globalAlpha = 1;

  // Caps: strings are only built when a count changes.
  for (const lane of lanes) {
    const t = tracks[lane.src];
    const pressed = playing && t ? t.pressed : false;
    if (pressed !== lane.shownPressed) { lane.shownPressed = pressed; lane.lit.style.opacity = pressed ? '1' : '0'; }
    const count = playing && t ? t.count : -1;
    if (count !== lane.shownCount) { lane.shownCount = count; lane.countEl.textContent = count < 0 ? '—' : formatCount(count, lane.room); }
  }

  const liveKps = playing && (baselined || totalPresses) ? countWindow(now, 1000 * rate) : -1;
  if (cfg.showKps && (dirty || liveKps !== lastLiveKps)) updateReadout(liveKps);
  lastLiveKps = liveKps;
  if (dirty) updateNote();

  hasContent = playing && (anyVisible || anyHeld || liveKps > 0);
  return hasContent && clock.running && !clock.paused;
}

/** KPS and peak; liveKps is -1 when there is no live figure. */
function updateReadout(liveKps) {
  const live = liveKps >= 0;
  text(el.kps, live ? String(liveKps) : '—');
  text(el.peak, live ? String(peakKps) : '—');
  attr(el.read, 'data-empty', live ? '0' : '1');
}

/** One short line when the vosu key feed is missing during play. */
function updateNote() {
  const missing = view === 'play' && !Array.isArray(values[P.keys]);
  if (el.note.hidden === missing) el.note.hidden = !missing;
  if (missing) text(el.note, 'No key data · enable ENABLE_KEY_OVERLAY in vosu');
}

function snap(value) { const d = geometry.dpr || 1; return Math.round(value * d) / d; }

function drawLaneBeds(g) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = BED;
  for (let li = 0; li < lanes.length; li++) {
    const p = g.pos[li];
    if (g.up) ctx.fillRect(p, 0, g.w, g.tape);
    else ctx.fillRect(0, p, g.tape, g.w);
  }
}

function drawRuler(g) {
  // Static time-ago scale: minor ticks every 100 ms of real time, major every 500 ms.
  let minor = cfg.speed * 0.1;
  let every = 5;
  if (minor < 8) { minor = cfg.speed * 0.25; every = 4; }
  const across = g.up ? 0 : g.cssH - RULER;
  ctx.fillStyle = BED;
  if (g.up) ctx.fillRect(0, 0, RULER - 1, g.tape);
  else ctx.fillRect(0, across + 1, g.tape, RULER - 1);
  ctx.fillStyle = '#7e8288';
  for (let k = 1; k * minor <= g.tape; k++) {
    const d = snap(k * minor);
    const len = k % every === 0 ? 7 : 3;
    if (g.up) ctx.fillRect(RULER - 2 - len, g.tape - d, len, 1);
    else ctx.fillRect(d, across + 2, 1, len);
  }
  if (g.up) ctx.fillRect(RULER - 2, 0, 1, g.tape);
  else ctx.fillRect(0, across + 2, g.tape, 1);
}

function drawBar(g, li, near, far, held) {
  const a = snap(near);
  let b = snap(far);
  if (b - a < 2) b = a + 2;
  const across = g.pos[li] + INSET;
  const thick = g.w - INSET * 2;
  ctx.globalAlpha = held ? 0.9 : 0.72;
  if (g.up) ctx.fillRect(across, g.tape - b, thick, b - a);
  else ctx.fillRect(a, across, b - a, thick);
  // Press edge: the moment the key went down, crisp at full strength.
  ctx.globalAlpha = 1;
  const edge = Math.min(2, b - a);
  if (g.up) ctx.fillRect(across, g.tape - b, thick, edge);
  else ctx.fillRect(b - edge, across, edge, thick);
}

// ------------------------------------------------------------------ connection
function onStatus(next) {
  status = next;
  updateVisibility();
}

// ------------------------------------------------------------------ settings
const OPTIONS = { zone: ['auto', 'left', 'right', 'below', 'stage'], direction: ['auto', 'up', 'right'], accent: ['map', '18-lab'], backing: ['none', 'scrim', 'panel'] };
settings(DEFAULTS, next => {
  cfg = { ...next, speed: clamp(Number(next.speed) || DEFAULTS.speed, 100, 3000) };
  for (const [key, allowed] of Object.entries(OPTIONS)) if (!allowed.includes(cfg[key])) cfg[key] = DEFAULTS[key];
  signature = '';
  if (values) { followPalette(); syncLayout(); updateVisibility(); }
  dirty = true;
  kick();
});

subscribe(Object.values(P), onFrame, { onStatus });

// Copyright (c) 2026 18-LAB. MIT.
// Key overlay: one scrolling tape lane per logical key (vosu `keys.all`), key caps with counts,
// live and peak keys per second. Bars are placed in gameplay time from pressedAt/releasedAt.
// The page is sized and placed by its host (OBS, vosulay, the replay renderer); it lays itself out
// for whatever box it is given.
import { subscribe, settings, activeMode, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

// Design units (px at scale 1); the block is scaled to the page's box.
const GAP = 4;          // between lanes
const RULER = 10;       // time ruler beside the tape
const INSET = 3;        // bar inset inside its lane
const LANE = 36;        // natural lane thickness
const LANE_MIN = 16;    // thinnest lane before the whole block scales down
const READ_H = 36;      // readout row
const READ_MIN = 172;   // narrowest vertical block that still fits the readout row
const ROW_GAP = 4;      // readout ↔ tape, tape ↔ caps
const CAP_H = 44;       // caps (vertical)
const CAP_W = 64;       // caps (horizontal)
const COL_GAP = 8;      // caps ↔ tape (horizontal)
const RING = 256;       // remembered presses per lane
const KPS_RING = 2048;  // remembered press times across lanes
const MAX_STEP = 8;     // most presses one key can gain between two samples before it counts as missed data
const EXTRAPOLATE = 100; // ms of wall time the clock may run past its last sample
const SMOKE = '#b8b5ad';
const BED = 'rgba(11,12,13,0.5)';

const DEFAULTS = {
  orientation: 'auto', align: 'auto', speed: 600, showCounts: true, showKps: true, smokeLane: false,
  accent: 'map', colorOsu: '#ff963f', colorDon: '#ef6a4f', colorKat: '#7fa6cf', colorFruits: '#6fbf8e', colorMania: '#ebe8e1',
  backing: 'none',
};
const OPTIONS = { orientation: ['auto', 'horizontal', 'vertical'], align: ['auto', 'start', 'end'], accent: ['map', '18-lab'], backing: ['none', 'scrim', 'panel'] };

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', client: '/client',
  keys: '/keys/all', live: '/beatmap/time/live', rate: '/beatmap/time/rate', checksum: '/beatmap/checksum', skin: '/settings/skin/name',
  modsRate: '/play/mods/rate', paused: '/game/paused', cs: '/beatmap/stats/cs/converted',
  osuK1: '/settings/keybinds/osu/k1', osuK2: '/settings/keybinds/osu/k2', osuSmoke: '/settings/keybinds/osu/smokeKey',
  taikoOL: '/settings/keybinds/taiko/outerLeft', taikoIL: '/settings/keybinds/taiko/innerLeft',
  taikoIR: '/settings/keybinds/taiko/innerRight', taikoOR: '/settings/keybinds/taiko/outerRight',
  catchK1: '/settings/keybinds/fruits/k1', catchK2: '/settings/keybinds/fruits/k2', catchDash: '/settings/keybinds/fruits/Dash',
};

const $ = id => document.getElementById(id);
const block = $('block');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const staticLayer = document.createElement('canvas');
const staticCtx = staticLayer.getContext('2d', { alpha: true });
const capsEl = $('caps');
const el = { read: $('read'), kps: $('kps'), peak: $('peak'), note: $('note'), chip: $('chip'), chipText: $('chip-text') };

let cfg = { ...DEFAULTS };
let cfgKey = '';
let values = null;
let status = 'connecting';
let palette = null;       // map tonal-spot roles, or null
let maniaGeometry = null; // current skin's mania stage for the current key count (maniaSkin), or null
let maniaKey = '';        // skin|keys requested
let maniaKeyLoaded = '';  // skin|keys whose geometry is applied

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

/** Cap count text; called only when the count changes. toFixed(0) is String(n) for integers without
 * V8's number-string cache, whose rebuild after a GC is a 64 KB allocation. */
function formatCount(count, room) {
  const plain = count.toFixed(0);
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
let baselined = false;  // first keys frame of this attempt seen
let observedEntry = false; // we saw the transition into play (counts start from zero)

function resetAttempt() {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    t.count = 0; t.pressed = false; t.ever = false; t.head = 0; t.size = 0; t.open = false;
  }
  kpsHead = 0; kpsSize = 0; peakKps = 0; totalPresses = 0;
  baselined = false;
}

function pushBar(t, start, end) {
  const index = t.head;
  t.starts[index] = start;
  t.ends[index] = end;
  t.head = (index + 1) % RING;
  if (t.size < RING) t.size++;
  t.open = Number.isNaN(end);
}

/** Records `count` presses at ck[CK_PRESS] and raises the peak. */
function pushPresses(count) {
  const time = ck[CK_PRESS];
  for (let k = 0; k < count; k++) {
    kpsTimes[kpsHead] = time;
    kpsHead = (kpsHead + 1) % KPS_RING;
    if (kpsSize < KPS_RING) kpsSize++;
  }
  totalPresses += count;
  // Every press shares one time, so the window after the last one holds the most.
  ck[CK_END] = time;
  const n = countWindow();
  if (n > peakKps) peakKps = n;
}

/**
 * Presses in (end - span, end] for end = ck[CK_END] and span = 1000 ms of real time. Times are nearly
 * ordered; a small tolerance absorbs cross-lane jitter.
 */
function countWindow() {
  const end = ck[CK_END];
  const from = end - 1000 * ck[CK_RATE];
  let n = 0;
  for (let k = 0, i = kpsHead; k < kpsSize; k++) {
    i = i === 0 ? KPS_RING - 1 : i - 1;
    const t = kpsTimes[i];
    if (t <= from - 250) break;
    if (t > from && t <= end) n++;
  }
  return n;
}

/** Reads vosu's per-key list in place at gameplay time ck[CK_NOW]. */
function ingestKeys(list) {
  if (!Array.isArray(list)) return;
  const now = ck[CK_NOW];
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
      ingestKeys(list);
      return;
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
      if (!burst) { ck[CK_PRESS] = at; pushPresses(delta); }
      t.count = count;
    } else if (t.open && !pressed) {
      const last = (t.head + RING - 1) % RING;
      t.ends[last] = releasedAt !== null && releasedAt >= t.starts[last] ? releasedAt : Math.max(now, t.starts[last]);
      t.open = false;
    }
    t.pressed = pressed;
  }
}

/** Ends held bars at the current gameplay time (wall time ck[CK_T], set by onFrame). */
function closeOpen() {
  clockNow();
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.open) continue;
    const last = (t.head + RING - 1) % RING;
    t.ends[last] = Math.max(t.starts[last], ck[CK_NOW]);
    t.open = false;
  }
}

// ------------------------------------------------------------------ gameplay clock
// Map clock samples arrive every few ms during play with delivery jitter; follow them smoothly and
// stop advancing when they stop (pause, freeze, stalled reader). Its numbers, and the times handed
// between the per-message and per-frame functions, live in one Float64Array: a fractional number
// passed to, returned from or stored by a function outside it would be boxed on the heap.
const CK_BASE = 0;  // gameplay ms at CK_AT
const CK_AT = 1;    // wall ms of the last sample
const CK_PREV = 2;  // last sampled gameplay ms
const CK_RATE = 3;  // playback rate
const CK_T = 4;     // wall ms the next clockNow() reads
const CK_NOW = 5;   // clockNow() result: gameplay ms at CK_T
const CK_PRESS = 6; // pushPresses() time
const CK_END = 7;   // countWindow() window end
const ck = new Float64Array(8);
ck[CK_PREV] = NaN;
ck[CK_RATE] = 1;
const clock = { running: false, valid: false, paused: false };
/** Gameplay ms at wall time ck[CK_T], into ck[CK_NOW]. */
function clockNow() {
  if (!clock.valid) ck[CK_NOW] = 0;
  else if (!clock.running || clock.paused) ck[CK_NOW] = ck[CK_BASE];
  else ck[CK_NOW] = ck[CK_BASE] + Math.min(Math.max(0, ck[CK_T] - ck[CK_AT]), EXTRAPOLATE) * ck[CK_RATE];
}
/** Follows a map clock sample `live` taken at wall time ck[CK_T]. */
function clockSample(live) {
  if (!clock.valid) {
    clock.valid = true; ck[CK_BASE] = live; ck[CK_AT] = ck[CK_T]; ck[CK_PREV] = live; clock.running = false;
    return;
  }
  clockNow();
  const predicted = ck[CK_NOW];
  const error = live - predicted;
  clock.running = live > ck[CK_PREV];
  // Two stores, not one conditional value: mixing `live` (as parsed) with a computed number would box it.
  if (!clock.running || Math.abs(error) > 60) ck[CK_BASE] = live;
  else ck[CK_BASE] = predicted + error * 0.2;
  ck[CK_AT] = ck[CK_T];
  ck[CK_PREV] = live;
}

// ------------------------------------------------------------------ lanes
let lanes = [];         // { src, label, color, cap, lit, labelEl, countEl, room, shownPressed, shownCount }
let geometry = null;
let signature = '';
let currentMode = null;
let builtMode = null;
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

// ------------------------------------------------------------------ layout (inside the page's box)
function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

/**
 * Lays the block out for the box the host gives the page (OBS source, vosulay frame, replay-renderer
 * cell). Orientation follows the box (wider than tall: rows; otherwise columns) unless set. The cross
 * axis fixes one scale k, so type, caps and lanes grow and shrink with the box; the tape takes the
 * rest of the long axis. Small boxes (multiplayer cells, half-size sources) first narrow the lanes
 * down to LANE_MIN and only then scale type down, so labels stay legible. Mania lanes keep the
 * current skin's column proportions.
 */
function computeGeometry(mode, n) {
  const W = Math.max(1, innerWidth);
  const H = Math.max(1, innerHeight);
  const v = cfg.orientation === 'auto' ? H > W : cfg.orientation === 'vertical';
  const caps = cfg.align === 'auto' ? (v ? 'end' : 'start') : cfg.align;
  const pad = cfg.backing === 'panel' ? 9 : 0; // padding + border
  const read = cfg.showKps ? READ_H + ROW_GAP : 0;
  const gaps = (n - 1) * GAP;
  let k;
  let cross;
  let along;
  if (v) {
    const natural = Math.max(RULER + n * LANE + gaps, cfg.showKps ? READ_MIN : 0) + pad * 2;
    const tightest = Math.max(RULER + n * LANE_MIN + gaps, cfg.showKps ? READ_MIN : 0) + pad * 2;
    k = clamp(W / natural, clamp(W / tightest, 0.5, 1), 1.6);
    cross = W / k - pad * 2 - RULER;
    along = H / k - pad * 2 - read - ROW_GAP - CAP_H;
  } else {
    const natural = read + n * LANE + gaps + RULER + pad * 2;
    const tightest = read + n * LANE_MIN + gaps + RULER + pad * 2;
    k = clamp(H / natural, clamp(H / tightest, 0.5, 1), 1.6);
    cross = H / k - pad * 2 - read - RULER;
    along = W / k - pad * 2 - CAP_W - COL_GAP;
  }
  // Lanes stop growing at a sane thickness; a single catch dash lane still spans the readout row.
  const maxSpan = Math.max(n * (v ? 96 : 72), v && cfg.showKps ? READ_MIN - RULER : 0);
  const span = Math.max(n * 8, Math.min(cross - gaps, maxSpan));
  const columns = mode === 'mania' && maniaGeometry?.columnWidth?.length === n ? maniaGeometry.columnWidth : null;
  const total = columns ? columns.reduce((a, b) => a + b, 0) : n;
  const widths = new Float64Array(n);
  const pos = new Float64Array(n);
  for (let i = 0, at = v ? RULER : 0; i < n; i++) {
    widths[i] = Math.floor((span * (columns ? columns[i] : 1)) / total);
    pos[i] = at;
    at += widths[i] + GAP;
  }
  const lanesEnd = pos[n - 1] + widths[n - 1];
  const tape = Math.max(40, Math.floor(along));
  const cssW = v ? lanesEnd : tape;
  const cssH = v ? tape : lanesEnd + RULER;
  const width = (v ? cssW : CAP_W + COL_GAP + tape) + pad * 2;
  const height = (v ? read + tape + ROW_GAP + CAP_H : read + cssH) + pad * 2;
  // Centred on whatever the scale clamp leaves over.
  const x = Math.max(0, Math.round((W - width * k) / 2));
  const y = Math.max(0, Math.round((H - height * k) / 2));
  // Caps at the end side (bottom / right): presses travel towards the start, so the tape is mirrored.
  return { v, caps, flip: caps === 'end', n, widths, pos, tape, cssW, cssH, width, k, x, y, dpr: 0, box: null };
}

function buildLanes(mode) {
  builtMode = mode;
  const spec = laneSpec(mode);
  geometry = computeGeometry(mode, spec.length);
  const g = geometry;
  attr(block, 'data-orient', g.v ? 'v' : 'h');
  attr(block, 'data-caps', g.caps);
  attr(block, 'data-kps', cfg.showKps ? '1' : '0');
  attr(block, 'data-counts', cfg.showCounts ? '1' : '0');
  attr(block, 'data-backing', cfg.backing);
  block.style.transform = `translate(${g.x}px, ${g.y}px) scale(${g.k})`;
  block.style.width = `${g.width}px`;
  canvas.style.width = `${g.cssW}px`;
  canvas.style.height = `${g.cssH}px`;
  capsEl.style.width = `${g.v ? g.cssW : CAP_W}px`;
  capsEl.style.height = `${g.v ? CAP_H : g.cssH}px`;

  const frag = document.createDocumentFragment();
  lanes = spec.map((s, i) => {
    const w = g.widths[i];
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.style.cssText = g.v
      ? `--k:${s.color};left:${g.pos[i]}px;top:0;width:${w}px;height:${CAP_H}px`
      : `--k:${s.color};left:0;top:${g.pos[i]}px;width:${CAP_W}px;height:${w}px`;
    const labelEl = document.createElement('b');
    labelEl.textContent = s.label;
    const countEl = document.createElement('span');
    countEl.textContent = '—';
    const lit = document.createElement('i');
    lit.className = 'lit';
    cap.append(lit, labelEl, countEl);
    const room = (g.v ? w : CAP_W) - 6;
    if (s.label.length * 7.8 > room) cap.classList.add('small');
    if (g.v ? w < 22 : w < 30) cap.classList.add('tight');
    frag.append(cap);
    return { ...s, cap, lit, labelEl, countEl, shownPressed: false, shownCount: null, room };
  });
  capsEl.replaceChildren(frag);
  resizeCanvas();
}

// Device-pixel numbers the per-frame drawing passes to the canvas, rebuilt with the canvas. They sit
// in an array that also holds null, so V8 keeps each one boxed once and the canvas calls take them
// as they are; a fractional number computed during the frame would be boxed anew on every call.
const BOX_W = 0;       // canvas width covered by the tape box (cssW · dpr)
const BOX_H = 1;       // cssH · dpr
const BOX_TAPE = 2;    // tape length (mirror axis for caps at the end)
const BOX_MIN = 3;     // shortest bar and press edge: 2 design px
const BOX_EDGE = 4;    // the press edge drawn back from a bar's far end
const BOX_BAR = 5;     // released bar alpha
const BOX_HELD = 6;    // held bar alpha
const BOX_LANES = 7;   // per lane: across offset, thickness

function resizeCanvas() {
  if (!geometry) return;
  const g = geometry;
  const dpr = (window.devicePixelRatio || 1) * g.k;
  const bw = Math.round(g.cssW * dpr);
  const bh = Math.round(g.cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  g.dpr = dpr;
  const box = new Array(BOX_LANES + 2 * g.n).fill(null);
  box[BOX_W] = g.cssW * dpr;
  box[BOX_H] = g.cssH * dpr;
  box[BOX_TAPE] = g.tape * dpr;
  box[BOX_MIN] = 2 * dpr;
  box[BOX_EDGE] = -2 * dpr;
  box[BOX_BAR] = 0.72;
  box[BOX_HELD] = 0.9;
  for (let i = 0; i < g.n; i++) {
    box[BOX_LANES + 2 * i] = (g.pos[i] + INSET) * dpr;
    box[BOX_LANES + 2 * i + 1] = (g.widths[i] - INSET * 2) * dpr;
  }
  g.box = box;
  // Lane beds and the ruler never move: drawn once here, copied under the bars every frame.
  if (staticLayer.width !== bw || staticLayer.height !== bh) { staticLayer.width = bw; staticLayer.height = bh; }
  staticCtx.setTransform(1, 0, 0, 1, 0, 0);
  staticCtx.clearRect(0, 0, bw, bh);
  staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawLaneBeds(staticCtx, g);
  drawRuler(staticCtx, g);
  dirty = true;
  kick();
}
matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.('change', resizeCanvas);
// Hosts resize the page (vosulay frame, renderer layer, OBS source): re-flow for the new box.
new ResizeObserver(() => { if (builtMode && !swapTimer) buildLanes(builtMode); }).observe(document.documentElement);

/** Rebuilds lanes when their structure changes; a ruleset change fades the block out and back. */
function syncLayout() {
  const mode = currentMode;
  if (!mode) return;
  const spec = laneSpec(mode);
  const sig = [mode, values?.[P.client], cfgKey, palette?.accent, maniaKeyLoaded, ...spec.map(s => `${s.src}:${s.label}:${s.color}`)].join('|');
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
 * The tape shows during gameplay only (incl. replay/spectate and the replay renderer). Song select,
 * results and menus show nothing: the page sits where the gameplay layout has room, which on those
 * screens is osu!'s own UI, and osu! shows no key data worth adding there.
 */
function updateVisibility() {
  const show = status === 'live' && view === 'play' && geometry !== null && !swapTimer;
  attr(block, 'data-show', show ? '1' : '0');
  if (show && !shownOnce) { shownOnce = true; setTimeout(() => block.removeAttribute('data-instant'), 400); }
  // A tiny chip for connection and no-game states; nothing elsewhere.
  const chip = status !== 'live' ? (status === 'offline' ? 'vosu offline' : 'Connecting') : view === 'nogame' ? 'osu! not running' : '';
  if (el.chip.hidden !== !chip) el.chip.hidden = !chip;
  if (chip) { text(el.chipText, chip); attr(el.chip, 'data-state', status === 'live' ? 'idle' : status); }
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

/** Re-reads the skin's mania column widths when the key count or skin changes (off the hot path). */
function followManiaSkin() {
  const keys = keyCount();
  const skin = typeof values?.[P.skin] === 'string' ? values[P.skin] : '';
  const key = `${skin}|${keys}`;
  if (key === maniaKey) return;
  maniaKey = key;
  maniaSkin(keys, skin).then(geometry => {
    if (maniaKey !== key) return;
    maniaGeometry = geometry;
    maniaKeyLoaded = key;
    syncLayout();
    updateVisibility();
    kick();
  });
}

// Pointers whose change can alter lanes or labels; key frames alone only can through their length
// (mania key count) or catch move keys getting their first press.
const LAYOUT_POINTERS = [P.state, P.playMode, P.settingsMode, P.client, P.cs, P.skin, P.osuK1, P.osuK2, P.osuSmoke,
  P.taikoOL, P.taikoIL, P.taikoIR, P.taikoOR, P.catchK1, P.catchK2, P.catchDash];
let keysLength = -1;
let catchMoves = false;
function layoutMayChange(changed) {
  let result = false;
  for (let i = 0; i < LAYOUT_POINTERS.length; i++) if (changed.has(LAYOUT_POINTERS[i])) { result = true; break; }
  const list = values[P.keys];
  const length = Array.isArray(list) ? list.length : -1;
  if (length !== keysLength) { keysLength = length; result = true; }
  const moves = Boolean(tracks[0]?.ever || tracks[1]?.ever);
  if (moves !== catchMoves) { catchMoves = moves; result = true; }
  return result;
}

function onFrame(v, changed) {
  values = v;
  ck[CK_T] = performance.now();
  if (changed.has(P.paused)) clock.paused = v[P.paused] === true;
  ck[CK_RATE] = Number(v[P.rate]) > 0 ? Number(v[P.rate]) : Number(v[P.modsRate]) > 0 ? Number(v[P.modsRate]) : 1;

  const state = v[P.state];
  const nextView = !Number.isInteger(state) ? 'nogame' : state === 2 ? 'play' : state === 7 ? 'results' : 'idle';
  if (nextView !== view) {
    const prev = view;
    view = nextView;
    if (view === 'play') {
      resetAttempt();
      observedEntry = prev !== 'none';
      clock.valid = false;
    } else {
      closeOpen();
      resetAttempt();
    }
  }

  if (changed.has(P.live) && Number.isFinite(v[P.live])) {
    const live = v[P.live];
    if (view === 'play' && clock.valid && live < ck[CK_PREV] - 1000) {
      // Rewound (retry without a state change): the old tape no longer belongs to this attempt.
      resetAttempt();
      observedEntry = true;
    }
    clockSample(live);
  }

  if (view === 'play' && changed.has(P.playMode) && !changed.has(P.state) && tracks.length) {
    // Ruleset switched under a running attempt: start over as if attaching.
    resetAttempt();
    observedEntry = false;
  }
  if (view === 'play' && changed.has(P.keys)) { clockNow(); ingestKeys(v[P.keys]); }

  // The map clock ticks constantly (song-select preview too); alone it only matters while the tape has content.
  if (changed.size === 1 && changed.has(P.live)) {
    if (view === 'play' && hasContent) kick();
    return;
  }
  if (changed.has(P.checksum)) followPalette();
  currentMode = activeMode(state, v[P.playMode], v[P.settingsMode]) ?? 'osu';
  if (layoutMayChange(changed)) {
    if (currentMode === 'mania') followManiaSkin();
    syncLayout();
  }
  updateVisibility();
  dirty = true;
  kick();
}

// ------------------------------------------------------------------ render (rAF only)
let raf = 0;
let dirty = true;
let hasContent = false; // the tape shows presses (or KPS is non-zero) that move with the clock
let lastLiveKps = -2;
let shownKps = -2;      // readout figures on screen (-1: '—')
let shownPeak = -2;
let shownEmpty = null;
document.fonts?.ready.then(() => { dirty = true; kick(); });

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame() {
  raf = 0;
  if (!geometry || !values || swapTimer) return; // fading out: keep the old ruleset's last frame
  ck[CK_T] = performance.now();
  clockNow();
  const animating = render();
  dirty = false;
  if (animating) kick();
}

/**
 * Draws the tape at gameplay time ck[CK_NOW] and updates DOM readouts; returns whether another frame
 * is needed. Allocation-free: bars are snapped to whole device pixels and drawn as integers along the
 * tape (a mirrored transform puts the caps at the end), every fractional value comes from g.box.
 */
function render() {
  const g = geometry;
  const box = g.box;
  const now = ck[CK_NOW];
  const playing = view === 'play';
  const pxPerMs = cfg.speed / 1000 / ck[CK_RATE]; // gameplay ms → design px
  const dpr = g.dpr; // set by resizeCanvas, which follows every computeGeometry
  let anyVisible = false;
  let anyHeld = false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, box[BOX_W], box[BOX_H]);
  ctx.drawImage(staticLayer, 0, 0);

  if (playing) {
    if (g.flip) {
      if (g.v) ctx.setTransform(1, 0, 0, -1, 0, box[BOX_TAPE]);
      else ctx.setTransform(-1, 0, 0, 1, box[BOX_TAPE], 0);
    }
    const min = box[BOX_MIN];
    const edge = box[BOX_EDGE];
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      const t = tracks[lane.src];
      if (!t || t.size === 0) continue;
      ctx.fillStyle = lane.color;
      const across = box[BOX_LANES + 2 * li];
      const thick = box[BOX_LANES + 2 * li + 1];
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
        // Distances from the caps in whole device pixels; bars are at least 2 design px long.
        const a = Math.round(near * dpr) | 0;
        const b = Math.round(far * dpr) | 0;
        if (held) ctx.globalAlpha = box[BOX_HELD];
        else ctx.globalAlpha = box[BOX_BAR];
        if (b - a < min) {
          // The whole short bar is its press edge.
          if (g.v) ctx.fillRect(across, a, thick, min); else ctx.fillRect(a, across, min, thick);
          ctx.globalAlpha = 1;
          if (g.v) ctx.fillRect(across, a, thick, min); else ctx.fillRect(a, across, min, thick);
        } else {
          if (g.v) ctx.fillRect(across, a, thick, b - a); else ctx.fillRect(a, across, b - a, thick);
          // Press edge: the moment the key went down (the far end), crisp at full strength.
          ctx.globalAlpha = 1;
          if (g.v) ctx.fillRect(across, b, thick, edge); else ctx.fillRect(b, across, edge, thick);
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // Caps: strings are only built when a count changes.
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    const t = tracks[lane.src];
    const pressed = playing && t ? t.pressed : false;
    if (pressed !== lane.shownPressed) { lane.shownPressed = pressed; lane.lit.style.opacity = pressed ? '1' : '0'; }
    const count = playing && t ? t.count : -1;
    if (count !== lane.shownCount) { lane.shownCount = count; lane.countEl.textContent = count < 0 ? '—' : formatCount(count, lane.room); }
  }

  let liveKps = -1;
  if (playing && (baselined || totalPresses)) { ck[CK_END] = now; liveKps = countWindow(); }
  if (cfg.showKps && (dirty || liveKps !== lastLiveKps)) updateReadout(liveKps);
  lastLiveKps = liveKps;
  if (dirty) updateNote();

  hasContent = playing && (anyVisible || anyHeld || liveKps > 0);
  return hasContent && clock.running && !clock.paused;
}

/** KPS and peak; liveKps is -1 when there is no live figure. */
function updateReadout(liveKps) {
  const live = liveKps >= 0;
  const peak = live ? peakKps : -1;
  if (liveKps !== shownKps) { shownKps = liveKps; el.kps.textContent = live ? figure(liveKps) : '—'; }
  if (peak !== shownPeak) { shownPeak = peak; el.peak.textContent = live ? figure(peak) : '—'; }
  if (live !== shownEmpty) { shownEmpty = live; attr(el.read, 'data-empty', live ? '0' : '1'); }
}

// KPS figures are window counts, at most KPS_RING: each string is built once and reused.
const figures = new Array(KPS_RING + 1).fill(null);
function figure(n) { return figures[n] ??= n.toFixed(0); }

/** One short line when the vosu key feed is missing during play. */
function updateNote() {
  const missing = view === 'play' && !Array.isArray(values[P.keys]);
  if (el.note.hidden === missing) el.note.hidden = !missing;
  if (missing) text(el.note, 'No key data · enable ENABLE_KEY_OVERLAY in vosu');
}

function drawLaneBeds(c, g) {
  c.globalAlpha = 1;
  c.fillStyle = BED;
  for (let li = 0; li < lanes.length; li++) {
    if (g.v) c.fillRect(g.pos[li], 0, g.widths[li], g.tape);
    else c.fillRect(0, g.pos[li], g.tape, g.widths[li]);
  }
}

function drawRuler(c, g) {
  // Static time-ago scale from the caps: minor ticks every 100 ms of real time, major every 500 ms.
  let minor = cfg.speed * 0.1;
  let every = 5;
  if (minor < 8) { minor = cfg.speed * 0.25; every = 4; }
  const base = g.v ? 0 : g.cssH - RULER;
  const dpr = g.dpr || 1;
  c.fillStyle = BED;
  if (g.v) c.fillRect(0, 0, RULER - 1, g.tape);
  else c.fillRect(0, base + 1, g.tape, RULER - 1);
  c.fillStyle = '#7e8288';
  for (let k = 1; k * minor <= g.tape; k++) {
    const d = Math.round(k * minor * dpr) / dpr; // on a device pixel
    const at = g.flip ? g.tape - d : d;
    const len = k % every === 0 ? 7 : 3;
    if (g.v) c.fillRect(RULER - 2 - len, at, len, 1);
    else c.fillRect(at, base + 2, 1, len);
  }
  if (g.v) c.fillRect(RULER - 2, 0, 1, g.tape);
  else c.fillRect(0, base + 2, g.tape, 1);
}

// ------------------------------------------------------------------ connection
function onStatus(next) {
  if (next === status) return; // the client reports 'live' with every message
  status = next;
  updateVisibility();
}

// ------------------------------------------------------------------ settings
settings(DEFAULTS, next => {
  cfg = { ...next, speed: clamp(Number(next.speed) || DEFAULTS.speed, 100, 3000) };
  for (const [key, allowed] of Object.entries(OPTIONS)) if (!allowed.includes(cfg[key])) cfg[key] = DEFAULTS[key];
  cfgKey = JSON.stringify(cfg);
  signature = '';
  if (values) { followPalette(); syncLayout(); updateVisibility(); }
  dirty = true;
  kick();
});

subscribe(Object.values(P), onFrame, { onStatus });

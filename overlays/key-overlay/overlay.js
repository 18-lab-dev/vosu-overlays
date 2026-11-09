// Copyright (c) 2026 18-LAB. MIT.
// Key overlay: one scrolling tape lane per logical key (vosu `keys.all`) and a key cap per lane with
// its press count. Bars are placed in gameplay time from pressedAt/releasedAt. Keys per second and
// the peak come from the set's one computation (createKps) and are off by default: key-counter and
// kps-graph own them. The page is sized and placed by its host (OBS, vosulay, the replay renderer)
// and lays itself out for whatever box it is given. System: docs/overlay-system.md.
import {
  subscribe, settings, activeMode, maniaSkin, applyKitSettings, numberFormatter, createKps, isKnown,
  UNKNOWN, MOTION_MS,
} from './vosu-overlay.js';

// Design px at --u = 1; the default boxes (osu!/catch/mania column 256 wide, taiko row 96 tall) are --u = 1.
const COLUMN_W = 256;  // vertical box width at --u = 1
const ROW_H = 96;      // horizontal box height at --u = 1
const U_MIN = 0.5;
const U_MAX = 1.6;
const PAD = 16;         // kit --pad (scrim, panel); none has no padding
const GAP_V = 4;        // between lanes (columns)
const GAP_H = 2;        // between lanes (rows: four taiko lanes share a 96 px row)
const LANE_MAX_V = 140; // widest column before the block stops growing and centres
const LANE_MAX_H = 40;  // thickest row
const CAP_H = 56;       // caps (vertical): key code over count
const CAP_W = 88;       // caps (horizontal): key code and count on one line
const CAP_GAP = 4;      // caps ↔ tape
const READ_H = 36;      // readout row (vertical)
const READ_W = 96;      // readout column (horizontal)
const READ_GAP = 8;     // readout ↔ tape / caps
const MIN_TAPE = 40;
const COUNT_MAX = 24;   // count size in columns, shrunk to fit the narrowest lane
const COUNT_MIN = 14;   // the kit's floor for anything a viewer reads
const COUNT_ROW = 16;   // count size in rows
const RING = 256;       // remembered presses per lane
const EXTRAPOLATE = 100; // ms of wall time the clock may run past its last sample
const BAR_REST = 0.42;  // released bars: history, quieter than the present
const SETTLE_MS = 150;  // a released press stays at full strength this long (real ms), then rests
const HEAT_STEPS = 16;  // settle alpha levels (precomputed, so drawing never boxes a fraction)
const FAST_ON = 16;     // above this KPS press feedback snaps (no settle, no release fade) …
const FAST_OFF = 12;    // … until it drops below this
const PEAK_MIN = 5;     // peaks below this are the attempt warming up, not news
const PEAK_QUIET = 2000; // gameplay ms between two new-peak marks
const BED_DARK = 'rgba(11,12,13,0.5)';     // lane beds with backing none
const BED_LIGHT = 'rgba(239,236,229,0.05)'; // lane beds on the scrim / panel

const DEFAULTS = {
  motion: 'full', backing: 'scrim',
  orientation: 'auto', align: 'auto', speed: 600, showCounts: true, showKps: false, maniaTape: false, smokeLane: false,
};
const OPTIONS = { orientation: ['auto', 'horizontal', 'vertical'], align: ['auto', 'start', 'end'] };

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', client: '/client',
  keys: '/keys/all', live: '/beatmap/time/live', rate: '/beatmap/time/rate', skin: '/settings/skin/name',
  modsRate: '/play/mods/rate', paused: '/game/paused', cs: '/beatmap/stats/cs/converted',
  osuK1: '/settings/keybinds/osu/k1', osuK2: '/settings/keybinds/osu/k2', osuSmoke: '/settings/keybinds/osu/smokeKey',
  taikoOL: '/settings/keybinds/taiko/outerLeft', taikoIL: '/settings/keybinds/taiko/innerLeft',
  taikoIR: '/settings/keybinds/taiko/innerRight', taikoOR: '/settings/keybinds/taiko/outerRight',
  catchK1: '/settings/keybinds/fruits/k1', catchK2: '/settings/keybinds/fruits/k2', catchDash: '/settings/keybinds/fruits/Dash',
};

const $ = id => document.getElementById(id);
const root = $('block');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const staticLayer = document.createElement('canvas');
const staticCtx = staticLayer.getContext('2d', { alpha: true });
const capsEl = $('caps');
const el = { read: $('read'), kps: $('kps'), peak: $('peak'), peakMark: $('peak-mark'), tapeBox: $('tape-box'), note: $('note'), chip: $('chip') };

let cfg = { ...DEFAULTS };
let cfgKey = '';
let motion = 'full';
let values = null;
let status = 'connecting';
let maniaGeometry = null; // current skin's mania stage for the current key count (maniaSkin), or null
let maniaKey = '';        // skin|keys requested
let maniaKeyLoaded = '';  // skin|keys whose geometry is applied

// ------------------------------------------------------------------ text helpers
function attr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
function flag(node, name, on) {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on);
}

const KEY_NAMES = {
  Left: '←', Right: '→', Up: '↑', Down: '↓', Space: 'SPACE', Enter: 'ENTER', Tab: 'TAB', Back: 'BKSP', Escape: 'ESC',
  CapsLock: 'CAPS', LeftShift: 'LSHFT', RightShift: 'RSHFT', LeftControl: 'LCTRL', RightControl: 'RCTRL',
  LeftAlt: 'LALT', RightAlt: 'RALT', PageUp: 'PGUP', PageDown: 'PGDN', Insert: 'INS', Delete: 'DEL', Home: 'HOME', End: 'END',
};
/** A stable keybind name as a short cap label (a code: kit-code caps), or null when unbound/unknown. */
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

// ------------------------------------------------------------------ key tracks (one per keys.all entry)
function makeTrack() {
  return {
    count: 0, pressed: false, ever: false,
    starts: new Float64Array(RING), ends: new Float64Array(RING), head: 0, size: 0, open: false,
    format: numberFormatter('count'),
  };
}
const tracks = [];
function track(i) { return tracks[i] ??= makeTrack(); }

// Keys per second: the set's shared definition (same window and peak as key-counter and kps-graph).
const kps = createKps();
let baselined = false;  // first keys frame of this attempt seen
let observedEntry = false; // we saw the transition into play (counts start from zero)

function resetAttempt() {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    t.count = 0; t.pressed = false; t.ever = false; t.head = 0; t.size = 0; t.open = false;
  }
  kps.reset();
  baselined = false;
  shownPeakValue = 0;
  ck[CK_FLASH] = -Infinity;
}

function pushBar(t, start, end) {
  const index = t.head;
  t.starts[index] = start;
  t.ends[index] = end;
  t.head = (index + 1) % RING;
  if (t.size < RING) t.size++;
  t.open = Number.isNaN(end);
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
      // only the latest press vosu still reports (it scrolls off if it is old).
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
      const at = pressedAt ?? now;
      if (t.open) {
        const last = (t.head + RING - 1) % RING;
        t.ends[last] = releasedAt !== null && releasedAt <= at && releasedAt >= t.starts[last] ? releasedAt : at;
        t.open = false;
      }
      // Complete taps between two samples count but have no times to draw: the latest bar stands for them.
      pushBar(t, at, pressed ? NaN : releasedAt !== null && releasedAt >= at ? releasedAt : at + 16);
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
const CK_FLASH = 6; // gameplay ms of the last new-peak mark
const ck = new Float64Array(7);
ck[CK_PREV] = NaN;
ck[CK_RATE] = 1;
ck[CK_FLASH] = -Infinity;
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
let lanes = [];         // { src, label, zone, rest, hot, cap, labelEl, countEl, shownDown, shownText }
let geometry = null;
let signature = '';
let currentMode = null;
let builtMode = null;
let swapTimer = 0;
let view = 'none';      // 'play' | 'results' | 'idle' | 'nogame' | 'none'

// Colour roles from kit.css, read once per layout (canvas needs them as strings).
const role = { text: '#efece5', you: '#ff963f', don: '#e8573e', kat: '#4f9fc4', display: '"Barlow Condensed"' };
function readRoles() {
  const style = getComputedStyle(root);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  role.text = read('--text-1', role.text);
  role.you = read('--you', role.you);
  role.don = read('--don', role.don);
  role.kat = read('--kat', role.kat);
  role.display = read('--font-display', role.display);
}

function keyCount() {
  const list = values?.[P.keys];
  if (Array.isArray(list) && view === 'play') return list.length;
  const n = Math.round(Number(values?.[P.cs]));
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 4;
}

/**
 * Lanes for the ruleset. Bars are neutral history; the present (a held key, a press for its first
 * 150 ms) is 18-LAB amber, "you". osu!taiko keeps don/kat, which are game meaning (the zones).
 */
function laneSpec(mode) {
  const v = values;
  const bind = pointer => keyLabel(v[pointer]);
  if (mode === 'osu') {
    const spec = [{ src: 0, label: bind(P.osuK1) ?? 'K1', zone: '' }, { src: 1, label: bind(P.osuK2) ?? 'K2', zone: '' }];
    if (cfg.smokeLane) spec.push({ src: 2, label: bind(P.osuSmoke) ?? 'SMK', zone: '' });
    return spec;
  }
  if (mode === 'taiko') {
    return [
      { src: 0, label: bind(P.taikoOL) ?? 'K', zone: 'kat' },
      { src: 1, label: bind(P.taikoIL) ?? 'D', zone: 'don' },
      { src: 2, label: bind(P.taikoIR) ?? 'D', zone: 'don' },
      { src: 3, label: bind(P.taikoOR) ?? 'K', zone: 'kat' },
    ];
  }
  if (mode === 'fruits') {
    // osu!stable never reports catch left/right, so those lanes only appear once they carry presses.
    const moves = v[P.client] === 'lazer' || tracks[0]?.ever || tracks[1]?.ever;
    const dash = { src: 2, label: bind(P.catchDash) ?? 'DASH', zone: '' };
    return moves ? [{ src: 0, label: bind(P.catchK1) ?? '←', zone: '' }, { src: 1, label: bind(P.catchK2) ?? '→', zone: '' }, dash] : [dash];
  }
  const spec = [];
  for (let i = 0, n = keyCount(); i < n; i++) spec.push({ src: i, label: String(i + 1), zone: '' });
  return spec;
}

// ------------------------------------------------------------------ layout (inside the page's box)
function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

/**
 * Lays the block out in CSS px for the box the host gives the page (OBS source, vosulay frame,
 * replay-renderer cell). Orientation follows the box (wider than tall: rows; otherwise columns)
 * unless set. --u is 1 at the default boxes (a 256 px column, a 96 px row) and follows the box's
 * cross axis, shrinking further when the long axis cannot hold caps, readout and a short tape.
 * The lanes fill the cross axis (mania keeps the skin's column proportions); the tape takes the
 * rest of the long axis. Without a tape (osu!mania by default) the block is content-sized and sits
 * on the caps' side of the box.
 */
function computeGeometry(mode, n) {
  const W = Math.max(1, innerWidth);
  const H = Math.max(1, innerHeight);
  const v = cfg.orientation === 'auto' ? H > W : cfg.orientation === 'vertical';
  const caps = cfg.align === 'auto' ? (v ? 'end' : 'start') : cfg.align;
  const tape = mode !== 'mania' || cfg.maniaTape;
  const pad = cfg.backing === 'none' ? 0 : PAD;
  const read = cfg.showKps;
  const capsD = v ? CAP_H : CAP_W;
  const readD = read ? (v ? READ_H : READ_W) + READ_GAP : 0;
  const need = pad * 2 + capsD + readD + (tape ? CAP_GAP + MIN_TAPE : 0);
  const u = clamp(Math.min(v ? W / COLUMN_W : H / ROW_H, (v ? H : W) / need), U_MIN, U_MAX);

  // Cross axis: lanes fill the box up to a sane thickness; the block centres on any rest.
  const p = Math.round(pad * u);
  const crossBox = v ? W : H;
  // Narrow columns (osu!mania 7K in a 256 px column) close up to 2 px so their counts keep the 14 px floor.
  const wide = v && (crossBox - 2 * p - (n - 1) * GAP_V * u) / n >= 40 * u;
  const gap = Math.max(1, Math.round((wide ? GAP_V : GAP_H) * u));
  const span = Math.max(n * 4, Math.floor(Math.min(crossBox - 2 * p, n * (v ? LANE_MAX_V : LANE_MAX_H) * u + (n - 1) * gap)));
  const columns = mode === 'mania' && maniaGeometry?.columnWidth?.length === n ? maniaGeometry.columnWidth : null;
  let total = 0;
  for (let i = 0; i < n; i++) total += columns ? columns[i] : 1;
  const widths = new Float64Array(n);
  const pos = new Float64Array(n);
  const free = span - (n - 1) * gap;
  let used = 0;
  for (let i = 0; i < n; i++) { widths[i] = Math.max(1, Math.floor((free * (columns ? columns[i] : 1)) / total)); used += widths[i]; }
  for (let i = 0, at = Math.floor((free - used) / 2); i < n; i++) { pos[i] = at; at += widths[i] + gap; }
  const cross = span + 2 * p;

  // Long axis.
  const capsLen = Math.round(capsD * u);
  const readLen = read ? Math.round((v ? READ_H : READ_W) * u) : 0;
  const readGap = read ? Math.round(READ_GAP * u) : 0;
  const capGap = tape ? Math.round(CAP_GAP * u) : 0;
  const alongBox = v ? H : W;
  const tapeLen = tape ? Math.max(Math.round(MIN_TAPE * u), alongBox - 2 * p - capsLen - capGap - readLen - readGap) : 0;
  const along = 2 * p + readLen + readGap + tapeLen + capGap + capsLen;
  const alongAt = tape ? Math.max(0, Math.round((alongBox - along) / 2)) : caps === 'end' ? Math.max(0, alongBox - along) : 0;
  const crossAt = Math.max(0, Math.round((crossBox - cross) / 2));
  const capsAt = caps === 'end' ? along - p - capsLen : p;
  const tapeAt = caps === 'end' ? p + readLen + readGap : p + capsLen + capGap;
  const readAt = caps === 'end' ? p : p + capsLen + capGap + tapeLen + readGap;
  const rect = (a, len) => (v ? { x: p, y: a, w: span, h: len } : { x: a, y: p, w: len, h: span });

  // Count size: the largest that fits "8,888" in the narrowest column (rows use one size).
  let minLane = Infinity;
  for (let i = 0; i < n; i++) if (widths[i] < minLane) minLane = widths[i];
  let countPx = COUNT_ROW * u;
  let tight = v ? false : minLane < 12 * u;
  if (v) {
    staticCtx.font = `600 100px ${role.display}`;
    const per100 = staticCtx.measureText('8,888').width;
    countPx = Math.min(COUNT_MAX * u, ((minLane - 2 * u) * 100) / per100);
    if (countPx < COUNT_MIN * u) tight = true;
  }

  return {
    v, caps, flip: caps === 'end', tape, read, n, u, widths, pos, tapeLen, capsLen,
    x: v ? crossAt : alongAt, y: v ? alongAt : crossAt, w: v ? cross : along, h: v ? along : cross,
    readRect: rect(readAt, readLen), tapeRect: rect(tapeAt, tapeLen), capsRect: rect(capsAt, capsLen),
    countPx: Math.floor(countPx / u * 10) / 10, tight, dpr: 0, box: null,
  };
}

function place(node, r) {
  node.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
}

function buildLanes(mode) {
  builtMode = mode;
  readRoles();
  const spec = laneSpec(mode);
  geometry = computeGeometry(mode, spec.length);
  const g = geometry;
  attr(root, 'data-orient', g.v ? 'v' : 'h');
  attr(root, 'data-caps', g.caps);
  attr(root, 'data-counts', cfg.showCounts ? '1' : '0');
  root.style.cssText = `--u:${g.u};left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`;
  place(el.read, g.readRect);
  place(el.tapeBox, g.tapeRect);
  place(capsEl, g.capsRect);
  capsEl.style.setProperty('--count', String(g.countPx));
  flag(capsEl, 'data-tight', g.tight);
  if (el.read.hidden === g.read) el.read.hidden = !g.read;
  if (el.tapeBox.hidden === g.tape) el.tapeBox.hidden = !g.tape;

  const frag = document.createDocumentFragment();
  lanes = spec.map((s, i) => {
    const w = g.widths[i];
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.style.cssText = g.v
      ? `left:${g.pos[i]}px;top:0;width:${w}px;height:${g.capsLen}px`
      : `left:0;top:${g.pos[i]}px;width:${g.capsLen}px;height:${w}px`;
    if (s.zone) { cap.dataset.zone = s.zone; cap.style.setProperty('--k', `var(--${s.zone})`); }
    const labelEl = document.createElement('b');
    labelEl.className = 'kit-code';
    labelEl.textContent = s.label;
    const countEl = document.createElement('span');
    countEl.className = 'n';
    countEl.textContent = '—';
    countEl.setAttribute('data-dash', '');
    const lit = document.createElement('i');
    lit.className = 'lit';
    cap.append(labelEl, countEl, lit);
    frag.append(cap);
    const rest = s.zone === 'don' ? role.don : s.zone === 'kat' ? role.kat : role.text;
    return { ...s, rest, hot: s.zone ? rest : role.you, cap, labelEl, countEl, shownDown: false, shownText: '—' };
  });
  capsEl.replaceChildren(frag);
  resizeCanvas();
}

// Device-pixel numbers the per-frame drawing passes to the canvas, rebuilt with the canvas. They sit
// in an array that also holds null, so V8 keeps each one boxed once and the canvas calls take them
// as they are; a fractional number computed during the frame would be boxed anew on every call.
const BOX_W = 0;       // canvas width (device px)
const BOX_H = 1;       // canvas height (device px)
const BOX_TAPE = 2;    // tape length (mirror axis for caps at the end)
const BOX_MIN = 3;     // shortest bar and press edge: 2 design px
const BOX_EDGE = 4;    // the press edge drawn back from a bar's far end
const BOX_REST = 5;    // released bar alpha
const BOX_HEAT = 6;    // HEAT_STEPS + 1 settle alphas, 0 … 1
const BOX_LANES = BOX_HEAT + HEAT_STEPS + 1; // per lane: across offset, thickness

function resizeCanvas() {
  if (!geometry) return;
  const g = geometry;
  const dpr = window.devicePixelRatio || 1;
  const cssW = g.v ? g.tapeRect.w : g.tapeLen;
  const cssH = g.v ? g.tapeLen : g.tapeRect.h;
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  g.dpr = dpr;
  const box = new Array(BOX_LANES + 2 * g.n).fill(null);
  box[BOX_W] = bw;
  box[BOX_H] = bh;
  box[BOX_TAPE] = g.tapeLen * dpr;
  box[BOX_MIN] = Math.max(1, Math.round(2 * g.u * dpr));
  box[BOX_EDGE] = -Math.max(1, Math.round(2 * g.u * dpr));
  box[BOX_REST] = BAR_REST;
  for (let k = 0; k <= HEAT_STEPS; k++) box[BOX_HEAT + k] = k / HEAT_STEPS;
  for (let i = 0; i < g.n; i++) {
    const inset = Math.min(Math.round(3 * g.u), Math.floor(g.widths[i] / 6));
    box[BOX_LANES + 2 * i] = Math.round((g.pos[i] + inset) * dpr);
    box[BOX_LANES + 2 * i + 1] = Math.max(1, Math.round((g.widths[i] - inset * 2) * dpr));
  }
  g.box = box;
  keepFrame = false; // a resized canvas is blank: draw it again
  // Lane beds never move: drawn once here, copied under the bars every frame.
  if (staticLayer.width !== bw || staticLayer.height !== bh) { staticLayer.width = bw; staticLayer.height = bh; }
  staticCtx.setTransform(1, 0, 0, 1, 0, 0);
  staticCtx.clearRect(0, 0, bw, bh);
  staticCtx.fillStyle = cfg.backing === 'none' ? BED_DARK : BED_LIGHT;
  for (let i = 0; i < g.n; i++) {
    const a = Math.round(g.pos[i] * dpr);
    const t = Math.round(g.widths[i] * dpr);
    if (g.v) staticCtx.fillRect(a, 0, t, bh); else staticCtx.fillRect(0, a, bw, t);
  }
  dirty = true;
  kick();
}
matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.('change', resizeCanvas);
// Hosts resize the page (vosulay frame, renderer layer, OBS source): re-flow for the new box.
new ResizeObserver(() => { if (builtMode && !swapTimer) buildLanes(builtMode); }).observe(document.documentElement);
// Counts are fitted with the display face's metrics: re-fit once it has loaded.
document.fonts?.load(`600 24px ${role.display}`).then(() => { if (builtMode && !swapTimer) buildLanes(builtMode); }, () => {});

/** Rebuilds lanes when their structure changes; a ruleset change fades the block out and back. */
function syncLayout() {
  const mode = currentMode;
  if (!mode) return;
  const spec = laneSpec(mode);
  const sig = [mode, values?.[P.client], cfgKey, maniaKeyLoaded, ...spec.map(s => `${s.src}:${s.label}`)].join('|');
  if (sig === signature) return;
  const modeChanged = !signature.startsWith(`${mode}|`);
  const wasShown = signature !== '' && !root.hasAttribute('data-out');
  signature = sig;
  if (modeChanged && wasShown) {
    flag(root, 'data-out', true);
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => { swapTimer = 0; buildLanes(currentMode); dirty = true; updateVisibility(); kick(); }, motion === 'off' ? 0 : MOTION_MS.base);
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
  flag(root, 'data-out', !show);
  if (show && !shownOnce) { shownOnce = true; setTimeout(() => root.removeAttribute('data-instant'), 400); }
  // A small chip for connection and no-game states; nothing elsewhere.
  const chip = status !== 'live' ? (status === 'offline' ? 'vosu offline' : 'Connecting to vosu') : view === 'nogame' ? 'osu! not running' : '';
  if (el.chip.hidden !== !chip) el.chip.hidden = !chip;
  if (chip && el.chip.textContent !== chip) el.chip.textContent = chip;
}

/** Re-reads the skin's mania column widths when the key count or skin changes (off the hot path). */
function followManiaSkin() {
  const keys = keyCount();
  const skin = typeof values?.[P.skin] === 'string' ? values[P.skin] : '';
  const key = `${skin}|${keys}`;
  if (key === maniaKey) return;
  maniaKey = key;
  maniaSkin(keys, skin).then(next => {
    if (maniaKey !== key) return;
    maniaGeometry = next;
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
  if (view === 'play' && changed.has(P.keys)) {
    clockNow();
    ingestKeys(v[P.keys]);
    kps.ingest(v[P.keys], v[P.live], ck[CK_RATE]);
  }

  // The map clock ticks constantly (song-select preview too); alone it only matters while the tape has content.
  if (changed.size === 1 && changed.has(P.live)) {
    if (view === 'play' && hasContent) kick();
    return;
  }
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
let fast = false;       // KPS above FAST_ON: press feedback snaps
let keepFrame = false;  // the canvas and caps still show the last play frame (kept while fading out)
let shownPeakValue = 0; // the peak the new-peak mark last answered
const kpsText = numberFormatter('kps');
const peakText = numberFormatter('kps');
let shownKps = '';
let shownPeak = '';
let shownEmpty = null;
// The new-peak mark: one Animation, restarted (never re-created) on each new peak.
const PEAK_KEYS = [{ opacity: 1 }, { opacity: 0 }];
const PEAK_TIMING = { duration: MOTION_MS.slow, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const peakFlash = el.peakMark.animate(PEAK_KEYS, PEAK_TIMING);
peakFlash.cancel();

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
 * tape (a mirrored transform puts the caps at the end); every fractional value comes from g.box.
 */
function render() {
  const g = geometry;
  const box = g.box;
  const now = ck[CK_NOW];
  const playing = view === 'play';
  const pxPerMs = (cfg.speed * g.u) / 1000 / ck[CK_RATE]; // gameplay ms → CSS px
  const dpr = g.dpr;
  let anyVisible = false;
  let anyHeld = false;
  // Leaving play: the block fades out on its last frame instead of blanking its counts mid-fade.
  if (!playing && keepFrame) { hasContent = false; return false; }
  keepFrame = playing;

  // Live keys per second (shared definition); it also decides whether press feedback may animate.
  const liveKps = playing ? kps.at(Math.floor(now)) : UNKNOWN;
  if (isKnown(liveKps)) {
    if (!fast && liveKps > FAST_ON) { fast = true; flag(root, 'data-fast', true); }
    else if (fast && liveKps < FAST_OFF) { fast = false; flag(root, 'data-fast', false); }
  }
  const settle = motion === 'full' && !fast;

  if (g.tape) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, box[BOX_W], box[BOX_H]);
    ctx.drawImage(staticLayer, 0, 0);
  }

  if (playing && g.tape) {
    if (g.flip) {
      if (g.v) ctx.setTransform(1, 0, 0, -1, 0, box[BOX_TAPE]);
      else ctx.setTransform(-1, 0, 0, 1, box[BOX_TAPE], 0);
    }
    const min = box[BOX_MIN];
    const edge = box[BOX_EDGE];
    const settleMap = SETTLE_MS * ck[CK_RATE]; // settle window in gameplay ms
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      const t = tracks[lane.src];
      if (!t || t.size === 0) continue;
      const across = box[BOX_LANES + 2 * li];
      const thick = box[BOX_LANES + 2 * li + 1];
      // History: every bar at rest, its press edge (the moment the key went down) crisp.
      ctx.fillStyle = lane.rest;
      for (let k = 0, i = t.head; k < t.size; k++) {
        i = i === 0 ? RING - 1 : i - 1;
        let end = t.ends[i];
        const held = Number.isNaN(end);
        if (held) { end = now; anyHeld = true; }
        const near = Math.max(0, (now - end) * pxPerMs);
        if (near >= g.tapeLen) break;
        const far = Math.min(g.tapeLen, Math.max(0, (now - t.starts[i]) * pxPerMs));
        anyVisible = true;
        const a = Math.round(near * dpr) | 0;
        const b = Math.round(far * dpr) | 0;
        ctx.globalAlpha = box[BOX_REST];
        if (b - a < min) {
          if (g.v) ctx.fillRect(across, a, thick, min); else ctx.fillRect(a, across, min, thick);
          ctx.globalAlpha = 1;
          if (g.v) ctx.fillRect(across, a, thick, min); else ctx.fillRect(a, across, min, thick);
        } else {
          if (g.v) ctx.fillRect(across, a, thick, b - a); else ctx.fillRect(a, across, b - a, thick);
          ctx.globalAlpha = 1;
          if (g.v) ctx.fillRect(across, b, thick, edge); else ctx.fillRect(b, across, edge, thick);
        }
      }
      // The present on top: a held key at full strength, a release settling to rest over SETTLE_MS.
      ctx.fillStyle = lane.hot;
      for (let k = 0, i = t.head; k < t.size; k++) {
        i = i === 0 ? RING - 1 : i - 1;
        let end = t.ends[i];
        let level = HEAT_STEPS;
        if (Number.isNaN(end)) end = now;
        else {
          const age = now - end;
          if (!settle || age >= settleMap) break;
          level = Math.ceil((1 - age / settleMap) * HEAT_STEPS) | 0;
          if (level <= 0) break;
        }
        const near = Math.max(0, (now - end) * pxPerMs);
        if (near >= g.tapeLen) break;
        const far = Math.min(g.tapeLen, Math.max(0, (now - t.starts[i]) * pxPerMs));
        const a = Math.round(near * dpr) | 0;
        let len = (Math.round(far * dpr) | 0) - a;
        if (len < min) len = min;
        ctx.globalAlpha = box[BOX_HEAT + level];
        if (g.v) ctx.fillRect(across, a, thick, len); else ctx.fillRect(a, across, len, thick);
      }
    }
  }
  ctx.globalAlpha = 1;

  // Caps: pressed state and counts, written only when they change.
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    const t = tracks[lane.src];
    const down = playing && t ? t.pressed : false;
    if (down !== lane.shownDown) { lane.shownDown = down; lane.cap.toggleAttribute('data-down', down); }
    const text = playing && t && baselined ? t.format(t.count) : t ? t.format(UNKNOWN) : '—';
    if (text !== lane.shownText) {
      const wasDash = lane.shownText === '—';
      lane.shownText = text;
      lane.countEl.textContent = text;
      if ((text === '—') !== wasDash) lane.countEl.toggleAttribute('data-dash', text === '—');
    }
  }

  if (cfg.showKps && (dirty || playing)) updateReadout(playing && baselined ? liveKps : UNKNOWN);
  if (dirty) updateNote();

  hasContent = playing && ((g.tape && (anyVisible || anyHeld)) || liveKps > 0);
  return hasContent && clock.running && !clock.paused;
}

/** Live KPS and the attempt's peak (DASH while unknown); a new peak gets the amber mark. */
function updateReadout(liveKps) {
  const known = isKnown(liveKps);
  const live = kpsText(liveKps);
  if (live !== shownKps) { shownKps = live; el.kps.textContent = live; }
  // No measured press yet (attached mid-attempt, or nothing pressed): the peak is unknown, not 0.
  const peakValue = known && kps.peak > 0 ? kps.peak : UNKNOWN;
  const peak = peakText(peakValue);
  if (peak !== shownPeak) { shownPeak = peak; el.peak.textContent = peak; flag(el.peak, 'data-dash', !isKnown(peakValue)); }
  if (known !== shownEmpty) { shownEmpty = known; flag(el.read, 'data-empty', !known); }
  if (known && kps.peak > shownPeakValue) {
    shownPeakValue = kps.peak;
    const now = ck[CK_NOW];
    if (motion === 'full' && kps.peak >= PEAK_MIN && now - ck[CK_FLASH] >= PEAK_QUIET * ck[CK_RATE]) {
      ck[CK_FLASH] = now;
      peakFlash.currentTime = 0;
      peakFlash.play();
    }
  }
}

/** One short line when the vosu key feed is missing during play. */
function updateNote() {
  const missing = view === 'play' && !Array.isArray(values[P.keys]);
  if (el.note.hidden === missing) el.note.hidden = !missing;
  if (missing && !el.note.textContent) el.note.textContent = 'No key data. Turn on ENABLE_KEY_OVERLAY in vosu.';
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
  motion = applyKitSettings(root, cfg);
  cfg.backing = root.dataset.backing;
  if (motion !== 'full') peakFlash.cancel();
  cfgKey = JSON.stringify(cfg);
  signature = '';
  if (values) { syncLayout(); updateVisibility(); }
  dirty = true;
  kick();
});

subscribe(Object.values(P), onFrame, { onStatus });

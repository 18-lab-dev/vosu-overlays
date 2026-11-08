// Copyright (c) 2026 18-LAB. MIT.
// Key overlay: one scrolling tape lane per logical key (vosu `keys.all`), key caps with counts,
// live and peak keys per second. Bars are placed in gameplay time from pressedAt/releasedAt.
import { subscribe, settings, fit, activeMode, MODE_LABELS } from './vosu-overlay.js';

const W = 480;
const H = 640;
const GAP = 4;          // between lanes
const RULER = 10;       // time ruler beside the tape
const INSET = 3;        // bar inset inside its lane
const RING = 256;       // remembered presses per lane
const KPS_RING = 2048;  // remembered press times across lanes
const MAX_STEP = 8;     // most presses one key can gain between two samples before it counts as missed data
const UP_CHROME = 96;   // panel height minus tape length (up)
const RIGHT_TAPE = W - 2 - 16 - 64 - 8; // tape length (right)
const RIGHT_CHROME = 2 + 28 + 1 + 8 + RULER + 8 + 1; // panel height minus lane block (right), without the rail
const EXTRAPOLATE = 100; // ms of wall time the clock may run past its last sample
const SMOKE = '#b8b5ad';

const DEFAULTS = {
  direction: 'up', speed: 600, laneWidth: 48, showCounts: true, showKps: true, smokeLane: false,
  colorOsu: '#ff963f', colorDon: '#ef6a4f', colorKat: '#7fa6cf', colorFruits: '#6fbf8e', colorMania: '#ebe8e1',
  showBrand: true,
};

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', client: '/client',
  source: '/play/source', keys: '/keys/all', live: '/beatmap/time/live', rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate', paused: '/game/paused', cs: '/beatmap/stats/cs/converted',
  osuK1: '/settings/keybinds/osu/k1', osuK2: '/settings/keybinds/osu/k2', osuSmoke: '/settings/keybinds/osu/smokeKey',
  taikoOL: '/settings/keybinds/taiko/outerLeft', taikoIL: '/settings/keybinds/taiko/innerLeft',
  taikoIR: '/settings/keybinds/taiko/innerRight', taikoOR: '/settings/keybinds/taiko/outerRight',
  catchK1: '/settings/keybinds/fruits/k1', catchK2: '/settings/keybinds/fruits/k2', catchDash: '/settings/keybinds/fruits/Dash',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const capsEl = $('caps');
const el = {
  brand: $('brand'), mode: $('mode'), state: $('state'), stateText: $('state-text'), note: $('note'),
  rail: $('rail'), kpsLabel: $('kps-label'), kps: $('kps'), peak: $('peak'), fill: $('fill'), tick: $('tick'),
  scaleMax: $('scale-max'), scaleMid: $('scale-mid'), chip: $('chip'), chipText: $('chip-text'),
};
fit(stage, W, H);

let cfg = { ...DEFAULTS };
let values = null;
let status = 'connecting';

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
  if (plain.length * 6.2 <= room) return plain;
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

// ------------------------------------------------------------------ lanes / layout
let lanes = [];         // { src, label, color, cap, lit, labelEl, countEl, room, shownPressed, shownCount }
let geometry = null;
let signature = '';
let currentMode = null;
let builtMode = null;  // ruleset the current lanes were built for (the header follows it through a fade)
let swapTimer = 0;
let view = 'none';      // 'play' | 'results' | 'idle' | 'nogame' | 'none'
let results = null;     // { avg, peak } held at the results screen

function modeColor(mode) {
  return mode === 'osu' ? cfg.colorOsu : mode === 'taiko' ? cfg.colorDon : mode === 'fruits' ? cfg.colorFruits : cfg.colorMania;
}

function laneSpec(mode) {
  const v = values;
  const list = Array.isArray(v[P.keys]) && view === 'play' ? v[P.keys] : null;
  const bind = pointer => keyLabel(v[pointer]);
  if (mode === 'osu') {
    const spec = [
      { src: 0, label: bind(P.osuK1) ?? 'K1', color: cfg.colorOsu },
      { src: 1, label: bind(P.osuK2) ?? 'K2', color: cfg.colorOsu },
    ];
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
    const moves = v[P.client] === 'lazer' || tracks[0]?.ever || tracks[1]?.ever;
    const dash = { src: 2, label: bind(P.catchDash) ?? 'DASH', color: cfg.colorFruits };
    return moves
      ? [{ src: 0, label: bind(P.catchK1) ?? '←', color: cfg.colorFruits }, { src: 1, label: bind(P.catchK2) ?? '→', color: cfg.colorFruits }, dash]
      : [dash];
  }
  let n = list ? list.length : Math.round(Number(v[P.cs]));
  if (!Number.isFinite(n) || n < 1 || n > 20) n = 4;
  const spec = [];
  for (let i = 0; i < n; i++) spec.push({ src: i, label: String(i + 1), color: cfg.colorMania });
  return spec;
}

function computeGeometry(n) {
  const kps = cfg.showKps;
  const up = cfg.direction !== 'right';
  const want = Math.round(Math.min(96, Math.max(16, cfg.laneWidth)));
  let w;
  if (up) {
    const room = W - 2 - 16 - RULER - (kps ? 8 + 64 : 0);
    w = Math.min(want, Math.floor((room - (n - 1) * GAP) / n));
    // Short lane sets widen so the header always fits (a single catch dash reads as a wide bar).
    const min = kps ? 120 : 176;
    if (n * w + (n - 1) * GAP < min) w = Math.ceil((min - (n - 1) * GAP) / n);
  } else {
    const room = H - RIGHT_CHROME - (kps ? 36 + 4 : 0);
    w = Math.min(want, Math.floor((room - (n - 1) * GAP) / n));
  }
  w = Math.max(10, w);
  const block = n * w + (n - 1) * GAP;
  const tape = up ? H - UP_CHROME : RIGHT_TAPE;
  const cssW = up ? RULER + block : tape;
  const cssH = up ? tape : block + RULER;
  const pos = new Float64Array(n);
  for (let i = 0; i < n; i++) pos[i] = (up ? RULER : 0) + i * (w + GAP);
  return { up, n, w, block, tape, cssW, cssH, pos, dpr: 0 };
}

function buildLanes(mode) {
  builtMode = mode;
  const spec = laneSpec(mode);
  geometry = computeGeometry(spec.length);
  const g = geometry;
  attr(panel, 'data-dir', g.up ? 'up' : 'right');
  attr(panel, 'data-kps', cfg.showKps ? '1' : '0');
  attr(panel, 'data-counts', cfg.showCounts ? '1' : '0');
  panel.style.setProperty('--w', `${g.w}px`);
  panel.style.setProperty('--c', modeColor(mode));
  if (g.up) { panel.style.width = ''; } else { panel.style.width = `${W}px`; }
  canvas.style.width = `${g.cssW}px`;
  canvas.style.height = `${g.cssH}px`;
  el.brand.hidden = !cfg.showBrand;

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
    const room = g.up ? g.w - 6 : 58;
    if (s.label.length * 7.8 > room) cap.classList.add('small');
    if (!g.up && g.w < 30) cap.classList.add('tight');
    frag.append(cap);
    return { ...s, cap, lit, labelEl, countEl, shownPressed: false, shownCount: null, room };
  });
  capsEl.replaceChildren(frag);
  resizeCanvas();
}

function resizeCanvas() {
  if (!geometry) return;
  const dpr = window.devicePixelRatio || 1;
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

/** Rebuilds lanes when their structure changes; a ruleset change fades the panel out and back. */
function syncLayout() {
  const mode = currentMode;
  if (!mode) return;
  const spec = laneSpec(mode);
  const sig = [mode, cfg.direction, cfg.laneWidth, cfg.showKps, cfg.showCounts, cfg.showBrand,
    ...spec.map(s => `${s.src}:${s.label}:${s.color}`)].join('|');
  if (sig === signature) return;
  const modeChanged = !signature.startsWith(`${mode}|`);
  const wasShown = signature !== '' && panel.getAttribute('data-show') === '1';
  signature = sig;
  if (modeChanged && wasShown) {
    attr(panel, 'data-show', '0');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => { swapTimer = 0; buildLanes(currentMode); dirty = true; updateVisibility(); kick(); }, 180);
  } else if (!swapTimer) {
    buildLanes(mode);
  }
  dirty = true;
}

// ------------------------------------------------------------------ state
let shownOnce = false;
function updateVisibility() {
  const show = status === 'live' && view !== 'none' && geometry !== null && !swapTimer;
  attr(panel, 'data-show', show ? '1' : '0');
  // The first appearance is immediate; later ruleset changes and disconnects fade.
  if (show && !shownOnce) { shownOnce = true; setTimeout(() => panel.removeAttribute('data-instant'), 400); }
}

const SOURCES = { player: 'Live', replay: 'Replay', spectator: 'Spectate', autoplay: 'Auto', watching: 'Watch' };

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
  const clockOnly = changed.size === 1 && changed.has(P.live);
  if (clockOnly) {
    if (view === 'play' && hasContent) kick();
    return;
  }
  currentMode = activeMode(state, v[P.playMode], v[P.settingsMode]) ?? (view === 'nogame' ? 'osu' : null);
  syncLayout();
  updateVisibility();
  dirty = true;
  kick();
}

function closeOpen() {
  for (const t of tracks) {
    if (!t || !t.open) continue;
    const last = (t.head + RING - 1) % RING;
    t.ends[last] = Math.max(t.starts[last], clockAt(performance.now()));
    t.open = false;
  }
}

// ------------------------------------------------------------------ render (rAF only)
let raf = 0;
let dirty = true;
let hasContent = false; // the tape shows presses (or KPS is non-zero) that move with the clock
let lastLiveKps = -1;
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

function niceMax(peak) { return Math.max(10, Math.ceil((peak * 1.15) / 10) * 10); }

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
        drawBar(g, lane, li, near, far, held);
      }
    }
  } else if (view === 'results') {
    drawBalance(g);
  }
  ctx.globalAlpha = 1;

  // Caps: strings are only built when a count changes.
  const counting = playing || view === 'results';
  for (const lane of lanes) {
    const t = tracks[lane.src];
    const pressed = playing && t ? t.pressed : false;
    if (pressed !== lane.shownPressed) { lane.shownPressed = pressed; lane.lit.style.opacity = pressed ? '1' : '0'; }
    const count = counting && t ? t.count : -1;
    if (count !== lane.shownCount) { lane.shownCount = count; lane.countEl.textContent = count < 0 ? '—' : formatCount(count, lane.room); }
  }

  const liveKps = playing && (baselined || totalPresses) ? countWindow(now, 1000 * rate) : -1;
  if (cfg.showKps && (dirty || liveKps !== lastLiveKps)) updateRail(liveKps);
  lastLiveKps = liveKps;
  if (dirty) updateChrome();

  hasContent = playing && (anyVisible || anyHeld || liveKps > 0);
  return hasContent && clock.running && !clock.paused;
}

/** KPS readout and meter; liveKps is -1 when there is no live figure. */
function updateRail(liveKps) {
  const up = geometry.up;
  let main = '—';
  let peak = '—';
  let fill = 0;
  let peakValue = 0;
  if (liveKps >= 0) {
    main = String(liveKps);
    peak = String(peakKps);
    peakValue = peakKps;
    fill = liveKps;
  } else if (view === 'results' && results) {
    main = results.avg === null ? '—' : results.avg.toFixed(1);
    if (totalPresses) { peak = String(results.peak); peakValue = results.peak; }
    fill = results.avg ?? 0;
  }
  const scale = niceMax(peakValue);
  text(el.kpsLabel, view === 'results' ? 'Avg' : 'KPS');
  text(el.kps, main);
  text(el.peak, peak);
  text(el.scaleMax, String(scale));
  text(el.scaleMid, String(scale / 2));
  attr(el.rail, 'data-empty', peak === '—' ? '1' : '0');
  const f = Math.min(1, fill / scale).toFixed(4);
  el.fill.style.transform = up ? `scaleY(${f})` : `scaleX(${f})`;
  const p = Math.min(100, (peakValue / scale) * 100);
  el.tick.style.transform = up ? `translateY(${(-p).toFixed(2)}%)` : `translateX(${(p - 100).toFixed(2)}%)`;
}

/** Header and notice: only on data/settings changes, never per animation frame. */
function updateChrome() {
  const v = values;
  const mode = builtMode;
  let label = mode ? MODE_LABELS[mode] : '—';
  if (mode === 'mania' && lanes.length) label += ` ${lanes.length}K`;
  if (view === 'nogame') label = '—';
  text(el.mode, label);
  let state = 'Idle';
  let tone = 'idle';
  if (view === 'play') { state = clock.paused ? 'Paused' : SOURCES[v[P.source]] ?? 'Live'; tone = clock.paused ? 'hold' : 'live'; }
  else if (view === 'results') { state = 'Result'; tone = 'hold'; }
  else if (view === 'idle') state = 'Select';
  else if (view === 'nogame') state = 'No game';
  text(el.stateText, state);
  attr(el.state, 'data-tone', tone);
  // One short line when the vosu key feed is missing during play.
  const missing = view === 'play' && !Array.isArray(v[P.keys]);
  if (el.note.hidden === missing) el.note.hidden = !missing;
  if (missing) text(el.note, 'No key data · enable ENABLE_KEY_OVERLAY in vosu');
}

function snap(value) { const d = geometry.dpr || 1; return Math.round(value * d) / d; }

function drawLaneBeds(g) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(235,232,225,0.035)';
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
  ctx.fillStyle = '#4a4f57';
  for (let k = 1; k * minor <= g.tape; k++) {
    const d = snap(k * minor);
    const len = k % every === 0 ? 7 : 3;
    if (g.up) ctx.fillRect(RULER - 2 - len, g.tape - d, len, 1);
    else ctx.fillRect(d, g.block + 2, 1, len);
  }
  if (g.up) ctx.fillRect(RULER - 2, 0, 1, g.tape);
  else ctx.fillRect(0, g.block + 2, g.tape, 1);
}

function drawBar(g, lane, li, near, far, held) {
  const a = snap(near);
  let b = snap(far);
  if (b - a < 2) b = a + 2;
  const across = g.pos[li] + INSET;
  const thick = g.w - INSET * 2;
  ctx.globalAlpha = held ? 0.86 : 0.68;
  if (g.up) ctx.fillRect(across, g.tape - b, thick, b - a);
  else ctx.fillRect(a, across, b - a, thick);
  // Press edge: the moment the key went down, crisp at full strength.
  ctx.globalAlpha = 1;
  const edge = Math.min(2, b - a);
  if (g.up) ctx.fillRect(across, g.tape - b, thick, edge);
  else ctx.fillRect(b - edge, across, edge, thick);
}

/** Results: each lane's share of all presses, as a static balance chart. */
function drawBalance(g) {
  let max = 0;
  let sum = 0;
  for (const lane of lanes) { const c = tracks[lane.src]?.count ?? 0; if (c > max) max = c; sum += c; }
  if (!max) return;
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    const c = tracks[lane.src]?.count ?? 0;
    const len = snap((g.tape * 0.62) * (c / max));
    const across = g.pos[li] + INSET;
    const thick = g.w - INSET * 2;
    ctx.fillStyle = lane.color;
    ctx.globalAlpha = 0.28;
    if (g.up) ctx.fillRect(across, g.tape - len, thick, len);
    else ctx.fillRect(0, across, len, thick);
    ctx.globalAlpha = 1;
    if (g.up) ctx.fillRect(across, g.tape - len, thick, 2);
    else ctx.fillRect(len - 2, across, 2, thick);
    ctx.fillStyle = '#b8b5ad';
    const share = `${Math.round((c / sum) * 100)}%`;
    if (g.up) ctx.fillText(share, g.pos[li] + g.w / 2, g.tape - len - 7);
    else { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(share, len + 7, g.pos[li] + g.w / 2 + 0.5); }
  }
}

// ------------------------------------------------------------------ status chip
function onStatus(next) {
  status = next;
  attr(el.chip, 'data-state', next);
  text(el.chipText, next === 'live' ? 'Live' : next === 'offline' ? 'vosu offline' : 'Connecting');
  updateVisibility();
}

// ------------------------------------------------------------------ settings
settings(DEFAULTS, next => {
  const speed = Math.min(3000, Math.max(100, Number(next.speed) || DEFAULTS.speed));
  cfg = { ...next, speed, direction: next.direction === 'right' ? 'right' : 'up' };
  signature = '';
  if (values) { syncLayout(); updateVisibility(); }
  dirty = true;
  kick();
});

subscribe(Object.values(P), onFrame, { onStatus });

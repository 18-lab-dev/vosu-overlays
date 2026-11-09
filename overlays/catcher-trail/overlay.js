// Copyright (c) 2026 18-LAB. MIT.
// Catcher trail: the path the osu!catch catcher took over the last seconds, from vosu's
// /play/catcher {x, dashing}. The game shows where the catcher is; the trail shows how it got
// there: dashes in amber, every miss pinned in red where the catcher was when it happened, kiai
// stretches shaded in the map's tone. The page is the overlay's box; the layout re-flows to its shape.
import {
  subscribe, settings, activeMode, isPlaying, mapPalette, applyPalette, applyKitSettings,
  known, numberFormatter, DASH, MOTION_MS,
} from './vosu-overlay.js';

const PLAYFIELD = 512;           // catcher x range in osu! pixels
const WIDE = 1.8;                // auto orientation: boxes at least this wide lay out horizontally
const RESULTS = 7;
const GRACE = 1500;              // ms of catch play without /play/catcher before naming vosu
const EXTRAPOLATE = 100;         // ms the head may run past the newest sample (hides frame jitter)
const SETTLE = 160;              // ms without samples before the loop parks (pause, results)
const TURN = 8;                  // px of reversal before a direction change counts
const STATS_EVERY = 250;         // readout refresh, ms
const CAP = 4096;                // trace ring; the sampling floor keeps 30 s under ~2.5k samples
const MASK = CAP - 1;
const MISS_CAP = 64;             // miss pins remembered (a window rarely holds more than a few)
const KIAI_CAP = 8;              // kiai stretches remembered
// Dash share, shared with catcher-heatmap so the two agree: gameplay time between the first and
// last object outside breaks, segments of at most MAX_STEP map ms, a clock jump back of more
// than RETRY_JUMP map ms is a new attempt.
const MAX_STEP = 3000;
const RETRY_JUMP = 1500;

const TAU = Math.PI * 2;

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  catcher: '/play/catcher', time: '/beatmap/time/live', rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate', brk: '/beatmap/isBreak', kiai: '/beatmap/isKiai', checksum: '/beatmap/checksum',
  first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', miss: '/play/hits/0',
  cs: '/beatmap/stats/cs/converted',
};

const root = document.getElementById('root');
const canvas = document.getElementById('trace');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  chip: document.getElementById('chip'), dashRow: document.getElementById('dash-row'), span: document.getElementById('span'),
  dash: document.getElementById('dash'), finalBlock: document.getElementById('final'),
  finalDash: document.getElementById('final-dash'), finalTurns: document.getElementById('final-turns'),
};
const fmt = { dash: numberFormatter('percent'), finalDash: numberFormatter('percent'), finalTurns: numberFormatter('count') };

// ---------------------------------------------------------------- colours (kit roles)
const css = getComputedStyle(document.documentElement);
/** A kit role as #rrggbb (the canvas normalises any CSS colour it accepts). */
function role(name, fallback) {
  ctx.fillStyle = fallback;
  ctx.fillStyle = css.getPropertyValue(name).trim() || fallback;
  return ctx.fillStyle;
}
const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${a})`;
};
const C = {
  text1: role('--text-1', '#efece5'), text2: role('--text-2', '#d3cfc6'),
  you: role('--you', '#ff963f'), miss: role('--j-miss', '#ef5b4f'),
};
const INK = {
  edge: alpha(C.text1, 0.4),     // --hair-strong: playfield edges, the "now" line
  centre: alpha(C.text1, 0.22),  // --hair: playfield centre
  halo: 'rgb(0 0 0 / .55)',
};
let mapTone = '#c9c4ba';         // kiai stretches on the playfield edges: --map, re-read when it changes
let kiaiW = 2;
let palette = null, paletteFor = '';
const CHIP = { offline: 'vosu offline', nodata: 'No data' };

// ---------------------------------------------------------------- state
const DEFAULTS = {
  orientation: 'auto', align: 'right', window: 6, showDash: true, showOnResults: true,
  motion: 'full', backing: 'scrim', mapTint: true,
};
let opts = { ...DEFAULTS };
let motion = 'full';
let spanText = '';
let status = 'connecting';
let view = 'connecting';
let viewDirty = true, layoutDirty = true, statsDirty = true, raf = 0;
let wasPlaying = false;
let missingSince = 0;
let graceTimer = 0;
// The fields evaluate() reads, copied from the newest frame (the client reuses its values object).
let framed = false, state, playMode, selMode, hasCatcher = false, checksum;
let orient = 'vertical', laneLeft = false, unit = 1;   // box layout (layoutBox)
let dpr = 1, cssW = 0, cssH = 0, plotLen = 0, span = 0, line = 1;   // canvas geometry (measure)
let traceInk = null, dashInk = null, haloInk = null;  // age gradients (buildInks)

// Geometry that only moves with the box (measure), in logical "vertical" coordinates: u across
// (playfield), v along (time, 0 = oldest). Whole pixels, so the per-frame passes hand the canvas
// small integers (a computed double passed to a canvas call is a heap allocation until the pass
// reaches the optimising tier).
let edge1 = 0, centreU = 0, tickLen = 4, plateTop = 0, plateH = 4, plateW = 0;
let traceW = 1.75, haloW = 4.5, dashW = 2.5, pinR = 3.5, ringR = 15, pinLine = 1.5, ringLine = 2;
// The visible trace, filled by the trace pass and replayed by the dash pass.
const pathU = new Float64Array(CAP), pathV = new Float64Array(CAP);

// Trace ring (decimated) and attempt statistics (every sample).
const ringT = new Float64Array(CAP), ringX = new Float32Array(CAP), ringD = new Uint8Array(CAP);
let ringHead = 0, ringCount = 0;
let sampled = false, lastD = false;   // whether lastT/lastX hold a sample; newest dash flag
let pushD = 0, pendD = 0, pending = false;
let turns = 0, dir = 0;
let hasPrev = false, prevDash = false;   // dash-share segment start
// Miss pins: gameplay time (wall-clock scale), catcher x, and the page time they arrived (flash).
const missT = new Float64Array(MISS_CAP), missX = new Float32Array(MISS_CAP), missWall = new Float64Array(MISS_CAP);
let missHead = 0, missCount = 0, missesSeen = -1;
// Kiai stretches (gameplay time, wall-clock scale); the open one ends at +Infinity, unused slots
// span -Infinity (zero height), so the kiai pass runs its whole body from the first frame.
const kiaiFrom = new Float64Array(KIAI_CAP).fill(-Infinity), kiaiTo = new Float64Array(KIAI_CAP).fill(-Infinity);
let kiaiHead = 0, kiaiCount = 0, kiaiOn = false;
// Doubles written per sample or frame live in object fields: V8 updates a double field in place,
// while every store to a module-level `let` allocates a new heap number.
const num = {
  lastT: 0, lastX: 0,                 // newest sample
  pushT: 0, pushX: 0,                 // newest stored sample
  pendT: 0, pendX: 0,                 // newest unstored sample
  sampleWall: 0, headT: -Infinity, statsAt: 0, flashUntil: 0,
  activeMs: 0, dashMs: 0, extreme: 0,
  prevMs: 0,                          // dash-share segment start, map ms
  cs: NaN,
};

function resetAttempt() {
  ringHead = 0; ringCount = 0; sampled = false; pending = false; num.headT = -Infinity;
  num.activeMs = 0; num.dashMs = 0; turns = 0; dir = 0; hasPrev = false;
  missHead = 0; missCount = 0; missesSeen = -1;
  kiaiHead = 0; kiaiCount = 0; kiaiOn = false; kiaiFrom.fill(-Infinity); kiaiTo.fill(-Infinity);
  statsDirty = true;
}

function store(t, x, d) {
  ringT[ringHead] = t; ringX[ringHead] = x; ringD[ringHead] = d;
  ringHead = (ringHead + 1) & MASK;
  if (ringCount < CAP) ringCount++;
  num.pushT = t; num.pushX = x; pushD = d; pending = false;
}

/** One trace sample at gameplay time t (wall-clock scale): direction changes and the decimated ring. */
function ingest(t, x, dashing, now) {
  const d = dashing ? 1 : 0;
  if (!sampled) {
    num.extreme = x;
    store(t, x, d);
  } else {
    const dt = t - num.lastT;
    if (dt >= 0 && dt < 250) {
      const extreme = num.extreme;
      if (dir === 0) {
        if (Math.abs(x - extreme) > TURN) { dir = x > extreme ? 1 : -1; num.extreme = x; }
      } else if (dir === 1) {
        if (x > extreme) num.extreme = x;
        else if (extreme - x > TURN) { turns++; dir = -1; num.extreme = x; }
      } else if (x < extreme) num.extreme = x;
      else if (x - extreme > TURN) { turns++; dir = 1; num.extreme = x; }
    }
    // Store about two samples per pixel of a ~600 px plot, but never shave a turning point or a
    // dash edge: a pending sample that was an extreme is stored before it is superseded.
    const gap = Math.max(4, (opts.window * 1000) / 1200);
    if (pending && (x - num.pendX) * (num.pendX - num.pushX) < 0) store(num.pendT, num.pendX, pendD);
    if (t - num.pushT >= gap || d !== pushD) store(t, x, d);
    else { num.pendT = t; num.pendX = x; pendD = d; pending = true; }
  }
  num.lastT = t; num.lastX = x; lastD = dashing; sampled = true;
  num.sampleWall = now;
}

/**
 * Dash share segment ending at map time ms (catcher-heatmap's rule, so both overlays show the same
 * figure). Returns true when the clock jumped back far enough to be a new attempt.
 */
function dashSegment(ms, dashing, inBreak, first, last) {
  const dt = ms - num.prevMs;
  let retry = false;
  if (!hasPrev || !(dt <= MAX_STEP)) {
    // first sample, or a gap too long (seek, hitch): resync
  } else if (dt < -RETRY_JUMP) {
    retry = true;
  } else if (dt > 0) {
    const mid = num.prevMs + dt / 2;
    const inMap = (typeof first !== 'number' || mid >= first) && (typeof last !== 'number' || last <= 0 || mid <= last);
    if (inMap && !inBreak) { num.activeMs += dt; num.dashMs += dt * (prevDash ? 1 : 0); }
  } else if (dt === 0) {
    return false;                // moved within one clock tick; the next tick carries the segment
  }
  num.prevMs = ms; prevDash = dashing; hasPrev = true;
  return retry;
}

function pinMiss(now) {
  missT[missHead] = num.lastT; missX[missHead] = num.lastX; missWall[missHead] = now;
  missHead = (missHead + 1) % MISS_CAP;
  if (missCount < MISS_CAP) missCount++;
  if (motion === 'full') num.flashUntil = now + MOTION_MS.base;
}

function kiaiEdge(on, t) {
  if (on) {
    kiaiFrom[kiaiHead] = t; kiaiTo[kiaiHead] = Infinity;
    kiaiHead = (kiaiHead + 1) % KIAI_CAP;
    if (kiaiCount < KIAI_CAP) kiaiCount++;
  } else if (kiaiCount) kiaiTo[(kiaiHead + KIAI_CAP - 1) % KIAI_CAP] = t;
  kiaiOn = on;
}

// ---------------------------------------------------------------- motion
// Results: the final readouts rise into place once (an Animation created once and restarted).
const REVEAL_KEYS = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];
const REVEAL_OPTS = { duration: MOTION_MS.base, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' };
const reveal = el.finalBlock.animate(REVEAL_KEYS, REVEAL_OPTS);
reveal.cancel();
function revealFinal() {
  if (motion === 'off') return;
  reveal.currentTime = 0;
  reveal.play();
}

// ---------------------------------------------------------------- data
subscribe(Object.values(P), (values, changed) => {
  const now = performance.now();
  framed = true;
  state = values[P.state]; playMode = values[P.playMode]; selMode = values[P.selMode];
  const catcher = values[P.catcher];
  hasCatcher = !!catcher;
  const playing = isPlaying(state) && activeMode(state, playMode, selMode) === 'fruits';
  if (playing && !wasPlaying) resetAttempt();
  wasPlaying = playing;
  if (changed.has(P.checksum)) {
    const next = values[P.checksum] || '';
    if (checksum !== undefined && next !== checksum) resetAttempt();
    checksum = next; loadPalette();
  }
  if (changed.has(P.cs)) { num.cs = known(values[P.cs]); plateWidth(); }

  const live = values[P.time];
  if (!playing || !catcher || typeof catcher.x !== 'number' || typeof live !== 'number') hasPrev = false;
  else if (changed.has(P.catcher) || changed.has(P.time)) {
    const x = Math.min(PLAYFIELD, Math.max(0, catcher.x));
    const dashing = catcher.dashing === true;
    if (dashSegment(live, dashing, values[P.brk] === true, values[P.first], values[P.last])) {
      resetAttempt();
      num.prevMs = live; prevDash = dashing; hasPrev = true;
    }
    const rate = values[P.rate] > 0 ? values[P.rate] : values[P.modsRate] > 0 ? values[P.modsRate] : 1;
    const t = live / rate;                       // gameplay ms on the wall-clock scale
    ingest(t, x, dashing, now);
    const kiai = values[P.kiai] === true;
    if (kiai !== kiaiOn) kiaiEdge(kiai, t);
    const misses = values[P.miss];
    if (typeof misses === 'number') {
      if (missesSeen >= 0 && misses > missesSeen) pinMiss(now);
      missesSeen = misses;
    }
    kick();
  }
  evaluate(now);
}, {
  onStatus: s => {
    if (s === 'connecting' && status === 'offline') return;   // retries stay "offline" until live
    status = s;
    if (s !== 'live') setView(s);
  },
});

/** Decides what shows; called per data frame and once more when the grace period ends. */
function evaluate(now) {
  if (!framed || status !== 'live') return;
  const mode = activeMode(state, playMode, selMode);
  let next = 'hidden';                          // song select, menus, other rulesets: nothing
  if (mode === null) next = 'nodata';
  else if (mode === 'fruits' && isPlaying(state)) {
    if (hasCatcher || ringCount) { next = 'live'; missingSince = 0; }
    else {
      // vosu publishes the catcher from the first precise poll; tosu never does.
      if (!missingSince) { missingSince = now; clearTimeout(graceTimer); graceTimer = setTimeout(() => evaluate(performance.now()), GRACE + 10); }
      if (now - missingSince >= GRACE) next = 'missing';
    }
  } else if (mode === 'fruits' && state === RESULTS && ringCount && opts.showOnResults) next = 'final';
  if (!isPlaying(state)) missingSince = 0;
  setView(next);
}

function setView(next) {
  if (next === view) return;
  const entering = next === 'final';
  view = next; viewDirty = true; statsDirty = true;
  if (entering) revealFinal();
  kick();
}

// ---------------------------------------------------------------- map tone
function loadPalette() {
  if (!checksum) { setPalette(null); return; }
  if (checksum === paletteFor) { setPalette(palette); return; }
  const wanted = paletteFor = checksum;
  mapPalette(wanted).then(result => {
    if (paletteFor !== wanted) return;
    palette = result;
    setPalette(result);
  });
}

/** --map follows the palette (or stays neutral with mapTint off); the canvas reads it back here. */
function setPalette(result) {
  applyPalette(root, result);
  readMap();
}

function readMap() {
  const tone = getComputedStyle(root).getPropertyValue('--map').trim() || '#c9c4ba';
  ctx.fillStyle = '#c9c4ba';
  ctx.fillStyle = tone;
  if (ctx.fillStyle === mapTone) return;
  mapTone = ctx.fillStyle;
  kick();
}

// ---------------------------------------------------------------- settings
settings(DEFAULTS, s => {
  const w = Math.round(Math.min(30, Math.max(2, Number(s.window) || DEFAULTS.window)));
  opts = {
    orientation: ['vertical', 'horizontal'].includes(s.orientation) ? s.orientation : 'auto',
    align: s.align === 'left' ? 'left' : 'right',
    window: w,
    showDash: s.showDash !== false, showOnResults: s.showOnResults !== false,
    motion: s.motion, backing: s.backing, mapTint: s.mapTint,
  };
  motion = applyKitSettings(root, opts);
  if (motion !== 'full') num.flashUntil = 0;
  spanText = `last ${w} s`;
  viewDirty = true;
  readMap();
  if (framed) evaluate(performance.now());
  layoutBox();
});

// ---------------------------------------------------------------- box layout
/** Orientation from the box's aspect (or the setting) and the kit unit from its size. */
function layoutBox() {
  const w = innerWidth || 256, h = innerHeight || 264;
  orient = opts.orientation === 'auto' ? (w / h >= WIDE ? 'horizontal' : 'vertical') : opts.orientation;
  laneLeft = orient === 'horizontal';
  // 1 at the slot's 256×264 column; wide boxes are laid out for 560×120.
  const k = orient === 'vertical' ? Math.min(w / 256, h / 264) : Math.min(h / 120, w / 560);
  unit = Math.round(Math.min(1.6, Math.max(0.75, k)) * 100) / 100;
  layoutDirty = true;
  measure();
  kick();
}
addEventListener('resize', layoutBox);

// ---------------------------------------------------------------- canvas geometry
function plateWidth() {
  // Catch range: 106.75 osu! px at CS 5, scaled by CS, of which 80 % catches (as osu! and catcher-heatmap).
  const cs = known(num.cs) ? num.cs : 4;
  plateW = Math.round(Math.max(6 * unit, (106.75 * (1 - 0.7 * (cs - 5) / 5) * 0.8 / PLAYFIELD) * span));
  kick();
}

function measure() {
  if (!cssW) return;
  dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const vertical = orient === 'vertical';
  const k = unit;
  // The band past the "now" line holds the catcher plate.
  const band = Math.round(12 * k);
  span = Math.max(1, Math.round(vertical ? cssW : cssH));
  plotLen = Math.max(1, Math.round(vertical ? cssH : cssW) - band);
  line = Math.max(1, Math.round(dpr)) / dpr;   // one device pixel (two on 1.5× screens)
  edge1 = span - 1; centreU = Math.round(span / 2);
  tickLen = Math.round(4 * k);
  plateH = Math.max(3, Math.round(4 * k));
  plateTop = plotLen + Math.round(5 * k);
  traceW = 1.75 * k; haloW = 4.5 * k; dashW = 2.5 * k; pinR = 3.5 * k; ringR = 15 * k;
  pinLine = 1.5 * k; ringLine = 2 * k; kiaiW = Math.max(2, Math.round(2 * k));
  plateWidth();
  buildInks();
  kick();
}

/** Age gradients along the time axis (logical v), rebuilt on resize only. */
function buildInks() {
  traceInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  traceInk.addColorStop(0, alpha(C.text2, 0));
  traceInk.addColorStop(0.45, alpha(C.text2, 0.6));
  traceInk.addColorStop(1, alpha(C.text2, 0.95));
  dashInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  dashInk.addColorStop(0, alpha(C.you, 0));
  dashInk.addColorStop(0.4, alpha(C.you, 0.75));
  dashInk.addColorStop(1, C.you);
  haloInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  haloInk.addColorStop(0, 'rgb(0 0 0 / 0)');
  haloInk.addColorStop(0.45, 'rgb(0 0 0 / .3)');
  haloInk.addColorStop(1, 'rgb(0 0 0 / .5)');
}

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  cssW = box.width; cssH = box.height;
  measure();
}).observe(canvas);

// ---------------------------------------------------------------- render
function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  if (layoutDirty) applyLayout();
  if (viewDirty) applyView();
  const flashing = view === 'live' && now < num.flashUntil;
  const animating = view === 'live' && (now - num.sampleWall < SETTLE || flashing);
  if (view === 'live' && sampled) {
    const target = num.lastT + Math.min(now - num.sampleWall, EXTRAPOLATE);
    if (target > num.headT) num.headT = target;
  }
  if (view === 'live' && cssW) draw(now);
  if (statsDirty || (animating && now - num.statsAt >= STATS_EVERY) || (!animating && view === 'live')) {
    writeStats(); num.statsAt = now; statsDirty = false;
  }
  if (animating) raf = requestAnimationFrame(frame);
}

function applyLayout() {
  layoutDirty = false;
  if (root.dataset.orient !== orient) root.dataset.orient = orient;
  if (root.dataset.align !== opts.align) root.dataset.align = opts.align;
  root.style.setProperty('--u', unit);
}

function applyView() {
  viewDirty = false;
  root.dataset.view = view;
  el.dashRow.hidden = !opts.showDash;
  setText(el.span, spanText);
  setText(el.chip, CHIP[view] || 'Connecting');
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

/** Writes a formatted value; the dash for an unknown one takes the caption colour. */
function setValue(node, text) {
  if (node.textContent === text) return;
  node.textContent = text;
  node.classList.toggle('kit-dash', text === DASH);
}

function writeStats() {
  const has = (view === 'live' || view === 'final') && sampled;
  const share = has && num.activeMs > 0 ? (num.dashMs / num.activeMs) * 100 : NaN;
  if (view === 'final') {
    setValue(el.finalDash, fmt.finalDash(share));
    setValue(el.finalTurns, fmt.finalTurns(has ? turns : NaN));
  } else setValue(el.dash, fmt.dash(share));
}

// Per-frame geometry shared by the draw passes. Object fields: V8 updates doubles there in place.
// Each pass is its own function, so a pass that first runs late (the first kiai, the first miss)
// cannot send the hot trace loop back to an unoptimised tier.
const g = { len: 0.5, head: 0.5, pxPerMs: 0.5, from: 0.5, nu: 0.5 };

function draw(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw in logical "vertical" coordinates: u across (playfield), v along (time, 0 = oldest).
  // Horizontal is the transpose, so one code path serves both orientations.
  if (orient === 'vertical') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(0, dpr, dpr, 0, 0, 0);
  const windowMs = opts.window * 1000;
  g.len = plotLen;
  g.head = ringCount > 0 ? (num.headT > -Infinity ? num.headT : num.lastT) : 0;
  g.pxPerMs = plotLen / windowMs;
  g.from = g.head - windowMs;
  g.nu = (num.lastX / PLAYFIELD) * span;
  drawFrame();
  if (ringCount === 0) return;
  drawKiai();
  drawTrace();
  drawMisses(now);
  drawCatcher();
}

/** Playfield frame: both edges, a fainter centre, and second ticks that scroll with gameplay time. */
function drawFrame() {
  const len = plotLen, head = g.head, pxPerMs = g.pxPerMs;
  ctx.fillStyle = INK.centre;
  ctx.fillRect(centreU, 0, line, len);
  ctx.fillStyle = INK.edge;
  ctx.fillRect(0, 0, line, len);
  ctx.fillRect(edge1, 0, line, len);
  ctx.fillRect(0, len, span, line);
  for (let s = Math.ceil(g.from / 1000); s * 1000 <= head; s++) {
    const v = (len - (head - s * 1000) * pxPerMs) | 0;
    ctx.fillRect(0, v, tickLen, line);
    ctx.fillRect(span - tickLen, v, tickLen, line);
  }
}

/** Kiai stretches light the playfield edges in the map's tone. */
function drawKiai() {
  const len = plotLen, head = g.head, pxPerMs = g.pxPerMs;
  ctx.fillStyle = mapTone;
  for (let j = 0; j < KIAI_CAP; j++) {
    // An open stretch (to = +Infinity) runs to the newest sample.
    const v0 = Math.max(0, len - (head - kiaiFrom[j]) * pxPerMs) | 0;
    const v1 = (len - (head - Math.min(kiaiTo[j], head)) * pxPerMs) | 0;
    const h = Math.max(0, v1 - v0);
    ctx.fillRect(0, v0, kiaiW, h);
    ctx.fillRect(span - kiaiW, v0, kiaiW, h);
  }
}

/** The trace, then its dash segments re-stroked in amber. */
function drawTrace() {
  const len = g.len, head = g.head, pxPerMs = g.pxPerMs, from = g.from, nu = g.nu;
  // Oldest visible sample (one before the window edge keeps the line continuous).
  let n = 0;
  let i = (ringHead - 1) & MASK;
  while (n < ringCount && ringT[i] >= from) { n++; i = (i - 1) & MASK; }
  if (n < ringCount) n++;
  const start = (ringHead - n) & MASK;

  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const j = (start + k) & MASK;
    const u = (ringX[j] / PLAYFIELD) * span;
    const v = Math.max(0, len - (head - ringT[j]) * pxPerMs);
    pathU[k] = u; pathV[k] = v;
    if (k === 0) ctx.moveTo(u, v); else ctx.lineTo(u, v);
  }
  ctx.lineTo(nu, len);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = haloInk; ctx.lineWidth = haloW; ctx.stroke();
  ctx.strokeStyle = traceInk; ctx.lineWidth = traceW; ctx.stroke();

  ctx.beginPath();
  let on = false;
  for (let k = 0; k < n; k++) {
    if (on) ctx.lineTo(pathU[k], pathV[k]);
    const d = ringD[(start + k) & MASK];
    if (d && !on) { ctx.moveTo(pathU[k], pathV[k]); on = true; } else if (!d) on = false;
  }
  if (on) ctx.lineTo(nu, len);
  ctx.strokeStyle = dashInk; ctx.lineWidth = dashW; ctx.stroke();
}

/** Miss pins where the catcher was; a new one rings out once (full motion only). */
function drawMisses(now) {
  const len = g.len, head = g.head, pxPerMs = g.pxPerMs, from = g.from;
  for (let k = 0; k < missCount; k++) {
    const j = (missHead + MISS_CAP - 1 - k) % MISS_CAP;
    if (missT[j] < from) continue;
    const u = (missX[j] / PLAYFIELD) * span;
    const v = Math.max(0, len - (head - missT[j]) * pxPerMs);
    ctx.globalAlpha = 0.35 + 0.65 * (v / len);
    ctx.fillStyle = C.miss; ctx.strokeStyle = INK.halo; ctx.lineWidth = pinLine;
    ctx.beginPath(); ctx.arc(u, v, pinR, 0, TAU); ctx.stroke(); ctx.fill();
    const age = now - missWall[j];
    if (age < MOTION_MS.base && now < num.flashUntil) {
      const e = 1 - (1 - age / MOTION_MS.base) ** 3;      // ease-out
      ctx.globalAlpha = 1 - e;
      ctx.strokeStyle = C.miss; ctx.lineWidth = ringLine;
      ctx.beginPath(); ctx.arc(u, v, pinR + (ringR - pinR) * e, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

/** The catcher: a plate at true width under the "now" line; amber while dashing. */
function drawCatcher() {
  const w = plateW, half = w >> 1;
  const x = Math.min(span - w, Math.max(0, (g.nu | 0) - half));
  ctx.fillStyle = INK.halo;
  ctx.fillRect(x - 1, plateTop - 1, w + 2, plateH + 2);
  ctx.fillStyle = lastD ? C.you : C.text1;
  ctx.fillRect(x, plateTop, w, plateH);
}

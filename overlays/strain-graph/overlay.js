// Copyright (c) 2026 18-LAB. MIT.
// Strain graph: vosu's /performance/graph rasterised once per map into two offscreen layers
// (lit and dim); each frame only blits them split at the playhead and draws the playhead.
// Frames are requested only when the playhead crosses a device pixel or a readout changes.
// The page is the overlay's box (hosts place and size it): a wide box draws time left→right,
// a tall box draws time running upward (the mania side strip).
//
// Time is the set's one map clock (createMapClock): the graph spans the first to the last hit
// object, so the playhead sits where now-playing's progress bar does and the clock reads the same.
import {
  subscribe, settings, formatDuration, mapPalette, applyPalette, createMapClock, isKnown, DASH,
  applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const P = {
  state: '/state/number',
  checksum: '/beatmap/checksum',
  live: '/beatmap/time/live',
  trackRate: '/beatmap/time/rate',
  first: '/beatmap/time/firstObject',
  last: '/beatmap/time/lastObject',
  mp3: '/beatmap/time/mp3Length',
  kiai: '/beatmap/isKiai',
  brk: '/beatmap/isBreak',
  // The graph x-axis is map time ÷ the calculation's mod rate; the track rate is only a fallback.
  rate: '/play/mods/rate',
  series: '/performance/graph/series',
  xaxis: '/performance/graph/xaxis',
};

const $ = id => document.getElementById(id);
const widget = $('w');
const plot = $('plot');
const canvas = $('graph');
const liftCanvas = $('lift');
const ticksRow = $('ticks');
const legend = $('legend');
const empty = $('empty');
const titleText = $('title');
const kiaiChip = $('kiai');
const breakChip = $('break');
const statusText = $('status');
const nowText = $('now');
const totalText = $('total');
const headRow = document.querySelector('.head');
const ctx = canvas.getContext('2d', { alpha: true });
const liftCtx = liftCanvas.getContext('2d', { alpha: true });

// ---------------------------------------------------------------- colours (kit roles, read once)
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => {
  const value = css.getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};
const C = {
  text1: token('--text-1', '#efece5'),
  text3: token('--text-3', '#ada99f'),
  neutral: token('--map-neutral', '#c9c4ba'),
  ground: '#0b0c0d', // --backing-rgb
};
const channels = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgba = (hex, a) => `rgb(${channels(hex).join(' ')} / ${a})`;
const mix = (a, b, t) => '#' + channels(a).map((v, i) => Math.round(v + (channels(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
// The dark under-stroke that keeps hairlines readable over bright maps (with any backing).
const UNDER = 'rgb(11 12 13 / 0.6)';
// The map's identity inks (--map: the map's tone, or neutral); rebuilt, with a re-raster, only
// when the map colour changes. Unplayed strain is neutral; nothing here is amber ("you").
const INK = {
  map: '', litEdge: '', base: '', bandDim: '', wash: '', kiaiHi: '', kiaiEdge: '',
  dimFill: rgba(C.text1, 0.12), dimEdge: rgba(C.text1, 0.55), hair: rgba(C.text1, 0.22), grid: rgba(C.text1, 0.1),
  preview: C.text3,
  // Per-skill bands: tonal steps of the map colour (lighter, the colour, darker, neutral).
  skills: ['', '', '', C.text3],
};
function setTint(hex) {
  if (hex === INK.map) return false;
  INK.map = hex;
  INK.litEdge = mix(hex, C.text1, 0.35);
  INK.base = rgba(hex, 0.55);
  INK.bandDim = rgba(hex, 0.8);
  INK.wash = rgba(hex, 0.16);
  INK.kiaiHi = mix(hex, C.text1, 0.5);
  INK.kiaiEdge = mix(hex, C.text1, 0.7);
  INK.skills[0] = hex;
  INK.skills[1] = mix(hex, C.text1, 0.5);
  INK.skills[2] = mix(hex, C.ground, 0.45);
  return true;
}
setTint(C.neutral);

// vosu series per ruleset (converts included); the first group present wins.
const SKILLS = {
  aim: ['Aim', 0], speed: ['Speed', 1],
  color: ['Colour', 0], rhythm: ['Rhythm', 1], stamina: ['Stamina', 2],
  movement: ['Movement', 0], strains: ['Strain', 0],
};
const GROUPS = [['aim', 'speed'], ['color', 'rhythm', 'stamina'], ['movement'], ['strains']];
const skillColor = slot => INK.skills[slot < 3 ? slot : 3];

// ---------------------------------------------------------------- motion
// Map change: the new silhouette grows out of the baseline (one reveal per map). Created once and
// restarted; the keyframes follow the orientation. motion=off skips it.
const REVEAL_H = [{ opacity: 0, transform: 'scaleY(0.2)' }, { opacity: 1, transform: 'none' }];
const REVEAL_V = [{ opacity: 0, transform: 'scaleX(0.2)' }, { opacity: 1, transform: 'none' }];
const reveal = plot.animate(REVEAL_H, { duration: MOTION_MS.slow, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
reveal.finish();

// ---------------------------------------------------------------- state
const opts = { orientation: 'auto', align: 'left', view: 'combined', showTime: true, showMarks: true, showInSelect: true, motion: 'full', backing: 'scrim', marks: 'neutral', mapTint: true };
const view = { phase: null, kiai: false, brk: false, checksum: '', status: 'connecting', show: 'status', motion: 'full', legend: false };
// The set's map clock: span (first → last object, else the audio), elapsed and total.
const clock = createMapClock();
// The map clock as received. Messages arrive every few ms and the code that reads them runs
// unoptimised for its first thousands of calls, where every fractional result is a new heap
// number; so these fields keep the parsed numbers by reference (null-initialised: tagged fields,
// never boxed copies) and the per-message path only compares them. `lo`..`hi` is the live-clock
// span in which neither the playhead pixel nor the clock second can change.
const tick = { live: null, rate: null, modRate: null, prev: null, lo: null, hi: null };
const head = { px: -1, sec: -1 }; // playhead device px along time and whole second; -1 when none
// The graph inputs, captured when they change (the subscribe values object is reused per frame).
const source = { series: undefined, xaxis: undefined };
// The drawn time span in map ms: the map clock's when it knows one (fromClock), else the strain
// data's own extent. No skills but span > 0: no strain data (e.g. the replay renderer), the strip
// is a plain progress track.
const graph = { skills: [], start: 0, span: 0, fromClock: false, clockStart: NaN, clockEnd: NaN, section: 400, key: '', k: 0 };
// Device-pixel geometry. u runs along time (0..L), v across it (0 = peak side, T = baseline).
const size = { w: 0, h: 0, cssW: 0, cssH: 0, cssL: 0, ratio: 1, lw: 1, L: 0, T: 0 };
const geo = { vertical: false, align: 'left', m: [1, 0, 0, 1, 0, 0] }; // ints only: no boxing per setTransform
const drawn = { px: -2, sec: -2, total: -1, nowLen: -1 };
const lifted = { u0: -1, u1: -1 }; // the kiai section the lift layer holds (device px)
const TAU = Math.PI * 2;
let needleX = 0.5, needleR = 3; // needle centre offset from the playhead column, radius (device px)
const lit = document.createElement('canvas');
const dim = document.createElement('canvas');
const litCtx = lit.getContext('2d');
const dimCtx = dim.getContext('2d');
// The same silhouette in its kiai look (lighter map tone, played and ahead): kiai sections are
// blitted from these over the plain layers, so kiai shows in the fill itself.
const kiaiLit = document.createElement('canvas');
const kiaiDim = document.createElement('canvas');
const kiaiLitCtx = kiaiLit.getContext('2d');
const kiaiDimCtx = kiaiDim.getContext('2d');
const NONE = new Float32Array(0);
let surface = NONE; // silhouette v per u column, for the playhead needle
let rawLevel = NONE; // one skill resampled per u column (raster scratch)
const levelPool = []; // stacked skill levels per u column, reused while L holds
let palette = null;
let modelDirty = false, rasterDirty = false, metaDirty = true, frameDirty = true, legendDirty = true, axisDirty = false, revealPending = false;
let ticks = [];
let raf = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const positive = value => (typeof value === 'number' && value > 0 ? value : 0);
const same = (a, b) => a === b || (a !== a && b !== b); // NaN-aware
const setText = (el, text) => { if (el.$text !== text) { el.$text = text; el.textContent = text; } };
const setData = (el, key, value) => { if (el.dataset[key] !== value) el.dataset[key] = value; };
const setOut = (el, out) => { if (el.hasAttribute('data-out') !== out) el.toggleAttribute('data-out', out); };
const request = () => { if (!raf) raf = requestAnimationFrame(frame); };

// ---------------------------------------------------------------- kiai / break sections
// vosu exposes only the live isKiai/isBreak flags, so sections are learned as the map clock
// passes them (gameplay or the song-select preview) and remembered per beatmap checksum.
const STORE = 'strain-graph:marks:';
const marks = { key: '', kiai: [], brk: [], runKiai: null, runBrk: null, prevKiai: false, prevBrk: false };

function settle(list) {
  list.sort((a, b) => a[0] - b[0]);
  let out = 0;
  for (let i = 0; i < list.length; i++) {
    const run = list[i];
    // No list[-1]: a negative index is a string-keyed lookup (number → string conversion).
    const last = out > 0 ? list[out - 1] : null;
    if (last && run[0] <= last[1] + 250) last[1] = Math.max(last[1], run[1]);
    else list[out++] = run;
  }
  list.length = Math.min(out, 64);
}

function saveMarks() {
  if (!marks.key) return;
  try {
    const round = list => list.map(([a, b]) => [Math.round(a), Math.round(b)]);
    localStorage.setItem(STORE + marks.key, JSON.stringify({ k: round(marks.kiai), b: round(marks.brk) }));
    const index = JSON.parse(localStorage.getItem(STORE + 'index') || '[]').filter(key => key !== marks.key);
    index.push(marks.key);
    for (const old of index.splice(0, Math.max(0, index.length - 64))) localStorage.removeItem(STORE + old);
    localStorage.setItem(STORE + 'index', JSON.stringify(index));
  } catch { /* storage full or blocked: sections stay in memory */ }
}

function loadMarks(key) {
  marks.key = key;
  marks.kiai = []; marks.brk = [];
  marks.runKiai = marks.runBrk = null;
  marks.prevKiai = marks.prevBrk = false;
  tick.prev = null;
  lifted.u0 = -1;
  if (!key) return;
  try {
    const stored = JSON.parse(localStorage.getItem(STORE + key) || 'null');
    const valid = list => (Array.isArray(list) ? list.filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0]) : []);
    if (stored) { marks.kiai = valid(stored.k); marks.brk = valid(stored.b); }
  } catch { /* unreadable entry: start fresh */ }
}

function track(list, run, on, t) {
  if (on) {
    if (run) run[1] = t;
    else { run = [tick.prev, t]; list.push(run); }
    return run;
  }
  if (run) { settle(list); saveMarks(); }
  return null;
}

/** t − prev < 1500 with t ≥ prev. Whole milliseconds (Smis) decide it unless the gap is within
 *  a millisecond of the limit, so the per-message check makes no heap number. */
function contiguous(t, prev) {
  if (prev === null || !(t >= prev)) return false;
  const gap = Math.floor(t) - Math.floor(prev);
  return gap < 1499 || (gap <= 1500 && t - prev < 1500);
}

function observe(key, t, kiai, brk) {
  if (key !== marks.key) loadMarks(key);
  // A flag counts once two consecutive, contiguous samples agree: a stale flag from the
  // previous map or a seek never paints a section.
  const kiaiOn = kiai && marks.prevKiai, brkOn = brk && marks.prevBrk;
  const near = (kiaiOn || brkOn) && contiguous(t, tick.prev);
  marks.runKiai = track(marks.kiai, marks.runKiai, kiaiOn && near, t);
  marks.runBrk = track(marks.brk, marks.runBrk, brkOn && near, t);
  marks.prevKiai = kiai;
  marks.prevBrk = brk;
  tick.prev = t;
}

/** The kiai section the map clock is in (map ms into `active`): the one being learned, widened by
 *  any remembered section it overlaps, so a known map lifts the whole section at once. */
const active = { a: 0, b: 0 };
function activeKiai(t) {
  const run = marks.runKiai;
  let found = false;
  if (run) { active.a = run[0]; active.b = run[1]; found = true; }
  if (typeof t !== 'number') return found;
  const list = marks.kiai;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r === run || t < r[0] - 250 || t > r[1] + 250) continue;
    if (!found) { active.a = r[0]; active.b = r[1]; found = true; continue; }
    if (r[0] < active.a) active.a = r[0];
    if (r[1] > active.b) active.b = r[1];
  }
  return found;
}

// ---------------------------------------------------------------- data
/** play (2, incl. replay/spectate) | select (5) | results (7) | menu (anything else) | null. */
function phaseOf(state) {
  if (typeof state !== 'number') return null;
  return state === 2 ? 'play' : state === 5 ? 'select' : state === 7 ? 'results' : 'menu';
}

/**
 * Places the playhead (`head`): progress and elapsed seconds from the map clock, clamped to the
 * span (lead-in reads 0:00). Also sets `tick.lo..hi`, the live-clock span that keeps both the
 * pixel and the second, shrunk by a microsecond so rounding can never hide a change; runs only
 * when the clock leaves that span.
 */
function locate() {
  const span = graph.span, L = size.L, live = tick.live;
  if (span > 0 && L > 0 && typeof live === 'number' && Number.isFinite(live)) {
    const start = graph.start;
    let t = live - start;
    t = t < 0 ? 0 : t > span ? span : t;
    const px = Math.round((graph.fromClock ? clock.progress(live) : t / span) * L);
    head.px = px;
    // px holds for t in [px − ½, px + ½)·span/L, the second for [sec, sec + 1)·1000·rate; clamping
    // extends a span touching either end of the track to infinity.
    let lo = (px - 0.5) * span / L, hi = (px + 0.5) * span / L;
    if (graph.fromClock) {
      const sec = Math.floor(clock.elapsed(live) / 1000);
      const ms = 1000 * clock.rate;
      head.sec = sec;
      if (sec * ms > lo) lo = sec * ms;
      if ((sec + 1) * ms < hi) hi = (sec + 1) * ms;
    } else head.sec = -1;
    tick.lo = lo <= 0 ? -Infinity : start + lo + 1e-3;
    tick.hi = hi > span ? Infinity : start + hi - 1e-3;
  } else {
    head.px = head.sec = -1;
    tick.lo = tick.hi = null;
  }
}

/** True while `live` stays inside the span the last locate measured, so `head` is current. */
function placed(live) {
  return tick.lo !== null && typeof live === 'number' && live >= tick.lo && live < tick.hi;
}

/** on | status (tiny connection / no-osu! caption) | off. Gameplay first; song select only previews. */
function visibility() {
  if (view.status !== 'live' || !view.phase) return 'status';
  if (view.phase === 'play') return 'on';
  if (view.phase === 'select' && opts.showInSelect && graph.skills.length) return 'on';
  return 'off';
}

function loadPalette(checksum) {
  if (!opts.mapTint || !checksum) { palette = null; applyColors(); return; }
  mapPalette(checksum).then(result => {
    if (checksum !== view.checksum) return;
    palette = result;
    applyColors();
  });
}

function applyColors() {
  applyPalette(widget, opts.mapTint ? palette : null);
  const tint = opts.mapTint && palette?.accent ? palette.accent : C.neutral;
  if (setTint(tint)) { rasterDirty = legendDirty = frameDirty = true; lifted.u0 = -1; request(); }
}

function onData(values, changed) {
  let want = false;
  const phase = phaseOf(values[P.state]);
  if (phase !== view.phase) { view.phase = phase; metaDirty = frameDirty = want = true; }
  const live = values[P.live];
  // pageNow 0: this overlay steps the playhead per device pixel on data and never extrapolates.
  clock.sample(live, values[P.trackRate], values[P.first], values[P.last], values[P.mp3], 0);
  if (clock.rate !== tick.rate) { tick.rate = clock.rate; tick.lo = tick.hi = null; frameDirty = want = true; }
  if (!same(clock.start, graph.clockStart) || !same(clock.end, graph.clockEnd)) {
    graph.clockStart = clock.start;
    graph.clockEnd = clock.end;
    modelDirty = true;
  }
  const modRate = positive(values[P.rate]) || positive(values[P.trackRate]) || 1;
  if (modRate !== tick.modRate) { tick.modRate = modRate; modelDirty = true; }
  if (changed.has(P.series) || changed.has(P.xaxis) || changed.has(P.checksum)) {
    source.series = values[P.series];
    source.xaxis = values[P.xaxis];
    modelDirty = true;
  }
  if (modelDirty) want = true;
  const checksum = typeof values[P.checksum] === 'string' ? values[P.checksum] : '';
  if (checksum !== view.checksum) { view.checksum = checksum; loadPalette(checksum); }
  tick.live = typeof live === 'number' ? live : null;
  const kiai = values[P.kiai] === true;
  const brk = values[P.brk] === true;
  if (kiai !== view.kiai || brk !== view.brk) { view.kiai = kiai; view.brk = brk; metaDirty = frameDirty = want = true; }
  if (phase && checksum && typeof live === 'number' && Number.isFinite(live) && (changed.has(P.live) || changed.has(P.kiai) || changed.has(P.brk))) {
    observe(checksum, live, kiai, brk);
  }
  // Inside the span the last locate measured, the playhead cannot have moved.
  if (!want && graph.span && view.show === 'on' && !(placed(live) && head.px === drawn.px && head.sec === drawn.sec)) {
    locate();
    want = head.px !== drawn.px || head.sec !== drawn.sec;
  }
  if (want) request();
}

function onStatus(state) {
  if (state === view.status) return;
  view.status = state;
  metaDirty = frameDirty = true;
  request();
}

// ---------------------------------------------------------------- box layout
// The host decides the page size; the layout re-flows to it. Tall boxes go vertical unless the
// orientation setting pins one. --u is 1 across the placement boxes (96–128 px thick) and
// scales outside them, so type keeps the kit's sizes on every ruleset's slot.
function layoutBox() {
  const W = innerWidth, H = innerHeight;
  const vertical = opts.orientation === 'vertical' || (opts.orientation === 'auto' && H > W * 1.25);
  const thickness = vertical ? W : H;
  const u = thickness < 96 ? Math.max(0.75, thickness / 96) : thickness > 128 ? Math.min(1.6, thickness / 128) : 1;
  widget.style.setProperty('--u', u.toFixed(3));
  setData(widget, 'orient', vertical ? 'v' : 'h');
  setData(widget, 'align', opts.align);
  // A thin vertical strip gives the time axis' room to the graph.
  setData(widget, 'compact', thickness < 84 ? 'on' : 'off');
  if (geo.vertical !== vertical || geo.align !== opts.align) {
    geo.vertical = vertical;
    geo.align = opts.align;
    reveal.effect.setKeyframes(vertical ? REVEAL_V : REVEAL_H);
    resize(size.cssW, size.cssH, true);
  }
  fitHead();
}

// ---------------------------------------------------------------- model
function pickSkills(series) {
  const byName = new Map();
  for (const entry of series) if (entry && typeof entry.name === 'string' && Array.isArray(entry.data)) byName.set(entry.name, entry);
  for (const group of GROUPS) {
    const found = group.filter(name => byName.has(name));
    if (found.length) return found.map(name => ({ name, label: SKILLS[name][0], slot: SKILLS[name][1], data: byName.get(name).data }));
  }
  return [...byName.values()].slice(0, 4).map((entry, i) => ({ name: entry.name, label: entry.name, slot: i, data: entry.data }));
}

function buildModel() {
  modelDirty = false;
  rasterDirty = legendDirty = frameDirty = metaDirty = true;
  const previous = graph.key;
  graph.skills = [];
  graph.key = view.checksum;
  tick.lo = tick.hi = null;
  lifted.u0 = -1;
  const fromClock = isKnown(clock.end) && clock.end > clock.start;
  graph.fromClock = fromClock;
  graph.start = fromClock ? clock.start : 0;
  graph.span = fromClock ? clock.end - clock.start : 0;
  const modRate = tick.modRate || 1;
  const series = source.series;
  const xaxis = source.xaxis;
  if (Array.isArray(series) && Array.isArray(xaxis) && xaxis.length) {
    let section = Infinity;
    let lastX = 0;
    for (let i = 0; i < xaxis.length; i++) {
      const x = xaxis[i];
      if (!Number.isFinite(x)) continue;
      if (x > lastX) lastX = x;
      const step = i ? x - xaxis[i - 1] : 0;
      if (step > 0 && step < section) section = step;
    }
    if (!Number.isFinite(section)) section = 400;
    // Graph x is map ms ÷ the mod rate; samples go to map ms relative to the span start.
    if (!fromClock) graph.span = (lastX + section) * modRate;
    const offset = section * modRate / 2 - graph.start;
    // vosu pads the series with negative sentinels (-100 audio padding, -50 object gaps) and its
    // padded x-axis may revisit times; keep real samples only, ordered by section centre.
    let any = false;
    for (const skill of pickSkills(series)) {
      const n = Math.min(skill.data.length, xaxis.length);
      const order = [];
      for (let i = 0; i < n; i++) {
        const v = skill.data[i];
        if (typeof v === 'number' && v >= 0 && Number.isFinite(xaxis[i])) order.push(i);
      }
      order.sort((a, b) => xaxis[a] - xaxis[b]);
      skill.xs = Float64Array.from(order, i => xaxis[i] * modRate + offset);
      skill.vs = Float64Array.from(order, i => skill.data[i]);
      skill.data = null;
      if (order.length) any = true;
      graph.skills.push(skill);
    }
    if (!any) graph.skills = [];
    graph.section = section * modRate;
    if (!any && !fromClock) graph.span = 0;
  }
  // No strain data (the replay renderer): the page becomes a clock over a progress track.
  setData(widget, 'track', graph.span > 0 && !graph.skills.length ? 'on' : 'off');
  if (graph.span > 0 && previous !== graph.key) revealPending = true;
}

// ---------------------------------------------------------------- raster (once per map/size/view)
function resample(xs, vs, k, out) {
  out.fill(0);
  const m = xs.length;
  let j = 0;
  for (let c = 0; c < out.length; c++) {
    const t0 = c / k, t1 = (c + 1) / k;
    while (j < m && xs[j] < t0) j++;
    let peak = -1;
    for (let q = j; q < m && xs[q] < t1; q++) if (vs[q] > peak) peak = vs[q];
    if (peak >= 0) out[c] = peak;
    else if (j > 0 && j < m) {
      const a = j - 1, f = ((c + 0.5) / k - xs[a]) / (xs[j] - xs[a]);
      out[c] = vs[a] + (vs[j] - vs[a]) * clamp(f, 0, 1);
    }
  }
}

function blur(src, dst, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const n = src.length;
  for (let c = 0; c < n; c++) {
    let acc = 0;
    for (let i = -radius; i <= radius; i++) {
      const s = c + i;
      if (s >= 0 && s < n) acc += src[s] * kernel[i + radius];
    }
    dst[c] = acc;
  }
}

function tickStep(cssPerMs) {
  for (const step of [10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1200e3]) if (step * cssPerMs >= 96) return step;
  return 1800e3;
}

/** Elapsed-time ticks (real ms from the first object), vertical form only: there the axis is the
 *  only time scale along the strip. The horizontal form has the clock and no axis. */
function computeTicks() {
  ticks = [];
  axisDirty = true;
  if (!geo.vertical || !graph.span || !size.cssL) return;
  const real = graph.span / (graph.fromClock ? clock.rate : tick.modRate || 1);
  const cssPerMs = size.cssL / real;
  const step = tickStep(cssPerMs);
  for (let t = 0; t * cssPerMs <= size.cssL - 24; t += step) ticks.push(t / real);
}

function writeAxis() {
  axisDirty = false;
  ticksRow.replaceChildren();
  if (!ticks.length) return;
  const real = graph.span / (graph.fromClock ? clock.rate : tick.modRate || 1);
  for (const f of ticks) {
    const label = document.createElement('span');
    label.textContent = formatDuration(f * real);
    label.className = f ? 'kit-tick' : 'kit-tick zero';
    label.style.bottom = `${f * 100}%`;
    ticksRow.append(label);
  }
}

/** The i-th stacked level buffer, sized L (contents are whatever the last raster left). */
function level(i) {
  return levelPool[i] || (levelPool[i] = new Float32Array(size.L));
}

function raster() {
  rasterDirty = false;
  frameDirty = true;
  const { w, h, lw, L, T, ratio } = size;
  if (lit.width !== w || lit.height !== h) {
    lit.width = dim.width = kiaiLit.width = kiaiDim.width = w;
    lit.height = dim.height = kiaiLit.height = kiaiDim.height = h;
  }
  litCtx.setTransform(1, 0, 0, 1, 0, 0); litCtx.clearRect(0, 0, w, h);
  dimCtx.setTransform(1, 0, 0, 1, 0, 0); dimCtx.clearRect(0, 0, w, h);
  kiaiLitCtx.setTransform(1, 0, 0, 1, 0, 0); kiaiLitCtx.clearRect(0, 0, w, h);
  kiaiDimCtx.setTransform(1, 0, 0, 1, 0, 0); kiaiDimCtx.clearRect(0, 0, w, h);
  computeTicks();
  // Map ms → device px along time for the playhead and the kiai/break sections.
  graph.k = graph.span && L ? L / graph.span : 0;
  if (!graph.span || !L || !T) { surface = rawLevel = NONE; return; }

  const k = graph.k;
  const floor = T - lw; // the baseline is the last device row
  const edgeW = Math.max(1.5, 1.5 * ratio), underW = edgeW + 2 * lw;
  // Column buffers persist across rasters and are replaced only when L changes.
  if (rawLevel.length !== L) { rawLevel = new Float32Array(L); surface = new Float32Array(L); levelPool.length = 0; }
  const levels = [level(0)];
  levels[0].fill(0);
  let scale = 0;
  // Headroom for the needle (radius + ring) above the highest peak.
  const ceiling = Math.round(needleR + 2 * lw);
  if (graph.skills.length) {
    const sigma = Math.max(0.9 * ratio, 0.7 * graph.section * k);
    for (const skill of graph.skills) {
      resample(skill.xs, skill.vs, k, rawLevel);
      const stacked = level(levels.length);
      blur(rawLevel, stacked, sigma);
      const below = levels[levels.length - 1];
      for (let c = 0; c < L; c++) stacked[c] += below[c];
      levels.push(stacked);
    }
    let peak = 0;
    for (const value of levels[levels.length - 1]) if (value > peak) peak = value;
    scale = peak > 0 ? (floor - ceiling) / peak : 0;
  }
  const top = levels[levels.length - 1];
  const V = value => floor - value * scale;
  for (let u = 0; u < L; u++) surface[u] = V(top[u]);

  const outline = (c, upper) => {
    c.moveTo(0, V(upper[0]));
    for (let u = 0; u < L; u++) c.lineTo(u + 0.5, V(upper[u]));
    c.lineTo(L, V(upper[L - 1]));
  };
  const area = (c, lower, upper) => {
    c.beginPath();
    outline(c, upper);
    c.lineTo(L, V(lower[L - 1]));
    for (let u = L - 1; u >= 0; u--) c.lineTo(u + 0.5, V(lower[u]));
    c.lineTo(0, V(lower[0]));
    c.closePath();
  };
  // Outer edges get a dark under-stroke so the silhouette reads over bright maps too.
  const edge = (c, upper, style, under) => {
    c.beginPath();
    outline(c, upper);
    c.lineJoin = 'round';
    if (under) { c.strokeStyle = UNDER; c.lineWidth = underW; c.stroke(); }
    c.strokeStyle = style;
    c.lineWidth = edgeW;
    c.stroke();
  };
  const [a, b, cc, d, e, f] = geo.m;

  const paint = (c, isLit) => {
    c.setTransform(a, b, cc, d, e, f);
    c.fillStyle = INK.grid;
    for (const t of ticks) if (t > 0) c.fillRect(Math.round(t * L), 0, lw, floor);
    if (!graph.skills.length) {
      // No strain data: a progress track only (the kit's track: hairline, map fill).
      const th = trackThickness();
      c.fillStyle = UNDER;
      c.fillRect(0, T - th - lw, L, th + lw);
      c.fillStyle = isLit ? INK.map : INK.hair;
      c.fillRect(0, T - th, L, th);
      return;
    }
    if (opts.view === 'per-skill' && graph.skills.length > 1) {
      for (let i = 0; i < graph.skills.length; i++) {
        area(c, levels[i], levels[i + 1]);
        c.fillStyle = rgba(skillColor(graph.skills[i].slot), isLit ? 0.7 : 0.16);
        c.fill();
      }
      for (let i = 0; i < graph.skills.length; i++) {
        const outer = i === graph.skills.length - 1;
        const color = skillColor(graph.skills[i].slot);
        edge(c, levels[i + 1], isLit ? color : outer ? INK.dimEdge : rgba(color, 0.45), outer);
      }
    } else {
      area(c, levels[0], top);
      if (isLit) {
        const fill = c.createLinearGradient(0, ceiling, 0, floor);
        fill.addColorStop(0, rgba(INK.map, 0.85));
        fill.addColorStop(1, rgba(INK.map, 0.3));
        c.fillStyle = fill;
      } else c.fillStyle = INK.dimFill;
      c.fill();
      edge(c, top, isLit ? INK.litEdge : INK.dimEdge, true);
    }
    // The baseline stays quieter than the kiai band that sits on it.
    c.fillStyle = isLit ? INK.base : INK.dimEdge;
    c.fillRect(0, floor, L, lw);
  };
  paint(litCtx, true);
  paint(dimCtx, false);
  if (!graph.skills.length) return; // a bare track marks kiai with its band only
  // Kiai: the plain layer under a lighter map sheen and a light edge (played), or a map wash and
  // a map edge where it is still ahead, so a kiai section reads as a lit block of the silhouette.
  paint(kiaiLitCtx, true);
  area(kiaiLitCtx, levels[0], top);
  const sheen = kiaiLitCtx.createLinearGradient(0, ceiling, 0, floor);
  sheen.addColorStop(0, rgba(INK.kiaiHi, 0.95));
  sheen.addColorStop(1, rgba(INK.kiaiHi, 0.55));
  kiaiLitCtx.fillStyle = sheen;
  kiaiLitCtx.fill();
  edge(kiaiLitCtx, top, INK.kiaiEdge, true);
  paint(kiaiDimCtx, false);
  area(kiaiDimCtx, levels[0], top);
  kiaiDimCtx.fillStyle = rgba(INK.map, 0.42);
  kiaiDimCtx.fill();
  edge(kiaiDimCtx, top, INK.kiaiEdge, true);
}

/** Kiai sections in the fill: each run's u-range comes from the kiai layers, played part from the
 *  lit one and the part still ahead from the dim one (identity transform, like blit). */
function kiaiFill(split) {
  const list = marks.kiai, k = graph.k, s = graph.start, L = size.L;
  for (let i = 0; i < list.length; i++) {
    const run = list[i];
    const u0 = clamp(Math.round((run[0] - s) * k), 0, L), u1 = clamp(Math.round((run[1] - s) * k), 0, L);
    blit(kiaiLit, u0, u1 < split ? u1 : split);
    blit(kiaiDim, u0 > split ? u0 : split, u1);
  }
}

// ---------------------------------------------------------------- frame
/** The progress track's thickness (device px) when there is no strain data. */
function trackThickness() {
  return Math.max(2 * size.lw, Math.round(3 * size.ratio));
}

/** Where the 2 px kiai band starts across time: on the baseline, or just above a bare track. */
function kiaiBand() {
  return graph.skills.length ? size.T - 2 * size.lw : size.T - trackThickness() - 3 * size.lw;
}

/** Fills (or clears) sections (map ms) along time between device px uMin and uMax. */
function runs(c, list, v, thickness, uMin, uMax, clear) {
  const k = graph.k, s = graph.start;
  for (let i = 0; i < list.length; i++) {
    const run = list[i];
    let u0 = Math.round((run[0] - s) * k), u1 = Math.round((run[1] - s) * k);
    if (u0 < uMin) u0 = uMin;
    if (u1 > uMax) u1 = uMax;
    if (u1 <= u0) continue;
    if (clear) c.clearRect(u0, v, u1 - u0, thickness);
    else c.fillRect(u0, v, u1 - u0, thickness);
  }
}

/** Copies the u-range [u0,u1) of a layer (device orientation) into the visible canvas. */
function blit(layer, u0, u1) {
  if (u1 <= u0) return;
  const { L, T } = size;
  if (geo.vertical) ctx.drawImage(layer, 0, L - u1, T, u1 - u0, 0, L - u1, T, u1 - u0);
  else ctx.drawImage(layer, u0, 0, u1 - u0, T, u0, 0, u1 - u0, T);
}

/** The active kiai section, lifted: the part still ahead of the playhead in its played kiai look,
 *  clipped to the silhouette, over a brighter, thicker band on the baseline. Its layer fades in
 *  and out with the section (CSS), so it is redrawn only when that range moves by a device pixel. */
function drawLift(u0, u1) {
  lifted.u0 = u0;
  lifted.u1 = u1;
  const { w, h, lw, L, T } = size;
  const m = geo.m;
  liftCtx.setTransform(1, 0, 0, 1, 0, 0);
  liftCtx.clearRect(0, 0, w, h);
  if (u1 <= u0) return;
  if (graph.skills.length) {
    if (geo.vertical) liftCtx.drawImage(kiaiLit, 0, L - u1, T, u1 - u0, 0, L - u1, T, u1 - u0);
    else liftCtx.drawImage(kiaiLit, u0, 0, u1 - u0, T, u0, 0, u1 - u0, T);
  }
  liftCtx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  liftCtx.fillStyle = C.text1;
  liftCtx.fillRect(u0, kiaiBand() - lw, u1 - u0, 3 * lw);
}

function updateSlot() {
  const chip = !opts.showMarks || view.show !== 'on' ? '' : view.kiai ? 'kiai' : view.brk ? 'break' : '';
  setOut(kiaiChip, chip !== 'kiai');
  setOut(breakChip, chip !== 'break');
  setOut(titleText, chip !== '' || view.legend);
  setOut(legend, chip !== '' || !view.legend);
}

function writeMeta() {
  metaDirty = false;
  const show = visibility();
  if (show !== view.show) { view.show = show; frameDirty = true; }
  setData(widget, 'show', show);
  setData(widget, 'phase', view.phase || 'none');
  setText(titleText, view.phase === 'select' ? 'Strain preview' : 'Strain');
  updateSlot();
  fitHead();
  liftCanvas.classList.toggle('on', view.kiai && opts.showMarks && show === 'on');
  statusText.hidden = show !== 'status';
  setText(statusText, view.status === 'offline' ? 'vosu offline' : view.status === 'live' ? 'osu! not running' : 'Connecting…');
}

function writeLegend() {
  legendDirty = false;
  legend.replaceChildren();
  view.legend = opts.view === 'per-skill' && graph.skills.length > 1;
  if (view.legend) {
    for (const skill of graph.skills) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.setProperty('--c', skillColor(skill.slot));
      item.append(swatch, skill.label);
      legend.append(item);
    }
  }
  updateSlot();
  fitHead();
}

/** Narrow boxes (the 216 px osu!/catch column): when the title and the clock do not fit on one
 *  line at the kit's sizes, the total ("of 2:24") is dropped instead of shrinking any text below
 *  14 px. Measured only when the header's text or the box changes (one layout read). */
function fitHead() {
  if (view.show !== 'on' || geo.vertical) { setData(widget, 'tight', 'off'); return; }
  setData(widget, 'tight', 'off');
  if (headRow.scrollWidth > headRow.clientWidth) setData(widget, 'tight', 'on');
}

function frame() {
  raf = 0;
  if (modelDirty) buildModel();
  if (metaDirty) writeMeta();
  if (view.show !== 'on') return;
  if (rasterDirty) raster();
  if (legendDirty) writeLegend();
  if (axisDirty) writeAxis();

  const { w, h, lw, L, T } = size;
  const hasTrack = graph.span > 0 && L > 0;
  if (empty.hidden !== hasTrack) empty.hidden = hasTrack;
  if (!placed(tick.live)) locate();
  const px = head.px, sec = head.sec;
  // Readouts format only when their value moves: the clock once a second, the total per model.
  if (sec !== drawn.sec || frameDirty) {
    setText(nowText, sec >= 0 ? formatDuration(sec * 1000) : DASH);
    // Tabular figures: the clock's width only changes with its length (— → 0:00 → 10:00).
    const len = nowText.$text.length;
    if (len !== drawn.nowLen) { drawn.nowLen = len; fitHead(); }
  }
  drawn.sec = sec;
  if (frameDirty) {
    const total = graph.fromClock ? clock.total() : NaN;
    const shown = isKnown(total) ? Math.floor(total / 1000) : -1;
    if (shown !== drawn.total) { drawn.total = shown; setText(totalText, shown >= 0 ? 'of ' + formatDuration(total) : ''); fitHead(); }
  }
  if (px === drawn.px && !frameDirty) return;
  drawn.px = px;
  frameDirty = false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!hasTrack) return;
  const play = view.phase === 'play';
  const marksOn = marks.key === graph.key && opts.showMarks;
  const m = geo.m;
  if (play && px >= 0) {
    blit(lit, 0, px);
    blit(dim, px, L);
  } else ctx.drawImage(lit, 0, 0);
  const split = play && px >= 0 ? px : L;
  if (marksOn && graph.skills.length) kiaiFill(split);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  // While the map is in kiai the playhead widens to 3 px: the section shows from its first frame.
  const kiaiNow = view.kiai && opts.showMarks && marksOn;
  if (marksOn) {
    // Breaks are gaps in the fill; kiai is a 2 px map band on the baseline, lighter where played.
    runs(ctx, marks.brk, 0, graph.skills.length ? T - lw : T, 0, L, true);
    const bandV = kiaiBand();
    ctx.fillStyle = INK.litEdge;
    runs(ctx, marks.kiai, bandV, 2 * lw, 0, split, false);
    ctx.fillStyle = INK.bandDim;
    runs(ctx, marks.kiai, bandV, 2 * lw, split, L, false);
  }
  if (view.kiai && marksOn && view.motion === 'full') {
    const found = activeKiai(tick.live);
    const k = graph.k, s = graph.start;
    // The lift covers what is still ahead in the section (behind the playhead the fill already
    // has its kiai look), and never the playhead itself: its layer sits above the graph.
    const ahead = split < L ? split + 2 * lw : L;
    let u0 = found ? clamp(Math.round((active.a - s) * k), 0, L) : 0;
    if (u0 < ahead) u0 = ahead;
    const u1 = found ? clamp(Math.round((active.b - s) * k), 0, L) : 0;
    if (u0 !== lifted.u0 || u1 !== lifted.u1) drawLift(u0, u1);
  }
  if (px >= 0) {
    const u = Math.min(px, L - lw);
    ctx.fillStyle = UNDER;
    ctx.fillRect(u - (kiaiNow ? 2 : 1) * lw, 0, (kiaiNow ? 5 : 3) * lw, T);
    ctx.fillStyle = play ? (kiaiNow ? INK.kiaiEdge : INK.litEdge) : INK.preview;
    if (kiaiNow) ctx.fillRect(u - lw, 0, 3 * lw, T);
    else ctx.fillRect(u, 0, lw, T);
    // Needle: where the playhead meets the strain silhouette.
    if (graph.skills.length) {
      ctx.beginPath();
      ctx.arc(u + needleX, surface[Math.min(px, L - 1)], needleR, 0, TAU);
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = UNDER;
      ctx.stroke();
    }
  }
  if (revealPending) {
    revealPending = false;
    if (view.motion !== 'off') { reveal.currentTime = 0; reveal.play(); }
  }
}

// ---------------------------------------------------------------- sizing
function resize(cssW, cssH, force = false) {
  const ratio = devicePixelRatio || 1;
  const w = Math.max(0, Math.round(cssW * ratio));
  const h = Math.max(0, Math.round(cssH * ratio));
  if (!force && w === size.w && h === size.h && cssW === size.cssW && cssH === size.cssH && ratio === size.ratio) return;
  const lw = Math.max(1, Math.round(ratio));
  const L = geo.vertical ? h : w;
  const T = geo.vertical ? w : h;
  Object.assign(size, { w, h, cssW, cssH, cssL: geo.vertical ? cssH : cssW, ratio, lw, L, T });
  tick.lo = tick.hi = null;
  lifted.u0 = -1;
  needleX = lw / 2;
  needleR = 3 * ratio;
  // u along time, v across (v = T is the baseline: left for align left, right for align right).
  geo.m = !geo.vertical ? [1, 0, 0, 1, 0, 0] : geo.align === 'right' ? [0, -1, 1, 0, 0, L] : [0, -1, -1, 0, T, L];
  if (canvas.width !== w) canvas.width = liftCanvas.width = w;
  if (canvas.height !== h) canvas.height = liftCanvas.height = h;
  rasterDirty = frameDirty = true;
  request();
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  resize(box.width, box.height);
}).observe(plot);
addEventListener('resize', layoutBox);
// Text widths change once the bundled fonts arrive (they load on first use, after this runs).
document.fonts.addEventListener('loadingdone', fitHead);

// ---------------------------------------------------------------- settings + subscription
settings({ ...opts }, s => {
  opts.orientation = ['horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = s.align === 'right' ? 'right' : 'left';
  const viewMode = s.view === 'per-skill' ? 'per-skill' : 'combined';
  if (viewMode !== opts.view) { opts.view = viewMode; rasterDirty = legendDirty = true; }
  opts.showTime = s.showTime !== false;
  opts.showMarks = s.showMarks !== false;
  opts.showInSelect = s.showInSelect !== false;
  const motion = applyKitSettings(widget, s);
  if (motion !== view.motion) { view.motion = motion; lifted.u0 = -1; }
  const tint = s.mapTint !== false;
  const tintChanged = tint !== opts.mapTint;
  opts.mapTint = tint;
  setData(widget, 'time', opts.showTime ? 'on' : 'off');
  setData(widget, 'chips', opts.showMarks ? 'on' : 'off');
  layoutBox();
  if (tintChanged) loadPalette(view.checksum);
  else applyColors();
  metaDirty = frameDirty = true;
  request();
});

subscribe(Object.values(P), onData, { onStatus });

// Copyright (c) 2026 18-LAB. MIT.
// KPS graph: osu!mania keys per second, the set's owner of KPS in mania. The live count, the peak
// and the trace all come from the shared createKps() (presses whose gameplay time falls in the
// last second of real time), so they agree with key-counter. The trace is that count sampled
// every 50 ms of map time, drawn as a chart-recorder strip over the map's strain density. The page
// is content-sized and re-flows to the box its host gives it: vertical beside the stage (time runs
// upward like the mania editor, the zero line on the stage side, the map's upcoming density above
// the now line when vosu sends it) or horizontal (time runs left → right). Results add the whole
// run; song select adds the map's density and note rate, which osu! does not show.
import {
  subscribe, settings, activeMode, isPlaying, formatDuration, mapPalette, applyPalette,
  createKps, createMapClock, numberFormatter, UNKNOWN, DASH, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const BIN = 50;          // map ms per sample of the trace
const ORIGIN = -10000;   // map time of bin 0, covers lead-in
const NOW_AT = 0.82;     // with the density lane: share of the plot that is history, the rest previews the map
const HEADROOM = 8;      // px kept past the now line without a lane, so the live head is not cut off
const HOLD = 250;        // ms the frame loop runs on after the last moving time sample (pauses stop it)
const REVISIT = 8;       // bins (400 ms) re-sampled after a key message: presses arrive after they happen
const RECORD_MS = 2000;  // a new peak flashes only when the old one stood this long (not on a ramp-up)
const SELECT = new Set([4, 5, 12, 13]);   // song select (edit, play, match setup, multi)
const RESULTS = new Set([7, 14, 18]);     // results (solo, vs, team)

const POINTERS = [
  '/state/number', '/play/mode/number', '/settings/mode/number',
  '/keys/all', '/beatmap/time/live', '/beatmap/time/rate', '/play/mods/rate',
  '/beatmap/time/firstObject', '/beatmap/time/lastObject', '/beatmap/time/mp3Length',
  '/beatmap/checksum', '/beatmap/isKiai', '/beatmap/stats/objects/total',
  '/performance/graph/series', '/performance/graph/xaxis',
];

const $ = id => document.getElementById(id);
const block = $('kps');
const chip = $('chip');
const canvas = $('chart');
const note = $('note');
const plot = canvas.parentElement;
const el = {
  phase: $('phase'), pLabel: $('pLabel'), pValue: $('pValue'), pUnit: $('pUnit'),
  aLabel: $('aLabel'), aName: $('aName'), aValue: $('aValue'), aEcho: $('aEcho'),
  bLabel: $('bLabel'), bName: $('bName'), bValue: $('bValue'),
  axisL: $('axisL'), axisM: $('axisM'), axisR: $('axisR'),
};
const ctx = canvas.getContext('2d', { alpha: true });

/** textContent only when the string changed. */
function put(node, value) {
  if (node._text !== value) { node._text = value; node.textContent = value; }
}
function attr(node, name, value) {
  if (node._attrs?.[name] === value) return;
  (node._attrs ??= {})[name] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}
/** A readout: the text, with the kit's dash style while it is the unknown dash. */
function show(node, text) {
  if (node._text === text) return;
  put(node, text);
  const dash = text === DASH;
  if (node._dash !== dash) { node._dash = dash; node.classList.toggle('kit-dash', dash); }
}

// ---------------------------------------------------------------- colour roles (kit.css)
const kit = getComputedStyle(block);
const role = (name, fallback) => kit.getPropertyValue(name).trim() || fallback;
const INK = '239 236 229';                      // --text-1 as channels, for the chart's alphas
const YOU = role('--you', '#ff963f');           // you: the live head and your peak
const C = {
  gridMinor: `rgb(${INK} / .06)`,
  gridMajor: `rgb(${INK} / .13)`,
  gridH: `rgb(${INK} / .09)`,
  base: `rgb(${INK} / .5)`,
  now: `rgb(${INK} / .7)`,
  label: role('--text-3', '#ada99f'),
  under: 'rgb(11 12 13 / .6)',
  line: role('--text-1', '#efece5'),
  ghost: `rgb(${INK} / .7)`,
  avg: `rgb(${INK} / .7)`,
  you: YOU,
  halo: 'rgb(255 150 63 / .28)',
  map: '#c9c4ba',                               // --map, read again when the palette or mapTint changes
};
/** The density lane takes the map's identity colour (--map: map tone or neutral with mapTint off). */
function recolor() {
  C.map = getComputedStyle(block).getPropertyValue('--map').trim() || '#c9c4ba';
  dirty = true;
}

// ---------------------------------------------------------------- settings (applied at the end of the module)
const DEFAULTS = { window: 20, strain: true, orientation: 'auto', align: 'left', menus: false, motion: 'full', backing: 'scrim', mapTint: true };
let opt = DEFAULTS;
let motion = 'full';
let spanS = 20;
const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
function applySettings(next) {
  opt = next;
  motion = applyKitSettings(block, next);
  spanS = Math.round(clamp(next.window, 5, 60, 20));
  attr(block, 'data-align', next.align === 'right' ? 'right' : 'left');
  recolor();
  relayout();
  setView(decideView());
  axisDirty = true;
  dirty = true;
  kick();
}

// ---------------------------------------------------------------- re-flow to the host's box
// Hosts (OBS, vosulay, the replay renderer's per-player cells) size the page; the layout follows
// the box: horizontal when it is wider than tall (or forced by `orientation`), the kit's sizes
// scaled by --u (1 = the 152 px strip beside the stage, or a 160 px tall horizontal box).
let u = NaN, tickPx = 11, band = 17;
let tickFont = '400 11px "IBM Plex Mono", ui-monospace, monospace';
function relayout() {
  const W = innerWidth, H = innerHeight;
  const next = opt.orientation === 'horizontal' ? 'h' : opt.orientation === 'vertical' ? 'v' : W > H ? 'h' : 'v';
  const scale = next === 'v' ? clamp(W / 152, 0.75, 2, 1) : clamp(H / 160, 0.75, 2, 1);
  if (scale !== u) {
    u = scale;
    block.style.setProperty('--u', u.toFixed(3));
    tickPx = Math.max(9, Math.round(11 * u));
    tickFont = `400 ${tickPx}px "IBM Plex Mono", ui-monospace, monospace`;
  }
  // The value scale's band at the strip's old end: one text line tall (vertical) or wide enough
  // for a two-digit value (horizontal).
  const nextBand = next === 'v' ? tickPx + 6 : tickPx * 2 + 4;
  if (nextBand !== band) { band = nextBand; plot.style.setProperty('--band', `${band}px`); }
  if (next !== orient) { orient = next; attr(block, 'data-orient', orient); }
  measure();
  axisDirty = dirty = true;
  kick();
}
addEventListener('resize', relayout);

// ---------------------------------------------------------------- map tint
let paletteFor = null;
function loadPalette() {
  const checksum = values['/beatmap/checksum'] ?? null;
  if (!checksum) { paletteFor = null; applyPalette(block, null); recolor(); kick(); return; }
  if (checksum === paletteFor) return;
  paletteFor = checksum;
  mapPalette(checksum).then(result => {
    if (paletteFor !== checksum) return;
    applyPalette(block, result);
    recolor();
    kick();
  });
}

// ---------------------------------------------------------------- canvas sizing
// The chart is drawn in a virtual horizontal frame (cw = time length, ch = amplitude thickness;
// x 0…band is the value scale, the plot runs from band to cw). A vertical box rotates it onto the
// canvas (later time goes up, amplitude grows away from the stage side); a horizontal box uses it
// as is (orient 'h').
let cw = 0, ch = 0, nowX = 0, dpr = 1, half = 0.5, fillGrad = null, ghostGrad = null, orient = 'v';
let lastCw = -1, lastCh = -1;
let box = null;
let DASH_AVG = [4, 3];
let DASH_PEAK = [2, 3];
const DASH_NONE = [];
new ResizeObserver(([entry]) => {
  box = entry.contentRect;
  dpr = window.devicePixelRatio || 1;
  half = Math.round(dpr) % 2 ? 0.5 : 0;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  measure();
  dirty = true;
  kick();
}).observe(canvas);
document.fonts?.load(tickFont).then(() => { dirty = true; kick(); }, () => {});

// A canvas call boxes every computed fractional number it is passed (a fresh heap number per
// argument, per call); integers, and numbers already boxed, pass free. So per-frame drawing hands
// the canvas integers (device pixels for crisp lines, bin times and window sums for the trace) and
// lets a transform scale them, and the fractional arguments that change only on resize, rescale,
// a new peak or a running transition are computed once into G. Its fields start as null, so they
// keep numbers boxed and a call takes them as they are.
const G = {
  a: null, b: null, c: null, d: null, e: null, f: null, // virtual → canvas (the frame transform)
  ra: null, rb: null, rc: null, rd: null,               // its rotation alone, in device pixels
  xe: null, xf: null, ye: null, yf: null,               // + the half-pixel offset of crisp x / y lines
  dpr: null, cw: null, ch: null, base: null, baseCrisp: null, band: null,
  topD: null, baseD: null, cwD: null, bandD: null, nowD: null, nowXD: null, wide: null,
  k: null, vc: null, tx: null, sShift: null, xMid: null, headY: null, peakY: null, peakDX: null,
  pastFill: null, pastEdge: null, futFill: null, futEdge: null, futW: null, pop: null,
};

/** Virtual dimensions, transforms and gradients for the current orientation (no layout reads). */
function measure() {
  if (!box) return;
  if (orient === 'h') { cw = box.width; ch = box.height; } else { ch = box.width; cw = box.height; }
  // Virtual (x = time, y = amplitude from the top) → canvas, for the current orientation and side.
  let a = dpr, b = 0, c = 0, d = dpr, e = 0, f = 0;
  if (orient !== 'h') {
    const right = opt.align === 'right';
    a = 0; b = -dpr; c = right ? -dpr : dpr; d = 0; e = right ? ch * dpr : 0; f = cw * dpr;
  }
  G.a = a; G.b = b; G.c = c; G.d = d; G.e = e; G.f = f;
  G.ra = a / dpr; G.rb = b / dpr; G.rc = c / dpr; G.rd = d / dpr;
  G.xe = e + G.ra * half; G.xf = f + G.rb * half;
  G.ye = e + G.rc * half; G.yf = f + G.rd * half;
  G.dpr = dpr; G.cw = cw; G.ch = ch; G.base = ch - 1; G.baseCrisp = crisp(ch - 1); G.band = band;
  G.topD = chartTop * dpr; G.baseD = (ch - 1) * dpr; G.cwD = cw * dpr; G.bandD = Math.round(band * dpr);
  G.wide = 2 * dpr;
  DASH_AVG = [4 * dpr, 3 * dpr];
  DASH_PEAK = [2 * dpr, 3 * dpr];
  strainK = K.labelScale = K.vcScale = K.headScale = K.peakScale = NaN; // laid out for the old box
  if (cw !== lastCw || ch !== lastCh) {
    lastCw = cw; lastCh = ch;
    fut.snap = true; fut.to = futureTarget(); // the now line snaps to a new box
    layoutNow(fut.to);
  } else layoutNow(fut.px); // a settings change keeps its tween (stepNow)
  frameTransform();
  fillGrad = ctx.createLinearGradient(0, 0, 0, ch);
  fillGrad.addColorStop(0, `rgb(${INK} / .3)`);
  fillGrad.addColorStop(1, `rgb(${INK} / .04)`);
  ghostGrad = ctx.createLinearGradient(0, 0, 0, ch);
  ghostGrad.addColorStop(0, `rgb(${INK} / .2)`);
  ghostGrad.addColorStop(1, `rgb(${INK} / .03)`);
}

function frameTransform() { if (box) ctx.setTransform(G.a, G.b, G.c, G.d, G.e, G.f); }
/** Device-pixel frames for crisp lines: an integer x (or y) lands exactly where crisp() puts it. */
function crispX() { ctx.setTransform(G.ra, G.rb, G.rc, G.rd, G.xe, G.xf); }
function crispY() { ctx.setTransform(G.ra, G.rb, G.rc, G.rd, G.ye, G.yf); }
/** Device frame without the half-pixel offset: an even-width line centred on an integer row. */
function deviceFrame() { ctx.setTransform(G.ra, G.rb, G.rc, G.rd, G.e, G.f); }
const crisp = v => (Math.round(v * dpr) + half) / dpr;

// ---------------------------------------------------------------- now line
// The future past the now line is the map's upcoming density; without a density lane (strain off,
// or a host that sends none: the replay renderer, tosu) the strip ends at the now line instead of
// showing an empty band. A change eases (MOTION_MS.base, ease-out) unless motion is off.
const fut = { from: 0, to: 0, at: 0, px: 0, snap: true };
let nowCss = -1;
function laneOn() { return opt.strain && sn > 1 && smax > 0 && view === 'live'; }
function futureTarget() { return laneOn() ? Math.round((cw - band) * (1 - NOW_AT)) : HEADROOM; }
function layoutNow(px) {
  fut.px = px;
  nowX = Math.round(cw - px);
  G.nowD = nowX * dpr; G.nowXD = Math.round(nowX * dpr); G.futW = cw - nowX;
  if (nowX !== nowCss) { nowCss = nowX; plot.style.setProperty('--now', `${nowX}px`); }
}
/** Advances the now line toward its target; true while it is still moving. */
function stepNow(now) {
  const target = futureTarget();
  if (fut.snap || motion === 'off') {
    fut.snap = false;
    if (target !== fut.to || fut.px !== target) { fut.to = target; layoutNow(target); }
    return false;
  }
  if (target !== fut.to) { fut.from = fut.px; fut.to = target; fut.at = now; }
  if (fut.px === fut.to) return false;
  const p = Math.min(1, (now - fut.at) / MOTION_MS.base);
  const q = 1 - p;
  layoutNow(p >= 1 ? fut.to : Math.round(fut.from + (fut.to - fut.from) * (1 - q * q * q * q)));
  return fut.px !== fut.to;
}

// ---------------------------------------------------------------- attempt record
// The shared meter keeps the presses; series[b] is its window count at the end of bin b (map
// time ORIGIN + (b + 1)·BIN), sampled as the shown time passes the bin and re-sampled for REVISIT
// bins after each key message, since a press reaches the page after its gameplay time.
const meter = createKps();
const clock = createMapClock();
let series = new Uint16Array(8192);
let used = -1;          // highest sampled bin
let doneBin = -1;       // first bin not yet sampled (−1: start at the shown time)
let revisitFrom = 0x3fffffff;
let peak = 0, peakBin = -1, peakSetAt = -Infinity, popAt = -Infinity;
let baseTotal = -1, lastTotal = 0, presses = 0;
let attemptChecksum = null;
const S = { liveT: NaN, shownT: NaN, firstT: NaN, lastFrame: 0, dt: 16, scale: 10, avg: NaN, end: NaN, mix: 0 };
let rate = 1;

function ensure(size) {
  if (size < series.length) return;
  let next = series.length;
  while (next <= size) next *= 2;
  const grown = new Uint16Array(next); grown.set(series); series = grown;
}

/** Forgets the recorded run (keeps the meter's own state; see resetAttempt). */
function clearRecord() {
  if (used >= 0) series.fill(0, 0, used + 1);
  used = -1; doneBin = -1; revisitFrom = 0x3fffffff;
  peak = 0; peakBin = -1; peakSetAt = -Infinity; popAt = -Infinity;
  baseTotal = -1; lastTotal = 0; presses = 0;
  S.firstT = NaN;
  attemptChecksum = values['/beatmap/checksum'] ?? null;
  dirty = true;
}
function resetAttempt() {
  meter.reset();
  clearRecord();
}

const binOf = t => Math.max(0, Math.floor((t - ORIGIN) / BIN));
const timeOf = b => ORIGIN + (b + 1) * BIN; // a series bin describes the window ending here

/** Feeds /keys/all to the shared meter at the latest map time sample. */
function takeKeys(now) {
  const t = S.liveT;
  meter.ingest(values['/keys/all'], t === t ? t : 0, rate);
  if (!meter.available || t !== t) return;
  const total = meter.total;
  // The meter starts over when a count falls (a retry): so does the record.
  if (total < lastTotal) clearRecord();
  if (baseTotal < 0) baseTotal = total; // the first list is the baseline: those presses have no times
  else if (total > lastTotal) {
    presses = total - baseTotal;
    if (S.firstT !== S.firstT) S.firstT = t;
    const from = binOf(t - REVISIT * BIN * rate);
    if (from < revisitFrom) revisitFrom = from;
  }
  lastTotal = total;
  if (meter.peak > peak) {
    // A record that stood RECORD_MS and is broken flashes; a ramp-up (a new peak every press) does not.
    const broken = peak >= 5 && now - peakSetAt >= RECORD_MS;
    peak = meter.peak; peakBin = binOf(t); peakSetAt = now;
    if (broken && motion === 'full') flashPeak(now);
    dirty = true;
  }
}

/** Samples the meter into the series up to map time t (bins whose end has passed). */
function sample(t) {
  const nowBin = binOf(t);
  if (doneBin < 0) doneBin = nowBin;
  let b = revisitFrom < doneBin ? revisitFrom : doneBin;
  if (b < nowBin - 400) b = nowBin - 400; // after a stall, only what can still be on screen
  revisitFrom = 0x3fffffff;
  if (b >= nowBin) return;
  ensure(nowBin + 1);
  for (; b < nowBin; b++) {
    const v = meter.at(timeOf(b));
    series[b] = v === v ? v : 0;
  }
  if (nowBin - 1 > used) used = nowBin - 1;
  doneBin = nowBin;
}

// ---------------------------------------------------------------- motion
// Element animations are built once and restarted (no per-event allocation); canvas motion reads
// page time in the frame loop. Deterministic under the replay renderer's virtual clock.
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
const flash = new Animation(new KeyframeEffect(el.aEcho,
  [{ opacity: 1 }, { opacity: 1, offset: 0.25, easing: EASE_OUT }, { opacity: 0 }],
  { duration: MOTION_MS.slow, fill: 'none' }));
const fade = new Animation(new KeyframeEffect(canvas,
  [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS.base, easing: EASE_OUT, fill: 'none' }));
/** A broken record: the peak numeral lights amber and fades back; the chart's peak mark pops. */
function flashPeak(now) {
  flash.cancel(); flash.play();
  popAt = now;
}
/** The chart's content changed wholesale (retry, another view): fade it in. */
function crossfade() {
  if (motion === 'off') return;
  fade.cancel(); fade.play();
}

// ---------------------------------------------------------------- strain backdrop
let sx = new Float64Array(0), sy = new Float32Array(0), sn = 0, smax = 0;
function takeStrain() {
  sn = 0; smax = 0; strainK = NaN;
  const series = values['/performance/graph/series'];
  const xaxis = values['/performance/graph/xaxis'];
  if (!Array.isArray(series) || !Array.isArray(xaxis) || !xaxis.length) return;
  let data = null;
  for (let i = 0; i < series.length && !data; i++) if (series[i]?.name === 'strains') data = series[i].data;
  if (!data) data = series[0]?.data;
  if (!Array.isArray(data)) return;
  const n = Math.min(data.length, xaxis.length);
  if (sx.length < n) { sx = new Float64Array(n); sy = new Float32Array(n); }
  for (let i = 0; i < n; i++) {
    // xaxis is rate-adjusted (real) ms; padding samples are negative sentinels.
    sx[i] = xaxis[i] * rate;
    const v = data[i];
    sy[i] = typeof v === 'number' && v > 0 ? v : 0;
    if (sy[i] > smax) smax = sy[i];
  }
  sn = n;
}

// ---------------------------------------------------------------- state
let values = {};
let status = 'connecting';
let view = 'init';
let dirty = true, axisDirty = true;
let scaleTarget = 10;
const DRAWN = new Set(['live', 'summary', 'select']);

function decideView() {
  if (status !== 'live') return 'offline';
  const state = values['/state/number'];
  const mode = activeMode(state, values['/play/mode/number'], values['/settings/mode/number']);
  if (state === undefined || mode === null) return 'empty';
  if (mode !== 'mania') return 'hidden';
  if (isPlaying(state)) return 'live';
  const sameMap = peak > 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
  // Song select and results only on request: the page keeps its gameplay box, which on those
  // screens usually sits over osu!'s own panels (local ranking, results card, back button).
  if (!opt.menus) return 'hidden';
  // Results: osu! shows judgements, not keys per second; without a recorded run there is nothing to add.
  if (RESULTS.has(state)) return sameMap ? 'summary' : 'hidden';
  // Song select: the map's density and note rate (osu! shows neither), plus the last run on it.
  if (SELECT.has(state)) return sameMap || sn > 0 || mapRate() !== null ? 'select' : 'hidden';
  return 'hidden';
}

function setView(next) {
  if (next === view) return;
  const from = view;
  view = next;
  attr(block, 'data-view', next);
  if (next === 'live' && from !== 'live') { S.shownT = NaN; resetAttempt(); }
  chip.hidden = next !== 'offline' && next !== 'empty';
  if (next === 'offline') put(chip, status === 'offline' ? 'vosu offline' : 'Connecting to vosu');
  else if (next === 'empty') put(chip, 'osu! not running');
  axisDirty = true;
  dirty = true;
  fut.snap = true; // a view starts with its own now line, no tween
  if (DRAWN.has(from) && DRAWN.has(next)) crossfade();
}

// ---------------------------------------------------------------- render loop
let raf = 0;
function kick() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  S.dt = 16;
  if (S.lastFrame) S.dt = Math.min(100, now - S.lastFrame);
  S.lastFrame = now;
  let again = false;
  if (view === 'live') again = renderLive(now);
  else if (dirty) renderStill();
  dirty = false;
  if (again) raf = requestAnimationFrame(frame);
  else S.lastFrame = 0;
}

function targetScale() {
  const want = Math.max(8, peak * 1.14);
  const step = want <= 12 ? 2 : want <= 30 ? 5 : want <= 60 ? 10 : 20;
  return (Math.ceil(want / step) * step) | 0; // an int32 return is passed unboxed
}

const chartTop = 6;
const yOf = v => ch - 1 - (v / S.scale) * (ch - 1 - chartTop);
/** The device row crisp(yOf(v)) lies on, for drawing in the crispY frame (v an integer). */
const rowOf = v => Math.round((ch - 1 - (v / S.scale) * (ch - 1 - chartTop)) * dpr) | 0;
/** rowOf(S.avg), read in place: passing the fractional average as an argument would box it. */
const avgRow = () => Math.round((ch - 1 - (S.avg / S.scale) * (ch - 1 - chartTop)) * dpr) | 0;

const NUMBERS = Array.from({ length: 401 }, (_, i) => String(i));
const STEPS = [2, 5, 10, 20, 50, 100];
/** Scale step for the strip's thickness: at least 30 px between lines so labels never crowd. */
function gridStep() {
  const usable = ch - 1 - chartTop;
  let i = S.scale <= 12 ? 0 : S.scale <= 30 ? 1 : S.scale <= 60 ? 2 : 3; // the scale's own nice step
  while (i < STEPS.length - 1 && (STEPS[i] / S.scale) * usable < 30) i++;
  return STEPS[i];
}
/** Scale lines across the plot (device pixels from the band to x1D). */
function drawGridH(x1D) {
  const step = gridStep();
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.gridH;
  ctx.beginPath();
  crispY();
  for (let v = step; v < S.scale + 0.001; v += step) {
    const row = rowOf(v);
    if ((row + half) / dpr < chartTop - 2) break;
    ctx.moveTo(G.bandD, row); ctx.lineTo(x1D, row);
  }
  frameTransform();
  ctx.stroke();
}

// The value scale in the band at the strip's old end, upright, zero on the stage side. Laid out
// only when the scale or the box changes; LX/LY keep the positions boxed for the text calls.
const LT = new Array(64).fill(''), LX = new Array(64).fill(null), LY = new Array(64).fill(null);
const LA = new Array(64).fill('center');
let labelCount = 0, labelBaseline = 'middle';
function layoutLabels() {
  K.labelScale = S.scale;
  labelCount = 0;
  const step = gridStep();
  const vertical = orient !== 'h';
  const right = opt.align === 'right';
  const room = tickPx * 1.6; // keeps a value label clear of the zero and of the far edge
  labelBaseline = 'middle';
  for (let v = 0; v < S.scale + 0.001 && v < NUMBERS.length && labelCount < LT.length; v += step) {
    const y = yOf(v);
    let x, top, align = 'center';
    if (vertical) {
      // Canvas x of the value (the zero sits on the stage side); the band is the strip's bottom.
      x = right ? ch - y : y; top = cw - band / 2;
      if (v === 0) { x = right ? 1 : ch - 1; align = right ? 'left' : 'right'; }
      else if (x < room / 2 + 2 || x > ch - room / 2 - 2 || Math.abs(x - (right ? 0 : ch)) < room + tickPx) continue;
    } else {
      x = band / 2; top = y;
      if (v === 0) top = ch - tickPx / 2 - 1;
      else if (y < tickPx / 2 + 1 || ch - y < tickPx * 1.5) continue;
    }
    LT[labelCount] = NUMBERS[v]; LX[labelCount] = x; LY[labelCount] = top; LA[labelCount] = align;
    labelCount++;
  }
}
function drawGridLabels() {
  if (K.labelScale !== S.scale) layoutLabels();
  ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  ctx.font = tickFont;
  ctx.textBaseline = labelBaseline;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.under;
  ctx.fillStyle = C.label;
  for (let i = 0; i < labelCount; i++) {
    ctx.textAlign = LA[i];
    ctx.strokeText(LT[i], LX[i], LY[i]);
    ctx.fillText(LT[i], LX[i], LY[i]);
  }
  frameTransform();
}

/** The zero line, on the stage side, through the band to the strip's far end. */
function drawBase() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.base;
  ctx.beginPath();
  ctx.moveTo(0, G.baseCrisp); ctx.lineTo(G.cw, G.baseCrisp);
  ctx.stroke();
}

// The strain silhouette, built once per scale (k px per map ms) at absolute x = t·k; drawing
// translates it by band − t0·k. The edge is its own path: it has no segments along the base.
let strainArea = null, strainEdge = null, strainK = NaN;
function buildStrain(k) {
  strainK = k;
  strainArea = strainEdge = null;
  if (sn < 2 || smax <= 0) return;
  const top = (ch - 1 - chartTop) * 0.92;
  const base = ch - 1;
  strainArea = new Path2D();
  strainEdge = new Path2D();
  strainArea.moveTo(sx[0] * k, base);
  for (let j = 0; j < sn; j++) {
    const x = sx[j] * k, y = base - (sy[j] / smax) * top;
    strainArea.lineTo(x, y);
    if (j === 0) strainEdge.moveTo(x, y); else strainEdge.lineTo(x, y);
  }
  strainArea.lineTo(sx[sn - 1] * k, base);
  strainArea.closePath();
}
// Strain alphas. Live: behind your trace (past) it stays quiet; ahead of the now line (future) it
// is the preview and reads stronger; kiai lifts both (S.mix 0…1). Still views: behind a run, or
// the subject of song select.
const PAST_FILL = 0.1, PAST_EDGE = 0.3, FUT_FILL = 0.22, FUT_EDGE = 0.7, LIFT = 1.6;
const S_FILL = 0.12, S_EDGE = 0.35, S_FILL_LIFT = 0.26, S_EDGE_LIFT = 0.8;
/** The strain area under a transform already shifted to the plot's t0. */
function drawStrain(fill, edge) {
  ctx.fillStyle = C.map;
  ctx.strokeStyle = C.map;
  ctx.globalAlpha = fill;
  ctx.fill(strainArea);
  ctx.lineWidth = 1;
  ctx.globalAlpha = edge;
  ctx.stroke(strainEdge);
  ctx.globalAlpha = 1;
}
let mixTarget = 0, mixSettled = false;
/** S.mix toward kiai (full motion only), eased over MOTION_MS.slow; true while it moves. */
function stepKiai() {
  const target = motion === 'full' && values['/beatmap/isKiai'] === true && laneOn() ? 1 : 0;
  // Settled: compare integers only (reading the fractional S.mix would box it every frame).
  if (mixSettled && target === mixTarget) return false;
  mixTarget = target;
  let moving = false;
  if (S.mix !== target) {
    const step = motion === 'full' ? S.dt / MOTION_MS.slow : 1;
    S.mix = target > S.mix ? Math.min(target, S.mix + step) : Math.max(target, S.mix - step);
    moving = S.mix !== target;
  }
  const m = 1 + (LIFT - 1) * S.mix * S.mix * (3 - 2 * S.mix); // smoothstep
  G.pastFill = PAST_FILL * m; G.pastEdge = PAST_EDGE * m;
  G.futFill = FUT_FILL * m; G.futEdge = Math.min(1, FUT_EDGE * m);
  mixSettled = !moving;
  return moving;
}

/** A level line at device row `row` from the band to x1D (device pixels). */
function drawLevel(row, color, dash, x1D, wide) {
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.beginPath();
  if (wide) { ctx.lineWidth = G.wide; deviceFrame(); } else { ctx.lineWidth = 1; crispY(); }
  ctx.moveTo(G.bandD, row); ctx.lineTo(x1D, row);
  frameTransform();
  ctx.stroke();
  ctx.setLineDash(DASH_NONE);
}

const PEAK_MARK = new Path2D();
PEAK_MARK.moveTo(-4.5, -9); PEAK_MARK.lineTo(4.5, -9); PEAK_MARK.lineTo(0, -3.5); PEAK_MARK.closePath();
/** The peak's marker, under a transform already moved to the peak. */
function drawPeakMark() {
  ctx.fillStyle = C.you;
  ctx.fill(PEAK_MARK);
}

const TAU = Math.PI * 2;
const W_LIVE = 1.75, W_LIVE_UNDER = 4.25, W_GHOST = 1.5, W_GHOST_UNDER = 4;
/** Area + line through n points added by trace(n, area), with a dark underlay so it reads on any map. */
function drawCurve(trace, n, fill, stroke, width, under) {
  if (n < 2) return;
  ctx.beginPath();
  trace(n, true);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  trace(n, false);
  ctx.lineJoin = 'round';
  ctx.lineWidth = under;
  ctx.strokeStyle = C.under;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

// Results / song select: the whole attempt as straight segments through virtual points.
const px = new Float32Array(4096);
const py = new Float32Array(4096);
function stillTrace(n, area) {
  ctx.moveTo(px[0], py[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(px[i], py[i]);
  if (!area) return;
  const base = ch - 1;
  ctx.lineTo(px[n - 1], base);
  ctx.lineTo(px[0], base);
  ctx.closePath();
}

// Live trace: n − 1 points in the bin frame (x = map ms after the frame's reference bin end, y =
// twice the window sum, so every point and every quadratic midpoint is an integer), then the head
// at (nowX, headY) in the virtual frame. The bin frame maps x·k + tx and base + y·vc.
const TX = new Int32Array(4096);
const TY = new Int32Array(4096);
function binFrame() { ctx.transform(G.k, 0, 0, G.vc, G.tx, G.base); }
function liveTrace(n, area) {
  binFrame();
  ctx.moveTo(TX[0], TY[0]);
  if (n >= 3) {
    for (let i = 1; i < n - 2; i++) ctx.quadraticCurveTo(TX[i], TY[i], (TX[i] + TX[i + 1]) >> 1, (TY[i] + TY[i + 1]) >> 1);
    ctx.quadraticCurveTo(TX[n - 2], TY[n - 2], G.xMid, (TY[n - 2] >> 1) + headSum);
  }
  frameTransform();
  ctx.lineTo(nowX, G.headY);
  if (!area) return;
  ctx.lineTo(nowX, G.base);
  binFrame();
  ctx.lineTo(TX[0], 0);
  ctx.closePath();
  frameTransform();
}

const SMOOTH = 6; // bins (300 ms) of display smoothing; readouts stay exact
/** Sum of the series over the m bins ending at e (the trace shows its mean). */
function sumTo(e, m) {
  let sum = 0;
  for (let j = Math.max(0, e - m + 1); j <= e; j++) sum += series[j];
  return sum;
}

// Boxed values in G recomputed only when what they depend on changes. The fractional keys sit in
// K's number fields (written in place); measure() resets the scales for the new box.
const K = { vcScale: NaN, headScale: NaN, peakScale: NaN, peakDXK: NaN, shiftK: NaN, labelScale: NaN };
let vcM = 0, headSum = -1, headDen = 0, peakFor = -1, peakDXBin = -1, peakDXRef = -1, shiftRef = -1;

function clearCanvas() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  frameTransform();
}
/** Clips to the plot from the band to x (virtual). */
function clipPlot(x) {
  ctx.save();
  ctx.beginPath(); ctx.rect(G.band, 0, x, G.ch); ctx.clip();
}

function renderLive(now) {
  let t = clock.now(now);
  if (t < S.shownT && S.shownT - t < 400) t = S.shownT; // never jitter backwards
  S.shownT = t;
  scaleTarget = targetScale();
  if (motion === 'off') S.scale = scaleTarget;
  else S.scale += (scaleTarget - S.scale) * (1 - Math.exp(-S.dt / 140));
  if (Math.abs(scaleTarget - S.scale) < 0.01) S.scale = scaleTarget;
  const scaling = S.scale !== scaleTarget;
  const easing = stepNow(now);
  const lifting = stepKiai();
  const popping = motion === 'full' && now - popAt < MOTION_MS.base;

  clearCanvas();
  const keysPresent = meter.available;
  if (t !== t || !cw) {
    drawBase();
    readouts(UNKNOWN, keysPresent);
    return scaling || easing;
  }
  if (keysPresent) sample(t);
  const span = spanS * 1000 * rate;       // map ms of history
  const k = (nowX - band) / span;         // px per map ms
  const t0 = t - span;                    // at x = band
  const t1 = t + (cw - nowX) / k;
  if (k !== G.k) G.k = k;
  // The bin frame's reference: the end of the first trace slice that can be in view. Its offset
  // tx is the one fractional argument every frame needs.
  const stride = Math.max(1, Math.ceil(2.5 / (k * BIN)));
  let ref = Math.max(0, Math.floor((t0 - stride * BIN - ORIGIN) / BIN));
  ref -= ref % stride;
  const xRef = ORIGIN + (ref + stride) * BIN;
  G.tx = band + (xRef - t0) * k;

  // Chart-recorder grid anchored to time: 1 s minor, 5 s (or 10 s) major.
  const second = 1000 * rate;
  const major = spanS > 30 ? 10 : 5;
  ctx.lineWidth = 1;
  if (k * second >= 8) {
    ctx.strokeStyle = C.gridMinor;
    ctx.beginPath();
    crispX();
    for (let s = Math.ceil(t0 / second); s * second <= t1; s++) {
      if (s % major === 0) continue;
      const x = Math.round((band + (s * second - t0) * k) * dpr) | 0;
      ctx.moveTo(x, G.topD); ctx.lineTo(x, G.baseD);
    }
    frameTransform();
    ctx.stroke();
  }
  ctx.strokeStyle = C.gridMajor;
  ctx.beginPath();
  crispX();
  for (let s = Math.ceil(t0 / (second * major)); s * second * major <= t1; s++) {
    const x = Math.round((band + (s * second * major - t0) * k) * dpr) | 0;
    ctx.moveTo(x, G.topD); ctx.lineTo(x, G.baseD);
  }
  frameTransform();
  ctx.stroke();

  if (opt.strain) {
    if (k !== strainK) buildStrain(k);
    if (strainArea) {
      if (xRef !== shiftRef || k !== K.shiftK) { shiftRef = xRef; K.shiftK = k; G.sShift = -xRef * k; }
      clipPlot(nowX - band);
      ctx.translate(G.tx, 0); ctx.translate(G.sShift, 0); // band − t0·k
      drawStrain(G.pastFill, G.pastEdge);
      ctx.restore();
      if (nowX < cw) {
        ctx.save();
        ctx.beginPath(); ctx.rect(nowX, 0, G.futW, G.ch); ctx.clip();
        ctx.translate(G.tx, 0); ctx.translate(G.sShift, 0);
        drawStrain(G.futFill, G.futEdge);
        ctx.restore();
      }
      frameTransform();
    }
  }
  drawGridH(G.cwD);

  const nowBin = binOf(t);
  const current = keysPresent ? meter.at(t | 0) : UNKNOWN;
  average(false);
  if (keysPresent && S.avg === S.avg) drawLevel(avgRow(), C.avg, DASH_AVG, G.nowD, false);
  if (keysPresent && peak > 0) drawLevel(rowOf(peak), C.you, DASH_PEAK, G.nowD, true);

  // The live head sits on the trace's last mean (or the exact count before the first press).
  // G.headY / G.peakY change only with it or the scale; computed here rather than in helpers,
  // since renderLive is optimised long before a small helper is and unoptimised arithmetic boxes.
  const m = Math.max(stride, SMOOTH);
  const tracing = keysPresent && S.firstT === S.firstT && used >= 0;
  if (keysPresent) {
    const num = tracing ? sumTo(nowBin - 1, m) : current === current ? current : 0;
    const den = tracing ? m : 1;
    if (num !== headSum || den !== headDen || S.scale !== K.headScale) {
      headSum = num; headDen = den; K.headScale = S.scale;
      G.headY = ch - 1 - ((num / den) / S.scale) * (ch - 1 - chartTop);
    }
  }

  // KPS trace: points every `stride` bins, anchored to absolute bins so the shape never shimmers;
  // each point averages the last SMOOTH bins of window counts so ±1 flicker reads as a line.
  if (tracing) {
    let b = Math.max(0, Math.floor((Math.max(t0 - stride * BIN, S.firstT - 1000 * rate) - ORIGIN) / BIN));
    b -= b % stride;
    let n = 0;
    for (; b + stride <= nowBin && n < TX.length - 1; b += stride) {
      const e = b + stride - 1;
      TX[n] = ORIGIN + (e + 1) * BIN - xRef;
      TY[n] = 2 * sumTo(e, m);
      n++;
    }
    if (S.scale !== K.vcScale || m !== vcM) { K.vcScale = S.scale; vcM = m; G.vc = -(ch - 1 - chartTop) / (2 * m * S.scale); }
    if (n >= 2) G.xMid = (TX[n - 1] + (t - xRef)) / 2; // last point ↔ head
    clipPlot(nowX - band);
    drawCurve(liveTrace, n + 1, fillGrad, C.line, W_LIVE, W_LIVE_UNDER);
    ctx.restore();
    frameTransform();
    if (peakBin >= 0) {
      const x = band + (timeOf(peakBin) - t0) * k;
      if (x >= band && x <= nowX) {
        if (peak !== peakFor || S.scale !== K.peakScale) {
          peakFor = peak; K.peakScale = S.scale;
          G.peakY = ch - 1 - (peak / S.scale) * (ch - 1 - chartTop);
        }
        if (peakBin !== peakDXBin || xRef !== peakDXRef || k !== K.peakDXK) {
          peakDXBin = peakBin; peakDXRef = xRef; K.peakDXK = k;
          G.peakDX = k * (timeOf(peakBin) - xRef);
        }
        ctx.translate(G.tx, G.peakY); ctx.translate(G.peakDX, 0);
        if (popping) {
          const q = 1 - (now - popAt) / MOTION_MS.base;
          G.pop = 1 + 0.8 * q * q * q; // ease-out back to size
          ctx.scale(G.pop, G.pop);
        }
        drawPeakMark();
        frameTransform();
      }
    }
  }

  // Now line and live head (yours: amber).
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.now;
  ctx.beginPath();
  crispX();
  ctx.moveTo(G.nowXD, 0); ctx.lineTo(G.nowXD, G.baseD);
  frameTransform();
  ctx.stroke();
  if (keysPresent) {
    ctx.fillStyle = C.halo;
    ctx.beginPath(); ctx.arc(nowX, G.headY, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = C.you;
    ctx.beginPath(); ctx.arc(nowX, G.headY, 3, 0, TAU); ctx.fill();
  }
  drawBase();
  if (keysPresent) drawGridLabels();
  readouts(current, keysPresent);
  const advancing = clock.moving && now - clock.sampledAt < HOLD;
  return advancing || scaling || easing || lifting || popping;
}

/** S.avg: presses per real second since the first press, up to the shown time (or the end of the
 * map when `toEnd`); NaN while there is too little to say. */
function average(toEnd) {
  S.avg = NaN;
  if (S.firstT !== S.firstT || presses < 2) return;
  // Separate stores, not `toEnd ? Infinity : S.shownT`: that merge would box the shown time.
  if (toEnd) S.end = timeOf(used); else S.end = S.shownT;
  const lastObject = values['/beatmap/time/lastObject'];
  if (typeof lastObject === 'number' && lastObject + 500 < S.end) S.end = lastObject + 500;
  const seconds = (S.end - S.firstT) / rate / 1000;
  if (seconds >= 1) S.avg = presses / seconds;
}

/** The map's average note rate in notes per real second (one press per mania object). */
function mapRate() {
  const objects = values['/beatmap/stats/objects/total'];
  const first = values['/beatmap/time/firstObject'];
  const last = values['/beatmap/time/lastObject'];
  if (typeof objects !== 'number' || typeof first !== 'number' || typeof last !== 'number' || last - first < 1000 || objects < 1) return null;
  return objects / ((last - first) / rate / 1000);
}

function renderStill() {
  // Leaving for a hidden view keeps the last frame while the page fades out.
  if (!cw || (view !== 'summary' && view !== 'select')) { readouts(UNKNOWN, true); return; }
  clearCanvas();
  const run = peak > 0 && used >= 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
  S.scale = scaleTarget = targetScale();
  const subject = view === 'select' && !run; // the map's density is the subject without a run
  const mp3 = values['/beatmap/time/mp3Length'];
  let t0 = sn ? Math.min(0, sx[0]) : 0;
  let t1 = typeof mp3 === 'number' && mp3 > 0 ? mp3 : 0;
  if (sn) t1 = Math.max(t1, sx[sn - 1]);
  if (run) { t0 = Math.min(t0, S.firstT - 1000); t1 = Math.max(t1, timeOf(used)); }
  if (t1 > t0) {
    // Time runs upward over the whole map, from the value band to the far end.
    const k = (cw - band) / (t1 - t0);
    if (opt.strain) {
      if (k !== strainK) buildStrain(k);
      if (strainArea) {
        clipPlot(G.cw); ctx.translate(band - t0 * k, 0);
        drawStrain(subject ? S_FILL_LIFT : S_FILL, subject ? S_EDGE_LIFT : S_EDGE);
        ctx.restore(); frameTransform();
      }
    }
    if (run) {
      drawGridH(G.cwD);
      average(true);
      if (S.avg === S.avg) drawLevel(avgRow(), C.avg, DASH_AVG, G.cwD, false);
      drawLevel(rowOf(peak), C.you, DASH_PEAK, G.cwD, true);
      // Whole attempt, ~2 px per point: the highest window value in each slice, so the envelope
      // meets the peak marker exactly.
      const per = Math.max(1, Math.round(2 / (k * BIN)));
      let n = 0;
      let b = binOf(S.firstT - 1000 * rate);
      b -= b % per;
      for (; b <= used && n < px.length - 1; b += per) {
        let top = 0;
        for (let j = b; j < b + per; j++) if (series[j] > top) top = series[j];
        px[n] = band + (timeOf(b + per - 1) - t0) * k;
        py[n] = yOf(top);
        n++;
      }
      if (n) { px[n] = px[n - 1] + 1; py[n] = ch - 1; n++; } // the run ends on the baseline
      drawCurve(stillTrace, n, ghostGrad, C.ghost, W_GHOST, W_GHOST_UNDER);
      if (peakBin >= 0) {
        ctx.translate(band + (timeOf(peakBin) - t0) * k, yOf(peak));
        drawPeakMark();
        frameTransform();
      }
    }
  }
  drawBase();
  if (run) drawGridLabels();
  if (axisDirty) {
    axisDirty = false;
    const has = t1 > t0;
    put(el.axisL, has ? formatDuration(Math.max(0, t0) / rate) : '');
    put(el.axisM, has ? formatDuration(Math.max(0, (t0 + t1) / 2) / rate) : '');
    put(el.axisR, has ? formatDuration(t1 / rate) : '');
  }
  readouts(UNKNOWN, true);
}

// ---------------------------------------------------------------- DOM readouts
// One formatter per displayed field (docs/overlay-system.md "Numbers"): each returns the same
// string until its shown value changes, so a steady readout allocates nothing per frame.
const fmtHero = numberFormatter('kps');
const fmtPeak = numberFormatter('kps');
const fmtAvg = numberFormatter('kps');
const fmtKeys = numberFormatter('count');
/** The average rounded to its shown precision (an integer passes unboxed; the format has 0 decimals). */
const avgShown = () => (S.avg === S.avg ? Math.round(S.avg) : UNKNOWN);
let shownView = '';

/** The labels of one view, written when the view (or whether a run exists) changes. */
function labels(phase, p, unit, a, b, aKey, bKey) {
  put(el.phase, phase); put(el.pLabel, p); put(el.pUnit, unit);
  put(el.aName, a); put(el.bName, b);
  attr(el.aLabel, 'data-key', aKey); attr(el.bLabel, 'data-key', bKey);
}
function showPeak(text) {
  show(el.aValue, text);
  put(el.aEcho, text);
}

/** `current`: the live window's count (UNKNOWN when there is none to show). */
function readouts(current, keysPresent) {
  if (view === 'live') {
    if (shownView !== 'live') { shownView = 'live'; labels('', '', 'kps', 'Peak', 'Avg', 'peak', 'avg'); }
    show(el.pValue, fmtHero(current));
    showPeak(keysPresent && peak > 0 ? fmtPeak(peak) : DASH);
    show(el.bValue, keysPresent ? fmtAvg(avgShown()) : DASH);
    if (note.hidden !== keysPresent) note.hidden = keysPresent;
    if (!keysPresent) put(note, 'No key data from this host (vosu sends it with its key overlay enabled).');
    return;
  }
  if (!note.hidden) note.hidden = true;
  if (view === 'summary') {
    if (shownView !== 'summary') { shownView = 'summary'; labels('Your run', 'Peak', 'kps', 'Avg', 'Keys', 'avg', 'none'); }
    show(el.pValue, fmtHero(peak));
    average(true);
    showPeak(fmtAvg(avgShown()));
    show(el.bValue, fmtKeys(meter.total));
    return;
  }
  if (view === 'select') {
    // osu! shows object counts and length, not the rate they add up to, nor where it peaks.
    const run = peak > 0 && used >= 0 && attemptChecksum !== null && attemptChecksum === values['/beatmap/checksum'];
    const key = run ? 'select-run' : 'select';
    if (shownView !== key) {
      shownView = key;
      if (run) labels('This map', 'Average', 'nps', 'Peak', 'Avg', 'peak', 'avg');
      else labels('This map', 'Average', 'nps', '', '', 'none', 'none');
    }
    const r = mapRate();
    show(el.pValue, fmtHero(r === null ? UNKNOWN : r));
    if (run) {
      showPeak(fmtPeak(peak));
      average(true);
      show(el.bValue, fmtAvg(avgShown()));
    } else { showPeak(''); show(el.bValue, ''); }
  }
}

// ---------------------------------------------------------------- wiring
settings(DEFAULTS, applySettings);
subscribe(POINTERS, (next, changed) => {
  values = next;
  const now = performance.now();
  if (changed.has('/beatmap/time/rate') || changed.has('/play/mods/rate')) {
    const r = values['/beatmap/time/rate'] ?? values['/play/mods/rate'];
    const fresh = typeof r === 'number' && r > 0 ? r : 1;
    if (fresh !== rate) { rate = fresh; takeStrain(); dirty = axisDirty = true; }
  }
  if (changed.has('/performance/graph/series') || changed.has('/performance/graph/xaxis')) { takeStrain(); dirty = axisDirty = true; }
  setView(decideView());
  if (changed.has('/beatmap/time/live')) {
    const t = values['/beatmap/time/live'];
    if (typeof t === 'number') {
      // A large backwards jump during play is a retry or rewind.
      if (view === 'live' && t < S.liveT - 1500) { resetAttempt(); S.shownT = NaN; crossfade(); }
      S.liveT = t;
    } else S.liveT = NaN;
    clock.sample(t, rate, values['/beatmap/time/firstObject'], values['/beatmap/time/lastObject'], values['/beatmap/time/mp3Length'], now);
  }
  if (view === 'live' && changed.has('/keys/all')) takeKeys(now);
  if (changed.has('/beatmap/checksum')) { loadPalette(); dirty = axisDirty = true; }
  if (changed.has('/beatmap/isKiai')) dirty = true;
  if (changed.has('/beatmap/time/mp3Length') || changed.has('/beatmap/stats/objects/total') || changed.has('/beatmap/time/lastObject')) dirty = axisDirty = true;
  if (view === 'live' || dirty) kick();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    setView(decideView());
    kick();
  },
});

// Copyright (c) 2026 18-LAB. MIT.
// Catcher trail: an osu!catch movement seismograph from vosu's /play/catcher {x, dashing}.
// The page is the overlay's box (hosts place and size it); the layout re-flows to the box's shape.
import { subscribe, settings, activeMode, isPlaying, mapPalette } from './vosu-overlay.js';

const PLAYFIELD = 512;           // catcher x range in osu! pixels; one "screen" of travel
const LANE = 4, GAP = 6;         // dash event lane, then the chart
const CHART = LANE + GAP;        // lane + gap on the across axis
const RULER = 12;                // tick band past the "now" edge
const WIDE = 1.8;                // auto orientation: boxes at least this wide lay out horizontally
const NARROW = 240;              // vertical boxes narrower than this stack the stats
const RESULTS = 7;
const GRACE = 1500;              // ms of catch play without /play/catcher before naming vosu
const EXTRAPOLATE = 100;         // ms the head may run past the newest sample (hides frame jitter)
const SETTLE = 160;              // ms without samples before the loop parks (pause, results)
const TURN = 8;                  // px of reversal before a direction change counts
const STATS_EVERY = 250;         // readout refresh, ms
const CAP = 4096;                // trace ring; the sampling floor keeps 30 s under ~2.5k samples
const MASK = CAP - 1;

const TAU = Math.PI * 2;
const TICKS = PLAYFIELD / 32 + 1;   // ruler ticks every 32 px

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  catcher: '/play/catcher', time: '/beatmap/time/live', rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate', brk: '/beatmap/isBreak', checksum: '/beatmap/checksum',
};

const root = document.getElementById('root');
const canvas = document.getElementById('trace');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  chip: document.getElementById('chip-text'), stats: document.getElementById('stats'), span: document.getElementById('span'),
  dash: document.getElementById('dash'), travel: document.getElementById('travel'), turns: document.getElementById('turns'),
};

// ---------------------------------------------------------------- colours
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgba = (hex, a) => `rgb(${rgb(hex).join(' ')} / ${a})`;
const C = { fg: token('--fg', '#ebe8e1'), dim: token('--fg-dim', '#b8b5ad'), amber: token('--accent', '#ff963f') };
// Marks float on the game, so lines are a touch stronger than on a panel and carry a dark understroke.
const INK = {
  gridMinor: rgba(C.fg, 0.07), gridMajor: rgba(C.fg, 0.16), edge: rgba(C.fg, 0.24),
  lane: rgba(C.fg, 0.12), guide: rgba(C.fg, 0.16), tick: C.dim, now: rgba(C.fg, 0.42), halo: 'rgb(0 0 0 / .55)',
};
const TRACE_STOPS = [rgba(C.dim, 0), rgba(C.dim, 0.6), rgba(C.dim, 0.95)];
const CHIP = { offline: 'vosu offline', nodata: 'No data' };
let accent = C.amber;            // map tone or amber; drives the dash marks and live markers
let dashStops = [rgba(accent, 0), rgba(accent, 0.7), rgba(accent, 1)];
let palette = null, paletteFor = '';

// ---------------------------------------------------------------- state
const DEFAULTS = { orientation: 'auto', align: 'right', window: 6, showStats: true, showOnResults: true, backing: 'none', accent: 'map' };
let opts = { ...DEFAULTS };
let spanText = '';
let status = 'connecting';
let view = 'connecting';
let viewDirty = true, layoutDirty = true, statsDirty = true, raf = 0;
let wasPlaying = false;
let missingSince = 0;
let graceTimer = 0;
// The fields evaluate() reads, copied from the newest frame (the client reuses its values object).
let framed = false, state, playMode, selMode, hasCatcher = false, checksum = '';
let orient = 'vertical', narrow = false, laneLeft = false, typeScale = 1;   // box layout (layoutBox)
let dpr = 1, cssW = 0, cssH = 0, plotLen = 0, span = 0, line = 1;   // canvas geometry (measure)
let traceInk = null, dashInk = null, haloInk = null;         // age gradients (buildInks)

// Geometry that only moves with the box (measure): chart and lane on the across axis, snap
// offset, and the snapped playfield grid, ruler ticks and "now" edge.
let c0 = 0, end = 0, lane0 = 0, halfLine = 0.5, nowFrom = 0, nowTo = 0, nowV = 0, tickV = 0;
const minorU = new Float64Array(6), tickU = new Float64Array(TICKS), tickEnd = new Float64Array(TICKS);
let centreU = 0, edge0 = 0, edge1 = 0;
// The visible trace, filled by the trace pass and replayed by the dash pass.
const pathU = new Float64Array(CAP), pathV = new Float64Array(CAP);

// Trace ring (decimated) and attempt statistics (every sample).
const ringT = new Float64Array(CAP), ringX = new Float32Array(CAP), ringD = new Uint8Array(CAP);
let ringHead = 0, ringCount = 0;
let sampled = false, lastD = false;   // whether lastT/lastX hold a sample; newest dash flag
let pushD = 0, pendD = 0, pending = false;
let turns = 0, dir = 0;
// Doubles written per sample or frame live in object fields: V8 updates a double field in place,
// while every store to a module-level `let` allocates a new heap number.
const num = {
  lastT: 0, lastX: 0,                 // newest sample
  pushT: 0, pushX: 0,                 // newest stored sample
  pendT: 0, pendX: 0,                 // newest unstored sample
  sampleWall: 0, headT: -Infinity, statsAt: 0,
  activeMs: 0, dashMs: 0, distance: 0, extreme: 0,
};

function resetAttempt() {
  ringHead = 0; ringCount = 0; sampled = false; pending = false; num.headT = -Infinity;
  num.activeMs = 0; num.dashMs = 0; num.distance = 0; turns = 0; dir = 0;
  statsDirty = true;
}

function store(t, x, d) {
  ringT[ringHead] = t; ringX[ringHead] = x; ringD[ringHead] = d;
  ringHead = (ringHead + 1) & MASK;
  if (ringCount < CAP) ringCount++;
  num.pushT = t; num.pushX = x; pushD = d; pending = false;
}

function ingest(t, x, dashing, inBreak, now) {
  const d = dashing ? 1 : 0;
  if (!sampled) {
    num.extreme = x;
    store(t, x, d);
  } else {
    const dt = t - num.lastT;
    if (dt >= 0 && dt < 250) {
      if (dt > 0 && !inBreak) { num.activeMs += dt; if (lastD) num.dashMs += dt; }
      num.distance += Math.abs(x - num.lastX);
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

  const live = values[P.time];
  if (playing && catcher && typeof catcher.x === 'number' && typeof live === 'number'
      && (changed.has(P.catcher) || changed.has(P.time))) {
    const rate = values[P.rate] > 0 ? values[P.rate] : values[P.modsRate] > 0 ? values[P.modsRate] : 1;
    const t = live / rate;                       // gameplay ms on the wall-clock scale
    if (sampled && t < num.lastT - 500) resetAttempt();   // retry or seek back
    ingest(t, Math.min(PLAYFIELD, Math.max(0, catcher.x)), catcher.dashing === true, values[P.brk] === true, now);
    kick();
  }
  if (changed.has(P.checksum)) { checksum = values[P.checksum] || ''; loadPalette(); }
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
  } else if (mode === 'fruits' && state === RESULTS && ringCount && opts.showOnResults && opts.showStats) next = 'final';
  if (!isPlaying(state)) missingSince = 0;
  setView(next);
}

function setView(next) {
  if (next === view) return;
  view = next; viewDirty = true; statsDirty = true;
  kick();
}

// ---------------------------------------------------------------- map tone
function loadPalette() {
  if (opts.accent !== 'map' || !checksum) { setAccent(null); return; }
  if (checksum === paletteFor) { setAccent(palette); return; }
  const wanted = paletteFor = checksum;
  mapPalette(wanted).then(result => {
    if (paletteFor !== wanted) return;
    palette = result;
    setAccent(opts.accent === 'map' ? result : null);
  });
}

function setAccent(result) {
  const next = result?.accent || C.amber;
  if (next === accent) return;
  accent = next;
  dashStops = [rgba(accent, 0), rgba(accent, 0.7), rgba(accent, 1)];
  root.style.setProperty('--ct-accent', accent);
  buildInks();
  kick();
}

// ---------------------------------------------------------------- settings
settings(DEFAULTS, s => {
  opts = {
    orientation: ['vertical', 'horizontal'].includes(s.orientation) ? s.orientation : 'auto',
    align: s.align === 'left' ? 'left' : 'right',
    window: Math.min(30, Math.max(2, s.window)),
    showStats: s.showStats, showOnResults: s.showOnResults,
    backing: ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none',
    accent: s.accent === '18-lab' ? '18-lab' : 'map',
  };
  spanText = `−${opts.window} s`;
  viewDirty = true;
  if (framed) { loadPalette(); evaluate(performance.now()); }
  layoutBox();
});

// ---------------------------------------------------------------- box layout
/** Orientation from the box's aspect (or the setting) and a type scale from its size. */
function layoutBox() {
  const w = innerWidth || 340, h = innerHeight || 280;
  orient = opts.orientation === 'auto' ? (w / h >= WIDE ? 'horizontal' : 'vertical') : opts.orientation;
  laneLeft = orient === 'horizontal' || opts.align === 'left';
  narrow = orient === 'vertical' && w < NARROW;
  const k = orient === 'vertical' ? Math.min(w / 340, h / 280) : Math.min(h / 150, w / 700);
  typeScale = Math.round(Math.min(1.6, Math.max(0.75, k)) * 100) / 100;
  layoutDirty = true;
  measure();
  kick();
}
addEventListener('resize', layoutBox);

// ---------------------------------------------------------------- canvas geometry
/** Centre of a crisp hairline at logical coordinate p. */
const snap = p => (Math.round(p * dpr - halfLine) + halfLine) / dpr;

function measure() {
  if (!cssW) return;
  dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const vertical = orient === 'vertical';
  span = Math.max(1, (vertical ? cssW : cssH) - CHART);
  plotLen = Math.max(1, (vertical ? cssH : cssW) - RULER);
  line = Math.max(1, Math.round(dpr)) / dpr;
  halfLine = 0.5 * line * dpr;

  // Logical "vertical" coordinates: u across (playfield), v along (time, 0 = oldest).
  const len = plotLen;
  c0 = laneLeft ? CHART : 0; end = c0 + span;                    // chart on the across axis
  lane0 = laneLeft ? 0 : span + GAP;                              // dash lane on the outer side
  for (let k = 1, m = 0; k < 8; k++) if (k !== 4) minorU[m++] = snap(c0 + (k * span) / 8);
  centreU = snap(c0 + span / 2);
  edge0 = snap(c0); edge1 = snap(end);
  // Ruler ticks: 32 px minor, 64 px mid, 128 px labelled.
  tickV = len + 2;
  for (let i = 0; i < TICKS; i++) {
    const p = i * 32;
    tickU[i] = snap(c0 + (p / PLAYFIELD) * span);
    tickEnd[i] = len + 2 + (p % 128 === 0 ? 8 : p % 64 === 0 ? 5 : 3);
  }
  nowFrom = Math.min(c0, lane0); nowTo = Math.max(end, lane0 + LANE); nowV = snap(len);
  buildInks();
  kick();
}

/** Age gradients along the time axis (logical v), rebuilt on resize and accent change only. */
function buildInks() {
  traceInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  traceInk.addColorStop(0, TRACE_STOPS[0]);
  traceInk.addColorStop(0.45, TRACE_STOPS[1]);
  traceInk.addColorStop(1, TRACE_STOPS[2]);
  dashInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  dashInk.addColorStop(0, dashStops[0]);
  dashInk.addColorStop(0.4, dashStops[1]);
  dashInk.addColorStop(1, dashStops[2]);
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
  const animating = view === 'live' && now - num.sampleWall < SETTLE;
  if (view === 'live' && sampled) {
    const target = num.lastT + Math.min(now - num.sampleWall, EXTRAPOLATE);
    if (target > num.headT) num.headT = target;
  }
  if (view === 'live' && cssW) draw();
  if (statsDirty || (animating && now - num.statsAt >= STATS_EVERY) || (!animating && view === 'live')) {
    writeStats(); num.statsAt = now; statsDirty = false;
  }
  if (animating) raf = requestAnimationFrame(frame);
}

function applyLayout() {
  layoutDirty = false;
  if (root.dataset.orient !== orient) root.dataset.orient = orient;
  if (root.dataset.align !== opts.align) root.dataset.align = opts.align;
  root.toggleAttribute('data-narrow', narrow);
  root.style.setProperty('--k', typeScale);
}

function applyView() {
  viewDirty = false;
  root.dataset.view = view;
  if (root.dataset.backing !== opts.backing) root.dataset.backing = opts.backing;
  el.stats.hidden = !opts.showStats;
  setText(el.span, spanText);
  setText(el.chip, CHIP[view] || 'Connecting');
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

// Readouts as shown (-1 = "—", the markup's initial text); text is formatted only when one changes.
let dashShown = -1, travelShown = -1, turnsShown = -1;
function writeStats() {
  const has = (view === 'live' || view === 'final') && sampled;
  const active = num.activeMs;
  const dash = (num.dashMs / active) * 100;
  const dashKey = has && active >= 1000 ? Math.round(dash * 10) : -1;
  if (dashKey !== dashShown) { dashShown = dashKey; el.dash.textContent = dashKey < 0 ? '—' : dash.toFixed(1); }
  // Screens: one decimal below 100, whole numbers above (keys -2 and below).
  const screens = num.distance / PLAYFIELD;
  const travelKey = !has ? -1 : screens >= 100 ? -2 - Math.round(screens) : Math.round(screens * 10);
  if (travelKey !== travelShown) {
    travelShown = travelKey;
    el.travel.textContent = travelKey === -1 ? '—' : screens >= 100 ? Math.round(screens).toFixed(0) : screens.toFixed(1);
  }
  const turnsKey = has && active >= 3000 ? Math.round(turns / (active / 60000)) : -1;
  // Integers via toFixed(0): same text as toString, without V8's number-string cache (rebuilt as
  // one 64 KB block after every full GC).
  if (turnsKey !== turnsShown) { turnsShown = turnsKey; el.turns.textContent = turnsKey < 0 ? '—' : turnsKey.toFixed(0); }
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw in logical "vertical" coordinates: u across (playfield), v along (time, 0 = oldest).
  // Horizontal is the transpose, so one code path serves both orientations.
  if (orient === 'vertical') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(0, dpr, dpr, 0, 0, 0);

  const len = plotLen;
  const windowMs = opts.window * 1000;
  const traced = ringCount > 0;
  const head = traced ? (num.headT > -Infinity ? num.headT : num.lastT) : 0;
  const pxPerMs = len / windowMs;

  // Lane bed and playfield grid: edges and centre stronger, 64 px divisions faint.
  ctx.fillStyle = INK.lane;
  ctx.fillRect(lane0, 0, LANE, len);
  ctx.lineWidth = line;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) { ctx.moveTo(minorU[k], 0); ctx.lineTo(minorU[k], len); }
  // Seconds scroll with gameplay time; every fifth is major.
  const first = Math.ceil((head - windowMs) / 1000);
  for (let s = first; s * 1000 <= head; s++) {
    if (!(s % 5)) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(c0, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMinor; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centreU, 0); ctx.lineTo(centreU, len);
  for (let s = first; s * 1000 <= head; s++) {
    if (s % 5) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(c0, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMajor; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(edge0, 0); ctx.lineTo(edge0, len);
  ctx.moveTo(edge1, 0); ctx.lineTo(edge1, len);
  ctx.strokeStyle = INK.edge; ctx.stroke();

  // Ruler ticks, then the "now" edge across chart and lane.
  ctx.beginPath();
  for (let i = 0; i < TICKS; i++) { ctx.moveTo(tickU[i], tickV); ctx.lineTo(tickU[i], tickEnd[i]); }
  ctx.strokeStyle = INK.tick; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(nowFrom, nowV); ctx.lineTo(nowTo, nowV);
  ctx.strokeStyle = INK.now; ctx.stroke();
  if (!traced) return;

  // Oldest visible sample (one before the window edge keeps the line continuous).
  const from = head - windowMs;
  let n = 0;
  let i = (ringHead - 1) & MASK;
  while (n < ringCount && ringT[i] >= from) { n++; i = (i - 1) & MASK; }
  if (n < ringCount) n++;
  const start = (ringHead - n) & MASK;

  // Dash lane runs and the trace in one walk; dash segments re-stroked in the accent afterwards.
  ctx.fillStyle = accent;
  ctx.beginPath();
  let runFrom = -1, pv = 0, pd = 0;
  for (let k = 0; k < n; k++) {
    const j = (start + k) & MASK;
    const u = c0 + (ringX[j] / PLAYFIELD) * span;
    const v = Math.max(0, len - (head - ringT[j]) * pxPerMs);
    pathU[k] = u; pathV[k] = v;
    if (k === 0) ctx.moveTo(u, v); else ctx.lineTo(u, v);
    if (k > 0) {
      if (pd && runFrom < 0) runFrom = pv;
      if (!pd && runFrom >= 0) { ctx.fillRect(lane0, runFrom, LANE, pv - runFrom); runFrom = -1; }
    }
    pv = v; pd = ringD[j];
  }
  const nu = c0 + (num.lastX / PLAYFIELD) * span;
  ctx.lineTo(nu, len);
  if (lastD && runFrom < 0) runFrom = pv;
  if (runFrom >= 0) ctx.fillRect(lane0, runFrom, LANE, len - runFrom);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = haloInk; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = traceInk; ctx.lineWidth = 1.75; ctx.stroke();

  ctx.beginPath();
  let on = false;
  for (let k = 0; k < n; k++) {
    if (on) ctx.lineTo(pathU[k], pathV[k]);
    const d = ringD[(start + k) & MASK];
    if (d && !on) { ctx.moveTo(pathU[k], pathV[k]); on = true; } else if (!d) on = false;
  }
  if (on) ctx.lineTo(nu, len);
  ctx.strokeStyle = dashInk; ctx.lineWidth = 3.25; ctx.stroke();

  // Now: guide through the chart, pen head and ruler caret (dark-edged so they hold on any map).
  const gu = snap(nu);
  ctx.lineWidth = line;
  ctx.beginPath(); ctx.moveTo(gu, 0); ctx.lineTo(gu, len); ctx.strokeStyle = INK.guide; ctx.stroke();
  ctx.fillStyle = lastD ? accent : C.fg;
  ctx.strokeStyle = INK.halo; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(nu, len - 0.5, 3.5, 0, TAU); ctx.stroke(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(nu, len + 1.5); ctx.lineTo(nu + 5.5, len + RULER); ctx.lineTo(nu - 5.5, len + RULER); ctx.closePath();
  ctx.stroke(); ctx.fill();
}

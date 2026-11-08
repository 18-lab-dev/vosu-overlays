// Copyright (c) 2026 18-LAB. MIT.
// Catcher trail: an osu!catch movement seismograph from vosu's /play/catcher {x, dashing}, placed in
// the side band beside the catch playfield with its ruler level with the catcher.
import { subscribe, settings, fit, activeMode, isPlaying, osuLayout, mapPalette } from './vosu-overlay.js';

const W = 1920, H = 1080;        // transparent source over the full osu! window
const PLAYFIELD = 512;           // catcher x range in osu! pixels; one "screen" of travel
const LANE = 4, GAP = 6;         // dash event lane, then the chart
const CHART = LANE + GAP;        // chart start on the across axis
const SPAN = 256;                // chart width: half a playfield pixel per osu! pixel
const RULER = 12;                // tick band past the "now" edge
const OUTER_W = 302;             // cluster box incl. padding and border (style.css)
const BELOW_BASELINE = 40;       // ruler band + labels + padding under the "now" edge
const EDGE_GAP = 12;             // cluster box to playfield edge
const CATCHER_LIFT = 56;         // "now" edge above the playfield's bottom, level with the catcher plate
const RESULTS = 7;
const GRACE = 1500;              // ms of catch play without /play/catcher before naming vosu
const EXTRAPOLATE = 100;         // ms the head may run past the newest sample (hides frame jitter)
const SETTLE = 160;              // ms without samples before the loop parks (pause, results)
const TURN = 8;                  // px of reversal before a direction change counts
const STATS_EVERY = 250;         // readout refresh, ms
const CAP = 4096;                // trace ring; the sampling floor keeps 30 s under ~2.5k samples
const RESULTS_RIGHT = 20, RESULTS_TOP = 22; // results: right end of stable's top header strip (x≈1000–1900, y≈8–130)

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  catcher: '/play/catcher', time: '/beatmap/time/live', rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate', brk: '/beatmap/isBreak', checksum: '/beatmap/checksum',
};

const stage = document.getElementById('stage');
const cluster = document.getElementById('cluster');
const canvas = document.getElementById('trace');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  chip: document.getElementById('chip-text'), status: document.getElementById('status-text'),
  brand: document.getElementById('brand'), stats: document.getElementById('stats'), span: document.getElementById('span'),
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
let accent = C.amber;            // map tone or 18-LAB amber; drives the dash marks and live markers
let palette = null, paletteFor = '';

// ---------------------------------------------------------------- state
const DEFAULTS = {
  zone: 'auto', x: 0, y: 0, scale: 1, window: 6, orientation: 'vertical',
  showStats: true, showOnResults: true, backing: 'none', accent: 'map', showBrand: true,
};
let opts = { ...DEFAULTS };
let status = 'connecting';
let view = 'connecting';
let viewDirty = true, placeDirty = true, statsDirty = true, statsAt = 0, raf = 0;
let wasPlaying = false;
let missingSince = 0;
let graceTimer = 0;
let values = null;
let dpr = 1, cssW = 0, cssH = 0, plotLen = 0, line = 1;   // canvas geometry (measure)
let traceInk = null, dashInk = null, haloInk = null;     // age gradients (buildInks)

// Trace ring (decimated) and attempt statistics (every sample).
const ringT = new Float64Array(CAP), ringX = new Float32Array(CAP), ringD = new Uint8Array(CAP);
let ringHead = 0, ringCount = 0;
let lastT = null, lastX = 0, lastD = false;       // newest sample
let pushT = 0, pushX = 0, pushD = 0;              // newest stored sample
let pendT = 0, pendX = 0, pendD = 0, pending = false;
let sampleWall = 0, headT = -Infinity;
let activeMs = 0, dashMs = 0, distance = 0, turns = 0, dir = 0, extreme = 0;

function resetAttempt() {
  ringHead = 0; ringCount = 0; lastT = null; pending = false; headT = -Infinity;
  activeMs = 0; dashMs = 0; distance = 0; turns = 0; dir = 0;
  statsDirty = true;
}

function store(t, x, d) {
  ringT[ringHead] = t; ringX[ringHead] = x; ringD[ringHead] = d;
  ringHead = (ringHead + 1) & (CAP - 1);
  if (ringCount < CAP) ringCount++;
  pushT = t; pushX = x; pushD = d; pending = false;
}

function ingest(t, x, dashing, inBreak, now) {
  const d = dashing ? 1 : 0;
  if (lastT === null) {
    extreme = x;
    store(t, x, d);
  } else {
    const dt = t - lastT;
    if (dt >= 0 && dt < 250) {
      if (dt > 0 && !inBreak) { activeMs += dt; if (lastD) dashMs += dt; }
      distance += Math.abs(x - lastX);
      if (dir === 0) {
        if (Math.abs(x - extreme) > TURN) { dir = x > extreme ? 1 : -1; extreme = x; }
      } else if (dir === 1) {
        if (x > extreme) extreme = x;
        else if (extreme - x > TURN) { turns++; dir = -1; extreme = x; }
      } else if (x < extreme) extreme = x;
      else if (x - extreme > TURN) { turns++; dir = 1; extreme = x; }
    }
    // Store about two samples per pixel of the longest plot (~600 px), but never shave a turning
    // point or a dash edge: a pending sample that was an extreme is stored before it is superseded.
    const gap = Math.max(4, (opts.window * 1000) / 1200);
    if (pending && (x - pendX) * (pendX - pushX) < 0) store(pendT, pendX, pendD);
    if (t - pushT >= gap || d !== pushD) store(t, x, d);
    else { pendT = t; pendX = x; pendD = d; pending = true; }
  }
  lastT = t; lastX = x; lastD = dashing;
  sampleWall = now;
}

// ---------------------------------------------------------------- data
subscribe(Object.values(P), (frameValues, changed) => {
  values = frameValues;
  const now = performance.now();
  const state = values[P.state];
  const playing = isPlaying(state) && activeMode(state, values[P.playMode], values[P.selMode]) === 'fruits';
  if (playing && !wasPlaying) resetAttempt();
  wasPlaying = playing;

  const catcher = values[P.catcher];
  const live = values[P.time];
  if (playing && catcher && typeof catcher.x === 'number' && typeof live === 'number'
      && (changed.has(P.catcher) || changed.has(P.time))) {
    const rate = values[P.rate] > 0 ? values[P.rate] : values[P.modsRate] > 0 ? values[P.modsRate] : 1;
    const t = live / rate;                       // gameplay ms on the wall-clock scale
    if (lastT !== null && t < lastT - 500) resetAttempt();   // retry or seek back
    ingest(t, Math.min(PLAYFIELD, Math.max(0, catcher.x)), catcher.dashing === true, values[P.brk] === true, now);
    kick();
  }
  if (changed.has(P.checksum)) loadPalette();
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
  if (!values || status !== 'live') return;
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.selMode]);
  let next = 'hidden';                          // song select, menus, other rulesets: nothing
  if (mode === null) next = 'nodata';
  else if (mode === 'fruits' && isPlaying(state)) {
    if (values[P.catcher] || ringCount) { next = 'live'; missingSince = 0; }
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
  if (next !== 'hidden') placeDirty = true;   // fade out where it was
  kick();
}

// ---------------------------------------------------------------- map tone
function loadPalette() {
  const checksum = values?.[P.checksum] || '';
  if (opts.accent !== 'map' || !checksum) { setAccent(null); return; }
  if (checksum === paletteFor) { setAccent(palette); return; }
  paletteFor = checksum;
  mapPalette(checksum).then(result => {
    if (paletteFor !== checksum) return;
    palette = result;
    setAccent(opts.accent === 'map' ? result : null);
  });
}

function setAccent(result) {
  const next = result?.accent || C.amber;
  if (next === accent) return;
  accent = next;
  stage.style.setProperty('--ct-accent', accent);
  buildInks();
  kick();
}

// ---------------------------------------------------------------- settings
settings(DEFAULTS, s => {
  opts = {
    zone: s.zone === 'right' ? 'right' : s.zone === 'left' ? 'left' : 'auto',
    x: s.x, y: s.y, scale: Math.min(2, Math.max(0.5, s.scale)),
    window: Math.min(30, Math.max(2, s.window)),
    orientation: s.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    showStats: s.showStats, showOnResults: s.showOnResults, showBrand: s.showBrand,
    backing: ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none',
    accent: s.accent === '18-lab' ? '18-lab' : 'map',
  };
  viewDirty = true; placeDirty = true;
  if (values) { loadPalette(); evaluate(performance.now()); }
  measure();
});

fit(stage, W, H);

// ---------------------------------------------------------------- placement
/**
 * Gameplay: the side band beside the catch playfield, hugging its edge, with the "now" edge level
 * with the catcher. Results: a single stats row at the right end of the header strip, the one area
 * the ranking screen leaves free. Nudge and scale apply to both.
 */
function place() {
  placeDirty = false;
  const { busy } = osuLayout('fruits', { width: W, height: H });
  const side = opts.zone === 'right' ? 'right' : 'left';
  const s = cluster.style;
  stage.dataset.zone = side;
  s.transform = opts.scale === 1 ? '' : `scale(${opts.scale})`;
  if (view === 'final') {
    s.left = s.bottom = '';
    s.right = `${Math.round(RESULTS_RIGHT - opts.x)}px`;
    s.top = `${Math.round(RESULTS_TOP + opts.y)}px`;
    s.transformOrigin = '100% 0';
    return;
  }
  const left = side === 'left' ? busy.x - EDGE_GAP - OUTER_W : busy.x + busy.w + EDGE_GAP;
  const baseline = busy.y + busy.h - CATCHER_LIFT;
  s.right = s.top = '';
  s.left = `${Math.round(left + opts.x)}px`;
  s.bottom = `${Math.round(H - baseline - BELOW_BASELINE - opts.y)}px`;
  s.transformOrigin = side === 'left' ? '100% 100%' : '0 100%';
}

// ---------------------------------------------------------------- canvas geometry

function measure() {
  if (!cssW) return;
  const fitScale = Math.min(innerWidth / W, innerHeight / H) || 1;
  dpr = (devicePixelRatio || 1) * fitScale * opts.scale;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  plotLen = Math.max(1, (opts.orientation === 'vertical' ? cssH : cssW) - RULER);
  line = Math.max(1, Math.round(dpr)) / dpr;
  buildInks();
  kick();
}

/** Age gradients along the time axis (logical v), rebuilt on resize and accent change only. */
function buildInks() {
  traceInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  traceInk.addColorStop(0, rgba(C.dim, 0));
  traceInk.addColorStop(0.45, rgba(C.dim, 0.6));
  traceInk.addColorStop(1, rgba(C.dim, 0.95));
  dashInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  dashInk.addColorStop(0, rgba(accent, 0));
  dashInk.addColorStop(0.4, rgba(accent, 0.7));
  dashInk.addColorStop(1, rgba(accent, 1));
  haloInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  haloInk.addColorStop(0, 'rgb(0 0 0 / 0)');
  haloInk.addColorStop(0.45, 'rgb(0 0 0 / .3)');
  haloInk.addColorStop(1, 'rgb(0 0 0 / .5)');
}

new ResizeObserver(([entry]) => {
  cssW = entry.contentRect.width; cssH = entry.contentRect.height;
  measure();
}).observe(canvas);
addEventListener('resize', measure);

/** Centre of a crisp hairline at logical coordinate p. */
const snap = p => (Math.round(p * dpr - 0.5 * line * dpr) + 0.5 * line * dpr) / dpr;

// ---------------------------------------------------------------- render
function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  if (placeDirty) place();
  if (viewDirty) applyView();
  const animating = view === 'live' && now - sampleWall < SETTLE;
  if (view === 'live' && lastT !== null) {
    const target = lastT + Math.min(now - sampleWall, EXTRAPOLATE);
    if (target > headT) headT = target;
  }
  if ((view === 'live' || view === 'final') && cssW) draw();
  if (statsDirty || (animating && now - statsAt >= STATS_EVERY) || (!animating && view === 'live')) {
    writeStats(); statsAt = now; statsDirty = false;
  }
  if (animating) raf = requestAnimationFrame(frame);
}

function applyView() {
  viewDirty = false;
  stage.dataset.view = view;
  if (stage.dataset.orient !== opts.orientation) stage.dataset.orient = opts.orientation;
  if (stage.dataset.backing !== opts.backing) stage.dataset.backing = opts.backing;
  el.brand.hidden = !opts.showBrand;
  el.stats.hidden = !opts.showStats;
  setText(el.span, `−${opts.window} s`);
  setText(el.chip, { offline: 'vosu offline', nodata: 'No data' }[view] || 'Connecting');
  setText(el.status, view === 'final' ? 'Final' : 'Live');
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

const fmtScreens = v => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
function writeStats() {
  const has = (view === 'live' || view === 'final') && lastT !== null;
  setText(el.dash, has && activeMs >= 1000 ? ((dashMs / activeMs) * 100).toFixed(1) : '—');
  setText(el.travel, has ? fmtScreens(distance / PLAYFIELD) : '—');
  setText(el.turns, has && activeMs >= 3000 ? Math.round(turns / (activeMs / 60000)).toString() : '—');
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw in logical "vertical" coordinates: u across (playfield), v along (time, 0 = oldest).
  // Horizontal is the transpose, so one code path serves both orientations.
  if (opts.orientation === 'vertical') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(0, dpr, dpr, 0, 0, 0);

  const len = plotLen, end = CHART + SPAN;
  const windowMs = opts.window * 1000;
  const traced = ringCount > 0;
  const head = traced ? (headT > -Infinity ? headT : lastT) : 0;
  const pxPerMs = len / windowMs;
  const uOf = x => CHART + (x / PLAYFIELD) * SPAN;

  // Lane bed and playfield grid: edges and centre stronger, 64 px divisions faint.
  ctx.fillStyle = INK.lane;
  ctx.fillRect(0, 0, LANE, len);
  ctx.lineWidth = line;
  ctx.beginPath();
  for (let k = 1; k < 8; k++) if (k !== 4) { const u = snap(CHART + (k * SPAN) / 8); ctx.moveTo(u, 0); ctx.lineTo(u, len); }
  // Seconds scroll with gameplay time; every fifth is major.
  const first = Math.ceil((head - windowMs) / 1000);
  for (let s = first; s * 1000 <= head; s++) {
    if (!(s % 5)) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(CHART, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMinor; ctx.stroke();
  ctx.beginPath();
  { const u = snap(CHART + SPAN / 2); ctx.moveTo(u, 0); ctx.lineTo(u, len); }
  for (let s = first; s * 1000 <= head; s++) {
    if (s % 5) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(CHART, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMajor; ctx.stroke();
  ctx.beginPath();
  for (const u0 of [CHART, end]) { const u = snap(u0); ctx.moveTo(u, 0); ctx.lineTo(u, len); }
  ctx.strokeStyle = INK.edge; ctx.stroke();

  // Ruler ticks: 32 px minor, 64 px mid, 128 px labelled.
  ctx.beginPath();
  for (let p = 0; p <= PLAYFIELD; p += 32) {
    const u = snap(uOf(p));
    const h = p % 128 === 0 ? 8 : p % 64 === 0 ? 5 : 3;
    ctx.moveTo(u, len + 2); ctx.lineTo(u, len + 2 + h);
  }
  ctx.strokeStyle = INK.tick; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, snap(len)); ctx.lineTo(end, snap(len)); ctx.strokeStyle = INK.now; ctx.stroke();
  if (!traced) return;

  // Oldest visible sample (one before the window edge keeps the line continuous).
  const from = head - windowMs;
  let n = 0;
  let i = (ringHead - 1) & (CAP - 1);
  while (n < ringCount && ringT[i] >= from) { n++; i = (i - 1) & (CAP - 1); }
  if (n < ringCount) n++;
  const start = (ringHead - n) & (CAP - 1);

  // Dash lane runs and the trace in one walk; dash segments re-stroked in the accent afterwards.
  ctx.fillStyle = accent;
  ctx.beginPath();
  let runFrom = -1, pv = 0, pd = 0;
  for (let k = 0; k < n; k++) {
    const j = (start + k) & (CAP - 1);
    const u = uOf(ringX[j]);
    const v = Math.max(0, len - (head - ringT[j]) * pxPerMs);
    if (k === 0) ctx.moveTo(u, v); else ctx.lineTo(u, v);
    if (k > 0) {
      if (pd && runFrom < 0) runFrom = pv;
      if (!pd && runFrom >= 0) { ctx.fillRect(0, runFrom, LANE, pv - runFrom); runFrom = -1; }
    }
    pv = v; pd = ringD[j];
  }
  const nu = uOf(lastX);
  ctx.lineTo(nu, len);
  if (lastD && runFrom < 0) runFrom = pv;
  if (runFrom >= 0) ctx.fillRect(0, runFrom, LANE, len - runFrom);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = haloInk; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = traceInk; ctx.lineWidth = 1.75; ctx.stroke();

  ctx.beginPath();
  let on = false;
  for (let k = 0; k < n; k++) {
    const j = (start + k) & (CAP - 1);
    const u = uOf(ringX[j]);
    const v = Math.max(0, len - (head - ringT[j]) * pxPerMs);
    if (on) ctx.lineTo(u, v);
    const d = ringD[j];
    if (d && !on) { ctx.moveTo(u, v); on = true; } else if (!d) on = false;
  }
  if (on) ctx.lineTo(nu, len);
  ctx.strokeStyle = dashInk; ctx.lineWidth = 3.25; ctx.stroke();

  // Now: guide through the chart, pen head and ruler caret (dark-edged so they hold on any map).
  const gu = snap(nu);
  ctx.lineWidth = line;
  ctx.beginPath(); ctx.moveTo(gu, 0); ctx.lineTo(gu, len); ctx.strokeStyle = INK.guide; ctx.stroke();
  ctx.fillStyle = lastD ? accent : C.fg;
  ctx.strokeStyle = INK.halo; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(nu, len - 0.5, 3.5, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(nu, len + 1.5); ctx.lineTo(nu + 5.5, len + RULER); ctx.lineTo(nu - 5.5, len + RULER); ctx.closePath();
  ctx.stroke(); ctx.fill();
}

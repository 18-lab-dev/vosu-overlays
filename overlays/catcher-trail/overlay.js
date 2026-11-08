// Copyright (c) 2026 18-LAB. MIT.
// Catcher trail: an osu!catch movement seismograph from vosu's /play/catcher {x, dashing}.
import { subscribe, settings, fit, activeMode, isPlaying } from './vosu-overlay.js';

const W = 640, H = 640;          // declared resolution; panels sit top-left inside it
const PLAYFIELD = 512;           // catcher x range in osu! pixels; one "screen" of travel
const LANE = 4, GAP = 6;         // dash event lane, then the chart
const CHART = LANE + GAP;        // chart start on the across axis
const RULER = 12;                // tick band past the "now" edge
const SPAN = { vertical: 320, horizontal: 192 };
const RESULTS = 7;
const GRACE = 1500;              // ms of catch play without /play/catcher before naming vosu
const EXTRAPOLATE = 100;         // ms the head may run past the newest sample (hides frame jitter)
const SETTLE = 160;              // ms without samples before the loop parks (pause, results)
const TURN = 8;                  // px of reversal before a direction change counts
const STATS_EVERY = 250;         // readout refresh, ms
const CAP = 4096;                // ring capacity; sampling floor keeps a window under ~2 samples/px

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number',
  catcher: '/play/catcher', time: '/beatmap/time/live', rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate', brk: '/beatmap/isBreak',
};

const stage = document.getElementById('stage');
const canvas = document.getElementById('trace');
const ctx = canvas.getContext('2d', { alpha: true });
const el = {
  chip: document.getElementById('chip-text'), status: document.getElementById('status-text'),
  brand: document.getElementById('brand'), stats: document.getElementById('stats'), span: document.getElementById('span'),
  dash: document.getElementById('dash'), travel: document.getElementById('travel'), turns: document.getElementById('turns'),
};

// ---------------------------------------------------------------- colours (tokens, read once)
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgba = (hex, a) => `rgb(${rgb(hex).join(' ')} / ${a})`;
const C = {
  fg: token('--fg', '#ebe8e1'), dim: token('--fg-dim', '#b8b5ad'), muted: token('--muted', '#7e8288'),
  accent: token('--accent', '#ff963f'), rule: token('--rule', '#25282c'), strong: token('--rule-strong', '#3b3f45'),
};
const INK = {
  paper: 'rgb(11 12 13 / .5)', gridMinor: rgba(C.fg, 0.045), gridMajor: rgba(C.fg, 0.09),
  lane: rgba(C.fg, 0.06), guide: rgba(C.fg, 0.12), tick: C.muted, now: C.strong,
};

// ---------------------------------------------------------------- state
let opts = { window: 6, orientation: 'vertical', showStats: true, showBrand: true };
let status = 'connecting';
let viewDirty = true, statsDirty = true, statsAt = 0, raf = 0;
let view = 'connecting';
let wasPlaying = false;
let missingSince = 0;
let graceTimer = 0;

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
let values = null;
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
  evaluate(now);
}, {
  onStatus: s => {
    if (s === 'connecting' && status === 'offline') return;   // retries stay "offline" until live
    status = s;
    if (s !== 'live') setView(s);
  },
});

/** Decides what the panel shows; called per data frame and once more when the grace period ends. */
function evaluate(now) {
  if (!values || status !== 'live') return;
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.selMode]);
  let next;
  if (mode === null) next = 'nodata';
  else if (mode !== 'fruits') next = 'hidden';
  else if (isPlaying(state)) {
    if (values[P.catcher] || ringCount) { next = 'live'; missingSince = 0; }
    else {
      // vosu publishes the catcher from the first precise poll; tosu never does.
      if (!missingSince) { missingSince = now; clearTimeout(graceTimer); graceTimer = setTimeout(() => evaluate(performance.now()), GRACE + 10); }
      next = now - missingSince >= GRACE ? 'missing' : 'idle';
    }
  } else next = state === RESULTS && ringCount ? 'final' : 'idle';
  if (!isPlaying(state)) missingSince = 0;
  setView(next);
}

function setView(next) {
  if (next === view) return;
  if (next === 'idle' || next === 'nodata') resetAttempt();
  view = next; viewDirty = true; statsDirty = true;
  kick();
}

// ---------------------------------------------------------------- settings
settings({ window: 6, orientation: 'vertical', showStats: true, showBrand: true }, s => {
  opts = {
    window: Math.min(30, Math.max(2, s.window)),
    orientation: s.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    showStats: s.showStats, showBrand: s.showBrand,
  };
  viewDirty = true;
  kick();
});

fit(stage, W, H);

// ---------------------------------------------------------------- canvas geometry
let dpr = 1, cssW = 0, cssH = 0, plotLen = 0, span = SPAN.vertical, line = 1;
let traceInk = null, dashInk = null;

function measure() {
  const scale = Math.min(innerWidth / W, innerHeight / H) || 1;
  dpr = (devicePixelRatio || 1) * scale;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const vertical = opts.orientation === 'vertical';
  span = SPAN[opts.orientation];
  plotLen = Math.max(1, (vertical ? cssH : cssW) - RULER);
  line = Math.max(1, Math.round(dpr)) / dpr;
  traceInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  traceInk.addColorStop(0, rgba(C.dim, 0));
  traceInk.addColorStop(0.45, rgba(C.dim, 0.5));
  traceInk.addColorStop(1, rgba(C.fg, 0.95));
  dashInk = ctx.createLinearGradient(0, 0, 0, plotLen);
  dashInk.addColorStop(0, rgba(C.accent, 0));
  dashInk.addColorStop(0.4, rgba(C.accent, 0.6));
  dashInk.addColorStop(1, rgba(C.accent, 1));
  kick();
}
new ResizeObserver(([entry]) => {
  cssW = entry.contentRect.width; cssH = entry.contentRect.height;
  measure();
}).observe(canvas);
addEventListener('resize', () => { if (cssW) measure(); });

/** Centre of a crisp hairline at logical coordinate p. */
const snap = p => (Math.round(p * dpr - 0.5 * line * dpr) + 0.5 * line * dpr) / dpr;

// ---------------------------------------------------------------- render
function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  if (viewDirty) applyView();
  const animating = view === 'live' && now - sampleWall < SETTLE;
  if (view === 'live' && lastT !== null) {
    const target = lastT + Math.min(now - sampleWall, EXTRAPOLATE);
    if (target > headT) headT = target;
  }
  if (view !== 'hidden' && view !== 'connecting' && view !== 'offline' && view !== 'missing' && cssW) draw();
  if (statsDirty || (animating && now - statsAt >= STATS_EVERY) || (!animating && view === 'live')) {
    writeStats(); statsAt = now; statsDirty = false;
  }
  if (animating) raf = requestAnimationFrame(frame);
}

function applyView() {
  viewDirty = false;
  stage.dataset.view = view;
  if (stage.dataset.orient !== opts.orientation) stage.dataset.orient = opts.orientation;
  el.brand.hidden = !opts.showBrand;
  el.stats.hidden = !opts.showStats;
  setText(el.span, `−${opts.window} s`);
  setText(el.chip, status === 'offline' ? 'vosu offline' : 'Connecting');
  setText(el.status, { live: 'Live', final: 'Final', idle: 'Idle', nodata: 'No data' }[view] || '');
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

const fmtPct = v => v.toFixed(1);
const fmtScreens = v => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
function writeStats() {
  const has = (view === 'live' || view === 'final') && lastT !== null;
  setText(el.dash, has && activeMs >= 1000 ? fmtPct((dashMs / activeMs) * 100) : '—');
  setText(el.travel, has ? fmtScreens(distance / PLAYFIELD) : '—');
  setText(el.turns, has && activeMs >= 3000 ? Math.round(turns / (activeMs / 60000)).toString() : '—');
}

function draw() {
  const vertical = opts.orientation === 'vertical';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw in logical "vertical" coordinates: u across (playfield), v along (time, 0 = oldest).
  // Horizontal is the transpose, so one code path serves both orientations.
  if (vertical) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(0, dpr, dpr, 0, 0, 0);

  const len = plotLen, end = CHART + span;
  const windowMs = opts.window * 1000;
  const traced = (view === 'live' || view === 'final') && ringCount > 0;
  const head = traced ? (headT > -Infinity ? headT : lastT) : 0;
  const pxPerMs = len / windowMs;
  const uOf = x => CHART + (x / PLAYFIELD) * span;

  // Paper, lane bed, playfield grid.
  ctx.fillStyle = INK.paper;
  ctx.fillRect(CHART, 0, span, len);
  ctx.fillStyle = INK.lane;
  ctx.fillRect(0, 0, LANE, len);
  ctx.lineWidth = line;
  ctx.beginPath();
  for (let k = 1; k < 8; k++) if (k !== 4) { const u = snap(CHART + (k * span) / 8); ctx.moveTo(u, 0); ctx.lineTo(u, len); }
  ctx.strokeStyle = INK.gridMinor; ctx.stroke();
  ctx.beginPath();
  for (const k of [0, 4, 8]) { const u = snap(CHART + (k * span) / 8); ctx.moveTo(u, 0); ctx.lineTo(u, len); }
  // Seconds scroll with gameplay time; every fifth is major.
  const first = Math.ceil((head - windowMs) / 1000);
  for (let s = first; s * 1000 <= head; s++) {
    if (s % 5) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(CHART, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMajor; ctx.stroke();
  ctx.beginPath();
  for (let s = first; s * 1000 <= head; s++) {
    if (!(s % 5)) continue;
    const v = snap(len - (head - s * 1000) * pxPerMs); ctx.moveTo(CHART, v); ctx.lineTo(end, v);
  }
  ctx.strokeStyle = INK.gridMinor; ctx.stroke();

  // Ruler ticks: 32 px minor, 64 px mid, 128 px labelled.
  ctx.beginPath();
  for (let p = 0; p <= PLAYFIELD; p += 32) {
    const u = snap(uOf(p));
    const h = p % 128 === 0 ? 8 : p % 64 === 0 ? 5 : 3;
    ctx.moveTo(u, len + 2); ctx.lineTo(u, len + 2 + h);
  }
  ctx.strokeStyle = INK.tick; ctx.stroke();

  if (traced) {
    // Oldest visible sample (one before the window edge keeps the line continuous).
    const from = head - windowMs;
    let n = 0;
    let i = (ringHead - 1) & (CAP - 1);
    while (n < ringCount && ringT[i] >= from) { n++; i = (i - 1) & (CAP - 1); }
    if (n < ringCount) n++;
    const start = (ringHead - n) & (CAP - 1);

    // Dash lane runs and the trace in one walk; dash segments re-stroked in accent afterwards.
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    let runFrom = -1, pu = 0, pv = 0, pd = 0;
    for (let k = 0; k < n; k++) {
      const j = (start + k) & (CAP - 1);
      const u = uOf(ringX[j]);
      const v = Math.max(0, len - (head - ringT[j]) * pxPerMs);
      if (k === 0) ctx.moveTo(u, v); else ctx.lineTo(u, v);
      if (k > 0) {
        if (pd && runFrom < 0) runFrom = pv;
        if (!pd && runFrom >= 0) { ctx.fillRect(0, runFrom, LANE, pv - runFrom); runFrom = -1; }
      }
      pu = u; pv = v; pd = ringD[j];
    }
    const nu = uOf(lastX);
    ctx.lineTo(nu, len);
    if (lastD && runFrom < 0) runFrom = pv;
    if (runFrom >= 0) ctx.fillRect(0, runFrom, LANE, len - runFrom);
    ctx.strokeStyle = traceInk; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();

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
    ctx.strokeStyle = dashInk; ctx.lineWidth = 2.5; ctx.stroke();

    // Now: guide through the chart, baseline, pen head and ruler caret.
    const gu = snap(nu);
    ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(gu, 0); ctx.lineTo(gu, len); ctx.strokeStyle = INK.guide; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, snap(len)); ctx.lineTo(end, snap(len)); ctx.strokeStyle = INK.now; ctx.stroke();
    const ink = lastD ? C.accent : C.fg;
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.arc(nu, len - 0.5, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(nu, len + 1.5); ctx.lineTo(nu + 5, len + RULER); ctx.lineTo(nu - 5, len + RULER); ctx.closePath(); ctx.fill();
  } else {
    ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(0, snap(len)); ctx.lineTo(end, snap(len)); ctx.strokeStyle = INK.now; ctx.stroke();
  }
}

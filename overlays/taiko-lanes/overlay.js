// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko strain lanes: colour, rhythm, stamina (and reading when the map has it) from
// /performance/graph, the play position, the skill leading the current section and live stars.
import { subscribe, settings, fit, activeMode, isPlaying, formatDuration } from './vosu-overlay.js';

const W = 480;
const H = 360;
const ROW_GAP = 4;
const SONG_SELECT = 5;
const RESULTS = 7;
/** Half-width of the "current section" the lead is judged over, in graph (real-time) ms. */
const SECTION_MS = 1600;
/** A new leader must beat the current one by this factor, so the callout does not flicker. */
const HYSTERESIS = 1.06;

/**
 * Skill weights are rosu-pp 4's per-section multipliers in combine_peaks (taiko/difficulty/mod.rs),
 * so lane heights and shares compare what each skill contributes to the star rating, not raw
 * strain units (raw stamina is ~30× raw rhythm on a typical map).
 */
const SKILLS = [
  { key: 'color', names: ['color', 'colour'], label: 'Color', setting: 'laneColor', weight: 0.375 },
  { key: 'rhythm', names: ['rhythm'], label: 'Rhythm', setting: 'laneRhythm', weight: 0.75 },
  { key: 'stamina', names: ['stamina'], label: 'Stamina', setting: 'laneStamina', weight: 0.445 },
  { key: 'reading', names: ['reading'], label: 'Reading', setting: 'laneReading', weight: 0.1, optional: true },
];

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  menuMode: '/settings/mode/number',
  live: '/beatmap/time/live',
  rate: '/play/mods/rate',
  starsLive: '/beatmap/stats/stars/live',
  starsTotal: '/beatmap/stats/stars/total',
  series: '/performance/graph/series',
  xaxis: '/performance/graph/xaxis',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const lanesEl = $('lanes');
const chart = $('chart');
const ctx = chart.getContext('2d', { alpha: true });
const el = {
  status: $('status-text'), brand: $('brand'), phase: $('phase'),
  leadLabel: $('lead-label'), leadName: $('lead-name'), leadShare: $('lead-share'),
  starsLabel: $('stars-label'), starsLive: $('stars-live'), starsTotal: $('stars-total'), starsMeter: $('stars-meter'),
  clock: $('clock'), note: $('note'), length: $('length'),
};

// ---------------------------------------------------------------- state
let config = null;
let connection = 'boot';
let values = null;
let graph = null;           // built strain model, see buildGraph
let shown = [];             // lanes on screen: { lane, nameEl, shareEl }
let leadLane = null;        // lane object currently called out
let summaryDone = false;   // whole-map lead already computed for the current graph/layout
let lastSecond = -1;
let meterTransform = '';

// Canvas geometry (device px). cssW/cssH come from the ResizeObserver, never from layout reads.
let cssW = 0;
let cssH = 0;
let ratio = 1;
let pxW = 0;
let pxH = 0;
let laneHpx = 0;
let rowTops = new Int32Array(0);
let layers = null;          // { base, lit, accent } offscreen canvases
let curves = [];            // per shown lane: Float32Array of curve height (device px) per column

// Dirty flags; data handlers only set these and request a frame.
let graphDirty = true;
let layoutDirty = true;
let layersDirty = true;
let drawDirty = true;
let textDirty = true;
let lastPlayX = -2;
let raf = 0;

const text = new WeakMap();
/** Writes textContent only when the string changed; returns whether it did. */
function setText(node, value) {
  if (text.get(node) === value) return false;
  text.set(node, value);
  node.textContent = value;
  return true;
}
const attrs = new Map();
function setAttr(node, name, value) {
  const key = node.id ? `${node.id}:${name}` : null;
  if (key && attrs.get(key) === value) return;
  if (key) attrs.set(key, value);
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- data model
function lowerBound(xs, t) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * vosu pads the strain series with negative sentinels (-100 audio lead-in, -50 object padding)
 * and its x-axis is real-time ms (map time ÷ mod rate). Negatives count as no strain.
 */
function buildGraph(series, xaxis) {
  if (!Array.isArray(series) || !Array.isArray(xaxis) || xaxis.length < 2) return null;
  const n = xaxis.length;
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = Number(xaxis[i]) || 0;
  const lanes = [];
  let globalPeak = 0;
  let first = n;
  let last = -1;
  for (const skill of SKILLS) {
    const entry = series.find(s => s && skill.names.includes(s.name));
    const data = entry?.data;
    if (!Array.isArray(data) || !data.length) continue;
    const weighted = new Float32Array(n);
    const prefix = new Float64Array(n + 1);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const raw = Number(data[i]);
      const v = raw > 0 && Number.isFinite(raw) ? raw * skill.weight : 0;
      weighted[i] = v;
      prefix[i + 1] = prefix[i] + v;
      if (v > 0) { if (v > peak) peak = v; if (i < first) first = i; if (i > last) last = i; }
    }
    lanes.push({ skill, weighted, prefix, peak, scale: 1 });
    if (peak > globalPeak) globalPeak = peak;
  }
  if (!lanes.length || globalPeak <= 0) return null;
  for (const lane of lanes) {
    // Own scale for legible shapes, floored at a quarter of the strongest skill so a
    // negligible skill stays flat instead of amplifying noise to full height.
    lane.scale = Math.max(lane.peak, globalPeak * 0.25);
    lane.present = !lane.skill.optional || lane.peak >= globalPeak * 0.02;
  }
  const start = xs[Math.max(0, first - 1)];
  const end = xs[Math.min(n - 1, last + 1)];
  return { n, xs, lanes, start, end: end > start ? end : start + 1, first, last };
}

// ---------------------------------------------------------------- layout (DOM, not hot)
function applyLayout() {
  layoutDirty = false;
  const wanted = graph ? graph.lanes.filter(l => l.present && config[l.skill.setting]) : [];
  // With no strain data, keep the empty tracks of the enabled base skills so the panel keeps its shape.
  const rows = graph ? wanted.map(lane => ({ lane, skill: lane.skill }))
    : SKILLS.filter(s => !s.optional && config[s.setting]).map(skill => ({ lane: null, skill }));
  for (const row of shown) { row.nameEl.remove(); row.shareEl.remove(); }
  shown = rows.map((row, i) => {
    const nameEl = document.createElement('span');
    nameEl.className = 'lane-name';
    nameEl.style.gridRow = String(i + 1);
    nameEl.textContent = row.skill.label;
    const shareEl = document.createElement('span');
    shareEl.className = 'lane-share';
    shareEl.style.gridRow = String(i + 1);
    const shareText = document.createElement('b');
    shareText.textContent = '—';
    const shareBar = document.createElement('i');
    shareEl.append(shareText, shareBar);
    lanesEl.append(nameEl, shareEl);
    return { ...row, nameEl, shareEl, shareText, shareBar, share: '', fraction: 0, lead: false };
  });
  const laneH = config.laneHeight;
  lanesEl.style.setProperty('--lane-h', `${laneH}px`);
  lanesEl.dataset.count = String(shown.length);
  chart.style.gridRowEnd = String(Math.max(2, shown.length + 1));
  chart.style.height = `${shown.length * laneH + Math.max(0, shown.length - 1) * ROW_GAP}px`;
  leadLane = null;
  summaryDone = false;
  layersDirty = drawDirty = textDirty = true;
}

function updateRatio() {
  const scale = Math.min(innerWidth / W, innerHeight / H) || 1;
  const next = (window.devicePixelRatio || 1) * Math.max(1, scale);
  if (next !== ratio) { ratio = next; resizeCanvas(); }
}

function resizeCanvas() {
  const w = Math.round(cssW * ratio);
  const h = Math.round(cssH * ratio);
  if (w === pxW && h === pxH) return;
  pxW = chart.width = w;
  pxH = chart.height = h;
  layersDirty = drawDirty = true;
  schedule();
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentBoxSize?.[0];
  const rect = entries[entries.length - 1].contentRect;
  cssW = box ? box.inlineSize : rect.width;
  cssH = box ? box.blockSize : rect.height;
  resizeCanvas();
}).observe(chart);
addEventListener('resize', updateRatio);

// ---------------------------------------------------------------- offscreen lane layers
function makeLayer() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(pxW, pxH);
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  return canvas;
}

function palette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: read('--fg', '#ebe8e1'), dim: read('--fg-dim', '#b8b5ad'), muted: read('--muted', '#7e8288'),
    accent: read('--accent', '#ff963f'), rule: read('--rule', '#25282c'),
  };
}

function hexA(hex, alpha) {
  const v = parseInt(hex.slice(1), 16);
  return `rgb(${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255} / ${alpha})`;
}

function buildLayers() {
  layersDirty = false;
  drawDirty = true;
  if (!pxW || !pxH) { layers = null; return; }
  const count = Math.max(1, shown.length);
  const gap = Math.round(ROW_GAP * ratio);
  laneHpx = Math.max(1, Math.round((pxH - gap * (count - 1)) / count));
  rowTops = new Int32Array(count);
  for (let i = 0; i < count; i++) rowTops[i] = Math.round(i * (pxH + gap) / count);
  const colours = palette();
  const base = makeLayer();
  const lit = makeLayer();
  const accent = makeLayer();
  const b = base.getContext('2d');
  const line = Math.max(1, Math.round(ratio));
  const half = line % 2 ? 0.5 : 0;

  curves = shown.map(() => new Float32Array(pxW));
  for (let row = 0; row < shown.length; row++) {
    const top = rowTops[row];
    const bottom = top + laneHpx;
    // Track: sunken lane like a taiko playfield strip, with a baseline hairline.
    b.fillStyle = 'rgb(11 12 13 / .62)';
    b.fillRect(0, top, pxW, laneHpx);
    b.fillStyle = colours.rule;
    b.fillRect(0, bottom - line, pxW, line);
    if (!graph || !shown[row].lane) continue;
    // Minute gridlines (half-minute minor) over the track.
    const span = graph.end - graph.start;
    for (let t = Math.ceil(graph.start / 30000) * 30000; t < graph.end; t += 30000) {
      const x = Math.round(((t - graph.start) / span) * pxW);
      b.fillStyle = t % 60000 === 0 ? 'rgb(235 232 225 / .07)' : 'rgb(235 232 225 / .035)';
      b.fillRect(x, top, line, laneHpx - line);
    }
    const curve = curves[row];
    columnHeights(shown[row].lane, curve, laneHpx - Math.round(4 * ratio));
    trace(b, curve, top, bottom - line, hexA(colours.fg, 0.045), hexA(colours.muted, 0.55), line, half);
    trace(lit.getContext('2d'), curve, top, bottom - line, hexA(colours.fg, 0.15), colours.dim, line, half);
    trace(accent.getContext('2d'), curve, top, bottom - line, hexA(colours.accent, 0.24), colours.accent, line, half);
  }
  colours.playhead = hexA(colours.fg, 0.9);
  layers = { base, lit, accent, colours };
}

/** Peak-preserving resample of a lane onto device-pixel columns (max per column, interpolated between sparse samples). */
function columnHeights(lane, out, usable) {
  const { xs, n, start, end } = graph;
  const span = end - start;
  const { weighted, scale } = lane;
  for (let c = 0; c < pxW; c++) {
    const t0 = start + (c / pxW) * span;
    const t1 = start + ((c + 1) / pxW) * span;
    let i = lowerBound(xs, t0);
    let peak = -1;
    for (; i < n && xs[i] < t1; i++) if (weighted[i] > peak) peak = weighted[i];
    if (peak < 0) {
      const tm = (t0 + t1) / 2;
      const j = lowerBound(xs, tm);
      if (j <= 0) peak = weighted[0];
      else if (j >= n) peak = weighted[n - 1];
      else {
        const f = (tm - xs[j - 1]) / ((xs[j] - xs[j - 1]) || 1);
        peak = weighted[j - 1] + (weighted[j] - weighted[j - 1]) * f;
      }
    }
    out[c] = Math.min(1, peak / scale) * usable;
  }
}

function trace(g, curve, top, base, fill, stroke, line, half) {
  g.beginPath();
  g.moveTo(0, base);
  for (let c = 0; c < curve.length; c++) g.lineTo(c + 0.5, base - curve[c]);
  g.lineTo(curve.length, base);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.beginPath();
  for (let c = 0; c < curve.length; c++) {
    const y = Math.max(top + line, base - curve[c]) + half;
    if (c) g.lineTo(c + 0.5, y); else g.moveTo(0, y);
  }
  g.lineWidth = line;
  g.lineJoin = 'round';
  g.strokeStyle = stroke;
  g.stroke();
}

// ---------------------------------------------------------------- view model
function viewOf() {
  if (connection !== 'live') return connection === 'offline' ? 'offline' : 'boot';
  const mode = activeMode(values[P.state], values[P.playMode], values[P.menuMode]);
  return mode === 'taiko' || mode === null ? 'panel' : 'hidden';
}

/** Graph-time position of the play head, or null outside an attempt. */
function playTime() {
  if (!graph || !isPlaying(values[P.state])) return null;
  const live = values[P.live];
  if (typeof live !== 'number') return null;
  const rate = Number(values[P.rate]);
  return live / (rate > 0 ? rate : 1);
}

function playX(t) {
  if (t === null || !pxW) return -1;
  const f = (t - graph.start) / (graph.end - graph.start);
  return Math.round(Math.min(1, Math.max(0, f)) * pxW);
}

/** Weighted strain sum of each shown lane over [i0, i1) and the leader, with hysteresis. */
function judge(i0, i1, sticky) {
  let total = 0;
  let best = null;
  let bestSum = 0;
  let leadSum = 0;
  for (const row of shown) {
    const sum = row.lane.prefix[i1] - row.lane.prefix[i0];
    row.sum = sum;
    total += sum;
    if (sum > bestSum) { best = row.lane; bestSum = sum; }
    if (row.lane === leadLane) leadSum = sum;
  }
  if (sticky && leadLane && leadSum > 0 && bestSum < leadSum * HYSTERESIS) best = leadLane;
  return { total, best };
}

function updateLead(t) {
  if (!graph || !shown.length || !shown[0].lane) { leadLane = null; return; }
  let i0 = 0;
  let i1 = graph.n;
  const live = t !== null;
  if (live) {
    summaryDone = false;
    i0 = lowerBound(graph.xs, t - SECTION_MS);
    i1 = lowerBound(graph.xs, t + SECTION_MS);
  } else {
    if (summaryDone) return;
    summaryDone = true;
  }
  const { total, best } = judge(i0, i1, live);
  if (best !== leadLane) { leadLane = best; drawDirty = true; }
  for (const row of shown) {
    row.fraction = total > 0 ? row.sum / total : 0;
    row.share = total > 0 ? `${Math.round(row.fraction * 100)}%` : '—';
    row.lead = row.lane === leadLane;
  }
  textDirty = true;
}

function stars(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

function renderText(view, t) {
  textDirty = false;
  const state = values ? values[P.state] : undefined;
  const playing = isPlaying(state) && view === 'panel';
  const results = state === RESULTS;
  const mode = values ? activeMode(state, values[P.playMode], values[P.menuMode]) : null;

  const phase = playing ? 'Live' : results ? 'Results' : state === SONG_SELECT ? 'Song select' : 'Map';
  setText(el.phase, mode === null ? '' : phase);
  setAttr(el.phase, 'data-live', playing ? '' : null);
  setText(el.leadLabel, playing ? 'Section lead' : 'Map lead');
  const lead = leadLane && shown.find(r => r.lane === leadLane);
  setText(el.leadName, lead ? lead.lane.skill.label : '—');
  setText(el.leadShare, lead ? lead.share : '');
  setAttr(panel, 'data-lead', lead ? 'some' : 'none');
  for (const row of shown) {
    const share = row.lane && row.share ? row.share : '—';
    if (setText(row.shareText, share)) row.shareBar.style.transform = `scaleX(${share === '—' ? 0 : row.fraction.toFixed(3)})`;
    const leading = row.lead && row.lane === leadLane;
    if (leading !== row.nameEl.hasAttribute('data-lead')) {
      row.nameEl.toggleAttribute('data-lead', leading);
      row.shareEl.toggleAttribute('data-lead', leading);
    }
  }

  const live = stars(values?.[P.starsLive]);
  const total = stars(values?.[P.starsTotal]);
  const big = playing || results ? live : total;
  setText(el.starsLabel, playing || results ? 'Stars live' : 'Stars');
  setText(el.starsLive, big ?? '—');
  setText(el.starsTotal, (playing || results) && total ? `/ ${total}` : '');
  setAttr(el.starsLive, 'data-empty', big ? null : '');
  const fraction = !big || !total ? 0 : playing || results ? Math.min(1, Number(live) / Number(total)) : 1;
  const transform = `scaleX(${fraction.toFixed(3)})`;
  if (transform !== meterTransform) { meterTransform = transform; el.starsMeter.style.transform = transform; }

  setText(el.clock, playing && t !== null ? formatDuration(Math.max(0, t)) : '');
  setText(el.length, graph ? formatDuration(graph.end) : '');
  setText(el.note, mode === null ? 'Waiting for osu!' : graph ? '' : 'No strain data for this map');
}

// ---------------------------------------------------------------- frame
let view = 'boot';
function frame() {
  raf = 0;
  if (!config) return;
  const nextView = viewOf();
  if (nextView !== view) { view = nextView; stage.dataset.view = view; textDirty = true; }
  if (graphDirty) {
    graphDirty = false;
    graph = values ? buildGraph(values[P.series], values[P.xaxis]) : null;
    layoutDirty = true;
  }
  if (layoutDirty) applyLayout();
  if (layersDirty) buildLayers();

  const t = playTime();
  const x = playX(t);
  if (x !== lastPlayX) { lastPlayX = x; drawDirty = true; }
  if (t !== null || drawDirty) updateLead(t);
  if (textDirty) renderText(view, t);
  if (drawDirty) draw(x, t);
}

function draw(x, t) {
  drawDirty = false;
  ctx.clearRect(0, 0, pxW, pxH);
  if (!layers) return;
  ctx.drawImage(layers.base, 0, 0);
  if (!graph || !shown.length || !shown[0].lane) return;
  const end = x < 0 ? pxW : x;
  for (let row = 0; row < shown.length; row++) {
    if (end <= 0) break;
    const src = shown[row].lane === leadLane ? layers.accent : layers.lit;
    ctx.drawImage(src, 0, rowTops[row], end, laneHpx, 0, rowTops[row], end, laneHpx);
  }
  if (x < 0) return;
  const { colours } = layers;
  const span = graph.end - graph.start;
  const x0 = Math.max(0, Math.round(((t - SECTION_MS - graph.start) / span) * pxW));
  const x1 = Math.min(pxW, Math.round(((t + SECTION_MS - graph.start) / span) * pxW));
  const line = Math.max(1, Math.round(ratio));
  ctx.fillStyle = 'rgb(235 232 225 / .07)';
  for (let row = 0; row < shown.length; row++) if (x1 > x0) ctx.fillRect(x0, rowTops[row], x1 - x0, laneHpx);
  ctx.fillStyle = colours.playhead;
  ctx.fillRect(Math.min(pxW - line, x), 0, line, pxH);
  // Read-out dot where the play head crosses each curve.
  const column = Math.min(pxW - 1, x);
  const radius = 2.5 * ratio;
  for (let row = 0; row < shown.length; row++) {
    const y = rowTops[row] + laneHpx - line - curves[row][column];
    ctx.beginPath();
    ctx.arc(column + 0.5, Math.max(rowTops[row] + radius, y), radius, 0, Math.PI * 2);
    ctx.fillStyle = shown[row].lane === leadLane ? colours.accent : colours.fg;
    ctx.fill();
  }
}

// ---------------------------------------------------------------- wiring
config = settings({ laneColor: true, laneRhythm: true, laneStamina: true, laneReading: true, laneHeight: 34, brand: true }, next => {
  next.laneHeight = Math.round(Math.min(56, Math.max(20, next.laneHeight)));
  config = next;
  el.brand.hidden = !next.brand;
  layoutDirty = true;
  schedule();
});

fit(stage, W, H);
updateRatio();

subscribe(Object.values(P), (frameValues, changed) => {
  values = frameValues;
  if (changed.has(P.series) || changed.has(P.xaxis)) graphDirty = true;
  if (changed.has(P.state) || changed.has(P.playMode) || changed.has(P.menuMode)
    || changed.has(P.starsLive) || changed.has(P.starsTotal)) textDirty = true;
  if (graphDirty || textDirty) { schedule(); return; }
  // Time ticks constantly; only wake the renderer when the play head moves a device pixel
  // or the clock readout turns over a second.
  if ((changed.has(P.live) || changed.has(P.rate)) && graph && isPlaying(values[P.state])) {
    const t = playTime();
    const second = Math.floor(t / 1000);
    if (playX(t) !== lastPlayX || second !== lastSecond) { lastSecond = second; textDirty = true; schedule(); }
  }
}, {
  onStatus: state => {
    connection = state;
    setText(el.status, state === 'offline' ? 'vosu offline' : 'Connecting to vosu');
    // 'live' repeats on every frame; only the first one changes what is shown.
    if (state !== 'live' || (view !== 'panel' && view !== 'hidden')) schedule();
  },
});

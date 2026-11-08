// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko strain lanes: colour, rhythm, stamina (and reading when the map has it) from
// /performance/graph, the play position, the skill leading the current section and live stars.
// Floats in the empty band below the taiko lane during play; song select gets the map's skill
// lanes (osu! shows no skill breakdown there); results and every other screen get nothing.
import { subscribe, settings, fit, activeMode, isPlaying, formatDuration, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const ROW_GAP = 6;
const SONG_SELECT = 5;
/** Half-width of the "current section" the lead is judged over, in graph (real-time) ms. */
const SECTION_MS = 1600;
/** A new leader must beat the current one by this factor, so the callout does not flicker. */
const HYSTERESIS = 1.06;
/** Cluster widths: gameplay strip under the lane, and the narrow song-select column. */
const PLAY_WIDTH = 880;
const SELECT_WIDTH = 460;
/**
 * osu!stable song select at 1080p leaves a centre column of background (x≈540–1160,
 * y≈190–930) between the local leaderboard and the beatmap carousel. The selected carousel
 * entry juts left to x≈1050, so the lanes stay left of it, in the lower half of the column.
 */
const SELECT_SPOT = { x: 564, y: 600 };

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
  checksum: '/beatmap/checksum',
  series: '/performance/graph/series',
  xaxis: '/performance/graph/xaxis',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const cluster = $('cluster');
const lanesEl = $('lanes');
const chart = $('chart');
const ctx = chart.getContext('2d', { alpha: true });
const el = {
  status: $('status-text'), brand: $('brand'),
  leadLabel: $('lead-label'), leadName: $('lead-name'), leadShare: $('lead-share'),
  starsLive: $('stars-live'), starsTotal: $('stars-total'),
  clock: $('clock'), note: $('note'), length: $('length'),
};

// ---------------------------------------------------------------- state
let config = null;
let connection = 'boot';
let values = null;
let view = 'boot';
let graph = null;           // built strain model, see buildGraph
let shown = [];             // lanes on screen: { lane, skill, nameEl, shareEl, shareText, shareBar, … }
let leadLane = null;        // lane object currently called out
let summaryDone = false;    // whole-map lead already computed for the current graph/layout
let lastSecond = -1;
let checksum = null;

// Canvas geometry (device px). cssW/cssH come from the ResizeObserver, never from layout reads.
let cssW = 0;
let cssH = 0;
let ratio = 1;
let pxW = 0;
let pxH = 0;
let laneHpx = 0;
let rowTops = new Int32Array(0);
let layers = null;          // { base, lit, accent, colours } offscreen canvases
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
function setAttr(node, name, value) {
  if (node.getAttribute(name) === value) return;
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
    lanes.push({ skill, weighted, prefix, peak, scale: 1, present: true });
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
  return { n, xs, lanes, start, end: end > start ? end : start + 1 };
}

// ---------------------------------------------------------------- view model
function currentMode() {
  return values ? activeMode(values[P.state], values[P.playMode], values[P.menuMode]) : null;
}

/** boot/status → tiny status line; play/select → the cluster; hidden → nothing at all. */
function viewOf() {
  if (connection !== 'live') return 'status';
  const state = values?.[P.state];
  if (state === undefined) return 'status'; // vosu is up, osu! is not
  if (currentMode() !== 'taiko') return 'hidden';
  if (isPlaying(state)) return 'play';
  if (state === SONG_SELECT && config.songSelect !== 'off' && graph) return 'select';
  return 'hidden';
}

// ---------------------------------------------------------------- placement (DOM, not hot)
function place() {
  const select = view === 'select';
  const scale = Math.min(2, Math.max(0.5, config.scale));
  const style = cluster.style;
  let x;
  let y;
  let tx = '0';
  let ty = '0';
  let origin = '0 0';
  if (select) {
    x = SELECT_SPOT.x;
    y = SELECT_SPOT.y;
  } else {
    const layout = osuLayout('taiko');
    const lane = layout.busy;
    if (config.zone === 'above lane') {
      // Centred between the HP bar and the score, sitting just above the lane.
      const health = layout.hud.health;
      const score = layout.hud.score;
      x = (health.x + health.w + score.x) / 2;
      y = lane.y - 24;
      tx = '-50%';
      ty = '-100%';
      origin = '50% 100%';
    } else {
      // Under the lane, the graph starting where the drum area ends (stable: 300 px at 1080p),
      // so the label column (88 px + 12 px gap) sits under the drum.
      x = Math.round(300 * layout.unit / 2.25) - 88 - 12;
      y = lane.y + lane.h + 24;
    }
  }
  style.setProperty('--x', `${Math.round(x + config.offsetX)}px`);
  style.setProperty('--y', `${Math.round(y + config.offsetY)}px`);
  style.setProperty('--tx', tx);
  style.setProperty('--ty', ty);
  style.setProperty('--origin', origin);
  style.setProperty('--s', String(scale));
  style.setProperty('--w', `${select ? SELECT_WIDTH : PLAY_WIDTH}px`);
  style.setProperty('--label-w', select ? '72px' : '88px');
  style.setProperty('--share-w', select ? '44px' : '52px');
  cluster.dataset.backing = config.backing;
  stage.dataset.accent = config.accent === '18-lab' ? 'brand' : 'map';
  updateRatio();
}

// ---------------------------------------------------------------- layout (DOM, not hot)
function applyLayout() {
  layoutDirty = false;
  place();
  const rows = graph ? graph.lanes.filter(l => l.present && config[l.skill.setting]) : [];
  for (const row of shown) { row.nameEl.remove(); row.shareEl.remove(); }
  shown = rows.map((lane, i) => {
    const nameEl = document.createElement('span');
    nameEl.className = 'lane-name';
    nameEl.style.gridRow = String(i + 1);
    nameEl.textContent = lane.skill.label;
    const shareEl = document.createElement('span');
    shareEl.className = 'lane-share';
    shareEl.style.gridRow = String(i + 1);
    const shareText = document.createElement('b');
    shareText.textContent = '—';
    const shareBar = document.createElement('i');
    shareEl.append(shareText, shareBar);
    lanesEl.append(nameEl, shareEl);
    return { lane, nameEl, shareEl, shareText, shareBar, share: '', fraction: 0, sum: 0, lead: false };
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
  const fitScale = Math.min(innerWidth / W, innerHeight / H) || 1;
  const next = (window.devicePixelRatio || 1) * Math.max(1, fitScale) * Math.max(1, config ? config.scale : 1);
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
  const entry = entries[entries.length - 1];
  const box = entry.contentBoxSize?.[0];
  cssW = box ? box.inlineSize : entry.contentRect.width;
  cssH = box ? box.blockSize : entry.contentRect.height;
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

function toRgb(colour) {
  const hex = colour.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return [255, 150, 63];
}
const rgba = ([r, g, b], alpha) => `rgb(${r} ${g} ${b} / ${alpha})`;

/** Colours resolved once per layer build (the map tint arrives asynchronously). */
function palette() {
  const css = getComputedStyle(stage);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: toRgb(read('--fg', '#ebe8e1')),
    lead: toRgb(read('--lead', '#ff963f')),
  };
}

function buildLayers() {
  layersDirty = false;
  drawDirty = true;
  if (!pxW || !pxH || !shown.length) { layers = null; return; }
  const count = shown.length;
  const gap = Math.round(ROW_GAP * ratio);
  laneHpx = Math.max(1, Math.round((pxH - gap * (count - 1)) / count));
  rowTops = new Int32Array(count);
  for (let i = 0; i < count; i++) rowTops[i] = Math.round(i * (pxH + gap) / count);
  const { fg, lead } = palette();
  const base = makeLayer();
  const lit = makeLayer();
  const accent = makeLayer();
  const b = base.getContext('2d');
  const line = Math.max(1, Math.round(ratio));
  const half = line % 2 ? 0.5 : 0;
  const panel = config.backing === 'panel';
  const span = graph.end - graph.start;

  curves = shown.map(() => new Float32Array(pxW));
  for (let row = 0; row < count; row++) {
    const top = rowTops[row];
    const bottom = top + laneHpx;
    if (panel) {
      b.fillStyle = 'rgb(11 12 13 / .62)';
      b.fillRect(0, top, pxW, laneHpx);
    }
    // Minute (and half-minute) ticks rising from the baseline, then the baseline itself.
    for (let t = Math.ceil(graph.start / 30000) * 30000; t < graph.end; t += 30000) {
      const x = Math.round(((t - graph.start) / span) * pxW);
      const tall = t % 60000 === 0;
      b.fillStyle = rgba(fg, tall ? 0.16 : 0.09);
      b.fillRect(x, tall ? top : bottom - Math.round(laneHpx / 3), line, tall ? laneHpx : Math.round(laneHpx / 3));
    }
    b.fillStyle = 'rgb(0 0 0 / .35)';
    b.fillRect(0, bottom - line, pxW, line * 2);
    b.fillStyle = rgba(fg, 0.3);
    b.fillRect(0, bottom - line, pxW, line);
    const curve = curves[row];
    columnHeights(shown[row].lane, curve, laneHpx - Math.round(4 * ratio));
    trace(b, curve, top, bottom - line, rgba(fg, 0.05), rgba(fg, 0.4), line, half);
    trace(lit.getContext('2d'), curve, top, bottom - line, rgba(fg, 0.16), rgba(fg, 0.85), line, half);
    trace(accent.getContext('2d'), curve, top, bottom - line, rgba(lead, 0.26), rgba(lead, 1), line, half);
  }
  layers = {
    base, lit, accent,
    playhead: rgba(fg, 0.95), dot: rgba(fg, 1), leadDot: rgba(lead, 1), band: rgba(fg, 0.08),
  };
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

/** Area plus top line; the line gets a dark under-stroke so it reads over bright backgrounds. */
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
  g.lineJoin = 'round';
  g.lineWidth = line * 3;
  g.strokeStyle = 'rgb(0 0 0 / .32)';
  g.stroke();
  g.lineWidth = line * 1.5;
  g.strokeStyle = stroke;
  g.stroke();
}

/** Graph-time position of the play head, or null outside an attempt. */
function playTime() {
  if (!graph || !isPlaying(values?.[P.state])) return null;
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
  if (!graph || !shown.length) { leadLane = null; return; }
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

function renderText(t) {
  textDirty = false;
  const playing = view === 'play';
  setText(el.leadLabel, playing ? 'Section lead' : 'Map lead');
  const lead = leadLane && shown.find(r => r.lane === leadLane);
  setText(el.leadName, lead ? lead.lane.skill.label : '—');
  setText(el.leadShare, lead ? lead.share : '');
  setAttr(cluster, 'data-lead', lead ? 'some' : 'none');
  for (const row of shown) {
    const share = row.share || '—';
    if (setText(row.shareText, share)) row.shareBar.style.transform = `scaleX(${share === '—' ? 0 : row.fraction.toFixed(3)})`;
    if (row.lead !== row.nameEl.hasAttribute('data-lead')) {
      row.nameEl.toggleAttribute('data-lead', row.lead);
      row.shareEl.toggleAttribute('data-lead', row.lead);
    }
  }
  const live = stars(values?.[P.starsLive]);
  const total = stars(values?.[P.starsTotal]);
  setText(el.starsLive, live ?? '—');
  setText(el.starsTotal, total ? `/ ${total}` : '');
  setAttr(el.starsLive, 'data-empty', live ? null : '');
  setText(el.clock, playing && t !== null ? formatDuration(Math.max(0, t)) : '');
  setText(el.length, graph ? formatDuration(graph.end) : '');
  setText(el.note, graph ? '' : 'No strain data for this map');
}

function renderStatus() {
  const offline = connection === 'offline';
  setText(el.status, connection === 'live' ? 'osu! not running' : offline ? 'vosu offline' : 'Connecting to vosu');
  stage.dataset.status = offline ? 'offline' : 'idle';
}

// ---------------------------------------------------------------- frame
function frame() {
  raf = 0;
  if (!config) return;
  if (graphDirty) {
    graphDirty = false;
    graph = values ? buildGraph(values[P.series], values[P.xaxis]) : null;
    layoutDirty = true;
  }
  const nextView = viewOf();
  if (nextView !== view) {
    view = nextView;
    stage.dataset.view = view;
    layoutDirty = true;
  }
  if (view === 'status') renderStatus();
  if (view !== 'play' && view !== 'select') return;
  if (layoutDirty) applyLayout();
  if (layersDirty) buildLayers();

  const t = playTime();
  const x = view === 'play' ? playX(t) : -1;
  if (x !== lastPlayX) { lastPlayX = x; drawDirty = true; }
  if (t !== null || drawDirty) updateLead(view === 'play' ? t : null);
  if (textDirty) renderText(t);
  if (drawDirty) draw(x, t);
}

function draw(x, t) {
  drawDirty = false;
  ctx.clearRect(0, 0, pxW, pxH);
  if (!layers) return;
  ctx.drawImage(layers.base, 0, 0);
  const end = x < 0 ? pxW : x;
  for (let row = 0; row < shown.length; row++) {
    if (end <= 0) break;
    const src = shown[row].lane === leadLane ? layers.accent : layers.lit;
    ctx.drawImage(src, 0, rowTops[row], end, laneHpx, 0, rowTops[row], end, laneHpx);
  }
  if (x < 0 || t === null) return;
  const span = graph.end - graph.start;
  const x0 = Math.max(0, Math.round(((t - SECTION_MS - graph.start) / span) * pxW));
  const x1 = Math.min(pxW, Math.round(((t + SECTION_MS - graph.start) / span) * pxW));
  const line = Math.max(1, Math.round(ratio));
  ctx.fillStyle = layers.band;
  if (x1 > x0) for (let row = 0; row < shown.length; row++) ctx.fillRect(x0, rowTops[row], x1 - x0, laneHpx);
  const px = Math.min(pxW - line, x);
  ctx.fillStyle = 'rgb(0 0 0 / .4)';
  ctx.fillRect(px + line, 0, line, pxH);
  ctx.fillStyle = layers.playhead;
  ctx.fillRect(px, 0, line, pxH);
  // Read-out dot where the play head crosses each curve.
  const column = Math.min(pxW - 1, x);
  const radius = 3 * ratio;
  for (let row = 0; row < shown.length; row++) {
    const y = rowTops[row] + laneHpx - line - curves[row][column];
    ctx.beginPath();
    ctx.arc(column + 0.5, Math.max(rowTops[row] + radius, y), radius, 0, Math.PI * 2);
    ctx.fillStyle = shown[row].lane === leadLane ? layers.leadDot : layers.dot;
    ctx.fill();
  }
}

// ---------------------------------------------------------------- map tint (off the hot path)
function loadPalette(next) {
  checksum = next || null;
  if (!checksum || config.accent !== 'map') { applyPalette(stage, null); layersDirty = true; schedule(); return; }
  mapPalette(checksum).then(found => {
    if (checksum !== next || config.accent !== 'map') return;
    applyPalette(stage, found);
    layersDirty = drawDirty = true;
    schedule();
  });
}

// ---------------------------------------------------------------- wiring
const DEFAULTS = {
  zone: 'below lane', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map', songSelect: 'centre gap',
  laneColor: true, laneRhythm: true, laneStamina: true, laneReading: true, laneHeight: 30, showBrand: true,
};
settings(DEFAULTS, next => {
  next.laneHeight = Math.round(Math.min(56, Math.max(20, next.laneHeight)));
  next.scale = Math.min(2, Math.max(0.5, next.scale));
  const accentChanged = config && config.accent !== next.accent;
  config = next;
  el.brand.hidden = !next.showBrand;
  layoutDirty = true;
  if (accentChanged) loadPalette(checksum);
  schedule();
});

fit(stage, W, H);
updateRatio();

subscribe(Object.values(P), (frameValues, changed) => {
  values = frameValues;
  if (changed.has(P.checksum)) loadPalette(values[P.checksum]);
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
    const changed = state !== connection;
    connection = state;
    // 'live' repeats on every frame; only a change of connection state needs a render.
    if (changed) schedule();
  },
});

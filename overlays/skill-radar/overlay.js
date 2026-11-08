// Copyright (c) 2026 18-LAB. MIT.
// Skill radar: osu! pp split into aim / speed / accuracy / flashlight, live against the
// full-combo projection, over a strip of the map's aim-vs-speed strain profile. Floats in the
// side band beside the 4:3 playfield; in song select it shows only the strain profile and SS pp.
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const SKILLS = ['aim', 'speed', 'accuracy', 'flashlight'];
const AXES = ['AIM', 'SPD', 'ACC', 'FL'];
const FL = 3;
const COLUMN_W = 208;
const LAYOUT = osuLayout('osu');
// Hit objects overhang the 512×384 playfield by their radius (≈ 82 px at CS 4, 1080p); keep clear.
const OVERHANG = 88;
// Song select: foot of the free centre column between stable's local leaderboard (x ≲ 520) and
// the beatmap carousel (x ≳ 1180). Results: right end of the ranking screen's header strip.
const SELECT = { centre: 850, bottom: 920, width: 360 };
const RESULTS = { right: 1900, top: 12 };

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  selMode: '/settings/mode/number',
  live: '/beatmap/time/live',
  rate: '/beatmap/time/rate',
  modsRate: '/play/mods/rate',
  mods: '/play/mods/name',
  checksum: '/beatmap/checksum',
  ppNow: '/play/pp/current',
  ppFc: '/play/pp/fc',
  resNow: '/resultsScreen/pp/current',
  resFc: '/resultsScreen/pp/fc',
  ss: '/performance/accuracy/100',
  acc99: '/performance/accuracy/99',
  series: '/performance/graph/series',
  xaxis: '/performance/graph/xaxis',
};
const NOW_P = SKILLS.map(skill => `/play/pp/detailed/current/${skill}`);
const FC_P = SKILLS.map(skill => `/play/pp/detailed/fc/${skill}`);
const POINTERS = [...Object.values(P), ...NOW_P, ...FC_P];

// ---------------------------------------------------------------- dom
const $ = id => document.getElementById(id);
const cluster = $('cluster');
const el = {
  title: $('title'), status: $('status'), statusText: $('status-text'),
  nowLabel: $('now-label'), nowValue: $('now-value'), fcLabel: $('fc-label'), fcValue: $('fc-value'),
  shareAim: $('share-aim'), shareSpeed: $('share-speed'), stripEmpty: $('strip-empty'),
};
const rows = [...cluster.querySelectorAll('.row[data-skill]')].map(row => {
  const cells = row.querySelectorAll('.v');
  return { row, now: cells[0], fc: cells[1] };
});
const radar = canvas($('radar'));
const bars = canvas($('bars'));
const strip = canvas($('strip'));

function canvas(node) {
  return { node, ctx: node.getContext('2d', { alpha: true }), w: 0, h: 0, dpr: 1 };
}

const textCache = new WeakMap();
function setText(node, text) {
  if (textCache.get(node) === text) return;
  textCache.set(node, text);
  node.textContent = text;
}
function setFlag(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}
function setData(node, key, value) {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}

function group(n) {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, '0')}`;
}
const num = value => typeof value === 'number' && Number.isFinite(value);
const fmt = value => (num(value) && value >= 0 ? group(Math.round(value)) : '—');

// ---------------------------------------------------------------- colours
const colour = {
  fg: '#ebe8e1', dim: '#b8b5ad', signal: '#7fa6cf', hl: '#ff963f',
  ring: 'rgb(235 232 225 / 0.13)', ringOuter: 'rgb(235 232 225 / 0.3)', axis: 'rgb(235 232 225 / 0.24)',
  tick: 'rgb(235 232 225 / 0.2)', track: 'rgb(235 232 225 / 0.12)', notch: 'rgb(11 12 13 / 0.8)',
  centre: 'rgb(235 232 225 / 0.34)', shadow: 'rgb(0 0 0 / 0.65)',
};
function readColours() {
  const root = getComputedStyle(document.documentElement);
  const get = (style, name, fallback) => style.getPropertyValue(name).trim() || fallback;
  colour.fg = get(root, '--fg', colour.fg);
  colour.dim = get(root, '--fg-dim', colour.dim);
  colour.signal = get(root, '--signal', colour.signal);
  colour.hl = get(getComputedStyle(cluster), '--hl', get(root, '--accent', colour.hl));
}

// ---------------------------------------------------------------- model
const opts = {
  chartStyle: 'radar', showFc: true, showProfile: true, zone: 'right', offsetX: 0, offsetY: 0, scale: 100,
  backing: 'none', accent: 'map', showSelect: true, showResults: true, showBrand: true,
};
const model = {
  link: 'connecting', present: false, osu: true, phase: 'idle', state: null, view: 'none',
  mods: '', axes: 3, components: false, checksum: null,
  nowLabel: 'Now', fcLabel: 'If FC', nowTotal: undefined, fcTotal: undefined,
};
const target = { now: new Float64Array(4), fc: new Float64Array(4), max: 0, alpha: 0 };
const shown = { now: new Float64Array(4), fc: new Float64Array(4), max: 0, alpha: 0 };
const held = { now: new Float64Array(4), fc: new Float64Array(4), checksum: null, valid: false };
const scratchNow = new Float64Array(4);
const scratchFc = new Float64Array(4);

const graph = {
  series: null, xaxis: null, dirty: true, ready: false,
  x0: 0, span: 1, shareAim: null, live: null, rate: 1,
  aimPath: null, speedPath: null, head: -1, built: { w: 0, h: 0 },
};

let textDirty = true;
let chartDirty = true;
let stripDirty = true;
let placeDirty = true;
let raf = 0;
let lastFrame = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };

function readComponents(values, into, fcInto) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const n = values[NOW_P[i]];
    const f = values[FC_P[i]];
    if (!num(n) || !num(f)) return false;
    into[i] = Math.max(0, n);
    fcInto[i] = Math.max(0, f);
    sum += fcInto[i];
  }
  return sum > 0;
}

/** What the overlay shows: gameplay always; results and song select only what osu! lacks there. */
function viewFor() {
  if (model.link !== 'live' || !model.present) return 'status';
  if (!model.osu) return 'none';
  if (model.phase === 'play') return 'play';
  if (model.phase === 'results') return opts.showResults && (model.components || num(model.nowTotal)) ? 'results' : 'none';
  if (model.state === 5 && opts.showSelect && (graph.series || num(model.nowTotal))) return 'select';
  return 'none';
}

function update(values) {
  const state = values[P.state];
  model.present = num(state);
  model.state = model.present ? state : null;
  model.osu = activeMode(state, values[P.playMode], values[P.selMode]) === 'osu';
  model.phase = state === 2 ? 'play' : state === 7 ? 'results' : 'idle';
  const mods = typeof values[P.mods] === 'string' ? values[P.mods] : '';
  model.mods = mods === 'NM' ? '' : mods;

  const checksum = typeof values[P.checksum] === 'string' ? values[P.checksum] : null;
  if (checksum !== model.checksum) {
    model.checksum = checksum;
    loadPalette(checksum);
  }
  const live = readComponents(values, scratchNow, scratchFc);
  let source = null;
  if (model.phase === 'play' && live) {
    held.now.set(scratchNow);
    held.fc.set(scratchFc);
    held.checksum = checksum;
    held.valid = true;
    source = 'live';
  } else if (model.phase === 'results') {
    if (live) source = 'live';
    else if (held.valid && held.checksum === checksum) source = 'held';
  }
  model.components = source !== null;
  if (source) {
    const now = source === 'live' ? scratchNow : held.now;
    const fc = source === 'live' ? scratchFc : held.fc;
    let max = 0;
    for (let i = 0; i < 4; i++) {
      target.now[i] = now[i];
      target.fc[i] = fc[i];
      max = Math.max(max, fc[i], now[i]);
    }
    target.max = max;
  }
  model.axes = (model.components && (target.fc[FL] > 0 || target.now[FL] > 0)) || /FL/.test(model.mods) ? 4 : 3;
  target.alpha = model.components ? 1 : 0;

  if (model.phase === 'play') {
    model.nowLabel = 'Now';
    model.fcLabel = 'If FC';
    model.nowTotal = values[P.ppNow];
    model.fcTotal = values[P.ppFc];
  } else if (model.phase === 'results') {
    const resNow = values[P.resNow];
    const resFc = values[P.resFc];
    const fromResults = num(resNow) && (resNow > 0 || (num(resFc) && resFc > 0));
    model.nowLabel = 'Final';
    model.fcLabel = 'If FC';
    model.nowTotal = fromResults ? resNow : values[P.ppNow];
    model.fcTotal = fromResults ? resFc : values[P.ppFc];
  } else {
    model.nowLabel = 'SS';
    model.fcLabel = '99%';
    model.nowTotal = values[P.ss];
    model.fcTotal = values[P.acc99];
  }
  // Absent gameplay pp (tosu without detail, osu! closed) stays a dash rather than 0.
  if (model.phase !== 'idle' && !model.components && !(num(model.fcTotal) && model.fcTotal > 0)) {
    model.nowTotal = undefined;
    model.fcTotal = undefined;
  }
}

function updateHead(values) {
  const rate = values[P.rate];
  const modsRate = values[P.modsRate];
  graph.rate = num(rate) && rate > 0 ? rate : num(modsRate) && modsRate > 0 ? modsRate : 1;
  graph.live = num(values[P.live]) ? values[P.live] : null;
  return headColumn();
}

/** Playhead in strip device pixels; graph x values are real-time ms (map clock ÷ rate). */
function headColumn() {
  if (!graph.ready || graph.live === null) return -1;
  const frac = (graph.live / graph.rate - graph.x0) / graph.span;
  if (!(frac >= 0 && frac <= 1)) return frac > 1 ? strip.w : -1;
  return Math.round(frac * strip.w);
}

function onFrame(values, changed) {
  let other = false;
  for (const pointer of changed) {
    if (pointer !== P.live) { other = true; break; }
  }
  if (other) {
    if (changed.has(P.series) || changed.has(P.xaxis)) {
      const series = values[P.series];
      graph.series = Array.isArray(series) && series.length ? series : null;
      graph.xaxis = values[P.xaxis];
      graph.dirty = true;
    }
    update(values);
    textDirty = chartDirty = stripDirty = true;
  }
  const head = updateHead(values);
  if (head !== graph.head) { graph.head = head; stripDirty = true; other = true; }
  if (other) schedule();
}

function onStatus(state) {
  if (state === model.link) return;
  model.link = state;
  if (state !== 'live') {
    model.present = false;
    model.phase = 'idle';
    model.components = false;
    model.nowTotal = model.fcTotal = undefined;
    target.alpha = 0;
    graph.series = graph.xaxis = null;
    graph.dirty = true;
    graph.live = null;
  }
  textDirty = chartDirty = stripDirty = true;
  schedule();
}

// ---------------------------------------------------------------- palette (off the hot path)
let palette = null;
let paletteFor = null;
function loadPalette(checksum) {
  paletteFor = checksum;
  if (!checksum) { palette = null; applyAccent(); return; }
  mapPalette(checksum).then(result => {
    if (paletteFor !== checksum) return;
    palette = result;
    applyAccent();
  });
}
function applyAccent() {
  applyPalette(cluster, opts.accent === 'map' ? palette : null);
  setData(cluster, 'accent', opts.accent);
  readColours();
  chartDirty = stripDirty = true;
  schedule();
}

// ---------------------------------------------------------------- placement
/** Right zone: the band between the playfield's hit-object overhang and the key counter. */
function place() {
  const s = Math.min(2, Math.max(0.5, opts.scale / 100));
  const pad = opts.backing === 'panel' ? 26 : 0;
  const outer = COLUMN_W + pad;
  const { busy, hud, width, height } = LAYOUT;
  let left = null;
  let right = null;
  let top = null;
  let bottom = null;
  if (model.view === 'select') {
    left = SELECT.centre - ((SELECT.width + pad) * s) / 2;
    bottom = height - SELECT.bottom;
  } else if (model.view === 'results') {
    right = width - RESULTS.right;
    top = RESULTS.top;
  } else if (opts.zone === 'left') {
    left = busy.x - OVERHANG - outer * s;
    top = hud.accuracy.y + hud.accuracy.h + 36;
  } else {
    left = Math.min(busy.x + busy.w + OVERHANG, hud.keys.x - 16 - outer * s);
    top = hud.accuracy.y + hud.accuracy.h + 36;
  }
  const px = value => `${Math.round(value)}px`;
  const style = cluster.style;
  style.left = left === null ? 'auto' : px(left + opts.offsetX);
  style.right = right === null ? 'auto' : px(right - opts.offsetX);
  style.top = top === null ? 'auto' : px(top + opts.offsetY);
  style.bottom = bottom === null ? 'auto' : px(bottom - opts.offsetY);
  style.transformOrigin = `${right === null ? '0' : '100%'} ${bottom === null ? '0' : '100%'}`;
  style.transform = s === 1 ? '' : `scale(${s})`;
}

// ---------------------------------------------------------------- text
const STATUS = {
  connecting: { tone: 'wait', text: 'connecting' },
  offline: { tone: 'error', text: 'vosu offline' },
  absent: { tone: 'wait', text: 'no game' },
};
function renderText() {
  const view = viewFor();
  if (view !== model.view) {
    model.view = view;
    setData(cluster, 'view', view);
    placeDirty = true;
    chartDirty = stripDirty = true;
  }
  if (placeDirty) { placeDirty = false; place(); }
  if (view === 'none') return;
  const st = model.link === 'connecting' ? STATUS.connecting : model.link === 'offline' ? STATUS.offline : STATUS.absent;
  setData(el.status, 'tone', st.tone);
  setText(el.statusText, st.text);
  setText(el.title, view === 'select' ? 'map profile' : 'pp by skill');
  setText(el.nowLabel, model.nowLabel);
  setText(el.fcLabel, model.fcLabel);
  const nowText = fmt(model.nowTotal);
  const fcText = fmt(model.fcTotal);
  setText(el.nowValue, nowText);
  setText(el.fcValue, fcText);
  setFlag(el.nowValue, 'none', nowText === '—');
  setFlag(el.fcValue, 'none', fcText === '—');
  for (let i = 0; i < 4; i++) {
    const off = i === FL && model.axes === 3;
    const show = model.components && !off;
    setFlag(rows[i].row, 'off', off);
    setFlag(rows[i].row, 'none', !show);
    setText(rows[i].now, show ? fmt(target.now[i]) : '—');
    setText(rows[i].fc, show ? fmt(target.fc[i]) : '—');
  }
}

// ---------------------------------------------------------------- radar
const DASH = [2, 3];
const SOLID = [];
const MONO = '400 12px "IBM Plex Mono", ui-monospace, monospace';
// Leaves room for the dial ticks and axis names around the scope (side names ≈ 22 px wide).
const radarRadius = c => Math.max(16, Math.min(c.w / 2 - 36, c.h / 2 - 22));
const RADAR_FILL = 0.86;
const COS = new Float64Array(4);
const SIN = new Float64Array(4);
let face = null;

function begin(c) {
  const { ctx } = c;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.node.width, c.node.height);
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  return ctx;
}

function polygon(ctx, cx, cy, values, n, k) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const r = values[i] * k;
    const x = cx + COS[i] * r;
    const y = cy + SIN[i] * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function drawRadar() {
  if (!radar.w) return;
  const ctx = begin(radar);
  const n = model.axes;
  const cx = Math.round(radar.w / 2);
  const cy = Math.round(radar.h / 2) + 2;
  const R = radarRadius(radar);
  const px = 0.5 / radar.dpr;
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    COS[i] = Math.cos(angle);
    SIN[i] = Math.sin(angle);
  }

  // Scope face: a feathered dark disc so the marks read over any map background.
  if (opts.backing !== 'panel') {
    if (!face) {
      face = ctx.createRadialGradient(cx, cy, 0, cx, cy, R + 30);
      face.addColorStop(0, 'rgb(11 12 13 / 0.56)');
      face.addColorStop((R + 4) / (R + 30), 'rgb(11 12 13 / 0.46)');
      face.addColorStop(1, 'rgb(11 12 13 / 0)');
    }
    ctx.fillStyle = face;
    ctx.fillRect(cx - R - 30, cy - R - 30, (R + 30) * 2, (R + 30) * 2);
  }

  // Dial: 5° graduations outside the scope, quarter rings inside.
  ctx.lineWidth = 1 / radar.dpr;
  ctx.strokeStyle = colour.tick;
  ctx.beginPath();
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const inner = deg % 30 === 0 ? R + 2 : R + 3;
    const outer = deg % 30 === 0 ? R + 6 : R + 4.5;
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
  }
  ctx.stroke();
  for (let k = 1; k <= 4; k++) {
    ctx.strokeStyle = k === 4 ? colour.ringOuter : colour.ring;
    ctx.beginPath();
    ctx.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = colour.axis;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = cx + COS[i] * (R + 6);
    const y = cy + SIN[i] * (R + 6);
    ctx.moveTo(Math.abs(COS[i]) < 1e-6 ? cx + px : cx, Math.abs(SIN[i]) < 1e-6 ? cy + px : cy);
    ctx.lineTo(Math.abs(COS[i]) < 1e-6 ? x + px : x, Math.abs(SIN[i]) < 1e-6 ? y + px : y);
  }
  ctx.stroke();

  // Layers: FC projection as a dashed ghost, the live split filled in the highlight colour.
  const a = shown.alpha;
  if (a > 0.004 && shown.max > 0) {
    const k = (R * RADAR_FILL) / shown.max;
    if (opts.showFc) {
      polygon(ctx, cx, cy, shown.fc, n, k);
      ctx.globalAlpha = a * 0.1;
      ctx.fillStyle = colour.dim;
      ctx.fill();
      ctx.globalAlpha = a * 0.85;
      ctx.setLineDash(DASH);
      ctx.strokeStyle = colour.dim;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash(SOLID);
    }
    polygon(ctx, cx, cy, shown.now, n, k);
    ctx.globalAlpha = a * 0.24;
    ctx.fillStyle = colour.hl;
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = colour.hl;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = colour.hl;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = shown.now[i] * k;
      const x = cx + COS[i] * r;
      const y = cy + SIN[i] * r;
      ctx.moveTo(x + 2.5, y);
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = colour.centre;
  ctx.fillRect(cx - 1, cy - 1, 2, 2);

  // Axis names just past the dial, pushed out by half their width on side axes.
  ctx.font = MONO;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.9px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = colour.shadow;
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = model.components ? colour.fg : colour.dim;
  for (let i = 0; i < n; i++) {
    const width = ctx.measureText(AXES[i]).width;
    const d = R + 13 + Math.abs(COS[i]) * (width / 2 - 2);
    ctx.fillText(AXES[i], Math.round(cx + COS[i] * d), Math.round(cy + SIN[i] * d) + 0.5);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

// ---------------------------------------------------------------- bars
const BAR_ROW = 34;
const BAR_Y = 25;
const BAR_H = 5;
const BAR_FILL = 0.96;

function drawBars() {
  if (!bars.w) return;
  const ctx = begin(bars);
  const w = bars.w;
  const px = 1 / bars.dpr;
  const k = shown.max > 0 ? (w * BAR_FILL) / shown.max : 0;
  for (let i = 0; i < 4; i++) {
    const top = i * BAR_ROW + BAR_Y;
    const off = i === FL && model.axes === 3;
    ctx.fillStyle = colour.track;
    ctx.fillRect(0, top, w, BAR_H);
    ctx.fillStyle = colour.notch;
    for (let q = 1; q < 4; q++) ctx.fillRect(Math.round((w * BAR_FILL * q) / 4), top, px, BAR_H);
    if (off || shown.alpha <= 0.004 || !k) continue;
    const a = shown.alpha;
    if (opts.showFc) {
      const fw = shown.fc[i] * k;
      ctx.globalAlpha = a * 0.34;
      ctx.fillStyle = colour.dim;
      ctx.fillRect(0, top, fw, BAR_H);
      ctx.globalAlpha = a;
      ctx.fillRect(Math.max(0, Math.round(fw) - px), top - 3, px * 2, BAR_H + 6);
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = colour.hl;
    ctx.fillRect(0, top, shown.now[i] * k, BAR_H);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- strip
function buildStrip() {
  graph.dirty = false;
  graph.ready = false;
  graph.shareAim = null;
  graph.aimPath = graph.speedPath = null;
  const { series, xaxis } = graph;
  if (!Array.isArray(series) || !Array.isArray(xaxis) || xaxis.length < 2) return;
  const aim = series.find(s => s && s.name === 'aim')?.data;
  const speed = series.find(s => s && s.name === 'speed')?.data;
  if (!Array.isArray(aim) || !Array.isArray(speed)) return;
  const count = Math.min(xaxis.length, aim.length, speed.length);
  if (count < 2) return;
  const x0 = xaxis[0];
  const span = xaxis[count - 1] - x0;
  if (!(span > 0)) return;
  graph.x0 = x0;
  graph.span = span;

  // Peak per device column (vosu pads empty lead-in/out with negative sentinels: read as 0).
  const w = strip.w;
  const h = strip.h;
  if (!w || !h) return;
  const aimCol = new Float32Array(w + 1).fill(-1);
  const speedCol = new Float32Array(w + 1).fill(-1);
  let peak = 0;
  let sumAim = 0;
  let sumSpeed = 0;
  for (let i = 0; i < count; i++) {
    const c = Math.max(0, Math.min(w, Math.round(((xaxis[i] - x0) / span) * w)));
    const a = aim[i] > 0 ? aim[i] : 0;
    const s = speed[i] > 0 ? speed[i] : 0;
    if (a > aimCol[c]) aimCol[c] = a;
    if (s > speedCol[c]) speedCol[c] = s;
    if (a > peak) peak = a;
    if (s > peak) peak = s;
    sumAim += a;
    sumSpeed += s;
  }
  graph.ready = true;
  graph.built.w = w;
  graph.built.h = h;
  if (sumAim + sumSpeed > 0) graph.shareAim = sumAim / (sumAim + sumSpeed);
  if (!(peak > 0)) return;
  const mid = Math.round(h / 2);
  const amp = (h / 2 - 2 * strip.dpr) / peak;
  const gap = Math.round(strip.dpr);
  const area = (cols, sign) => {
    const path = new Path2D();
    const base = mid + sign * gap;
    path.moveTo(0, base);
    for (let c = 0; c <= w; c++) {
      if (cols[c] < 0) continue;
      path.lineTo(c, base - sign * cols[c] * amp);
    }
    path.lineTo(w, base);
    path.closePath();
    return path;
  };
  graph.aimPath = area(aimCol, 1);
  graph.speedPath = area(speedCol, -1);
}

function fillStrip(ctx, from, to, alpha) {
  if (to <= from) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(from, 0, to - from, strip.h);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour.dim;
  ctx.fill(graph.aimPath);
  ctx.fillStyle = colour.signal;
  ctx.fill(graph.speedPath);
  ctx.restore();
}

function drawStrip() {
  if (!strip.w) return;
  if (graph.dirty || graph.built.w !== strip.w || graph.built.h !== strip.h) {
    buildStrip();
    graph.head = headColumn();
  }
  const { ctx } = strip;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, strip.w, strip.h);
  if (!graph.aimPath) return;
  const w = strip.w;
  const h = strip.h;
  const line = Math.max(1, Math.round(strip.dpr));
  const head = graph.head;
  if (model.view === 'play') {
    const split = Math.max(0, Math.min(w, head));
    fillStrip(ctx, 0, split, 0.95);
    fillStrip(ctx, split, w, 0.38);
  } else if (model.view === 'results') {
    fillStrip(ctx, 0, w, 0.95);
  } else {
    fillStrip(ctx, 0, w, 0.8);
  }
  ctx.fillStyle = colour.ringOuter;
  ctx.fillRect(0, Math.round(h / 2) - (line >> 1), w, line);
  if (head >= 0 && head <= w && model.view !== 'results') {
    const x = Math.min(w - line * 2, head);
    ctx.fillStyle = model.view === 'play' ? colour.hl : colour.fg;
    ctx.fillRect(x, 0, line * 2, h);
  }
}

function renderShare() {
  const share = graph.shareAim;
  const has = graph.ready && share !== null;
  const aimPct = has ? Math.round(share * 100) : 0;
  setText(el.shareAim, has ? `${aimPct}%` : '—');
  setText(el.shareSpeed, has ? `${100 - aimPct}%` : '—');
  const empty = !graph.aimPath;
  if (el.stripEmpty.hidden !== !empty) el.stripEmpty.hidden = !empty;
}

// ---------------------------------------------------------------- frame
function approach(from, to, k, eps) {
  const next = from + (to - from) * k;
  return Math.abs(to - next) < eps ? to : next;
}

function frame(time) {
  raf = 0;
  const dt = lastFrame ? Math.min(64, time - lastFrame) : 16;
  lastFrame = time;

  let animating = false;
  // Grow from the centre when a breakdown first appears.
  if (target.alpha > 0 && shown.alpha === 0) {
    shown.now.fill(0);
    shown.fc.fill(0);
    shown.max = target.max;
  }
  const k = 1 - Math.exp(-dt / 55);
  const eps = Math.max(0.01, target.max * 0.0015);
  if (target.alpha > 0) {
    for (let i = 0; i < 4; i++) {
      shown.now[i] = approach(shown.now[i], target.now[i], k, eps);
      shown.fc[i] = approach(shown.fc[i], target.fc[i], k, eps);
      if (shown.now[i] !== target.now[i] || shown.fc[i] !== target.fc[i]) animating = true;
    }
    shown.max = approach(shown.max, target.max, k, eps);
    if (shown.max !== target.max) animating = true;
  }
  shown.alpha = approach(shown.alpha, target.alpha, 1 - Math.exp(-dt / 45), 0.004);
  if (shown.alpha !== target.alpha) animating = true;

  if (textDirty) {
    textDirty = false;
    renderText();
  }
  const view = model.view;
  if (view === 'play' || view === 'results') {
    if (chartDirty || animating) {
      chartDirty = false;
      if (opts.chartStyle === 'bars' && view === 'play') drawBars(); else drawRadar();
    }
  } else {
    animating = false;
  }
  if (stripDirty && (view === 'select' || ((view === 'play' || view === 'results') && opts.showProfile))) {
    stripDirty = false;
    drawStrip();
    renderShare();
  }
  if (animating) schedule(); else lastFrame = 0;
}

// ---------------------------------------------------------------- sizing
function size(c, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (w === c.node.width && h === c.node.height && dpr === c.dpr) return false;
  c.node.width = w;
  c.node.height = h;
  c.dpr = dpr;
  c.w = c === strip ? w : width;
  c.h = c === strip ? h : height;
  if (c === radar) face = null;
  return true;
}
const cssSize = new Map();
const observer = new ResizeObserver(entries => {
  for (const entry of entries) cssSize.set(entry.target, entry.contentRect);
  resizeAll();
});
function resizeAll() {
  let changed = false;
  for (const c of [radar, bars, strip]) {
    const rect = cssSize.get(c.node);
    if (rect && rect.width > 0 && rect.height > 0 && size(c, rect.width, rect.height)) changed = true;
  }
  if (!changed) return;
  graph.head = headColumn();
  chartDirty = stripDirty = true;
  schedule();
}
for (const c of [radar, bars, strip]) observer.observe(c.node);
addEventListener('resize', resizeAll);

// ---------------------------------------------------------------- boot
fit($('stage'), 1920, 1080);
readColours();

settings({ ...opts }, next => {
  const backing = ['none', 'scrim', 'panel'].includes(next.backing) ? next.backing : 'none';
  opts.chartStyle = next.chartStyle === 'bars' ? 'bars' : 'radar';
  opts.showFc = next.showFc !== false;
  opts.showProfile = next.showProfile !== false;
  opts.zone = next.zone === 'left' ? 'left' : 'right';
  opts.offsetX = next.offsetX;
  opts.offsetY = next.offsetY;
  opts.scale = next.scale;
  if (backing !== opts.backing) face = null;
  opts.backing = backing;
  opts.accent = next.accent === '18-lab' ? '18-lab' : 'map';
  opts.showSelect = next.showSelect !== false;
  opts.showResults = next.showResults !== false;
  opts.showBrand = next.showBrand !== false;
  setData(cluster, 'style', opts.chartStyle);
  setData(cluster, 'backing', opts.backing);
  setFlag(cluster, 'no-fc', !opts.showFc);
  setFlag(cluster, 'no-profile', !opts.showProfile);
  setFlag(cluster, 'no-brand', !opts.showBrand);
  placeDirty = textDirty = true;
  applyAccent();
});

subscribe(POINTERS, onFrame, { onStatus });

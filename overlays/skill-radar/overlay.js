// Copyright (c) 2026 18-LAB. MIT.
// Skill radar: osu! pp split into aim / speed / accuracy / flashlight, live against the
// full-combo projection, over a strip of the map's aim-vs-speed strain profile.
import { subscribe, settings, fit, activeMode } from './vosu-overlay.js';

const STAGE_W = 408;
const STAGE_H = 388;
const SKILLS = ['aim', 'speed', 'accuracy', 'flashlight'];
const AXES = ['AIM', 'SPD', 'ACC', 'FL'];
const FL = 3;

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
const panel = $('panel');
const el = {
  status: $('status'), statusText: $('status-text'), mods: $('mods'),
  nowLabel: $('now-label'), nowValue: $('now-value'), fcLabel: $('fc-label'), fcValue: $('fc-value'),
  shareAim: $('share-aim'), shareSpeed: $('share-speed'), stripEmpty: $('strip-empty'),
};
const rows = [...panel.querySelectorAll('.row[data-skill]')].map(row => {
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

function group(n) {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, '0')}`;
}
const num = value => typeof value === 'number' && Number.isFinite(value);
const fmt = value => (num(value) && value >= 0 ? group(Math.round(value)) : '—');

// ---------------------------------------------------------------- colours
const colour = {};
function readColours() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  colour.fg = get('--fg', '#ebe8e1');
  colour.dim = get('--fg-dim', '#b8b5ad');
  colour.muted = get('--muted', '#7e8288');
  colour.rule = get('--rule', '#25282c');
  colour.ruleStrong = get('--rule-strong', '#3b3f45');
  colour.accent = get('--accent', '#ff963f');
  colour.signal = get('--signal', '#7fa6cf');
  colour.bg = get('--bg', '#111214');
}
readColours();

// ---------------------------------------------------------------- model
const opts = { chartStyle: 'radar', showFc: true, showProfile: true, showBrand: true };
const model = {
  link: 'connecting', present: false, visible: true, phase: 'idle', state: null,
  mods: '', axes: 3, components: false,
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

function update(values) {
  const state = values[P.state];
  model.present = num(state);
  model.state = model.present ? state : null;
  const mode = activeMode(state, values[P.playMode], values[P.selMode]);
  model.visible = mode === 'osu' || mode === null;
  model.phase = state === 2 ? 'play' : state === 7 ? 'results' : 'idle';
  const mods = typeof values[P.mods] === 'string' ? values[P.mods] : '';
  model.mods = mods === 'NM' ? '' : mods;

  const checksum = values[P.checksum] ?? null;
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
  } else if (model.present) {
    model.nowLabel = 'SS';
    model.fcLabel = '99%';
    model.nowTotal = values[P.ss];
    model.fcTotal = values[P.acc99];
  } else {
    model.nowLabel = 'Now';
    model.fcLabel = 'If FC';
    model.nowTotal = model.fcTotal = undefined;
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
    update(values);
    if (changed.has(P.series) || changed.has(P.xaxis)) {
      graph.series = values[P.series];
      graph.xaxis = values[P.xaxis];
      graph.dirty = true;
    }
    textDirty = true;
    chartDirty = true;
    stripDirty = true;
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
    model.visible = true;
    model.phase = 'idle';
    model.components = false;
    model.mods = '';
    model.nowTotal = model.fcTotal = undefined;
    model.nowLabel = 'Now';
    model.fcLabel = 'If FC';
    target.alpha = 0;
    graph.series = graph.xaxis = null;
    graph.dirty = true;
    graph.live = null;
  }
  textDirty = chartDirty = stripDirty = true;
  schedule();
}

// ---------------------------------------------------------------- text
const STATUS = {
  connecting: { tone: 'wait', text: 'connecting' },
  offline: { tone: 'error', text: 'vosu offline' },
  absent: { tone: 'wait', text: 'no game' },
  play: { tone: 'live', text: 'live' },
  results: { tone: 'hold', text: 'result' },
  select: { tone: 'wait', text: 'song select' },
  idle: { tone: 'wait', text: 'idle' },
};
function status() {
  if (model.link === 'connecting') return STATUS.connecting;
  if (model.link === 'offline') return STATUS.offline;
  if (!model.present) return STATUS.absent;
  if (model.phase === 'play') return STATUS.play;
  if (model.phase === 'results') return STATUS.results;
  return model.state === 5 ? STATUS.select : STATUS.idle;
}

function renderText() {
  const { tone, text } = status();
  if (el.status.dataset.tone !== tone) el.status.dataset.tone = tone;
  setText(el.statusText, text);
  setText(el.mods, model.mods);
  if (el.mods.hidden !== !model.mods) el.mods.hidden = !model.mods;
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
  setFlag(panel, 'is-hidden', !model.visible);
}

// ---------------------------------------------------------------- radar
const DASH = [2, 3];
const SOLID = [];
const MONO = '400 10px "IBM Plex Mono", ui-monospace, monospace';
const RADAR_R = 60;
const RADAR_FILL = 0.86;
const COS = new Float64Array(4);
const SIN = new Float64Array(4);

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
  const cy = Math.round(radar.h / 2);
  const R = RADAR_R;
  const px = 0.5 / radar.dpr;
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    COS[i] = Math.cos(angle);
    SIN[i] = Math.sin(angle);
  }

  // Dial: 5° graduations outside the scope, with quarter rings inside.
  ctx.lineWidth = 1 / radar.dpr;
  ctx.strokeStyle = colour.rule;
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
    ctx.strokeStyle = k === 4 ? colour.ruleStrong : colour.rule;
    ctx.beginPath();
    ctx.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = colour.ruleStrong;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = cx + COS[i] * (R + 6);
    const y = cy + SIN[i] * (R + 6);
    ctx.moveTo(Math.abs(COS[i]) < 1e-6 ? cx + px : cx, Math.abs(SIN[i]) < 1e-6 ? cy + px : cy);
    ctx.lineTo(Math.abs(COS[i]) < 1e-6 ? x + px : x, Math.abs(SIN[i]) < 1e-6 ? y + px : y);
  }
  ctx.stroke();

  // Layers: FC projection as a dashed ghost, the live split filled in accent.
  const a = shown.alpha;
  if (a > 0.004 && shown.max > 0) {
    const k = (R * RADAR_FILL) / shown.max;
    if (opts.showFc) {
      polygon(ctx, cx, cy, shown.fc, n, k);
      ctx.globalAlpha = a * 0.08;
      ctx.fillStyle = colour.dim;
      ctx.fill();
      ctx.globalAlpha = a * 0.75;
      ctx.setLineDash(DASH);
      ctx.strokeStyle = colour.dim;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash(SOLID);
    }
    polygon(ctx, cx, cy, shown.now, n, k);
    ctx.globalAlpha = a * 0.2;
    ctx.fillStyle = colour.accent;
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = colour.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = colour.accent;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = shown.now[i] * k;
      const x = cx + COS[i] * r;
      const y = cy + SIN[i] * r;
      ctx.moveTo(x + 2.25, y);
      ctx.arc(x, y, 2.25, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = colour.ruleStrong;
  ctx.fillRect(cx - 1, cy - 1, 2, 2);

  // Axis names sit just past the dial, pushed out by half their width on side axes.
  ctx.font = MONO;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const width = ctx.measureText(AXES[i]).width;
    const d = R + 12 + Math.abs(COS[i]) * (width / 2 - 2);
    ctx.fillStyle = model.components ? colour.dim : colour.muted;
    ctx.fillText(AXES[i], Math.round(cx + COS[i] * d), Math.round(cy + SIN[i] * d) + 0.5);
  }
}

// ---------------------------------------------------------------- bars
const BAR_ROW = 28;
const BAR_H = 6;
const BAR_FILL = 0.94;

function drawBars() {
  if (!bars.w) return;
  const ctx = begin(bars);
  const w = bars.w;
  const px = 1 / bars.dpr;
  const k = shown.max > 0 ? (w * BAR_FILL) / shown.max : 0;
  ctx.lineWidth = px;
  for (let i = 0; i < 4; i++) {
    const mid = i * BAR_ROW + BAR_ROW / 2 + 0.5;
    const top = Math.round(mid - BAR_H / 2);
    const off = i === FL && model.axes === 3;
    // Track with quarter graduations.
    ctx.fillStyle = colour.rule;
    ctx.fillRect(0, top, w, BAR_H);
    ctx.fillStyle = colour.bg;
    for (let q = 1; q < 4; q++) ctx.fillRect(Math.round((w * BAR_FILL * q) / 4), top, px, BAR_H);
    if (off || shown.alpha <= 0.004 || !k) continue;
    const a = shown.alpha;
    if (opts.showFc) {
      const fw = shown.fc[i] * k;
      ctx.globalAlpha = a * 0.28;
      ctx.fillStyle = colour.dim;
      ctx.fillRect(0, top, fw, BAR_H);
      ctx.globalAlpha = a;
      ctx.fillStyle = colour.dim;
      ctx.fillRect(Math.max(0, Math.round(fw) - px), top - 3, px, BAR_H + 6);
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = colour.accent;
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

  // Peak per device column (padding sentinels are negative: read as empty).
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
  const amp = (h / 2 - 3 * strip.dpr) / peak;
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
    textDirty = true;
  }
  const { ctx } = strip;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, strip.w, strip.h);
  if (!graph.aimPath) return;
  const w = strip.w;
  const h = strip.h;
  const line = Math.max(1, Math.round(strip.dpr));
  const head = graph.head;
  if (model.phase === 'play') {
    const split = Math.max(0, Math.min(w, head));
    fillStrip(ctx, 0, split, 0.9);
    fillStrip(ctx, split, w, 0.3);
  } else if (model.phase === 'results') {
    fillStrip(ctx, 0, w, 0.9);
  } else {
    fillStrip(ctx, 0, w, 0.55);
  }
  ctx.fillStyle = colour.ruleStrong;
  ctx.fillRect(0, Math.round(h / 2) - (line >> 1), w, line);
  if (head >= 0 && head <= w && model.phase !== 'results') {
    const x = Math.min(w - line, head);
    ctx.fillStyle = model.phase === 'play' ? colour.accent : colour.muted;
    ctx.fillRect(x, 0, line, h);
    if (model.phase === 'play') ctx.fillRect(x - line, 0, line * 3, line * 2);
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
  setText(el.stripEmpty, model.present ? 'No strain data' : '—');
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
  if (model.visible) {
    if (chartDirty || animating) {
      chartDirty = false;
      if (opts.chartStyle === 'bars') drawBars(); else drawRadar();
    }
    if (stripDirty && opts.showProfile) {
      stripDirty = false;
      drawStrip();
      renderShare();
      if (textDirty) { textDirty = false; renderText(); }
    }
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
  return true;
}
const cssSize = new Map();
const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    cssSize.set(entry.target, entry.contentRect);
  }
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
fit($('stage'), STAGE_W, STAGE_H);

settings({ ...opts }, next => {
  opts.chartStyle = next.chartStyle === 'bars' ? 'bars' : 'radar';
  opts.showFc = next.showFc !== false;
  opts.showProfile = next.showProfile !== false;
  opts.showBrand = next.showBrand !== false;
  if (panel.dataset.style !== opts.chartStyle) panel.dataset.style = opts.chartStyle;
  setFlag(panel, 'no-fc', !opts.showFc);
  setFlag(panel, 'no-profile', !opts.showProfile);
  setFlag(panel, 'no-brand', !opts.showBrand);
  chartDirty = stripDirty = textDirty = true;
  schedule();
});

document.fonts?.ready.then(() => { chartDirty = true; schedule(); });

subscribe(POINTERS, onFrame, { onStatus });

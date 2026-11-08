// Copyright (c) 2026 18-LAB. MIT.
// Strain graph: vosu's /performance/graph rasterised once per map into two offscreen layers
// (lit and dim); each frame only blits them split at the playhead and draws the playhead.
// Frames are requested only when the playhead crosses a device pixel or a readout changes.
import { subscribe, settings, fit, formatDuration } from './vosu-overlay.js';

const STAGE_W = 720;
const STAGE_H = 232;
const P = {
  state: '/state/number',
  checksum: '/beatmap/checksum',
  title: '/beatmap/title',
  version: '/beatmap/version',
  live: '/beatmap/time/live',
  mp3: '/beatmap/time/mp3Length',
  kiai: '/beatmap/isKiai',
  brk: '/beatmap/isBreak',
  // The graph x-axis is map time ÷ the calculation's mod rate; the track rate is only a fallback.
  rate: '/play/mods/rate',
  trackRate: '/beatmap/time/rate',
  series: '/performance/graph/series',
  xaxis: '/performance/graph/xaxis',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const plot = $('plot');
const canvas = $('graph');
const ticksRow = $('ticks');
const legend = $('legend');
const empty = $('empty');
const ctx = canvas.getContext('2d', { alpha: true });

// ---------------------------------------------------------------- colours (tokens, read once)
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => {
  const value = css.getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};
const C = {
  accent: token('--accent', '#ff963f'),
  signal: token('--signal', '#7fa6cf'),
  ok: token('--ok', '#6fbf8e'),
  fg: token('--fg', '#ebe8e1'),
  fgDim: token('--fg-dim', '#b8b5ad'),
  rule: token('--rule-strong', '#3b3f45'),
};
const channels = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgba = (hex, a) => `rgb(${channels(hex).join(' ')} / ${a})`;
const mix = (a, b, t) => '#' + channels(a).map((v, i) => Math.round(v + (channels(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const INK = {
  grid: rgba(C.fg, 0.055),
  dimFill: rgba(C.fg, 0.085),
  dimEdge: rgba(C.fg, 0.3),
  litEdge: mix(C.accent, C.fg, 0.35),
  kiaiWash: rgba(C.accent, 0.075),
  preview: C.fgDim,
  ring: 'rgb(17 18 20 / 0.9)',
};

// vosu series per ruleset (converts included); the first group present wins.
const SKILLS = {
  aim: ['Aim', C.accent], speed: ['Speed', C.signal],
  color: ['Colour', C.accent], rhythm: ['Rhythm', C.signal], stamina: ['Stamina', C.ok],
  movement: ['Movement', C.accent], strains: ['Strain', C.accent],
};
const GROUPS = [['aim', 'speed'], ['color', 'rhythm', 'stamina'], ['movement'], ['strains']];
const FALLBACK = [C.accent, C.signal, C.ok, C.fgDim];

// ---------------------------------------------------------------- state
const opts = { graphHeight: 64, view: 'combined', showTime: true, showMarks: true, showBrand: true };
const view = { phase: null, live: NaN, rate: 1, kiai: false, brk: false, checksum: '', status: 'connecting' };
const graph = { skills: [], end: 0, section: 400, key: '' };
const size = { w: 0, h: 0, cssW: 0, cssH: 0, ratio: 1, lw: 1 };
const drawn = { px: -2, sec: -2 };
const lit = document.createElement('canvas');
const dim = document.createElement('canvas');
const litCtx = lit.getContext('2d');
const dimCtx = dim.getContext('2d');
let hatch = null;
let surface = new Float32Array(0); // silhouette y per device column, for the playhead needle
let latest = null;
let modelDirty = false, rasterDirty = false, metaDirty = true, frameDirty = true, legendDirty = true, axisDirty = false, fadeIn = false;
let ticks = [];
let legendW = 0;
let raf = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const positive = value => (typeof value === 'number' && value > 0 ? value : 0);
const setText = (el, text) => { if (el.$text !== text) { el.$text = text; el.textContent = text; } };
const request = () => { if (!raf) raf = requestAnimationFrame(frame); };

// ---------------------------------------------------------------- kiai / break sections
// vosu exposes only the live isKiai/isBreak flags, so sections are learned as the map clock
// passes them (gameplay or the song-select preview) and remembered per beatmap checksum.
const STORE = 'strain-graph:marks:';
const marks = { key: '', kiai: [], brk: [], runKiai: null, runBrk: null, prevKiai: false, prevBrk: false, prevT: NaN };

function settle(list) {
  list.sort((a, b) => a[0] - b[0]);
  let out = 0;
  for (const run of list) {
    const last = list[out - 1];
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
  marks.prevT = NaN;
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
    else { run = [marks.prevT, t]; list.push(run); }
    return run;
  }
  if (run) { settle(list); saveMarks(); }
  return null;
}

function observe(key, t, kiai, brk) {
  if (key !== marks.key) loadMarks(key);
  // A flag counts once two consecutive, contiguous samples agree: a stale flag from the
  // previous map or a seek never paints a section.
  const contiguous = t >= marks.prevT && t - marks.prevT < 1500;
  marks.runKiai = track(marks.kiai, marks.runKiai, kiai && marks.prevKiai && contiguous, t);
  marks.runBrk = track(marks.brk, marks.runBrk, brk && marks.prevBrk && contiguous, t);
  marks.prevKiai = kiai;
  marks.prevBrk = brk;
  marks.prevT = t;
}

// ---------------------------------------------------------------- data
function phaseOf(state) {
  if (typeof state !== 'number') return null;
  return state === 2 ? 'play' : state === 7 ? 'results' : 'preview';
}

/** Graph time (ms after rate) the readouts show; NaN when unknown. */
function shownTime() {
  if (!graph.end) return NaN;
  if (view.phase === 'results') return graph.end;
  return Number.isFinite(view.live) ? clamp(view.live / view.rate, 0, graph.end) : NaN;
}

function playheadPx() {
  const t = shownTime();
  return Number.isFinite(t) && size.w ? Math.round(t / graph.end * size.w) : -1;
}

function onData(values, changed) {
  latest = values;
  let want = false;
  const phase = phaseOf(values[P.state]);
  if (phase !== view.phase) { view.phase = phase; metaDirty = frameDirty = want = true; }
  const rate = positive(values[P.rate]) || positive(values[P.trackRate]) || 1;
  if (rate !== view.rate) { view.rate = rate; modelDirty = true; }
  if (changed.has(P.series) || changed.has(P.xaxis) || changed.has(P.mp3) || changed.has(P.checksum)) modelDirty = true;
  if (changed.has(P.title) || changed.has(P.version)) metaDirty = true;
  if (modelDirty || metaDirty) want = true;
  const checksum = typeof values[P.checksum] === 'string' ? values[P.checksum] : '';
  view.checksum = checksum;
  const live = values[P.live];
  view.live = typeof live === 'number' ? live : NaN;
  const kiai = values[P.kiai] === true;
  const brk = values[P.brk] === true;
  if (kiai !== view.kiai || brk !== view.brk) { view.kiai = kiai; view.brk = brk; metaDirty = want = true; }
  if (phase && checksum && Number.isFinite(view.live) && (changed.has(P.live) || changed.has(P.kiai) || changed.has(P.brk))) {
    observe(checksum, view.live, kiai, brk);
  }
  if (!want && graph.end) {
    const t = shownTime();
    want = playheadPx() !== drawn.px || (Number.isFinite(t) ? Math.floor(t / 1000) : -1) !== drawn.sec;
  }
  if (want) request();
}

function onStatus(state) {
  if (state === view.status) return;
  view.status = state;
  metaDirty = true;
  request();
}

// ---------------------------------------------------------------- model
function pickSkills(series) {
  const byName = new Map();
  for (const entry of series) if (entry && typeof entry.name === 'string' && Array.isArray(entry.data)) byName.set(entry.name, entry);
  for (const group of GROUPS) {
    const found = group.filter(name => byName.has(name));
    if (found.length) return found.map(name => ({ name, label: SKILLS[name][0], color: SKILLS[name][1], data: byName.get(name).data }));
  }
  return [...byName.values()].slice(0, 4).map((entry, i) => ({ name: entry.name, label: entry.name, color: FALLBACK[i], data: entry.data }));
}

function buildModel() {
  modelDirty = false;
  rasterDirty = legendDirty = frameDirty = true;
  const previous = graph.key;
  graph.skills = [];
  graph.end = 0;
  graph.key = view.checksum;
  const series = latest?.[P.series];
  const xaxis = latest?.[P.xaxis];
  if (!Array.isArray(series) || !Array.isArray(xaxis) || !xaxis.length) return;
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
    skill.xs = Float64Array.from(order, i => xaxis[i] + section / 2);
    skill.vs = Float64Array.from(order, i => skill.data[i]);
    skill.data = null;
    if (order.length) any = true;
    graph.skills.push(skill);
  }
  if (!any) { graph.skills = []; return; }
  const mp3 = latest[P.mp3];
  graph.end = Math.max(lastX + section, typeof mp3 === 'number' && mp3 > 0 ? mp3 / view.rate : 0);
  graph.section = section;
  if (previous !== graph.key) fadeIn = true;
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
  for (const step of [10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1200e3]) if (step * cssPerMs >= 72) return step;
  return 1800e3;
}

function computeTicks() {
  ticks = [];
  axisDirty = true;
  if (!graph.end || !size.cssW) return;
  const cssPerMs = size.cssW / graph.end;
  const step = tickStep(cssPerMs);
  for (let t = 0; t * cssPerMs <= size.cssW - 30; t += step) ticks.push(t);
}

function writeAxis() {
  axisDirty = false;
  ticksRow.replaceChildren();
  if (!graph.skills.length || !size.cssW) return;
  // Labels stop short of the right edge, and of the legend when it shares the row.
  const limit = size.cssW - (legendW ? legendW + 36 : 30);
  for (const t of ticks) {
    if (t && (t / graph.end) * size.cssW > limit) break;
    const label = document.createElement('span');
    label.textContent = formatDuration(t);
    label.style.left = `${(t / graph.end) * 100}%`;
    ticksRow.append(label);
  }
}

function makeHatch() {
  const s = Math.max(4, Math.round(6 * size.ratio));
  const tile = document.createElement('canvas');
  tile.width = tile.height = s;
  const c = tile.getContext('2d');
  c.strokeStyle = rgba(C.fg, 0.11);
  c.lineWidth = size.lw;
  c.beginPath();
  c.moveTo(-1, s + 1); c.lineTo(s + 1, -1);
  c.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
}

function raster() {
  rasterDirty = false;
  frameDirty = true;
  const { w, h, lw } = size;
  if (lit.width !== w || lit.height !== h) { lit.width = dim.width = w; lit.height = dim.height = h; }
  litCtx.clearRect(0, 0, w, h);
  dimCtx.clearRect(0, 0, w, h);
  computeTicks();
  if (!graph.skills.length || !w || !h) return;

  const k = w / graph.end;
  const sigma = Math.max(0.9 * size.ratio, 0.7 * graph.section * k);
  const raw = new Float32Array(w);
  const levels = [new Float32Array(w)];
  for (const skill of graph.skills) {
    resample(skill.xs, skill.vs, k, raw);
    const level = new Float32Array(w);
    blur(raw, level, sigma);
    const below = levels[levels.length - 1];
    for (let c = 0; c < w; c++) level[c] += below[c];
    levels.push(level);
  }
  const top = levels[levels.length - 1];
  let peak = 0;
  for (let c = 0; c < w; c++) if (top[c] > peak) peak = top[c];
  const floor = h - lw;
  const ceiling = Math.round(7 * size.ratio);
  const scale = peak > 0 ? (floor - ceiling) / peak : 0;
  const Y = v => floor - v * scale;
  surface = Float32Array.from(top, Y);

  const outline = (c, upper) => {
    c.moveTo(0, Y(upper[0]));
    for (let x = 0; x < w; x++) c.lineTo(x + 0.5, Y(upper[x]));
    c.lineTo(w, Y(upper[w - 1]));
  };
  const area = (c, lower, upper) => {
    c.beginPath();
    outline(c, upper);
    c.lineTo(w, Y(lower[w - 1]));
    for (let x = w - 1; x >= 0; x--) c.lineTo(x + 0.5, Y(lower[x]));
    c.lineTo(0, Y(lower[0]));
    c.closePath();
  };
  const edge = (c, upper, style) => {
    c.beginPath();
    outline(c, upper);
    c.strokeStyle = style;
    c.lineWidth = lw;
    c.lineJoin = 'round';
    c.stroke();
  };

  for (const [c, isLit] of [[litCtx, true], [dimCtx, false]]) {
    c.fillStyle = INK.grid;
    for (const t of ticks) if (t > 0) c.fillRect(Math.round(t * k), 0, lw, floor);
    if (opts.view === 'per-skill' && graph.skills.length > 1) {
      graph.skills.forEach((skill, i) => {
        area(c, levels[i], levels[i + 1]);
        c.fillStyle = rgba(skill.color, isLit ? 0.62 : 0.14);
        c.fill();
      });
      graph.skills.forEach((skill, i) => edge(c, levels[i + 1], isLit ? skill.color : rgba(skill.color, 0.4)));
    } else {
      area(c, levels[0], top);
      if (isLit) {
        const fill = c.createLinearGradient(0, ceiling, 0, floor);
        fill.addColorStop(0, rgba(C.accent, 0.78));
        fill.addColorStop(1, rgba(C.accent, 0.22));
        c.fillStyle = fill;
      } else c.fillStyle = INK.dimFill;
      c.fill();
      edge(c, top, isLit ? INK.litEdge : INK.dimEdge);
    }
    c.fillStyle = C.rule;
    c.fillRect(0, floor, w, lw);
  }
}

// ---------------------------------------------------------------- frame
function runs(list, k, y, height) {
  for (let i = 0; i < list.length; i++) {
    const x0 = Math.round(list[i][0] * k), x1 = Math.round(list[i][1] * k);
    if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, height);
  }
}

function writeMeta() {
  metaDirty = false;
  const values = latest || {};
  const title = typeof values[P.title] === 'string' && values[P.title] ? values[P.title] : '—';
  setText($('title'), view.phase ? title : '—');
  setText(empty, !view.phase && view.status === 'live' ? 'osu! not running' : '—');
  setText($('version'), view.phase && typeof values[P.version] === 'string' ? values[P.version] : '');
  setText($('phase'), view.phase === 'play' ? 'Live' : view.phase === 'preview' ? 'Preview' : view.phase === 'results' ? 'Final' : '');
  if (panel.dataset.phase !== (view.phase || 'none')) panel.dataset.phase = view.phase || 'none';
  $('kiai').classList.toggle('on', view.kiai && !!view.phase);
  $('break').classList.toggle('on', view.brk && !!view.phase);
  const status = $('status');
  status.hidden = view.status === 'live';
  if (status.dataset.state !== view.status) status.dataset.state = view.status;
  setText($('statusText'), view.status === 'offline' ? 'vosu offline' : 'Connecting…');
}

function writeLegend() {
  legendDirty = false;
  legend.replaceChildren();
  const show = opts.view === 'per-skill' && graph.skills.length > 1;
  panel.dataset.legend = show ? 'on' : 'off';
  if (!show) return;
  for (const skill of graph.skills) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.setProperty('--c', skill.color);
    item.append(swatch, skill.label);
    legend.append(item);
  }
}

function frame() {
  raf = 0;
  if (modelDirty) buildModel();
  if (rasterDirty) raster();
  if (legendDirty) writeLegend();
  if (axisDirty) writeAxis();
  if (metaDirty) writeMeta();

  const { w, h, lw } = size;
  const hasGraph = graph.skills.length > 0 && w > 0;
  if (empty.hidden !== hasGraph) empty.hidden = hasGraph;
  const px = hasGraph ? playheadPx() : -1;
  const t = shownTime();
  const sec = Number.isFinite(t) && hasGraph ? Math.floor(t / 1000) : -1;
  if (sec !== drawn.sec || frameDirty) {
    setText($('now'), sec >= 0 ? formatDuration(sec * 1000) : view.phase ? '—' : '');
    setText($('total'), hasGraph ? `/ ${formatDuration(graph.end)}` : '');
  }
  drawn.sec = sec;
  if (px === drawn.px && !frameDirty) return;
  drawn.px = px;
  frameDirty = false;

  ctx.clearRect(0, 0, w, h);
  if (!hasGraph) return;
  const phase = view.phase;
  const floor = h - lw;
  const k = w / (graph.end * view.rate); // map ms → device px
  const sameMap = marks.key === graph.key && opts.showMarks;
  if (sameMap) {
    ctx.fillStyle = hatch;
    runs(marks.brk, k, 0, floor);
    ctx.fillStyle = INK.kiaiWash;
    runs(marks.kiai, k, 0, floor);
  }
  if (phase === 'play' && px >= 0) {
    if (px > 0) ctx.drawImage(lit, 0, 0, px, h, 0, 0, px, h);
    if (px < w) ctx.drawImage(dim, px, 0, w - px, h, px, 0, w - px, h);
  } else if (phase) ctx.drawImage(lit, 0, 0);
  else ctx.drawImage(dim, 0, 0);
  if (sameMap) {
    ctx.fillStyle = C.accent;
    runs(marks.kiai, k, 0, 2 * lw);
  }
  if ((phase === 'play' || phase === 'preview') && px >= 0) {
    const x = Math.min(px, w - lw);
    if (phase === 'play') {
      ctx.fillStyle = C.accent;
      ctx.fillRect(0, floor, x, lw);
    }
    ctx.fillStyle = phase === 'play' ? C.fg : INK.preview;
    ctx.fillRect(x, 0, lw, floor);
    // Needle: where the playhead meets the strain silhouette.
    ctx.beginPath();
    ctx.arc(x + lw / 2, surface[Math.min(px, w - 1)], 2.5 * size.ratio, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK.ring;
    ctx.stroke();
  }
  if (fadeIn) {
    fadeIn = false;
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' });
  }
}

// ---------------------------------------------------------------- sizing
function stageScale() {
  return Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H) || 1;
}

function resize(cssW, cssH) {
  const ratio = (devicePixelRatio || 1) * stageScale();
  const w = Math.max(0, Math.round(cssW * ratio));
  const h = Math.max(0, Math.round(cssH * ratio));
  if (w === size.w && h === size.h && cssW === size.cssW && ratio === size.ratio) return;
  const lwChanged = Math.max(1, Math.round(ratio)) !== size.lw || !hatch;
  Object.assign(size, { w, h, cssW, cssH, ratio, lw: Math.max(1, Math.round(ratio)) });
  canvas.width = w;
  canvas.height = h;
  if (lwChanged) makeHatch();
  rasterDirty = frameDirty = true;
  request();
}

new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  resize(box.width, box.height);
}).observe(plot);
new ResizeObserver(entries => {
  const width = Math.ceil(entries[entries.length - 1].contentRect.width);
  if (width === legendW) return;
  legendW = width;
  axisDirty = true;
  request();
}).observe(legend);
addEventListener('resize', () => resize(size.cssW, size.cssH));
fit(stage, STAGE_W, STAGE_H);

// ---------------------------------------------------------------- settings + subscription
settings({ ...opts }, s => {
  const height = Number.isFinite(s.graphHeight) ? clamp(Math.round(s.graphHeight), 40, 160) : 64;
  panel.style.setProperty('--graph-h', `${height}px`);
  const viewMode = s.view === 'per-skill' ? 'per-skill' : 'combined';
  if (viewMode !== opts.view) { opts.view = viewMode; rasterDirty = legendDirty = true; }
  opts.graphHeight = height;
  opts.showTime = !!s.showTime;
  opts.showMarks = !!s.showMarks;
  opts.showBrand = !!s.showBrand;
  panel.dataset.time = opts.showTime ? 'on' : 'off';
  panel.dataset.marks = opts.showMarks ? 'on' : 'off';
  $('brand').hidden = !opts.showBrand;
  frameDirty = true;
  request();
});

subscribe(Object.values(P), onData, { onStatus });

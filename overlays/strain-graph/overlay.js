// Copyright (c) 2026 18-LAB. MIT.
// Strain graph: vosu's /performance/graph rasterised once per map into two offscreen layers
// (lit and dim); each frame only blits them split at the playhead and draws the playhead.
// Frames are requested only when the playhead crosses a device pixel or a readout changes.
// The page is the overlay's box (hosts place and size it): a wide box draws time left→right,
// a tall box draws time running upward (the mania side strip).
import { subscribe, settings, formatDuration, mapPalette, applyPalette } from './vosu-overlay.js';

const P = {
  state: '/state/number',
  checksum: '/beatmap/checksum',
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
/** Thickness (css px across the time axis) the type scale is designed for: --s = 1. */
const BASE = 112;

const $ = id => document.getElementById(id);
const widget = $('w');
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
};
const channels = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgba = (hex, a) => `rgb(${channels(hex).join(' ')} / ${a})`;
const mix = (a, b, t) => '#' + channels(a).map((v, i) => Math.round(v + (channels(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const SHADOW = 'rgb(0 0 0 / 0.55)';
// Map-tinted inks; rebuilt (with a re-raster) only when the tint changes.
const INK = { tint: '', grid: rgba(C.fg, 0.08), dimFill: rgba(C.fg, 0.13), dimEdge: rgba(C.fg, 0.6), litEdge: '', kiaiWash: '', preview: C.fgDim, ring: 'rgb(17 18 20 / 0.9)' };
function setTint(hex) {
  if (hex === INK.tint) return false;
  INK.tint = hex;
  INK.litEdge = mix(hex, C.fg, 0.35);
  INK.kiaiWash = rgba(hex, 0.09);
  return true;
}
setTint(C.accent);

// vosu series per ruleset (converts included); the first group present wins. Slot 0 takes the tint.
const SKILLS = {
  aim: ['Aim', 0], speed: ['Speed', 1],
  color: ['Colour', 0], rhythm: ['Rhythm', 1], stamina: ['Stamina', 2],
  movement: ['Movement', 0], strains: ['Strain', 0],
};
const GROUPS = [['aim', 'speed'], ['color', 'rhythm', 'stamina'], ['movement'], ['strains']];
const skillColor = slot => (slot === 0 ? INK.tint : [C.accent, C.signal, C.ok, C.fgDim][slot]);

// ---------------------------------------------------------------- state
const opts = { orientation: 'auto', align: 'left', view: 'combined', showTime: true, showMarks: true, showInSelect: true, backing: 'none', accent: 'map' };
const view = { phase: null, live: NaN, rate: 1, kiai: false, brk: false, checksum: '', status: 'connecting', show: 'status' };
// skills empty but end > 0: no strain data (e.g. the replay renderer), the strip is a plain progress track.
const graph = { skills: [], end: 0, section: 400, key: '' };
// Device-pixel geometry. u runs along time (0..L), v across it (0 = peak side, T = baseline).
const size = { w: 0, h: 0, cssW: 0, cssH: 0, cssL: 0, ratio: 1, lw: 1, L: 0, T: 0 };
const geo = { vertical: false, align: 'left', m: [1, 0, 0, 1, 0, 0] };
const drawn = { px: -2, sec: -2 };
const lit = document.createElement('canvas');
const dim = document.createElement('canvas');
const litCtx = lit.getContext('2d');
const dimCtx = dim.getContext('2d');
let hatch = null;
let surface = new Float32Array(0); // silhouette v per u column, for the playhead needle
let latest = null;
let palette = null;
let modelDirty = false, rasterDirty = false, metaDirty = true, frameDirty = true, legendDirty = true, axisDirty = false, fadeIn = false;
let ticks = [];
let legendW = 0;
let raf = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const positive = value => (typeof value === 'number' && value > 0 ? value : 0);
const setText = (el, text) => { if (el.$text !== text) { el.$text = text; el.textContent = text; } };
const setData = (el, key, value) => { if (el.dataset[key] !== value) el.dataset[key] = value; };
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
/** play (2, incl. replay/spectate) | select (5) | results (7) | menu (anything else) | null. */
function phaseOf(state) {
  if (typeof state !== 'number') return null;
  return state === 2 ? 'play' : state === 5 ? 'select' : state === 7 ? 'results' : 'menu';
}

/** Graph time (ms after rate) the readouts show; NaN when unknown. */
function shownTime() {
  if (!graph.end || !Number.isFinite(view.live)) return NaN;
  return clamp(view.live / view.rate, 0, graph.end);
}

function playheadPx() {
  const t = shownTime();
  return Number.isFinite(t) && size.L ? Math.round(t / graph.end * size.L) : -1;
}

/** on | status (tiny connection / no-osu! chip) | off. Gameplay first; song select only previews. */
function visibility() {
  if (view.status !== 'live' || !view.phase) return 'status';
  if (view.phase === 'play') return 'on';
  if (view.phase === 'select' && opts.showInSelect && graph.skills.length) return 'on';
  return 'off';
}

function loadPalette(checksum) {
  if (opts.accent !== 'map' || !checksum) { palette = null; applyColors(); return; }
  mapPalette(checksum).then(result => {
    if (checksum !== view.checksum) return;
    palette = result;
    applyColors();
  });
}

function applyColors() {
  applyPalette(widget, opts.accent === 'map' ? palette : null);
  setData(widget, 'accent', opts.accent === 'map' ? 'map' : '18-lab');
  const tint = opts.accent === 'map' && palette?.accent ? palette.accent : C.accent;
  if (setTint(tint)) { rasterDirty = legendDirty = frameDirty = true; request(); }
}

function onData(values, changed) {
  latest = values;
  let want = false;
  const phase = phaseOf(values[P.state]);
  if (phase !== view.phase) { view.phase = phase; metaDirty = frameDirty = want = true; }
  const rate = positive(values[P.rate]) || positive(values[P.trackRate]) || 1;
  if (rate !== view.rate) { view.rate = rate; modelDirty = true; }
  if (changed.has(P.series) || changed.has(P.xaxis) || changed.has(P.mp3) || changed.has(P.checksum)) modelDirty = true;
  if (modelDirty) want = true;
  const checksum = typeof values[P.checksum] === 'string' ? values[P.checksum] : '';
  if (checksum !== view.checksum) { view.checksum = checksum; loadPalette(checksum); }
  const live = values[P.live];
  view.live = typeof live === 'number' ? live : NaN;
  const kiai = values[P.kiai] === true;
  const brk = values[P.brk] === true;
  if (kiai !== view.kiai || brk !== view.brk) { view.kiai = kiai; view.brk = brk; metaDirty = want = true; }
  if (phase && checksum && Number.isFinite(view.live) && (changed.has(P.live) || changed.has(P.kiai) || changed.has(P.brk))) {
    observe(checksum, view.live, kiai, brk);
  }
  if (!want && graph.end && view.show === 'on') {
    const t = shownTime();
    want = playheadPx() !== drawn.px || (Number.isFinite(t) ? Math.floor(t / 1000) : -1) !== drawn.sec;
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
// orientation setting pins one; type and chrome scale with the box's thickness (--s).
function layoutBox() {
  const W = innerWidth, H = innerHeight;
  const vertical = opts.orientation === 'vertical' || (opts.orientation === 'auto' && H > W * 1.25);
  const thickness = vertical ? W : H;
  widget.style.setProperty('--s', clamp(thickness / BASE, 0.6, 1.6).toFixed(3));
  setData(widget, 'orient', vertical ? 'v' : 'h');
  setData(widget, 'align', opts.align);
  // Below ~3/4 of the default thickness the time axis and legend give their room to the graph.
  setData(widget, 'compact', thickness < BASE * 0.75 ? 'on' : 'off');
  if (geo.vertical !== vertical || geo.align !== opts.align) {
    geo.vertical = vertical;
    geo.align = opts.align;
    hatch = null;
    resize(size.cssW, size.cssH, true);
  }
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
  graph.end = 0;
  graph.key = view.checksum;
  const mp3 = latest?.[P.mp3];
  const audioEnd = typeof mp3 === 'number' && mp3 > 0 ? mp3 / view.rate : 0;
  const series = latest?.[P.series];
  const xaxis = latest?.[P.xaxis];
  if (!Array.isArray(series) || !Array.isArray(xaxis) || !xaxis.length) { graph.end = audioEnd; return; }
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
  if (!any) { graph.skills = []; graph.end = audioEnd; return; }
  graph.end = Math.max(lastX + section, audioEnd);
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
  for (const step of [10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1200e3]) if (step * cssPerMs >= 96) return step;
  return 1800e3;
}

function computeTicks() {
  ticks = [];
  axisDirty = true;
  if (!graph.end || !size.cssL) return;
  const cssPerMs = size.cssL / graph.end;
  const step = tickStep(cssPerMs);
  for (let t = 0; t * cssPerMs <= size.cssL - 30; t += step) ticks.push(t);
}

function writeAxis() {
  axisDirty = false;
  ticksRow.replaceChildren();
  if (!graph.end || !size.cssL) return;
  // Labels stop short of the far end, and of the legend when it shares the row.
  const limit = size.cssL - (legendW && !geo.vertical ? legendW + 36 : 30);
  const flip = !geo.vertical && opts.align === 'right' && legendW;
  for (const t of ticks) {
    const at = (t / graph.end) * size.cssL;
    if (flip ? at < legendW + 36 || (t && at > size.cssL - 30) : t && at > limit) continue;
    const label = document.createElement('span');
    label.textContent = formatDuration(t);
    if (!t) label.className = 'zero';
    label.style[geo.vertical ? 'bottom' : 'left'] = `${(t / graph.end) * 100}%`;
    ticksRow.append(label);
  }
}

function makeHatch() {
  const s = Math.max(4, Math.round(6 * size.ratio));
  const tile = document.createElement('canvas');
  tile.width = tile.height = s;
  const c = tile.getContext('2d');
  c.strokeStyle = rgba(C.fg, 0.16);
  c.lineWidth = size.lw;
  c.beginPath();
  c.moveTo(-1, s + 1); c.lineTo(s + 1, -1);
  c.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
}

function raster() {
  rasterDirty = false;
  frameDirty = true;
  const { w, h, lw, L, T } = size;
  if (lit.width !== w || lit.height !== h) { lit.width = dim.width = w; lit.height = dim.height = h; }
  for (const c of [litCtx, dimCtx]) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, w, h); }
  computeTicks();
  if (!graph.end || !L || !T) { surface = new Float32Array(0); return; }

  const k = L / graph.end;
  const floor = T - lw;
  const shade = (c, on) => {
    c.shadowColor = on ? SHADOW : 'transparent';
    c.shadowBlur = on ? 3 * size.ratio : 0;
    c.shadowOffsetX = 0;
    c.shadowOffsetY = on ? size.ratio : 0;
  };
  const [a, b, cc, d, e, f] = geo.m;
  const levels = [new Float32Array(L)];
  let scale = 0;
  const ceiling = Math.round(7 * size.ratio);
  if (graph.skills.length) {
    const sigma = Math.max(0.9 * size.ratio, 0.7 * graph.section * k);
    const raw = new Float32Array(L);
    for (const skill of graph.skills) {
      resample(skill.xs, skill.vs, k, raw);
      const level = new Float32Array(L);
      blur(raw, level, sigma);
      const below = levels[levels.length - 1];
      for (let c = 0; c < L; c++) level[c] += below[c];
      levels.push(level);
    }
    let peak = 0;
    for (const value of levels[levels.length - 1]) if (value > peak) peak = value;
    scale = peak > 0 ? (floor - ceiling) / peak : 0;
  }
  const top = levels[levels.length - 1];
  const V = value => floor - value * scale;
  surface = Float32Array.from(top, V);

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
  // Edges carry a contact shadow so the silhouette reads over bright map backgrounds too.
  const edge = (c, upper, style) => {
    c.beginPath();
    outline(c, upper);
    c.strokeStyle = style;
    c.lineWidth = lw;
    c.lineJoin = 'round';
    shade(c, true);
    c.stroke();
    shade(c, false);
  };

  for (const [c, isLit] of [[litCtx, true], [dimCtx, false]]) {
    c.setTransform(a, b, cc, d, e, f);
    c.fillStyle = INK.grid;
    for (const t of ticks) if (t > 0) c.fillRect(Math.round(t * k), graph.skills.length ? 0 : floor - 6 * lw, lw, graph.skills.length ? floor : 6 * lw);
    if (!graph.skills.length) {
      // No strain data: a progress track only (lit part a touch heavier).
      shade(c, true);
      c.fillStyle = isLit ? INK.tint : rgba(C.fg, 0.45);
      c.fillRect(0, isLit ? floor - lw : floor, L, isLit ? 2 * lw : lw);
      shade(c, false);
      continue;
    }
    if (opts.view === 'per-skill' && graph.skills.length > 1) {
      graph.skills.forEach((skill, i) => {
        area(c, levels[i], levels[i + 1]);
        c.fillStyle = rgba(skillColor(skill.slot), isLit ? 0.66 : 0.18);
        c.fill();
      });
      graph.skills.forEach((skill, i) => edge(c, levels[i + 1], isLit ? skillColor(skill.slot) : rgba(skillColor(skill.slot), 0.6)));
    } else {
      area(c, levels[0], top);
      if (isLit) {
        const fill = c.createLinearGradient(0, ceiling, 0, floor);
        fill.addColorStop(0, rgba(INK.tint, 0.85));
        fill.addColorStop(1, rgba(INK.tint, 0.3));
        c.fillStyle = fill;
      } else c.fillStyle = INK.dimFill;
      c.fill();
      edge(c, top, isLit ? INK.litEdge : INK.dimEdge);
    }
    c.fillStyle = isLit ? rgba(INK.tint, 0.9) : rgba(C.fg, 0.45);
    shade(c, true);
    c.fillRect(0, floor, L, lw);
    shade(c, false);
  }
}

// ---------------------------------------------------------------- frame
function runs(list, k, v, thickness) {
  for (let i = 0; i < list.length; i++) {
    const u0 = Math.round(list[i][0] * k), u1 = Math.round(list[i][1] * k);
    if (u1 > u0) ctx.fillRect(u0, v, u1 - u0, thickness);
  }
}

/** Copies the u-range [u0,u1) of a layer (device orientation) into the visible canvas. */
function blit(layer, u0, u1) {
  if (u1 <= u0) return;
  const { L, T } = size;
  if (geo.vertical) ctx.drawImage(layer, 0, L - u1, T, u1 - u0, 0, L - u1, T, u1 - u0);
  else ctx.drawImage(layer, u0, 0, u1 - u0, T, u0, 0, u1 - u0, T);
}

function writeMeta() {
  metaDirty = false;
  const show = visibility();
  if (show !== view.show) { view.show = show; frameDirty = true; }
  setData(widget, 'show', show);
  setData(widget, 'phase', view.phase || 'none');
  setText($('phase'), view.phase === 'select' ? 'Preview' : '');
  $('kiai').classList.toggle('on', view.kiai);
  $('break').classList.toggle('on', view.brk && !view.kiai);
  const status = $('status');
  status.hidden = show !== 'status';
  setData(status, 'state', view.status === 'live' ? 'idle' : view.status);
  setText($('statusText'), view.status === 'offline' ? 'vosu offline' : view.status === 'live' ? 'osu! not running' : 'Connecting…');
}

function writeLegend() {
  legendDirty = false;
  legend.replaceChildren();
  const show = opts.view === 'per-skill' && graph.skills.length > 1;
  setData(widget, 'legend', show ? 'on' : 'off');
  if (!show) return;
  for (const skill of graph.skills) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.setProperty('--c', skillColor(skill.slot));
    item.append(swatch, skill.label);
    legend.append(item);
  }
}

function frame() {
  raf = 0;
  if (modelDirty) buildModel();
  if (metaDirty) writeMeta();
  if (view.show !== 'on') return;
  if (!hatch && size.lw) makeHatch();
  if (rasterDirty) raster();
  if (legendDirty) writeLegend();
  if (axisDirty) writeAxis();

  const { w, h, lw, L } = size;
  const hasTrack = graph.end > 0 && L > 0;
  if (empty.hidden !== hasTrack) empty.hidden = hasTrack;
  const px = hasTrack ? playheadPx() : -1;
  const t = shownTime();
  const sec = Number.isFinite(t) && hasTrack ? Math.floor(t / 1000) : -1;
  if (sec !== drawn.sec || frameDirty) {
    setText($('now'), sec >= 0 ? formatDuration(sec * 1000) : '—');
    setText($('total'), hasTrack ? `/ ${formatDuration(graph.end)}` : '');
  }
  drawn.sec = sec;
  if (px === drawn.px && !frameDirty) return;
  drawn.px = px;
  frameDirty = false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!hasTrack) return;
  const play = view.phase === 'play';
  const floor = size.T - lw;
  const k = L / (graph.end * view.rate); // map ms → device px along time
  const marksOn = marks.key === graph.key && opts.showMarks;
  const [a, b, c, d, e, f] = geo.m;
  ctx.setTransform(a, b, c, d, e, f);
  if (marksOn) {
    ctx.fillStyle = hatch;
    runs(marks.brk, k, 0, floor);
    ctx.fillStyle = INK.kiaiWash;
    runs(marks.kiai, k, 0, floor);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (play && px >= 0) {
    blit(lit, 0, px);
    blit(dim, px, L);
  } else ctx.drawImage(lit, 0, 0);
  ctx.setTransform(a, b, c, d, e, f);
  if (marksOn) {
    ctx.fillStyle = INK.tint;
    runs(marks.kiai, k, 0, 2 * lw);
  }
  if (px >= 0) {
    const u = Math.min(px, L - lw);
    ctx.fillStyle = play ? C.fg : INK.preview;
    ctx.fillRect(u, 0, lw, floor);
    // Needle: where the playhead meets the strain silhouette.
    ctx.beginPath();
    ctx.arc(u + lw / 2, surface[Math.min(px, L - 1)], 2.5 * size.ratio, 0, Math.PI * 2);
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
function resize(cssW, cssH, force = false) {
  const ratio = devicePixelRatio || 1;
  const w = Math.max(0, Math.round(cssW * ratio));
  const h = Math.max(0, Math.round(cssH * ratio));
  if (!force && w === size.w && h === size.h && cssW === size.cssW && cssH === size.cssH && ratio === size.ratio) return;
  const lw = Math.max(1, Math.round(ratio));
  if (lw !== size.lw || ratio !== size.ratio) hatch = null;
  const L = geo.vertical ? h : w;
  const T = geo.vertical ? w : h;
  Object.assign(size, { w, h, cssW, cssH, cssL: geo.vertical ? cssH : cssW, ratio, lw, L, T });
  // u along time, v across (v = T is the baseline: left for align left, right for align right).
  geo.m = !geo.vertical ? [1, 0, 0, 1, 0, 0] : geo.align === 'right' ? [0, -1, 1, 0, 0, L] : [0, -1, -1, 0, T, L];
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
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
addEventListener('resize', layoutBox);

// ---------------------------------------------------------------- settings + subscription
settings({ ...opts }, s => {
  opts.orientation = ['horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = s.align === 'right' ? 'right' : 'left';
  const viewMode = s.view === 'per-skill' ? 'per-skill' : 'combined';
  if (viewMode !== opts.view) { opts.view = viewMode; rasterDirty = legendDirty = true; }
  opts.showTime = !!s.showTime;
  opts.showMarks = !!s.showMarks;
  opts.showInSelect = !!s.showInSelect;
  opts.backing = ['scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  const accent = s.accent === '18-lab' ? '18-lab' : 'map';
  const accentChanged = accent !== opts.accent;
  opts.accent = accent;
  setData(widget, 'time', opts.showTime ? 'on' : 'off');
  setData(widget, 'marks', opts.showMarks ? 'on' : 'off');
  setData(widget, 'backing', opts.backing);
  layoutBox();
  if (accentChanged) loadPalette(view.checksum);
  else applyColors();
  metaDirty = frameDirty = axisDirty = true;
  request();
});

subscribe(Object.values(P), onData, { onStatus });

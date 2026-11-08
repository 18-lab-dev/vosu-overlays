// Copyright (c) 2026 18-LAB. MIT.
// Hit error bar: judgement-window ladder, fading per-hit ticks, a moving-average marker and a
// live distribution, with an optional osu!mania press/release split. It floats in the space osu!
// leaves empty for the ruleset (osuLayout) and holds the attempt on stable's results screen.
import { subscribe, settings, fit, activeMode, isPlaying, osuLayout, maniaSkin, mapPalette, applyPalette, MODE_LABELS } from './vosu-overlay.js';

const RESULTS = 7;
const SONG_SELECT = 5;
const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  client: '/client',
  checksum: '/beatmap/checksum',
  keys: '/beatmap/stats/cs/converted',
  skin: '/settings/skin/name',
  windows: '/beatmap/stats/hitWindow',
  holds: '/beatmap/stats/objects/holds',
  all: '/play/hitErrorArray',
  press: '/play/pressHitErrors',
  release: '/play/releaseHitErrors',
};

const DEFAULTS = {
  zone: 'auto',
  offsetX: 0,
  offsetY: 0,
  size: 1,
  width: 0,
  orientation: 'horizontal',
  backing: 'none',
  accent: 'map',
  lifetime: 4,
  range: 'judgement windows',
  showUr: true,
  showMean: true,
  showEarlyLate: true,
  showDistribution: true,
  releaseRow: 'auto',
  results: 'osu!stable only',
  songSelect: true,
  columnStart: 0,
  columnWidth: 0,
  showBrand: true,
};

// Default zone per ruleset: osu! the band right of the playfield (under the key counter), mania
// beside the stage on the left, taiko the empty area under the lane.
const AUTO_ZONE = { osu: 'right', mania: 'left', taiko: 'below' };
const SCREEN_W = 1920;
const SCREEN_H = 1080;
const MARGIN = 16;
const PANEL_CHROME = 26; // panel padding + borders around the bar

// Judgement classes index COLORS; 6 = neutral (release row, or no published windows).
const BANDS = {
  osu: [['great', 1], ['ok', 2], ['meh', 4]],
  taiko: [['great', 1], ['ok', 2], ['miss', 5]],
  mania: [['perfect', 0], ['great', 1], ['good', 2], ['ok', 3], ['meh', 4], ['miss', 5]],
};
const MISS = 5;
const NEUTRAL = 6;

// Cross-axis geometry (CSS px), measured from the far edge of the canvas inwards:
// [distribution][gap][tick lane][ladder][gap][marker].
const LANE = 22;
const TRACK = 8;
const MARK_GAP = 3;
const MARK = 7;
const BASE = LANE + TRACK + MARK_GAP + MARK;
const HIST_GAP = 4;
const EDGE = 2;

const TICKS = 1024; // ring capacity; far above what a lifetime holds at mania 7K densities
const SPAWN_BULK = 48; // a snapshot mid-attempt animates only its newest hits
const EMA_ALPHA = 0.08;
const MAX_BINS = 512;
const ZOOM = 1.5; // "great window" scale: ±1.5 × great

const root = getComputedStyle(document.documentElement);
const tok = name => root.getPropertyValue(name).trim();
const COLORS = ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss', '--fg-dim'].map(tok);
const FG = tok('--fg');
const SIGNAL = tok('--signal');
const ACCENT = tok('--accent');
const SUNKEN = 'rgb(11 12 13 / .62)';
const GRID = 'rgb(235 232 225 / .1)';

const $ = id => document.getElementById(id);
const dock = $('dock');
const panel = $('panel');
const chip = $('chip');
const text = {
  chip: $('chip-text'), mode: $('mode'), ur: $('ur'), mean: $('mean'), dir: $('dir'),
  early: $('early'), late: $('late'), range: $('range'), relUr: $('rel-ur'), relMean: $('rel-mean'), mainLabel: $('main-label'),
  rsUr: $('rs-ur'), rsMean: $('rs-mean'),
};
const releaseEl = $('row-release');
const legend = $('legend');

let cfg = { ...DEFAULTS };
let status = 'connecting';
let values = {};
let raf = 0;
let lastFrame = 0;
let viewDirty = true;
let textDirty = true;

// Gaussian profile sampled at 65 points over 0…2.5σ; the smoothing radius spans the whole table.
const KERNEL = new Float32Array(65);
for (let i = 0; i <= 64; i++) { const z = (i / 64) * 2.5; KERNEL[i] = Math.exp(-0.5 * z * z); }

const view = {
  show: 'chip', chip: 'connecting', mode: null, final: false, idle: true, split: false, missing: false, hist: true,
  keys: 4, lazer: false, vertical: false,
};
let placed = '';
let checksum = '';
let skin = null; // maniaSkin() result for the current skin and key count
let skinKey = '';
const geo = { bands: [], range: 100, fallback: true, key: '' };

function createRow(el, hasHist, neutral) {
  const canvas = el.querySelector('canvas');
  const cache = hasHist ? document.createElement('canvas') : null;
  return {
    canvas, ctx: canvas.getContext('2d', { alpha: true }), cache, cacheCtx: cache?.getContext('2d', { alpha: true }),
    hasHist, neutral, w: 0, h: 0, dpr: 1, L: 0, C: 0,
    source: null, seen: 0, lastRaw: NaN,
    errs: new Float32Array(2048), n: 0, mean: 0, m2: 0, early: 0, late: 0, ema: 0, shown: NaN, maxAbs: 0,
    tickErr: new Float32Array(TICKS), tickAt: new Float64Array(TICKS), head: 0, count: 0,
    bins: new Float32Array(MAX_BINS), dens: new Float32Array(MAX_BINS), nb: 0, histDirty: true,
  };
}
const main = createRow($('row-main'), true, false);
const release = createRow(releaseEl, false, true);
const ROWS = [main, release];

// ---------------------------------------------------------------- data
function resetRow(row) {
  row.seen = 0; row.lastRaw = NaN;
  row.n = 0; row.mean = 0; row.m2 = 0; row.early = 0; row.late = 0; row.ema = 0; row.shown = NaN; row.maxAbs = 0;
  row.count = 0;
  row.bins.fill(0);
  row.histDirty = true;
}

function px(row, e) {
  const half = row.L / 2;
  const t = e / geo.range;
  return half + (t < -1 ? -1 : t > 1 ? 1 : t) * (half - EDGE);
}

function binHit(row, e) {
  if (!row.nb) return;
  const p = (px(row, e) - 1) / 2;
  const i = Math.floor(p);
  const f = p - i;
  if (i >= 0 && i < row.nb) row.bins[i] += 1 - f;
  if (i + 1 >= 0 && i + 1 < row.nb) row.bins[i + 1] += f;
}

function rebin(row) {
  row.bins.fill(0);
  for (let i = 0; i < row.n; i++) binHit(row, row.errs[i]);
  row.histDirty = true;
}

function addHit(row, e, at) {
  if (typeof e !== 'number' || !Number.isFinite(e)) return;
  if (row.n === row.errs.length) {
    const grown = new Float32Array(row.n * 2);
    grown.set(row.errs);
    row.errs = grown;
  }
  row.errs[row.n++] = e;
  const d = e - row.mean;
  row.mean += d / row.n;
  row.m2 += d * (e - row.mean);
  if (e < 0) row.early++;
  else if (e > 0) row.late++;
  row.ema = row.n === 1 ? e : row.ema + EMA_ALPHA * (e - row.ema);
  const a = e < 0 ? -e : e;
  if (a > row.maxAbs) row.maxAbs = a;
  binHit(row, e);
  row.histDirty = true;
  if (at >= 0) {
    row.tickErr[row.head] = e;
    row.tickAt[row.head] = at;
    row.head = (row.head + 1) % TICKS;
    if (row.count < TICKS) row.count++;
  }
}

/** Consumes only the new tail of a whole-array update; a shrink or rewritten prefix is a new attempt. */
function ingest(row, pointer, now) {
  if (row.source !== pointer) { resetRow(row); row.source = pointer; }
  const arr = pointer ? values[pointer] : undefined;
  if (!Array.isArray(arr)) { if (row.seen) resetRow(row); return; }
  const len = arr.length;
  if (len < row.seen || (row.seen && arr[row.seen - 1] !== row.lastRaw)) resetRow(row);
  if (len === row.seen) return;
  const spawnFrom = now >= 0 ? Math.max(row.seen, len - SPAWN_BULK) : len;
  for (let i = row.seen; i < len; i++) addHit(row, arr[i], i >= spawnFrom ? now : -1);
  row.seen = len;
  row.lastRaw = arr[len - 1];
  textDirty = true;
}

function wantSplit(mode, idle) {
  if (idle || mode !== 'mania' || cfg.releaseRow === 'off') return false;
  if (cfg.releaseRow === 'always') return true;
  const holds = values[P.holds];
  return typeof holds === 'number' && holds > 0;
}

function route(now) {
  const split = view.split;
  const pressPresent = Array.isArray(values[P.press]);
  ingest(main, split && pressPresent ? P.press : P.all, now);
  ingest(release, split ? P.release : null, now);
  if (geo.fallback && Math.max(main.maxAbs, release.maxAbs) > geo.range) computeGeometry();
}

function computeGeometry() {
  const spec = BANDS[view.mode];
  const hw = values[P.windows];
  const bands = [];
  let great = 0;
  if (spec && hw && typeof hw === 'object') {
    for (const [key, cls] of spec) {
      const edge = hw[key];
      if (typeof edge !== 'number' || !(edge > 0) || (bands.length && edge <= bands[bands.length - 1].edge)) continue;
      bands.push({ edge, cls });
      if (key === 'great') great = edge;
    }
  }
  let range = bands.length ? bands[bands.length - 1].edge : 0;
  if (cfg.range === 'great window' && great) range = great * ZOOM;
  const fallback = !range;
  if (fallback) {
    const m = Math.max(main.maxAbs, release.maxAbs);
    range = m ? Math.max(40, Math.ceil(m * 1.15 / 10) * 10) : 100;
  }
  const key = `${range}|${bands.map(b => `${b.edge}:${b.cls}`).join(',')}`;
  if (key === geo.key) return;
  geo.key = key;
  geo.bands = bands;
  geo.range = range;
  geo.fallback = fallback;
  for (const row of ROWS) rebin(row);
  buildLegend();
  textDirty = true;
  invalidate();
}

/** Song select: the rate-adjusted windows in ms, which osu! itself only shows as an OD number. */
function buildLegend() {
  legend.replaceChildren();
  if (!geo.bands.length) return;
  const head = document.createElement('span');
  head.className = 'label';
  head.textContent = 'Windows ±ms';
  legend.append(head);
  for (const band of geo.bands) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = COLORS[band.cls];
    item.append(swatch, String(Math.round(band.edge * 10) / 10));
    legend.append(item);
  }
}

function evaluateView() {
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  const playing = isPlaying(state);
  const lazer = values[P.client] === 'lazer';
  // Results: lazer has its own timing statistics, so by default only stable gets the hold.
  const final = state === RESULTS && (cfg.results === 'always' || (cfg.results === 'osu!stable only' && !lazer));
  const select = state === SONG_SELECT && cfg.songSelect;
  let show = 'none';
  let chipState = status;
  if (status !== 'live') show = 'chip';
  else if (state === undefined) { show = 'chip'; chipState = 'idle'; }
  else if (mode === 'fruits' || !mode) show = 'none';
  else if (playing || final || select) show = 'panel';
  const idle = !playing && !final;
  const split = wantSplit(mode, idle);
  const keys = Math.round(Number(values[P.keys]));
  const next = {
    show, chip: chipState, mode, final: final && show === 'panel', idle, split,
    missing: split && !Array.isArray(values[P.release]),
    hist: !idle && (final || cfg.showDistribution),
    keys: keys >= 1 && keys <= 18 ? keys : 4,
    lazer,
    vertical: cfg.orientation === 'vertical' && !idle && !final,
  };
  let changed = false;
  for (const key in next) if (view[key] !== next[key]) { view[key] = next[key]; changed = true; }
  if (changed) viewDirty = true;
  return changed;
}

function loadPalette() {
  const target = cfg.accent === 'map' ? checksum : '';
  if (!target) { applyPalette(dock, null); return; }
  mapPalette(target).then(palette => {
    if (target === checksum && cfg.accent === 'map') applyPalette(dock, palette);
  });
}

/** Reads the mania stage geometry of the player's skin; re-places the bar when it arrives. */
function loadSkin() {
  const key = `${view.keys}|${values[P.skin] ?? ''}`;
  skinKey = key;
  skin = null; // another key count's columns would misplace the stage until the new read lands
  maniaSkin(view.keys, values[P.skin] ?? '').then(result => {
    if (skinKey !== key) return;
    skin = result;
    viewDirty = true;
    placed = '';
    invalidate();
  });
}

const VIEW_POINTERS = [P.state, P.playMode, P.settingsMode, P.client, P.keys, P.skin, P.windows, P.holds, P.release];

subscribe(Object.values(P), (_, changed) => {
  values = _;
  const now = performance.now();
  let structural = false;
  for (const pointer of VIEW_POINTERS) if (changed.has(pointer)) { structural = true; break; }
  if (structural) {
    const before = view.mode;
    evaluateView();
    if (before !== view.mode || changed.has(P.windows)) computeGeometry();
    if (view.mode === 'mania' && `${view.keys}|${values[P.skin] ?? ''}` !== skinKey) loadSkin();
  }
  if (changed.has(P.checksum) && values[P.checksum] !== checksum) {
    checksum = typeof values[P.checksum] === 'string' ? values[P.checksum] : '';
    loadPalette();
  }
  route(now);
  invalidate();
}, {
  onStatus(state) {
    if (state === status) return;
    status = state;
    evaluateView();
    invalidate();
  },
});

// ---------------------------------------------------------------- settings + layout
function setFlag(name, on) { panel.dataset[name] = on ? '1' : '0'; }

settings(DEFAULTS, s => {
  const accentChanged = s.accent !== cfg.accent;
  cfg = s;
  panel.dataset.backing = ['none', 'scrim', 'panel'].includes(cfg.backing) ? cfg.backing : 'none';
  dock.dataset.accent = cfg.accent === '18-lab' ? 'lab' : 'map';
  setFlag('brand', cfg.showBrand);
  setFlag('ur', cfg.showUr);
  setFlag('mean', cfg.showMean);
  setFlag('el', cfg.showEarlyLate);
  setFlag('readouts', cfg.showUr || cfg.showMean);
  if (accentChanged) loadPalette();
  evaluateView();
  viewDirty = true;
  placed = '';
  computeGeometry();
  route(-1);
  for (const row of ROWS) row.histDirty = true;
  invalidate();
});

const even = v => Math.round(v / 2) * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Puts the cluster into the space osu! leaves empty: gameplay follows osuLayout() for the ruleset
 * (busy = playfield/stage/lane); song select uses the centre column between the local leaderboard
 * and the carousel; stable results the free right end of the header strip.
 */
function place() {
  const mode = AUTO_ZONE[view.mode] ? view.mode : 'osu';
  const chrome = cfg.backing === 'panel' ? PANEL_CHROME : 40;
  let zone, len, ax, ay, align, from;
  if (view.final) {
    zone = 'results'; len = 560; align = 'end'; from = 'top'; ax = 1900; ay = 8;
  } else if (view.idle && view.show === 'panel') {
    zone = 'select'; len = 480; align = 'center'; from = 'bottom'; ax = 850; ay = 870;
  } else {
    // mania: the player's skin.ini stage (through vosu) unless the settings override it.
    const width = cfg.columnWidth > 0 ? clamp(cfg.columnWidth, 5, 200) : skin?.columnWidth ?? 30;
    const lay = osuLayout(mode, {
      keys: view.keys, columnWidth: width, columnSpacing: skin?.columnSpacing ?? 0,
      columnStart: cfg.columnStart > 0 ? clamp(cfg.columnStart, 0, 1000) : skin?.columnStart ?? 136,
      client: view.lazer ? 'lazer' : 'stable',
    });
    const b = lay.busy;
    zone = cfg.zone === 'auto' ? AUTO_ZONE[mode] : cfg.zone === 'osu! bar' ? 'bar' : cfg.zone;
    if (mode === 'taiko' && (zone === 'left' || zone === 'right')) zone = 'below';
    if (zone === 'below' && mode !== 'taiko') zone = mode === 'mania' ? 'left' : 'bar';
    // Side zones: osu! under the key counter; mania with the ladder on the skin's judgement line
    // (HitPosition, stable default 402 of 480), kept on screen when the block is tall.
    let top = Math.round(SCREEN_H * 0.7);
    if (mode === 'mania') {
      const pad = cfg.backing === 'panel' ? 9 : 14;
      const readouts = cfg.showUr || cfg.showMean ? 36 : 0;
      const cross = view.hist ? 64 : BASE;
      const meta = view.split ? 16 : 0;
      const trackY = pad + readouts + meta + cross - BASE + LANE;
      const height = pad * 2 + readouts + meta + cross + 16 + (view.split ? 8 + 16 + 40 : 0);
      top = clamp(Math.round(lay.unit * (skin?.hitPosition ?? 402)) - trackY, MARGIN, SCREEN_H - MARGIN - height);
    }
    let avail;
    if (zone === 'left') {
      align = 'end'; from = 'top'; ax = b.x - 8; ay = top; avail = Math.min(360, ax - MARGIN);
    } else if (zone === 'right') {
      // Stable mania draws its HP bar just right of the stage.
      align = 'start'; from = 'top'; ax = b.x + b.w + (mode === 'mania' ? 40 : 8); ay = top; avail = Math.min(360, SCREEN_W - MARGIN - ax);
    } else if (zone === 'below') {
      align = 'center'; from = 'top'; ax = SCREEN_W / 2; ay = b.y + b.h + 40; avail = 680;
    } else {
      zone = 'bar'; align = 'center'; from = 'bottom'; ax = SCREEN_W / 2; ay = SCREEN_H - 4; avail = 440;
    }
    len = cfg.width > 0 ? cfg.width : avail - chrome;
    if (view.vertical) {
      len = cfg.width > 0 ? cfg.width : 420;
      if (zone === 'left' || zone === 'right') ay = Math.round((SCREEN_H - len) / 2) - 120;
    }
  }
  len = even(clamp(len, 200, 960));
  const x = Math.round(ax + cfg.offsetX);
  const y = Math.round(ay + cfg.offsetY);
  const size = clamp(cfg.size, 0.5, 2.5);
  const key = `${zone}|${len}|${x}|${y}|${align}|${from}|${size}|${view.vertical}`;
  if (key === placed) return;
  placed = key;
  const st = dock.style;
  st.left = align === 'end' ? '' : `${x}px`;
  st.right = align === 'end' ? `${SCREEN_W - x}px` : '';
  st.top = from === 'top' ? `${y}px` : '';
  st.bottom = from === 'bottom' ? `${SCREEN_H - y}px` : '';
  st.transformOrigin = `${align === 'start' ? 'left' : align === 'end' ? 'right' : 'center'} ${from}`;
  st.scale = String(size);
  st.setProperty('--len', `${len}px`);
  dock.dataset.zone = zone;
  dock.dataset.align = align;
  dock.dataset.from = from;
  dock.dataset.orient = view.vertical ? 'v' : 'h';
  resizeAll();
}

function sizeRow(row, w, h) {
  // Back the canvas at the on-screen size so a scaled cluster stays crisp.
  const dpr = (window.devicePixelRatio || 1) * clamp(cfg.size, 0.5, 2.5);
  if (w === row.w && h === row.h && dpr === row.dpr) return;
  row.w = w; row.h = h; row.dpr = dpr;
  row.canvas.width = Math.round(w * dpr);
  row.canvas.height = Math.round(h * dpr);
  row.L = view.vertical ? h : w;
  row.C = view.vertical ? w : h;
  row.nb = Math.min(MAX_BINS, Math.floor(row.L / 2));
  if (row.cache) {
    const histH = Math.max(0, row.C - BASE - HIST_GAP);
    row.cache.width = Math.max(1, Math.round(row.L * dpr));
    row.cache.height = Math.max(1, Math.round(histH * dpr));
  }
  rebin(row);
}

const byCanvas = new Map(ROWS.map(row => [row.canvas, row]));
const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    const row = byCanvas.get(entry.target);
    // Re-read orientation with the size: the swap of width/height is what triggered this.
    row.w = -1;
    sizeRow(row, entry.contentRect.width, entry.contentRect.height);
  }
  invalidate();
});
for (const row of ROWS) observer.observe(row.canvas);
function resizeAll() {
  for (const row of ROWS) if (row.w > 0) { const { w, h } = row; row.w = -1; sizeRow(row, w, h); }
  invalidate();
}
addEventListener('resize', resizeAll);

fit($('stage'), 1920, 1080);

// ---------------------------------------------------------------- render

function invalidate() { if (!raf) raf = requestAnimationFrame(frame); }

function setText(el, s) {
  if (el.__text !== s) { el.__text = s; el.textContent = s; }
}

const signed = v => (v >= 0.05 ? `+${v.toFixed(1)}` : v <= -0.05 ? `\u2212${(-v).toFixed(1)}` : '0.0');
const urOf = row => (row.n >= 2 ? (Math.sqrt(row.m2 / row.n) * 10).toFixed(2) : '—');

function applyView() {
  viewDirty = false;
  place();
  chip.dataset.show = view.show === 'chip' ? '1' : '0';
  chip.dataset.state = view.chip;
  setText(text.chip, view.chip === 'offline' ? 'vosu offline' : view.chip === 'idle' ? 'osu! not running' : 'Connecting to vosu');
  panel.dataset.show = view.show === 'panel' ? '1' : '0';
  setFlag('final', view.final);
  setFlag('idle', view.idle);
  setFlag('split', view.split);
  releaseEl.dataset.missing = view.missing ? '1' : '0';
  dock.style.setProperty('--cross-main', `${view.hist ? 64 : BASE}px`);
  setText(text.mode, MODE_LABELS[view.mode] ?? '—');
  // Without vosu's press array the main row carries every event, releases included.
  setText(text.mainLabel, view.missing ? 'All hits' : 'Press');
  textDirty = true;
}

function writeText() {
  textDirty = false;
  const row = main;
  setText(text.ur, urOf(row));
  setText(text.mean, row.n ? signed(row.mean) : '—');
  const side = !row.n || Math.abs(row.mean) < 0.05 ? '' : row.mean < 0 ? 'early' : 'late';
  if (text.dir.dataset.side !== side) text.dir.dataset.side = side;
  setText(text.dir, side ? (side === 'early' ? 'Early' : 'Late') : '');
  setText(text.early, row.n ? `${Math.round(row.early / row.n * 100)}%` : '—');
  setText(text.late, row.n ? `${Math.round(row.late / row.n * 100)}%` : '—');
  setText(text.range, geo.bands.length || row.n ? `\u00b1${Math.round(geo.range)} ms` : '—');
  setText(text.relUr, urOf(release));
  setText(text.relMean, release.n ? signed(release.mean) : '—');
  setText(text.rsUr, text.relUr.__text);
  setText(text.rsMean, text.relMean.__text);
}

function classOf(e) {
  const a = e < 0 ? -e : e;
  const bands = geo.bands;
  for (let k = 0; k < bands.length; k++) if (a <= bands[k].edge) return bands[k].cls;
  return bands.length ? MISS : NEUTRAL;
}

function buildHist(row) {
  row.histDirty = false;
  const { nb, bins, dens, L, dpr } = row;
  const c = row.cacheCtx;
  const H = row.cache.height / dpr;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, row.cache.width, row.cache.height);
  if (!row.n || H < 2) return;
  // Gaussian smoothing over at least ~1.6 ms so integer (stable) errors do not comb at zoom.
  const msPerBin = (2 * geo.range) / ((L / 2 - EDGE) || 1);
  const sigma = Math.max(1.1, 1.6 / msPerBin);
  const radius = Math.min(24, Math.ceil(sigma * 2.5));
  let max = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = b + k;
      if (j >= 0 && j < nb) s += bins[j] * KERNEL[(k < 0 ? -k : k) * 64 / radius | 0];
    }
    dens[b] = s;
    if (s > max) max = s;
  }
  if (max <= 0) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.beginPath();
  c.moveTo(0, H);
  for (let b = 0; b < nb; b++) c.lineTo(b * 2 + 1, H - (dens[b] / max) * (H - 1));
  c.lineTo(L, H);
  c.closePath();
  c.fillStyle = COLORS[NEUTRAL];
  c.fill();
  // Colour the silhouette by judgement band, outermost first.
  c.globalCompositeOperation = 'source-atop';
  const bands = geo.bands;
  for (let k = bands.length - 1; k >= 0; k--) {
    const x0 = px(row, -bands[k].edge);
    c.fillStyle = COLORS[bands[k].cls];
    c.fillRect(x0, 0, px(row, bands[k].edge) - x0, H);
  }
  c.globalCompositeOperation = 'source-over';
}

function drawRow(row, now, dt) {
  const { ctx, L, C, dpr } = row;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, row.canvas.width, row.canvas.height);
  if (!L || C < BASE) return false;
  // Vertical is the transpose of horizontal: the error axis runs down, early at the top.
  if (view.vertical) ctx.setTransform(0, dpr, dpr, 0, 0, 0);
  else ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const laneTop = C - BASE;
  const trackTop = laneTop + LANE;
  const markTop = trackTop + TRACK + MARK_GAP;
  const mid = L / 2;
  const bands = geo.bands;
  const nBands = bands.length;
  const live = !view.final && !view.idle;

  // The sunken lane belongs to the opt-in panel; floating, the window hairlines frame the ticks.
  if (cfg.backing === 'panel') {
    ctx.fillStyle = SUNKEN;
    ctx.fillRect(0, laneTop, L, LANE);
  }

  // Window edges as hairlines through the lane.
  ctx.fillStyle = GRID;
  for (let k = 0; k < nBands; k++) {
    const e = bands[k].edge;
    if (e >= geo.range) continue;
    ctx.fillRect(Math.round(px(row, -e)), laneTop, 1, LANE);
    ctx.fillRect(Math.round(px(row, e)) - 1, laneTop, 1, LANE);
  }

  // Ladder: inner windows stand taller, so the target reads at a glance.
  if (nBands) {
    for (let k = nBands - 1; k >= 0; k--) {
      const x0 = Math.round(px(row, -bands[k].edge));
      const x1 = Math.round(px(row, bands[k].edge));
      const h = nBands === 1 ? TRACK : Math.round(3 + (TRACK - 3) * (nBands - 1 - k) / (nBands - 1));
      if (row.neutral) { ctx.fillStyle = FG; ctx.globalAlpha = 0.16 + 0.34 * (nBands - 1 - k) / Math.max(1, nBands - 1); }
      else { ctx.fillStyle = COLORS[bands[k].cls]; ctx.globalAlpha = 0.92; }
      ctx.fillRect(x0, trackTop, x1 - x0, h);
    }
  } else {
    ctx.fillStyle = FG;
    ctx.globalAlpha = 0.2;
    ctx.fillRect(EDGE, trackTop, L - 2 * EDGE, 2);
  }

  // Distribution.
  if (row.hasHist && view.hist && row.n && laneTop - HIST_GAP >= 2) {
    if (row.histDirty) buildHist(row);
    ctx.globalAlpha = view.final ? 0.85 : 0.5;
    ctx.drawImage(row.cache, 0, 0, L, laneTop - HIST_GAP);
  }

  // Centre reference.
  ctx.fillStyle = FG;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(mid - 1, laneTop, 2, LANE + TRACK);

  let animating = false;
  let lastStyle = -1;
  if (live && row.count) {
    const life = Math.min(30000, Math.max(250, cfg.lifetime * 1000));
    // Drop expired ticks from the old end; times are monotonic.
    while (row.count && now - row.tickAt[(row.head - row.count + TICKS) % TICKS] >= life) row.count--;
    for (let j = row.count; j > 0; j--) {
      const i = (row.head - j + TICKS) % TICKS;
      let age = (now - row.tickAt[i]) / life;
      if (age < 0) age = 0;
      const f = 1 - age;
      const e = row.tickErr[i];
      const cls = row.neutral ? NEUTRAL : classOf(e);
      if (cls !== lastStyle) { ctx.fillStyle = COLORS[cls]; lastStyle = cls; }
      ctx.globalAlpha = 0.08 + 0.92 * f * f;
      const h = Math.round(LANE * (0.38 + 0.62 * f));
      ctx.fillRect(Math.round(px(row, e)) - 1, trackTop - h, 2, h);
    }
    animating = row.count > 0;
  } else if (view.final && row.n) {
    // Results: every hit of the attempt as a faint barcode.
    ctx.globalAlpha = Math.min(0.55, Math.max(0.06, 2.4 / Math.sqrt(row.n)));
    for (let i = 0; i < row.n; i++) {
      const e = row.errs[i];
      const cls = row.neutral ? NEUTRAL : classOf(e);
      if (cls !== lastStyle) { ctx.fillStyle = COLORS[cls]; lastStyle = cls; }
      ctx.fillRect(Math.round(px(row, e)) - 1, laneTop, 2, LANE);
    }
  }

  // Marker: moving average while live, the final mean (with a ±1σ bracket) on results.
  if (row.n && !view.idle) {
    let value;
    if (view.final) {
      value = row.mean;
      row.shown = value;
      const sigma = Math.sqrt(row.m2 / row.n);
      const a = Math.round(px(row, row.mean - sigma));
      const b = Math.round(px(row, row.mean + sigma));
      ctx.fillStyle = FG;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(a, markTop + 3, b - a, 1);
      ctx.fillRect(a, markTop, 1, MARK);
      ctx.fillRect(b - 1, markTop, 1, MARK);
    } else {
      if (Number.isNaN(row.shown)) row.shown = row.ema;
      row.shown += (row.ema - row.shown) * (1 - Math.exp(-dt / 90));
      if (Math.abs(px(row, row.ema) - px(row, row.shown)) > 0.2) animating = true;
      else row.shown = row.ema;
      value = row.shown;
    }
    const x = px(row, value);
    ctx.fillStyle = value < -0.05 ? SIGNAL : value > 0.05 ? ACCENT : FG;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(Math.round(x), laneTop, 1, LANE);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x, markTop);
    ctx.lineTo(x + 4.5, markTop + MARK);
    ctx.lineTo(x - 4.5, markTop + MARK);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return animating;
}

function frame(now) {
  raf = 0;
  const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
  lastFrame = now;
  if (viewDirty) applyView();
  if (textDirty) writeText();
  let again = false;
  if (view.show === 'panel') {
    again = drawRow(main, now, dt);
    if (view.split && !view.missing) again = drawRow(release, now, dt) || again;
  }
  if (again) raf = requestAnimationFrame(frame);
  else lastFrame = 0;
}

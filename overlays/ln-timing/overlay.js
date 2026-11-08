// Copyright (c) 2026 18-LAB. MIT.
// LN timing: osu!mania press vs release hit errors as two mirrored distributions, floated in the
// empty space beside the mania stage.
import { subscribe, settings, fit, activeMode, isPlaying, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const SCREEN_W = 1920;
const SCREEN_H = 1080;
const RESULTS = 7;
// Hold-note releases are judged against the note windows widened by 1.5 (lazer's
// TailNote.RELEASE_WINDOW_LENIENCE, which replicates stable).
const RELEASE_LENIENCE = 1.5;
const MAX_BINS = 61;
const MAX_LANES = 18;
// Cluster footprint in screen px at scale 1 (style.css: .cluster width; tallest view's height).
const CLUSTER_W = 468;
const CLUSTER_H = 360;
const EDGE = 40; // gap kept to the screen edge and to the stage
// Results strip (style.css: [data-view="results"]) and the free right part of osu!stable's
// results header band it sits in, left of which the title/mapper text runs.
const STRIP_W = 760;
const STRIP_H = 120;
const RESULTS_BAND = { x: 1000, y: 8, w: 900, h: 122 };

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  selectedMode: '/settings/mode/number',
  client: '/client',
  checksum: '/beatmap/checksum',
  holds: '/beatmap/stats/objects/holds',
  keys: '/beatmap/stats/cs/converted',
  great: '/beatmap/stats/hitWindow/great',
  ok: '/beatmap/stats/hitWindow/ok',
  press: '/play/pressHitErrors',
  release: '/play/releaseHitErrors',
  laneRelease: '/play/keyHitErrors/release',
};

const $ = id => document.getElementById(id);
const cluster = $('cluster');
const el = {
  brand: $('brand'), chip: $('chip'), chipText: $('chip-text'), done: $('count-done'), total: $('count-total'),
  pMean: $('p-mean'), pDir: $('p-dir'), pUr: $('p-ur'), rMean: $('r-mean'), rDir: $('r-dir'), rUr: $('r-ur'),
  lanes: $('lanes'), earlyPct: $('early-pct'), latePct: $('late-pct'), earlyBar: $('early-bar'), lateBar: $('late-bar'),
  greatWin: $('great-win'), greatPct: $('great-pct'),
};
const hist = $('hist');
const laneCanvas = $('lane-canvas');
const hctx = hist.getContext('2d', { alpha: true });
const lctx = laneCanvas.getContext('2d', { alpha: true });

const css = getComputedStyle(document.documentElement);
const token = name => css.getPropertyValue(name).trim();
const C = {
  fg: token('--fg') || '#ebe8e1', dim: token('--fg-dim') || '#b8b5ad', muted: token('--muted') || '#7e8288',
  early: token('--signal') || '#7fa6cf', late: token('--accent') || '#ff963f', accent: token('--accent') || '#ff963f',
  hair: 'rgb(235 232 225 / .3)', hairStrong: 'rgb(235 232 225 / .42)', shade: 'rgb(0 0 0 / .42)', textShade: 'rgb(0 0 0 / .6)',
};
const MONO = token('--font-mono') || 'monospace';
const FONT_12 = `500 12px ${MONO}`;
const FONT_14 = `500 14px ${MONO}`;
const LANE_INDEX = Array.from({ length: MAX_LANES }, (_, i) => String(i + 1));
const ticks = { left: '', right: '' };

// ---------------------------------------------------------------- incremental series stats

/** Running stats over one append-only error array; rebuilt only if vosu rewrites its history. */
class Series {
  constructor() {
    this.bins = new Uint32Array(MAX_BINS);
    this.reset();
  }
  reset() {
    this.len = 0; this.last = NaN; this.n = 0; this.sum = 0; this.sq = 0;
    this.early = 0; this.late = 0; this.inside = 0;
    this.bins.fill(0);
  }
  /** Feeds the new tail of `values`; returns true when anything changed. */
  feed(values, geometry, window) {
    const length = Array.isArray(values) ? values.length : 0;
    if (length < this.len || (this.len && values[this.len - 1] !== this.last)) this.reset();
    if (length === this.len) return false;
    const { count, range } = geometry;
    const scale = count / (2 * range);
    for (let i = this.len; i < length; i++) {
      const e = Number(values[i]);
      if (!Number.isFinite(e)) continue;
      this.n++; this.sum += e; this.sq += e * e;
      if (e < 0) this.early++; else if (e > 0) this.late++;
      if (Math.abs(e) <= window) this.inside++;
      let bin = Math.floor((e + range) * scale);
      if (bin < 0) bin = 0; else if (bin >= count) bin = count - 1;
      this.bins[bin]++;
    }
    this.len = length;
    this.last = values[length - 1];
    return true;
  }
  get mean() { return this.n ? this.sum / this.n : null; }
  get ur() {
    if (this.n < 2) return null;
    const m = this.sum / this.n;
    return Math.sqrt(Math.max(0, this.sq / this.n - m * m)) * 10;
  }
}

/** Per-lane release means (keyHitErrors.release), fed incrementally like Series. */
class Lane {
  constructor() { this.reset(); }
  reset() { this.len = 0; this.last = NaN; this.n = 0; this.sum = 0; }
  feed(values) {
    const length = Array.isArray(values) ? values.length : 0;
    if (length < this.len || (this.len && values[this.len - 1] !== this.last)) this.reset();
    if (length === this.len) return false;
    for (let i = this.len; i < length; i++) {
      const e = Number(values[i]);
      if (Number.isFinite(e)) { this.n++; this.sum += e; }
    }
    this.len = length;
    this.last = values[length - 1];
    return true;
  }
}

const press = new Series();
const release = new Series();
const lanes = Array.from({ length: MAX_LANES }, () => new Lane());

// ---------------------------------------------------------------- state

const DEFAULTS = {
  zone: 'right', offsetX: 0, offsetY: 0, scale: 1, columnWidth: 30, columnStart: 136,
  backing: 'none', accent: 'map', bins: 31, perColumn: true, showBrand: true, showOnResults: true,
};
const conf = { ...DEFAULTS };
const geometry = { count: 31, range: 120 };
let values = null;
let status = 'connecting';
let view = '';
let greatWindow = null;     // press great (ms)
let releaseWindow = null;   // press great × lenience
let laneCount = 0;
let lanesPresent = false;
let placementKey = '';
let clusterScale = 1;
let checksum = '';

// Displayed (eased) bar heights and mean markers; targets are recomputed when data changes.
const shown = { press: new Float32Array(MAX_BINS), release: new Float32Array(MAX_BINS) };
const target = { press: new Float32Array(MAX_BINS), release: new Float32Array(MAX_BINS) };
const marker = { press: NaN, release: NaN, pressTo: NaN, releaseTo: NaN };

let dirtyData = false;
let dirtyHist = true;
let dirtyLanes = true;
let raf = 0;
let lastFrame = 0;
let easing = false;

function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}
function invalidateCanvases() {
  dirtyHist = true; dirtyLanes = true;
  schedule();
}

// ---------------------------------------------------------------- inputs

subscribe(Object.values(P), v => {
  values = v;
  dirtyData = true;
  schedule();
}, {
  onStatus: state => {
    // Reconnect attempts after a drop keep reading "offline" rather than flickering.
    if (state === status || (state === 'connecting' && status === 'offline')) return;
    status = state;
    el.chip.dataset.tone = state;
    setText(el.chipText, state === 'connecting' ? 'Connecting to vosu' : state === 'offline' ? 'vosu offline' : '');
    dirtyData = true;
    schedule();
  },
});

settings(DEFAULTS, s => {
  let bins = Math.round(Math.min(MAX_BINS, Math.max(9, s.bins)));
  if (bins % 2 === 0) bins += 1; // odd: one bin centred on 0 ms
  // Lanes are not fed while hidden, so a re-enable starts their history over from the arrays.
  if (s.perColumn && !conf.perColumn) for (const lane of lanes) lane.reset();
  Object.assign(conf, s, { bins });
  el.brand.hidden = !conf.showBrand;
  cluster.dataset.backing = ['none', 'scrim', 'panel'].includes(conf.backing) ? conf.backing : 'none';
  cluster.dataset.accent = conf.accent === '18-lab' ? '18-lab' : 'map';
  placementKey = '';
  loadPalette(true);
  dirtyData = true;
  invalidateCanvases();
});

/** Map tint (identity marks only, via --map-* in CSS): per checksum, off the hot path. */
function loadPalette(force) {
  const next = values?.[P.checksum] || '';
  if (!force && next === checksum) return;
  checksum = next;
  if (conf.accent === '18-lab' || !checksum) {
    applyPalette(cluster, null);
    return;
  }
  const wanted = checksum;
  mapPalette(wanted).then(palette => {
    if (wanted === checksum && conf.accent !== '18-lab') applyPalette(cluster, palette);
  });
}

// ---------------------------------------------------------------- placement

/**
 * Gameplay: the free region beside the stage (osuLayout), against the outer screen edge so skins
 * that move or widen the stage still leave it clear; shrinks only if the region is narrow.
 * Results: a one-row strip in the right part of osu!stable's results header band, the only area
 * the ranking screen leaves free.
 */
function place(v) {
  const keys = Math.round(Number(v?.[P.keys])) || 4;
  const client = v?.[P.client] === 'lazer' ? 'lazer' : 'stable';
  const strip = view === 'results';
  const key = `${keys}|${client}|${strip}`;
  if (key === placementKey) return;
  placementKey = key;
  const user = Math.min(1.6, Math.max(0.5, conf.scale || 1));
  let x, y, s;
  if (strip) {
    s = Math.min(user, (RESULTS_BAND.w - 2 * 10) / STRIP_W, RESULTS_BAND.h / STRIP_H);
    x = RESULTS_BAND.x + RESULTS_BAND.w - 10 - STRIP_W * s + conf.offsetX;
    y = RESULTS_BAND.y + conf.offsetY;
  } else {
    const layout = osuLayout('mania', {
      keys, client, columnWidth: conf.columnWidth > 0 ? conf.columnWidth : 30,
      columnStart: conf.columnStart >= 0 ? conf.columnStart : 136, width: SCREEN_W, height: SCREEN_H,
    });
    const { busy } = layout;
    const left = conf.zone === 'left';
    const region = layout.free.find(r => (left ? r.x + r.w <= busy.x : r.x >= busy.x + busy.w)) || layout.free[0];
    s = Math.max(0.35, Math.min(user, (region.w - 2 * EDGE) / CLUSTER_W, (region.h - EDGE) / CLUSTER_H));
    x = (left ? region.x + EDGE : region.x + region.w - EDGE - CLUSTER_W * s) + conf.offsetX;
    // A little above centre: clear of the score/accuracy block and of HP bars skins hang low.
    y = region.y + Math.max(0, region.h - CLUSTER_H * s) * 0.3 + conf.offsetY;
  }
  cluster.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${s})`;
  const chart = strip ? CHARTS.strip : CHARTS.play;
  if (s !== clusterScale || chart.w !== HW) {
    clusterScale = s;
    useChart(chart);
    dirtyHist = true; dirtyLanes = true;
  }
}

/** Map windows or bin count changed: re-bin every stored error once (rare). */
function syncGeometry(v) {
  const great = Number(v[P.great]);
  const ok = Number(v[P.ok]);
  const g = great > 0 ? great : null;
  // The chart spans the mania 100 (ok) window, widened if needed to show the release great guide.
  let range = ok > 0 ? ok : 120;
  if (g) range = Math.max(range, Math.ceil(g * RELEASE_LENIENCE * 1.15));
  if (g === greatWindow && range === geometry.range && conf.bins === geometry.count) return;
  greatWindow = g;
  releaseWindow = g ? g * RELEASE_LENIENCE : null;
  ticks.left = g ? `−${Math.round(g)}` : '';
  ticks.right = g ? `+${Math.round(g)}` : '';
  geometry.range = range;
  geometry.count = conf.bins;
  press.reset(); release.reset();
  shown.press.fill(0); shown.release.fill(0);
  dirtyHist = true; dirtyLanes = true;
}

// ---------------------------------------------------------------- formatting

function setText(node, text) {
  if (node.__text !== text) { node.__text = text; node.textContent = text; }
}
function setAttr(node, name, value) {
  const key = `__${name}`;
  if (node[key] === value) return;
  node[key] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}
function signed(ms) {
  if (ms === null) return '—';
  const r = Math.round(ms * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}
function direction(ms) {
  if (ms === null) return '';
  const r = Math.round(ms * 10) / 10;
  return r < 0 ? 'early' : r > 0 ? 'late' : '';
}

// ---------------------------------------------------------------- view model

/**
 * Gameplay (and results, which only show press and release combined) are the only screens with
 * something osu! lacks. Song select already lists hold notes ("sliders"), so it shows nothing.
 */
function resolveView(v) {
  if (status !== 'live' || !v) return 'offline';
  const mode = activeMode(v[P.state], v[P.playMode], v[P.selectedMode]);
  if (mode === null) return 'idle';
  if (mode !== 'mania') return 'hidden';
  const state = v[P.state];
  if (!isPlaying(state) && !(state === RESULTS && conf.showOnResults)) return 'hidden';
  const released = Array.isArray(v[P.release]) && v[P.release].length > 0;
  // Rice maps: one quiet line during play; on results there is nothing to add.
  if (v[P.holds] === 0 && !released) return state === RESULTS ? 'hidden' : 'noln';
  return state === RESULTS ? 'results' : 'play';
}

function update() {
  const v = values;
  const next = resolveView(v);
  if (next !== view) {
    view = next;
    cluster.dataset.view = next;
    if (next === 'idle') { el.chip.dataset.tone = 'idle'; setText(el.chipText, 'No game data'); }
    else if (next === 'offline') el.chip.dataset.tone = status;
    dirtyHist = true; dirtyLanes = true;
  }
  place(v);
  if (!v || view === 'offline' || view === 'idle' || view === 'hidden') return;
  loadPalette(false);
  syncGeometry(v);

  const holds = Number.isInteger(v[P.holds]) ? v[P.holds] : null;
  if (view === 'noln') {
    setText(el.done, '');
    setText(el.total, holds === null ? '—' : String(holds));
    return;
  }

  // play / results
  const pChanged = press.feed(v[P.press], geometry, greatWindow ?? Infinity);
  const rChanged = release.feed(v[P.release], geometry, releaseWindow ?? Infinity);
  if (pChanged || rChanged) dirtyHist = true;

  setText(el.done, String(release.n));
  setText(el.total, holds === null || holds === 0 ? '—' : String(holds));

  const pm = press.mean, rm = release.mean, pu = press.ur, ru = release.ur;
  setText(el.pMean, signed(pm)); setText(el.pDir, direction(pm)); setAttr(el.pDir, 'data-dir', direction(pm) || null);
  setText(el.rMean, signed(rm)); setText(el.rDir, direction(rm)); setAttr(el.rDir, 'data-dir', direction(rm) || null);
  setText(el.pUr, pu === null ? '—' : pu.toFixed(0));
  setText(el.rUr, ru === null ? '—' : ru.toFixed(0));
  setAttr(el.pMean.parentElement, 'data-empty', pm === null ? '' : null);
  setAttr(el.rMean.parentElement, 'data-empty', rm === null ? '' : null);

  const n = release.n;
  setText(el.earlyPct, n ? `${Math.round(100 * release.early / n)}%` : '—');
  setText(el.latePct, n ? `${Math.round(100 * release.late / n)}%` : '—');
  const ef = n ? (release.early / n).toFixed(3) : '0', lf = n ? (release.late / n).toFixed(3) : '0';
  if (el.earlyBar.__f !== ef) { el.earlyBar.__f = ef; el.earlyBar.style.transform = `scaleX(${ef})`; }
  if (el.lateBar.__f !== lf) { el.lateBar.__f = lf; el.lateBar.style.transform = `scaleX(${lf})`; }
  setText(el.greatWin, releaseWindow ? `±${Math.round(releaseWindow)}` : '');
  setText(el.greatPct, releaseWindow && n ? (100 * release.inside / n).toFixed(1) : '—');
  setAttr(el.greatPct.parentElement, 'data-empty', releaseWindow && n ? null : '');

  // Per-column release (vosu extension).
  const laneData = v[P.laneRelease];
  const present = Array.isArray(laneData);
  setAttr(el.lanes, 'data-on', conf.perColumn ? '' : null);
  setAttr(el.lanes, 'data-missing', conf.perColumn && !present ? '' : null);
  if (conf.perColumn && present) {
    const keys = Number(v[P.keys]);
    const count = Math.min(MAX_LANES, Math.max(Number.isFinite(keys) ? Math.round(keys) : 0, laneData.length));
    if (count !== laneCount || present !== lanesPresent) { laneCount = count; dirtyLanes = true; }
    for (let i = 0; i < count; i++) if (lanes[i].feed(laneData[i])) dirtyLanes = true;
  }
  lanesPresent = present;

  if (dirtyHist) computeTargets();
}

function computeTargets() {
  const count = geometry.count;
  const pn = press.n, rn = release.n;
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const a = pn ? press.bins[i] / pn : 0;
    const b = rn ? release.bins[i] / rn : 0;
    target.press[i] = a; target.release[i] = b;
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  // Shared density scale so the two shapes compare honestly at any sample size.
  const k = peak ? 1 / peak : 0;
  for (let i = 0; i < count; i++) { target.press[i] *= k; target.release[i] *= k; }
  marker.pressTo = press.mean ?? NaN;
  marker.releaseTo = release.mean ?? NaN;
}

// ---------------------------------------------------------------- render loop

function frame(now) {
  raf = 0;
  const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
  lastFrame = now;
  if (dirtyData) { dirtyData = false; update(); }

  let animating = false;
  if (view === 'play' || view === 'results') {
    if (dirtyHist || easing) {
      dirtyHist = false;
      animating = ease(dt);
      drawHist();
    }
    if (dirtyLanes && conf.perColumn && lanesPresent) { dirtyLanes = false; drawLanes(); }
  }
  easing = animating;
  if (animating || dirtyData) schedule();
  else lastFrame = 0;
}

/** Exponential approach (ease-out) of bars and markers; true while still moving. */
function ease(dt) {
  const f = 1 - Math.exp(-dt / 55);
  let moving = easeBars(shown.press, target.press, f);
  if (easeBars(shown.release, target.release, f)) moving = true;
  marker.press = easeMarker(marker.press, marker.pressTo, f);
  marker.release = easeMarker(marker.release, marker.releaseTo, f);
  // A marker without data stays NaN (set straight to its target), so only finite ones can lag.
  return moving || (marker.press === marker.press && marker.press !== marker.pressTo)
    || (marker.release === marker.release && marker.release !== marker.releaseTo);
}
function easeBars(s, t, f) {
  let moving = false;
  for (let i = 0; i < geometry.count; i++) {
    const d = t[i] - s[i];
    if (Math.abs(d) > 0.004) { s[i] += d * f; moving = true; } else s[i] = t[i];
  }
  return moving;
}
function easeMarker(from, to, f) {
  if (Number.isNaN(to) || Number.isNaN(from)) return to;
  const d = to - from;
  return Math.abs(d) > 0.05 ? from + d * f : to;
}

// Chart geometry (CSS px at cluster scale 1): the gameplay cluster, and the results strip that
// must fit osu!'s results header band. Matches .hist sizes in style.css.
const CHARTS = {
  play: { w: 280, h: 164, top: 70, bottom: 94 },
  strip: { w: 240, h: 92, top: 38, bottom: 56 },
};
let HW = 0, HH = 0, TOP_BASE = 0, BOTTOM_BASE = 0, HALF = 0;
function useChart(chart) {
  HW = chart.w; HH = chart.h; TOP_BASE = chart.top; BOTTOM_BASE = chart.bottom;
  HALF = TOP_BASE - 1; // bar height budget per half
}
useChart(CHARTS.play);

let stageScale = 1;
function backing(canvas, ctx, w, h) {
  const k = (devicePixelRatio || 1) * stageScale * clusterScale;
  const bw = Math.round(w * k), bh = Math.round(h * k);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  ctx.setTransform(k, 0, 0, k, 0, 0);
}

function xOf(ms) {
  return Math.round((ms + geometry.range) / (2 * geometry.range) * HW);
}

function dashed(ctx, x, y0, y1) {
  for (let y = y0; y < y1; y += 4) ctx.fillRect(x, y, 1, Math.min(2, y1 - y));
}

/** Text with a 1 px dark under-copy: legible on any background without a box or a blur. */
function label(c, text, x, y, color) {
  if (conf.backing !== 'panel') { c.fillStyle = C.textShade; c.fillText(text, x, y + 1); }
  c.fillStyle = color;
  c.fillText(text, x, y);
}

function drawHist() {
  const c = hctx;
  backing(hist, c, HW, HH);
  c.clearRect(0, 0, HW, HH);
  const count = geometry.count;
  const binW = HW / count;
  const gap = binW >= 4 ? 1 : 0;
  const centre = (count - 1) / 2;
  const floating = conf.backing !== 'panel';

  // Window guides.
  c.fillStyle = C.hair;
  if (greatWindow) {
    dashed(c, xOf(-greatWindow), 0, TOP_BASE);
    dashed(c, Math.min(HW - 1, xOf(greatWindow)), 0, TOP_BASE);
  }
  if (releaseWindow) {
    dashed(c, xOf(-releaseWindow), BOTTOM_BASE + 1, HH);
    dashed(c, Math.min(HW - 1, xOf(releaseWindow)), BOTTOM_BASE + 1, HH);
  }

  // Floating: a 1 px shade around every bar first, so bars hold their edge on bright backgrounds.
  if (floating) {
    c.fillStyle = C.shade;
    for (let half = 0; half < 2; half++) {
      const values = half ? shown.release : shown.press;
      for (let i = 0; i < count; i++) {
        if (values[i] <= 0) continue;
        const h = Math.max(1, Math.round(values[i] * HALF));
        const x0 = Math.round(i * binW), w = Math.round((i + 1) * binW) - x0 - gap;
        c.fillRect(x0 - 1, half ? BOTTOM_BASE : TOP_BASE - h - 1, w + 2, h + 2);
      }
    }
  }

  // Bars: early bins blue, late bins amber, the 0 ms bin neutral. Press is the quieter
  // reference (soft fill under a bright cap); release, the subject, is solid.
  for (let half = 0; half < 2; half++) {
    const values = half ? shown.release : shown.press;
    for (let i = 0; i < count; i++) {
      const v = values[i];
      if (v <= 0) continue;
      const h = Math.max(1, Math.round(v * HALF));
      const x0 = Math.round(i * binW), w = Math.round((i + 1) * binW) - x0 - gap;
      c.fillStyle = i === centre ? C.dim : i < centre ? C.early : C.late;
      if (half) {
        c.globalAlpha = 0.92;
        c.fillRect(x0, BOTTOM_BASE + 1, w, h);
      } else {
        c.globalAlpha = 0.4;
        c.fillRect(x0, TOP_BASE - h + 1, w, h - 1);
        c.globalAlpha = 1;
        c.fillRect(x0, TOP_BASE - h, w, 1);
      }
    }
  }
  c.globalAlpha = 1;

  // Baselines and the 0 ms spine.
  c.fillStyle = C.hairStrong;
  c.fillRect(0, TOP_BASE, HW, 1);
  c.fillRect(0, BOTTOM_BASE, HW, 1);
  const zero = xOf(0);
  c.fillStyle = C.hair;
  c.fillRect(zero, 0, 1, TOP_BASE);
  c.fillRect(zero, BOTTOM_BASE + 1, 1, HH - BOTTOM_BASE - 1);

  // Mean markers: the subject (release) in the value colour, press in the secondary one.
  drawMarker(c, marker.press, 0, TOP_BASE, C.dim, -1);
  drawMarker(c, marker.release, BOTTOM_BASE + 1, HH, C.fg, 1);

  c.font = FONT_12;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const pressMid = TOP_BASE - Math.round(HALF / 2), releaseMid = BOTTOM_BASE + Math.round(HALF / 2) + 1;
  if (!press.n) { c.clearRect(HW / 2 - 60, pressMid - 10, 120, 20); label(c, 'No presses yet', HW / 2, pressMid, C.dim); }
  if (!release.n) { c.clearRect(HW / 2 - 60, releaseMid - 10, 120, 20); label(c, 'No releases yet', HW / 2, releaseMid, C.dim); }

  // Axis band: direction words once, then 0 and ± great ticks.
  const mid = (TOP_BASE + BOTTOM_BASE) / 2 + 1;
  c.textAlign = 'left'; label(c, 'EARLY', 0, mid, C.early);
  c.textAlign = 'right'; label(c, 'LATE', HW, mid, C.late);
  c.textAlign = 'center'; label(c, '0', zero + 0.5, mid, C.fg);
  if (greatWindow) {
    const left = xOf(-greatWindow), right = xOf(greatWindow);
    if (left > 58) label(c, ticks.left, left + 0.5, mid, C.dim);
    if (right < HW - 48) label(c, ticks.right, right + 0.5, mid, C.dim);
  }
}

function drawMarker(c, ms, y0, y1, color, side) {
  if (Number.isNaN(ms)) return;
  const x = Math.max(4, Math.min(HW - 6, xOf(ms)));
  // A dark gutter either side so the marker reads against any bin colour or background.
  c.clearRect(x - 1, y0, 4, y1 - y0);
  c.fillStyle = C.textShade;
  c.fillRect(x - 1, y0, 4, y1 - y0);
  c.fillStyle = color;
  c.fillRect(x, y0, 2, y1 - y0);
  // Notch on the half's outer edge, pointing in (the axis band stays free for its labels).
  const edge = side < 0 ? y0 : y1;
  const tip = edge - side * 5;
  c.beginPath();
  c.moveTo(x - 3, edge);
  c.lineTo(x + 5, edge);
  c.lineTo(x + 1, tip);
  c.closePath();
  c.fill();
}

const LW = 280, LH = 40;
function drawLanes() {
  const c = lctx;
  backing(laneCanvas, c, LW, LH);
  c.clearRect(0, 0, LW, LH);
  const count = laneCount;
  if (!count) return;
  const cell = LW / count;
  const limit = releaseWindow || geometry.range;
  c.textBaseline = 'alphabetic';
  for (let i = 0; i < count; i++) {
    const x0 = Math.round(i * cell), x1 = Math.round((i + 1) * cell);
    const w = x1 - x0 - 3;
    const mid = x0 + Math.floor(w / 2);
    const lane = lanes[i];
    // Cell rail with a centre tick.
    c.fillStyle = C.hair;
    c.fillRect(x0, LH - 3, w, 1);
    c.fillStyle = C.hairStrong;
    c.fillRect(mid, LH - 7, 1, 7);
    c.font = FONT_12;
    c.textAlign = 'left';
    label(c, LANE_INDEX[i], x0, 10, C.dim);
    const mean = lane.n ? lane.sum / lane.n : null;
    c.textAlign = 'center';
    c.font = FONT_14;
    if (mean === null) {
      label(c, '—', mid + 0.5, 28, C.muted);
      continue;
    }
    const r = Math.round(mean);
    const color = r < 0 ? C.early : r > 0 ? C.late : C.fg;
    label(c, r === 0 ? '0' : `${r > 0 ? '+' : '−'}${Math.abs(r)}`, mid + 0.5, 28, color);
    // Deviation bar from the centre tick, full half-cell = release great.
    const len = Math.round(Math.min(1, Math.abs(mean) / limit) * (w / 2));
    if (len > 0) { c.fillStyle = color; c.fillRect(mean < 0 ? mid - len : mid + 1, LH - 4, len, 3); }
  }
}

// ---------------------------------------------------------------- sizing

const stage = $('stage');
fit(stage, SCREEN_W, SCREEN_H);
function resize() {
  stageScale = Math.min(innerWidth / SCREEN_W, innerHeight / SCREEN_H) || 1;
  invalidateCanvases();
}
addEventListener('resize', resize);
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener?.('change', resize);
resize();
document.fonts?.ready.then(invalidateCanvases);

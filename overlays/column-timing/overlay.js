// Copyright (c) 2026 18-LAB. MIT.
// Column timing: per-column osu!mania press (and hold release) timing from vosu's
// /play/keyHitErrors. Each column is a vertical channel strip, early above and late below,
// on a scale that is linear near zero and compresses towards the outer windows (so a few
// ms of bias is visible while 100s still fit). The attempt's distribution is a mirrored
// density profile coloured by judgement window; fresh hits flash as ticks that fade; a
// mean marker and ±1σ edge bars sit on top. Readouts give per-column mean (bias) and UR
// and call out the column with the highest UR and the most biased column.

import { subscribe, settings, fit, activeMode } from './vosu-overlay.js';

const W = 500;
const H = 460;
const AREA = 420;             // widest the column block may get (px)
const MAX_COLS = 18;          // dual-stage 9K+9K
const MIN_N = 20;             // presses a column needs before it can be called out
const MIN_BIAS = 1.5;         // ms; below this every column counts as balanced
const RELEASE_LENIENCE = 1.5; // osu!mania hold tails are judged on 1.5× windows
const TEXT_MS = 125;          // readouts refresh at most 8×/s so digits stay legible
const LAYER_MS = 120;         // density profiles redraw at most ~8×/s
const RING = 4096;
const BURST = 64;             // more new events than this in one frame = a snapshot, not live hits

// Per kind (0 press, 1 release): strip height, density bins, scale knee (ms).
const STRIP_H = [192, 56];
const BINS = [64, 24];
const KNEE = [10, 15];

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  keyHitErrors: '/play/keyHitErrors',
  hitWindow: '/beatmap/stats/hitWindow',
  keys: '/beatmap/stats/cs/converted',
  holds: '/beatmap/stats/objects/holds',
};

const $ = id => document.getElementById(id);
const dock = $('dock');
const panel = $('panel');
const chip = $('chip');
const chipText = $('chip-text');
const brand = $('brand');
const keysLabel = $('keys');
const body = $('body');
const message = $('message');
const foot = $('foot');
const rel = $('rel');
const rows = { cols: $('cols'), mean: $('mean'), ur: $('ur'), rmean: $('rmean') };
const factWeak = $('weak');
const factBias = $('bias');
const factAll = $('all');

fit($('stage'), W, H);

// ---------------------------------------------------------------- colours
const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const JUDGE = [
  token('--j-max', '#ebe8e1'), token('--j-great', '#7fa6cf'), token('--j-good', '#6fbf8e'),
  token('--j-ok', '#b8b5ad'), token('--j-meh', '#e8b04a'), token('--j-miss', '#ef5b4f'),
];
const FG = token('--fg', '#ebe8e1');
const ACCENT = token('--accent', '#ff963f');
const ZERO = 'rgb(235 232 225 / .34)';
const SUNKEN = 'rgb(11 12 13 / .66)';
const OUTLINE = 'rgb(11 12 13 / .9)';
const SIGMA = 'rgb(235 232 225 / .5)';
const RULER_GREAT = 'rgb(235 232 225 / .11)';
const RULER_GOOD = 'rgb(235 232 225 / .06)';
const PROFILE_FILL = 0.15;
const PROFILE_LINE = 0.8;
const KERNEL = [1, 6, 15, 20, 15, 6, 1];

// ---------------------------------------------------------------- per-kind state
function series(kind) {
  return {
    kind,
    bins: BINS[kind],
    count: new Float64Array(MAX_COLS), sum: new Float64Array(MAX_COLS), sq: new Float64Array(MAX_COLS),
    seen: new Int32Array(MAX_COLS), last: new Array(MAX_COLS).fill(undefined),
    density: new Uint32Array(MAX_COLS * BINS[kind]), peak: new Uint32Array(MAX_COLS),
    shownMean: new Float64Array(MAX_COLS), shownSd: new Float64Array(MAX_COLS),
    // Ring of live ticks (value, column, arrival time); head/tail are absolute counters.
    value: new Float32Array(RING), column: new Uint8Array(RING), time: new Float64Array(RING),
    head: 0, tail: 0,
    range: kind ? 180 : 120, scale: 1, binColour: [],
  };
}
const kinds = [series(0), series(1)];

let status = 'connecting';
let values = {};
let opts = { tickLifetime: 6, release: 'auto', numbers: true, brand: true, align: 'left' };
let columns = 0;
let colW = 64;
let gap = 4;
let ratio = 0;
let view = '';                // hidden | waiting | extension | strips
let showRelease = false;
let windows = [null, null];   // [perfect, great, good, ok, meh] max |error| per kind
let weak = -1;
let biased = -1;
let textDirty = true;
let lastText = -Infinity;
let layoutDirty = true;
let total = 0;
let raf = 0;
let lastFrame = 0;

// ---------------------------------------------------------------- scale and judgement
/** Error (ms) → position in [-1, 1]: linear near zero, logarithmic towards the range edge. */
function position(s, v) {
  const t = Math.asinh(v / KNEE[s.kind]) / s.scale;
  return t < -1 ? -1 : t > 1 ? 1 : t;
}

function judgement(kind, v) {
  const w = windows[kind];
  if (!w) return JUDGE[3];
  const e = v < 0 ? -v : v;
  for (let i = 0; i < 5; i++) if (w[i] > 0 && e <= w[i]) return JUDGE[i];
  return JUDGE[5];
}

function configureScale(s) {
  s.scale = Math.asinh(s.range / KNEE[s.kind]);
  s.binColour = Array.from({ length: s.bins }, (_, b) => {
    const t = ((b + 0.5) / s.bins) * 2 - 1;
    return judgement(s.kind, KNEE[s.kind] * Math.sinh(t * s.scale));
  });
  s.colourVersion = (s.colourVersion || 0) + 1;
}

function binOf(s, v) {
  const b = Math.floor((position(s, v) + 1) * 0.5 * s.bins);
  return b >= s.bins ? s.bins - 1 : b;
}

// ---------------------------------------------------------------- data
function clearColumn(s, c) {
  s.count[c] = s.sum[c] = s.sq[c] = 0;
  s.density.fill(0, c * s.bins, (c + 1) * s.bins);
  s.peak[c] = 0;
}

function resetSeries(s) {
  for (let c = 0; c < MAX_COLS; c++) clearColumn(s, c);
  s.seen.fill(0); s.last.fill(undefined);
  s.shownMean.fill(0); s.shownSd.fill(0);
  s.head = s.tail = 0;
  s.layerDirty = true;
}

function add(s, c, v) {
  if (!s.count[c]) { s.shownMean[c] = v; s.shownSd[c] = 0; }
  s.count[c]++; s.sum[c] += v; s.sq[c] += v * v;
  const i = c * s.bins + binOf(s, v);
  if (++s.density[i] > s.peak[c]) s.peak[c] = s.density[i];
}

/** Folds the new tail of each column into running stats and density; returns how many arrived. */
function ingest(s, lists, now, live) {
  let fresh = 0;
  const n = Math.min(lists.length, MAX_COLS);
  for (let c = 0; c < n; c++) {
    const list = Array.isArray(lists[c]) ? lists[c] : [];
    const len = list.length;
    let from = s.seen[c];
    let tick = live;
    // A shorter column or a changed last value means vosu rewrote that column (lazer moves
    // a tail's timing from press to release once its hold result arrives): recount it quietly.
    if (len < from || (from > 0 && list[from - 1] !== s.last[c])) {
      clearColumn(s, c);
      from = 0;
      tick = false;
    }
    for (let i = from; i < len; i++) {
      const v = list[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      add(s, c, v);
      fresh++;
      if (tick) {
        const r = s.head % RING;
        s.value[r] = v; s.column[r] = c; s.time[r] = now;
        s.head++;
      }
    }
    s.seen[c] = len;
    s.last[c] = len ? list[len - 1] : undefined;
  }
  if (fresh) s.layerDirty = true;
  return fresh;
}

function onKeyHitErrors(khe) {
  const press = khe && Array.isArray(khe.press) ? khe.press : [];
  const release = khe && Array.isArray(khe.release) ? khe.release : [];
  let next = 0;
  for (const list of press) next += Array.isArray(list) ? list.length : 0;
  for (const list of release) next += Array.isArray(list) ? list.length : 0;
  // Fewer events in total = a new attempt (retry, back to song select); a lazer press→release
  // move keeps the total. A large jump is a snapshot (joining mid-attempt): no live ticks.
  const restarted = next < total;
  if (restarted) { resetSeries(kinds[0]); resetSeries(kinds[1]); }
  const live = next - (restarted ? 0 : total) <= BURST;
  total = next;
  const now = performance.now();
  if (ingest(kinds[0], press, now, live) + ingest(kinds[1], release, now, live) || restarted) textDirty = true;
}

/** Re-bins every column from the current arrays (hit windows changed the scale). */
function rebin() {
  const khe = values[P.keyHitErrors];
  for (const s of kinds) {
    const lists = khe && Array.isArray(khe[s.kind ? 'release' : 'press']) ? khe[s.kind ? 'release' : 'press'] : [];
    for (let c = 0; c < MAX_COLS; c++) {
      s.density.fill(0, c * s.bins, (c + 1) * s.bins);
      s.peak[c] = 0;
      const list = Array.isArray(lists[c]) ? lists[c] : [];
      for (const v of list) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const i = c * s.bins + binOf(s, v);
        if (++s.density[i] > s.peak[c]) s.peak[c] = s.density[i];
      }
    }
    s.layerDirty = true;
  }
}

function setWindows(win) {
  const list = win && typeof win === 'object'
    ? [win.perfect, win.great, win.good, win.ok, win.meh].map(v => (typeof v === 'number' && v > 0 ? v : 0))
    : null;
  const press = list && list.some(Boolean) ? list : null;
  windows = [press, press && press.map(v => v * RELEASE_LENIENCE)];
  // The strip spans the OK (100) window; 50s and misses pin to the edge.
  const range = press ? (press[3] || press[4] || press[2] || 120) : 120;
  kinds[0].range = range;
  kinds[1].range = range * RELEASE_LENIENCE;
  configureScale(kinds[0]);
  configureScale(kinds[1]);
  rebin();
}

function columnCount() {
  const khe = values[P.keyHitErrors];
  let n = Math.round(Number(values[P.keys]));
  if (!Number.isFinite(n) || n < 1) n = 0;
  if (khe) n = Math.max(n, khe.press?.length || 0, khe.release?.length || 0);
  return Math.min(MAX_COLS, n || 4);
}

// ---------------------------------------------------------------- strips (canvas)
class Strip {
  constructor(canvas, s) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d', { alpha: true });
    this.s = s;
    this.xs = new Int32Array(MAX_COLS);
    this.ws = new Int32Array(MAX_COLS);
    this.edges = new Int32Array(s.bins + 1);
    this.smooth = new Float32Array(s.bins);
    this.layerAt = -Infinity;
    this.dirty = true;
  }

  layout() {
    const cssW = columns * colW + (columns - 1) * gap;
    const cssH = STRIP_H[this.s.kind];
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    this.canvas.width = this.layer.width = w;
    this.canvas.height = this.layer.height = h;
    for (let c = 0; c < columns; c++) {
      const x0 = Math.round(c * (colW + gap) * ratio);
      this.xs[c] = x0;
      this.ws[c] = Math.round((c * (colW + gap) + colW) * ratio) - x0;
    }
    const pad = Math.round(4 * ratio);
    this.mid = Math.round(h / 2);
    this.half = this.mid - pad;
    for (let b = 0; b <= this.s.bins; b++) this.edges[b] = Math.round(this.mid + ((b / this.s.bins) * 2 - 1) * this.half);
    this.thin = Math.max(1, Math.round(ratio));
    this.thick = Math.max(2, Math.round(2 * ratio));
    this.inset = Math.max(2, Math.round(4 * ratio));
    this.tickInset = Math.max(4, Math.round(Math.min(9, colW / 6) * ratio));
    this.s.layerDirty = true;
    this.dirty = true;
  }

  y(v) {
    return this.mid + position(this.s, v) * this.half;
  }

  /** Vertical gradient with a hard stop at every bin edge: the profile takes judgement colours. */
  gradient() {
    const s = this.s;
    if (this.grad && this.gradVersion === s.colourVersion && this.gradHeight === this.layer.height) return this.grad;
    const h = this.layer.height;
    const grad = this.lctx.createLinearGradient(0, 0, 0, h);
    for (let b = 0; b < s.bins; b++) {
      grad.addColorStop(Math.min(1, Math.max(0, this.edges[b] / h)), s.binColour[b]);
      grad.addColorStop(Math.min(1, Math.max(0, this.edges[b + 1] / h)), s.binColour[b]);
    }
    this.grad = grad;
    this.gradVersion = s.colourVersion;
    this.gradHeight = h;
    return grad;
  }

  /** Column wells, judgement-window edge marks and each column's density profile. */
  drawLayer() {
    const { lctx: g, layer, s } = this;
    g.clearRect(0, 0, layer.width, layer.height);
    const w = windows[s.kind];
    const rulers = [RULER_GREAT, RULER_GOOD];
    const smooth = this.smooth;
    const grad = this.gradient();
    g.lineJoin = 'round';
    g.lineWidth = this.thin;
    for (let c = 0; c < columns; c++) {
      const x = this.xs[c], cw = this.ws[c];
      g.fillStyle = SUNKEN;
      g.fillRect(x, 0, cw, layer.height);
      if (w) {
        // 300 and 200 window edges; the strip itself ends at the 100 window.
        for (let i = 1; i <= 2; i++) {
          if (!(w[i] > 0)) continue;
          g.fillStyle = rulers[i - 1];
          for (let sign = -1; sign <= 1; sign += 2) g.fillRect(x, Math.round(this.y(sign * w[i])), cw, this.thin);
        }
      }
      if (!s.peak[c]) continue;
      // 7-tap binomial smoothing, then a mirrored outline normalised to the column's peak.
      const base = c * s.bins;
      let top = 0;
      for (let b = 0; b < s.bins; b++) {
        let acc = 0, weight = 0;
        for (let o = -3; o <= 3; o++) {
          const j = b + o;
          if (j < 0 || j >= s.bins) continue;
          const k = KERNEL[o + 3];
          acc += k * s.density[base + j];
          weight += k;
        }
        smooth[b] = acc / weight;
        if (smooth[b] > top) top = smooth[b];
      }
      let lo = 0, hi = s.bins - 1;
      const floor = top * 0.015;
      while (lo < hi && smooth[lo] <= floor) lo++;
      while (hi > lo && smooth[hi] <= floor) hi--;
      const centre = x + cw / 2;
      const reach = (cw - 2 * this.inset) / 2;
      g.beginPath();
      g.moveTo(centre, this.edges[lo]);
      for (let b = lo; b <= hi; b++) {
        g.lineTo(centre + reach * (smooth[b] / top) ** 0.75, (this.edges[b] + this.edges[b + 1]) / 2);
      }
      g.lineTo(centre, this.edges[hi + 1]);
      for (let b = hi; b >= lo; b--) {
        g.lineTo(centre - reach * (smooth[b] / top) ** 0.75, (this.edges[b] + this.edges[b + 1]) / 2);
      }
      g.closePath();
      g.fillStyle = grad;
      g.strokeStyle = grad;
      g.globalAlpha = PROFILE_FILL;
      g.fill();
      g.globalAlpha = PROFILE_LINE;
      g.stroke();
      g.globalAlpha = 1;
    }
    s.layerDirty = false;
  }

  /** Draws one frame; returns true while something on the strip is still moving. */
  render(now, dt) {
    const s = this.s;
    let busy = false;
    if (s.layerDirty) {
      if (now - this.layerAt >= LAYER_MS) { this.drawLayer(); this.layerAt = now; this.dirty = true; } else busy = true;
    }

    // Ease the mean marker and σ bars towards the running statistics.
    const k = 1 - Math.exp(-dt / 90);
    for (let c = 0; c < columns; c++) {
      const n = s.count[c];
      if (!n) continue;
      const mean = s.sum[c] / n;
      const sd = Math.sqrt(Math.max(0, s.sq[c] / n - mean * mean));
      const dm = mean - s.shownMean[c], ds = sd - s.shownSd[c];
      if (Math.abs(dm) > 0.02 || Math.abs(ds) > 0.02) {
        s.shownMean[c] += dm * k;
        s.shownSd[c] += ds * k;
        busy = true;
        this.dirty = true;
      } else if (dm || ds) {
        s.shownMean[c] = mean;
        s.shownSd[c] = sd;
        this.dirty = true;
      }
    }

    const life = Math.min(30, Math.max(0.5, opts.tickLifetime)) * 1000;
    while (s.tail < s.head && (s.head - s.tail > RING || now - s.time[s.tail % RING] >= life)) { s.tail++; this.dirty = true; }
    const alive = s.tail < s.head;
    if (!alive && !this.dirty) return busy;

    const { ctx: g, canvas } = this;
    g.globalAlpha = 1;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(this.layer, 0, 0);

    g.fillStyle = ZERO;
    for (let c = 0; c < columns; c++) g.fillRect(this.xs[c], this.mid, this.ws[c], this.thin);

    // Live ticks, newest brightest.
    for (let i = s.tail; i < s.head; i++) {
      const r = i % RING;
      const age = now - s.time[r];
      const p = age <= 0 ? 0 : age / life;
      const a = (1 - p) * (1 - p);
      if (a <= 0.004) continue;
      const c = s.column[r], v = s.value[r];
      g.globalAlpha = a;
      g.fillStyle = judgement(s.kind, v);
      g.fillRect(this.xs[c] + this.tickInset, Math.round(this.y(v) - this.thick / 2), this.ws[c] - 2 * this.tickInset, this.thick);
    }
    g.globalAlpha = 1;

    // ±1σ edge bars, then the mean marker: a full-width rule with inward notches at both edges.
    const nh = 4 * ratio, nd = 5 * ratio;
    for (let c = 0; c < columns; c++) {
      if (!s.count[c]) continue;
      const x = this.xs[c], cw = this.ws[c];
      const m = s.shownMean[c];
      const hot = s.kind === 0 && c === weak;
      if (s.count[c] > 1) {
        const top = Math.round(this.y(m - s.shownSd[c])), bottom = Math.round(this.y(m + s.shownSd[c]));
        const bar = hot ? this.thick : this.thin;
        g.fillStyle = hot ? ACCENT : SIGMA;
        g.fillRect(x, top, bar, bottom - top);
        g.fillRect(x + cw - bar, top, bar, bottom - top);
      }
      const y = Math.round(this.y(m) - this.thick / 2);
      const yc = y + this.thick / 2;
      g.fillStyle = OUTLINE;
      g.fillRect(x, y - this.thin, cw, this.thick + 2 * this.thin);
      g.fillStyle = hot ? ACCENT : FG;
      g.fillRect(x, y, cw, this.thick);
      g.beginPath();
      g.moveTo(x, yc - nh); g.lineTo(x + nd, yc); g.lineTo(x, yc + nh);
      g.moveTo(x + cw, yc - nh); g.lineTo(x + cw - nd, yc); g.lineTo(x + cw, yc + nh);
      g.fill();
    }
    this.dirty = false;
    return busy || alive;
  }
}

const strips = [new Strip($('press'), kinds[0]), new Strip($('release'), kinds[1])];
configureScale(kinds[0]);
configureScale(kinds[1]);

// ---------------------------------------------------------------- inputs
subscribe(Object.values(P), (v, changed) => {
  values = v;
  if (changed.has(P.hitWindow)) setWindows(values[P.hitWindow]);
  if (changed.has(P.keyHitErrors)) onKeyHitErrors(values[P.keyHitErrors]);
  if (changed.has(P.state) || changed.has(P.playMode) || changed.has(P.settingsMode) || changed.has(P.keys)
    || changed.has(P.holds) || changed.has(P.keyHitErrors)) layoutDirty = true;
  wake();
}, {
  onStatus(next) {
    if (next === status) return;
    status = next;
    layoutDirty = true;
    wake();
  },
});

settings({ ...opts }, next => {
  opts = next;
  strips[0].dirty = strips[1].dirty = true;
  layoutDirty = textDirty = true;
  wake();
});

addEventListener('resize', () => { layoutDirty = true; wake(); });

// ---------------------------------------------------------------- layout (rare: key count, view, settings)
const cells = { cols: [], mean: [], ur: [], rmean: [] };
const shown = { mean: [], ur: [], rmean: [], weak: '', bias: '', all: '', keys: '', chip: '' };

function setHidden(el, hidden) { if (el.hidden !== hidden) el.hidden = hidden; }
function setClass(el, name, on) { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); }
function setText(el, key, i, text) {
  if (shown[key][i] === text) return;
  shown[key][i] = text;
  el.textContent = text;
}
function setOnce(el, key, text) {
  if (shown[key] === text) return;
  shown[key] = text;
  el.textContent = text;
}

function makeCells(row, n) {
  while (row.children.length - 1 > n) row.lastChild.remove();
  while (row.children.length - 1 < n) row.append(document.createElement('b'));
  return Array.from(row.children).slice(1);
}

function applyLayout() {
  layoutDirty = false;
  setClass(dock, 'is-right', opts.align === 'right');
  setHidden(brand, !opts.brand);

  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  let next;
  if (status !== 'live') next = 'hidden';
  else if (state === undefined) next = 'waiting';
  else if (mode !== 'mania') next = 'hidden';
  else if (values[P.keyHitErrors] === undefined) next = 'extension';
  else if (state === 2 || state === 7 || total > 0) next = 'strips';
  else next = 'idle';  // song select and menus: no attempt to show, so stay compact

  setClass(chip, 'is-hidden', status === 'live');
  if (chip.dataset.state !== status) chip.dataset.state = status;
  setOnce(chipText, 'chip', status === 'offline' ? 'vosu offline' : 'Connecting to vosu');
  setClass(panel, 'is-hidden', next === 'hidden');

  if (next !== view) {
    view = next;
    if (view === 'extension') {
      const code = document.createElement('code');
      code.textContent = 'ENABLE_MANIA_KEY_HIT_ERRORS';
      message.replaceChildren('Needs ', code, ' in vosu');
    } else if (view === 'waiting') {
      message.replaceChildren('— Waiting for osu!');
    } else if (view === 'idle') {
      message.replaceChildren('— Waiting for play');
    }
    if (view !== 'hidden') {  // a fading-out panel keeps its last content
      setHidden(message, view === 'strips');
      setHidden(body, view !== 'strips');
      setHidden(foot, view !== 'strips');
    }
    strips[0].dirty = strips[1].dirty = true;
    textDirty = true;
  }

  const n = mode === 'mania' ? columnCount() : 0;
  setOnce(keysLabel, 'keys', n && view !== 'waiting' ? `${n}K${state === 7 ? ' · final' : ''}` : '');
  if (view !== 'strips') return;

  const wantRelease = opts.release === 'always'
    || (opts.release === 'auto' && (Number(values[P.holds]) > 0 || kinds[1].count.some(Boolean)));
  setHidden(rel, !wantRelease);
  setHidden(rows.mean, !opts.numbers);
  setHidden(rows.ur, !opts.numbers);
  setHidden(rows.rmean, !opts.numbers);
  if (wantRelease !== showRelease) { showRelease = wantRelease; strips[1].dirty = true; }

  const nextRatio = (window.devicePixelRatio || 1) * (Math.min(innerWidth / W, innerHeight / H) || 1);
  if (n === columns && nextRatio === ratio) return;
  ratio = nextRatio;
  if (n !== columns) {
    columns = n;
    gap = n > 10 ? 2 : 4;
    colW = Math.max(n > 10 ? 18 : 24, Math.min(64, Math.floor((AREA - (n - 1) * gap) / n)));
    panel.style.setProperty('--n', n);
    panel.style.setProperty('--col', `${colW}px`);
    panel.style.setProperty('--gap', `${gap}px`);
    setClass(panel, 'dense', colW < 34);
    cells.cols = makeCells(rows.cols, n);
    cells.cols.forEach((el, i) => { el.textContent = String(i + 1); });
    cells.mean = makeCells(rows.mean, n);
    cells.ur = makeCells(rows.ur, n);
    cells.rmean = makeCells(rows.rmean, n);
    shown.mean = []; shown.ur = []; shown.rmean = [];
    weak = biased = -2;
  }
  strips[0].layout();
  strips[1].layout();
  textDirty = true;
}

// ---------------------------------------------------------------- readouts
/** Signed ms, − early / + late; whole ms when columns are too narrow for a decimal. */
function signed(v) {
  const digits = colW < 34 ? 0 : 1;
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v < 0 ? '−' : '+'}${text}`;
}

function columnStats(s, c) {
  const n = s.count[c];
  const mean = n ? s.sum[c] / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, s.sq[c] / n - mean * mean)) : 0;
  return { n, mean, ur: sd * 10 };
}

function writeText() {
  const press = kinds[0], release = kinds[1];
  let nextWeak = -1, nextBias = -1, eligible = 0, worstUr = -1, worstBias = MIN_BIAS;
  let n = 0, sum = 0, sq = 0;
  for (let c = 0; c < columns; c++) {
    const p = columnStats(press, c);
    n += press.count[c] + release.count[c];
    sum += press.sum[c] + release.sum[c];
    sq += press.sq[c] + release.sq[c];
    if (p.n >= MIN_N) {
      eligible++;
      if (p.ur > worstUr) { worstUr = p.ur; nextWeak = c; }
      if (Math.abs(p.mean) >= worstBias) { worstBias = Math.abs(p.mean); nextBias = c; }
    }
    setText(cells.mean[c], 'mean', c, p.n ? signed(p.mean) : '—');
    setText(cells.ur[c], 'ur', c, p.n > 1 ? String(Math.round(p.ur)) : '—');
    setClass(cells.mean[c], 'is-empty', !p.n);
    setClass(cells.ur[c], 'is-empty', p.n < 2);
    const r = columnStats(release, c);
    setText(cells.rmean[c], 'rmean', c, r.n ? signed(r.mean) : '—');
    setClass(cells.rmean[c], 'is-empty', !r.n);
  }
  if (eligible < 2) nextWeak = nextBias = -1;

  if (nextWeak !== weak) {
    weak = nextWeak;
    for (let c = 0; c < columns; c++) {
      setClass(cells.cols[c], 'is-weak', c === weak);
      setClass(cells.ur[c], 'is-weak', c === weak);
    }
    strips[0].dirty = true;
  }
  const biasMean = nextBias >= 0 ? columnStats(press, nextBias).mean : 0;
  if (nextBias !== biased || (nextBias >= 0 && cells.mean[nextBias].classList.contains('is-early') !== biasMean < 0)) {
    biased = nextBias;
    for (let c = 0; c < columns; c++) {
      setClass(cells.mean[c], 'is-early', c === biased && biasMean < 0);
      setClass(cells.mean[c], 'is-late', c === biased && biasMean >= 0);
    }
  }
  setOnce(factWeak, 'weak', weak >= 0 ? `Col ${weak + 1} · ${Math.round(columnStats(press, weak).ur)}` : '—');
  setOnce(factBias, 'bias', biased >= 0
    ? `Col ${biased + 1} · ${Math.abs(biasMean).toFixed(1)} ms ${biasMean < 0 ? 'early' : 'late'}`
    : eligible >= 2 ? 'Balanced' : '—');
  const mean = n ? sum / n : 0;
  setOnce(factAll, 'all', n > 1 ? String(Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 10)) : '—');
  setClass(factWeak, 'is-weak', weak >= 0);
}

// ---------------------------------------------------------------- frame loop
function wake() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
  lastFrame = now;
  if (layoutDirty) applyLayout();
  let busy = false;
  if (view === 'strips' && columns) {
    if (strips[0].render(now, dt)) busy = true;
    if (showRelease && strips[1].render(now, dt)) busy = true;
    if (textDirty) {
      if (now - lastText >= TEXT_MS) { writeText(); lastText = now; textDirty = false; } else busy = true;
    }
  }
  if (busy) wake(); else lastFrame = 0;
}

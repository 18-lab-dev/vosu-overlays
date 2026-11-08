// Copyright (c) 2026 18-LAB. MIT.
// Tap meter: osu! stream speed, consistency, alternation and finger balance from vosu's keys.all.
import { subscribe, settings, fit, activeMode, isPlaying } from './vosu-overlay.js';

const STAGE_W = 360;
const STAGE_H = 308;
const RING = 128;          // taps kept; ≥ comb bars and ≥ the largest window
const PITCH = 6;           // CSS px per comb bar (4 bar + 2 gap)
const RUN_GAP_MS = 250;    // a slower real-time interval ends a stream run (= 60 BPM at 1/4)
const MIN_TAPS = 4;        // taps a run needs before it has a speed
const MAX_FILL = 16;       // most taps per key per frame we spread between known edges
const STALE_MS = 700;      // readout dims this long after the last tap
const RESULTS = 7;
const BPM_PER_MS = 15000;  // 1/4 convention: BPM = 15000 / interval

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  keys: '/keys/all', rate: '/play/mods/rate', mods: '/play/mods/array',
  h300: '/play/hits/300', h100: '/play/hits/100', h50: '/play/hits/50', h0: '/play/hits/0', hsb: '/play/hits/sliderBreaks',
  r100: '/resultsScreen/hits/100', r50: '/resultsScreen/hits/50', r0: '/resultsScreen/hits/0', rsb: '/resultsScreen/hits/sliderBreaks',
};

const $ = id => document.getElementById(id);
const panel = $('meter');
const el = {
  brand: $('brand'), status: $('status'), statusText: $('status-text'), live: $('live'),
  bpm: $('bpm'), interval: $('interval'), peak: $('peak'), peakSub: $('peak-sub'), notice: $('notice'),
  sigma: $('sigma'), alt: $('alt'), balanceCell: $('balance-cell'), balance: $('balance'), split: $('split'),
  judgements: $('judgements'), h100: $('h100'), h50: $('h50'), h0: $('h0'), hsb: $('hsb'),
};
const canvas = $('comb');
const ctx = canvas.getContext('2d', { alpha: true });

// ---------------------------------------------------------------- tap ring
const tapTime = new Float64Array(RING);  // real-time ms (gameplay ms / rate); NaN = unknown
const tapKey = new Uint8Array(RING);     // 0 = K1 (B1), 1 = K2 (B2)
const tapExact = new Uint8Array(RING);   // 1 = reported edge time, 0 = spread between edges
const tapStart = new Uint8Array(RING);   // 1 = first tap of a run (no interval bar)
let head = 0;
let size = 0;
let runLen = 0;
let serial = 0;                          // taps ever pushed; locates the readout's window in the comb

// Scratch for one frame's new taps (≤ MAX_FILL per key), sorted by time before entering the ring.
const newT = new Float64Array(MAX_FILL * 2);
const newK = new Uint8Array(MAX_FILL * 2);
const newE = new Uint8Array(MAX_FILL * 2);

const prevCount = [0, 0];
let haveBaseline = false;
let lastTapTime = NaN;

// ---------------------------------------------------------------- derived state
const stat = { bpm: NaN, interval: NaN, sigma: NaN, alt: NaN, taps: 0, serial: 0 };
let peak = NaN;
let fresh = false;
let staleTimer = 0;
const keyTotals = [NaN, NaN];
const hits = { h100: undefined, h50: undefined, h0: undefined, hsb: undefined };
let hasPlay = false;
let wasPlaying = false;
let socketState = 'connecting';
const view = { hidden: false, status: 'connecting', statusText: 'Connecting', notice: '' };
let config = { windowTaps: 16, showBalance: true, showJudgements: true, showBrand: true };
let combDirty = true;

const at = offset => (head - 1 - offset + RING * 2) % RING; // 0 = newest
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
function hasMod(mods, acronym) {
  if (!Array.isArray(mods)) return false;
  for (const mod of mods) if (mod?.acronym === acronym) return true;
  return false;
}

function resetAttempt() {
  head = 0; size = 0; runLen = 0;
  haveBaseline = false;
  lastTapTime = NaN;
  stat.bpm = stat.interval = stat.sigma = stat.alt = NaN; stat.taps = 0; stat.serial = 0;
  peak = NaN;
  fresh = false;
  clearTimeout(staleTimer);
  keyTotals[0] = keyTotals[1] = NaN;
  hits.h100 = hits.h50 = hits.h0 = hits.hsb = undefined;
  combDirty = true;
}

/** Turns count edges since the previous frame into timed taps (several taps may land in one frame). */
function ingestKeys(all, rate) {
  const c0 = number(all[0]?.count) ?? 0, c1 = number(all[1]?.count) ?? 0;
  if (haveBaseline && (c0 < prevCount[0] || c1 < prevCount[1])) {
    // Retry or rewind restarts the attempt.
    resetAttempt();
    haveBaseline = true;
    keyTotals[0] = prevCount[0] = c0; keyTotals[1] = prevCount[1] = c1;
    return true;
  }
  keyTotals[0] = c0; keyTotals[1] = c1;
  if (!haveBaseline) {
    // Attaching mid-attempt: take the current state as the baseline without inventing presses.
    prevCount[0] = c0; prevCount[1] = c1;
    haveBaseline = true;
    return false;
  }
  let n = 0;
  const floor = lastTapTime;
  for (let key = 0; key < 2; key++) {
    const delta = keyTotals[key] - prevCount[key];
    prevCount[key] = keyTotals[key];
    if (delta <= 0) continue;
    const pressedAt = number(all[key]?.pressedAt);
    const edge = pressedAt === undefined ? NaN : pressedAt / rate;
    const span = edge - floor;
    if (delta > MAX_FILL || !Number.isFinite(floor) || !Number.isFinite(edge) || span < 0 || span / delta > RUN_GAP_MS) {
      // Lost edges we cannot place honestly (too many, no reference, or not a stream): keep the
      // reported latest tap and break the run before it.
      if (delta > MAX_FILL || !Number.isFinite(edge)) lastTapTime = NaN;
      newT[n] = edge; newK[n] = key; newE[n] = 1; n++;
      continue;
    }
    // The reported edge is the last of `delta` taps; earlier ones are spread evenly back to the
    // previous tap, which keeps the window's mean interval (and so its BPM) exact.
    for (let k = 1; k <= delta; k++) {
      newT[n] = k === delta ? edge : floor + span * k / delta;
      newK[n] = key; newE[n] = k === delta ? 1 : 0; n++;
    }
  }
  if (!n) return false;
  // Insertion sort by time (NaN last); n is tiny.
  for (let i = 1; i < n; i++) {
    const t = newT[i], k = newK[i], e = newE[i];
    let j = i - 1;
    while (j >= 0 && (Number.isNaN(newT[j]) || newT[j] > t)) { newT[j + 1] = newT[j]; newK[j + 1] = newK[j]; newE[j + 1] = newE[j]; j--; }
    newT[j + 1] = t; newK[j + 1] = k; newE[j + 1] = e;
  }
  for (let i = 0; i < n; i++) pushTap(newT[i], newK[i], newE[i]);
  return true;
}

function pushTap(time, key, exact) {
  const prev = at(0);
  const prevTime = size ? tapTime[prev] : NaN;
  const forcedBreak = !Number.isFinite(lastTapTime);
  const gap = time - prevTime;
  const joins = !forcedBreak && Number.isFinite(gap) && gap >= 0 && gap <= RUN_GAP_MS;
  runLen = joins ? runLen + 1 : 1;
  tapTime[head] = time;
  tapKey[head] = key;
  tapExact[head] = exact;
  tapStart[head] = joins ? 0 : 1;
  head = (head + 1) % RING;
  if (size < RING) size++;
  serial++;
  lastTapTime = Number.isFinite(time) ? time : NaN;
}

/** Window stats over the newest min(window, run) taps; O(window), run only when taps arrive. */
function computeStats() {
  const m = Math.min(config.windowTaps, runLen, size);
  if (m < MIN_TAPS) { fresh = false; return; }
  const newest = at(0), oldest = at(m - 1);
  const span = tapTime[newest] - tapTime[oldest];
  if (!(span > 0)) return;
  stat.bpm = BPM_PER_MS * (m - 1) / span;
  stat.interval = span / (m - 1);
  stat.taps = m;
  stat.serial = serial;
  let n = 0, sum = 0, sumSq = 0, switches = 0;
  for (let k = 0; k < m - 1; k++) {
    const a = at(k), b = at(k + 1);
    if (tapKey[a] !== tapKey[b]) switches++;
    if (tapExact[a] && tapExact[b]) {
      const d = tapTime[a] - tapTime[b];
      n++; sum += d; sumSq += d * d;
    }
  }
  stat.alt = 100 * switches / (m - 1);
  const mean = n ? sum / n : 0;
  stat.sigma = n >= 3 ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : NaN;
  if (runLen >= config.windowTaps && !(stat.bpm <= peak)) peak = stat.bpm;
  fresh = true;
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => { fresh = false; combDirty = true; markDirty(); }, STALE_MS);
}

// ---------------------------------------------------------------- data
function onFrame(v, changed) {
  const state = v[P.state];
  const mode = activeMode(state, v[P.playMode], v[P.settingsMode]);
  const playing = isPlaying(state) && mode === 'osu';
  if (playing && !wasPlaying) resetAttempt();
  wasPlaying = playing;

  const all = v[P.keys];
  if (playing) {
    hasPlay = true;
    if (Array.isArray(all) && changed.has(P.keys)) {
      const rate = number(v[P.rate]) > 0 ? v[P.rate] : 1;
      if (ingestKeys(all, rate)) {
        computeStats();
        combDirty = true;
      }
    }
    hits.h100 = number(v[P.h100]); hits.h50 = number(v[P.h50]); hits.h0 = number(v[P.h0]); hits.hsb = number(v[P.hsb]);
  } else if (state === RESULTS && mode === 'osu') {
    // Results hold the attempt's final values; the results screen's own counts win when present.
    hits.h100 = number(v[P.r100]) ?? hits.h100; hits.h50 = number(v[P.r50]) ?? hits.h50;
    hits.h0 = number(v[P.r0]) ?? hits.h0; hits.hsb = number(v[P.rsb]) ?? hits.hsb;
  }

  let notice = '';
  if (playing) {
    // Every judged circle or slider head takes a press, so far fewer counted presses than hits
    // means vosu's key updates are switched off (they stop after the opening 150 ms).
    const hit = (number(v[P.h300]) ?? 0) + (hits.h100 ?? 0) + (hits.h50 ?? 0);
    if (hasMod(v[P.mods], 'RX')) notice = 'Relax: no taps to measure';
    else if (!Array.isArray(all)) notice = 'Tap timing needs vosu keys.all';
    else if (hit >= 30 && !(keyTotals[0] + keyTotals[1] >= hit * 0.5)) notice = 'Enable ENABLE_KEY_OVERLAY in vosu';
  }
  if (notice !== view.notice) combDirty = true;

  const results = state === RESULTS;
  view.hidden = mode !== null && mode !== 'osu';
  view.status = playing ? 'live' : state === undefined ? 'idle' : results || hasPlay ? 'held' : 'idle';
  view.statusText = playing ? 'Live' : state === undefined ? 'No game' : results ? 'Result' : hasPlay ? 'Last play' : 'Idle';
  view.notice = notice;
  markDirty();
}

function onStatus(state) {
  socketState = state;
  if (state !== 'live') haveBaseline = false; // counts across a gap would smear taps over it
  markDirty();
}

// ---------------------------------------------------------------- render
let raf = 0;
function markDirty() { if (!raf) raf = requestAnimationFrame(render); }

const shown = new WeakMap();
function text(node, value) {
  if (shown.get(node) === value) return;
  shown.set(node, value);
  node.textContent = value;
  attr(node, 'data-empty', value === '—');
}
function attr(node, name, on) {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on);
}

const fmt = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const count = value => (value === undefined ? '—' : String(value));

function render() {
  raf = 0;
  const offline = socketState !== 'live';
  const viewName = offline ? 'chip' : 'full';
  if (panel.dataset.view !== viewName) panel.dataset.view = viewName;
  attr(panel, 'data-hidden', !offline && view.hidden);
  const status = offline ? socketState : view.status;
  if (el.status.dataset.state !== status) el.status.dataset.state = status;
  text(el.statusText, socketState === 'offline' ? 'vosu offline' : socketState === 'connecting' ? 'Connecting' : view.statusText);
  if (offline || view.hidden) return;

  attr(el.live, 'data-stale', !(fresh && view.status === 'live'));
  text(el.bpm, fmt(stat.bpm));
  text(el.interval, Number.isFinite(stat.interval) ? `${stat.interval.toFixed(1)} ms · ${stat.taps} taps`
    : view.status === 'live' ? 'no stream yet' : hasPlay ? 'no stream this play' : '');
  text(el.peak, fmt(peak));
  text(el.peakSub, `over ${config.windowTaps} taps`);
  text(el.sigma, fmt(stat.sigma, 1));
  text(el.alt, fmt(stat.alt));

  const total = keyTotals[0] + keyTotals[1];
  const share = total > 0 ? keyTotals[0] / total : NaN;
  const left = Math.round(share * 100);
  text(el.balance, Number.isFinite(share) ? `${left} : ${100 - left}` : '—');
  const scale = Number.isFinite(share) ? share.toFixed(3) : '0';
  if (shown.get(el.split) !== scale) { shown.set(el.split, scale); el.split.style.transform = `scaleX(${scale})`; }

  text(el.h100, count(hits.h100));
  text(el.h50, count(hits.h50));
  text(el.h0, count(hits.h0));
  text(el.hsb, count(hits.hsb));

  attr(el.notice, 'hidden', !view.notice);
  text(el.notice, view.notice);
  if (combDirty) { combDirty = false; drawComb(); }
}

// ---------------------------------------------------------------- comb canvas
let colors = null;
function palette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: get('--fg', '#ebe8e1'), dim: get('--fg-dim', '#b8b5ad'), muted: get('--muted', '#7e8288'),
    accent: get('--accent', '#ff963f'), rule: get('--rule-strong', '#3b3f45'), grid: get('--grid-major', 'rgb(235 232 225 / .06)'),
  };
}

let dpr = 1;
new ResizeObserver(([entry]) => {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(entry.contentRect.width * dpr);
  const height = Math.round(entry.contentRect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  combDirty = true;
  markDirty();
}).observe(canvas);

function drawComb() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!w || !h || view.notice) return;
  colors ??= palette();
  const line = Math.max(1, Math.round(dpr));
  const mid = Math.round(h / 2 - line / 2);               // axis row
  const reach = mid - line - Math.round(5 * dpr);         // tallest bar, each side
  const up = level => mid - line - level;                 // K1 bar top (bars stop one hairline off the axis)
  const down = level => mid + 2 * line + level - line;    // K2 bar bottom row
  const pitch = Math.max(2, Math.round(PITCH * dpr));
  const bar = pitch - Math.max(1, Math.round(2 * dpr));
  const slots = Math.min(RING - 1, Math.floor(w / pitch));
  const count = Math.min(size, slots);

  // Scale: 100-BPM steps that clear the fastest visible bar and the peak.
  let top = Number.isFinite(peak) ? peak : 0;
  for (let k = 0; k < count; k++) {
    const i = at(k);
    if (tapStart[i]) continue;
    const gap = tapTime[i] - tapTime[at(k + 1)];
    if (gap > 0) top = Math.max(top, Math.min(600, BPM_PER_MS / gap));
  }
  const scale = Math.max(300, Math.ceil(top * 1.05 / 100) * 100);
  const y = bpm => Math.max(line, Math.round(Math.min(1, bpm / scale) * reach));

  ctx.fillStyle = colors.grid;
  for (let g = 100; g < scale; g += 100) {
    ctx.fillRect(0, up(y(g)), w, line);
    ctx.fillRect(0, down(y(g)), w, line);
  }
  ctx.fillStyle = colors.rule;
  ctx.fillRect(0, mid, w, line);

  // Bars the readout averages (it may describe an earlier run while a new one warms up).
  const live = fresh && view.status === 'live';
  const from = Number.isFinite(stat.bpm) ? serial - stat.serial : slots;
  const to = from + stat.taps - 1;
  const tick = Math.round(4 * dpr);
  for (let k = 0; k < count; k++) {
    const i = at(k);
    const right = w - k * pitch;
    if (tapStart[i]) {
      // Run break: a short tick across the axis.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = colors.muted;
      ctx.fillRect(right - Math.round((bar + line) / 2), mid - tick, line, 2 * tick + line);
      continue;
    }
    const gap = tapTime[i] - tapTime[at(k + 1)];
    const height = y(gap > 0 ? BPM_PER_MS / gap : scale);
    const inWindow = k >= from && k < to;
    ctx.fillStyle = k === 0 && live ? colors.accent : inWindow ? colors.fg : colors.muted;
    ctx.globalAlpha = (inWindow ? 0.88 : 0.5) * (tapExact[i] && tapExact[at(k + 1)] ? 1 : 0.5);
    if (tapKey[i] === 0) ctx.fillRect(right - bar, up(height), bar, height);
    else ctx.fillRect(right - bar, mid + 2 * line, bar, height);
  }
  ctx.globalAlpha = 1;

  // Window mean: a hairline at the readout's speed spanning the bars it averages, mirrored.
  if (to > from && from < slots) {
    const level = y(stat.bpm);
    const x0 = Math.max(0, w - Math.min(slots, to) * pitch);
    const x1 = w - from * pitch;
    ctx.fillStyle = live ? colors.accent : colors.dim;
    ctx.globalAlpha = live ? 1 : 0.55;
    ctx.fillRect(x0, up(level), x1 - x0, line);
    ctx.fillRect(x0, down(level), x1 - x0, line);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- wiring
settings(config, next => {
  const windowTaps = Math.round(Math.min(64, Math.max(MIN_TAPS, next.windowTaps)));
  if (windowTaps !== config.windowTaps) {
    peak = NaN; // a peak is only comparable with peaks over the same window
    config = { ...next, windowTaps };
    computeStats();
  } else {
    config = { ...next, windowTaps };
  }
  el.brand.hidden = !config.showBrand;
  el.balanceCell.hidden = !config.showBalance;
  el.judgements.hidden = !config.showJudgements;
  combDirty = true;
  markDirty();
});

fit(document.getElementById('stage'), STAGE_W, STAGE_H);
subscribe(Object.values(P), onFrame, { onStatus });

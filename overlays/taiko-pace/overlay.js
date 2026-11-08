// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko accuracy pace: how far the attempt can still go, and how many OKs or misses the chosen
// target accuracy can still absorb. The page is the overlay's own box (hosts place and size it);
// the layout follows the box: a two-row strip, a one-line row for short boxes, or a column.
import { subscribe, settings, activeMode, mapPalette, applyPalette } from './vosu-overlay.js';

const EPS = 1e-9;

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum',
  great: '/play/hits/300',
  ok: '/play/hits/100',
  miss: '/play/hits/0',
  ur: '/play/unstableRate',
  pp: '/play/pp/current',
  fc: '/play/pp/fc',
  // Taiko max combo is the number of hit notes (drumrolls and swells excluded), computed for the
  // ruleset being played, so it is also right for converts. objects/circles is the raw fallback.
  notes: '/beatmap/stats/maxCombo',
  circles: '/beatmap/stats/objects/circles',
};

/**
 * Accuracy pace for osu!taiko, where a note scores GREAT 1, OK ½, MISS 0.
 * `target` is a fraction (0.99). Budgets assume every other remaining note is a GREAT; a miss
 * costs twice what an OK does. Budgets are null once the target is out of reach.
 * The result is written into `out` (reused by the render path) and returned.
 */
export function pace(great, ok, miss, notes, target, out = {}) {
  const judged = great + ok + miss;
  const total = Math.max(notes, judged);
  const remaining = total - judged;
  const points = great + ok / 2;
  const slack = points + remaining - target * total; // GREAT-equivalents above the target
  const lost = slack < -EPS;
  out.judged = judged;
  out.remaining = remaining;
  out.accuracy = judged ? points / judged : 1;
  out.max = total ? (points + remaining) / total : 1;
  out.lost = lost;
  // `| 0` is exact here (|budget| <= notes) and keeps the integers Smis, so storing them allocates nothing.
  out.okBudget = lost ? null : Math.min(remaining, Math.floor(2 * slack + EPS) | 0);
  out.missBudget = lost ? null : Math.min(remaining, Math.floor(slack + EPS) | 0);
  return out;
}

const $ = id => document.getElementById(id);
const stage = $('stage');
const budget = $('budget');
const okBudgetBox = $('okBudget').parentElement;
const urCell = $('urCell');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const ppCells = [...document.querySelectorAll('[data-pp]')];

// Text slots. Each remembers the string it last wrote and the number it last formatted (`key`), so a
// data message formats only numbers that changed and touches the DOM only for strings that differ.
const T = Object.fromEntries(['chipText', 'acc', 'max', 'target', 'budgetLabel', 'okBudget', 'budgetUnit', 'missLabel',
  'missBudget', 'great', 'ok', 'miss', 'remaining', 'ur', 'pp', 'fc'].map(id => [id, { node: $(id), text: $(id).textContent, key: null }]));

function text(slot, value) {
  if (slot.text === value) return;
  slot.text = value;
  slot.node.textContent = value;
}

// True when `key` differs from the number the slot last formatted, which it then records.
function fresh(slot, key) {
  if (slot.key === key) return false;
  slot.key = key;
  return true;
}

const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const int = value => { const n = num(value); return n === null ? null : Math.max(0, Math.round(n)); };
const DASH = '—';
const DASH_KEY = -Infinity; // slot key while a slot shows the dash
const MINUS = '\u2212';
// Accuracies round down to 2 decimals (as osu!lazer shows them), so a readout never shows the
// target as reached, or reachable, when it is not. The render path keys each readout by the shown
// value in hundredths of a percent, Math.floor(fraction * 1e4 + 1e-6) | 0 (0..10000, so `| 0` is
// exact and keeps a Smi), inlined so no fractional number is passed to a call.
const pct = key => (key / 100).toFixed(2);

// n.toFixed(0) is String(n) for an integer, without V8's number-string cache (a full GC flushes
// it, and the next miss rebuilds it as one 64 KB block).
function showInt(slot, n) {
  if (fresh(slot, n === null ? DASH_KEY : n)) text(slot, n === null ? DASH : n.toFixed(0));
}

const DEFAULTS = {
  target: 99, orientation: 'auto', align: 'left', backing: 'none', accent: 'map', showPp: true, showUr: true,
};
let config = { ...DEFAULTS };
let status = 'connecting';
let dataDirty = true;
let lastJudged = 0;
let lastView = '';
let checksum = '';
let palette = null;
// Stage attributes written per data message, cached so a message never reads them back.
let stageView = stage.getAttribute('data-view');
let stageStatus = stage.getAttribute('data-status');
let tone = budget.getAttribute('data-tone');
const result = pace(0, 0, 0, 0, 1);
// Inputs of the last pace render (renderPace), so messages without a new judgement skip it.
const seen = { great: -1, ok: -1, miss: -1, notes: -1, target: -1 };

// Latest value of every subscribed pointer, copied out of the client's reused frame object.
const KEYS = Object.keys(P);
const POINTERS = Object.values(P);
const data = {};
for (const key of KEYS) data[key] = undefined;

// ------------------------------------------------------------------ layout from the page's box
// Design sizes per layout (CSS px at --u = 1): strip 1100×150, row 1100×56, column 320×460.
// --u scales type and graphics so the design fits the box; widths re-flow around the tape.
function layout() {
  const W = innerWidth;
  const H = innerHeight;
  if (!W || !H) return;
  const shape = config.orientation === 'vertical' ? 'column'
    : config.orientation === 'horizontal' ? (H < 104 ? 'row' : 'strip')
    : W / H < 2.2 ? 'column' : H < 104 || W / H > 14 ? 'row' : 'strip';
  let u;
  let room = 'full';
  if (shape === 'strip') u = Math.min(H / 150, W / 860);
  else if (shape === 'column') u = Math.min(W / 320, H / 470);
  else {
    u = Math.min(H / 56, W / 640);
    const span = W / u; // width available in design px
    room = span >= 1240 ? 'full' : span >= 900 ? 'stats' : 'core';
  }
  attr(stage, 'data-layout', shape);
  attr(stage, 'data-room', room);
  stage.style.setProperty('--u', Math.max(0.4, u).toFixed(3));
}

// ------------------------------------------------------------------ tape (canvas)
const SPANS = [1, 2, 5, 10, 20, 50];
const MAJOR = { 1: 0.25, 2: 0.5, 5: 1, 10: 2, 20: 5, 50: 10 };
// Tape values (percent) by index: the scale's low end, the max achievable, the live accuracy.
// `goalAt` holds where they are heading, `shownAt` where the tape draws them while they ease there.
const LO = 0;
const MAX = 1;
const ACC = 2;
const goalAt = new Float64Array([98, 100, 100]);
const shownAt = new Float64Array([98, 100, 100]);
const goal = { target: 99, span: 2, hasAcc: false };
// Frame clock: [0] the previous frame's timestamp (0 once the tape settles), [1] this frame's step.
const clock = new Float64Array(2);
let colours = null;
let tapeDirty = true;
let snap = true;

// Canvas geometry, set on resize. The tape is drawn in 1/Q CSS px (Q a power of two, so the scale
// is exact) and every coordinate reaches the context as an integer: V8 boxes each fractional
// number passed to a canvas binding below its top tier, never an integer (Smi).
const Q = 65536;
const size = { w: 0, h: 0, dpr: 1 };
let pixelsW = 0; // canvas backing store, device px
let pixelsH = 0;
let wQ = 0; // tape width, 1/Q px
// Passed to the context as they are (tagged once here, not boxed per call).
let dprScale = 1; // CSS px -> device px, for text
let qScale = 1 / Q; // 1/Q px -> device px
let labelY = 0; // tick label baseline, CSS px

// Tick labels by major-tick index (value / major), measured once per scale and font.
const LABEL_SLOTS = 401; // 100 / smallest major step (0.25) + 1
const labels = { major: NaN, font: '', text: new Array(LABEL_SLOTS).fill(null), width: new Float64Array(LABEL_SLOTS) };
let fontPx = 0;
let fontMono = '';
let font = '';

function forgetLabels() {
  labels.font = '';
}

function readColours() {
  const style = getComputedStyle(stage);
  const get = name => style.getPropertyValue(name).trim();
  colours = {
    fg: get('--fg'), dim: get('--fg-dim'), hl: get('--hl') || get('--accent'), miss: get('--j-miss'), mono: get('--font-mono'),
  };
  tapeDirty = true;
}

// Allocation-free. Geometry is inlined: x(v) = ((v - lo) / (100 - lo)) * w, and px(v) =
// Math.round(v * dpr) / dpr snaps to device pixels; Math.round(… * Q) turns CSS px into 1/Q px.
function drawTape() {
  const w = size.w;
  const h = size.h;
  const dpr = size.dpr;
  if (!w || !h || !colours) return;
  const c = colours;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixelsW, pixelsH);
  ctx.setTransform(qScale, 0, 0, qScale, 0, 0);
  const lo = shownAt[LO];
  // Tall tapes carry tick labels under the axis; short ones (one-line layout) only ticks.
  const labelled = h >= 32;
  const fontSize = Math.round(Math.min(13, Math.max(10, h * 0.27)));
  const Y0 = Math.max(5, Math.round(h * (labelled ? 0.18 : 0.24)));
  const Y1 = Math.round(labelled ? h - fontSize - 8 : h - 6);
  const flag = Math.max(3, Y0 - 3);
  const y0 = Y0 * Q;
  const y1 = Y1 * Q;

  // Track: a dark shade so the marks read over any map background.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = 'rgb(9 10 11 / .5)';
  ctx.fillRect(0, y0, wQ, y1 - y0);

  const xMax = Math.max(0, Math.min(w, ((shownAt[MAX] - lo) / (100 - lo)) * w));
  const xTarget = Math.max(0, Math.min(w, ((goal.target - lo) / (100 - lo)) * w));
  const xMaxQ = Math.round(xMax * Q);
  const xTargetQ = Math.round(xTarget * Q);

  // Spent: accuracy already lost to OKs and misses (max .. 100).
  if (xMax < w - 0.5) {
    const rise = y1 - y0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(xMaxQ, y0, wQ - xMaxQ, rise);
    ctx.clip();
    ctx.beginPath();
    for (let i = xMaxQ - rise; i < wQ; i += 5 * Q) { ctx.moveTo(i, y1); ctx.lineTo(i + rise, y0); }
    ctx.strokeStyle = c.dim;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = Q;
    ctx.stroke();
    ctx.restore();
  }

  // Headroom above the target, or the shortfall below it.
  const lost = shownAt[MAX] < goal.target - EPS;
  ctx.fillStyle = lost ? c.miss : c.hl;
  const bandX = Math.min(xMaxQ, xTargetQ);
  const bandW = Math.abs(xMaxQ - xTargetQ);
  ctx.globalAlpha = 0.28;
  ctx.fillRect(bandX, y0, bandW, y1 - y0);
  ctx.globalAlpha = 1;
  ctx.fillRect(bandX, y0, bandW, 2 * Q);
  ctx.fillRect(Math.round((Math.round(Math.min(w - 2, Math.max(0, xMax - 1)) * dpr) / dpr) * Q), y0, 2 * Q, y1 - y0);

  // Target: a hairline with a flag.
  ctx.shadowColor = 'rgb(0 0 0 / .65)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  const tx = Math.round(Math.min(w - 1, xTarget) * dpr) / dpr;
  ctx.fillStyle = c.fg;
  ctx.fillRect(Math.round(tx * Q), y0 - 2 * Q, Q, y1 - y0 + 2 * Q);
  ctx.beginPath();
  ctx.moveTo(Math.round((tx + 0.5 - flag * 0.85) * Q), 0);
  ctx.lineTo(Math.round((tx + 0.5 + flag * 0.85) * Q), 0);
  ctx.lineTo(Math.round((tx + 0.5) * Q), flag * Q);
  ctx.closePath();
  ctx.fill();

  // Live accuracy.
  if (goal.hasAcc) {
    const raw = ((shownAt[ACC] - lo) / (100 - lo)) * w;
    const mid = (Y0 + Y1) / 2;
    const half = (Y1 - Y0) / 2 - 2;
    if (raw < 0) {
      ctx.beginPath(); // pinned left: the attempt sits below the scale
      ctx.moveTo(0, mid * Q);
      ctx.lineTo(Math.round(half * 1.4 * Q), Math.round((mid - half) * Q));
      ctx.lineTo(Math.round(half * 1.4 * Q), Math.round((mid + half) * Q));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(Math.round((Math.round(Math.min(w - 3, raw - 1.5) * dpr) / dpr) * Q), y0 - 3 * Q, 3 * Q, y1 - y0 + 6 * Q);
    }
  }

  // Axis ticks, labelled when there is room. Labels are text, drawn at the CSS px scale.
  const major = MAJOR[goal.span] ?? goal.span / 4;
  const minor = major / 5;
  if (fontSize !== fontPx || c.mono !== fontMono) {
    fontPx = fontSize;
    fontMono = c.mono;
    font = `500 ${fontSize}px ${c.mono}`;
  }
  ctx.font = font;
  if (labels.major !== major || labels.font !== font) {
    labels.major = major;
    labels.font = font;
    labels.text.fill(null);
  }
  ctx.textBaseline = 'alphabetic';
  for (let k = Math.ceil(lo / minor - EPS); k * minor <= 100 + EPS; k++) {
    const isMajor = k % 5 === 0;
    const v = k * minor;
    const tickX = Math.round(Math.min(w - 1, ((v - lo) / (100 - lo)) * w) * dpr) / dpr;
    ctx.fillStyle = isMajor ? c.fg : c.dim;
    ctx.globalAlpha = isMajor ? 0.8 : 0.5;
    ctx.fillRect(Math.round(tickX * Q), y1 + 2 * Q, Q, (isMajor ? 4 : 2) * Q);
    if (!isMajor || !labelled) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.dim;
    const m = k / 5;
    let label = labels.text[m];
    if (label === null) {
      label = String(Number(v.toFixed(2)));
      labels.text[m] = label;
      labels.width[m] = ctx.measureText(label).width;
    }
    const width = labels.width[m];
    ctx.setTransform(dprScale, 0, 0, dprScale, 0, 0);
    ctx.fillText(label, Math.round(Math.max(0, Math.min(w - width, tickX - width / 2))), labelY);
    ctx.setTransform(qScale, 0, 0, qScale, 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function sizeCanvas(entry) {
  const box = entry.devicePixelContentBoxSize?.[0];
  const w = entry.contentRect.width;
  const h = entry.contentRect.height;
  canvas.width = box ? box.inlineSize : Math.round(w * (devicePixelRatio || 1));
  canvas.height = box ? box.blockSize : Math.round(h * (devicePixelRatio || 1));
  size.w = w;
  size.h = h;
  size.dpr = canvas.width / Math.max(1, w);
  pixelsW = canvas.width;
  pixelsH = canvas.height;
  wQ = Math.round(w * Q);
  dprScale = size.dpr;
  qScale = size.dpr / Q;
  labelY = h - 2;
  tapeDirty = true;
  invalidate();
}

// ------------------------------------------------------------------ colour
function tint() {
  applyPalette(document.documentElement, config.accent === 'map' ? palette : null);
  attr(stage, 'data-accent', config.accent === 'map' ? 'map' : '18-lab');
  readColours();
  invalidate();
}

function follow(next) {
  if (next === checksum) return;
  checksum = next;
  palette = null;
  tint();
  if (!next) return;
  mapPalette(next).then(result => {
    if (checksum !== next) return;
    palette = result;
    tint();
  });
}

// ------------------------------------------------------------------ model -> view
// Gameplay only: osu! song select and results already show what this would add there, and the
// page's box is placed for gameplay (it would land on the local ranking or the ranking panel).
function viewOf() {
  if (status !== 'live') return status;
  const state = num(data.state);
  if (state === null) return 'idle'; // osu! is not running
  if (state !== 2) return 'hidden';
  return activeMode(state, data.playMode, data.settingsMode) === 'taiko' ? 'pace' : 'hidden';
}

// Points the tape at the pace result; marks it for a redraw only when where it is heading changes.
function setTape(p, reachable) {
  const max = reachable ? p.max * 100 : 100;
  const acc = p.accuracy * 100;
  const floorPct = Math.min(config.target, max);
  let span = 100;
  for (let i = 0; i < SPANS.length; i++) if (SPANS[i] * 0.88 >= 100 - floorPct) { span = SPANS[i]; break; }
  if (goal.hasAcc && goal.target === config.target && goal.span === span && goalAt[MAX] === max && goalAt[ACC] === acc) return;
  goal.target = config.target;
  goal.span = span;
  goal.hasAcc = true;
  goalAt[LO] = 100 - span;
  goalAt[MAX] = max;
  goalAt[ACC] = acc;
  tapeDirty = true;
}

// Switches the budget readout's tone and its fixed labels; values follow per message.
function setTone(next, label, unit, subLabel) {
  if (next === tone) return;
  tone = next;
  budget.setAttribute('data-tone', next);
  text(T.budgetLabel, label);
  text(T.budgetUnit, unit);
  text(T.missLabel, subLabel);
  okBudgetBox.classList.toggle('empty', next === 'idle');
  T.okBudget.key = null;
  T.missBudget.key = null;
}

// Pace readouts and the tape for one set of counts; renderData calls it only when they change.
function renderPace(great, ok, miss, notes) {
  const target = config.target / 100;
  const p = pace(great, ok, miss, notes ?? great + ok + miss, target, result);
  const accKey = Math.floor(p.accuracy * 1e4 + 1e-6) | 0;
  if (fresh(T.acc, accKey)) text(T.acc, pct(accKey));
  showInt(T.great, great);
  showInt(T.ok, ok);
  showInt(T.miss, miss);
  if (notes) {
    const maxKey = Math.floor(p.max * 1e4 + 1e-6) | 0;
    if (fresh(T.max, maxKey)) text(T.max, `${pct(maxKey)}%`);
    showInt(T.remaining, p.remaining);
    if (p.lost) {
      setTone('lost', 'Below target', '%', 'Target');
      // Shortfall in hundredths of a percent, at least 0.01 (1..10000: `| 0` is exact).
      const short = Math.max(1, Math.ceil((target - p.max) * 1e4 - 1e-6)) | 0;
      if (fresh(T.okBudget, short)) text(T.okBudget, `${MINUS}${pct(short)}`);
      text(T.missBudget, 'Out of reach');
    } else {
      setTone('budget', 'OK budget', '', 'Miss budget');
      showInt(T.okBudget, p.okBudget);
      showInt(T.missBudget, p.missBudget);
    }
    setTape(p, true);
  } else {
    showInt(T.max, null);
    showInt(T.remaining, null);
    setTone('idle', 'OK budget', '', 'Miss budget');
    showInt(T.okBudget, null);
    showInt(T.missBudget, null);
    setTape(p, false);
  }
}

function renderData() {
  const view = viewOf();
  follow(typeof data.checksum === 'string' ? data.checksum : '');

  const chip = view === 'connecting' || view === 'offline' || view === 'idle';
  const shape = chip ? 'chip' : view;
  if (shape !== stageView) { stageView = shape; stage.setAttribute('data-view', shape); }
  if (view !== stageStatus) { stageStatus = view; stage.setAttribute('data-status', view); }
  text(T.chipText, view === 'offline' ? 'vosu offline' : view === 'idle' ? 'Waiting for osu!' : 'Connecting');
  if (view !== lastView) snap = true;
  lastView = view;
  if (view !== 'pace') return;

  if (fresh(T.target, config.target)) text(T.target, `${config.target.toFixed(2)}%`);
  const great = int(data.great) ?? 0;
  const ok = int(data.ok) ?? 0;
  const miss = int(data.miss) ?? 0;
  const notes = int(data.notes) || int(data.circles) || null;
  const judged = great + ok + miss;
  if (judged < lastJudged) snap = true; // retry
  lastJudged = judged;
  // Most messages carry no new judgement: the pace readouts and tape then stay as they are.
  if (great !== seen.great || ok !== seen.ok || miss !== seen.miss || notes !== seen.notes || config.target !== seen.target) {
    seen.great = great;
    seen.ok = ok;
    seen.miss = miss;
    seen.notes = notes;
    seen.target = config.target;
    renderPace(great, ok, miss, notes);
  }

  const ur = num(data.ur);
  const urShown = judged > 1 && ur !== null;
  if (fresh(T.ur, urShown ? ur : DASH_KEY)) text(T.ur, urShown ? ur.toFixed(1) : DASH);
  const pp = num(data.pp);
  showInt(T.pp, pp === null ? null : Math.round(pp));
  const fc = num(data.fc);
  showInt(T.fc, fc === null ? null : Math.round(fc));
}

// ------------------------------------------------------------------ frame loop
let raf = 0;

function invalidate() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  // 16 ms on the first frame after a pause. Set through the array: a conditional choosing between
  // a computed double and an integer literal makes V8 box the double on every frame.
  clock[1] = 16;
  if (clock[0]) clock[1] = Math.min(64, now - clock[0]);
  clock[0] = now;
  const dt = clock[1];
  if (dataDirty) { dataDirty = false; renderData(); }

  let moving = false;
  if (snap) {
    shownAt[LO] = goalAt[LO];
    shownAt[MAX] = goalAt[MAX];
    if (goal.hasAcc) shownAt[ACC] = goalAt[ACC];
    snap = false;
    tapeDirty = true;
  } else {
    const k = 1 - Math.exp(-dt / 70);
    const settle = goal.span * 2e-4;
    const count = goal.hasAcc ? 3 : 2; // the accuracy mark waits for its first value
    for (let i = 0; i < count; i++) {
      const delta = goalAt[i] - shownAt[i];
      if (Math.abs(delta) <= settle) {
        if (delta !== 0) { shownAt[i] = goalAt[i]; tapeDirty = true; }
        continue;
      }
      shownAt[i] += delta * k;
      moving = true;
      tapeDirty = true;
    }
  }
  if (tapeDirty && lastView === 'pace') { tapeDirty = false; drawTape(); }
  if (moving) invalidate();
  else clock[0] = 0;
}

// ------------------------------------------------------------------ wiring
function refont() {
  forgetLabels();
  tapeDirty = true;
  invalidate();
}

readColours();
layout();
addEventListener('resize', layout);
document.fonts?.ready.then(refont);
document.fonts?.addEventListener('loadingdone', refont); // label widths depend on the loaded faces
new ResizeObserver(entries => sizeCanvas(entries[entries.length - 1])).observe(canvas, { box: 'device-pixel-content-box' });

settings(DEFAULTS, s => {
  const target = Math.min(100, Math.max(50, Number(s.target) || DEFAULTS.target));
  config = {
    ...s,
    target: Math.round(target * 100) / 100,
    orientation: ['auto', 'horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto',
    align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
    backing: ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none',
  };
  attr(stage, 'data-align', config.align);
  attr(stage, 'data-backing', config.backing);
  hide(urCell, !config.showUr);
  for (const node of ppCells) hide(node, !config.showPp);
  layout();
  tint();
  dataDirty = true;
  snap = true;
  invalidate();
});

// The client reuses its values object for every frame: copy the pointers out instead of keeping it.
subscribe(POINTERS, current => {
  for (let i = 0; i < KEYS.length; i++) data[KEYS[i]] = current[POINTERS[i]];
  dataDirty = true;
  invalidate();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    dataDirty = true;
    invalidate();
  },
});

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
 */
export function pace(great, ok, miss, notes, target) {
  const judged = great + ok + miss;
  const total = Math.max(notes, judged);
  const remaining = total - judged;
  const points = great + ok / 2;
  const slack = points + remaining - target * total; // GREAT-equivalents above the target
  const lost = slack < -EPS;
  return {
    judged,
    remaining,
    accuracy: judged ? points / judged : 1,
    max: total ? (points + remaining) / total : 1,
    lost,
    okBudget: lost ? null : Math.min(remaining, Math.floor(2 * slack + EPS)),
    missBudget: lost ? null : Math.min(remaining, Math.floor(slack + EPS)),
  };
}

const $ = id => document.getElementById(id);
const stage = $('stage');
const budget = $('budget');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const el = Object.fromEntries(['chipText', 'acc', 'max', 'target', 'budgetLabel', 'okBudget', 'budgetUnit', 'missLabel',
  'missBudget', 'great', 'ok', 'miss', 'remaining', 'urCell', 'ur', 'pp', 'fc'].map(id => [id, $(id)]));
const ppCells = [...document.querySelectorAll('[data-pp]')];

const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const int = value => { const n = num(value); return n === null ? null : Math.max(0, Math.round(n)); };
const DASH = '—';
const MINUS = '\u2212';
// Accuracies round down to 2 decimals (as osu!lazer shows them), so a readout never shows the
// target as reached, or reachable, when it is not.
const pct = fraction => (Math.floor(fraction * 1e4 + 1e-6) / 100).toFixed(2);
const whole = value => (value === null ? DASH : String(Math.round(value)));

const DEFAULTS = {
  target: 99, orientation: 'auto', align: 'left', backing: 'none', accent: 'map', showPp: true, showUr: true,
};
let config = { ...DEFAULTS };
let status = 'connecting';
let values = null;
let dataDirty = true;
let lastJudged = 0;
let lastView = '';
let checksum = '';
let palette = null;

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
const goal = { lo: 98, max: 100, acc: null, target: 99, span: 2 };
const shown = { lo: 98, max: 100, acc: 100 };
let colours = null;
let size = { w: 0, h: 0, dpr: 1 };
let tapeDirty = true;
let snap = true;

function spanFor(floorPct) {
  for (const span of SPANS) if (span * 0.88 >= 100 - floorPct) return span;
  return 100;
}

function readColours() {
  const style = getComputedStyle(stage);
  const get = name => style.getPropertyValue(name).trim();
  colours = {
    fg: get('--fg'), dim: get('--fg-dim'), hl: get('--hl') || get('--accent'), miss: get('--j-miss'), mono: get('--font-mono'),
  };
  tapeDirty = true;
}

function drawTape() {
  const { w, h, dpr } = size;
  if (!w || !h || !colours) return;
  const c = colours;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const lo = shown.lo;
  const x = v => ((v - lo) / (100 - lo)) * w;
  const px = v => Math.round(v * dpr) / dpr; // snap to device pixels
  // Tall tapes carry tick labels under the axis; short ones (one-line layout) only ticks.
  const labels = h >= 32;
  const font = Math.round(Math.min(13, Math.max(10, h * 0.27)));
  const Y0 = Math.max(5, Math.round(h * (labels ? 0.18 : 0.24)));
  const Y1 = Math.round(labels ? h - font - 8 : h - 6);
  const flag = Math.max(3, Y0 - 3);
  const shadow = on => {
    ctx.shadowColor = on ? 'rgb(0 0 0 / .65)' : 'transparent';
    ctx.shadowBlur = on ? 2 : 0;
    ctx.shadowOffsetY = on ? 1 : 0;
  };

  // Track: a dark shade so the marks read over any map background.
  shadow(false);
  ctx.fillStyle = 'rgb(9 10 11 / .5)';
  ctx.fillRect(0, Y0, w, Y1 - Y0);

  const xMax = Math.max(0, Math.min(w, x(shown.max)));
  const xTarget = Math.max(0, Math.min(w, x(goal.target)));

  // Spent: accuracy already lost to OKs and misses (max .. 100).
  if (xMax < w - 0.5) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(xMax, Y0, w - xMax, Y1 - Y0);
    ctx.clip();
    ctx.beginPath();
    for (let i = xMax - (Y1 - Y0); i < w; i += 5) { ctx.moveTo(i, Y1); ctx.lineTo(i + (Y1 - Y0), Y0); }
    ctx.strokeStyle = c.dim;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Headroom above the target, or the shortfall below it.
  const lost = shown.max < goal.target - EPS;
  ctx.fillStyle = lost ? c.miss : c.hl;
  const bandX = Math.min(xMax, xTarget);
  const bandW = Math.abs(xMax - xTarget);
  ctx.globalAlpha = 0.28;
  ctx.fillRect(bandX, Y0, bandW, Y1 - Y0);
  ctx.globalAlpha = 1;
  ctx.fillRect(bandX, Y0, bandW, 2);
  ctx.fillRect(px(Math.min(w - 2, Math.max(0, xMax - 1))), Y0, 2, Y1 - Y0);

  // Target: a hairline with a flag.
  shadow(true);
  const tx = px(Math.min(w - 1, xTarget));
  ctx.fillStyle = c.fg;
  ctx.fillRect(tx, Y0 - 2, 1, Y1 - Y0 + 2);
  ctx.beginPath();
  ctx.moveTo(tx + 0.5 - flag * 0.85, 0);
  ctx.lineTo(tx + 0.5 + flag * 0.85, 0);
  ctx.lineTo(tx + 0.5, flag);
  ctx.closePath();
  ctx.fill();

  // Live accuracy.
  if (goal.acc !== null) {
    const raw = x(shown.acc);
    const mid = (Y0 + Y1) / 2;
    const half = (Y1 - Y0) / 2 - 2;
    if (raw < 0) {
      ctx.beginPath(); // pinned left: the attempt sits below the scale
      ctx.moveTo(0, mid);
      ctx.lineTo(half * 1.4, mid - half);
      ctx.lineTo(half * 1.4, mid + half);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(px(Math.min(w - 3, raw - 1.5)), Y0 - 3, 3, Y1 - Y0 + 6);
    }
  }

  // Axis ticks, labelled when there is room.
  const major = MAJOR[goal.span] ?? goal.span / 4;
  const minor = major / 5;
  ctx.font = `500 ${font}px ${c.mono}`;
  ctx.textBaseline = 'alphabetic';
  for (let k = Math.ceil(lo / minor - EPS); k * minor <= 100 + EPS; k++) {
    const isMajor = k % 5 === 0;
    const v = k * minor;
    const tickX = px(Math.min(w - 1, x(v)));
    ctx.fillStyle = isMajor ? c.fg : c.dim;
    ctx.globalAlpha = isMajor ? 0.8 : 0.5;
    ctx.fillRect(tickX, Y1 + 2, 1, isMajor ? 4 : 2);
    if (!isMajor || !labels) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.dim;
    const label = String(Number(v.toFixed(2)));
    const width = ctx.measureText(label).width;
    ctx.fillText(label, Math.round(Math.max(0, Math.min(w - width, tickX - width / 2))), h - 2);
  }
  ctx.globalAlpha = 1;
  shadow(false);
}

function sizeCanvas(entry) {
  const box = entry.devicePixelContentBoxSize?.[0];
  const w = entry.contentRect.width;
  const h = entry.contentRect.height;
  canvas.width = box ? box.inlineSize : Math.round(w * (devicePixelRatio || 1));
  canvas.height = box ? box.blockSize : Math.round(h * (devicePixelRatio || 1));
  size = { w, h, dpr: canvas.width / Math.max(1, w) };
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
function viewOf(v) {
  if (status !== 'live') return status;
  const state = num(v[P.state]);
  if (state === null) return 'idle'; // osu! is not running
  if (state !== 2) return 'hidden';
  return activeMode(state, v[P.playMode], v[P.settingsMode]) === 'taiko' ? 'pace' : 'hidden';
}

function setTape(max, acc) {
  goal.target = config.target;
  goal.max = max;
  goal.acc = acc;
  goal.span = spanFor(Math.min(config.target, max));
  goal.lo = 100 - goal.span;
  tapeDirty = true;
}

function setBudget(tone, label, value, unit, subLabel, sub) {
  attr(budget, 'data-tone', tone);
  put(el.budgetLabel, label);
  put(el.okBudget, value);
  el.okBudget.parentElement.classList.toggle('empty', value === DASH);
  put(el.budgetUnit, unit);
  put(el.missLabel, subLabel);
  put(el.missBudget, sub);
}

function renderData() {
  const v = values ?? {};
  const view = viewOf(v);
  follow(typeof v[P.checksum] === 'string' ? v[P.checksum] : '');

  const chip = view === 'connecting' || view === 'offline' || view === 'idle';
  attr(stage, 'data-view', chip ? 'chip' : view);
  attr(stage, 'data-status', view);
  put(el.chipText, view === 'offline' ? 'vosu offline' : view === 'idle' ? 'Waiting for osu!' : 'Connecting');
  if (view !== lastView) snap = true;
  lastView = view;
  if (view !== 'pace') return;

  const target = config.target / 100;
  put(el.target, `${config.target.toFixed(2)}%`);
  const great = int(v[P.great]) ?? 0;
  const ok = int(v[P.ok]) ?? 0;
  const miss = int(v[P.miss]) ?? 0;
  const notes = int(v[P.notes]) || int(v[P.circles]) || null;
  const judged = great + ok + miss;
  if (judged < lastJudged) snap = true; // retry
  lastJudged = judged;
  const p = pace(great, ok, miss, notes ?? judged, target);

  put(el.acc, pct(p.accuracy));
  put(el.great, String(great));
  put(el.ok, String(ok));
  put(el.miss, String(miss));
  if (notes) {
    put(el.max, `${pct(p.max)}%`);
    put(el.remaining, String(p.remaining));
    if (p.lost) {
      const short = Math.max(0.01, Math.ceil((target - p.max) * 1e4 - 1e-6) / 100);
      setBudget('lost', 'Below target', `${MINUS}${short.toFixed(2)}`, '%', 'Target', 'Out of reach');
    } else {
      setBudget('budget', 'OK budget', String(p.okBudget), '', 'Miss budget', String(p.missBudget));
    }
    setTape(p.max * 100, p.accuracy * 100);
  } else {
    put(el.max, DASH);
    put(el.remaining, DASH);
    setBudget('idle', 'OK budget', DASH, '', 'Miss budget', DASH);
    setTape(100, p.accuracy * 100);
  }

  const ur = num(v[P.ur]);
  put(el.ur, judged > 1 && ur !== null ? ur.toFixed(1) : DASH);
  put(el.pp, whole(num(v[P.pp])));
  put(el.fc, whole(num(v[P.fc])));
}

// ------------------------------------------------------------------ frame loop
let raf = 0;
let lastTime = 0;

function invalidate() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  const dt = lastTime ? Math.min(64, now - lastTime) : 16;
  lastTime = now;
  if (dataDirty) { dataDirty = false; renderData(); }

  let moving = false;
  if (snap) {
    shown.lo = goal.lo; shown.max = goal.max; shown.acc = goal.acc ?? shown.acc;
    snap = false;
    tapeDirty = true;
  } else {
    const k = 1 - Math.exp(-dt / 70);
    const settle = goal.span * 2e-4;
    for (const key of ['lo', 'max', 'acc']) {
      const target = goal[key];
      if (target === null) continue;
      const delta = target - shown[key];
      if (Math.abs(delta) <= settle) {
        if (delta !== 0) { shown[key] = target; tapeDirty = true; }
        continue;
      }
      shown[key] += delta * k;
      moving = true;
      tapeDirty = true;
    }
  }
  if (tapeDirty && lastView === 'pace') { tapeDirty = false; drawTape(); }
  if (moving) invalidate();
  else lastTime = 0;
}

// ------------------------------------------------------------------ wiring
readColours();
layout();
addEventListener('resize', layout);
document.fonts?.ready.then(() => { tapeDirty = true; invalidate(); });
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
  hide(el.urCell, !config.showUr);
  for (const node of ppCells) hide(node, !config.showPp);
  layout();
  tint();
  dataDirty = true;
  snap = true;
  invalidate();
});

subscribe(Object.values(P), current => {
  values = current;
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

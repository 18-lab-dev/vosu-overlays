// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko accuracy pace: how far the attempt can still go, and how many OKs or misses the
// chosen target accuracy can still absorb.
import { subscribe, settings, fit, activeMode } from './vosu-overlay.js';

const WIDTH = 400;
const HEIGHT = 280;
const TAIKO = 1;
const EPS = 1e-9;

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
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
  greatWindow: '/beatmap/stats/hitWindow/great',
  ppByAcc: '/performance/accuracy',
  resultMode: '/resultsScreen/mode/number',
  resultGreat: '/resultsScreen/hits/300',
  resultOk: '/resultsScreen/hits/100',
  resultMiss: '/resultsScreen/hits/0',
  resultRank: '/resultsScreen/rank',
  resultPp: '/resultsScreen/pp/current',
  resultFc: '/resultsScreen/pp/fc',
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
const panel = $('panel');
const budget = $('budget');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const el = Object.fromEntries(['chipText', 'brand', 'target', 'leftLabel', 'left', 'leftUnit', 'leftSubLabel', 'leftSub',
  'rightLabel', 'right', 'rightUnit', 'rightSubLabel', 'rightSub', 'great', 'ok', 'miss', 'leftCountLabel',
  'remaining', 'foot', 'urStat', 'ur', 'ppStat', 'ppLabel', 'pp', 'fcLabel', 'fc'].map(id => [id, $(id)]));

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
const count = value => (value === null ? DASH : String(value));
const ms = value => (value === null ? DASH : `±${Number(value.toFixed(1))} ms`);
const whole = value => (value === null ? DASH : String(Math.round(value)));

let status = 'connecting';
let values = null;
let config = { target: 99, showPp: true, showUr: true, showBrand: true };
let dataDirty = true;
let heldUr = null;
let lastJudged = 0;
let lastPhase = '';

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
  const style = getComputedStyle(document.documentElement);
  const get = name => style.getPropertyValue(name).trim();
  colours = {
    fg: get('--fg'), dim: get('--fg-dim'), muted: get('--muted'), rule: get('--rule'), strong: get('--rule-strong'),
    accent: get('--accent'), miss: get('--j-miss'), mono: get('--font-mono'),
  };
}

function drawTape() {
  const { w, h, dpr } = size;
  if (!w || !colours) return;
  const c = colours;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const lo = shown.lo;
  const range = 100 - lo;
  const x = v => ((v - lo) / range) * w;
  const crisp = v => (Math.round(v * dpr) + 0.5) / dpr; // centre of a device pixel for 1px lines
  const Y0 = 8;
  const Y1 = 24;

  ctx.globalAlpha = 1;
  ctx.fillStyle = c.rule;
  ctx.globalAlpha = 0.45;
  ctx.fillRect(0, Y0, w, Y1 - Y0);
  ctx.globalAlpha = 1;

  const xMax = Math.max(0, Math.min(w, x(shown.max)));
  const xTarget = Math.max(0, Math.min(w, x(goal.target)));

  // Spent: accuracy already lost to OKs and misses (max .. 100).
  if (xMax < w - 0.5) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(xMax, Y0, w - xMax, Y1 - Y0);
    ctx.clip();
    ctx.beginPath();
    for (let i = xMax - (Y1 - Y0); i < w; i += 4) { ctx.moveTo(i, Y1); ctx.lineTo(i + (Y1 - Y0), Y0); }
    ctx.strokeStyle = c.strong;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Headroom above the target, or the shortfall below it.
  const lost = shown.max < goal.target - EPS;
  ctx.fillStyle = lost ? c.miss : c.accent;
  const bandX = Math.min(xMax, xTarget);
  const bandW = Math.abs(xMax - xTarget);
  ctx.globalAlpha = 0.22;
  ctx.fillRect(bandX, Y0, bandW, Y1 - Y0);
  ctx.globalAlpha = 1;
  ctx.fillRect(bandX, Y0, bandW, 2);
  ctx.fillRect(Math.round(Math.min(w - 2, Math.max(0, xMax - 1)) * dpr) / dpr, Y0, 2, Y1 - Y0);

  // Target: hairline with a flag.
  const tx = crisp(Math.min(w - 1, xTarget));
  ctx.strokeStyle = c.fg;
  ctx.lineWidth = 1 / dpr * Math.max(1, Math.round(dpr));
  ctx.beginPath();
  ctx.moveTo(tx, Y0 - 3);
  ctx.lineTo(tx, Y1);
  ctx.stroke();
  ctx.fillStyle = c.fg;
  ctx.beginPath();
  ctx.moveTo(tx - 4, 0);
  ctx.lineTo(tx + 4, 0);
  ctx.lineTo(tx, 5);
  ctx.closePath();
  ctx.fill();

  // Live accuracy.
  if (goal.acc !== null) {
    const raw = x(shown.acc);
    ctx.fillStyle = c.fg;
    if (raw < 0) {
      ctx.beginPath(); // pinned left: the attempt sits below the scale
      ctx.moveTo(0, (Y0 + Y1) / 2);
      ctx.lineTo(6, Y0 + 3);
      ctx.lineTo(6, Y1 - 3);
      ctx.closePath();
      ctx.fill();
    } else {
      const ax = Math.round(Math.min(w - 2, raw - 1) * dpr) / dpr;
      ctx.fillRect(ax, Y0 - 2, 2, Y1 - Y0 + 4);
    }
  }

  // Axis, ticks and labels.
  ctx.fillStyle = c.strong;
  ctx.fillRect(0, Y1, w, 1);
  const major = MAJOR[goal.span] ?? goal.span / 4;
  const minor = major / 5;
  ctx.font = `500 10px ${c.mono}`;
  ctx.textBaseline = 'alphabetic';
  for (let k = Math.ceil(lo / minor - EPS); k * minor <= 100 + EPS; k++) {
    const v = k * minor;
    const isMajor = k % 5 === 0;
    const tx2 = Math.round(Math.min(w - 1, x(v)) * dpr) / dpr;
    ctx.fillStyle = isMajor ? c.muted : c.strong;
    ctx.fillRect(tx2, Y1 + 1, 1, isMajor ? 4 : 2);
    if (!isMajor) continue;
    const label = String(Number(v.toFixed(2)));
    const width = ctx.measureText(label).width;
    const lx = Math.max(0, Math.min(w - width, tx2 - width / 2));
    ctx.fillText(label, Math.round(lx), 38);
  }
}

function sizeCanvas(entry) {
  const box = entry.devicePixelContentBoxSize?.[0];
  const dpr = devicePixelRatio || 1;
  const w = entry.contentRect.width;
  const h = entry.contentRect.height;
  canvas.width = box ? box.inlineSize : Math.round(w * dpr);
  canvas.height = box ? box.blockSize : Math.round(h * dpr);
  size = { w, h, dpr: canvas.width / Math.max(1, w) };
  tapeDirty = true;
  invalidate();
}

// ------------------------------------------------------------------ model -> view
function phaseOf(v) {
  if (status !== 'live') return status;
  const state = num(v[P.state]);
  if (state === null) return 'idle';
  if (state === 7) {
    const mode = num(v[P.resultMode]) ?? num(v[P.settingsMode]);
    return mode === TAIKO ? 'results' : 'other';
  }
  const mode = activeMode(state, v[P.playMode], v[P.settingsMode]);
  if (mode === null) return 'idle';
  if (mode !== 'taiko') return 'other';
  return state === 2 ? 'play' : 'menu';
}

function notesOf(v) {
  return int(v[P.notes]) || int(v[P.circles]) || null;
}

function ppAtTarget(table, target) {
  if (!table || typeof table !== 'object') return null;
  const lo = Math.floor(target);
  const hi = Math.ceil(target);
  const a = num(table[String(lo)]);
  const b = num(table[String(hi)]);
  if (a === null || b === null) return null;
  return a + (b - a) * (target - lo);
}

function setRight(tone, label, value, unit, subLabel, sub) {
  attr(budget, 'data-tone', tone);
  put(el.rightLabel, label);
  put(el.right, value);
  el.right.parentElement.classList.toggle('empty', value === DASH);
  put(el.rightUnit, unit);
  put(el.rightSubLabel, subLabel);
  put(el.rightSub, sub);
}

function setLeft(label, value, unit, subLabel, sub) {
  put(el.leftLabel, label);
  put(el.left, value);
  el.left.parentElement.classList.toggle('empty', value === DASH);
  put(el.leftUnit, unit);
  put(el.leftSubLabel, subLabel);
  put(el.leftSub, sub);
}

function setCounts(great, ok, miss, restLabel, rest) {
  put(el.great, count(great));
  put(el.ok, count(ok));
  put(el.miss, count(miss));
  put(el.leftCountLabel, restLabel);
  put(el.remaining, count(rest));
}

function setTape(max, acc) {
  const t = config.target;
  goal.target = t;
  goal.max = max;
  goal.acc = acc;
  goal.span = spanFor(Math.min(t, max));
  goal.lo = 100 - goal.span;
  tapeDirty = true;
}

function renderData() {
  const v = values ?? {};
  const phase = phaseOf(v);
  const target = config.target / 100;
  const targetText = `${config.target.toFixed(2)}%`;
  put(el.target, targetText);
  hide(el.brand, !config.showBrand);

  const view = phase === 'connecting' || phase === 'offline' ? phase : phase === 'other' ? 'hidden' : 'panel';
  attr(stage, 'data-view', view);
  put(el.chipText, phase === 'offline' ? 'vosu offline' : 'Connecting');
  if (view !== 'panel') { lastPhase = phase; return; }
  attr(panel, 'data-phase', phase);
  if (phase !== lastPhase) snap = true;
  lastPhase = phase;

  let ur = null;
  let pp = null;
  let fc = null;
  let ppLabel = 'PP';
  let fcLabel = 'FC';

  if (phase === 'idle') {
    // osu! is not running: the panel collapses to its header and one line.
    heldUr = null;
    goal.acc = null;
  } else if (phase === 'menu') {
    heldUr = null;
    const notes = notesOf(v);
    setLeft('Notes', count(notes), '', 'Great window', ms(num(v[P.greatWindow])));
    if (notes) {
      const p = pace(0, 0, 0, notes, target);
      setRight('budget', 'OK budget', String(p.okBudget), '', 'Miss budget', String(p.missBudget));
    } else {
      setRight('idle', 'OK budget', DASH, '', 'Miss budget', DASH);
    }
    setCounts(null, null, null, 'Left', null);
    setTape(100, null);
    pp = ppAtTarget(v[P.ppByAcc], config.target);
    fc = num(v[P.ppByAcc]?.['100']);
    ppLabel = `PP ${targetText}`;
    fcLabel = 'SS';
  } else if (phase === 'play') {
    const great = int(v[P.great]) ?? 0;
    const ok = int(v[P.ok]) ?? 0;
    const miss = int(v[P.miss]) ?? 0;
    const notes = notesOf(v);
    const judged = great + ok + miss;
    if (judged < lastJudged) { heldUr = null; snap = true; } // restart or retry
    lastJudged = judged;
    const p = pace(great, ok, miss, notes ?? judged, target);
    if (notes) {
      setLeft('Accuracy', pct(p.accuracy), '%', 'Max', `${pct(p.max)}%`);
      if (p.lost) {
        const short = Math.max(0.01, Math.ceil((target - p.max) * 1e4 - 1e-6) / 100);
        setRight('lost', 'Below target', `${MINUS}${short.toFixed(2)}`, '%', 'Target', 'Out of reach');
      } else {
        setRight('budget', 'OK budget', String(p.okBudget), '', 'Miss budget', String(p.missBudget));
      }
      setCounts(great, ok, miss, 'Left', p.remaining);
      setTape(p.max * 100, p.accuracy * 100);
    } else {
      setLeft('Accuracy', pct(p.accuracy), '%', 'Max', DASH);
      setRight('idle', 'OK budget', DASH, '', 'Miss budget', DASH);
      setCounts(great, ok, miss, 'Left', null);
      setTape(100, p.accuracy * 100);
    }
    const liveUr = num(v[P.ur]);
    if (liveUr !== null && judged > 1) heldUr = liveUr;
    ur = judged > 1 ? liveUr : null;
    pp = num(v[P.pp]);
    fc = num(v[P.fc]);
  } else {
    // Results: hold the final score.
    const great = int(v[P.resultGreat]) ?? 0;
    const ok = int(v[P.resultOk]) ?? 0;
    const miss = int(v[P.resultMiss]) ?? 0;
    const p = pace(great, ok, miss, 0, target);
    lastJudged = 0;
    const rank = typeof v[P.resultRank] === 'string' && v[P.resultRank] ? v[P.resultRank] : DASH;
    setLeft('Final', p.judged ? pct(p.accuracy) : DASH, p.judged ? '%' : '', 'Rank', rank);
    if (p.judged) {
      const delta = p.accuracy - target;
      if (delta >= -EPS) setRight('met', 'Vs target', `+${(Math.floor(Math.max(0, delta) * 1e4 + 1e-6) / 100).toFixed(2)}`, '%', 'Target', 'Met');
      else setRight('missed', 'Vs target', `${MINUS}${Math.max(0.01, Math.ceil(-delta * 1e4 - 1e-6) / 100).toFixed(2)}`, '%', 'Target', 'Missed');
      setTape(p.accuracy * 100, p.accuracy * 100);
    } else {
      setRight('idle', 'Vs target', DASH, '', 'Target', DASH);
      setTape(100, null);
    }
    setCounts(great, ok, miss, 'Notes', p.judged);
    const lastUr = num(v[P.ur]);
    ur = heldUr ?? (lastUr ? lastUr : null);
    pp = num(v[P.resultPp]);
    fc = num(v[P.resultFc]);
  }

  hide(el.urStat, !config.showUr || phase === 'menu');
  hide(el.ppStat, !config.showPp);
  hide(el.foot, el.urStat.hidden && el.ppStat.hidden);
  put(el.ur, ur === null ? DASH : ur.toFixed(1));
  put(el.ppLabel, ppLabel);
  put(el.fcLabel, fcLabel);
  put(el.pp, whole(pp));
  put(el.fc, whole(fc));
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
  if (tapeDirty && stage.dataset.view === 'panel') { tapeDirty = false; drawTape(); }
  if (moving) invalidate();
  else lastTime = 0;
}

// ------------------------------------------------------------------ wiring
fit(stage, WIDTH, HEIGHT);
readColours();
document.fonts?.ready.then(() => { tapeDirty = true; invalidate(); });
new ResizeObserver(entries => sizeCanvas(entries[entries.length - 1])).observe(canvas, { box: 'device-pixel-content-box' });

settings({ target: 99, showPp: true, showUr: true, showBrand: true }, s => {
  const target = Math.min(100, Math.max(50, Number(s.target) || 99));
  config = { ...s, target: Math.round(target * 100) / 100 };
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

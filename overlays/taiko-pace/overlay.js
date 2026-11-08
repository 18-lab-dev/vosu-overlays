// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko accuracy pace, floated in the empty space below the lane: how far the attempt can
// still go, and how many OKs or misses the chosen target accuracy can still absorb. Song select
// gets the map's budget for the target; results get the verdict against it, UR and pp.
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const CLUSTER_WIDTH = 720;
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
  greatWindow: '/beatmap/stats/hitWindow/great',
  ppByAcc: '/performance/accuracy',
  resultMode: '/resultsScreen/mode/number',
  resultGreat: '/resultsScreen/hits/300',
  resultOk: '/resultsScreen/hits/100',
  resultMiss: '/resultsScreen/hits/0',
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
const playSpot = $('playSpot');
const budget = $('budget');
const verdict = $('verdict');
const canvas = $('tape');
const ctx = canvas.getContext('2d', { alpha: true });
const el = Object.fromEntries(['chipText', 'acc', 'max', 'budgetLabel', 'okBudget', 'budgetUnit', 'missLabel', 'missBudget',
  'great', 'ok', 'miss', 'remaining', 'ur', 'pp', 'fc', 'preOk', 'preMiss', 'preNotes', 'preWindow', 'prePp', 'preSs',
  'verdictLabel', 'delta', 'postUr', 'postPp', 'postFc']
  .map(id => [id, $(id)]));
const all = selector => [...document.querySelectorAll(selector)];
const group = { target: all('[data-target]'), brand: all('.brand'), ur: all('[data-ur]'), pp: all('[data-pp]') };

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
  target: 99, zone: 'below lane', x: 0, y: 0, scale: 1, backing: 'none', accent: 'map',
  showPp: true, showUr: true, showBrand: true, showSongSelect: true, showResults: true,
};
let heldUr = null;
let config = { ...DEFAULTS };
let status = 'connecting';
let values = null;
let dataDirty = true;
let lastJudged = 0;
let lastView = '';
let checksum = '';
let palette = null;

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
  if (!w || !colours) return;
  const c = colours;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const lo = shown.lo;
  const x = v => ((v - lo) / (100 - lo)) * w;
  const px = v => Math.round(v * dpr) / dpr; // snap to device pixels
  const Y0 = 10;
  const Y1 = 30;
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
  ctx.fillRect(tx, Y0 - 3, 1, Y1 - Y0 + 3);
  ctx.beginPath();
  ctx.moveTo(tx + 0.5 - 5, 0);
  ctx.lineTo(tx + 0.5 + 5, 0);
  ctx.lineTo(tx + 0.5, 6);
  ctx.closePath();
  ctx.fill();

  // Live accuracy.
  if (goal.acc !== null) {
    const raw = x(shown.acc);
    if (raw < 0) {
      ctx.beginPath(); // pinned left: the attempt sits below the scale
      ctx.moveTo(0, (Y0 + Y1) / 2);
      ctx.lineTo(7, Y0 + 3);
      ctx.lineTo(7, Y1 - 3);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(px(Math.min(w - 3, raw - 1.5)), Y0 - 3, 3, Y1 - Y0 + 6);
    }
  }

  // Axis, ticks and labels.
  const major = MAJOR[goal.span] ?? goal.span / 4;
  const minor = major / 5;
  ctx.font = `500 12px ${c.mono}`;
  ctx.textBaseline = 'alphabetic';
  for (let k = Math.ceil(lo / minor - EPS); k * minor <= 100 + EPS; k++) {
    const isMajor = k % 5 === 0;
    const v = k * minor;
    const tickX = px(Math.min(w - 1, x(v)));
    ctx.fillStyle = isMajor ? c.fg : c.dim;
    ctx.globalAlpha = isMajor ? 0.8 : 0.5;
    ctx.fillRect(tickX, Y1 + 2, 1, isMajor ? 5 : 3);
    if (!isMajor) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.dim;
    const label = String(Number(v.toFixed(2)));
    const width = ctx.measureText(label).width;
    ctx.fillText(label, Math.round(Math.max(0, Math.min(w - width, tickX - width / 2))), 47);
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

// ------------------------------------------------------------------ placement and colour
/** Gameplay: below the lane (default) or in the band between the HP bar and the score. */
function place() {
  const layout = osuLayout('taiko');
  const lane = layout.busy;
  const below = layout.free.find(r => r.y >= lane.y + lane.h);
  const above = layout.free.find(r => r.y + r.h <= lane.y);
  const scale = Math.min(2, Math.max(0.5, config.scale));
  let x;
  let y;
  if (config.zone === 'above lane' && above) {
    x = above.x + (above.w - CLUSTER_WIDTH * scale) / 2;
    y = above.y + 32;
  } else {
    x = below.x + 192; // under the hit target, where the player is already looking
    y = below.y + 40;
  }
  playSpot.style.transform = `translate(${Math.round(x + config.x)}px, ${Math.round(y + config.y)}px) scale(${scale})`;
  $('preSpot').style.transform = `scale(${scale})`;
  $('postSpot').style.transform = `scale(${scale})`;
}

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
function viewOf(v) {
  if (status !== 'live') return status;
  const state = num(v[P.state]);
  if (state === null) return 'idle'; // osu! is not running
  if (state === 2) return activeMode(state, v[P.playMode], v[P.settingsMode]) === 'taiko' ? 'pace' : 'hidden';
  if (state === 5) return config.showSongSelect && num(v[P.settingsMode]) === 1 ? 'pre' : 'hidden';
  if (state === 7) return config.showResults && (num(v[P.resultMode]) ?? num(v[P.settingsMode])) === 1 ? 'post' : 'hidden';
  return 'hidden';
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

function ppAtTarget(table, target) {
  if (!table || typeof table !== 'object') return null;
  const lo = Math.floor(target);
  const hi = Math.ceil(target);
  const a = num(table[String(lo)]);
  const b = num(table[String(hi)]);
  return a === null || b === null ? null : a + (b - a) * (target - lo);
}

function renderPlay(v, target) {
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
  if (judged > 1 && ur !== null) heldUr = ur;
  put(el.ur, judged > 1 && ur !== null ? ur.toFixed(1) : DASH);
  put(el.pp, whole(num(v[P.pp])));
  put(el.fc, whole(num(v[P.fc])));
}

/** Song select: what osu! does not show there — the budget for the target, timing window, pp at target. */
function renderPre(v, target) {
  heldUr = null;
  lastJudged = 0;
  const notes = int(v[P.notes]) || int(v[P.circles]) || null;
  const p = notes ? pace(0, 0, 0, notes, target) : null;
  put(el.preOk, p ? String(p.okBudget) : DASH);
  put(el.preMiss, p ? String(p.missBudget) : DASH);
  put(el.preNotes, notes ? String(notes) : DASH);
  for (const id of ['preOk', 'preMiss', 'preNotes']) el[id].parentElement.classList.toggle('empty', !p);
  const window = num(v[P.greatWindow]);
  put(el.preWindow, window === null ? DASH : `±${Number(window.toFixed(1))} ms`);
  put(el.prePp, whole(ppAtTarget(v[P.ppByAcc], config.target)));
  put(el.preSs, whole(num(v[P.ppByAcc]?.['100'])));
}

/** Results: osu! shows the accuracy; this adds the verdict against the target, UR and pp. */
function renderPost(v, target) {
  lastJudged = 0;
  const p = pace(int(v[P.resultGreat]) ?? 0, int(v[P.resultOk]) ?? 0, int(v[P.resultMiss]) ?? 0, 0, target);
  if (p.judged) {
    const delta = p.accuracy - target;
    const met = delta >= -EPS;
    attr(verdict, 'data-tone', met ? 'met' : 'missed');
    put(el.verdictLabel, met ? 'Met' : 'Missed');
    put(el.delta, met
      ? `+${(Math.floor(Math.max(0, delta) * 1e4 + 1e-6) / 100).toFixed(2)}%`
      : `${MINUS}${Math.max(0.01, Math.ceil(-delta * 1e4 - 1e-6) / 100).toFixed(2)}%`);
  } else {
    attr(verdict, 'data-tone', 'idle');
    put(el.verdictLabel, 'Vs');
    put(el.delta, DASH);
  }
  const lastUr = num(v[P.ur]);
  const ur = heldUr ?? (lastUr ? lastUr : null);
  put(el.postUr, ur === null ? DASH : ur.toFixed(1));
  put(el.postPp, whole(num(v[P.resultPp])));
  put(el.postFc, whole(num(v[P.resultFc])));
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

  const target = config.target / 100;
  for (const node of group.target) put(node, `${config.target.toFixed(2)}%`);
  if (view === 'pace') renderPlay(v, target);
  else if (view === 'pre') renderPre(v, target);
  else if (view === 'post') renderPost(v, target);
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
fit(stage, WIDTH, HEIGHT);
readColours();
document.fonts?.ready.then(() => { tapeDirty = true; invalidate(); });
new ResizeObserver(entries => sizeCanvas(entries[entries.length - 1])).observe(canvas, { box: 'device-pixel-content-box' });

settings(DEFAULTS, s => {
  const target = Math.min(100, Math.max(50, Number(s.target) || DEFAULTS.target));
  config = {
    ...s,
    target: Math.round(target * 100) / 100,
    backing: ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none',
  };
  attr(stage, 'data-backing', config.backing);
  for (const node of group.brand) hide(node, !config.showBrand);
  for (const node of group.ur) hide(node, !config.showUr);
  for (const node of group.pp) hide(node, !config.showPp);
  place();
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

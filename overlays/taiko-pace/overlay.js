// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko OK budget: how many OKs (or misses) the attempt can still take and keep the target
// accuracy, as one hero number with an amber gauge that drains as the budget is spent. Built on
// the overlay kit (docs/overlay-system.md). The page is the overlay's own box (hosts place and
// size it): a row for wide boxes (the 280×80 chip), a column for tall ones.
import { subscribe, settings, activeMode, known, isKnown, DASH, numberFormatter, applyKitSettings, MOTION_MS } from './vosu-overlay.js';

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
const root = $('root');
const heroNum = $('heroNum');
const heroFrac = $('heroFrac');
const heroUnit = $('heroUnit');
const targetGroup = $('targetGroup');
const l2Group = $('l2Group');
const l2Unit = $('l2Unit');
const fill = $('fill');
const ghost = $('ghost');
const extras = $('extras');
const hudItems = [...document.querySelectorAll('[data-hud]')];
const urItem = $('urItem');
const ppItem = $('ppItem');

// Text slots write their text node's data only when the string differs.
function slot(id) {
  const node = $(id);
  if (!node.firstChild) node.appendChild(document.createTextNode(''));
  return { node: node.firstChild, text: node.textContent };
}
function put(s, value) {
  if (s.text !== value) { s.text = value; s.node.data = value; }
}
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const T = {
  hero: slot('hero'), heroFrac: slot('heroFrac'), l1: slot('l1'), target: slot('target'), l2a: slot('l2a'), l2n: slot('l2n'), l2b: slot('l2b'),
  acc: slot('acc'), great: slot('great'), ok: slot('ok'), miss: slot('miss'), ur: slot('ur'), pp: slot('pp'), fc: slot('fc'),
};
// One formatter per displayed field (docs/overlay-system.md "Numbers").
const F = {
  budget: numberFormatter('count'), bestWhole: numberFormatter('count'), misses: numberFormatter('count'),
  target: numberFormatter('accuracy'), acc: numberFormatter('accuracy'), great: numberFormatter('count'),
  ok: numberFormatter('count'), miss: numberFormatter('count'), ur: numberFormatter('ur'), pp: numberFormatter('pp'),
  fc: numberFormatter('pp'),
};
const STATUS_TEXT = { connecting: 'Connecting to vosu', offline: 'vosu offline', idle: 'osu! not running' };

const int = value => (isKnown(value) ? Math.max(0, Math.round(value)) : null);
// Accuracies round down to 2 decimals (as osu!lazer shows them), so the chip never shows a
// target as reachable when it is not: percent with the hundredths floored.
const floorPct = fraction => Math.floor(fraction * 1e4 + 1e-6) / 100;
// The hero's accuracy decimals as a kit-frac (".42"), one string per hundredth, built on first use.
const fracText = new Array(100).fill(null);
const fracOf = n => fracText[n] ?? (fracText[n] = `.${n < 10 ? '0' : ''}${n}`);

const DEFAULTS = {
  target: 99, orientation: 'auto', align: 'left', motion: 'full', backing: 'scrim', hudFields: false, showPp: false, showUr: false,
};
let config = { ...DEFAULTS };
let motion = 'full';
let status = 'connecting';
let dataDirty = true;
let view = root.dataset.view;
let tone = root.dataset.tone;
let line2 = ''; // which sentence line 2 holds: 'budget', 'lost' or a status
const result = pace(0, 0, 0, 0, 1);
const scratch = pace(0, 0, 0, 0, 1);
// Inputs of the last pace render, so messages without a new judgement skip it.
const seen = { great: -1, ok: -1, miss: -1, notes: -1, target: -1 };
let fullBudget = 0; // the OK budget before the first judgement, for the gauge
let armed = false; // spending animates only after the attempt's first render in view

// Latest value of every subscribed pointer, copied out of the client's reused frame object.
const KEYS = Object.keys(P);
const POINTERS = Object.values(P);
const data = {};
for (const key of KEYS) data[key] = undefined;

// ------------------------------------------------------------------ gauge
// The fill's scaleY in steps of 1/240 (0.2 px of the 48 px gauge), one string per step, built once.
const STEPS = 240;
const scaleText = new Array(STEPS + 1).fill(null);
const scaleOf = k => scaleText[k] ?? (scaleText[k] = `scaleY(${(k / STEPS).toFixed(4)})`);
let gaugeK = 0;
let ghostK = -1;

function setGauge(k) {
  if (k === gaugeK) return;
  gaugeK = k;
  fill.style.transform = scaleOf(k);
}

// ------------------------------------------------------------------ motion
// Created once and restarted per event (motion brief rule 3).
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
// Tick-down: the new budget drops into place, as a counter rolling down.
const tick = heroNum.animate(
  [{ transform: 'translateY(-0.18em)', opacity: 0.25 }, { transform: 'translateY(0)', opacity: 1 }],
  { duration: MOTION_MS.base, easing: EASE_OUT },
);
// The part of the gauge just spent, in the judgement's colour, holding briefly and fading.
const fade = ghost.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: MOTION_MS.slow, easing: 'linear' });
tick.cancel();
fade.cancel();

function restart(animation) {
  animation.currentTime = 0;
  animation.play();
}

// One OK or miss spent budget (or, past the target, lowered the best possible accuracy).
function spend(kind, fromK) {
  if (motion !== 'full') return; // reduced keeps the gauge easing; the tick and ghost are event flashes
  restart(tick);
  if (fromK <= gaugeK) return;
  if (fromK !== ghostK) { ghostK = fromK; ghost.style.transform = scaleOf(fromK); }
  if (ghost.dataset.kind !== kind) ghost.dataset.kind = kind;
  restart(fade);
}

// ------------------------------------------------------------------ layout from the page's box
// Design sizes at --u = 1: row 280×80 (the chip), column 200×156 (+24 with an extras line). Lines
// are 20 px: the chip's 48 px content height takes two beside the hero, so there extras replace the
// miss line (data-rows 2); a row box with 60 px of content or more shows all three.
let lastU = '';
function layout() {
  const W = innerWidth;
  const H = innerHeight;
  if (!W || !H) return;
  const shape = config.orientation === 'vertical' ? 'column'
    : config.orientation === 'horizontal' ? 'row'
    : W / H < 1.6 ? 'column' : 'row';
  const u = Math.max(0.5, shape === 'row' ? Math.min(W / 280, H / 80) : Math.min(W / 200, H / (extras.hidden ? 156 : 180)));
  const rows = shape === 'row' && H / u - 32 < 60 ? '2' : '3';
  if (root.dataset.layout !== shape) root.dataset.layout = shape;
  if (root.dataset.rows !== rows) root.dataset.rows = rows;
  const text = u.toFixed(3);
  if (text !== lastU) { lastU = text; root.style.setProperty('--u', text); }
}

// ------------------------------------------------------------------ model -> view
// Gameplay only: osu! song select and results already show what this would add there, and the
// page's box is placed for gameplay (under the lane).
function viewOf() {
  if (status !== 'live') return status;
  const state = known(data.state);
  if (!isKnown(state)) return 'idle'; // osu! is not running
  if (state !== 2) return 'hidden';
  return activeMode(state, data.playMode, data.settingsMode) === 'taiko' ? 'pace' : 'hidden';
}

function setTone(next) {
  if (next === tone) return;
  tone = next;
  root.dataset.tone = next;
}

function showTarget() {
  put(T.target, F.target(config.target));
}

// Line 2: "or 10 misses", "below 99.50%" (the target, once out of reach), or the connection status.
function setLine2(mode) {
  if (mode === line2) return;
  line2 = mode;
  if (mode === 'budget') {
    put(T.l2a, 'or');
    hide(l2Group, false);
    hide(l2Unit, true);
  } else if (mode === 'lost') {
    put(T.l2a, 'below');
    hide(l2Group, false);
    hide(l2Unit, false);
    put(T.l2b, '');
  } else {
    put(T.l2a, STATUS_TEXT[mode] ?? '');
    hide(l2Group, true);
    put(T.l2b, '');
  }
}

function showBudget(okBudget, missBudget) {
  put(T.hero, okBudget === null ? DASH : F.budget(okBudget));
  hide(heroFrac, true);
  hide(heroUnit, true);
  put(T.l1, okBudget === 1 ? 'OK left for' : 'OKs left for');
  hide(targetGroup, false);
  setLine2('budget');
  put(T.l2n, missBudget === null ? DASH : F.misses(missBudget));
  put(T.l2b, missBudget === 1 ? 'miss' : 'misses');
}

function renderStatus(next) {
  setTone('idle');
  showBudget(null, null);
  setLine2(next);
  setGauge(0);
  seen.great = -1; // re-render the pace once play resumes
}

function renderPace(great, ok, miss, notes) {
  const target = config.target / 100;
  if (!notes) {
    setTone('idle');
    showBudget(null, null);
    setGauge(0);
    return;
  }
  if (notes !== seen.notes || config.target !== seen.target) fullBudget = pace(0, 0, 0, notes, target, scratch).okBudget ?? 0;
  const fromK = gaugeK;
  const spent = armed && (ok > seen.ok || miss > seen.miss);
  const kind = miss > seen.miss ? 'miss' : 'ok';
  const p = pace(great, ok, miss, notes, target, result);
  if (p.lost) {
    setTone('lost');
    // Best accuracy still possible, hundredths floored, with its decimals as the hero's fraction.
    const key = Math.floor(p.max * 1e4 + 1e-6) | 0; // 0..10000
    put(T.hero, F.bestWhole((key - key % 100) / 100));
    put(T.heroFrac, fracOf(key % 100));
    hide(heroFrac, false);
    hide(heroUnit, false);
    put(T.l1, 'Best possible');
    hide(targetGroup, true);
    setLine2('lost');
    put(T.l2n, F.target(config.target));
    setGauge(0);
  } else {
    const fraction = fullBudget > 0 ? p.okBudget / fullBudget : 0;
    // Under a tenth of the budget the hero and gauge turn to the miss colour (a budget running out).
    setTone(fraction <= 0.1 ? 'low' : 'budget');
    showBudget(p.okBudget, p.missBudget);
    setGauge(Math.round(Math.min(1, fraction) * STEPS));
  }
  if (spent) spend(kind, fromK);
}

function renderExtras(great, ok, miss, judged) {
  if (config.hudFields) {
    put(T.acc, F.acc(judged ? floorPct((great + ok / 2) / judged) : NaN));
    put(T.great, F.great(great));
    put(T.ok, F.ok(ok));
    put(T.miss, F.miss(miss));
  }
  if (config.showUr) put(T.ur, F.ur(judged > 1 ? known(data.ur) : NaN));
  if (config.showPp) {
    put(T.pp, F.pp(known(data.pp)));
    put(T.fc, F.fc(known(data.fc, true)));
  }
}

function render() {
  const next = viewOf();
  const shape = next === 'pace' || next === 'hidden' ? next : 'status';
  if (shape !== view) {
    view = shape;
    root.dataset.view = shape;
    armed = false;
  }
  if (shape === 'hidden') return;
  showTarget();
  if (shape === 'status') { renderStatus(next); return; }

  const great = int(data.great) ?? 0;
  const ok = int(data.ok) ?? 0;
  const miss = int(data.miss) ?? 0;
  const notes = int(data.notes) || int(data.circles) || 0; // 0: unknown
  const judged = great + ok + miss;
  if (judged < seen.great + seen.ok + seen.miss) armed = false; // retry: the gauge refills, nothing flashes
  // Most messages carry no new judgement: the budget then stays as it is.
  if (great !== seen.great || ok !== seen.ok || miss !== seen.miss || notes !== seen.notes || config.target !== seen.target) {
    renderPace(great, ok, miss, notes);
    seen.great = great;
    seen.ok = ok;
    seen.miss = miss;
    seen.notes = notes;
    seen.target = config.target;
    armed = true;
  }
  if (!extras.hidden) renderExtras(great, ok, miss, judged);
}

// ------------------------------------------------------------------ frame (coalesces messages; no loop)
let raf = 0;
function invalidate() {
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame() {
  raf = 0;
  if (dataDirty) { dataDirty = false; render(); }
}

// ------------------------------------------------------------------ wiring
addEventListener('resize', layout);

settings(DEFAULTS, s => {
  const target = Math.min(100, Math.max(50, Number(s.target) || DEFAULTS.target));
  config = {
    ...s,
    target: Math.round(target * 100) / 100,
    orientation: ['auto', 'horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto',
    align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
  };
  motion = applyKitSettings(root, s);
  if (motion !== 'full') { tick.cancel(); fade.cancel(); }
  if (root.dataset.align !== config.align) root.dataset.align = config.align;
  for (const node of hudItems) hide(node, !config.hudFields);
  hide(urItem, !config.showUr);
  hide(ppItem, !config.showPp);
  const anyExtras = config.hudFields || config.showUr || config.showPp;
  hide(extras, !anyExtras);
  root.toggleAttribute('data-extras', anyExtras);
  layout();
  armed = false;
  seen.great = -1; // re-render with the new target and fields
  dataDirty = true;
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

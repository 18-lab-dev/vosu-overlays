// Copyright (c) 2026 18-LAB. MIT.
// Performance counter: live pp with a count-up readout, if-FC and max-achievable markers on a
// pp rail scaled to the map's SS value, the accuracy→pp ladder in song select, and final pp at
// results. Data handlers only record values; one rAF loop renders and stops once settled.
import { subscribe, settings, fit, activeMode, MODE_LABELS } from './vosu-overlay.js';

const W = 424;
const H = 236;
const TEXT_MS = 50;     // readout text writes are throttled to 20 Hz while a tween runs
const TWEEN_MS = 480;   // count-up duration (ease-out expo); ~97 % of the way by 240 ms

const P = {
  state: '/state/number', playMode: '/play/mode/number', setMode: '/settings/mode/number',
  source: '/play/source', failed: '/play/failed', mods: '/play/mods/name', stars: '/beatmap/stats/stars/total',
  cur: '/play/pp/current', fc: '/play/pp/fc', max: '/play/pp/maxAchievable',
  rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc', rAcc: '/resultsScreen/accuracy', rRank: '/resultsScreen/rank',
};
// Breakdown components: label plus current/fc pointers, resolved once.
const PART = {};
for (const [key, label] of [['aim', 'Aim'], ['speed', 'Speed'], ['accuracy', 'Accuracy'], ['flashlight', 'Flashlight'], ['difficulty', 'Difficulty']]) {
  PART[key] = { label, cur: `/play/pp/detailed/current/${key}`, fc: `/play/pp/detailed/fc/${key}` };
  P[`c_${key}`] = PART[key].cur;
  P[`f_${key}`] = PART[key].fc;
}
const OSU_PARTS = [PART.aim, PART.speed, PART.accuracy, PART.flashlight];
const OTHER_PARTS = [PART.difficulty, PART.accuracy];
const LADDER = ['95', '97', '98', '99', '100'];
const LADDER_P = LADDER.map(a => `/performance/accuracy/${a}`);
LADDER_P.forEach((pointer, i) => { P[`a${LADDER[i]}`] = pointer; });
const STATE_LABEL = { 5: 'Select', 13: 'Select', 6: 'Select', 1: 'Editor', 4: 'Editor', 11: 'Lobby', 12: 'Lobby' };
const SOURCE_LABEL = { player: 'Live', replay: 'Replay', spectator: 'Spectating', watching: 'Spectating', autoplay: 'Auto' };

const $ = id => document.getElementById(id);
const el = {
  panel: $('panel'), brand: $('brand'), mods: $('mods'), mode: $('mode'), state: $('state'),
  kicker: $('kicker'), int: $('int'), frac: $('frac'), rowA: $('rowA'), rowB: $('rowB'),
  labelA: $('labelA'), labelB: $('labelB'), valA: $('valA'), valB: $('valB'),
  rail: $('rail'), scaleMax: $('scaleMax'), ladder: $('ladder'), chips: $('chips'),
  status: $('status'), statusText: $('statusText'),
};
const ladderValues = [...el.ladder.querySelectorAll('b')];
const bigEl = el.int.parentElement;
const sideEl = el.rowA.parentElement;

// Chip pool: four cells (label, value, share bar), filled per view.
const chips = [];
for (let i = 0; i < 4; i++) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  const value = document.createElement('b');
  const share = document.createElement('i');
  label.className = 'label';
  li.append(label, value, share);
  li.hidden = true;
  el.chips.append(li);
  chips.push({ li, label, value, share, text: { label: '', value: '', share: -1, tone: '' } });
}

// ---------------------------------------------------------------------------------------------
// Cached DOM writers: every write is skipped when the string (or flag) is unchanged.
const cache = new Map();
function text(node, value) {
  if (cache.get(node) === value) return;
  cache.set(node, value);
  node.textContent = value;
}
function attr(node, name, value) {
  let entry = cache.get(node);
  if (!entry || typeof entry !== 'object') { entry = {}; cache.set(node, entry); }
  if (entry[name] === value) return;
  entry[name] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}
function show(node, visible) {
  if (node.hidden === !visible) return;
  node.hidden = !visible;
}

// ---------------------------------------------------------------------------------------------
// Settings
// `decimals` is an options setting (strings in settings.json); a numeric default coerces either form.
let opt = { showBrand: true, showIfFc: true, showMax: true, showLadder: true, showBreakdown: true, decimals: 1 };
let decimals = 1;

// ---------------------------------------------------------------------------------------------
// Data
let values = {};
let modelDirty = true;
let online = 'connecting';

const num = pointer => { const v = values[pointer]; return typeof v === 'number' && Number.isFinite(v) ? v : NaN; };
const pos = pointer => { const v = num(pointer); return v > 0 ? v : NaN; };

// ---------------------------------------------------------------------------------------------
// Tweens: fixed-duration ease-out (expo) from the shown value to the latest target. A new target
// restarts the ease from wherever the readout is, so frequent pp updates chase smoothly and a
// large jump (0 → SS on entering song select) lands in TWEEN_MS instead of crawling its tail.
const tweens = { big: tween(), a: tween(), b: tween() };
let frameNow = 0;
function tween() { return { value: NaN, from: NaN, target: NaN, t0: 0 }; }
function retarget(t, target, from) {
  if (Number.isNaN(target)) { t.value = t.from = t.target = NaN; return; }
  if (from !== undefined) t.value = from;
  else if (Number.isNaN(t.value)) t.value = target;
  if (target === t.target && from === undefined) return;
  t.from = t.value;
  t.target = target;
  t.t0 = frameNow;
}
function step(t, now) {
  if (t.value === t.target || Number.isNaN(t.target)) return false;
  const p = (now - t.t0) / TWEEN_MS;
  t.value = p >= 1 ? t.target : t.from + (t.target - t.from) * (1 - 2 ** (-10 * p));
  return true;
}

// ---------------------------------------------------------------------------------------------
// View model, derived in the frame (never in the socket handler).
let view = 'idle';
const rail = { scale: NaN, ladder: [NaN, NaN, NaN, NaN, NaN] };
let parts = [];
let everLive = false;

function derive() {
  modelDirty = false;
  const state = values[P.state];
  const live = online === 'live';
  const next = !live ? 'offline' : !Number.isInteger(state) ? 'idle' : state === 2 ? 'play' : state === 7 ? 'results' : 'select';

  // Status chip + panel visibility.
  // Retries report 'connecting' between failures; once the socket has dropped it stays "offline".
  if (live) everLive = true;
  else text(el.statusText, online === 'connecting' && !everLive ? 'Connecting to vosu' : 'vosu offline');
  attr(el.status, 'data-state', live ? 'live' : online === 'connecting' && !everLive ? 'connecting' : 'offline');
  attr(el.panel, 'data-view', next);
  show(el.brand, opt.showBrand);

  const mode = activeMode(state, values[P.playMode], values[P.setMode]);
  text(el.mode, mode ? MODE_LABELS[mode] : '');
  const mods = typeof values[P.mods] === 'string' && next !== 'idle' ? values[P.mods] : '';
  text(el.mods, mods && mods !== 'NM' ? mods : '');

  let stateLabel = 'No game';
  let tone = 'idle';
  if (next === 'play') {
    stateLabel = values[P.failed] === true ? 'Failed' : SOURCE_LABEL[values[P.source]] || 'Live';
    tone = values[P.failed] === true ? 'fail' : values[P.source] === 'player' || values[P.source] == null ? 'live' : 'watch';
  } else if (next === 'results') { stateLabel = 'Result'; tone = 'done'; }
  else if (next === 'select') stateLabel = STATE_LABEL[state] || 'Menu';
  text(el.state, stateLabel);
  attr(el.panel, 'data-tone', tone);

  const changed = next !== view;
  const previous = view;
  view = next;
  // A view change counts its readouts up from 0; data that just appeared (source loaded, osu!
  // started, socket back) shows its values at once. Play → results keeps its value continuous.
  const countUp = changed && previous !== 'offline' && previous !== 'idle' ? 0 : undefined;

  for (let i = 0; i < LADDER.length; i++) rail.ladder[i] = pos(LADDER_P[i]);
  const ss = rail.ladder[4];

  if (view === 'play') {
    const cur = num(P.cur), fc = num(P.fc), max = num(P.max);
    text(el.kicker, 'Current');
    text(el.labelA, 'If FC');
    text(el.labelB, 'Max');
    show(el.rowA, opt.showIfFc);
    show(el.rowB, opt.showMax);
    retarget(tweens.big, cur, countUp);
    retarget(tweens.a, fc, countUp);
    retarget(tweens.b, max, countUp);
    rail.scale = maxOf(maxOf(ss, fc), maxOf(max, cur));
    parts = mode === 'osu' ? OSU_PARTS : OTHER_PARTS;
    renderChipsPlay();
  } else if (view === 'results') {
    const final = num(P.rPp), fc = num(P.rFc);
    text(el.kicker, 'Final');
    text(el.labelA, 'If FC');
    text(el.labelB, 'To FC');
    show(el.rowA, true);
    const gap = fc - final;
    show(el.rowB, gap >= 0.5);
    retarget(tweens.big, final, previous !== 'play' ? countUp : undefined);
    retarget(tweens.a, fc, previous !== 'play' ? countUp : undefined);
    retarget(tweens.b, gap >= 0.5 ? gap : NaN);
    rail.scale = maxOf(maxOf(ss, fc), final);
    renderChipsResults();
  } else {
    const stars = pos(P.stars);
    text(el.kicker, view === 'select' ? 'SS' : 'Current');
    text(el.labelA, 'Stars');
    show(el.rowA, view === 'select');
    show(el.rowB, false);
    retarget(tweens.big, view === 'select' ? ss : NaN, view === 'select' ? countUp : undefined);
    retarget(tweens.a, view === 'select' ? stars : NaN);
    retarget(tweens.b, NaN);
    rail.scale = view === 'select' ? ss : NaN;
    for (let i = 0; i < LADDER.length; i++) text(ladderValues[i], Number.isNaN(rail.ladder[i]) ? '—' : Math.round(rail.ladder[i]).toString());
    for (const chip of chips) show(chip.li, false);
  }
  show(el.ladder, view === 'select' && opt.showLadder);
  show(sideEl, !el.rowA.hidden || !el.rowB.hidden);
  show(el.chips, (view === 'play' && opt.showBreakdown) || view === 'results');
  text(el.scaleMax, Number.isNaN(ss) ? 'SS —' : `SS ${Math.round(ss)}`);

  if (changed) textForce = true;
  railDirty = true;
}

function maxOf(a, b) {
  return a > 0 ? (b > a ? b : a) : b > 0 ? b : NaN;
}

function setChip(chip, label, value, share, tone) {
  show(chip.li, true);
  if (chip.text.label !== label) { chip.text.label = label; chip.label.textContent = label; }
  if (chip.text.value !== value) { chip.text.value = value; chip.value.textContent = value; }
  const s = Math.round(share * 200) / 200;
  if (chip.text.share !== s) { chip.text.share = s; chip.share.style.transform = `scaleX(${s})`; }
  if (chip.text.tone !== tone) { chip.text.tone = tone; chip.li.dataset.tone = tone; }
}

function renderChipsPlay() {
  let sum = 0;
  for (const part of parts) { const c = num(part.cur); if (c > 0) sum += c; }
  let n = 0;
  for (const part of parts) {
    const c = num(part.cur), f = num(part.fc);
    if (!(c > 0 || f > 0) || n >= chips.length) continue;
    const v = c > 0 ? c : 0;
    setChip(chips[n++], part.label, Math.round(v).toString(), sum > 0 ? v / sum : 0, '');
  }
  if (n === 0) setChip(chips[n++], 'Breakdown', '—', 0, 'empty');
  for (; n < chips.length; n++) show(chips[n].li, false);
}

function renderChipsResults() {
  const acc = num(P.rAcc);
  const rank = typeof values[P.rRank] === 'string' && values[P.rRank] ? values[P.rRank] : '—';
  setChip(chips[0], 'Rank', rank, 0, 'rank');
  setChip(chips[1], 'Accuracy', Number.isNaN(acc) ? '—' : `${acc.toFixed(2)}%`, 0, '');
  for (let n = 2; n < chips.length; n++) show(chips[n].li, false);
}

// ---------------------------------------------------------------------------------------------
// Rail canvas (DPR-aware, sized only on resize).
const ctx = el.rail.getContext('2d', { alpha: true });
let dpr = 1;
let cw = 0, ch = 0;
let railDirty = true;
let hatch = null;
const css = getComputedStyle(document.documentElement);
const tok = name => css.getPropertyValue(name).trim();
const C = {
  accent: tok('--accent') || '#ff963f', fg: tok('--fg') || '#ebe8e1', dim: tok('--fg-dim') || '#b8b5ad',
  muted: tok('--muted') || '#7e8288', strong: tok('--rule-strong') || '#3b3f45', bg: tok('--bg') || '#111214',
  track: 'rgb(235 232 225 / 0.07)', select: 'rgb(235 232 225 / 0.26)', hatchBg: 'rgb(235 232 225 / 0.05)',
};
const FONT = '"IBM Plex Mono", ui-monospace, monospace';

function buildHatch() {
  const size = Math.max(4, Math.round(5 * dpr));
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgb(184 181 173 / 0.62)';
  t.lineWidth = Math.max(1, Math.round(dpr));
  t.beginPath();
  for (const o of [-size, 0, size]) { t.moveTo(o, size); t.lineTo(o + size, 0); }
  t.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
}

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  dpr = window.devicePixelRatio || 1;
  cw = Math.round(box.width * dpr);
  ch = Math.round(box.height * dpr);
  if (el.rail.width !== cw) el.rail.width = cw;
  if (el.rail.height !== ch) el.rail.height = ch;
  buildHatch();
  setRailFont();
}).observe(el.rail);
document.fonts?.ready.then(setRailFont);

// Rail geometry (CSS px): marker labels 0–10, bar 13–21, graduations 23–27.
const BAR_Y = 13, BAR_H = 8, TICK_Y = 23;

let railScale = 1;
const at = v => Math.max(0, Math.min(cw, Math.round((v / railScale) * cw)));

// Resizing a canvas resets its context state, so the label font is set here, not per frame.
function setRailFont() {
  ctx.font = `500 ${Math.round(10 * dpr)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  widths.clear();
  railDirty = true;
  kick();
}

function drawRail() {
  railDirty = false;
  if (!cw || !ch) return;
  const d = dpr, w = cw, px = Math.max(1, Math.round(d));
  const by = Math.round(BAR_Y * d), bh = Math.round(BAR_H * d), ty = Math.round(TICK_Y * d);
  ctx.clearRect(0, 0, w, ch);
  ctx.fillStyle = C.track;
  ctx.fillRect(0, by, w, bh);
  // Graduations every tenth of the scale; majors at 0, ½ and SS.
  for (let i = 0; i <= 10; i++) {
    const x = Math.min(w - px, Math.round((i / 10) * w));
    const major = i === 0 || i === 5 || i === 10;
    ctx.fillStyle = major ? C.muted : C.strong;
    ctx.fillRect(x, ty, px, Math.round((major ? 5 : 3) * d));
  }
  if (!(rail.scale > 0)) return;
  railScale = rail.scale;
  occupied = 0;

  if (view === 'select') {
    // The band sweeps out with the SS count-up: solid to 95 %, hatched 95 → 100 % with notches
    // at 97/98/99 % (solid all the way when the ladder is hidden).
    const reach = tweens.big.value > 0 ? at(tweens.big.value) : 0;
    const lo = rail.ladder[0];
    const x = opt.showLadder && lo > 0 ? Math.min(reach, at(lo)) : reach;
    ctx.fillStyle = C.select;
    ctx.fillRect(0, by, x, bh);
    if (reach > x) {
      ctx.fillStyle = C.hatchBg;
      ctx.fillRect(x, by, reach - x, bh);
      ctx.fillStyle = hatch;
      ctx.fillRect(x, by, reach - x, bh);
      ctx.fillStyle = C.bg;
      for (let i = 1; i < 4; i++) {
        const n = rail.ladder[i] > 0 ? Math.min(w - px * 2, at(rail.ladder[i])) : -1;
        if (n > x && n < reach) ctx.fillRect(n, by, px * 2, bh);
      }
      place(x, '95%', C.dim, START, START);
    }
    if (reach > 0) {
      ctx.fillStyle = C.accent;
      ctx.fillRect(Math.max(0, reach - px * 2), by - Math.round(2 * d), px * 2, bh + Math.round(4 * d));
    }
    return;
  }

  const fill = tweens.big.value;
  const fc = view === 'play' ? (opt.showIfFc ? tweens.a.value : NaN) : tweens.a.value;
  const potential = view === 'play' ? (opt.showMax ? tweens.b.value : NaN) : tweens.a.value;
  const fx = fill > 0 ? at(fill) : 0;
  let mx = -1;
  if (potential > fill) {
    mx = at(potential);
    ctx.fillStyle = C.hatchBg;
    ctx.fillRect(fx, by, mx - fx, bh);
    ctx.fillStyle = hatch;
    ctx.fillRect(fx, by, mx - fx, bh);
    if (view === 'play') {
      ctx.fillStyle = C.dim;
      ctx.fillRect(Math.max(0, mx - px), by, px, bh);
    }
  }
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, by, fx, bh);
  // FC owns its label; MAX takes whichever side of its tick is free, or stays unlabelled.
  if (fc > 0) {
    const x = Math.min(w - px, at(fc));
    ctx.fillStyle = C.fg;
    ctx.fillRect(x, Math.round(11 * d), px, by + bh + Math.round(2 * d) - Math.round(11 * d));
    place(x, 'FC', C.fg, CENTER, CENTER);
  }
  if (mx >= 0 && view === 'play') place(mx, 'MAX', C.dim, END, START);
}

// Marker labels: up to four occupied [left, right] spans, checked before each label is drawn.
const START = 0, END = 1, CENTER = 2;
const spans = new Float64Array(8);
let occupied = 0;
const widths = new Map();
function place(x, label, color, first, second) {
  let width = widths.get(label);
  if (width === undefined) { width = ctx.measureText(label).width; widths.set(label, width); }
  const gap = 6 * dpr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const align = attempt === 0 ? first : second;
    let left = align === START ? x + 2 * dpr : align === END ? x - width - 2 * dpr : x - width / 2;
    left = Math.round(Math.max(0, Math.min(cw - width, left)));
    let free = true;
    for (let i = 0; i < occupied; i++) if (left < spans[i * 2 + 1] + gap && left + width + gap > spans[i * 2]) free = false;
    if (!free) continue;
    ctx.fillStyle = color;
    ctx.fillText(label, left, Math.round(9 * dpr));
    if (occupied < 4) { spans[occupied * 2] = left; spans[occupied * 2 + 1] = left + width; occupied++; }
    return;
  }
}

// ---------------------------------------------------------------------------------------------
// Frame loop: one rAF, stops when every tween has settled and nothing is dirty.
let raf = 0;
let lastText = 0;
let textForce = true;

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  frameNow = now;
  if (modelDirty) derive();
  const moving = step(tweens.big, now) | step(tweens.a, now) | step(tweens.b, now);
  if (moving) railDirty = true;
  if (textForce || !moving || now - lastText >= TEXT_MS) {
    writeText();
    lastText = now;
    textForce = false;
  }
  if (railDirty) drawRail();
  if (moving) kick();
}

function split(v) {
  if (Number.isNaN(v)) return ['—', ''];
  const s = v.toFixed(decimals);
  const dot = s.indexOf('.');
  return dot < 0 ? [s, ''] : [s.slice(0, dot), s.slice(dot)];
}

function writeText() {
  const [i, f] = split(tweens.big.value);
  text(el.int, i);
  attr(bigEl, 'data-empty', f === '' && i === '—' ? '' : null);
  text(el.frac, f);
  const a = tweens.a.value;
  if (view === 'select') text(el.valA, Number.isNaN(a) ? '—' : a.toFixed(2));
  else text(el.valA, Number.isNaN(a) ? '—' : a.toFixed(decimals));
  const b = tweens.b.value;
  text(el.valB, Number.isNaN(b) ? '—' : (view === 'results' ? '+' : '') + b.toFixed(decimals));
}

// ---------------------------------------------------------------------------------------------
// Start-up (after every binding above exists: both calls report synchronously).
fit(document.getElementById('stage'), W, H);
settings(opt, next => {
  opt = next;
  decimals = Math.max(0, Math.min(2, Math.round(Number(next.decimals)) || 0));
  modelDirty = true;
  textForce = true;
  railDirty = true;
  kick();
});

subscribe(Object.values(P), v => { values = v; modelDirty = true; kick(); }, {
  onStatus: state => {
    if (state === online) return;
    online = state;
    modelDirty = true;
    kick();
  },
});


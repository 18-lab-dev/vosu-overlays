// Copyright (c) 2026 18-LAB. MIT.
// Performance counter. During play: current pp counting up, if-FC and max achievable, a rail scaled
// to the map's SS value and the non-zero pp components. Song select: the accuracy→pp ladder (osu!
// never shows pp there). Results: what the results screen lacks. The page is content-sized: hosts
// (OBS, vosulay, the replay renderer) place and size it, and the layout re-flows to the box —
// a vertical column or a horizontal strip, scaled from the box. Data handlers only record values;
// one rAF loop renders and stops once settled.
import { subscribe, settings, activeMode, mapPalette, applyPalette } from './vosu-overlay.js';

const TEXT_MS = 50;     // readout text writes are throttled to 20 Hz while a tween runs
const TWEEN_MS = 480;   // count-up duration (ease-out expo); ~97 % of the way by 240 ms
const AMBER = '#ff963f';
// Design boxes at --u = 1; the page scales its type and graphics from the box it is given.
const VERTICAL = { w: 300, h: 184 };
const HORIZONTAL = { w: 720, h: 80 };

const P = {
  state: '/state/number', client: '/client', playMode: '/play/mode/number', setMode: '/settings/mode/number',
  source: '/play/source', failed: '/play/failed', checksum: '/beatmap/checksum',
  cur: '/play/pp/current', fc: '/play/pp/fc', max: '/play/pp/maxAchievable',
  rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc',
};
const PART_LABELS = [['aim', 'Aim'], ['speed', 'Speed'], ['accuracy', 'Acc'], ['flashlight', 'FL'], ['difficulty', 'Diff']];
for (const [key] of PART_LABELS) {
  P[`c_${key}`] = `/play/pp/detailed/current/${key}`;
  P[`f_${key}`] = `/play/pp/detailed/fc/${key}`;
}
const LADDER = ['95', '97', '98', '99', '100'];
for (const a of LADDER) P[`a${a}`] = `/performance/accuracy/${a}`;
// Every pointer gets a fixed slot in `D`, the overlay's own copy of the latest values (the
// client reuses its values object for every frame, so it is copied in the handler, not kept).
const POINTERS = Object.values(P);
const I = {};
Object.keys(P).forEach((key, i) => { I[key] = i; });
const D = POINTERS.map(() => undefined);
// Breakdown components: label plus current/fc slots, resolved once.
const PART = {};
for (const [key, label] of PART_LABELS) PART[key] = { label, cur: I[`c_${key}`], fc: I[`f_${key}`] };
const OSU_PARTS = [PART.aim, PART.speed, PART.accuracy, PART.flashlight];
const OTHER_PARTS = [PART.difficulty, PART.accuracy];
const LADDER_I = LADDER.map(a => I[`a${a}`]);
const SELECT_STATES = new Set([5, 6, 13]);
const SOURCE_LABEL = { player: 'Live', replay: 'Replay', spectator: 'Spectating', watching: 'Spectating', autoplay: 'Auto' };

const $ = id => document.getElementById(id);
const el = {
  root: $('root'), kicker: $('kicker'), state: $('state'),
  int: $('int'), frac: $('frac'), big: $('big'), rowA: $('rowA'), rowB: $('rowB'),
  labelA: $('labelA'), labelB: $('labelB'), valA: $('valA'), valB: $('valB'),
  rail: $('rail'), scaleMax: $('scaleMax'), ladder: $('ladder'), chips: $('chips'),
};
const ladderValues = [...el.ladder.querySelectorAll('b')];

// Chip pool: up to four inline label/value pairs.
const chips = [];
for (let i = 0; i < 4; i++) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  const value = document.createElement('b');
  label.className = 'label';
  li.append(label, value);
  li.hidden = true;
  el.chips.append(li);
  chips.push({ li, label, value });
}

// ---------------------------------------------------------------------------------------------
// Cached DOM writers: every write is skipped when the string (or flag) is unchanged. Numbers are
// cached as numbers before these (see `shown*` below), so strings are only built when they change.
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
// Settings. `decimals` is an options setting (strings in settings.json); a numeric default coerces
// either form.
let opt = {
  orientation: 'auto', align: 'auto', backing: 'none', accent: 'map',
  showIfFc: true, showMax: true, showBreakdown: true, showLadder: true, decimals: 1,
};
let decimals = 1;
let scale = 10;         // 10 ** decimals
let fracs = [''];       // '.0' … '.9' (or '.00' … '.99'): every fraction string, built per setting
function setDecimals(next) {
  decimals = next;
  scale = 10 ** next;
  fracs = [];
  for (let i = 0; i < scale; i++) fracs.push(next ? '.' + String(i).padStart(next, '0') : '');
  shown.fill(-2);
  shownValue.fill(NaN);
}

// ---------------------------------------------------------------------------------------------
// Layout: orientation from the box's aspect (or the setting), type/graphics scaled from the box
// through --u. Runs on resize and on settings changes, never per frame.
function layout() {
  const w = innerWidth || VERTICAL.w, h = innerHeight || VERTICAL.h;
  const orient = opt.orientation === 'horizontal' || opt.orientation === 'vertical' ? opt.orientation
    : w / h >= 2.4 ? 'horizontal' : 'vertical';
  const base = orient === 'horizontal' ? HORIZONTAL : VERTICAL;
  const pad = opt.backing === 'scrim' || opt.backing === 'panel' ? 1 : 0;   // backing adds 12/10 u padding
  const u = Math.max(0.35, Math.min(4, Math.min(w / (base.w + 24 * pad), h / (base.h + 20 * pad))));
  const align = ['left', 'center', 'right'].includes(opt.align) ? opt.align : orient === 'vertical' ? 'right' : 'left';
  el.root.dataset.orient = orient;
  el.root.dataset.align = align;
  el.root.style.setProperty('--u', u.toFixed(4));
}
addEventListener('resize', layout);

// ---------------------------------------------------------------------------------------------
// Data
let modelDirty = true;
let online = 'connecting';

const num = slot => { const v = D[slot]; return typeof v === 'number' && Number.isFinite(v) ? v : NaN; };
const pos = slot => { const v = num(slot); return v > 0 ? v : NaN; };

// Per-frame numeric state lives in typed arrays: module-level `let` doubles would box a fresh
// heap number on every write.
const F = new Float64Array(3);
const NOW = 0, LAST_TEXT = 1, RAIL_SCALE = 2;
F[RAIL_SCALE] = NaN;

// ---------------------------------------------------------------------------------------------
// Tweens: fixed-duration ease-out (expo) from the shown value to the latest target. A new target
// restarts the ease from wherever the readout is, so frequent pp updates chase smoothly and a big
// jump lands in TWEEN_MS instead of crawling its tail. Five slots per tween: value, from, target,
// t0 and the incoming target, which derive() writes before retarget() reads it (a double passed as
// an argument would be boxed per call).
const BIG = 0, A = 5, B = 10, FILL = 15, FC = 20, MAX = 25;
const IN = 4;
const T = new Float64Array(30);
for (let o = 0; o < T.length; o += 5) T[o] = T[o + 1] = T[o + 2] = T[o + IN] = NaN;
function retarget(o, countUp) {
  const target = T[o + IN];
  if (target !== target) { T[o] = T[o + 1] = T[o + 2] = NaN; return; }
  if (countUp) T[o] = 0;
  else if (T[o] !== T[o]) T[o] = target;
  if (target === T[o + 2] && !countUp) return;
  T[o + 1] = T[o];
  T[o + 2] = target;
  T[o + 3] = F[NOW];
}

// ---------------------------------------------------------------------------------------------
// Map tint: M3 tonal-spot roles from the map background, loaded per checksum off the hot path.
let checksum = null;
let palette = null;
let railAccent = AMBER;
function loadPalette(next) {
  if (next === checksum) return;
  checksum = next;
  mapPalette(next).then(p => {
    if (checksum !== next) return;
    palette = p;
    applyPalette(el.root, p);
    tint();
  });
}
function tint() {
  railAccent = opt.accent === 'map' && palette ? palette.accent : AMBER;
  railDirty = true;
  kick();
}

// ---------------------------------------------------------------------------------------------
// View model, derived in the frame (never in the socket handler).
let view = 'offline';
let parts = OSU_PARTS;
let everLive = false;
let extrasDirty = false;  // breakdown chips and the rail's SS label, written with the readout text

function derive() {
  modelDirty = false;
  const state = D[I.state];
  const live = online === 'live';
  if (live) everLive = true;
  const next = !live ? 'offline'
    : !Number.isInteger(state) ? 'idle'
      : state === 2 ? 'play'
        : state === 7 ? 'results'
          : SELECT_STATES.has(state) && opt.showLadder ? 'select'
            : 'hidden';
  const mode = activeMode(state, D[I.playMode], D[I.setMode]);
  const sum = D[I.checksum];
  if (live) loadPalette(typeof sum === 'string' && sum ? sum : null);

  const changed = next !== view;
  const previous = view;
  view = next;
  attr(el.root, 'data-view', next);
  // A view change counts readouts up from 0; data that just appeared (page loaded, osu! started,
  // socket back) shows at once.
  const countUp = changed && previous !== 'offline' && previous !== 'idle' && previous !== 'hidden';

  let stateLabel = '';
  let tone = 'idle';
  if (next === 'offline') { stateLabel = online === 'connecting' && !everLive ? 'Connecting to vosu' : 'vosu offline'; tone = online === 'connecting' && !everLive ? 'wait' : 'down'; }
  else if (next === 'idle') stateLabel = 'osu! not running';
  else if (next === 'play') {
    const failed = D[I.failed] === true;
    const source = D[I.source];
    stateLabel = failed ? 'Failed' : SOURCE_LABEL[source] || 'Live';
    tone = failed ? 'fail' : source === 'player' || source == null ? 'live' : 'watch';
  } else if (next === 'results') { stateLabel = 'Result'; tone = 'done'; }
  else if (next === 'select') stateLabel = 'by accuracy';
  text(el.state, stateLabel);
  text(el.kicker, next === 'offline' || next === 'idle' ? ''
    : next === 'results' && D[I.client] === 'lazer' ? 'pp if FC' : 'pp');
  attr(el.root, 'data-tone', tone);

  const fade = NaN;
  if (next === 'play') {
    const cur = num(I.cur), fc = num(I.fc), max = num(I.max), ss = pos(LADDER_I[4]);
    text(el.labelA, 'If FC');
    text(el.labelB, 'Max');
    show(el.rowA, opt.showIfFc);
    show(el.rowB, opt.showMax);
    T[BIG + IN] = T[FILL + IN] = cur;
    T[A + IN] = T[FC + IN] = opt.showIfFc ? fc : fade;
    T[B + IN] = T[MAX + IN] = opt.showMax ? max : fade;
    retarget(BIG, countUp);
    retarget(A, countUp);
    retarget(B, countUp);
    retarget(FILL, countUp);
    retarget(FC, countUp);
    retarget(MAX, countUp);
    // The replay renderer and tosu may report no accuracy ladder: the rail then spans the
    // largest of the live values (each pair: the larger positive one, else NaN).
    const ssFc = ss > 0 ? (fc > ss ? fc : ss) : fc > 0 ? fc : NaN;
    const maxCur = max > 0 ? (cur > max ? cur : max) : cur > 0 ? cur : NaN;
    F[RAIL_SCALE] = ssFc > 0 ? (maxCur > ssFc ? maxCur : ssFc) : maxCur > 0 ? maxCur : NaN;
    parts = mode === 'osu' ? OSU_PARTS : OTHER_PARTS;
    show(el.chips, opt.showBreakdown);
    extrasDirty = true;
  } else if (next === 'results') {
    // osu!stable's results screen shows no pp at all; lazer shows the final pp, so there the
    // big readout is the if-FC value instead.
    const final = num(I.rPp), fc = num(I.rFc), gap = fc - final;
    const lazer = D[I.client] === 'lazer';
    text(el.labelA, 'If FC');
    text(el.labelB, 'To FC');
    show(el.rowA, !lazer);
    show(el.rowB, gap >= 0.5);
    T[BIG + IN] = lazer ? fc : final;
    T[A + IN] = lazer ? fade : fc;
    T[B + IN] = gap >= 0.5 ? gap : fade;
    retarget(BIG, countUp);
    retarget(A, countUp);
    retarget(B, countUp);
  } else if (next === 'select') {
    for (let i = 0; i < LADDER.length; i++) {
      const v = pos(LADDER_I[i]);
      const r = v !== v ? -1 : Math.round(v);
      if (r === shownLadder[i]) continue;
      shownLadder[i] = r;
      text(ladderValues[i], r < 0 ? '—' : r.toFixed(0));
    }
  }
  if (changed) textForce = true;
  railDirty = true;
}

// Breakdown chips and the SS label: whole pp, rebuilt only when the rounded number changes.
const shownChip = new Int32Array(4).fill(-1);
const shownLadder = new Int32Array(5).fill(-2);
const shownSs = new Int32Array(1).fill(-2);
function renderExtras() {
  extrasDirty = false;
  let n = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const c = num(part.cur), f = num(part.fc);
    if (!(c > 0 || f > 0) || n >= chips.length) continue;
    const chip = chips[n];
    show(chip.li, true);
    text(chip.label, part.label);
    const r = Math.round(c > 0 ? c : 0);
    if (r !== shownChip[n]) { shownChip[n] = r; text(chip.value, r.toFixed(0)); }
    n++;
  }
  for (; n < chips.length; n++) show(chips[n].li, false);
  const ss = pos(LADDER_I[4]);
  const r = ss !== ss ? -1 : Math.round(ss);
  if (r !== shownSs[0]) { shownSs[0] = r; text(el.scaleMax, r < 0 ? 'max' : 'SS ' + r.toFixed(0)); }
}

// ---------------------------------------------------------------------------------------------
// Rail canvas, sized only on resize. Geometry in design units (the canvas is 30 units tall at any
// scale): marker labels 0–12, bar 16–22, graduations 25–29.
const ctx = el.rail.getContext('2d', { alpha: true });
let k = 1;              // device px per design unit
let cw = 0, ch = 0;
let railDirty = true;
let hatch = null;
const C = {
  fg: '#ebe8e1', dim: '#d2cfc7', track: 'rgb(11 12 13 / 0.5)', tick: 'rgb(235 232 225 / 0.55)', tickMajor: '#ebe8e1',
  hatchBg: 'rgb(11 12 13 / 0.35)', shadow: 'rgb(0 0 0 / 0.85)',
};
const FONT = '"IBM Plex Mono", ui-monospace, monospace';
const BAR_Y = 16, BAR_H = 6, TICK_Y = 25, LABEL_Y = 11;

function buildHatch() {
  const size = Math.max(4, Math.round(5 * k));
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgb(235 232 225 / 0.7)';
  t.lineWidth = Math.max(1, Math.round(k));
  t.beginPath();
  for (const o of [-size, 0, size]) { t.moveTo(o, size); t.lineTo(o + size, 0); }
  t.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
}

// Resizing a canvas resets its context state, so the label font and the marker shadow geometry
// are set here, not per frame (the shadow only shows while shadowColor is opaque: markers), along
// with every device-pixel coordinate that depends only on the canvas size. Canvas arguments stay
// integers (`| 0`): a computed fractional double passed to the canvas binding is boxed per call.
let px = 1, barY = 0, barH = 0, tickY = 0, majorH = 0, minorH = 0, fcTop = 0, fcH = 0, labelY = 0;
const tickX = new Int32Array(11);
const LABEL_TEXT = ['FC', 'MAX'];
const labelW = new Float64Array(2);
function setRailFont() {
  ctx.font = `500 ${Math.round(12 * k)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 2 * k;
  ctx.shadowOffsetY = k;
  px = Math.max(1, Math.round(k));
  barY = Math.round(BAR_Y * k);
  barH = Math.round(BAR_H * k);
  tickY = Math.round(TICK_Y * k);
  majorH = Math.round(5 * k);
  minorH = Math.round(3 * k);
  fcTop = Math.round(13 * k);
  fcH = barY + barH + Math.round(2 * k) - fcTop;
  labelY = Math.round(LABEL_Y * k);
  // Graduations every tenth of the scale; majors at 0, ½ and the end.
  for (let i = 0; i <= 10; i++) tickX[i] = Math.min(cw - px, Math.round((i / 10) * cw));
  for (let i = 0; i < LABEL_TEXT.length; i++) labelW[i] = ctx.measureText(LABEL_TEXT[i]).width;
  railDirty = true;
  kick();
}

function drawRail() {
  railDirty = false;
  if (!cw || !ch) return;
  const w = cw;
  const by = barY, bh = barH;
  ctx.clearRect(0, 0, w, ch);
  if (view !== 'play') return;
  ctx.fillStyle = C.track;
  ctx.fillRect(0, by - px, w, bh + 2 * px);
  // A light hairline under the bar keeps the rail's full length readable on dark backgrounds.
  ctx.fillStyle = C.tick;
  ctx.fillRect(0, by + bh, w, px);
  for (let i = 0; i <= 10; i++) {
    const major = i === 0 || i === 5 || i === 10;
    ctx.fillStyle = major ? C.tickMajor : C.tick;
    ctx.fillRect(tickX[i], tickY, px, major ? majorH : minorH);
  }
  const s = F[RAIL_SCALE];
  if (!(s > 0)) return;
  occupied = 0;
  const fill = T[FILL];
  const fc = T[FC];
  const potential = T[MAX];
  // Value → x, clamped to the rail (inlined: a helper call would box its double argument).
  const fx = fill > 0 ? Math.max(0, Math.min(w, Math.round((fill / s) * w))) | 0 : 0;
  let mx = -1;
  if (potential > fill) {
    mx = Math.max(0, Math.min(w, Math.round((potential / s) * w))) | 0;
    ctx.fillStyle = C.hatchBg;
    ctx.fillRect(fx, by, mx - fx, bh);
    ctx.fillStyle = hatch;
    ctx.fillRect(fx, by, mx - fx, bh);
    ctx.fillStyle = C.dim;
    ctx.fillRect(Math.max(0, mx - px), by - 2 * px, px, bh + 4 * px);
  }
  ctx.fillStyle = railAccent;
  ctx.fillRect(0, by, fx, bh);
  // FC owns its label; MAX takes whichever side of its tick is free, or stays unlabelled.
  ctx.shadowColor = C.shadow;
  if (fc > 0) {
    const x = Math.min(w - px * 2, Math.max(0, Math.min(w, Math.round((fc / s) * w)))) | 0;
    ctx.fillStyle = C.fg;
    ctx.fillRect(x, fcTop, px * 2, fcH);
    placeLabel(x, 0, C.fg, CENTER, CENTER);
  }
  if (mx >= 0) placeLabel(mx, 1, C.dim, END, START);
  ctx.shadowColor = 'transparent';
}

// Marker labels: up to four occupied [left, right] spans, checked before each label is drawn.
const START = 0, END = 1, CENTER = 2;
const spans = new Float64Array(8);
let occupied = 0;
function placeLabel(x, label, color, first, second) {
  const width = labelW[label];
  const gap = 6 * k;
  for (let attempt = 0; attempt < 2; attempt++) {
    const align = attempt === 0 ? first : second;
    // One rounded integer per branch: a fractional double merged from branches would be boxed.
    let left = 0;
    if (align === START) left = Math.round(Math.max(0, Math.min(cw - width, x + 3 * k))) | 0;
    else if (align === END) left = Math.round(Math.max(0, Math.min(cw - width, x - width - 3 * k))) | 0;
    else left = Math.round(Math.max(0, Math.min(cw - width, x - width / 2))) | 0;
    let free = true;
    for (let i = 0; i < occupied; i++) if (left < spans[i * 2 + 1] + gap && left + width + gap > spans[i * 2]) free = false;
    if (!free) continue;
    ctx.fillStyle = color;
    ctx.fillText(LABEL_TEXT[label], left, labelY);
    if (occupied < 4) { spans[occupied * 2] = left; spans[occupied * 2 + 1] = left + width; occupied++; }
    return;
  }
}

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  if (!box.width || !box.height) return;
  const dpr = window.devicePixelRatio || 1;
  cw = Math.round(box.width * dpr);
  ch = Math.round(box.height * dpr);
  k = ch / 30;
  if (el.rail.width !== cw) el.rail.width = cw;
  if (el.rail.height !== ch) el.rail.height = ch;
  buildHatch();
  setRailFont();
}).observe(el.rail);
document.fonts?.ready.then(setRailFont);

// ---------------------------------------------------------------------------------------------
// Frame loop: one rAF, stops when every tween has settled and nothing is dirty.
let raf = 0;
let textForce = true;

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

// Eased value and target, picked by index: one store site that runs every step. A store that only
// runs when a tween settles has no type feedback when the loop is optimised and deopts it, and a
// double merged from two branches (`p >= 1 ? target : …`) is boxed.
const PICK = new Float64Array(2);
function frame(now) {
  raf = 0;
  F[NOW] = now;
  if (modelDirty) derive();
  let moving = false;
  for (let o = 0; o < T.length; o += 5) {
    const target = T[o + 2];
    if (T[o] === target || target !== target) continue;
    const from = T[o + 1];
    const p = (now - T[o + 3]) / TWEEN_MS;
    PICK[0] = from + (target - from) * (1 - 2 ** (-10 * p));
    PICK[1] = target;
    T[o] = PICK[p >= 1 ? 1 : 0];
    moving = true;
  }
  if (moving) railDirty = true;
  if (textForce || !moving || now - F[LAST_TEXT] >= TEXT_MS) {
    writeText();
    F[LAST_TEXT] = now;
    textForce = false;
  }
  if (railDirty) drawRail();
  if (moving) kick();
}

// Readouts (big, A, B) are compared as the scaled integer they display (pp × 10^decimals), so a
// string is built only when the shown text changes. -1 shows '—', -2 forces a write, -3 marks a
// value outside the integer path (negative or huge), formatted by toFixed every time.
const shown = new Int32Array(3);
const shownValue = new Float64Array(3);   // the tween value `shown` was computed from
const shownInt = new Int32Array(1);
const shownPrefix = ['', '', ''];
// Tween o's value as the integer v.toFixed(decimals) prints, without building the string:
// Math.round agrees with toFixed except within float error of a .5 boundary, where toFixed itself
// decides. Recomputed only when the value moved; takes the tween offset, not the value (a double
// argument would be boxed per call).
function scaled(o, slot) {
  const v = T[o];
  if (v === shownValue[slot]) return shown[slot];
  shownValue[slot] = v;
  if (v !== v) return -1;
  if (!(v >= 0) || v >= 1e6) return -3;
  const x = v * scale;
  const n = Math.round(x);
  const d = x - n;
  return d > -0.4999 && d < 0.4999 ? n | 0 : Number(v.toFixed(decimals).replace('.', ''));
}

function writeText() {
  if (extrasDirty && view === 'play') renderExtras();
  const n = scaled(BIG, 0);
  if (n !== shown[0] || n === -3) {
    shown[0] = n;
    attr(el.big, 'data-empty', n === -1 ? '' : null);
    if (n === -1) { shownInt[0] = -2; text(el.int, '—'); text(el.frac, ''); }
    else if (n === -3) {
      shownInt[0] = -2;
      const s = T[BIG].toFixed(decimals);
      const dot = s.indexOf('.');
      text(el.int, dot < 0 ? s : s.slice(0, dot));
      text(el.frac, dot < 0 ? '' : s.slice(dot));
    } else {
      const f = n % scale;
      const i = (n - f) / scale;
      if (i !== shownInt[0]) { shownInt[0] = i; text(el.int, i.toFixed(0)); }
      text(el.frac, fracs[f]);
    }
  }
  writeValue(1, el.valA, A, '');
  writeValue(2, el.valB, B, view === 'results' ? '+' : '');
}

function writeValue(slot, node, o, prefix) {
  const n = scaled(o, slot);
  if (n === shown[slot] && n !== -3 && prefix === shownPrefix[slot]) return;
  shown[slot] = n;
  shownPrefix[slot] = prefix;
  if (n === -1) text(node, '—');
  else if (n === -3) text(node, prefix + T[o].toFixed(decimals));
  else {
    const f = n % scale;
    text(node, prefix + ((n - f) / scale).toFixed(0) + fracs[f]);
  }
}

// ---------------------------------------------------------------------------------------------
// Start-up (after every binding above exists: both calls report synchronously).
settings(opt, next => {
  opt = next;
  setDecimals(Math.max(0, Math.min(2, Math.round(Number(next.decimals)) || 0)));
  el.root.dataset.backing = ['none', 'scrim', 'panel'].includes(next.backing) ? next.backing : 'none';
  el.root.dataset.accent = next.accent === '18-lab' ? '18-lab' : 'map';
  layout();
  modelDirty = true;
  textForce = true;
  tint();
});

subscribe(POINTERS, values => {
  for (let i = 0; i < POINTERS.length; i++) D[i] = values[POINTERS[i]];
  modelDirty = true;
  kick();
}, {
  onStatus: state => {
    if (state === online) return;
    online = state;
    modelDirty = true;
    kick();
  },
});

// Copyright (c) 2026 18-LAB. MIT.
// Performance counter: a pp readout that floats in a free region of osu!'s own layout. During play
// it counts current pp up, shows if-FC and max achievable, a rail scaled to the map's SS value and
// the non-zero pp components; song select gets the accuracy→pp ladder (osu! never shows pp there);
// results add what the results screen lacks. Data handlers only record values; one rAF loop
// renders and stops once settled.
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const CLUSTER_W = 320;  // cluster layout width (CSS px) before scaling
const MARGIN = 24;      // clearance from screen edges and osu!'s HUD/playfield
const TEXT_MS = 50;     // readout text writes are throttled to 20 Hz while a tween runs
const TWEEN_MS = 480;   // count-up duration (ease-out expo); ~97 % of the way by 240 ms
const AMBER = '#ff963f';

const P = {
  state: '/state/number', client: '/client', playMode: '/play/mode/number', setMode: '/settings/mode/number',
  source: '/play/source', failed: '/play/failed', checksum: '/beatmap/checksum', cs: '/beatmap/stats/cs/converted',
  cur: '/play/pp/current', fc: '/play/pp/fc', max: '/play/pp/maxAchievable',
  rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc',
};
// Breakdown components: label plus current/fc pointers, resolved once.
const PART = {};
for (const [key, label] of [['aim', 'Aim'], ['speed', 'Speed'], ['accuracy', 'Acc'], ['flashlight', 'FL'], ['difficulty', 'Diff']]) {
  PART[key] = { label, cur: `/play/pp/detailed/current/${key}`, fc: `/play/pp/detailed/fc/${key}` };
  P[`c_${key}`] = PART[key].cur;
  P[`f_${key}`] = PART[key].fc;
}
const OSU_PARTS = [PART.aim, PART.speed, PART.accuracy, PART.flashlight];
const OTHER_PARTS = [PART.difficulty, PART.accuracy];
const LADDER = ['95', '97', '98', '99', '100'];
const LADDER_P = LADDER.map(a => `/performance/accuracy/${a}`);
LADDER_P.forEach((pointer, i) => { P[`a${LADDER[i]}`] = pointer; });
const SELECT_STATES = new Set([5, 6, 13]);
const SOURCE_LABEL = { player: 'Live', replay: 'Replay', spectator: 'Spectating', watching: 'Spectating', autoplay: 'Auto' };

const $ = id => document.getElementById(id);
const el = {
  cluster: $('cluster'), brand: $('brand'), kicker: $('kicker'), state: $('state'),
  int: $('int'), frac: $('frac'), big: $('big'), rowA: $('rowA'), rowB: $('rowB'),
  labelA: $('labelA'), labelB: $('labelB'), valA: $('valA'), valB: $('valB'),
  rail: $('rail'), scaleMax: $('scaleMax'), ladder: $('ladder'), chips: $('chips'),
};
const ladderValues = [...el.ladder.querySelectorAll('b')];

// Chip pool: up to four inline label/value pairs, filled per frame of data.
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
// Settings. `decimals` is an options setting (strings in settings.json); a numeric default coerces
// either form. Placement numbers are clamped where they are used.
let opt = {
  zone: 'auto', selectZone: 'column-top', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map',
  showIfFc: true, showMax: true, showBreakdown: true, showLadder: true, decimals: 1, showBrand: true,
};
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
// restarts the ease from wherever the readout is, so frequent pp updates chase smoothly and a big
// jump lands in TWEEN_MS instead of crawling its tail.
const tweens = { big: tween(), a: tween(), b: tween(), fill: tween(), fc: tween(), max: tween() };
const TWEEN_LIST = Object.values(tweens);
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
// Placement: the cluster sits in a free region of osu!'s layout for the active ruleset.
// auto = top-right under score/accuracy (clear of the mod icons) for osu!/catch/mania; below the
// lane on the right for taiko. Recomputed only when its inputs change.
const placed = { mode: '', keys: 0, client: '', kind: '', zone: '', selectZone: '', x: 0, y: 0, scale: 0 };
let lastMode = 'osu';

function place(mode, kind) {
  const keys = Math.max(1, Math.min(18, Math.round(num(P.cs)) || 4));
  const client = values[P.client] === 'lazer' ? 'lazer' : 'stable';
  if (placed.mode === mode && placed.keys === keys && placed.client === client && placed.kind === kind && placed.zone === opt.zone
    && placed.selectZone === opt.selectZone && placed.x === opt.offsetX && placed.y === opt.offsetY && placed.scale === opt.scale) return;
  Object.assign(placed, { mode, keys, client, kind, zone: opt.zone, selectZone: opt.selectZone, x: opt.offsetX, y: opt.offsetY, scale: opt.scale });

  const L = osuLayout(mode, { keys, client, width: W, height: H });
  const { busy, hud } = L;
  let h = 'right', v = 'top', x = MARGIN, y = 0, maxW = W;
  const zone = kind === 'results' ? 'results'
    : kind === 'select' && opt.selectZone !== 'gameplay' ? opt.selectZone
      : opt.zone === 'auto' ? (mode === 'taiko' ? 'bottom-right' : 'top-right') : opt.zone;
  if (zone === 'results') {
    // osu!stable's results screen: the right part of the top header strip (x ≈ 1000–1900,
    // y ≈ 8–130) is the only reliably free band; title/mapper text sits on its left.
    y = 16; maxW = 880;
  } else if (zone === 'column-bottom' || zone === 'column-top') {
    // Song select: the centre column between the local leaderboard (x ≈ 0–520) and the
    // carousel (x ≥ 1180), below the info header and above the bottom bar (y ≈ 190–930).
    h = 'center'; x = 850; maxW = 600;
    if (zone === 'column-top') y = 210; else { v = 'bottom'; y = H - 910; }
  } else {
    h = zone.endsWith('left') ? 'left' : 'right';
    if (mode !== 'taiko') maxW = h === 'left' ? busy.x - 2 * MARGIN : W - busy.x - busy.w - 2 * MARGIN;
    if (zone.startsWith('top')) {
      // Right: below accuracy plus a row of mod icons; left: below the HP bar.
      y = h === 'right' ? hud.accuracy.y + hud.accuracy.h + 100 : hud.health.y + hud.health.h + 2 * MARGIN;
    } else if (mode === 'taiko') {
      y = busy.y + busy.h + MARGIN;           // below the lane, anchored to it
    } else {
      v = 'bottom';
      y = h === 'left' && hud.combo ? hud.combo.h + MARGIN : MARGIN;
    }
  }
  const user = Math.max(0.5, Math.min(2, Number(opt.scale) || 1));
  const s = Math.round(Math.min(user, Math.max(0.5, maxW / CLUSTER_W)) * 1000) / 1000;
  const style = el.cluster.style;
  style.left = h === 'left' || h === 'center' ? `${x}px` : 'auto';
  style.right = h === 'right' ? `${x}px` : 'auto';
  style.top = v === 'top' ? `${y}px` : 'auto';
  style.bottom = v === 'bottom' ? `${y}px` : 'auto';
  style.transformOrigin = `${h === 'center' ? 'center' : h} ${v}`;
  const ox = Math.round(Number(opt.offsetX) || 0), oy = Math.round(Number(opt.offsetY) || 0);
  style.transform = `translate(${ox}px, ${oy}px)${h === 'center' ? ' translateX(-50%)' : ''} scale(${s})`;
  el.cluster.dataset.align = h === 'left' ? 'left' : h === 'center' ? 'center' : 'right';
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
    applyPalette(el.cluster, p);
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
const ladder = [NaN, NaN, NaN, NaN, NaN];
let railScale = NaN;

function derive() {
  modelDirty = false;
  const state = values[P.state];
  const live = online === 'live';
  if (live) everLive = true;
  const next = !live ? 'offline'
    : !Number.isInteger(state) ? 'idle'
      : state === 2 ? 'play'
        : state === 7 ? 'results'
          : SELECT_STATES.has(state) ? (opt.showLadder ? 'select' : 'hidden')
            : 'hidden';
  const mode = activeMode(state, values[P.playMode], values[P.setMode]) || lastMode;
  lastMode = mode;
  place(mode, next === 'select' || next === 'results' ? next : 'game');
  if (live) loadPalette(typeof values[P.checksum] === 'string' && values[P.checksum] ? values[P.checksum] : null);

  const changed = next !== view;
  const previous = view;
  view = next;
  attr(el.cluster, 'data-view', next);
  show(el.brand, opt.showBrand);
  // A view change counts readouts up from 0; data that just appeared (source loaded, osu!
  // started, socket back) shows at once. Play → results keeps its values continuous.
  const countUp = changed && previous !== 'offline' && previous !== 'idle' && previous !== 'hidden' ? 0 : undefined;

  let stateLabel = '';
  let tone = 'idle';
  if (next === 'offline') { stateLabel = online === 'connecting' && !everLive ? 'Connecting to vosu' : 'vosu offline'; tone = online === 'connecting' && !everLive ? 'wait' : 'down'; }
  else if (next === 'idle') stateLabel = 'osu! not running';
  else if (next === 'play') {
    const failed = values[P.failed] === true;
    const source = values[P.source];
    stateLabel = failed ? 'Failed' : SOURCE_LABEL[source] || 'Live';
    tone = failed ? 'fail' : source === 'player' || source == null ? 'live' : 'watch';
  } else if (next === 'results') { stateLabel = 'Result'; tone = 'done'; }
  else if (next === 'select') stateLabel = 'by accuracy';
  text(el.state, stateLabel);
  text(el.kicker, next === 'offline' || next === 'idle' ? '' : 'pp');
  attr(el.cluster, 'data-tone', tone);

  for (let i = 0; i < LADDER.length; i++) ladder[i] = pos(LADDER_P[i]);
  const ss = ladder[4];
  const fade = NaN;

  if (next === 'play') {
    const cur = num(P.cur), fc = num(P.fc), max = num(P.max);
    text(el.labelA, 'If FC');
    text(el.labelB, 'Max');
    show(el.rowA, opt.showIfFc);
    show(el.rowB, opt.showMax);
    retarget(tweens.big, cur, countUp);
    retarget(tweens.a, opt.showIfFc ? fc : fade, countUp);
    retarget(tweens.b, opt.showMax ? max : fade, countUp);
    retarget(tweens.fill, cur, countUp);
    retarget(tweens.fc, opt.showIfFc ? fc : fade, countUp);
    retarget(tweens.max, opt.showMax ? max : fade, countUp);
    railScale = maxOf(maxOf(ss, fc), maxOf(max, cur));
    parts = mode === 'osu' ? OSU_PARTS : OTHER_PARTS;
    show(el.chips, opt.showBreakdown);
    renderChips();
  } else if (next === 'results') {
    // osu!stable's results screen shows no pp at all; lazer shows the final pp, so there the
    // big readout is the if-FC value instead. Results sit in the header strip, so the readouts
    // count up afresh there.
    const final = num(P.rPp), fc = num(P.rFc), gap = fc - final;
    const lazer = values[P.client] === 'lazer';
    text(el.labelA, 'If FC');
    text(el.labelB, 'To FC');
    show(el.rowA, !lazer);
    show(el.rowB, gap >= 0.5);
    retarget(tweens.big, lazer ? fc : final, countUp);
    retarget(tweens.a, lazer ? fade : fc, countUp);
    retarget(tweens.b, gap >= 0.5 ? gap : fade, countUp);
    show(el.chips, false);
  } else if (next === 'select') {
    for (let i = 0; i < LADDER.length; i++) text(ladderValues[i], Number.isNaN(ladder[i]) ? '—' : Math.round(ladder[i]).toString());
  }
  if (next === 'results' || next === 'play') {
    text(el.kicker, next === 'results' && values[P.client] === 'lazer' ? 'pp if FC' : 'pp');
    text(el.scaleMax, Number.isNaN(ss) ? 'SS —' : `SS ${Math.round(ss)}`);
  }
  if (changed) textForce = true;
  railDirty = true;
}

function maxOf(a, b) {
  return a > 0 ? (b > a ? b : a) : b > 0 ? b : NaN;
}

function renderChips() {
  let n = 0;
  for (const part of parts) {
    const c = num(part.cur), f = num(part.fc);
    if (!(c > 0 || f > 0) || n >= chips.length) continue;
    const chip = chips[n++];
    show(chip.li, true);
    text(chip.label, part.label);
    text(chip.value, Math.round(c > 0 ? c : 0).toString());
  }
  for (; n < chips.length; n++) show(chips[n].li, false);
}

// ---------------------------------------------------------------------------------------------
// Rail canvas (DPR-aware, sized only on resize). Geometry in CSS px: marker labels 0–12,
// bar 16–22, graduations 25–29.
const ctx = el.rail.getContext('2d', { alpha: true });
let dpr = 1;
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
  const size = Math.max(4, Math.round(5 * dpr));
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgb(235 232 225 / 0.7)';
  t.lineWidth = Math.max(1, Math.round(dpr));
  t.beginPath();
  for (const o of [-size, 0, size]) { t.moveTo(o, size); t.lineTo(o + size, 0); }
  t.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
}

// Resizing a canvas resets its context state, so the label font is set here, not per frame.
function setRailFont() {
  ctx.font = `500 ${Math.round(12 * dpr)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  widths.clear();
  railDirty = true;
  kick();
}

let scaleNow = 1;
const at = v => Math.max(0, Math.min(cw, Math.round((v / scaleNow) * cw)));

function drawRail() {
  railDirty = false;
  if (!cw || !ch) return;
  const d = dpr, w = cw, px = Math.max(1, Math.round(d));
  const by = Math.round(BAR_Y * d), bh = Math.round(BAR_H * d), ty = Math.round(TICK_Y * d);
  ctx.clearRect(0, 0, w, ch);
  if (view !== 'play') return;
  ctx.fillStyle = C.track;
  ctx.fillRect(0, by - px, w, bh + 2 * px);
  // Graduations every tenth of the scale; majors at 0, ½ and SS.
  for (let i = 0; i <= 10; i++) {
    const x = Math.min(w - px, Math.round((i / 10) * w));
    const major = i === 0 || i === 5 || i === 10;
    ctx.fillStyle = major ? C.tickMajor : C.tick;
    ctx.fillRect(x, ty, px, Math.round((major ? 5 : 3) * d));
  }
  if (!(railScale > 0)) return;
  scaleNow = railScale;
  occupied = 0;
  const fill = tweens.fill.value;
  const fc = tweens.fc.value;
  const potential = tweens.max.value;
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
      ctx.fillRect(Math.max(0, mx - px), by - 2 * px, px, bh + 4 * px);
    }
  }
  ctx.fillStyle = railAccent;
  ctx.fillRect(0, by, fx, bh);
  // FC owns its label; MAX takes whichever side of its tick is free, or stays unlabelled.
  ctx.shadowColor = C.shadow;
  ctx.shadowBlur = 2 * d;
  ctx.shadowOffsetY = d;
  if (fc > 0) {
    const x = Math.min(w - px, at(fc));
    ctx.fillStyle = C.fg;
    const top = Math.round(13 * d);
    ctx.fillRect(x, top, px * 2, by + bh + Math.round(2 * d) - top);
    placeLabel(x, 'FC', C.fg, CENTER, CENTER);
  }
  if (mx >= 0 && view === 'play') placeLabel(mx, 'MAX', C.dim, END, START);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

// Marker labels: up to four occupied [left, right] spans, checked before each label is drawn.
const START = 0, END = 1, CENTER = 2;
const spans = new Float64Array(8);
let occupied = 0;
const widths = new Map();
function placeLabel(x, label, color, first, second) {
  let width = widths.get(label);
  if (width === undefined) { width = ctx.measureText(label).width; widths.set(label, width); }
  const gap = 6 * dpr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const align = attempt === 0 ? first : second;
    let left = align === START ? x + 3 * dpr : align === END ? x - width - 3 * dpr : x - width / 2;
    left = Math.round(Math.max(0, Math.min(cw - width, left)));
    let free = true;
    for (let i = 0; i < occupied; i++) if (left < spans[i * 2 + 1] + gap && left + width + gap > spans[i * 2]) free = false;
    if (!free) continue;
    ctx.fillStyle = color;
    ctx.fillText(label, left, Math.round(LABEL_Y * dpr));
    if (occupied < 4) { spans[occupied * 2] = left; spans[occupied * 2 + 1] = left + width; occupied++; }
    return;
  }
}

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  if (!box.width) return;
  dpr = window.devicePixelRatio || 1;
  cw = Math.round(box.width * dpr);
  ch = Math.round(box.height * dpr);
  if (el.rail.width !== cw) el.rail.width = cw;
  if (el.rail.height !== ch) el.rail.height = ch;
  buildHatch();
  setRailFont();
}).observe(el.rail);
document.fonts?.ready.then(setRailFont);

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
  let moving = false;
  for (const t of TWEEN_LIST) if (step(t, now)) moving = true;
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
  text(el.frac, f);
  attr(el.big, 'data-empty', f === '' && i === '—' ? '' : null);
  const a = tweens.a.value;
  text(el.valA, Number.isNaN(a) ? '—' : a.toFixed(decimals));
  const b = tweens.b.value;
  text(el.valB, Number.isNaN(b) ? '—' : (view === 'results' ? '+' : '') + b.toFixed(decimals));
}

// ---------------------------------------------------------------------------------------------
// Start-up (after every binding above exists: both calls report synchronously).
fit(document.getElementById('stage'), W, H);
settings(opt, next => {
  opt = next;
  decimals = Math.max(0, Math.min(2, Math.round(Number(next.decimals)) || 0));
  el.cluster.dataset.backing = ['none', 'scrim', 'panel'].includes(next.backing) ? next.backing : 'none';
  el.cluster.dataset.accent = next.accent === '18-lab' ? '18-lab' : 'map';
  modelDirty = true;
  textForce = true;
  tint();
});

subscribe(Object.values(P), v => { values = v; modelDirty = true; kick(); }, {
  onStatus: state => {
    if (state === online) return;
    online = state;
    modelDirty = true;
    kick();
  },
});

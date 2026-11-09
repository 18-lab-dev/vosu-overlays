// Copyright (c) 2026 18-LAB. MIT.
// Performance counter on the 18-LAB overlay kit (docs/overlay-system.md). During play: current pp
// as the hero, the pp breakdown on the secondary line and a rail from 0 to the map's SS value
// (current filled in amber, hatched up to max achievable, a tick at if-FC). Once the full combo is
// lost, the if-FC value detaches from the hero and takes the secondary line. Song select: the
// accuracy → pp ladder (osu! never shows pp there). Results: what the results screen lacks.
// Unknown values (the replay renderer leaves if-FC and max at 0) are hidden, never shown as 0.
// The page is content-sized: hosts place and size it and the layout re-flows to the box (a column,
// or a strip in wide boxes). Data handlers only record values; one rAF loop renders and stops once
// everything has settled.
import { subscribe, settings, activeMode, known, numberFormatter, applyKitSettings, MOTION_MS, DASH } from './vosu-overlay.js';

// Design boxes at --u = 1 (the metadata placements), the kit's --pad padding included (every
// backing, none too).
const VERTICAL = { w: 256, h: 144 };
const HORIZONTAL = { w: 336, h: 80 };
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';   // kit --ease-out
const FC_GAP = 0.5;       // if-FC shows only while it is at least this far above current pp

const P = {
  state: '/state/number', client: '/client', playMode: '/play/mode/number', setMode: '/settings/mode/number',
  failed: '/play/failed',
  cur: '/play/pp/current', fc: '/play/pp/fc', max: '/play/pp/maxAchievable',
  comboCur: '/play/combo/current', comboMax: '/play/combo/max', misses: '/play/hits/0',
  rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc',
};
const PART_LABELS = [['aim', 'Aim'], ['speed', 'Speed'], ['accuracy', 'Acc'], ['flashlight', 'FL'], ['difficulty', 'Diff']];
for (const [key] of PART_LABELS) P[`c_${key}`] = `/play/pp/detailed/current/${key}`;
const LADDER = ['95', '97', '98', '99', '100'];
for (const a of LADDER) P[`a${a}`] = `/performance/accuracy/${a}`;
// Every pointer gets a fixed slot in `D`, the overlay's own copy of the latest values (the
// client reuses its values object for every frame, so it is copied in the handler, not kept).
const POINTERS = Object.values(P);
const I = {};
Object.keys(P).forEach((key, i) => { I[key] = i; });
const D = POINTERS.map(() => undefined);
const PART = {};
for (const [key, label] of PART_LABELS) PART[key] = { label, slot: I[`c_${key}`] };
const OSU_PARTS = [PART.aim, PART.speed, PART.accuracy, PART.flashlight];
const OTHER_PARTS = [PART.difficulty, PART.accuracy];
const LADDER_I = LADDER.map(a => I[`a${a}`]);
const SS_I = LADDER_I[LADDER_I.length - 1];
const SELECT_STATES = new Set([5, 6, 13]);

const $ = id => document.getElementById(id);
const el = {
  root: $('root'), note: $('note'), fail: $('fail'), heroLabel: $('heroLabel'), heroGap: $('heroGap'),
  big: $('big'), int: $('int'), frac: $('frac'),
  fcRow: $('fcRow'), fcVal: $('fcVal'), fcGap: $('fcGap'), chips: $('chips'),
  rail: $('rail'), ss: $('ss'), ssVal: $('ssVal'), ladder: $('ladder'),
};

// ---------------------------------------------------------------------------------------------
// Cached DOM writers: a write is skipped when the string (or flag) is unchanged. The strings come
// from numberFormatter(), which returns the same object until the shown number changes.
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
// Formatters (docs: Numbers), one per displayed field.
const ppFmt = numberFormatter('pp');
const ssFmt = numberFormatter('pp');
const gapFmt = numberFormatter('delta');
const heroFmt = numberFormatter('count');   // the hero's whole part; the decimals are a kit-frac
const ladderFmt = LADDER.map(() => numberFormatter('pp'));
const ladderValues = [...el.ladder.querySelectorAll('b')];

// Breakdown chip pool: up to four label/value pairs.
const chips = [];
for (let i = 0; i < 4; i++) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  const value = document.createElement('span');
  label.className = 'kit-label';
  value.className = 'kit-value';
  li.append(label, value);
  li.hidden = true;
  el.chips.append(li);
  chips.push({ li, label, value, fmt: numberFormatter('pp') });
}

// ---------------------------------------------------------------------------------------------
// Motion (docs: Motion). Animations are created once and restarted; `off` plays none of them.
let motion = 'full';
// Hero digits: one box per character, filled from the right, so only the digits that change roll
// (critique: no full-number tween). A roll is a short rise into place.
const DIGITS = 9;
const digits = [];
const rolls = [];
const rolledAt = new Float64Array(DIGITS).fill(-Infinity);
const ROLL_KF = [{ transform: 'translateY(0.22em)', opacity: 0.3 }, { transform: 'none', opacity: 1 }];
const ROLL_OPTS = { duration: MOTION_MS.fast, easing: EASE_OUT };
for (let i = 0; i < DIGITS; i++) {
  const d = document.createElement('i');
  el.int.append(d);
  digits.push(d);
}
for (let k = 0; k < DIGITS; k++) {
  const a = digits[DIGITS - 1 - k].animate(ROLL_KF, ROLL_OPTS);   // rolls[k]: k-th digit from the right
  a.cancel();
  rolls.push(a);
}
// The choke: if-FC drops out from under the hero onto its own line, after the breakdown it
// replaces has faded (a fifth of the duration, the breakdown's --dur-fast fade-out).
const DETACH_FROM = 'translateY(-1em) scale(1.12)';
const detach = el.fcRow.animate([
  { transform: DETACH_FROM, opacity: 0 },
  { transform: DETACH_FROM, opacity: 0, offset: 0.2, easing: EASE_OUT },
  { transform: 'none', opacity: 1 },
], { duration: MOTION_MS.base });
detach.cancel();
// Entering a view (play, results, song select): the overlay rises into place.
const enter = el.root.animate([
  { transform: 'translateY(0.25em)', opacity: 0 },
  { transform: 'none', opacity: 1 },
], { duration: MOTION_MS.base, easing: EASE_OUT });
enter.cancel();
const ENTER_BASE = { duration: MOTION_MS.base };
const ENTER_SLOW = { duration: MOTION_MS.slow };   // results: a one-time reveal

// Characters the formatters produce, as one-character strings (no allocation per digit).
const CHAR = [];
for (const c of '0123456789,') CHAR[c.charCodeAt(0)] = c;

// ---------------------------------------------------------------------------------------------
// Settings. `decimals` is an options setting (strings in settings.json); a numeric default coerces
// either form.
let opt = {
  orientation: 'auto', align: 'auto', motion: 'full', backing: 'scrim',
  showIfFc: true, showMax: true, showBreakdown: true, showLadder: true, decimals: 1,
};
let scale = 10;         // 10 ** decimals
let fracs = [''];       // '.0' … '.9' (or '.00' … '.99'): every fraction string, built per setting
function setDecimals(next) {
  scale = 10 ** next;
  fracs = [];
  for (let i = 0; i < scale; i++) fracs.push(next ? '.' + String(i).padStart(next, '0') : '');
  H[KEY] = NaN;
}

// ---------------------------------------------------------------------------------------------
// Layout: orientation from the box's aspect (or the setting), everything scaled from the box
// through --u. Runs on resize and on settings changes, never per frame.
function layout() {
  const w = innerWidth || VERTICAL.w, h = innerHeight || VERTICAL.h;
  const orient = opt.orientation === 'horizontal' || opt.orientation === 'vertical' ? opt.orientation
    : w / h >= 2.4 ? 'horizontal' : 'vertical';
  const base = orient === 'horizontal' ? HORIZONTAL : VERTICAL;
  const u = Math.max(0.35, Math.min(4, Math.min(w / base.w, h / base.h)));
  const align = ['left', 'center', 'right'].includes(opt.align) ? opt.align : orient === 'vertical' ? 'right' : 'left';
  attr(el.root, 'data-orient', orient);
  attr(el.root, 'data-align', align);
  attr(document.body, 'data-align', align);   // positions the content-sized views (no :has in older CEF)
  el.root.style.setProperty('--u', u.toFixed(4));
}
addEventListener('resize', layout);

// ---------------------------------------------------------------------------------------------
// State. Per-frame numbers live in typed arrays: module-level `let` doubles would box a fresh heap
// number on every write.
let modelDirty = true;
let online = 'connecting';
let everLive = false;
let view = 'offline';
let choked = false;     // the full combo was lost this attempt
let fcOn = false;       // the if-FC line is showing
const num = slot => { const v = D[slot]; return typeof v === 'number' && Number.isFinite(v) ? v : NaN; };

const F = new Float64Array(5);
const NOW = 0, SCALE = 1, DUR = 2, COMBO_MAX = 3, MISSES = 4;
F[SCALE] = NaN;
F[DUR] = MOTION_MS.base;
// Hero: the value to show and the scaled integer (pp × 10^decimals) on screen.
const H = new Float64Array(2);
const VALUE = 0, KEY = 1;
H[VALUE] = H[KEY] = NaN;

// Rail tweens: ease-out (expo) from the drawn value to the latest target over --dur-base; a new
// target restarts the ease from wherever the rail is. Five slots per tween: value, from, target,
// t0 and the incoming target, which derive() writes before retarget() reads it.
const FILL = 0, FC = 5, MAX = 10;
const IN = 4;
const T = new Float64Array(15);
for (let o = 0; o < T.length; o += 5) T[o] = T[o + 1] = T[o + 2] = T[o + IN] = NaN;
function retarget(o) {
  const target = T[o + IN];
  if (target !== target) { T[o] = T[o + 1] = T[o + 2] = NaN; return; }
  if (T[o] !== T[o]) T[o] = target;   // appears in place
  if (target === T[o + 2]) return;
  T[o + 1] = T[o];
  T[o + 2] = target;
  T[o + 3] = F[NOW];
}

// ---------------------------------------------------------------------------------------------
// View model, derived in the frame (never in the socket handler).
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
  const changed = next !== view;
  view = next;
  attr(el.root, 'data-view', next);
  if (changed && motion !== 'off' && (next === 'play' || next === 'results' || next === 'select')) {
    enter.effect.updateTiming(next === 'results' ? ENTER_SLOW : ENTER_BASE);
    enter.cancel();
    enter.play();
  }
  text(el.note, next === 'offline' ? (online === 'connecting' && !everLive ? 'Connecting to vosu' : 'vosu offline')
    : next === 'idle' ? 'osu! not running' : next === 'select' ? 'pp by accuracy' : '');

  let wantFc = false;
  let slot = false;
  let failed = false;
  let label = '';
  let gapText = '';
  if (next === 'play') {
    const cur = known(D[I.cur]);
    const fc = known(D[I.fc], true);
    const max = known(D[I.max], true);
    const ss = known(D[SS_I], true);
    // The full combo is lost at the first miss or combo break; a retry (combo or misses going back
    // down) or entering play starts over.
    const comboMax = num(I.comboMax), misses = num(I.misses);
    if (changed || comboMax < F[COMBO_MAX] || misses < F[MISSES]) choked = false;
    F[COMBO_MAX] = comboMax;
    F[MISSES] = misses;
    if (misses > 0 || num(I.comboCur) < comboMax) choked = true;
    wantFc = opt.showIfFc && choked && fc - cur >= FC_GAP;   // unknown (NaN) never shows
    failed = D[I.failed] === true;
    H[VALUE] = cur;
    if (fc > 0) text(el.fcVal, ppFmt(fc));
    text(el.fcGap, '');

    T[FILL + IN] = cur;
    T[FC + IN] = opt.showIfFc ? fc : NaN;
    T[MAX + IN] = opt.showMax ? max : NaN;
    retarget(FILL);
    retarget(FC);
    retarget(MAX);
    // Rail scale: the map's SS value; without it (tosu, the renderer) the largest known projection.
    // Never current pp alone: that would draw a full rail, an affirmative claim.
    let s = ss > 0 ? ss : NaN;
    if (fc > 0 && !(fc <= s)) s = fc;
    if (max > 0 && !(max <= s)) s = max;
    if (s > 0 && cur > s) s = cur;
    F[SCALE] = s;
    show(el.ss, ss > 0);
    if (ss > 0) text(el.ssVal, ssFmt(ss));

    const chipCount = renderChips(activeMode(state, D[I.playMode], D[I.setMode]));
    slot = (opt.showIfFc && fc > 0) || chipCount > 0;
  } else if (next === 'results') {
    // osu!stable's results screen shows no pp at all; lazer shows the final pp, so there the hero
    // is the if-FC value instead.
    const final = known(D[I.rPp], true), fc = known(D[I.rFc], true), gap = fc - final;
    const lazer = D[I.client] === 'lazer';
    if (gap >= FC_GAP) gapText = gapFmt(gap);
    if (lazer && fc > 0) {
      H[VALUE] = fc;
      label = 'If FC';
    } else {
      H[VALUE] = final;
      wantFc = !lazer && gap >= FC_GAP;
      if (wantFc) { text(el.fcVal, ppFmt(fc)); text(el.fcGap, gapText); gapText = ''; }
    }
    slot = wantFc;
  } else if (next === 'select') {
    for (let i = 0; i < LADDER.length; i++) {
      const v = known(D[LADDER_I[i]], true);
      text(ladderValues[i], ladderFmt[i](v));
      attr(ladderValues[i], 'data-empty', v > 0 ? null : '');
    }
  }
  show(el.fail, failed);
  text(el.heroLabel, label);
  text(el.heroGap, label ? gapText : '');
  attr(el.root, 'data-slot', slot ? null : 'off');
  if (wantFc !== fcOn) {
    fcOn = wantFc;
    attr(el.root, 'data-fc', wantFc ? '' : null);
    if (wantFc && !changed && next === 'play' && motion !== 'off') { detach.cancel(); detach.play(); }
  }
  writeHero(!changed && motion === 'full');
  railDirty = true;
}

// Breakdown: the non-zero components of current pp, whole pp. Returns how many show.
function renderChips(mode) {
  const parts = mode === 'osu' ? OSU_PARTS : OTHER_PARTS;
  let n = 0;
  if (opt.showBreakdown) {
    for (let p = 0; p < parts.length; p++) {
      const c = known(D[parts[p].slot]);
      if (!(c > 0) || n >= chips.length) continue;
      const chip = chips[n++];
      show(chip.li, true);
      text(chip.label, parts[p].label);
      text(chip.value, chip.fmt(c));
    }
  }
  for (let i = n; i < chips.length; i++) show(chips[i].li, false);
  return n;
}

// Hero: whole pp in the digit boxes, the decimals as a kit-frac, a dash when unknown. Only the
// characters that changed are rewritten (and roll, when `roll`).
let heroText = '';
function writeHero(roll) {
  const v = H[VALUE];
  if (v !== v) {
    if (heroText === DASH) return;
    setDigits(DASH, false);
    text(el.frac, '');
    attr(el.big, 'data-empty', '');
    H[KEY] = NaN;
    return;
  }
  const key = Math.round((v > 0 ? v : 0) * scale);
  if (key === H[KEY]) return;
  H[KEY] = key;
  const f = key % scale;
  attr(el.big, 'data-empty', null);
  setDigits(heroFmt((key - f) / scale), roll && heroText !== DASH && heroText !== '');
  text(el.frac, fracs[f]);
}

function setDigits(s, roll) {
  if (s === heroText) return;
  const n = s.length, m = heroText.length;
  const now = F[NOW];
  for (let k = 0; k < DIGITS; k++) {
    const c = k < n ? s.charCodeAt(n - 1 - k) : 0;
    const p = k < m ? heroText.charCodeAt(m - 1 - k) : 0;
    if (c === p) continue;
    digits[DIGITS - 1 - k].textContent = c === 0 ? '' : c < 128 ? CHAR[c] : s;
    // A digit already rolling just swaps (more than ~8 changes a second would strobe).
    if (roll && c !== 0 && p !== 0 && now - rolledAt[k] >= MOTION_MS.fast) {
      rolledAt[k] = now;
      rolls[k].currentTime = 0;
      rolls[k].play();
    }
  }
  heroText = s;
}

// ---------------------------------------------------------------------------------------------
// Rail canvas, sized only on resize. Geometry in design units (the canvas is 12 units tall at any
// scale): bar 3–9, the if-FC tick full height.
const ctx = el.rail.getContext('2d', { alpha: true });
let k = 1;              // device px per design unit
let cw = 0, ch = 0;
let railDirty = true;
let hatch = null;
// kit.css roles: --you (current), --text-1 (if-FC tick), --text-2 (max end), --hair (track).
const C = { you: '#ff963f', tick: '#efece5', end: '#d3cfc6', track: 'rgb(11 12 13 / 0.45)', hair: 'rgb(239 236 229 / 0.22)' };
let px = 1, barY = 0, barH = 0, tickW = 2;

function resizeRail() {
  px = Math.max(1, Math.round(k));
  barY = Math.round(3 * k);
  barH = Math.round(6 * k);
  tickW = Math.max(2, Math.round(2 * k));
  const size = Math.max(4, Math.round(5 * k));
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = 'rgb(239 236 229 / 0.6)';
  t.lineWidth = px;
  t.beginPath();
  for (const o of [-size, 0, size]) { t.moveTo(o, size); t.lineTo(o + size, 0); }
  t.stroke();
  hatch = ctx.createPattern(tile, 'repeat');
  railDirty = true;
  kick();
}

// Canvas arguments stay integers (`| 0`): a computed fractional double passed to the canvas
// binding is boxed per call.
function drawRail() {
  railDirty = false;
  // Hidden: keep the last frame while the overlay fades out.
  if (!cw || !ch || view === 'hidden') return;
  const w = cw;
  ctx.clearRect(0, 0, w, ch);
  if (view !== 'play') return;
  ctx.fillStyle = C.track;
  ctx.fillRect(0, barY, w, barH);
  ctx.fillStyle = C.hair;
  ctx.fillRect(0, barY, w, barH);
  const s = F[SCALE];
  if (!(s > 0)) return;   // unknown scale: an empty track, no claim
  const fill = T[FILL];
  const fc = T[FC];
  const potential = T[MAX];
  // Value → x, clamped to the rail (inlined: a helper call would box its double argument).
  const fx = fill > 0 ? Math.max(0, Math.min(w, Math.round((fill / s) * w))) | 0 : 0;
  if (potential > fill) {
    const mx = Math.max(0, Math.min(w, Math.round((potential / s) * w))) | 0;
    ctx.fillStyle = hatch;
    ctx.fillRect(fx, barY, mx - fx, barH);
    ctx.fillStyle = C.end;
    ctx.fillRect(Math.max(0, mx - px), barY, px, barH);
  }
  ctx.fillStyle = C.you;
  ctx.fillRect(0, barY, fx, barH);
  if (fc > 0) {
    const x = Math.min(w - tickW, Math.max(0, Math.round((fc / s) * w) - (tickW >> 1))) | 0;
    ctx.fillStyle = C.tick;
    ctx.fillRect(x, 0, tickW, ch);
  }
}

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  if (!box.width || !box.height) return;
  const dpr = window.devicePixelRatio || 1;
  cw = Math.round(box.width * dpr);
  ch = Math.round(box.height * dpr);
  k = ch / 12;
  if (el.rail.width !== cw) el.rail.width = cw;
  if (el.rail.height !== ch) el.rail.height = ch;
  resizeRail();
}).observe(el.rail);

// ---------------------------------------------------------------------------------------------
// Frame loop: one rAF, stops when every tween has settled and nothing is dirty.
let raf = 0;
function kick() { if (!raf) raf = requestAnimationFrame(frame); }

// Eased value and target, picked by index: one store site that runs every step (a double merged
// from two branches would be boxed).
const PICK = new Float64Array(2);
function frame(now) {
  raf = 0;
  F[NOW] = now;
  if (modelDirty) derive();
  let moving = false;
  const dur = F[DUR];
  for (let o = 0; o < T.length; o += 5) {
    const target = T[o + 2];
    if (T[o] === target || target !== target) continue;
    const from = T[o + 1];
    const p = dur > 0 ? (now - T[o + 3]) / dur : 1;
    PICK[0] = from + (target - from) * (1 - 2 ** (-10 * p));
    PICK[1] = target;
    T[o] = PICK[p >= 1 ? 1 : 0];
    moving = true;
  }
  if (moving || railDirty) drawRail();
  if (moving) kick();
}

// ---------------------------------------------------------------------------------------------
// Start-up (after every binding above exists: both calls report synchronously).
settings(opt, next => {
  opt = next;
  motion = applyKitSettings(el.root, next);
  F[DUR] = motion === 'off' ? 0 : MOTION_MS.base;
  setDecimals(Math.max(0, Math.min(2, Math.round(Number(next.decimals)) || 0)));
  layout();
  modelDirty = true;
  kick();
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

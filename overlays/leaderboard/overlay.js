// Copyright (c) 2026 18-LAB. MIT.
// Live in-game leaderboard on the 18-LAB overlay kit (docs/overlay-system.md). The page is sized
// by its host (OBS, vosulay, the replay renderer) and lays itself out for that box: a vertical
// board in tall boxes, a horizontal strip in wide ones. Styles: board (the in-game list) or rival
// (the player above, you, the player below, with the score gaps).
// Rows sit absolutely positioned and move between slots on a transform transition, so an overtake
// slides the passed player past you without layout work; one-shot Web Animations (created once
// per element, then restarted) mark the overtake itself.
import { subscribe, settings, applyKitSettings, numberFormatter, known, MOTION_MS } from './vosu-overlay.js';

const PLAY = 2;
const MAX_ROWS = 16;
const PRUNE_MS = 800;
const MIN_U = 0.5;
const MAX_U = 3;
// Design geometry in px at --u = 1 (the 216×400 osu!/catch column; the 256 px mania column and
// the 480×72 strip are also --u = 1); style.css carries the same numbers. PAD is the kit's
// backing padding (none: 0).
const PAD = 16;
const V = { width: 216, height: 400, head: 60, one: 28, two: 44, three: 60, skip: 20 };
const H = { height: 72, head: 136, cell: 94, skip: 22 };
const RV = { height: 116 };
const RH = { width: 344, below: 20 };
const RV_BELOW = 88;
const CHIP_MS = 2400;
const P = { state: '/state/number', checksum: '/beatmap/checksum', board: '/leaderboard', name: '/play/playerName', score: '/play/score' };
// Row flags: your row, a direct neighbour of yours, a row with a second line, a second line that
// shows accuracy and combo (your neighbours'; yours only with hudFields), your row's third line
// (hudFields: accuracy and combo, then the gap).
const ME = 1;
const NEAR = 2;
const TWO = 4;
const FACTS = 8;
const THREE = 16;
const DEFAULTS = {
  style: 'board', orientation: 'auto', align: 'left', motion: 'full', backing: 'scrim',
  rows: 8, showAcc: true, showCombo: true, showMods: true, compact: false, showGap: true, hudFields: false,
};

const $ = id => document.getElementById(id);
const body = document.body;
const root = $('root');
const chip = $('chip');
const chipText = $('chip-text');
const rivalEl = $('rival');
const rivalPos = $('rival-pos');
const rivalTotal = $('rival-total');
const boardEl = $('board');
const boardPos = $('board-pos');
const boardTotal = $('board-total');
const boardGap = $('board-gap');
const skipEl = $('skip');

// Motion (docs/overlay-system.md "Motion"): keyframes and options hoisted, Animations created
// once per element and restarted, so an event allocates nothing but its chip text.
const KF_ROLL_UP = [{ transform: 'translate3d(0,30%,0)', opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }];
const KF_ROLL_DOWN = [{ transform: 'translate3d(0,-30%,0)', opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }];
const ROLL_OPTS = { duration: MOTION_MS.base, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const KF_CHIP = [
  { opacity: 0, transform: 'translate3d(0,25%,0)' },
  { opacity: 1, transform: 'translate3d(0,0,0)', offset: MOTION_MS.fast / CHIP_MS },
  { opacity: 1, transform: 'translate3d(0,0,0)', offset: 1 - MOTION_MS.base / CHIP_MS },
  { opacity: 0, transform: 'translate3d(0,0,0)' },
];
// motion=off: the chip still shows for its 2.4 s, without easing in or out.
const KF_CHIP_OFF = [{ opacity: 1 }, { opacity: 1 }];
const CHIP_OPTS = { duration: CHIP_MS, easing: 'linear' };
const KF_FLASH = [{ opacity: 0.32 }, { opacity: 0 }];
const FLASH_OPTS = { duration: MOTION_MS.slow, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
// A row passing yours dims while it slides behind it, so the pass reads as "under you". The
// slide is expo-out (most of the travel in the first third), so the dip peaks early.
const KF_DIP = [{ opacity: 1 }, { opacity: 0.15, offset: 0.3 }, { opacity: 1 }];
const DIP_OPTS = { duration: MOTION_MS.base, easing: 'linear' };

/**
 * Keyed rows placed at slot offsets; entering rows snap into place, then fade in next frame.
 * Rows and their value caches live as long as their entry stays on the board, so a frame only
 * touches the DOM (and formats text) for values that changed.
 */
class SlotList {
  constructor(container, template, fill) {
    this.container = container;
    this.template = template.content.firstElementChild;
    this.fill = fill;
    this.pool = new Map();
    this.rows = [];
    this.entering = [];
    this.enteringCount = 0;
    this.serial = 0;
    this.moved = false;
  }

  begin() {
    for (let i = 0; i < this.enteringCount; i++) {
      this.entering[i].el.classList.remove('snap', 'out');
      this.entering[i] = null;
    }
    this.enteringCount = 0;
    this.serial++;
    this.moved = false;
  }

  put(key, x, y, e, index, extra) {
    let row = this.pool.get(key);
    if (!row) {
      row = newRow(key, this.template.cloneNode(true));
      this.container.append(row.el);
      this.pool.set(key, row);
      this.rows.push(row);
    }
    row.serial = this.serial;
    this.fill(row, e, index, extra);
    if (!row.on) {
      row.on = true;
      row.px = NaN;
      row.py = NaN;
      row.el.classList.add('snap', 'out');
      this.entering[this.enteringCount++] = row;
    } else {
      row.px = row.x;
      row.py = row.y;
      if (row.x === x && row.y === y) return;
      this.moved = true;
    }
    row.x = x;
    row.y = y;
    row.el.style.transform = `translate3d(${x}px,${y}px,0)`;
  }

  /**
   * Rows not placed this frame leave: they fade out while sliding one `step` away from `pivot`
   * (your row), so a player pushed off the window is pushed, not overdrawn by the one taking
   * its slot.
   */
  end(now, pivot, step, alongX) {
    const rows = this.rows;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.serial === this.serial) continue;
      if (row.on) {
        row.on = false;
        row.hiddenAt = now;
        row.el.classList.add('out');
        if (alongX) row.x += row.x < pivot ? -step : step;
        else row.y += row.y < pivot ? -step : step;
        row.el.style.transform = `translate3d(${row.x}px,${row.y}px,0)`;
      } else if (now - row.hiddenAt > PRUNE_MS) {
        row.el.remove();
        this.pool.delete(row.key);
        rows[i] = rows[rows.length - 1];
        rows.length--;
      }
    }
  }

  clear() {
    for (let i = 0; i < this.rows.length; i++) this.rows[i].el.remove();
    this.pool.clear();
    this.rows.length = 0;
    for (let i = 0; i < this.enteringCount; i++) this.entering[i] = null;
    this.enteringCount = 0;
  }
}

/**
 * One row: its nodes (by `data-r`), one number formatter per displayed field, and the last value
 * written to each, in one fixed shape. Raw caches start as null and hold the message's own values,
 * so an unchanged value is skipped before it is converted or formatted.
 */
function newRow(key, el) {
  const row = {
    key, el, on: false, x: NaN, y: NaN, px: NaN, py: NaN, serial: 0, hiddenAt: 0, flags: -1, failed: false,
    pos: null, name: null, score: null, acc: null, combo: null, mods: null, flash: null, gap: null, target: null,
    vPos: null, tPos: null, tName: null, vScore: null, tScore: null, vAcc: null, tAcc: null, vCombo: null, tCombo: null,
    vDiff: null, tGap: null, nTarget: null, vAhead: null,
    fPos: numberFormatter('count'), fScore: numberFormatter('count'), fAcc: numberFormatter('accuracy'),
    fCombo: numberFormatter('count'), fGap: numberFormatter('delta'),
    modsKind: -1, modsName: undefined, acronyms: [], acronymCount: 0, tMods: null,
    dip: null, flashAnim: null,
  };
  for (const node of el.querySelectorAll('[data-r]')) row[node.dataset.r] = node;
  return row;
}

/** A text node's last written string, so equal text never reaches the DOM; `n` caches its source value. */
class Cell {
  constructor(el) {
    this.el = el;
    this.n = null;
    this.s = null;
  }

  set(value) {
    if (value === this.s) return;
    this.s = value;
    this.el.textContent = value;
  }
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rankOf = e => (Number.isInteger(e.position) && e.position > 0 ? e.position : Infinity);
const compare = (a, b) => rankOf(a) - rankOf(b) || (Number(b.score) || 0) - (Number(a.score) || 0);
const displayPos = (e, index) => (Number.isInteger(e.position) && e.position > 0 ? e.position : index + 1);

/** Mods as the game writes them: acronyms run together (HDDT). */
function modsText(mods) {
  if (!mods || typeof mods !== 'object') return '';
  if (Array.isArray(mods.array)) {
    let out = '';
    for (let i = 0; i < mods.array.length; i++) {
      const acronym = mods.array[i]?.acronym;
      if (typeof acronym === 'string' && acronym) out += acronym;
    }
    return out;
  }
  return typeof mods.name === 'string' && mods.name !== 'NM' ? mods.name : '';
}

/** Whether `mods` is what the row last showed, compared in place (the message's objects are fresh). */
function modsSame(row, mods) {
  if (!mods || typeof mods !== 'object') return row.modsKind === 0;
  const list = mods.array;
  if (!Array.isArray(list)) return row.modsKind === 2 && row.modsName === mods.name;
  if (row.modsKind !== 1) return false;
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const acronym = list[i]?.acronym;
    if (typeof acronym !== 'string' || !acronym) continue;
    if (count >= row.acronymCount || row.acronyms[count] !== acronym) return false;
    count++;
  }
  return count === row.acronymCount;
}

function fillMods(row, mods) {
  if (modsSame(row, mods)) return;
  row.modsKind = !mods || typeof mods !== 'object' ? 0 : Array.isArray(mods.array) ? 1 : 2;
  row.modsName = row.modsKind === 2 ? mods.name : undefined;
  row.acronymCount = 0;
  if (row.modsKind === 1) {
    for (let i = 0; i < mods.array.length; i++) {
      const acronym = mods.array[i]?.acronym;
      if (typeof acronym === 'string' && acronym) row.acronyms[row.acronymCount++] = acronym;
    }
  }
  const value = modsText(mods);
  if (row.tMods !== value) { row.tMods = value; row.mods.textContent = value; }
}

function fillCommon(row, e, index) {
  const pos = displayPos(e, index);
  if (row.vPos !== pos) {
    row.vPos = pos;
    const text = row.fPos(pos);
    if (row.tPos !== text) { row.tPos = text; row.pos.textContent = text; }
  }
  const name = typeof e.name === 'string' && e.name ? e.name : '—';
  if (row.tName !== name) { row.tName = name; row.name.textContent = name; }
  const failed = e.isFailed === true;
  if (row.failed !== failed) { row.failed = failed; row.el.classList.toggle('failed', failed); }
}

/**
 * Board entry: position, name, score; accuracy, max combo and mods on a second line for your
 * direct neighbours (and for you with hudFields). Values the message did not carry show a dash.
 */
function fillBoard(row, e, index, flags) {
  fillCommon(row, e, index);
  if (row.flags !== flags) {
    const c = row.el.classList;
    c.toggle('me', (flags & ME) !== 0);
    c.toggle('kit-own', (flags & ME) !== 0);
    c.toggle('near', (flags & NEAR) !== 0);
    c.toggle('two', (flags & TWO) !== 0);
    c.toggle('three', (flags & THREE) !== 0);
    row.flags = flags;
  }
  const score = e.score;
  if (score !== row.vScore) {
    row.vScore = score;
    const text = row.fScore(known(score));
    if (row.tScore !== text) { row.tScore = text; row.score.textContent = text; }
  }
  // Mods ride every second line; accuracy and combo only where they show (FACTS), so your own
  // per-hit accuracy is not formatted while hudFields hides it.
  if ((flags & TWO) === 0) return;
  fillMods(row, e.mods);
  if ((flags & FACTS) === 0) return;
  const acc = e.accuracy;
  if (acc !== row.vAcc) {
    row.vAcc = acc;
    const text = row.fAcc(known(acc));
    if (row.tAcc !== text) { row.tAcc = text; row.acc.textContent = text; }
  }
  const combo = e.combo?.max;
  if (combo !== row.vCombo) {
    row.vCombo = combo;
    const text = row.fCombo(known(combo));
    if (row.tCombo !== text) { row.tCombo = text; row.combo.textContent = text; }
  }
}

/** Rival rung: their position and name, and your score minus theirs. */
function fillRival(row, e, index, mine) {
  fillCommon(row, e, index);
  const diff = mine - (Number(e.score) || 0);
  if (diff !== row.vDiff) {
    row.vDiff = diff;
    const text = row.fGap(diff);
    if (row.tGap !== text) { row.tGap = text; row.gap.textContent = text; }
  }
  const ahead = diff >= 0;
  if (row.vAhead !== ahead) { row.vAhead = ahead; row.el.classList.toggle('ahead', ahead); }
}

const rivals = new SlotList($('rival-rows'), $('rival-template'), fillRival);
const board = new SlotList($('board-rows'), $('board-template'), fillBoard);

/** Hero and rank-change chip of one view (board header, rival "you" line). */
function heroView(section) {
  return {
    hero: section.querySelector('[data-a="hero"]'), delta: section.querySelector('[data-a="delta"]'),
    flashEl: section.querySelector('[data-a="flash"]'), roll: null, chip: null, flash: null,
  };
}
const boardView = heroView(boardEl);
const rivalView = heroView(rivalEl);

const chipCell = new Cell(chipText);
const rivalPosCell = new Cell(rivalPos);
const rivalTotalCell = new Cell(rivalTotal);
const boardPosCell = new Cell(boardPos);
const boardTotalCell = new Cell(boardTotal);
const headGapCell = new Cell(boardGap);
const headTargetCell = new Cell($('board-target'));
let headHasGap = false;
const fHeroPos = numberFormatter('count');
const fRivalPos = numberFormatter('count');
const fTotal = numberFormatter('count');
const fRivalTotal = numberFormatter('count');
const fOwnGap = numberFormatter('delta');

let cfg = DEFAULTS;
let motion = 'full';
let style = 'board';
let horizontal = false;
let unit = 1;
let pad = PAD;
let rowLimit = DEFAULTS.rows;
let ownTwo = true;
let nearTwo = true;
let laidOut = false;

let status = 'connecting';
let wasOffline = false;
// The subscribed values, copied out of the client's reused frame object.
let state;
let entries;
let playerName;
let playerScore;
let checksum;

let shown = '';
let frame = 0;
let lastExtent = -1;
let lastPos = 0;
let lastScore = 0;
let chipHidden = null;
let chipOffline = null;
let skipOut = true;
let skipSnap = false;
let skipOffset = NaN;
let skipHorizontal = null;

// Sorted entries: a reused array with a live length, so a message never reallocates it.
const order = [];
let orderCount = 0;
// Row keys handed out this frame, and the formatted key strings, kept per map.
const usedKeys = [];
let usedCount = 0;
const idKeys = new Map();
const nameKeys = new Map();
// renderBoard's slot state, shared with putEntry.
let slotOffset = 0;
let slotSkipAt = -1;
let slotSkipPos = 0;
let slotCount = 0;
let slotPlayer = -1;

settings(DEFAULTS, next => {
  cfg = next;
  style = next.style === 'rival' ? 'rival' : 'board';
  motion = applyKitSettings(root, next);
  applyKitSettings(chip, next);
  const c = body.classList;
  c.toggle('compact', next.compact);
  c.toggle('no-acc', !next.showAcc);
  c.toggle('no-combo', !next.showCombo);
  c.toggle('no-mods', !next.showMods);
  c.toggle('no-gap', !next.showGap);
  c.toggle('hud', next.hudFields);
  relayout();
});

addEventListener('resize', relayout);

subscribe(Object.values(P), next => {
  state = next[P.state];
  entries = next[P.board];
  playerName = next[P.name];
  playerScore = next[P.score];
  if (next[P.checksum] !== checksum) {
    checksum = next[P.checksum];
    idKeys.clear();
    nameKeys.clear();
  }
  schedule();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    schedule();
  },
});

function relayout() {
  laidOut = false;
  board.clear();
  rivals.clear();
  boardView.roll?.cancel();
  boardView.chip?.cancel();
  rivalView.roll?.cancel();
  rivalView.chip?.cancel();
  rivalView.flash?.cancel();
  shown = '';
  root.classList.remove('on');
  lastExtent = -1;
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

/**
 * Fits the design to the host's box: orientation from the box's aspect (or the setting), --u so
 * type stays proportional (1 in the default boxes), and as many entries as the box holds.
 * Runs on resize and settings changes only.
 */
function layout() {
  laidOut = true;
  const w = innerWidth || 1;
  const h = innerHeight || 1;
  horizontal = cfg.orientation === 'horizontal' || (cfg.orientation !== 'vertical' && w > h * 1.6);
  pad = cfg.backing === 'none' ? 0 : PAD;
  // Vertical: --u follows the width down to the 216 px column, but a wider box (the 256 px mania
  // column) only widens the name column unless it is also taller than 400 px.
  const fitV = Math.min(w / V.width, Math.max(1, h / V.height));
  let u;
  if (style === 'rival') u = horizontal ? Math.min(h / H.height, w / (RH.width + 2 * PAD)) : Math.min(fitV, h / (RV.height + 2 * PAD));
  else u = horizontal ? h / H.height : fitV;
  unit = clamp(u, MIN_U, MAX_U);
  // Second lines: yours carries the gap (and, with hudFields, your accuracy and combo); your
  // neighbours' carry accuracy, combo and mods. The strip and compact boards have none.
  ownTwo = !horizontal && (cfg.showGap || cfg.hudFields);
  nearTwo = !horizontal && !cfg.compact && (cfg.showAcc || cfg.showCombo || cfg.showMods);
  let room = 0;
  if (style === 'board' && horizontal) {
    room = Math.floor((w / unit - 2 * pad - H.head - H.skip) / H.cell);
  } else if (style === 'board') {
    const avail = h / unit - 2 * pad - V.head;
    // Worst case: you (three lines with hudFields) and both neighbours on two, the skip marker,
    // then one-line entries.
    const fixed = 2 * V.two + (cfg.hudFields ? V.three : V.two) + V.skip;
    room = avail >= fixed ? 3 + Math.floor((avail - fixed) / V.one) : Math.floor(avail / V.two);
  }
  rowLimit = clamp(Math.min(Math.round(cfg.rows) || DEFAULTS.rows, room), 1, MAX_ROWS);
  root.style.setProperty('--u', String(Math.round(unit * 1000) / 1000));
  chip.style.setProperty('--u', String(Math.round(unit * 1000) / 1000));
  const c = body.classList;
  c.toggle('horizontal', horizontal);
  c.toggle('vertical', !horizontal);
  c.toggle('align-right', cfg.align === 'right');
  c.toggle('align-center', cfg.align === 'center');
}

/** Copies the message's entries into `order` and sorts them in place (stable insertion sort). */
function collect(list) {
  let count = 0;
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object') continue;
      // Stable, and linear on the nearly sorted board a message carries.
      let j = count++;
      while (j > 0 && compare(order[j - 1], e) > 0) { order[j] = order[j - 1]; j--; }
      order[j] = e;
    }
  }
  // Drop references to the previous message's entries past the new length.
  for (let i = count; i < orderCount; i++) order[i] = null;
  orderCount = count;
}

/** The player's entry: exact name first, case-insensitive second; closest live score breaks ties. */
function findPlayer(name, score) {
  if (typeof name !== 'string' || !name) return -1;
  const best = findName(name, score, false);
  return best >= 0 ? best : findName(name, score, true);
}

function findName(name, score, fold) {
  const target = fold ? name.trim().toLowerCase() : name;
  const hasScore = Number.isFinite(score);
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < orderCount; i++) {
    const candidate = order[i].name;
    if (typeof candidate !== 'string') continue;
    if ((fold ? candidate.trim().toLowerCase() : candidate) !== target) continue;
    const diff = hasScore ? Math.abs((Number(order[i].score) || 0) - score) : 0;
    if (diff < bestDiff) { best = i; bestDiff = diff; }
  }
  return best;
}

function uniqueId(id) {
  let count = 0;
  for (let i = 0; i < orderCount; i++) if (order[i].id === id && ++count > 1) return false;
  return true;
}

function keyOf(e, index, player) {
  if (index === player) return 'me';
  let key;
  if (Number.isInteger(e.id) && e.id > 0 && uniqueId(e.id)) {
    key = idKeys.get(e.id);
    if (key === undefined) { key = `u${e.id}`; idKeys.set(e.id, key); }
  } else if (typeof e.name === 'string') {
    // Entries without a usable id are keyed by name and score; their scores are final, so the
    // string is built once per player rather than per frame.
    let cached = nameKeys.get(e.name);
    if (cached === undefined) { cached = { score: undefined, key: null }; nameKeys.set(e.name, cached); }
    if (cached.key === null || cached.score !== e.score) { cached.score = e.score; cached.key = `n${e.name}\u0001${e.score}`; }
    key = cached.key;
  } else {
    key = `n${e.name}\u0001${e.score}`;
  }
  for (let i = 0; i < usedCount; i++) {
    if (usedKeys[i] === key) { key += `#${index}`; break; }
  }
  usedKeys[usedCount++] = key;
  return key;
}

function render(now) {
  frame = 0;
  if (!laidOut) layout();
  rivals.begin();
  board.begin();
  if (skipSnap) { skipEl.classList.remove('snap', 'out'); skipSnap = false; skipOut = false; }

  const live = status === 'live';
  if (status === 'offline') wasOffline = true;
  else if (live) wasOffline = false;
  if (chipHidden !== live) { chipHidden = live; chip.hidden = live; }
  if (chipOffline !== wasOffline) { chipOffline = wasOffline; chip.classList.toggle('offline', wasOffline); }
  if (!live) chipCell.set(wasOffline ? 'vosu offline' : 'Connecting to vosu');

  // Gameplay only: the in-game scoreboard is a gameplay element, and on song select and results
  // osu! shows its own leaderboard or the page would sit over the results panel.
  const playing = live && state === PLAY;
  if (!playing) { lastPos = 0; lastScore = 0; }
  collect(playing ? entries : null);
  const player = findPlayer(playerName, playerScore);
  // An idle leaderboard (empty, as in the replay renderer and lazer) renders nothing; the rival
  // ladder also needs you on it.
  const want = !orderCount ? '' : style === 'board' ? 'board' : player >= 0 ? 'rival' : '';

  if (want !== shown) {
    // Rows left over from a previous attempt must not flash in with the cluster.
    if (want === 'rival') rivals.clear();
    if (want === 'board') { board.clear(); lastExtent = -1; }
    shown = want;
    // The leaving view stays drawn while the root fades out.
    if (want) { boardEl.hidden = want !== 'board'; rivalEl.hidden = want !== 'rival'; }
    root.classList.toggle('on', want !== '');
  }
  if (!want) return;

  for (let i = 0; i < usedCount; i++) usedKeys[i] = null;
  usedCount = 0;

  if (want === 'rival') renderRival(player, now);
  else renderBoard(player, now);

  if (player >= 0) signalMove(displayPos(order[player], player), Number(order[player].score) || 0, want === 'rival' ? rivalView : boardView);
  if (rivals.enteringCount || board.enteringCount || skipSnap) schedule();
}

function renderRival(player, now) {
  const pos = displayPos(order[player], player);
  if (rivalPosCell.n !== pos) { rivalPosCell.n = pos; rivalPosCell.set(fRivalPos(pos)); }
  if (rivalTotalCell.n !== orderCount) { rivalTotalCell.n = orderCount; rivalTotalCell.set(fRivalTotal(orderCount)); }
  const mine = Number(order[player].score) || 0;
  const below = (horizontal ? RH.below : RV_BELOW) * unit;
  if (player > 0) rivals.put(keyOf(order[player - 1], player - 1, player), 0, 0, order[player - 1], player - 1, mine);
  if (player + 1 < orderCount) rivals.put(keyOf(order[player + 1], player + 1, player), 0, below, order[player + 1], player + 1, mine);
  rivals.end(now, below / 2, (horizontal ? RH.below : V.one) * unit, false);
  if (rivals.moved && motion === 'full') dipPassers(rivals, below / 2, below / 2, false);
}

function flagsOf(i, player) {
  if (i === player) return ownTwo ? (cfg.hudFields ? ME | TWO | FACTS | THREE : ME | TWO) : ME;
  if (player >= 0 && (i === player - 1 || i === player + 1)) return nearTwo ? NEAR | TWO | FACTS : NEAR;
  return 0;
}

/** Puts entry `i` in the next board slot, after the skip marker when this is its slot. */
function putEntry(i) {
  if (slotCount++ === slotSkipAt) { slotSkipPos = slotOffset; slotOffset += horizontal ? H.skip : V.skip; }
  const flags = flagsOf(i, slotPlayer);
  const at = slotOffset * unit;
  board.put(keyOf(order[i], i, slotPlayer), horizontal ? at : 0, horizontal ? 0 : at, order[i], i, flags);
  slotOffset += horizontal ? H.cell : flags & THREE ? V.three : flags & TWO ? V.two : V.one;
}

function renderBoard(player, now) {
  const n = orderCount;
  // Window: the top entries, and when you are below them, a skip marker, then the player you are
  // chasing, you and the player behind you, so a pass slides that player under you. The limit
  // counts entries, not the marker.
  slotSkipAt = -1;
  slotCount = 0;
  slotOffset = 0;
  slotPlayer = player;
  if (n <= rowLimit || player < rowLimit) {
    for (let i = 0; i < Math.min(n, rowLimit); i++) putEntry(i);
  } else {
    const before = rowLimit >= 2 ? 1 : 0;
    const after = rowLimit >= 3 && player + 1 < n ? 1 : 0;
    const top = rowLimit - 1 - before - after;
    slotSkipAt = top;
    for (let i = 0; i < top; i++) putEntry(i);
    for (let i = player - before; i <= player + after; i++) putEntry(i);
  }
  const me = player >= 0 ? board.pool.get('me') : undefined;
  const pivot = me === undefined ? -Infinity : horizontal ? me.x : me.y;
  board.end(now, pivot, (horizontal ? H.cell / 2 : V.one) * unit, horizontal);
  if (board.moved && motion === 'full' && me !== undefined && me.py === me.py) {
    dipPassers(board, horizontal ? me.px : me.py, horizontal ? me.x : me.y, horizontal);
  }

  if (slotSkipAt >= 0) {
    const offset = slotSkipPos * unit;
    if (offset !== skipOffset || horizontal !== skipHorizontal) {
      skipOffset = offset;
      skipHorizontal = horizontal;
      skipEl.style.transform = horizontal ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`;
    }
    if (skipOut) { skipEl.classList.add('snap'); skipSnap = true; }
  } else if (!skipOut) {
    skipEl.classList.add('out');
    skipOut = true;
  }
  const extent = slotOffset * unit;
  if (extent !== lastExtent) {
    lastExtent = extent;
    const s = board.container.style;
    s.width = horizontal ? `${extent}px` : '';
    s.height = horizontal ? '' : `${extent}px`;
  }

  // Your position (dash when you are not on the board), the total, and the gap: to the player
  // above you, or your lead over the second when first.
  const pos = player >= 0 ? displayPos(order[player], player) : 0;
  if (boardPosCell.n !== pos) {
    boardPosCell.n = pos;
    boardPosCell.set(pos ? fHeroPos(pos) : '—');
    boardEl.classList.toggle('unplaced', !pos);
  }
  if (boardTotalCell.n !== n) { boardTotalCell.n = n; boardTotalCell.set(fTotal(n)); }
  const other = player > 0 ? player - 1 : 1;
  const target = player < 0 || n < 2 ? -2 : player > 0 ? displayPos(order[other], other) : -1;
  // The strip carries the gap in its header, as "−49,006 to #13" over two lines where the list
  // has its total; the list carries it in your row.
  if (horizontal && headHasGap !== target > -2) { headHasGap = target > -2; boardEl.classList.toggle('has-gap', headHasGap); }
  if (target === -2) return;
  const diff = (Number(order[player].score) || 0) - (Number(order[other].score) || 0);
  const gap = fOwnGap(diff);
  if (horizontal) {
    headGapCell.set(gap);
    if (headTargetCell.n !== target) { headTargetCell.n = target; headTargetCell.set(targetLabel(target)); }
    return;
  }
  if (!me || (me.flags & TWO) === 0) return;
  if (me.tGap !== gap) { me.tGap = gap; me.gap.textContent = gap; }
  if (me.nTarget !== target) { me.nTarget = target; me.target.textContent = targetLabel(target); }
}

/** The gap's label: the place you are chasing, or your lead when first. Called on change only. */
function targetLabel(target) {
  return target < 0 ? 'lead' : `to #${target}`;
}

/**
 * Rows of `list` that slid past yours this frame (from before `was` to after `is`, or back) dim
 * while they pass behind it.
 */
function dipPassers(list, was, is, alongX) {
  const rows = list.rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.key === 'me' || !row.on || row.serial !== list.serial || row.py !== row.py) continue;
    if ((alongX ? row.px < was : row.py < was) === (alongX ? row.x < is : row.y < is)) continue;
    if (row.dip) restart(row.dip);
    else row.dip = row.el.animate(KF_DIP, DIP_OPTS);
  }
}

function restart(animation) {
  animation.currentTime = 0;
  animation.play();
}

/**
 * One-shot cue when your position changes: the hero rolls to the new number (from below when you
 * climb), a ▲n / ▼n chip shows for 2.4 s, and your row (the rival's "you" line) flashes amber
 * when you climb. A retry (the score drops) resets it silently.
 */
function signalMove(pos, score, view) {
  const restarted = score < lastScore;
  lastScore = score;
  if (restarted || !lastPos || pos === lastPos) { lastPos = pos; return; }
  const up = pos < lastPos;
  view.delta.textContent = `${up ? '▲' : '▼'}${up ? lastPos - pos : pos - lastPos}`;
  view.delta.classList.toggle('down', !up);
  lastPos = pos;
  if (view.chip) {
    view.chip.effect.setKeyframes(motion === 'off' ? KF_CHIP_OFF : KF_CHIP);
    restart(view.chip);
  } else {
    view.chip = view.delta.animate(motion === 'off' ? KF_CHIP_OFF : KF_CHIP, CHIP_OPTS);
  }
  if (motion === 'off') return;
  if (view.roll) {
    view.roll.effect.setKeyframes(up ? KF_ROLL_UP : KF_ROLL_DOWN);
    restart(view.roll);
  } else {
    view.roll = view.hero.animate(up ? KF_ROLL_UP : KF_ROLL_DOWN, ROLL_OPTS);
  }
  if (motion !== 'full' || !up) return;
  if (view === rivalView) {
    if (view.flash) restart(view.flash);
    else view.flash = view.flashEl.animate(KF_FLASH, FLASH_OPTS);
    return;
  }
  const me = board.pool.get('me');
  if (!me) return;
  if (me.flashAnim) restart(me.flashAnim);
  else me.flashAnim = me.flash.animate(KF_FLASH, FLASH_OPTS);
}

// Copyright (c) 2026 18-LAB. MIT.
// Live in-game leaderboard. The page is sized by its host (OBS, vosulay, the replay renderer) and
// lays itself out for that box: a vertical board in tall boxes, a horizontal strip in wide ones.
// Styles: board (the in-game list) or rival (the player above, you, the player below, gaps).
// Rows sit absolutely positioned and move between slots on a transform transition, so an
// overtake slides the passed player past you without layout work.
import { subscribe, settings, mapPalette, applyPalette } from './vosu-overlay.js';

const PLAY = 2;
const MAX_ROWS = 16;
const PRUNE_MS = 800;
const DELTA_MS = 2400;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;
// Design geometry in CSS px before scaling to the box; style.css carries the same numbers.
const BOARD_V = { width: 280, head: 32, row: 48, skip: 16 };
const BOARD_VC = { width: 336, head: 32, row: 34, skip: 12 };
const BOARD_H = { height: 76, head: 156, entry: 188, skip: 28 };
const BOARD_HC = { height: 56, head: 156, entry: 188, skip: 28 };
const RIVAL_V = { width: 272, height: 130, above: 0, below: 80 };
const RIVAL_H = { width: 392, height: 56, above: 0, below: 28 };
// Panel backing: 8 px side padding plus 1 px borders; 4 + 6 px vertical padding, 2 + 1 px borders.
const PANEL_X = 18;
const PANEL_Y = 13;
const P = { state: '/state/number', checksum: '/beatmap/checksum', board: '/leaderboard', name: '/play/playerName', score: '/play/score' };
const DEFAULTS = {
  style: 'board', orientation: 'auto', align: 'left', backing: 'none', accent: 'map',
  rows: 8, showAcc: true, showCombo: true, showMods: true, compact: false, showGap: true,
};

const $ = id => document.getElementById(id);
const root = $('root');
const chip = $('chip');
const chipText = $('chip-text');
const rivalEl = $('rival');
const rivalPos = $('rival-pos');
const rivalTotal = $('rival-total');
const rivalDelta = $('rival-delta');
const boardEl = $('board');
const boardPos = $('board-pos');
const boardTotal = $('board-total');
const boardGap = $('board-gap');
const skipEl = $('skip');
const skipLabel = skipEl.firstElementChild;

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MINUS = '\u2212';
const FLASH_KEYS = [{ opacity: 0.4 }, { opacity: 0 }];
const FLASH_OPTS = { duration: 720, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const ROLL_KEYS = [{ transform: 'translate3d(0,40%,0)', opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }];
const ROLL_OPTS = { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

/**
 * Keyed rows placed at slot offsets; entering rows snap into place, then fade in next frame.
 * Rows and their value caches live as long as their entry stays on the board, so a frame only
 * touches the DOM (and formats text) for values that changed.
 */
class SlotList {
  constructor(container, template, fill, hash) {
    this.container = container;
    this.template = template.content.firstElementChild;
    this.fill = fill;
    this.hash = hash;
    this.pool = new Map();
    this.rows = [];
    this.entering = [];
    this.enteringCount = 0;
    this.serial = 0;
  }

  begin() {
    for (let i = 0; i < this.enteringCount; i++) {
      this.entering[i].el.classList.remove('snap', 'out');
      this.entering[i] = null;
    }
    this.enteringCount = 0;
    this.serial++;
  }

  put(key, x, y, e, index, extra) {
    let row = this.pool.get(key);
    if (!row) {
      row = newRow(key, this.template.cloneNode(true), this.hash);
      this.container.append(row.el);
      this.pool.set(key, row);
      this.rows.push(row);
    }
    row.serial = this.serial;
    this.fill(row, e, index, extra);
    if (!row.on) {
      row.on = true;
      row.el.classList.add('snap', 'out');
      this.entering[this.enteringCount++] = row;
    } else if (row.x === x && row.y === y) {
      return;
    }
    row.x = x;
    row.y = y;
    row.el.style.transform = `translate3d(${x}px,${y}px,0)`;
  }

  end(now) {
    const rows = this.rows;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.serial === this.serial) continue;
      if (row.on) {
        row.on = false;
        row.hiddenAt = now;
        row.el.classList.add('out');
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
 * One row: its nodes (by `data-r`) and the last value written to each, in one fixed shape.
 * Value caches start as null: they hold the message's own (already boxed) numbers, so reading
 * and comparing them never boxes a double, and null differs from any first value.
 */
function newRow(key, el, hash) {
  const row = {
    key, el, on: false, x: NaN, y: NaN, serial: 0, hiddenAt: 0, isMe: false, failed: false, hash,
    pos: null, name: null, score: null, acc: null, combo: null, mods: null, flash: null, delta: null, gap: null,
    vPos: null, tName: null, vScore: null, vAcc: null, kAcc: -1, tAcc: null, vCombo: null, vDiff: null, vAhead: null,
    modsKind: -1, modsName: undefined, acronyms: [], acronymCount: 0, tMods: null,
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
const signed = diff => `${diff < 0 ? MINUS : '+'}${INT.format(Math.abs(Math.round(diff)))}`;
const rankOf = e => (Number.isInteger(e.position) && e.position > 0 ? e.position : Infinity);
const compare = (a, b) => rankOf(a) - rankOf(b) || (Number(b.score) || 0) - (Number(a.score) || 0);
const displayPos = (e, index) => (Number.isInteger(e.position) && e.position > 0 ? e.position : index + 1);

function modsText(mods) {
  if (!mods || typeof mods !== 'object') return '';
  if (Array.isArray(mods.array)) {
    let out = '';
    for (let i = 0; i < mods.array.length; i++) {
      const acronym = mods.array[i]?.acronym;
      if (typeof acronym === 'string' && acronym) out += out ? ` ${acronym}` : acronym;
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
  if (row.vPos !== pos) { row.vPos = pos; row.pos.textContent = row.hash ? `#${pos}` : String(pos); }
  const name = typeof e.name === 'string' && e.name ? e.name : '—';
  if (row.tName !== name) { row.tName = name; row.name.textContent = name; }
  const failed = e.isFailed === true;
  if (row.failed !== failed) { row.failed = failed; row.el.classList.toggle('failed', failed); }
}

/**
 * Board entry: position, name, score; accuracy, max combo and mods as secondary data.
 * Comparisons are inline and NaN-safe (a non-numeric value writes its dash once): a helper
 * taking the numbers would box them on every call.
 */
function fillBoard(row, e, index, isMe) {
  fillCommon(row, e, index);
  const score = Number(e.score);
  const lastScore = row.vScore;
  if (score !== lastScore && (score === score || lastScore === lastScore)) {
    row.vScore = score;
    row.score.textContent = Number.isFinite(score) ? INT.format(Math.round(score)) : '—';
  }
  const acc = Number(e.accuracy);
  const lastAcc = row.vAcc;
  if (acc !== lastAcc && (acc === acc || lastAcc === lastAcc)) {
    row.vAcc = acc;
    // The text is the accuracy in hundredths. Away from a rounding tie Math.round decides it
    // exactly, so a hit that moves the accuracy without changing the shown value formats nothing.
    const scaled = acc * 100;
    const decided = acc >= 0 && Math.abs(scaled - Math.floor(scaled) - 0.5) > 1e-6;
    const hundredths = decided ? Math.round(scaled) : -1;
    if (hundredths < 0 || hundredths !== row.kAcc) {
      row.kAcc = hundredths;
      const value = Number.isFinite(acc) ? `${acc.toFixed(2)}%` : '—';
      if (row.tAcc !== value) { row.tAcc = value; row.acc.textContent = value; }
    }
  }
  const combo = Number(e.combo?.max);
  const lastCombo = row.vCombo;
  if (combo !== lastCombo && (combo === combo || lastCombo === lastCombo)) {
    row.vCombo = combo;
    row.combo.textContent = Number.isFinite(combo) ? `${INT.format(combo)}x` : '—';
  }
  fillMods(row, e.mods);
  if (row.isMe !== isMe) { row.isMe = isMe; row.el.classList.toggle('me', isMe); }
}

/** Rival rung: their position and name, and your score minus theirs. */
function fillRival(row, e, index, mine) {
  fillCommon(row, e, index);
  const diff = mine - (Number(e.score) || 0);
  const last = row.vDiff;
  if (diff !== last && (diff === diff || last === last)) { row.vDiff = diff; row.gap.textContent = signed(diff); }
  const ahead = diff >= 0;
  if (row.vAhead !== ahead) { row.vAhead = ahead; row.el.classList.toggle('ahead', ahead); }
}

const rivals = new SlotList($('rival-rows'), $('rival-template'), fillRival, true);
const board = new SlotList($('board-rows'), $('board-template'), fillBoard, false);

const chipCell = new Cell(chipText);
const rivalPosCell = new Cell(rivalPos);
const rivalTotalCell = new Cell(rivalTotal);
const boardPosCell = new Cell(boardPos);
const boardTotalCell = new Cell(boardTotal);
const gapCell = new Cell(boardGap.firstElementChild);
const labelCell = new Cell(boardGap.lastElementChild);
const skipCell = new Cell(skipLabel);

let cfg = DEFAULTS;
let style = 'board';
let horizontal = false;
let designW = 0;
let padX = 0;
let rowLimit = DEFAULTS.rows;
let geo = BOARD_V;
let laidOut = false;

let status = 'connecting';
let wasOffline = false;
let checksum;
// The subscribed values, copied out of the client's reused frame object.
let state;
let entries;
let playerName;
let playerScore;

let shown = '';
let frame = 0;
let lastExtent = -1;
let lastShift = NaN;
let lastPos = 0;
let lastScore = 0;
let deltaTimer = 0;
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
let slotStep = 0;
let slotSkipAt = -1;
let slotCount = 0;
let slotPlayer = -1;

settings(DEFAULTS, next => {
  cfg = next;
  style = next.style === 'rival' ? 'rival' : 'board';
  const c = root.classList;
  c.toggle('compact', next.compact);
  c.toggle('no-acc', !next.showAcc);
  c.toggle('no-combo', !next.showCombo);
  c.toggle('no-mods', !next.showMods);
  c.toggle('no-gap', !next.showGap);
  c.toggle('lab', next.accent === '18-lab');
  for (const backing of ['scrim', 'panel']) c.toggle(`backing-${backing}`, next.backing === backing);
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
    loadPalette(checksum);
  }
  schedule();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    schedule();
  },
});

/** Map tint, off the hot path; a stale result for a previous map is dropped. */
async function loadPalette(sum) {
  const result = typeof sum === 'string' && sum ? await mapPalette(sum) : null;
  if (sum !== checksum) return;
  applyPalette(root, result);
}

function relayout() {
  laidOut = false;
  board.clear();
  rivals.clear();
  shown = '';
  lastExtent = -1;
  lastShift = NaN;
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

/**
 * Fits the design to the host's box: orientation from the box's aspect (or the setting), a
 * uniform scale so type stays proportional, and as many rows/entries as the box holds.
 * Runs on resize and settings changes only.
 */
function layout() {
  laidOut = true;
  const w = innerWidth || 1;
  const h = innerHeight || 1;
  horizontal = cfg.orientation === 'horizontal' || (cfg.orientation !== 'vertical' && w > h * 1.6);
  // The panel backing adds padding and borders inside the box.
  padX = cfg.backing === 'panel' ? PANEL_X : 0;
  const padY = cfg.backing === 'panel' ? PANEL_Y : 0;
  let scale;
  if (style === 'rival') {
    const g = horizontal ? RIVAL_H : RIVAL_V;
    scale = Math.min(w / (g.width + padX), h / (g.height + padY));
  } else if (horizontal) {
    geo = cfg.compact ? BOARD_HC : BOARD_H;
    scale = h / (geo.height + padY);
  } else {
    geo = cfg.compact ? BOARD_VC : BOARD_V;
    // As wide as the box, but never so large that fewer than three rows fit.
    scale = Math.min(w / geo.width, h / (geo.head + 3 * geo.row + padY));
  }
  scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  designW = w / scale;
  const designH = h / scale;
  const room = style === 'board'
    ? Math.floor(horizontal ? (designW - padX - geo.head - geo.skip) / geo.entry : (designH - padY - geo.head - geo.skip) / geo.row)
    : 0;
  rowLimit = clamp(Math.min(Math.round(cfg.rows) || DEFAULTS.rows, room), 1, MAX_ROWS);
  const s = root.style;
  s.width = `${designW}px`;
  s.height = `${designH}px`;
  s.transform = `scale(${scale})`;
  const c = root.classList;
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

/** Horizontal strips hug the left, centre or right of the box; vertical ones mirror in CSS. */
function shift(el, extent) {
  const offset = !horizontal || cfg.align === 'left' ? 0
    : cfg.align === 'right' ? Math.max(0, designW - extent) : Math.max(0, (designW - extent) / 2);
  if (offset === lastShift) return;
  lastShift = offset;
  el.style.transform = offset ? `translate3d(${offset}px,0,0)` : '';
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
  // An idle leaderboard (empty, as in the replay renderer) renders nothing; the rival ladder
  // also needs you on it.
  const want = !orderCount ? '' : style === 'board' ? 'board' : player >= 0 ? 'rival' : '';

  if (want !== shown) {
    // Rows left over from a previous attempt must not flash in with the cluster.
    if (want === 'rival') rivals.clear();
    if (want === 'board') { board.clear(); lastExtent = -1; }
    lastShift = NaN;
    shown = want;
    rivalEl.classList.toggle('on', want === 'rival');
    boardEl.classList.toggle('on', want === 'board');
  }
  if (!want) return;

  for (let i = 0; i < usedCount; i++) usedKeys[i] = null;
  usedCount = 0;

  if (want === 'rival') renderRival(player, now);
  else renderBoard(player, now);

  if (player >= 0) signalMove(displayPos(order[player], player), Number(order[player].score) || 0, want);
  if (rivals.enteringCount || board.enteringCount || skipSnap) schedule();
}

function renderRival(player, now) {
  const g = horizontal ? RIVAL_H : RIVAL_V;
  const pos = displayPos(order[player], player);
  if (rivalPosCell.n !== pos) { rivalPosCell.n = pos; rivalPosCell.set(String(pos)); }
  if (rivalTotalCell.n !== orderCount) { rivalTotalCell.n = orderCount; rivalTotalCell.set(`/ ${orderCount}`); }
  const mine = Number(order[player].score) || 0;
  if (player > 0) rivals.put(keyOf(order[player - 1], player - 1, player), 0, g.above, order[player - 1], player - 1, mine);
  if (player + 1 < orderCount) rivals.put(keyOf(order[player + 1], player + 1, player), 0, g.below, order[player + 1], player + 1, mine);
  rivals.end(now);
  shift(rivalEl, g.width + padX);
}

/** Puts entry `i` in the next board slot, past the skip marker once it is placed. */
function putEntry(i, isMe) {
  const slot = slotCount++;
  const offset = slot * slotStep + (slotSkipAt >= 0 && slot >= slotSkipAt ? geo.skip : 0);
  board.put(keyOf(order[i], i, slotPlayer), horizontal ? offset : 0, horizontal ? 0 : offset, order[i], i, isMe);
}

function renderBoard(player, now) {
  const n = orderCount;
  // Window: the top entries, and when you are below them, a skip marker, then the player you are
  // chasing, you and the player behind you, so a pass slides that player under you. The limit
  // counts entries, not the marker.
  let skipped = 0;
  slotSkipAt = -1;
  slotCount = 0;
  slotPlayer = player;
  slotStep = horizontal ? geo.entry : geo.row;
  if (n <= rowLimit || player < rowLimit) {
    for (let i = 0; i < Math.min(n, rowLimit); i++) putEntry(i, i === player);
  } else {
    const before = rowLimit >= 2 ? 1 : 0;
    const after = rowLimit >= 3 && player + 1 < n ? 1 : 0;
    const top = rowLimit - 1 - before - after;
    slotSkipAt = top;
    for (let i = 0; i < top; i++) putEntry(i, false);
    skipped = player - before - top;
    for (let i = player - before; i <= player + after; i++) putEntry(i, i === player);
  }
  board.end(now);

  const skipAt = slotSkipAt;
  if (skipAt >= 0) {
    if (skipCell.n !== skipped) { skipCell.n = skipped; skipCell.set(`+${skipped}`); }
    const offset = skipAt * slotStep;
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
  const extent = slotCount * slotStep + (skipAt >= 0 ? geo.skip : 0);
  if (extent !== lastExtent) {
    lastExtent = extent;
    const s = board.container.style;
    s.width = horizontal ? `${extent}px` : '';
    s.height = horizontal ? '' : `${extent}px`;
  }
  shift(boardEl, geo.head + extent + padX);

  // Position (0 when you are not on the board), total, and the gap with its label: the player
  // above you, your lead when first (-1), nothing without a rival (-2).
  const pos = player >= 0 ? displayPos(order[player], player) : 0;
  if (boardPosCell.n !== pos) { boardPosCell.n = pos; boardPosCell.set(pos ? String(pos) : '—'); }
  if (boardTotalCell.n !== n) { boardTotalCell.n = n; boardTotalCell.set(`/ ${n}`); }
  let diff = 0;
  let target = -2;
  if (player >= 0 && n > 1) {
    const other = player > 0 ? player - 1 : 1;
    diff = (Number(order[player].score) || 0) - (Number(order[other].score) || 0);
    target = player > 0 ? displayPos(order[other], other) : -1;
  }
  const lastDiff = gapCell.n;
  if (target === -2) { gapCell.n = null; gapCell.set(''); }
  else if (diff !== lastDiff && (diff === diff || lastDiff === lastDiff)) { gapCell.n = diff; gapCell.set(signed(diff)); }
  if (labelCell.n !== target) { labelCell.n = target; labelCell.set(target === -2 ? '' : target === -1 ? 'lead' : `to #${target}`); }
}

/** One-shot cue when your position changes; a retry (score drops) resets it silently. */
function signalMove(pos, score, view) {
  const restarted = score < lastScore;
  lastScore = score;
  if (restarted || !lastPos || pos === lastPos) { lastPos = pos; return; }
  const up = pos < lastPos;
  const delta = view === 'rival' ? rivalDelta : board.pool.get('me')?.delta;
  if (delta) {
    delta.textContent = `${up ? '▲' : '▼'}${Math.abs(lastPos - pos)}`;
    delta.classList.toggle('down', !up);
    delta.classList.add('on');
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => delta.classList.remove('on'), DELTA_MS);
  }
  if (view === 'rival') rivalPos.animate(ROLL_KEYS, ROLL_OPTS);
  else if (up) board.pool.get('me')?.flash.animate(FLASH_KEYS, FLASH_OPTS);
  lastPos = pos;
}

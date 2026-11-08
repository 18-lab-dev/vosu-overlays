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

/** Keyed rows placed at slot offsets; entering rows snap into place, then fade in next frame. */
class SlotList {
  constructor(container, template, fill) {
    this.container = container;
    this.template = template.content.firstElementChild;
    this.fill = fill;
    this.pool = new Map();
    this.entering = [];
    this.serial = 0;
  }

  begin() {
    for (const row of this.entering) row.el.classList.remove('snap', 'out');
    this.entering.length = 0;
    this.serial++;
  }

  put(key, x, y, e, index, extra) {
    let row = this.pool.get(key);
    if (!row) {
      const el = this.template.cloneNode(true);
      row = { key, el, t: {}, v: {}, on: false, x: NaN, y: NaN, serial: 0, hiddenAt: 0, isMe: false, failed: false };
      for (const node of el.querySelectorAll('[data-r]')) row[node.dataset.r] = node;
      this.container.append(el);
      this.pool.set(key, row);
    }
    row.serial = this.serial;
    this.fill(row, e, index, extra);
    if (!row.on) {
      row.on = true;
      row.el.classList.add('snap', 'out');
      this.entering.push(row);
    } else if (row.x === x && row.y === y) {
      return;
    }
    row.x = x;
    row.y = y;
    row.el.style.transform = `translate3d(${x}px,${y}px,0)`;
  }

  end(now) {
    for (const row of this.pool.values()) {
      if (row.serial === this.serial) continue;
      if (row.on) {
        row.on = false;
        row.hiddenAt = now;
        row.el.classList.add('out');
      } else if (now - row.hiddenAt > PRUNE_MS) {
        row.el.remove();
        this.pool.delete(row.key);
      }
    }
  }

  clear() {
    for (const row of this.pool.values()) row.el.remove();
    this.pool.clear();
    this.entering.length = 0;
  }
}

function setText(row, key, el, value) {
  if (row.t[key] === value) return;
  row.t[key] = value;
  el.textContent = value;
}

function text(el, value) {
  if (el.textContent !== value) el.textContent = value;
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
    for (const mod of mods.array) {
      const acronym = mod?.acronym;
      if (typeof acronym === 'string' && acronym) out += out ? ` ${acronym}` : acronym;
    }
    return out;
  }
  return typeof mods.name === 'string' && mods.name !== 'NM' ? mods.name : '';
}

function fillCommon(row, e, index) {
  const pos = displayPos(e, index);
  if (row.v.pos !== pos) { row.v.pos = pos; row.pos.textContent = row.hash ? `#${pos}` : String(pos); }
  setText(row, 'name', row.name, typeof e.name === 'string' && e.name ? e.name : '—');
  const failed = e.isFailed === true;
  if (row.failed !== failed) { row.failed = failed; row.el.classList.toggle('failed', failed); }
}

/** Board entry: position, name, score; accuracy, max combo and mods as secondary data. */
function fillBoard(row, e, index, isMe) {
  fillCommon(row, e, index);
  const score = Number(e.score);
  if (row.v.score !== score) { row.v.score = score; row.score.textContent = Number.isFinite(score) ? INT.format(Math.round(score)) : '—'; }
  const acc = Number(e.accuracy);
  if (row.v.acc !== acc) { row.v.acc = acc; row.acc.textContent = Number.isFinite(acc) ? `${acc.toFixed(2)}%` : '—'; }
  const combo = Number(e.combo?.max);
  if (row.v.combo !== combo) { row.v.combo = combo; row.combo.textContent = Number.isFinite(combo) ? `${INT.format(combo)}x` : '—'; }
  setText(row, 'mods', row.mods, modsText(e.mods));
  if (row.isMe !== isMe) { row.isMe = isMe; row.el.classList.toggle('me', isMe); }
}

/** Rival rung: their position and name, and your score minus theirs. */
function fillRival(row, e, index, mine) {
  row.hash = true;
  fillCommon(row, e, index);
  const diff = mine - (Number(e.score) || 0);
  if (row.v.diff !== diff) { row.v.diff = diff; row.gap.textContent = signed(diff); }
  const ahead = diff >= 0;
  if (row.v.ahead !== ahead) { row.v.ahead = ahead; row.el.classList.toggle('ahead', ahead); }
}

const rivals = new SlotList($('rival-rows'), $('rival-template'), fillRival);
const board = new SlotList($('board-rows'), $('board-template'), fillBoard);

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
let values = {};
let checksum;

let shown = '';
let frame = 0;
let lastExtent = -1;
let lastShift = NaN;
let lastPos = 0;
let lastScore = 0;
let deltaTimer = 0;

const order = [];
const ids = new Map();
const used = new Set();

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
  values = next;
  if (next[P.checksum] !== checksum) {
    checksum = next[P.checksum];
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
  for (let i = 0; i < order.length; i++) {
    const candidate = order[i].name;
    if (typeof candidate !== 'string') continue;
    if ((fold ? candidate.trim().toLowerCase() : candidate) !== target) continue;
    const diff = hasScore ? Math.abs((Number(order[i].score) || 0) - score) : 0;
    if (diff < bestDiff) { best = i; bestDiff = diff; }
  }
  return best;
}

function keyOf(e, index, player) {
  if (index === player) return 'me';
  let key = Number.isInteger(e.id) && e.id > 0 && ids.get(e.id) === 1 ? `u${e.id}` : `n${e.name}\u0001${e.score}`;
  if (used.has(key)) key += `#${index}`;
  used.add(key);
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
  if (skipEl.classList.contains('snap')) skipEl.classList.remove('snap', 'out');

  const live = status === 'live';
  if (status === 'offline') wasOffline = true;
  else if (live) wasOffline = false;
  chip.hidden = live;
  chip.classList.toggle('offline', wasOffline);
  if (!live) text(chipText, wasOffline ? 'vosu offline' : 'Connecting to vosu');

  // Gameplay only: the in-game scoreboard is a gameplay element, and on song select and results
  // osu! shows its own leaderboard or the page would sit over the results panel.
  const state = values[P.state];
  const list = live && state === PLAY ? values[P.board] : null;
  if (!(live && state === PLAY)) { lastPos = 0; lastScore = 0; }
  order.length = 0;
  if (Array.isArray(list)) for (const e of list) if (e && typeof e === 'object') order.push(e);
  order.sort(compare);
  const player = findPlayer(values[P.name], values[P.score]);
  // An idle leaderboard (empty, as in the replay renderer) renders nothing; the rival ladder
  // also needs you on it.
  const want = !order.length ? '' : style === 'board' ? 'board' : player >= 0 ? 'rival' : '';

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

  ids.clear();
  used.clear();
  for (const e of order) if (Number.isInteger(e.id) && e.id > 0) ids.set(e.id, (ids.get(e.id) || 0) + 1);

  if (want === 'rival') renderRival(player, now);
  else renderBoard(player, now);

  if (player >= 0) signalMove(displayPos(order[player], player), Number(order[player].score) || 0, want);
  if (rivals.entering.length || board.entering.length || skipEl.classList.contains('snap')) schedule();
}

function renderRival(player, now) {
  const g = horizontal ? RIVAL_H : RIVAL_V;
  text(rivalPos, String(displayPos(order[player], player)));
  text(rivalTotal, `/ ${order.length}`);
  const mine = Number(order[player].score) || 0;
  if (player > 0) rivals.put(keyOf(order[player - 1], player - 1, player), 0, g.above, order[player - 1], player - 1, mine);
  if (player + 1 < order.length) rivals.put(keyOf(order[player + 1], player + 1, player), 0, g.below, order[player + 1], player + 1, mine);
  rivals.end(now);
  shift(rivalEl, g.width + padX);
}

function renderBoard(player, now) {
  const n = order.length;
  // Window: the top entries, and when you are below them, a skip marker, then the player you are
  // chasing, you and the player behind you, so a pass slides that player under you. The limit
  // counts entries, not the marker.
  let skipAt = -1;
  let skipped = 0;
  let count = 0;
  const step = horizontal ? geo.entry : geo.row;
  const at = slot => slot * step + (skipAt >= 0 && slot >= skipAt ? geo.skip : 0);
  const put = (i, isMe) => {
    const offset = at(count++);
    board.put(keyOf(order[i], i, player), horizontal ? offset : 0, horizontal ? 0 : offset, order[i], i, isMe);
  };
  if (n <= rowLimit || player < rowLimit) {
    for (let i = 0; i < Math.min(n, rowLimit); i++) put(i, i === player);
  } else {
    const before = rowLimit >= 2 ? 1 : 0;
    const after = rowLimit >= 3 && player + 1 < n ? 1 : 0;
    const top = rowLimit - 1 - before - after;
    skipAt = top;
    for (let i = 0; i < top; i++) put(i, false);
    skipped = player - before - top;
    for (let i = player - before; i <= player + after; i++) put(i, i === player);
  }
  board.end(now);

  if (skipAt >= 0) {
    text(skipLabel, `+${skipped}`);
    const offset = skipAt * step;
    skipEl.style.transform = horizontal ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`;
    if (skipEl.classList.contains('out')) skipEl.classList.add('snap');
  } else {
    skipEl.classList.add('out');
  }
  const extent = count * step + (skipAt >= 0 ? geo.skip : 0);
  if (extent !== lastExtent) {
    lastExtent = extent;
    const s = board.container.style;
    s.width = horizontal ? `${extent}px` : '';
    s.height = horizontal ? '' : `${extent}px`;
  }
  shift(boardEl, geo.head + extent + padX);

  text(boardPos, player >= 0 ? String(displayPos(order[player], player)) : '—');
  text(boardTotal, `/ ${n}`);
  let gap = '';
  let label = '';
  if (player >= 0 && n > 1) {
    const other = player > 0 ? player - 1 : 1;
    gap = signed((Number(order[player].score) || 0) - (Number(order[other].score) || 0));
    label = player > 0 ? `to #${displayPos(order[other], other)}` : 'lead';
  }
  text(boardGap.firstElementChild, gap);
  text(boardGap.lastElementChild, label);
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

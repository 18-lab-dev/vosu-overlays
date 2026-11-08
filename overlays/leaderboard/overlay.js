// Copyright (c) 2026 18-LAB. MIT.
// Live in-game leaderboard. Rows sit absolutely positioned and move between slots with a
// transform transition, so an overtake slides rows past each other without any layout work.
import { subscribe, settings, fit } from './vosu-overlay.js';

const STAGE_W = 420;
const STAGE_H = 720;
const PLAY = 2;
const RESULTS = 7;
const MAX_ROWS = 16;
const PRUNE_MS = 800;
const DELTA_MS = 2400;
const GEOMETRY = { normal: { row: 40, skip: 16 }, compact: { row: 26, skip: 12 } };
const P = { state: '/state/number', board: '/leaderboard', name: '/play/playerName', score: '/play/score' };
const DEFAULTS = { rows: 8, showAcc: true, showCombo: true, showMods: true, compact: false, showGap: true, showBrand: true };

const $ = id => document.getElementById(id);
const stage = $('stage');
const boardEl = $('board');
const rowsEl = $('rows');
const skipEl = $('skip');
const skipLabel = skipEl.firstElementChild;
const chip = $('chip');
const chipText = $('chip-text');
const titleEl = $('title');
const rankPos = $('rank-pos');
const rankTotal = $('rank-total');
const hgap = $('hgap');
const rowTemplate = $('row-template').content.firstElementChild;

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MINUS = '\u2212';
const FLASH_KEYS = [{ opacity: 1 }, { opacity: 0 }];
const FLASH_OPTS = { duration: 720, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

let geo = GEOMETRY.normal;
let rowLimit = DEFAULTS.rows;

let status = 'connecting';
let wasOffline = false;
let state;
let list;
let me;
let myScore;
// Results may arrive after vosu has cleared the gameplay leaderboard: keep the last standings.
let heldList = null;
let heldName;
let heldScore;

let shown = false;
let frame = 0;
let serial = 0;
let lastHeight = -1;
let lastPos = 0;
let lastScore = 0;
let deltaTimer = 0;
let meRow = null;

const pool = new Map();
const order = [];
const visible = [];
const ids = new Map();
const used = new Set();
const entering = [];

fit(stage, STAGE_W, STAGE_H);

settings(DEFAULTS, next => {
  rowLimit = Math.max(1, Math.min(MAX_ROWS, Math.round(next.rows) || DEFAULTS.rows));
  geo = next.compact ? GEOMETRY.compact : GEOMETRY.normal;
  const c = boardEl.classList;
  c.toggle('compact', next.compact);
  c.toggle('no-acc', !next.showAcc);
  c.toggle('no-combo', !next.showCombo);
  c.toggle('no-mods', !next.showMods);
  c.toggle('no-gap', !next.showGap);
  c.toggle('no-brand', !next.showBrand);
  schedule();
});

subscribe([P.state, P.board, P.name, P.score], values => {
  state = values[P.state];
  list = values[P.board];
  me = values[P.name];
  myScore = values[P.score];
  schedule();
}, {
  onStatus: next => {
    if (next === status) return;
    status = next;
    schedule();
  },
});

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

const rankOf = e => (Number.isInteger(e.position) && e.position > 0 ? e.position : Infinity);
const compare = (a, b) => rankOf(a) - rankOf(b) || (Number(b.score) || 0) - (Number(a.score) || 0);
const displayPos = (e, index) => (Number.isInteger(e.position) && e.position > 0 ? e.position : index + 1);

function text(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

function setText(row, key, el, value) {
  if (row.t[key] === value) return;
  row.t[key] = value;
  el.textContent = value;
}

/** Writes only what changed; numbers are formatted only when their raw value changes. */
function fill(row, e, index, isMe) {
  const pos = displayPos(e, index);
  if (row.v.pos !== pos) { row.v.pos = pos; row.pos.textContent = String(pos); }
  setText(row, 'name', row.name, typeof e.name === 'string' && e.name ? e.name : '—');
  const score = Number(e.score);
  if (row.v.score !== score) { row.v.score = score; row.score.textContent = Number.isFinite(score) ? INT.format(Math.round(score)) : '—'; }
  const acc = Number(e.accuracy);
  if (row.v.acc !== acc) { row.v.acc = acc; row.acc.textContent = Number.isFinite(acc) ? `${acc.toFixed(2)}%` : '—'; }
  const combo = Number(e.combo?.max);
  if (row.v.combo !== combo) { row.v.combo = combo; row.combo.textContent = Number.isFinite(combo) ? `${INT.format(combo)}x` : '—'; }
  setText(row, 'mods', row.mods, modsText(e.mods));
  if (row.isMe !== isMe) { row.isMe = isMe; row.el.classList.toggle('me', isMe); }
  const failed = e.isFailed === true;
  if (row.failed !== failed) { row.failed = failed; row.el.classList.toggle('failed', failed); }
}

function modsText(mods) {
  if (!mods || typeof mods !== 'object') return '';
  const array = mods.array;
  if (Array.isArray(array)) {
    let out = '';
    for (const mod of array) {
      const acronym = mod?.acronym;
      if (typeof acronym === 'string' && acronym) out += out ? ` ${acronym}` : acronym;
    }
    return out;
  }
  return typeof mods.name === 'string' && mods.name !== 'NM' ? mods.name : '';
}

function create(key) {
  const el = rowTemplate.cloneNode(true);
  const [flash, pos, who, score, meta, gapv] = el.children;
  const row = {
    key, el, flash, pos, score,
    name: who.firstElementChild, delta: who.lastElementChild,
    mods: meta.children[1], acc: meta.children[2], combo: meta.children[3],
    gapValue: gapv.firstElementChild, gapLabel: gapv.lastElementChild,
    t: {}, v: {}, isMe: false, failed: false, on: false, y: NaN, serial: 0, hiddenAt: 0,
  };
  rowsEl.append(el);
  pool.set(key, row);
  return row;
}

function place(row, y) {
  if (!row.on) {
    // Enter at the target slot without sliding from a stale one, then fade in next frame.
    row.on = true;
    row.el.classList.add('snap', 'out');
    entering.push(row);
  } else if (row.y === y) {
    return;
  }
  row.y = y;
  row.el.style.transform = `translate3d(0,${y}px,0)`;
}

/** The player's entry: exact name first, case-insensitive second; closest live score breaks ties. */
function findPlayer(name, score) {
  if (typeof name !== 'string' || !name) return -1;
  let best = findName(name, score, false);
  if (best < 0) best = findName(name, score, true);
  return best;
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

function gapText(player) {
  if (player < 0 || order.length < 2) return null;
  const mine = Number(order[player].score) || 0;
  const other = player > 0 ? order[player - 1] : order[1];
  const diff = mine - (Number(other.score) || 0);
  const value = `${diff < 0 ? MINUS : '+'}${INT.format(Math.abs(Math.round(diff)))}`;
  const label = player > 0 ? `to #${displayPos(other, player - 1)}` : 'lead';
  return [value, label];
}

function render(now) {
  frame = 0;
  for (const row of entering) row.el.classList.remove('snap', 'out');
  entering.length = 0;
  if (skipEl.classList.contains('snap')) skipEl.classList.remove('snap', 'out');

  const live = status === 'live';
  if (status === 'offline') wasOffline = true;
  else if (live) wasOffline = false;
  chip.hidden = live;
  chip.classList.toggle('offline', wasOffline);
  if (!live) text(chipText, wasOffline ? 'vosu offline' : 'Connecting to vosu');

  let source = null;
  let name = me;
  let score = myScore;
  if (live) {
    const hasList = Array.isArray(list) && list.length > 0;
    if (state === PLAY) {
      source = list;
      if (hasList) { heldList = list; heldName = me; heldScore = myScore; }
    } else if (state === RESULTS) {
      if (hasList) source = list;
      else if (heldList) { source = heldList; name = heldName; score = heldScore; }
    } else {
      heldList = null;
      lastPos = 0;
      lastScore = 0;
    }
  }

  const want = live && Array.isArray(source) && source.length > 0;
  if (want !== shown) {
    shown = want;
    boardEl.classList.toggle('on', want);
    // Rows left over from a previous attempt must not flash in with the panel.
    if (want) for (const row of pool.values()) { row.el.remove(); pool.delete(row.key); }
  }
  if (!want) return;

  const final = state === RESULTS;
  boardEl.classList.toggle('final', final);
  text(titleEl, final ? 'Final' : 'Leaderboard');

  order.length = 0;
  for (const e of source) if (e && typeof e === 'object') order.push(e);
  order.sort(compare);
  const n = order.length;
  const player = findPlayer(name, score);

  // Window: the top rows, and when the player is below them, a skip marker then the row the
  // player is chasing and the player's own row. The limit counts rows, not the marker.
  visible.length = 0;
  let skipAt = -1;
  let skipped = 0;
  if (n <= rowLimit || player < rowLimit) {
    for (let i = 0; i < Math.min(n, rowLimit); i++) visible.push(i);
  } else {
    const top = Math.max(0, rowLimit - 2);
    for (let i = 0; i < top; i++) visible.push(i);
    skipAt = top;
    if (rowLimit >= 2) visible.push(player - 1);
    visible.push(player);
    skipped = visible[top] - top;
  }

  ids.clear();
  used.clear();
  for (const e of order) if (Number.isInteger(e.id) && e.id > 0) ids.set(e.id, (ids.get(e.id) || 0) + 1);

  serial++;
  meRow = null;
  for (let slot = 0; slot < visible.length; slot++) {
    const index = visible[slot];
    const e = order[index];
    const key = keyOf(e, index, player);
    const row = pool.get(key) || create(key);
    row.serial = serial;
    fill(row, e, index, index === player);
    if (index === player) meRow = row;
    place(row, slot * geo.row + (skipAt >= 0 && slot >= skipAt ? geo.skip : 0));
  }
  for (const row of pool.values()) {
    if (row.serial === serial) continue;
    if (row.on) {
      row.on = false;
      row.hiddenAt = now;
      row.el.classList.add('out');
    } else if (now - row.hiddenAt > PRUNE_MS) {
      row.el.remove();
      pool.delete(row.key);
    }
  }

  if (skipAt >= 0) {
    text(skipLabel, `+${skipped}`);
    skipEl.style.transform = `translate3d(0,${skipAt * geo.row}px,0)`;
    if (skipEl.classList.contains('out')) skipEl.classList.add('snap');
  } else {
    skipEl.classList.add('out');
  }

  const height = visible.length * geo.row + (skipAt >= 0 ? geo.skip : 0);
  if (height !== lastHeight) { lastHeight = height; rowsEl.style.height = `${height}px`; }

  text(rankPos, player >= 0 ? String(displayPos(order[player], player)) : '—');
  text(rankTotal, `/ ${n}`);

  const gap = gapText(player);
  text(hgap.firstElementChild, gap ? gap[0] : '');
  text(hgap.lastElementChild, gap ? gap[1] : '');
  if (meRow) {
    setText(meRow, 'gapValue', meRow.gapValue, gap ? gap[0] : '');
    setText(meRow, 'gapLabel', meRow.gapLabel, gap ? gap[1] : '');
  }

  if (player >= 0) signalMove(displayPos(order[player], player), Number(order[player].score) || 0);
  if (entering.length || skipEl.classList.contains('snap')) schedule();
}

/** One-shot cue when the player's position changes; a retry (score drops) resets it silently. */
function signalMove(pos, score) {
  const restarted = score < lastScore;
  lastScore = score;
  if (restarted || !lastPos || pos === lastPos || !meRow) { lastPos = pos; return; }
  const up = pos < lastPos;
  const delta = meRow.delta;
  delta.textContent = `${up ? '▲' : '▼'}${Math.abs(lastPos - pos)}`;
  delta.classList.toggle('down', !up);
  delta.classList.add('on');
  if (up) meRow.flash.animate(FLASH_KEYS, FLASH_OPTS);
  clearTimeout(deltaTimer);
  deltaTimer = setTimeout(() => delta.classList.remove('on'), DELTA_MS);
  lastPos = pos;
}

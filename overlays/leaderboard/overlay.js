// Copyright (c) 2026 18-LAB. MIT.
// Live leaderboard standing for the in-game scoreboard. Two styles share one renderer:
//  - rival: a three-rung ladder (player above, you, player below) with score gaps, placed in a
//    free region beside the playfield — what osu!'s own scoreboard does not tell you;
//  - board: a full replacement placed where osu!stable draws its scoreboard, for users who hide it.
// Rows sit absolutely positioned and move between slots on a transform transition, so an
// overtake slides the passed player past you without layout work.
import { subscribe, settings, fit, activeMode, osuLayout, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const PLAY = 2;
const RESULTS = 7;
const MARGIN = 32;
const MAX_ROWS = 16;
const PRUNE_MS = 800;
const DELTA_MS = 2400;
// Footprints in CSS px at scale 1; style.css carries the same numbers.
const RIVAL = { width: 272, row: 28, me: 52 };
const BOARD = { width: 280, head: 32, row: 48, skip: 16 };
const COMPACT = { width: 336, head: 32, row: 34, skip: 12 };
const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum', board: '/leaderboard', name: '/play/playerName', score: '/play/score',
  client: '/client', skin: '/settings/skin/name', keys: '/beatmap/stats/cs/converted',
};
const DEFAULTS = {
  style: 'rival', zone: 'auto', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map',
  rows: 8, showAcc: true, showCombo: true, showMods: true, compact: false, showGap: true, showBrand: true,
};

const $ = id => document.getElementById(id);
const stage = $('stage');
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

/** Keyed rows placed by slot; entering rows snap to their slot, then fade in on the next frame. */
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

  put(key, y, e, index, extra) {
    let row = this.pool.get(key);
    if (!row) {
      const el = this.template.cloneNode(true);
      row = { key, el, t: {}, v: {}, on: false, y: NaN, serial: 0, hiddenAt: 0, isMe: false, failed: false };
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
    } else if (row.y === y) {
      return row;
    }
    row.y = y;
    row.el.style.transform = `translate3d(0,${y}px,0)`;
    return row;
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

/** Board row: position, name, score; accuracy, max combo and mods underneath. */
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
let style = 'rival';
let mode = null;
let placedFor = '';
let rowLimit = DEFAULTS.rows;
let geo = BOARD;

let status = 'connecting';
let wasOffline = false;
let values = {};
let checksum;
let palette = null;
let skinFor = '';
let maniaStage = null;
// Results may arrive after vosu has cleared the gameplay scoreboard: keep the last standings.
let heldList = null;
let heldName;
let heldScore;

let shown = '';
let frame = 0;
let lastHeight = -1;
let lastPos = 0;
let lastScore = 0;
let deltaTimer = 0;

const order = [];
const ids = new Map();
const used = new Set();

fit(stage, W, H);

settings(DEFAULTS, next => {
  cfg = next;
  style = next.style === 'board' ? 'board' : 'rival';
  geo = next.compact ? COMPACT : BOARD;
  const c = root.classList;
  c.toggle('compact', next.compact);
  c.toggle('no-acc', !next.showAcc);
  c.toggle('no-combo', !next.showCombo);
  c.toggle('no-mods', !next.showMods);
  c.toggle('no-gap', !next.showGap);
  c.toggle('no-brand', !next.showBrand);
  c.toggle('lab', next.accent === '18-lab');
  for (const backing of ['scrim', 'panel']) c.toggle(`backing-${backing}`, next.backing === backing);
  placedFor = '';
  board.clear();
  rivals.clear();
  lastHeight = -1;
  shown = '';
  schedule();
});

subscribe(Object.values(P), next => {
  values = next;
  if (next[P.checksum] !== checksum) {
    checksum = next[P.checksum];
    loadPalette(checksum);
  }
  const skin = `${next[P.keys]}|${next[P.skin]}`;
  if (skin !== skinFor) {
    skinFor = skin;
    loadManiaStage(skin, next[P.keys], next[P.skin]);
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
  palette = result;
  applyPalette(root, palette);
}

/** The skin's mania stage (stable skin.ini via vosu), so mania placement keeps clear of it. */
async function loadManiaStage(key, keys, skin) {
  const result = Number.isInteger(keys) && keys > 0 ? await maniaSkin(keys, typeof skin === 'string' ? skin : '') : null;
  if (key !== skinFor) return;
  maniaStage = result;
  placedFor = '';
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

/**
 * Places the cluster in osu!'s free space for the ruleset. Rival defaults to the right (beside the
 * playfield, under score/accuracy, clear of the key counter); board defaults to the left, where
 * osu!stable draws its own scoreboard. Taiko uses the open area under the lane; mania keeps clear
 * of the skin's stage. On results the final standing goes to the free right part of osu!'s
 * header strip.
 */
function place(final) {
  const keys = values[P.keys];
  const client = values[P.client] === 'lazer' ? 'lazer' : 'stable';
  const key = `${mode}|${style}|${final}|${cfg.zone}|${cfg.offsetX}|${cfg.offsetY}|${cfg.scale}|${cfg.compact}|${keys}|${client}|${maniaStage !== null}`;
  if (key === placedFor) return;
  placedFor = key;
  root.classList.toggle('final', final);
  const layout = osuLayout(mode || 'osu', mode === 'mania' && Number.isInteger(keys) && keys > 0
    ? { keys, client, ...(client === 'stable' && maniaStage ? maniaStage : {}) }
    : {});
  const side = final ? 'right' : cfg.zone === 'left' || cfg.zone === 'right' ? cfg.zone : style === 'board' ? 'left' : 'right';
  const scale = Math.max(0.5, Math.min(2, Number(cfg.scale) || 1));
  const width = (style === 'rival' || final ? RIVAL : geo).width * scale;
  const laneBottom = layout.busy.y + layout.busy.h;
  let y;
  if (final) y = 12;
  else if (mode === 'taiko') y = laneBottom + 40;
  else if (side === 'left') y = style === 'board' ? Math.round(H * 0.28) : layout.hud.health.y + layout.hud.health.h + 96;
  else if (mode === 'mania') y = Math.round(H * 0.3);
  else y = layout.hud.accuracy.y + layout.hud.accuracy.h + 48;
  y += Number(cfg.offsetY) || 0;
  const dx = Number(cfg.offsetX) || 0;
  const s = root.style;
  s.top = `${y}px`;
  s.transform = scale === 1 ? '' : `scale(${scale})`;
  root.classList.toggle('right', side === 'right');
  if (side === 'left') {
    // Mania: end at least 24 px before the stage when the skin leaves room.
    const x = mode === 'mania' && !final ? Math.max(8, Math.min(MARGIN, layout.busy.x - 24 - width)) : MARGIN;
    s.left = `${x + dx}px`;
    s.right = 'auto';
    s.transformOrigin = '0 0';
  } else {
    // osu!'s key counter sits on the right edge; end just left of its column so even the panel
    // backing stays clear of the playfield. Mania: start at least 24 px after the stage.
    let edge = final ? W - 24 : mode === 'osu' ? layout.hud.keys.x - 8 : W - MARGIN;
    if (mode === 'mania' && !final) edge = Math.min(W - 8, Math.max(edge, layout.busy.x + layout.busy.w + 24 + width));
    s.left = 'auto';
    s.right = `${W - edge - dx}px`;
    s.transformOrigin = '100% 0';
  }
  // The board never runs off the bottom of the screen: fewer rows when there is less room.
  const room = (H - MARGIN - y) / scale - geo.head - geo.skip;
  rowLimit = Math.max(1, Math.min(MAX_ROWS, Math.round(cfg.rows) || DEFAULTS.rows, Math.floor(room / geo.row)));
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

function render(now) {
  frame = 0;
  rivals.begin();
  board.begin();
  if (skipEl.classList.contains('snap')) skipEl.classList.remove('snap', 'out');

  const live = status === 'live';
  if (status === 'offline') wasOffline = true;
  else if (live) wasOffline = false;
  const state = values[P.state];
  const final = live && state === RESULTS;
  mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  place(final);

  const list = values[P.board];
  let source = null;
  let name = values[P.name];
  let score = values[P.score];
  if (live) {
    const hasList = Array.isArray(list) && list.length > 0;
    if (state === PLAY) {
      source = list;
      if (hasList) { heldList = list; heldName = name; heldScore = score; }
    } else if (state === RESULTS) {
      if (hasList) source = list;
      else if (heldList) { source = heldList; name = heldName; score = heldScore; }
    } else {
      heldList = null;
      lastPos = 0;
      lastScore = 0;
    }
  }

  order.length = 0;
  if (Array.isArray(source)) for (const e of source) if (e && typeof e === 'object') order.push(e);
  order.sort(compare);
  const player = findPlayer(name, score);
  // The ladder needs you on the board; the replacement board stands on its own. Results show
  // only your final standing (osu!'s results screen has no leaderboard), in its header strip.
  const ladder = style === 'rival' || final;
  const want = !order.length ? '' : ladder ? (player >= 0 ? 'rival' : '') : 'board';

  chip.hidden = live;
  chip.classList.toggle('offline', wasOffline);
  if (!live) text(chipText, wasOffline ? 'vosu offline' : 'Connecting to vosu');

  if (want !== shown) {
    // Rows left over from a previous attempt must not flash in with the cluster.
    if (want === 'rival') rivals.clear();
    if (want === 'board') { board.clear(); lastHeight = -1; }
    shown = want;
    rivalEl.classList.toggle('on', want === 'rival');
    boardEl.classList.toggle('on', want === 'board');
  }
  if (!want) return;

  ids.clear();
  used.clear();
  for (const e of order) if (Number.isInteger(e.id) && e.id > 0) ids.set(e.id, (ids.get(e.id) || 0) + 1);

  if (want === 'rival') renderRival(player, final, now);
  else renderBoard(player, now);

  if (player >= 0) signalMove(displayPos(order[player], player), Number(order[player].score) || 0, want);
  if (rivals.entering.length || board.entering.length || skipEl.classList.contains('snap')) schedule();
}

function renderRival(player, final, now) {
  text(rivalPos, String(displayPos(order[player], player)));
  text(rivalTotal, final ? `/ ${order.length} · final` : `/ ${order.length}`);
  const mine = Number(order[player].score) || 0;
  if (player > 0) rivals.put(keyOf(order[player - 1], player - 1, player), 0, order[player - 1], player - 1, mine);
  if (player + 1 < order.length) rivals.put(keyOf(order[player + 1], player + 1, player), RIVAL.row + RIVAL.me, order[player + 1], player + 1, mine);
  rivals.end(now);
}

function renderBoard(player, now) {
  const n = order.length;
  // Window: the top rows, and when you are below them, a skip marker, then the row you are
  // chasing, your own row and the row behind you, so a pass slides that player under you.
  // The limit counts rows, not the marker.
  let skipAt = -1;
  let skipped = 0;
  let count = 0;
  const y = slot => slot * geo.row + (skipAt >= 0 && slot >= skipAt ? geo.skip : 0);
  if (n <= rowLimit || player < rowLimit) {
    for (let i = 0; i < Math.min(n, rowLimit); i++) board.put(keyOf(order[i], i, player), y(count++), order[i], i, i === player);
  } else {
    const before = rowLimit >= 2 ? 1 : 0;
    const after = rowLimit >= 3 && player + 1 < n ? 1 : 0;
    const top = rowLimit - 1 - before - after;
    skipAt = top;
    for (let i = 0; i < top; i++) board.put(keyOf(order[i], i, player), y(count++), order[i], i, false);
    skipped = player - before - top;
    for (let i = player - before; i <= player + after; i++) board.put(keyOf(order[i], i, player), y(count++), order[i], i, i === player);
  }
  board.end(now);

  if (skipAt >= 0) {
    text(skipLabel, `+${skipped}`);
    skipEl.style.transform = `translate3d(0,${skipAt * geo.row}px,0)`;
    if (skipEl.classList.contains('out')) skipEl.classList.add('snap');
  } else {
    skipEl.classList.add('out');
  }
  const height = count * geo.row + (skipAt >= 0 ? geo.skip : 0);
  if (height !== lastHeight) { lastHeight = height; board.container.style.height = `${height}px`; }

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

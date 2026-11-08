// Copyright (c) 2026 18-LAB. MIT.
// Session tracker: plays, play time, pass / fail / retry outcomes, best pp, average pass
// accuracy, grade tally and profile pp / rank movement, counted in the page from state
// transitions (vosu's /session/playCount is always 0 and /session/playTime is osu!'s game
// clock, so neither measures a streaming session).
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const PLAY = 2;
const RESULTS = 7;
const SONG_SELECT = new Set([5, 13]); // solo and multiplayer song select
const MAX_ATTEMPTS = 2000;
const SCHEMA = 1;

const $ = id => document.getElementById(id);
const stage = $('stage');
fit(stage, W, H);

const POINTERS = [
  '/state/number', '/play/source', '/play/failed', '/play/score', '/play/hits/0',
  '/play/accuracy', '/play/rank/current', '/play/pp/current',
  '/resultsScreen/score', '/resultsScreen/accuracy', '/resultsScreen/rank', '/resultsScreen/pp/current',
  '/beatmap/title', '/beatmap/version', '/beatmap/checksum', '/beatmap/stats/cs/converted',
  '/play/mode/number', '/settings/mode/number', '/client',
  '/profile/id', '/profile/mode/number', '/profile/pp', '/profile/globalRank',
];

const DEFAULTS = {
  inSelect: 'ledger', inPlay: 'minimal', inResults: 'line', side: 'right', scale: 1,
  playX: 0, playY: 0, selectX: 0, selectY: 0, resultX: 0, resultY: 0,
  backing: 'none', accent: 'map',
  rowPlays: true, rowTape: true, rowBest: true, rowAccuracy: true, rowGrades: true, rowProfile: true,
  showBrand: true, persist: 'reload', resetHour: 6, resetEpoch: 0,
};

// ----------------------------------------------------------------------------- session store
const STORE_KEY = `18lab:session-tracker:${window.COUNTER_PATH || 'page'}`;
let cfg = { ...DEFAULTS };

const pad2 = n => String(n).padStart(2, '0');
/** Session day: the local date, rolling over at `resetHour` instead of midnight. */
function dayKey() {
  const hour = Math.trunc(cfg.resetHour);
  if (!(hour >= 0 && hour <= 23)) return 'any';
  const d = new Date(Date.now() - hour * 3600000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function freshSession(epoch) {
  return { v: SCHEMA, day: dayKey(), epoch, start: Date.now(), playMs: 0, attempts: [], base: {} };
}

function storageFor(mode) {
  try {
    if (mode === 'day') return localStorage;
    if (mode === 'reload') return sessionStorage;
  } catch { /* storage disabled */ }
  return null;
}

function load() {
  try {
    const stored = JSON.parse(storageFor(cfg.persist)?.getItem(STORE_KEY) || 'null');
    if (stored?.v === SCHEMA && stored.day === dayKey() && Array.isArray(stored.attempts)
      && Number.isFinite(stored.start) && Number.isFinite(stored.playMs) && stored.base && typeof stored.base === 'object') return stored;
  } catch { /* corrupt or unavailable: start fresh */ }
  return null;
}

function save() {
  if (!adopted) return;
  try { storageFor(cfg.persist)?.setItem(STORE_KEY, JSON.stringify(session)); } catch { /* quota or disabled */ }
}

function forget(mode) {
  try { storageFor(mode)?.removeItem(STORE_KEY); } catch { /* unavailable */ }
}

let session = freshSession(null);
// Stored sessions are adopted once the real settings (persistence mode, reset hour) are known;
// until then attempts collect in a temporary session that is merged in.
let adopted = false;
let authoritative = !window.COUNTER_PATH;

function adopt() {
  if (adopted) return;
  adopted = true;
  const stored = load();
  if (stored) {
    stored.attempts.push(...session.attempts);
    stored.playMs += session.playMs;
    for (const [key, value] of Object.entries(session.base)) stored.base[key] ??= value;
    session = stored;
  }
  checkEpoch();
  recompute();
  save();
}

/** A changed reset number (a vosu setting) starts a new session; null = not yet known. */
function checkEpoch() {
  if (!adopted || !authoritative) return;
  if (session.epoch === null) { session.epoch = cfg.resetEpoch; save(); }
  else if (session.epoch !== cfg.resetEpoch) resetSession();
}

function resetSession() {
  session = freshSession(authoritative ? cfg.resetEpoch : null);
  // The profile as it stands now is the new baseline.
  if (model.profileKey) session.base[model.profileKey] = { pp: model.pp, rank: model.rank };
  if (active) active.start = Date.now();
  pending = null;
  recompute();
  save();
}

function checkDay() {
  if (adopted && session.day !== dayKey()) resetSession();
}

// ----------------------------------------------------------------------------- attempt tracking
let active = null;   // the attempt on screen: { start, score, miss, failed, judged, acc, rank, pp, map }
let pending = null;  // last pass record, refined from /resultsScreen while results show
let gameState;
let socketState = 'connecting';

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function grade(rank) {
  switch (rank) {
    case 'X': case 'XH': case 'SS': case 'SSH': return 'SS';
    case 'S': case 'SH': return 'S';
    case 'A': case 'B': case 'C': case 'D': return rank;
    default: return null;
  }
}

function startAttempt(v, now) {
  const title = v['/beatmap/title'];
  const version = v['/beatmap/version'];
  active = {
    start: now, score: num(v['/play/score']), miss: num(v['/play/hits/0']), failed: v['/play/failed'] === true,
    judged: false, acc: null, rank: null, pp: null,
    map: typeof title === 'string' && title ? (version ? `${title} [${version}]` : title) : '',
  };
  active.judged = active.score > 0 || active.miss > 0;
  model.newBest = false;
  dirty();
}

function track(v) {
  const a = active;
  a.score = num(v['/play/score']);
  a.miss = num(v['/play/hits/0']);
  if (a.score > 0 || a.miss > 0) a.judged = true;
  if (v['/play/failed'] === true) a.failed = true;
  const acc = v['/play/accuracy'];
  const rank = v['/play/rank/current'];
  const pp = v['/play/pp/current'];
  if (typeof acc === 'number' && acc > 0) a.acc = acc;
  if (typeof rank === 'string' && rank) a.rank = rank;
  if (typeof pp === 'number' && pp >= 0) a.pp = pp;
}

function endAttempt(outcome, v, now) {
  const a = active;
  active = null;
  session.playMs += Math.max(0, now - a.start);
  if (outcome !== 'p' && !a.judged) { save(); dirty(); return; } // restarted before the first object
  const record = { o: outcome };
  if (outcome === 'p') {
    record.acc = a.acc;
    record.rank = grade(a.rank);
    record.pp = a.pp;
    record.map = a.map;
    record.score = a.score;
    pending = record;
  }
  session.attempts.push(record);
  if (session.attempts.length > MAX_ATTEMPTS) session.attempts.splice(0, session.attempts.length - MAX_ATTEMPTS);
  recompute();
  if (outcome === 'p') { markBest(record); refine(v); }
  save();
}

/** Results-screen values are the authoritative final ones; ignore a stale screen from an older score. */
function refine(v) {
  const rank = grade(v['/resultsScreen/rank']);
  const acc = v['/resultsScreen/accuracy'];
  const pp = v['/resultsScreen/pp/current'];
  const score = v['/resultsScreen/score'];
  if (!rank || typeof acc !== 'number' || acc <= 0) return;
  if (typeof score === 'number' && pending.score > 0 && Math.abs(score - pending.score) > pending.score * 0.02) return;
  const nextPp = typeof pp === 'number' && pp >= 0 ? pp : pending.pp;
  if (pending.rank === rank && pending.acc === acc && pending.pp === nextPp) return;
  pending.rank = rank;
  pending.acc = acc;
  pending.pp = nextPp;
  recompute();
  markBest(pending);
  save();
}

/** "New" marks a pass that beat an earlier pass's pp this session (not merely the first pass). */
function markBest(record) {
  model.newBest = model.best === record && session.attempts.some(other => other !== record && other.o === 'p' && other.pp > 0);
  dirty();
}

function onFrame(v) {
  const now = Date.now();
  const state = v['/state/number'];
  const source = v['/play/source'];
  const playing = state === PLAY && (source == null || source === 'player');
  if (active && !playing) endAttempt(state === RESULTS ? 'p' : active.failed ? 'f' : 'r', v, now);
  if (active && playing) {
    const score = num(v['/play/score']);
    const miss = num(v['/play/hits/0']);
    // Quick retry keeps state 2: the score (and misses) fall back to zero.
    if ((active.score > 0 && score < active.score * 0.5) || miss < active.miss) {
      endAttempt(active.failed ? 'f' : 'r', v, now);
      startAttempt(v, now);
    } else track(v);
  }
  if (!active && playing) { startAttempt(v, now); track(v); }
  if (pending) { if (state === RESULTS) refine(v); else pending = null; }
  profile(v);
  if (state !== gameState) { gameState = state; dirty(); }
  const mode = activeMode(state, v['/play/mode/number'], v['/settings/mode/number']);
  const keys = Math.round(num(v['/beatmap/stats/cs/converted'])) || 4;
  const client = v['/client'] === 'lazer' ? 'lazer' : 'stable';
  if (mode !== view.mode || client !== view.client || (mode === 'mania' && keys !== view.keys)) {
    view.mode = mode;
    view.keys = keys;
    view.client = client;
    placeDirty = true;
    dirty();
  }
  const checksum = v['/beatmap/checksum'];
  if (checksum !== view.checksum) { view.checksum = checksum; tint(); }
}

function profile(v) {
  const pp = v['/profile/pp'];
  const rank = v['/profile/globalRank'];
  const valid = typeof pp === 'number' && pp > 0;
  const key = `${num(v['/profile/id'])}:${num(v['/profile/mode/number'])}`;
  if (valid && !session.base[key]) {
    session.base[key] = { pp, rank: typeof rank === 'number' && rank > 0 ? rank : null };
    save();
  } else if (valid && session.base[key].rank === null && typeof rank === 'number' && rank > 0) {
    session.base[key].rank = rank;
    save();
  }
  const next = valid ? key : null;
  if (next !== model.profileKey || pp !== model.pp || rank !== model.rank) {
    model.profileKey = next;
    model.pp = valid ? pp : null;
    model.rank = typeof rank === 'number' && rank > 0 ? rank : null;
    dirty();
  }
}

// ----------------------------------------------------------------------------- aggregates
const model = {
  plays: 0, pass: 0, fail: 0, retry: 0, best: null, newBest: false, accSum: 0, accN: 0,
  grades: { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0 }, profileKey: null, pp: null, rank: null,
};
let tapeDirty = true;

function recompute() {
  const m = model;
  m.pass = m.fail = m.retry = 0;
  m.best = null;
  m.accSum = m.accN = 0;
  for (const key in m.grades) m.grades[key] = 0;
  for (const a of session.attempts) {
    if (a.o === 'p') {
      m.pass++;
      if (typeof a.pp === 'number' && a.pp > 0 && (!m.best || a.pp > m.best.pp)) m.best = a;
      if (typeof a.acc === 'number' && a.acc > 0) { m.accSum += a.acc; m.accN++; }
      if (a.rank && a.rank in m.grades) m.grades[a.rank]++;
    } else if (a.o === 'f') m.fail++;
    else m.retry++;
  }
  m.plays = m.pass + m.fail + m.retry;
  if (!m.best) m.newBest = false;
  tapeDirty = true;
  dirty();
}

// ----------------------------------------------------------------------------- rendering
let frame = 0;
function dirty() { if (!frame) frame = requestAnimationFrame(render); }

const text = (el, value) => { if (el._t !== value) { el._t = value; el.textContent = value; } };
const show = (el, on) => { if (el._s !== on) { el._s = on; el.hidden = !on; } };
const attr = (el, name, value) => {
  const key = `_a${name}`;
  if (el[key] === value) return;
  el[key] = value;
  if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
};
const klass = (el, name, on) => { const key = `_c${name}`; if (el[key] !== on) { el[key] = on; el.classList.toggle(name, on); } };

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pp1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const acc2 = value => value.toFixed(2);

function duration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}

const el = Object.fromEntries([
  'ledger', 'mini', 'result', 'chip', 'chipText', 'clock', 'brand',
  'rowPlays', 'plays', 'ptH', 'ptHu', 'ptM', 'rate', 'rateU',
  'rowTape', 'tape', 'tapeEmpty', 'nPass', 'nFail', 'nRetry',
  'rowBest', 'best', 'bestU', 'bestGrade', 'bestAcc', 'newBest', 'bestMap',
  'rowAccuracy', 'acc', 'accU', 'accSub', 'rowGrades', 'rowProfile', 'ppDelta', 'rankDelta',
  'miniLbl', 'miniNum', 'miniClock', 'miniTape', 'mPass', 'mFail', 'mRetry',
  'rPlays', 'rPass', 'rBestBox', 'rBest', 'rNew', 'rDelta',
].map(id => [id, $(id)]));
const gradeEls = Object.fromEntries(Object.keys(model.grades).map(g => [g, { count: $(`g${g}`), box: $(`g${g}`).parentElement }]));

// ----------------------------------------------------------------------------- placement
// Shared stable 1920×1080 free regions: song select's centre column (x 540–1160, y 190–930,
// between the local leaderboard and the carousel, above the bottom bar) and the right part of
// the results header strip (x 1000–1900, y 8–130). Gameplay uses osuLayout() per ruleset.
const SELECT_CENTRE_X = 850;
const SELECT_CENTRE_Y = 560;
const SELECT_BOTTOM = 930;
const RESULT_RIGHT = 1900;
const RESULT_TOP = 54;
const LEDGER_W = 320;
const MINI_W = 216;
const EDGE = 24;
const view = { mode: null, keys: 4, client: 'stable', checksum: undefined };
let placeDirty = true;

const scaleOf = () => Math.min(1.6, Math.max(0.6, Number(cfg.scale) || 1));

function put(node, { left = null, right = null, top = null, bottom = null }, origin, shift = '') {
  const style = node.style;
  style.left = left === null ? 'auto' : `${left}px`;
  style.right = right === null ? 'auto' : `${right}px`;
  style.top = top === null ? 'auto' : `${top}px`;
  style.bottom = bottom === null ? 'auto' : `${bottom}px`;
  style.transformOrigin = origin;
  style.setProperty('--place', `${shift} scale(${scaleOf()})`);
}

function place() {
  placeDirty = false;
  const s = scaleOf();
  const ledgerLeft = Math.round(SELECT_CENTRE_X - LEDGER_W / 2 + cfg.selectX);
  // Centred in the column whatever rows are enabled (no layout read: the box shifts itself up by half).
  put(el.ledger, { left: ledgerLeft, top: Math.round(SELECT_CENTRE_Y + cfg.selectY) }, '50% 0', 'translateY(-50%)');
  put(el.chip, { left: ledgerLeft, bottom: Math.round(H - SELECT_BOTTOM - cfg.selectY) }, '0 100%');
  put(el.result, { right: Math.round(W - RESULT_RIGHT - cfg.resultX), top: Math.round(RESULT_TOP + cfg.resultY) }, '100% 0');

  // Gameplay: beside the playfield (osu!/catch side bands, mania beside the stage, taiko below the lane).
  const mode = view.mode || 'osu';
  const { busy } = osuLayout(mode, { keys: view.keys, client: view.client });
  const width = MINI_W * s;
  // Clear the stable skip button / lazer key counter in the bottom corners.
  const bottom = (view.client === 'lazer' ? 200 : 140) - cfg.playY;
  const leftRoom = mode === 'taiko' ? W : busy.x;
  const rightRoom = mode === 'taiko' ? W : W - busy.x - busy.w;
  let side = cfg.side === 'left' ? 'left' : 'right';
  if (side === 'left' && leftRoom < width + EDGE * 2 && rightRoom >= width + EDGE * 2) side = 'right';
  if (side === 'right' && rightRoom < width + EDGE * 2 && leftRoom >= width + EDGE * 2) side = 'left';
  if (side === 'right') put(el.mini, { right: EDGE - cfg.playX, bottom }, '100% 100%');
  else put(el.mini, { left: EDGE + cfg.playX, bottom }, '0 100%');
  klass(el.mini, 'end', side === 'right');
  tapes.forEach(t => { t.ratio = 0; });
  resizeTapes();
}

// ----------------------------------------------------------------------------- map tint
let palette = null;
function tint() {
  const checksum = view.checksum;
  if (cfg.accent !== 'map' || !checksum) { palette = null; applyPalette(document.documentElement, null); tapeDirty = true; dirty(); return; }
  mapPalette(checksum).then(result => {
    if (view.checksum !== checksum || cfg.accent !== 'map') return;
    palette = result;
    applyPalette(document.documentElement, result);
    tapeDirty = true;
    dirty();
  });
}

// ----------------------------------------------------------------------------- rendering
function render() {
  frame = 0;
  if (placeDirty) place();
  const m = model;
  const now = Date.now();
  const live = socketState === 'live' && gameState !== undefined;
  const showLedger = live && cfg.inSelect === 'ledger' && SONG_SELECT.has(gameState);
  const showMini = live && cfg.inPlay === 'minimal' && gameState === PLAY;
  const showResult = live && cfg.inResults === 'line' && gameState === RESULTS;
  show(el.ledger, showLedger);
  show(el.mini, showMini);
  show(el.result, showResult);
  show(el.chip, !live);
  if (!live) {
    const state = socketState === 'offline' ? 'offline' : socketState === 'connecting' ? 'connecting' : 'nogame';
    attr(el.chip, 'data-state', state);
    text(el.chipText, state === 'offline' ? 'vosu offline' : state === 'connecting' ? 'Connecting' : 'osu! closed');
  }

  const s = duration(now - session.start);
  const clock = s.h ? `${s.h}h ${pad2(s.m)}m` : `${s.m}m`;
  const p = duration(session.playMs + (active ? now - active.start : 0));
  const best = m.best;
  const base = m.profileKey ? session.base[m.profileKey] : null;
  const ppMove = m.pp !== null && base ? m.pp - base.pp : null;

  if (showLedger) {
    text(el.clock, clock);
    text(el.plays, int.format(m.plays));
    show(el.ptH, p.h > 0);
    show(el.ptHu, p.h > 0);
    text(el.ptH, String(p.h));
    text(el.ptM, p.h ? pad2(p.m) : String(p.m));
    text(el.rate, m.plays ? String(Math.round((m.pass / m.plays) * 100)) : '—');
    show(el.rateU, m.plays > 0);
    text(el.nPass, String(m.pass));
    text(el.nFail, String(m.fail));
    text(el.nRetry, String(m.retry));
    show(el.tapeEmpty, m.plays === 0);
    text(el.best, best ? ppText(best.pp) : '—');
    show(el.bestU, !!best);
    text(el.bestGrade, best?.rank || '');
    attr(el.bestGrade, 'data-g', best?.rank || null);
    text(el.bestAcc, best && typeof best.acc === 'number' ? `${acc2(best.acc)}%` : '');
    klass(el.newBest, 'on', m.newBest && !!best);
    text(el.bestMap, best?.map || '');
    text(el.acc, m.accN ? acc2(m.accSum / m.accN) : '—');
    show(el.accU, m.accN > 0);
    text(el.accSub, m.accN ? `${m.accN} pass${m.accN === 1 ? '' : 'es'}` : '');
    for (const g in m.grades) {
      text(gradeEls[g].count, String(m.grades[g]));
      klass(gradeEls[g].box, 'zero', m.grades[g] === 0);
    }
    delta(el.ppDelta, ppMove, value => `${pp1.format(value)} pp`, 0.05, 'pp');
    delta(el.rankDelta, m.rank !== null && base?.rank ? base.rank - m.rank : null, value => `${int.format(value)} rank`, 0.5, 'rank');
  }
  if (showMini) {
    text(el.miniLbl, active ? 'Attempt' : 'Plays');
    text(el.miniNum, int.format(active ? m.plays + 1 : m.plays));
    text(el.miniClock, clock);
    text(el.mPass, String(m.pass));
    text(el.mFail, String(m.fail));
    text(el.mRetry, String(m.retry));
  }
  if (showResult) {
    text(el.rPlays, int.format(m.plays));
    text(el.rPass, int.format(m.pass));
    show(el.rBestBox, !!best);
    if (best) text(el.rBest, ppText(best.pp));
    klass(el.rNew, 'on', m.newBest && !!best);
    delta(el.rDelta, ppMove, value => `${pp1.format(value)} pp`, 0.05, 'pp');
  }
  const liveBar = !!active;
  for (const t of tapes) if (tapeDirty || t.live !== liveBar) drawTape(t, liveBar);
  tapeDirty = false;
}

const ppText = value => pp1.format(value).replace(/\.0$/, '');

/** ▲ = better. Rank deltas arrive pre-inverted (fewer is better). */
function delta(node, value, format, epsilon, unit) {
  if (value === null) { text(node, `— ${unit}`); attr(node, 'data-dir', null); return; }
  if (Math.abs(value) < epsilon) { text(node, `±0 ${unit}`); attr(node, 'data-dir', 'flat'); return; }
  const up = value > 0;
  text(node, `${up ? '▲' : '▼'} ${format(Math.abs(value))}`);
  attr(node, 'data-dir', up ? 'up' : 'down');
}

// ----------------------------------------------------------------------------- attempt tapes (canvas)
const css = getComputedStyle(document.documentElement);
const ink = name => css.getPropertyValue(name).trim();
const COLORS = {
  SS: ink('--g-ss'), S: ink('--g-s'), A: ink('--g-a'), B: ink('--g-b'), C: ink('--g-c'), D: ink('--g-d'),
  pass: ink('--fg-dim'), miss: ink('--j-miss'), retry: '#a3a6ab', rule: 'rgba(235,232,225,.4)', accent: ink('--accent'),
};
const PITCH = 6;
const BAR = 4;
const tapes = [el.tape, el.miniTape].map(node => ({ node, ctx: node.getContext('2d', { alpha: true }), w: 0, h: 0, ratio: 0, live: false }));

function resizeTapes() {
  for (const t of tapes) {
    const ratio = (window.devicePixelRatio || 1) * scaleOf();
    if (!t.w || t.ratio === ratio) continue;
    t.ratio = ratio;
    t.node.width = Math.round(t.w * ratio);
    t.node.height = Math.round(t.h * ratio);
  }
  tapeDirty = true;
  dirty();
}

const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    const t = tapes.find(item => item.node === entry.target);
    t.w = Math.round(entry.contentRect.width);
    t.h = Math.round(entry.contentRect.height);
    t.ratio = 0;
  }
  resizeTapes();
});
for (const t of tapes) observer.observe(t.node);

function drawTape(t, liveBar) {
  t.live = liveBar;
  const { ctx, w, h, ratio } = t;
  if (!w || !ratio) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // A soft dark under-shadow keeps thin bars legible on bright map backgrounds.
  const shadow = cfg.backing !== 'panel';
  ctx.shadowColor = shadow ? 'rgba(0,0,0,.6)' : 'transparent';
  ctx.shadowBlur = shadow ? 2 * ratio : 0;
  ctx.shadowOffsetY = shadow ? 0.5 * ratio : 0;
  const floor = h - 1;
  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(0, floor, w, 1);
  const tall = floor - 3;
  const failH = Math.round(floor * 0.55);
  const retryH = Math.max(4, Math.round(floor * 0.24));
  // Newest at the right edge (last bar flush with it); the live attempt takes the last slot.
  const attempts = session.attempts;
  const slots = Math.floor((w + PITCH - BAR) / PITCH);
  const offset = w - (slots - 1) * PITCH - BAR;
  let slot = slots - 1;
  if (liveBar) {
    ctx.fillStyle = (cfg.accent === 'map' && palette?.accent) || COLORS.accent;
    ctx.fillRect(slot * PITCH + offset, 0, BAR, floor);
    slot--;
  }
  for (let i = attempts.length - 1; i >= 0 && slot >= 0; i--, slot--) {
    const a = attempts[i];
    const x = slot * PITCH + offset;
    if (a.o === 'p') {
      ctx.fillStyle = COLORS[a.rank] || COLORS.pass;
      ctx.fillRect(x, floor - tall, BAR, tall);
    } else if (a.o === 'f') {
      ctx.fillStyle = COLORS.miss;
      ctx.fillRect(x, floor - failH, BAR, 1);
      ctx.fillRect(x, floor - failH, 1, failH);
      ctx.fillRect(x + BAR - 1, floor - failH, 1, failH);
    } else {
      ctx.fillStyle = COLORS.retry;
      ctx.fillRect(x, floor - retryH, BAR, retryH);
    }
  }
}

// ----------------------------------------------------------------------------- settings
const ROWS = ['rowPlays', 'rowTape', 'rowBest', 'rowAccuracy', 'rowGrades', 'rowProfile'];
let settingsCalls = 0;
settings(DEFAULTS, next => {
  settingsCalls++;
  const prev = cfg;
  cfg = next;
  if (window.COUNTER_PATH && settingsCalls >= 2) authoritative = true;
  if (!adopted && authoritative) adopt();
  else if (adopted && prev.persist !== cfg.persist) { forget(prev.persist); save(); }
  // A new reset hour re-dates the running session; only a real rollover (timer) restarts it.
  if (prev.resetHour !== cfg.resetHour) { session.day = dayKey(); save(); }
  checkEpoch();
  for (const row of ROWS) show(el[row], !!cfg[row]);
  show(el.brand, !!cfg.showBrand);
  stage.dataset.backing = ['scrim', 'panel'].includes(cfg.backing) ? cfg.backing : 'none';
  document.documentElement.dataset.accent = cfg.accent === '18-lab' ? '18-lab' : 'map';
  if (prev.accent !== cfg.accent || settingsCalls === 1) tint();
  placeDirty = true;
  tapeDirty = true;
  dirty();
});
// vosu unreachable at load: keep counting and adopt the stored session with what we know.
setTimeout(adopt, 1500);

// Clocks advance by the minute; a coarse timer refreshes them and rolls the session day.
setInterval(() => { checkDay(); dirty(); }, 5000);

subscribe(POINTERS, onFrame, {
  onStatus: state => { if (state !== socketState) { socketState = state; dirty(); } },
});

// Copyright (c) 2026 18-LAB. MIT.
// Session tracker: plays, play time, pass / fail / retry outcomes, best pp, average pass
// accuracy, grade tally and profile pp / rank movement, counted in the page from state
// transitions (vosu's /session/playCount is always 0 and /session/playTime is osu!'s game
// clock, so neither measures a streaming session).
import { subscribe, settings, fit } from './vosu-overlay.js';

const W = 320;
const H = 440;
const PLAY = 2;
const RESULTS = 7;
const MAX_ATTEMPTS = 2000;
const SCHEMA = 1;

const $ = id => document.getElementById(id);
const panel = $('panel');
fit($('stage'), W, H);

const POINTERS = [
  '/state/number', '/play/source', '/play/failed', '/play/score', '/play/hits/0',
  '/play/accuracy', '/play/rank/current', '/play/pp/current',
  '/resultsScreen/score', '/resultsScreen/accuracy', '/resultsScreen/rank', '/resultsScreen/pp/current',
  '/beatmap/title', '/beatmap/version',
  '/profile/id', '/profile/mode/number', '/profile/pp', '/profile/globalRank',
];

const DEFAULTS = {
  rowPlays: true, rowTape: true, rowBest: true, rowAccuracy: true, rowGrades: true, rowProfile: true,
  hideInPlay: false, showBrand: true, persist: 'reload', resetHour: 6, resetEpoch: 0,
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
  'clock', 'chip', 'chipText', 'brand', 'rowPlays', 'plays', 'ptH', 'ptHu', 'ptM', 'rate', 'rateU',
  'rowTape', 'tape', 'tapeEmpty', 'nPass', 'nFail', 'nRetry', 'rowPasses', 'cellBest', 'cellAcc', 'newBest',
  'best', 'bestU', 'bestSub', 'bestGrade', 'bestAcc', 'bestMap', 'acc', 'accU', 'accSub', 'rowGrades', 'rowProfile',
  'ppNow', 'ppDelta', 'rankNow', 'rankDelta',
].map(id => [id, $(id)]));
const gradeEls = Object.fromEntries(Object.keys(model.grades).map(g => [g, { count: $(`g${g}`), bar: $(`b${g}`), col: $(`g${g}`).parentElement }]));

function render() {
  frame = 0;
  const m = model;
  const now = Date.now();

  // Header: session length and connection / attempt chip.
  const s = duration(now - session.start);
  text(el.clock, s.h ? `${s.h}h ${pad2(s.m)}m` : `${s.m}m`);
  let chip = 'idle';
  let chipText = '';
  if (socketState === 'offline') { chip = 'offline'; chipText = 'vosu offline'; }
  else if (socketState === 'connecting') { chip = 'connecting'; chipText = 'Connecting'; }
  else if (gameState === undefined) { chip = 'nogame'; chipText = 'osu! closed'; }
  else if (active) { chip = 'live'; chipText = 'Live'; }
  attr(el.chip, 'data-state', chip);
  if (chipText) text(el.chipText, chipText);
  klass(panel, 'is-away', cfg.hideInPlay && !!active);

  // Plays.
  text(el.plays, int.format(m.plays));
  const p = duration(session.playMs + (active ? now - active.start : 0));
  show(el.ptH, p.h > 0);
  show(el.ptHu, p.h > 0);
  text(el.ptH, String(p.h));
  text(el.ptM, p.h ? pad2(p.m) : String(p.m));
  text(el.rate, m.plays ? String(Math.round((m.pass / m.plays) * 100)) : '—');
  show(el.rateU, m.plays > 0);

  // Outcomes.
  text(el.nPass, String(m.pass));
  text(el.nFail, String(m.fail));
  text(el.nRetry, String(m.retry));
  show(el.tapeEmpty, m.plays === 0 && !active);
  if (tapeDirty || tapeLive !== !!active) drawTape();

  // Passes.
  const best = m.best;
  text(el.best, best ? pp1.format(best.pp).replace(/\.0$/, '') : '—');
  show(el.bestU, !!best);
  klass(el.newBest, 'on', m.newBest && !!best);
  show(el.bestSub, !!best);
  if (best) {
    text(el.bestGrade, best.rank || '');
    attr(el.bestGrade, 'data-g', best.rank || null);
    text(el.bestAcc, typeof best.acc === 'number' ? `${acc2(best.acc)}%` : '');
  }
  text(el.bestMap, best && cfg.rowBest ? best.map || '' : '');
  text(el.acc, m.accN ? acc2(m.accSum / m.accN) : '—');
  show(el.accU, m.accN > 0);
  text(el.accSub, m.accN ? `${m.accN} pass${m.accN === 1 ? '' : 'es'}` : '');

  // Grades: bars scale against the most common grade.
  let top = 0;
  for (const g in m.grades) top = Math.max(top, m.grades[g]);
  for (const g in m.grades) {
    const n = m.grades[g];
    const ui = gradeEls[g];
    text(ui.count, String(n));
    klass(ui.col, 'zero', n === 0);
    const scale = top ? (n / top).toFixed(3) : '0';
    if (ui.bar._sc !== scale) { ui.bar._sc = scale; ui.bar.style.transform = `scaleY(${scale})`; }
  }

  // Profile movement since the session began, per account and ruleset.
  const base = m.profileKey ? session.base[m.profileKey] : null;
  text(el.ppNow, m.pp === null ? '—' : pp1.format(m.pp));
  text(el.rankNow, m.rank === null ? '—' : `#${int.format(m.rank)}`);
  delta(el.ppDelta, m.pp !== null && base ? m.pp - base.pp : null, value => pp1.format(value), 0.05);
  delta(el.rankDelta, m.rank !== null && base?.rank ? base.rank - m.rank : null, value => int.format(value), 0.5);
}

/** ▲ = better. Rank deltas arrive pre-inverted (fewer is better). */
function delta(node, value, format, epsilon) {
  if (value === null) { text(node, ''); attr(node, 'data-dir', null); return; }
  if (Math.abs(value) < epsilon) { text(node, '±0'); attr(node, 'data-dir', 'flat'); return; }
  const up = value > 0;
  text(node, `${up ? '▲' : '▼'} ${format(Math.abs(value))}`);
  attr(node, 'data-dir', up ? 'up' : 'down');
}

// ----------------------------------------------------------------------------- attempt tape (canvas)
const tape = el.tape;
const ctx = tape.getContext('2d', { alpha: true });
const css = getComputedStyle(document.documentElement);
const ink = name => css.getPropertyValue(name).trim();
const COLORS = {
  SS: ink('--j-max'), S: ink('--j-meh'), A: ink('--j-good'), B: ink('--j-great'), C: ink('--g-c'), D: ink('--j-miss'),
  pass: ink('--fg-dim'), miss: ink('--j-miss'), muted: ink('--muted'), rule: ink('--rule-strong'), accent: ink('--accent'),
};
let tapeW = 0;
let tapeH = 0;
let dpr = 1;
let tapeLive = false;
const PITCH = 6;
const BAR = 4;

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  dpr = window.devicePixelRatio || 1;
  tapeW = Math.round(box.width);
  tapeH = Math.round(box.height);
  tape.width = Math.round(tapeW * dpr);
  tape.height = Math.round(tapeH * dpr);
  tapeDirty = true;
  dirty();
}).observe(tape);

function drawTape() {
  tapeDirty = false;
  tapeLive = !!active;
  if (!tapeW) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, tapeW, tapeH);
  const line = 1;
  const floor = tapeH - 1;
  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(0, floor, tapeW, 1);
  // Newest at the right edge (last bar flush with it); the live attempt takes the last slot.
  const attempts = session.attempts;
  const slots = Math.floor((tapeW + PITCH - BAR) / PITCH);
  const offset = tapeW - (slots - 1) * PITCH - BAR;
  let slot = slots - 1;
  if (tapeLive) {
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(slot * PITCH + offset, 0, BAR, floor);
    slot--;
  }
  for (let i = attempts.length - 1; i >= 0 && slot >= 0; i--, slot--) {
    const a = attempts[i];
    const x = slot * PITCH + offset;
    if (a.o === 'p') {
      ctx.fillStyle = COLORS[a.rank] || COLORS.pass;
      ctx.fillRect(x, 4, BAR, floor - 4);
    } else if (a.o === 'f') {
      const h = 14;
      ctx.fillStyle = COLORS.miss;
      ctx.fillRect(x, floor - h, BAR, line);
      ctx.fillRect(x, floor - h, line, h);
      ctx.fillRect(x + BAR - line, floor - h, line, h);
    } else {
      ctx.fillStyle = COLORS.muted;
      ctx.fillRect(x, floor - 6, BAR, 6);
    }
  }
}

// ----------------------------------------------------------------------------- settings
const ROWS = ['rowPlays', 'rowTape', 'rowGrades', 'rowProfile'];
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
  show(el.cellBest, !!cfg.rowBest);
  show(el.cellAcc, !!cfg.rowAccuracy);
  show(el.rowPasses, !!(cfg.rowBest || cfg.rowAccuracy));
  el.rowPasses.style.gridTemplateColumns = cfg.rowBest && cfg.rowAccuracy ? '' : '1fr';
  show(el.brand, !!cfg.showBrand);
  dirty();
});
// vosu unreachable at load: keep counting and adopt the stored session with what we know.
setTimeout(adopt, 1500);

// Clocks advance by the minute; a coarse timer refreshes them and rolls the session day.
setInterval(() => { checkDay(); dirty(); }, 5000);

subscribe(POINTERS, onFrame, {
  onStatus: state => { if (state !== socketState) { socketState = state; dirty(); } },
});

// Copyright (c) 2026 18-LAB. MIT.
// Player card: identity, ranking stats, level progress and session changes since load.
import { subscribe, settings, fit, MODES, MODE_LABELS } from './vosu-overlay.js';

// Room for the card to grow (7-digit rank and play count) without clipping.
const WIDTH = 640;
const HEIGHT = 360;
// A ruleset or account switch can deliver stats that are still settling; the session baseline
// follows the latest values for this long after a key is first seen.
const SETTLE_MS = 2000;

const P = {
  client: '/client',
  name: '/profile/name',
  id: '/profile/id',
  login: '/profile/userStatus/name',
  bancho: '/profile/banchoStatus/name',
  mode: '/profile/mode/number',
  selectedMode: '/settings/mode/number',
  country: '/profile/countryCode/name',
  rank: '/profile/globalRank',
  pp: '/profile/pp',
  accuracy: '/profile/accuracy',
  plays: '/profile/playCount',
  level: '/profile/level',
};

// Bancho presence → [label, tone]. Unlisted or empty names hide the chip.
const BANCHO = {
  idle: ['Idle', 'idle'],
  afk: ['AFK', 'away'],
  playing: ['Playing', 'live'],
  editing: ['Editing', 'idle'],
  modding: ['Modding', 'idle'],
  multiplayer: ['Multiplayer', 'idle'],
  watching: ['Watching', 'idle'],
  testing: ['Testing', 'live'],
  submitting: ['Submitting', 'idle'],
  paused: ['Paused', 'away'],
  lobby: ['Lobby', 'idle'],
  multiplaying: ['Multiplaying', 'live'],
  osuDirect: ['osu!direct', 'idle'],
};
const LOGIN = {
  reconnecting: ['Reconnecting', 'warn'],
  disconnected: ['Disconnected', 'warn'],
  guest: ['Guest', 'off'],
  recieving_data: ['Signing in', 'wait'],
};

const $ = id => document.getElementById(id);
const card = $('card');
const ui = {
  brand: $('brand'), ruleset: $('ruleset'), status: $('status'), statusText: $('status-text'),
  img: $('avatar-img'), monogram: $('monogram'), name: $('name'), country: $('country'),
  rank: $('rank'), pp: $('pp'), acc: $('acc'), plays: $('plays'),
  dRank: $('d-rank'), dPp: $('d-pp'), dPlays: $('d-plays'),
  level: $('level'), track: $('level-track'), fill: $('level-fill'), head: $('level-head'), pct: $('level-pct'),
};

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)';
const ARRIVE = [{ transform: 'translateY(4px)', opacity: 0.25 }, { transform: 'none', opacity: 1 }];
const ARRIVE_TIMING = { duration: 200, easing: EASE };

const shown = new WeakMap();
/** Writes `textContent` only when it changed; returns whether it did. */
function text(node, value) {
  if (shown.get(node) === value) return false;
  const had = shown.has(node);
  shown.set(node, value);
  node.textContent = value;
  return had;
}
function flag(node, name, on) {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on);
}
function data(node, key, value) {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}
/** A readout that changed from one real value to another eases in, so a rank-up reads as an event. */
function readout(node, value, live) {
  const empty = value === '—';
  const was = node.hasAttribute('data-empty');
  flag(node, 'data-empty', empty);
  if (text(node, value) && live && !empty && !was) node.animate(ARRIVE, ARRIVE_TIMING);
}

let values = null;
let conn = 'connecting';
const opts = { layout: 'horizontal', showAvatar: true, showDeltas: true, showBrand: true };
const baselines = new Map();
let session = null;
let frame = 0;

function invalidate() {
  if (!frame) frame = requestAnimationFrame(render);
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const signedIn = () => typeof values?.[P.name] === 'string' && values[P.name].trim() !== '' && finite(values[P.id]) && values[P.id] > 0;

function modeNumber() {
  const own = values?.[P.mode];
  if (Number.isInteger(own) && MODES[own]) return own;
  const selected = values?.[P.selectedMode];
  return Number.isInteger(selected) && MODES[selected] ? selected : null;
}

/** Session baselines per account and ruleset, so a ruleset switch never reads as a pp swing. */
function track() {
  if (!signedIn()) { session = null; return; }
  const mode = modeNumber();
  const key = `${values[P.id]}:${mode}`;
  const now = performance.now();
  let base = baselines.get(key);
  if (!base) { base = { since: now, rank: 0, pp: 0, plays: 0 }; baselines.set(key, base); }
  const settling = now - base.since < SETTLE_MS;
  const rank = values[P.rank], pp = values[P.pp], plays = values[P.plays];
  // Zero means "not loaded" (or unranked): it never becomes a baseline.
  if (finite(rank) && rank > 0 && (settling || base.rank === 0)) base.rank = rank;
  if (finite(pp) && pp > 0 && (settling || base.pp === 0)) base.pp = pp;
  if (finite(plays) && plays > 0 && (settling || base.plays === 0)) base.plays = plays;
  session = base;
}

subscribe(Object.values(P), current => {
  values = current;
  track();
  invalidate();
}, {
  onStatus: state => {
    // A reconnect attempt is still "offline" to the viewer until vosu answers.
    if (state === conn || (state === 'connecting' && conn === 'offline')) return;
    conn = state;
    invalidate();
  },
});

settings({ ...opts }, next => {
  Object.assign(opts, next);
  invalidate();
});

fit($('stage'), WIDTH, HEIGHT);

/* ---------- avatar ---------- */

let avatarFor = 0;
ui.img.addEventListener('load', () => { if (avatarFor) ui.img.classList.add('is-loaded'); });
// a.ppy.sh unreachable (offline PC, blocked host): the monogram underneath stays.
ui.img.addEventListener('error', () => { ui.img.classList.remove('is-loaded'); ui.img.hidden = true; });

function avatar(id) {
  const want = opts.showAvatar && finite(id) && id > 0 ? id : 0;
  if (want === avatarFor) return;
  avatarFor = want;
  ui.img.classList.remove('is-loaded');
  if (!want) {
    ui.img.hidden = true;
    ui.img.removeAttribute('src');
    return;
  }
  ui.img.hidden = false;
  ui.img.src = `https://a.ppy.sh/${want}`;
}

/* ---------- formatting ---------- */

function signed(delta, digits) {
  const size = Math.abs(delta);
  if (size < 0.5 / 10 ** digits) return '±0';
  const body = digits && size < 100 && !Number.isInteger(delta) ? size.toFixed(digits) : integer.format(Math.round(size));
  return `${delta > 0 ? '+' : '−'}${body}`;
}

function delta(node, before, now, kind, live) {
  let out = '', tone = 'flat';
  if (before > 0 && finite(now) && now > 0) {
    if (kind === 'rank') {
      const gain = before - now; // a smaller rank number is an improvement
      out = gain === 0 ? '±0' : `${gain > 0 ? '▲' : '▼'} ${integer.format(Math.abs(gain))}`;
      tone = gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat';
    } else {
      const change = now - before;
      out = signed(change, kind === 'pp' ? 1 : 0);
      tone = out === '±0' ? 'flat' : change > 0 ? 'up' : 'down';
    }
  }
  data(node, 'tone', tone);
  if (text(node, out) && live && out && tone !== 'flat') node.animate(ARRIVE, ARRIVE_TIMING);
}

function status(user) {
  if (conn === 'offline') return ['vosu offline', 'error'];
  if (conn === 'connecting') return ['Connecting', 'wait'];
  if (values[P.client] === undefined) return ['osu! not running', 'off'];
  if (!user) return [LOGIN[values[P.login]]?.[0] ?? 'Not signed in', 'off'];
  // lazer has no bancho presence: vosu reports a constant placeholder there.
  if (values[P.client] === 'lazer') return null;
  const login = LOGIN[values[P.login]];
  if (login) return login;
  return BANCHO[values[P.bancho]] ?? null;
}

/* ---------- render ---------- */

function render() {
  frame = 0;
  data(card, 'layout', opts.layout === 'vertical' ? 'vertical' : 'horizontal');
  data(card, 'avatar', opts.showAvatar ? 'on' : 'off');
  data(card, 'deltas', opts.showDeltas ? 'on' : 'off');
  data(card, 'conn', conn);
  flag(ui.brand, 'hidden', !opts.showBrand);

  const v = values ?? {};
  // While vosu reconnects the last values stay up, dimmed (see style.css), instead of blanking.
  const user = values !== null && signedIn();
  const live = conn === 'live';

  const chip = values !== null || conn !== 'live' ? status(user) : ['Connecting', 'wait'];
  flag(ui.status, 'hidden', chip === null);
  if (chip) {
    text(ui.statusText, chip[0]);
    data(ui.status, 'tone', chip[1]);
  }

  const mode = user ? modeNumber() : null;
  text(ui.ruleset, mode === null ? '' : MODE_LABELS[MODES[mode]]);

  const name = user ? v[P.name].trim() : '';
  flag(ui.name, 'data-empty', !user);
  text(ui.name, user ? name : '—');
  const initial = user ? (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name[0]).toUpperCase() : '';
  text(ui.monogram, initial);
  avatar(user ? v[P.id] : 0);

  const country = user && typeof v[P.country] === 'string' ? v[P.country].trim() : '';
  flag(ui.country, 'hidden', country === '');
  text(ui.country, country);

  // Zero reads as "not loaded yet" (stats arrive after login) or unranked: show a calm dash.
  const stat = pointer => (user && finite(v[pointer]) && v[pointer] > 0 ? v[pointer] : 0);
  const rank = stat(P.rank);
  const pp = stat(P.pp);
  let acc = stat(P.accuracy);
  if (acc <= 1) acc *= 100; // tolerate a 0–1 ratio
  const plays = stat(P.plays);

  readout(ui.rank, rank > 0 ? integer.format(rank) : '—', live);
  readout(ui.pp, pp > 0 ? integer.format(Math.round(pp)) : '—', live);
  readout(ui.acc, acc > 0 ? `${acc.toFixed(2)}%` : '—', live);
  readout(ui.plays, plays > 0 ? integer.format(plays) : '—', live);

  const base = user ? session : null;
  delta(ui.dRank, base?.rank ?? 0, rank, 'rank', live);
  delta(ui.dPp, base?.pp ?? 0, pp, 'pp', live);
  delta(ui.dPlays, base?.plays ?? 0, plays, 'plays', live);

  // Stable stores the level with its progress as a fraction; lazer reports only the whole level.
  const level = user && finite(v[P.level]) && v[P.level] > 0 ? v[P.level] : 0;
  const whole = Math.floor(level);
  const progress = level > 0 && v[P.client] !== 'lazer' ? level - whole : null;
  flag(ui.level, 'data-empty', level === 0);
  text(ui.level, level > 0 ? String(whole) : '—');
  flag(ui.track, 'data-empty', progress === null);
  flag(ui.pct, 'data-empty', progress === null);
  text(ui.pct, progress === null ? '—' : `${Math.floor(progress * 100)}%`);
  const scale = progress === null ? 0 : Math.round(progress * 1000) / 1000;
  if (shown.get(ui.fill) !== scale) {
    shown.set(ui.fill, scale);
    ui.fill.style.transform = `scaleX(${scale})`;
    ui.head.style.transform = `translateX(${scale * 100}%)`;
  }
}

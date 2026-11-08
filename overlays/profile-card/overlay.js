// Copyright (c) 2026 18-LAB. MIT.
// Player tag: who is playing, their global rank and pp, and what this session has changed.
// Shown during gameplay only: song select already shows the user panel and results already show
// the ranking change. The page is the overlay's box; the tag re-flows to whatever box the host
// (OBS, vosulay, the replay renderer) gives it.
import { subscribe, settings, mapPalette, applyPalette, MODES } from './vosu-overlay.js';

const PLAYING = 2;
// Design boxes per arrangement (metadata resolution is the horizontal one); --u scales to fit.
// `orientation: auto` takes whichever arrangement fits the page at the larger size.
const BOX = { horizontal: [400, 88], vertical: [220, 200] };
// A ruleset or account switch can deliver stats that are still settling; the session baseline
// follows the latest values for this long after a key is first seen.
const SETTLE_MS = 2000;

const P = {
  client: '/client',
  state: '/state/number',
  source: '/play/source',
  playerName: '/play/playerName',
  selectedMode: '/settings/mode/number',
  checksum: '/beatmap/checksum',
  name: '/profile/name',
  id: '/profile/id',
  mode: '/profile/mode/number',
  country: '/profile/countryCode/name',
  rank: '/profile/globalRank',
  pp: '/profile/pp',
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const ui = {
  img: $('avatar-img'), monogram: $('monogram'), name: $('name'), country: $('country'),
  nums: $('nums'), rankNum: $('rank-num'), ppNum: $('pp-num'), rank: $('rank'), pp: $('pp'),
  dRank: $('d-rank'), dPp: $('d-pp'), chip: $('chip'), chipText: $('chip-text'), ppUnit: document.querySelector('#pp-num .unit'),
};

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ARRIVE = [{ transform: 'translateY(4px)', opacity: 0.25 }, { transform: 'none', opacity: 1 }];
const ARRIVE_TIMING = { duration: 200, easing: 'cubic-bezier(0.65, 0, 0.2, 1)' };

const shown = new WeakMap();
/** Writes `textContent` only when it changed; returns whether a previous value was replaced. */
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

const DEFAULTS = {
  orientation: 'auto', align: 'right', backing: 'none', accent: 'map', showAvatar: true, showDeltas: true,
  customName: '', customAvatar: '', customRank: '', customPp: '', customCountry: '',
};
const opts = { ...DEFAULTS };
let values = null;
let conn = 'connecting';
const baselines = new Map();
let session = null;
let frame = 0;
let palette = null;
let paletteFor = '';
let appliedPalette = null;
// Arrangement and unit for the current box; computed on resize, never inside a frame.
let orient = 'horizontal';
let unit = 1;

function invalidate() {
  if (!frame) frame = requestAnimationFrame(render);
}

function measure() {
  const width = innerWidth || BOX.horizontal[0];
  const height = innerHeight || BOX.horizontal[1];
  const fits = ([w, h]) => Math.min(width / w, height / h);
  orient = opts.orientation === 'horizontal' || opts.orientation === 'vertical'
    ? opts.orientation
    : fits(BOX.horizontal) >= fits(BOX.vertical) ? 'horizontal' : 'vertical';
  unit = Math.round(fits(BOX[orient]) * 1000) / 1000 || 1;
  invalidate();
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const textOf = value => (typeof value === 'string' ? value.trim() : '');
const signedIn = () => textOf(values?.[P.name]) !== '' && finite(values[P.id]) && values[P.id] > 0;

function profileMode() {
  const own = values?.[P.mode];
  if (Number.isInteger(own) && MODES[own]) return own;
  const selected = values?.[P.selectedMode];
  return Number.isInteger(selected) && MODES[selected] ? selected : null;
}

/** Session baselines per account and ruleset, so a ruleset switch never reads as a pp swing. */
function track() {
  if (!signedIn()) { session = null; return; }
  const key = `${values[P.id]}:${profileMode()}`;
  const now = performance.now();
  let base = baselines.get(key);
  if (!base) { base = { since: now, rank: 0, pp: 0 }; baselines.set(key, base); }
  const settling = now - base.since < SETTLE_MS;
  const rank = values[P.rank], pp = values[P.pp];
  // Zero means "not loaded" (or unranked): it never becomes a baseline.
  if (finite(rank) && rank > 0 && (settling || base.rank === 0)) base.rank = rank;
  if (finite(pp) && pp > 0 && (settling || base.pp === 0)) base.pp = pp;
  session = base;
}

/** Map tint, derived off the hot path once per beatmap. */
function loadPalette() {
  const checksum = opts.accent === 'map' ? textOf(values?.[P.checksum]) : '';
  if (checksum === paletteFor) return;
  paletteFor = checksum;
  palette = null;
  invalidate();
  if (!checksum) return;
  mapPalette(checksum).then(result => {
    if (paletteFor !== checksum) return;
    palette = result;
    invalidate();
  });
}

subscribe(Object.values(P), current => {
  values = current;
  track();
  loadPalette();
  invalidate();
}, {
  onStatus: state => {
    // A reconnect attempt is still "offline" to the viewer until vosu answers.
    if (state === conn || (state === 'connecting' && conn === 'offline')) return;
    conn = state;
    invalidate();
  },
});

settings({ ...DEFAULTS }, next => {
  Object.assign(opts, next);
  loadPalette();
  measure();
});

addEventListener('resize', measure);

/* ---------- avatar ---------- */

let avatarSrc = '';
ui.img.addEventListener('load', () => { if (avatarSrc) ui.img.classList.add('is-loaded'); });
// Unreachable image (offline PC, blocked host such as the replay renderer's): the monogram stays.
ui.img.addEventListener('error', () => { ui.img.classList.remove('is-loaded'); ui.img.hidden = true; });

function avatar(src) {
  if (src === avatarSrc) return;
  avatarSrc = src;
  ui.img.classList.remove('is-loaded');
  if (!src) {
    ui.img.hidden = true;
    ui.img.removeAttribute('src');
    return;
  }
  ui.img.hidden = false;
  ui.img.src = src;
}

/* ---------- values ---------- */

/** A custom stat: a number when it reads as one ("#4,120", "8123pp"), else the text as typed. */
function custom(textValue) {
  const raw = textValue.trim();
  if (!raw) return null;
  const digits = raw.replace(/^#|pp$/gi, '').replace(/[,\s]/g, '');
  const number = Number(digits);
  return digits !== '' && Number.isFinite(number) ? number : raw;
}

function signed(change) {
  const size = Math.abs(change);
  if (size < 0.05) return '';
  const body = size < 100 && !Number.isInteger(change) ? size.toFixed(1) : integer.format(Math.round(size));
  return `${change > 0 ? '+' : '−'}${body}`;
}

/** Session change since load; empty when there is none, so the tag only grows when it has news. */
function delta(node, before, now, kind, animate) {
  let out = '', tone = 'flat';
  if (before > 0 && now > 0) {
    if (kind === 'rank') {
      const gain = before - now; // a smaller rank number is an improvement
      if (gain) out = `${gain > 0 ? '▲' : '▼'}${integer.format(Math.abs(gain))}`;
      tone = gain > 0 ? 'up' : 'down';
    } else {
      out = signed(now - before);
      tone = now > before ? 'up' : 'down';
    }
  }
  data(node, 'tone', out ? tone : 'flat');
  if (text(node, out) && animate && out) node.animate(ARRIVE, ARRIVE_TIMING);
}

/** Writes one stat; returns whether it has a value. Numbers that change ease in. */
function stat(node, wrap, value, kind, animate) {
  const has = value !== null && value !== 0 && value !== '';
  flag(wrap, 'hidden', !has);
  if (!has) return false;
  const raw = typeof value === 'string';
  flag(node, 'data-raw', raw);
  const out = raw ? value : integer.format(Math.round(value));
  if (text(node, out) && animate) node.animate(ARRIVE, ARRIVE_TIMING);
  return true;
}

function chipFor() {
  if (conn === 'offline') return ['vosu offline', 'error'];
  if (conn === 'connecting' || values === null) return ['Connecting', 'wait'];
  if (values[P.client] === undefined) return ['osu! not running', 'wait'];
  return null;
}

/** The signed-in player's own attempt (not someone else's replay, spectating or autoplay). */
function ownAttempt() {
  const source = values[P.source];
  if (typeof source === 'string') return source === 'player';
  const player = textOf(values[P.playerName]);
  return player === '' || player.toLowerCase() === textOf(values[P.name]).toLowerCase();
}

/* ---------- render ---------- */

function render() {
  frame = 0;
  if (shown.get(stage) !== unit) {
    shown.set(stage, unit);
    stage.style.setProperty('--u', `${unit}px`);
  }
  data(stage, 'orient', orient);
  data(stage, 'align', ['left', 'center', 'right'].includes(opts.align) ? opts.align : DEFAULTS.align);
  data(stage, 'backing', ['scrim', 'panel'].includes(opts.backing) ? opts.backing : 'none');
  data(stage, 'accent', opts.accent === '18-lab' ? 'lab' : 'map');
  data(stage, 'avatar', opts.showAvatar ? 'on' : 'off');
  data(stage, 'deltas', opts.showDeltas ? 'on' : 'off');
  const tint = opts.accent === 'map' ? palette : null;
  if (tint !== appliedPalette) {
    appliedPalette = tint;
    applyPalette(stage, tint);
  }

  const chip = chipFor();
  flag(ui.chip, 'hidden', chip === null);
  if (chip) {
    text(ui.chipText, chip[0]);
    data(ui.chip, 'tone', chip[1]);
  }
  const v = values ?? {};
  const playing = chip === null && v[P.state] === PLAYING;

  // Who the tag is about. Custom values describe the streamer and always make a full tag (the
  // replay renderer keeps the profile idle). Otherwise the signed-in player's own attempt does;
  // anyone else's attempt (replay, spectating, a renderer track) gets a name-only tag.
  const customName = opts.customName.trim();
  const customRank = custom(opts.customRank);
  const customPp = custom(opts.customPp);
  const customCountry = opts.customCountry.trim();
  const customAvatar = opts.customAvatar.trim();
  const anyCustom = Boolean(customName || customRank !== null || customPp !== null || customCountry || customAvatar);
  const own = playing && signedIn() && ownAttempt();
  const full = playing && (anyCustom || own);
  const player = textOf(v[P.playerName]);
  const name = customName || (own ? textOf(v[P.name]) : full && signedIn() ? textOf(v[P.name]) : player);
  const show = playing && name !== '';
  data(stage, 'show', show ? 'tag' : chip ? 'chip' : 'none');
  if (!show) return;

  text(ui.name, name);
  text(ui.monogram, (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name[0]).toUpperCase());
  const liveProfile = full && signedIn();
  const id = liveProfile ? v[P.id] : 0;
  avatar(!opts.showAvatar ? '' : customAvatar || (id > 0 ? `https://a.ppy.sh/${id}` : ''));
  const country = customCountry || (liveProfile ? textOf(v[P.country]) : '');
  flag(ui.country, 'hidden', country === '');
  text(ui.country, country);

  // Zero reads as "not loaded yet" (stats arrive after login) or unranked: the stat stays out.
  const liveRank = liveProfile && finite(v[P.rank]) && v[P.rank] > 0 ? v[P.rank] : 0;
  const livePp = liveProfile && finite(v[P.pp]) && v[P.pp] > 0 ? v[P.pp] : 0;
  const rank = full ? customRank ?? liveRank : null;
  const pp = full ? customPp ?? livePp : null;
  const hasRank = stat(ui.rank, ui.rankNum, rank, 'rank', true);
  const hasPp = stat(ui.pp, ui.ppNum, pp, 'pp', true);
  flag(ui.ppUnit, 'hidden', typeof pp === 'string');
  flag(ui.nums, 'hidden', !hasRank && !hasPp);
  // Session changes only for live values (a custom value has no history).
  const base = own ? session : null;
  delta(ui.dRank, customRank === null ? base?.rank ?? 0 : 0, liveRank, 'rank', true);
  delta(ui.dPp, customPp === null ? base?.pp ?? 0 : 0, livePp, 'pp', true);
}

measure();

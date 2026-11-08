// Copyright (c) 2026 18-LAB. MIT.
// Player tag: who is playing, their global rank and pp, and what this session has changed.
// It floats in a free corner of osu!'s layout during the player's own attempts only: song select
// already shows the user panel and results already show the ranking change, so it stays away there.
import { subscribe, settings, fit, osuLayout, mapPalette, applyPalette, activeMode, MODES } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const PLAYING = 2;
// Distance from the edges of the chosen free region.
const MARGIN = 32;
const HP_CLEARANCE = 64;
// A ruleset or account switch can deliver stats that are still settling; the session baseline
// follows the latest values for this long after a key is first seen.
const SETTLE_MS = 2000;

const P = {
  client: '/client',
  state: '/state/number',
  source: '/play/source',
  playerName: '/play/playerName',
  playMode: '/play/mode/number',
  selectedMode: '/settings/mode/number',
  keys: '/beatmap/stats/cs/converted',
  checksum: '/beatmap/checksum',
  name: '/profile/name',
  id: '/profile/id',
  mode: '/profile/mode/number',
  country: '/profile/countryCode/name',
  rank: '/profile/globalRank',
  pp: '/profile/pp',
};

const $ = id => document.getElementById(id);
const zone = $('zone');
const ui = {
  img: $('avatar-img'), monogram: $('monogram'), name: $('name'), country: $('country'), brand: $('brand'),
  rank: $('rank'), pp: $('pp'), dRank: $('d-rank'), dPp: $('d-pp'), chip: $('chip'), chipText: $('chip-text'),
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
function css(node, property, value) {
  if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
}
/** A readout that changed from one real value to another eases in, so a rank-up reads as an event. */
function readout(node, value, live) {
  const empty = value === '—';
  const was = node.hasAttribute('data-empty');
  flag(node, 'data-empty', empty);
  if (text(node, value) && live && !empty && !was) node.animate(ARRIVE, ARRIVE_TIMING);
}

const DEFAULTS = {
  zone: 'bottom-right', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map',
  showAvatar: true, showDeltas: true, showBrand: true,
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

function invalidate() {
  if (!frame) frame = requestAnimationFrame(render);
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const signedIn = () => typeof values?.[P.name] === 'string' && values[P.name].trim() !== '' && finite(values[P.id]) && values[P.id] > 0;

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
  const checksum = opts.accent === 'map' && typeof values?.[P.checksum] === 'string' ? values[P.checksum] : '';
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

/* ---------- placement ---------- */

const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
let placedFor = '';

/**
 * Pins the zone to the requested corner of the free region of osu!'s layout that touches that
 * screen edge and lies closest to the corner: beside the osu!/catch playfield, beside the mania
 * stage, below the taiko lane — clear of the playfield and the default HUD. The tag never hops
 * across the playfield, so it stays where the chosen corner promises.
 */
function place(mode, keys, client) {
  const corner = CORNERS.has(opts.zone) ? opts.zone : DEFAULTS.zone;
  const scale = Math.min(2, Math.max(0.5, opts.scale || 1));
  const key = `${mode}|${keys}|${client}|${corner}|${opts.offsetX}|${opts.offsetY}|${scale}`;
  if (key === placedFor) return;
  placedFor = key;
  const layout = osuLayout(mode ?? 'osu', { keys, client });
  const [v, h] = corner.split('-');
  const cornerX = h === 'right' ? WIDTH : 0;
  const cornerY = v === 'bottom' ? HEIGHT : 0;
  const edge = layout.free.filter(r => (h === 'right' ? r.x + r.w >= WIDTH : r.x <= 0));
  let best = null, bestDistance = Infinity;
  for (const r of edge.length ? edge : layout.free) {
    const x = h === 'right' ? r.x + r.w : r.x;
    const y = v === 'bottom' ? r.y + r.h : r.y;
    const distance = Math.hypot(x - cornerX, y - cornerY);
    if (distance < bestDistance) { best = r; bestDistance = distance; }
  }
  const r = best ?? { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  data(zone, 'h', h);
  data(zone, 'v', v);
  css(zone, 'left', h === 'left' ? `${r.x + MARGIN}px` : 'auto');
  css(zone, 'right', h === 'right' ? `${WIDTH - r.x - r.w + MARGIN}px` : 'auto');
  // Skinned HP bars (face, SP gauge) hang well below the default bar: keep extra room under it.
  const health = layout.hud.health;
  const underHealth = r.y <= health.y + health.h + 8 ? HP_CLEARANCE : 0;
  css(zone, 'top', v === 'top' ? `${r.y + MARGIN + underHealth}px` : 'auto');
  css(zone, 'bottom', v === 'bottom' ? `${HEIGHT - r.y - r.h + MARGIN}px` : 'auto');
  css(zone, 'transform-origin', `${v} ${h}`);
  css(zone, 'transform', `translate(${Number(opts.offsetX) || 0}px, ${Number(opts.offsetY) || 0}px) scale(${scale})`);
}

/* ---------- formatting ---------- */

function signed(change) {
  const size = Math.abs(change);
  if (size < 0.05) return '';
  const body = size < 100 && !Number.isInteger(change) ? size.toFixed(1) : integer.format(Math.round(size));
  return `${change > 0 ? '+' : '−'}${body}`;
}

/** Session change since load; empty when there is none, so the tag only grows when it has news. */
function delta(node, before, now, kind, live) {
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
  if (text(node, out) && live && out) node.animate(ARRIVE, ARRIVE_TIMING);
}

function chipFor() {
  if (conn === 'offline') return ['vosu offline', 'error'];
  if (conn === 'connecting' || values === null) return ['Connecting', 'wait'];
  if (values[P.client] === undefined) return ['osu! not running', 'wait'];
  if (values[P.state] === PLAYING && !signedIn()) return ['Not signed in', 'warn'];
  return null;
}

/** The tag belongs to the signed-in player: it hides for other people's replays and spectating. */
function ownAttempt() {
  if (values[P.state] !== PLAYING) return false;
  const source = values[P.source];
  if (typeof source === 'string') return source === 'player';
  const player = values[P.playerName];
  return typeof player !== 'string' || player === '' || player.toLowerCase() === values[P.name].trim().toLowerCase();
}

/* ---------- render ---------- */

function render() {
  frame = 0;
  const v = values ?? {};
  const playMode = activeMode(v[P.state], v[P.playMode], v[P.selectedMode]);
  const keys = finite(v[P.keys]) ? Math.round(v[P.keys]) : 4;
  place(playMode, keys, v[P.client] === 'lazer' ? 'lazer' : 'stable');

  data(zone, 'backing', ['scrim', 'panel'].includes(opts.backing) ? opts.backing : 'none');
  data(zone, 'accent', opts.accent === '18-lab' ? 'lab' : 'map');
  data(zone, 'avatar', opts.showAvatar ? 'on' : 'off');
  data(zone, 'deltas', opts.showDeltas ? 'on' : 'off');
  flag(ui.brand, 'hidden', !opts.showBrand);
  const tint = opts.accent === 'map' ? palette : null;
  if (tint !== appliedPalette) {
    appliedPalette = tint;
    applyPalette(zone, tint);
  }

  const chip = chipFor();
  const user = chip === null && signedIn();
  const show = user && ownAttempt();
  data(zone, 'show', show ? 'tag' : chip ? 'chip' : 'none');
  flag(ui.chip, 'hidden', chip === null);
  if (chip) {
    text(ui.chipText, chip[0]);
    data(ui.chip, 'tone', chip[1]);
  }
  // Values keep updating while hidden so the tag never fades in with stale numbers.
  if (!user) return;
  const live = show;

  const name = v[P.name].trim();
  text(ui.name, name);
  text(ui.monogram, (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name[0]).toUpperCase());
  avatar(v[P.id]);
  const country = typeof v[P.country] === 'string' ? v[P.country].trim() : '';
  flag(ui.country, 'hidden', country === '');
  text(ui.country, country);

  // Zero reads as "not loaded yet" (stats arrive after login) or unranked: show a calm dash.
  const rank = finite(v[P.rank]) && v[P.rank] > 0 ? v[P.rank] : 0;
  const pp = finite(v[P.pp]) && v[P.pp] > 0 ? v[P.pp] : 0;
  readout(ui.rank, rank ? integer.format(rank) : '—', live);
  readout(ui.pp, pp ? integer.format(Math.round(pp)) : '—', live);
  delta(ui.dRank, session?.rank ?? 0, rank, 'rank', live);
  delta(ui.dPp, session?.pp ?? 0, pp, 'pp', live);
}

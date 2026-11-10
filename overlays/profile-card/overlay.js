// Copyright (c) 2026 18-LAB. MIT.
// Player tag: who is playing, their global rank (the hero) and pp, and what this session has
// changed. Shown during gameplay only: song select already shows the user panel and results
// already show the ranking change. The page is the overlay's box; the tag re-flows to whatever box
// the host (OBS, vosulay, the replay renderer) gives it. Built on the shared kit
// (docs/overlay-system.md): kit.css roles, numberFormatter(), known(), applyKitSettings().
import {
  subscribe, settings, MODES, known, isKnown, numberFormatter, DASH, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const PLAYING = 2;
// Design boxes per arrangement at --u = 1; --u scales to fit. `tag` (two lines beside the avatar)
// is sized for the narrowest placement (216×96, osu!/catch); the 256×96 resolution and the
// 328×96 taiko box also draw at --u = 1 and simply have room for more. `strip` (one line) serves
// short boxes; `card` is the stacked (vertical) form. The two-line tag wins whenever it fits at
// full size or larger than the strip; otherwise the strip. `orientation: auto` then takes the
// card when that fits larger; `horizontal` picks between tag and strip, `vertical` is the card.
const BOX = { tag: [216, 96], strip: [256, 72], card: [232, 212] };
// A ruleset or account switch can deliver stats that are still settling; the session baseline
// follows the latest values for this long after a key is first seen.
const SETTLE_MS = 2000;

const P = {
  client: '/client',
  state: '/state/number',
  source: '/play/source',
  playerName: '/play/playerName',
  selectedMode: '/settings/mode/number',
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
  tag: $('tag'), img: $('avatar-img'), monogram: $('monogram'), name: $('name'), country: $('country'),
  rankLine: $('rank-line'), rank: $('rank'), ppLine: $('pp-line'), pp: $('pp'), gain: $('gain'),
  dRank: $('d-rank'), dRankText: $('d-rank-text'), dPp: $('d-pp'), dPpText: $('d-pp-text'), status: $('status'),
};

// One formatter per displayed field: each returns the same string until the shown number changes.
const fmt = { rank: numberFormatter('count'), pp: numberFormatter('pp'), dRank: numberFormatter('count'), dPp: numberFormatter('delta') };

// Motion (MOTION_MS mirrors kit.css). Animations are created once and restarted per event.
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
// A session change arriving: up from below and in (an element entering; reduced keeps it).
const ARRIVE = [{ opacity: 0, transform: 'translateY(.35em)' }, { opacity: 1, transform: 'none' }];
const ARRIVE_TIMING = { duration: MOTION_MS.base, easing: EASE_OUT };
// A rank gain: an amber rule draws under the rank (fast), holds, and fades (slow). Full only.
const GAIN_MS = MOTION_MS.fast + 700 + MOTION_MS.slow;
const GAIN = [
  { transform: 'scaleX(0)', opacity: 1, easing: EASE_OUT },
  { transform: 'scaleX(1)', opacity: 1, offset: MOTION_MS.fast / GAIN_MS },
  { transform: 'scaleX(1)', opacity: 1, offset: (GAIN_MS - MOTION_MS.slow) / GAIN_MS, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' },
  { transform: 'scaleX(1)', opacity: 0 },
];
const animation = (node, keyframes, timing) => {
  const made = node.animate(keyframes, timing);
  made.cancel();
  return made;
};
const anim = {
  dRank: animation(ui.dRank, ARRIVE, ARRIVE_TIMING),
  dPp: animation(ui.dPp, ARRIVE, ARRIVE_TIMING),
  gain: animation(ui.gain, GAIN, { duration: GAIN_MS }),
};
function restart(made) {
  made.cancel();
  made.play();
}

const shown = new WeakMap();
/** Writes `textContent` only when it changed; returns whether it changed. */
function text(node, value) {
  if (shown.get(node) === value) return false;
  shown.set(node, value);
  node.textContent = value;
  return true;
}
function flag(node, name, on) {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on);
}
function data(node, key, value) {
  if (node.dataset[key] !== value) node.dataset[key] = value;
}

const DEFAULTS = {
  orientation: 'auto', align: 'right', motion: 'full', backing: 'scrim', showAvatar: true, showDeltas: true,
  customName: '', customAvatar: '', customRank: '', customPp: '', customCountry: '',
};
const opts = { ...DEFAULTS };
let level = 'full';
let values = null;
let conn = 'connecting';
const baselines = new Map();
let session = null;
let frame = 0;
// Arrangement and unit for the current box; computed on resize, never inside a frame.
let arrangement = 'tag';
let unit = 1;
let unitShown = NaN;
// The tag's natural width is measured again only after something that changes it.
let fitDirty = true;

function invalidate() {
  if (!frame) frame = requestAnimationFrame(render);
}

function measure() {
  const width = innerWidth || BOX.tag[0];
  const height = innerHeight || BOX.tag[1];
  const fits = ([w, h]) => Math.min(width / w, height / h);
  arrangement = opts.orientation === 'vertical' ? 'card'
    : fits(BOX.tag) >= 1 || fits(BOX.tag) >= fits(BOX.strip) ? 'tag' : 'strip';
  if (opts.orientation !== 'horizontal' && opts.orientation !== 'vertical' && fits(BOX.card) > fits(BOX[arrangement])) arrangement = 'card';
  unit = Math.round(fits(BOX[arrangement]) * 1000) / 1000 || 1;
  fitDirty = true;
  invalidate();
}

const textOf = value => (typeof value === 'string' ? value.trim() : '');
const signedIn = () => textOf(values?.[P.name]) !== '' && isKnown(values[P.id]) && values[P.id] > 0;

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
  if (!base) { base = { since: now, rank: NaN, pp: NaN }; baselines.set(key, base); }
  const settling = now - base.since < SETTLE_MS;
  // Zero means "not loaded" (or unranked): it never becomes a baseline.
  const rank = known(values[P.rank], true), pp = known(values[P.pp], true);
  if (isKnown(rank) && (settling || !isKnown(base.rank))) base.rank = rank;
  if (isKnown(pp) && (settling || !isKnown(base.pp))) base.pp = pp;
  session = base;
}

/* ---------- avatar ---------- */

let avatarSrc = '';
ui.img.addEventListener('load', () => { if (avatarSrc) ui.img.classList.add('is-loaded'); });
// Unreachable image (offline PC, blocked host such as the replay renderer's): the initial stays.
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

// What the viewer last saw, as numbers (UNKNOWN for a dash or a custom text), so a change made
// while the tag was hidden (results) counts from there when it comes back.
const seen = { rank: NaN, pp: NaN, dRank: NaN, dPp: NaN };
// The count from the last seen values to the new ones (one rAF loop, only while it runs).
const count = { active: false, start: 0, delay: 0, fromRank: NaN, toRank: NaN, fromPp: NaN, toPp: NaN, gain: false };
let wasShown = false;
// The session changes last computed (landed, or waiting for a running count to land).
let pendingRank = NaN;
let pendingPp = NaN;
/** Equal numbers, UNKNOWN (NaN) included. */
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

function writeRank(value) {
  text(ui.rank, fmt.rank(value));
}
function writePp(value) {
  text(ui.pp, fmt.pp(value));
}

/** One stat's final text; returns the number shown (UNKNOWN for a dash or custom text). */
function stat(node, line, value, write) {
  const raw = typeof value === 'string';
  flag(line, 'data-raw', raw);
  flag(line, 'data-unknown', !raw && !isKnown(value));
  if (raw) { text(node, value); return NaN; }
  if (!isKnown(value)) { text(node, DASH); return NaN; }
  // A running count owns the number until it lands.
  if (!count.active) write(value);
  return Math.round(value);
}

/** A session change: ▲/▼ rank places, signed pp. Hidden (`none`) without live history and while
 *  it is zero: a `±0` beside the hero is a crumb, not news. */
function writeDelta(kind, change) {
  const node = kind === 'rank' ? ui.dRank : ui.dPp;
  const label = kind === 'rank' ? ui.dRankText : ui.dPpText;
  if (!isKnown(change) || change === 0) { data(node, 'tone', 'none'); return; }
  // Rank: a smaller number is a gain, so the change is before − now (positive = places gained).
  data(node, 'tone', change > 0 ? 'up' : 'down');
  text(label, kind === 'rank' ? fmt.dRank(change < 0 ? -change : change) : fmt.dPp(change));
}

/** Lands the session changes (after a count, or at once): they slide in when they changed. */
function landDeltas(dRank, dPp, gain) {
  const rankMoved = !same(dRank, seen.dRank);
  const ppMoved = !same(dPp, seen.dPp);
  writeDelta('rank', dRank);
  writeDelta('pp', dPp);
  seen.dRank = dRank;
  seen.dPp = dPp;
  if (level === 'off') return;
  if (rankMoved && isKnown(dRank) && dRank !== 0) restart(anim.dRank);
  if (ppMoved && isKnown(dPp) && dPp !== 0) restart(anim.dPp);
  if (gain && level === 'full') restart(anim.gain);
}

const easeOut = p => 1 - (1 - p) ** 4;
function tick(now) {
  if (!count.active) return;
  if (!count.start) count.start = now + count.delay;
  const p = now <= count.start ? 0 : Math.min(1, (now - count.start) / MOTION_MS.slow);
  const e = easeOut(p);
  if (isKnown(count.toRank)) writeRank(Math.round(count.fromRank + (count.toRank - count.fromRank) * e));
  if (isKnown(count.toPp)) writePp(Math.round(count.fromPp + (count.toPp - count.fromPp) * e));
  if (p < 1) { requestAnimationFrame(tick); return; }
  count.active = false;
  landDeltas(pendingRank, pendingPp, count.gain);
}

function chipFor() {
  if (conn === 'offline') return 'vosu offline';
  if (conn === 'connecting' || values === null) return 'Connecting';
  if (values[P.client] === undefined) return 'osu! not running';
  return '';
}

/** The signed-in player's own attempt (not someone else's replay, spectating or autoplay). */
function ownAttempt() {
  const source = values[P.source];
  if (typeof source === 'string') return source === 'player';
  const player = textOf(values[P.playerName]);
  return player === '' || player.toLowerCase() === textOf(values[P.name]).toLowerCase();
}

/** Narrow boxes give way in order: pp change, country, avatar. Reads layout; runs only on change. */
const FIT = ['0', '1', '2', '3'];
function fit() {
  fitDirty = false;
  const room = stage.clientWidth;
  for (let step = 0; ; step++) {
    data(ui.tag, 'fit', FIT[step]);
    if (step === FIT.length - 1) return;
    stage.setAttribute('data-measure', '');
    const need = ui.tag.getBoundingClientRect().width;
    stage.removeAttribute('data-measure');
    if (need <= room + 0.5) return;
  }
}

/* ---------- render ---------- */

function render() {
  frame = 0;
  if (unitShown !== unit) {
    unitShown = unit;
    document.documentElement.style.setProperty('--u', String(unit));
  }
  data(stage, 'orient', arrangement === 'card' ? 'vertical' : 'horizontal');
  data(stage, 'rows', arrangement === 'tag' ? '2' : '1');
  data(stage, 'align', opts.align === 'left' || opts.align === 'center' ? opts.align : 'right');

  const chip = chipFor();
  const v = values ?? {};
  const playing = chip === '' && v[P.state] === PLAYING;

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
  const name = customName || (full && signedIn() ? textOf(v[P.name]) : textOf(v[P.playerName]));
  const view = chip ? 'status' : playing && name !== '' ? 'full' : 'none';
  data(ui.tag, 'view', view);
  flag(ui.tag, 'data-out', view === 'none');
  if (chip) { text(ui.status, chip); fitDirty = true; }
  if (view !== 'full') {
    wasShown = false;
    // Hidden mid-count: the final values land unseen (the numbers are rewritten on return).
    if (count.active) {
      count.active = false;
      writeDelta('rank', pendingRank);
      writeDelta('pp', pendingPp);
      seen.dRank = pendingRank;
      seen.dPp = pendingPp;
    }
    return;
  }
  const entering = !wasShown;
  wasShown = true;

  if (text(ui.name, name)) {
    fitDirty = true;
    text(ui.monogram, (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name[0]).toUpperCase());
  }
  const liveProfile = full && signedIn();
  const id = liveProfile ? v[P.id] : 0;
  const avatarOn = full && opts.showAvatar;
  data(ui.tag, 'avatar', avatarOn ? 'on' : 'off');
  avatar(!avatarOn ? '' : customAvatar || (id > 0 ? `https://a.ppy.sh/${id}` : ''));
  const country = full ? customCountry || (liveProfile ? textOf(v[P.country]) : '') : '';
  flag(ui.country, 'hidden', country === '');
  if (text(ui.country, country)) fitDirty = true;

  // Zero reads as "not loaded yet" (stats arrive after login) or unranked: UNKNOWN, a dash.
  const liveRank = liveProfile ? known(v[P.rank], true) : NaN;
  const livePp = liveProfile ? known(v[P.pp], true) : NaN;
  const rank = full ? customRank ?? liveRank : NaN;
  const pp = full ? customPp ?? livePp : NaN;
  const hasNums = typeof rank === 'string' || typeof pp === 'string' || isKnown(rank) || isKnown(pp);
  data(ui.tag, 'nums', hasNums ? 'on' : 'off');

  // Session changes only for live values (a custom value has no history), computed on the shown
  // (rounded) numbers so the change always matches the numbers beside it.
  const base = own && opts.showDeltas ? session : null;
  data(ui.tag, 'deltas', base ? 'on' : 'off');
  const dRank = base && customRank === null && isKnown(base.rank) && isKnown(liveRank) ? Math.round(base.rank) - Math.round(liveRank) : NaN;
  const dPp = base && customPp === null && isKnown(base.pp) && isKnown(livePp) ? Math.round(livePp) - Math.round(base.pp) : NaN;

  // Final texts first (the measuring pass needs them), then the count may rewind the numbers.
  const nextRank = stat(ui.rank, ui.rankLine, rank, writeRank);
  const nextPp = stat(ui.pp, ui.ppLine, pp, writePp);
  if (!same(nextRank, seen.rank) || !same(nextPp, seen.pp) || !same(dRank, pendingRank) || !same(dPp, pendingPp)) fitDirty = true;
  if (fitDirty) {
    // The measuring pass shows every session change at its final text.
    writeDelta('rank', dRank);
    writeDelta('pp', dPp);
    fit();
    // A running count keeps the old session change until it lands.
    if (count.active) { writeDelta('rank', seen.dRank); writeDelta('pp', seen.dPp); }
  }

  // The viewer saw these numbers before (or, on first sight, the session's starting values):
  // count from there to the new ones, after the tag has entered, then land the session change.
  const fromRank = isKnown(seen.rank) ? seen.rank : entering && isKnown(dRank) ? Math.round(base.rank) : NaN;
  const fromPp = isKnown(seen.pp) ? seen.pp : entering && isKnown(dPp) ? Math.round(base.pp) : NaN;
  const countRank = isKnown(fromRank) && isKnown(nextRank) && fromRank !== nextRank;
  const countPp = isKnown(fromPp) && isKnown(nextPp) && fromPp !== nextPp;
  const gain = isKnown(dRank) && dRank > (isKnown(seen.dRank) ? seen.dRank : 0);
  seen.rank = nextRank;
  seen.pp = nextPp;
  pendingRank = dRank;
  pendingPp = dPp;
  if (level !== 'off' && (countRank || countPp)) {
    count.fromRank = countRank ? fromRank : NaN;
    count.toRank = countRank ? nextRank : NaN;
    count.fromPp = countPp ? fromPp : NaN;
    count.toPp = countPp ? nextPp : NaN;
    count.gain = gain;
    count.delay = entering ? MOTION_MS.base : 0;
    count.start = 0;
    // The old session change stays until the count lands.
    writeDelta('rank', seen.dRank);
    writeDelta('pp', seen.dPp);
    if (countRank) writeRank(fromRank);
    if (countPp) writePp(fromPp);
    if (!count.active) { count.active = true; requestAnimationFrame(tick); }
    return;
  }
  if (count.active) return;
  landDeltas(dRank, dPp, gain);
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

settings({ ...DEFAULTS }, next => {
  Object.assign(opts, next);
  level = applyKitSettings(ui.tag, opts);
  if (level === 'off') { count.active = false; anim.dRank.cancel(); anim.dPp.cancel(); anim.gain.cancel(); }
  measure();
});

addEventListener('resize', measure);

measure();

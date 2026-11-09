// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko drum input: four drum zones lighting on press, the per-zone counts, the left/right
// hand split and the alternation rate (keys per second on request). Data comes only from vosu's
// `/keys/all`; shown during taiko gameplay only. The page re-flows to whatever box its host gives
// it (one row for strips, a column for tall boxes), on the 18-LAB kit (kit.css).
import {
  subscribe, settings, activeMode, isPlaying, DASH, numberFormatter, createKps, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const POINTERS = ['/state/number', '/play/mode/number', '/settings/mode/number', '/keys/all', '/beatmap/time/rate'];
// Live keys per second needs the map clock, which changes every sample: only followed while shown.
const KPS_POINTERS = [...POINTERS, '/beatmap/time/live'];

// keys.all order in taiko: B1 left rim (kat), B2 left centre (don), B3 right centre (don), B4 right rim (kat).
const HAND = [0, 0, 1, 1];
const CHORD_MS = 12;           // both hands within this = one doubled (big-note) hit, not an alternation
const MAX_FRAME_PRESSES = 24;  // bigger jumps are an attach/baseline, not playing
const SNAP_KPS = 15;           // above this, a released zone goes dark at once instead of fading
const CHORD = 2;               // prevHand value after a doubled hit
const NONE = -1;

// Design boxes (CSS px at --u 1, padding included) — must match style.css.
const ROW = {
  full: { h: 96, base: 16 * 2 + 64 + 12 + 240, alt: 24 + 100, kps: 24 + 64 },
  compact: { h: 48, base: 8 * 2 + 32 + 12 + 340, alt: 16 + 124, kps: 16 + 64 },
};
const FULL_MIN_SCALE = 0.75;   // below this a full row's 14 px labels get too small: go compact
const COLUMN = { w: 256, h: 16 * 2 + 112 + 16 + 61 + 16 + 60 };

const $ = id => document.getElementById(id);
const ov = $('ov');
const chip = $('chip');
const chipText = $('chip-text');
const countEls = [$('c0'), $('c1'), $('c2'), $('c3')];
const balL = $('bal-l');
const balR = $('bal-r');
const balFill = $('bal-fill');
const altEl = $('alt');
const kpsEl = $('kps');
const peakEl = $('peak');

// ------------------------------------------------------------------ drum
// Zone outlines in a 100-unit viewBox (they scale with the drum): two rims and two faces with a
// parallel centre split and a gap between rim and face. Built once.
{
  const c = 50, h = 1.6, outer = 49.5, inner = 32.6, face = inner - 2 * h;
  // The point on radius r at `deg` degrees (screen coordinates, clockwise from +x), moved off the
  // centre line by the half-gap so the split between the hands stays parallel.
  const at = (r, deg, inward) => {
    const rad = (deg + inward * Math.asin(h / r) * 180 / Math.PI) * Math.PI / 180;
    return `${(c + r * Math.cos(rad)).toFixed(2)} ${(c + r * Math.sin(rad)).toFixed(2)}`;
  };
  const rim = (from, to) => `M${at(outer, from, 1)}A${outer} ${outer} 0 0 1 ${at(outer, to, -1)}`
    + `L${at(inner, to, -1)}A${inner} ${inner} 0 0 0 ${at(inner, from, 1)}Z`;
  const disc = (from, to) => `M${at(face, from, 1)}A${face} ${face} 0 0 1 ${at(face, to, -1)}Z`;
  const zones = [rim(90, 270), disc(90, 270), disc(-90, 90), rim(-90, 90)];
  const rest = document.querySelectorAll('.drum-rest path');
  const shapes = document.querySelectorAll('.drum-lit path');
  for (let i = 0; i < 4; i++) { rest[i].setAttribute('d', zones[i]); shapes[i].setAttribute('d', zones[i]); }
}

// One Animation per zone, created once and restarted: paused at 0 holds the zone lit while the
// key is down; playing it fades (or, fast or with reduced motion, blinks) the zone out.
const LIT_KEYFRAMES = [{ opacity: 1 }, { opacity: 0 }];
const FADE = { duration: MOTION_MS.fast, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const SNAP = { duration: 34, easing: 'steps(1, end)' }; // two frames: a press between samples still shows
const lit = [];
const litTiming = [FADE, FADE, FADE, FADE];
for (const el of document.querySelectorAll('.drum-lit')) {
  const animation = el.animate(LIT_KEYFRAMES, { duration: FADE.duration, easing: FADE.easing });
  animation.cancel();
  lit.push(animation);
}
let motion = 'full';

function lightOn(zone) {
  const animation = lit[zone];
  animation.pause();
  animation.currentTime = 0;
}
function lightOff(zone, timing) {
  const animation = lit[zone];
  if (litTiming[zone] !== timing) { litTiming[zone] = timing; animation.effect.updateTiming(timing); }
  if (animation.playState !== 'paused') animation.currentTime = 0; // a press seen only as a count
  animation.play();
}
/** All zones dark; a key still held lights again on the next sample. */
function lightsOut() {
  for (let i = 0; i < 4; i++) { lit[i].cancel(); pressed[i] = 0; }
}

// ------------------------------------------------------------------ state
const live = new Int32Array(4);        // vosu counts as last received
let hasLive = false;
const pressed = new Uint8Array(4);
const pressedAt = new Float64Array(4); // this frame's press edges (map ms; NaN when absent)
const delta = new Int32Array(4);
const order = new Uint8Array(4);

let alternations = 0;
let repeats = 0;
let prevHand = NONE;
let prevT = NaN;
const kps = createKps();
let kpsNow = 0;

let show = 'none';     // none | play | chip | note
let online = false;
let offline = false;
let game = false;
let wasPlaying = false;
let current = null;    // latest settings
let dirty = true;

function resetRun() {
  alternations = repeats = 0;
  prevHand = NONE;
  prevT = NaN;
  kps.reset();
  kpsNow = 0;
  lightsOut();
  dirty = true;
}

// ------------------------------------------------------------------ input
function press(zone, t) {
  const hand = HAND[zone];
  if ((prevHand === 0 || prevHand === 1) && hand !== prevHand && t - prevT <= CHORD_MS) {
    prevHand = CHORD; // both hands together: a big-note double, not an alternation
  } else {
    if (prevHand === 0 || prevHand === 1) {
      if (hand === prevHand) repeats++;
      else alternations++;
    }
    prevHand = hand;
  }
  if (Number.isFinite(t)) prevT = t;
}

/**
 * Reads one `/keys/all` frame in place (the array is fresh per message; nothing is copied).
 * Counts only become hits while a taiko attempt is live.
 */
function ingestKeys(all, playing, rate, mapNow) {
  let total = 0;
  let dropped = false;
  let latest = -Infinity;
  for (let i = 0; i < 4; i++) {
    const key = all[i];
    const count = key && Number.isFinite(key.count) ? key.count : 0;
    const at = key && Number.isFinite(key.pressedAt) ? key.pressedAt : NaN;
    pressedAt[i] = at;
    if (at > latest) latest = at;
    if (count < live[i]) dropped = true;
    delta[i] = count;
  }
  if (dropped && playing) resetRun(); // retry / rewind restarts the attempt
  kps.ingest(all, mapNow, rate);
  for (let i = 0; i < 4; i++) {
    const count = delta[i];
    delta[i] = dropped ? 0 : count - live[i];
    if (delta[i] < 0) delta[i] = 0;
    total += delta[i];
    if (live[i] !== count) { live[i] = count; dirty = true; }
  }
  if (!hasLive) { hasLive = true; dirty = true; }
  const counted = playing && total > 0 && total <= MAX_FRAME_PRESSES;
  if (counted) {
    // Order this frame's zones by their latest press edge so alternation survives batched frames.
    for (let i = 0; i < 4; i++) {
      let j = i;
      while (j > 0 && pressedAt[order[j - 1]] > pressedAt[i]) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    for (let k = 0; k < 4; k++) {
      const zone = order[k];
      for (let n = delta[zone]; n > 0; n--) press(zone, n === 1 ? pressedAt[zone] : NaN);
    }
    if (latest > -Infinity) kpsNow = kps.at(latest);
    dirty = true;
  }
  // The drum follows the keys: lit while down, fading out on release or after a press that
  // started and ended between two samples.
  const timing = motion !== 'full' || kpsNow > SNAP_KPS ? SNAP : FADE;
  for (let i = 0; i < 4; i++) {
    const key = all[i];
    const down = playing && key && key.isPressed ? 1 : 0;
    if (down !== pressed[i]) {
      pressed[i] = down;
      if (down) lightOn(i);
      else lightOff(i, timing);
    } else if (!down && counted && delta[i] > 0) lightOff(i, timing);
  }
}

// ------------------------------------------------------------------ data
// `values` and `changed` are the client's reused frame objects: read them here, never keep them.
function onFrame(values, changed) {
  const state = values['/state/number'];
  const mode = activeMode(state, values['/play/mode/number'], values['/settings/mode/number']);
  const all = values['/keys/all'];
  const playing = isPlaying(state) && mode === 'taiko';
  const rate = values['/beatmap/time/rate'];
  const mapNow = values['/beatmap/time/live'];
  game = state !== undefined;

  if (playing && !wasPlaying) resetRun();
  wasPlaying = playing;

  // An unchanged keys array was already read (its counts and edges are known).
  if (Array.isArray(all)) { if (changed.has('/keys/all')) ingestKeys(all, playing, rate, mapNow); }
  else if (hasLive) { hasLive = false; kps.ingest(all); dirty = true; }

  if (showKps && playing && changed.has('/beatmap/time/live')) {
    const now = kps.at(mapNow);
    if (now !== kpsNow) { kpsNow = now; dirty = true; }
  }
  updateShow();
  if (dirty && show === 'play') writeText();
}

let chipTone = chip.dataset.tone;

/** Gameplay shows the drum; song select, results and other rulesets show nothing. */
function updateShow() {
  let next = 'none';
  let text = '';
  let tone = 'muted';
  if (offline) { next = 'chip'; text = 'vosu offline'; tone = 'offline'; }
  else if (!online) { next = connectingShown ? 'chip' : 'none'; text = 'Connecting to vosu'; tone = 'connecting'; }
  else if (!game) { next = 'chip'; text = 'osu! not running'; }
  else if (wasPlaying) next = hasLive ? 'play' : 'note';
  if (text && chipText.textContent !== text) chipText.textContent = text;
  if (chipTone !== tone) { chipTone = tone; chip.dataset.tone = tone; }
  if (next === show) return;
  show = next;
  // Leaving: the root fades out over what it last showed. Entering: the new content fades in.
  if (next === 'none') { ov.toggleAttribute('data-out', true); lightsOut(); return; }
  ov.dataset.show = next;
  ov.toggleAttribute('data-out', false);
  dirty = true;
}

let connectingTimer = 0;
let connectingShown = false;
function status(state) {
  clearTimeout(connectingTimer);
  online = state === 'live';
  if (state === 'offline') offline = true;
  else if (online) { offline = false; connectingShown = false; }
  else if (!offline) {
    // A first connect is near-instant; only surface it when it drags. Retries stay "offline".
    connectingTimer = setTimeout(() => { connectingShown = true; updateShow(); }, 800);
  }
  updateShow();
}

// ------------------------------------------------------------------ text
// One formatter per field: each returns the same string until the shown number changes, so
// textContent is written only when the text changed (compared by identity).
const countText = [numberFormatter('count'), numberFormatter('count'), numberFormatter('count'), numberFormatter('count')];
const pctL = numberFormatter('percent');
const pctR = numberFormatter('percent');
const pctAlt = numberFormatter('percent');
const kpsText = numberFormatter('kps');
const peakText = numberFormatter('kps');
const BAL_TRANSFORM = Array.from({ length: 101 }, (_, n) => `scaleX(${n / 100})`);
let balShown = -1;

function setText(el, text) {
  if (el._text === text) return;
  if ((el._text === DASH) !== (text === DASH)) el.classList.toggle('kit-dash', text === DASH);
  el._text = text;
  el.textContent = text;
}

function writeText() {
  dirty = false;
  for (let i = 0; i < 4; i++) setText(countEls[i], hasLive ? countText[i](live[i]) : DASH);

  const left = hasLive ? live[0] + live[1] : 0;
  const total = hasLive ? left + live[2] + live[3] : 0;
  // Rounded so the two shares always sum to 100; the bar moves only when the shown share does.
  const share = total > 0 ? Math.round(left / total * 100) : -1;
  if (share !== balShown) {
    balShown = share;
    setText(balL, share < 0 ? DASH : pctL(share));
    setText(balR, share < 0 ? DASH : pctR(100 - share));
    balFill.style.transform = BAL_TRANSFORM[share < 0 ? 0 : share];
  }

  const pairs = alternations + repeats;
  setText(altEl, pairs ? pctAlt(alternations / pairs * 100) : DASH);
  if (showKps) {
    // Presses made before the page watched have no times: no KPS until one has been timed.
    const timed = kps.available && kps.peak > 0;
    setText(kpsEl, timed ? kpsText(kpsNow) : DASH);
    setText(peakEl, timed ? peakText(kps.peak) : DASH);
  }
}

// ------------------------------------------------------------------ settings + layout
let showKps = false;
let feed = null;
let feedKps = null;

/** Follows the clock only while live KPS is shown (it changes every sample). */
function connect() {
  if (feed && feedKps === showKps) return;
  feed?.close();
  feedKps = showKps;
  feed = subscribe(showKps ? KPS_POINTERS : POINTERS, onFrame, { onStatus: status });
}

function applySettings(s) {
  current = s;
  motion = applyKitSettings(ov, s);
  const align = s.align === 'centre' || s.align === 'right' ? s.align : 'left';
  ov.dataset.align = align;
  document.body.dataset.align = align;
  showKps = s.showKps === true;
  ov.dataset.kps = String(showKps);
  layout();
  dirty = true;
  if (show === 'play') writeText();
  connect();
}

/**
 * Re-flows to the page box: a single row for wide boxes (full, or compact with inline values when
 * the box is short), a column for tall ones. The row scales with the box's height; when it is too
 * narrow for that, it shrinks to its width down to the design size (--u 1), and below that KPS,
 * then alternation drop. The scale reaches the CSS as --u. Runs on resize/settings only.
 */
function layout() {
  const W = Math.max(1, innerWidth);
  const H = Math.max(1, innerHeight);
  const pick = current?.orientation;
  const orient = pick === 'horizontal' || pick === 'vertical' ? pick : W / H >= 2 ? 'horizontal' : 'vertical';
  let density = 'full';
  let drop = '';
  let u;
  if (orient === 'vertical') {
    u = Math.min(W / COLUMN.w, H / COLUMN.h);
  } else {
    density = H / ROW.full.h >= FULL_MIN_SCALE ? 'full' : 'compact';
    const row = ROW[density];
    u = H / row.h;
    const least = u < 1 ? u : 1;
    let need = row.base + row.alt + (showKps ? row.kps : 0);
    if (showKps && W / need < least) { need -= row.kps; drop = 'kps'; }
    if (W / need < least) { need -= row.alt; drop += ' alt'; }
    u = Math.min(u, W / need);
  }
  ov.dataset.orient = orient;
  ov.dataset.density = density;
  ov.dataset.drop = drop;
  ov.style.setProperty('--u', String(Math.round(u * 1000) / 1000));
}
addEventListener('resize', layout);

// ------------------------------------------------------------------ start
settings({ orientation: 'auto', align: 'left', motion: 'full', backing: 'scrim', showKps: false }, applySettings);

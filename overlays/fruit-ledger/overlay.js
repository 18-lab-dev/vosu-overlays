// Copyright (c) 2026 18-LAB. MIT.
// Fruit ledger: the two osu!catch misses the game's HUD never counts. Combo breaks (the hero:
// fruit and drop misses, the rarer and costlier event; miss red once above zero) and droplets
// missed (they cost accuracy but not combo, so a full combo hides them). With `hudFields` on it
// also lists what the HUD already shows: fruits, drops and droplets caught, accuracy with the
// best accuracy still possible, and combo.
// A content-sized page on the 18-LAB kit (docs/overlay-system.md): the host places and sizes it,
// the ledger fits itself to that box through --u. Gameplay only: song select, results (osu!'s
// results screen lists every catch judgement) and menus show nothing.
import {
  subscribe, settings, activeMode, known, isKnown, numberFormatter, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const PLAYING = 2;
const MAX_U = 4; // largest scale a big box gets
const STRETCH = 1.3; // a wide box widens the ledger up to this factor of its natural width

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum',
  accuracy: '/play/accuracy',
  combo: '/play/combo/current',
  h300: '/play/hits/300',
  h100: '/play/hits/100',
  h50: '/play/hits/50',
  h0: '/play/hits/0',
  katu: '/play/hits/katu',
  large: '/play/hits/largeTickHits',
  small: '/play/hits/smallTickHits',
  sliderBreaks: '/play/hits/sliderBreaks',
};

const $ = id => document.getElementById(id);
const ledger = $('ledger');
const statusEl = $('status');
const hud = $('hud');
const bestStat = $('best-stat');
const breaksCell = ledger.querySelector('.cell-breaks');

// ------------------------------------------------------------ writers (DOM touched only on change)
/** A number field: one formatter (same string object until the shown value changes), the text
 *  written only when that string changes, and the dash colour while the value is unknown. */
function numberField(el, kind) {
  const format = numberFormatter(kind);
  let last = el.textContent;
  let dash = el.classList.contains('kit-dash');
  return value => {
    const text = format(value);
    if (text !== last) { last = text; el.textContent = text; }
    const unknown = !isKnown(value);
    if (unknown !== dash) { dash = unknown; el.classList.toggle('kit-dash', unknown); }
  };
}
function attrToggle(el, name) {
  let last = el.hasAttribute(name);
  return on => { if (on !== last) { last = on; el.toggleAttribute(name, on); } };
}
function textField(el) {
  let last = el.textContent;
  return text => { if (text !== last) { last = text; el.textContent = text; } };
}

const ui = {
  dmiss: numberField($('dmiss'), 'count'),
  breaks: numberField($('breaks'), 'count'),
  broken: attrToggle(breaksCell, 'data-broken'),
  fruits: numberField($('fruits'), 'count'),
  drops: numberField($('drops'), 'count'),
  droplets: numberField($('droplets'), 'count'),
  acc: numberField($('acc'), 'accuracy'),
  best: numberField($('best'), 'accuracy'),
  bestUnknown: attrToggle(bestStat, 'data-unknown'),
  combo: numberField($('combo'), 'count'),
  out: attrToggle(ledger, 'data-out'),
  statusHidden: attrToggle(statusEl, 'hidden'),
  status: textField(statusEl),
};

// ------------------------------------------------------------ motion (full only)
// Event motion answers a miss: the cell's rule flashes the miss colour (held a moment, then
// fading) and its number kicks. Animation objects are created once and restarted per event.
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
const FLASH_KEYS = [{ opacity: 1 }, { opacity: 1, offset: 0.3, easing: EASE_OUT }, { opacity: 0 }];
const FLASH_OPTS = { duration: MOTION_MS.slow, easing: 'linear' };
const KICK_KEYS = [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }];
const KICK_OPTS = { duration: MOTION_MS.base, easing: EASE_OUT };

function effect(numberEl, flashEl) {
  const flash = flashEl.animate(FLASH_KEYS, FLASH_OPTS);
  const kick = numberEl.animate(KICK_KEYS, KICK_OPTS);
  flash.cancel();
  kick.cancel();
  return { flash, kick, kickedAt: -Infinity };
}
const dmissFx = effect($('dmiss'), $('dmiss-flash'));
const breaksFx = effect($('breaks'), $('breaks-flash'));

/** Restarts a cell's flash; the kick restarts only when the last one is older than a fast
 *  duration, so a stream of droplet misses keeps the rule lit while the number snaps. */
function fire(fx, now) {
  fx.flash.currentTime = 0;
  fx.flash.play();
  if (now - fx.kickedAt < MOTION_MS.fast) return;
  fx.kickedAt = now;
  fx.kick.currentTime = 0;
  fx.kick.play();
}
function still(fx) {
  fx.flash.cancel();
  fx.kick.cancel();
}

// ------------------------------------------------------------ state
const DEFAULTS = { motion: 'full', backing: 'scrim', marks: 'neutral', hudFields: false, orientation: 'auto', align: 'left' };
let options = { ...DEFAULTS };
let motion = 'full';
let status = 'connecting';
// The subscribed values, copied out of the client's reused frame object on every message.
let gameState, playMode, settingsMode, checksum, accuracyRaw, comboRaw;
let h300, h100, h50, h0, katu, large, small, sliderBreaks;
let rafId = 0;

// Previous counts, for events. `armed` is false until a frame in play has been shown, so
// entering play (or a page loaded mid-play) never flashes.
let armed = false;
let lastDmiss = 0;
let lastBreaks = 0;

// Map composition (vosu's and tosu's /api/calculate/pp): object counts for "Best possible".
// Fetched only while hudFields is on; the replay renderer does not serve it (stays hidden).
let composition = 0; // accuracy objects on the map (fruits + drops + droplets); 0 = unknown
let compositionFor = null;
let compositionTimer = 0;

function markDirty() {
  if (!rafId) rafId = requestAnimationFrame(render);
}

// ------------------------------------------------------------ re-flow to the page box (never in rAF)
let relayoutTimer = 0;
function scheduleRelayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayout, 0);
}

/** Scale at which the ledger, laid out in `orient` at --u 1, fits W×H. */
function fitScale(orient, W, H) {
  ledger.dataset.orient = orient;
  return Math.min(MAX_U, W / ledger.offsetWidth, H / ledger.offsetHeight);
}

/**
 * Picks the arrangement (auto: whichever of the band and the column shows the ledger larger),
 * sets --u so it fits the page box, widens it up to STRETCH to fill a wide box, and places it by
 * the align setting, vertically centred. Runs on resize, settings change and font load only.
 */
function relayout() {
  const W = innerWidth, H = innerHeight;
  if (!W || !H) return;
  ledger.dataset.align = options.align;
  statusEl.dataset.align = options.align;
  ledger.style.setProperty('--u', '1');
  ledger.style.width = '';
  let orient = options.orientation === 'vertical' ? 'v' : options.orientation === 'horizontal' ? 'h' : '';
  let u;
  if (orient) {
    u = fitScale(orient, W, H);
  } else {
    const uv = fitScale('v', W, H);
    const uh = fitScale('h', W, H);
    // The band unless the column is clearly larger (it reads as one chip at the slot's shape).
    if (uv > uh * 1.15) { orient = 'v'; ledger.dataset.orient = 'v'; u = uv; } else { orient = 'h'; u = uh; }
  }
  ledger.style.setProperty('--u', String(u));
  const naturalW = ledger.offsetWidth;
  const height = ledger.offsetHeight;
  const width = Math.max(naturalW, Math.min(W, naturalW * STRETCH));
  ledger.style.width = `${width}px`;
  const x = options.align === 'left' ? 0 : options.align === 'right' ? W - width : (W - width) / 2;
  ledger.style.left = `${Math.round(x)}px`;
  ledger.style.top = `${Math.round((H - height) / 2)}px`;
}

function wantComposition(key) {
  if (!key || key === compositionFor) return;
  compositionFor = key;
  composition = 0;
  clearTimeout(compositionTimer);
  // Arguments rather than a closure: a captured parameter would allocate a context on every call.
  compositionTimer = setTimeout(loadComposition, 300, key, 0);
}

async function loadComposition(key, attempt) {
  try {
    const response = await fetch('/api/calculate/pp?mode=2', { cache: 'no-store' });
    if (compositionFor !== key) return;
    if (!response.ok) {
      // 503: the map is still being parsed; anything else means the route is unavailable.
      if (response.status === 503 && attempt < 5) compositionTimer = setTimeout(loadComposition, 1500, key, attempt + 1);
      return;
    }
    const attributes = (await response.json())?.difficulty;
    if (compositionFor !== key || !attributes) return;
    const { nFruits, nDroplets, nTinyDroplets } = attributes;
    if (!Number.isInteger(nFruits) || !Number.isInteger(nDroplets) || !Number.isInteger(nTinyDroplets)) return;
    composition = nFruits + nDroplets + nTinyDroplets;
    markDirty();
  } catch { /* offline or not JSON: composition stays unknown */ }
}

const int = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function showStatus(text) {
  ui.out(true);
  ui.status(text);
  ui.statusHidden(false);
  armed = false;
}

// ------------------------------------------------------------ render (rAF, one per data change)
function render(now) {
  rafId = 0;
  if (status !== 'live') return showStatus(status === 'connecting' ? 'Connecting to vosu' : 'vosu offline');
  if (!Number.isInteger(gameState)) return showStatus('Waiting for osu!');
  ui.statusHidden(true);

  // Another ruleset, song select, results, menus: nothing.
  if (gameState !== PLAYING || activeMode(gameState, playMode, settingsMode) !== 'fruits') {
    ui.out(true);
    armed = false;
    return;
  }
  ui.out(false);

  const fruits = known(h300);
  if (!isKnown(fruits)) {
    ui.dmiss(NaN); ui.breaks(NaN); ui.broken(false);
    if (options.hudFields) { ui.fruits(NaN); ui.drops(NaN); ui.droplets(NaN); ui.acc(NaN); ui.best(NaN); ui.bestUnknown(true); ui.combo(known(comboRaw)); }
    armed = false;
    return;
  }

  // Two shapes of catch statistics. tosu (and vosu's legacy shape): 300 fruits, 100 drops,
  // 50 droplets, katu missed droplets, 0 fruit + drop misses. vosu v2: drops and droplets as
  // large/small tick hits, 100/50/katu zero and missed droplets not published.
  const n100 = int(h100), n50 = int(h50), nKatu = int(katu);
  const legacy = n100 > 0 || n50 > 0 || nKatu > 0;
  const drops = legacy ? n100 : int(large);
  const droplets = legacy ? n50 : int(small);
  const misses = int(h0);
  // Combo breaks: fruit and drop misses. lazer files a missed drop as a large-tick miss, which
  // vosu does not publish either; it counts the combo resets without a new miss as slider breaks.
  const breaks = misses + int(sliderBreaks);
  const caught = fruits + drops + droplets;

  // Everything lost to accuracy so far. Both clients weight every catch object equally, so the
  // judged count is caught ÷ accuracy; without a usable accuracy the counted misses stand.
  const accuracy = known(accuracyRaw);
  const lost = isKnown(accuracy) && accuracy > 0 && caught > 0
    ? Math.max(0, Math.round(caught * 100 / accuracy) - caught)
    : misses + nKatu;
  const dmiss = legacy ? nKatu : Math.max(0, lost - breaks);

  ui.dmiss(dmiss);
  ui.breaks(breaks);
  ui.broken(breaks > 0);

  if (armed && motion === 'full') {
    if (dmiss > lastDmiss) fire(dmissFx, now);
    if (breaks > lastBreaks) fire(breaksFx, now);
  }
  lastDmiss = dmiss;
  lastBreaks = breaks;
  armed = true;

  if (!options.hudFields) return;
  ui.fruits(fruits);
  ui.drops(drops);
  ui.droplets(droplets);
  ui.acc(caught + lost > 0 ? accuracy : NaN);
  ui.combo(known(comboRaw));
  // Best possible: every object not yet lost is still catchable. Floored to the shown hundredth
  // so it never promises more than is left.
  const best = composition > 0 ? Math.floor(Math.max(0, (composition - lost) / composition) * 10000) / 100 : NaN;
  ui.best(best);
  ui.bestUnknown(!isKnown(best));
}

// ------------------------------------------------------------ wiring
subscribe(Object.values(P), (next, changed) => {
  // `next` and `changed` are reused by the client for every frame: copy the values out now.
  gameState = next[P.state];
  playMode = next[P.playMode];
  settingsMode = next[P.settingsMode];
  checksum = next[P.checksum];
  accuracyRaw = next[P.accuracy];
  comboRaw = next[P.combo];
  h300 = next[P.h300];
  h100 = next[P.h100];
  h50 = next[P.h50];
  h0 = next[P.h0];
  katu = next[P.katu];
  large = next[P.large];
  small = next[P.small];
  sliderBreaks = next[P.sliderBreaks];
  if (options.hudFields && activeMode(gameState, playMode, settingsMode) === 'fruits') wantComposition(checksum);
  if (changed.size) markDirty();
}, {
  onStatus: state => {
    // A reconnect attempt after losing vosu still reads as offline; no flicker per retry.
    if (state === 'connecting' && status === 'offline') return;
    if (state === status) return;
    status = state;
    markDirty();
  },
});

settings(DEFAULTS, next => {
  options = next;
  motion = applyKitSettings(ledger, next);
  if (motion !== 'full') { still(dmissFx); still(breaksFx); }
  hud.hidden = !options.hudFields;
  if (options.hudFields && activeMode(gameState, playMode, settingsMode) === 'fruits') wantComposition(checksum);
  scheduleRelayout();
  markDirty();
});

new ResizeObserver(scheduleRelayout).observe(document.documentElement);
document.fonts.ready.then(scheduleRelayout);

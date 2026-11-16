// Copyright (c) 2026 18-LAB. MIT.
// osu!mania judgement ratio: the chained ratio MAX : 300 : 200 : 100 : 50 : Miss as the hero (every
// count divided by the smallest non-zero count, so that term reads 1), each term under its judgement
// name, and the judgement mix as one proportional bar, on the 18-LAB kit (docs/overlay-system.md).
// The MAX…Miss counts, accuracy and combo are osu!'s HUD's and appear only with `hudFields`; keys per
// second (the shared createKps() number) only with `showKps`, from a second subscription that exists
// only while it is on. Results keep what osu!'s ranking screen lacks: the ratio, the bar and the
// attempt's peak.
//
// Motion (setting `motion`): the panel enters and leaves with the kit's fade; a 50 or a miss marks
// its place on the bar (and flashes its count when counts are shown); on results the bar grows in
// once. Counts and the ratio terms snap. Idle is free: a frame is requested only for new data or
// while a mark is fading.
//
// Render path: every buffer and formatter is created at load or on resize. The ratio terms are
// reformatted only when a count changed (numberFormatter returns one string per shown value), the DOM
// is written only when a string differs, and whether the terms fit is arithmetic on glyph widths
// measured at layout time (no layout reads per frame). The bar is redrawn only when a count changed
// or a mark is fading.
import {
  subscribe, settings, activeMode, MODES, UNKNOWN, DASH, isKnown, known,
  numberFormatter, createKps, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const BASE_WIDTH = 256; // the column's design width at --u = 1 (the default box)
const HORIZONTAL_ASPECT = 2; // auto orientation: boxes at least this wide per unit of height
const STATE_PLAY = 2;
const STATE_RESULTS = 7;

// Row order: MAX, 300, 200, 100, 50, MISS.
const KEYS = ['geki', '300', 'katu', '100', '50', '0'];
const PLAY_HITS = KEYS.map(key => `/play/hits/${key}`);
const RESULT_HITS = KEYS.map(key => `/resultsScreen/hits/${key}`);
const MEH = 4;
const MISS = 5;
const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  resultsMode: '/resultsScreen/mode/number',
  accuracy: '/play/accuracy',
  combo: '/play/combo/current',
};
// Keys per second: its own subscription, open only while showKps is on (the live clock changes
// every vosu tick; without it the main subscription only wakes on judgements).
const K = { keys: '/keys/all', live: '/beatmap/time/live', rate: '/beatmap/time/rate' };

const $ = id => document.getElementById(id);
const hud = $('hud');
const chip = $('chip');
const canvas = $('bar');
const ctx = canvas.getContext('2d', { alpha: true });
const chain = $('chain');
const probe = $('probe');
const note = $('note');
const text = { acc: $('acc'), combo: $('combo'), kps: $('kps'), peak: $('peak') };
const terms = [...chain.querySelectorAll('.term')].map(term => ({
  name: term.querySelector('.name'),
  value: term.querySelector('.value'),
  colon: term.nextElementSibling, // the colon after the term (null after Miss)
}));
const cells = [...hud.querySelectorAll('.cell')].map(cell => ({
  count: cell.querySelector('.count > b'),
  flash: cell.querySelector('.flash'),
  anim: null,
}));

// ------------------------------------------------------------------ state
let socketStatus = 'connecting';
let feed = null; // subscribe()'s handle; its `values` object is the client's, updated in place
let kpsFeed = null; // the keys-per-second subscription while showKps is on
let previousState;
let peakValid = false; // results reached straight from our own play → its peak applies
let options = null;
let motion = 'full';
let pending = 0;
let shown = false;
let phase = ''; // 'live' | 'results' | '' (hidden)
let orientation = 'vertical';

const kps = createKps();
// Last attempt, held so the results screen can show its ratio, bar and peak.
const held = { has: false, counts: new Int32Array(6), total: 0, peak: UNKNOWN };
const counts = new Int32Array(6);
const drawn = new Int32Array(6).fill(-1); // counts the bar was last drawn with; -1 = none
let barDirty = true;

// One formatter per displayed field (docs/overlay-system.md "Numbers").
const fmt = {
  acc: numberFormatter('accuracy'),
  combo: numberFormatter('count'),
  kps: numberFormatter('kps'),
  peak: numberFormatter('kps'),
  counts: KEYS.map(() => numberFormatter('count')),
  // Ratio terms: ≥ 10 whole (comma groups), below 10 one decimal with a trailing ".0" dropped.
  whole: KEYS.map(() => numberFormatter('count')),
  frac: KEYS.map(() => numberFormatter('stat')),
};

// ------------------------------------------------------------------ the chained ratio
// MAX : 300 : 200 : 100 : 50 : Miss, each count over the smallest non-zero one. Recomputed only when a
// count changed. All six terms always show: in the column they take the fewest rows that fit its
// width at the term size (one row of six, two of three, or three of two for very narrow boxes), and
// the text never shrinks. The chain is one grid over the term/colon siblings, so the columns align
// across rows and a row ends with its colon when the chain reads on.
const chainFor = new Int32Array(6).fill(-1); // counts the terms were computed from
let chainKnown = false;
const termText = new Array(6).fill(DASH);
const PER_ROW = [0, 6, 3, 2]; // terms per row for 1, 2 and 3 rows
const ROW_TEXT = ['', '1', '2', '3'];
let rows = 1;
// Fit geometry in 1/64 base px (measured at --u = 1, so it holds at any scale; integers, so the
// arithmetic never boxes a double), measured in measureChain() only.
const SUB = 64;
const NO_LIMIT = 0x3fffffff;
let fitWidth = NO_LIMIT; // the column's content width; no limit in the row form (always one row)
let digitW = 0;
let commaW = 0;
let dotW = 0;
let dashW = 0;
let colonW = 0;
const nameW = new Int32Array(6);
const termW = new Int32Array(6); // each term's number width, set when its text changes
// The page's natural height at --u = 1 (CSS px) for 1, 2 and 3 chain rows at each give-way level
// (index (rows − 1) · 4 + level), its natural width, and the box it scales into.
const GIVE_TEXT = ['0', '1', '2', '3'];
const naturalH = new Float64Array(12);
let naturalW = BASE_WIDTH;
let boxW = BASE_WIDTH;
let boxH = BASE_WIDTH;
let narrow = false;

function textWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 48 && c <= 57 ? digitW : c === 44 ? commaW : c === 46 ? dotW : dashW;
  }
  return w;
}

/** Width the chain needs with `k` terms per row: each column takes the widest term in it. */
function chainWidth(k) {
  let w = 0;
  for (let j = 0; j < k; j++) {
    let column = 0;
    for (let i = j; i < 6; i += k) {
      const cell = termW[i] > nameW[i] ? termW[i] : nameW[i];
      if (cell > column) column = cell;
    }
    w += column;
  }
  return w + (k === 6 ? 5 : k) * colonW; // a wrapped row ends with its colon
}

/** The fewest rows that fit; going back to fewer rows takes a digit's width to spare. */
function fitChain() {
  let next = 1;
  while (next < 3 && chainWidth(PER_ROW[next]) > fitWidth - (next < rows ? digitW : 0)) next++;
  if (next === rows) return false;
  rows = next;
  setAttr(chain, 'rows', ROW_TEXT[next]);
  return true;
}

/**
 * --u for the box from the natural sizes measured in measureChain(); no layout reads. In the column,
 * when the page would have to scale below --u = 1 to fit the box's height (every field on and the
 * ratio wrapped, or a short replay cell), fields give way before any text shrinks, least useful
 * first: 1 accuracy and combo (osu!'s HUD shows them biggest), 2 the judgement count table (osu!'s
 * HUD data too), 3 keys per second. Only a box too small even then scales the text down.
 */
function applyScale() {
  const byWidth = narrow ? 1 : boxW / naturalW;
  let level = 0;
  let unit = Math.min(byWidth, boxH / naturalH[(rows - 1) * 4]);
  while (orientation === 'vertical' && unit < 0.999 && level < 3) {
    level++;
    unit = Math.min(byWidth, boxH / naturalH[(rows - 1) * 4 + level]);
  }
  setAttr(hud, 'give', GIVE_TEXT[level]);
  hud.style.setProperty('--u', String(Math.max(0.25, unit)));
  barDirty = true;
}

function updateChain(known6) {
  chainFor.set(counts);
  chainKnown = known6;
  let min = 0;
  for (let i = 0; i < 6; i++) if (counts[i] > 0 && (min === 0 || counts[i] < min)) min = counts[i];
  const has = known6 && min > 0; // a dash before the first judgement, never 0
  setAttr(chain, 'known', has ? 'true' : 'false');
  for (let i = 0; i < 6; i++) {
    const t = counts[i] / min;
    const s = !has ? DASH : t >= 10 ? fmt.whole[i](t) : fmt.frac[i](t);
    termText[i] = s;
    termW[i] = textWidth(s);
    setText(terms[i].value, s);
  }
  if (fitChain()) applyScale(); // a new row count changes the page's height
}

/**
 * Layout time only (resize, settings, font load): with --u = 1 and the live layout, measures the
 * glyphs, the column's width and the page's natural size for each row count, then fits and scales.
 */
function measureChain() {
  const width = () => Math.round(probe.getBoundingClientRect().width * SUB);
  probe.textContent = '0000000000';
  digitW = Math.round(width() / 10);
  probe.textContent = ',,,,,,,,,,';
  commaW = Math.round(width() / 10);
  probe.textContent = '..........';
  dotW = Math.round(width() / 10);
  probe.textContent = DASH;
  dashW = width();
  probe.textContent = '';
  for (let i = 0; i < 6; i++) {
    nameW[i] = Math.round(terms[i].name.getBoundingClientRect().width * SUB);
    termW[i] = textWidth(termText[i]);
  }
  colonW = Math.round(terms[0].colon.getBoundingClientRect().width * SUB);
  fitWidth = orientation === 'vertical' ? Math.floor(chain.getBoundingClientRect().width * SUB) : NO_LIMIT;
  for (let r = 3; r >= 1; r--) {
    chain.dataset.rows = ROW_TEXT[r];
    for (let level = 3; level >= 0; level--) {
      hud.dataset.give = GIVE_TEXT[level];
      naturalH[(r - 1) * 4 + level] = hud.offsetHeight || BASE_WIDTH;
    }
  }
  if (hud._data) hud._data.give = '0';
  naturalW = hud.offsetWidth || BASE_WIDTH;
  rows = 1;
  setAttr(chain, 'rows', '1');
  fitChain();
}

// ------------------------------------------------------------------ data
function onFrame(next) {
  const state = next[P.state];
  if (state === STATE_PLAY && previousState !== STATE_PLAY) {
    kps.reset();
    peakValid = true;
    held.total = 0;
    held.peak = UNKNOWN;
  }
  if (state === STATE_RESULTS && previousState !== STATE_RESULTS && previousState !== STATE_PLAY) peakValid = false;
  previousState = state;
  schedule();
}

function onKpsFrame(next, changed) {
  if (feed?.values[P.state] !== STATE_PLAY) return;
  const live = known(next[K.live]);
  if (changed.has(K.keys)) {
    kps.ingest(next[K.keys], live, next[K.rate]);
    schedule();
  } else if (live >= kps.expiresAt) schedule(); // a press just left the window
}

function onStatus(state) {
  // Reconnect attempts report `connecting`; keep saying offline until one succeeds.
  if (state === socketStatus || (state === 'connecting' && socketStatus === 'offline')) return;
  socketStatus = state;
  schedule();
}

function schedule() {
  if (!pending) pending = requestAnimationFrame(render);
}

function setKpsFeed(on) {
  if (on && !kpsFeed) {
    kps.reset();
    kpsFeed = subscribe([K.keys, K.live, K.rate], onKpsFrame);
  } else if (!on && kpsFeed) {
    kpsFeed.close();
    kpsFeed = null;
  }
}

// ------------------------------------------------------------------ box layout
/**
 * Orientation from the box's aspect (or the setting), then the scale: the live layout is measured
 * at --u = 1 and fitted into the box. A column box narrower than the 256 px placement keeps --u at 1
 * (the type floor) and takes the box's width; the ratio wraps onto more rows to fit it. Runs on
 * resize, settings and font load only (it reads layout).
 */
function layout() {
  if (!options) return;
  boxW = innerWidth || BASE_WIDTH;
  boxH = innerHeight || BASE_WIDTH;
  const orient = options.orientation === 'horizontal' || options.orientation === 'vertical'
    ? options.orientation
    : boxW >= boxH * HORIZONTAL_ASPECT ? 'horizontal' : 'vertical';
  const align = options.align === 'left' || options.align === 'right' || options.align === 'center'
    ? options.align
    : orient === 'horizontal' ? 'center' : 'left';
  orientation = orient;
  setAttr(hud, 'orient', orient);
  setAttr(hud, 'align', align);
  setAttr(document.body, 'align', align);
  narrow = orient === 'vertical' && boxW < BASE_WIDTH;
  hud.style.setProperty('--w', String(narrow ? boxW : BASE_WIDTH));
  const shownPhase = hud.dataset.phase;
  hud.dataset.phase = 'live';
  hud.style.setProperty('--u', '1');
  measureChain();
  hud.dataset.phase = shownPhase;
  applyScale();
  schedule();
}

// ------------------------------------------------------------------ DOM writes
// Rewrites the existing text node in place (no node churn); only the first write creates one.
function setText(element, value) {
  if (element._text === value) return;
  element._text = value;
  const node = element.firstChild;
  if (value && node && node.nodeType === 3 && !node.nextSibling) node.nodeValue = value;
  else element.textContent = value;
}
// data-* writes go through a per-element mirror so an unchanged value never touches the DOM.
function setAttr(element, name, value) {
  const mirror = element._data || (element._data = {});
  if (mirror[name] === value) return;
  mirror[name] = value;
  if (element.dataset[name] !== value) element.dataset[name] = value;
}
function setShown(on) {
  if (on === shown) return;
  shown = on;
  hud.toggleAttribute('data-out', !on);
}

function hide() {
  setShown(false);
  phase = '';
  markAt.fill(NaN);
}

const num = value => typeof value === 'number' && Number.isFinite(value);

// ------------------------------------------------------------------ render
function render(now) {
  pending = 0;
  if (!options) return;
  const v = feed?.values;
  const state = v?.[P.state];

  // Connection and no-game states: one caption in the box, nothing else.
  if (socketStatus !== 'live' || !v || state === undefined) {
    hide();
    setAttr(chip, 'shown', 'true');
    setText(chip, socketStatus === 'offline' ? 'vosu offline' : socketStatus === 'live' ? 'osu! not running' : 'Connecting to vosu');
    return;
  }
  setAttr(chip, 'shown', 'false');

  const mode = state === STATE_RESULTS && Number.isInteger(v[P.resultsMode])
    ? MODES[v[P.resultsMode]] ?? null
    : activeMode(state, v[P.playMode], v[P.settingsMode]);
  if (mode !== 'mania' || (state !== STATE_PLAY && state !== STATE_RESULTS)) { hide(); return; }

  let total = 0;
  let known6 = false;
  const pointers = state === STATE_PLAY ? PLAY_HITS : RESULT_HITS;
  for (let i = 0; i < 6; i++) {
    const value = v[pointers[i]];
    if (num(value)) { counts[i] = value; known6 = true; } else counts[i] = 0;
    total += counts[i];
  }

  let next;
  if (state === STATE_PLAY) {
    next = 'live';
    if (options.hudFields) {
      setText(text.acc, fmt.acc(known(v[P.accuracy])));
      setText(text.combo, fmt.combo(known(v[P.combo])));
    }
    // A falling judgement total is a retry: the held attempt (and its peak) starts over.
    if (total < held.total) held.peak = UNKNOWN;
    held.total = total;
    if (options.showKps) {
      const live = known(kpsFeed?.values[K.live]);
      const current = isKnown(live) ? kps.at(live) : kps.available ? kps.current : UNKNOWN;
      // The attempt's peak is held here, not read back from the meter: the keys arrive on their own
      // socket, and a key reset there (a retry, the results screen) can land before this one's state.
      if (kps.available && !(held.peak >= kps.peak)) held.peak = kps.peak;
      setText(text.kps, fmt.kps(current));
      setText(text.peak, fmt.peak(held.peak));
      // Without keys.all (tosu, vosu without the key overlay) the cells hide; once the attempt is
      // clearly running without it, a caption says why.
      setAttr(hud, 'keys', kps.available ? 'ok' : 'missing');
      const explain = !kps.available && total > 16;
      if (note.hidden === explain) note.hidden = !explain;
    }
    if (total > 0) {
      held.has = true;
      held.counts.set(counts);
    }
    setAttr(hud, 'kps', options.showKps ? 'true' : 'false');
  } else {
    if (!total && held.has) {
      counts.set(held.counts);
      for (let i = 0; i < 6; i++) total += counts[i];
      known6 = true;
    }
    // Nothing osu!'s ranking screen lacks to add: stay off its screen.
    if (!total) { hide(); return; }
    next = 'results';
    const peak = peakValid && held.has ? held.peak : UNKNOWN;
    setText(text.peak, fmt.peak(peak));
    setAttr(hud, 'kps', options.showKps && isKnown(peak) ? 'true' : 'false');
  }

  const entering = next !== phase;
  if (entering) {
    drawn.fill(-1);
    markAt.fill(NaN);
    barDirty = true;
  }
  setAttr(hud, 'phase', next);
  setShown(true);

  // The chained ratio, reformatted only when a count (or whether any is known) changed.
  let stale = known6 !== chainKnown;
  for (let i = 0; i < 6 && !stale; i++) stale = counts[i] !== chainFor[i];
  if (stale) updateChain(known6);

  const events = next === 'live' && !entering && motion === 'full';
  for (let i = 0; i < 6; i++) {
    const c = counts[i];
    if (options.hudFields && next === 'live') {
      const value = fmt.counts[i](known6 ? c : UNKNOWN);
      const cell = cells[i];
      if (cell.count._text !== value) {
        setText(cell.count, value);
        if (cell.flash) setText(cell.flash, value);
      }
    }
    if (c === drawn[i]) continue;
    if (events && (i === MEH || i === MISS) && drawn[i] >= 0 && c > drawn[i]) {
      markAt[i] = now;
      if (options.hudFields) {
        const anim = cells[i].anim;
        anim.currentTime = 0;
        anim.play();
      }
    }
    drawn[i] = c;
    barDirty = true;
  }

  if (entering && next === 'results' && motion !== 'off') {
    reveal.currentTime = 0;
    reveal.play();
  }
  phase = next;

  if (barDirty || marking) marking = drawBar(now);
  if (marking) schedule();
}

// The 50 and Miss counts flash their judgement colour: a coloured copy of the numeral on top fades
// out (opacity only). One Animation per cell, created idle at load and restarted.
const FLASH_KEYFRAMES = [{ opacity: 1 }, { opacity: 1, offset: 1 / 3, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }, { opacity: 0 }];
const FLASH_TIMING = { duration: MOTION_MS.fast + MOTION_MS.base };
for (const cell of cells) {
  if (!cell.flash) continue;
  cell.anim = cell.flash.animate(FLASH_KEYFRAMES, FLASH_TIMING);
  cell.anim.cancel();
}
// The bar grows in once when results open.
const reveal = canvas.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: MOTION_MS.slow, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
reveal.cancel();

// ------------------------------------------------------------------ bar
// The canvas holds the bar (its bottom 6 of 16 px) and the headroom above it, where a 50 or a miss
// raises a mark over its segment: full for --dur-fast, then fading over --dur-base.
const tokens = getComputedStyle(document.documentElement);
const COLORS = ['--j-max', '--j-great', '--j-good', '--j-ok', '--j-meh', '--j-miss'].map(name => tokens.getPropertyValue(name).trim());
const TRACK = tokens.getPropertyValue('--hair').trim();
const BAR_SHARE = 6 / 16;
const MARK_HOLD = MOTION_MS.fast;
const MARK_FADE = MOTION_MS.base;
const markAt = new Float64Array(6).fill(NaN); // rAF time each judgement's mark was raised
const segStart = new Int32Array(6);
const segEnd = new Int32Array(6);
let marking = false;
// Device-pixel geometry, recomputed on resize only.
let barHeight = 0;
let gap = 1; // between segments
let markWidth = 4;
let markGap = 2;

/** Draws the bar for `counts`; returns whether a mark is still fading at rAF time `now`. */
function drawBar(now) {
  barDirty = false;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return false;
  const top = h - barHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = TRACK;
  ctx.fillRect(0, top, w, barHeight);
  let total = 0;
  for (let i = 0; i < 6; i++) total += counts[i];
  segStart.fill(0);
  segEnd.fill(0);
  if (total > 0) {
    let x = 0;
    let sum = 0;
    let last = 5;
    while (last > 0 && !counts[last]) last--;
    for (let i = 0; i <= last; i++) {
      if (!counts[i]) continue;
      sum += counts[i];
      let end = Math.round((sum / total) * w);
      if (end <= x) end = x + 1; // a non-zero share always shows
      if (end > w) end = w;
      segStart[i] = x;
      segEnd[i] = end;
      ctx.fillStyle = COLORS[i];
      ctx.fillRect(x, top, end - x - (i < last && end - x > gap + 1 ? gap : 0), barHeight);
      x = end;
    }
  }
  let active = false;
  for (let i = MEH; i <= MISS; i++) {
    const age = now - markAt[i];
    if (!(age >= 0 && age < MARK_HOLD + MARK_FADE)) { markAt[i] = NaN; continue; }
    active = true;
    const fade = age <= MARK_HOLD ? 0 : (age - MARK_HOLD) / MARK_FADE;
    const width = segEnd[i] - segStart[i] > markWidth ? segEnd[i] - segStart[i] : markWidth;
    let x = Math.round((segStart[i] + segEnd[i] - width) / 2);
    if (x < 0) x = 0;
    if (x > w - width) x = w - width;
    ctx.globalAlpha = (1 - fade) * (1 - fade);
    ctx.fillStyle = COLORS[i];
    ctx.fillRect(x, 0, width, top - markGap);
  }
  ctx.globalAlpha = 1;
  return active;
}

/** Sizes the canvas backing store to its CSS box × DPR. */
function sizeCanvas(width, height) {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  barHeight = Math.max(2, Math.round(h * BAR_SHARE));
  const px = h / 16; // device px per base px
  gap = Math.max(1, Math.round(px));
  markWidth = Math.max(4, Math.round(8 * px));
  markGap = Math.max(1, Math.round(2 * px));
  barDirty = true;
  schedule();
}
new ResizeObserver(entries => {
  const box = entries[entries.length - 1].contentRect;
  sizeCanvas(box.width, box.height);
}).observe(canvas);

// ------------------------------------------------------------------ settings + data
settings({ motion: 'full', backing: 'scrim', marks: 'neutral', hudFields: false, showKps: false, orientation: 'auto', align: 'auto' }, s => {
  options = s;
  motion = applyKitSettings(hud, s);
  setAttr(hud, 'hud', s.hudFields ? 'true' : 'false');
  setAttr(hud, 'kps', s.showKps ? 'true' : 'false');
  setKpsFeed(s.showKps);
  if (motion !== 'full') {
    markAt.fill(NaN);
    for (const cell of cells) cell.anim?.cancel();
  }
  if (motion === 'off') reveal.cancel();
  layout();
});
addEventListener('resize', layout);
document.fonts.ready.then(layout);

feed = subscribe([
  P.state, P.playMode, P.settingsMode, P.resultsMode,
  ...PLAY_HITS, P.accuracy, P.combo,
  ...RESULT_HITS,
], onFrame, { onStatus });

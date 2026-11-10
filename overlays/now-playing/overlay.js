// Copyright (c) 2026 18-LAB. MIT.
// Now playing: the map's identity, its star rating (the hero) and BPM, mods, the mod-adjusted
// difficulty settings and a progress hairline, during gameplay. Song select and results already
// show all of this, so the card stays empty there. Built on the overlay kit (docs/overlay-system.md):
// a column in tall boxes, a strip in wide ones, sized to its content.
import {
  subscribe, settings, activeMode, mapPalette, applyPalette, known, isKnown, numberFormatter, formatNumber,
  createMapClock, applyKitSettings, splitTitle, fitFields, NAME_KEEP, MOTION_MS, DASH,
} from './vosu-overlay.js';

// Default boxes of the two arrangements (metadata.txt placements); --u is 1 at these. The column
// is laid out for the osu!/catch side column (216 wide); mania's 256 × 192 box is also --u 1.
const BASE = { vertical: [216, 192], horizontal: [520, 104] };
// Below this content width (CSS px at --u 1) four settings at the kit's sizes no longer fit.
const NARROW = 240;
const WIDE = 2.2; // auto orientation: boxes at least this many times wider than tall get the strip

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  title: '/beatmap/title', titleUnicode: '/beatmap/titleUnicode', artist: '/beatmap/artist', artistUnicode: '/beatmap/artistUnicode',
  version: '/beatmap/version', mapper: '/beatmap/mapper', checksum: '/beatmap/checksum',
  first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', mp3: '/beatmap/time/mp3Length', clockRate: '/beatmap/time/rate',
  starsLive: '/beatmap/stats/stars/live', starsTotal: '/beatmap/stats/stars/total',
  arC: '/beatmap/stats/ar/converted', csC: '/beatmap/stats/cs/converted',
  odC: '/beatmap/stats/od/converted', hpC: '/beatmap/stats/hp/converted',
  bpmLive: '/beatmap/stats/bpm/realtime', bpmCommon: '/beatmap/stats/bpm/common',
  mods: '/play/mods/array', modsRate: '/play/mods/rate',
};
// Sampled only during an attempt: outside play they would wake vosu's fast reader for nothing.
const LIVE = '/beatmap/time/live';
const KIAI = '/beatmap/isKiai';
const PLAYING = 2;
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'; // --ease-out

// Difficulty settings that mean something while playing each ruleset: taiko has no approach rate
// or circle size, catch has no timing windows, and a mania player is looking at the key count.
// The narrow column (osu!/catch side column) drops HP, the least telling, rather than shrink type.
const KEYS = ['ar', 'cs', 'od', 'hp'];
const CELLS = { osu: ['ar', 'cs', 'od', 'hp'], taiko: ['od', 'hp'], fruits: ['ar', 'cs', 'hp'], mania: ['od', 'hp'] };
const CELLS_NARROW = { osu: ['ar', 'cs', 'od'], taiko: ['od', 'hp'], fruits: ['ar', 'cs'], mania: ['od', 'hp'] };
// align = auto follows the placements: osu!/catch hug the right screen edge; taiko's strip reads
// from the left (right of the mascot), mania sits in the top-left corner.
const AUTO_ALIGN = { osu: 'end', fruits: 'end', taiko: 'start', mania: 'start' };
// The clock rate a speed mod implies by itself; a rate chip shows only for other rates.
const MOD_RATE = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };
// The identity's fixed words (docs/overlay-system.md "Words": the mapper is "mapped by X").
const SEP = ' \u00b7 ';
const CREDIT = 'mapped by ';

const $ = id => document.getElementById(id);
const root = document.documentElement;
const np = $('np');
const body = $('body');
const chip = $('chip');
const ident = $('ident');
const titleEl = $('title');
const metaEl = $('meta');
const creditEl = $('credit');
const joinedEl = $('joined');
const numsEl = document.querySelector('.nums');
const bar = $('bar');
const prog = $('prog');
const strain = $('strain');
const strainFill = $('strainFill');
const bpmNum = $('bpmNum');
const statsEl = $('stats');

const fields = {};
for (const el of document.querySelectorAll('[data-f]')) fields[el.dataset.f] = el;
const shown = {};
function text(key, value) {
  if (shown[key] === value) return;
  shown[key] = value;
  write(fields[key], value);
}
/** Updates an element's single text node in place (no node churn); textContent otherwise. */
function write(el, value) {
  const node = el.firstChild;
  if (value && node && node.nodeType === 3 && !node.nextSibling) node.data = value;
  else el.textContent = value;
}
function attr(el, name, value) {
  if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

const cells = {};
for (const el of document.querySelectorAll('.cell')) {
  cells[el.dataset.k] = { el, v: el.querySelector('.v'), shown: '', format: numberFormatter('stat') };
}
const starsText = numberFormatter('stars');
const bpmText = numberFormatter('bpm');

// ------------------------------------------------------------------ state
let opts = {
  layout: 'full', orientation: 'auto', align: 'auto', unicode: false, showStats: true, showProgress: true,
  motion: 'full', backing: 'scrim', mapTint: true, marks: 'neutral',
};
let motion = 'full';
let values = {};
let liveSub = null;
let conn = 'connecting';
let dirty = true;
let liveDirty = false;
let progressDirty = false;
let frame = 0;
let orient = 'vertical';
const ctx = { show: false, parsed: false };
// The map's play span (first → last object, or the audio) and progress come from the shared
// clock; the hairline reads them through a step table (below). The latest map time sits in an
// object field that starts as null (tagged): a fractional number in a module-level `let`, or in
// a double-typed field, is boxed afresh on every read outside optimised code.
const clock = createMapClock();
const live = { t: null };
// Kiai ambience runs only while the map clock moves: a paused or frozen game stops it.
const kiai = { on: false, moving: false, ticks: 0, seen: 0, timer: 0, shown: false };
const STILL_MS = 250;
let shownChecksum;
let narrow = false; // the column is narrower than four settings need (osu!/catch side column)
let shownCells = null;
let paletteFor = '';
let identityFor = '';
let shownBpm = null;
let shownMods = null;
// Progress hairline and live-rating bar: transforms for every step, built on resize, so a step
// change writes a kept string. The hairline steps at half a CSS pixel of the box width.
let barSteps = 1;
let barTransforms = [];
let barStep = -1;
// Hairline step k = round(clock.progress(t) · barSteps), as whole-millisecond map-time ranges
// built when the span or the step count changes: a clock message then only compares the time
// against them (no arithmetic, nothing boxed). lo[k]..hi[k] are the times certainly inside
// step k; a time within rounding of an edge, or before the table exists, takes the formula.
const FAR = 1e9; // ms past either end of any map, still a small integer
const SLACK = 1e-3;
const table = { lo: new Int32Array(0), hi: new Int32Array(0), n: -1, at: -1 };
const built = { start: null, end: null, steps: -1 };
const STRAIN_STEPS = 100;
const strainTransforms = [];
for (let k = 0; k <= STRAIN_STEPS; k++) strainTransforms.push(`scaleX(${k / STRAIN_STEPS})`);
let strainStep = -2; // -1: hidden

// Motion: created once and restarted (motion brief rule 3).
const identityFade = body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS.slow, easing: EASE_OUT });
identityFade.cancel();
const bpmNudge = bpmNum.animate([{ opacity: 0.3, transform: 'translateY(-0.2em)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_MS.base, easing: EASE_OUT });
bpmNudge.cancel();

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

subscribe(Object.values(P), (snapshot, changed) => {
  values = snapshot;
  const state = snapshot[P.state];
  if (state === PLAYING && !liveSub) {
    liveSub = subscribe([LIVE, KIAI], onLive);
  } else if (state !== PLAYING && liveSub) {
    liveSub.close();
    liveSub = null;
    kiai.on = false;
    kiai.moving = false;
    live.t = null;
  }
  // Live stars and realtime BPM tick throughout play; they only need their own readouts.
  const hot = (changed.has(P.starsLive) ? 1 : 0) + (changed.has(P.bpmLive) ? 1 : 0);
  if (changed.size > hot) dirty = true;
  else if (changed.size) liveDirty = true;
  if (changed.size) schedule();
}, {
  onStatus: state => { if (state !== conn) { conn = state; dirty = true; schedule(); } },
});

function onLive(v) {
  const t = v[LIVE];
  kiai.on = v[KIAI] === true;
  if (typeof t === 'number' && t !== live.t) {
    // Moving takes two different samples: the first one after load or a pause proves nothing.
    if (live.t !== null) { kiai.ticks++; kiai.moving = true; }
    live.t = t;
  }
  progressDirty = true;
  schedule();
}

settings(opts, next => {
  const tintChanged = next.mapTint !== opts.mapTint;
  opts = next;
  motion = applyKitSettings(np, opts);
  const base = motion === 'off' ? 0 : MOTION_MS.base;
  identityFade.effect.updateTiming({ duration: motion === 'off' ? 0 : MOTION_MS.slow });
  bpmNudge.effect.updateTiming({ duration: base });
  if (tintChanged) loadPalette(paletteFor);
  layoutBox();
  dirty = true;
  schedule();
});

/** Orientation and scale from the page's box (runs on resize and setting changes only). */
function layoutBox() {
  const w = innerWidth || BASE.vertical[0];
  const h = innerHeight || BASE.vertical[1];
  orient = opts.orientation === 'horizontal' || opts.orientation === 'vertical' ? opts.orientation : w / h >= WIDE ? 'horizontal' : 'vertical';
  const [bw, bh] = BASE[orient];
  attr(np, 'data-orient', orient);
  const u = Math.round(Math.min(Math.max(Math.min(w / bw, h / bh), 0.5), 4) * 1000) / 1000;
  root.style.setProperty('--u', String(u));
  narrow = orient === 'vertical' && w / u < NARROW;
  attr(np, 'data-narrow', narrow ? '' : null);
  shownCells = null;
  dirty = true;
  const steps = Math.max(200, Math.round(w * 2));
  if (steps !== barSteps) {
    barSteps = steps;
    barTransforms = new Array(steps + 1);
    for (let k = 0; k <= steps; k++) barTransforms[k] = `scaleX(${k / steps})`;
  }
  barStep = -1;
  identityFor = '';
  buildTable();
  progressDirty = true;
  schedule();
}
addEventListener('resize', layoutBox);
// The identity's lines are fitted by measuring text; fit again once the web fonts have arrived.
function refitIdentity() { identityFor = ''; dirty = true; schedule(); }
document.fonts.ready.then(refitIdentity);
document.fonts.addEventListener('loadingdone', refitIdentity);

// ------------------------------------------------------------------ render
function render() {
  frame = 0;
  if (dirty) { dirty = false; liveDirty = false; renderAll(); }
  if (liveDirty) { liveDirty = false; renderLive(); }
  if (progressDirty) { progressDirty = false; renderProgress(); }
}

function renderAll() {
  const state = values[P.state];
  const online = conn === 'live';
  const mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  const playing = online && state === PLAYING;
  const hasMap = playing && !!(str(values[P.title]) || str(values[P.checksum]));
  ctx.show = hasMap;
  // vosu reports 0 for the timing and difficulty of a map it has not parsed: "no value".
  ctx.parsed = hasMap && (isKnown(known(values[P.bpmCommon], true)) || isKnown(known(values[P.last], true)));

  // The map colour follows the selected map (loaded in song select already, so play starts tinted).
  const checksum = online ? str(values[P.checksum]) : '';
  if (checksum && checksum !== paletteFor) loadPalette(checksum);

  const align = opts.align === 'left' ? 'start' : opts.align === 'right' ? 'end' : AUTO_ALIGN[mode] || 'end';
  attr(np, 'data-align', align);
  attr(chip, 'data-align', align);

  // A short status line in the box; nothing at all in menus, song select and results.
  let status = '';
  if (!online) status = conn === 'offline' ? 'vosu offline' : 'Connecting';
  else if (state === undefined) status = 'osu! not running';
  else if (playing && !hasMap) status = 'No map data';
  text('chip', status);
  chip.hidden = !status;

  attr(np, 'data-out', hasMap ? null : '');
  attr(np, 'data-layout', opts.layout === 'compact' ? 'compact' : 'full');
  attr(np, 'data-stats', opts.showStats ? 'on' : 'off');
  attr(np, 'data-progress', opts.showProgress ? 'on' : 'off');
  if (!hasMap) { setKiai(false); return; } // keep the last map's text in place while the card fades out

  if (checksum !== shownChecksum) {
    // Fade the identity in on a real map change, not when the source first loads.
    if (checksum && shownChecksum && motion !== 'off') { identityFade.currentTime = 0; identityFade.play(); }
    shownChecksum = checksum;
    shownBpm = null; // a new map's BPM arrives without the nudge
  }
  renderMods();
  renderStats(mode);
  renderLive();
  renderIdentity(); // last: the strip fits its text beside the numbers
  clock.sample(live.t, values[P.clockRate], values[P.first], values[P.last], values[P.mp3], 0);
  buildTable(); // the span may have moved
  progressDirty = true;
}

function renderIdentity() {
  const unicode = opts.unicode;
  const title = (unicode && str(values[P.titleUnicode]).trim()) || str(values[P.title]);
  const artist = (unicode && str(values[P.artistUnicode]).trim()) || str(values[P.artist]);
  const version = str(values[P.version]);
  const mapper = str(values[P.mapper]);
  const strip = orient === 'horizontal';
  // Fitted once per map, box, layout or (in the strip, which shares its row with them) number change.
  const key = `${orient}|${opts.layout}|${opts.showStats}|${opts.showProgress}|${innerWidth}x${innerHeight}|${strip ? `${shown.stars}|${shown.bpm}|${shown.mods}` : ''}|${title}|${artist}|${version}|${mapper}`;
  if (key === identityFor) return;
  identityFor = key;
  fitIdentity(title, artist, version, mapper, strip);
}

const measure = document.createElement('canvas').getContext('2d');
function fontOf(el) {
  const s = getComputedStyle(el);
  return `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}
function width(font, value) {
  measure.font = font;
  return measure.measureText(value).width;
}

/**
 * Lays the identity out with the shared truncation (docs/overlay-system.md "Words"): the title's
 * (…)/[…] suffix gives way first, then the difficulty name, then the artist; a mapper of 16
 * characters or fewer is never cut, and the title is cut last (to one line, never below 8).
 * Three lines in both arrangements: title (with a short artist joined to it), artist · difficulty,
 * and "mapped by X" as a caption.
 */
function fitIdentity(title, artist, version, mapper, strip) {
  const { main, suffix } = splitTitle(title);
  const titleFont = fontOf(titleEl);
  const textFont = fontOf(metaEl);
  let room = ident.clientWidth;
  if (strip) {
    // The strip's identity takes what the numbers leave of the box.
    room = innerWidth - 2 * parseFloat(getComputedStyle(np).paddingLeft) - numsEl.offsetWidth - parseFloat(getComputedStyle(body).columnGap);
  }

  // A short artist joins the title's line (no stray "xi" on a line of its own).
  const joinWidth = artist && !suffix ? width(textFont, SEP + artist) : 0;
  const join = joinWidth > 0 && width(titleFont, main) + joinWidth <= room;
  joinedEl.hidden = !join;
  text('artistJoined', join ? artist : '');

  // One line: artist (+ the title's suffix) · difficulty.
  const sepFor = t => ((t[0] || t[1]) && t[2] ? SEP : '');
  const meta = fitFields([
    { text: join ? '' : artist, order: 2, keep: 8 },
    { text: join || !suffix ? '' : artist ? ` ${suffix}` : suffix, order: 0, keep: 0 },
    { text: version, order: 1, keep: 6 },
  ], t => width(textFont, t[0] + t[1] + sepFor(t) + t[2]) <= room);
  text('artist', meta[0]);
  text('suffix', meta[1]);
  text('sep', sepFor(meta));
  text('version', meta[2]);

  // "mapped by X" on its own caption line.
  creditEl.hidden = !mapper;
  if (mapper) {
    const captionFont = fontOf(creditEl);
    text('mapper', fitFields([{ text: mapper, keep: NAME_KEEP }], t => width(captionFont, CREDIT + t[0]) <= room)[0]);
  }

  // Title: two lines in the column when the card has the height for them, otherwise one line
  // fitted beside the joined artist.
  attr(ident, 'data-title-lines', null);
  text('title', main || DASH);
  if (strip || np.offsetHeight > innerHeight) {
    attr(ident, 'data-title-lines', '1');
    const titleRoom = room - (join ? joinWidth : 0);
    text('title', fitFields([{ text: main, keep: 8 }], t => width(titleFont, t[0]) <= titleRoom)[0] || DASH);
  }
}

function loadPalette(checksum) {
  paletteFor = checksum;
  if (!checksum || opts.mapTint === false) { applyPalette(root, null); return; }
  mapPalette(checksum).then(palette => {
    if (paletteFor === checksum && opts.mapTint !== false) applyPalette(root, palette);
  });
}

function renderMods() {
  const list = Array.isArray(values[P.mods]) ? values[P.mods] : [];
  const rate = num(values[P.modsRate]) || num(values[P.clockRate]) || 1;
  let label = '';
  let implied = 1;
  for (let i = 0; i < list.length; i++) {
    const acronym = str(list[i]?.acronym);
    if (!acronym) continue;
    label += label ? ` ${acronym}` : acronym;
    if (MOD_RATE[acronym]) implied = MOD_RATE[acronym];
  }
  if (Math.abs(rate - implied) > 1e-4 && Math.abs(rate - 1) > 1e-4) label += `${label ? ' ' : ''}${formatNumber(rate, 'rate')}×`;
  if (label === shownMods) return;
  shownMods = label;
  text('mods', label);
}

function renderStats(mode) {
  const { parsed } = ctx;
  const visible = (narrow ? CELLS_NARROW : CELLS)[mode] || (narrow ? CELLS_NARROW : CELLS).osu;
  if (visible !== shownCells) {
    shownCells = visible;
    for (const k of KEYS) cells[k].el.hidden = !visible.includes(k);
    statsEl.dataset.n = String(visible.length);
  }
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i];
    const cell = cells[k];
    if (cell.el.hidden) continue;
    // The mod-adjusted value; 0 is a real AR/CS/OD/HP, so only an unparsed map makes it unknown.
    const to = cell.format(parsed ? known(values[P[`${k}C`]]) : NaN);
    if (to !== cell.shown) { cell.shown = to; write(cell.v, to); }
  }
}

/** The map's star rating, the live rating against it, and realtime BPM. */
function renderLive() {
  if (!ctx.show) return;
  const total = ctx.parsed ? known(values[P.starsTotal], true) : NaN;
  // The hero's decimals are a .kit-frac (7.01 → "7" + ".01"), as the set's heroes do; split only
  // when the shown rating changes.
  const stars = starsText(total);
  if (stars !== shown.stars) {
    shown.stars = stars;
    const dot = stars.indexOf('.');
    text('starsInt', dot < 0 ? stars : stars.slice(0, dot));
    text('starsFrac', dot < 0 ? '' : stars.slice(dot));
  }
  const liveStars = ctx.parsed ? known(values[P.starsLive], true) : NaN;
  let step = -1;
  if (isKnown(total) && isKnown(liveStars)) step = Math.round(Math.min(1, liveStars / total) * STRAIN_STEPS);
  if (step !== strainStep) {
    if ((step < 0) !== (strainStep < 0)) strain.hidden = step < 0;
    strainStep = step;
    if (step >= 0) strainFill.style.transform = strainTransforms[step];
  }
  let bpm = ctx.parsed ? known(values[P.bpmLive], true) : NaN;
  if (!isKnown(bpm) && ctx.parsed) bpm = known(values[P.bpmCommon], true);
  const bpmLabel = bpmText(bpm);
  if (bpmLabel !== shown.bpm) {
    // A timing change mid-map: the new BPM settles in (not on load or a map change).
    if (shownBpm !== null && motion === 'full' && bpmLabel !== DASH && shownBpm !== DASH) { bpmNudge.currentTime = 0; bpmNudge.play(); }
    shownBpm = bpmLabel;
    text('bpm', bpmLabel);
  }
}

function renderProgress() {
  if (!ctx.show) { setKiai(false); return; }
  const t = live.t;
  let step = t === null ? -1 : locate(t);
  if (step < 0) step = exact(t);
  if (step !== barStep) {
    barStep = step;
    bar.style.transform = barTransforms[step];
  }
  setKiai(kiai.on && kiai.moving);
}

/** The shared formula, for times next to a step edge, no clock or no span. */
function exact(t) {
  const p = t === null ? NaN : clock.progress(t);
  const step = isKnown(p) ? Math.round(p * barSteps) : 0;
  if (table.n >= 0) table.at = step;
  return step;
}

/** Step of the table whose certain range holds `t`, walking from the last one; -1 when unsure. */
function locate(t) {
  let k = table.at;
  if (k < 0) return -1;
  const { lo, hi, n } = table;
  while (k < n && t > hi[k]) k++;
  while (k > 0 && t < lo[k]) k--;
  if (t < lo[k] || t > hi[k]) return -1;
  table.at = k;
  return k;
}

/** Rebuilds the step table when the clock's span or the step count changed. */
function buildTable() {
  const start = isKnown(clock.end) ? clock.start : null;
  const end = isKnown(clock.end) ? clock.end : null;
  if (start === built.start && end === built.end && barSteps === built.steps) return;
  built.start = start;
  built.end = end;
  built.steps = barSteps;
  const n = end === null ? -1 : barSteps;
  if (table.lo.length <= n) {
    table.lo = new Int32Array(n + 1);
    table.hi = new Int32Array(n + 1);
  }
  // Step k spans start + (k ± 0.5) · span / steps: round(progress · steps) = k.
  const unit = end === null ? 0 : (end - start) / barSteps;
  for (let k = 0; k <= n; k++) {
    table.lo[k] = k === 0 ? -FAR : Math.ceil(start + (k - 0.5) * unit + SLACK);
    table.hi[k] = k === n ? FAR : Math.floor(start + (k + 0.5) * unit - SLACK);
  }
  table.n = n;
  table.at = -1;
}

/** Kiai ambience on the hairline while kiai is on and the clock moves; a watchdog stops it on a pause. */
function setKiai(on) {
  if (on !== kiai.shown) {
    kiai.shown = on;
    attr(prog, 'data-kiai', on ? '' : null);
  }
  if (on && !kiai.timer) kiai.timer = setTimeout(watchKiai, STILL_MS);
}
function watchKiai() {
  kiai.timer = 0;
  // No new map time since the last check: paused, frozen or the data stopped.
  if (kiai.ticks === kiai.seen) kiai.moving = false;
  kiai.seen = kiai.ticks;
  setKiai(ctx.show && kiai.on && kiai.moving);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function str(value) {
  return typeof value === 'string' ? value : '';
}

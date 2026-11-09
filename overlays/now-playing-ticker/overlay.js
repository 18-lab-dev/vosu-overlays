// Copyright (c) 2026 18-LAB. MIT.
// Now playing ticker: during gameplay, the map in one line (artist — title [diff], stars, mods,
// mapper) with a play-progress hairline. Built on the 18-LAB overlay kit (docs/overlay-system.md).
// The page is the overlay's box: it re-flows to a single line, a two-line stack or a side column
// from the box it is given. Song select and results already show all of this, so nothing appears
// there. A line too long for the box scrolls through once when a map starts, then rests with an
// ellipsis: no constant motion at the edge of the player's vision.
import {
  subscribe, settings, activeMode, mapPalette, applyPalette, applyKitSettings, known, isKnown,
  numberFormatter, createMapClock, MOTION_MS,
} from './vosu-overlay.js';

const PLAYING = 2;
// `align: auto` per ruleset, matching the placements: centred in the top slot (osu!, taiko,
// catch), against the stage's left edge in mania.
const AUTO_ALIGN = { osu: 'center', fruits: 'center', taiko: 'center', mania: 'right' };

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  artist: '/beatmap/artist',
  artistUnicode: '/beatmap/artistUnicode',
  title: '/beatmap/title',
  titleUnicode: '/beatmap/titleUnicode',
  version: '/beatmap/version',
  mapper: '/beatmap/mapper',
  checksum: '/beatmap/checksum',
  stars: '/beatmap/stats/stars/total',
  mods: '/play/mods/array',
  kiai: '/beatmap/isKiai',
  // createMapClock().sample() order (MAP_TIME_POINTERS).
  live: '/beatmap/time/live',
  rate: '/beatmap/time/rate',
  first: '/beatmap/time/firstObject',
  last: '/beatmap/time/lastObject',
  mp3: '/beatmap/time/mp3Length',
};
const META = [P.state, P.artist, P.artistUnicode, P.title, P.titleUnicode, P.version, P.mapper, P.checksum, P.stars, P.mods];
const MODE = [P.state, P.playMode, P.settingsMode];
const TIME = [P.state, P.live, P.rate, P.first, P.last, P.mp3];
const SPAN = [P.state, P.rate, P.first, P.last, P.mp3];
const KIAI = [P.state, P.kiai];
const RATE_MODS = new Set(['DT', 'NC', 'HT', 'DC']);
// A title's trailing "(covered by …)", "[TV Size]", "【…】": shown at text weight after the title.
const SUFFIX = /^(.+?)\s*([([（【].*)$/;

const $ = selector => document.querySelector(selector);
const root = $('#root');
const panel = $('#panel');
const fill = $('.prog i');
const prog = $('.prog');
const vp = $('.vp');
const track = $('.track');
const el = {
  status: $('#status'), artist: $('.artist'), sep: $('.sep'), title: $('.title'), suffix: $('.suffix'),
  version: $('.ver'), stars: $('.stars'), starsNum: $('.stars .num'),
  mods: $('.mods'), modCodes: $('.mods .codes'), modRate: $('.mods .rate'), modRateNum: $('.mods .rate .num'),
  mapper: $('.mapper'), mapperName: $('.mapper .name'),
};
const formatStars = numberFormatter('stars');
const formatRate = numberFormatter('rate');
const clock = createMapClock();

// ------------------------------------------------------------------ state
const defaults = {
  orientation: 'auto', align: 'auto', motion: 'full', backing: 'scrim', mapTint: true,
  unicode: false, showStars: true, showProgress: true, showMods: true, showMapper: true, overflow: 'once',
};
let opts = { ...defaults };
let motion = 'full';
let link = 'connecting';
let values = null;
let target = null;      // content the data asks for
let shown = null;       // content on screen
let visible = true;
let rolling = false;
let contentDirty = false;
let progressDirty = false;
let layoutDirty = true;
let layout = 'line';
let paletteKey = null;
let wantPlaying = false;
let wantStep = 0;      // progress is wantStep / wantSteps, quantized to device pixels of the rule
let wantSteps = 120;
let shownPlaying = false;
let shownStep = -1;
let shownSteps = 0;
let ruleSteps = 120;   // device pixels along the rule (at least 120), measured on resize and layout
let kiai = false;
// The map clock's span is sampled only when it changes (first/last object, audio length, rate);
// a clock message then finds its step in a table of whole-millisecond map-time ranges, the same
// progress as clock.progress() without arithmetic per message (nothing boxed). Entry k holds
// [lo[k], hi[k]], the times certainly inside step k; a time within SLACK-and-rounding of an edge
// takes clock.progress() instead.
const FAR = 1e9; // ms past either end of any map, still a small integer
const SLACK = 1e-3; // ms kept off each edge against rounding
const stepTable = { lo: new Int32Array(0), hi: new Int32Array(0), n: -1, at: -1, start: NaN, end: NaN };
let spanDirty = true;
// `scaleX(k / steps)` (`scaleY` in the column) for every step of the rule, built when the axis or
// step count changes, so a step change writes a kept string.
let ruleTransforms = [];
let ruleAxis = '';
let panelWidth = 0;
let panelHeight = 0;
let fitDirty = false;
let raf = 0;

const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
const text = (node, value) => { if (node.$text !== value) { node.$text = value; node.textContent = value; } };
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const flag = (node, name, on) => { if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on); };
const str = value => (typeof value === 'string' ? value.trim() : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** What the line should say. Gameplay only; transport and "osu! not running" get a small chip. */
function compose() {
  if (link !== 'live') return { kind: 'status', key: `status:${link}`, status: link };
  const v = values;
  if (v[P.state] === undefined) return { kind: 'empty', key: 'empty' };
  if (v[P.state] !== PLAYING) return { kind: 'hidden', key: shown?.key ?? 'hidden' };
  const prefer = (unicode, roman) => (opts.unicode ? str(v[unicode]) || str(v[roman]) : str(v[roman]) || str(v[unicode]));
  const artist = prefer(P.artistUnicode, P.artist);
  const title = prefer(P.titleUnicode, P.title);
  if (!artist && !title) return { kind: 'empty', key: 'empty' };
  const split = SUFFIX.exec(title);
  const version = str(v[P.version]);
  let codes = '';
  let rate = NaN;
  if (Array.isArray(v[P.mods])) for (const mod of v[P.mods]) {
    const acronym = str(mod?.acronym);
    if (!acronym) continue;
    codes += acronym;
    const speed = Number(mod?.settings?.speed_change);
    if (RATE_MODS.has(acronym) && Number.isFinite(speed) && speed > 0) rate = speed;
  }
  return {
    kind: 'map',
    key: str(v[P.checksum]) || `${str(v[P.artist])}|${str(v[P.title])}|${version}`,
    artist, version,
    titleName: split ? split[1] : title,
    titleSuffix: split ? split[2] : '',
    mapper: str(v[P.mapper]),
    stars: known(v[P.stars], true),
    codes, rate,
  };
}

function refresh() {
  target = compose();
  contentDirty = true;
  schedule();
  // The map tint is derived once per map, off the render path. Song select already carries the
  // next map's checksum, so the tint is ready when play starts.
  const checksum = opts.mapTint && link === 'live' ? str(values?.[P.checksum]) : '';
  if (checksum === paletteKey) return;
  paletteKey = checksum;
  if (!checksum) { applyPalette(panel, null); return; }
  mapPalette(checksum).then(palette => { if (paletteKey === checksum) applyPalette(panel, palette); });
}

/** Progress from the set's one map clock, quantized to device pixels of the rule. */
function updateProgress() {
  const v = values;
  const playing = link === 'live' && v[P.state] === PLAYING;
  let step = 0;
  if (playing) {
    if (spanDirty) {
      spanDirty = false;
      clock.sample(v[P.live], v[P.rate], v[P.first], v[P.last], v[P.mp3], 0);
    }
    if (isKnown(clock.end)) {
      if (clock.start !== stepTable.start || clock.end !== stepTable.end || ruleSteps !== stepTable.n) {
        stepTable.start = clock.start;
        stepTable.end = clock.end;
        // Step k spans start + (k ± 0.5) · (end - start) / steps.
        fillTable(stepTable, ruleSteps, clock.start, (clock.end - clock.start) / ruleSteps, 0.5);
      }
      const live = v[P.live];
      if (typeof live === 'number') {
        step = locate(stepTable, live);
        if (step < 0) step = stepTable.at = Math.round(clock.progress(live) * ruleSteps);
      }
    }
  }
  if (playing === wantPlaying && step === wantStep && ruleSteps === wantSteps) return;
  wantPlaying = playing;
  wantStep = step;
  wantSteps = ruleSteps;
  progressDirty = true;
  schedule();
}

/** Entry of `table` whose certain range holds `t`, walking from the last one; -1 when unsure. */
function locate(table, t) {
  let k = table.at;
  if (k < 0) return -1;
  const { lo, hi, n } = table;
  while (k < n && t > hi[k]) k++;
  while (k > 0 && t < lo[k]) k--;
  if (t < lo[k] || t > hi[k]) return -1;
  table.at = k;
  return k;
}

/** Entries 0..n with edges at origin + (k - offset) · unit; the outer two reach FAR. */
function fillTable(table, n, origin, unit, offset) {
  if (table.lo.length <= n) {
    const size = Math.max(n + 1, table.lo.length * 2);
    table.lo = new Int32Array(size);
    table.hi = new Int32Array(size);
  }
  const { lo, hi } = table;
  for (let k = 0; k <= n; k++) {
    lo[k] = k === 0 ? -FAR : Math.ceil(origin + (k - offset) * unit + SLACK);
    hi[k] = k === n ? FAR : Math.floor(origin + (k + 1 - offset) * unit - SLACK);
  }
  table.n = n;
  table.at = -1;
}

/** Kiai lifts the progress rule (motion=full only): one transition in, one out. */
function updateKiai() {
  const on = motion === 'full' && link === 'live' && values[P.state] === PLAYING && values[P.kiai] === true;
  if (on === kiai) return;
  kiai = on;
  flag(panel, 'data-kiai', on);
}

/** The rule's length in device pixels sets its steps (read on resize and layout, not per message). */
function measureSteps() {
  const pad = layout === 'column' ? 2 * parseFloat(getComputedStyle(panel).paddingTop) : 2 * parseFloat(getComputedStyle(panel).paddingLeft);
  ruleSteps = Math.max(120, Math.round(((layout === 'column' ? panelHeight : panelWidth) - pad) * devicePixelRatio));
}
// A device-pixel-ratio change (zoom, another monitor) re-measures as well.
function watchPixelRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { measureSteps(); watchPixelRatio(); }, { once: true });
}
watchPixelRatio();

// ------------------------------------------------------------------ layout from the box
/**
 * Picks the arrangement for the page's box and sets the kit's unit from it: a single line for a
 * flat box (32 px tall at --u 1), a two-line stack once the box is about 66 px tall or more, a
 * column for an upright box (256 px wide at --u 1).
 */
function relayout() {
  const w = innerWidth, h = innerHeight;
  let next = opts.orientation === 'vertical' ? 'column' : opts.orientation === 'horizontal' ? 'line' : w / h < 1.4 ? 'column' : 'line';
  if (next === 'line' && h >= 66) next = 'stack';
  const unit = next === 'column' ? w / 256 : next === 'stack' ? h / 72 : h / 32;
  layout = next;
  attr(root, 'data-layout', next);
  panel.style.setProperty('--u', Math.min(2.4, Math.max(0.5, unit)).toFixed(3));
  const v = values || {};
  const mode = activeMode(v[P.state], v[P.playMode], v[P.settingsMode]) || 'osu';
  attr(root, 'data-align', opts.align === 'auto' ? AUTO_ALIGN[mode] : opts.align);
  // The rule changes axis with the layout: redraw it from scratch.
  fill.style.transform = '';
  shownStep = -1;
  measureSteps();
  progressDirty = true;
  if (values) updateProgress();
  park();
  fitDirty = true;
}

// ------------------------------------------------------------------ render (rAF only)
function frame() {
  raf = 0;
  if (layoutDirty) { layoutDirty = false; relayout(); }
  if (contentDirty && !rolling) {
    contentDirty = false;
    const show = target.kind !== 'hidden';
    const wasVisible = visible;
    if (show !== visible) {
      visible = show;
      attr(root, 'data-show', show ? 'on' : 'off');
      if (!show) park();
    }
    if (show) {
      if (!shown || target.key !== shown.key || target.kind !== shown.kind) rollTo(!wasVisible);
      else apply(target);
      if (!wasVisible) revealLater();
    }
  }
  if (progressDirty) {
    progressDirty = false;
    if (wantPlaying !== shownPlaying) { shownPlaying = wantPlaying; panel.classList.toggle('playing', wantPlaying); }
    if (wantPlaying && (wantStep !== shownStep || wantSteps !== shownSteps)) {
      shownStep = wantStep;
      shownSteps = wantSteps;
      fill.style.transform = ruleTransform(wantStep, wantSteps);
    }
  }
  if (fitDirty) { fitDirty = false; fit(); }
}

/**
 * The map line is the job: when it would be cut (line) or the column runs out of height, the
 * mapper goes first (data-fit="compact"). The stack has a line of its own for it. One layout read
 * per map or box change, never per message.
 */
function fit() {
  attr(panel, 'data-fit', '');
  if (layout === 'stack' || !shown || shown.kind !== 'map' || el.mapper.hidden) return;
  const cut = layout === 'column' ? panel.scrollHeight > panel.clientHeight + 1 : overflowing();
  if (cut) attr(panel, 'data-fit', 'compact');
}

function ruleTransform(step, steps) {
  const axis = layout === 'column' ? 'scaleY' : 'scaleX';
  if (axis !== ruleAxis || ruleTransforms.length !== steps + 1) {
    ruleAxis = axis;
    ruleTransforms = new Array(steps + 1);
    for (let k = 0; k <= steps; k++) ruleTransforms[k] = `${axis}(${k / steps})`;
  }
  return ruleTransforms[step];
}

function apply(content) {
  const fresh = !shown || shown.key !== content.key;
  attr(panel, 'data-kind', content.kind);
  if (content.kind === 'status') {
    text(el.status, content.status === 'offline' ? 'vosu offline' : 'Connecting');
  } else if (content.kind === 'empty') {
    text(el.title, '—');
    hide(el.title, false);
  } else {
    text(el.artist, content.artist);
    text(el.title, content.titleName);
    text(el.suffix, content.titleSuffix);
    hide(el.suffix, !content.titleSuffix);
    text(el.version, content.version);
    hide(el.artist, !content.artist);
    hide(el.sep, !content.artist || !content.titleName);
    hide(el.title, !content.titleName);
    hide(el.version, !content.version);
    // Unknown stars (an unparsed map reports 0) hide the segment rather than print a dash.
    text(el.starsNum, formatStars(content.stars));
    hide(el.stars, !opts.showStars || !isKnown(content.stars));
    text(el.modCodes, content.codes);
    text(el.modRateNum, formatRate(content.rate));
    hide(el.modRate, !isKnown(content.rate));
    hide(el.mods, !opts.showMods || !content.codes);
    text(el.mapperName, content.mapper);
    hide(el.mapper, !opts.showMapper || !content.mapper);
  }
  hide(prog, !opts.showProgress);
  shown = content;
  if (fresh) { park(); fitDirty = true; schedule(); }
}

// ------------------------------------------------------------------ map change
// Created once and restarted: the strip leaves up and fades (fast, ease-in), the new map settles
// in from below (slow, expo-out). Same strip, same backing; the width change happens unseen.
const ROLL_OUT = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }];
const ROLL_IN = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];
const rollOut = panel.animate(ROLL_OUT, { duration: MOTION_MS.fast, easing: 'cubic-bezier(0.7, 0, 0.84, 0)', fill: 'forwards' });
const rollIn = panel.animate(ROLL_IN, { duration: MOTION_MS.slow, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' });
rollOut.cancel();
rollIn.cancel();
rollOut.onfinish = () => {
  apply(target);
  rollIn.play();
  rollOut.cancel();
};
rollIn.onfinish = () => {
  rolling = false;
  revealLater();
  contentDirty = true;
  schedule();
};

/** Map change on screen. Coming back from song select the strip enters as a whole (CSS). */
function rollTo(instant) {
  if (motion === 'off' || instant || !shown) { apply(target); return; }
  rolling = true;
  rollOut.play();
}

// ------------------------------------------------------------------ long lines: scroll once, then rest
// A line wider than the box rests with an ellipsis (the title's "(…)" suffix and the difficulty
// give way before the title). The first time a map is played this session (not on retries), it
// scrolls through once after a short hold, holds at the end, returns and rests. motion=full only.
const HOLD_MS = 1400;
const END_HOLD_MS = 1600;
const READ_PX_PER_S = 48;
let revealedKey = null;
let revealTimer = 0;
let revealOut = null;
let revealBack = null;

function park() {
  clearTimeout(revealTimer);
  revealTimer = 0;
  revealOut?.cancel();
  revealBack?.cancel();
  revealOut = revealBack = null;
  flag(vp, 'data-scroll', false);
  attr(vp, 'data-edge', '');
}

function revealLater() {
  if (!shown || shown.kind !== 'map' || shown.key === revealedKey) return;
  revealedKey = shown.key;
  if (motion !== 'full' || opts.overflow !== 'once' || layout === 'column') return;
  revealTimer = setTimeout(reveal, HOLD_MS);
}

function overflowing() {
  return el.title.scrollWidth > el.title.clientWidth + 1 || el.suffix.scrollWidth > el.suffix.clientWidth + 1
    || el.artist.scrollWidth > el.artist.clientWidth + 1 || el.version.scrollWidth > el.version.clientWidth + 1;
}

function reveal() {
  revealTimer = 0;
  if (!visible || !overflowing()) return;
  flag(vp, 'data-scroll', true);
  const distance = track.offsetWidth - vp.clientWidth;
  if (distance <= 1) { park(); return; }
  attr(vp, 'data-edge', 'lr');
  revealOut = track.animate([{ transform: 'none' }, { transform: `translateX(${-distance}px)` }],
    { duration: Math.max(1600, distance / READ_PX_PER_S * 1000), easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' });
  revealOut.onfinish = () => {
    attr(vp, 'data-edge', 'l');
    revealTimer = setTimeout(() => {
      revealTimer = 0;
      attr(vp, 'data-edge', 'lr');
      revealBack = track.animate([{ transform: `translateX(${-distance}px)` }, { transform: 'none' }],
        { duration: Math.max(MOTION_MS.slow, distance / 240 * 1000), easing: 'cubic-bezier(0.65, 0, 0.2, 1)', fill: 'forwards' });
      revealBack.onfinish = park;
    }, END_HOLD_MS);
  };
}

// ------------------------------------------------------------------ sizes
const sizes = new ResizeObserver(entries => {
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    panelWidth = box?.inlineSize ?? entry.contentRect.width;
    panelHeight = box?.blockSize ?? entry.contentRect.height;
  }
  measureSteps(); // the rule's length sets its step count
  if (values) updateProgress();
});
sizes.observe(panel);
// Hosts (OBS source size, vosulay width/height, the replay renderer's cell) resize the page.
addEventListener('resize', () => { layoutDirty = true; schedule(); });
// The line's fit is measured in the kit's fonts; measure again once they have loaded.
document.fonts.addEventListener('loadingdone', () => { fitDirty = true; schedule(); });

// ------------------------------------------------------------------ inputs
settings(defaults, next => {
  opts = {
    ...next,
    orientation: pick(next.orientation, ['auto', 'horizontal', 'vertical'], 'auto'),
    align: pick(next.align, ['auto', 'left', 'center', 'right'], 'auto'),
    overflow: pick(next.overflow, ['once', 'truncate'], 'once'),
  };
  motion = applyKitSettings(panel, opts);
  if (motion === 'off') { rollOut.cancel(); rollIn.cancel(); rolling = false; }
  layoutDirty = true;
  paletteKey = null;
  if (values) { refresh(); updateKiai(); }
  schedule();
});

/** Whether this frame touched any of `pointers` (a loop, not `some`: no closure per message). */
function touches(pointers, changed) {
  for (let i = 0; i < pointers.length; i++) if (changed.has(pointers[i])) return true;
  return false;
}

const subscription = subscribe(Object.values(P), (next, changed) => {
  values = next;
  if (opts.align === 'auto' && touches(MODE, changed)) { layoutDirty = true; schedule(); }
  if (touches(META, changed)) refresh();
  if (touches(SPAN, changed)) spanDirty = true;
  if (touches(TIME, changed)) updateProgress();
  if (touches(KIAI, changed)) updateKiai();
}, {
  // The shared client reports 'live' on every frame; act on transitions only.
  onStatus(state) {
    if (state === link) return;
    link = state;
    if (!values) return;
    refresh();
    spanDirty = true;
    updateProgress();
    updateKiai();
  },
});
values = subscription.values;
refresh();

// Copyright (c) 2026 18-LAB. MIT.
// Now playing: the map's identity, live star rating/BPM, mod-adjusted settings and progress
// during gameplay. Song select and results already show all of this, so the page stays empty
// there. The page is content-sized: it lays out for whatever box its host (OBS, vosulay, the
// replay renderer) gives it — a column for tall boxes, a strip for wide ones.
import { subscribe, settings, activeMode, formatDuration, mapPalette, applyPalette } from './vosu-overlay.js';

// Design sizes of the two arrangements; type and spacing scale with the box against these.
const BASE = { vertical: [260, 244], horizontal: [820, 104] };
const WIDE = 2.2; // auto orientation: boxes at least this many times wider than tall get the strip

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  title: '/beatmap/title', titleUnicode: '/beatmap/titleUnicode', artist: '/beatmap/artist', artistUnicode: '/beatmap/artistUnicode',
  version: '/beatmap/version', mapper: '/beatmap/mapper', checksum: '/beatmap/checksum', isConvert: '/beatmap/isConvert',
  first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', mp3: '/beatmap/time/mp3Length', clockRate: '/beatmap/time/rate',
  starsLive: '/beatmap/stats/stars/live', starsTotal: '/beatmap/stats/stars/total',
  arO: '/beatmap/stats/ar/original', arC: '/beatmap/stats/ar/converted', csO: '/beatmap/stats/cs/original', csC: '/beatmap/stats/cs/converted',
  odO: '/beatmap/stats/od/original', odC: '/beatmap/stats/od/converted', hpO: '/beatmap/stats/hp/original', hpC: '/beatmap/stats/hp/converted',
  bpmLive: '/beatmap/stats/bpm/realtime', bpmCommon: '/beatmap/stats/bpm/common', bpmMin: '/beatmap/stats/bpm/min', bpmMax: '/beatmap/stats/bpm/max',
  mods: '/play/mods/array', modsRate: '/play/mods/rate',
};
const LIVE = '/beatmap/time/live';
const PLAYING = 2;
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)'; // --ease-draft

// Difficulty settings that mean something while playing each ruleset: taiko has no approach rate
// or circle size, catch has no timing windows, and a mania player is looking at the key count.
const CELLS = { osu: ['ar', 'cs', 'od', 'hp'], taiko: ['od', 'hp'], fruits: ['ar', 'cs', 'hp'], mania: ['od', 'hp'] };
// align = auto mirrors the suggested placements: osu!/catch top-right and taiko bottom-right
// hug the right edge, mania sits in the top-left corner.
const AUTO_ALIGN = { osu: 'end', fruits: 'end', taiko: 'end', mania: 'start' };

const $ = id => document.getElementById(id);
const root = document.documentElement;
const np = $('np');
const chip = $('chip');
const bar = $('bar');
const modsEl = $('mods');
const mapperWrap = $('mapperWrap');

const fields = {};
for (const el of document.querySelectorAll('[data-f]')) (fields[el.dataset.f] ||= []).push(el);
const shown = {};
function text(key, value) {
  if (shown[key] === value) return;
  shown[key] = value;
  const list = fields[key];
  for (let i = 0; i < list.length; i++) write(list[i], value);
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
  cells[el.dataset.k] = { el, from: el.querySelector('.from'), to: el.querySelector('.to'), cache: {} };
}
function cellText(cell, part, value) {
  if (cell.cache[part] === value) return;
  cell.cache[part] = value;
  write(cell[part], value);
}

// ------------------------------------------------------------------ state
let opts = {
  layout: 'full', orientation: 'auto', align: 'auto', unicode: false, showStats: true, backing: 'none', accent: 'map',
};
let values = {};
// The map clock in an object field: a module-level `let` holding a fractional number is boxed
// afresh on every read, an object field hands the parsed number through as is.
const clock = { live: null };
let liveSub = null;
let conn = 'connecting';
let dirty = true;
let liveDirty = false;
let progressDirty = false;
let frame = 0;
const ctx = { show: false, parsed: false, rate: 1, start: 0, length: 0 };
// Last numbers behind the live readouts, so text is formatted only when they change. Fields start
// as null (tagged): double-typed fields would box a fresh number on every read outside optimised code.
const last = { stars: null, bpm: null };
// The hairline's steps and the clock's seconds as whole-millisecond map-time ranges, built when
// the map, rate or box changes: a clock message then only compares the time against them (no
// arithmetic, so nothing is boxed even before V8 optimises). Entry k holds [lo[k], hi[k]], the
// times certainly inside step/second k; a time within SLACK-and-rounding of an edge, or before
// the tables exist, takes the exact formula instead.
const FAR = 1e9; // ms past either end of any map, still a small integer
const SLACK = 1e-3; // ms kept off each edge against rounding
const stepTable = { lo: new Int32Array(0), hi: new Int32Array(0), n: -1, at: -1 }; // n -1: not built
const secondTable = { lo: new Int32Array(0), hi: new Int32Array(0), n: -1, at: -1 };
const built = { start: -1, length: -1, rate: -1, steps: -1 };
let shownChecksum;
let shownMode;
let paletteFor = '';
let barSteps = 1200;
// `scaleX(k / barSteps)` for every step, built with the step count (on resize) so a step change
// writes a kept string: the same text, and so the same pixels, as formatting it there and then.
let barTransforms = [];
let barStep = -1; // integer step of the hairline on screen; -1 forces the next write
let shownSecond = -1;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = value => (typeof value === 'string' ? value : '');
const fmt = value => String(Math.round(value * 100) / 100);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

subscribe(Object.values(P), (snapshot, changed) => {
  values = snapshot;
  // The map clock is only worth sampling during an attempt: outside play it would wake vosu's
  // fast reader for the song-select preview, which this overlay never shows.
  const state = snapshot[P.state];
  if (state === PLAYING && !liveSub) {
    liveSub = subscribe([LIVE], v => { clock.live = v[LIVE]; progressDirty = true; schedule(); });
  } else if (state !== PLAYING && liveSub) {
    liveSub.close();
    liveSub = null;
    clock.live = null;
  }
  // Live stars and realtime BPM tick throughout play; they only need their own two readouts.
  const hot = (changed.has(P.starsLive) ? 1 : 0) + (changed.has(P.bpmLive) ? 1 : 0);
  if (changed.size > hot) dirty = true;
  else if (changed.size) liveDirty = true;
  if (changed.size) schedule();
}, {
  onStatus: state => { if (state !== conn) { conn = state; dirty = true; schedule(); } },
});

settings(opts, next => {
  const accentChanged = next.accent !== opts.accent;
  opts = next;
  if (accentChanged) loadPalette(paletteFor);
  layoutBox();
  dirty = true;
  schedule();
});

/** Orientation and type scale from the page's box (runs on resize and setting changes only). */
function layoutBox() {
  const w = innerWidth || BASE.vertical[0];
  const h = innerHeight || BASE.vertical[1];
  const orient = opts.orientation === 'horizontal' || opts.orientation === 'vertical' ? opts.orientation : w / h >= WIDE ? 'horizontal' : 'vertical';
  const [bw, bh] = BASE[orient];
  attr(np, 'data-orient', orient);
  root.style.setProperty('--u', String(Math.round(clamp(Math.min(w / bw, h / bh), 0.5, 4) * 1000) / 1000));
  barSteps = Math.max(200, Math.round(w * 2));
  if (barTransforms.length !== barSteps + 1) {
    barTransforms = new Array(barSteps + 1);
    for (let k = 0; k <= barSteps; k++) barTransforms[k] = `scaleX(${k / barSteps})`;
  }
  barStep = -1;
  buildTables();
  progressDirty = true;
  schedule();
}
addEventListener('resize', layoutBox);

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
  ctx.parsed = hasMap && ((num(values[P.bpmCommon]) ?? 0) > 0 || (num(values[P.last]) ?? 0) > 0);

  // Tint follows the selected map (loaded in song select already, so play starts tinted).
  const checksum = online ? str(values[P.checksum]) : '';
  if (checksum && checksum !== paletteFor) loadPalette(checksum);

  const align = opts.align === 'left' ? 'start' : opts.align === 'right' ? 'end' : AUTO_ALIGN[mode] || 'end';
  attr(np, 'data-align', align);
  attr(chip, 'data-align', align);

  // Tiny status line in the box; nothing at all in menus, song select and results.
  let status = '';
  if (!online) status = conn === 'offline' ? 'vosu offline' : 'Connecting';
  else if (state === undefined) status = 'osu! not running';
  else if (playing && !hasMap) status = 'No map data';
  text('chip', status);
  chip.hidden = !status;
  attr(chip, 'data-s', online ? null : conn);

  attr(np, 'data-show', hasMap ? '' : null);
  attr(np, 'data-layout', opts.layout === 'compact' ? 'compact' : 'full');
  attr(np, 'data-stats', opts.showStats ? 'on' : 'off');
  attr(np, 'data-backing', opts.backing === 'scrim' || opts.backing === 'panel' ? opts.backing : 'none');
  if (!hasMap) return; // keep the last map's text in place while the strip fades out

  const pick = (plain, unicode) => (opts.unicode && str(values[unicode]).trim() ? str(values[unicode]) : str(values[plain]));
  text('title', pick(P.title, P.titleUnicode) || '—');
  text('artist', pick(P.artist, P.artistUnicode));
  text('version', str(values[P.version]));
  const mapper = str(values[P.mapper]);
  text('mapper', mapper);
  mapperWrap.hidden = !mapper;
  if (checksum !== shownChecksum) {
    // Fade the identity in on a real map change, not when the source first loads.
    if (checksum && shownChecksum) $('ident').animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
    shownChecksum = checksum;
  }

  // Length: the hit-object span in map time (the audio length when the map is not parsed), at
  // the mods' clock rate. vosu's object times are not rate-adjusted; its BPM values are.
  ctx.rate = rate();
  const first = num(values[P.first]) ?? 0;
  const last = num(values[P.last]);
  const mp3 = num(values[P.mp3]);
  if (last && last > first) { ctx.start = first; ctx.length = last - first; }
  else if (mp3 && mp3 > 0) { ctx.start = 0; ctx.length = mp3; }
  else ctx.length = 0;
  text('total', ctx.length ? formatDuration(ctx.length / ctx.rate) : '—');

  const total = ctx.parsed ? num(values[P.starsTotal]) : null;
  text('starsOf', total ? `of ${total.toFixed(2)}` : '');
  const lo = ctx.parsed ? num(values[P.bpmMin]) : null;
  const hi = ctx.parsed ? num(values[P.bpmMax]) : null;
  text('bpmRange', lo && hi && Math.round(lo) !== Math.round(hi) ? `${Math.round(lo)}–${Math.round(hi)}` : '');

  renderMods();
  renderStats(mode, mode !== 'osu' && values[P.isConvert] === true);
  renderLive();
  buildTables(); // start, length or rate may have moved
  progressDirty = true;
}

function rate() {
  return num(values[P.modsRate]) || num(values[P.clockRate]) || 1;
}

function loadPalette(checksum) {
  paletteFor = checksum;
  if (!checksum || opts.accent !== 'map') { applyPalette(root, null); return; }
  mapPalette(checksum).then(palette => {
    if (paletteFor === checksum && opts.accent === 'map') applyPalette(root, palette);
  });
}

let shownMods = null;
function renderMods() {
  const list = Array.isArray(values[P.mods]) ? values[P.mods] : [];
  const r = rate();
  const acronyms = list.map(m => str(m?.acronym)).filter(Boolean);
  const key = `${acronyms.join(' ')}|${r}`;
  if (key === shownMods) return;
  shownMods = key;
  const chips = acronyms.map(acronym => chipEl(acronym, 'mod'));
  if (Math.abs(r - 1) > 1e-4) chips.push(chipEl(`${(Math.round(r * 100) / 100).toFixed(2)}×`, 'mod rate'));
  modsEl.replaceChildren(...chips);
}
function chipEl(label, className) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = label;
  return el;
}

function renderStats(mode, convert) {
  const { parsed } = ctx;
  if (mode !== shownMode) {
    shownMode = mode;
    const visible = CELLS[mode] || CELLS.osu;
    for (const k of ['ar', 'cs', 'od', 'hp']) cells[k].el.hidden = !visible.includes(k);
  }
  for (const k of ['ar', 'cs', 'od', 'hp']) {
    const cell = cells[k];
    if (cell.el.hidden) continue;
    const original = parsed ? num(values[P[`${k}O`]]) : null;
    const converted = parsed ? num(values[P[`${k}C`]]) : null;
    let to = '—', from = '', d = null;
    if (converted !== null) {
      to = fmt(converted);
      // A convert's original values belong to the osu! map, not to this ruleset.
      if (!convert && original !== null && Math.abs(converted - original) >= 0.005) {
        from = `${fmt(original)}→`;
        d = converted > original ? 'up' : 'down';
      }
    }
    cellText(cell, 'to', to);
    cellText(cell, 'from', from);
    attr(cell.el, 'data-d', d);
  }
}

/** Live star rating and realtime BPM (vosu reports 0 for an unparsed map: "no value"). */
function renderLive() {
  if (!ctx.show) return;
  const stars = ctx.parsed ? num(values[P.starsLive]) || num(values[P.starsTotal]) || 0 : 0;
  if (stars !== last.stars) { last.stars = stars; text('stars', stars ? stars.toFixed(2) : '—'); }
  const bpm = ctx.parsed ? num(values[P.bpmLive]) || num(values[P.bpmCommon]) : null;
  const rounded = bpm ? Math.round(bpm) : null;
  // toFixed(0): same text as String() for an integer, without rebuilding V8's number-string cache.
  if (rounded !== last.bpm) { last.bpm = rounded; text('bpm', rounded === null ? '—' : rounded.toFixed(0)); }
}

function renderProgress() {
  if (!ctx.show) return;
  const t = num(clock.live);
  const step = t === null ? -1 : locate(stepTable, t);
  const second = step < 0 ? -1 : locate(secondTable, t);
  if (second < 0) { exact(t); return; }
  showSecond(second);
  showStep(step);
}

/** The exact formula: times next to an edge, no clock, no timing, or the first after a rebuild. */
function exact(t) {
  const { start, length, rate: r } = ctx;
  let scale = 0;
  if (length) {
    const elapsed = t === null ? 0 : Math.min(length, Math.max(0, t - start)) / r;
    scale = elapsed * r / length;
    const second = Math.floor(elapsed / 1000);
    if (secondTable.n >= 0) secondTable.at = second;
    showSecond(second);
  } else if (shownSecond !== -1) {
    shownSecond = -1;
    text('elapsed', '0:00');
  }
  // Quantised to half a CSS pixel of the box so a steady clock does not restyle every frame.
  const step = Math.round(scale * barSteps);
  if (stepTable.n >= 0) stepTable.at = step;
  showStep(step);
}

function showSecond(second) {
  if (second === shownSecond) return;
  shownSecond = second;
  // formatDuration floors to whole seconds: the second's start gives the same text.
  text('elapsed', formatDuration(second * 1000));
}

function showStep(step) {
  if (step === barStep) return;
  barStep = step;
  bar.style.transform = barTransforms[step];
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

/** Rebuilds the edge tables when the map's timing, the rate or the step count changed. */
function buildTables() {
  const { start, length, rate: r } = ctx;
  if (start === built.start && length === built.length && r === built.rate && barSteps === built.steps) return;
  built.start = start;
  built.length = length;
  built.rate = r;
  built.steps = barSteps;
  // Step k spans start + (k ± 0.5) · length / steps; second k spans start + [k, k + 1) · 1000 · rate.
  fillTable(stepTable, length ? barSteps : -1, start, length / barSteps, 0.5);
  fillTable(secondTable, length ? Math.floor(length / r / 1000) : -1, start, 1000 * r, 0);
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

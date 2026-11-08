// Copyright (c) 2026 18-LAB. MIT.
// Now playing: the selected map's identity and difficulty card, live during play.
import { subscribe, settings, fit, activeMode, formatDuration, backgroundUrl, MODE_LABELS } from './vosu-overlay.js';

const WIDTH = 600;
const HEIGHT = 320;

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', source: '/play/source',
  title: '/beatmap/title', titleUnicode: '/beatmap/titleUnicode', artist: '/beatmap/artist', artistUnicode: '/beatmap/artistUnicode',
  version: '/beatmap/version', mapper: '/beatmap/mapper', checksum: '/beatmap/checksum', status: '/beatmap/status/name',
  isConvert: '/beatmap/isConvert',
  first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', mp3: '/beatmap/time/mp3Length', clockRate: '/beatmap/time/rate',
  starsLive: '/beatmap/stats/stars/live', starsTotal: '/beatmap/stats/stars/total',
  arO: '/beatmap/stats/ar/original', arC: '/beatmap/stats/ar/converted', csO: '/beatmap/stats/cs/original', csC: '/beatmap/stats/cs/converted',
  odO: '/beatmap/stats/od/original', odC: '/beatmap/stats/od/converted', hpO: '/beatmap/stats/hp/original', hpC: '/beatmap/stats/hp/converted',
  bpmLive: '/beatmap/stats/bpm/realtime', bpmCommon: '/beatmap/stats/bpm/common', bpmMin: '/beatmap/stats/bpm/min', bpmMax: '/beatmap/stats/bpm/max',
  circles: '/beatmap/stats/objects/circles', sliders: '/beatmap/stats/objects/sliders', spinners: '/beatmap/stats/objects/spinners',
  holds: '/beatmap/stats/objects/holds', objects: '/beatmap/stats/objects/total', maxCombo: '/beatmap/stats/maxCombo',
  mods: '/play/mods/array', modsRate: '/play/mods/rate',
};
const LIVE = '/beatmap/time/live';
const PLAYING = 2;
const RESULTS = 7;
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)'; // --ease-draft

const PHASE_LABEL = { 0: 'Main menu', 1: 'Editor', 4: 'Editor', 5: 'Song select', 7: 'Results', 11: 'Lobby', 12: 'Match setup', 13: 'Song select', 15: 'Browsing' };
const SOURCE_LABEL = { player: 'Playing', replay: 'Replay', spectator: 'Spectating', autoplay: 'Autoplay', watching: 'Watching' };
const STATUS_LABEL = { ranked: 'Ranked', approved: 'Approved', qualified: 'Qualified', loved: 'Loved', pending: 'Pending', notSubmitted: 'Unsubmitted' };
// Which difficulty settings mean something in each ruleset (catch has no timing windows, taiko and
// mania have no approach rate or circle size; mania's CS is its key count).
const CELLS = {
  osu: ['ar', 'cs', 'od', 'hp'], taiko: ['od', 'hp'], fruits: ['ar', 'cs', 'hp'], mania: ['cs', 'od', 'hp'],
};
const PARTS = {
  osu: [['circles', 'circles'], ['sliders', 'sliders'], ['spinners', 'spinners']],
  taiko: [['circles', 'hits'], ['sliders', 'drumrolls'], ['spinners', 'swells']],
  fruits: [['circles', 'fruits'], ['sliders', 'streams'], ['spinners', 'bananas']],
  mania: [['circles', 'notes'], ['holds', 'holds']],
};

const $ = id => document.getElementById(id);
const card = $('card');
const stage = $('stage');
const band = $('band');
const bar = $('bar');
const statusEl = $('status');
const phaseEl = $('phase');
const connEl = $('conn');
const brandEl = $('brand');
const modsEl = $('mods');
const mapperWrap = $('mapperWrap');

const fields = {};
for (const el of document.querySelectorAll('[data-f]')) (fields[el.dataset.f] ||= []).push(el);
const shown = {};
function text(key, value) {
  if (shown[key] === value) return;
  shown[key] = value;
  for (const el of fields[key]) write(el, value);
}
/** Updates an element's single text node in place (no node churn); textContent otherwise. */
function write(el, value) {
  const node = el.firstChild;
  if (value && node && node.nodeType === 3 && !node.nextSibling) node.data = value;
  else el.textContent = value;
}

const cells = {};
for (const el of document.querySelectorAll('.cell')) {
  cells[el.dataset.k] = { el, label: el.querySelector('.label'), from: el.querySelector('.from'), to: el.querySelector('.to'), aux: el.querySelector('.aux'), cache: {} };
}
function cellText(cell, part, value) {
  if (cell.cache[part] === value) return;
  cell.cache[part] = value;
  write(cell[part], value);
}
function attr(el, name, value) {
  if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

const parts = [...document.querySelectorAll('[data-c]')].map(el => ({ el, n: el.firstElementChild, w: el.lastElementChild, cache: '' }));

// ------------------------------------------------------------------ state
let opts = { unicode: false, showBackground: true, showStats: true, layout: 'full', anchor: 'top', showBrand: true };
let values = {};
let live;
let liveSub = null;
let conn = 'connecting';
let dirty = true;
let liveDirty = false;
let progressDirty = false;
const HOT = new Set([P.starsLive, P.bpmLive]);
const ctx = { phase: 'none', playing: false, parsed: false, rate: 1, start: 0, length: 0, total: '', ofTotal: '' };
let frame = 0;
let shownChecksum;
let shownMode;
let barScale = -1;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = value => (typeof value === 'string' ? value : '');
const fmt = value => String(Math.round(value * 100) / 100);
const int = value => Math.round(value).toLocaleString('en-US');

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

subscribe(Object.values(P), (snapshot, changed) => {
  values = snapshot;
  const state = snapshot[P.state];
  // The map clock is only worth sampling during an attempt: outside play it would wake vosu's
  // fast reader for the song-select preview, which this card never shows.
  if (state === PLAYING && !liveSub) {
    liveSub = subscribe([LIVE], v => { live = v[LIVE]; progressDirty = true; schedule(); });
  } else if (state !== PLAYING && liveSub) {
    liveSub.close();
    liveSub = null;
    live = undefined;
  }
  // Live stars and realtime BPM tick throughout play; they only need their own two readouts.
  let full = false;
  for (const pointer of changed) if (!HOT.has(pointer)) { full = true; break; }
  if (full) dirty = true;
  else if (changed.size) liveDirty = true;
  if (changed.size) schedule();
}, {
  onStatus: state => { if (state !== conn) { conn = state; dirty = true; schedule(); } },
});

settings(opts, next => {
  const bgChanged = next.showBackground !== opts.showBackground;
  opts = next;
  if (bgChanged) loadBackground(shownChecksum);
  dirty = true;
  schedule();
});

fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------------ derived values
function rate() {
  return num(values[P.modsRate]) || num(values[P.clockRate]) || 1;
}

function phaseOf(state) {
  if (state === PLAYING) return 'play';
  if (state === RESULTS) return 'results';
  return state === undefined ? 'none' : 'menu';
}

// ------------------------------------------------------------------ render
function render() {
  frame = 0;
  if (dirty) { dirty = false; liveDirty = false; renderAll(); }
  if (liveDirty) { liveDirty = false; renderLive(); }
  if (progressDirty) { progressDirty = false; renderProgress(); }
}

function renderAll() {
  const state = values[P.state];
  const phase = conn === 'live' ? phaseOf(state) : 'none';
  const mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  const hasMap = phase !== 'none' && !!(str(values[P.title]) || str(values[P.checksum]));

  attr(card, 'data-phase', phase);
  attr(card, 'data-layout', opts.layout === 'compact' ? 'compact' : 'full');
  attr(card, 'data-bg', opts.showBackground ? 'on' : 'off');
  attr(card, 'data-stats', opts.showStats ? 'on' : 'off');
  attr(stage, 'data-anchor', opts.anchor === 'bottom' ? 'bottom' : 'top');
  brandEl.hidden = !opts.showBrand;

  // Head: connection chip only when not live; otherwise ranked status, ruleset and phase.
  connEl.hidden = conn === 'live';
  attr(connEl, 'data-s', conn);
  text('conn', conn === 'offline' ? 'vosu offline' : 'Connecting');
  const status = hasMap ? str(values[P.status]) : '';
  statusEl.hidden = !STATUS_LABEL[status];
  attr(statusEl, 'data-s', status || null);
  text('status', STATUS_LABEL[status] || '');
  const convert = mode && mode !== 'osu' && values[P.isConvert] === true;
  text('ruleset', mode && phase !== 'none' ? `${MODE_LABELS[mode]}${convert ? ' · convert' : ''}` : '');
  let phaseText = '';
  if (conn === 'live' && state !== undefined) {
    phaseText = state === PLAYING ? SOURCE_LABEL[values[P.source]] || 'Playing' : PHASE_LABEL[state] || '';
  }
  text('phase', phaseText);
  phaseEl.hidden = !phaseText;
  attr(phaseEl, 'data-live', phase === 'play' ? '' : null);

  // Identity.
  const pick = (plain, unicode) => (opts.unicode && str(values[unicode]).trim() ? str(values[unicode]) : str(values[plain]));
  attr(card, 'data-empty', hasMap ? null : conn === 'live' ? 'map' : 'conn');
  const empty = conn !== 'live' ? '—' : state === undefined ? 'Waiting for osu!' : 'No map selected';
  text('title', hasMap ? pick(P.title, P.titleUnicode) || '—' : empty);
  text('artist', hasMap ? pick(P.artist, P.artistUnicode) : '');
  text('version', hasMap ? str(values[P.version]) : '');
  const mapper = hasMap ? str(values[P.mapper]) : '';
  text('mapper', mapper);
  mapperWrap.hidden = !mapper;

  const checksum = hasMap ? str(values[P.checksum]) : '';
  if (checksum !== shownChecksum) {
    // Fade the identity in on a real map change, not when the source first loads.
    if (checksum && shownChecksum) $('ident').animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
    shownChecksum = checksum;
    loadBackground(checksum);
  }

  ctx.phase = phase;
  ctx.playing = phase === 'play';
  ctx.parsed = hasMap && ((num(values[P.objects]) ?? 0) > 0 || (num(values[P.bpmCommon]) ?? 0) > 0 || (num(values[P.last]) ?? 0) > 0);
  // Length: the hit-object span in map time (the audio length when the map is not parsed),
  // shown at the mods' clock rate. vosu's object times are not rate-adjusted.
  ctx.rate = rate();
  const first = num(values[P.first]) ?? 0;
  const last = num(values[P.last]);
  const mp3 = num(values[P.mp3]);
  if (!hasMap) ctx.length = 0;
  else if (last && last > first) { ctx.start = first; ctx.length = last - first; }
  else if (mp3 && mp3 > 0) { ctx.start = 0; ctx.length = mp3; }
  else ctx.length = 0;
  ctx.total = ctx.length ? formatDuration(ctx.length / ctx.rate) : '';
  ctx.ofTotal = `/ ${ctx.total}`;
  const total = ctx.parsed ? num(values[P.starsTotal]) : null;
  text('starsLabel', ctx.playing ? 'Live stars' : 'Star rating');
  text('starsOf', ctx.playing && total ? `of ${total.toFixed(2)}` : '');

  renderMods(hasMap);
  renderStats(mode, convert);
  renderLive();
  progressDirty = true;
}

/** Star rating (live during play, the map's total elsewhere) and BPM (realtime during play). */
function renderLive() {
  const { parsed, playing } = ctx;
  // vosu reports 0 for an unparsed map, so 0 reads as "no value".
  const total = parsed ? num(values[P.starsTotal]) : null;
  const liveStars = num(values[P.starsLive]);
  const stars = parsed ? (playing && liveStars ? liveStars : total) : null;
  text('stars', stars ? stars.toFixed(2) : '—');
  // BPM is already rate-adjusted by vosu.
  const common = parsed ? num(values[P.bpmCommon]) : null;
  const realtime = num(values[P.bpmLive]);
  const main = playing && realtime ? realtime : common;
  cellText(cells.bpm, 'to', main ? String(Math.round(main)) : '—');
}

/** Preloads the map's background off-DOM, then fades it into the band (none when disabled or missing). */
function loadBackground(checksum) {
  if (!checksum || !opts.showBackground) { band.replaceChildren(); return; }
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    if (shownChecksum !== checksum || !opts.showBackground) return;
    band.replaceChildren(img);
    img.animate([{ opacity: 0 }, { opacity: 0.5 }], { duration: 240, easing: EASE });
  };
  img.onerror = () => { if (shownChecksum === checksum) band.replaceChildren(); };
  img.src = backgroundUrl(checksum);
}

let shownMods = null;
function renderMods(hasMap) {
  const list = hasMap && Array.isArray(values[P.mods]) ? values[P.mods] : null;
  const r = rate();
  const acronyms = list ? list.map(m => str(m?.acronym)).filter(Boolean) : [];
  const key = list ? `${acronyms.join(' ')}|${r}` : '';
  if (key === shownMods) return;
  shownMods = key;
  const chips = [];
  for (const acronym of acronyms) chips.push(chip(acronym, 'mod'));
  if (list && Math.abs(r - 1) > 1e-4) chips.push(chip(`${fmtRate(r)}×`, 'mod rate'));
  if (list && !chips.length) chips.push(chip('NM', 'mod none'));
  modsEl.replaceChildren(...chips);
}
function chip(label, className) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = label;
  return el;
}
const fmtRate = r => (Math.round(r * 100) / 100).toFixed(2);

function renderStats(mode, convert) {
  const { parsed } = ctx;
  if (mode !== shownMode) {
    shownMode = mode;
    const visible = CELLS[mode] || CELLS.osu;
    let first = true;
    for (const k of ['ar', 'cs', 'od', 'hp']) {
      cells[k].el.hidden = !visible.includes(k);
      if (!cells[k].el.hidden) { cells[k].el.classList.toggle('first', first); first = false; } else cells[k].el.classList.remove('first');
    }
    cells.cs.label.textContent = mode === 'mania' ? 'Keys' : 'CS';
    const list = PARTS[mode] || PARTS.osu;
    parts.forEach((part, i) => {
      part.el.hidden = !list[i];
      if (list[i]) part.w.textContent = list[i][1];
    });
  }

  for (const k of ['ar', 'cs', 'od', 'hp']) {
    const cell = cells[k];
    const original = parsed ? num(values[P[`${k}O`]]) : null;
    const converted = parsed ? num(values[P[`${k}C`]]) : null;
    let to = '—', from = '', d = null;
    if (converted !== null) {
      if (k === 'cs' && mode === 'mania') {
        to = `${Math.round(converted)}K`;
        // A converted map's original CS is an osu! circle size, not a key count.
        if (!convert && original !== null && Math.round(original) !== Math.round(converted)) {
          from = `${Math.round(original)}K→`;
          d = converted > original ? 'up' : 'down';
        }
      } else {
        to = fmt(converted);
        if (original !== null && Math.abs(converted - original) >= 0.005) {
          from = `${fmt(original)}→`;
          d = converted > original ? 'up' : 'down';
        }
      }
    }
    cellText(cell, 'to', to);
    cellText(cell, 'from', from);
    attr(cell.el, 'data-d', d);
  }

  const lo = parsed ? num(values[P.bpmMin]) : null;
  const hi = parsed ? num(values[P.bpmMax]) : null;
  cellText(cells.bpm, 'aux', lo && hi && Math.round(lo) !== Math.round(hi) ? `${Math.round(lo)}–${Math.round(hi)}` : '');

  const objects = parsed ? num(values[P.objects]) : null;
  text('objects', objects ? int(objects) : '—');
  const combo = parsed ? num(values[P.maxCombo]) : null;
  text('combo', combo ? `${int(combo)}×` : '—');
  const list = PARTS[mode] || PARTS.osu;
  parts.forEach((part, i) => {
    if (!list[i]) return;
    const n = parsed ? num(values[P[list[i][0]]]) : null;
    const value = n === null ? '—' : int(n);
    if (part.cache !== value) { part.cache = value; write(part.n, value); }
  });
}

let shownSecond = -1;
function renderProgress() {
  const { phase, start, length, rate: r } = ctx;
  const len = cells.len;
  let scale = 0;
  if (phase === 'play' && length) {
    const t = num(live);
    const elapsed = t === null ? 0 : Math.min(length, Math.max(0, t - start)) / r;
    scale = elapsed * r / length;
    const second = Math.floor(elapsed / 1000);
    if (second !== shownSecond) { shownSecond = second; cellText(len, 'to', formatDuration(elapsed)); }
    cellText(len, 'aux', ctx.ofTotal);
  } else {
    shownSecond = -1;
    if (phase === 'results' && length) scale = 1;
    cellText(len, 'to', ctx.total || '—');
    cellText(len, 'aux', '');
  }
  // Quantised to half a CSS pixel of the bar so a steady clock does not restyle every frame.
  const q = Math.round(scale * WIDTH * 2) / (WIDTH * 2);
  if (q !== barScale) {
    barScale = q;
    bar.style.transform = `scaleX(${q})`;
  }
}

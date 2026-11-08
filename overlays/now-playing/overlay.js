// Copyright (c) 2026 18-LAB. MIT.
// Now playing: the map's identity, live star rating/BPM, mod-adjusted settings and progress,
// floated into the free space beside osu!'s playfield during gameplay. Song select and results
// already show all of this, so the overlay stays empty there.
import { subscribe, settings, fit, activeMode, formatDuration, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const STRIP = 320; // strip width at scale 1, CSS px (side bands, beside the mania stage)
const STRIP_TAIKO = 440; // below the taiko lane there is room for a title on one line
const MARGIN = 40; // gap to the screen edge or the playfield/stage

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number', client: '/client',
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
// Default zone: osu!/catch the right side band (under score/accuracy, above the key counter),
// mania left of the stage, taiko the empty area below the lane.
const AUTO_ZONE = { osu: 'right', fruits: 'right', mania: 'left', taiko: 'left' };

const $ = id => document.getElementById(id);
const stage = $('stage');
const np = $('np');
const chip = $('chip');
const bar = $('bar');
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
  layout: 'full', unicode: false, showStats: true, zone: 'auto', x: 0, y: 0, scale: 1,
  backing: 'none', accent: 'map', showBrand: true, columnStart: 136, columnWidth: 30,
};
let values = {};
let live;
let liveSub = null;
let conn = 'connecting';
let dirty = true;
let liveDirty = false;
let progressDirty = false;
let frame = 0;
const HOT = new Set([P.starsLive, P.bpmLive]);
const ctx = { show: false, parsed: false, rate: 1, start: 0, length: 0 };
let shownChecksum;
let shownMode;
let placed = '';
let paletteFor = '';
let barScale = -1;
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
  const accentChanged = next.accent !== opts.accent;
  opts = next;
  placed = '';
  if (accentChanged) loadPalette(paletteFor);
  dirty = true;
  schedule();
});

fit(stage, WIDTH, HEIGHT);

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

  // Placement: re-laid out on ruleset, key count, client and placement settings only.
  const keys = mode === 'mania' && ctx.parsed ? Math.round(num(values[P.csC]) ?? 4) : 4;
  place(mode || 'osu', keys, values[P.client] === 'lazer' ? 'lazer' : 'stable');

  // Tiny status line in the zone; nothing at all in menus, song select and results.
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
  brandEl.hidden = !opts.showBrand;
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
  progressDirty = true;
}

function rate() {
  return num(values[P.modsRate]) || num(values[P.clockRate]) || 1;
}

function place(mode, keys, client) {
  const key = `${mode}|${keys}|${client}`;
  if (key === placed) return;
  placed = key;
  const layout = osuLayout(mode, { keys, client, columnWidth: num(opts.columnWidth) || 30, columnStart: num(opts.columnStart) ?? 136 });
  const { busy, hud } = layout;
  const scale = clamp(num(opts.scale) || 1, 0.5, 2);
  const zone = opts.zone === 'left' || opts.zone === 'right' ? opts.zone : AUTO_ZONE[mode];
  // `x` is the anchored edge: the strip's left edge when aligned start, its right edge when end.
  let x, y, align, room;
  if (mode === 'taiko') {
    align = zone === 'right' ? 'end' : 'start';
    x = align === 'end' ? WIDTH - MARGIN : MARGIN;
    y = busy.y + busy.h + 44;
    room = WIDTH;
  } else if (mode === 'mania') {
    y = hud.health.y + hud.health.h + 48;
    if (zone === 'left') { align = 'end'; x = busy.x - MARGIN; room = busy.x - 2 * MARGIN; }
    else { align = 'start'; x = busy.x + busy.w + 96; room = WIDTH - x - MARGIN; }
  } else if (zone === 'left') {
    align = 'start'; x = MARGIN; y = hud.health.y + hud.health.h + 40; room = busy.x - 2 * MARGIN;
  } else {
    align = 'end'; x = WIDTH - MARGIN; y = hud.accuracy.y + hud.accuracy.h + 32; room = WIDTH - busy.x - busy.w - 2 * MARGIN;
  }
  const width = Math.round(clamp(room / scale, 180, mode === 'taiko' ? STRIP_TAIKO : STRIP));
  x += num(opts.x) ?? 0;
  y += num(opts.y) ?? 0;
  attr(np, 'data-align', align);
  np.style.width = `${width}px`;
  np.style.left = `${Math.round(align === 'end' ? x - width : x)}px`;
  np.style.top = `${Math.round(y)}px`;
  np.style.transform = scale === 1 ? '' : `scale(${scale})`;
  chip.style.top = `${Math.round(y)}px`;
  chip.style.left = align === 'end' ? '' : `${Math.round(x)}px`;
  chip.style.right = align === 'end' ? `${Math.round(WIDTH - x)}px` : '';
}

function loadPalette(checksum) {
  paletteFor = checksum;
  if (!checksum || opts.accent !== 'map') { applyPalette(stage, null); return; }
  mapPalette(checksum).then(palette => {
    if (paletteFor === checksum && opts.accent === 'map') applyPalette(stage, palette);
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
  const stars = ctx.parsed ? num(values[P.starsLive]) || num(values[P.starsTotal]) : null;
  text('stars', stars ? stars.toFixed(2) : '—');
  const bpm = ctx.parsed ? num(values[P.bpmLive]) || num(values[P.bpmCommon]) : null;
  text('bpm', bpm ? String(Math.round(bpm)) : '—');
}

function renderProgress() {
  if (!ctx.show) return;
  const { start, length, rate: r } = ctx;
  let scale = 0;
  if (length) {
    const t = num(live);
    const elapsed = t === null ? 0 : Math.min(length, Math.max(0, t - start)) / r;
    scale = elapsed * r / length;
    const second = Math.floor(elapsed / 1000);
    if (second !== shownSecond) { shownSecond = second; text('elapsed', formatDuration(elapsed)); }
  } else if (shownSecond !== -1) {
    shownSecond = -1;
    text('elapsed', '0:00');
  }
  // Quantised to half a CSS pixel of the widest strip so a steady clock does not restyle every frame.
  const q = Math.round(scale * STRIP_TAIKO * 2) / (STRIP_TAIKO * 2);
  if (q !== barScale) {
    barScale = q;
    bar.style.transform = `scaleX(${q})`;
  }
}

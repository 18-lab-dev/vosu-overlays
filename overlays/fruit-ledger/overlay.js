// Copyright (c) 2026 18-LAB. MIT.
// Fruit ledger: osu!catch judgements as a ruled ledger floating in the side band beside the
// playfield — caught and missed per object class, combo status, accuracy and the accuracy
// still reachable. Song select shows the map's fruit/drop/droplet split (osu! shows only
// circles/sliders/spinners); results and menus show nothing.
import { subscribe, settings, fit, activeMode, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const CLUSTER = 296; // px, .anchor width
const GUTTER = 40; // px between the playfield edge and the ledger
const TRACK = CLUSTER - 46 - 12; // the bar spans the label and caught columns
const MIN_SHARE = 2 / TRACK; // a non-zero share stays visible
const PLAYING = 2;
const SONG_SELECT = new Set([5, 12, 13]); // select play, multiplayer match setup, multiplayer select

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum',
  mapCombo: '/beatmap/stats/maxCombo',
  accuracy: '/play/accuracy',
  combo: '/play/combo/current',
  comboMax: '/play/combo/max',
};
const HIT_KEYS = ['300', '100', '50', '0', 'katu', 'largeTickHits', 'smallTickHits'];
const playHits = HIT_KEYS.map(key => `/play/hits/${key}`);

const $ = id => document.getElementById(id);
const root = document.documentElement;
const stage = $('stage');
const anchor = $('anchor');
const ledger = $('ledger');
const chip = $('chip');
fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------ writers (DOM touched only on change)
function textCell(el) {
  let last = null;
  return value => { if (value !== last) { last = value; el.textContent = value; } };
}
function attrCell(el, name) {
  let last;
  return value => {
    if (value === last) return;
    last = value;
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
  };
}
function classCell(el, name) {
  let last = null;
  return on => { if (on !== last) { last = on; el.classList.toggle(name, on); } };
}
function segCell(el) {
  let lastStart = -1, lastWidth = -1;
  return (start, width) => {
    if (width > 0 && width < MIN_SHARE) width = MIN_SHARE;
    if (start + width > 1) start = Math.max(0, 1 - width);
    start = Math.round(start * 1000) / 1000;
    width = Math.round(width * 1000) / 1000;
    if (start === lastStart && width === lastWidth) return;
    lastStart = start; lastWidth = width;
    el.style.transform = `translateX(${start * 100}%) scaleX(${width})`;
  };
}
const stat = name => document.querySelector(`.stat-${name}`);

const ui = {
  chipState: attrCell(chip, 'data-state'),
  chipText: textCell($('chip-text')),
  hidden: classCell(ledger, 'is-hidden'),
  compact: classCell(ledger, 'compact'),
  backing: attrCell(ledger, 'data-backing'),
  phaseAttr: attrCell(ledger, 'data-phase'),
  brand: attrCell($('brand'), 'hidden'),
  phase: textCell($('phase')),
  verdict: textCell($('verdict')),
  tone: attrCell($('verdict'), 'data-tone'),
  colCaught: textCell($('col-caught')),
  fruit: textCell($('n-fruit')),
  drop: textCell($('n-drop')),
  tiny: textCell($('n-tiny')),
  miss: textCell($('n-miss')),
  missHot: classCell($('n-miss'), 'hot'),
  dmiss: textCell($('n-dmiss')),
  dmissHot: classCell($('n-dmiss'), 'hot'),
  segFruit: segCell($('seg-fruit')),
  segDrop: segCell($('seg-drop')),
  segMiss: segCell($('seg-miss')),
  segTiny: segCell($('seg-tiny')),
  segDmiss: segCell($('seg-dmiss')),
  acc: textCell($('acc')),
  accEmpty: attrCell(stat('acc'), 'data-empty'),
  accHidden: attrCell(stat('acc'), 'hidden'),
  max: textCell($('max')),
  maxEmpty: attrCell(stat('max'), 'data-empty'),
  maxHidden: attrCell(stat('max'), 'hidden'),
  combo: textCell($('combo')),
  comboEmpty: attrCell(stat('combo'), 'data-empty'),
  comboOf: textCell($('combo-of')),
};

const grouping = new Intl.NumberFormat('en-US');
const count = n => (n === null ? '—' : grouping.format(n));
const percent = n => (n === null ? '—' : n.toFixed(2));

// ------------------------------------------------------------ state
const DEFAULTS = { zone: 'right', offsetX: 0, offsetY: 0, scale: 1, backing: 'scrim', accent: 'map', compact: false, showAcc: true, showBrand: true };
let values = {};
let options = { ...DEFAULTS };
let status = 'connecting';
let dirty = true;
let frame = 0;

// Map composition from vosu's (and tosu's) calculator: one request per selected map.
let composition = null;
let compositionFor = null;
let compositionTimer = 0;
let paletteFor = null;

function markDirty() {
  dirty = true;
  if (!frame) frame = requestAnimationFrame(render);
}

// osu!stable song select at 1920×1080: the centre column between the local leaderboard and the
// beatmap carousel, below the map info header, is empty (the mode chooser there is normally shut).
const SONG_SELECT_COLUMN = { x: 540, y: 190, w: 620 };
let placedAt = '';

/**
 * Gameplay: the side band beside the 4:3 playfield (osuLayout geometry), top clear of score and
 * accuracy, bottom clear of a key counter at the right edge. Song select: the centre column.
 * Writes the transform only when the spot changes.
 */
function place(phase) {
  const scale = Math.min(2, Math.max(0.5, options.scale || 1));
  let x, y;
  if (phase === 'map') {
    x = SONG_SELECT_COLUMN.x + (SONG_SELECT_COLUMN.w - CLUSTER * scale) / 2;
    y = SONG_SELECT_COLUMN.y + 40;
  } else {
    const { busy, hud } = osuLayout('fruits', { width: WIDTH, height: HEIGHT });
    x = options.zone === 'left' ? busy.x - GUTTER - CLUSTER * scale : busy.x + busy.w + GUTTER;
    y = hud.accuracy.y + hud.accuracy.h + 34;
  }
  // Scaled or nudged, the ledger never leaves the 1920×1080 source.
  x = Math.min(WIDTH - CLUSTER * scale, Math.max(0, x + options.offsetX));
  y = Math.max(0, y + options.offsetY);
  const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${scale})`;
  if (transform === placedAt) return;
  placedAt = transform;
  anchor.style.transform = transform;
}

function wantComposition(checksum) {
  if (!checksum || checksum === compositionFor) return;
  compositionFor = checksum;
  composition = null;
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => loadComposition(checksum, 0), 300);
}

async function loadComposition(checksum, attempt) {
  try {
    const response = await fetch('/api/calculate/pp?mode=2', { cache: 'no-store' });
    if (compositionFor !== checksum) return;
    if (!response.ok) {
      // 503: the map is still being parsed; anything else means the route is unavailable.
      if (response.status === 503 && attempt < 5) compositionTimer = setTimeout(() => loadComposition(checksum, attempt + 1), 1500);
      return;
    }
    const attributes = (await response.json())?.difficulty;
    if (compositionFor !== checksum || !attributes) return;
    const { nFruits: fruits, nDroplets: drops, nTinyDroplets: droplets } = attributes;
    if (![fruits, drops, droplets].every(Number.isInteger)) return;
    composition = { fruits, drops, droplets, total: fruits + drops + droplets };
    markDirty();
  } catch { /* offline or not JSON: composition stays unknown */ }
}

function wantPalette(checksum) {
  const key = options.accent === 'map' ? checksum || null : null;
  if (key === paletteFor) return;
  paletteFor = key;
  if (!key) { applyPalette(root, null); return; }
  mapPalette(key).then(palette => { if (paletteFor === key) applyPalette(root, palette); });
}

const int = value => (Number.isFinite(value) ? value : 0);

/**
 * Reads the hits object. The brief's (tosu) catch table: 300 fruits, 100 drops, 50 droplets,
 * katu missed droplets, 0 fruit+drop misses. vosu v2 currently publishes catch statistics raw
 * (drops in largeTickHits, droplets in smallTickHits, droplet misses absent): then droplet
 * misses are unknown (null), never zero.
 */
function readHits() {
  const fruits = values[playHits[0]];
  if (!Number.isFinite(fruits)) return null;
  const h100 = int(values[playHits[1]]);
  const h50 = int(values[playHits[2]]);
  const katu = int(values[playHits[4]]);
  const large = int(values[playHits[5]]);
  const small = int(values[playHits[6]]);
  const raw = h100 === 0 && h50 === 0 && katu === 0 && (large > 0 || small > 0);
  return {
    fruits,
    drops: raw ? large : h100,
    droplets: raw ? small : h50,
    misses: int(values[playHits[3]]),
    dropletMisses: raw ? null : katu,
    raw,
  };
}

function verdictOf(hits, maxCombo) {
  const judged = hits.fruits + hits.drops + hits.droplets + hits.misses + (hits.dropletMisses ?? 0);
  if (!judged) return ['none', ''];
  // Without a separate drop-miss count, a combo shorter than the combo objects caught means a break.
  const broken = hits.misses > 0 || (hits.raw && Number.isFinite(maxCombo) && maxCombo < hits.fruits + hits.drops);
  if (broken) return ['broken', 'Combo broken'];
  if (hits.dropletMisses === null || hits.dropletMisses > 0) return ['intact', 'Combo intact'];
  return ['fc', 'Full combo'];
}

function chipOnly(state, text) {
  place('live');
  ui.chipState(state);
  ui.chipText(text);
  ui.hidden(true);
}

// ------------------------------------------------------------ render (rAF only)
function render() {
  frame = 0;
  if (!dirty) return;
  dirty = false;

  ui.compact(options.compact);
  ui.backing(options.backing);
  ui.brand(options.showBrand ? null : '');

  if (status !== 'live') return chipOnly(status, status === 'connecting' ? 'Connecting to vosu' : 'vosu offline');

  const state = values[P.state];
  if (!Number.isInteger(state)) return chipOnly('idle', 'Waiting for osu!');
  ui.chipState('live');

  const mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  const phase = state === PLAYING ? 'live' : SONG_SELECT.has(state) ? 'map' : null;
  // Another ruleset, results, menus — or song select without anything osu! doesn't show: nothing.
  if (mode !== 'fruits' || phase === null || (phase === 'map' && !composition)) {
    ui.hidden(true);
    return;
  }
  place(phase);
  ui.hidden(false);
  ui.phaseAttr(phase);
  ui.phase(phase === 'live' ? 'Live' : 'Map');

  if (phase === 'map') {
    // The map's opening balance: osu! song select shows circles/sliders/spinners, not this split.
    const c = composition;
    ui.colCaught('In map');
    ui.fruit(count(c.fruits));
    ui.drop(count(c.drops));
    ui.tiny(count(c.droplets));
    const combos = c.fruits + c.drops;
    ui.segFruit(0, combos ? c.fruits / combos : 0);
    ui.segDrop(combos ? c.fruits / combos : 0, combos ? c.drops / combos : 0);
    ui.segMiss(1, 0);
    ui.segTiny(0, c.droplets ? 1 : 0);
    ui.segDmiss(1, 0);
    return;
  }

  ui.colCaught('Caught');
  ui.accHidden(options.showAcc ? null : '');
  ui.maxHidden(options.showAcc ? null : '');
  const mapCombo = Number.isFinite(values[P.mapCombo]) && values[P.mapCombo] > 0 ? values[P.mapCombo] : null;
  ui.comboOf(mapCombo === null ? '' : `/ ${count(mapCombo)}`);
  const combo = Number.isFinite(values[P.combo]) ? values[P.combo] : null;
  ui.combo(combo === null ? '—' : count(combo));
  ui.comboEmpty(combo === null ? '' : null);

  const hits = readHits();
  if (!hits) {
    for (const write of [ui.fruit, ui.drop, ui.tiny, ui.miss, ui.dmiss, ui.acc, ui.max]) write('—');
    ui.missHot(false); ui.dmissHot(false);
    for (const seg of [ui.segFruit, ui.segDrop, ui.segMiss, ui.segTiny, ui.segDmiss]) seg(0, 0);
    ui.tone('none'); ui.verdict('');
    ui.accEmpty(''); ui.maxEmpty('');
    return;
  }

  ui.fruit(count(hits.fruits));
  ui.drop(count(hits.drops));
  ui.tiny(count(hits.droplets));
  ui.miss(count(hits.misses));
  ui.missHot(hits.misses > 0);
  ui.dmiss(count(hits.dropletMisses));
  ui.dmissHot(hits.dropletMisses > 0);

  // Waterfall shares: combo objects (fruits, drops, their misses) and droplets (caught, missed).
  const comboTotal = hits.fruits + hits.drops + hits.misses;
  const fruitShare = comboTotal ? hits.fruits / comboTotal : 0;
  const dropShare = comboTotal ? hits.drops / comboTotal : 0;
  ui.segFruit(0, fruitShare);
  ui.segDrop(fruitShare, dropShare);
  ui.segMiss(fruitShare + dropShare, comboTotal ? hits.misses / comboTotal : 0);
  const dropletTotal = hits.droplets + (hits.dropletMisses ?? 0);
  const caughtShare = dropletTotal ? hits.droplets / dropletTotal : 0;
  ui.segTiny(0, caughtShare);
  ui.segDmiss(caughtShare, dropletTotal ? (hits.dropletMisses ?? 0) / dropletTotal : 0);

  const comboMax = Number.isFinite(values[P.comboMax]) ? values[P.comboMax] : null;
  const [tone, label] = verdictOf(hits, comboMax);
  ui.tone(tone);
  ui.verdict(label);

  const accuracy = tone !== 'none' && Number.isFinite(values[P.accuracy]) ? values[P.accuracy] : null;
  ui.acc(percent(accuracy));
  ui.accEmpty(accuracy === null ? '' : null);

  // Max achievable: everything not yet missed is still catchable.
  let max = null;
  if (composition && composition.total > 0 && hits.dropletMisses !== null) {
    max = Math.max(0, (composition.total - hits.misses - hits.dropletMisses) / composition.total) * 100;
    max = Math.floor(max * 100) / 100;
  }
  ui.max(percent(max));
  ui.maxEmpty(max === null ? '' : null);
}

// ------------------------------------------------------------ wiring
subscribe([...Object.values(P), ...playHits], (next, changed) => {
  values = next;
  const fruits = activeMode(next[P.state], next[P.playMode], next[P.settingsMode]) === 'fruits';
  if (fruits) wantComposition(next[P.checksum]);
  if (changed.has(P.checksum) || changed.has(P.state)) wantPalette(fruits ? next[P.checksum] : null);
  if (changed.size) markDirty();
}, {
  onStatus: state => {
    // A reconnect attempt after losing vosu still reads as offline; no chip flicker per retry.
    if (state === 'connecting' && status === 'offline') return;
    if (state === status) return;
    status = state;
    markDirty();
  },
});

settings(DEFAULTS, next => {
  options = next;
  const fruits = activeMode(values[P.state], values[P.playMode], values[P.settingsMode]) === 'fruits';
  wantPalette(fruits ? values[P.checksum] : null);
  markDirty();
});

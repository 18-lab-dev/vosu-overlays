// Copyright (c) 2026 18-LAB. MIT.
// Fruit ledger: osu!catch judgements as a ruled ledger — caught and missed per object class,
// combo status, accuracy and the accuracy still reachable.
import { subscribe, settings, fit, activeMode, MODES } from './vosu-overlay.js';

const WIDTH = 520; // full ledger is 368 px; the compact strip may run wider
const HEIGHT = 219;
const TRACK = 136; // px, matches .table's second column; keeps a non-zero share visible.
const MIN_SHARE = 2 / TRACK;
const PLAYING = 2;
const SHORT = { fc: 'FC', intact: 'Intact', broken: 'Broken' };
const RESULTS = 7;

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum',
  mapCombo: '/beatmap/stats/maxCombo',
  accuracy: '/play/accuracy',
  combo: '/play/combo/current',
  comboMax: '/play/combo/max',
  resultsMode: '/resultsScreen/mode/number',
  resultsAccuracy: '/resultsScreen/accuracy',
  resultsCombo: '/resultsScreen/maxCombo',
};
const HIT_KEYS = ['300', '100', '50', '0', 'katu', 'largeTickHits', 'smallTickHits'];
const playHits = HIT_KEYS.map(key => `/play/hits/${key}`);
const resultHits = HIT_KEYS.map(key => `/resultsScreen/hits/${key}`);

const $ = id => document.getElementById(id);
const stage = $('stage');
const ledger = $('ledger');
const chip = $('chip');
fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------ text/attribute writers (write on change only)
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

const ui = {
  chipState: attrCell(chip, 'data-state'),
  chipText: textCell($('chip-text')),
  hidden: classCell(ledger, 'is-hidden'),
  compact: classCell(ledger, 'compact'),
  brand: attrCell($('brand'), 'hidden'),
  phase: textCell($('phase')),
  phaseAttr: attrCell($('phase'), 'data-phase'),
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
  accEmpty: attrCell(document.querySelector('.stat-acc'), 'data-empty'),
  accHidden: attrCell(document.querySelector('.stat-acc'), 'hidden'),
  max: textCell($('max')),
  maxEmpty: attrCell(document.querySelector('.stat-max'), 'data-empty'),
  maxHidden: attrCell(document.querySelector('.stat-max'), 'hidden'),
  combo: textCell($('combo')),
  comboEmpty: attrCell(document.querySelector('.stat-combo'), 'data-empty'),
  comboKey: textCell($('combo-key')),
  comboOf: textCell($('combo-of')),
  footSolo: attrCell(document.querySelector('.foot'), 'data-solo'),
};

const grouping = new Intl.NumberFormat('en-US');
const count = n => (n === null ? '—' : grouping.format(n));
const percent = n => (n === null ? '—' : n.toFixed(2));

// ------------------------------------------------------------ state
let values = {};
let options = { compact: false, showAcc: true, showBrand: true };
let status = 'connecting';
let dirty = true;
let frame = 0;
let held = null; // last live ledger, kept for results when the client publishes no result screen

// Map composition from vosu's calculator (also served by tosu): one request per selected map.
let composition = null;
let compositionFor = null;
let compositionTimer = 0;

function markDirty() {
  dirty = true;
  if (!frame) frame = requestAnimationFrame(render);
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
  } catch { /* offline or not JSON: max stays unknown */ }
}

const int = value => (Number.isFinite(value) ? value : 0);

/**
 * Reads a hits object into the ledger. The brief's (tosu) catch table: 300 fruits, 100 drops,
 * 50 droplets, katu missed droplets, 0 fruit+drop misses. Some servers instead publish catch
 * statistics raw (drops in largeTickHits, droplets in smallTickHits, droplet misses absent);
 * then droplet misses are unknown (null) rather than zero.
 */
function readHits(pointers) {
  const fruits = values[pointers[0]];
  if (!Number.isFinite(fruits)) return null;
  const h100 = int(values[pointers[1]]);
  const h50 = int(values[pointers[2]]);
  const katu = int(values[pointers[4]]);
  const large = int(values[pointers[5]]);
  const small = int(values[pointers[6]]);
  const raw = h100 === 0 && h50 === 0 && katu === 0 && (large > 0 || small > 0);
  return {
    fruits,
    drops: raw ? large : h100,
    droplets: raw ? small : h50,
    misses: int(values[pointers[3]]),
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

// ------------------------------------------------------------ render (rAF only)
function render() {
  frame = 0;
  if (!dirty) return;
  dirty = false;

  ui.compact(options.compact);
  ui.brand(options.showBrand ? null : '');

  if (status !== 'live') {
    ui.chipState(status);
    ui.chipText(status === 'connecting' ? 'Connecting to vosu' : 'vosu offline');
    ui.hidden(true);
    return;
  }
  ui.chipState('live');

  const state = values[P.state];
  let mode = activeMode(state, values[P.playMode], values[P.settingsMode]);
  if (state === RESULTS && Number.isInteger(values[P.resultsMode])) mode = MODES[values[P.resultsMode]] ?? mode;
  // Another ruleset: nothing on screen. No game at all: a calm placeholder.
  ui.hidden(mode !== null && mode !== 'fruits');
  if (mode !== null && mode !== 'fruits') return;

  const phase = state === PLAYING ? 'live' : state === RESULTS ? 'final' : 'map';
  ui.phaseAttr(phase);
  ui.phase(phase === 'live' ? 'Live' : phase === 'final' ? 'Final' : Number.isInteger(state) ? 'Map' : 'Idle');
  const accShown = options.showAcc && phase !== 'map';
  ui.accHidden(accShown ? null : '');
  ui.footSolo(accShown ? null : '');
  ui.maxHidden(options.showAcc && phase === 'live' ? null : '');

  let hits = null;
  let accuracy = null;
  let combo = null;
  let comboMax = null;
  if (phase === 'live') {
    hits = readHits(playHits);
    accuracy = Number.isFinite(values[P.accuracy]) ? values[P.accuracy] : null;
    combo = Number.isFinite(values[P.combo]) ? values[P.combo] : null;
    comboMax = Number.isFinite(values[P.comboMax]) ? values[P.comboMax] : null;
    held = hits ? { hits, accuracy, comboMax } : held;
  } else if (phase === 'final') {
    const result = readHits(resultHits);
    const judged = result ? result.fruits + result.drops + result.droplets + result.misses + (result.dropletMisses ?? 0) : 0;
    if (judged > 0) {
      hits = result;
      accuracy = Number.isFinite(values[P.resultsAccuracy]) ? values[P.resultsAccuracy] : null;
      comboMax = Number.isFinite(values[P.resultsCombo]) ? values[P.resultsCombo] : null;
    } else if (held) {
      ({ hits, accuracy, comboMax } = held);
    }
    combo = comboMax;
  } else {
    held = null;
  }

  const mapCombo = Number.isFinite(values[P.mapCombo]) && values[P.mapCombo] > 0 ? values[P.mapCombo] : null;
  ui.comboKey(phase === 'live' ? 'Combo' : 'Max combo');
  ui.comboOf(mapCombo === null || phase === 'map' ? '' : `/ ${count(mapCombo)}`);

  if (phase === 'map') {
    // Song select: the map's opening balance, when the calculator can tell us.
    const c = composition;
    ui.colCaught('In map');
    ui.fruit(count(c ? c.fruits : null));
    ui.drop(count(c ? c.drops : null));
    ui.tiny(count(c ? c.droplets : null));
    ui.miss('—'); ui.missHot(false);
    ui.dmiss('—'); ui.dmissHot(false);
    const combos = c ? c.fruits + c.drops : 0;
    ui.segFruit(0, combos ? c.fruits / combos : 0);
    ui.segDrop(combos ? c.fruits / combos : 0, combos ? c.drops / combos : 0);
    ui.segMiss(1, 0);
    ui.segTiny(0, c && c.droplets ? 1 : 0);
    ui.segDmiss(1, 0);
    ui.verdict('—'); ui.tone('none');
    ui.combo(count(mapCombo)); ui.comboEmpty(mapCombo === null ? '' : null);
    return;
  }

  ui.colCaught('Caught');
  if (!hits) {
    for (const write of [ui.fruit, ui.drop, ui.tiny, ui.miss, ui.dmiss]) write('—');
    ui.missHot(false); ui.dmissHot(false);
    for (const seg of [ui.segFruit, ui.segDrop, ui.segMiss, ui.segTiny, ui.segDmiss]) seg(0, 0);
    ui.verdict('—'); ui.tone('none');
    ui.acc('—'); ui.accEmpty('');
    ui.max('—'); ui.maxEmpty('');
    ui.combo('—'); ui.comboEmpty('');
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

  const [tone, label] = verdictOf(hits, comboMax);
  ui.tone(tone);
  ui.verdict(tone === 'none' ? '—' : options.compact ? SHORT[tone] : label);

  const judged = tone !== 'none';
  const shownAcc = judged && accuracy !== null ? accuracy : null;
  ui.acc(percent(shownAcc));
  ui.accEmpty(shownAcc === null ? '' : null);

  // Max achievable: everything not yet missed is still catchable.
  let max = null;
  if (composition && composition.total > 0 && hits.dropletMisses !== null) {
    max = Math.max(0, (composition.total - hits.misses - hits.dropletMisses) / composition.total) * 100;
    max = Math.floor(max * 100) / 100;
  }
  ui.max(percent(max));
  ui.maxEmpty(max === null ? '' : null);

  ui.combo(combo === null ? '—' : count(combo));
  ui.comboEmpty(combo === null ? '' : null);
}

// ------------------------------------------------------------ wiring
subscribe([...Object.values(P), ...playHits, ...resultHits], (next, changed) => {
  values = next;
  const mode = activeMode(next[P.state], next[P.playMode], next[P.settingsMode]);
  if (mode === 'fruits' || next[P.state] === RESULTS) wantComposition(next[P.checksum]);
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

settings({ compact: false, showAcc: true, showBrand: true }, next => {
  options = next;
  markDirty();
});

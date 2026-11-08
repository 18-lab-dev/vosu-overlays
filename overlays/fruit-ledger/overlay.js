// Copyright (c) 2026 18-LAB. MIT.
// Fruit ledger: osu!catch judgements as a ruled ledger — caught and missed per object class,
// combo status, accuracy and the accuracy still reachable. A content-sized page: the host
// (OBS, vosulay, the replay renderer) places and sizes it; the ledger re-flows to that box,
// vertical for side columns and corners, horizontal for top/bottom bands. Gameplay only: a page
// placed for gameplay would sit on song select's carousel art, and osu!'s results screen already
// lists every catch judgement, so song select, results and menus show nothing.
import { subscribe, settings, activeMode, mapPalette, applyPalette } from './vosu-overlay.js';

const PAD = 20; // design px around the ledger, holding the scrim's fade (.frame padding)
const STRETCH = 1.3; // a wide box widens the ledger up to this factor before scaling it up
const PLAYING = 2;

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
const frame = $('frame');
const ledger = $('ledger');
const chip = $('chip');

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
let mirrored = false;
let segEpoch = 0; // bumped when the bars' direction flips, so every bar rewrites
function segCell(el) {
  let lastStart = -1, lastWidth = -1, lastEpoch = -1;
  return (start, width) => {
    // A non-zero share stays visible (2 px of a ~120 px track).
    if (width > 0 && width < 0.016) width = 0.016;
    if (start + width > 1) start = Math.max(0, 1 - width);
    start = Math.round(start * 1000) / 1000;
    width = Math.round(width * 1000) / 1000;
    if (start === lastStart && width === lastWidth && segEpoch === lastEpoch) return;
    lastStart = start; lastWidth = width; lastEpoch = segEpoch;
    el.style.transform = `translateX(${(mirrored ? -start : start) * 100}%) scaleX(${width})`;
  };
}
const stat = name => document.querySelector(`.stat-${name}`);

const ui = {
  chipState: attrCell(chip, 'data-state'),
  chipText: textCell($('chip-text')),
  hidden: classCell(ledger, 'is-hidden'),
  verdict: textCell($('verdict')),
  tone: attrCell($('verdict'), 'data-tone'),
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
  max: textCell($('max')),
  maxUnknown: attrCell(stat('max'), 'data-unknown'),
  combo: textCell($('combo')),
  comboEmpty: attrCell(stat('combo'), 'data-empty'),
  comboOf: textCell($('combo-of')),
};

const grouping = new Intl.NumberFormat('en-US');
const count = n => (n === null ? '—' : grouping.format(n));
const percent = n => (n === null ? '—' : n.toFixed(2));

// ------------------------------------------------------------ state
const DEFAULTS = { orientation: 'auto', align: 'right', backing: 'scrim', accent: 'map', compact: false, showAcc: true };
let values = {};
let options = { ...DEFAULTS };
let status = 'connecting';
let dirty = true;
let rafId = 0;

// Map composition from vosu's (and tosu's) calculator: one request per selected map. The
// replay renderer does not serve it; MAX then stays hidden.
let composition = null;
let compositionFor = null;
let compositionTimer = 0;
let paletteFor = null;

function markDirty() {
  dirty = true;
  if (!rafId) rafId = requestAnimationFrame(render);
}

// ------------------------------------------------------------ re-flow to the page box (never in rAF)
let relayoutTimer = 0;
function scheduleRelayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayout, 0);
}

/**
 * Picks the arrangement for the box (horizontal when it is much wider than tall, unless the
 * orientation setting forces one), measures the ledger at design size, then scales the frame to
 * fit and aligns it. A box too small for the full ledger at ≥ 70 % (e.g. a 4-player renderer
 * cell) gets the compact ledger, which keeps type larger. Runs on resize, settings change and
 * font load only.
 */
function relayout() {
  const W = innerWidth, H = innerHeight;
  if (!W || !H) return;
  const orient = options.orientation === 'horizontal' ? 'h'
    : options.orientation === 'vertical' ? 'v'
      : W / H > 2.2 ? 'h' : 'v';
  ledger.dataset.orient = orient;
  ledger.dataset.align = options.align;
  frame.dataset.align = options.align;
  const nowMirrored = orient === 'v' && options.align === 'right';
  if (nowMirrored !== mirrored) { mirrored = nowMirrored; segEpoch++; dirty = true; }
  ledger.style.width = '';
  const measure = () => {
    const naturalW = ledger.offsetWidth;
    const naturalH = ledger.offsetHeight;
    return { naturalW, naturalH, scale: Math.min(4, W / (naturalW + 2 * PAD), H / (naturalH + 2 * PAD)) };
  };
  ledger.classList.toggle('compact', options.compact);
  let box = measure();
  if (!options.compact && box.scale < 0.7) {
    ledger.classList.add('compact');
    box = measure();
  }
  const { naturalW, naturalH, scale } = box;
  const width = Math.min(W / scale - 2 * PAD, naturalW * STRETCH);
  ledger.style.width = `${Math.floor(width)}px`;
  const frameW = (width + 2 * PAD) * scale;
  const frameH = (naturalH + 2 * PAD) * scale;
  const x = options.align === 'left' ? 0 : options.align === 'right' ? W - frameW : (W - frameW) / 2;
  const y = (H - frameH) / 2;
  frame.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${scale})`;
  markDirty();
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
  ui.chipState(state);
  ui.chipText(text);
  ui.hidden(true);
}

// ------------------------------------------------------------ render (rAF only)
function render() {
  rafId = 0;
  if (!dirty) return;
  dirty = false;

  if (status !== 'live') return chipOnly(status, status === 'connecting' ? 'Connecting to vosu' : 'vosu offline');

  const state = values[P.state];
  if (!Number.isInteger(state)) return chipOnly('idle', 'Waiting for osu!');
  ui.chipState('live');

  // Another ruleset, song select, results, menus: nothing.
  if (state !== PLAYING || activeMode(state, values[P.playMode], values[P.settingsMode]) !== 'fruits') {
    ui.hidden(true);
    return;
  }
  ui.hidden(false);

  const mapCombo = Number.isFinite(values[P.mapCombo]) && values[P.mapCombo] > 0 ? values[P.mapCombo] : null;
  ui.comboOf(mapCombo === null ? '' : `/ ${count(mapCombo)}`);
  const combo = Number.isFinite(values[P.combo]) ? values[P.combo] : null;
  ui.combo(combo === null ? '—' : count(combo));
  ui.comboEmpty(combo === null ? '' : null);

  const hits = readHits();
  if (!hits) {
    for (const write of [ui.fruit, ui.drop, ui.tiny, ui.miss, ui.dmiss, ui.acc]) write('—');
    ui.missHot(false); ui.dmissHot(false);
    for (const seg of [ui.segFruit, ui.segDrop, ui.segMiss, ui.segTiny, ui.segDmiss]) seg(0, 0);
    ui.tone('none'); ui.verdict('');
    ui.accEmpty(''); ui.maxUnknown('');
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

  // Max achievable: everything not yet missed is still catchable. Needs the map's object counts
  // and a known droplet-miss count; otherwise the readout stays hidden rather than a dash.
  let max = null;
  if (composition && composition.total > 0 && hits.dropletMisses !== null) {
    max = Math.max(0, (composition.total - hits.misses - hits.dropletMisses) / composition.total) * 100;
    max = Math.floor(max * 100) / 100;
  }
  ui.max(percent(max));
  ui.maxUnknown(max === null ? '' : null);
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
  ledger.dataset.backing = options.backing;
  stat('acc').hidden = !options.showAcc;
  stat('max').hidden = !options.showAcc;
  const fruits = activeMode(values[P.state], values[P.playMode], values[P.settingsMode]) === 'fruits';
  wantPalette(fruits ? values[P.checksum] : null);
  scheduleRelayout();
});

new ResizeObserver(scheduleRelayout).observe(root);
document.fonts.ready.then(scheduleRelayout);

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
/**
 * A text cell keyed by its number (or null): `format` runs, and allocates, only when the number
 * changes, and the DOM is written only when the formatted text does.
 */
function numberCell(el, format) {
  let last, text = null;
  return value => {
    if (value === last) return;
    last = value;
    const next = format(value);
    if (next !== text) { text = next; el.textContent = next; }
  };
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
// Transform strings per thousandth, built the first time each is used. A segment at the track's
// start (fruits, droplets caught) then reuses a whole cached string; any other costs one
// concatenation of two cached pieces instead of two number conversions and a template.
const AT_START = new Array(1001).fill(null);
const TRANSLATE = new Array(1001).fill(null);
const TRANSLATE_MIRRORED = new Array(1001).fill(null);
const SCALE = new Array(1001).fill(null);
function scalePiece(k) {
  return SCALE[k] ?? (SCALE[k] = `scaleX(${k / 1000})`);
}
function transformOf(startK, widthK) {
  // translateX(0%) reads the same mirrored or not.
  if (startK === 0) return AT_START[widthK] ?? (AT_START[widthK] = `translateX(0%) ${scalePiece(widthK)}`);
  const table = mirrored ? TRANSLATE_MIRRORED : TRANSLATE;
  const translate = table[startK] ?? (table[startK] = `translateX(${(mirrored ? -startK : startK) / 1000 * 100}%) `);
  return translate + scalePiece(widthK);
}

/**
 * A bar segment spanning `[startCount, startCount + widthCount)` of `total`, positioned in
 * thousandths. Integer counts (not shares) let unchanged counts return at once and keep the
 * quantising to one division per edge.
 */
function segCell(el) {
  let lastStartCount = -1, lastWidthCount = -1, lastTotal = -1;
  let lastStart = -1, lastWidth = -1, lastEpoch = -1;
  return (startCount, widthCount, total) => {
    if (startCount === lastStartCount && widthCount === lastWidthCount && total === lastTotal && segEpoch === lastEpoch) return;
    lastStartCount = startCount; lastWidthCount = widthCount; lastTotal = total;
    let startK = 0, widthK = 0;
    if (total) {
      // A non-zero share stays visible: at least 16 ‰ (2 px of a ~120 px track), pushed back
      // from the track's end when it would overflow it.
      if (widthCount > 0 && widthCount * 1000 < 16 * total) {
        widthK = 16;
        startK = startCount * 1000 + 16 * total > 1000 * total ? 984 : Math.round(startCount * 1000 / total);
      } else {
        widthK = Math.round(widthCount * 1000 / total);
        startK = Math.round(startCount * 1000 / total);
      }
    }
    if (startK === lastStart && widthK === lastWidth && segEpoch === lastEpoch) return;
    lastStart = startK; lastWidth = widthK; lastEpoch = segEpoch;
    el.style.transform = transformOf(startK, widthK);
  };
}
const stat = name => document.querySelector(`.stat-${name}`);

const grouping = new Intl.NumberFormat('en-US');
const count = n => (n === null ? '—' : grouping.format(n));
const percent = n => (n === null ? '—' : n.toFixed(2));
const comboOf = n => (n === null ? '' : `/ ${grouping.format(n)}`);
const hundredths = n => (n === null ? '—' : (n / 100).toFixed(2));

const ui = {
  chipState: attrCell(chip, 'data-state'),
  chipText: textCell($('chip-text')),
  hidden: classCell(ledger, 'is-hidden'),
  verdict: textCell($('verdict')),
  tone: attrCell($('verdict'), 'data-tone'),
  fruit: numberCell($('n-fruit'), count),
  drop: numberCell($('n-drop'), count),
  tiny: numberCell($('n-tiny'), count),
  miss: numberCell($('n-miss'), count),
  missHot: classCell($('n-miss'), 'hot'),
  dmiss: numberCell($('n-dmiss'), count),
  dmissHot: classCell($('n-dmiss'), 'hot'),
  segFruit: segCell($('seg-fruit')),
  segDrop: segCell($('seg-drop')),
  segMiss: segCell($('seg-miss')),
  segTiny: segCell($('seg-tiny')),
  segDmiss: segCell($('seg-dmiss')),
  acc: numberCell($('acc'), percent),
  accEmpty: attrCell(stat('acc'), 'data-empty'),
  max: numberCell($('max'), hundredths),
  maxUnknown: attrCell(stat('max'), 'data-unknown'),
  combo: numberCell($('combo'), count),
  comboEmpty: attrCell(stat('combo'), 'data-empty'),
  comboOf: numberCell($('combo-of'), comboOf),
};

// ------------------------------------------------------------ state
const DEFAULTS = { orientation: 'auto', align: 'right', backing: 'scrim', accent: 'map', compact: false, showAcc: true };
// The subscribed values, copied out of the client's reused frame object on every message.
let gameState, playMode, settingsMode, checksum, mapComboRaw, accuracyRaw, comboRaw, comboMaxRaw;
let hit300, hit100, hit50, hit0, hitKatu, hitLarge, hitSmall;
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
  // Arguments rather than a closure: a captured parameter would allocate a context on every call.
  compositionTimer = setTimeout(loadComposition, 300, checksum, 0);
}

async function loadComposition(checksum, attempt) {
  try {
    const response = await fetch('/api/calculate/pp?mode=2', { cache: 'no-store' });
    if (compositionFor !== checksum) return;
    if (!response.ok) {
      // 503: the map is still being parsed; anything else means the route is unavailable.
      if (response.status === 503 && attempt < 5) compositionTimer = setTimeout(loadComposition, 1500, checksum, attempt + 1);
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

// The current hits (readHits), kept as scalars so a render builds no objects.
let fruits = 0, drops = 0, droplets = 0, misses = 0, raw = false;
let dropletMisses = null; // unknown when vosu publishes catch statistics raw

/**
 * Reads the hits. The brief's (tosu) catch table: 300 fruits, 100 drops, 50 droplets,
 * katu missed droplets, 0 fruit+drop misses. vosu v2 currently publishes catch statistics raw
 * (drops in largeTickHits, droplets in smallTickHits, droplet misses absent): then droplet
 * misses are unknown (null), never zero. Returns false when there are no hits yet.
 */
function readHits() {
  if (!Number.isFinite(hit300)) return false;
  const h100 = int(hit100);
  const h50 = int(hit50);
  const katu = int(hitKatu);
  const large = int(hitLarge);
  const small = int(hitSmall);
  raw = h100 === 0 && h50 === 0 && katu === 0 && (large > 0 || small > 0);
  fruits = hit300;
  drops = raw ? large : h100;
  droplets = raw ? small : h50;
  misses = int(hit0);
  dropletMisses = raw ? null : katu;
  return true;
}

const VERDICT = { none: '', broken: 'Combo broken', intact: 'Combo intact', fc: 'Full combo' };

/** The combo verdict's tone for the current hits; VERDICT maps it to its words. */
function verdictOf(maxCombo) {
  const judged = fruits + drops + droplets + misses + (dropletMisses ?? 0);
  if (!judged) return 'none';
  // Without a separate drop-miss count, a combo shorter than the combo objects caught means a break.
  const broken = misses > 0 || (raw && Number.isFinite(maxCombo) && maxCombo < fruits + drops);
  if (broken) return 'broken';
  if (dropletMisses === null || dropletMisses > 0) return 'intact';
  return 'fc';
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

  if (!Number.isInteger(gameState)) return chipOnly('idle', 'Waiting for osu!');
  ui.chipState('live');

  // Another ruleset, song select, results, menus: nothing.
  if (gameState !== PLAYING || activeMode(gameState, playMode, settingsMode) !== 'fruits') {
    ui.hidden(true);
    return;
  }
  ui.hidden(false);

  ui.comboOf(Number.isFinite(mapComboRaw) && mapComboRaw > 0 ? mapComboRaw : null);
  const combo = Number.isFinite(comboRaw) ? comboRaw : null;
  ui.combo(combo);
  ui.comboEmpty(combo === null ? '' : null);

  if (!readHits()) {
    ui.fruit(null); ui.drop(null); ui.tiny(null); ui.miss(null); ui.dmiss(null); ui.acc(null);
    ui.missHot(false); ui.dmissHot(false);
    ui.segFruit(0, 0, 0); ui.segDrop(0, 0, 0); ui.segMiss(0, 0, 0); ui.segTiny(0, 0, 0); ui.segDmiss(0, 0, 0);
    ui.tone('none'); ui.verdict('');
    ui.accEmpty(''); ui.maxUnknown('');
    return;
  }

  ui.fruit(fruits);
  ui.drop(drops);
  ui.tiny(droplets);
  ui.miss(misses);
  ui.missHot(misses > 0);
  ui.dmiss(dropletMisses);
  ui.dmissHot(dropletMisses > 0);

  // Waterfall shares: combo objects (fruits, drops, their misses) and droplets (caught, missed).
  const comboTotal = fruits + drops + misses;
  ui.segFruit(0, fruits, comboTotal);
  ui.segDrop(fruits, drops, comboTotal);
  ui.segMiss(fruits + drops, misses, comboTotal);
  const knownDropletMisses = dropletMisses ?? 0;
  const dropletTotal = droplets + knownDropletMisses;
  ui.segTiny(0, droplets, dropletTotal);
  ui.segDmiss(droplets, knownDropletMisses, dropletTotal);

  const tone = verdictOf(Number.isFinite(comboMaxRaw) ? comboMaxRaw : null);
  ui.tone(tone);
  ui.verdict(VERDICT[tone]);

  const accuracy = tone !== 'none' && Number.isFinite(accuracyRaw) ? accuracyRaw : null;
  ui.acc(accuracy);
  ui.accEmpty(accuracy === null ? '' : null);

  // Max achievable: everything not yet missed is still catchable. Needs the map's object counts
  // and a known droplet-miss count; otherwise the readout stays hidden rather than a dash.
  // Kept in integer hundredths of a percent, so an unchanged readout costs nothing.
  let max = null;
  if (composition && composition.total > 0 && dropletMisses !== null) {
    max = Math.floor(Math.max(0, (composition.total - misses - dropletMisses) / composition.total) * 100 * 100);
  }
  ui.max(max);
  ui.maxUnknown(max === null ? '' : null);
}

// ------------------------------------------------------------ wiring
subscribe([...Object.values(P), ...playHits], (next, changed) => {
  // `next` and `changed` are reused by the client for every frame: copy the values out now.
  gameState = next[P.state];
  playMode = next[P.playMode];
  settingsMode = next[P.settingsMode];
  checksum = next[P.checksum];
  mapComboRaw = next[P.mapCombo];
  accuracyRaw = next[P.accuracy];
  comboRaw = next[P.combo];
  comboMaxRaw = next[P.comboMax];
  hit300 = next[playHits[0]];
  hit100 = next[playHits[1]];
  hit50 = next[playHits[2]];
  hit0 = next[playHits[3]];
  hitKatu = next[playHits[4]];
  hitLarge = next[playHits[5]];
  hitSmall = next[playHits[6]];
  const isFruits = activeMode(gameState, playMode, settingsMode) === 'fruits';
  if (isFruits) wantComposition(checksum);
  if (changed.has(P.checksum) || changed.has(P.state)) wantPalette(isFruits ? checksum : null);
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
  const isFruits = activeMode(gameState, playMode, settingsMode) === 'fruits';
  wantPalette(isFruits ? checksum : null);
  scheduleRelayout();
});

new ResizeObserver(scheduleRelayout).observe(root);
document.fonts.ready.then(scheduleRelayout);

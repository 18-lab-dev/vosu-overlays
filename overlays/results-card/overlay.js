// Copyright (c) 2026 18-LAB. MIT.
// Results card: a splash shown only on the results screen (state 7). Hit errors are captured
// while the attempt is played so the histogram and UR belong to that attempt.
import { subscribe, settings, fit, MODES, MODE_LABELS } from './vosu-overlay.js';

const RESULTS = 7;
const PLAYING = 2;
const READY_FALLBACK_MS = 1500;
const BINS = 41;

const HIT_KEYS = ['300', '100', '50', '0', 'geki', 'katu', 'largeTickHits', 'smallTickHits'];
const POINTERS = [
  '/state/number', '/resultsScreen/mode/number', '/play/mode/number', '/settings/mode/number',
  '/resultsScreen/score', '/resultsScreen/accuracy', '/resultsScreen/maxCombo', '/resultsScreen/rank',
  '/resultsScreen/pp/current', '/resultsScreen/pp/fc', '/resultsScreen/playerName',
  '/resultsScreen/mods/name', '/resultsScreen/mods/array', '/resultsScreen/mods/rate', '/play/mods/rate',
  ...HIT_KEYS.map(key => `/resultsScreen/hits/${key}`),
  '/play/hits/sliderBreaks', '/play/hitErrorArray',
  '/beatmap/stats/maxCombo', '/beatmap/stats/hitWindow', '/beatmap/stats/stars/total',
  '/beatmap/title', '/beatmap/artist', '/beatmap/version', '/beatmap/mapper',
];

const $ = id => document.getElementById(id);
const stage = $('stage');
const card = $('card');
const chip = $('chip');
const canvas = $('hist');
const ctx = canvas.getContext('2d', { alpha: true });
fit(stage, 760, 448);

const css = getComputedStyle(document.documentElement);
const token = name => css.getPropertyValue(name).trim();
const COLORS = {
  bar: token('--fg-dim') || '#b8b5ad', rule: token('--rule') || '#25282c', ruleStrong: token('--rule-strong') || '#3b3f45',
  accent: token('--accent') || '#ff963f', muted: token('--muted') || '#7e8288',
  max: '#ebe8e1', great: '#7fa6cf', good: '#6fbf8e', ok: '#b8b5ad', meh: '#e8b04a', miss: '#ef5b4f',
};

// Ruleset-correct judgement rows: [label, colour token, reader(hits) -> number | null].
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const catchRaw = h => !h['100'] && !h['50'] && !h.katu && (h.largeTickHits > 0 || h.smallTickHits > 0);
const ROWS = {
  osu: [['300', 'great', h => h['300']], ['100', 'good', h => h['100']], ['50', 'meh', h => h['50']], ['Miss', 'miss', h => h['0']]],
  taiko: [['Great', 'great', h => h['300']], ['Ok', 'good', h => h['100']], ['Miss', 'miss', h => h['0']]],
  // vosu emits catch from raw statistics (drops/droplets in large/smallTickHits, missed droplets
  // unknown); tosu and older payloads use the legacy 100/50/katu shape. Read whichever is present.
  fruits: [
    ['Fruits', 'great', h => h['300']],
    ['Drops', 'good', h => (catchRaw(h) ? h.largeTickHits : h['100'])],
    ['Droplets', 'ok', h => (catchRaw(h) ? h.smallTickHits : h['50'])],
    ['Drop miss', 'meh', h => (catchRaw(h) ? null : h.katu)],
    ['Miss', 'miss', h => h['0']],
  ],
  mania: [['Max', 'max', h => h.geki], ['300', 'great', h => h['300']], ['200', 'good', h => h.katu], ['100', 'ok', h => h['100']], ['50', 'meh', h => h['50']], ['Miss', 'miss', h => h['0']]],
};
const GRADE_TEXT = { XH: 'SS', X: 'SS', SH: 'S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };
const GRADE_CAP = { XH: 'Grade · silver', SH: 'Grade · silver', F: 'Failed' };

// --------------------------------------------------------------------- hit-error capture
// Every timing event of the attempt, appended from the array's new tail only.
let errors = new Float32Array(4096);
let errorCount = 0;
let seenLength = 0;
let firstSeen = NaN;
let sliderBreaks = null;

function resetCapture() {
  errorCount = 0;
  seenLength = 0;
  firstSeen = NaN;
  sliderBreaks = null;
}

function ingest(array) {
  if (!Array.isArray(array)) return;
  // A shorter array or a different first event is a new attempt (quick retry).
  if (array.length < seenLength || (seenLength && array.length && array[0] !== firstSeen)) resetCapture();
  for (let i = seenLength; i < array.length; i++) {
    const value = array[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (errorCount === errors.length) {
      const grown = new Float32Array(errors.length * 2);
      grown.set(errors);
      errors = grown;
    }
    errors[errorCount++] = value;
  }
  if (array.length) firstSeen = array[0];
  seenLength = array.length;
}

// ------------------------------------------------------------------------- state
let config = { showBrand: true, showHistogram: true, showMap: true, hold: 0 };
let values = null;
let lastState;
let enteredAt = 0;
let holdTimer = 0;
let readyTimer = 0;
let expired = false;
let visible = false;
let builtMode = null;
let rowEls = [];
let textDirty = true;
let histDirty = true;
let classDirty = true;
let frame = 0;
let chipTimer = 0;

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function onResultsEntered() {
  enteredAt = performance.now();
  expired = false;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(updateVisibility, READY_FALLBACK_MS);
  armHold();
}

function armHold() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  if (lastState !== RESULTS || !(config.hold > 0)) { expired = false; return; }
  const remaining = config.hold * 1000 - (performance.now() - enteredAt);
  if (remaining <= 0) { expired = true; return; }
  expired = false;
  holdTimer = setTimeout(() => { expired = true; updateVisibility(); }, remaining);
}

function ready() {
  const rank = values['/resultsScreen/rank'];
  return (typeof rank === 'string' && rank !== '') || values['/resultsScreen/score'] > 0
    || performance.now() - enteredAt >= READY_FALLBACK_MS;
}

function updateVisibility() {
  const next = !!values && lastState === RESULTS && !expired && ready();
  if (next === visible) return;
  visible = next;
  if (visible) { textDirty = true; histDirty = true; }
  classDirty = true;
  schedule();
}

function onFrame(v, changed) {
  values = v;
  const state = v['/state/number'];
  if (state !== lastState) {
    // Only play -> results keeps the capture; any other entry (new attempt, menus, osu! gone) starts fresh.
    if (state !== RESULTS) resetCapture();
    lastState = state;
    if (state === RESULTS) onResultsEntered();
    else { clearTimeout(holdTimer); clearTimeout(readyTimer); }
  }
  if (state === PLAYING || state === RESULTS) {
    if (changed.has('/play/hitErrorArray')) { ingest(v['/play/hitErrorArray']); histDirty = true; }
    const breaks = num(v['/play/hits/sliderBreaks']);
    if (breaks !== null) sliderBreaks = breaks;
  }
  if (state === RESULTS) { textDirty = true; schedule(); }
  updateVisibility();
}

// The shared client reports 'live' on every frame, so this returns early unless the status changed.
let status = '';
function onStatus(next) {
  if (next === status) return;
  status = next;
  clearTimeout(chipTimer);
  if (next === 'live') { chip.hidden = true; return; }
  // Reconnect attempts after an outage keep reading "offline" rather than flickering.
  if (next === 'connecting' && !chip.hidden) return;
  const show = () => {
    chip.dataset.state = next;
    setText($('chipText'), next === 'offline' ? 'vosu offline' : 'connecting to vosu');
    chip.hidden = false;
  };
  // A brief connect on load is not worth a flash; a real outage is.
  if (next === 'connecting') chipTimer = setTimeout(show, 1500);
  else show();
}

settings(config, next => {
  config = { ...next, hold: Math.max(0, Number(next.hold) || 0) };
  classDirty = true;
  histDirty = true;
  armHold();
  if (values) updateVisibility();
  schedule();
});

subscribe(POINTERS, onFrame, { onStatus });

new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  const dpr = devicePixelRatio || 1;
  const width = Math.round(box.width * dpr);
  const height = Math.round(box.height * dpr);
  if (width === canvas.width && height === canvas.height) return;
  canvas.width = width;
  canvas.height = height;
  histDirty = true;
  schedule();
}).observe(canvas);

// ------------------------------------------------------------------------ render
// Writes only changed strings; "—" (no data) marks the element empty so CSS can quiet it.
function setText(el, text) {
  if (el._text === text) return;
  if ((el._text === '—') !== (text === '—')) el.classList.toggle('empty', text === '—');
  el._text = text;
  el.textContent = text;
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt = value => (value === null ? '—' : integer.format(value));

function currentMode() {
  const number = [values['/resultsScreen/mode/number'], values['/play/mode/number'], values['/settings/mode/number']].find(Number.isInteger);
  return MODES[number] ?? 'osu';
}

function buildRows(mode) {
  const list = $('rows');
  list.replaceChildren();
  rowEls = ROWS[mode].map(([label, color], index) => {
    const row = document.createElement('li');
    row.className = 'row';
    row.style.setProperty('--c', `var(--j-${color})`);
    row.style.setProperty('--i', index);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('span');
    fill.className = 'fill';
    track.append(fill);
    const count = document.createElement('span');
    count.className = 'count';
    const pct = document.createElement('span');
    pct.className = 'pct';
    row.append(name, track, count, pct);
    list.append(row);
    return { row, fill, count, pct, fraction: -1, zero: null };
  });
  builtMode = mode;
}

function renderMods() {
  const array = values['/resultsScreen/mods/array'];
  const name = values['/resultsScreen/mods/name'];
  const known = Array.isArray(array) || typeof name === 'string';
  const acronyms = Array.isArray(array) ? array.map(mod => mod?.acronym).filter(Boolean)
    : typeof name === 'string' && name ? name.match(/[A-Z0-9]{2}/g) || [] : [];
  const key = known ? acronyms.join(' ') : null;
  const mods = $('mods');
  if (mods._key === key) return;
  mods._key = key;
  // Absent mods show nothing; a known empty selection reads "NM".
  mods.replaceChildren(...(!known ? [] : acronyms.length ? acronyms : [null]).map(acronym => {
    const el = document.createElement(acronym ? 'b' : 'span');
    if (acronym) el.textContent = acronym;
    else { el.className = 'none'; el.textContent = 'NM'; }
    return el;
  }));
}

function renderText() {
  const v = values;
  const mode = currentMode();
  if (mode !== builtMode) buildRows(mode);
  if (card.dataset.mode !== mode) card.dataset.mode = mode;
  const modeKnown = [v['/resultsScreen/mode/number'], v['/play/mode/number'], v['/settings/mode/number']].some(Number.isInteger);
  setText($('mode'), modeKnown ? MODE_LABELS[mode] : '—');
  setText($('player'), typeof v['/resultsScreen/playerName'] === 'string' ? v['/resultsScreen/playerName'] : '');
  renderMods();
  const rate = num(v['/resultsScreen/mods/rate']) ?? num(v['/play/mods/rate']);
  setText($('rate'), rate !== null && Math.abs(rate - 1) > 1e-3 ? `${rate.toFixed(2)}×` : '');

  const str = pointer => (typeof v[pointer] === 'string' && v[pointer] ? v[pointer] : '');
  setText($('title'), str('/beatmap/title') || '—');
  setText($('artist'), str('/beatmap/artist'));
  setText($('version'), str('/beatmap/version'));
  setText($('mapper'), str('/beatmap/mapper') ? `mapped by ${str('/beatmap/mapper')}` : '');
  const stars = num(v['/beatmap/stats/stars/total']);
  setText($('stars'), stars ? `${stars.toFixed(2)}★` : '');

  const rank = str('/resultsScreen/rank');
  const grade = $('grade');
  if (grade.dataset.grade !== rank) grade.dataset.grade = rank;
  setText($('gradeLetter'), GRADE_TEXT[rank] ?? (rank || '—'));
  setText($('gradeCap'), GRADE_CAP[rank] ?? 'Grade');

  const score = num(v['/resultsScreen/score']);
  setText($('score'), fmt(score));
  const acc = num(v['/resultsScreen/accuracy']);
  setText($('acc'), acc === null ? '—' : acc.toFixed(2));

  const hits = {};
  for (const key of HIT_KEYS) hits[key] = num(v[`/resultsScreen/hits/${key}`]) ?? 0;
  const anyHits = HIT_KEYS.some(key => num(v[`/resultsScreen/hits/${key}`]) !== null);

  const combo = num(v['/resultsScreen/maxCombo']);
  const mapMax = num(v['/beatmap/stats/maxCombo']);
  setText($('combo'), fmt(combo));
  setText($('comboMax'), combo !== null && mapMax ? `/ ${integer.format(mapMax)}×` : combo !== null ? '×' : '');
  const fc = anyHits && combo !== null && combo > 0 && hits['0'] === 0 && (mode !== 'osu' || !sliderBreaks);
  $('fc').hidden = !fc;

  const pp = num(v['/resultsScreen/pp/current']);
  const ppFc = num(v['/resultsScreen/pp/fc']);
  setText($('pp'), pp === null ? '—' : integer.format(Math.round(pp)));
  setText($('ppFc'), !fc && ppFc !== null && pp !== null && ppFc - pp >= 0.5 ? `if FC ${integer.format(Math.round(ppFc))}` : '');

  // Judgement breakdown: bars are proportional to the judged total of this ruleset.
  const counts = ROWS[mode].map(([, , read]) => (anyHits ? num(read(hits)) : null));
  let total = 0;
  for (const count of counts) total += count ?? 0;
  setText($('total'), anyHits ? `${integer.format(total)} judged` : '');
  rowEls.forEach((el, i) => {
    const count = counts[i];
    const fraction = count !== null && total > 0 ? count / total : 0;
    if (fraction !== el.fraction) { el.fraction = fraction; el.fill.style.setProperty('--f', fraction.toFixed(4)); }
    setText(el.count, fmt(count));
    setText(el.pct, count === null || total === 0 ? '' : percent(fraction));
    const zero = count === 0 || count === null;
    if (zero !== el.zero) { el.zero = zero; el.row.classList.toggle('zero', zero); }
  });

  const showBreaks = mode === 'osu';
  $('breaks').hidden = !showBreaks;
  if (showBreaks) {
    setText($('breakCount'), sliderBreaks === null ? '—' : integer.format(sliderBreaks));
    $('breaks').classList.toggle('some', sliderBreaks > 0);
  }
}

function percent(fraction) {
  if (fraction === 0) return '0%';
  if (fraction < 0.001) return '<0.1%';
  return `${(fraction * 100).toFixed(fraction >= 0.995 ? 0 : 1)}%`;
}

// Histogram scratch, reused for every draw.
const bins = new Uint32Array(BINS);

function windowsOf(mode) {
  const w = values['/beatmap/stats/hitWindow'];
  const pick = key => (w && typeof w[key] === 'number' && w[key] > 0 ? w[key] : 0);
  if (mode === 'osu') return [['great', pick('great')], ['good', pick('ok')], ['meh', pick('meh')]];
  if (mode === 'taiko') return [['great', pick('great')], ['good', pick('ok')]];
  if (mode === 'mania') return [['max', pick('perfect')], ['great', pick('great')], ['good', pick('good')], ['ok', pick('ok')], ['meh', pick('meh')]];
  return [];
}

function renderHistogram() {
  const mode = currentMode();
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const n = errorCount;
  $('noTiming').hidden = n > 0;
  if (n < 2) {
    setText($('ur'), '—');
    setText($('mean'), '—');
    setText($('early'), '—');
    setText($('late'), '—');
    return;
  }
  let sum = 0, early = 0, late = 0, extent = 0;
  for (let i = 0; i < n; i++) {
    const e = errors[i];
    sum += e;
    if (e < 0) early++; else if (e > 0) late++;
    const a = e < 0 ? -e : e;
    if (a > extent) extent = a;
  }
  const average = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) { const d = errors[i] - average; squares += d * d; }
  setText($('ur'), (Math.sqrt(squares / n) * 10).toFixed(2));
  setText($('mean'), `${average < 0 ? '−' : average > 0 ? '+' : ''}${Math.abs(average).toFixed(1)}`);
  setText($('early'), `${Math.round((early / n) * 100)}%`);
  setText($('late'), `${Math.round((late / n) * 100)}%`);

  const windows = windowsOf(mode);
  const outer = windows.reduce((max, [, value]) => Math.max(max, value), 0);
  const range = outer || Math.max(20, Math.ceil(extent / 10) * 10);
  bins.fill(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((errors[i] + range) / (2 * range)) * BINS);
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    if (++bins[b] > peak) peak = bins[b];
  }

  const dpr = devicePixelRatio || 1;
  const strip = Math.round(4 * dpr);
  const gapBelow = Math.round(4 * dpr);
  const base = height - strip - gapBelow; // bar baseline (device px)
  const top = Math.round(6 * dpr);
  const xOf = ms => ((ms + range) / (2 * range)) * width;

  // Hit-window scale under the bars: innermost judgement drawn last so it stays on top.
  ctx.globalAlpha = 0.55;
  for (let i = windows.length - 1; i >= 0; i--) {
    const [name, value] = windows[i];
    if (!value) continue;
    ctx.fillStyle = COLORS[name];
    const x0 = Math.round(xOf(-value));
    ctx.fillRect(x0, height - strip, Math.round(xOf(value)) - x0, strip);
  }
  if (!windows.length) { ctx.fillStyle = COLORS.rule; ctx.fillRect(0, height - strip, width, strip); }
  ctx.globalAlpha = 1;

  // Bars, pixel-snapped with a 1 device-px gutter.
  const step = width / BINS;
  const gutter = Math.max(1, Math.round(dpr));
  ctx.fillStyle = COLORS.bar;
  for (let b = 0; b < BINS; b++) {
    if (!bins[b]) continue;
    const x0 = Math.round(b * step);
    const x1 = Math.round((b + 1) * step) - gutter;
    const h = Math.max(Math.round(dpr), Math.round((bins[b] / peak) * (base - top)));
    ctx.fillRect(x0, base - h, Math.max(1, x1 - x0), h);
  }

  // Baseline and zero line (hairlines).
  const hair = Math.max(1, Math.round(dpr));
  ctx.fillStyle = COLORS.ruleStrong;
  ctx.fillRect(0, base, width, hair);
  const zero = Math.round(xOf(0) - hair / 2);
  ctx.fillRect(zero, 0, hair, base);

  // Mean marker: accent hairline with a small cap.
  const m = Math.round(xOf(Math.max(-range, Math.min(range, average))) - hair / 2);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(m, 0, hair, base + hair);
  const cap = Math.round(3 * dpr);
  ctx.fillRect(m - cap, 0, cap * 2 + hair, hair * 2);
}

function render() {
  frame = 0;
  if (classDirty) {
    classDirty = false;
    card.classList.toggle('no-brand', !config.showBrand);
    card.classList.toggle('no-map', !config.showMap);
    card.classList.toggle('no-hist', !config.showHistogram);
    card.classList.toggle('on', visible);
    card.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
  if (!values || !visible) return;
  if (textDirty) { textDirty = false; renderText(); }
  if (histDirty && config.showHistogram && currentMode() !== 'fruits') { histDirty = false; renderHistogram(); }
}

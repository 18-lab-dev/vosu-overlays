// Copyright (c) 2026 18-LAB. MIT.
// Results timing: on the results screen only, adds what osu! leaves out there: UR, timing mean,
// early/late split and a hit-error histogram captured while the attempt was played, plus pp and
// the if-FC gap (stable's results screen shows no pp; lazer shows pp but no if-FC). It floats in
// space the results screen leaves empty and renders nothing in every other state.
import { subscribe, settings, fit, mapPalette, applyPalette, MODES } from './vosu-overlay.js';

const RESULTS = 7;
const READY_FALLBACK_MS = 1500;
const BINS = 41;
const AMBER = '#ff963f';

// Placement (positions live in style.css; settings add a nudge and scale):
// - header (default): a one-row strip in the right part of osu!stable's results header band
//   (x ≈ 1000–1900, y 8–130). Below it the ranking panel, grade art, mods and buttons fill the
//   screen, and the title/mapper/player text sits on the band's left. On lazer the top of the
//   results screen above the centred score panel is free as well.
// - center: a stacked block in the column between stable's score panel and grade (x ≈ 900–1390),
//   for skins whose grade art leaves it empty.

const POINTERS = [
  '/state/number', '/resultsScreen/mode/number', '/play/mode/number', '/settings/mode/number',
  '/resultsScreen/score', '/resultsScreen/rank', '/resultsScreen/pp/current', '/resultsScreen/pp/fc',
  '/play/hitErrorArray', '/beatmap/stats/hitWindow', '/beatmap/checksum',
];

const $ = id => document.getElementById(id);
const stage = $('stage');
const zone = $('zone');
const card = $('card');
const chip = $('chip');
const canvas = $('hist');
const ctx = canvas.getContext('2d', { alpha: true });
fit(stage, 1920, 1080);

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const COLORS = {
  bar: token('--fg', '#ebe8e1'), axis: 'rgb(235 232 225 / .45)',
  max: '#ebe8e1', great: '#7fa6cf', good: '#6fbf8e', ok: '#b8b5ad', meh: '#e8b04a',
};
let highlight = AMBER;

// --------------------------------------------------------------------- hit-error capture
// Every timing event of the attempt, appended from the array's new tail only.
let errors = new Float32Array(4096);
let errorCount = 0;
let seenLength = 0;
let firstSeen = NaN;

function resetCapture() {
  errorCount = 0;
  seenLength = 0;
  firstSeen = NaN;
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
const DEFAULTS = { zone: 'header', x: 0, y: 0, scale: 1, backing: 'none', accent: 'map', showHistogram: true, showPp: true, hold: 0, showBrand: true };
let config = { ...DEFAULTS };
let values = null;
let lastState;
let enteredAt = 0;
let holdTimer = 0;
let readyTimer = 0;
let expired = false;
let visible = false;
let textDirty = true;
let histDirty = true;
let classDirty = true;
let placeDirty = true;
let frame = 0;
let chipTimer = 0;
let checksum = '';
let palette = null;

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

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function ready() {
  const rank = values['/resultsScreen/rank'];
  return (typeof rank === 'string' && rank !== '') || values['/resultsScreen/score'] > 0
    || performance.now() - enteredAt >= READY_FALLBACK_MS;
}

const hasTiming = () => errorCount >= 2;
const hasPp = () => config.showPp && num(values['/resultsScreen/pp/current']) !== null;

function updateVisibility() {
  // Nothing worth adding (catch without pp, a score opened from song select, …) renders nothing.
  const next = !!values && lastState === RESULTS && !expired && ready() && (hasTiming() || hasPp());
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
  if ((state === 2 || state === RESULTS) && changed.has('/play/hitErrorArray')) {
    ingest(v['/play/hitErrorArray']);
    histDirty = true;
  }
  if (changed.has('/beatmap/checksum')) {
    const next = typeof v['/beatmap/checksum'] === 'string' ? v['/beatmap/checksum'] : '';
    if (next !== checksum) { checksum = next; requestPalette(); }
  }
  if (state === RESULTS) textDirty = true;
  if (placeDirty || (state === RESULTS && visible)) schedule();
  updateVisibility();
}

// Map tint: derived once per map off the hot path; the art itself is never shown.
function requestPalette() {
  palette = null;
  applyTint();
  if (config.accent !== 'map' || !checksum) return;
  const wanted = checksum;
  mapPalette(wanted).then(result => {
    if (wanted !== checksum) return;
    palette = result;
    applyTint();
  });
}

function applyTint() {
  const use = config.accent === 'map' ? palette : null;
  applyPalette(zone, use);
  zone.classList.toggle('tint', !!use);
  const next = use?.accent || AMBER;
  if (next !== highlight) { highlight = next; histDirty = true; schedule(); }
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

settings(DEFAULTS, next => {
  const accentChanged = next.accent !== config.accent;
  config = {
    ...next,
    hold: Math.max(0, Number(next.hold) || 0),
    scale: Math.min(2, Math.max(0.5, Number(next.scale) || 1)),
  };
  classDirty = true;
  histDirty = true;
  textDirty = true;
  placeDirty = true;
  armHold();
  if (accentChanged) requestPalette();
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

function currentMode() {
  const number = [values['/resultsScreen/mode/number'], values['/play/mode/number'], values['/settings/mode/number']].find(Number.isInteger);
  return MODES[number] ?? 'osu';
}

function place() {
  zone.dataset.layout = config.zone === 'center' ? 'stack' : 'strip';
  zone.style.transform = `translate(${Number(config.x) || 0}px, ${Number(config.y) || 0}px) scale(${config.scale})`;
}

function renderText() {
  zone.classList.toggle('no-timing', !hasTiming());
  const pp = num(values['/resultsScreen/pp/current']);
  const ppFc = num(values['/resultsScreen/pp/fc']);
  $('perf').hidden = !hasPp();
  setText($('pp'), pp === null ? '—' : integer.format(Math.round(pp)));
  const gap = pp !== null && ppFc !== null ? ppFc - pp : 0;
  $('ifFc').hidden = !(gap >= 0.5);
  if (gap >= 0.5) {
    setText($('ppFc'), integer.format(Math.round(ppFc)));
    setText($('ppGap'), `+${integer.format(Math.round(ppFc) - Math.round(pp))}`);
  }
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

function renderTiming() {
  const n = errorCount;
  if (n < 2) return;
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
  const sigma = Math.sqrt(squares / n);
  setText($('ur'), (sigma * 10).toFixed(2));
  setText($('mean'), `${average < 0 ? '−' : average > 0 ? '+' : ''}${Math.abs(average).toFixed(1)}`);
  setText($('early'), `${Math.round((early / n) * 100)}%`);
  setText($('late'), `${Math.round((late / n) * 100)}%`);
  if (!config.showHistogram) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const windows = windowsOf(currentMode());
  const outer = windows.reduce((max, [, value]) => Math.max(max, value), 0);
  const great = windows.find(([name]) => name === 'great')?.[1] || 0;
  // Frame the distribution (±3.5σ around the mean), never tighter than the great window nor wider
  // than the outermost one, so a 300 px strip shows shape rather than one spike.
  const spread = Math.ceil((3.5 * sigma + Math.abs(average)) / 5) * 5;
  const range = outer ? Math.min(outer, Math.max(great, spread, 10)) : Math.max(20, Math.ceil(extent / 10) * 10);
  bins.fill(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((errors[i] + range) / (2 * range)) * BINS);
    if (b < 0 || b >= BINS) continue; // outliers stay in UR/mean, not on the frame's edge
    if (++bins[b] > peak) peak = bins[b];
  }

  const dpr = devicePixelRatio || 1;
  const hair = Math.max(1, Math.round(dpr));
  const strip = Math.round(4 * dpr);
  const base = height - strip - Math.round(4 * dpr); // bar baseline (device px)
  const top = Math.round(6 * dpr);
  const xOf = ms => ((ms + range) / (2 * range)) * width;

  // Contrast over any map background: the same restrained shadow as the text.
  ctx.shadowColor = 'rgb(0 0 0 / .55)';
  ctx.shadowBlur = 2 * dpr;
  ctx.shadowOffsetY = dpr;

  // Hit-window scale under the bars: innermost judgement drawn last so it stays on top.
  for (let i = windows.length - 1; i >= 0; i--) {
    const [name, value] = windows[i];
    if (!value) continue;
    ctx.fillStyle = COLORS[name];
    const x0 = Math.round(xOf(-value));
    ctx.fillRect(x0, height - strip, Math.round(xOf(value)) - x0, strip);
  }

  // Bars, pixel-snapped with a 1 device-px gutter.
  const step = width / BINS;
  ctx.fillStyle = COLORS.bar;
  ctx.globalAlpha = 0.92;
  for (let b = 0; b < BINS; b++) {
    if (!bins[b]) continue;
    const x0 = Math.round(b * step);
    const x1 = Math.round((b + 1) * step) - hair;
    const h = Math.max(hair, Math.round((bins[b] / peak) * (base - top)));
    ctx.fillRect(x0, base - h, Math.max(1, x1 - x0), h);
  }
  ctx.globalAlpha = 1;

  // Baseline and zero line (hairlines).
  ctx.fillStyle = COLORS.axis;
  ctx.fillRect(0, base, width, hair);
  ctx.fillRect(Math.round(xOf(0) - hair / 2), 0, hair, base);

  // Mean marker in the highlight colour, with a small cap.
  const m = Math.round(xOf(Math.max(-range, Math.min(range, average))) - hair / 2);
  ctx.fillStyle = highlight;
  ctx.fillRect(m, 0, hair * 2, base + hair);
  const cap = Math.round(4 * dpr);
  ctx.fillRect(m - cap, 0, cap * 2 + hair * 2, hair * 2);
  ctx.shadowColor = 'transparent';
}

function render() {
  frame = 0;
  if (placeDirty) { placeDirty = false; place(); }
  if (classDirty) {
    classDirty = false;
    zone.dataset.backing = config.backing;
    zone.classList.toggle('no-brand', !config.showBrand);
    zone.classList.toggle('no-hist', !config.showHistogram);
    card.classList.toggle('on', visible);
    card.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
  if (!values || !visible) return;
  if (textDirty) { textDirty = false; renderText(); }
  if (histDirty) { histDirty = false; renderTiming(); }
}

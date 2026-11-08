// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko drum input: four drum zones lighting on press, per-zone counts, hand balance,
// alternation, same-hand repeats and live KPS. Data comes only from vosu's `/keys/all`.
import { subscribe, settings, fit, activeMode, isPlaying } from './vosu-overlay.js';

const WIDTH = 576;
const HEIGHT = 288;
const RESULTS = 7;
const POINTERS = ['/state/number', '/play/mode/number', '/settings/mode/number', '/keys/all'];

// keys.all order in taiko: B1 left rim (kat), B2 left centre (don), B3 right centre (don), B4 right rim (kat).
const HAND = [0, 0, 1, 1];
const KAT = [true, false, false, true];
const DECAY_MS = 170;          // light fade after release
const KPS_WINDOW = 1000;
const KPS_RING = 256;
const CHORD_MS = 12;           // both hands within this = one doubled (big-note) hit, not an alternation
const MAX_FRAME_PRESSES = 24;  // bigger jumps are an attach/baseline, not playing
const SEQ = 24;                // hits in the hand sequence strip
const CHORD = 2;               // prevHand value after a doubled hit
const NONE = -1;

const $ = id => document.getElementById(id);
const stage = $('stage');
const panel = $('panel');
const statusEl = $('status');
const statusText = $('status-text');
const chipText = $('chip-text');
const note = $('note');
const countEls = [$('c0'), $('c1'), $('c2'), $('c3')];
const kpsEl = $('kps');
const kpsLabel = $('kps-label');
const subLabel = $('sub-label');
const subEl = $('sub');
const balL = $('bal-l');
const balR = $('bal-r');
const balFill = $('bal-fill');
const altEl = $('alt');
const repEl = $('rep');
const drumCanvas = $('drum-canvas');
const seqCanvas = $('seq-canvas');
const drumCtx = drumCanvas.getContext('2d', { alpha: true });
const seqCtx = seqCanvas.getContext('2d', { alpha: true });

fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------------ state
const live = new Int32Array(4);        // vosu counts as last received
const held = new Int32Array(4);        // counts frozen when the attempt ended
let hasLive = false;
let hasHeld = false;
const pressed = new Uint8Array(4);
const litAt = new Float64Array(4).fill(-1e9);
const level = new Float32Array(4);
const pressedAt = new Float64Array(4);
const delta = new Int32Array(4);
const order = new Uint8Array(4);

let alternations = 0;
let repeats = 0;
let prevHand = NONE;
let prevT = NaN;
let peak = 0;
let kps = 0;
const kpsTimes = new Float64Array(KPS_RING);
let kpsHead = 0;
let kpsLen = 0;
let kpsTimer = 0;
const seq = new Uint8Array(SEQ);       // zone bitmask per hit, ring
let seqHead = 0;
let seqLen = 0;

let phase = 'none';   // none | live | result | last | idle
let visible = false;
let online = false;
let wasPlaying = false;
let keysMissing = false;

let drumDirty = true;
let seqDirty = true;
let textDirty = true;
let raf = 0;

// Colours resolve from tokens on every settings change, never inside rAF.
let zoneColour = ['#7fa6cf', '#ef5b4f', '#ef5b4f', '#7fa6cf'];
let tokens = null;
function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  tokens = {
    fg: get('--fg', '#ebe8e1'), signal: get('--signal', '#7fa6cf'), danger: get('--danger', '#ef5b4f'),
    accent: get('--accent', '#ff963f'), rule: get('--rule', '#25282c'), ruleStrong: get('--rule-strong', '#3b3f45'),
    sunken: get('--bg-sunken', '#0b0c0d'), raised: get('--bg-raised', '#17191c'),
  };
}

function resetRun() {
  alternations = repeats = 0;
  prevHand = NONE;
  prevT = NaN;
  peak = kps = 0;
  kpsHead = kpsLen = 0;
  clearTimeout(kpsTimer);
  seqHead = seqLen = 0;
  seqDirty = textDirty = true;
}

// ------------------------------------------------------------------ input
function press(zone, t, now) {
  const hand = HAND[zone];
  const timed = Number.isFinite(t) && Number.isFinite(prevT);
  if ((prevHand === 0 || prevHand === 1) && hand !== prevHand && timed && t - prevT <= CHORD_MS) {
    // Both centres (or rims) together: a big-note double, merged into the previous strip slot.
    seq[(seqHead + SEQ - 1) % SEQ] |= 1 << zone;
    prevHand = CHORD;
  } else {
    if (prevHand === 0 || prevHand === 1) {
      if (hand === prevHand) repeats++;
      else alternations++;
    }
    prevHand = hand;
    seq[seqHead] = 1 << zone;
    seqHead = (seqHead + 1) % SEQ;
    if (seqLen < SEQ) seqLen++;
  }
  if (Number.isFinite(t)) prevT = t;
  litAt[zone] = now;
  kpsTimes[(kpsHead + kpsLen) % KPS_RING] = now;
  if (kpsLen < KPS_RING) kpsLen++;
  else kpsHead = (kpsHead + 1) % KPS_RING;
}

function expireKps(now) {
  while (kpsLen && kpsTimes[kpsHead] <= now - KPS_WINDOW) {
    kpsHead = (kpsHead + 1) % KPS_RING;
    kpsLen--;
  }
  if (kpsLen !== kps) { kps = kpsLen; textDirty = true; }
  if (kps > peak) peak = kps;
  clearTimeout(kpsTimer);
  if (kpsLen) kpsTimer = setTimeout(onKpsTimer, kpsTimes[kpsHead] + KPS_WINDOW - now + 1);
}
function onKpsTimer() {
  expireKps(performance.now());
  requestRender();
}

/** Reads one `/keys/all` frame. Counts only become hits while an attempt is live. */
function ingestKeys(all, playing, now) {
  let total = 0;
  let dropped = false;
  for (let i = 0; i < 4; i++) {
    const key = all[i];
    const count = key && Number.isFinite(key.count) ? key.count : 0;
    const down = key && key.isPressed ? 1 : 0;
    if (down !== pressed[i]) {
      pressed[i] = down;
      if (!down) litAt[i] = now;
      drumDirty = true;
    }
    pressedAt[i] = key && Number.isFinite(key.pressedAt) ? key.pressedAt : -Infinity;
    if (count < live[i]) dropped = true;
    delta[i] = count;
  }
  if (dropped && playing) resetRun(); // retry / rewind restarts the attempt's counts
  for (let i = 0; i < 4; i++) {
    const count = delta[i];
    delta[i] = dropped ? count : count - live[i];
    if (delta[i] < 0) delta[i] = 0;
    total += delta[i];
    if (live[i] !== count) { live[i] = count; textDirty = true; }
  }
  hasLive = true;
  if (!playing || total === 0 || total > MAX_FRAME_PRESSES) return;
  // Order this frame's zones by their latest press edge so alternation survives batched frames.
  for (let i = 0; i < 4; i++) {
    let j = i;
    while (j > 0 && pressedAt[order[j - 1]] > pressedAt[i]) { order[j] = order[j - 1]; j--; }
    order[j] = i;
  }
  for (let k = 0; k < 4; k++) {
    const zone = order[k];
    for (let n = delta[zone]; n > 0; n--) press(zone, n === 1 ? pressedAt[zone] : NaN, now);
  }
  expireKps(now);
  seqDirty = drumDirty = textDirty = true;
}

// ------------------------------------------------------------------ data
function onFrame(values) {
  const now = performance.now();
  const state = values['/state/number'];
  const mode = activeMode(state, values['/play/mode/number'], values['/settings/mode/number']);
  const all = values['/keys/all'];
  const playing = isPlaying(state) && mode === 'taiko';

  if (playing && !wasPlaying) { resetRun(); hasHeld = false; }
  if (!playing && wasPlaying) {
    held.set(live);
    hasHeld = held[0] + held[1] + held[2] + held[3] > 0;
    expireKps(now);
  }
  wasPlaying = playing;

  const game = state !== undefined;
  if (!game && hasHeld) { hasHeld = false; resetRun(); } // osu! closed: the last attempt is gone
  const missing = game && mode === 'taiko' && !Array.isArray(all);
  if (missing !== keysMissing) { keysMissing = missing; textDirty = true; }
  if (Array.isArray(all)) ingestKeys(all, playing, now);
  else if (hasLive) { hasLive = false; textDirty = true; }

  const next = !game ? 'none' : playing ? 'live' : hasHeld ? (state === RESULTS ? 'result' : 'last') : state === RESULTS ? 'result' : 'idle';
  if (next !== phase) { phase = next; textDirty = true; }
  setVisible(online && (!game || mode === 'taiko'));
  requestRender();
}

let connectingTimer = 0;
function status(state) {
  online = state === 'live';
  clearTimeout(connectingTimer);
  if (state === 'connecting') {
    // A first connect is near-instant; only surface it when it drags. Retries stay "offline".
    if (statusEl.dataset.state !== 'offline') connectingTimer = setTimeout(() => showStatus('connecting', 'Connecting to vosu'), 800);
  } else if (state === 'offline') {
    showStatus('offline', 'vosu offline');
    setVisible(false);
  } else {
    showStatus('live', '');
  }
}
function showStatus(state, text) {
  if (statusEl.dataset.state !== state) statusEl.dataset.state = state;
  if (text) setText(statusText, text);
}
statusEl.dataset.state = 'live';

function setVisible(next) {
  if (next === visible) return;
  visible = next;
  panel.dataset.visible = String(next);
}

// ------------------------------------------------------------------ settings
const COLOUR_MODES = { 'Don red / kat blue': 'don-kat', 'Left blue / right amber': 'hands', Monochrome: 'mono' };
const SIZES = new Set(['small', 'medium', 'large']);
function applySettings(s) {
  readTokens();
  const colour = COLOUR_MODES[s.colourMode] || 'don-kat';
  panel.dataset.colour = colour;
  panel.dataset.size = SIZES.has(s.drumSize) ? s.drumSize : 'medium';
  panel.dataset.stats = String(s.showStats);
  panel.dataset.brand = String(s.showBrand);
  zoneColour = colour === 'hands' ? [tokens.signal, tokens.signal, tokens.accent, tokens.accent]
    : colour === 'mono' ? [tokens.fg, tokens.fg, tokens.fg, tokens.fg]
    : [tokens.signal, tokens.danger, tokens.danger, tokens.signal];
  drumDirty = seqDirty = true;
  requestRender();
}

// ------------------------------------------------------------------ canvas sizing
const dpr = () => window.devicePixelRatio || 1;
let drumSize = 0;
let drumScale = 1;
const zonePaths = [null, null, null, null];
let seqW = 0;
let seqH = 0;
let seqScale = 1;

/** Sizes a canvas backing store to its CSS box at device resolution; returns the CSS size. */
function sizeCanvas(entry, canvas) {
  const css = entry.contentBoxSize?.[0];
  const device = entry.devicePixelContentBoxSize?.[0];
  const w = css ? css.inlineSize : entry.contentRect.width;
  const h = css ? css.blockSize : entry.contentRect.height;
  if (!w || !h) return null; // hidden (stats off): keep the old backing store
  canvas.width = device?.inlineSize || Math.round(w * dpr());
  canvas.height = device?.blockSize || Math.round(h * dpr());
  return { w, h, scale: canvas.width / w };
}

const resize = new ResizeObserver(entries => {
  for (const entry of entries) {
    const canvas = entry.target;
    const size = sizeCanvas(entry, canvas);
    if (!size) continue;
    if (canvas === drumCanvas) {
      drumSize = size.w;
      drumScale = size.scale;
      buildPaths(size.w);
      drumDirty = true;
    } else {
      seqW = size.w;
      seqH = size.h;
      seqScale = size.scale;
      seqDirty = true;
    }
  }
  requestRender();
});
for (const canvas of [drumCanvas, seqCanvas]) {
  try { resize.observe(canvas, { box: 'device-pixel-content-box' }); } catch { resize.observe(canvas); }
}

/** Four zone outlines with a parallel centre split and a gap between rim and face. */
function buildPaths(size) {
  const c = size / 2;
  const gap = Math.max(2, Math.round(size / 64));
  const h = gap / 2;
  const outer = c - 1;
  const inner = Math.round(outer * 0.69);
  const face = inner - gap;
  const a = r => Math.asin(Math.min(1, h / r));
  const HALF = Math.PI / 2;

  const rimL = new Path2D();
  rimL.arc(c, c, outer, HALF + a(outer), 3 * HALF - a(outer));
  rimL.arc(c, c, inner, 3 * HALF - a(inner), HALF + a(inner), true);
  rimL.closePath();
  const faceL = new Path2D();
  faceL.arc(c, c, face, HALF + a(face), 3 * HALF - a(face));
  faceL.closePath();
  const faceR = new Path2D();
  faceR.arc(c, c, face, -HALF + a(face), HALF - a(face));
  faceR.closePath();
  const rimR = new Path2D();
  rimR.arc(c, c, outer, -HALF + a(outer), HALF - a(outer));
  rimR.arc(c, c, inner, HALF - a(inner), -HALF + a(inner), true);
  rimR.closePath();
  zonePaths[0] = rimL;
  zonePaths[1] = faceL;
  zonePaths[2] = faceR;
  zonePaths[3] = rimR;
}

// ------------------------------------------------------------------ render
function requestRender() {
  if (!raf) raf = requestAnimationFrame(render);
}

function render() {
  raf = 0;
  const now = performance.now();
  let animating = false;
  for (let i = 0; i < 4; i++) {
    let next = 1;
    if (!pressed[i]) {
      const p = (now - litAt[i]) / DECAY_MS;
      next = p <= 0 ? 1 : p >= 1 ? 0 : (1 - p) * (1 - p) * (1 - p);
      if (next > 0) animating = true;
    }
    if (Math.abs(next - level[i]) > 0.002 || (next === 0 && level[i] !== 0)) { level[i] = next; drumDirty = true; }
  }
  if (drumDirty && drumSize && tokens) drawDrum();
  if (seqDirty && seqW && tokens) drawSeq();
  if (textDirty) writeText();
  if (animating) requestRender();
}

function drawDrum() {
  drumDirty = false;
  const ctx = drumCtx;
  ctx.setTransform(drumScale, 0, 0, drumScale, 0, 0);
  ctx.clearRect(0, 0, drumSize, drumSize);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const path = zonePaths[i];
    const lit = level[i];
    const colour = zoneColour[i];
    ctx.globalAlpha = 1;
    ctx.fillStyle = KAT[i] ? tokens.sunken : tokens.raised;
    ctx.fill(path);
    // Resting zones keep their colour identity, quietly; a press fills them.
    ctx.globalAlpha = (KAT[i] ? 0.08 : 0.06) + lit * (KAT[i] ? 0.7 : 0.58);
    ctx.fillStyle = colour;
    ctx.fill(path);
    ctx.globalAlpha = 0.42 + 0.58 * lit;
    ctx.strokeStyle = colour;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

function drawSeq() {
  seqDirty = false;
  const ctx = seqCtx;
  ctx.setTransform(seqScale, 0, 0, seqScale, 0, 0);
  ctx.clearRect(0, 0, seqW, seqH);
  const pitch = seqW / SEQ;
  const block = Math.max(2, Math.floor(pitch) - 2);
  const row = Math.floor((seqH - 4) / 2);
  const top = 1;
  const bottom = seqH - 1 - row;
  ctx.globalAlpha = 1;
  ctx.fillStyle = tokens.rule;
  ctx.fillRect(0, Math.floor(seqH / 2), seqW, 1);
  ctx.lineWidth = 1;
  for (let k = 0; k < seqLen; k++) {
    const mask = seq[(seqHead - seqLen + k + SEQ) % SEQ];
    const x = Math.round((SEQ - seqLen + k) * pitch);
    const age = (k + 1) / seqLen;
    ctx.globalAlpha = 0.25 + 0.75 * age * age;
    for (let zone = 0; zone < 4; zone++) {
      if (!(mask & (1 << zone))) continue;
      const y = HAND[zone] === 0 ? top : bottom;
      if (KAT[zone]) {
        // Kat hollow, don solid: the shape carries the note type in every colour mode.
        ctx.strokeStyle = zoneColour[zone];
        ctx.strokeRect(x + 0.5, y + 0.5, block - 1, row - 1);
      } else {
        ctx.fillStyle = zoneColour[zone];
        ctx.fillRect(x, y, block, row);
      }
    }
  }
  ctx.globalAlpha = 1;
}

const DASH = '—';
function setText(el, text) {
  if (el._text === text) return;
  const empty = text === DASH;
  if ((el._text === DASH) !== empty) el.classList.toggle('empty', empty);
  el._text = text;
  el.textContent = text;
}

const CHIP = { none: 'No game', live: 'Live', result: 'Result', last: 'Last play', idle: 'Ready' };

function writeText() {
  textDirty = false;
  if (panel.dataset.phase !== phase) panel.dataset.phase = phase;
  setText(chipText, CHIP[phase]);

  // Which counts to show: live attempt > held result > whatever vosu still reports.
  let counts = null;
  if (phase === 'live' && hasLive) counts = live;
  else if (hasHeld) counts = held;
  else if (phase !== 'none' && hasLive && live[0] + live[1] + live[2] + live[3] > 0) counts = live;

  const total = counts ? counts[0] + counts[1] + counts[2] + counts[3] : 0;
  for (let i = 0; i < 4; i++) setText(countEls[i], counts ? String(counts[i]) : '—');

  if (total > 0) {
    const left = (counts[0] + counts[1]) / total;
    const l = Math.round(left * 100);
    setText(balL, `${l}%`);
    setText(balR, `${100 - l}%`);
    const transform = `scaleX(${left.toFixed(3)})`;
    if (balFill._transform !== transform) { balFill._transform = transform; balFill.style.transform = transform; }
  } else {
    setText(balL, '—');
    setText(balR, '—');
    if (balFill._transform !== 'scaleX(0)') { balFill._transform = 'scaleX(0)'; balFill.style.transform = 'scaleX(0)'; }
  }
  if (panel.dataset.empty !== String(total === 0)) panel.dataset.empty = String(total === 0);

  const pairs = alternations + repeats;
  const derived = phase === 'live' || hasHeld;
  setText(altEl, derived && pairs ? `${Math.round(alternations / pairs * 100)}%` : '—');
  setText(repEl, derived && pairs ? String(repeats) : '—');

  if (phase === 'live') {
    setText(kpsLabel, 'KPS');
    setText(kpsEl, hasLive ? String(kps) : DASH);
    setText(subLabel, 'Peak');
    setText(subEl, peak ? String(peak) : '—');
  } else {
    setText(kpsLabel, 'Peak KPS');
    setText(kpsEl, hasHeld && peak ? String(peak) : '—');
    setText(subLabel, 'Hits');
    setText(subEl, total ? String(total) : '—');
  }
  if (keysMissing === note.hidden) note.hidden = !keysMissing;
}

// ------------------------------------------------------------------ start
settings({ showStats: true, drumSize: 'medium', colourMode: 'Don red / kat blue', showBrand: true }, applySettings);
subscribe(POINTERS, onFrame, { onStatus: status });

// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko drum input: four drum zones lighting on press, per-zone counts, live KPS and peak,
// hand balance, the recent hits by hand, alternation and same-hand repeats. Data comes only from
// vosu's `/keys/all`; shown during taiko gameplay only. The page is content-sized: it re-flows to
// whatever box its host gives it (one row for strips, a column for tall boxes).
import { subscribe, settings, activeMode, isPlaying, mapPalette, applyPalette } from './vosu-overlay.js';

const POINTERS = ['/state/number', '/play/mode/number', '/settings/mode/number', '/keys/all', '/beatmap/checksum'];

// keys.all order in taiko: B1 left rim (kat), B2 left centre (don), B3 right centre (don), B4 right rim (kat).
const HAND = [0, 0, 1, 1];
const KAT = [true, false, false, true];
const DECAY_MS = 170;          // light fade after release
const KPS_WINDOW = 1000;
const KPS_RING = 256;
const CHORD_MS = 12;           // both hands within this = one doubled (big-note) hit, not an alternation
const MAX_FRAME_PRESSES = 24;  // bigger jumps are an attach/baseline, not playing
const SEQ_MAX = 48;            // hits kept for the hand strip; the box decides how many show
const CHORD = 2;               // prevHand value after a doubled hit
const NONE = -1;
const DASH = '—';

// Design sizes (CSS px before scaling) — must match style.css.
const ROW_HEIGHT = { full: 96, compact: 60 };
const FULL_MIN_SCALE = 0.75;   // below this a full row's 12 px labels get too small: go compact
const BLOCK = {
  full: { drum: 76, counts: 216, kps: 64, peak: 52, hands: 184, seq: 120, alt: 100, rep: 84, gap: 24, pad: 12 },
  compact: { drum: 48, counts: 194, kps: 70, peak: 80, hands: 150, seq: 100, alt: 80, rep: 70, gap: 18, pad: 6 },
};
const STAT_BLOCKS = ['drum', 'counts', 'kps', 'peak', 'hands', 'seq', 'alt', 'rep'];
const DROP_ORDER = ['rep', 'peak', 'seq', 'alt', 'hands']; // first to go when the box is too narrow
const COLUMN = { w: 296, h: 520, hBare: 276 };
const SEQ_PITCH = { full: 7, compact: 6, vertical: 11 };

const $ = id => document.getElementById(id);
const ov = $('ov');
const chip = $('chip');
const chipText = $('chip-text');
const countEls = [$('c0'), $('c1'), $('c2'), $('c3')];
const kpsEl = $('kps');
const peakEl = $('peak');
const balL = $('bal-l');
const balR = $('bal-r');
const balFill = $('bal-fill');
const altEl = $('alt');
const repEl = $('rep');
const drumCanvas = $('drum-canvas');
const seqCanvas = $('seq-canvas');
const drumCtx = drumCanvas.getContext('2d', { alpha: true });
const seqCtx = seqCanvas.getContext('2d', { alpha: true });

// ------------------------------------------------------------------ state
const live = new Int32Array(4);        // vosu counts as last received
let hasLive = false;
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
const seq = new Uint8Array(SEQ_MAX);   // zone bitmask per hit, ring
let seqHead = 0;
let seqLen = 0;

let show = 'none';     // none | play | chip | note
let online = false;
let offline = false;
let game = false;
let wasPlaying = false;
let checksum = '';
let palette = null;
let current = null;    // latest settings

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
  tokens = { fg: get('--fg', '#ebe8e1'), signal: get('--signal', '#7fa6cf'), danger: get('--danger', '#ef5b4f'), accent: get('--accent', '#ff963f') };
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
    // Both hands together: a big-note double, merged into the previous strip slot.
    seq[(seqHead + SEQ_MAX - 1) % SEQ_MAX] |= 1 << zone;
    prevHand = CHORD;
  } else {
    if (prevHand === 0 || prevHand === 1) {
      if (hand === prevHand) repeats++;
      else alternations++;
    }
    prevHand = hand;
    seq[seqHead] = 1 << zone;
    seqHead = (seqHead + 1) % SEQ_MAX;
    if (seqLen < SEQ_MAX) seqLen++;
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

/** Reads one `/keys/all` frame. Counts only become hits while a taiko attempt is live. */
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
  if (!hasLive) { hasLive = true; textDirty = true; }
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
function onFrame(values, changed) {
  const now = performance.now();
  const state = values['/state/number'];
  const mode = activeMode(state, values['/play/mode/number'], values['/settings/mode/number']);
  const all = values['/keys/all'];
  const playing = isPlaying(state) && mode === 'taiko';
  game = state !== undefined;

  if (playing && !wasPlaying) resetRun();
  wasPlaying = playing;

  if (Array.isArray(all)) ingestKeys(all, playing, now);
  else if (hasLive) { hasLive = false; textDirty = true; }

  if (mode === 'taiko') loadPalette(values['/beatmap/checksum'] || ''); // no-op unless the map changed
  updateShow();
  requestRender();
}

/** Gameplay shows the drum; song select, results and other rulesets show nothing. */
function updateShow() {
  let next = 'none';
  let text = '';
  let tone = 'muted';
  if (offline) { next = 'chip'; text = 'vosu offline'; tone = 'offline'; }
  else if (!online) { next = connectingShown ? 'chip' : 'none'; text = 'Connecting to vosu'; tone = 'connecting'; }
  else if (!game) { next = 'chip'; text = 'osu! not running'; }
  else if (wasPlaying) next = hasLive ? 'play' : 'note';
  if (text) setText(chipText, text);
  if (chip.dataset.tone !== tone) chip.dataset.tone = tone;
  if (next !== show) { show = next; ov.dataset.show = next; textDirty = drumDirty = seqDirty = true; }
}

let connectingTimer = 0;
let connectingShown = false;
function status(state) {
  clearTimeout(connectingTimer);
  online = state === 'live';
  if (state === 'offline') offline = true;
  else if (online) { offline = false; connectingShown = false; }
  else if (!offline) {
    // A first connect is near-instant; only surface it when it drags. Retries stay "offline".
    connectingTimer = setTimeout(() => { connectingShown = true; updateShow(); }, 800);
  }
  updateShow();
}

function loadPalette(next) {
  if (next === checksum) return;
  checksum = next;
  palette = null;
  applyPalette(ov, null);
  if (!next) return;
  mapPalette(next).then(result => {
    if (checksum !== next) return; // the map changed while the background was decoding
    palette = result;
    if (current?.accent === 'map') applyPalette(ov, palette);
  });
}

// ------------------------------------------------------------------ settings + layout
const COLOUR_MODES = { 'Don red / kat blue': 'don-kat', 'Left blue / right amber': 'hands', Monochrome: 'mono' };

function applySettings(s) {
  current = s;
  readTokens();
  const colour = COLOUR_MODES[s.colourMode] || 'don-kat';
  ov.dataset.colour = colour;
  ov.dataset.stats = String(s.showStats);
  ov.dataset.backing = ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  ov.dataset.accent = s.accent === '18-lab' ? '18-lab' : 'map';
  ov.dataset.align = ['left', 'centre', 'right'].includes(s.align) ? s.align : 'left';
  applyPalette(ov, s.accent === 'map' ? palette : null);
  zoneColour = colour === 'hands' ? [tokens.signal, tokens.signal, tokens.accent, tokens.accent]
    : colour === 'mono' ? [tokens.fg, tokens.fg, tokens.fg, tokens.fg]
    : [tokens.signal, tokens.danger, tokens.danger, tokens.signal];
  layout();
}

let pageScale = 1;
let seqPitch = SEQ_PITCH.full;

/**
 * Re-flows to the page box: a single row for wide boxes (full, or compact with inline labels
 * when the box is short), a column for tall ones. Blocks drop by priority when a row is too
 * narrow; the design is then scaled to the box. Runs on resize/settings only, never in rAF.
 */
function layout() {
  const W = Math.max(1, innerWidth);
  const H = Math.max(1, innerHeight);
  const pick = current?.orientation;
  const orient = pick === 'horizontal' || pick === 'vertical' ? pick : W / H >= 2 ? 'horizontal' : 'vertical';
  const stats = current?.showStats !== false;
  let density = 'full';
  let scale;
  const drop = [];
  if (orient === 'vertical') {
    scale = Math.min(W / COLUMN.w, H / (stats ? COLUMN.h : COLUMN.hBare));
    seqPitch = SEQ_PITCH.vertical;
  } else {
    density = H / ROW_HEIGHT.full >= FULL_MIN_SCALE ? 'full' : 'compact';
    const b = BLOCK[density];
    const width = list => b.pad * 2 + list.reduce((sum, key) => sum + b[key], 0) + b.gap * (list.length - 1);
    scale = H / ROW_HEIGHT[density];
    let shown = stats ? STAT_BLOCKS.slice() : ['drum', 'counts'];
    for (const key of DROP_ORDER) {
      if (width(shown) <= W / scale) break;
      if (shown.includes(key)) { shown = shown.filter(k => k !== key); drop.push(key); }
    }
    scale = Math.min(scale, W / width(shown));
    seqPitch = SEQ_PITCH[density];
  }
  pageScale = scale;
  ov.dataset.orient = orient;
  ov.dataset.density = density;
  ov.dataset.drop = drop.join(' ');
  ov.style.width = `${W / scale}px`;
  ov.style.height = `${H / scale}px`;
  ov.style.transform = `scale(${scale})`;
  sizeCanvas(drumCanvas, drumBox);
  sizeCanvas(seqCanvas, seqBox);
  drumDirty = seqDirty = true;
  requestRender();
}
addEventListener('resize', layout);

// ------------------------------------------------------------------ canvas sizing
const drumBox = { w: 0, h: 0, scale: 1 };
const seqBox = { w: 0, h: 0, scale: 1 };
const zonePaths = [null, null, null, null];

/** Backing stores follow devicePixelRatio × the page scale (CSS transforms don't reach the observed box). */
function sizeCanvas(canvas, box) {
  if (!box.w || !box.h) return;
  box.scale = (window.devicePixelRatio || 1) * pageScale;
  const w = Math.round(box.w * box.scale);
  const h = Math.round(box.h * box.scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

const resizer = new ResizeObserver(entries => {
  for (const entry of entries) {
    const css = entry.contentBoxSize?.[0];
    const w = css ? css.inlineSize : entry.contentRect.width;
    const h = css ? css.blockSize : entry.contentRect.height;
    if (!w || !h) continue; // hidden (stats off or dropped): keep the old backing store
    const canvas = entry.target;
    const box = canvas === drumCanvas ? drumBox : seqBox;
    box.w = w;
    box.h = h;
    sizeCanvas(canvas, box);
    if (canvas === drumCanvas) { buildPaths(w); drumDirty = true; } else seqDirty = true;
  }
  requestRender();
});
resizer.observe(drumCanvas);
resizer.observe(seqCanvas);

/** Four zone outlines with a parallel centre split and a gap between rim and face. */
function buildPaths(size) {
  const c = size / 2;
  const gap = Math.max(2, Math.round(size / 48));
  const h = gap / 2;
  const outer = c - 1;
  const inner = Math.round(outer * 0.66);
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
  if (show !== 'play') return; // hidden: nothing to draw; dirty flags carry over
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
  if (drumDirty && drumBox.w && tokens) drawDrum();
  if (seqDirty && seqBox.w && tokens) drawSeq();
  if (textDirty) writeText();
  if (animating) requestRender();
}

// Translucent resting fills: the drum reads as a shape over any background without a box.
const RIM_REST = 'rgb(11 12 13 / 0.55)';
const FACE_REST = 'rgb(23 25 28 / 0.6)';

function drawDrum() {
  drumDirty = false;
  const ctx = drumCtx;
  const size = drumBox.w;
  ctx.setTransform(drumBox.scale, 0, 0, drumBox.scale, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const path = zonePaths[i];
    const lit = level[i];
    const colour = zoneColour[i];
    ctx.globalAlpha = 1;
    ctx.fillStyle = KAT[i] ? RIM_REST : FACE_REST;
    ctx.fill(path);
    // Resting zones keep their colour identity, quietly; a press fills them.
    ctx.globalAlpha = (KAT[i] ? 0.12 : 0.1) + lit * (KAT[i] ? 0.76 : 0.72);
    ctx.fillStyle = colour;
    ctx.fill(path);
    ctx.globalAlpha = 0.5 + 0.5 * lit;
    ctx.strokeStyle = colour;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

function drawSeq() {
  seqDirty = false;
  const ctx = seqCtx;
  const w = seqBox.w;
  const h = seqBox.h;
  ctx.setTransform(seqBox.scale, 0, 0, seqBox.scale, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const slots = Math.max(4, Math.min(SEQ_MAX, Math.floor(w / seqPitch)));
  const pitch = w / slots;
  const block = Math.max(2, Math.floor(pitch) - 2);
  const row = Math.floor((h - 2) / 2);
  const top = 0;
  const bottom = h - row;
  // Dark cells make a track that stays legible over bright map backgrounds.
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgb(5 6 7 / 0.45)';
  for (let s = 0; s < slots; s++) {
    const x = Math.round(s * pitch);
    ctx.fillRect(x, top, block, row);
    ctx.fillRect(x, bottom, block, row);
  }
  ctx.lineWidth = 1;
  const count = Math.min(seqLen, slots);
  for (let k = 0; k < count; k++) {
    const mask = seq[(seqHead - count + k + SEQ_MAX) % SEQ_MAX];
    const x = Math.round((slots - count + k) * pitch);
    const age = (k + 1) / count;
    ctx.globalAlpha = 0.3 + 0.7 * age * age;
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

function setText(el, text) {
  if (el._text === text) return;
  const empty = text === DASH;
  if ((el._text === DASH) !== empty) el.classList.toggle('empty', empty);
  el._text = text;
  el.textContent = text;
}

function writeText() {
  textDirty = false;
  const counts = hasLive ? live : null;
  const total = counts ? counts[0] + counts[1] + counts[2] + counts[3] : 0;
  for (let i = 0; i < 4; i++) setText(countEls[i], counts ? String(counts[i]) : DASH);

  let transform = 'scaleX(0)';
  if (total > 0) {
    const left = (counts[0] + counts[1]) / total;
    const l = Math.round(left * 100);
    setText(balL, `${l}%`);
    setText(balR, `${100 - l}%`);
    transform = `scaleX(${left.toFixed(3)})`;
  } else {
    setText(balL, DASH);
    setText(balR, DASH);
  }
  if (balFill._transform !== transform) { balFill._transform = transform; balFill.style.transform = transform; }
  if (ov.dataset.empty !== String(total === 0)) ov.dataset.empty = String(total === 0);

  const pairs = alternations + repeats;
  setText(altEl, pairs ? `${Math.round(alternations / pairs * 100)}%` : DASH);
  setText(repEl, pairs ? String(repeats) : DASH);
  setText(kpsEl, hasLive ? String(kps) : DASH);
  setText(peakEl, peak ? String(peak) : DASH);
}

// ------------------------------------------------------------------ start
settings({
  orientation: 'auto', align: 'left', backing: 'none', accent: 'map',
  showStats: true, colourMode: 'Don red / kat blue',
}, applySettings);
subscribe(POINTERS, onFrame, { onStatus: status });

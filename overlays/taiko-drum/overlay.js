// Copyright (c) 2026 18-LAB. MIT.
// osu!taiko drum input, floating in the free area below the lane: four drum zones lighting on
// press, per-zone counts, hand balance, alternation, same-hand repeats and live KPS.
// Data comes only from vosu's `/keys/all`; shown during taiko gameplay only.
import { subscribe, settings, fit, activeMode, isPlaying, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const POINTERS = ['/state/number', '/play/mode/number', '/settings/mode/number', '/keys/all', '/beatmap/checksum'];

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
const DASH = '—';
const RESULTS = 7;

const $ = id => document.getElementById(id);
const stage = $('stage');
const anchor = $('anchor');
const group = $('group');
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
const rPeak = $('r-peak');
const rLeft = $('r-left');
const rRight = $('r-right');
const rAlt = $('r-alt');
const rRep = $('r-rep');
const rZones = $('r-zones');
const drumCanvas = $('drum-canvas');
const seqCanvas = $('seq-canvas');
const drumCtx = drumCanvas.getContext('2d', { alpha: true });
const seqCtx = seqCanvas.getContext('2d', { alpha: true });

fit(stage, WIDTH, HEIGHT);

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
const seq = new Uint8Array(SEQ);       // zone bitmask per hit, ring
let seqHead = 0;
let seqLen = 0;

let show = 'none';     // none | play | chip | note
let online = false;
let offline = false;
let game = false;
let wasPlaying = false;
let results = false;
let summary = false;  // a taiko attempt's drum summary is held for its results screen
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
  tokens = {
    fg: get('--fg', '#ebe8e1'), signal: get('--signal', '#7fa6cf'), danger: get('--danger', '#ef5b4f'),
    accent: get('--accent', '#ff963f'),
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
    // Both hands together: a big-note double, merged into the previous strip slot.
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

  if (playing && !wasPlaying) { resetRun(); summary = false; }
  if (!playing && wasPlaying) holdSummary(now);
  if ((isPlaying(state) && !playing) || !game) summary = false; // another ruleset's attempt, or osu! closed
  wasPlaying = playing;
  results = state === RESULTS;

  if (Array.isArray(all)) ingestKeys(all, playing, now);
  else if (hasLive) { hasLive = false; textDirty = true; }

  if (changed.has('/beatmap/checksum')) loadPalette(values['/beatmap/checksum'] || '');
  updateShow();
  requestRender();
}

function updateShow() {
  let next = 'none';
  let text = '';
  let tone = 'muted';
  if (offline) { next = 'chip'; text = 'vosu offline'; tone = 'offline'; }
  else if (!online) { next = connectingShown ? 'chip' : 'none'; text = 'Connecting to vosu'; tone = 'connecting'; }
  else if (!game) { next = 'chip'; text = 'osu! not running'; }
  else if (wasPlaying) next = hasLive ? 'play' : 'note';
  else if (results && summary && current?.showResults) next = 'result';
  if (text) setText(chipText, text);
  if (chip.dataset.tone !== tone) chip.dataset.tone = tone;
  if (next !== show) { show = next; stage.dataset.show = next; textDirty = drumDirty = seqDirty = true; }
}

/** Freezes the attempt's drum summary for the results screen (osu! shows none of it). */
function holdSummary(now) {
  expireKps(now);
  const total = live[0] + live[1] + live[2] + live[3];
  const pairs = alternations + repeats;
  summary = hasLive && total > 0 && pairs > 0;
  if (!summary) return;
  const left = Math.round((live[0] + live[1]) / total * 100);
  setText(rPeak, peak ? String(peak) : DASH);
  setText(rLeft, String(left));
  setText(rRight, String(100 - left));
  setText(rAlt, `${Math.round(alternations / pairs * 100)}%`);
  setText(rRep, String(repeats));
  setText(rZones, `${live[0]} · ${live[1]} · ${live[2]} · ${live[3]}`);
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
  applyPalette(stage, null);
  if (!next) return;
  mapPalette(next).then(result => {
    if (checksum !== next) return; // the map changed while the background was decoding
    palette = result;
    if (current?.accent === 'map') applyPalette(stage, palette);
  });
}

// ------------------------------------------------------------------ settings + placement
const COLOUR_MODES = { 'Don red / kat blue': 'don-kat', 'Left blue / right amber': 'hands', Monochrome: 'mono' };
const SIZES = new Set(['small', 'medium', 'large']);
const LAYOUT = osuLayout('taiko');
const LANE = LAYOUT.busy;
const ABOVE = LAYOUT.free.find(r => r.y + r.h <= LANE.y) || { x: 0, y: 0, w: WIDTH, h: LANE.y };
const BELOW = LANE.y + LANE.h;
const INSET = 96;
// x, y = anchor point on screen; ax, ay = which point of the group sits on it (0 / -50 / -100 %).
const ZONES = {
  'below lane, left': { x: INSET, y: BELOW + 40, ax: 0, ay: 0, align: 'start' },
  'below lane, centre': { x: WIDTH / 2, y: BELOW + 40, ax: -50, ay: 0, align: 'center' },
  'below lane, right': { x: WIDTH - INSET, y: BELOW + 40, ax: -100, ay: 0, align: 'end' },
  'above lane': { x: ABOVE.x + 48, y: ABOVE.y + ABOVE.h / 2, ax: 0, ay: -50, align: 'start' },
};
let userScale = 1;

function applySettings(s) {
  current = s;
  readTokens();
  const colour = COLOUR_MODES[s.colourMode] || 'don-kat';
  group.dataset.colour = colour;
  group.dataset.size = SIZES.has(s.drumSize) ? s.drumSize : 'medium';
  group.dataset.stats = String(s.showStats);
  stage.dataset.brand = String(s.showBrand);
  group.dataset.backing = ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  stage.dataset.accent = s.accent === '18-lab' ? '18-lab' : 'map';
  applyPalette(stage, s.accent === 'map' ? palette : null);
  updateShow(); // showResults may change what this state shows

  const zone = ZONES[s.zone] || ZONES['below lane, left'];
  userScale = Math.min(2, Math.max(0.5, s.scale || 1));
  group.dataset.align = zone.align;
  anchor.style.transform = `translate(${Math.round(zone.x + s.offsetX)}px, ${Math.round(zone.y + s.offsetY)}px)`;
  group.style.transformOrigin = `${-zone.ax}% ${-zone.ay}%`;
  group.style.transform = `translate(${zone.ax}%, ${zone.ay}%) scale(${userScale})`;

  zoneColour = colour === 'hands' ? [tokens.signal, tokens.signal, tokens.accent, tokens.accent]
    : colour === 'mono' ? [tokens.fg, tokens.fg, tokens.fg, tokens.fg]
    : [tokens.signal, tokens.danger, tokens.danger, tokens.signal];
  // Backing stores follow the user scale (CSS transforms don't reach the observed box).
  sizeCanvas(drumCanvas, drumBox);
  sizeCanvas(seqCanvas, seqBox);
  drumDirty = seqDirty = true;
  requestRender();
}

// ------------------------------------------------------------------ canvas sizing
const drumBox = { w: 0, h: 0, scale: 1 };
const seqBox = { w: 0, h: 0, scale: 1 };
const zonePaths = [null, null, null, null];

function sizeCanvas(canvas, box) {
  if (!box.w || !box.h) return;
  box.scale = (window.devicePixelRatio || 1) * userScale;
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
    if (!w || !h) continue; // hidden (stats off): keep the old backing store
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
    ctx.globalAlpha = (KAT[i] ? 0.1 : 0.08) + lit * (KAT[i] ? 0.72 : 0.6);
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
  const pitch = w / SEQ;
  const block = Math.max(2, Math.floor(pitch) - 2);
  const row = Math.floor((h - 2) / 2);
  const top = 0;
  const bottom = h - row;
  // Dark cells make a track that stays legible over bright map backgrounds.
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgb(5 6 7 / 0.45)';
  for (let s = 0; s < SEQ; s++) {
    const x = Math.round(s * pitch);
    ctx.fillRect(x, top, block, row);
    ctx.fillRect(x, bottom, block, row);
  }
  ctx.lineWidth = 1;
  for (let k = 0; k < seqLen; k++) {
    const mask = seq[(seqHead - seqLen + k + SEQ) % SEQ];
    const x = Math.round((SEQ - seqLen + k) * pitch);
    const age = (k + 1) / seqLen;
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
  if (group.dataset.empty !== String(total === 0)) group.dataset.empty = String(total === 0);

  const pairs = alternations + repeats;
  setText(altEl, pairs ? `${Math.round(alternations / pairs * 100)}%` : DASH);
  setText(repEl, pairs ? String(repeats) : DASH);
  setText(kpsEl, hasLive ? String(kps) : DASH);
  setText(peakEl, peak ? String(peak) : DASH);
}

// ------------------------------------------------------------------ start
settings({
  zone: 'below lane, left', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map',
  showStats: true, drumSize: 'medium', colourMode: 'Don red / kat blue', showBrand: true, showResults: true,
}, applySettings);
subscribe(POINTERS, onFrame, { onStatus: status });

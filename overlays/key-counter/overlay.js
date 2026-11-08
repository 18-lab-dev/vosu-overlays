// Copyright (c) 2026 18-LAB. MIT.
// Key counter: one cap per logical key (vosu keys.all) with its count and share of presses,
// total taps, and taps per second with a 10 s history. Everything that changes per tap is
// drawn on two canvases (caps, stats) with per-region dirty redraws; the DOM holds only
// static chrome. Data handlers only record state; one rAF pass renders, and the loop sleeps
// (timer-woken) until the next thing that will visibly change.
import { subscribe, settings, activeMode, isPlaying, MODE_LABELS } from './vosu-overlay.js';

const RESULTS = 7;
const BUCKET_MS = 250;          // history resolution
const SPARK_BARS = 40;          // 40 × 250 ms = 10 s
const SPARK_SPAN = SPARK_BARS * BUCKET_MS;
const HISTORY = 14400;          // one hour of buckets for the results overview
const RING = 1024;              // taps inside the trailing second (power of two)
const MAX_KEYS = 32;
const FLASH_MS = 90;            // a tap that began and ended between two frames still lights
const PRESS_MS = 50, RELEASE_MS = 180;

// Geometry (CSS px).
const COUNT_GAP = 6, COUNT_H = 14, METER_GAP = 5, METER_H = 2;
const TALLY_H = COUNT_GAP + COUNT_H + METER_GAP + METER_H;   // below each cap (horizontal)
const SIDE_GAP = 10, SIDE_W = 56;                             // beside each cap (vertical)
const NUM_W = 50, SPARK_X = 58, SPARK_W = 120, SPARK_TOP = 2, SPARK_BOTTOM = 30;
const FOOT_Y = 36, STATS_H = 49;

const P = {
  state: '/state/number', playMode: '/play/mode/number', menuMode: '/settings/mode/number',
  client: '/client', all: '/keys/all', k1: '/keys/k1', k2: '/keys/k2', m1: '/keys/m1', m2: '/keys/m2',
  bindOsu: '/settings/keybinds/osu', bindTaiko: '/settings/keybinds/taiko', bindFruits: '/settings/keybinds/fruits',
  cs: '/beatmap/stats/cs/converted',
};

const $ = id => document.getElementById(id);
const panel = $('panel');
const el = {
  brand: $('brand'), mode: $('mode'), statusText: $('status-text'), note: $('note'),
  kpsLabel: $('kps-label'), spanLabel: $('span-label'),
};
const keysCanvas = $('keys'), statsCanvas = $('stats');
const kx = keysCanvas.getContext('2d', { alpha: true });
const sx = statsCanvas.getContext('2d', { alpha: true });
const css = getComputedStyle(document.documentElement);
const token = name => css.getPropertyValue(name).trim();
const C = {
  fg: token('--fg'), dim: token('--fg-dim'), muted: token('--muted'), rule: token('--rule'), ruleStrong: token('--rule-strong'),
  accent: token('--accent'), signal: token('--signal'), onAccent: token('--on-accent'),
  capBg: 'rgb(23 25 28 / 0.9)', lip: 'rgb(5 6 7 / 0.55)', sheen: 'rgb(235 232 225 / 0.06)',
};
const F = {
  count: '600 17px "Barlow Condensed"', big: '600 38px "Barlow Condensed"', sub: '500 9px "IBM Plex Mono"',
  footLabel: '500 9px "IBM Plex Mono"', footValue: '500 11px "IBM Plex Mono"',
  glyph: ['', '', '', '', '', ''],   // by label length, rebuilt with the cap size
};
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ease = t => 1 - (1 - t) ** 3;

// ---------------------------------------------------------------- attempt state
const tapRing = new Float64Array(RING);
let ringHead = 0, ringLen = 0;
const hist = new Uint8Array(HISTORY);
const prev = new Float64Array(MAX_KEYS);
const counts = new Float64Array(MAX_KEYS);
const pressed = new Uint8Array(MAX_KEYS);
const litUntil = new Float64Array(MAX_KEYS);
const att = { seeded: false, n: 0, t0: 0, idx: -1, peak: 0, taps: 0, firstTap: 0, lastTap: -Infinity, valid: false };

function resetAttempt() {
  ringHead = 0; ringLen = 0;
  hist.fill(0);
  prev.fill(0); counts.fill(0); pressed.fill(0); litUntil.fill(0);
  att.seeded = false; att.n = 0; att.idx = -1; att.peak = 0; att.taps = 0; att.firstTap = 0; att.lastTap = -Infinity; att.valid = false;
  dirty.keys = dirty.stats = true;
}

function pushTaps(n, now) {
  for (let i = 0; i < n; i++) {
    tapRing[(ringHead + ringLen) & (RING - 1)] = now;
    if (ringLen < RING) ringLen++; else ringHead = (ringHead + 1) & (RING - 1);
  }
  if (!att.taps) att.firstTap = now;
  att.taps += n;
  att.lastTap = now;
}

function evict(now) {
  while (ringLen && tapRing[ringHead] <= now - 1000) { ringHead = (ringHead + 1) & (RING - 1); ringLen--; }
}

// ---------------------------------------------------------------- key layouts
const KEY_NAMES = {
  Left: 'LEFT', Right: 'RIGHT', Up: 'UP', Down: 'DOWN', LeftShift: 'SHIFT', RightShift: 'SHIFT', Shift: 'SHIFT',
  LeftControl: 'CTRL', RightControl: 'CTRL', Control: 'CTRL', LeftAlt: 'ALT', RightAlt: 'ALT', Space: 'SPACE',
  MouseLeft: 'M1', MouseRight: 'M2', LButton: 'M1', RButton: 'M2', Return: 'ENTER', Enter: 'ENTER', Tab: 'TAB',
  OemTilde: '`', OemComma: ',', OemPeriod: '.', OemQuestion: '/', OemSemicolon: ';', OemQuotes: "'",
  OemOpenBrackets: '[', OemCloseBrackets: ']', OemMinus: '-', OemPlus: '=',
};

function keyLabel(name, fallback) {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const n = name.trim();
  if (KEY_NAMES[n]) return KEY_NAMES[n];
  if (/^D\d$/.test(n)) return n[1];
  if (/^NumPad\d$/i.test(n)) return `N${n.slice(-1)}`;
  return n.slice(0, 5).toUpperCase();
}

/** Caps to show: [{src: index into keys.all, label, sub, rim}]. */
function layoutFor(mode, client, columns, smoke, binds) {
  const b = binds || {};
  if (mode === 'osu') {
    const caps = [{ src: 0, label: keyLabel(b.k1, 'K1') }, { src: 1, label: keyLabel(b.k2, 'K2') }];
    if (smoke) caps.push({ src: 2, label: keyLabel(b.smokeKey, 'SMOKE'), sub: 'SMOKE' });
    return caps;
  }
  if (mode === 'taiko') return [
    { src: 0, label: keyLabel(b.outerLeft, 'L'), sub: 'KAT', rim: true },
    { src: 1, label: keyLabel(b.innerLeft, 'L'), sub: 'DON' },
    { src: 2, label: keyLabel(b.innerRight, 'R'), sub: 'DON' },
    { src: 3, label: keyLabel(b.outerRight, 'R'), sub: 'KAT', rim: true },
  ];
  if (mode === 'fruits') {
    // osu!stable records the catcher position, not left/right presses: only dash is real there.
    const dash = { src: 2, label: keyLabel(b.Dash, 'DASH'), sub: b.Dash ? 'DASH' : undefined };
    return client === 'stable' ? [dash] : [{ src: 0, label: keyLabel(b.k1, 'L') }, { src: 1, label: keyLabel(b.k2, 'R') }, dash];
  }
  const caps = [];
  for (let i = 0; i < Math.min(columns, MAX_KEYS); i++) caps.push({ src: i, label: String(i + 1) });
  return caps;
}

// ---------------------------------------------------------------- incoming data
const LEGACY = [{ count: 0, isPressed: false }, { count: 0, isPressed: false }];
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Source key array for the ruleset: keys.all, or tosu's legacy k1/k2 (+m1/m2) for osu!. */
function readKeys(values, mode) {
  const all = values[P.all];
  if (Array.isArray(all) && all.length) return all;
  const k1 = values[P.k1], k2 = values[P.k2];
  if (mode !== 'osu' || !k1 || !k2) return null;
  const m1 = values[P.m1] || {}, m2 = values[P.m2] || {};
  LEGACY[0].count = num(k1.count) + num(m1.count); LEGACY[0].isPressed = !!(k1.isPressed || m1.isPressed);
  LEGACY[1].count = num(k2.count) + num(m2.count); LEGACY[1].isPressed = !!(k2.isPressed || m2.isPressed);
  return LEGACY;
}

const view = { status: 'connecting', phase: 'connecting', mode: null, modeText: '', caps: [], sig: '', columns: 0 };
const dirty = { layout: true, keys: true, stats: true, phase: true };
let lastColumns = 0;
const lk = { mode: undefined, client: undefined, columns: -1, smoke: false, binds: undefined };

function onFrame(values) {
  const now = performance.now();
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.menuMode]);
  const playing = isPlaying(state);
  let phase = state === undefined || !mode ? 'absent' : playing ? 'play' : state === RESULTS ? 'results' : 'menu';
  const src = playing || phase === 'results' ? readKeys(values, mode) : null;
  if (phase === 'play' && !src) phase = 'nokeys';

  if (phase === 'play' && view.phase !== 'play') resetAttempt();

  // Layout: rebuilt only when the key set or its labels change.
  let columns = 0;
  if (mode === 'mania') {
    if (src) columns = lastColumns = src.length;
    else {
      const cs = Math.round(num(values[P.cs]));
      columns = lastColumns || (cs >= 1 && cs <= 18 ? cs : 4);
    }
  }
  const smoke = mode === 'osu' && !!src && src.length > 2 && num(src[2].count) > 0;
  const client = values[P.client];
  const binds = mode === 'osu' ? values[P.bindOsu] : mode === 'taiko' ? values[P.bindTaiko] : mode === 'fruits' ? values[P.bindFruits] : null;
  // Cheap identity check first (binds are the same object until vosu reports a change).
  if (mode !== lk.mode || client !== lk.client || columns !== lk.columns || smoke !== lk.smoke || binds !== lk.binds) {
    lk.mode = mode; lk.client = client; lk.columns = columns; lk.smoke = smoke; lk.binds = binds;
    const caps = mode ? layoutFor(mode, client, columns, smoke, binds) : [];
    const sig = `${mode}|${caps.map(c => `${c.src}:${c.label}:${c.sub || ''}`).join(',')}`;
    if (sig !== view.sig) {
      const keysetChanged = view.mode !== mode || view.columns !== columns || (mode === 'fruits' && view.caps.length !== caps.length);
      view.sig = sig; view.caps = caps; view.mode = mode; view.columns = columns;
      dirty.layout = true;
      if (keysetChanged && phase === 'play') resetAttempt();
    }
    const modeText = mode ? `${MODE_LABELS[mode]}${mode === 'mania' && columns ? ` · ${columns}K` : ''}` : '';
    if (modeText !== view.modeText) { view.modeText = modeText; dirty.phase = true; }
  }

  if (phase === 'play') {
    const n = Math.min(src.length, MAX_KEYS);
    if (!att.seeded || n !== att.n) {
      // First sight of this attempt: take the counts as a baseline instead of inventing a burst.
      for (let i = 0; i < n; i++) prev[i] = num(src[i].count);
      att.seeded = true; att.n = n; att.t0 = now; att.idx = -1;
    } else {
      for (let i = 0; i < n; i++) {
        if (num(src[i].count) < prev[i]) { // retry or rewind: a new attempt
          resetAttempt();
          for (let j = 0; j < n; j++) prev[j] = num(src[j].count);
          att.seeded = true; att.n = n; att.t0 = now;
          break;
        }
      }
      for (let i = 0; i < n; i++) {
        const c = num(src[i].count);
        const d = c - prev[i];
        if (d > 0) { pushTaps(Math.min(d, 64), now); litUntil[i] = now + FLASH_MS; }
        prev[i] = c;
      }
    }
    for (let i = 0; i < n; i++) { counts[i] = num(src[i].count); pressed[i] = src[i].isPressed ? 1 : 0; }
    att.valid = true;
    dirty.keys = dirty.stats = true;
  } else if (phase === 'results') {
    // Hold the attempt that just ended; a page opened on the results screen shows what vosu still reports.
    if (!att.valid && src) {
      let total = 0;
      const n = Math.min(src.length, MAX_KEYS);
      for (let i = 0; i < n; i++) { counts[i] = num(src[i].count); total += counts[i]; }
      if (total > 0) { att.valid = true; att.n = n; }
    }
    pressed.fill(0);
    dirty.keys = dirty.stats = true;
  } else if (view.phase === 'results' || view.phase === 'play') {
    att.valid = false;
    dirty.keys = dirty.stats = true;
  }

  setPhase(phase);
  wake();
}

function onStatus(state) {
  if (state === view.status) return;
  view.status = state;
  if (state !== 'live') setPhase(state);
  wake();
}

function setPhase(phase) {
  if (view.status !== 'live') phase = view.status;
  if (phase === view.phase) return;
  view.phase = phase;
  dirty.phase = dirty.keys = dirty.stats = true;
}

// ---------------------------------------------------------------- geometry
const opts = { vertical: false, cap: 48, spark: true, total: true };
const geo = { cap: 48, gap: 4, pitch: 52, w: 0, h: 0, statsW: 0, side: SIDE_W };
const caps = [];   // per drawn cap: {src, label, sub, rim, len, p, f, drawn*}

function buildLayout() {
  const n = view.caps.length;
  geo.cap = opts.cap;
  geo.gap = Math.max(4, Math.round(opts.cap / 12));
  geo.pitch = geo.cap + geo.gap;
  const run = n ? n * geo.cap + (n - 1) * geo.gap : 0;
  geo.statsW = opts.spark ? SPARK_X + SPARK_W : 124;
  geo.side = Math.max(SIDE_W, geo.statsW - geo.cap - SIDE_GAP);   // vertical: meters run to the panel edge
  geo.w = opts.vertical ? geo.cap + SIDE_GAP + geo.side : run;
  geo.h = opts.vertical ? run : geo.cap + TALLY_H;
  keysCanvas.style.width = `${geo.w}px`;
  keysCanvas.style.height = `${geo.h}px`;
  statsCanvas.style.width = `${geo.statsW}px`;
  statsCanvas.style.height = `${STATS_H}px`;
  const scales = [0.3, 0.3, 0.25, 0.21, 0.19, 0.16];
  for (let len = 1; len <= 5; len++) F.glyph[len] = `500 ${Math.round(geo.cap * scales[len] * 10) / 10}px "IBM Plex Mono"`;
  caps.length = 0;
  for (const cap of view.caps) {
    caps.push({
      src: cap.src, label: cap.label, sub: cap.sub && cap.sub !== cap.label ? cap.sub : '', rim: !!cap.rim,
      len: Math.min(5, Math.max(1, cap.label.length)), p: 0, f: 0,
      dP: -1, dF: -1, dN: -2, dM: -1, dTop: false, dAlpha: -1,
    });
  }
  dirty.layout = false;
  forceRedraw();
}

function forceRedraw() {
  for (const cap of caps) cap.dP = -1;
  shown.kps = shown.total = shown.aux = NaN; shown.spark = -1; shown.full = true;
  dirty.keys = dirty.stats = true;
}

// Fixed advance per digit so changing numbers never shift (canvas has no tabular-nums).
const adv = { count: 9, big: 19 };
function measureDigits() {
  for (const [key, font] of [['count', F.count], ['big', F.big]]) {
    sx.font = font;
    let w = 0;
    for (const d of DIGITS) w = Math.max(w, sx.measureText(d).width);
    adv[key] = w;
  }
}

/** Draws a non-negative integer at fixed digit advance; align 0 left, 0.5 centre, 1 right. */
function drawInt(ctx, value, x, y, align, step) {
  let n = Math.max(0, Math.round(value)), digits = 1, div = 1;
  while (n >= div * 10) { div *= 10; digits++; }
  let left = x - digits * step * align + step / 2;
  for (let i = 0; i < digits; i++) {
    const d = Math.floor(n / div) % 10;
    ctx.fillText(DIGITS[d], left, y);
    left += step; div /= 10;
  }
}

// ---------------------------------------------------------------- settings
const DEFAULTS = { orientation: 'horizontal', capSize: 48, showSparkline: true, showTotal: true, anchor: 'top-left', showBrand: true };

// Scale the panel down (never up) when it outgrows the browser source.
let panelW = 0, panelH = 0, panelScale = 1;
function fitPanel() {
  if (!panelW || !panelH) return;
  const scale = Math.min(1, innerWidth / panelW, innerHeight / panelH);
  if (Math.abs(scale - panelScale) < 0.001) return;
  panelScale = scale;
  panel.style.transform = scale < 1 ? `scale(${scale})` : '';
}
new ResizeObserver(([entry]) => {
  const box = entry.borderBoxSize?.[0];
  panelW = box ? box.inlineSize : entry.target.offsetWidth;
  panelH = box ? box.blockSize : entry.target.offsetHeight;
  fitPanel();
}).observe(panel);
addEventListener('resize', fitPanel);

// Backing stores follow the CSS size × devicePixelRatio, measured by the observer (never in rAF).
let dpr = devicePixelRatio || 1;
const backing = new ResizeObserver(entries => {
  for (const entry of entries) {
    const canvas = entry.target;
    const box = entry.devicePixelContentBoxSize?.[0];
    const w = box ? box.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio);
    const h = box ? box.blockSize : Math.round(entry.contentRect.height * devicePixelRatio);
    if (!w || !h || (w === canvas.width && h === canvas.height)) continue;
    canvas.width = w; canvas.height = h;
    if (entry.contentRect.width) dpr = w / entry.contentRect.width;
  }
  forceRedraw();
  wake();
});
backing.observe(keysCanvas);
backing.observe(statsCanvas);

// ---------------------------------------------------------------- render loop
let raf = 0, timer = 0, kps = 0, lastFrame = 0;
function wake() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  if (timer) { clearTimeout(timer); timer = 0; }
  const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
  lastFrame = now;
  const live = view.phase === 'play';

  if (live) {
    evict(now);
    if (ringLen !== kps) { kps = ringLen; dirty.stats = true; }
    if (kps > att.peak) att.peak = kps;
    if (att.seeded) {
      const idx = Math.floor((now - att.t0) / BUCKET_MS);
      if (idx < HISTORY) {
        if (idx !== att.idx) { att.idx = idx; dirty.stats = true; }
        if (kps > hist[idx]) { hist[idx] = Math.min(255, kps); dirty.stats = true; }
      }
    }
  } else if (kps) { kps = 0; ringLen = 0; dirty.stats = true; }

  if (dirty.layout) buildLayout();
  if (dirty.phase) renderPhase();
  const animating = renderKeys(now, dt);
  if (dirty.stats) renderStats();
  dirty.stats = false;

  let next = Infinity;
  if (animating) next = now;
  if (live) {
    if (ringLen) next = Math.min(next, tapRing[ringHead] + 1001);
    for (let i = 0; i < att.n; i++) if (litUntil[i] > now && litUntil[i] < next) next = litUntil[i];
    if (att.seeded && now - att.lastTap < SPARK_SPAN + BUCKET_MS && att.idx + 1 < HISTORY) next = Math.min(next, att.t0 + (att.idx + 1) * BUCKET_MS);
  }
  if (next === now) raf = requestAnimationFrame(frame);
  else if (next !== Infinity) timer = setTimeout(wake, Math.max(0, next - performance.now()));
  else lastFrame = 0;
}

let modeText = null, noteText = null;
function renderPhase() {
  panel.dataset.phase = view.phase;
  const text = view.phase === 'connecting' || view.phase === 'offline' ? '' : view.modeText;
  if (text !== modeText) el.mode.textContent = modeText = text;
  el.statusText.textContent = view.phase === 'offline' ? 'vosu offline' : 'Connecting';
  const note = view.phase === 'absent' ? 'Waiting for osu!' : view.phase === 'nokeys' ? 'Key data needs vosu · <b>ENABLE_KEY_OVERLAY</b>' : '';
  if (note !== noteText) { noteText = note; el.note.innerHTML = note; } // static strings only, outside the hot path
  dirty.phase = false;
}

/** Advances press animations and redraws only the caps whose look changed. Returns true while animating. */
function renderKeys(now, dt) {
  const w = keysCanvas.width, h = keysCanvas.height;
  if (!w || !h) return false;
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const live = phase === 'play';
  const alpha = phase === 'menu' ? 0.5 : 1;
  let max = 0;
  if (show) for (const cap of caps) if (counts[cap.src] > max) max = counts[cap.src];
  let animating = false;
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];
    const on = live && (pressed[cap.src] === 1 || litUntil[cap.src] > now);
    if (on) { cap.f = 1; cap.p = Math.min(1, cap.p + dt / PRESS_MS); }
    else { cap.f = Math.max(0, cap.f - dt / RELEASE_MS); cap.p = Math.max(0, cap.p - dt / RELEASE_MS); }
    if ((on && cap.p < 1) || (!on && (cap.p > 0 || cap.f > 0))) animating = true;
    const c = show ? counts[cap.src] : -1;
    const meterLen = opts.vertical ? geo.side : geo.cap;
    const m = c > 0 && max > 0 ? Math.round(c / max * meterLen * dpr) : 0;
    const top = c > 0 && c === max && caps.length > 1;
    if (cap.p === cap.dP && cap.f === cap.dF && c === cap.dN && m === cap.dM && top === cap.dTop && alpha === cap.dAlpha) continue;
    cap.dP = cap.p; cap.dF = cap.f; cap.dN = c; cap.dM = m; cap.dTop = top; cap.dAlpha = alpha;
    drawCap(i, cap, c, m, top, alpha);
  }
  dirty.keys = false;
  return animating;
}

function drawCap(i, cap, c, meterPx, top, alpha) {
  const ctx = kx, s = geo.cap, vertical = opts.vertical;
  const ox = vertical ? 0 : i * geo.pitch, oy = vertical ? i * geo.pitch : 0;
  // Clear this cap's slot (device px).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (vertical) ctx.clearRect(0, Math.round(oy * dpr), keysCanvas.width, Math.round((oy + s) * dpr) - Math.round(oy * dpr));
  else ctx.clearRect(Math.round(ox * dpr), 0, Math.round((ox + s) * dpr) - Math.round(ox * dpr), keysCanvas.height);
  ctx.globalAlpha = alpha;

  // Cap: travels 1 px down and shrinks to 93 % while pressed; the lit face is instant on, eased off.
  const press = ease(cap.p);
  const scale = 1 - 0.07 * press;
  const cx = ox + s / 2, cy = oy + s / 2 + press;
  const half = s * scale / 2;
  const x0 = Math.round((cx - half) * dpr), x1 = Math.round((cx + half) * dpr);
  const y0 = Math.round((cy - half) * dpr), y1 = Math.round((cy + half) * dpr);
  const hair = Math.max(1, Math.round(dpr)), r = 2 * dpr;
  ctx.fillStyle = C.capBg;
  ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r); ctx.fill();
  // Keycap depth: a darker lip along the bottom that compresses as the key travels, and a top sheen.
  const lipH = Math.round(4 * dpr * (1 - press));
  if (lipH > 0) { ctx.fillStyle = C.lip; ctx.fillRect(x0 + hair, y1 - hair - lipH, x1 - x0 - 2 * hair, lipH); }
  ctx.fillStyle = C.sheen;
  ctx.fillRect(x0 + hair, y0 + hair, x1 - x0 - 2 * hair, hair);
  ctx.fillStyle = C.ruleStrong;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
  ctx.roundRect(x0 + hair, y0 + hair, x1 - x0 - 2 * hair, y1 - y0 - 2 * hair, Math.max(0, r - hair));
  ctx.fill('evenodd');
  const lit = cap.f > 0 ? ease(cap.f) : 0;
  if (lit > 0) {
    ctx.globalAlpha = alpha * lit;
    ctx.fillStyle = cap.rim ? C.signal : C.accent;
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r); ctx.fill();
    ctx.globalAlpha = alpha;
  }

  // Label, scaled with the cap about its centre.
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, cx * dpr, (cy - 2 * (1 - press)) * dpr);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const ink = lit >= 0.5 ? C.onAccent : null;
  ctx.font = F.glyph[cap.len];
  ctx.fillStyle = ink || C.fg;
  const glyphSize = s * [0.3, 0.3, 0.25, 0.21, 0.19, 0.16][cap.len];
  const capHeight = glyphSize * 0.7;
  if (cap.sub && s >= 36) {
    const block = capHeight + 5 + 6.3;
    ctx.fillText(cap.label, 0, -block / 2 + capHeight);
    ctx.font = F.sub;
    ctx.letterSpacing = '0.7px';
    ctx.fillStyle = ink || C.muted;
    ctx.fillText(cap.sub, 0.35, block / 2);
    ctx.letterSpacing = '0px';
  } else {
    ctx.fillText(cap.label, 0, capHeight / 2);
  }

  // Count and its share-of-presses meter.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = F.count;
  ctx.fillStyle = c < 0 ? C.muted : C.fg;
  const meterLen = vertical ? geo.side : s;
  const mx = vertical ? ox + s + SIDE_GAP : ox;
  const countBase = vertical ? oy + s / 2 + 3 : oy + s + COUNT_GAP + 12.5;
  const meterY = vertical ? oy + s / 2 + 8 : oy + s + COUNT_GAP + COUNT_H + METER_GAP;
  if (c < 0) { ctx.textAlign = vertical ? 'left' : 'center'; ctx.fillText('—', vertical ? mx : ox + s / 2, countBase); }
  else { ctx.textAlign = 'center'; drawInt(ctx, c, vertical ? mx : ox + s / 2, countBase, vertical ? 0 : 0.5, adv.count); }
  // Share-of-presses meter; meaningless with a single key (stable catch: dash only).
  if (caps.length > 1) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const X = Math.round(mx * dpr), W = Math.round((mx + meterLen) * dpr) - X;
    const Y = Math.round(meterY * dpr), H = Math.max(1, Math.round(METER_H * dpr));
    ctx.fillStyle = C.rule;
    ctx.fillRect(X, Y, W, H);
    if (meterPx > 0) {
      ctx.fillStyle = top ? C.fg : C.dim;
      ctx.fillRect(X, Y, Math.min(W, meterPx), H);
    }
  }
  ctx.globalAlpha = 1;
}

// Last drawn stats; regions repaint only when their value changes. -1 draws "—".
const shown = { kps: NaN, bigInk: '', total: NaN, aux: NaN, spark: -1, held: null, full: true };

function renderStats() {
  const w = statsCanvas.width, h = statsCanvas.height;
  if (!w || !h) return;
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const held = phase === 'results' && att.taps > 0;
  let total = 0;
  if (show) for (const cap of caps) total += counts[cap.src];
  if (held !== shown.held) {
    shown.held = held;
    el.kpsLabel.textContent = held ? 'Peak KPS' : 'KPS';
    el.spanLabel.textContent = held ? 'Attempt' : '10 s';
    shown.full = true;
  }
  const bigValue = phase === 'play' ? kps : held ? att.peak : -1;
  const seconds = (att.lastTap - att.firstTap) / 1000;
  const aux = held ? (seconds >= 1 ? Math.round((att.taps - 1) / seconds * 10) : -1) : phase === 'play' && att.taps ? att.peak : -1;
  const bigInk = phase === 'play' ? (bigValue > 0 ? C.accent : C.dim) : bigValue < 0 ? C.muted : C.fg;
  const full = shown.full;
  shown.full = false;
  if (full) { sx.setTransform(1, 0, 0, 1, 0, 0); sx.clearRect(0, 0, w, h); }

  if (full || bigValue !== shown.kps || bigInk !== shown.bigInk) {
    shown.kps = bigValue; shown.bigInk = bigInk;
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.clearRect(0, 0, Math.round(NUM_W * dpr), Math.round(SPARK_BOTTOM * dpr) + 2);
    sx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sx.font = F.big;
    sx.fillStyle = bigInk;
    sx.textAlign = 'center';
    sx.textBaseline = 'alphabetic';
    if (bigValue < 0) { sx.textAlign = 'left'; sx.font = F.count; sx.fillText('—', 0, 27); }
    else drawInt(sx, bigValue, -1, 29, 0, adv.big);
  }

  if (opts.spark) {
    const sparkKey = held ? -2 : phase === 'play' ? att.idx * 256 + hist[Math.max(0, att.idx)] : -3;
    if (full || sparkKey !== shown.spark) { shown.spark = sparkKey; drawSpark(phase, held); }
  }

  if (full || total !== shown.total || aux !== shown.aux) {
    shown.total = total; shown.aux = aux;
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.clearRect(0, Math.round(FOOT_Y * dpr), w, h - Math.round(FOOT_Y * dpr));
    sx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sx.textBaseline = 'alphabetic';
    let x = 0;
    if (opts.total) {
      x = drawPair(x, 'TOTAL', show ? total : -1, false);
      x += 14;
    }
    drawPair(x, held ? 'AVG' : 'PEAK', aux, held);
  }
}

function drawPair(x, label, value, tenths) {
  const y = STATS_H - 2;
  sx.textAlign = 'left';
  sx.font = F.footLabel;
  sx.letterSpacing = '0.72px';
  sx.fillStyle = C.muted;
  sx.fillText(label, x, y);
  x += sx.measureText(label).width + 6;
  sx.letterSpacing = '0px';
  sx.font = F.footValue;
  sx.fillStyle = C.dim;
  const text = value < 0 ? '—' : tenths ? `${Math.floor(value / 10)}.${value % 10}` : DIGITS[value] || String(value);
  sx.fillText(text, x, y);
  return x + sx.measureText(text).width;
}

function drawSpark(phase, held) {
  const left = Math.round(SPARK_X * dpr), right = Math.round((SPARK_X + SPARK_W) * dpr);
  const top = Math.round(SPARK_TOP * dpr), bottom = Math.round(SPARK_BOTTOM * dpr);
  const hair = Math.max(1, Math.round(dpr));
  sx.setTransform(1, 0, 0, 1, 0, 0);
  sx.clearRect(left, 0, right - left, bottom + 1);
  sx.fillStyle = C.ruleStrong;
  sx.fillRect(left, bottom - hair, right - left, hair);
  if (phase !== 'play' && !held) return;

  // 40 slots: live = the last 10 s ending at the current bucket; held = the whole attempt.
  const last = Math.max(0, att.idx);
  const group = held ? Math.max(1, Math.ceil((last + 1) / SPARK_BARS)) : 1;
  const start = held ? 0 : last - SPARK_BARS + 1;
  let peak = 0, peakBar = -1;
  for (let k = 0; k < SPARK_BARS; k++) {
    const v = bucket(start, group, k, last);
    if (v > peak) { peak = v; peakBar = k; }
  }
  const scale = Math.max(10, Math.ceil(peak / 5) * 5);
  const pitch = (right - left) / SPARK_BARS;
  const usable = bottom - hair - top;
  for (let k = 0; k < SPARK_BARS; k++) {
    const v = bucket(start, group, k, last);
    if (!v) continue;
    const x = left + Math.round(k * pitch);
    const bw = Math.max(1, left + Math.round(k * pitch + pitch * 2 / 3) - x);
    const bh = Math.max(hair, Math.round(v / scale * usable));
    const marked = held ? k === peakBar : start + k === last;
    sx.fillStyle = marked ? C.accent : C.dim;
    sx.globalAlpha = marked ? 1 : 0.5;
    sx.fillRect(x, bottom - hair - bh, bw, bh);
  }
  sx.globalAlpha = 1;
}

function bucket(start, group, k, last) {
  let v = 0;
  const from = start + k * group;
  for (let b = from; b < from + group; b++) if (b >= 0 && b <= last && hist[b] > v) v = hist[b];
  return v;
}

// ---------------------------------------------------------------- go
settings(DEFAULTS, s => {
  opts.vertical = s.orientation === 'vertical';
  opts.cap = Math.round(Math.min(80, Math.max(28, s.capSize)));
  opts.spark = !!s.showSparkline;
  opts.total = !!s.showTotal;
  panel.dataset.orient = opts.vertical ? 'vertical' : 'horizontal';
  panel.dataset.anchor = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(s.anchor) ? s.anchor : 'top-left';
  panel.dataset.spark = opts.spark ? 'on' : 'off';
  el.brand.hidden = !s.showBrand;
  dirty.layout = true;
  wake();
});

measureDigits();
Promise.all([F.count, F.big, F.sub, F.footValue].map(font => document.fonts.load(font))).catch(() => {}).then(() => {
  measureDigits();
  forceRedraw();
  wake();
});

subscribe(Object.values(P), onFrame, { onStatus });
wake();

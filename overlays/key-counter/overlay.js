// Copyright (c) 2026 18-LAB. MIT.
// Key counter: key caps that light on press (count inside, share-of-presses bar along the bottom)
// and a KPS readout (live keys per second, 10 s history, total and peak). The page is sized and
// placed by its host (OBS, vosulay, the replay renderer); it lays itself out for the box it gets:
// a row of caps in wide boxes (mania caps take the skin's column proportions, so the row lines up
// with the stage when the page spans it), a column in tall boxes. Shown during gameplay, and on
// the results screen with the attempt's peak/average KPS and history (osu! shows neither).
// Everything that changes per tap is drawn on one canvas with per-tile dirty redraws; data
// handlers only record state and one rAF pass renders, then sleeps until something will change.
// The per-frame path allocates nothing, even before V8 optimises it (unoptimised code boxes every
// fractional number it computes or reads from a Float64Array): it runs on small integers (whole-ms
// times, fixed-point press progress, Smi arrays) and reads fractional geometry from tables derived
// at layout time or on first use, held in generic arrays or null-initialised fields that store
// numbers as-is. Text is formatted and measured only when the number it shows changes.
import { subscribe, settings, activeMode, isPlaying, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

const RESULTS = 7;
const BUCKET_MS = 250;          // history resolution
const SPARK_BARS = 40;          // 40 × 250 ms = 10 s
const SPARK_SPAN = SPARK_BARS * BUCKET_MS;
const HISTORY = 14400;          // one hour of buckets for the results overview
const RING = 1024;              // taps inside the trailing second (power of two)
const MAX_KEYS = 32;
const FLASH_MS = 90;            // a tap that began and ended between two frames still lights
const PRESS_MS = 50, RELEASE_MS = 180;
// Press progress in fixed point (0..ANIM): a press advances PRESS_STEP per ms, a release retreats
// RELEASE_STEP per ms; both are integers, so the animation state stays in Smis.
const ANIM = 900, PRESS_STEP = ANIM / PRESS_MS, RELEASE_STEP = ANIM / RELEASE_MS;
const DIGIT_MAX = 16;           // digits of the largest safe integer; digit tables cover 1..16

const P = {
  state: '/state/number', playMode: '/play/mode/number', menuMode: '/settings/mode/number',
  client: '/client', all: '/keys/all', k1: '/keys/k1', k2: '/keys/k2', m1: '/keys/m1', m2: '/keys/m2',
  bindOsu: '/settings/keybinds/osu', bindTaiko: '/settings/keybinds/taiko', bindFruits: '/settings/keybinds/fruits',
  cs: '/beatmap/stats/cs/converted', checksum: '/beatmap/checksum', skin: '/settings/skin/name',
};

const $ = id => document.getElementById(id);
const root = document.documentElement;
const hud = $('hud'), chipText = $('chip-text');
const canvas = $('keys');
const ctx = canvas.getContext('2d', { alpha: true });
const css = getComputedStyle(root);
const token = name => css.getPropertyValue(name).trim();
const C = {
  fg: token('--fg'), dim: token('--fg-dim'), muted: token('--muted'), ruleStrong: token('--rule-strong'),
  amber: token('--accent'), onAmber: token('--on-accent'), kat: token('--signal'),
  tile: 'rgb(17 18 20 / 0.84)', track: 'rgb(235 232 225 / 0.1)', base: 'rgb(235 232 225 / 0.16)',
  lit: token('--accent'), onLit: token('--on-accent'),
};
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ease = t => 1 - (1 - t) ** 3;
/** An array with generic elements: fractional numbers stored here are read back without boxing. */
const tagged = n => new Array(n).fill(null);
const EASE = tagged(ANIM + 1), SCALE = tagged(ANIM + 1); // eased progress; cap scale while pressed
for (let p = 0; p <= ANIM; p++) { EASE[p] = ease(p / ANIM); SCALE[p] = 1 - 0.06 * EASE[p]; }

// ---------------------------------------------------------------- attempt state
const tapRing = new Int32Array(RING);      // whole-ms tap times
let ringHead = 0, ringLen = 0;
const hist = new Uint8Array(HISTORY);
const prev = new Array(MAX_KEYS).fill(0);  // key counts: integers, kept as Smis
const counts = new Array(MAX_KEYS).fill(0);
const pressed = new Uint8Array(MAX_KEYS);
const litUntil = new Int32Array(MAX_KEYS);
// next: when history bucket idx + 1 starts (t0 + (idx + 1) × BUCKET_MS). lastTap is set by the first tap.
const att = { seeded: false, n: 0, t0: 0, idx: -1, next: 0, peak: 0, taps: 0, firstTap: 0, lastTap: 0, valid: false };

function resetAttempt() {
  ringHead = 0; ringLen = 0;
  hist.fill(0);
  prev.fill(0); counts.fill(0); pressed.fill(0); litUntil.fill(0);
  att.seeded = false; att.n = 0; att.idx = -1; att.peak = 0; att.taps = 0; att.firstTap = 0; att.lastTap = 0; att.valid = false;
  dirty.stats = true;
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

/** Caps to show: [{src: index into keys.all, label, sub, kind}]; kind 'kat' | 'don' tints taiko keys. */
function layoutFor(mode, client, columns, smoke, binds) {
  const b = binds || {};
  if (mode === 'osu') {
    const caps = [{ src: 0, label: keyLabel(b.k1, 'K1') }, { src: 1, label: keyLabel(b.k2, 'K2') }];
    if (smoke) caps.push({ src: 2, label: keyLabel(b.smokeKey, 'SMOKE'), sub: 'SMK' });
    return caps;
  }
  if (mode === 'taiko') return [
    { src: 0, label: keyLabel(b.outerLeft, 'L'), sub: 'KAT', kind: 'kat' },
    { src: 1, label: keyLabel(b.innerLeft, 'L'), sub: 'DON', kind: 'don' },
    { src: 2, label: keyLabel(b.innerRight, 'R'), sub: 'DON', kind: 'don' },
    { src: 3, label: keyLabel(b.outerRight, 'R'), sub: 'KAT', kind: 'kat' },
  ];
  if (mode === 'fruits') {
    // osu!stable records the catcher position, not left/right presses: only dash is real there.
    const dash = { src: 2, label: keyLabel(b.Dash, 'DASH'), sub: b.Dash ? 'DASH' : '' };
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

const view = { status: 'connecting', phase: 'connecting', mode: null, client: 'stable', caps: [], sig: '', columns: 0 };
const dirty = { layout: true, stats: true, phase: true };
let lastColumns = 0;
const lk = { mode: undefined, client: undefined, columns: -1, smoke: false, binds: undefined };

function onFrame(values) {
  const now = Math.floor(performance.now()); // whole ms: every time below stays a Smi
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.menuMode]);
  const playing = isPlaying(state);
  let phase = state === undefined || !mode ? 'absent' : playing ? 'play' : state === RESULTS ? 'results' : 'menu';
  const src = playing || phase === 'results' ? readKeys(values, mode) : null;
  if (phase === 'play' && !src) phase = 'nokeys';

  if (phase === 'play' && view.phase !== 'play') resetAttempt();
  loadPalette(values[P.checksum]);

  let columns = 0;
  if (mode === 'mania') {
    if (src) columns = lastColumns = src.length;
    else {
      const cs = Math.round(num(values[P.cs]));
      columns = lastColumns || (cs >= 1 && cs <= 18 ? cs : 4);
    }
    loadSkin(columns, values[P.skin]);
  }
  const smoke = mode === 'osu' && !!src && src.length > 2 && num(src[2].count) > 0;
  const client = values[P.client] === 'lazer' ? 'lazer' : 'stable';
  const binds = mode === 'osu' ? values[P.bindOsu] : mode === 'taiko' ? values[P.bindTaiko] : mode === 'fruits' ? values[P.bindFruits] : null;
  // Cheap identity check first (binds stay the same object until vosu reports a change).
  if (mode !== lk.mode || client !== lk.client || columns !== lk.columns || smoke !== lk.smoke || binds !== lk.binds) {
    lk.mode = mode; lk.client = client; lk.columns = columns; lk.smoke = smoke; lk.binds = binds;
    const caps = mode ? layoutFor(mode, client, columns, smoke, binds) : [];
    const sig = `${mode}|${client}|${caps.map(c => `${c.src}:${c.label}:${c.sub || ''}`).join(',')}`;
    if (sig !== view.sig) {
      const keysetChanged = view.mode !== mode || view.columns !== columns || (mode === 'fruits' && view.caps.length !== caps.length);
      view.sig = sig; view.caps = caps; view.mode = mode; view.columns = columns; view.client = client;
      dirty.layout = true;
      if (keysetChanged && phase === 'play') resetAttempt();
    }
  }

  if (phase === 'play') {
    const n = Math.min(src.length, MAX_KEYS);
    if (!att.seeded || n !== att.n) {
      // First sight of this attempt: take the counts as a baseline instead of inventing a burst.
      for (let i = 0; i < n; i++) prev[i] = num(src[i].count);
      att.seeded = true; att.n = n; att.t0 = att.next = now; att.idx = -1;
    } else {
      for (let i = 0; i < n; i++) {
        if (num(src[i].count) < prev[i]) { // retry or rewind: a new attempt
          resetAttempt();
          for (let j = 0; j < n; j++) prev[j] = num(src[j].count);
          att.seeded = true; att.n = n; att.t0 = att.next = now;
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
    dirty.stats = true;
  } else if (phase === 'results') {
    // Hold the attempt that just ended; a page opened on the results screen shows what vosu still reports.
    if (!att.valid && src) {
      let total = 0;
      const n = Math.min(src.length, MAX_KEYS);
      for (let i = 0; i < n; i++) { counts[i] = num(src[i].count); total += counts[i]; }
      if (total > 0) { att.valid = true; att.n = n; }
    }
    pressed.fill(0);
    dirty.stats = true;
  } else if (view.phase === 'results' || view.phase === 'play') {
    att.valid = false;
    dirty.stats = true;
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
  // Column layouts drop the key rows on the results screen.
  if (phase === 'results' || view.phase === 'results') dirty.layout = true;
  view.phase = phase;
  dirty.phase = dirty.stats = true;
}

// ---------------------------------------------------------------- map tint
let paletteFor = null;
function loadPalette(checksum) {
  const key = opts.accent === 'map' ? checksum || '' : '';
  if (key === paletteFor) return;
  paletteFor = key;
  if (!key) { setTint(null); return; }
  mapPalette(key).then(palette => { if (paletteFor === key) setTint(palette); }); // off the hot path
}
function setTint(palette) {
  applyPalette(root, palette);
  C.lit = palette?.accent || C.amber;
  C.onLit = palette?.onAccent || C.onAmber;
  forceRedraw();
  wake();
}

// ---------------------------------------------------------------- mania column proportions
// The current skin's [Mania] section for this key count (column widths and spacing), re-read on
// key-count or skin change. Only proportions are used: the page spans what its host gives it.
const skinGeo = { wantKeys: 0, wantName: null, keys: 0, value: null };
function loadSkin(keys, name) {
  const skin = typeof name === 'string' ? name : '';
  if (keys === skinGeo.wantKeys && skin === skinGeo.wantName) return;
  skinGeo.wantKeys = keys; skinGeo.wantName = skin;
  maniaSkin(keys, skin).then(value => {
    if (skinGeo.wantKeys !== keys || skinGeo.wantName !== skin) return;
    skinGeo.keys = keys; skinGeo.value = value;
    dirty.layout = true;
    wake();
  }).catch(() => {});
}

/** Column edges as fractions of the stage width: [{a, b}] per column, from the skin or equal. */
function columnFractions(n) {
  const skin = opts.maniaColumns === 'skin' && skinGeo.keys === n ? skinGeo.value : null;
  const widths = [], gaps = [];
  for (let i = 0; i < n; i++) widths.push(skin?.columnWidth?.[i] || 30);
  for (let i = 0; i < n - 1; i++) gaps.push(skin?.columnSpacing?.[i] || 0);
  const total = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const out = [];
  let x = 0;
  for (let i = 0; i < n; i++) { out.push({ a: x / total, b: (x + widths[i]) / total }); x += widths[i] + (gaps[i] || 0); }
  return out;
}

// ---------------------------------------------------------------- layout for the page's box
const opts = {
  orientation: 'auto', align: 'center', kps: 'auto', spark: true, total: true,
  maniaColumns: 'skin', backing: 'none', accent: 'map',
};
const box = { w: 0, h: 0 };        // page size in CSS px (ResizeObserver)
let dpr = devicePixelRatio || 1;   // device px per CSS px
const caps = [];                   // drawn caps (planCap): source, text and per-press geometry, animation state
// KPS tile box in CSS px; X0..Y1 its device-px bounds, tx/ty its text transform origin (planStats).
const stat = { show: false, x: 0, y: 0, w: 0, h: 0, style: 'wide', X0: 0, Y0: 0, X1: 0, Y1: 0, tx: null, ty: null };
// Device-px constants for the current devicePixelRatio: hairline, taiko drum line, tile corner radii.
let HAIR = 1, RD = 1, HAIR2 = 2, R2 = null, R2IN = null;
const TEXT_A = tagged(ANIM + 1);   // cap text transform scale (dpr × cap scale) per press progress
const F = {};                      // font strings for the current layout
const adv = { count: 0, big: 0 };  // fixed digit advance for the current fonts
let adv100 = { display: 55, mono: 60 }; // digit advance at 100 px, measured once fonts load
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Lays the caps and the KPS tile out in the page's box. Wide boxes: a row of caps with the KPS
 * tile beside it (osu!/taiko/catch) or as a strip above/below it (mania, whose row then spans the
 * box with the skin's column proportions). Tall boxes: a column of key rows with the KPS tile below.
 */
function buildLayout() {
  const W = box.w, H = box.h;
  dirty.layout = false;
  caps.length = 0;
  stat.show = false;
  planDevice();
  if (!W || !H) return;
  const n = view.caps.length;
  const mania = view.mode === 'mania';
  const vertical = opts.orientation === 'vertical' || (opts.orientation === 'auto' && H > W * 1.15);
  let where = opts.kps === 'auto' ? (vertical ? 'below' : mania ? 'above' : 'beside') : opts.kps;
  if (vertical && where === 'beside') where = 'below';
  const align = opts.align === 'left' ? 0 : opts.align === 'right' ? 1 : 0.5;
  const place = (list, x, y, w, h, style) => list.push({ x, y, w, h, style });
  const rects = [];

  if (vertical) {
    // Unit = tile width; caps are half as tall, the KPS tile a little taller than wide. On the
    // results screen a column keeps only the KPS tile at its foot: osu!stable's results UI (Watch
    // replay) sits where the key rows of a corner column would be.
    const rows = view.phase === 'results' && where !== 'off' ? 0 : n;
    const statH = where === 'off' ? 0 : 1.1;
    const per = rows * 0.5 + Math.max(0, rows - 1) * 0.06 + (statH ? 0.1 + statH : 0);
    const u = Math.min(W, H / Math.max(per, 0.5));
    const x0 = (W - u) * align;
    const g = Math.round(u * 0.06), capH = Math.round(u * 0.5);
    // Pages in a column sit in screen corners: the stack hugs the bottom of the box.
    let y = Math.max(0, Math.floor(H - u * per));
    if (where === 'above') { stat.show = true; Object.assign(stat, { x: x0, y, w: u, h: Math.round(u * statH), style: 'tall' }); y += stat.h + Math.round(u * 0.1); }
    for (let i = 0; i < rows; i++) { place(rects, x0, y, u, capH, 'row'); y += capH + g; }
    if (where === 'below') { stat.show = true; Object.assign(stat, { x: x0, y: y - g + Math.round(u * 0.1), w: u, h: Math.round(u * statH), style: 'tall' }); }
    const label = clamp(u * 0.1, 9, 16), count = clamp(capH * 0.44, 12, 40);
    setFonts(label, count, clamp(u * 0.34, 16, 52), label, clamp(u * 0.11, 10, 16));
  } else if (where === 'beside') {
    // Unit = cap height = box height; the KPS tile is 3.7 units wide.
    const gp = 0.08;
    let u = H;
    const fixed = 3.7 + gp;                         // KPS tile and the gap before it
    const minCaps = mania ? n * 0.55 : n * 0.7 + (n - 1) * gp;
    if (W < u * (fixed + minCaps)) u = W / (fixed + minCaps);
    const g = Math.round(u * gp), statW = Math.round(u * 3.7);
    const capsW = W - statW - g;
    const y0 = Math.round((H - u) / 2);
    let used;
    if (mania) {
      for (const c of columnFractions(n)) place(rects, Math.round(capsW * c.a), y0, Math.round(capsW * (c.b - c.a)), u, 'col');
      used = capsW;
    } else {
      const cw = Math.min(u, Math.floor((capsW - (n - 1) * g) / Math.max(1, n)));
      for (let i = 0; i < n; i++) place(rects, i * (cw + g), y0, cw, u, 'col');
      used = n * cw + (n - 1) * g;
    }
    // Align the whole cluster in the box; the KPS tile stays on the side away from the edge it hugs.
    const clusterW = used + g + statW;
    const off = Math.round((W - clusterW) * align);
    const statLeft = align === 1 && !mania;
    for (const r of rects) r.x += off + (statLeft ? statW + g : 0);
    stat.show = true;
    Object.assign(stat, { x: off + (statLeft ? 0 : used + g), y: y0, w: statW, h: u, style: 'wide' });
    const s = u / 72;
    setFonts(clamp(12 * s, 9, 18), clamp(26 * s, 12, 44), clamp(32 * s, 14, 52), clamp(12 * s, 9, 16), clamp(13 * s, 9, 18));
  } else {
    // KPS strip above/below a row of caps. Mania caps span the box with the skin's proportions.
    const stripH = where === 'off' ? 0 : Math.round(clamp(H * 0.34, 16, 52));
    const g = stripH ? Math.max(3, Math.round(H * 0.05)) : 0;
    const capH = H - stripH - g;
    const capsY = where === 'above' ? stripH + g : 0;
    let left = 0, used = W;
    if (mania) {
      const cols = columnFractions(n);
      const gap = Math.max(2, Math.round(W * 0.006));
      for (const c of cols) {
        const x0 = Math.round(W * c.a), x1 = Math.round(W * c.b);
        place(rects, x0 + gap / 2, capsY, Math.max(4, x1 - x0 - gap), capH, 'col');
      }
    } else {
      const cg = Math.round(capH * 0.08);
      const cw = Math.min(capH, Math.floor((W - (n - 1) * cg) / Math.max(1, n)));
      used = n * cw + (n - 1) * cg;
      left = Math.round((W - used) * align);
      for (let i = 0; i < n; i++) place(rects, left + i * (cw + cg), capsY, cw, capH, 'col');
    }
    if (stripH) {
      stat.show = true;
      // The strip spans the caps, but never narrower than a readable minimum.
      const sw = Math.min(W, Math.max(used, stripH * 7));
      Object.assign(stat, { x: Math.round(clamp(left + (used - sw) * align, 0, W - sw)), y: where === 'above' ? 0 : capH + g, w: sw, h: stripH, style: 'line' });
    }
    const minW = rects.reduce((m, r) => Math.min(m, r.w), Infinity);
    setFonts(clamp(Math.min(capH * 0.17, minW * 0.22), 9, 16), clamp(Math.min(capH * 0.38, minW * 0.5), 11, 44),
      clamp(stripH * 0.8, 12, 40), clamp(stripH * 0.3, 9, 14), clamp(stripH * 0.34, 9, 16));
  }

  for (let i = 0; i < view.caps.length; i++) if (rects[i]) caps.push(planCap(view.caps[i], rects[i], i));
  if (stat.show) planStats();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  forceRedraw();
}

function setFonts(label, count, big, footLabel, footValue) {
  const r = v => Math.round(v * 10) / 10;
  F.label = `500 ${r(label)}px "IBM Plex Mono"`;
  F.labelPx = label;
  F.count = `600 ${r(count)}px "Barlow Condensed"`;
  F.countPx = count;
  F.big = `600 ${r(big)}px "Barlow Condensed"`;
  F.bigPx = big;
  F.footLabel = `500 ${r(footLabel)}px "IBM Plex Mono"`;
  F.footValue = `500 ${r(footValue)}px "IBM Plex Mono"`;
  adv.count = adv100.display * count / 100;
  adv.big = adv100.display * big / 100;
}

function forceRedraw() {
  for (let i = 0; i < caps.length; i++) caps[i].dP = -1;
  shown.full = true;
  dirty.stats = true;
}

function measureDigits() {
  ctx.font = '600 100px "Barlow Condensed"';
  let w = 0;
  for (const d of DIGITS) w = Math.max(w, ctx.measureText(d).width);
  adv100 = { display: w || 55, mono: 60 };
  dirty.layout = true;
}

function planDevice() {
  HAIR = Math.max(1, Math.round(dpr)); RD = Math.round(dpr); HAIR2 = Math.max(1, Math.round(2 * dpr));
  R2 = 2 * dpr; R2IN = Math.max(0, R2 - HAIR);
  TEXT_A.fill(null); // derived per press progress on first use (capPress)
}

/** Width of text in a font and letter spacing (layout time only: measureText allocates). */
function textWidth(text, font, spacing) {
  ctx.font = font;
  ctx.letterSpacing = spacing;
  const w = ctx.measureText(text).width;
  ctx.letterSpacing = '0px';
  return w;
}

// Per-press geometry buffers for each cap slot, kept across layouts (a relayout only invalidates them).
const pressBufs = [];

/**
 * A drawn cap for layout rect r (slot i): device-px bounds, text positions, and per-press-progress
 * buffers that capPress fills on first use. Fractional fields start as null so they hold numbers as-is.
 */
function planCap(spec, r, i) {
  const X0 = Math.floor(r.x * dpr), X1 = Math.ceil((r.x + r.w) * dpr);
  const Y0 = Math.floor(r.y * dpr), Y1 = Math.ceil((r.y + r.h) * dpr);
  const buf = pressBufs[i] || (pressBufs[i] = { rect: new Int32Array(4 * (ANIM + 1)), ty: tagged(ANIM + 1), bh: new Int32Array(ANIM + 1) });
  buf.bh.fill(-1);
  const cap = {
    src: spec.src, label: spec.label, sub: spec.sub || '', kind: spec.kind || '', w: r.w, h: r.h, style: r.style,
    X0, Y0, CW: X1 - X0, CH: Y1 - Y0, rect: buf.rect, ty: buf.ty, bh: buf.bh,
    ry: null, cx: null, tx: null, lx: null, ly: null, subX: null, cntX: null, cntY: null, digX: null, squeeze: null,
    labelAlign: 'left', subAlign: 'left', dashAlign: 'center', subShown: false,
    p: 0, f: 0, dP: -1, dF: -1, dN: -2, dM: -1, dTop: false, mC: -2, mMax: -2, m: 0,
  };
  cap.ry = r.y;
  cap.cx = r.x + r.w / 2;
  cap.tx = cap.cx * dpr;
  const labelW = textWidth(cap.label, F.label, '0.5px');
  const subW = cap.sub ? textWidth(cap.sub, F.label, '0.5px') : 0;
  const pad = Math.max(4, Math.min(r.w, r.h) * 0.11);
  if (r.style === 'row') {
    // Key row (vertical layout): label (and role) on the outer side, count on the inner side.
    const mirror = opts.align === 'right';
    cap.ly = F.labelPx * 0.36;
    cap.labelAlign = cap.subAlign = mirror ? 'right' : 'left';
    cap.lx = mirror ? r.w / 2 - pad : -r.w / 2 + pad;
    cap.subShown = !!cap.sub && labelW + subW + 8 + pad * 2 + adv.count * 2 < r.w;
    cap.subX = mirror ? cap.lx - labelW - 8 : cap.lx + labelW + 8;
    cap.cntX = mirror ? -r.w / 2 + pad : r.w / 2 - pad;
    cap.cntY = F.countPx * 0.35;
    cap.dashAlign = mirror ? 'left' : 'right';
    cap.digX = digitPlan(cap.cntX, mirror ? 0 : 1, adv.count);
  } else {
    // Column cap: label row at the top (role on the right when it fits), count below.
    const subFits = !!cap.sub && labelW + 8 + subW <= r.w - pad * 2;
    cap.ly = -r.h / 2 + pad + F.labelPx * 0.75;
    cap.subShown = subFits;
    cap.labelAlign = subFits ? 'left' : 'center';
    cap.lx = subFits ? -r.w / 2 + pad : 0;
    cap.subAlign = 'right';
    cap.subX = r.w / 2 - pad;
    cap.cntX = 0;
    cap.cntY = r.h / 2 - pad - Math.max(2, r.h * 0.05);
    cap.digX = digitPlan(0, 0.5, adv.count);
    // Long counts in narrow caps are condensed horizontally rather than clipped.
    cap.squeeze = tagged(DIGIT_MAX + 1);
    for (let d = 1; d <= DIGIT_MAX; d++) cap.squeeze[d] = Math.min(1, (r.w - pad * 2) / (d * adv.count));
  }
  return cap;
}

/** Derives a cap's tile rect, text origin and meter height at press progress p (the cap travels 1 px down and shrinks to 94 % while pressed). */
function capPress(cap, p) {
  const press = EASE[p], scale = SCALE[p];
  const cx = cap.cx, cy = cap.ry + cap.h / 2 + press;
  const hw = cap.w * scale / 2, hh = cap.h * scale / 2;
  cap.rect[4 * p] = Math.round((cx - hw) * dpr);
  cap.rect[4 * p + 1] = Math.round((cy - hh) * dpr);
  cap.rect[4 * p + 2] = Math.round((cx + hw) * dpr);
  cap.rect[4 * p + 3] = Math.round((cy + hh) * dpr);
  cap.ty[p] = cy * dpr;
  cap.bh[p] = Math.max(2, Math.round(Math.min(3, cap.h * 0.045) * dpr * scale));
  if (TEXT_A[p] === null) TEXT_A[p] = dpr * scale;
}

/**
 * Where drawDigits puts each digit of a d-digit integer at fixed advance (canvas has no
 * tabular-nums): xs[d * DIGIT_MAX + i], derived per digit count on first use. Align 0 left, 0.5 centre, 1 right.
 */
function digitPlan(x, align, step) {
  const plan = { xs: tagged((DIGIT_MAX + 1) * DIGIT_MAX), x: null, align: null, step: null };
  plan.x = x; plan.align = align; plan.step = step;
  return plan;
}

const DIG = new Int32Array(DIGIT_MAX); // digits of the integer being drawn, least significant first
/** Splits a non-negative integer into DIG; returns its digit count. */
function splitDigits(value) {
  let n = Math.max(0, Math.round(value)), d = 0;
  if (n > Number.MAX_SAFE_INTEGER) n = Number.MAX_SAFE_INTEGER;
  do { const r = n % 10; DIG[d++] = r; n = (n - r) / 10; } while (n > 0);
  return d;
}
function drawDigits(d, plan, y) {
  const xs = plan.xs, o = d * DIGIT_MAX;
  if (xs[o] === null) {
    let left = plan.x - d * plan.step * plan.align + plan.step / 2;
    for (let i = 0; i < d; i++) { xs[o + i] = left; left += plan.step; }
  }
  ctx.textAlign = 'center';
  for (let i = 0; i < d; i++) ctx.fillText(DIGITS[DIG[d - 1 - i]], xs[o + i], y);
}
function digitCount(v) {
  let d = 1;
  while (v >= 10) { v = (v - v % 10) / 10; d++; }
  return d;
}

// The canvas fills the page; its backing store follows the box × devicePixelRatio.
new ResizeObserver(([entry]) => {
  const bx = entry.devicePixelContentBoxSize?.[0];
  const w = bx ? bx.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio);
  const h = bx ? bx.blockSize : Math.round(entry.contentRect.height * devicePixelRatio);
  if (!w || !h) return;
  if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  box.w = entry.contentRect.width; box.h = entry.contentRect.height;
  dpr = w / box.w;
  dirty.layout = true;
  wake();
}).observe(canvas);

// ---------------------------------------------------------------- render loop
let raf = 0, timer = 0, kps = 0, lastFrame = 0;
function wake() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(stamp) {
  raf = 0;
  if (timer) { clearTimeout(timer); timer = 0; }
  const now = Math.floor(stamp);
  const dt = lastFrame ? (now - lastFrame < 100 ? now - lastFrame : 100) : 16;
  lastFrame = now;
  const live = view.phase === 'play';

  if (live) {
    evict(now);
    if (ringLen !== kps) { kps = ringLen; dirty.stats = true; }
    if (kps > att.peak) att.peak = kps;
    if (att.seeded) {
      // Step to the bucket holding now (history ends after HISTORY buckets).
      while (now >= att.next && att.idx < HISTORY - 1) { att.idx++; att.next += BUCKET_MS; dirty.stats = true; }
      if (att.idx >= 0 && now < att.next && kps > hist[att.idx]) { hist[att.idx] = kps < 255 ? kps : 255; dirty.stats = true; }
    }
  } else if (kps) { kps = 0; ringLen = 0; dirty.stats = true; }

  if (dirty.layout) buildLayout();
  if (dirty.phase) renderPhase();
  const visible = view.phase === 'play' || view.phase === 'results';
  let animating = false;
  if (visible && canvas.width) {
    animating = renderKeys(now, dt);
    if (dirty.stats) renderStats();
  }
  dirty.stats = !visible && dirty.stats;

  let next = Infinity;
  if (animating) next = now;
  if (live) {
    if (ringLen && tapRing[ringHead] + 1001 < next) next = tapRing[ringHead] + 1001;
    for (let i = 0; i < att.n; i++) if (litUntil[i] > now && litUntil[i] < next) next = litUntil[i];
    if (att.seeded && att.taps > 0 && now - att.lastTap < SPARK_SPAN + BUCKET_MS && att.idx + 1 < HISTORY && att.next < next) next = att.next;
  }
  if (next === now) raf = requestAnimationFrame(frame);
  else if (next !== Infinity) {
    const wait = next - Math.floor(performance.now());
    timer = setTimeout(wake, wait > 0 ? wait : 0);
  } else lastFrame = 0;
}

function renderPhase() {
  const phase = view.phase;
  hud.dataset.phase = phase;
  chipText.textContent = phase === 'offline' ? 'vosu offline' : phase === 'connecting' ? 'Connecting to vosu'
    : phase === 'absent' ? 'Waiting for osu!' : phase === 'nokeys' ? 'Needs vosu · ENABLE_KEY_OVERLAY' : '';
  dirty.phase = false;
}

/** Advances press animations and redraws only the caps whose look changed. Returns true while animating. */
function renderKeys(now, dt) {
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const live = phase === 'play';
  const n = caps.length;
  let max = 0;
  if (show) for (let i = 0; i < n; i++) if (counts[caps[i].src] > max) max = counts[caps[i].src];
  let animating = false;
  for (let i = 0; i < n; i++) {
    const cap = caps[i], k = cap.src;
    const on = live && (pressed[k] === 1 || litUntil[k] > now);
    if (on) {
      cap.f = ANIM;
      const p = cap.p + dt * PRESS_STEP;
      cap.p = p < ANIM ? p : ANIM;
    } else {
      const step = dt * RELEASE_STEP;
      cap.f = cap.f > step ? cap.f - step : 0;
      cap.p = cap.p > step ? cap.p - step : 0;
    }
    if ((on && cap.p < ANIM) || (!on && (cap.p > 0 || cap.f > 0))) animating = true;
    const c = show ? counts[k] : -1;
    if (c !== cap.mC || max !== cap.mMax) { // share-of-presses bar length, re-derived only when a count moves
      cap.mC = c; cap.mMax = max;
      cap.m = c > 0 && max > 0 ? Math.round(c / max * (cap.w - 2) * dpr) : 0;
    }
    const m = cap.m;
    const top = c > 0 && c === max && n > 1;
    if (cap.p === cap.dP && cap.f === cap.dF && c === cap.dN && m === cap.dM && top === cap.dTop) continue;
    cap.dP = cap.p; cap.dF = cap.f; cap.dN = c; cap.dM = m; cap.dTop = top;
    drawCap(cap, c, m, top);
  }
  return animating;
}

/** Rounded tile in device px with a hairline border (≥ 1 device px). */
function tile(x0, y0, x1, y1, fill, border) {
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, R2); ctx.fill();
  ctx.fillStyle = border;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, R2);
  ctx.roundRect(x0 + HAIR, y0 + HAIR, x1 - x0 - 2 * HAIR, y1 - y0 - 2 * HAIR, R2IN);
  ctx.fill('evenodd');
}

function drawCap(cap, c, meterPx, top) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(cap.X0, cap.Y0, cap.CW, cap.CH);

  // The cap travels 1 px down and shrinks to 94 % while pressed (capPress); the fill is instant on, eased off.
  const p = cap.p, rect = cap.rect;
  if (cap.bh[p] < 0) capPress(cap, p);
  const x0 = rect[4 * p], y0 = rect[4 * p + 1], x1 = rect[4 * p + 2], y1 = rect[4 * p + 3];
  const lit = EASE[cap.f];
  const litFill = cap.kind === 'kat' ? C.kat : cap.kind === 'don' ? C.amber : C.lit;
  const litInk = cap.kind ? C.onAmber : C.onLit;
  tile(x0, y0, x1, y1, C.tile, C.ruleStrong);
  if (lit > 0) {
    ctx.globalAlpha = lit;
    ctx.fillStyle = litFill;
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, R2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Taiko keys keep a hairline of their drum colour so kat/don read without pressing.
  if (cap.kind && lit < 1) {
    ctx.fillStyle = cap.kind === 'kat' ? C.kat : C.amber;
    ctx.fillRect(x0 + RD, y0 + RD, x1 - x0 - 2 * RD, HAIR2);
  }
  const ink = lit >= 0.5 ? litInk : null;

  // Text, scaled with the cap about its centre.
  const a = TEXT_A[p];
  ctx.setTransform(a, 0, 0, a, cap.tx, cap.ty[p]);
  ctx.textBaseline = 'alphabetic';
  ctx.font = F.label;
  ctx.letterSpacing = '0.5px';
  ctx.fillStyle = ink || C.dim;
  ctx.textAlign = cap.labelAlign;
  ctx.fillText(cap.label, cap.lx, cap.ly);
  if (cap.subShown) {
    ctx.textAlign = cap.subAlign;
    ctx.fillStyle = ink || C.muted;
    ctx.fillText(cap.sub, cap.subX, cap.ly);
  }
  ctx.letterSpacing = '0px';
  ctx.font = F.count;
  ctx.fillStyle = ink || (c < 0 ? C.muted : C.fg);
  if (c < 0) { ctx.textAlign = cap.dashAlign; ctx.fillText('—', cap.cntX, cap.cntY); }
  else {
    const d = splitDigits(c);
    if (cap.squeeze && cap.squeeze[d] < 1) ctx.transform(cap.squeeze[d], 0, 0, 1, 0, 0);
    drawDigits(d, cap.digX, cap.cntY);
  }

  // Share-of-presses bar along the bottom edge (skipped for a lone key: stable catch dash).
  if (caps.length > 1) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bx = x0 + HAIR, bw = x1 - x0 - 2 * HAIR;
    const bh = cap.bh[p];
    const by = y1 - HAIR - bh;
    ctx.fillStyle = ink ? 'rgb(0 0 0 / 0.18)' : C.track;
    ctx.fillRect(bx, by, bw, bh);
    if (meterPx > 0) {
      ctx.fillStyle = ink || (top ? C.fg : C.dim);
      ctx.globalAlpha = ink ? 0.55 : top ? 0.9 : 0.6;
      const mw = p === 0 ? meterPx : Math.round(meterPx * SCALE[p]);
      ctx.fillRect(bx, by, mw < bw ? mw : bw, bh);
      ctx.globalAlpha = 1;
    }
  }
}

// Last drawn stats; the tile repaints only when one of its values changes. Numbers start as null
// (not NaN) so these fields hold integers as-is.
const shown = { kps: null, total: null, aux: null, spark: -1, phase: '', full: true };

// Tile plans for the current layout, live [0] and held results [1]: labels, text positions in tile
// space, the history bars' device rect. Fractional fields start as null so they hold numbers as-is.
const statPlan = () => ({
  label: '', span: '', auxLabel: '', spanAlign: 'left', chain: false, sparkOn: false, pairsOn: false, stripD: -1,
  labelX: null, labelY: null, spanX: null, spanY: null, bigDashX: null, bigY: null, bigXs: null,
  L: 0, R: 0, T: 0, B: 0, pairX: null, pairY: null, totalValueX: null, gap: null,
  auxW: null, auxX: null, auxY: null, auxValueX: null, chainText: null, chainX: null, chainValueX: null,
  xb: null, fx: null, pad: null, sparkTop: null, sparkRight: null, sparkBottom: null,
});
const SP = [statPlan(), statPlan()];
// Foot values on display: formatted and measured only when the number changes.
const valueSlot = () => ({ v: null, tenths: false, text: '', w: null });
const totalShown = valueSlot(), auxShown = valueSlot();

function planStats() {
  const { x: sx, y: sy, w: sw, h: sh } = stat;
  stat.X0 = Math.floor(sx * dpr); stat.Y0 = Math.floor(sy * dpr);
  stat.X1 = Math.ceil((sx + sw) * dpr); stat.Y1 = Math.ceil((sy + sh) * dpr);
  stat.tx = sx * dpr; stat.ty = sy * dpr;
  planVariant(SP[0], false, sw, sh);
  planVariant(SP[1], true, sw, sh);
  totalShown.v = auxShown.v = null; // fonts may have changed: re-measure
}

const labelWidth = text => textWidth(text, F.footLabel, '0.9px');

function planVariant(sp, held, sw, sh) {
  sp.label = held ? 'PEAK' : 'KPS';
  sp.span = held ? 'ATTEMPT' : '10 S';
  sp.auxLabel = held ? 'AVG' : 'PEAK';
  sp.auxW = labelWidth(sp.auxLabel);
  sp.chainText = null; sp.stripD = -1;
  if (stat.style === 'wide') {
    // Left: label over the big number. Right: window label, history bars, total / peak line.
    const s = sh / 72, pad = 10 * s, right0 = 84 * s;
    sp.labelX = pad; sp.labelY = 20 * s;
    sp.spanX = right0; sp.spanY = 20 * s; sp.spanAlign = 'left';
    planBig(sp, pad - 1, 60 * s);
    sparkRect(sp, right0, 27 * s, sw - pad, 48 * s);
    sp.pairX = right0; sp.pairY = sp.auxY = opts.spark ? 63 * s : 50 * s;
    sp.chain = opts.total; sp.gap = 12 * s;
  } else if (stat.style === 'tall') {
    // Vertical column: label row, big number, history bars, then total and peak on their own lines.
    const pad = Math.max(6, sw * 0.08);
    sp.labelX = pad; sp.labelY = pad + F.labelPx * 0.8;
    sp.spanX = sw - pad; sp.spanY = pad + F.labelPx * 0.8; sp.spanAlign = 'right';
    planBig(sp, pad - 1, sh * 0.48);
    sparkRect(sp, pad, sh * 0.54, sw - pad, sh * 0.7);
    sp.pairX = pad; sp.pairY = sh * 0.83; sp.auxY = sh * (opts.total ? 0.95 : 0.88);
    sp.chain = false;
  } else {
    // Strip: KPS label, number, history bars filling the middle, total / peak at the end. The bars
    // start after the big number (at least two digits wide; renderStats places them per digit count).
    const pad = Math.max(6, sh * 0.25);
    sp.pad = pad;
    sp.labelX = pad; sp.labelY = sh / 2 + F.labelPx * 0.36;
    sp.xb = pad + labelWidth(sp.label) + pad * 0.6;
    planBig(sp, sp.xb - 1, sh / 2 + F.bigPx * 0.33);
    // Measure the foot from its right end (labels without letter spacing here); the bars take what is left.
    const valueW = textWidth('0000', F.footValue, '0px');
    const pairW = l => textWidth(l, F.footLabel, '0px') + 4 + valueW;
    const footW = (opts.total ? pairW('TOTAL') + 12 : 0) + pairW(sp.auxLabel);
    sp.fx = sw - pad - footW;
    sp.sparkTop = sh * 0.2; sp.sparkRight = sp.fx - pad; sp.sparkBottom = sh * 0.8;
    sp.pairX = sp.fx; sp.pairY = sp.auxY = sp.labelY;
    sp.chain = opts.total; sp.gap = 12;
  }
  sp.totalValueX = sp.pairX + labelWidth('TOTAL') + 4;
  sp.auxX = sp.pairX; // the aux pair's place when it does not follow the total on its line
  sp.auxValueX = sp.auxX + sp.auxW + 4;
}

function planBig(sp, x, y) {
  sp.bigDashX = x + 1; sp.bigY = y;
  sp.bigXs = digitPlan(x, 0, adv.big);
}

/** History bars' device rect from tile-space x0..x1, top..bottom. */
function sparkRect(sp, x0, top, x1, bottom) {
  sp.L = Math.round((stat.x + x0) * dpr); sp.R = Math.round((stat.x + x1) * dpr);
  sp.T = Math.round((stat.y + top) * dpr); sp.B = Math.round((stat.y + bottom) * dpr);
}

function renderStats() {
  if (!stat.show) return;
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const held = phase === 'results' && att.taps > 0;
  let total = 0;
  if (show) for (let i = 0; i < view.caps.length; i++) total += counts[view.caps[i].src];
  const big = phase === 'play' ? kps : held ? att.peak : -1;
  let aux = -1;
  if (held) {
    const seconds = (att.lastTap - att.firstTap) / 1000;
    if (seconds >= 1) aux = Math.round((att.taps - 1) / seconds * 10);
  } else if (phase === 'play' && att.taps) aux = att.peak;
  const spark = !opts.spark ? 0 : held ? -2 : phase === 'play' ? att.idx * 256 + hist[att.idx > 0 ? att.idx : 0] : -3;
  if (!shown.full && big === shown.kps && total === shown.total && aux === shown.aux && spark === shown.spark && phase === shown.phase) return;
  shown.full = false; shown.kps = big; shown.total = total; shown.aux = aux; shown.spark = spark; shown.phase = phase;

  const sp = SP[held ? 1 : 0];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(stat.X0, stat.Y0, stat.X1 - stat.X0, stat.Y1 - stat.Y0);
  tile(stat.X0, stat.Y0, stat.X1, stat.Y1, C.tile, C.ruleStrong);
  ctx.setTransform(dpr, 0, 0, dpr, stat.tx, stat.ty);
  ctx.textBaseline = 'alphabetic';
  const bigInk = phase === 'play' ? (big > 0 ? C.lit : C.dim) : big < 0 ? C.muted : C.fg;
  setValue(totalShown, show ? total : -1, false);
  setValue(auxShown, aux, held);

  drawLabel(sp.label, sp.labelX, sp.labelY, 'left', C.muted);
  if (stat.style === 'line') {
    drawBig(big, sp, bigInk);
    const digits = digitCount(big > 0 ? big : 0);
    const d = digits > 2 ? digits : 2;
    if (d !== sp.stripD) {
      sp.stripD = d;
      const x = sp.xb + (d * adv.big + sp.pad);
      sp.sparkOn = opts.spark && sp.fx - x > 40;
      if (sp.sparkOn) sparkRect(sp, x, sp.sparkTop, sp.sparkRight, sp.sparkBottom);
      sp.pairsOn = sp.fx > x;
    }
    if (sp.sparkOn) drawSpark(sp, held);
    if (sp.pairsOn) drawPairs(sp);
  } else {
    if (opts.spark) drawLabel(sp.span, sp.spanX, sp.spanY, sp.spanAlign, C.muted);
    drawBig(big, sp, bigInk);
    if (opts.spark) drawSpark(sp, held);
    drawPairs(sp);
  }
}

/**
 * Formats and measures a foot value only when it changes. Integers go through toFixed(0) rather
 * than String(): String() fills V8's number-string cache, which a full GC flushes and the next
 * miss re-creates whole (64 KB).
 */
function setValue(slot, value, tenths) {
  if (value === slot.v && tenths === slot.tenths) return;
  slot.v = value; slot.tenths = tenths;
  slot.text = value < 0 ? '—' : tenths ? `${Math.floor(value / 10)}.${value % 10}` : value < 10 ? DIGITS[value] : value.toFixed(0);
  slot.w = textWidth(slot.text, F.footValue, '0px');
}

/** Mono caps label at (x, y) in tile space. */
function drawLabel(text, x, y, align, color) {
  ctx.font = F.footLabel;
  ctx.letterSpacing = '0.9px';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
}

function drawBig(value, sp, ink) {
  ctx.font = F.big;
  ctx.fillStyle = ink;
  if (value < 0) { ctx.textAlign = 'left'; ctx.fillText('—', sp.bigDashX, sp.bigY); }
  else drawDigits(splitDigits(value), sp.bigXs, sp.bigY);
}

function drawValue(text, x, y) {
  ctx.font = F.footValue;
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
}

/** TOTAL (optional) and the aux pair (peak live, average held); on one line the aux pair follows the total's width. */
function drawPairs(sp) {
  let auxX = sp.auxX, auxValueX = sp.auxValueX;
  if (opts.total) {
    drawLabel('TOTAL', sp.pairX, sp.pairY, 'left', C.muted);
    drawValue(totalShown.text, sp.totalValueX, sp.pairY);
    if (sp.chain) {
      if (sp.chainText !== totalShown.text) {
        sp.chainText = totalShown.text;
        sp.chainX = sp.totalValueX + totalShown.w + sp.gap;
        sp.chainValueX = sp.chainX + sp.auxW + 4;
      }
      auxX = sp.chainX; auxValueX = sp.chainValueX;
    }
  }
  drawLabel(sp.auxLabel, auxX, sp.auxY, 'left', C.muted);
  drawValue(auxShown.text, auxValueX, sp.auxY);
}

// History bar columns for the current device span and bar heights for the current scale (−1: not yet derived).
const BAR_X = new Int32Array(SPARK_BARS), BAR_W = new Int32Array(SPARK_BARS), BAR_V = new Int32Array(SPARK_BARS);
const BAR_H = new Int32Array(256);
const barGeo = { L: 0, R: -1, scale: 0, usable: -1, hair: 0 };

/** 40 bars in the plan's device rect; live = the last 10 s, held = the whole attempt. */
function drawSpark(sp, held) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const L = sp.L, R = sp.R, T = sp.T, B = sp.B;
  ctx.fillStyle = C.base;
  ctx.fillRect(L, B - HAIR, R - L, HAIR);
  if (view.phase === 'play' || held) {
    const last = att.idx > 0 ? att.idx : 0;
    const group = held ? Math.max(1, Math.ceil((last + 1) / SPARK_BARS)) : 1;
    const start = held ? 0 : last - SPARK_BARS + 1;
    let peak = 0, peakBar = -1;
    for (let k = 0; k < SPARK_BARS; k++) {
      const v = bucket(start, group, k, last);
      BAR_V[k] = v;
      if (v > peak) { peak = v; peakBar = k; }
    }
    const r5 = peak % 5;
    let scale = peak - r5 + (r5 ? 5 : 0); // peak rounded up to a multiple of 5, at least 10
    if (scale < 10) scale = 10;
    planBars(L, R, scale, B - HAIR - T);
    for (let k = 0; k < SPARK_BARS; k++) {
      const v = BAR_V[k];
      if (!v) continue;
      if (BAR_H[v] < 0) BAR_H[v] = Math.max(HAIR, Math.round(v / scale * barGeo.usable));
      const bh = BAR_H[v];
      const marked = held ? k === peakBar : start + k === last;
      ctx.fillStyle = marked ? C.lit : C.dim;
      ctx.globalAlpha = marked ? 1 : 0.55;
      ctx.fillRect(BAR_X[k], B - HAIR - bh, BAR_W[k], bh);
    }
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(dpr, 0, 0, dpr, stat.tx, stat.ty);
}

function planBars(L, R, scale, usable) {
  if (L !== barGeo.L || R !== barGeo.R) {
    barGeo.L = L; barGeo.R = R;
    const pitch = (R - L) / SPARK_BARS;
    for (let k = 0; k < SPARK_BARS; k++) {
      const x = L + Math.round(k * pitch);
      BAR_X[k] = x;
      BAR_W[k] = Math.max(1, L + Math.round(k * pitch + pitch * 2 / 3) - x);
    }
  }
  if (scale !== barGeo.scale || usable !== barGeo.usable || HAIR !== barGeo.hair) {
    barGeo.scale = scale; barGeo.usable = usable; barGeo.hair = HAIR;
    BAR_H.fill(-1);
  }
}

function bucket(start, group, k, last) {
  let v = 0;
  const from = start + k * group;
  for (let b = from; b < from + group; b++) if (b >= 0 && b <= last && hist[b] > v) v = hist[b];
  return v;
}

// ---------------------------------------------------------------- go
const sub = subscribe(Object.values(P), onFrame, { onStatus });

const DEFAULTS = {
  orientation: 'auto', align: 'center', kps: 'auto', showSparkline: true, showTotal: true,
  maniaColumns: 'skin', backing: 'none', accent: 'map',
};
settings(DEFAULTS, s => {
  opts.orientation = ['auto', 'horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'center';
  opts.kps = ['auto', 'beside', 'above', 'below', 'off'].includes(s.kps) ? s.kps : 'auto';
  opts.spark = !!s.showSparkline;
  opts.total = !!s.showTotal;
  opts.maniaColumns = s.maniaColumns === 'equal' ? 'equal' : 'skin';
  opts.backing = ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  opts.accent = s.accent === '18-lab' ? '18-lab' : 'map';
  hud.dataset.backing = opts.backing;
  hud.dataset.accent = opts.accent;
  loadPalette(sub.values[P.checksum]); // the accent choice applies to the map already loaded
  dirty.layout = true;
  wake();
});

measureDigits();
Promise.all(['500 12px "IBM Plex Mono"', '600 26px "Barlow Condensed"'].map(font => document.fonts.load(font))).catch(() => {}).then(() => {
  measureDigits();
  wake();
});

wake();

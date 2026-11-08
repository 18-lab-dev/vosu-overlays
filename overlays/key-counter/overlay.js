// Copyright (c) 2026 18-LAB. MIT.
// Key counter: key caps that light on press (count inside, share-of-presses bar along the bottom)
// and a KPS readout (live keys per second, 10 s history, total and peak). The page is sized and
// placed by its host (OBS, vosulay, the replay renderer); it lays itself out for the box it gets:
// a row of caps in wide boxes (mania caps take the skin's column proportions, so the row lines up
// with the stage when the page spans it), a column in tall boxes. Shown during gameplay, and on
// the results screen with the attempt's peak/average KPS and history (osu! shows neither).
// Everything that changes per tap is drawn on one canvas with per-tile dirty redraws; data
// handlers only record state and one rAF pass renders, then sleeps until something will change.
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
  const now = performance.now();
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
const caps = [];                   // drawn caps: {src, label, sub, kind, x, y, w, h, style, p, f, d*}
const stat = { show: false, x: 0, y: 0, w: 0, h: 0, style: 'wide' };
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

  view.caps.forEach((cap, i) => {
    const r = rects[i];
    if (!r) return;
    caps.push({
      src: cap.src, label: cap.label, sub: cap.sub || '', kind: cap.kind || '',
      x: r.x, y: r.y, w: r.w, h: r.h, style: r.style, p: 0, f: 0, dP: -1, dF: -1, dN: -2, dM: -1, dTop: false,
    });
  });
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
  for (const cap of caps) cap.dP = -1;
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

/** Draws a non-negative integer at fixed digit advance (canvas has no tabular-nums); align 0 left, 0.5 centre, 1 right. */
function drawInt(value, x, y, align, step) {
  let n = Math.max(0, Math.round(value)), digits = 1, div = 1;
  while (n >= div * 10) { div *= 10; digits++; }
  let left = x - digits * step * align + step / 2;
  ctx.textAlign = 'center';
  for (let i = 0; i < digits; i++) {
    ctx.fillText(DIGITS[Math.floor(n / div) % 10], left, y);
    left += step; div /= 10;
  }
}
const digitCount = v => (v < 10 ? 1 : Math.floor(Math.log10(v)) + 1);

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
    if (ringLen) next = Math.min(next, tapRing[ringHead] + 1001);
    for (let i = 0; i < att.n; i++) if (litUntil[i] > now && litUntil[i] < next) next = litUntil[i];
    if (att.seeded && now - att.lastTap < SPARK_SPAN + BUCKET_MS && att.idx + 1 < HISTORY) next = Math.min(next, att.t0 + (att.idx + 1) * BUCKET_MS);
  }
  if (next === now) raf = requestAnimationFrame(frame);
  else if (next !== Infinity) timer = setTimeout(wake, Math.max(0, next - performance.now()));
  else lastFrame = 0;
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
  let max = 0;
  if (show) for (const cap of caps) if (counts[cap.src] > max) max = counts[cap.src];
  let animating = false;
  for (const cap of caps) {
    const on = live && (pressed[cap.src] === 1 || litUntil[cap.src] > now);
    if (on) { cap.f = 1; cap.p = Math.min(1, cap.p + dt / PRESS_MS); }
    else { cap.f = Math.max(0, cap.f - dt / RELEASE_MS); cap.p = Math.max(0, cap.p - dt / RELEASE_MS); }
    if ((on && cap.p < 1) || (!on && (cap.p > 0 || cap.f > 0))) animating = true;
    const c = show ? counts[cap.src] : -1;
    const m = c > 0 && max > 0 ? Math.round(c / max * (cap.w - 2) * dpr) : 0;
    const top = c > 0 && c === max && caps.length > 1;
    if (cap.p === cap.dP && cap.f === cap.dF && c === cap.dN && m === cap.dM && top === cap.dTop) continue;
    cap.dP = cap.p; cap.dF = cap.f; cap.dN = c; cap.dM = m; cap.dTop = top;
    drawCap(cap, c, m, top);
  }
  return animating;
}

/** Rounded tile in device px with a hairline border (≥ 1 device px). */
function tile(x0, y0, x1, y1, fill, border) {
  const hair = Math.max(1, Math.round(dpr)), r = 2 * dpr;
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r); ctx.fill();
  ctx.fillStyle = border;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, r);
  ctx.roundRect(x0 + hair, y0 + hair, x1 - x0 - 2 * hair, y1 - y0 - 2 * hair, Math.max(0, r - hair));
  ctx.fill('evenodd');
}

function drawCap(cap, c, meterPx, top) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  const X0 = Math.floor(cap.x * dpr), X1 = Math.ceil((cap.x + cap.w) * dpr);
  const Y0 = Math.floor(cap.y * dpr), Y1 = Math.ceil((cap.y + cap.h) * dpr);
  ctx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);

  // The cap travels 1 px down and shrinks to 94 % while pressed; the fill is instant on, eased off.
  const press = ease(cap.p);
  const scale = 1 - 0.06 * press;
  const cx = cap.x + cap.w / 2, cy = cap.y + cap.h / 2 + press;
  const hw = cap.w * scale / 2, hh = cap.h * scale / 2;
  const x0 = Math.round((cx - hw) * dpr), x1 = Math.round((cx + hw) * dpr);
  const y0 = Math.round((cy - hh) * dpr), y1 = Math.round((cy + hh) * dpr);
  const lit = cap.f > 0 ? ease(cap.f) : 0;
  const litFill = cap.kind === 'kat' ? C.kat : cap.kind === 'don' ? C.amber : C.lit;
  const litInk = cap.kind ? C.onAmber : C.onLit;
  tile(x0, y0, x1, y1, C.tile, C.ruleStrong);
  if (lit > 0) {
    ctx.globalAlpha = lit;
    ctx.fillStyle = litFill;
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 2 * dpr); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Taiko keys keep a hairline of their drum colour so kat/don read without pressing.
  if (cap.kind && lit < 1) {
    ctx.fillStyle = cap.kind === 'kat' ? C.kat : C.amber;
    ctx.fillRect(x0 + Math.round(dpr), y0 + Math.round(dpr), x1 - x0 - 2 * Math.round(dpr), Math.max(1, Math.round(2 * dpr)));
  }
  const ink = lit >= 0.5 ? litInk : null;

  // Text, scaled with the cap about its centre.
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, cx * dpr, cy * dpr);
  ctx.textBaseline = 'alphabetic';
  ctx.font = F.label;
  ctx.letterSpacing = '0.5px';
  const pad = Math.max(4, Math.min(cap.w, cap.h) * 0.11);
  const labelW = ctx.measureText(cap.label).width;
  const subW = cap.sub ? ctx.measureText(cap.sub).width : 0;
  ctx.fillStyle = ink || C.dim;
  if (cap.style === 'row') {
    // Key row (vertical layout): label (and role) on the outer side, count on the inner side.
    const mirror = opts.align === 'right';
    const ly = F.labelPx * 0.36;
    ctx.textAlign = mirror ? 'right' : 'left';
    const lx = mirror ? cap.w / 2 - pad : -cap.w / 2 + pad;
    ctx.fillText(cap.label, lx, ly);
    if (cap.sub && labelW + subW + 8 + pad * 2 + adv.count * 2 < cap.w) {
      ctx.fillStyle = ink || C.muted;
      ctx.fillText(cap.sub, mirror ? lx - labelW - 8 : lx + labelW + 8, ly);
    }
    ctx.letterSpacing = '0px';
    ctx.font = F.count;
    ctx.fillStyle = ink || (c < 0 ? C.muted : C.fg);
    const base = F.countPx * 0.35;
    const cxText = mirror ? -cap.w / 2 + pad : cap.w / 2 - pad;
    if (c < 0) { ctx.textAlign = mirror ? 'left' : 'right'; ctx.fillText('—', cxText, base); }
    else drawInt(c, cxText, base, mirror ? 0 : 1, adv.count);
  } else {
    // Column cap: label row at the top (role on the right when it fits), count below.
    const ly = -cap.h / 2 + pad + F.labelPx * 0.75;
    const subFits = cap.sub && labelW + 8 + subW <= cap.w - pad * 2;
    ctx.textAlign = subFits ? 'left' : 'center';
    ctx.fillText(cap.label, subFits ? -cap.w / 2 + pad : 0, ly);
    if (subFits) {
      ctx.textAlign = 'right';
      ctx.fillStyle = ink || C.muted;
      ctx.fillText(cap.sub, cap.w / 2 - pad, ly);
    }
    ctx.letterSpacing = '0px';
    ctx.font = F.count;
    ctx.fillStyle = ink || (c < 0 ? C.muted : C.fg);
    const base = cap.h / 2 - pad - Math.max(2, cap.h * 0.05);
    if (c < 0) { ctx.textAlign = 'center'; ctx.fillText('—', 0, base); }
    else {
      // Long counts in narrow caps are condensed horizontally rather than clipped.
      const squeeze = Math.min(1, (cap.w - pad * 2) / (digitCount(c) * adv.count));
      if (squeeze < 1) ctx.transform(squeeze, 0, 0, 1, 0, 0);
      drawInt(c, 0, base, 0.5, adv.count);
    }
  }

  // Share-of-presses bar along the bottom edge (skipped for a lone key: stable catch dash).
  if (caps.length > 1) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const hair = Math.max(1, Math.round(dpr));
    const bx = x0 + hair, bw = x1 - x0 - 2 * hair;
    const bh = Math.max(2, Math.round(Math.min(3, cap.h * 0.045) * dpr * scale));
    const by = y1 - hair - bh;
    ctx.fillStyle = ink ? 'rgb(0 0 0 / 0.18)' : C.track;
    ctx.fillRect(bx, by, bw, bh);
    if (meterPx > 0) {
      ctx.fillStyle = ink || (top ? C.fg : C.dim);
      ctx.globalAlpha = ink ? 0.55 : top ? 0.9 : 0.6;
      ctx.fillRect(bx, by, Math.min(bw, Math.round(meterPx * scale)), bh);
      ctx.globalAlpha = 1;
    }
  }
}

// Last drawn stats; the tile repaints only when one of its values changes.
const shown = { kps: NaN, total: NaN, aux: NaN, spark: -1, phase: '', full: true };

function renderStats() {
  if (!stat.show) return;
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const held = phase === 'results' && att.taps > 0;
  let total = 0;
  if (show) for (const cap of view.caps) total += counts[cap.src];
  const big = phase === 'play' ? kps : held ? att.peak : -1;
  const seconds = (att.lastTap - att.firstTap) / 1000;
  const aux = held ? (seconds >= 1 ? Math.round((att.taps - 1) / seconds * 10) : -1) : phase === 'play' && att.taps ? att.peak : -1;
  const spark = !opts.spark ? 0 : held ? -2 : phase === 'play' ? att.idx * 256 + hist[Math.max(0, att.idx)] : -3;
  if (!shown.full && big === shown.kps && total === shown.total && aux === shown.aux && spark === shown.spark && phase === shown.phase) return;
  shown.full = false; shown.kps = big; shown.total = total; shown.aux = aux; shown.spark = spark; shown.phase = phase;

  const { x: sx, y: sy, w: sw, h: sh } = stat;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  const X0 = Math.floor(sx * dpr), Y0 = Math.floor(sy * dpr);
  const X1 = Math.ceil((sx + sw) * dpr), Y1 = Math.ceil((sy + sh) * dpr);
  ctx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);
  tile(X0, Y0, X1, Y1, C.tile, C.ruleStrong);
  ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
  ctx.textBaseline = 'alphabetic';
  const label = held ? 'PEAK' : 'KPS';
  const span = held ? 'ATTEMPT' : '10 S';
  const bigInk = phase === 'play' ? (big > 0 ? C.lit : C.dim) : big < 0 ? C.muted : C.fg;
  const auxLabel = held ? 'AVG' : 'PEAK';
  const totalValue = show ? total : -1;

  if (stat.style === 'wide') {
    // Left: label over the big number. Right: window label, history bars, total / peak line.
    const s = sh / 72, pad = 10 * s;
    drawLabel(label, pad, 20 * s, 'left', C.muted);
    const right0 = 84 * s;
    if (opts.spark) drawLabel(span, right0, 20 * s, 'left', C.muted);
    drawBig(big, pad - 1, 60 * s, bigInk);
    if (opts.spark) drawSpark(right0, 27 * s, sw - pad, 48 * s, held);
    let x = right0;
    const fy = opts.spark ? 63 * s : 50 * s;
    if (opts.total) x = drawPair(x, fy, 'TOTAL', totalValue, false) + 12 * s;
    drawPair(x, fy, auxLabel, aux, held);
  } else if (stat.style === 'tall') {
    // Vertical column: label row, big number, history bars, then total and peak on their own lines.
    const u = sw, pad = Math.max(6, u * 0.08);
    drawLabel(label, pad, pad + F.labelPx * 0.8, 'left', C.muted);
    if (opts.spark) drawLabel(span, sw - pad, pad + F.labelPx * 0.8, 'right', C.muted);
    drawBig(big, pad - 1, sh * 0.48, bigInk);
    if (opts.spark) drawSpark(pad, sh * 0.54, sw - pad, sh * 0.7, held);
    if (opts.total) drawPair(pad, sh * 0.83, 'TOTAL', totalValue, false);
    drawPair(pad, sh * (opts.total ? 0.95 : 0.88), auxLabel, aux, held);
  } else {
    // Strip: KPS label, number, history bars filling the middle, total / peak at the end.
    const pad = Math.max(6, sh * 0.25);
    const base = sh / 2 + F.bigPx * 0.33;
    let x = pad;
    x = drawLabel(label, x, sh / 2 + F.labelPx * 0.36, 'left', C.muted) + pad * 0.6;
    drawBig(big, x - 1, base, bigInk);
    x += Math.max(2, digitCount(Math.max(0, big))) * adv.big + pad;
    // Measure the foot from its right end; the bars take what is left.
    ctx.font = F.footValue;
    const valueW = ctx.measureText('0000').width;
    ctx.font = F.footLabel;
    const pairW = l => ctx.measureText(l).width + 4 + valueW;
    const footW = (opts.total ? pairW('TOTAL') + 12 : 0) + pairW(auxLabel);
    let fx = sw - pad - footW;
    if (opts.spark && fx - x > 40) drawSpark(x, sh * 0.2, fx - pad, sh * 0.8, held);
    const fy = sh / 2 + F.labelPx * 0.36;
    if (fx > x) {
      if (opts.total) fx = drawPair(fx, fy, 'TOTAL', totalValue, false) + 12;
      drawPair(fx, fy, auxLabel, aux, held);
    }
  }
}

/** Mono caps label at (x, y) in tile space; returns its right edge. */
function drawLabel(text, x, y, align, color) {
  ctx.font = F.footLabel;
  ctx.letterSpacing = '0.9px';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.letterSpacing = '0px';
  return align === 'left' ? x + w : x;
}

function drawBig(value, x, y, ink) {
  ctx.font = F.big;
  ctx.fillStyle = ink;
  if (value < 0) { ctx.textAlign = 'left'; ctx.fillText('—', x + 1, y); }
  else drawInt(value, x, y, 0, adv.big);
}

function drawPair(x, y, label, value, tenths) {
  x = drawLabel(label, x, y, 'left', C.muted) + 4;
  ctx.font = F.footValue;
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'left';
  const text = value < 0 ? '—' : tenths ? `${Math.floor(value / 10)}.${value % 10}` : DIGITS[value] || String(value);
  ctx.fillText(text, x, y);
  return x + ctx.measureText(text).width;
}

/** 40 bars in tile space x0..x1, top..bottom; live = the last 10 s, held = the whole attempt. */
function drawSpark(x0, top, x1, bottom, held) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const L = Math.round((stat.x + x0) * dpr), R = Math.round((stat.x + x1) * dpr);
  const T = Math.round((stat.y + top) * dpr), B = Math.round((stat.y + bottom) * dpr);
  const hair = Math.max(1, Math.round(dpr));
  ctx.fillStyle = C.base;
  ctx.fillRect(L, B - hair, R - L, hair);
  if (view.phase === 'play' || held) {
    const last = Math.max(0, att.idx);
    const group = held ? Math.max(1, Math.ceil((last + 1) / SPARK_BARS)) : 1;
    const start = held ? 0 : last - SPARK_BARS + 1;
    let peak = 0, peakBar = -1;
    for (let k = 0; k < SPARK_BARS; k++) {
      const v = bucket(start, group, k, last);
      if (v > peak) { peak = v; peakBar = k; }
    }
    const scale = Math.max(10, Math.ceil(peak / 5) * 5);
    const pitch = (R - L) / SPARK_BARS;
    const usable = B - hair - T;
    for (let k = 0; k < SPARK_BARS; k++) {
      const v = bucket(start, group, k, last);
      if (!v) continue;
      const x = L + Math.round(k * pitch);
      const bw = Math.max(1, L + Math.round(k * pitch + pitch * 2 / 3) - x);
      const bh = Math.max(hair, Math.round(v / scale * usable));
      const marked = held ? k === peakBar : start + k === last;
      ctx.fillStyle = marked ? C.lit : C.dim;
      ctx.globalAlpha = marked ? 1 : 0.55;
      ctx.fillRect(x, B - hair - bh, bw, bh);
    }
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(dpr, 0, 0, dpr, stat.x * dpr, stat.y * dpr);
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

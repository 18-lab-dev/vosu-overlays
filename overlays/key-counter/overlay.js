// Copyright (c) 2026 18-LAB. MIT.
// Key counter overlay: floating key caps (count inside, share-of-presses bar along the bottom)
// and one KPS tile (live keys per second, 10 s history, total and peak), placed in the empty
// regions osu! leaves around the playfield (osuLayout). Shown during gameplay, and on the
// results screen with the attempt's peak/average KPS and history (osu! shows neither); hidden in
// song select and menus. Everything that changes per tap is drawn on one canvas with per-tile
// dirty redraws; data handlers only record state and one rAF pass renders, then sleeps.
import { subscribe, settings, fit, activeMode, isPlaying, osuLayout, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

const RESULTS = 7;
const BUCKET_MS = 250;          // history resolution
const SPARK_BARS = 40;          // 40 × 250 ms = 10 s
const SPARK_SPAN = SPARK_BARS * BUCKET_MS;
const HISTORY = 14400;          // one hour of buckets for the results overview
const RING = 1024;              // taps inside the trailing second (power of two)
const MAX_KEYS = 32;
const FLASH_MS = 90;            // a tap that began and ended between two frames still lights
const PRESS_MS = 50, RELEASE_MS = 180;

// Cluster geometry in layout px (multiplied by the scale setting).
const GAP = 6;                  // between caps
const GROUP_GAP = 8;            // between the caps and the KPS tile
const STAT_W = 268, STAT_H = 72;
const MARGIN = 48;              // from screen edges
const MANIA_CLEAR = 112;        // right of a stable mania stage: room for its HP bar

const P = {
  state: '/state/number', playMode: '/play/mode/number', menuMode: '/settings/mode/number',
  client: '/client', all: '/keys/all', k1: '/keys/k1', k2: '/keys/k2', m1: '/keys/m1', m2: '/keys/m2',
  bindOsu: '/settings/keybinds/osu', bindTaiko: '/settings/keybinds/taiko', bindFruits: '/settings/keybinds/fruits',
  cs: '/beatmap/stats/cs/converted', checksum: '/beatmap/checksum', skin: '/settings/skin/name',
};

const $ = id => document.getElementById(id);
const root = document.documentElement;
const hud = $('hud'), cluster = $('cluster'), backing = $('backing'), chip = $('chip'), chipText = $('chip-text');
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
const F = {
  label: '500 12px "IBM Plex Mono"', count: '600 26px "Barlow Condensed"', big: '600 32px "Barlow Condensed"',
  footValue: '500 13px "IBM Plex Mono"',
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
  // Results use their own zone (the header strip), so leaving or entering them re-places the cluster.
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

// ---------------------------------------------------------------- placement
const opts = {
  zone: 'auto', x: 0, y: 0, scale: 1, orientation: 'horizontal', cap: 72, spark: true, total: true,
  backing: 'none', accent: 'map', brand: true, columnStart: 0, columnWidth: 0, matchColumns: false,
};
const geo = { k: 1, w: 0, h: 0, stat: { x: 0, y: 0 } };
const caps = [];   // drawn caps: {src, label, sub, kind, x, y, w, h, p, f, d*}
let pxr = 1;       // device px per layout px (devicePixelRatio × scale)
let dpr = devicePixelRatio || 1;

/**
 * Resolves the zone into a target box and how the cluster sits in it:
 * {x, y, w, h, alignX: 0 start | 0.5 centre | 1 end, anchorY: 'top' | 'bottom' | 'centre', at: y px, stackAbove}.
 */
function resolveZone(mode, keys) {
  // Results: osu! fills the screen with its ranking panel; the right part of the top header strip is free.
  if (view.phase === 'results') return { x: 1000, y: 8, w: 900, h: 122, alignX: 1, anchorY: 'centre', at: 69 };
  const m = mode || 'osu';
  const stage = maniaStage(keys || 4);
  const layout = osuLayout(m, { keys: keys || 4, ...stage, client: view.client });
  const { busy, hud: h, width: W, height: H, unit } = layout;
  const zone = opts.zone === 'auto' ? (m === 'taiko' ? 'bottom' : 'right') : opts.zone;
  const low = Math.round(H * 0.86);   // side bands: cluster bottom, clear of lazer's bottom-right key counter
  if (m === 'taiko') {
    if (zone === 'top') {
      const x0 = h.health.x + h.health.w + MARGIN, x1 = h.score.x - MARGIN;
      return { x: x0, y: 0, w: x1 - x0, h: busy.y, alignX: 0.5, anchorY: 'centre', at: busy.y / 2 };
    }
    const top = busy.y + busy.h + 40;
    return { x: MARGIN, y: top, w: W - 2 * MARGIN, h: H - top - MARGIN, alignX: zone === 'right' ? 1 : zone === 'left' || zone === 'bottom' ? 0 : 0.5, anchorY: 'top', at: top };
  }
  if (m === 'mania') {
    // Caps row ends just above the hit line (skin HitPosition), level with the receptors.
    const receptors = Math.min(H - MARGIN, Math.round(stage.hitPosition * unit) - 24) - opts.cap / 2;
    if (zone === 'left') {
      const x1 = busy.x - MARGIN;
      return { x: MARGIN, y: 0, w: x1 - MARGIN, h: H, alignX: 1, anchorY: 'capsCentre', at: receptors };
    }
    const x0 = busy.x + busy.w + (view.client === 'lazer' ? MARGIN : Math.round(MANIA_CLEAR * unit / 2.25));
    return { x: x0, y: 0, w: W - MARGIN - x0, h: H, alignX: 0, anchorY: 'capsCentre', at: receptors };
  }
  // osu! / catch: the side bands left and right of the 4:3 playfield, or the strip under it.
  if (zone === 'bottom') {
    const top = busy.y + busy.h + 4;
    return { x: busy.x, y: top, w: busy.w, h: H - top, alignX: 0.5, anchorY: 'centre', at: top + (H - top) / 2 };
  }
  if (zone === 'left') {
    const x1 = busy.x - MARGIN;
    return { x: MARGIN, y: 0, w: x1 - MARGIN, h: H, alignX: 0, anchorY: 'bottom', at: low };
  }
  const x0 = busy.x + busy.w + MARGIN;
  return { x: x0, y: 0, w: W - MARGIN - x0, h: H, alignX: 1, anchorY: 'bottom', at: low };
}

/** Mania stage geometry: the skin's [Mania] section, with the column settings as overrides (0 = skin). */
function maniaStage(keys) {
  const skin = skinGeo.keys === keys ? skinGeo.value : null;
  return {
    columnStart: opts.columnStart || skin?.columnStart || 136,
    columnWidth: opts.columnWidth || skin?.columnWidth || 30,
    columnSpacing: opts.columnWidth ? 0 : skin?.columnSpacing || 0,
    hitPosition: skin?.hitPosition || 402,
  };
}

// Current skin's mania section, re-read on key-count or skin change (off the hot path).
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

function buildLayout() {
  const n = view.caps.length;
  const mode = view.mode;
  const zone = resolveZone(mode, view.columns);
  const unit = 1080 / 480;
  let capW = opts.cap, capH = opts.cap, gap = GAP;
  if (mode === 'mania' && opts.matchColumns) {
    // One cap per stage column at the stage's own average pitch.
    const cols = osuLayout('mania', { keys: n || 1, ...maniaStage(n || 1) }).columns || [];
    const pitch = cols.length ? (cols.at(-1).x + cols.at(-1).w - cols[0].x) / cols.length : 30 * unit;
    gap = Math.max(2, Math.round(pitch * 0.08));
    capW = Math.round(pitch - gap);
  }
  const vertical = opts.orientation === 'vertical';
  const avail = zone.w / opts.scale;
  // Side by side when the zone is wide enough, otherwise the KPS tile stacks above the caps.
  let capsW = n ? (vertical ? capW : n * capW + (n - 1) * gap) : 0;
  const side = !vertical && capsW + GROUP_GAP + STAT_W <= avail;
  // A stacked row still too wide (many mania keys beside a wide stage) narrows its caps before
  // the whole cluster is scaled, so labels stay legible.
  if (!vertical && !side && capsW > avail && n > 1) {
    capW = Math.max(52, Math.floor((avail - (n - 1) * gap) / n));
    capsW = n * capW + (n - 1) * gap;
  }
  const capsH = n ? (vertical ? n * capH + (n - 1) * gap : capH) : 0;
  let W, H;
  if (vertical) { W = Math.max(capsW, STAT_W); H = capsH + GROUP_GAP + STAT_H; }
  else if (side) { W = capsW + GROUP_GAP + STAT_W; H = Math.max(capsH, STAT_H); }
  else { W = Math.max(capsW, STAT_W); H = capsH + GROUP_GAP + STAT_H; }
  // Never upscale past the setting; shrink to fit the zone (many-key mania, narrow bands).
  const k = Math.max(0.3, Math.min(opts.scale, zone.w / W, zone.h / H));

  // Positions inside the cluster (layout px, unscaled).
  const align = zone.alignX;
  const capsX = vertical ? (align === 1 ? W - capsW : align === 0.5 ? (W - capsW) / 2 : 0) : side ? 0 : (W - capsW) * align;
  const capsY = vertical ? 0 : side ? H - capsH : STAT_H + GROUP_GAP;
  geo.stat.x = vertical ? (W - STAT_W) * align : side ? capsW + GROUP_GAP : (W - STAT_W) * align;
  geo.stat.y = vertical ? capsH + GROUP_GAP : side ? H - STAT_H : 0;
  caps.length = 0;
  view.caps.forEach((cap, i) => caps.push({
    src: cap.src, label: cap.label, sub: cap.sub || '', kind: cap.kind || '',
    x: capsX + (vertical ? 0 : i * (capW + gap)), y: capsY + (vertical ? i * (capH + gap) : 0), w: capW, h: capH,
    p: 0, f: 0, dP: -1, dF: -1, dN: -2, dM: -1, dTop: false,
  }));

  // Place the scaled cluster in the zone.
  const sw = W * k, sh = H * k;
  let x = zone.x + (zone.w - sw) * zone.alignX;
  let y;
  if (zone.anchorY === 'top') y = zone.at;
  else if (zone.anchorY === 'bottom') y = zone.at - sh;
  else if (zone.anchorY === 'capsCentre') y = zone.at - (capsY + capsH / 2) * k;
  else y = zone.at - sh / 2;
  y = Math.max(0, Math.min(1080 - sh, y));
  x += opts.x; y += opts.y;
  geo.k = k; geo.w = W; geo.h = H;
  cluster.style.left = `${Math.round(x)}px`;
  cluster.style.top = `${Math.round(y)}px`;
  canvas.style.width = `${Math.round(sw)}px`;
  canvas.style.height = `${Math.round(sh)}px`;
  // Chip / note sit at the cluster's anchor corner, on the same side.
  chip.style.left = `${Math.round(zone.alignX === 1 ? x + sw : zone.alignX === 0.5 ? x + sw / 2 : x)}px`;
  chip.style.top = `${Math.round(zone.anchorY === 'top' ? y : y + sh)}px`;
  chip.dataset.align = zone.alignX === 1 ? 'end' : zone.alignX === 0.5 ? 'centre' : 'start';
  chip.dataset.anchor = zone.anchorY === 'top' ? 'top' : 'bottom';
  pxr = dpr * k;
  dirty.layout = false;
  forceRedraw();
}

function forceRedraw() {
  for (const cap of caps) cap.dP = -1;
  shown.full = true;
  dirty.stats = true;
}

// Fixed advance per digit so changing numbers never shift (canvas has no tabular-nums).
const adv = { count: 13, big: 16 };
function measureDigits() {
  for (const [key, font] of [['count', F.count], ['big', F.big]]) {
    ctx.font = font;
    let w = 0;
    for (const d of DIGITS) w = Math.max(w, ctx.measureText(d).width);
    adv[key] = w;
  }
}

/** Draws a non-negative integer at fixed digit advance; align 0 left, 0.5 centre, 1 right. */
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

// Backing store follows the CSS size × devicePixelRatio, measured by the observer (never in rAF).
new ResizeObserver(([entry]) => {
  const box = entry.devicePixelContentBoxSize?.[0];
  const w = box ? box.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio);
  const h = box ? box.blockSize : Math.round(entry.contentRect.height * devicePixelRatio);
  if (!w || !h) return;
  if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  dpr = w / entry.contentRect.width / geo.k;
  pxr = w / geo.w;
  forceRedraw();
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
    : phase === 'absent' ? 'Waiting for osu!' : phase === 'nokeys' ? 'Key counter needs vosu · ENABLE_KEY_OVERLAY' : '';
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
    const m = c > 0 && max > 0 ? Math.round(c / max * (cap.w - 2) * pxr) : 0;
    const top = c > 0 && c === max && caps.length > 1;
    if (cap.p === cap.dP && cap.f === cap.dF && c === cap.dN && m === cap.dM && top === cap.dTop) continue;
    cap.dP = cap.p; cap.dF = cap.f; cap.dN = c; cap.dM = m; cap.dTop = top;
    drawCap(cap, c, m, top);
  }
  return animating;
}

/** Rounded tile in device px; returns nothing. Fill and 1-device-px-or-more border. */
function tile(x0, y0, x1, y1, fill, border) {
  const hair = Math.max(1, Math.round(dpr)), r = 2 * pxr;
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
  const X0 = Math.floor(cap.x * pxr), X1 = Math.ceil((cap.x + cap.w) * pxr);
  const Y0 = Math.floor(cap.y * pxr), Y1 = Math.ceil((cap.y + cap.h) * pxr);
  ctx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);

  // The cap travels 1 px down and shrinks to 94 % while pressed; the fill is instant on, eased off.
  const press = ease(cap.p);
  const scale = 1 - 0.06 * press;
  const cx = cap.x + cap.w / 2, cy = cap.y + cap.h / 2 + press;
  const hw = cap.w * scale / 2, hh = cap.h * scale / 2;
  const x0 = Math.round((cx - hw) * pxr), x1 = Math.round((cx + hw) * pxr);
  const y0 = Math.round((cy - hh) * pxr), y1 = Math.round((cy + hh) * pxr);
  const lit = cap.f > 0 ? ease(cap.f) : 0;
  const litFill = cap.kind === 'kat' ? C.kat : cap.kind === 'don' ? C.amber : C.lit;
  const litInk = cap.kind ? C.onAmber : C.onLit;
  tile(x0, y0, x1, y1, C.tile, C.ruleStrong);
  if (lit > 0) {
    ctx.globalAlpha = lit;
    ctx.fillStyle = litFill;
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 2 * pxr); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Taiko keys keep a hairline of their drum colour so kat/don read without pressing.
  if (cap.kind && lit < 1) {
    ctx.fillStyle = cap.kind === 'kat' ? C.kat : C.amber;
    ctx.fillRect(x0 + Math.round(pxr), y0 + Math.round(pxr), x1 - x0 - 2 * Math.round(pxr), Math.max(1, Math.round(2 * pxr)));
  }
  const ink = lit >= 0.5 ? litInk : null;

  // Label row (key, and its role on the right when it fits), then the count.
  ctx.setTransform(pxr * scale, 0, 0, pxr * scale, cx * pxr, cy * pxr);
  const lx = -cap.w / 2 + 8, rx = cap.w / 2 - 8, ly = -cap.h / 2 + 19;
  ctx.font = F.label;
  ctx.letterSpacing = '0.5px';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink || C.dim;
  const labelW = ctx.measureText(cap.label).width;
  const subFits = cap.sub && labelW + 8 + ctx.measureText(cap.sub).width <= cap.w - 16;
  ctx.textAlign = subFits ? 'left' : 'center';
  ctx.fillText(cap.label, subFits ? lx : 0, ly);
  if (subFits) {
    ctx.textAlign = 'right';
    ctx.fillStyle = ink || C.muted;
    ctx.fillText(cap.sub, rx, ly);
  }
  ctx.letterSpacing = '0px';
  ctx.font = F.count;
  ctx.fillStyle = ink || (c < 0 ? C.muted : C.fg);
  const base = cap.h / 2 - 11;
  if (c < 0) { ctx.textAlign = 'center'; ctx.fillText('—', 0, base); }
  else {
    // Long counts in narrow caps are condensed horizontally rather than clipped.
    const digits = c < 10 ? 1 : Math.floor(Math.log10(c)) + 1;
    const squeeze = Math.min(1, (cap.w - 10) / (digits * adv.count));
    if (squeeze < 1) ctx.transform(squeeze, 0, 0, 1, 0, 0);
    drawInt(c, 0, base, 0.5, adv.count);
  }

  // Share-of-presses bar along the bottom edge (skipped for a lone key: stable catch dash).
  if (caps.length > 1) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const hair = Math.max(1, Math.round(dpr));
    const bx = x0 + hair, bw = x1 - x0 - 2 * hair;
    const bh = Math.max(2, Math.round(3 * pxr * scale));
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
  const phase = view.phase;
  const show = att.valid && (phase === 'play' || phase === 'results');
  const held = phase === 'results' && att.taps > 0;
  let total = 0;
  if (show) for (const cap of caps) total += counts[cap.src];
  const big = phase === 'play' ? kps : held ? att.peak : -1;
  const seconds = (att.lastTap - att.firstTap) / 1000;
  const aux = held ? (seconds >= 1 ? Math.round((att.taps - 1) / seconds * 10) : -1) : phase === 'play' && att.taps ? att.peak : -1;
  const spark = !opts.spark ? 0 : held ? -2 : phase === 'play' ? att.idx * 256 + hist[Math.max(0, att.idx)] : -3;
  if (!shown.full && big === shown.kps && total === shown.total && aux === shown.aux && spark === shown.spark && phase === shown.phase) return;
  shown.full = false; shown.kps = big; shown.total = total; shown.aux = aux; shown.spark = spark; shown.phase = phase;

  const sx = geo.stat.x, sy = geo.stat.y;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  const X0 = Math.floor(sx * pxr), Y0 = Math.floor(sy * pxr);
  const X1 = Math.ceil((sx + STAT_W) * pxr), Y1 = Math.ceil((sy + STAT_H) * pxr);
  ctx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);
  tile(X0, Y0, X1, Y1, C.tile, C.ruleStrong);

  ctx.setTransform(pxr, 0, 0, pxr, sx * pxr, sy * pxr);
  ctx.textBaseline = 'alphabetic';
  // Left column: label and the big number.
  ctx.font = F.label;
  ctx.letterSpacing = '0.96px';
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText(held ? 'PEAK' : 'KPS', 10, 20);
  const right0 = 84;
  if (opts.spark) ctx.fillText(held ? 'ATTEMPT' : '10 S', right0, 20);
  if (opts.brand) { ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText('18—LAB', STAT_W - 10, 20); }
  ctx.letterSpacing = '0px';
  ctx.font = F.big;
  ctx.fillStyle = phase === 'play' ? (big > 0 ? C.lit : C.dim) : big < 0 ? C.muted : C.fg;
  if (big < 0) { ctx.textAlign = 'left'; ctx.font = F.count; ctx.fillText('—', 10, 58); }
  else drawInt(big, 9, 60, 0, adv.big);

  // Right column: history bars above the total / peak (or average) line.
  if (opts.spark) drawSpark(right0, 27, STAT_W - 10, 48, held);
  ctx.setTransform(pxr, 0, 0, pxr, sx * pxr, sy * pxr);
  let x = right0;
  const fy = opts.spark ? 63 : 50;
  if (opts.total) x = drawPair(x, fy, 'TOTAL', show ? total : -1, false) + 12;
  drawPair(x, fy, held ? 'AVG' : 'PEAK', aux, held);
}

function drawPair(x, y, label, value, tenths) {
  ctx.textAlign = 'left';
  ctx.font = F.label;
  ctx.letterSpacing = '0.96px';
  ctx.fillStyle = C.muted;
  ctx.fillText(label, x, y);
  x += ctx.measureText(label).width + 4;
  ctx.letterSpacing = '0px';
  ctx.font = F.footValue;
  ctx.fillStyle = C.dim;
  const text = value < 0 ? '—' : tenths ? `${Math.floor(value / 10)}.${value % 10}` : DIGITS[value] || String(value);
  ctx.fillText(text, x, y);
  return x + ctx.measureText(text).width;
}

/** 40 bars between local x0..x1 (layout px inside the tile), top..bottom; live = last 10 s, held = whole attempt. */
function drawSpark(x0, top, x1, bottom, held) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const ox = geo.stat.x, oy = geo.stat.y;
  const L = Math.round((ox + x0) * pxr), R = Math.round((ox + x1) * pxr);
  const T = Math.round((oy + top) * pxr), B = Math.round((oy + bottom) * pxr);
  const hair = Math.max(1, Math.round(dpr));
  ctx.fillStyle = C.base;
  ctx.fillRect(L, B - hair, R - L, hair);
  if (view.phase !== 'play' && !held) return;
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

function bucket(start, group, k, last) {
  let v = 0;
  const from = start + k * group;
  for (let b = from; b < from + group; b++) if (b >= 0 && b <= last && hist[b] > v) v = hist[b];
  return v;
}

// ---------------------------------------------------------------- go
fit($('stage'), 1920, 1080);
const sub = subscribe(Object.values(P), onFrame, { onStatus });

const DEFAULTS = {
  zone: 'auto', x: 0, y: 0, scale: 1, orientation: 'horizontal', capSize: 72, showSparkline: true, showTotal: true,
  backing: 'none', accent: 'map', showBrand: true, columnStart: 0, columnWidth: 0, matchColumns: false,
};
settings(DEFAULTS, s => {
  opts.zone = ['auto', 'left', 'right', 'top', 'bottom'].includes(s.zone) ? s.zone : 'auto';
  opts.x = Math.max(-1920, Math.min(1920, s.x));
  opts.y = Math.max(-1080, Math.min(1080, s.y));
  opts.scale = Math.max(0.5, Math.min(2, s.scale));
  opts.orientation = s.orientation === 'vertical' ? 'vertical' : 'horizontal';
  opts.cap = Math.round(Math.min(96, Math.max(48, s.capSize)));
  opts.spark = !!s.showSparkline;
  opts.total = !!s.showTotal;
  opts.backing = ['none', 'scrim', 'panel'].includes(s.backing) ? s.backing : 'none';
  opts.accent = s.accent === '18-lab' ? '18-lab' : 'map';
  opts.brand = !!s.showBrand;
  // 0 (or empty) = take the stage from the current skin's skin.ini.
  opts.columnStart = s.columnStart > 0 ? Math.min(600, s.columnStart) : 0;
  opts.columnWidth = s.columnWidth > 0 ? Math.max(10, Math.min(200, s.columnWidth)) : 0;
  opts.matchColumns = !!s.matchColumns;
  hud.dataset.backing = opts.backing;
  hud.dataset.accent = opts.accent;
  loadPalette(sub.values[P.checksum]); // the accent choice applies to the map already loaded
  dirty.layout = true;
  wake();
});

measureDigits();
Promise.all([F.label, F.count, F.big, F.footValue].map(font => document.fonts.load(font))).catch(() => {}).then(() => {
  measureDigits();
  forceRedraw();
  wake();
});

wake();

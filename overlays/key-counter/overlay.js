// Copyright (c) 2026 18-LAB. MIT.
// Key counter: one cap per key with its press count, lit while held, and keys per second (the
// set's shared definition, createKps) with the attempt's peak. key-counter is where KPS lives in
// osu!, taiko and catch; in mania kps-graph owns it and the copy here has a toggle (showKps).
// Lays itself out for the box its host gives it: a row of caps beside the readout (osu!, taiko,
// catch), a strip over a row of caps that follows the skin's column proportions (mania), or a
// column of key rows in tall boxes. On the results screen the readout holds the attempt's peak and
// average, which osu! does not show.
//
// Everything is DOM on the shared kit (type roles, colour roles, backing, signature). Data frames
// write only what changed: a count's text node when its formatted string changes, a cap's `lit`
// class when it toggles. No frame loop: KPS is read at each data frame's map time, so it decays
// with the game clock and stops with it (frozen or paused data costs nothing).
import {
  subscribe, settings, activeMode, isPlaying, maniaSkin, createKps, numberFormatter, known, isKnown,
  UNKNOWN, DASH, applyKitSettings, MOTION_MS,
} from './vosu-overlay.js';

const RESULTS = 7;
const MAX_KEYS = 32;
const SNAP_KPS = 15;            // above this the light snaps off instead of fading (no strobe)…
const SNAP_OFF_KPS = 12;        // …until KPS falls back to this
const PEAK_HOLD_MS = 1000;      // a new peak flashes only after the previous one held this long
const BUCKET_MS = 250;          // history resolution (real time)
const SPARK_BARS = 40;          // 40 × 250 ms = the last 10 s
const HISTORY = 14400;          // one hour of buckets for the results overview

// Design widths at --u = 1 (CSS px).
const BASE_H = 96;
const PAD = 16, GAP = 16, CAP_GAP = 6;
const CAP_MIN = 52, CAP_MAX = 72;      // a cap fits "8,888" at 20 px with 6 px either side
const ROWS_MIN = 112, ROWS_MAX = 150;  // three keys as rows when three caps do not fit
const STATS_W = 88;                    // "88" at 52 px plus the kps unit (measured 87)
const TOTAL_W = 56;
const SPARK_MIN = 96;
const COLUMN_W = 160;                  // vertical layout

const P = {
  state: '/state/number', playMode: '/play/mode/number', menuMode: '/settings/mode/number',
  client: '/client', all: '/keys/all', k1: '/keys/k1', k2: '/keys/k2', m1: '/keys/m1', m2: '/keys/m2',
  bindOsu: '/settings/keybinds/osu', bindTaiko: '/settings/keybinds/taiko', bindFruits: '/settings/keybinds/fruits',
  cs: '/beatmap/stats/cs/converted', skin: '/settings/skin/name',
  live: '/beatmap/time/live', rate: '/beatmap/time/rate',
};

const $ = id => document.getElementById(id);
const hud = $('hud'), capsEl = $('caps'), chip = $('chip');
const totalCol = $('total'), statsCol = $('stats'), sparkCol = $('spark-col');
const hero = $('hero');
const totalText = totalCol.querySelector('.num').firstChild;
const kpsText = $('kps').firstChild, peakText = $('peak').firstChild, statsLabelText = $('stats-label').firstChild;
const peakEl = $('peak'), kpsEl = $('kps'), totalEl = totalCol.querySelector('.num');
const sparkLabel = $('spark-label');
const spark = $('spark');
const sctx = spark.getContext('2d');
const css = getComputedStyle(document.documentElement);
const role = name => css.getPropertyValue(name).trim();
const C = { text1: role('--text-1'), text3: role('--text-3'), hair: role('--hair'), hairStrong: role('--hair-strong'), you: role('--you') };

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

/**
 * Caps to show: [{src: index into keys.all, code, title, zone}]. `code` is the bound key (kit-code),
 * `title` a sentence-case label used instead of it, `zone` the taiko drum zone ('kat' | 'don').
 */
function layoutFor(mode, client, columns, smoke, binds) {
  const b = binds || {};
  if (mode === 'osu') {
    const caps = [{ src: 0, code: keyLabel(b.k1, 'K1') }, { src: 1, code: keyLabel(b.k2, 'K2') }];
    if (smoke) caps.push({ src: 2, code: keyLabel(b.smokeKey, 'SMOKE') });
    return caps;
  }
  if (mode === 'taiko') return [
    { src: 0, code: keyLabel(b.outerLeft, 'L·KAT'), zone: 'kat' },
    { src: 1, code: keyLabel(b.innerLeft, 'L·DON'), zone: 'don' },
    { src: 2, code: keyLabel(b.innerRight, 'R·DON'), zone: 'don' },
    { src: 3, code: keyLabel(b.outerRight, 'R·KAT'), zone: 'kat' },
  ];
  if (mode === 'fruits') {
    // osu!stable records the catcher position, not left/right presses: only dash is real there,
    // and dashes per second mean nothing, so it is one cap that says what it counts.
    if (client === 'stable') return [{ src: 2, title: 'Dash presses' }];
    return [{ src: 0, code: keyLabel(b.k1, 'LEFT') }, { src: 1, code: keyLabel(b.k2, 'RIGHT') }, { src: 2, code: keyLabel(b.Dash, 'DASH') }];
  }
  const caps = [];
  for (let i = 0; i < Math.min(columns, MAX_KEYS); i++) caps.push({ src: i });
  return caps;
}

// ---------------------------------------------------------------- attempt state
const kps = createKps();
const prev = new Int32Array(MAX_KEYS);   // last counts, for presses since the previous frame
const counts = new Float64Array(MAX_KEYS);
const lit = new Uint8Array(MAX_KEYS);
const hist = new Uint8Array(HISTORY);    // highest KPS per 250 ms bucket
// t0: map time the attempt was first seen; first/last: map time of the first and last press seen.
const att = { seeded: false, n: 0, t0: 0, idx: -1, taps: 0, first: 0, last: 0, rate: 1, valid: false };

function resetAttempt() {
  kps.reset();
  hist.fill(0);
  prev.fill(0); counts.fill(0); lit.fill(0);
  att.seeded = false; att.n = 0; att.idx = -1; att.taps = 0; att.first = 0; att.last = 0; att.valid = false;
  peakState.at = -Infinity;
}

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

// ---------------------------------------------------------------- incoming data
const view = { status: 'connecting', phase: 'connecting', mode: null, client: 'stable', caps: [], sig: '', columns: 0, kpsShown: true };
const lk = { mode: undefined, client: undefined, columns: -1, smoke: false, binds: undefined };
let lastColumns = 0;
let layoutDirty = true;
let kpsNow = UNKNOWN;

function onFrame(values) {
  const state = values[P.state];
  const mode = activeMode(state, values[P.playMode], values[P.menuMode]);
  const playing = isPlaying(state);
  let phase = state === undefined || !mode ? 'absent' : playing ? 'play' : state === RESULTS ? 'results' : 'menu';
  const src = playing || phase === 'results' ? readKeys(values, mode) : null;
  if (phase === 'play' && !src) phase = 'nokeys';
  if (phase === 'play' && view.phase !== 'play') resetAttempt();

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
    const sig = `${mode}|${client}|${caps.map(c => `${c.src}:${c.code || c.title || ''}:${c.zone || ''}`).join(',')}`;
    if (sig !== view.sig) {
      const keysetChanged = view.mode !== mode || view.columns !== columns || (mode === 'fruits' && view.caps.length !== caps.length);
      view.sig = sig; view.caps = caps; view.mode = mode; view.columns = columns; view.client = client;
      layoutDirty = true;
      if (keysetChanged && phase === 'play') resetAttempt();
    }
  }

  const now = performance.now();
  if (phase === 'play') {
    const live = known(values[P.live]);
    const rate = num(values[P.rate]) > 0 ? values[P.rate] : 1;
    kps.ingest(values[P.all], live, rate);
    track(src, live, rate);
    kpsNow = isKnown(live) ? kps.at(live) : UNKNOWN;
    if (isKnown(live)) history(live, rate);
    att.valid = true;
  } else if (phase === 'results') {
    // Hold the attempt that just ended; a page opened on the results screen shows what vosu still
    // reports, if it reports any presses (all zero means the host has already cleared them).
    if (!att.valid && src) {
      const n = Math.min(src.length, MAX_KEYS);
      let sum = 0;
      for (let i = 0; i < n; i++) { counts[i] = num(src[i].count); sum += counts[i]; }
      att.valid = sum > 0;
    }
    lit.fill(0);
    kpsNow = UNKNOWN;
  } else {
    att.valid = false;
    kpsNow = UNKNOWN;
  }

  setPhase(phase);
  if (layoutDirty) layout();
  render(now);
}

/** Counts, presses since the previous frame (they light the cap for at least this frame), attempt span. */
function track(src, live, rate) {
  const n = Math.min(src.length, MAX_KEYS);
  if (!att.seeded || n !== att.n) {
    // First sight of this attempt: take the counts as a baseline instead of inventing a burst.
    for (let i = 0; i < n; i++) prev[i] = num(src[i].count);
    att.seeded = true; att.n = n; att.t0 = isKnown(live) ? live : 0; att.idx = -1;
  }
  for (let i = 0; i < n; i++) {
    const c = num(src[i].count);
    if (c < prev[i]) { // retry or rewind: a new attempt (createKps resets itself on the same signal)
      resetAttempt();
      for (let j = 0; j < n; j++) prev[j] = num(src[j].count);
      att.seeded = true; att.n = n; att.t0 = isKnown(live) ? live : 0;
      break;
    }
  }
  for (let i = 0; i < n; i++) {
    const key = src[i];
    const c = num(key.count);
    const d = c - prev[i];
    if (d > 0) {
      att.taps += d < 64 ? d : 64;
      if (isKnown(live)) { if (att.taps === d) att.first = live; att.last = live; att.rate = rate; }
    }
    prev[i] = c;
    counts[i] = c;
    lit[i] = key.isPressed || d > 0 ? 1 : 0;
  }
}

/** Highest KPS per 250 ms of real time since the attempt began. */
function history(live, rate) {
  const k = isKnown(kpsNow) ? kpsNow : 0;
  const idx = Math.floor((live - att.t0) / rate / BUCKET_MS);
  if (idx < 0 || idx >= HISTORY) return;
  if (idx !== att.idx) { att.idx = idx; sparkDirty = true; }
  if (k > hist[idx]) { hist[idx] = k < 255 ? k : 255; sparkDirty = true; }
}

function onStatus(state) {
  if (state === view.status) return;
  view.status = state;
  if (state !== 'live') { setPhase(state); render(performance.now()); }
}

function setPhase(phase) {
  if (view.status !== 'live') phase = view.status;
  if (phase === view.phase) return;
  const was = view.phase;
  view.phase = phase;
  const shown = phase === 'play' || phase === 'results';
  if (shown) hud.removeAttribute('data-out');
  else if (!hud.hasAttribute('data-out')) hud.setAttribute('data-out', '');
  const message = phase === 'offline' ? 'vosu offline' : phase === 'connecting' ? 'Connecting to vosu'
    : phase === 'absent' ? 'Waiting for osu!' : phase === 'nokeys' ? 'Needs vosu key data' : '';
  if (message) { chip.textContent = message; chip.hidden = false; } else chip.hidden = true;
  if ((was === 'play' && phase === 'results') || (was === 'results' && phase === 'play')) {
    phaseSwitched = true;
    layoutDirty = true; // the readout swaps between live and held; history spans 10 s or the attempt
  }
  if (phase === 'results' || was === 'results') sparkDirty = true;
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
    layoutDirty = true;
    layout();
    render(performance.now());
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
  orientation: 'auto', align: 'center', showKps: true, spark: true, total: true, maniaColumns: 'skin',
  backing: 'scrim', motion: 'full',
};
const box = { w: 0, h: 0 };
// Drawn caps: element, count text node, formatter, last shown string/lit state, squeeze per digit count.
const capNodes = [];
let sparkOn = false, sparkDirty = true, phaseSwitched = false;
const sparkGeo = { w: 0, h: 0, dpr: 1 };
// Count text width in em per digit count (Barlow Condensed tabular digits .45 em, comma .2 em).
const countEm = d => d * 0.45 + Math.floor((d - 1) / 3) * 0.2;

function makeCap(spec) {
  const el = document.createElement('div');
  el.className = 'cap';
  if (spec.zone) el.dataset.zone = spec.zone;
  if (spec.code || spec.title) {
    const key = document.createElement('span');
    key.className = spec.title ? 'kit-label key' : 'kit-code key';
    key.textContent = spec.title || spec.code;
    el.append(key);
  }
  const n = document.createElement('span');
  n.className = 'kit-value num dash';
  n.textContent = DASH;
  el.append(n);
  return {
    el, num: n, text: n.firstChild, src: spec.src, fmt: numberFormatter('count'),
    shown: DASH, lit: 0, digits: -1, room: 0, fontPx: 20, squeeze: [1],
  };
}

/** Builds the caps and sizes every column for the box. Layout time only (allocates freely). */
function layout() {
  layoutDirty = false;
  const W = box.w, H = box.h;
  if (!W || !H) return;
  capsEl.textContent = '';
  capNodes.length = 0;
  for (const spec of view.caps) { const c = makeCap(spec); capNodes.push(c); capsEl.append(c.el); }
  const n = capNodes.length;
  const mode = view.mode;
  const held = view.phase === 'results';
  view.kpsShown = !(mode === 'fruits' && view.client === 'stable') && (mode !== 'mania' || opts.showKps);
  const pad = PAD; // kit.css pads every backing (none included) by --pad
  const vertical = opts.orientation === 'vertical' || (opts.orientation === 'auto' && H > W * 1.15);
  hud.dataset.align = opts.align;
  hud.style.setProperty('--justify', opts.align === 'center' ? 'center' : 'flex-start');
  capsEl.removeAttribute('data-rows');
  hud.removeAttribute('data-strip');
  capsEl.style.width = '';
  statsCol.style.width = ''; totalCol.style.width = '';
  hero.className = 'kit-hero num';
  let u = H / BASE_H;
  let total = false, sparkShown = false;

  if (vertical) {
    hud.dataset.layout = 'column';
    u = Math.max(0.5, Math.min(3, W / COLUMN_W));
    total = opts.total && n > 1 && view.kpsShown;
    sparkShown = false;
    for (const c of capNodes) c.room = W / u - 2 * pad - 16 - 48; // beside the key label
  } else if (mode === 'mania') {
    hud.dataset.layout = 'mania';
    hero.className = 'kit-value num';
    total = opts.total;
    if (!view.kpsShown && !total) hud.dataset.strip = 'off';
    const inner = W / u - 2 * pad;
    const cols = columnFractions(n);
    let narrow = Infinity;
    for (let i = 0; i < n; i++) {
      const c = capNodes[i];
      const x0 = cols[i].a * inner, x1 = cols[i].b * inner;
      const g = n > 1 ? 2 : 0;
      c.el.style.left = `calc(var(--u) * ${(x0 + g).toFixed(2)}px)`;
      c.el.style.width = `calc(var(--u) * ${Math.max(4, x1 - x0 - 2 * g).toFixed(2)}px)`;
      const room = x1 - x0 - 2 * g - 4;
      c.room = room;
      if (room < narrow) narrow = room;
    }
    // Counts at 20 px when "8,888" fits the narrowest column, else smaller, never under 14 px.
    const size = Math.max(14, Math.min(20, narrow / countEm(4)));
    hud.style.setProperty('--mania-n', `calc(var(--u) * ${size.toFixed(2)}px)`);
    for (const c of capNodes) c.fontPx = size;
  } else {
    hud.dataset.layout = 'row';
    const statsW = view.kpsShown ? STATS_W + GAP : 0;
    let avail = W / u - 2 * pad;
    const rows = n >= 3 && n * CAP_MIN + (n - 1) * CAP_GAP + statsW > avail;
    const capsMin = rows ? ROWS_MIN : view.caps[0]?.title ? 112 : n * CAP_MIN + (n - 1) * CAP_GAP;
    let need = capsMin + statsW;
    if (need > avail) { u = W / (need + 2 * pad); avail = need; }
    if (opts.total && n > 1 && view.kpsShown && need + TOTAL_W + GAP <= avail) { total = true; need += TOTAL_W + GAP; }
    if (opts.spark && view.kpsShown && need + SPARK_MIN + GAP <= avail) { sparkShown = true; need += SPARK_MIN + GAP; }
    const extra = avail - need;
    if (rows) {
      capsEl.dataset.rows = '';
      const w = Math.min(ROWS_MAX, ROWS_MIN + extra);
      capsEl.style.width = `calc(var(--u) * ${w}px)`;
      for (const c of capNodes) { c.room = w - 12 - 48; c.fontPx = 16; }
    } else if (view.caps[0]?.title) {
      // osu!stable catch: one cap that says what it counts, across the box, its count at value size.
      for (const c of capNodes) { c.el.classList.add('wide'); c.el.style.width = `calc(var(--u) * ${avail.toFixed(2)}px)`; c.room = avail - 16; c.fontPx = 32; }
    } else {
      const capW = Math.min(CAP_MAX, CAP_MIN + extra / Math.max(1, n));
      for (const c of capNodes) { c.el.style.width = `calc(var(--u) * ${capW.toFixed(2)}px)`; c.room = capW - 16; }
    }
    statsCol.style.width = `calc(var(--u) * ${STATS_W}px)`;
    totalCol.style.width = `calc(var(--u) * ${TOTAL_W}px)`;
  }
  hud.style.setProperty('--u', u.toFixed(4));
  statsCol.hidden = !view.kpsShown;
  totalCol.hidden = !total;
  sparkCol.hidden = !sparkShown;
  sparkOn = sparkShown;
  sparkLabel.textContent = held ? 'Whole attempt' : 'Last 10 s';
  // Squeeze factors per digit count: long counts in narrow caps condense instead of clipping.
  for (const c of capNodes) {
    c.squeeze = [1];
    for (let d = 1; d <= 16; d++) c.squeeze.push(Math.min(1, c.room / (countEm(d) * c.fontPx)));
    c.digits = -1;
  }
  if (sparkShown) {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(spark.clientWidth * dpr), h = Math.round(spark.clientHeight * dpr);
    if (w !== spark.width || h !== spark.height) { spark.width = w; spark.height = h; }
    sparkGeo.w = w; sparkGeo.h = h; sparkGeo.dpr = dpr;
    planBars(w);
  }
  shown.kps = shown.peak = shown.total = shown.label = null;
  sparkDirty = true;
}

// ---------------------------------------------------------------- render (per data frame; writes only changes)
const kpsFmt = numberFormatter('kps'), peakFmt = numberFormatter('kps'), avgFmt = numberFormatter('kps'), totalFmt = numberFormatter('count');
const shown = { kps: null, peak: null, total: null, label: null, snap: false };
const peakState = { value: 0, at: -Infinity };
const LABEL_LIVE = 'Peak', LABEL_HELD = 'Peak · avg';

function setText(node, el, text, prevText) {
  if (text === prevText) return;
  node.data = text;
  const dash = text === DASH;
  if (dash !== el.classList.contains('dash')) el.classList.toggle('dash', dash);
}

function render(now) {
  const phase = view.phase;
  if (phase !== 'play' && phase !== 'results') return;
  const live = phase === 'play';
  for (let i = 0; i < capNodes.length; i++) {
    const c = capNodes[i];
    const text = att.valid ? c.fmt(counts[c.src]) : DASH;
    if (text !== c.shown) {
      setText(c.text, c.num, text, c.shown);
      c.shown = text;
      const d = text.length; // digits plus commas: the squeeze table is indexed by digit count
      const digits = d - Math.floor(d / 4);
      if (digits !== c.digits) {
        c.digits = digits;
        const s = c.squeeze[digits < c.squeeze.length ? digits : c.squeeze.length - 1];
        c.num.style.transform = s < 1 ? `scaleX(${s.toFixed(3)})` : '';
      }
    }
    const on = live ? lit[c.src] : 0;
    if (on !== c.lit) { c.lit = on; c.el.classList.toggle('lit', on === 1); }
  }

  if (view.kpsShown) {
    // Live: KPS now, peak beside it. Held: the attempt's peak, with its average beside it.
    const peak = att.taps > 0 && kps.available ? kps.peak : UNKNOWN;
    const big = live ? kpsNow : peak;
    const k = kpsFmt(big);
    if (k !== shown.kps) { setText(kpsText, kpsEl, k, shown.kps); shown.kps = k; }
    let aux = peak;
    if (!live) {
      const seconds = (att.last - att.first) / att.rate / 1000;
      aux = att.taps > 1 && seconds >= 1 ? (att.taps - 1) / seconds : UNKNOWN;
    }
    const a = live ? peakFmt(aux) : avgFmt(aux);
    if (a !== shown.peak) { setText(peakText, peakEl, a, shown.peak); shown.peak = a; }
    const label = live ? LABEL_LIVE : LABEL_HELD;
    if (label !== shown.label) { statsLabelText.data = label; shown.label = label; }
    if (live) newPeak(peak, now);
  }
  // Press feedback snaps above 15 KPS (no strobe) and fades again below 12 (no flapping at the edge).
  const kNow = live && isKnown(kpsNow) ? kpsNow : 0;
  const snap = shown.snap ? kNow > SNAP_OFF_KPS : kNow > SNAP_KPS;
  if (snap !== shown.snap) { shown.snap = snap; if (snap) hud.setAttribute('data-snap', ''); else hud.removeAttribute('data-snap'); }
  if (!totalCol.hidden) {
    let sum = 0;
    for (let i = 0; i < capNodes.length; i++) sum += counts[capNodes[i].src];
    const t = totalFmt(att.valid ? (kps.available && live ? kps.total : sum) : UNKNOWN);
    if (t !== shown.total) { setText(totalText, totalEl, t, shown.total); shown.total = t; }
  }
  if (sparkOn && sparkDirty) drawSpark(!live);
  if (phaseSwitched) { phaseSwitched = false; playSwitch(); }
}

// ---------------------------------------------------------------- motion
// Created once and restarted (motion brief: no animate() per event). Durations follow MOTION_MS.
let peakAnim = null, switchAnim = null;
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
function animations() {
  peakAnim?.cancel(); switchAnim?.cancel();
  // New peak: the peak figure lights amber and settles back (an event flash; dropped under reduced/off).
  peakAnim = peakEl.animate([{ color: C.you }, { color: C.you, offset: 0.3 }, { color: C.text1 }], { duration: MOTION_MS.slow, easing: 'ease-out' });
  peakAnim.cancel();
  // Play ↔ results: the readout re-enters (continuity; kept under reduced, instant under off).
  switchAnim = statsCol.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_MS.base, easing: EASE_OUT });
  switchAnim.cancel();
}

function newPeak(peak, now) {
  if (!isKnown(peak) || peak === peakState.value) { if (!isKnown(peak)) peakState.value = 0; return; }
  const held = now - peakState.at;
  peakState.value = peak; peakState.at = now;
  // A burst ramps the peak up press by press; only the first rise after a held peak flashes.
  if (held >= PEAK_HOLD_MS && peak >= 5 && opts.motion === 'full') { peakAnim.currentTime = 0; peakAnim.play(); }
}

function playSwitch() {
  if (opts.motion === 'off' || statsCol.hidden) return;
  switchAnim.currentTime = 0;
  switchAnim.play();
}

// ---------------------------------------------------------------- history bars
const BAR_X = new Int32Array(SPARK_BARS), BAR_W = new Int32Array(SPARK_BARS), BAR_V = new Int32Array(SPARK_BARS);

function planBars(w) {
  const pitch = w / SPARK_BARS;
  for (let k = 0; k < SPARK_BARS; k++) {
    const x = Math.round(k * pitch);
    BAR_X[k] = x;
    BAR_W[k] = Math.max(1, Math.round(k * pitch + pitch * 2 / 3) - x);
  }
}

/** 40 bars: live = the last 10 s, the newest bright; held = the whole attempt, the peak bright. */
function drawSpark(held) {
  sparkDirty = false;
  const w = sparkGeo.w, h = sparkGeo.h;
  if (!w || !h) return;
  sctx.clearRect(0, 0, w, h);
  const hair = Math.max(1, Math.round(sparkGeo.dpr));
  sctx.fillStyle = C.hair;
  sctx.fillRect(0, h - hair, w, hair);
  if (!att.valid || att.idx < 0) return;
  const last = att.idx;
  const group = held ? Math.max(1, Math.ceil((last + 1) / SPARK_BARS)) : 1;
  const start = held ? 0 : last - SPARK_BARS + 1;
  let peak = 0, peakBar = -1;
  for (let k = 0; k < SPARK_BARS; k++) {
    let v = 0;
    const from = start + k * group;
    for (let b = from; b < from + group; b++) if (b >= 0 && b <= last && hist[b] > v) v = hist[b];
    BAR_V[k] = v;
    if (v > peak) { peak = v; peakBar = k; }
  }
  const r5 = peak % 5;
  let scale = peak - r5 + (r5 ? 5 : 0); // peak rounded up to a multiple of 5, at least 10
  if (scale < 10) scale = 10;
  const usable = h - hair;
  for (let k = 0; k < SPARK_BARS; k++) {
    const v = BAR_V[k];
    if (!v) continue;
    const bh = Math.max(hair, Math.round(v / scale * usable));
    const marked = held ? k === peakBar : start + k === last;
    sctx.fillStyle = marked ? C.text1 : C.hairStrong;
    sctx.fillRect(BAR_X[k], h - hair - bh, BAR_W[k], bh);
  }
}

// ---------------------------------------------------------------- go
new ResizeObserver(([entry]) => {
  const w = entry.contentRect.width, h = entry.contentRect.height;
  if (w === box.w && h === box.h) return;
  box.w = w; box.h = h;
  layoutDirty = true;
  layout();
  render(performance.now());
}).observe(document.body);

const sub = subscribe(Object.values(P), onFrame, { onStatus });

const DEFAULTS = {
  motion: 'full', backing: 'scrim', showKps: true, orientation: 'auto', align: 'center',
  showSparkline: true, showTotal: true, maniaColumns: 'skin',
};
settings(DEFAULTS, s => {
  opts.motion = applyKitSettings(hud, { motion: s.motion, backing: s.backing, mapTint: false });
  opts.backing = hud.dataset.backing;
  opts.showKps = !!s.showKps;
  opts.orientation = ['auto', 'horizontal', 'vertical'].includes(s.orientation) ? s.orientation : 'auto';
  opts.align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'center';
  opts.spark = !!s.showSparkline;
  opts.total = !!s.showTotal;
  opts.maniaColumns = s.maniaColumns === 'equal' ? 'equal' : 'skin';
  layoutDirty = true;
  if (sub) { layout(); render(performance.now()); }
});

animations();
document.fonts.ready.then(() => { layoutDirty = true; layout(); render(performance.now()); });

// Copyright (c) 2026 18-LAB. MIT.
// Stream scene: streamer chrome laid over the full-screen osu! window. A webcam frame and handle tag,
// a compact live play strip and a session ledger, each placed into the space osu! leaves empty for
// the active ruleset/screen (osuLayout), never over the playfield, stage, lane or HUD.
// Only narrow scalar leaves are subscribed (no hit-error arrays); per frame during play the work is
// one progress transform plus a handful of string compares.
import { subscribe, settings, fit, formatDuration, osuLayout, mapPalette, applyPalette } from './vosu-overlay.js';

const W = 1920, H = 1080, M = 24;
const CAM_W = { small: 320, medium: 384, large: 480 };
const MODES = ['osu', 'taiko', 'fruits', 'mania'];
// osu!stable 1080p screens outside gameplay: the free centre column of song select (between the
// local leaderboard and the carousel, above the bottom bar) and the right of the results header.
const SELECT_FREE = { x: 540, y: 190, w: 620, h: 740 };
const RESULTS_FREE = { x: 1000, y: 8, w: 900, h: 122 };

const $ = id => document.getElementById(id);
const stage = $('stage');
fit(stage, W, H);

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number', client: '/client',
  title: '/beatmap/title', version: '/beatmap/version', checksum: '/beatmap/checksum', keys: '/beatmap/stats/cs/converted',
  live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', clockRate: '/beatmap/time/rate',
  ppNow: '/play/pp/current', ppFc: '/play/pp/fc', acc: '/play/accuracy', combo: '/play/combo/current',
  ur: '/play/unstableRate', miss: '/play/hits/0', mods: '/play/mods/array', rate: '/play/mods/rate',
  rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc', rMode: '/resultsScreen/mode/number',
  name: '/profile/name', pRank: '/profile/globalRank', pPp: '/profile/pp', pMode: '/profile/mode/name',
  sTime: '/session/playTime', sPlays: '/session/playCount',
};

// Dirty groups: data handlers only OR these in; rendering happens once per animation frame.
const STATUS = 1, PLACE = 2, NP = 4, PROGRESS = 8, PLAY = 16, RESULT = 32, SESSION = 64, ALL = 127;
const GROUP = {
  [P.state]: ALL, [P.playMode]: ALL, [P.selMode]: ALL, [P.rMode]: ALL, [P.client]: PLACE | RESULT, [P.keys]: PLACE,
  [P.title]: NP, [P.version]: NP, [P.checksum]: NP,
  [P.live]: PROGRESS, [P.first]: PROGRESS, [P.last]: PROGRESS, [P.clockRate]: PROGRESS,
  [P.ppNow]: PLAY, [P.ppFc]: PLAY, [P.acc]: PLAY, [P.combo]: PLAY, [P.ur]: PLAY, [P.miss]: PLAY,
  [P.mods]: PLAY, [P.rate]: PLAY | PROGRESS,
  [P.rPp]: RESULT, [P.rFc]: RESULT,
  [P.name]: SESSION, [P.pRank]: SESSION, [P.pPp]: SESSION, [P.pMode]: SESSION, [P.sTime]: SESSION, [P.sPlays]: SESSION,
};

// ---------------------------------------------------------------- helpers
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = x => (typeof x === 'string' ? x.trim() : '');
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const int = x => (num(x) === null ? '—' : intFmt.format(Math.round(x)));
const fixed = (x, digits) => (num(x) === null ? '—' : x.toFixed(digits));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function put(el, text) {
  if (el._text === text) return;
  el._text = text;
  // Reuse the text node (no node churn at 60 Hz); fall back to textContent for empty/mixed content.
  const node = el.firstChild;
  if (node && node === el.lastChild && node.nodeType === 3 && text) node.nodeValue = text;
  else el.textContent = text;
  // A readout with no data drops its unit ("— pp" reads as a value); see `.v.na` in style.css.
  const na = text === '—';
  if (el._na !== na) { el._na = na; el.parentElement?.classList.toggle('na', na); }
}
function attr(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}
function hide(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}
function style(el, key, value) {
  if (el.style[key] !== value) el.style[key] = value;
}

const sessionCells = [...document.querySelectorAll('.lg-session')];
const el = Object.fromEntries([
  'cam-group', 'cam', 'cam-guide', 'info', 'caption', 'handle', 'social', 'status-line', 'dot', 'status-text',
  'strip', 'brand', 'np-title', 'np-time', 'progress', 'np-fill', 'pp-now', 'pp-fc', 'acc', 'combo', 'ur-k', 'ur', 'mods', 'rate',
  'ledger', 'result-cell', 'r-pp', 'r-fc', 's-plays', 's-time', 's-pp', 's-rank', 's-rank-now',
].map(id => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));

// ---------------------------------------------------------------- state
let opts = {};
let link = 'connecting';
let dirty = 0;
let frame = 0;
function mark(bits) {
  dirty |= bits;
  if (!frame && dirty) frame = requestAnimationFrame(render);
}
let phase = 'none';
let mode = null;
let placed = '';
let checksum = '';
const bases = new Map(); // `${profile}|${ruleset}` → session baseline {pp, rank}, first values seen by this source

// ---------------------------------------------------------------- soft scrims
// Each floating cluster carries a canvas painted once per size change with a feathered dark field,
// so light text stays legible over bright maps/skins without a hard-edged box.
const FEATHER = 40;
const scrims = new Map();
for (const cluster of [el.info, el.strip, el.ledger]) {
  const canvas = document.createElement('canvas');
  canvas.className = 'scrim';
  canvas.setAttribute('aria-hidden', 'true');
  cluster.prepend(canvas);
  scrims.set(cluster, canvas);
}
function paintScrim(cluster) {
  const canvas = scrims.get(cluster);
  const w = cluster.offsetWidth, h = cluster.offsetHeight;
  if (!w || !h || opts.backing !== 'scrim') return;
  const dpr = window.devicePixelRatio || 1;
  const cw = w + FEATHER * 2, ch = h + FEATHER * 2;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.filter = 'blur(16px)';
  ctx.fillStyle = 'rgb(9 10 11 / 0.66)';
  ctx.beginPath();
  ctx.roundRect(FEATHER - 6, FEATHER - 6, w + 12, h + 12, 14);
  ctx.fill();
}
const scrimObserver = new ResizeObserver(entries => { for (const entry of entries) paintScrim(entry.target); });
for (const cluster of scrims.keys()) scrimObserver.observe(cluster);

// ---------------------------------------------------------------- placement
/** HUD-clear vertical limits of a side band: below any top HUD it touches, above any bottom HUD. */
function bandLimits(band, hud) {
  let top = 144, bottom = H - M;
  for (const r of Object.values(hud)) {
    if (r.x + r.w <= band.x || r.x >= band.x + band.w) continue;
    if (r.y + r.h < H * 0.3) top = Math.max(top, r.y + r.h + M);
    else if (r.y > H * 0.7) bottom = Math.min(bottom, r.y - M);
  }
  return { top, bottom };
}
function sideBand(layout, side) {
  const right = layout.busy.x + layout.busy.w;
  return side === 'left' ? { x: 0, w: layout.busy.x } : { x: right, w: W - right };
}
/** Content of width `want` in a band: centred when the band is narrow, else on its outer screen edge. */
function inBand(band, side, want) {
  const w = Math.max(160, Math.min(want, band.w - 2 * M));
  const x = band.w - 2 * M < want * 1.5 ? band.x + Math.round((band.w - w) / 2) : side === 'left' ? M : W - M - w;
  return { x, w };
}

function place() {
  const client = v(P.client) === 'lazer' ? 'lazer' : 'stable';
  const keys = clamp(Math.round(num(v(P.keys)) || 4), 1, 18);
  const side = opts.side === 'left' ? 'left' : 'right';
  const other = side === 'left' ? 'right' : 'left';
  const camMode = MODES.includes(opts.camLayout) ? opts.camLayout : mode ?? 'osu';
  const stripMode = mode ?? 'osu';
  const key = `${camMode}|${stripMode}|${keys}|${client}|${phase}|${side}|${opts.camSize}|${opts.camX}|${opts.camY}|${opts.stripX}|${opts.stripY}|${opts.scale}|${opts.ledgerX}|${opts.ledgerY}`;
  if (key === placed) return;
  placed = key;
  const want = CAM_W[opts.camSize] ?? CAM_W.medium;
  const camX = num(opts.camX) ?? 0, camY = num(opts.camY) ?? 0;

  // Webcam: taiko → bottom corner of the band under the lane (tag above the frame);
  // osu!/catch/mania → top of the side band, below the score/accuracy or HP bar.
  const camLayout = osuLayout(camMode, { keys, client });
  let cam;
  if (camMode === 'taiko') {
    const w = Math.min(want, 640);
    cam = { x: side === 'left' ? M : W - M - w, w, h: Math.round(w * 9 / 16), anchor: 'bottom', edge: H - M };
  } else {
    const band = sideBand(camLayout, side);
    const { x, w } = inBand(band, side, want);
    cam = { x, w, h: Math.round(w * 9 / 16), anchor: 'top', edge: bandLimits(band, camLayout.hud).top };
  }
  const g = el.camGroup.style;
  g.left = `${cam.x + camX}px`;
  g.width = `${cam.w}px`;
  if (cam.anchor === 'top') { g.top = `${cam.edge + camY}px`; g.bottom = ''; }
  else { g.bottom = `${H - cam.edge - camY}px`; g.top = ''; }
  el.cam.style.height = `${cam.h}px`;
  attr(stage, 'cam', cam.anchor);
  const camTop = cam.anchor === 'top' ? cam.edge + camY : cam.edge + camY - cam.h;
  put(el.camGuide, `CAM ${cam.x + camX},${camTop} · ${cam.w}×${cam.h}`);

  // Play strip: taiko → a row under the lane on the side away from the webcam; osu!/catch → the
  // bottom of the opposite side band (left band ends above the combo counter); mania → under the
  // webcam's band, bottom-anchored beside the stage.
  const stripLayout = osuLayout(stripMode, { keys, client });
  const scale = clamp(num(opts.scale) ?? 1, 0.6, 1.6);
  const s = el.strip.style;
  let strip;
  if (stripMode === 'taiko') {
    const w = 720;
    strip = { x: side === 'left' ? W - M - w : M, w, top: stripLayout.busy.y + stripLayout.busy.h + 32, flow: 'row', right: side === 'left' };
  } else {
    const stripSide = stripMode === 'mania' ? side : other;
    const band = sideBand(stripLayout, stripSide);
    const { x, w } = inBand(band, stripSide, 336);
    strip = { x, w, bottom: bandLimits(band, stripLayout.hud).bottom, flow: 'column', right: stripSide === 'right' };
  }
  const stripX = num(opts.stripX) ?? 0, stripY = num(opts.stripY) ?? 0;
  s.left = `${strip.x + stripX}px`;
  s.width = `${strip.w}px`;
  if (strip.top !== undefined) { s.top = `${strip.top + stripY}px`; s.bottom = ''; }
  else { s.bottom = `${H - strip.bottom - stripY}px`; s.top = ''; }
  s.transformOrigin = `${strip.right ? 'right' : 'left'} ${strip.top !== undefined ? 'top' : 'bottom'}`;
  s.transform = scale === 1 ? '' : `scale(${scale})`;
  attr(el.strip, 'flow', strip.flow);

  // Session ledger: song select → bottom of the free centre column; results → right of the header.
  const l = el.ledger.style;
  const ledgerX = num(opts.ledgerX) ?? 0, ledgerY = num(opts.ledgerY) ?? 0;
  if (phase === 'results') {
    l.left = ''; l.right = `${W - (RESULTS_FREE.x + RESULTS_FREE.w) - ledgerX}px`;
    l.top = `${RESULTS_FREE.y + 16 + ledgerY}px`; l.bottom = '';
    l.width = '';
    l.transformOrigin = 'right top';
  } else {
    l.right = ''; l.left = `${SELECT_FREE.x + ledgerX}px`;
    l.top = ''; l.bottom = `${H - (SELECT_FREE.y + SELECT_FREE.h) - ledgerY}px`;
    l.width = `${SELECT_FREE.w}px`;
    l.transformOrigin = 'left bottom';
  }
  l.transform = scale === 1 ? '' : `scale(${scale})`;
}

// ---------------------------------------------------------------- settings
function applySettings() {
  attr(stage, 'backing', ['none', 'scrim', 'panel'].includes(opts.backing) ? opts.backing : 'scrim');
  attr(stage, 'guides', opts.showGuides ? 'on' : 'off');
  attr(stage, 'accent', opts.accent === '18-lab' ? 'lab' : 'map');
  hide(el.cam, !opts.showCam);
  hide(el.caption, !opts.showCaption);
  hide(el.brand, !opts.showBrand);
  hide(el.npTitle, !opts.showNowPlaying);
  hide(el.npTime, !opts.showNowPlaying);
  hide(el.progress, !opts.showNowPlaying);
  put(el.social, str(opts.social));
  hide(el.social, !str(opts.social));
  placed = '';
  for (const cluster of scrims.keys()) paintScrim(cluster);
  tint();
}

/** Map tint (accent = map): M3 tonal-spot roles from the background, loaded per checksum off the hot path. */
function tint() {
  const want = checksum;
  if (opts.accent === '18-lab' || !want) { applyPalette(stage, null); return; }
  mapPalette(want).then(palette => {
    if (want === checksum && opts.accent !== '18-lab') applyPalette(stage, palette);
  });
}

// ---------------------------------------------------------------- data
const values = subscribe(Object.values(P), (_, changed) => {
  let bits = 0;
  for (const pointer of changed) bits |= GROUP[pointer] ?? 0;
  // The song-select preview clock ticks constantly; nothing on screen follows it outside play.
  if (bits === PROGRESS && phase !== 'play') return;
  mark(bits);
}, {
  onStatus: state => {
    if (state === link) return;
    link = state;
    mark(ALL);
  },
}).values;

const v = pointer => (link === 'live' ? values[pointer] : undefined);

settings({
  side: 'auto', camLayout: 'follow ruleset', camSize: 'medium', camX: 0, camY: 0, stripX: 0, stripY: 0,
  ledgerX: 0, ledgerY: 0, scale: 1, handle: '', social: '', accent: 'map', backing: 'scrim',
  showCam: true, showCaption: true, showStrip: true, showNowPlaying: true, showSession: true, showResultsPp: true,
  showBrand: true, showGuides: false,
}, next => {
  opts = next;
  applySettings();
  mark(ALL);
});

function render() {
  const bits = dirty;
  dirty = 0;
  const state = v(P.state);
  phase = state === 2 ? 'play' : state === 5 ? 'select' : state === 7 ? 'results' : Number.isInteger(state) ? 'other' : 'none';
  const number = state === 2 && Number.isInteger(v(P.playMode)) ? v(P.playMode)
    : state === 7 && Number.isInteger(v(P.rMode)) ? v(P.rMode) : v(P.selMode);
  mode = MODES[number] ?? null;
  attr(stage, 'phase', phase);
  if (bits & (PLACE | STATUS)) place();
  if (bits & STATUS) renderStatus(state);
  if (bits & NP) renderMap();
  if (bits & PROGRESS && phase === 'play') renderProgress();
  if (bits & PLAY && phase === 'play') renderPlay();
  if (bits & (RESULT | SESSION | STATUS)) renderLedger();
  if (bits & SESSION) renderSession();
  frame = 0;
  if (dirty) frame = requestAnimationFrame(render);
}

function renderStatus(state) {
  const known = Number.isInteger(state);
  const text = link === 'offline' ? 'vosu offline' : link === 'connecting' ? 'Connecting' : !known ? 'Waiting for osu!' : '';
  attr(el.dot, 'status', link === 'live' ? 'idle' : link);
  put(el.statusText, text);
  hide(el.statusLine, !text);
  const playing = phase === 'play' && opts.showStrip;
  el.strip.classList.toggle('on', playing);
}

function renderMap() {
  const title = str(v(P.title)), version = str(v(P.version));
  put(el.npTitle, title ? (version ? `${title} [${version}]` : title) : '—');
  const next = str(v(P.checksum));
  if (next !== checksum) { checksum = next; tint(); }
}

function clockRate() {
  return num(v(P.clockRate)) || num(v(P.rate)) || 1;
}

function renderProgress() {
  const first = num(v(P.first)) ?? 0, last = num(v(P.last)), live = num(v(P.live));
  let f = 0;
  let text = '';
  if (last && live !== null) {
    f = clamp((live - first) / Math.max(1, last - first), 0, 1);
    const rate = clockRate();
    text = `${formatDuration(live / rate)} / ${formatDuration(last / rate)}`;
  }
  style(el.npFill, 'transform', `scaleX(${f.toFixed(4)})`);
  put(el.npTime, text);
}

function renderMods(list, rate) {
  const acronyms = Array.isArray(list) ? list.map(m => str(m?.acronym)).filter(Boolean) : null;
  const key = acronyms === null ? '—' : acronyms.join(' ') || 'NM';
  if (el.mods._key !== key) {
    el.mods._key = key;
    if (acronyms === null) el.mods.textContent = '—';
    else {
      el.mods.replaceChildren(...(acronyms.length ? acronyms : ['NM']).slice(0, 5).map(text => {
        const chip = document.createElement('span');
        chip.textContent = text;
        if (!acronyms.length) chip.className = 'nm';
        return chip;
      }));
    }
  }
  const r = num(rate);
  put(el.rate, r && Math.abs(r - 1) > 1e-3 ? `rate ${r.toFixed(2)}×` : '');
}

function renderPlay() {
  put(el.ppNow, int(v(P.ppNow)));
  put(el.ppFc, int(v(P.ppFc)));
  put(el.acc, fixed(num(v(P.acc)), 2));
  put(el.combo, int(v(P.combo)));
  if (mode === 'fruits') {
    // Catch has no timing windows, so no UR: fruit + drop misses (hits "0") instead.
    put(el.urK, 'Miss');
    put(el.ur, int(v(P.miss)));
  } else {
    const ur = num(v(P.ur));
    put(el.urK, 'UR');
    put(el.ur, ur ? ur.toFixed(1) : '—');
  }
  renderMods(v(P.mods), v(P.rate));
}

function renderLedger() {
  // Song select and results already show the map, mods, scores and (lazer) pp; the ledger adds
  // only what osu! lacks there: this stream's session, plus the result's pp on stable.
  const showResult = phase === 'results' && opts.showResultsPp && v(P.client) !== 'lazer' && num(v(P.rPp)) !== null;
  const show = opts.showSession && (phase === 'select' || phase === 'results');
  hide(el.resultCell, !showResult);
  el.ledger.classList.toggle('on', show || showResult);
  for (const cell of sessionCells) hide(cell, !show);
  if (showResult) {
    put(el.rPp, int(v(P.rPp)));
    put(el.rFc, int(v(P.rFc)));
  }
}

function renderSession() {
  const name = str(v(P.name));
  put(el.handle, str(opts.handle) || name);
  hide(el.caption, !opts.showCaption || (!str(opts.handle) && !name && !str(opts.social)));

  put(el.sPlays, int(v(P.sPlays)));
  const time = num(v(P.sTime));
  put(el.sTime, time === null ? '—' : formatDuration(time));

  // One baseline per profile + ruleset, so switching rulesets mid-session keeps each one's gains.
  const pp = num(v(P.pPp)), rank = num(v(P.pRank));
  const key = `${name}|${str(v(P.pMode))}`;
  if (name && pp && !bases.has(key)) bases.set(key, { pp, rank: rank || null });
  const base = name && pp !== null ? bases.get(key) : undefined;
  put(el.sRankNow, rank ? `now #${intFmt.format(rank)}` : '');
  if (!base) {
    put(el.sPp, '—'); attr(el.sPp, 'sign', 'none');
    put(el.sRank, '—'); attr(el.sRank, 'sign', 'none');
    return;
  }
  const gained = pp - base.pp;
  const sign = Math.abs(gained) < 0.05 ? 'flat' : gained > 0 ? 'up' : 'down';
  attr(el.sPp, 'sign', sign);
  put(el.sPp, sign === 'flat' ? '±0' : `${gained > 0 ? '+' : '−'}${Math.abs(gained).toFixed(1)}`);
  if (rank && !base.rank) base.rank = rank;
  if (rank && base.rank) {
    const moved = base.rank - rank;
    attr(el.sRank, 'sign', moved > 0 ? 'up' : moved < 0 ? 'down' : 'flat');
    put(el.sRank, moved > 0 ? `▲ ${intFmt.format(moved)}` : moved < 0 ? `▼ ${intFmt.format(-moved)}` : '±0');
  } else {
    attr(el.sRank, 'sign', 'none');
    put(el.sRank, '—');
  }
}

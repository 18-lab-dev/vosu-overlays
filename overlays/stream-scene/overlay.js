// Copyright (c) 2026 18-LAB. MIT.
// Stream scene: a full 1920×1080 frame around a transparent 16:9 gameplay window and webcam slot.
// Everything is narrow scalar leaves (no hit-error arrays), so vosu's fast readers stay quiet and the
// only per-frame work during play is the progress transform plus a handful of string compares.
import { subscribe, settings, fit, formatDuration, backgroundUrl, MODE_LABELS } from './vosu-overlay.js';

const W = 1920, H = 1080, M = 24, GAP = 24, SIDE_W = 440, GAME_W = 1408, GAME_H = 792;
const CAM_H = { small: 248, medium: 330, large: 440 };
const MODES = ['osu', 'taiko', 'fruits', 'mania'];

const $ = id => document.getElementById(id);
const stage = $('stage');
fit(stage, W, H);

const P = {
  state: '/state/number', playMode: '/play/mode/number', selMode: '/settings/mode/number', source: '/play/source',
  artist: '/beatmap/artist', title: '/beatmap/title', version: '/beatmap/version', mapper: '/beatmap/mapper',
  checksum: '/beatmap/checksum', status: '/beatmap/status/name',
  live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject', clockRate: '/beatmap/time/rate',
  stars: '/beatmap/stats/stars/total', bpm: '/beatmap/stats/bpm/common', ar: '/beatmap/stats/ar/converted',
  od: '/beatmap/stats/od/converted', cs: '/beatmap/stats/cs/converted', mapCombo: '/beatmap/stats/maxCombo',
  ppNow: '/play/pp/current', ppFc: '/play/pp/fc', acc: '/play/accuracy', combo: '/play/combo/current',
  comboMax: '/play/combo/max', ur: '/play/unstableRate', grade: '/play/rank/current', miss: '/play/hits/0',
  mods: '/play/mods/array', rate: '/play/mods/rate', ppAcc: '/performance/accuracy',
  rGrade: '/resultsScreen/rank', rAcc: '/resultsScreen/accuracy', rPp: '/resultsScreen/pp/current', rFc: '/resultsScreen/pp/fc',
  rCombo: '/resultsScreen/maxCombo', rScore: '/resultsScreen/score', rHits: '/resultsScreen/hits',
  rMods: '/resultsScreen/mods/name', rMode: '/resultsScreen/mode/number', rPlayer: '/resultsScreen/playerName',
  name: '/profile/name', country: '/profile/countryCode/name', pRank: '/profile/globalRank', pPp: '/profile/pp',
  pAcc: '/profile/accuracy', pMode: '/profile/mode/name', level: '/profile/level', pPlays: '/profile/playCount',
  sTime: '/session/playTime', sPlays: '/session/playCount',
};

// Dirty groups: data handlers only OR these in; rendering happens once per animation frame.
const STATUS = 1, NP = 2, PROGRESS = 4, PLAY = 8, MENU = 16, RESULTS = 32, PLAYER = 64, SESSION = 128, RECENT = 256, ALL = 511;
const GROUP = {
  [P.state]: ALL, [P.playMode]: ALL, [P.selMode]: ALL, [P.source]: STATUS,
  [P.artist]: NP, [P.title]: NP, [P.version]: NP, [P.mapper]: NP, [P.checksum]: NP, [P.status]: NP,
  [P.live]: PROGRESS, [P.first]: PROGRESS, [P.last]: PROGRESS | NP, [P.clockRate]: PROGRESS | NP,
  [P.stars]: NP, [P.bpm]: NP, [P.ar]: NP, [P.od]: NP, [P.cs]: NP | STATUS, [P.mapCombo]: MENU,
  [P.ppNow]: PLAY, [P.ppFc]: PLAY, [P.acc]: PLAY, [P.combo]: PLAY, [P.comboMax]: PLAY, [P.ur]: PLAY, [P.grade]: PLAY,
  [P.miss]: PLAY,
  [P.mods]: PLAY | MENU, [P.rate]: PLAY | MENU | PROGRESS | NP, [P.ppAcc]: MENU,
  [P.rGrade]: RESULTS, [P.rAcc]: RESULTS, [P.rPp]: RESULTS, [P.rFc]: RESULTS, [P.rCombo]: RESULTS,
  [P.rScore]: RESULTS, [P.rHits]: RESULTS, [P.rMods]: RESULTS, [P.rMode]: RESULTS, [P.rPlayer]: RESULTS,
  [P.name]: PLAYER | SESSION, [P.country]: PLAYER, [P.pRank]: PLAYER | SESSION, [P.pPp]: PLAYER | SESSION,
  [P.pAcc]: PLAYER, [P.pMode]: PLAYER | SESSION, [P.level]: PLAYER, [P.pPlays]: PLAYER,
  [P.sTime]: SESSION, [P.sPlays]: SESSION,
};

// ---------------------------------------------------------------- helpers
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = x => (typeof x === 'string' ? x.trim() : '');
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const int = x => (num(x) === null ? '—' : intFmt.format(Math.round(x)));
const fixed = (x, digits) => (num(x) === null ? '—' : x.toFixed(digits));
const short = x => (num(x) === null ? '—' : String(Math.round(x * 10) / 10));
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
/** osu!stable reports X/XH/SH; lazer and tosu SS/SSH/SH. One spelling for the grade badge. */
function grade(rank) {
  const r = str(rank).toUpperCase();
  return { X: 'SS', XH: 'SSH' }[r] ?? r;
}
const gradeLabel = g => (g === 'SSH' ? 'SS' : g === 'SH' ? 'S' : g);

const el = Object.fromEntries([
  'backdrop', 'game', 'game-guide', 'rail', 'dot', 'status', 'phase', 'ruleset',
  'deck', 'brand', 'deck-label', 'np-status', 't-now', 't-total', 'np', 'np-bg', 'np-title', 'np-artist', 'np-version',
  'np-mapper', 'np-stars', 'np-bpm', 'np-k4', 'np-v4', 'np-len', 'progress', 'np-fill', 'strips',
  'pp-now', 'pp-fc', 'acc', 'grade-now', 'combo', 'combo-max', 'ur-k', 'ur', 'ur-s', 'mods', 'rate',
  'pp-100', 'pp-99', 'pp-98', 'pp-95', 'menu-combo', 'menu-mods', 'menu-rate',
  'r-grade', 'r-pp', 'r-fc', 'r-acc', 'r-mods', 'r-combo', 'r-score', 'r-hits',
  'side', 'cam-group', 'cam', 'cam-guide', 'caption', 'handle', 'social',
  'player', 'p-mode', 'p-country', 'p-name', 'p-rank', 'p-pp', 'p-acc', 'p-level', 'p-plays',
  'session', 's-plays', 's-time', 's-pp', 's-rank', 'recent', 'recent-empty',
].map(id => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]));

el.npBg.addEventListener('error', () => { el.npBg.hidden = true; });
el.npBg.addEventListener('load', () => { el.npBg.hidden = false; });

// ---------------------------------------------------------------- settings + layout
let opts = {};
let link = 'connecting';

let dirty = 0;
let frame = 0;
function mark(bits) {
  dirty |= bits;
  if (!frame && dirty) frame = requestAnimationFrame(render);
}

let phase = 'menu';
let mode = null;
let hitsMode = null;
const bases = new Map(); // `${profile}|${ruleset}` → session baseline {pp, rank}, first values seen by this source

function rect(node, x, y, w, h) {
  const s = node.style;
  s.left = `${x}px`; s.top = `${y}px`; s.width = `${w}px`;
  if (h !== undefined) s.height = `${h}px`;
}

function layout() {
  const corner = String(opts.camCorner);
  const right = !corner.endsWith('left');
  const top = !corner.startsWith('bottom');
  const camH = CAM_H[opts.camSize] ?? CAM_H.small;
  const gameX = right ? M : W - M - GAME_W;
  const sideX = right ? M + GAME_W + GAP : M;
  const camY = top ? M : H - M - camH;

  rect(el.game, gameX, M, GAME_W, GAME_H);
  rect(el.rail, gameX, M + GAME_H, GAME_W, GAP);
  el.deck.style.left = `${gameX}px`; el.deck.style.bottom = `${M}px`; el.deck.style.width = `${GAME_W}px`;
  rect(el.side, sideX, M, SIDE_W, H - 2 * M);
  el.cam.style.height = `${camH}px`;

  paintBackdrop(opts.showCam ? [[gameX, M, GAME_W, GAME_H], [sideX, camY, SIDE_W, camH]] : [[gameX, M, GAME_W, GAME_H]]);

  stage.dataset.cam = top ? 'top' : 'bottom';
  stage.dataset.guides = opts.showGuides ? 'on' : 'off';
  stage.dataset.frame = opts.showFrame ? 'on' : 'off';
  put(el.gameGuide, `GAME ${gameX},${M} · ${GAME_W}×${GAME_H}`);
  put(el.camGuide, `CAM ${sideX},${camY} · ${SIDE_W}×${camH}`);

  hide(el.cam, !opts.showCam);
  hide(el.caption, !opts.showCaption);
  stage.dataset.caption = opts.showCaption ? 'on' : 'off';
  hide(el.camGroup, !opts.showCam && !opts.showCaption);
  hide(el.player, !opts.showPlayer);
  hide(el.session, !opts.showSession);
  hide(el.rail, !opts.showStatus);
  hide(el.brand, !opts.showBrand);
  hide(el.np, !opts.showNowPlaying);
  hide(el.progress, !opts.showNowPlaying);
  put(el.social, str(opts.social));
  hide(el.social, !str(opts.social));
}

// The backdrop is painted once per layout/DPR change: graphite fill, an 8/64 px drafting grid, then
// the gameplay window and webcam slot cleared to fully transparent pixels.
const backdrop = el.backdrop.getContext('2d', { alpha: true });
let holes = [];
function paintBackdrop(next = holes) {
  holes = next;
  const dpr = window.devicePixelRatio || 1;
  const canvas = el.backdrop;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  backdrop.setTransform(dpr, 0, 0, dpr, 0, 0);
  backdrop.clearRect(0, 0, W, H);
  const kind = ['grid', 'solid', 'none'].includes(opts.backdrop) ? opts.backdrop : 'grid';
  if (kind === 'none') return;
  const tokens = getComputedStyle(document.documentElement);
  backdrop.fillStyle = tokens.getPropertyValue('--bg-sunken').trim() || '#0b0c0d';
  backdrop.fillRect(0, 0, W, H);
  if (kind === 'grid') {
    const half = 0.5 / dpr; // one device pixel, centred on the pixel grid
    for (const [step, colour] of [[8, '--grid-minor'], [64, '--grid-major']]) {
      backdrop.beginPath();
      for (let x = step; x < W; x += step) { backdrop.moveTo(x + half, 0); backdrop.lineTo(x + half, H); }
      for (let y = step; y < H; y += step) { backdrop.moveTo(0, y + half); backdrop.lineTo(W, y + half); }
      backdrop.lineWidth = 1 / dpr;
      backdrop.strokeStyle = tokens.getPropertyValue(colour).trim();
      backdrop.stroke();
    }
  }
  for (const [x, y, w, h] of holes) backdrop.clearRect(x, y, w, h);
}
addEventListener('resize', () => {
  if (el.backdrop.width !== Math.round(W * (window.devicePixelRatio || 1))) paintBackdrop();
});

settings({
  camCorner: 'top-right', camSize: 'small', handle: '', social: '', backdrop: 'grid',
  showCam: true, showCaption: true, showFrame: true, showNowPlaying: true, showPlay: true, showResults: true,
  showPlayer: true, showSession: true, showStatus: true, showBrand: true, showGuides: false,
}, next => {
  opts = next;
  layout();
  mark(ALL);
});

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

function render() {
  const bits = dirty;
  dirty = 0;
  const state = v(P.state);
  phase = state === 2 ? 'play' : state === 7 ? 'results' : 'menu';
  const number = state === 2 && Number.isInteger(v(P.playMode)) ? v(P.playMode)
    : state === 7 && Number.isInteger(v(P.rMode)) ? v(P.rMode) : v(P.selMode);
  mode = MODES[number] ?? null;
  if (bits & (STATUS | NP | PLAY | MENU | RESULTS)) renderPhase(state);
  if (bits & STATUS) renderStatus(state);
  if (bits & NP) renderMap();
  if (bits & PROGRESS) renderProgress();
  if (bits & PLAY && phase === 'play') renderPlay();
  if (bits & MENU && phase === 'menu') renderMenu();
  if (bits & RESULTS && phase === 'results') renderResults();
  if (bits & PLAYER) renderPlayer();
  if (bits & SESSION) renderSession();
  // renderResults may have recorded a result this frame; draw it now rather than next frame.
  if ((bits | dirty) & RECENT) { dirty &= ~RECENT; renderRecent(); }
  frame = 0;
  if (dirty) frame = requestAnimationFrame(render);
}

function renderPhase() {
  const shown = phase === 'results' ? opts.showResults : opts.showPlay;
  attr(stage, 'strip', shown ? phase : 'none');
  hide(el.strips, !shown);
  hide(el.deck, !shown && !opts.showNowPlaying);
  put(el.deckLabel, phase === 'play' ? 'Now playing' : phase === 'results' ? 'Result' : 'Selected');
}

const SOURCES = { player: 'Playing', replay: 'Replay', spectator: 'Spectating', autoplay: 'Autoplay', watching: 'Watching' };
const STATES = { 0: 'Main menu', 5: 'Song select', 7: 'Results', 11: 'Multiplayer' };

function renderStatus(state) {
  const known = Number.isInteger(state);
  attr(el.dot, 'status', link !== 'live' ? link : !known ? 'connecting' : phase === 'play' ? 'playing' : 'live');
  put(el.status, link === 'offline' ? 'vosu offline' : link === 'connecting' ? 'Connecting' : !known ? 'Waiting for osu!' : 'Live');
  put(el.phase, !known ? '' : state === 2 ? SOURCES[v(P.source)] ?? 'Playing' : STATES[state] ?? '');
  const keys = num(v(P.cs));
  put(el.ruleset, mode ? MODE_LABELS[mode] + (mode === 'mania' && keys ? ` · ${keys}K` : '') : '');
}

function clockRate() {
  return num(v(P.clockRate)) || num(v(P.rate)) || 1;
}

let shownChecksum = null;
function renderMap() {
  const title = str(v(P.title));
  put(el.npTitle, title || '—');
  put(el.npArtist, str(v(P.artist)));
  put(el.npVersion, str(v(P.version)));
  const mapper = str(v(P.mapper));
  put(el.npMapper, mapper ? `by ${mapper}` : '');

  const status = str(v(P.status)).toLowerCase();
  const showStatus = status && status !== 'unknown' && status !== 'notsubmitted';
  hide(el.npStatus, !showStatus);
  if (showStatus) { attr(el.npStatus, 'status', status); put(el.npStatus, status); }

  const checksum = str(v(P.checksum));
  if (checksum !== shownChecksum) {
    shownChecksum = checksum;
    el.npBg.hidden = true;
    if (checksum) el.npBg.src = backgroundUrl(checksum); else el.npBg.removeAttribute('src');
  }

  put(el.npStars, fixed(num(v(P.stars)), 2));
  put(el.npBpm, int(v(P.bpm)));
  if (mode === 'mania') { put(el.npK4, 'Keys'); put(el.npV4, num(v(P.cs)) ? `${v(P.cs)}K` : '—'); }
  else if (mode === 'taiko') { put(el.npK4, 'OD'); put(el.npV4, short(v(P.od))); }
  else { put(el.npK4, 'AR'); put(el.npV4, short(v(P.ar))); }
  const last = num(v(P.last));
  put(el.npLen, last ? formatDuration(last / clockRate()) : '—');
}

function renderProgress() {
  const first = num(v(P.first)), last = num(v(P.last)), live = num(v(P.live));
  const rate = clockRate();
  let f = 0;
  let now = '';
  if (phase === 'play' && last && live !== null) {
    f = Math.min(1, Math.max(0, (live - (first ?? 0)) / Math.max(1, last - (first ?? 0))));
    now = formatDuration(live / rate);
  } else if (phase === 'results' && last) {
    f = 1;
  }
  const transform = `scaleX(${f.toFixed(4)})`;
  if (el.npFill._t !== transform) { el.npFill._t = transform; el.npFill.style.transform = transform; }
  put(el.tNow, now);
  put(el.tTotal, last ? formatDuration(last / rate) : '—');
}

function renderMods(box, rateEl, list, rate) {
  const acronyms = Array.isArray(list) ? list.map(m => str(m?.acronym)).filter(Boolean) : null;
  const key = acronyms === null ? '' : acronyms.join(' ') || 'NM';
  if (box._key !== key) {
    box._key = key;
    box.replaceChildren(...(acronyms === null ? [] : (acronyms.length ? acronyms : ['NM']).slice(0, 6).map(text => {
      const chip = document.createElement('span');
      chip.textContent = text;
      if (!acronyms.length) chip.className = 'nm';
      return chip;
    })));
    if (acronyms === null) box.textContent = '—';
  }
  const r = num(rate);
  put(rateEl, r && Math.abs(r - 1) > 1e-3 ? `rate ${r.toFixed(2)}×` : '');
}

function renderPlay() {
  put(el.ppNow, int(v(P.ppNow)));
  put(el.ppFc, int(v(P.ppFc)));
  put(el.acc, fixed(num(v(P.acc)), 2));
  put(el.gradeNow, gradeLabel(grade(v(P.grade))) || '—');
  put(el.combo, int(v(P.combo)));
  put(el.comboMax, int(v(P.comboMax)));
  if (mode === 'fruits') {
    // Catch has no timing windows, so no UR: show fruit + drop misses (hits "0") instead.
    put(el.urK, 'Misses');
    put(el.ur, int(v(P.miss)));
    put(el.urS, 'fruits · drops');
  } else {
    const ur = num(v(P.ur));
    put(el.urK, 'UR');
    put(el.ur, ur ? ur.toFixed(1) : '—');
    put(el.urS, 'unstable rate');
  }
  renderMods(el.mods, el.rate, v(P.mods), v(P.rate));
}

function renderMenu() {
  const table = v(P.ppAcc);
  const at = key => int(table && typeof table === 'object' ? table[key] : undefined);
  put(el.pp100, at('100'));
  put(el.pp99, at('99'));
  put(el.pp98, at('98'));
  put(el.pp95, at('95'));
  put(el.menuCombo, int(v(P.mapCombo)));
  renderMods(el.menuMods, el.menuRate, v(P.mods), v(P.rate));
}

// Judgement rows per ruleset: [label, colour token, count(hits) → number | null (null hides the row)].
const at = key => hits => num(hits[key]);
// vosu reports catch raw (drops/droplets as large/small tick hits, missed droplets not exposed);
// tosu-shaped data uses 100/50/katu. Read whichever shape is present.
const ticks = (tick, legacy) => hits => (num(hits[tick]) || num(hits[legacy]) || 0);
const legacyCatch = hits => (num(hits.largeTickHits) || num(hits.smallTickHits) ? null : num(hits.katu));
const HITS = {
  osu: [['300', 'great', at('300')], ['100', 'good', at('100')], ['50', 'meh', at('50')], ['Miss', 'miss', at('0')], ['SB', 'meh', at('sliderBreaks')]],
  taiko: [['Great', 'great', at('300')], ['Ok', 'good', at('100')], ['Miss', 'miss', at('0')]],
  fruits: [['Fruit', 'great', at('300')], ['Drop', 'good', ticks('largeTickHits', '100')], ['Droplet', 'ok', ticks('smallTickHits', '50')], ['Miss', 'miss', at('0')], ['Dl miss', 'miss', legacyCatch]],
  mania: [['Max', 'max', at('geki')], ['300', 'great', at('300')], ['200', 'good', at('katu')], ['100', 'ok', at('100')], ['50', 'meh', at('50')], ['Miss', 'miss', at('0')]],
};
const hitCells = [];
function buildHits(rows) {
  el.rHits.replaceChildren();
  hitCells.length = 0;
  for (const [label, colour, count] of rows) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const value = document.createElement('b');
    name.textContent = label;
    li.style.setProperty('--c', `var(--j-${colour})`);
    value.textContent = '—';
    li.append(name, value);
    el.rHits.append(li);
    hitCells.push({ count, li, value });
  }
}

function renderResults() {
  const g = grade(v(P.rGrade));
  attr(el.rGrade, 'grade', g);
  put(el.rGrade, gradeLabel(g) || '—');
  put(el.rPp, int(v(P.rPp)));
  put(el.rFc, int(v(P.rFc)));
  put(el.rAcc, fixed(num(v(P.rAcc)), 2));
  put(el.rMods, str(v(P.rMods)) || 'NM');
  put(el.rCombo, int(v(P.rCombo)));
  put(el.rScore, int(v(P.rScore)));
  const rowsMode = mode ?? 'osu';
  if (rowsMode !== hitsMode) { hitsMode = rowsMode; buildHits(HITS[rowsMode]); }
  const hits = v(P.rHits);
  const known = hits && typeof hits === 'object';
  for (const cell of hitCells) {
    const count = known ? cell.count(hits) : null;
    hide(cell.li, known && count === null);
    put(cell.value, count === null ? '—' : intFmt.format(count));
    const zero = count === 0;
    if (cell.li._zero !== zero) { cell.li._zero = zero; cell.li.classList.toggle('zero', zero); }
  }
  record(g);
}

// ---------------------------------------------------------------- recent results (this source's lifetime)
const RECENT_MAX = 16;
const ROW_H = 44;
const recent = []; // newest first: {key, grade, title, detail, acc, pp}
let capacity = 0;
const rows = Array.from({ length: RECENT_MAX }, () => {
  const li = document.createElement('li');
  li.innerHTML = '<span class="g"></span><div class="t"><b></b><span></span></div><span class="a"></span><span class="p"><b></b><small>pp</small></span>';
  li.hidden = true;
  el.recent.append(li);
  const [g, t, a, p] = li.children;
  return { li, g, title: t.children[0], detail: t.children[1], acc: a, pp: p.children[0] };
});
new ResizeObserver(([entry]) => {
  const next = Math.min(RECENT_MAX, Math.max(0, Math.floor(entry.contentRect.height / ROW_H)));
  if (next !== capacity) { capacity = next; mark(RECENT); }
}).observe(el.recent);

/** Adds the result on screen once per attempt (keyed by vosu's session play count); later
 *  updates to the same result (pp settling after the screen opens) refresh that entry. */
function record(g) {
  const score = num(v(P.rScore));
  const player = str(v(P.rPlayer)), profile = str(v(P.name));
  if (!score || (player && profile && player !== profile)) return;
  const title = str(v(P.title));
  const key = `${v(P.sPlays)}|${score}|${title}|${str(v(P.version))}`;
  const entry = {
    key, grade: g, title: title || '—',
    detail: [str(v(P.version)), str(v(P.rMods)) || 'NM'].filter(Boolean).join(' · '),
    acc: fixed(num(v(P.rAcc)), 2), pp: int(v(P.rPp)),
  };
  if (recent[0]?.key === key) recent[0] = entry;
  else { recent.unshift(entry); if (recent.length > RECENT_MAX) recent.pop(); }
  mark(RECENT);
}

function renderRecent() {
  hide(el.recentEmpty, recent.length > 0 || capacity === 0);
  for (let i = 0; i < RECENT_MAX; i++) {
    const row = rows[i];
    const entry = i < capacity ? recent[i] : undefined;
    hide(row.li, !entry);
    if (!entry) continue;
    attr(row.g, 'grade', entry.grade);
    put(row.g, gradeLabel(entry.grade) || '—');
    put(row.title, entry.title);
    put(row.detail, entry.detail);
    put(row.acc, entry.acc === '—' ? '—' : `${entry.acc}%`);
    put(row.pp, entry.pp);
  }
}

function renderPlayer() {
  const name = str(v(P.name));
  put(el.pName, name || '—');
  put(el.handle, str(opts.handle) || name || '—');
  const country = str(v(P.country));
  put(el.pCountry, country ? country.toUpperCase() : '—');
  const profileMode = str(v(P.pMode));
  put(el.pMode, MODE_LABELS[profileMode] ?? '');
  const rank = num(v(P.pRank));
  put(el.pRank, rank ? intFmt.format(rank) : '—');
  put(el.pPp, int(v(P.pPp)));
  put(el.pAcc, fixed(num(v(P.pAcc)), 2));
  const level = num(v(P.level));
  put(el.pLevel, level === null ? '—' : String(Math.floor(level)));
  put(el.pPlays, int(v(P.pPlays)));
}

function renderSession() {
  put(el.sPlays, int(v(P.sPlays)));
  const time = num(v(P.sTime));
  put(el.sTime, time === null ? '—' : formatDuration(time));

  // One baseline per profile + ruleset, so switching rulesets mid-session keeps each one's gains.
  const name = str(v(P.name)), pp = num(v(P.pPp)), rank = num(v(P.pRank));
  const key = `${name}|${str(v(P.pMode))}`;
  if (name && pp && !bases.has(key)) bases.set(key, { pp, rank: rank || null });
  const base = name && pp !== null ? bases.get(key) : undefined;
  if (!base) {
    put(el.sPp, '—'); attr(el.sPp, 'sign', 'none');
    put(el.sRank, '—'); attr(el.sRank, 'sign', 'none');
    return;
  }
  const gained = pp - base.pp;
  const sign = Math.abs(gained) < 0.05 ? 'flat' : gained > 0 ? 'up' : 'down';
  attr(el.sPp, 'sign', sign);
  put(el.sPp, sign === 'flat' ? '±0' : `${gained > 0 ? '+' : '−'}${Math.abs(gained).toFixed(1)}`);
  if (rank && base.rank) {
    const moved = base.rank - rank;
    attr(el.sRank, 'sign', moved > 0 ? 'up' : moved < 0 ? 'down' : 'flat');
    put(el.sRank, moved > 0 ? `▲ ${intFmt.format(moved)}` : moved < 0 ? `▼ ${intFmt.format(-moved)}` : '±0');
  } else {
    if (rank && !base.rank) base.rank = rank;
    attr(el.sRank, 'sign', 'none');
    put(el.sRank, '—');
  }
}

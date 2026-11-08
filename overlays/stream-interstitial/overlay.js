// Copyright (c) 2026 18-LAB. MIT.
// Stream interstitial: starting soon / be right back / ending scene with a client-side
// countdown, the selected map (live from vosu) and the session summary.
//
// Nothing animates while idle. Data handlers format a field only when its raw value changed and
// only request a frame when a visible string changed; the countdown wakes once per displayed
// second, and a tick allocates nothing but its aria-label string.
import { subscribe, settings, fit, activeMode, formatDuration, backgroundUrl, MODE_LABELS } from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const RAISED = 32; // characters before the headline steps down a size
const LONG_TITLE = 34;

const SCENES = {
  'starting-soon': { index: '01', code: 'Pre-show', headline: 'Starting soon', subline: 'Warming up the hands', count: 'Starts in', done: 'Starting now', map: 'Up first', session: 'This session' },
  'be-right-back': { index: '02', code: 'Intermission', headline: 'Be right back', subline: 'Short break, stay tuned', count: 'Back in', done: 'Back any second', map: 'Up next', session: 'This session' },
  ending: { index: '03', code: 'Post-show', headline: 'Thanks for watching', subline: 'See you next stream', count: 'Ending in', done: 'Off air', map: 'Last map', session: 'Session total' },
};
const STATE_LABEL = { 2: 'Now playing', 7: 'Just played' };

const $ = id => document.getElementById(id);
const stage = $('stage');
const el = {
  sceneIndex: $('scene-index'), sceneCode: $('scene-code'), date: $('date'),
  status: $('status'), statusText: $('status-text'),
  headline: $('headline'), subline: $('subline'),
  countdown: $('countdown'), countdownLabel: $('countdown-label'), digits: $('digits'),
  rulerFill: $('ruler-fill'), rulerTicks: $('ruler-ticks'), rulerMax: $('ruler-max'),
  thumb: $('thumb'), mapCell: $('map-cell'), mapLabel: $('map-label'), mapMode: $('map-mode'), mapStatus: $('map-status'),
  mapTitle: $('map-title'), mapArtist: $('map-artist'), mapVersion: $('map-version'), mapMapper: $('map-mapper'),
  stars: $('v-stars'), starsUnit: $('v-stars-u'), bpm: $('v-bpm'), length: $('v-length'),
  sessionLabel: $('session-label'), plays: $('v-plays'),
  timeA: $('v-time-a'), timeUa: $('v-time-ua'), timeB: $('v-time-b'), timeUb: $('v-time-ub'),
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

fit(stage, W, H);

// ---------------------------------------------------------------- frame scheduling
// A fixed slot list instead of a Set: flushing must not allocate an iterator every frame.
let frame = 0;
const pending = new Array(16).fill(null);
let pendingCount = 0;
function schedule(task) {
  for (let i = 0; i < pendingCount; i++) if (pending[i] === task) return;
  pending[pendingCount++] = task;
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  // Tasks scheduled while flushing run in this pass too (Set iteration order, as before).
  for (let i = 0; i < pendingCount; i++) pending[i]();
  for (let i = 0; i < pendingCount; i++) pending[i] = null;
  pendingCount = 0;
}

const written = new WeakMap();
function text(node, value) {
  if (written.get(node) === value) return;
  written.set(node, value);
  node.textContent = value;
}
function flag(node, name, on) {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on);
}
function attr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

// ---------------------------------------------------------------- settings
const DEFAULTS = { scene: 'starting-soon', headline: '', subline: '', minutes: 5, showMap: true, showSession: true, backdrop: 'map' };
let config = { ...DEFAULTS };
let settingsCalls = 0;

function onSettings(next) {
  settingsCalls++;
  const previous = config;
  config = next;
  if (!SCENES[config.scene]) config.scene = DEFAULTS.scene;
  if (!['map', 'graphite', 'transparent'].includes(config.backdrop)) config.backdrop = DEFAULTS.backdrop;
  const minutes = Math.max(0, Math.min(600, config.minutes));
  // The countdown starts on load. vosu's first settings reply only corrects its length; a later
  // edit of the scene or the minutes restarts it from that moment.
  if (settingsCalls <= 2) setCountdown(minutes, loadedAt);
  else if (minutes !== countdown.minutes || config.scene !== previous.scene) setCountdown(minutes, performance.now());
  schedule(renderScene);
  schedule(renderMap);
}

function resolve(custom, fallback) {
  const value = custom.trim();
  if (value === '-') return '';
  return value || fallback;
}

function renderScene() {
  const scene = SCENES[config.scene];
  attr(stage, 'data-scene', config.scene);
  attr(stage, 'data-backdrop', config.backdrop);
  attr(stage, 'data-map', config.showMap ? 'on' : 'off');
  attr(stage, 'data-session', config.showSession ? 'on' : 'off');
  attr(stage, 'data-block', config.showMap || config.showSession ? 'on' : 'off');
  attr(stage, 'data-countdown', countdown.minutes > 0 ? 'on' : 'off');
  text(el.sceneIndex, scene.index);
  text(el.sceneCode, scene.code);
  const headline = resolve(config.headline, scene.headline) || scene.headline;
  text(el.headline, headline);
  flag(el.headline, 'data-long', headline.length > RAISED);
  const subline = resolve(config.subline, scene.subline);
  text(el.subline, subline);
  el.subline.hidden = !subline;
  text(el.sessionLabel, scene.session);
  renderCountdown();
}

// ---------------------------------------------------------------- countdown (client-side)
// Clock parts come from tables built once, so a tick formats nothing but its aria-label.
const NUM = Array.from({ length: 60 }, (_, n) => String(n));
const PAD2 = NUM.map(n => n.padStart(2, '0'));
const PAD2_COLON = PAD2.map(n => `${n}:`);
const NUM_COLON = NUM.map(n => `${n}:`);
const loadedAt = performance.now();
const countdown = {
  minutes: 0, startedAt: loadedAt, total: 0, seconds: -1, timer: 0,
  // Digit cells, rebuilt only when the shape changes: 0 = mm:ss, 1 = h:mm:ss, 2 = hh:mm:ss.
  shape: -1, count: 0, glyphs: [], motion: [], shown: new Int8Array(6), next: new Int8Array(6),
};
// Ruler fill transform as one reusable Typed OM value: a tick writes a number into it instead of
// formatting a `scaleX(…)` string.
const rulerScale = new CSSUnitValue(1, 'number');
const rulerTransform = new CSSTransformValue([new CSSScale(rulerScale, 1)]);

function setCountdown(minutes, startedAt) {
  countdown.minutes = minutes;
  countdown.startedAt = startedAt;
  countdown.total = minutes * 60000;
  countdown.seconds = -1;
  clearTimeout(countdown.timer);
  schedule(buildRuler);
  tick();
}

function tick() {
  countdown.timer = 0;
  if (countdown.total <= 0) return;
  const remaining = Math.max(0, countdown.startedAt + countdown.total - performance.now());
  const seconds = Math.ceil(remaining / 1000);
  if (seconds !== countdown.seconds) {
    countdown.seconds = seconds;
    schedule(renderCountdown);
  }
  // Wake exactly when the displayed second turns over; stop at zero.
  if (seconds > 0) countdown.timer = setTimeout(tick, remaining - (seconds - 1) * 1000 + 5);
}

function buildDigits(shape) {
  countdown.shape = shape;
  const count = 4 + shape;
  countdown.count = count;
  el.digits.replaceChildren();
  for (let i = 0; i < count; i++) {
    if (i === count - 2 || (shape && i === count - 4)) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ':';
      el.digits.append(sep);
    }
    const span = document.createElement('span');
    const glyph = document.createTextNode('');
    span.append(glyph);
    el.digits.append(span);
    countdown.glyphs[i] = glyph;
    // One reusable Animation per cell; Element.animate() would build a new one every tick.
    countdown.motion[i] = new Animation(new KeyframeEffect(span, DIGIT_IN, DIGIT_TIMING), document.timeline);
    countdown.shown[i] = -1;
  }
  flag(el.digits, 'data-hours', shape > 0);
}

function renderCountdown() {
  if (countdown.minutes <= 0 || countdown.seconds < 0) return;
  const scene = SCENES[config.scene];
  const seconds = countdown.seconds;
  const done = seconds === 0;
  flag(el.countdown, 'data-done', done);
  text(el.countdownLabel, done ? scene.done : scene.count);
  // Exact integer divisions keep every intermediate a small integer (no boxed doubles).
  const s = seconds % 60;
  const minutes = (seconds - s) / 60;
  const m = minutes % 60;
  const h = (minutes - m) / 60;
  const shape = h === 0 ? 0 : h < 10 ? 1 : 2;
  if (shape !== countdown.shape) buildDigits(shape);
  const next = countdown.next;
  let n = countdown.count;
  next[--n] = s % 10;
  next[--n] = (s - (s % 10)) / 10;
  next[--n] = m % 10;
  next[--n] = (m - (m % 10)) / 10;
  if (shape) next[--n] = h % 10;
  if (shape === 2) next[--n] = (h - (h % 10)) / 10;
  const animate = !reducedMotion.matches && !stage.hasAttribute('data-enter');
  for (let i = 0; i < countdown.count; i++) {
    const digit = next[i];
    if (countdown.shown[i] === digit) continue;
    countdown.shown[i] = digit;
    countdown.glyphs[i].data = NUM[digit];
    if (animate) {
      const motion = countdown.motion[i];
      motion.cancel();
      motion.play();
    }
  }
  // The one string a tick allocates.
  el.digits.setAttribute('aria-label', h ? NUM_COLON[h] + PAD2_COLON[m] + PAD2[s] : PAD2_COLON[m] + PAD2[s]);
  rulerScale.value = (seconds * 1000) / countdown.total;
  el.rulerFill.attributeStyleMap.set('transform', rulerTransform);
}
const DIGIT_IN = [{ transform: 'translateY(-0.08em)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
const DIGIT_TIMING = { duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };

const RULER_W = 560;
function buildRuler() {
  const { minutes } = countdown;
  el.rulerTicks.replaceChildren();
  if (minutes <= 0) return;
  const step = minutes <= 15 ? 1 : minutes <= 60 ? 5 : minutes <= 180 ? 15 : 60;
  for (let m = 0; m <= minutes; m += step) {
    const tick = document.createElement('i');
    tick.style.left = `${Math.min(RULER_W - 1, Math.round((m / minutes) * RULER_W))}px`;
    if (m === 0) tick.className = 'major';
    el.rulerTicks.append(tick);
  }
  const end = document.createElement('i');
  end.className = 'major';
  end.style.left = `${RULER_W - 1}px`;
  el.rulerTicks.append(end);
  text(el.rulerMax, minutes % 1 ? formatDuration(minutes * 60000) : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`);
}

// ---------------------------------------------------------------- date (sheet stamp)
function stampDate() {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  text(el.date, iso);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  setTimeout(() => schedule(stampDate), midnight - now);
}
schedule(stampDate);

// ---------------------------------------------------------------- live data
const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  checksum: '/beatmap/checksum', title: '/beatmap/title', artist: '/beatmap/artist', version: '/beatmap/version',
  mapper: '/beatmap/mapper', status: '/beatmap/status/name', stars: '/beatmap/stats/stars/total',
  bpm: '/beatmap/stats/bpm/common', length: '/beatmap/time/lastObject',
  playTime: '/session/playTime', playCount: '/session/playCount',
};

// Formatted view of the vosu values. The socket handler fills it; render() writes it.
const view = {
  state: undefined, mode: '', checksum: '', hasMap: false,
  title: '—', artist: '', version: '', mapper: '', status: '',
  stars: '—', bpm: '—', length: '—',
  plays: '—', timeA: '—', timeUa: '', timeB: '', timeUb: '',
};
let mapDirty = false;
let sessionDirty = false;

function set(key, value, kind) {
  if (view[key] === value) return;
  view[key] = value;
  if (kind === 'map') mapDirty = true; else sessionDirty = true;
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const word = value => (typeof value === 'string' ? value.trim() : '');

function statusName(name) {
  const value = word(name);
  if (!value || /^(unknown|notsubmitted|unsubmitted)$/i.test(value)) return '';
  return value.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// Session playtime parts, from the clock tables; formatted only when the shown second changes.
let shownPlaySecond = NaN;
function playtime(ms) {
  // Remainder arithmetic keeps integral playtimes in small integers (no boxed quotient).
  const total = finite(ms) && ms >= 0 ? (ms - (ms % 1000)) / 1000 : -1;
  if (total === shownPlaySecond) return;
  shownPlaySecond = total;
  if (total < 0) {
    set('timeA', '—', 'session'); set('timeUa', '', 'session'); set('timeB', '', 'session'); set('timeUb', '', 'session');
    return;
  }
  const s = total % 60;
  const minutes = (total - s) / 60;
  const m = minutes % 60;
  const h = (minutes - m) / 60;
  if (h) {
    set('timeA', h < 60 ? NUM[h] : String(h), 'session'); set('timeUa', 'h', 'session'); set('timeB', PAD2[m], 'session'); set('timeUb', 'm', 'session');
  } else {
    set('timeA', NUM[m], 'session'); set('timeUa', 'm', 'session'); set('timeB', PAD2[s], 'session'); set('timeUb', 's', 'session');
  }
}

// Last raw value per formatted field: numbers and statuses are formatted only when they change.
// Plain `let`s, not object fields: a double-typed field would box a fresh number on every read.
let rawStatus = NaN;
let rawStars = NaN;
let rawBpm = NaN;
let rawLength = NaN;
let rawPlayCount = NaN;

function onData(values, changed) {
  if (changed.has(P.state) || changed.has(P.playMode) || changed.has(P.settingsMode)) {
    set('state', values[P.state], 'map');
    const mode = activeMode(values[P.state], values[P.playMode], values[P.settingsMode]);
    set('mode', mode ? MODE_LABELS[mode] : '', 'map');
  }
  if (changed.has(P.title) || changed.has(P.checksum)) {
    const title = word(values[P.title]);
    const checksum = word(values[P.checksum]);
    set('hasMap', Boolean(title || checksum), 'map');
    set('checksum', checksum, 'map');
    set('title', title || '—', 'map');
  }
  if (changed.has(P.artist)) set('artist', word(values[P.artist]), 'map');
  if (changed.has(P.version)) set('version', word(values[P.version]), 'map');
  if (changed.has(P.mapper)) set('mapper', word(values[P.mapper]), 'map');
  if (changed.has(P.status) && values[P.status] !== rawStatus) {
    rawStatus = values[P.status];
    set('status', statusName(rawStatus), 'map');
  }
  if (changed.has(P.stars) && values[P.stars] !== rawStars) {
    const stars = (rawStars = values[P.stars]);
    set('stars', finite(stars) && stars > 0 ? stars.toFixed(2) : '—', 'map');
  }
  if (changed.has(P.bpm) && values[P.bpm] !== rawBpm) {
    const bpm = (rawBpm = values[P.bpm]);
    set('bpm', finite(bpm) && bpm > 0 ? String(Math.round(bpm)) : '—', 'map');
  }
  if (changed.has(P.length) && values[P.length] !== rawLength) {
    const length = (rawLength = values[P.length]);
    set('length', finite(length) && length > 0 ? formatDuration(length) : '—', 'map');
  }

  if (changed.has(P.playTime) || changed.has(P.playCount)) {
    if (values[P.playCount] !== rawPlayCount) {
      const count = (rawPlayCount = values[P.playCount]);
      set('plays', finite(count) && count >= 0 ? String(count) : '—', 'session');
    }
    playtime(values[P.playTime]);
  }
  if (mapDirty) schedule(renderMap);
  if (sessionDirty) schedule(renderSession);
}

let statusState = '';
function status(state) {
  if (state === statusState) return;
  statusState = state;
  schedule(renderStatus);
}
function renderStatus() {
  el.status.hidden = statusState === 'live';
  attr(el.status, 'data-state', statusState);
  text(el.statusText, statusState === 'offline' ? 'vosu offline' : 'Connecting to vosu');
}

function renderMap() {
  mapDirty = false;
  const scene = SCENES[config.scene];
  text(el.mapLabel, config.scene === 'ending' && view.state !== 2 ? scene.map : STATE_LABEL[view.state] || scene.map);
  flag(el.mapCell, 'data-nomap', !view.hasMap);
  text(el.mapTitle, view.title);
  flag(el.mapTitle, 'data-long', view.title.length > LONG_TITLE);
  text(el.mapArtist, view.artist);
  text(el.mapVersion, view.version);
  text(el.mapMapper, view.mapper ? `${view.version ? '  ·  ' : ''}mapped by ${view.mapper}` : '');
  text(el.mapMode, view.hasMap ? view.mode : '');
  el.mapMode.hidden = !view.hasMap || !view.mode;
  text(el.mapStatus, view.status);
  el.mapStatus.hidden = !view.hasMap || !view.status;
  text(el.stars, view.stars);
  text(el.starsUnit, view.stars === '—' ? '' : '★');
  text(el.bpm, view.bpm);
  text(el.length, view.length);
  syncBackdrop();
}

function renderSession() {
  sessionDirty = false;
  text(el.plays, view.plays);
  text(el.timeA, view.timeA);
  text(el.timeUa, view.timeUa);
  text(el.timeB, view.timeB);
  text(el.timeUb, view.timeUb);
}

// ---------------------------------------------------------------- map backgrounds (crossfade)
function crossfader(images, onEmpty) {
  let url = '';
  let front = 0;
  let token = 0;
  for (const image of images) image.addEventListener('dragstart', event => event.preventDefault());
  return next => {
    if (next === url) return;
    url = next;
    const ticket = ++token;
    if (!next) {
      for (const image of images) image.removeAttribute('data-on');
      onEmpty(true);
      return;
    }
    const back = images[front ^ 1];
    back.onload = () => {
      if (ticket !== token) return;
      schedule(() => {
        if (ticket !== token) return;
        back.setAttribute('data-on', '');
        images[front].removeAttribute('data-on');
        front ^= 1;
        onEmpty(false);
      });
    };
    back.onerror = () => {
      if (ticket !== token) return;
      schedule(() => {
        for (const image of images) image.removeAttribute('data-on');
        onEmpty(true);
      });
    };
    back.src = next;
  };
}

const backdropImages = crossfader([...document.querySelectorAll('.backdrop__img')], () => {});
const thumbImages = crossfader([...document.querySelectorAll('.thumb__img')], empty => flag(el.thumb, 'data-empty', empty));

function syncBackdrop() {
  const url = view.hasMap && view.checksum ? backgroundUrl(view.checksum) : '';
  backdropImages(config.backdrop === 'map' ? url : '');
  thumbImages(config.showMap ? url : '');
}

// ---------------------------------------------------------------- entrance, once
const enter = () => requestAnimationFrame(() => requestAnimationFrame(() => stage.removeAttribute('data-enter')));
Promise.race([document.fonts.ready, new Promise(done => setTimeout(done, 800))]).then(enter);

// ---------------------------------------------------------------- start
settings(DEFAULTS, onSettings);
subscribe(Object.values(P), onData, { onStatus: status });

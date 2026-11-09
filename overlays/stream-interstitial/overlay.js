// Copyright (c) 2026 18-LAB. MIT.
// Stream interstitial: starting soon / be right back / ending scene with a client-side
// countdown, the selected map (live from vosu) and the session summary.
//
// Nothing animates while idle. Data handlers format a field only when its raw value changed and
// only request a frame when a visible string changed; the countdown wakes once per displayed
// second and a tick allocates nothing. Motion (docs/overlay-system.md, "Motion"): the countdown's
// colon lifts on the selected map's beat while its music runs (/json/sc; kiai only without it),
// the map backdrop breathes through kiai, digits roll in, the map identity fades in on a map
// change, and the sheet enters once. Beat and kiai motion stop as soon as the map clock stops.
import {
  subscribe, settings, fit, activeMode, formatDuration, backgroundUrl, MODE_LABELS,
  known, isKnown, DASH, numberFormatter, createMapClock, createBeatClock,
  applyKitSettings, MOTION_MS, mapPalette, applyPalette,
} from './vosu-overlay.js';

const W = 1920;
const H = 1080;
const RAISED = 32; // characters before the headline steps down a size
const LONG_TITLE = 34;
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'; // --ease-out
// The map clock counts as running while samples keep arriving; past this it has stopped (paused,
// frozen, the data stopped), and beat and kiai motion wind down.
const STALE_MS = 250;

const SCENES = {
  'starting-soon': { index: '01', code: 'Pre-show', headline: 'Starting soon', subline: 'Warming up the hands', count: 'Starts in', done: 'Starting now', map: 'Up first', session: 'This session' },
  'be-right-back': { index: '02', code: 'Intermission', headline: 'Be right back', subline: 'Short break, stay tuned', count: 'Back in', done: 'Back any second', map: 'Up next', session: 'This session' },
  ending: { index: '03', code: 'Post-show', headline: 'Thanks for watching', subline: 'See you next stream', count: 'Ending in', done: 'Off air', map: 'Last map', session: 'Session total' },
};
const STATE_LABEL = { 2: 'Now playing', 7: 'Just played' };
const BACKDROPS = ['map', 'graphite', 'transparent'];

const $ = id => document.getElementById(id);
const stage = $('stage');
const sheet = $('sheet');
const el = {
  sceneIndex: $('scene-index'), sceneCode: $('scene-code'), date: $('date'), status: $('status'),
  headline: $('headline'), subline: $('subline'),
  countdown: $('countdown'), countdownLabel: $('countdown-label'), digits: $('digits'),
  rulerFill: $('ruler-fill'), rulerTicks: $('ruler-ticks'), rulerMax: $('ruler-max'),
  scrim: $('scrim'),
  thumb: $('thumb'), mapCell: $('map-cell'), mapHead: $('map-head'), mapLabel: $('map-label'), mapMeta: $('map-meta'),
  mapTitle: $('map-title'), mapArtist: $('map-artist'), mapVersion: $('map-version'), mapMapper: $('map-mapper'),
  statStars: $('stat-stars'), statBpm: $('stat-bpm'), statLength: $('stat-length'),
  rStars: $('r-stars'), rBpm: $('r-bpm'), rLength: $('r-length'), rPlays: $('r-plays'), rTime: $('r-time'),
  stars: $('v-stars'), bpm: $('v-bpm'), length: $('v-length'),
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
  // Tasks scheduled while flushing run in this pass too.
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
// One reusable Animation per animated element: Element.animate() would build a new one per event.
function animation(node, keyframes, timing) {
  return new Animation(new KeyframeEffect(node, keyframes, timing), document.timeline);
}
function restart(motion) {
  motion.currentTime = 0;
  motion.play();
}
const entering = () => stage.hasAttribute('data-enter');

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  scene: 'starting-soon', headline: '', subline: '', minutes: 5, showMap: true, showSession: true, backdrop: 'map',
  motion: 'full', backing: 'scrim', mapTint: true,
};
let config = { ...DEFAULTS };
let motion = 'full'; // the applied level: full | reduced | off
let settingsCalls = 0;

function onSettings(next) {
  settingsCalls++;
  const previous = config;
  config = next;
  if (!SCENES[config.scene]) config.scene = DEFAULTS.scene;
  if (!BACKDROPS.includes(config.backdrop)) config.backdrop = DEFAULTS.backdrop;
  // The OS reduced-motion preference caps `full` at `reduced`.
  const wanted = config.motion === 'full' && reducedMotion.matches ? 'reduced' : config.motion;
  // The map and graphite backdrops are the scene's backing (a dark field under all text); the
  // kit backing only applies over the streamer's own background (transparent). `none` adds the
  // kit's contrast shadow, which is invisible on the dark backdrops.
  motion = applyKitSettings(sheet, { motion: wanted, backing: config.backdrop === 'transparent' ? config.backing : 'none', mapTint: config.mapTint });
  const minutes = Math.max(0, Math.min(600, config.minutes));
  // The countdown starts on load. vosu's first settings reply only corrects its length; a later
  // edit of the scene or the minutes restarts it from that moment.
  if (settingsCalls <= 2) setCountdown(minutes, loadedAt);
  else if (minutes !== countdown.minutes || config.scene !== previous.scene) setCountdown(minutes, performance.now());
  syncPalette();
  syncAmbient();
  if (motion !== 'full') stopBeat();
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
// Clock parts come from tables built once, so a tick formats nothing.
const NUM = Array.from({ length: 60 }, (_, n) => String(n));
const PAD2 = NUM.map(n => n.padStart(2, '0'));
const loadedAt = performance.now();
const countdown = {
  minutes: 0, startedAt: loadedAt, total: 0, seconds: -1, timer: 0,
  // Digit cells, rebuilt only when the shape changes: 0 = mm:ss, 1 = h:mm:ss, 2 = hh:mm:ss.
  shape: -1, count: 0, glyphs: [], roll: [], shown: new Int8Array(6), next: new Int8Array(6),
  // The colons and their beat lifts.
  beats: [],
};
// Ruler fill transform as one reusable Typed OM value: a tick writes a number into it instead of
// formatting a `scaleX(…)` string.
const rulerScale = new CSSUnitValue(1, 'number');
const rulerTransform = new CSSTransformValue([new CSSScale(rulerScale, 1)]);
// A digit rolls in from above when it changes (a value settling: kept under `reduced`).
const DIGIT_IN = [{ transform: 'translateY(-0.08em)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
const DIGIT_TIMING = { duration: MOTION_MS.base, easing: EASE_OUT };
// The colon lifts to full on a beat and settles back to its resting 0.5 (style.css) within it.
const BEAT_LIFT = [{ opacity: 1 }, { opacity: 0.5 }];
const BEAT_TIMING = { duration: MOTION_MS.base, easing: EASE_OUT };

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
  countdown.beats.length = 0;
  el.digits.replaceChildren();
  for (let i = 0; i < count; i++) {
    if (i === count - 2 || (shape && i === count - 4)) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ':';
      el.digits.append(sep);
      countdown.beats.push(animation(sep, BEAT_LIFT, BEAT_TIMING));
    }
    const span = document.createElement('span');
    const glyph = document.createTextNode('');
    span.append(glyph);
    el.digits.append(span);
    countdown.glyphs[i] = glyph;
    countdown.roll[i] = animation(span, DIGIT_IN, DIGIT_TIMING);
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
  const roll = motion !== 'off' && !entering();
  for (let i = 0; i < countdown.count; i++) {
    const digit = next[i];
    if (countdown.shown[i] === digit) continue;
    countdown.shown[i] = digit;
    countdown.glyphs[i].data = NUM[digit];
    if (roll) restart(countdown.roll[i]);
  }
  rulerScale.value = (seconds * 1000) / countdown.total;
  el.rulerFill.attributeStyleMap.set('transform', rulerTransform);
}

const RULER_W = 560;
function buildRuler() {
  const { minutes } = countdown;
  el.rulerTicks.replaceChildren();
  if (minutes <= 0) return;
  const step = minutes <= 15 ? 1 : minutes <= 60 ? 5 : minutes <= 180 ? 15 : 60;
  for (let m = 0; m <= minutes; m += step) {
    const mark = document.createElement('i');
    mark.style.left = `${Math.min(RULER_W - 1, Math.round((m / minutes) * RULER_W))}px`;
    if (m === 0) mark.className = 'major';
    el.rulerTicks.append(mark);
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
  bpm: '/beatmap/stats/bpm/realtime', bpmCommon: '/beatmap/stats/bpm/common', kiai: '/beatmap/isKiai',
  live: '/beatmap/time/live', rate: '/beatmap/time/rate', first: '/beatmap/time/firstObject',
  last: '/beatmap/time/lastObject', mp3: '/beatmap/time/mp3Length',
  playTime: '/session/playTime', playCount: '/session/playCount',
};

// Formatted view of the vosu values. The socket handler fills it; render() writes it.
const view = {
  state: undefined, mode: '', checksum: '', hasMap: false,
  title: DASH, artist: '', version: '', mapper: '', status: '',
  stars: DASH, bpm: DASH, length: DASH,
  plays: DASH, timeA: DASH, timeUa: '', timeB: '', timeUb: '',
};
let mapDirty = false;
let sessionDirty = false;

function set(key, value, kind) {
  if (view[key] === value) return;
  view[key] = value;
  if (kind === 'map') mapDirty = true; else sessionDirty = true;
}

const word = value => (typeof value === 'string' ? value.trim() : '');

function statusName(name) {
  const value = word(name);
  if (!value || /^(unknown|notsubmitted|unsubmitted)$/i.test(value)) return '';
  if (value === value.toUpperCase()) return value; // WIP
  // Sentence case: "ranked" / "Ranked" → "Ranked", "NotSubmitted"-style → "Not submitted".
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced[0].toUpperCase() + spaced.slice(1);
}

// Shared computations (vosu-overlay.js), so these agree with now-playing and strain-graph.
const formatStars = numberFormatter('stars');
const formatBpm = numberFormatter('bpm');
const formatPlays = numberFormatter('count');
const mapClock = createMapClock();

// Session playtime parts, from the clock tables; formatted only when the shown second changes.
let shownPlaySecond = NaN;
function playtime(ms) {
  const value = known(ms);
  // Remainder arithmetic keeps integral playtimes in small integers (no boxed quotient).
  const total = isKnown(value) && value >= 0 ? (value - (value % 1000)) / 1000 : -1;
  if (total === shownPlaySecond) return;
  shownPlaySecond = total;
  if (total < 0) {
    set('timeA', DASH, 'session'); set('timeUa', '', 'session'); set('timeB', '', 'session'); set('timeUb', '', 'session');
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

// Last raw value per formatted field: statuses and lengths are formatted only when they change.
// Plain `let`s, not object fields: a double-typed field would box a fresh number on every read.
let rawStatus = NaN;
let shownTotal = NaN;

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
    set('title', title || DASH, 'map');
    beat.setMap(checksum);
  }
  if (changed.has(P.artist)) set('artist', word(values[P.artist]), 'map');
  if (changed.has(P.version)) set('version', word(values[P.version]), 'map');
  if (changed.has(P.mapper)) set('mapper', word(values[P.mapper]), 'map');
  if (changed.has(P.status) && values[P.status] !== rawStatus) {
    rawStatus = values[P.status];
    set('status', statusName(rawStatus), 'map');
  }
  if (changed.has(P.stars)) set('stars', formatStars(known(values[P.stars], true)), 'map');
  if (changed.has(P.bpm) || changed.has(P.bpmCommon)) {
    const realtime = known(values[P.bpm], true);
    set('bpm', formatBpm(isKnown(realtime) ? realtime : known(values[P.bpmCommon], true)), 'map');
  }

  // Map clock: the play span (Length) and, while the music runs, the beat and kiai motion.
  const timing = changed.has(P.rate) || changed.has(P.first) || changed.has(P.last) || changed.has(P.mp3);
  if (timing || changed.has(P.live)) {
    mapClock.sample(values[P.live], values[P.rate], values[P.first], values[P.last], values[P.mp3], performance.now());
    if (timing) {
      const total = mapClock.total();
      const seconds = isKnown(total) ? Math.floor(total / 1000) : -1;
      if (seconds !== shownTotal) {
        shownTotal = seconds;
        set('length', seconds >= 0 ? formatDuration(total) : DASH, 'map');
      }
    }
    if (!beatTimer) armBeat();
  }
  if (changed.has(P.kiai)) beat.setKiai(values[P.kiai]);
  if (beat.kiai !== breathing) syncAmbient();

  if (changed.has(P.playTime) || changed.has(P.playCount)) {
    set('plays', formatPlays(known(values[P.playCount])), 'session');
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
  flag(el.status, 'data-out', statusState === 'live');
  if (statusState !== 'live') text(el.status, statusState === 'offline' ? 'vosu offline' : 'Connecting to vosu');
}

// ---------------------------------------------------------------- map identity
// A map change fades the map's cells in (the identity fade); a new state label (up first → now
// playing → just played) fades the cell head in. Enter motion: kept under `reduced`.
const ENTER = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }];
const MAP_TIMING = { duration: MOTION_MS.slow, easing: EASE_OUT };
const HEAD_TIMING = { duration: MOTION_MS.base, easing: EASE_OUT };
const mapIn = [el.mapCell, el.statStars, el.statBpm, el.statLength].map(node => animation(node, ENTER, MAP_TIMING));
const headIn = animation(el.mapHead, ENTER, HEAD_TIMING);
let shownChecksum = null;

function renderMap() {
  mapDirty = false;
  const scene = SCENES[config.scene];
  const label = config.scene === 'ending' && view.state !== 2 ? scene.map : STATE_LABEL[view.state] || scene.map;
  const animate = motion !== 'off' && !entering() && config.showMap;
  if (view.checksum !== shownChecksum) {
    if (animate && shownChecksum !== null) for (let i = 0; i < mapIn.length; i++) restart(mapIn[i]);
    shownChecksum = view.checksum;
  } else if (animate && written.has(el.mapLabel) && written.get(el.mapLabel) !== label) restart(headIn);
  text(el.mapLabel, label);
  flag(el.mapCell, 'data-nomap', !view.hasMap);
  text(el.mapTitle, view.title);
  flag(el.mapTitle, 'data-long', view.title.length > LONG_TITLE);
  text(el.mapArtist, view.artist);
  text(el.mapVersion, view.version);
  text(el.mapMapper, view.mapper ? `${view.version ? '  ·  ' : ''}mapped by ${view.mapper}` : '');
  const mode = view.hasMap ? view.mode : '';
  const state = view.hasMap ? view.status : '';
  text(el.mapMeta, mode && state ? `${mode} · ${state}` : mode || state);
  text(el.stars, view.stars);
  flag(el.rStars, 'data-unknown', view.stars === DASH);
  text(el.bpm, view.bpm);
  flag(el.rBpm, 'data-unknown', view.bpm === DASH);
  text(el.length, view.length);
  flag(el.rLength, 'data-unknown', view.length === DASH);
  syncBackdrop();
}

function renderSession() {
  sessionDirty = false;
  text(el.plays, view.plays);
  flag(el.rPlays, 'data-unknown', view.plays === DASH);
  text(el.timeA, view.timeA);
  text(el.timeUa, view.timeUa);
  text(el.timeB, view.timeB);
  text(el.timeUb, view.timeUb);
  flag(el.rTime, 'data-unknown', view.timeA === DASH);
}

// Map tint: the title block's top rule and the star follow the map (--map); neutral when off.
let paletteFor = '';
function syncPalette() {
  const wanted = config.mapTint && view.hasMap ? view.checksum : '';
  if (wanted === paletteFor) return;
  paletteFor = wanted;
  if (!wanted) { applyPalette(sheet, null); return; }
  mapPalette(wanted).then(palette => { if (paletteFor === wanted) applyPalette(sheet, palette); });
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
  syncPalette();
}

// ---------------------------------------------------------------- beat (motion: full)
// While the selected map's music runs (song-select preview or play), each beat lifts the
// countdown's colon. One timer per beat, armed from the map clock; it is not re-armed once the
// clock stops, so a paused or frozen map costs nothing. Without /json/sc (tosu, the replay
// renderer) there is no beat and nothing pulses.
const beat = createBeatClock({ onChange: () => armBeat() });
let beatTimer = 0;
let lastBeat = NaN;

function clockRunning() {
  return mapClock.moving && performance.now() - mapClock.sampledAt < STALE_MS;
}

function armBeat() {
  if (beatTimer || motion !== 'full' || countdown.beats.length === 0 || countdown.minutes <= 0) return;
  if (!clockRunning() || !beat.at(mapClock.now(performance.now()))) return;
  // Beats until the next one we have not lifted for (a timer can fire a hair early).
  const position = beat.index + beat.phase;
  const target = beat.index + 1 === lastBeat ? beat.index + 2 : beat.index + 1;
  beatTimer = setTimeout(onBeat, ((target - position) * beat.beatLength) / mapClock.rate);
}

function onBeat() {
  beatTimer = 0;
  if (motion !== 'full' || !clockRunning() || !beat.at(mapClock.now(performance.now()))) return;
  // The beat this timer was for: the one just started, or the next if the timer ran early.
  const index = beat.phase > 0.5 ? beat.index + 1 : beat.index;
  if (index !== lastBeat) {
    lastBeat = index;
    if (!entering()) for (let i = 0; i < countdown.beats.length; i++) restart(countdown.beats[i]);
  }
  armBeat();
}

function stopBeat() {
  clearTimeout(beatTimer);
  beatTimer = 0;
}

// ---------------------------------------------------------------- kiai (motion: full, map backdrop)
// Through a kiai section of the running map the backdrop's dim lightens and returns on the
// ambient period (--dur-ambient); when kiai ends it finishes the breath back to rest instead of
// snapping. Off as soon as the map clock stops (checked twice a second while breathing).
const BREATH = [{ opacity: 1 }, { opacity: 0.8 }];
const breath = animation(el.scrim, BREATH, { duration: MOTION_MS.ambient, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
const BREATH_FOREVER = { iterations: Infinity };
let breathing = false;
let ambientTimer = 0;

function syncAmbient() {
  const allowed = motion === 'full' && config.backdrop === 'map';
  const want = allowed && beat.kiai && clockRunning();
  if (want !== breathing) {
    breathing = want;
    if (want) {
      breath.effect.updateTiming(BREATH_FOREVER);
      if (breath.playState !== 'running') restart(breath);
    } else if (!allowed) breath.cancel();
    else if (breath.playState === 'running') {
      // Alternate iterations: even ones dim, odd ones return. End after the next odd one.
      const current = breath.effect.getComputedTiming().currentIteration;
      breath.effect.updateTiming({ iterations: current % 2 ? current + 1 : current + 2 });
    }
  } else if (!allowed && breath.playState === 'running') breath.cancel();
  if (breathing && !ambientTimer) ambientTimer = setTimeout(checkAmbient, 500);
}
function checkAmbient() {
  ambientTimer = 0;
  syncAmbient();
}

// ---------------------------------------------------------------- entrance, once
const enter = () => requestAnimationFrame(() => requestAnimationFrame(() => stage.removeAttribute('data-enter')));
Promise.race([document.fonts.ready, new Promise(done => setTimeout(done, 800))]).then(enter);

// ---------------------------------------------------------------- start
settings(DEFAULTS, onSettings);
subscribe(Object.values(P), onData, { onStatus: status });

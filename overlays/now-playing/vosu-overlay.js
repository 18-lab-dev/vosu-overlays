// Copyright (c) 2026 18-LAB. MIT.
// Shared vosu client for the official overlays. Source of truth: shared/vosu-overlay.js.
// Every overlay folder carries a byte-identical copy because packages must be
// self-contained; edit the shared file and run `python scripts/sync_shared.py`.

const PLAYING = 2;
const MAX_BACKOFF = 10000;

function socketUrl(path) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

function backoff(attempt) {
  return Math.min(MAX_BACKOFF, 400 * 2 ** Math.min(attempt, 5)) + Math.random() * 250;
}

/**
 * Follows selected v2 fields through `/websocket/v2/subscribe` (JSON Pointers, e.g.
 * `/play/combo/current`). vosu only samples fast readers for fields someone selected,
 * so select narrow leaves rather than `/play` or the whole document.
 *
 * `onFrame(values, changed)`: `values` maps each pointer to its value (`undefined` when vosu
 * reports it absent); `changed` is the Set of pointers this frame touched (all on a snapshot).
 * Both objects are reused for every frame, so read them inside the callback and keep neither.
 * `onStatus(state, detail)`: state is `connecting`, `live` or `offline`.
 * Returns `{ values, close() }`.
 */
export function subscribe(pointers, onFrame, { onStatus = () => {} } = {}) {
  const values = Object.fromEntries(pointers.map(pointer => [pointer, undefined]));
  let socket = null;
  let attempt = 0;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    onStatus('connecting', 'Connecting to vosu…');
    socket = new WebSocket(socketUrl('/websocket/v2/subscribe'));
    socket.onopen = () => socket.send(JSON.stringify(pointers));
    // One Set for the socket's lifetime: a message arrives every few milliseconds during play,
    // and parsing the text is the only allocation a frame cannot avoid.
    const changed = new Set();
    socket.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 2) {
        onStatus('offline', `vosu refused the subscription: ${frame[2]}`);
        return;
      }
      if (frame[0] !== 0 && frame[0] !== 1) return;
      changed.clear();
      if (frame[0] === 0) {
        for (let i = 0; i < pointers.length; i++) { values[pointers[i]] = undefined; changed.add(pointers[i]); }
      }
      const set = frame[2];
      if (set) for (let i = 0; i < set.length; i++) {
        const pointer = pointers[set[i][0]];
        if (pointer === undefined) continue;
        values[pointer] = set[i][1];
        changed.add(pointer);
      }
      const removed = frame[3];
      if (removed) for (let i = 0; i < removed.length; i++) {
        const pointer = pointers[removed[i]];
        if (pointer === undefined) continue;
        values[pointer] = undefined;
        changed.add(pointer);
      }
      attempt = 0;
      onStatus('live', 'Live');
      onFrame(values, changed);
    };
    socket.onclose = () => {
      if (stopped) return;
      onStatus('offline', 'vosu disconnected · retrying');
      setTimeout(open, backoff(++attempt));
    };
  };

  const close = () => {
    stopped = true;
    window.removeEventListener('pagehide', close);
    socket?.close(1000);
  };
  open();
  window.addEventListener('pagehide', close);
  return { values, close };
}

function coerce(fallback, value) {
  if (typeof fallback === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  // Option values are strings in settings.json, but an option list of numbers can reach us as numbers.
  if (typeof fallback === 'string') return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
  return value ?? fallback;
}

/**
 * Reads the overlay's vosu settings (`settings.json` uniqueIDs) through the command socket and
 * follows live edits. `defaults` must mirror settings.json values; received values are coerced
 * to each default's type and unknown keys are ignored. Outside vosu (no COUNTER_PATH) the
 * defaults stay in force. `onChange(settings)` runs once immediately and after every update.
 */
export function settings(defaults, onChange) {
  const current = { ...defaults };
  const path = window.COUNTER_PATH;
  onChange({ ...current });
  if (!path) return current;
  let attempt = 0;
  let stopped = false;
  let socket = null;
  const apply = message => {
    if (!message || typeof message !== 'object' || message.error) return;
    for (const key of Object.keys(defaults)) {
      if (key in message) current[key] = coerce(defaults[key], message[key]);
    }
    onChange({ ...current });
  };
  const open = () => {
    if (stopped) return;
    socket = new WebSocket(socketUrl(`/websocket/commands?l=${encodeURIComponent(path)}`));
    socket.onopen = () => { attempt = 0; socket.send(`getSettings:${encodeURIComponent(path)}`); };
    socket.onmessage = event => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.command === 'getSettings' || frame.command === 'updateSettings') apply(frame.message);
      } catch { /* non-JSON relay frames carry nothing for us */ }
    };
    socket.onclose = () => { if (!stopped) setTimeout(open, backoff(++attempt)); };
  };
  open();
  window.addEventListener('pagehide', () => { stopped = true; socket?.close(1000); });
  return current;
}

/**
 * Scales `stage` (laid out at its declared `width`×`height`) to the largest size that fits the
 * viewport without distortion, anchored top-left. OBS sources and vosulay frames size the page
 * to the declared resolution, so this is normally 1×; it keeps resized sources legible.
 */
export function fit(stage, width, height) {
  const apply = () => {
    const scale = Math.min(innerWidth / width, innerHeight / height) || 1;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.transformOrigin = '0 0';
    stage.style.transform = `scale(${scale})`;
  };
  addEventListener('resize', apply);
  apply();
}

export const MODES = Object.freeze(['osu', 'taiko', 'fruits', 'mania']);
export const MODE_LABELS = Object.freeze({ osu: 'osu!', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' });

/**
 * The ruleset being played or selected, as `osu` | `taiko` | `fruits` | `mania` (or null).
 * `beatmap.mode` is the map's original ruleset, so a converted map still reports osu! there;
 * gameplay uses `play.mode`, menus the selected `settings.mode`.
 * Pass the values of `/state/number`, `/play/mode/number`, `/settings/mode/number`.
 */
export function activeMode(state, playMode, settingsMode) {
  const number = state === PLAYING && Number.isInteger(playMode) ? playMode : settingsMode;
  return Number.isInteger(number) ? MODES[number] ?? null : null;
}

/** True while an attempt is on screen (`/state/number` 2: play, replay or spectate). */
export function isPlaying(state) {
  return state === PLAYING;
}

export function mean(values) {
  if (!values?.length) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Unstable rate as osu! defines it: ten times the (population) standard deviation of hit errors. */
export function unstableRate(values) {
  if (!values || values.length < 2) return null;
  const average = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - average) ** 2;
  return Math.sqrt(sum / values.length) * 10;
}

/** `m:ss` (or `h:mm:ss`) from milliseconds; negative values clamp to zero. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// ---------------------------------------------------------------- unknown values
// docs/overlay-system.md "Numbers": a value vosu did not provide is UNKNOWN (NaN), never 0, and
// renders as DASH (or hides its row). The helpers below return it; `mean`/`unstableRate` predate
// the rule and return null, which known() also maps to UNKNOWN.

export const UNKNOWN = NaN;
export const DASH = '\u2014';
const MINUS = '\u2212';
const INFINITY = '\u221e';

/**
 * `value` when it is a finite number, else UNKNOWN. With `zeroIsUnknown`, 0 is UNKNOWN too: use it
 * for fields where vosu or a host reports 0 for "not computed" (pp fc/maxAchievable in the replay
 * renderer or when the calculator fails, star rating and BPM of an unparsed map, profile rank/pp
 * while the profile is idle, mp3Length of a map without audio).
 */
export function known(value, zeroIsUnknown = false) {
  return typeof value === 'number' && Number.isFinite(value) && !(zeroIsUnknown && value === 0) ? value : UNKNOWN;
}

/** True for a finite number (false for UNKNOWN, null, undefined, strings). */
export function isKnown(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------- numbers

/**
 * The set's number conventions (docs/overlay-system.md "Numbers"): comma thousands separators,
 * a fixed number of decimals per quantity, U+2212 minus, `+`/`−`/`±0` on signed quantities.
 * `trim` drops trailing zeros (AR 9, AR 9.3; rate 1.5). Units are markup (`.kit-unit`), never part
 * of the formatted text, so a changing number never re-renders its unit.
 */
export const NUMBER_FORMATS = Object.freeze({
  count: Object.freeze({ decimals: 0 }), // presses, judgement counts, combo, score, rank, objects
  pp: Object.freeze({ decimals: 0 }),
  stars: Object.freeze({ decimals: 2 }),
  accuracy: Object.freeze({ decimals: 2 }), // followed by a `%` unit
  ur: Object.freeze({ decimals: 1 }),
  ms: Object.freeze({ decimals: 1, signed: true }), // hit-error mean and offsets
  kps: Object.freeze({ decimals: 0 }),
  bpm: Object.freeze({ decimals: 0 }),
  stat: Object.freeze({ decimals: 1, trim: true }), // AR / CS / OD / HP
  rate: Object.freeze({ decimals: 2, trim: true }), // followed by `×`
  percent: Object.freeze({ decimals: 0 }), // shares, splits (not accuracy)
  px: Object.freeze({ decimals: 1 }),
  ratio: Object.freeze({ decimals: 1 }), // MAX : 300; Infinity renders ∞
  delta: Object.freeze({ decimals: 0, signed: true }), // gains and gaps: pp, rank, score, counts
});
const SCALES = [1, 10, 100, 1000];

// Grouped text for 0…9999, built on first use: counters that tick through small integers reuse
// one string per value instead of building a new one each time.
const INT_TABLE = 10000;
const intTexts = new Array(INT_TABLE).fill(null);

function groupedInteger(n) {
  if (n < INT_TABLE) {
    let text = intTexts[n];
    if (text === null) text = intTexts[n] = n < 1000 ? String(n) : `${(n - n % 1000) / 1000},${String(n % 1000).padStart(3, '0')}`;
    return text;
  }
  let text = '';
  while (n >= 1000) {
    const r = n % 1000;
    text = `,${r < 10 ? '00' : r < 100 ? '0' : ''}${r}${text}`;
    n = (n - r) / 1000;
  }
  return `${n}${text}`;
}

/** Text for `key` = the value already multiplied by 10^decimals and rounded. */
function renderKey(key, spec) {
  const scale = SCALES[spec.decimals];
  const magnitude = key < 0 ? -key : key;
  const whole = Math.floor(magnitude / scale);
  let text = groupedInteger(whole);
  let digits = spec.decimals;
  if (digits) {
    let fraction = magnitude - whole * scale;
    if (spec.trim) while (digits > 0 && fraction % 10 === 0) { fraction /= 10; digits--; }
    if (digits) text = `${text}.${String(fraction).padStart(digits, '0')}`;
  }
  if (spec.signed) return `${key === 0 ? '\u00b1' : key < 0 ? MINUS : '+'}${text}`;
  return key < 0 ? MINUS + text : text;
}

function formatSpec(kind) {
  const spec = NUMBER_FORMATS[kind];
  if (!spec) throw new TypeError(`unknown number format "${kind}"`);
  return spec;
}

/**
 * `value` as text under the `kind` convention (a NUMBER_FORMATS key). UNKNOWN, null and
 * undefined give DASH. Allocates a string per call: in render paths use numberFormatter().
 */
export function formatNumber(value, kind = 'count') {
  const spec = formatSpec(kind);
  if (typeof value !== 'number' || !Number.isFinite(value)) return kind === 'ratio' && value === Infinity ? INFINITY : DASH;
  return renderKey(Math.round(value * SCALES[spec.decimals]), spec);
}

/**
 * A formatter for one displayed field: `format(value)` returns the same string object until the
 * value changes at the displayed precision, so callers can compare by identity and write
 * `textContent` only when the text changed. Create one per field at load; calling it allocates
 * only when the shown number changes (and not at all for repeated integers below 10,000).
 */
export function numberFormatter(kind = 'count') {
  const spec = formatSpec(kind);
  const scale = SCALES[spec.decimals];
  let lastKey = NaN;
  let lastText = DASH;
  return value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return kind === 'ratio' && value === Infinity ? INFINITY : DASH;
    const key = Math.round(value * scale) || 0; // -0 → 0
    if (key !== lastKey) { lastKey = key; lastText = renderKey(key, spec); }
    return lastText;
  };
}

// ---------------------------------------------------------------- keys per second

export const KPS_WINDOW_MS = 1000;
const KPS_RING = 4096; // presses remembered (power of two); a window rarely holds more than 60
const KPS_KEYS = 64;
// More new presses on one key than can happen between two samples is missed data (a stall, a
// ruleset swap): the count is kept, but the presses have no times and stay out of the window.
const KPS_MAX_STEP = 6;
// Presses from different keys arrive slightly out of order; a scan stops this far past the window.
const KPS_SLACK_MS = 250;

/**
 * The set's one keys-per-second computation, so every overlay that shows KPS shows the same number.
 * Definition: presses whose gameplay time (vosu `keys.all[i].pressedAt`, map ms) falls in the last
 * second of real time, i.e. the window (now − 1000 × rate, now] of map time. No smoothing: a press
 * leaves the count exactly one second after it happened (that is the decay). `peak` is the highest
 * window count reached at any press this attempt; `total` is the sum of the keys' own counts.
 *
 * Feed every `/keys/all` frame to `ingest(list, live, rate)` (the list is read in place, never kept)
 * and read `at(live)` when drawing. `available` is false while the host sends no `keys.all` (tosu):
 * show DASH then, not 0. `expiresAt` is the map time at which the count next drops, for scheduling
 * one wake-up instead of a frame loop. Nothing here allocates after construction.
 */
export function createKps() {
  return new KpsMeter();
}

class KpsMeter {
  constructor() {
    this.times = new Float64Array(KPS_RING);
    this.counts = new Int32Array(KPS_KEYS);
    this.head = 0;
    this.size = 0;
    this.keys = 0;
    this.baselined = false;
    this.available = false;
    this.rate = 1;
    this.current = 0;
    this.peak = 0;
    this.total = 0;
    this.expiresAt = Infinity;
  }

  /** Forget the attempt (map change, retry, leaving play). */
  reset() {
    this.head = 0;
    this.size = 0;
    this.keys = 0;
    this.baselined = false;
    this.current = 0;
    this.peak = 0;
    this.total = 0;
    this.expiresAt = Infinity;
    this.counts.fill(0);
  }

  /**
   * Reads vosu's `keys.all` at map time `live` with clock `rate`. The first list after a reset is
   * the baseline (presses made before this page watched have no times); a falling count is a retry.
   */
  ingest(list, live, rate = 1) {
    if (!Array.isArray(list)) { this.available = false; return; }
    this.available = true;
    this.rate = rate > 0 ? rate : 1;
    const n = list.length < KPS_KEYS ? list.length : KPS_KEYS;
    if (this.baselined) {
      for (let i = 0; i < n; i++) {
        const count = list[i] !== null && typeof list[i] === 'object' && Number.isFinite(list[i].count) ? list[i].count : 0;
        if (count < this.counts[i]) { this.reset(); break; }
      }
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      const key = list[i];
      if (key === null || typeof key !== 'object') continue;
      const count = Number.isFinite(key.count) ? key.count : 0;
      const delta = this.baselined && i < this.keys ? count - this.counts[i] : 0;
      this.counts[i] = count;
      total += count;
      if (delta <= 0 || delta > KPS_MAX_STEP) continue;
      const at = Number.isFinite(key.pressedAt) ? key.pressedAt : live;
      for (let k = 0; k < delta; k++) {
        this.times[this.head] = at;
        this.head = (this.head + 1) & (KPS_RING - 1);
        if (this.size < KPS_RING) this.size++;
      }
      const inWindow = this.window(at);
      if (inWindow > this.peak) this.peak = inWindow;
    }
    this.keys = n;
    this.total = total;
    this.baselined = true;
  }

  /** Presses in the window ending at map time `end`; also sets `expiresAt`. */
  window(end) {
    const span = KPS_WINDOW_MS * this.rate;
    const from = end - span;
    let count = 0;
    let oldest = Infinity;
    for (let k = 0, i = this.head; k < this.size; k++) {
      i = (i - 1) & (KPS_RING - 1);
      const t = this.times[i];
      if (t <= from - KPS_SLACK_MS) break;
      if (t > from && t <= end) { count++; if (t < oldest) oldest = t; }
    }
    this.expiresAt = count ? oldest + span : Infinity;
    return count;
  }

  /** The live count at map time `live` (UNKNOWN without `keys.all`). */
  at(live) {
    if (!this.available) return UNKNOWN;
    this.current = this.window(live);
    return this.current;
  }
}

// ---------------------------------------------------------------- map time

/** Pointers createMapClock().sample() reads, in its argument order after `live`. */
export const MAP_TIME_POINTERS = Object.freeze(['/beatmap/time/live', '/beatmap/time/rate', '/beatmap/time/firstObject', '/beatmap/time/lastObject', '/beatmap/time/mp3Length']);
// A sample older than this stops extrapolating (paused, frozen, or the data stopped).
const EXTRAPOLATE_MS = 120;

/**
 * The set's one map time / progress computation, so every clock and progress bar agrees.
 * Definition: the play span runs from the first to the last hit object (the audio length when the
 * map reports no objects); `elapsed` is real time since the first object, clamped to the span, and
 * `total` is the span in real time (both ÷ the clock rate, so DT shows real minutes). Lead-in reads
 * 0:00. `progress` is elapsed ÷ total. Without a span everything is UNKNOWN.
 *
 * `sample(live, rate, first, last, mp3, pageNow)` on each data frame (pageNow = performance.now()
 * or the rAF timestamp); `now(pageNow)` extrapolates map time between samples for smooth motion
 * (up to 120 ms, and only while the clock is moving). No allocation.
 */
export function createMapClock() {
  return new MapClock();
}

class MapClock {
  constructor() {
    this.live = UNKNOWN;
    this.rate = 1;
    this.start = UNKNOWN;
    this.end = UNKNOWN;
    this.sampledAt = 0;
    this.moving = false;
  }

  sample(live, rate, first, last, mp3, pageNow) {
    const t = known(live);
    this.moving = isKnown(t) && isKnown(this.live) && t !== this.live;
    this.live = t;
    this.rate = typeof rate === 'number' && rate > 0 ? rate : 1;
    this.sampledAt = pageNow;
    const from = known(first);
    const to = known(last);
    if (isKnown(from) && isKnown(to) && to > from) { this.start = from; this.end = to; }
    else {
      const length = known(mp3, true);
      this.start = isKnown(length) ? 0 : UNKNOWN;
      this.end = isKnown(length) ? length : UNKNOWN;
    }
  }

  /** Map time (ms) at page time `pageNow`. */
  now(pageNow) {
    if (!this.moving) return this.live;
    const ahead = pageNow - this.sampledAt;
    return this.live + (ahead < 0 ? 0 : ahead > EXTRAPOLATE_MS ? EXTRAPOLATE_MS : ahead) * this.rate;
  }

  /** Real milliseconds of the play span. */
  total() {
    return isKnown(this.end) ? (this.end - this.start) / this.rate : UNKNOWN;
  }

  /** Real milliseconds played at map time `mapMs`, clamped to the span. */
  elapsed(mapMs) {
    if (!isKnown(this.end) || !isKnown(mapMs)) return UNKNOWN;
    const t = mapMs < this.start ? this.start : mapMs > this.end ? this.end : mapMs;
    return (t - this.start) / this.rate;
  }

  /** 0…1 through the span at map time `mapMs`. */
  progress(mapMs) {
    if (!isKnown(this.end) || !isKnown(mapMs)) return UNKNOWN;
    const t = mapMs < this.start ? this.start : mapMs > this.end ? this.end : mapMs;
    return (t - this.start) / (this.end - this.start);
  }
}

// ---------------------------------------------------------------- motion

export const MOTION_LEVELS = Object.freeze(['full', 'reduced', 'off']);
/** Durations matching kit.css (--dur-*) for element.animate(); `off` overlays use 0. */
export const MOTION_MS = Object.freeze({ fast: 120, base: 240, slow: 400, ambient: 1600 });
export const BACKINGS = Object.freeze(['scrim', 'panel', 'none']);

/** The `motion` setting as `full` | `reduced` | `off` (anything else is `full`). */
export function motionLevel(value) {
  return value === 'reduced' || value === 'off' ? value : 'full';
}

/**
 * Applies the kit's shared settings to the overlay's `.kit` root: `data-motion` (motion),
 * `data-backing` (backing; default scrim) and `data-map-tint` (mapTint). Returns the motion level.
 * Attributes are written only when they change, so calling it from settings() costs nothing extra.
 */
export function applyKitSettings(element, { motion, backing, mapTint } = {}) {
  const level = motionLevel(motion);
  const back = backing === 'panel' || backing === 'none' ? backing : 'scrim';
  const tint = mapTint === false ? 'off' : 'on';
  if (element.dataset.motion !== level) element.dataset.motion = level;
  if (element.dataset.backing !== back) element.dataset.backing = back;
  if (element.dataset.mapTint !== tint) element.dataset.mapTint = tint;
  return level;
}

// ---------------------------------------------------------------- beat clock

/** Pointers the beat clock needs besides MAP_TIME_POINTERS. */
export const BEAT_POINTERS = Object.freeze(['/beatmap/checksum', '/beatmap/isKiai']);
const BEAT_RETRIES = 3;

async function fetchTimingPoints(checksum) {
  const response = await fetch('/json/sc', { cache: 'no-store' });
  if (!response.ok) return null; // tosu and the replay renderer: no beat, kiai only
  const doc = await response.json();
  // /json/sc describes whatever is selected now: a map change mid-request answers for the new map.
  if (typeof doc?.md5 === 'string' && doc.md5 && checksum && doc.md5 !== checksum) throw new Error('map changed');
  return Array.isArray(doc?.mapTimingPoints) ? doc.mapTimingPoints : null;
}

/**
 * Beat phase for beat-synced motion. Per map checksum it makes one `GET /json/sc` and keeps the
 * uninherited timing points ({startTime, beatLength}, map ms); `at(mapMs)` then sets `index`
 * (beats since the active red line, negative before the first) and `phase` (0…1 through the beat)
 * and returns true. When /json/sc is missing (tosu, the replay renderer) or has no points, `at()`
 * returns false: use kiai-only ambience then, never a free-running timer pretending to be the beat.
 * `kiai` mirrors `/beatmap/isKiai` (set it with `setKiai`).
 *
 * `setMap(checksum)` on every `/beatmap/checksum` change; `onChange` (optional) runs when the points
 * for the current map arrive or turn out to be absent. `at()` allocates nothing.
 */
export function createBeatClock({ onChange = null, load = fetchTimingPoints } = {}) {
  return new BeatClock(onChange, load);
}

class BeatClock {
  constructor(onChange, load) {
    this.onChange = onChange;
    this.load = load;
    this.checksum = '';
    this.starts = null;
    this.lengths = null;
    this.segment = 0;
    this.index = 0;
    this.phase = 0;
    this.beatLength = UNKNOWN;
    this.kiai = false;
    this.pending = 0; // generation of the request in flight
    this.cache = new Map();
  }

  get hasBeat() {
    return this.starts !== null;
  }

  setKiai(on) {
    this.kiai = on === true;
  }

  setMap(checksum) {
    const key = typeof checksum === 'string' ? checksum : '';
    if (key === this.checksum) return;
    this.checksum = key;
    this.use(this.cache.get(key) ?? null);
    if (key && !this.cache.has(key)) this.request(key, 0);
  }

  use(points) {
    this.starts = points ? points.starts : null;
    this.lengths = points ? points.lengths : null;
    this.segment = 0;
    this.beatLength = points ? points.lengths[0] : UNKNOWN;
  }

  request(key, attempt) {
    const generation = ++this.pending;
    Promise.resolve()
      .then(() => this.load(key))
      .then(list => {
        const points = beatPoints(list);
        this.cache.set(key, points);
        if (generation !== this.pending || key !== this.checksum) return;
        this.use(points);
        this.onChange?.(this);
      }, () => {
        // Network error or a map change mid-request: try again shortly, then give up (kiai only).
        if (attempt + 1 < BEAT_RETRIES) setTimeout(() => { if (key === this.checksum && !this.cache.has(key)) this.request(key, attempt + 1); }, 1000);
        else this.cache.set(key, null);
      });
  }

  /** Sets `index`, `phase` and `beatLength` for map time `mapMs`; false when the beat is unknown. */
  at(mapMs) {
    const starts = this.starts;
    if (starts === null || !Number.isFinite(mapMs)) return false;
    let s = this.segment;
    while (s + 1 < starts.length && mapMs >= starts[s + 1]) s++;
    while (s > 0 && mapMs < starts[s]) s--;
    this.segment = s;
    const length = this.lengths[s];
    const beats = (mapMs - starts[s]) / length;
    const index = Math.floor(beats);
    this.index = index;
    this.phase = beats - index;
    this.beatLength = length;
    return true;
  }
}

/** Uninherited points from /json/sc as sorted typed arrays, or null when there are none. */
function beatPoints(list) {
  if (!Array.isArray(list)) return null;
  const valid = list.filter(p => p && Number.isFinite(p.startTime) && Number.isFinite(p.beatLength) && p.beatLength > 0)
    .sort((a, b) => a.startTime - b.startTime);
  if (!valid.length) return null;
  const starts = new Float64Array(valid.length);
  const lengths = new Float64Array(valid.length);
  for (let i = 0; i < valid.length; i++) { starts[i] = valid[i].startTime; lengths[i] = valid[i].beatLength; }
  return { starts, lengths };
}

/** Beatmap background URL for the current selection; the checksum busts caches between maps. */
export function backgroundUrl(checksum) {
  return `/files/beatmap/background?${encodeURIComponent(checksum || '')}`;
}

/**
 * Where osu! draws things on a `width`×`height` screen (default 1920×1080), so overlays share the
 * screen with the game instead of covering it. Rects are `{ x, y, w, h }` in CSS px.
 *
 * Geometry follows osu!stable's default skin, scaled from its 480-line virtual canvas to the screen
 * height: the osu!/catch playfield is 512×384 placed 64 px from the left and 56 px from the top of
 * a 4:3 box centred horizontally; the taiko lane spans 216–416 of 768 lines; a mania column is
 * `columnWidth` virtual px (skin ColumnWidth, default 30) and stable places the stage's left edge at
 * `columnStart` (skin ColumnStart, default 136) — it is not centred — while lazer centres it
 * (`client: 'lazer'`). Skins move things, so treat this as the default placement and keep user
 * offsets (or columnStart/columnWidth settings) for anything aligned to it.
 *
 * `free` lists the regions osu! leaves empty for the ruleset, largest first; `hud` the default
 * HUD elements to keep clear of; `busy` the playfield/stage/lane. For mania, `columns` gives each
 * column's `{ x, w }`; pass `maniaSkin(keys)`'s result (columnStart, columnWidth array,
 * columnSpacing) to align with the player's actual skin instead of the defaults.
 */
export function osuLayout(mode, { keys = 4, columnWidth = 30, columnSpacing = 0, columnStart = 136, client = 'stable', width = 1920, height = 1080 } = {}) {
  const unit = height / 480;
  const rect = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  const hud = {
    health: rect(width * 0.008, height * 0.011, 320 * unit, 16 * unit),
    score: rect(width - 180 * unit, height * 0.007, 180 * unit - width * 0.008, 32 * unit),
    accuracy: rect(width - 118 * unit, 36 * unit, 118 * unit - width * 0.008, 18 * unit),
    combo: rect(width * 0.008, height - 44 * unit, 116 * unit, 42 * unit),
  };
  let busy;
  let columns;
  if (mode === 'mania') {
    const widths = Array.from({ length: keys }, (_, i) => (Array.isArray(columnWidth) ? columnWidth[i] ?? columnWidth.at(-1) : columnWidth) * unit);
    const gaps = Array.from({ length: Math.max(0, keys - 1) }, (_, i) => (Array.isArray(columnSpacing) ? columnSpacing[i] ?? 0 : columnSpacing) * unit);
    const stageWidth = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    const left = client === 'lazer' ? (width - stageWidth) / 2 : columnStart * unit;
    columns = [];
    let x = left;
    widths.forEach((w, i) => { columns.push({ x: Math.round(x), w: Math.round(w) }); x += w + (gaps[i] ?? 0); });
    busy = rect(left, 0, stageWidth, height);
    delete hud.combo; // mania draws combo inside the stage
  } else if (mode === 'taiko') {
    busy = rect(0, height * 216 / 768, width, height * 200 / 768);
  } else {
    const boxX = (width - 640 * unit) / 2;
    busy = rect(boxX + 64 * unit, 56 * unit, 512 * unit, 384 * unit);
  }
  if (mode === 'osu') {
    hud.keys = rect(width - 32 * unit, height * 0.435, 32 * unit, 66 * unit);
    hud.hitError = rect(width / 2 - 90 * unit, height - 12 * unit, 180 * unit, 12 * unit);
    hud.leaderboard = rect(0, height * 0.28, 102 * unit, height * 0.37);
  }
  const top = hud.health.y + hud.health.h;
  const free = mode === 'taiko'
    ? [rect(0, busy.y + busy.h, width, height - busy.y - busy.h), rect(hud.health.x + hud.health.w, 0, hud.score.x - hud.health.x - hud.health.w, busy.y)]
    : [rect(0, top, busy.x, height - top - (hud.combo ? hud.combo.h : 0)), rect(busy.x + busy.w, hud.accuracy.y + hud.accuracy.h, width - busy.x - busy.w, height - hud.accuracy.y - hud.accuracy.h)];
  if (mode === 'osu' || mode === 'fruits') free.push(rect(busy.x, busy.y + busy.h, busy.w, height - busy.y - busy.h));
  return { width, height, unit, busy, hud, columns, free: free.filter(r => r.w > 0 && r.h > 0).sort((a, b) => b.w * b.h - a.w * a.h) };
}

const skinIni = new Map();

/**
 * The current skin's osu!mania stage for `keys` columns, read from its skin.ini through vosu
 * (`/files/skin/skin.ini`): `{ columnStart, columnWidth: number[], columnSpacing: number[],
 * hitPosition }` in skin units (480-line), with stable's defaults (136, 30, 0, 402) for anything
 * the section omits. Resolves to null when vosu serves no skin.ini (lazer built-in skins, tosu,
 * or file access off) — keep the defaults or user settings then. `skin` (the
 * `/settings/skin/name` value) keys the cache, so a skin change re-reads the file.
 */
export async function maniaSkin(keys, skin = '') {
  if (!skinIni.has(skin)) {
    skinIni.set(skin, fetch('/files/skin/skin.ini', { cache: 'no-store' })
      .then(response => (response.ok ? response.text() : null))
      .catch(() => null));
  }
  const text = await skinIni.get(skin);
  if (!text) return null;
  let section = null;
  let match = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line.startsWith('[')) {
      section = line.toLowerCase() === '[mania]' ? {} : null;
      continue;
    }
    const colon = line.indexOf(':');
    if (!section || colon < 0) continue;
    section[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    if (section.keys !== undefined && Number(section.keys) === keys) match = section;
  }
  // Per position, as stable does: a missing or blank entry takes the default (not the previous
  // value), and widths below 1 are invalid. Number('') is 0, so blanks must be rejected explicitly.
  const list = (value, fallback, length, min = 0) => {
    const tokens = typeof value === 'string' ? value.split(',') : [];
    return Array.from({ length }, (_, i) => {
      const parsed = Number.parseFloat(tokens[i]);
      return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    });
  };
  const number = (value, fallback) => (Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : fallback);
  return {
    columnStart: number(match?.columnstart, 136),
    columnWidth: list(match?.columnwidth, 30, keys, 1),
    columnSpacing: list(match?.columnspacing, 0, Math.max(0, keys - 1)),
    hitPosition: number(match?.hitposition, 402),
  };
}

const palettes = new Map();
const PALETTE_KEYS = ['accent', 'onAccent', 'container', 'onContainer', 'secondary', 'tertiary', 'surface', 'outline'];

/**
 * Material 3 tonal-spot colours for the current map, derived from its background: the overlay is
 * tinted to the map without showing the background art itself (which would fight the 18-LAB look).
 * Resolves to `{ source, accent, onAccent, container, onContainer, secondary, tertiary, surface,
 * outline }` as `#rrggbb` dark-scheme roles, or null when the map has no usable background (none,
 * unreadable, or too grey to score). Requires the overlay folder to carry `m3.js`. Cached per map.
 */
export function mapPalette(checksum) {
  if (!checksum) return Promise.resolve(null);
  if (!palettes.has(checksum)) palettes.set(checksum, derivePalette(checksum));
  return palettes.get(checksum);
}

/** Sets `--map-<role>` custom properties on `element` from a mapPalette() result; null clears them. */
export function applyPalette(element, palette) {
  for (const key of PALETTE_KEYS) {
    const name = `--map-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
    if (palette) element.style.setProperty(name, palette[key]);
    else element.style.removeProperty(name);
  }
}

async function derivePalette(checksum) {
  try {
    const [{ QuantizerCelebi, Score, TonalPalette }, image] = await Promise.all([import('./m3.js'), loadImage(backgroundUrl(checksum))]);
    // A 128 px thumbnail keeps quantization in the low milliseconds; colour, not detail, matters.
    const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 255) pixels.push((0xff000000 | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) >>> 0);
    }
    // The TypeScript port's WSMeans assigns starting clusters with Math.random (the Java original
    // seeds 0x42688), so one background gave a slightly different accent on every load. The call
    // is synchronous, so a seeded generator for its duration cannot leak to other code.
    const random = Math.random;
    let seed = 0x42688;
    Math.random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    let quantized;
    try { quantized = QuantizerCelebi.quantize(pixels, 128); } finally { Math.random = random; }
    // Fallback 0 marks "nothing chromatic enough": a grey background keeps the 18-LAB accent
    // instead of M3's default blue.
    const [source] = Score.score(quantized, { desired: 1, fallbackColorARGB: 0 });
    if (!source) return null;
    const hue = TonalPalette.fromInt(source).hue;
    // Tonal spot: primary chroma 36, secondary 16, tertiary hue + 60 at 24, neutrals 6 / 8.
    const primary = TonalPalette.fromHueAndChroma(hue, 36);
    const secondary = TonalPalette.fromHueAndChroma(hue, 16);
    const tertiary = TonalPalette.fromHueAndChroma((hue + 60) % 360, 24);
    const neutral = TonalPalette.fromHueAndChroma(hue, 6);
    const neutralVariant = TonalPalette.fromHueAndChroma(hue, 8);
    const hex = argb => `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;
    return {
      source: hex(source),
      accent: hex(primary.tone(80)),
      onAccent: hex(primary.tone(20)),
      container: hex(primary.tone(30)),
      onContainer: hex(primary.tone(90)),
      secondary: hex(secondary.tone(80)),
      tertiary: hex(tertiary.tone(80)),
      surface: hex(neutral.tone(6)),
      outline: hex(neutralVariant.tone(60)),
    };
  } catch {
    palettes.delete(checksum);
    return null;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('background unavailable'));
    image.src = url;
  });
}

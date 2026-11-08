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
    socket.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 2) {
        onStatus('offline', `vosu refused the subscription: ${frame[2]}`);
        return;
      }
      if (frame[0] !== 0 && frame[0] !== 1) return;
      const changed = new Set();
      if (frame[0] === 0) {
        for (const pointer of pointers) { values[pointer] = undefined; changed.add(pointer); }
      }
      for (const [id, value] of frame[2] || []) {
        if (pointers[id] === undefined) continue;
        values[pointers[id]] = value;
        changed.add(pointers[id]);
      }
      for (const id of frame[3] || []) {
        if (pointers[id] === undefined) continue;
        values[pointers[id]] = undefined;
        changed.add(pointers[id]);
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
  if (typeof fallback === 'string') return typeof value === 'string' ? value : fallback;
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

/** Beatmap background URL for the current selection; the checksum busts caches between maps. */
export function backgroundUrl(checksum) {
  return `/files/beatmap/background?${encodeURIComponent(checksum || '')}`;
}

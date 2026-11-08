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
  const list = (value, fallback, length) => {
    const parts = String(value ?? '').split(',').map(Number).filter(Number.isFinite);
    return Array.from({ length }, (_, i) => parts[i] ?? parts.at(-1) ?? fallback);
  };
  const number = (value, fallback) => (Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : fallback);
  return {
    columnStart: number(match?.columnstart, 136),
    columnWidth: list(match?.columnwidth, 30, keys),
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
    // Fallback 0 marks "nothing chromatic enough": a grey background keeps the 18-LAB accent
    // instead of M3's default blue.
    const [source] = Score.score(QuantizerCelebi.quantize(pixels, 128), { desired: 1, fallbackColorARGB: 0 });
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

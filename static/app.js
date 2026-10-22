import { VosuClient } from './vosu-client.js';

const content = document.querySelector('#content');
const connection = document.querySelector('#connection');
const routeName = document.querySelector('#route-name');
const route = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'index';
const allowed = new Set(['lyrics', 'map', 'keys']);
let snapshot = null;
let precise = null;
let lyrics = null;
let lyricsIdentity = '';
let lyricsLoading = false;

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value, fallback = 'Unavailable') { return typeof value === 'string' && value.trim() ? value : fallback; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function display(value, digits = 1) { const n = number(value); return n === null ? '—' : n.toFixed(digits).replace(/\.0$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function message(value, error = false) { content.innerHTML = `<div class="message${error ? ' error' : ''}">${escapeHtml(value)}</div>`; }
function modeName(value) { const item = object(value); return text(item.name, 'unknown ruleset'); }

function identity(beatmap) {
  return JSON.stringify([beatmap.checksum, beatmap.id, beatmap.set, beatmap.artist, beatmap.title, beatmap.version]);
}

function renderIndex() {
  routeName.textContent = 'vosu overlays';
  content.innerHTML = '<div class="message">Choose an overlay route: <strong>/lyrics</strong>, <strong>/map</strong>, or <strong>/keys</strong>.</div>';
}

async function loadLyrics(beatmap) {
  const nextIdentity = identity(beatmap);
  if (nextIdentity === lyricsIdentity || lyricsLoading) return;
  lyricsIdentity = nextIdentity;
  lyrics = null;
  lyricsLoading = true;
  renderLyrics();
  try {
    const params = new URLSearchParams({ server: client.base });
    const response = await fetch(`/api/lyrics?${params}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Lyrics service returned HTTP ${response.status}`);
    lyrics = body;
  } catch (error) {
    lyrics = { status: 'error', error: error.message || 'Lyrics lookup failed' };
  } finally {
    lyricsLoading = false;
    renderLyrics();
  }
}

function renderLyrics() {
  routeName.textContent = 'live lyrics';
  if (!snapshot) return message('Waiting for vosu beatmap telemetry.');
  const beatmap = object(snapshot.beatmap);
  if (!beatmap.title && !beatmap.artist) return message('No current map metadata; lyrics are unavailable.');
  loadLyrics(beatmap);
  if (lyricsLoading || !lyrics) return message(`Looking up lyrics for ${text(beatmap.artist, 'unknown artist')} — ${text(beatmap.title, 'unknown title')}…`);
  if (lyrics.status !== 'ok' || !Array.isArray(lyrics.lines) || !lyrics.lines.length) {
    return message(lyrics.error || 'No lyrics or transcription are available for this map.', lyrics.status === 'error');
  }
  const now = number(object(beatmap.time).live) || 0;
  let active = lyrics.lines.findLastIndex(line => number(line.start_ms) !== null && line.start_ms <= now);
  active = Math.max(0, active);
  const visible = [active - 1, active, active + 1].filter(i => lyrics.lines[i]);
  content.innerHTML = `<div class="lyrics">${visible.map(i => `<p class="lyric ${i === active ? 'active' : i < active ? 'previous' : 'next'}">${escapeHtml(lyrics.lines[i].text)}</p>`).join('')}<div class="lyric-source">${escapeHtml(lyrics.source === 'lrclib' ? 'Synced lyrics · LRCLIB' : `Local transcription · ${lyrics.model || 'Qwen3-ASR'}`)}</div></div>`;
}

function renderMap() {
  routeName.textContent = 'map data';
  if (!snapshot) return message('Waiting for vosu map telemetry.');
  const map = object(snapshot.beatmap);
  if (!map.title && !map.artist) return message('No current map is available.');
  const stats = object(map.stats);
  const time = object(map.time);
  const live = number(time.live) || 0;
  const total = number(time.mp3Length) ?? number(time.lastObject) ?? 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, live / total * 100)) : 0;
  const items = [
    ['Stars', object(stats.stars).live], ['BPM', object(stats.bpm).realtime],
    ['AR', object(stats.ar).converted], ['OD', object(stats.od).converted],
    [modeName(map.mode) === 'mania' ? 'Keys' : 'CS', object(stats.cs).converted], ['HP', object(stats.hp).converted]
  ];
  content.innerHTML = `<article class="map"><img class="map-bg" src="${escapeHtml(client.base)}/files/beatmap/background" alt=""><div class="map-shade"></div><div class="map-data"><div class="map-kicker">${escapeHtml(modeName(map.mode))} · ${escapeHtml(text(map.status?.name, 'unknown status'))}</div><h1>${escapeHtml(text(map.title))}</h1><h2>${escapeHtml(text(map.artist))} · [${escapeHtml(text(map.version))}] · mapped by ${escapeHtml(text(map.mapper))}</h2><dl class="stats">${items.map(([label, value]) => `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${display(value)}</dd></div>`).join('')}</dl><div class="progress"><div style="width:${percent}%"></div></div></div></article>`;
}

function renderKeys() {
  routeName.textContent = 'keypress visualizer';
  if (!precise) return message('Waiting for vosu precise key telemetry.');
  const keypresses = object(precise.keypresses);
  const keys = Array.isArray(keypresses.keys) ? keypresses.keys : [];
  if (!keys.length) return message(`Key telemetry is unavailable for ${modeName(keypresses.mode)}. Start or focus gameplay; fabricated lanes are never shown.`);
  content.innerHTML = `<div class="keys-wrap"><div class="keys-meta"><span>${escapeHtml(modeName(keypresses.mode))}</span><span>${keys.length} live ${keys.length === 1 ? 'input' : 'inputs'}</span></div><div class="keys" style="--lanes:${keys.length}">${keys.map(key => `<div class="key${key.isPressed === true ? ' pressed' : ''}"><span class="key-name">${escapeHtml(text(key.name, '?'))}</span><span class="key-count">${Number.isSafeInteger(key.count) ? key.count : '—'}</span></div>`).join('')}</div></div>`;
}

function render() {
  if (route === 'lyrics') renderLyrics();
  else if (route === 'map') renderMap();
  else if (route === 'keys') renderKeys();
  else renderIndex();
}

const client = new VosuClient();
client.addEventListener('connection', event => {
  connection.dataset.state = event.detail.state;
  connection.textContent = event.detail.detail;
});
client.addEventListener('snapshot', event => { snapshot = event.detail; render(); });
client.addEventListener('precise', event => { precise = event.detail; if (route === 'keys') renderKeys(); });
window.addEventListener('beforeunload', () => client.stop(), { once: true });

if (!allowed.has(route) && route !== 'index') message(`Unknown overlay route /${route}`, true);
else render();
client.start().catch(error => {
  connection.dataset.state = 'error';
  connection.textContent = error.message || 'Unable to start vosu client';
});
setInterval(() => { if (route === 'lyrics' && snapshot && lyrics?.status === 'ok') renderLyrics(); }, 100);

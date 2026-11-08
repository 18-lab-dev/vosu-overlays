#!/usr/bin/env bun
// Copyright (c) 2026 18-LAB. MIT.
// Development-only mock of the vosu routes the overlays use, so they can be designed,
// screenshotted and profiled without osu! running. NOT a vosu replacement: values come from a
// deterministic synthetic attempt, not from a client.
//
//   bun dev/mock-vosu.js [--port 24100] [--mode osu|taiko|fruits|mania] [--state play|menu|results|offline]
//                        [--client stable|lazer] [--keys 4|7] [--ext 1|0] [--freeze <ms>] [--speed 1]
//
// Overlays: http://127.0.0.1:<port>/<overlay-id>/   Control page: /__dev/   All overlays live: /__dev/gallery
// Live control: GET /__dev/scenario?mode=mania&state=play&keys=7&freeze=60000 (any subset; resets).
//               GET /__dev/settings?id=<overlay>&<uniqueID>=<value>  pushes updateSettings live.
// /assets/* (18-LAB tokens and fonts) is read from $VOSU_ASSETS (a vosu checkout's
// assets/server) when set, else proxied from a running vosu at $VOSU_URL (default :24050).

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OVERLAYS = join(ROOT, 'overlays');
const arg = (name, fallback) => {
  const index = Bun.argv.indexOf(`--${name}`);
  return index > 0 && Bun.argv[index + 1] !== undefined ? Bun.argv[index + 1] : fallback;
};
const PORT = Number(arg('port', 24100));
const VOSU_URL = process.env.VOSU_URL || 'http://127.0.0.1:24050';
const VOSU_ASSETS = process.env.VOSU_ASSETS || '';

// ---------------------------------------------------------------- deterministic randomness
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = random => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());

// ---------------------------------------------------------------- scenario
const MODE_NUMBER = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
const STATE = { menu: { number: 5, name: 'selectPlay' }, play: { number: 2, name: 'play' }, results: { number: 7, name: 'resultScreen' } };

let config = {
  mode: arg('mode', 'osu'), state: arg('state', 'play'), client: arg('client', 'stable'),
  keys: Number(arg('keys', 4)), ext: arg('ext', '1') !== '0', freeze: arg('freeze', null), speed: Number(arg('speed', 1)),
  start: Number(arg('start', 0)),
};
let scenario;

const MAPS = {
  osu: { artist: 'xi', title: 'FREEDOM DiVE', version: "FOUR DIMENSIONS", mapper: 'Nakagawa-Kanon', bpm: 222.22, stars: 7.01, ar: 9, cs: 4, od: 8, hp: 6, length: 150000 },
  taiko: { artist: 'Camellia', title: 'Exit This Earth\'s Atomosphere', version: 'Inner Oni', mapper: 'Mikii', bpm: 200, stars: 6.42, ar: 5, cs: 5, od: 6, hp: 5, length: 150000 },
  fruits: { artist: 'Sakuzyo', title: 'Altale', version: 'Overdose', mapper: 'Spectator', bpm: 190, stars: 6.1, ar: 9, cs: 4.2, od: 9, hp: 6, length: 150000 },
  mania: { artist: 'cYsmix', title: 'Peer Gynt', version: 'Lv.28', mapper: 'Sky_Demon', bpm: 175, stars: 5.33, ar: 5, cs: 4, od: 8, hp: 8, length: 150000 },
};

function hitWindow(mode, od) {
  if (mode === 'osu') return { great: 80 - 6 * od, ok: 140 - 8 * od, meh: 200 - 10 * od, miss: 400 };
  if (mode === 'taiko') return { great: 50 - 3 * od, ok: 120 - 8 * od, miss: 135 - 8 * od };
  if (mode === 'mania') return { perfect: 16, great: 64 - 3 * od, good: 97 - 3 * od, ok: 127 - 3 * od, meh: 151 - 3 * od, miss: 188 - 3 * od };
  return { miss: 0, meh: 0, ok: 0, good: 0, great: 0, perfect: 0 };
}

/** Builds a synthetic attempt: objects with precomputed judgements, key presses and catcher path. */
function build() {
  const { mode } = config;
  const map = MAPS[mode];
  const random = rng(0x18a + MODE_NUMBER[mode] * 97 + config.keys);
  const beat = 60000 / map.bpm;
  const first = 1500;
  const end = first + map.length - 6000;
  const windows = hitWindow(mode, map.od);
  const sigma = { osu: 11, taiko: 9, fruits: 0, mania: 13 }[mode];
  const bias = { osu: -3.2, taiko: 2.1, fruits: 0, mania: -1.4 }[mode];
  const columns = mode === 'mania' ? config.keys : mode === 'taiko' ? 4 : mode === 'osu' ? 3 : 3;
  const objects = [];
  const presses = Array.from({ length: columns }, () => []);
  let t = first;
  let section = 0;
  while (t < end) {
    // Sections alternate density so streams, bursts and breathers all appear.
    section = Math.floor((t - first) / (beat * 16)) % 6;
    const division = mode === 'mania' ? [2, 4, 4, 2, 4, 3][section] : [2, 4, 1, 4, 2, 4][section];
    const step = beat / division;
    const breakSection = t > first + 60000 && t < first + 66000;
    if (!breakSection) objects.push({ t, section, step });
    t += breakSection ? 6000 : step;
  }
  let alternate = 0;
  let catcherTarget = 256;
  const path = [];
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    const miss = random() < 0.006;
    const error = Math.round((bias + gauss(random) * sigma * (object.step < beat / 3 ? 1.25 : 1)) * 10) / 10;
    object.miss = miss;
    object.error = error;
    if (mode === 'osu') {
      object.kind = random() < 0.35 ? 'slider' : 'circle';
      const key = object.step < beat / 1.5 ? (alternate++ % 2) : 0;
      object.key = key;
      if (!miss) presses[key].push([object.t + error, object.t + error + 30 + random() * 40]);
      const radius = 54.4 - 4.48 * map.cs;
      if (!miss) offsets.push([Math.round(gauss(random) * radius * 0.34 * 10) / 10, Math.round(gauss(random) * radius * 0.3 * 10) / 10, error]);
      object.sliderBreak = object.kind === 'slider' && !miss && random() < 0.01;
    } else if (mode === 'taiko') {
      const kat = random() < 0.42;
      object.kind = kat ? 'kat' : 'don';
      const right = object.step < beat / 3 ? (alternate++ % 2) : random() < 0.5 ? 1 : 0;
      const key = kat ? (right ? 3 : 0) : (right ? 2 : 1); // B1 left rim, B2 left centre, B3 right centre, B4 right rim
      object.key = key;
      if (!miss) presses[key].push([object.t + error, object.t + error + 25 + random() * 25]);
    } else if (mode === 'mania') {
      const chord = object.section === 3 && index % 2 === 0 ? 2 : 1;
      object.columns = [];
      for (let c = 0; c < chord; c++) object.columns.push(Math.floor(random() * columns));
      object.columns = [...new Set(object.columns)];
      object.ln = object.section === 5 && random() < 0.6 ? beat * (1 + Math.floor(random() * 2)) : 0;
      object.release = object.ln ? Math.round((bias + 6 + gauss(random) * sigma * 1.6) * 10) / 10 : null;
      for (const column of object.columns) {
        if (!miss) presses[column].push([object.t + error, object.t + (object.ln ? object.ln + object.release : error + 35 + random() * 40)]);
      }
    } else {
      // Catch: fruits on the beat, droplet trails between big moves.
      object.kind = object.section === 1 || object.section === 3 ? (index % 4 === 0 ? 'fruit' : index % 2 ? 'droplet' : 'drop') : 'fruit';
      if (object.kind === 'fruit' && random() < 0.35) catcherTarget = 40 + random() * 432;
      object.x = catcherTarget + gauss(random) * 18;
      path.push([object.t, object.x]);
      object.miss = object.kind === 'droplet' ? random() < 0.03 : miss;
    }
  }
  // Dash: held when the catcher must cover a wide gap quickly (stable reports only dash in keys.all).
  if (mode === 'fruits') {
    for (let i = 1; i < path.length; i++) {
      const speed = Math.abs(path[i][1] - path[i - 1][1]) / Math.max(1, path[i][0] - path[i - 1][0]);
      if (speed > 0.6) presses[2].push([path[i - 1][0], path[i][0]]);
      if (config.client === 'lazer' && Math.abs(path[i][1] - path[i - 1][1]) > 4) presses[path[i][1] < path[i - 1][1] ? 0 : 1].push([path[i - 1][0], path[i][0]]);
    }
  }
  for (const list of presses) list.sort((a, b) => a[0] - b[0]);
  const graphStep = 400;
  const xaxis = [];
  for (let x = 0; x <= map.length; x += graphStep) xaxis.push(x);
  const seriesNames = { osu: ['aim', 'aimNoSliders', 'reading', 'flashlight', 'speed'], taiko: ['color', 'rhythm', 'stamina', 'reading'], fruits: ['movement'], mania: ['strains'] }[mode];
  const series = seriesNames.map((name, s) => ({
    name,
    data: xaxis.map(x => {
      const density = objects.filter(o => Math.abs(o.t - x) < 1500).length;
      return Math.max(0, Math.round((density * (0.9 + 0.15 * s) + 6 * Math.sin(x / 9000 + s)) * 100) / 100);
    }),
  }));
  return { map, mode, beat, first, end, windows, objects, presses, offsets, path, columns, xaxis, series, startedAt: performance.now(), attempt: 1 };
}

function judge(mode, object, windows) {
  if (object.miss) return 0;
  const e = Math.abs(object.error);
  if (mode === 'osu') return e <= windows.great ? 300 : e <= windows.ok ? 100 : 50;
  if (mode === 'taiko') return e <= windows.great ? 300 : 100;
  if (mode === 'mania') return e <= windows.perfect ? 'geki' : e <= windows.great ? 300 : e <= windows.good ? 'katu' : e <= windows.ok ? 100 : 50;
  return object.kind === 'fruit' ? 300 : object.kind === 'drop' ? 100 : 50;
}

function clock() {
  if (config.freeze !== null && config.freeze !== '') return Number(config.freeze);
  // `start` begins a live attempt that far into the map, so long histories keep growing (late-attempt perf).
  const elapsed = (performance.now() - scenario.startedAt) * config.speed + (config.start && config.state !== 'menu' ? config.start + 800 : 0);
  if (config.state === 'menu') return (elapsed % 30000) + 40000;
  const cycle = scenario.end + 2500 + 8000;
  const attempt = Math.floor(elapsed / cycle);
  scenario.attempt = attempt + 1;
  return (elapsed % cycle) - 800;
}

const PP_FULL = { osu: 512, taiko: 388, fruits: 401, mania: 455 };

function documentAt() {
  const { map, mode, objects, windows } = scenario;
  const time = clock();
  const ended = time > scenario.end + 2500;
  const state = config.state === 'menu' ? STATE.menu : config.state === 'results' || ended ? STATE.results : STATE.play;
  const t = state === STATE.results ? Infinity : state === STATE.menu ? -Infinity : time;
  const hits = { 0: 0, 50: 0, 100: 0, 300: 0, geki: 0, katu: 0, sliderBreaks: 0, sliderEndHits: 0, smallTickHits: 0, largeTickHits: 0 };
  const hitErrors = [];
  const pressHitErrors = [];
  const releaseHitErrors = [];
  const keyPress = Array.from({ length: mode === 'mania' ? scenario.columns : 0 }, () => []);
  const keyRelease = Array.from({ length: mode === 'mania' ? scenario.columns : 0 }, () => []);
  const hitOffsets = [];
  let combo = 0, maxCombo = 0, judged = 0, score = 0, osuIndex = 0;
  for (const object of objects) {
    if (object.t + Math.max(0, object.error) > t) break;
    judged++;
    const result = judge(mode, object, windows);
    if (mode === 'fruits' && object.kind === 'droplet' && object.miss) hits.katu++;
    else hits[result]++;
    if (result === 0 || object.sliderBreak) { combo = 0; if (object.sliderBreak) hits.sliderBreaks++; }
    else combo++;
    if (object.kind === 'slider' && !object.miss) hits.sliderEndHits++;
    maxCombo = Math.max(maxCombo, combo);
    score += ({ geki: 320, katu: 200 }[result] ?? result) * (1 + combo / 25);
    if (!object.miss && mode !== 'fruits') {
      hitErrors.push(object.error);
      pressHitErrors.push(object.error);
      if (mode === 'mania') for (const column of object.columns) keyPress[column].push(object.error);
    }
    if (mode === 'osu' && !object.miss) {
      const triple = scenario.offsets[osuIndex++];
      if (triple) hitOffsets.push(...triple);
    }
    if (mode === 'mania' && object.ln && !object.miss && object.t + object.ln <= t) {
      hitErrors.push(object.release);
      releaseHitErrors.push(object.release);
      for (const column of object.columns) keyRelease[column].push(object.release);
    }
  }
  const total = objects.length;
  const accuracy = accuracyOf(mode, hits);
  const progress = judged / total;
  const accFactor = Math.pow(accuracy / 100, mode === 'mania' ? 8 : 5);
  const missFactor = Math.pow(0.97, hits[0]);
  const ppFull = PP_FULL[mode];
  const pp = {
    current: Math.round(ppFull * Math.pow(progress, 1.1) * accFactor * missFactor * 100) / 100,
    fc: Math.round(ppFull * accFactor * 100) / 100,
    maxAchieved: Math.round(ppFull * Math.pow(progress, 1.1) * accFactor * missFactor * 100) / 100,
    maxAchievable: Math.round(ppFull * Math.pow((accuracy * progress + 100 * (1 - progress)) / 100, mode === 'mania' ? 8 : 5) * missFactor * 100) / 100,
  };
  const split = { aim: 0.48, speed: 0.31, accuracy: 0.17, flashlight: 0, difficulty: mode === 'osu' ? 0 : 0.7 };
  const detail = total => Object.fromEntries([...Object.entries(split).map(([k, v]) => [k, Math.round(total * v * 100) / 100]), ['total', total]]);
  pp.detailed = { current: detail(pp.current), fc: detail(pp.fc) };
  const ur = hitErrors.length > 1 ? stddev(hitErrors) * 10 : 0;
  const rank = accuracy === 100 ? 'SS' : accuracy > 95 && !hits[0] ? 'S' : accuracy > 90 ? 'A' : accuracy > 80 ? 'B' : 'C';
  const live = state === STATE.play ? Math.max(0, time) : state === STATE.menu ? time : map.length;
  const kiai = live > 30000 && live < 52000 || live > 100000 && live < 125000;
  const keysAll = Array.from({ length: scenario.columns }, (_, column) => keyState(`B${column + 1}`, scenario.presses[column], state === STATE.play ? time : -Infinity));
  if (mode === 'fruits' && config.client === 'stable') for (const key of keysAll.slice(0, 2)) Object.assign(key, { isPressed: false, count: 0, pressedAt: null, releasedAt: null });
  const legacy = i => ({ isPressed: keysAll[i]?.isPressed ?? false, count: keysAll[i]?.count ?? 0 });
  const keys = { k1: legacy(0), k2: legacy(1), m1: { isPressed: false, count: 0 }, m2: { isPressed: false, count: 0 }, all: mode === 'osu' ? keysAll : keysAll };
  const mods = { checksum: 'HD', number: 8, name: 'HD', array: [{ acronym: 'HD' }], rate: 1 };
  const modeObj = { number: MODE_NUMBER[mode], name: mode };
  const play = {
    failed: false, playerName: 'sxlvia', mode: modeObj, score: Math.round(score), accuracy, healthBar: { normal: 180, smooth: 178 },
    hits, hitErrorArray: hitErrors, pressHitErrors, releaseHitErrors, combo: { current: combo, max: maxCombo }, mods,
    rank: { current: rank, maxThisPlay: rank }, pp, unstableRate: Math.round(ur * 100) / 100,
    source: state === STATE.play ? 'player' : null,
  };
  if (config.ext && mode === 'osu') play.hitOffsets = hitOffsets;
  if (config.ext && mode === 'mania') play.keyHitErrors = { press: keyPress, release: keyRelease };
  let catcher;
  if (mode === 'fruits' && state === STATE.play) {
    catcher = { x: Math.round(catcherAt(time) * 10) / 10, dashing: keysAll[2].isPressed };
    play.catcher = catcher;
  }
  const stars = map.stars;
  const ppAcc = Object.fromEntries([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100].map(a => [String(a), Math.round(ppFull * Math.pow(a / 100, mode === 'mania' ? 8 : 5) * 100) / 100]));
  const checksum = `mock${mode}${config.keys}`.padEnd(32, '0');
  const doc = {
    game: { focused: true, paused: false }, client: config.client, server: 'ppy.sh', state,
    session: { playTime: Math.round(240000 + (scenario.attempt - 1) * scenario.end + (state === STATE.play ? Math.max(0, time) : 0)), playCount: 11 + scenario.attempt },
    directPath: { beatmapFile: '', beatmapBackground: '', beatmapAudio: '', beatmapFolder: '', skinFolder: '' },
    profile: {
      userStatus: { number: 0, name: 'connected' }, banchoStatus: { number: 2, name: 'playing' }, id: 7562902, name: 'sxlvia', mode: modeObj,
      rankedScore: 9876543210, level: 101.4, accuracy: 98.62, pp: 8123.4 + (state === STATE.results ? 3.1 : 0), playCount: 48211,
      globalRank: 4120 - (state === STATE.results ? 6 : 0), countryCode: { number: 225, name: 'US' }, backgroundColour: 'ff963f', matchmaking: null,
    },
    beatmap: {
      isKiai: kiai, isBreak: live > 61500 && live < 66500, isConvert: false,
      time: { live, firstObject: scenario.first, lastObject: scenario.end, mp3Length: map.length, rate: 1, running: true },
      status: { number: 4, name: 'ranked' }, checksum, id: 129891 + MODE_NUMBER[mode], set: 39804, mode: modeObj,
      artist: map.artist, artistUnicode: map.artist, title: map.title, titleUnicode: map.title, mapper: map.mapper, version: mode === 'mania' ? `${config.keys}K ${map.version}` : map.version,
      source: '', tags: '',
      stats: {
        stars: { live: Math.round(stars * Math.min(1, 0.4 + progress) * 100) / 100, total: stars },
        ar: { original: map.ar, converted: Math.min(10, map.ar) }, cs: { original: mode === 'mania' ? config.keys : map.cs, converted: mode === 'mania' ? config.keys : map.cs },
        od: { original: map.od, converted: map.od }, hp: { original: map.hp, converted: map.hp },
        bpm: { realtime: kiai ? map.bpm : map.bpm, common: map.bpm, min: Math.round(map.bpm * 0.75), max: map.bpm },
        objects: countObjects(mode, objects), hitWindow: windows, maxCombo: total,
      },
    },
    play,
    leaderboard: [
      { isFailed: false, position: 1, team: 0, id: 1, name: 'mrekk', score: 98123456, accuracy: 99.21, hits: { 0: 0, 50: 0, 100: 12, 300: total - 12, geki: 0, katu: 0 }, combo: { current: total, max: total }, mods, rank: 'S' },
      { isFailed: false, position: 2, team: 0, id: 2, name: 'sxlvia', score: Math.round(score), accuracy, hits, combo: play.combo, mods, rank },
    ],
    performance: { accuracy: ppAcc, graph: { series: scenario.series, xaxis: scenario.xaxis } },
    resultsScreen: state === STATE.results ? {
      scoreId: 4400000000 + scenario.attempt, playerName: 'sxlvia', mode: modeObj, score: Math.round(score), accuracy, name: 'sxlvia', hits, mods,
      maxCombo, rank, pp: { current: pp.current, fc: pp.fc }, createdAt: new Date().toISOString(),
    } : { scoreId: 0, playerName: '', mode: modeObj, score: 0, accuracy: 0, name: '', hits: zeroHits(), mods, maxCombo: 0, rank: '', pp: { current: 0, fc: 0 }, createdAt: '' },
    files: { beatmap: 'map.osu', background: 'bg.jpg', audio: 'audio.mp3' },
    folders: { game: '', skin: '', songs: '', beatmap: '' },
    keys,
    settings: {
      mode: modeObj, mania: { scrollDirection: { number: 1, name: 'down' }, scrollSpeed: 24 },
      keybinds: { osu: { k1: 'Z', k2: 'X', smokeKey: 'C' }, fruits: { k1: 'Left', k2: 'Right', Dash: 'LeftShift' }, taiko: { innerLeft: 'X', innerRight: 'C', outerLeft: 'Z', outerRight: 'V' }, quickRetry: '`' },
      audio: { offset: { universal: 0 } }, skin: { name: '18-LAB' }, resolution: { width: 1920, height: 1080 },
    },
  };
  const precise = {
    keys, hitErrors, pressHitErrors, releaseHitErrors, tourney: [],
    ...(play.hitOffsets ? { hitOffsets: play.hitOffsets } : {}),
    ...(play.keyHitErrors ? { keyHitErrors: play.keyHitErrors } : {}),
    ...(catcher ? { catcher } : {}),
  };
  return { doc, precise };
}

function zeroHits() { return { 0: 0, 50: 0, 100: 0, 300: 0, geki: 0, katu: 0, sliderEndHits: 0, smallTickHits: 0, largeTickHits: 0 }; }

function countObjects(mode, objects) {
  const holds = mode === 'mania' ? objects.filter(o => o.ln).length : 0;
  const sliders = mode === 'osu' ? objects.filter(o => o.kind === 'slider').length : 0;
  return { circles: objects.length - holds - sliders, sliders, spinners: mode === 'osu' ? 3 : 0, holds, total: objects.length };
}

function accuracyOf(mode, h) {
  const n = h[300] + h[100] + h[50] + h[0] + h.geki + h.katu;
  if (!n) return 100;
  let value;
  if (mode === 'osu') value = (300 * h[300] + 100 * h[100] + 50 * h[50]) / (300 * (h[300] + h[100] + h[50] + h[0]));
  else if (mode === 'taiko') value = (h[300] + 0.5 * h[100]) / (h[300] + h[100] + h[0]);
  else if (mode === 'fruits') value = (h[300] + h[100] + h[50]) / (h[300] + h[100] + h[50] + h[0] + h.katu);
  else value = (305 * h.geki + 300 * h[300] + 200 * h.katu + 100 * h[100] + 50 * h[50]) / (305 * (h.geki + h[300] + h.katu + h[100] + h[50] + h[0]));
  return Math.round(value * 1e6) / 1e4;
}

function stddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

function keyState(name, intervals, t) {
  let count = 0, pressedAt = null, releasedAt = null, isPressed = false;
  for (const [start, end] of intervals) {
    if (start > t) break;
    count++;
    pressedAt = Math.round(start);
    if (end <= t) releasedAt = Math.round(end);
    else isPressed = true;
  }
  return { name, isPressed, count, pressedAt, releasedAt };
}

function catcherAt(t) {
  const path = scenario.path;
  if (!path.length) return 256;
  let i = path.findIndex(p => p[0] > t);
  if (i === -1) return path[path.length - 1][1];
  if (i === 0) return path[0][1];
  const [t0, x0] = path[i - 1], [t1, x1] = path[i];
  const f = (t - t0) / Math.max(1, t1 - t0);
  return Math.max(0, Math.min(512, x0 + (x1 - x0) * (f * f * (3 - 2 * f))));
}

// ---------------------------------------------------------------- JSON Pointer
function pointerGet(doc, pointer) {
  if (pointer === '') return doc;
  let value = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !(token in value)) return undefined;
    value = value[token];
  }
  return value;
}

// ---------------------------------------------------------------- server
let current = null;
let revision = 0;
function tick() {
  revision++;
  current = config.state === 'offline' ? null : documentAt();
  for (const client of subscribers) publish(client);
}

const subscribers = new Set();
const commandClients = new Set();
const overrides = new Map();

function publish(client) {
  const values = client.pointers.map(p => (current ? pointerGet(current.doc, p) : undefined));
  const encoded = values.map(v => (v === undefined ? undefined : JSON.stringify(v)));
  if (!client.sent) {
    client.sent = encoded;
    const pairs = encoded.flatMap((v, i) => (v === undefined ? [] : [`[${i},${v}]`]));
    client.ws.send(`[0,${revision},[${pairs.join(',')}]]`);
    return;
  }
  const present = [], absent = [];
  encoded.forEach((v, i) => {
    if (v === client.sent[i]) return;
    if (v === undefined) absent.push(i); else present.push(`[${i},${v}]`);
  });
  client.sent = encoded;
  if (present.length || absent.length) client.ws.send(`[1,${revision},[${present.join(',')}],[${absent.join(',')}]]`);
}

function overlayMeta(id) {
  const meta = { id, name: id, description: '', resolution: [1920, 1080] };
  const file = join(OVERLAYS, id, 'metadata.txt');
  if (!existsSync(file)) return meta;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    const value = rest.join('=').trim();
    if (!value) continue;
    if (key.trim() === 'resolution') meta.resolution = JSON.parse(value);
    else if (['name', 'description'].includes(key.trim())) meta[key.trim()] = value;
  }
  return meta;
}

/** Overlay framed at its declared resolution over a dimmed mock gameplay background. */
function stagePage(id, params) {
  let [width, height] = overlayMeta(id).resolution;
  width = Number(params.get('w')) || width;
  height = Number(params.get('h')) || height;
  const dim = Number(params.get('dim') ?? 0.55);
  const pad = Number(params.get('pad') ?? 32);
  return `<!doctype html><meta charset=utf-8><title>${id} · stage</title><style>html,body{margin:0;background:#000}body{width:${width + pad * 2}px;height:${height + pad * 2}px;position:relative;background:url(/files/beatmap/background) center/cover}body::before{content:"";position:absolute;inset:0;background:rgb(0 0 0 / ${dim})}iframe{position:absolute;left:${pad}px;top:${pad}px;width:${width}px;height:${height}px;border:0;outline:1px dashed rgb(255 255 255 / .18);background:transparent}</style><iframe src="/${id}/" allowtransparency="true"></iframe>`;
}

/** Every overlay live at once, each scaled into a card over the mock background, for review. */
function galleryPage() {
  const cards = overlayIds().map(overlayMeta).map(({ id, name, description, resolution: [w, h] }) => {
    const scale = Math.min(1, 440 / w, 300 / h);
    return `<figure><div class="frame" style="height:${Math.ceil(h * scale)}px"><iframe src="/${id}/" style="width:${w}px;height:${h}px;transform:scale(${scale})" loading="lazy"></iframe></div><figcaption><a href="/__dev/stage?id=${id}" target="_blank">${name}</a> <code>${id} · ${w}×${h}</code><p>${description}</p></figcaption></figure>`;
  }).join('');
  const modes = ['osu', 'taiko', 'fruits', 'mania'].flatMap(mode => ['menu', 'play', 'results'].map(state => `<button data-q="mode=${mode}&state=${state}&freeze=">${mode} ${state}</button>`)).join('');
  return `<!doctype html><meta charset=utf-8><title>overlay gallery</title><link rel="stylesheet" href="/assets/tokens.css"><style>html{background:#0b0c0d;color:#ebe8e1;font:14px var(--font-body)}body{margin:0;padding:20px}header{position:sticky;top:0;z-index:2;background:#0b0c0d;padding:8px 0 12px;display:flex;flex-wrap:wrap;gap:6px}button{font:12px var(--font-mono);background:#17191c;color:#ebe8e1;border:1px solid #3b3f45;padding:5px 8px;cursor:pointer}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:16px}figure{margin:0;background:#111214;border:1px solid #25282c;padding:10px}.frame{position:relative;overflow:hidden;background:url(/files/beatmap/background) center/cover}.frame::before{content:"";position:absolute;inset:0;background:rgb(0 0 0/.55)}iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:transparent}figcaption{margin-top:8px}figcaption a{color:#ff963f;font-weight:600}code{color:#7e8288;font:11px var(--font-mono);margin-left:6px}p{margin:4px 0 0;color:#b8b5ad;font-size:12px}</style><header>${modes}<button data-q="state=offline">offline</button><button data-q="ext=0">ext off</button><button data-q="ext=1">ext on</button><button data-q="keys=7">7K</button><button data-q="keys=4">4K</button><button data-q="client=lazer">lazer</button><button data-q="client=stable">stable</button></header><main>${cards}</main><script>for(const b of document.querySelectorAll('button'))b.onclick=()=>fetch('/__dev/scenario?'+b.dataset.q)</script>`;
}

function overlaySettings(id) {
  const file = join(OVERLAYS, id, 'settings.json');
  const values = {};
  if (existsSync(file)) for (const entry of JSON.parse(readFileSync(file, 'utf8'))) values[entry.uniqueID] = entry.value;
  return { ...values, ...(overrides.get(id) || {}) };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

function background() {
  const hue = { osu: 330, taiko: 18, fruits: 140, mania: 210 }[config.mode];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 45% 9%)"/></linearGradient><radialGradient id="r" cx=".72" cy=".3" r=".6"><stop offset="0" stop-color="hsl(${hue} 80% 62% / .55)"/><stop offset="1" stop-color="transparent"/></radialGradient></defs><rect width="1920" height="1080" fill="url(#g)"/><rect width="1920" height="1080" fill="url(#r)"/>${Array.from({ length: 14 }, (_, i) => `<circle cx="${(i * 389) % 1920}" cy="${(i * 233) % 1080}" r="${60 + (i * 37) % 180}" fill="none" stroke="hsl(${hue} 70% 70% / .12)" stroke-width="${2 + i % 5}"/>`).join('')}</svg>`;
}

async function assets(path) {
  if (VOSU_ASSETS) {
    const file = normalize(join(VOSU_ASSETS, path.slice('/assets/'.length)));
    if (!file.startsWith(normalize(VOSU_ASSETS)) || !existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
  }
  try {
    const upstream = await fetch(VOSU_URL + path);
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' } });
  } catch {
    return new Response('/assets unavailable: run vosu or set VOSU_ASSETS=<vosu>/assets/server', { status: 502 });
  }
}

function overlayIds() {
  return readdirSync(OVERLAYS).filter(id => existsSync(join(OVERLAYS, id, 'index.html'))).sort();
}

function controlPage() {
  const links = overlayIds().map(id => `<li><a href="/${id}/" target="_blank">${id}</a> · <a href="/__dev/stage?id=${id}" target="_blank">stage</a></li>`).join('');
  const presets = ['osu', 'taiko', 'fruits', 'mania'].flatMap(mode => ['play', 'menu', 'results'].map(state => `<a href="/__dev/scenario?mode=${mode}&state=${state}">${mode}/${state}</a>`)).join(' · ');
  return `<!doctype html><meta charset=utf-8><title>mock vosu</title><body style="font:14px system-ui;background:#111214;color:#ebe8e1;padding:24px"><h1>mock vosu</h1><p><a href="/__dev/gallery">Gallery of every overlay</a></p><p>Current: <code>${JSON.stringify(config)}</code></p><p>${presets} · <a href="/__dev/scenario?state=offline">offline</a> · <a href="/__dev/scenario?ext=0">no vosu extensions</a> · <a href="/__dev/scenario?keys=7">7K</a> · <a href="/__dev/scenario?client=lazer">lazer</a></p><ul>${links}</ul></body>`;
}

function file(id, rest) {
  const base = join(OVERLAYS, id);
  const path = normalize(join(base, rest || 'index.html'));
  if (!path.startsWith(base) || !existsSync(path) || statSync(path).isDirectory()) return new Response('not found', { status: 404 });
  if (path.endsWith('index.html')) {
    // vosu injects the counter identity ahead of the page's own scripts.
    const html = readFileSync(path, 'utf8').replace(/<head[^>]*>/i, match => `${match}<script>window.COUNTER_PATH=${JSON.stringify(id)};</script>`);
    return new Response(html, { headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
  }
  return new Response(Bun.file(path), { headers: { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' } });
}

function reset(params) {
  for (const key of ['mode', 'state', 'client']) if (params.has(key)) config[key] = params.get(key);
  if (params.has('keys')) config.keys = Number(params.get('keys'));
  if (params.has('ext')) config.ext = params.get('ext') !== '0';
  if (params.has('freeze')) config.freeze = params.get('freeze') || null;
  if (params.has('speed')) config.speed = Number(params.get('speed')) || 1;
  if (params.has('start')) config.start = Number(params.get('start')) || 0;
  scenario = build();
  // A new selection drops subscriber baselines, like a fresh vosu snapshot.
  for (const client of subscribers) client.sent = null;
  tick();
}

scenario = build();
tick();
setInterval(tick, 16);

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/websocket/v2/subscribe') return server.upgrade(request, { data: { kind: 'subscribe' } }) ? undefined : new Response('upgrade', { status: 400 });
    if (path === '/websocket/commands') return server.upgrade(request, { data: { kind: 'commands', overlay: url.searchParams.get('l') || '' } }) ? undefined : new Response('upgrade', { status: 400 });
    if (path === '/websocket/v2' || path === '/websocket/v2/precise') return server.upgrade(request, { data: { kind: path.endsWith('precise') ? 'precise' : 'v2' } }) ? undefined : new Response('upgrade', { status: 400 });
    if (path === '/json/v2') return current ? Response.json(current.doc) : Response.json({ error: 'osu is not ready/running' });
    if (path === '/json/v2/precise') return current ? Response.json(current.precise) : Response.json({ error: 'osu is not ready/running' });
    if (path === '/files/beatmap/background') return new Response(background(), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
    if (path.startsWith('/assets/')) return assets(path);
    if (path === '/__dev/' || path === '/__dev' || path === '/') return new Response(controlPage(), { headers: { 'content-type': TYPES['.html'] } });
    if (path === '/__dev/stage') return new Response(stagePage(url.searchParams.get('id') || '', url.searchParams), { headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    if (path === '/__dev/gallery') return new Response(galleryPage(), { headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' } });
    if (path === '/__dev/scenario') {
      if ([...url.searchParams.keys()].length) reset(url.searchParams);
      return request.headers.get('accept')?.includes('text/html') ? Response.redirect('/__dev/', 302) : Response.json(config);
    }
    if (path === '/__dev/settings') {
      const id = url.searchParams.get('id');
      const patch = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'id').map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v]));
      overrides.set(id, { ...(overrides.get(id) || {}), ...patch });
      const message = JSON.stringify({ command: 'updateSettings', message: overlaySettings(id) });
      for (const client of commandClients) if (client.data.overlay === id) client.send(message);
      return Response.json(overlaySettings(id));
    }
    const [, id, ...rest] = path.split('/');
    if (id && overlayIds().includes(id)) {
      if (!path.startsWith(`/${id}/`)) return Response.redirect(`/${id}/${url.search}`, 302);
      return file(id, rest.join('/'));
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === 'commands') commandClients.add(ws);
      if (ws.data.kind === 'v2' || ws.data.kind === 'precise') {
        const send = () => ws.send(JSON.stringify(current ? current[ws.data.kind === 'v2' ? 'doc' : 'precise'] : { error: 'osu is not ready/running' }));
        ws.data.timer = setInterval(send, ws.data.kind === 'v2' ? 100 : 16);
        send();
      }
    },
    message(ws, message) {
      if (ws.data.kind === 'subscribe') {
        if (ws.data.client) return ws.send('[2,5,"subscription already established"]');
        let pointers;
        try { pointers = JSON.parse(String(message)); } catch { return ws.send('[2,1,"invalid subscription request"]'); }
        if (!Array.isArray(pointers) || pointers.some(p => typeof p !== 'string' || (p && !p.startsWith('/')))) return ws.send('[2,2,"invalid JSON Pointer"]');
        ws.data.client = { ws, pointers, sent: null };
        subscribers.add(ws.data.client);
        publish(ws.data.client);
      } else if (ws.data.kind === 'commands') {
        const text = String(message);
        const [command, encoded] = text.split(':');
        const overlay = decodeURIComponent(encoded || '');
        if (command === 'getSettings') ws.send(JSON.stringify({ command, message: overlay === ws.data.overlay ? overlaySettings(overlay) : { error: 'Wrong overlay' } }));
      }
    },
    close(ws) {
      if (ws.data.client) subscribers.delete(ws.data.client);
      commandClients.delete(ws);
      clearInterval(ws.data.timer);
    },
  },
});

console.log(`mock vosu on http://127.0.0.1:${PORT}/__dev/ · ${JSON.stringify(config)}`);

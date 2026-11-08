// Copyright (c) 2026 18-LAB. MIT.
// Combo HUD: replaces osu!'s gameplay HUD for streamers who hide it. Combo, accuracy + rank,
// score, HP and map progress float in osu!'s own HUD spots (or one stack/strip in a free band).
// Gameplay only: song select and results already show all of this, so the page stays empty there.
import {
  subscribe, settings, fit, activeMode, isPlaying, formatDuration, osuLayout, mapPalette, applyPalette,
} from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const RING_STEPS = 720;           // progress ring redraws at most every half degree
const HP_MAX = 200;
const RESTART_JUMP_MS = 1500;     // the map clock jumping back this far is a retry, not a break
const EASE_OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';
const AMBER = '#ff963f';
const HP_WIDTH = 440;            // HP readout width at size 1 in HUD spots (label + 360 px gauge + value)
const COMBO_HEIGHT = 113;        // combo readout height at size 1 in HUD spots

const P = {
  state: '/state/number', client: '/client', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  source: '/play/source', failed: '/play/failed', score: '/play/score', acc: '/play/accuracy',
  combo: '/play/combo/current', peak: '/play/combo/max', hp: '/play/healthBar/normal', rank: '/play/rank/current',
  rate: '/play/mods/rate', live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject',
  mapMax: '/beatmap/stats/maxCombo', keys: '/beatmap/stats/cs/converted', checksum: '/beatmap/checksum',
};

const SOURCES = { replay: 'Replay', spectator: 'Spectating', watching: 'Watching', autoplay: 'Autoplay' };
// osu! grade strings: X/XH = SS (silver with HD/FL), SH = silver S. tosu-style "SS"/"SSH" also map.
const GRADES = {
  XH: ['SS', 'top', true], X: ['SS', 'top', false], SSH: ['SS', 'top', true], SS: ['SS', 'top', false],
  SH: ['S', 'top', true], S: ['S', 'top', false], A: ['A', 'top', false], B: ['B', 'low', false], C: ['C', 'low', false], D: ['D', 'd', false],
};
const SEPARATORS = { comma: ',', period: '.', 'thin space': '\u2009', apostrophe: '\u2019', none: '' };
const LAYOUTS = { 'osu! HUD spots': 'hud', stack: 'stack', strip: 'strip' };
const CHIP_TEXT = { connecting: 'Connecting to vosu', offline: 'vosu offline', idle: 'osu! not running' };

const DEFAULTS = {
  layout: 'osu! HUD spots', zone: 'auto', offsetX: 0, offsetY: 0, size: 1,
  columnWidth: 30, columnStart: 136, separator: 'comma', backing: 'none', accent: 'map',
  showCombo: true, showAccuracy: true, showRank: true, showScore: true, showHealth: true, showProgress: true, showBrand: true,
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const el = {
  group: $('group'), source: $('source'), brand: $('brand'),
  comboCell: $('combo-cell'), combo: $('combo'), comboNum: $('combo-num'), comboLabel: $('combo-label'), breakLabel: $('break-label'),
  peakValue: $('peak-value'), ghost: $('ghost'), ghostNum: $('ghost-num'),
  rail: $('rail'), railFill: $('rail-fill'), railPeak: $('rail-peak'), railBreak: $('rail-break'),
  scoreCluster: $('score-cluster'), scoreCell: $('score-cell'), scoreLead: $('score-lead'), score: $('score'),
  accCell: $('acc-cell'), acc: $('acc'), rank: $('rank'), progCell: $('prog-cell'), ring: $('ring'), time: $('time'),
  hpCell: $('hp-cell'), hpFill: $('hp-fill'), hp: $('hp'),
  status: $('status'), statusText: $('status-text'),
};
const CLUSTERS = [el.comboCell, el.scoreCluster, el.hpCell];

fit(stage, WIDTH, HEIGHT);

// ── Animations: built once, restarted in place (compositor transform/opacity, no allocation) ──

function prepared(target, frames, options) {
  const animation = target.animate(frames, options);
  animation.cancel();
  return animation;
}
function replay(animation) {
  animation.cancel();
  animation.play();
}
const anim = {
  bump: prepared(el.combo, [{ transform: 'scale(1.075)' }, { transform: 'scale(1)' }], { duration: 150, easing: EASE_OUT }),
  // Break: the lost combo drops onto the rail in red while the reset count rises in behind it.
  reveal: prepared(el.combo, [
    { opacity: 0, transform: 'translateY(12px)' },
    { opacity: 0, transform: 'translateY(12px)', offset: 0.62, easing: EASE_OUT },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 400 }),
  ghost: prepared(el.ghost, [
    { offset: 0, opacity: 1, transform: 'translateY(0)' },
    { offset: 0.3, opacity: 1, transform: 'translateY(0)', easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
    { offset: 0.8, opacity: 0 },
    { offset: 1, opacity: 0, transform: 'translateY(22px)' },
  ], { duration: 340 }),
  railBreak: prepared(el.railBreak, [{ opacity: 1 }, { opacity: 0 }], { duration: 520, easing: EASE_OUT }),
  breakLabel: prepared(el.breakLabel, [{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 900 }),
  comboLabel: prepared(el.comboLabel, [{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: 900 }),
};

// ── State: handlers fill `want`; one rAF applies the difference to the DOM ──

const want = {
  status: 'connecting', absent: true, on: false, mode: 'osu', keys: 4, client: 'stable', source: '', failed: false,
  combo: null, peak: null, mapMax: null, acc: null, rank: '', score: null, hp: null,
  step: -1, remain: -1, restart: false,
};
const shown = {
  status: '', on: false, source: null, failed: null, combo: null, comboText: null, peakText: null,
  rail: NaN, railPeak: NaN, railOff: null, acc: null, rank: null, score: null, scoreText: null,
  hp: NaN, hpText: null, hpLow: null, step: NaN, remain: NaN,
};
let cfg = { ...DEFAULTS };
let frame = 0;
let placeDirty = true;
let lastLive = null;
let checksum = '';
let mapAccent = null;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = value => (typeof value === 'string' ? value : '');

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

// Map tint, loaded per checksum during play only (off the hot path; song select scrolling never decodes art).
function loadPalette(next) {
  checksum = next;
  mapPalette(next).then(palette => {
    if (checksum !== next) return;
    applyPalette(stage, palette);
    mapAccent = palette?.accent ?? null;
    shown.step = NaN;
    schedule();
  });
}

function onFrame(v) {
  const state = v[P.state];
  const playing = isPlaying(state);
  let dirty = false;
  const set = (key, value) => { if (want[key] !== value) { want[key] = value; dirty = true; } };

  set('absent', state === undefined);
  set('on', playing);
  if (!playing) {
    lastLive = null;
    if (dirty) schedule();
    return;
  }

  const mode = activeMode(state, v[P.playMode], v[P.settingsMode]) ?? 'osu';
  const keys = Math.round(num(v[P.keys]) ?? 4);
  const client = v[P.client] === 'lazer' ? 'lazer' : 'stable';
  if (mode !== want.mode || client !== want.client || (mode === 'mania' && keys !== want.keys)) {
    want.mode = mode; want.client = client; want.keys = keys;
    placeDirty = true; dirty = true;
  }
  const sum = str(v[P.checksum]);
  if (sum && sum !== checksum) loadPalette(sum);

  const live = num(v[P.live]);
  if (live !== null && lastLive !== null && live < lastLive - RESTART_JUMP_MS) want.restart = true;
  lastLive = live;
  const mapMax = num(v[P.mapMax]);
  set('mapMax', mapMax !== null && mapMax > 0 ? mapMax : null);
  set('source', SOURCES[v[P.source]] ?? '');
  set('failed', v[P.failed] === true);
  set('combo', num(v[P.combo]));
  set('peak', num(v[P.peak]));
  set('acc', num(v[P.acc]));
  set('rank', str(v[P.rank]));
  set('score', num(v[P.score]));
  set('hp', num(v[P.hp]));
  const first = num(v[P.first]);
  const last = num(v[P.last]);
  if (live !== null && first !== null && last !== null && last > first) {
    const progress = Math.min(1, Math.max(0, (live - first) / (last - first)));
    const rate = num(v[P.rate]) || 1;
    set('step', Math.round(progress * RING_STEPS));
    set('remain', Math.ceil(Math.max(0, last - Math.max(live, first)) / rate / 1000));
  } else {
    set('step', -1);
    set('remain', -1);
  }
  if (dirty) schedule();
}

function onStatus(state) {
  if (want.status === state) return;
  want.status = state;
  schedule();
}

// ── Placement (osuLayout geometry; style writes only, no layout reads) ──

// Anchor a box by any two of left/right/top/bottom and grow its scale away from that corner.
function anchor(node, { left, right, top, bottom, centerX }, align) {
  node.style.left = centerX !== undefined ? `${centerX}px` : left !== undefined ? `${left}px` : '';
  node.style.right = right !== undefined && centerX === undefined ? `${right}px` : '';
  node.style.top = top !== undefined ? `${top}px` : '';
  node.style.bottom = bottom !== undefined ? `${bottom}px` : '';
  node.style.setProperty('--tx', centerX !== undefined ? '-50%' : '0px');
  const ox = centerX !== undefined ? '50%' : right !== undefined ? '100%' : '0';
  node.style.transformOrigin = `${ox} ${bottom !== undefined ? '100%' : '0'}`;
  if (align) node.dataset.align = align;
}

function place() {
  placeDirty = false;
  const layoutName = LAYOUTS[cfg.layout] ?? 'hud';
  const { mode, keys, client } = want;
  const L = osuLayout(mode, { keys, columnWidth: cfg.columnWidth, columnStart: cfg.columnStart, client, width: WIDTH, height: HEIGHT });
  const { busy, hud } = L;
  const ox = cfg.offsetX;
  const oy = cfg.offsetY;
  const nudge = box => ({
    left: box.left !== undefined ? box.left + ox : undefined,
    right: box.right !== undefined ? box.right - ox : undefined,
    centerX: box.centerX !== undefined ? box.centerX + ox : undefined,
    top: box.top !== undefined ? box.top + oy : undefined,
    bottom: box.bottom !== undefined ? box.bottom - oy : undefined,
  });
  stage.dataset.layout = layoutName;

  if (layoutName === 'hud') {
    for (const node of CLUSTERS) if (node.parentElement !== stage) stage.insertBefore(node, el.status);
    delete el.group.dataset.align;
    anchor(el.scoreCluster, nudge({ right: WIDTH - hud.score.x - hud.score.w + 4, top: hud.score.y + 8 }), 'end');
    let combo;
    if (hud.combo) combo = { left: hud.combo.x + 8, bottom: HEIGHT - hud.combo.y - hud.combo.h + 12 };
    // Mania draws its combo inside the stage: use the wider band beside it instead.
    // 64 px clears stable's own HP bar, which hugs the stage's right edge.
    else if (busy.x >= WIDTH - busy.x - busy.w) combo = { right: WIDTH - busy.x + 64, bottom: 32 };
    else combo = { left: busy.x + busy.w + 64, bottom: 32 };
    const align = combo.right !== undefined ? 'end' : 'start';
    anchor(el.comboCell, nudge(combo), align);
    anchor(el.status, nudge(combo));
    // HP sits at osu!'s top-left health bar unless the stage runs through it (stable mania puts the
    // stage at ColumnStart); then it stacks above the combo in the same free band.
    const scale = clamp(cfg.size, 0.5, 3);
    const hpLeft = hud.health.x + 8;
    if (hpLeft < busy.x + busy.w && hpLeft + HP_WIDTH * scale > busy.x && busy.y < hud.health.y + hud.health.h) {
      const lift = cfg.showCombo ? COMBO_HEIGHT * scale + 28 : 0;
      anchor(el.hpCell, nudge({ ...combo, bottom: combo.bottom + lift }), align);
    } else {
      anchor(el.hpCell, nudge({ left: hpLeft, top: hud.health.y + 12 }), 'start');
    }
    shown.step = NaN;
    return;
  }

  for (const node of CLUSTERS) {
    if (node.parentElement !== el.group) el.group.append(node);
    node.style.left = node.style.right = node.style.top = node.style.bottom = '';
  }
  let box;
  let align = 'start';
  const zone = cfg.zone;
  if (mode === 'taiko') {
    // Below the lane: the largest empty area of the taiko screen.
    if (layoutName === 'strip' && zone === 'auto') box = { centerX: WIDTH / 2, bottom: 48 };
    else if (zone === 'right') { box = { right: 40, bottom: 40 }; align = 'end'; } else box = { left: 40, bottom: 40 };
  } else if (mode === 'mania') {
    const leftRoom = busy.x;
    const rightRoom = WIDTH - busy.x - busy.w;
    const side = zone === 'auto' ? (rightRoom >= leftRoom ? 'right' : 'left') : zone;
    if (side === 'right') box = { left: busy.x + busy.w + 64, bottom: 40 };
    else { box = { right: WIDTH - busy.x + 64, bottom: 40 }; align = 'end'; }
  } else if (layoutName === 'strip' && zone === 'auto') {
    // The band under the 4:3 playfield.
    box = { centerX: busy.x + busy.w / 2, bottom: 6 };
  } else if (zone === 'left') {
    box = { right: WIDTH - busy.x + 32, bottom: 32 }; align = 'end';
  } else {
    box = { left: busy.x + busy.w + 32, bottom: 32 };
  }
  for (const node of CLUSTERS) node.dataset.align = align;
  anchor(el.group, nudge(box), align);
  anchor(el.status, nudge(box));
  shown.step = NaN;
}

// ── Formatting ──

function writeText(node, key, text) {
  if (shown[key] === text) return;
  shown[key] = text;
  node.textContent = text;
}

function writeScore(score) {
  if (score === null) {
    if (shown.scoreText === '') return;
    shown.scoreText = '';
    el.scoreLead.textContent = '';
    el.score.textContent = '—';
    el.scoreCell.dataset.empty = '';
    return;
  }
  const sep = SEPARATORS[cfg.separator] ?? ',';
  const digits = String(Math.max(0, Math.round(score))).padStart(8, '0');
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += sep;
    grouped += digits[i];
  }
  if (shown.scoreText === grouped) return;
  shown.scoreText = grouped;
  // Leading zeros (and the separators between them) stay dim, like an odometer.
  let split = 0;
  while (split < grouped.length - 1 && (grouped[split] === '0' || grouped[split] === sep)) split++;
  el.scoreLead.textContent = grouped.slice(0, split);
  el.score.textContent = grouped.slice(split);
  delete el.scoreCell.dataset.empty;
}

// ── Progress ring (canvas, DPR-aware, sized on resize only) ──

const ringCtx = el.ring.getContext('2d', { alpha: true });
let ringDpr = 1;
new ResizeObserver(([entry]) => {
  ringDpr = window.devicePixelRatio || 1;
  const px = Math.round(entry.contentRect.width * ringDpr);
  el.ring.width = px;
  el.ring.height = px;
  shown.step = NaN;
  schedule();
}).observe(el.ring);

function drawRing(step) {
  const size = el.ring.width;
  ringCtx.clearRect(0, 0, size, size);
  if (!size) return;
  const d = ringDpr;
  const line = 3 * d;
  const c = size / 2;
  const r = c - line / 2 - 1.5 * d;
  ringCtx.lineWidth = line;
  // Dark under-stroke keeps the ring legible on bright backgrounds (the type's shadow, for canvas).
  ringCtx.strokeStyle = 'rgba(8, 9, 10, 0.55)';
  ringCtx.beginPath();
  ringCtx.arc(c, c, r, 0, Math.PI * 2);
  ringCtx.lineWidth = line + 2 * d;
  ringCtx.stroke();
  ringCtx.lineWidth = line;
  ringCtx.strokeStyle = 'rgba(235, 232, 225, 0.22)';
  ringCtx.stroke();
  if (step > 0) {
    ringCtx.strokeStyle = cfg.accent === 'map' && mapAccent ? mapAccent : AMBER;
    ringCtx.beginPath();
    ringCtx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * step) / RING_STEPS);
    ringCtx.stroke();
  }
  // Bright index at 12 o'clock.
  const w = Math.max(1, Math.round(d));
  ringCtx.fillStyle = '#ebe8e1';
  ringCtx.fillRect(Math.round(c - w / 2), 0, w, Math.ceil(c - r + line / 2 + d));
}

// ── Render ──

function render() {
  frame = 0;
  if (placeDirty) place();
  const live = want.status === 'live';
  const on = want.on && live;
  // Chip: connection trouble, or vosu up with osu! not running. Otherwise only gameplay shows anything.
  const chip = live ? (want.absent ? 'idle' : '') : want.status;
  if (shown.status !== chip) {
    shown.status = chip;
    if (chip) {
      el.status.dataset.state = chip;
      el.statusText.textContent = CHIP_TEXT[chip];
      el.status.dataset.show = '';
    } else {
      delete el.status.dataset.show;
    }
  }
  if (shown.on !== on) {
    if (on) stage.dataset.on = ''; else delete stage.dataset.on;
  }
  const animate = on && shown.on;
  shown.on = on;
  if (!on) {
    // Hidden: forget the attempt so the next one starts without a spurious bump or break.
    shown.combo = null;
    want.restart = false;
    return;
  }

  if (shown.source !== want.source) {
    shown.source = want.source;
    el.source.textContent = want.source;
    el.source.hidden = !want.source;
  }

  // Combo: bump on increment, break flash on loss (not on a retry).
  const combo = want.combo;
  const previous = shown.combo;
  if (animate && combo !== null && previous !== null && combo !== previous) {
    if (combo > previous) {
      replay(anim.bump);
    } else if (!want.restart && !(want.score !== null && shown.score !== null && want.score < shown.score)) {
      el.ghostNum.textContent = String(previous);
      anim.bump.cancel();
      replay(anim.reveal);
      replay(anim.ghost);
      replay(anim.railBreak);
      replay(anim.breakLabel);
      replay(anim.comboLabel);
    }
  }
  want.restart = false;
  shown.combo = combo;
  const comboText = combo === null ? '—' : String(combo);
  if (shown.comboText !== comboText) {
    shown.comboText = comboText;
    el.comboNum.textContent = comboText;
    if (combo === null) el.combo.dataset.empty = ''; else delete el.combo.dataset.empty;
  }
  writeText(el.peakValue, 'peakText', want.peak === null ? '—' : String(want.peak));

  const mapMax = want.mapMax;
  const railOff = mapMax === null;
  if (shown.railOff !== railOff) {
    shown.railOff = railOff;
    if (railOff) el.rail.dataset.off = ''; else delete el.rail.dataset.off;
  }
  if (!railOff) {
    const fill = Math.round(Math.min(1, (combo ?? 0) / mapMax) * 1000) / 1000;
    const peak = Math.round(Math.min(1, (want.peak ?? 0) / mapMax) * 1000) / 1000;
    if (shown.rail !== fill) { shown.rail = fill; el.railFill.style.transform = `scaleX(${fill})`; }
    if (shown.railPeak !== peak) { shown.railPeak = peak; el.railPeak.style.transform = `translateX(${(peak - 1) * 100}%)`; }
  }

  // Accuracy + rank.
  if (shown.acc !== want.acc) {
    shown.acc = want.acc;
    el.acc.textContent = want.acc === null ? '—' : want.acc.toFixed(2);
    if (want.acc === null) el.accCell.dataset.empty = ''; else delete el.accCell.dataset.empty;
  }
  const rankKey = cfg.showRank ? want.rank : '';
  if (shown.rank !== rankKey) {
    shown.rank = rankKey;
    const grade = GRADES[rankKey];
    el.rank.hidden = !grade;
    if (grade) {
      el.rank.textContent = grade[0];
      el.rank.dataset.tone = grade[1];
      if (grade[2]) el.rank.dataset.silver = ''; else delete el.rank.dataset.silver;
    }
  }

  writeScore(want.score);
  shown.score = want.score;

  // Health (0–200). Low under a quarter; a failed attempt reads FAIL.
  const hp = want.hp === null ? -1 : Math.round(Math.min(HP_MAX, Math.max(0, want.hp)) * 2) / 2;
  if (shown.hp !== hp) {
    shown.hp = hp;
    el.hpFill.style.transform = `scaleX(${Math.max(0, hp) / HP_MAX})`;
  }
  writeText(el.hp, 'hpText', want.failed ? 'Fail' : hp < 0 ? '—' : `${Math.round((hp / HP_MAX) * 100)}%`);
  const low = hp >= 0 && hp < HP_MAX / 4;
  if (shown.hpLow !== low) {
    shown.hpLow = low;
    if (low) el.hpCell.dataset.low = ''; else delete el.hpCell.dataset.low;
  }
  if (shown.failed !== want.failed) {
    shown.failed = want.failed;
    if (want.failed) el.hpCell.dataset.failed = ''; else delete el.hpCell.dataset.failed;
  }

  // Progress ring + remaining time.
  if (shown.step !== want.step && !el.progCell.hidden) {
    shown.step = want.step;
    drawRing(want.step);
  }
  if (shown.remain !== want.remain) {
    shown.remain = want.remain;
    el.time.textContent = want.remain < 0 ? '—' : want.remain === 0 ? '0:00' : `\u2212${formatDuration(want.remain * 1000)}`;
  }
}

// ── Settings ──

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

settings(DEFAULTS, next => {
  const separatorChanged = next.separator !== cfg.separator;
  cfg = {
    ...next,
    zone: ['auto', 'left', 'right'].includes(next.zone) ? next.zone : 'auto',
    offsetX: clamp(next.offsetX, -1920, 1920),
    offsetY: clamp(next.offsetY, -1080, 1080),
    columnWidth: clamp(next.columnWidth, 10, 120),
    columnStart: clamp(next.columnStart, 0, 600),
  };
  stage.dataset.backing = ['scrim', 'panel'].includes(cfg.backing) ? cfg.backing : 'none';
  stage.dataset.accent = cfg.accent === '18-lab' ? '18-lab' : 'map';
  stage.style.setProperty('--scale', String(clamp(cfg.size, 0.5, 3)));
  el.brand.hidden = !cfg.showBrand;
  el.comboCell.hidden = !cfg.showCombo;
  el.scoreCell.hidden = !cfg.showScore;
  el.accCell.hidden = !cfg.showAccuracy;
  el.progCell.hidden = !cfg.showProgress;
  el.hpCell.hidden = !cfg.showHealth;
  el.scoreCluster.hidden = !cfg.showScore && !cfg.showAccuracy && !cfg.showProgress && !cfg.showRank && !cfg.showBrand;
  if (separatorChanged) shown.scoreText = null;
  shown.rank = null;
  shown.step = NaN;
  placeDirty = true;
  schedule();
});

subscribe(Object.values(P), onFrame, { onStatus });

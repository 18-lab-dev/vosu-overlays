// Copyright (c) 2026 18-LAB. MIT.
// Combo HUD: combo, accuracy + rank, score, health and map progress for streamers who hide the
// in-game HUD. Visible only during play (state 2) and on the results screen (state 7).
import { subscribe, settings, fit, activeMode, isPlaying, formatDuration, MODE_LABELS } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const RESULTS = 7;
const RING_STEPS = 720;          // progress ring redraws at most every half degree
const HP_MAX = 200;
const RESTART_JUMP_MS = 1500;     // the map clock jumping back this far is a retry, not a break
const EASE_OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';

const P = {
  state: '/state/number', playMode: '/play/mode/number', settingsMode: '/settings/mode/number',
  source: '/play/source', failed: '/play/failed', score: '/play/score', acc: '/play/accuracy',
  combo: '/play/combo/current', peak: '/play/combo/max', hp: '/play/healthBar/normal', rank: '/play/rank/current',
  rate: '/play/mods/rate', live: '/beatmap/time/live', first: '/beatmap/time/firstObject', last: '/beatmap/time/lastObject',
  mapMax: '/beatmap/stats/maxCombo',
  rScore: '/resultsScreen/score', rAcc: '/resultsScreen/accuracy', rMax: '/resultsScreen/maxCombo', rRank: '/resultsScreen/rank',
};

const SOURCES = { replay: 'Replay', spectator: 'Spectating', watching: 'Watching', autoplay: 'Autoplay' };
// osu! grade strings: X/XH = SS (silver with HD/FL), SH = silver S. Mock and tosu may send "SS".
const GRADES = {
  XH: ['SS', 'top', true], X: ['SS', 'top', false], SSH: ['SS', 'top', true], SS: ['SS', 'top', false],
  SH: ['S', 'top', true], S: ['S', 'top', false], A: ['A', 'top', false], B: ['B', 'low', false], C: ['C', 'low', false], D: ['D', 'd', false],
};
const SEPARATORS = { comma: ',', period: '.', 'thin space': '\u2009', apostrophe: '\u2019', none: '' };
const ANCHORS = new Set(['top-left', 'top-right', 'top-center', 'bottom-left', 'bottom-right', 'bottom-center']);
const CHIP_TEXT = { connecting: 'Connecting to vosu', offline: 'vosu offline', idle: 'osu! not running' };

const DEFAULTS = {
  layout: 'corner stack', anchor: 'bottom-left', inset: 32, size: 1, separator: 'comma',
  showCombo: true, showAccuracy: true, showRank: true, showScore: true, showHealth: true, showProgress: true, showBrand: true,
};

const $ = id => document.getElementById(id);
const stage = $('stage');
const hud = $('hud');
const el = {
  brand: $('brand'), mode: $('mode'), source: $('source'), resultsTag: $('results-tag'),
  comboCell: $('combo-cell'), combo: $('combo'), comboNum: $('combo-num'), comboLabel: $('combo-label'), breakLabel: $('break-label'),
  peakLabel: $('peak-label'), peakValue: $('peak-value'), ghost: $('ghost'), ghostNum: $('ghost-num'),
  rail: $('rail'), railFill: $('rail-fill'), railPeak: $('rail-peak'), railBreak: $('rail-break'),
  accCell: $('acc-cell'), acc: $('acc'), rank: $('rank'),
  scoreCell: $('score-cell'), scoreLead: $('score-lead'), score: $('score'),
  hpCell: $('hp-cell'), hpFill: $('hp-fill'), hp: $('hp'),
  progCell: $('prog-cell'), ring: $('ring'), time: $('time'),
  status: $('status'), statusText: $('status-text'),
};
const accReadout = el.acc.parentElement;
const scoreReadout = el.score.parentElement;

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
  status: 'connecting', absent: true, on: false, results: false, mode: '', source: '', failed: false,
  combo: null, peak: null, mapMax: null, acc: null, rank: '', score: null, hp: null,
  step: -1, remain: -1, restart: false,
};
const shown = {
  status: '', on: false, results: null, mode: null, source: null, failed: null,
  combo: null, peakText: null, comboText: null, rail: NaN, railPeak: NaN, railOff: null, acc: null, rank: null,
  score: null, scoreText: null, hp: NaN, hpText: null, hpLow: null, step: NaN, remain: NaN,
};
let cfg = { ...DEFAULTS };
let frame = 0;
let heldHp = null;
let lastLive = null;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = value => (typeof value === 'string' ? value : '');

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function onFrame(v) {
  const state = v[P.state];
  const playing = isPlaying(state);
  const results = state === RESULTS;
  let dirty = false;
  const set = (key, value) => { if (want[key] !== value) { want[key] = value; dirty = true; } };

  set('absent', state === undefined);
  set('on', playing || results);
  set('results', results);
  set('mode', MODE_LABELS[activeMode(state, v[P.playMode], v[P.settingsMode])] ?? '');
  const mapMax = num(v[P.mapMax]);
  set('mapMax', mapMax !== null && mapMax > 0 ? mapMax : null);

  if (playing) {
    const live = num(v[P.live]);
    if (live !== null && lastLive !== null && live < lastLive - RESTART_JUMP_MS) want.restart = true;
    lastLive = live;
    const hp = num(v[P.hp]);
    heldHp = hp;
    set('source', SOURCES[v[P.source]] ?? '');
    set('failed', v[P.failed] === true);
    set('combo', num(v[P.combo]));
    set('peak', num(v[P.peak]));
    set('acc', num(v[P.acc]));
    set('rank', str(v[P.rank]));
    set('score', num(v[P.score]));
    set('hp', hp);
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
  } else if (results) {
    // Results hold the final values from the results screen; HP holds the last gameplay value.
    lastLive = null;
    set('source', '');
    set('failed', false);
    set('combo', num(v[P.rMax]));
    set('peak', null);
    set('acc', num(v[P.rAcc]));
    set('rank', str(v[P.rRank]));
    set('score', num(v[P.rScore]));
    set('hp', heldHp);
    set('step', RING_STEPS);
    set('remain', 0);
  } else {
    lastLive = null;
    heldHp = null;
  }
  if (dirty) schedule();
}

function onStatus(state) {
  if (want.status === state) return;
  want.status = state;
  schedule();
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
    scoreReadout.dataset.empty = '';
    delete scoreReadout.dataset.long;
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
  delete scoreReadout.dataset.empty;
  // Ten-digit ScoreV1 totals step down a size so they never spill out of the cell.
  if (grouped.length > 11) scoreReadout.dataset.long = ''; else delete scoreReadout.dataset.long;
}

// ── Progress ring (canvas, DPR-aware, sized on resize only) ──

const ringCtx = el.ring.getContext('2d', { alpha: true });
let ringCss = 0;
let ringDpr = 1;
let colors = null;
new ResizeObserver(([entry]) => {
  ringCss = entry.contentRect.width;
  ringDpr = window.devicePixelRatio || 1;
  const px = Math.round(ringCss * ringDpr);
  el.ring.width = px;
  el.ring.height = px;
  shown.step = NaN;
  schedule();
}).observe(el.ring);

function drawRing(step) {
  const size = el.ring.width;
  ringCtx.clearRect(0, 0, size, size);
  if (!size) return;
  if (!colors) {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    colors = { track: read('--rule-strong', '#3b3f45'), arc: read('--accent', '#ff963f'), cut: read('--bg', '#111214'), index: read('--fg', '#ebe8e1') };
  }
  const d = ringDpr;
  const line = (ringCss >= 56 ? 3 : 2.5) * d;
  const c = size / 2;
  const r = c - line / 2 - 2 * d;
  ringCtx.lineWidth = line;
  ringCtx.lineCap = 'butt';
  ringCtx.strokeStyle = colors.track;
  ringCtx.beginPath();
  ringCtx.arc(c, c, r, 0, Math.PI * 2);
  ringCtx.stroke();
  if (step > 0) {
    ringCtx.strokeStyle = colors.arc;
    ringCtx.beginPath();
    ringCtx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * step) / RING_STEPS);
    ringCtx.stroke();
  }
  // Quarter cuts like the HP gauge, and a bright index at 12 o'clock.
  const w = Math.max(1, Math.round(d));
  ringCtx.fillStyle = colors.cut;
  const inner = Math.floor(c - r - line / 2);
  const outer = Math.ceil(c - r + line / 2);
  const mid = Math.round(c - w / 2);
  ringCtx.fillRect(size - outer, mid, outer - inner, w);
  ringCtx.fillRect(mid, size - outer, w, outer - inner);
  ringCtx.fillRect(inner, mid, outer - inner, w);
  ringCtx.fillStyle = colors.index;
  ringCtx.fillRect(mid, 0, w, outer + d);
}

// ── Render ──

function render() {
  frame = 0;
  const live = want.status === 'live';
  const on = want.on && live;
  // Chip: connection trouble, or vosu up with osu! not running. Otherwise the page is empty.
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
    if (on) hud.dataset.on = ''; else delete hud.dataset.on;
  }
  // Animate only on a visible panel, within one attempt.
  const animate = on && shown.on && shown.results === want.results;
  shown.on = on;

  if (shown.results !== want.results) {
    shown.results = want.results;
    el.resultsTag.hidden = !want.results;
    el.comboLabel.textContent = want.results ? 'Max combo' : 'Combo';
    el.peakLabel.textContent = want.results ? 'Of' : 'Peak';
    shown.peakText = null;
  }
  writeText(el.mode, 'mode', want.mode);
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
    } else if (combo < previous && !want.restart && !(want.score !== null && shown.score !== null && want.score < shown.score)) {
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
  writeText(el.peakValue, 'peakText', want.results ? (want.mapMax === null ? '—' : String(want.mapMax)) : (want.peak === null ? '—' : String(want.peak)));

  const mapMax = want.mapMax;
  const railOff = mapMax === null;
  if (shown.railOff !== railOff) {
    shown.railOff = railOff;
    if (railOff) el.rail.dataset.off = ''; else delete el.rail.dataset.off;
  }
  if (!railOff) {
    const fill = Math.round(Math.min(1, (combo ?? 0) / mapMax) * 1000) / 1000;
    const peakSource = want.results ? combo : want.peak;
    const peak = Math.round(Math.min(1, (peakSource ?? 0) / mapMax) * 1000) / 1000;
    if (shown.rail !== fill) { shown.rail = fill; el.railFill.style.transform = `scaleX(${fill})`; }
    if (shown.railPeak !== peak) { shown.railPeak = peak; el.railPeak.style.transform = `translateX(${(peak - 1) * 100}%)`; }
  }

  // Accuracy + rank.
  if (shown.acc !== want.acc) {
    shown.acc = want.acc;
    el.acc.textContent = want.acc === null ? '—' : want.acc.toFixed(2);
    if (want.acc === null) accReadout.dataset.empty = ''; else delete accReadout.dataset.empty;
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
  cfg = next;
  stage.dataset.anchor = ANCHORS.has(cfg.anchor) ? cfg.anchor : DEFAULTS.anchor;
  hud.dataset.layout = cfg.layout === 'horizontal' ? 'horizontal' : 'stack';
  stage.style.setProperty('--inset', `${clamp(cfg.inset, 0, 480)}px`);
  stage.style.setProperty('--scale', String(clamp(cfg.size, 0.5, 3)));
  el.brand.hidden = !cfg.showBrand;
  el.comboCell.hidden = !cfg.showCombo;
  el.accCell.hidden = !cfg.showAccuracy;
  el.scoreCell.hidden = !cfg.showScore;
  el.hpCell.hidden = !cfg.showHealth;
  el.progCell.hidden = !cfg.showProgress;
  if (separatorChanged) shown.scoreText = null;
  shown.rank = null;
  shown.step = NaN;
  schedule();
});

subscribe(Object.values(P), onFrame, { onStatus });

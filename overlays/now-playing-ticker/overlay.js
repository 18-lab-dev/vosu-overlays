// Copyright (c) 2026 18-LAB. MIT.
// Now playing ticker: during gameplay, the map in one line (artist — title [diff], stars, mods,
// mapper) with a play-progress hairline, a rolling change between maps and a paused marquee for
// lines that do not fit. The page is the overlay's box: it re-flows to a single line, a two-line
// stack or a side column from the box it is given. Song select and results already show all of
// this, so nothing appears there.
import { subscribe, settings, activeMode, mapPalette, applyPalette } from './vosu-overlay.js';

const PLAYING = 2;
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
// `align: auto` per ruleset, matching the suggested placements: centred in the osu!/catch top
// strip, right-aligned in the bottom-right corner under the taiko lane, against the mania stage.
const AUTO_ALIGN = { osu: 'center', fruits: 'center', taiko: 'right', mania: 'right' };

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  artist: '/beatmap/artist',
  artistUnicode: '/beatmap/artistUnicode',
  title: '/beatmap/title',
  titleUnicode: '/beatmap/titleUnicode',
  version: '/beatmap/version',
  mapper: '/beatmap/mapper',
  checksum: '/beatmap/checksum',
  stars: '/beatmap/stats/stars/total',
  mods: '/play/mods/array',
  live: '/beatmap/time/live',
  first: '/beatmap/time/firstObject',
  last: '/beatmap/time/lastObject',
};
const META = [P.state, P.artist, P.artistUnicode, P.title, P.titleUnicode, P.version, P.mapper, P.checksum, P.stars, P.mods];
const MODE = [P.state, P.playMode, P.settingsMode];
const TIME = [P.state, P.live, P.first, P.last];
const RATE_MODS = new Set(['DT', 'NC', 'HT', 'DC']);

const $ = selector => document.querySelector(selector);
const root = $('#root');
const panel = $('#panel');
const bg = $('.bg');
const fill = $('.prog i');
const roll = $('.roll');
const vp = $('.vp');
const track = $('.track');
const el = {
  status: $('#status'), artist: $('.artist'), sep: $('.sep'), title: $('.title'), version: $('.ver'),
  stars: $('.stars'), starsNum: $('.stars .num'), mods: $('.mods'), mapper: $('.mapper'), mapperName: $('.mapper .name'),
};

// ------------------------------------------------------------------ state
const defaults = {
  orientation: 'auto', align: 'auto', backing: 'none', accent: 'map',
  unicode: false, showStars: true, showMods: true, showMapper: true, overflow: 'marquee',
};
let opts = { ...defaults };
let link = 'connecting';
let values = null;
let target = null;      // content the data asks for
let shown = null;       // content on screen
let visible = true;
let rolling = false;
let contentDirty = false;
let progressDirty = false;
let layoutDirty = true;
let layout = 'line';
let paletteKey = null;
let wantPlaying = false;
let wantProgress = 0;   // 0..1, quantized to device pixels of the rule
let shownPlaying = false;
let shownProgress = -1;
let panelWidth = 0;
let panelHeight = 0;
let raf = 0;

const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
const text = (node, value) => { if (node.$text !== value) { node.$text = value; node.textContent = value; } };
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const str = value => (typeof value === 'string' ? value.trim() : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function modLabel(mod) {
  const acronym = str(mod?.acronym);
  const speed = Number(mod?.settings?.speed_change);
  return RATE_MODS.has(acronym) && Number.isFinite(speed) && speed > 0 ? [acronym, `${speed.toFixed(2).replace(/0$/, '')}×`] : [acronym, ''];
}

/** What the line should say. Gameplay only; transport and "osu! not running" get a tiny chip. */
function compose() {
  if (link !== 'live') return { kind: 'status', key: `status:${link}`, status: link };
  const v = values;
  if (v[P.state] === undefined) return { kind: 'empty', key: 'empty' };
  if (v[P.state] !== PLAYING) return { kind: 'hidden', key: shown?.key ?? 'hidden' };
  const prefer = (unicode, roman) => (opts.unicode ? str(v[unicode]) || str(v[roman]) : str(v[roman]) || str(v[unicode]));
  const artist = prefer(P.artistUnicode, P.artist);
  const title = prefer(P.titleUnicode, P.title);
  if (!artist && !title) return { kind: 'empty', key: 'empty' };
  const version = str(v[P.version]);
  const stars = v[P.stars];
  const mods = Array.isArray(v[P.mods]) ? v[P.mods].map(modLabel).filter(([acronym]) => acronym) : [];
  return {
    kind: 'map',
    key: str(v[P.checksum]) || `${str(v[P.artist])}|${str(v[P.title])}|${version}`,
    artist, title, version,
    mapper: str(v[P.mapper]),
    stars: typeof stars === 'number' && Number.isFinite(stars) ? stars.toFixed(2) : '—',
    mods, modsKey: mods.map(pair => pair.join(' ')).join(','),
  };
}

function refresh() {
  target = compose();
  contentDirty = true;
  schedule();
  // The map tint is derived once per map, off the render path. Song select already carries the
  // next map's checksum, so the tint is ready when play starts.
  const checksum = opts.accent === 'map' && link === 'live' ? str(values?.[P.checksum]) : '';
  if (checksum === paletteKey) return;
  paletteKey = checksum;
  if (!checksum) { applyPalette(root, null); return; }
  mapPalette(checksum).then(palette => { if (paletteKey === checksum) applyPalette(root, palette); });
}

function updateProgress() {
  const v = values;
  const playing = link === 'live' && v[P.state] === PLAYING;
  let progress = 0;
  if (playing) {
    const live = v[P.live], first = v[P.first], last = v[P.last];
    if (typeof live === 'number' && typeof first === 'number' && typeof last === 'number' && last > first) {
      const length = layout === 'column' ? panelHeight : panelWidth;
      const steps = Math.max(120, Math.round(length * devicePixelRatio));
      progress = Math.round(Math.min(1, Math.max(0, (live - first) / (last - first))) * steps) / steps;
    }
  }
  if (playing === wantPlaying && progress === wantProgress) return;
  wantPlaying = playing;
  wantProgress = progress;
  progressDirty = true;
  schedule();
}

// ------------------------------------------------------------------ layout from the box
/**
 * Picks the arrangement for the page's box and scales type to it: a single line for a flat box,
 * a two-line stack once the box is tall enough for it, a column for an upright box.
 */
function relayout() {
  const w = innerWidth, h = innerHeight;
  let next = opts.orientation === 'vertical' ? 'column' : opts.orientation === 'horizontal' ? 'line' : w / h < 1.4 ? 'column' : 'line';
  if (next === 'line' && h >= 66) next = 'stack';
  const scale = next === 'column' ? w / 320 : next === 'stack' ? h / 80 : h / 56;
  layout = next;
  attr(root, 'data-layout', next);
  root.style.setProperty('--s', Math.min(2.4, Math.max(0.55, scale)).toFixed(3));
  const v = values || {};
  const mode = activeMode(v[P.state], v[P.playMode], v[P.settingsMode]) || 'osu';
  attr(root, 'data-align', opts.align === 'auto' ? AUTO_ALIGN[mode] : opts.align);
  // The rule changes axis with the layout: redraw it from scratch.
  fill.style.transform = '';
  shownProgress = -1;
  progressDirty = true;
  if (values) updateProgress();
  marqueeReset();
}

// ------------------------------------------------------------------ render (rAF only)
function frame() {
  raf = 0;
  if (layoutDirty) { layoutDirty = false; relayout(); }
  if (contentDirty && !rolling) {
    contentDirty = false;
    const show = target.kind !== 'hidden';
    const wasVisible = visible;
    if (show !== visible) {
      visible = show;
      attr(root, 'data-show', show ? 'on' : 'off');
      if (!show) marqueeReset();
    }
    if (show) {
      if (!shown || target.key !== shown.key || target.kind !== shown.kind) rollTo(!wasVisible);
      else apply(target);
    }
  }
  if (progressDirty) {
    progressDirty = false;
    if (wantPlaying !== shownPlaying) { shownPlaying = wantPlaying; panel.classList.toggle('playing', wantPlaying); }
    if (wantPlaying && wantProgress !== shownProgress) {
      shownProgress = wantProgress;
      fill.style.transform = `${layout === 'column' ? 'scaleY' : 'scaleX'}(${wantProgress})`;
    }
  }
}

function apply(content) {
  const fresh = !shown || shown.key !== content.key;
  attr(panel, 'data-kind', content.kind);
  if (content.kind === 'status') {
    attr(panel, 'data-status', content.status);
    text(el.status, content.status === 'offline' ? 'vosu offline' : 'Connecting');
  } else if (content.kind === 'empty') {
    text(el.title, '—');
    hide(el.title, false);
  } else {
    text(el.artist, content.artist);
    text(el.title, content.title);
    text(el.version, content.version);
    hide(el.artist, !content.artist);
    hide(el.sep, !content.artist || !content.title);
    hide(el.title, !content.title);
    hide(el.version, !content.version);
    text(el.starsNum, content.stars);
    hide(el.stars, !opts.showStars);
    if (el.mods.$key !== content.modsKey) {
      el.mods.$key = content.modsKey;
      el.mods.replaceChildren(...content.mods.map(([acronym, rate]) => {
        const chip = document.createElement('span');
        chip.className = 'mod';
        chip.textContent = acronym;
        if (rate) chip.append(Object.assign(document.createElement('span'), { textContent: rate }));
        return chip;
      }));
    }
    hide(el.mods, !opts.showMods || !content.mods.length);
    text(el.mapperName, content.mapper);
    hide(el.mapper, !opts.showMapper || !content.mapper);
  }
  shown = content;
  if (fresh) marqueeReset();
}

/** Map change on screen: the old line rolls up and out, the new one rolls up and in. */
function rollTo(instant) {
  // Coming back from song select the page fades in as a whole; no roll needed.
  if (reduced || instant || !shown) {
    const first = !shown;
    apply(target);
    if (first && !reduced) roll.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE });
    return;
  }
  rolling = true;
  const enter = () => {
    apply(target);
    const animation = roll.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: EASE, fill: 'backwards' });
    animation.onfinish = () => {
      rolling = false;
      contentDirty = true;
      schedule();
    };
  };
  const exit = roll.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }],
    { duration: 140, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
  exit.onfinish = () => { enter(); exit.cancel(); };
}

// ------------------------------------------------------------------ width easing + marquee
let flipping = null;
let vpWidth = 0;
let trackWidth = 0;
let marqueeTimer = 0;
let marquee = null;

/** The backing jumps to its new width at layout; ease it there with a scaleX from the old one. */
function flip(width) {
  const previous = panelWidth;
  panelWidth = width;
  if (!previous || reduced || !visible || opts.backing === 'none' || Math.abs(width - previous) < 0.5) return;
  flipping?.cancel();
  flipping = bg.animate([{ transform: `scaleX(${previous / width})` }, { transform: 'none' }], { duration: 240, easing: EASE });
}

function marqueeReset() {
  clearTimeout(marqueeTimer);
  marquee?.cancel();
  marquee = null;
  const over = layout !== 'column' && opts.overflow === 'marquee' && trackWidth - vpWidth > 1;
  attr(vp, 'data-edge', over ? 'r' : '');
  if (over && visible && !reduced) marqueeTimer = setTimeout(marqueeOut, 2800);
}

function marqueeOut() {
  const distance = trackWidth - vpWidth;
  attr(vp, 'data-edge', 'lr');
  marquee = track.animate([{ transform: 'none' }, { transform: `translateX(${-distance}px)` }],
    { duration: Math.max(1600, distance / 48 * 1000), easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' });
  marquee.onfinish = () => {
    attr(vp, 'data-edge', 'l');
    marqueeTimer = setTimeout(marqueeBack, 2200);
  };
}

function marqueeBack() {
  const distance = trackWidth - vpWidth;
  const previous = marquee;
  attr(vp, 'data-edge', 'lr');
  marquee = track.animate([{ transform: `translateX(${-distance}px)` }, { transform: 'none' }],
    { duration: Math.max(500, distance / 240 * 1000), easing: EASE });
  previous?.cancel();
  marquee.onfinish = () => {
    marquee = null;
    attr(vp, 'data-edge', 'r');
    marqueeTimer = setTimeout(marqueeOut, 7000);
  };
}

const sizes = new ResizeObserver(entries => {
  let textResized = false;
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    const width = box?.inlineSize ?? entry.contentRect.width;
    if (entry.target === panel) {
      panelHeight = box?.blockSize ?? entry.contentRect.height;
      flip(width);
    } else {
      if (entry.target === vp) vpWidth = width;
      else trackWidth = width;
      textResized = true;
    }
  }
  if (textResized) marqueeReset();
});
sizes.observe(panel);
sizes.observe(vp);
sizes.observe(track);
// Hosts (OBS source size, vosulay width/height, the replay renderer's cell) resize the page.
addEventListener('resize', () => { layoutDirty = true; schedule(); });

// ------------------------------------------------------------------ inputs
settings(defaults, next => {
  opts = {
    ...next,
    orientation: pick(next.orientation, ['auto', 'horizontal', 'vertical'], 'auto'),
    align: pick(next.align, ['auto', 'left', 'center', 'right'], 'auto'),
    backing: pick(next.backing, ['none', 'scrim', 'panel'], 'none'),
    accent: pick(next.accent, ['map', '18-lab'], 'map'),
    overflow: pick(next.overflow, ['marquee', 'truncate'], 'marquee'),
  };
  attr(panel, 'data-overflow', opts.overflow);
  attr(panel, 'data-backing', opts.backing);
  layoutDirty = true;
  paletteKey = null;
  if (values) refresh();
  schedule();
});

const subscription = subscribe(Object.values(P), (next, changed) => {
  values = next;
  if (opts.align === 'auto' && MODE.some(pointer => changed.has(pointer))) { layoutDirty = true; schedule(); }
  if (META.some(pointer => changed.has(pointer))) refresh();
  if (TIME.some(pointer => changed.has(pointer))) updateProgress();
}, {
  // The shared client reports 'live' on every frame; act on transitions only.
  onStatus(state) {
    if (state === link) return;
    link = state;
    if (!values) return;
    refresh();
    updateProgress();
  },
});
values = subscription.values;
refresh();

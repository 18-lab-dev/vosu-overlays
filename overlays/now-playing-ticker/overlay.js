// Copyright (c) 2026 18-LAB. MIT.
// Now playing ticker: one line of map info, a play-progress hairline, a rolling change
// between maps, and a paused marquee for titles that do not fit.
import { subscribe, settings, fit } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 52;
const PLAYING = 2;
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const P = {
  state: '/state/number',
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
const META = [P.artist, P.artistUnicode, P.title, P.titleUnicode, P.version, P.mapper, P.checksum, P.stars, P.mods];
const TIME = [P.state, P.live, P.first, P.last];
const RATE_MODS = new Set(['DT', 'NC', 'HT', 'DC']);

const $ = selector => document.querySelector(selector);
const stage = $('#stage');
const bar = $('#bar');
const panel = $('#panel');
const bg = $('.bg');
const fill = $('.prog i');
const brand = $('.brand');
const roll = $('.roll');
const vp = $('.vp');
const track = $('.track');
const el = {
  status: $('#status'), artist: $('.artist'), sep: $('.sep'), title: $('.title'), version: $('.ver'),
  stars: $('.stars'), starsNum: $('.stars .num'), mods: $('.mods'), mapper: $('.mapper'), mapperName: $('.mapper .name'),
};

fit(stage, WIDTH, HEIGHT);

// ------------------------------------------------------------------ state
const defaults = { unicode: false, showStars: true, showMods: true, showMapper: true, overflow: 'marquee', align: 'left', maxWidth: 760, showBrand: true };
let opts = { ...defaults };
let link = 'connecting';
let values = null;
let target = null;      // content the data asks for
let shown = null;       // content on screen
let rolling = false;
let contentDirty = false;
let progressDirty = false;
let wantPlaying = false;
let wantProgress = 0;   // 0..1, quantized to device pixels of the bar
let shownPlaying = false;
let shownProgress = -1;
let panelWidth = 0;
let raf = 0;

const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
const text = (node, value) => { if (node.$text !== value) { node.$text = value; node.textContent = value; } };
const hide = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const str = value => (typeof value === 'string' ? value.trim() : '');

function modLabel(mod) {
  const acronym = str(mod?.acronym);
  const speed = Number(mod?.settings?.speed_change);
  return RATE_MODS.has(acronym) && Number.isFinite(speed) && speed > 0 ? [acronym, `${speed.toFixed(2).replace(/0$/, '')}×`] : [acronym, ''];
}

/** What the line should say, from the latest vosu values and settings. */
function compose() {
  if (link !== 'live') return { kind: 'status', key: `status:${link}`, status: link };
  const v = values;
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
}

function updateProgress() {
  const v = values;
  const playing = link === 'live' && v[P.state] === PLAYING;
  let progress = 0;
  if (playing) {
    const live = v[P.live], first = v[P.first], last = v[P.last];
    if (typeof live === 'number' && typeof first === 'number' && typeof last === 'number' && last > first) {
      const steps = Math.max(240, Math.round(panelWidth * devicePixelRatio));
      progress = Math.round(Math.min(1, Math.max(0, (live - first) / (last - first))) * steps) / steps;
    }
  }
  if (playing === wantPlaying && progress === wantProgress) return;
  wantPlaying = playing;
  wantProgress = progress;
  progressDirty = true;
  schedule();
}

// ------------------------------------------------------------------ render (rAF only)
function frame() {
  raf = 0;
  if (contentDirty && !rolling) {
    contentDirty = false;
    if (!shown || target.key !== shown.key) rollTo();
    else apply(target);
  }
  if (progressDirty) {
    progressDirty = false;
    if (wantPlaying !== shownPlaying) { shownPlaying = wantPlaying; panel.classList.toggle('playing', wantPlaying); }
    if (wantPlaying && wantProgress !== shownProgress) {
      shownProgress = wantProgress;
      fill.style.transform = `scaleX(${wantProgress})`;
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

/** Map change: the old line rolls up and out, the new one rolls up and in. */
function rollTo() {
  if (reduced) { apply(target); return; }
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
    return animation;
  };
  if (!shown) { enter(); return; }
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

/** The surface jumps to its new width at layout; ease it there with a scaleX from the old one. */
function flip(width) {
  const previous = panelWidth;
  panelWidth = width;
  if (!previous || reduced || Math.abs(width - previous) < 0.5) return;
  flipping?.cancel();
  flipping = bg.animate([{ transform: `scaleX(${previous / width})` }, { transform: 'none' }], { duration: 240, easing: EASE });
  const shift = opts.align === 'left' ? 0 : opts.align === 'center' ? (width - previous) / 2 : width - previous;
  if (shift && opts.showBrand) brand.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
}

function marqueeReset() {
  clearTimeout(marqueeTimer);
  marquee?.cancel();
  marquee = null;
  const over = opts.overflow === 'marquee' && trackWidth - vpWidth > 1;
  attr(vp, 'data-edge', over ? 'r' : '');
  if (over && !reduced) marqueeTimer = setTimeout(marqueeOut, 2800);
}

function marqueeOut() {
  const distance = trackWidth - vpWidth;
  attr(vp, 'data-edge', 'lr');
  marquee = track.animate([{ transform: 'none' }, { transform: `translateX(${-distance}px)` }],
    { duration: Math.max(1600, distance / 42 * 1000), easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' });
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
    { duration: Math.max(500, distance / 220 * 1000), easing: EASE });
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
    const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    if (entry.target === panel) {
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

// ------------------------------------------------------------------ inputs
settings(defaults, next => {
  opts = {
    ...next,
    overflow: next.overflow === 'truncate' ? 'truncate' : 'marquee',
    align: ['left', 'center', 'right'].includes(next.align) ? next.align : 'left',
    maxWidth: Math.min(1896, Math.max(320, Math.round(next.maxWidth) || defaults.maxWidth)),
  };
  attr(bar, 'data-align', opts.align);
  attr(panel, 'data-overflow', opts.overflow);
  attr(panel, 'data-brand', opts.showBrand ? 'on' : 'off');
  panel.style.setProperty('--max-w', `${opts.maxWidth}px`);
  marqueeReset();
  if (values) refresh();
});

const subscription = subscribe(Object.values(P), (next, changed) => {
  values = next;
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

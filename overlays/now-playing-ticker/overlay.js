// Copyright (c) 2026 18-LAB. MIT.
// Now playing ticker: during gameplay, one line of map info floated into a free band of
// osu!'s layout, with a play-progress hairline, a rolling change between maps and a paused
// marquee for lines that do not fit. Song select and results already show all of it: nothing there.
import { subscribe, settings, fit, activeMode, osuLayout, maniaSkin, mapPalette, applyPalette } from './vosu-overlay.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const LINE = 44;          // zone height; the text sits on its vertical centre
const GAP = 24;           // clearance from osu!'s HUD and playfield
const SIDE = 480;         // a side column is a column, not a band: cap its reach towards the stage
const PLAYING = 2;
const EASE = 'cubic-bezier(0.65, 0, 0.2, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Default band per ruleset: the top strip between HP bar and score for the 4:3 rulesets, the
// open field under the taiko lane, and beside the (full-height) mania stage.
const AUTO = { osu: 'top', fruits: 'top', taiko: 'under', mania: 'side' };

const P = {
  state: '/state/number',
  playMode: '/play/mode/number',
  settingsMode: '/settings/mode/number',
  client: '/client',
  skin: '/settings/skin/name',
  keys: '/beatmap/stats/cs/converted',
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
const GEOMETRY = [P.state, P.playMode, P.settingsMode, P.client, P.keys, P.skin];
const TIME = [P.state, P.live, P.first, P.last];
const RATE_MODS = new Set(['DT', 'NC', 'HT', 'DC']);

const $ = selector => document.querySelector(selector);
const stage = $('#stage');
const zone = $('#zone');
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
const defaults = {
  zone: 'auto', align: 'auto', offsetX: 0, offsetY: 0, scale: 1, backing: 'none', accent: 'map',
  unicode: false, showStars: true, showMods: true, showMapper: true, overflow: 'marquee', maxWidth: 900, showBrand: true,
  columnWidth: 0, columnStart: 0,
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
let placeDirty = true;
let placeKey = '';
let skinKey = '';
let skin = null;        // maniaSkin() result for skinKey
let paletteKey = null;
let wantPlaying = false;
let wantProgress = 0;   // 0..1, quantized to device pixels of the line
let shownPlaying = false;
let shownProgress = -1;
let panelWidth = 0;
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
  // The map tint is derived once per map, off the render path.
  // Song select already carries the next map's checksum, so the tint is ready when play starts.
  const checksum = opts.accent === 'map' && link === 'live' ? str(values?.[P.checksum]) : '';
  if (checksum === paletteKey) return;
  paletteKey = checksum;
  if (!checksum) { applyPalette(zone, null); return; }
  mapPalette(checksum).then(palette => { if (paletteKey === checksum) applyPalette(zone, palette); });
}

function updateProgress() {
  const v = values;
  const playing = link === 'live' && v[P.state] === PLAYING;
  let progress = 0;
  if (playing) {
    const live = v[P.live], first = v[P.first], last = v[P.last];
    if (typeof live === 'number' && typeof first === 'number' && typeof last === 'number' && last > first) {
      const steps = Math.max(240, Math.round(panelWidth * opts.scale * devicePixelRatio));
      progress = Math.round(Math.min(1, Math.max(0, (live - first) / (last - first))) * steps) / steps;
    }
  }
  if (playing === wantPlaying && progress === wantProgress) return;
  wantPlaying = playing;
  wantProgress = progress;
  progressDirty = true;
  schedule();
}

// ------------------------------------------------------------------ placement
/** The band for the active ruleset: `{ x, w, cy, align }` in stage px. `reach` caps a side column. */
function band(mode, zoneName, layout, reach) {
  const { busy, hud } = layout;
  const healthEnd = hud.health.x + hud.health.w;
  const stageEnd = busy.x + busy.w;
  if (zoneName === 'top') {
    let x0 = healthEnd + GAP, x1 = hud.score.x - GAP;
    if (mode === 'mania') {
      // The stage is full height: keep the wider side of the strip it leaves.
      const left = [x0, Math.min(x1, busy.x - GAP)], right = [Math.max(x0, stageEnd + GAP), x1];
      [x0, x1] = left[1] - left[0] >= right[1] - right[0] ? left : right;
      if (x1 - x0 < 320) return band(mode, 'side', layout, reach);
    }
    return { x: x0, w: x1 - x0, cy: hud.health.y + hud.health.h / 2, align: 'center' };
  }
  if (zoneName === 'under') {
    if (mode === 'taiko') return { x: GAP, w: WIDTH - GAP * 2, cy: busy.y + busy.h + GAP + LINE / 2, align: 'left' };
    if (mode === 'mania') {
      const x1 = WIDTH - GAP, x0 = Math.max(stageEnd + GAP, x1 - reach);
      return { x: x0, w: x1 - x0, cy: HEIGHT - GAP - LINE / 2, align: 'right' };
    }
    // osu!: the strip under the playfield, above the hit-error meter.
    const floor = hud.hitError ? hud.hitError.y : HEIGHT;
    return { x: busy.x, w: busy.w, cy: (busy.y + busy.h + floor) / 2, align: 'center' };
  }
  // side: right of the playfield/stage, under score and accuracy.
  const x1 = WIDTH - GAP, x0 = Math.max(stageEnd + GAP, x1 - reach);
  return { x: x0, w: x1 - x0, cy: hud.accuracy.y + hud.accuracy.h + GAP + LINE / 2, align: 'right' };
}

function place() {
  const v = values || {};
  const mode = activeMode(v[P.state], v[P.playMode], v[P.settingsMode]) || 'osu';
  const keys = mode === 'mania' && Number.isFinite(v[P.keys]) ? Math.min(18, Math.max(1, Math.round(v[P.keys]))) : 4;
  const client = v[P.client] === 'lazer' ? 'lazer' : 'stable';
  let zoneName = opts.zone === 'auto' ? AUTO[mode] : opts.zone;
  if (zoneName === 'under' && mode === 'fruits') zoneName = 'top';   // the catcher lives under the playfield
  if (zoneName === 'side' && mode === 'taiko') zoneName = 'under';   // the lane spans the full width
  // Mania stage: the skin's own [Mania] section when vosu serves it, the settings as overrides,
  // stable's defaults otherwise. With a guessed stage, a side column keeps a short reach.
  const stage = { columnStart: 136, columnWidth: 30, columnSpacing: 0 };
  let known = false;
  if (mode === 'mania') {
    const skinName = str(v[P.skin]);
    const wanted = `${keys}|${skinName}`;
    if (wanted !== skinKey) {
      skinKey = wanted;
      skin = null;
      maniaSkin(keys, skinName).then(result => {
        if (skinKey !== wanted || !result) return;
        skin = result;
        placeDirty = true;
        schedule();
      });
    }
    if (skin) { Object.assign(stage, { columnStart: skin.columnStart, columnWidth: skin.columnWidth, columnSpacing: skin.columnSpacing }); known = true; }
    if (opts.columnStart > 0) { stage.columnStart = opts.columnStart; known = true; }
    if (opts.columnWidth > 0) { stage.columnWidth = opts.columnWidth; known = true; }
  }
  const key = `${mode}|${keys}|${client}|${zoneName}|${opts.align}|${opts.offsetX}|${opts.offsetY}|${opts.scale}|${opts.maxWidth}|${opts.showBrand}|${known}|${JSON.stringify(stage)}`;
  if (key === placeKey) return;
  placeKey = key;
  const layout = osuLayout(mode, { keys, client, ...stage });
  const b = band(mode, zoneName, layout, known ? WIDTH : SIDE);
  const align = opts.align === 'auto' ? b.align : opts.align;
  const s = opts.scale;
  const width = b.w / s;
  const origin = align === 'left' ? 0 : align === 'right' ? width : width / 2;
  attr(zone, 'data-align', align);
  zone.style.width = `${width}px`;
  zone.style.transformOrigin = `${origin}px ${LINE / 2}px`;
  // Scale about the aligned edge of the band, centred on the band's line.
  zone.style.transform = `translate(${b.x + opts.offsetX}px, ${b.cy - LINE / 2 + opts.offsetY}px) scale(${s})`;
  panel.style.setProperty('--max-w', `${Math.min(opts.maxWidth / s, width)}px`);
  // A narrow band (beside the stage or playfield) spends its width on the title, not the tag,
  // and the narrowest one on the title before the mapper.
  attr(panel, 'data-brand', opts.showBrand && width >= 560 ? 'on' : 'off');
  attr(panel, 'data-fit', width < 440 ? 'tight' : 'wide');
}

// ------------------------------------------------------------------ render (rAF only)
function frame() {
  raf = 0;
  if (placeDirty) { placeDirty = false; place(); }
  if (contentDirty && !rolling) {
    contentDirty = false;
    const show = target.kind !== 'hidden';
    const wasVisible = visible;
    if (show !== visible) {
      visible = show;
      attr(zone, 'data-show', show ? 'on' : 'off');
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
  // Coming back from song select the zone fades in as a whole; no roll needed.
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
  if (!previous || reduced || !visible || Math.abs(width - previous) < 0.5) return;
  flipping?.cancel();
  flipping = bg.animate([{ transform: `scaleX(${previous / width})` }, { transform: 'none' }], { duration: 240, easing: EASE });
  const align = zone.getAttribute('data-align');
  const shift = align === 'left' ? 0 : align === 'center' ? (width - previous) / 2 : width - previous;
  if (shift && opts.showBrand) brand.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
}

function marqueeReset() {
  clearTimeout(marqueeTimer);
  marquee?.cancel();
  marquee = null;
  const over = opts.overflow === 'marquee' && trackWidth - vpWidth > 1;
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
  const number = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  opts = {
    ...next,
    zone: pick(next.zone, ['auto', 'top', 'under', 'side'], 'auto'),
    align: pick(next.align, ['auto', 'left', 'center', 'right'], 'auto'),
    backing: pick(next.backing, ['none', 'scrim', 'panel'], 'none'),
    accent: pick(next.accent, ['map', '18-lab'], 'map'),
    overflow: pick(next.overflow, ['marquee', 'truncate'], 'marquee'),
    offsetX: Math.round(number(next.offsetX, -1920, 1920, 0)),
    offsetY: Math.round(number(next.offsetY, -1080, 1080, 0)),
    scale: number(next.scale, 0.5, 2, 1),
    maxWidth: Math.round(number(next.maxWidth, 240, 1872, defaults.maxWidth)),
    // 0 = from the skin's skin.ini (or stable's defaults when vosu cannot serve it).
    columnWidth: number(next.columnWidth, 0, 200, 0),
    columnStart: number(next.columnStart, 0, 600, 0),
  };
  attr(panel, 'data-overflow', opts.overflow);
  attr(panel, 'data-backing', opts.backing);
  placeDirty = true;
  paletteKey = null;
  marqueeReset();
  if (values) refresh();
  schedule();
});

const subscription = subscribe(Object.values(P), (next, changed) => {
  values = next;
  if (GEOMETRY.some(pointer => changed.has(pointer))) { placeDirty = true; schedule(); }
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

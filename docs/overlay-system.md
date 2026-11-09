# 18-LAB overlay system

The shared system every official overlay is built on: one type scale, fixed colour roles, one backing, one signature, one set of number conventions, shared computations for values several overlays show, shared settings, and a placement plan in which overlays that people run together never collide. It is implemented by:

- `shared/kit.css`: type, colour roles, backings, signature, spacing, motion tokens. Synced into every overlay that carries the shared client.
- `shared/vosu-overlay.js`: number formatting, the unknown-value rule, keys per second, map time, the beat clock, the motion/backing/tint setting reader.
- every `overlays/<id>/metadata.txt` `placement` line.
- `dev/kit.html` (specimen page) and `dev/mock-vosu.js` (lazer backdrops, client-aware anchors, placement proofs).

Owner decisions this system implements (2026-11-09): data osu!'s HUD already shows is allowed only behind a setting that is off by default; all 17 overlays stay and each stays usable alone; any value several overlays show comes from one shared computation so copies agree, with a hide toggle where it is not the overlay's main job; game colours only for game meaning, the map tint only for map identity, 18-LAB amber as the constant "you"/signature accent.

## Adopting the kit (existing overlay)

1. **Load it.** In `index.html`: `tokens.css`, then `kit.css`, then `style.css`. `kit.css` is already in your folder (`python3 scripts/sync_shared.py` copies it; never edit the copy).
2. **Root.** Put `class="kit"` on the element that fills the overlay's box (or wraps its content when the page is content-sized). Set `--u` on that element, **unitless** (1 at the default box), not `${n}px`. Call `applyPalette()` on that element (or `<html>`), so `--map` resolves there. Do not use `.kit::before` or `.kit::after`: they draw the backing and the signature.
3. **Settings.** Replace `backing`/`accent` with the entries in [Settings](#settings) (`motion`, `backing`, `mapTint`, `hudFields`, `show…`). In the `settings()` callback call `applyKitSettings(root, s)`; it writes `data-motion`, `data-backing`, `data-map-tint` only when they change.
4. **Delete local copies of system things:** the `:root { --j-… }` line, `html[data-theme] { color-scheme: normal }`, your own scrim/panel/`--shade` rules, padding you added for `backing: none` (the kit pads every backing), `data-accent` / `--hl` / `--tint`, and any use of `--accent`, `--signal`, `--note`, `--caution`, `--muted`, `--fg-dim` (tokens.css names whose meaning is ambiguous in overlays). Use the roles below instead.
5. **Type.** Map every text element to one role class (`kit-hero`, `kit-value`, `kit-title`, `kit-text`, `kit-label`, `kit-caption`, `kit-unit`, `kit-code`, `kit-tick`). One hero per overlay. Labels in sentence case. Nothing a viewer needs below 14 px at `--u: 1`.
6. **Numbers.** Create one `numberFormatter(kind)` per displayed field at load; write `textContent` only when the returned string is a different object. Keep the number in its own text node so the unit span (`<span class="kit-unit">pp</span>`) is never rewritten:
   ```html
   <span class="kit-hero"><span data-f="pp">1,075</span><span class="kit-frac" data-f="ppFrac">.3</span><span class="kit-unit">pp</span></span>
   ```
7. **Unknown values.** Pass every value through `known(v)` / `known(v, true)` (zero means "not computed") and render UNKNOWN as `—` (`DASH`) or hide the row. Never print 0 for something vosu did not provide.
8. **Shared values.** KPS from `createKps()`, clocks and progress from `createMapClock()`, beat-synced motion from `createBeatClock()`. Do not keep a private definition.
9. **Placement.** Design for the box in your `metadata.txt` `placement` (and `resolution`). Check it on the stage for both clients: `/__dev/scenario?client=stable` and `client=lazer`, then `/__dev/stage?id=*&boxes=1&layout=2`.
10. **Check.** `/__dev/kit/` for the reference look, then your overlay over `bg=wallpaper.jpg` (bright, undimmed) and a dark frame.

## Type

Sizes at `--u: 1` on a 1080p canvas; every size scales with `--u`. On a 720p stream 14 px becomes ≈ 9 px, the smallest size that survives H.264. Numerals are tabular everywhere (`.kit` sets `tabular-nums lining-nums`).

| Role | Class | Font | Size / line | Colour | Use |
| --- | --- | --- | --- | --- | --- |
| Hero | `kit-hero` | Barlow Condensed 600 | 52 / 1 | `--text-1` | The one number the overlay exists for (pp, UR, ratio, rank, OK budget). Exactly one per overlay. |
| Value | `kit-value` | Barlow Condensed 600 | 32 / 1 | `--text-1` | Every other number (≈ 60 % of the hero). Tables and rows may set a smaller size on the same role, never below 20. |
| Title | `kit-title` | Barlow 600 | 20 / 1.2 | `--text-1` | Map title, player name. Two lines max, ellipsis at the character level. |
| Text | `kit-text` | Barlow 500 | 16 / 1.25 | `--text-2` | Artist, difficulty, mapper, secondary text. |
| Label | `kit-label` | Barlow 500 | 14 / 1.15 | `--text-2` | What a number is: `If FC`, `Gap to #12`. Sentence case, no mono caps, no colon. |
| Caption | `kit-caption` | Barlow 400 | 14 / 1.2 | `--text-3` | Context: `last 10 s`, `of 2:24`, `mapped by …`. |
| Unit | `kit-unit` | Barlow 500 | 40 % of its number, ≥ 14 | `--text-2` | Inside the number's element, lowercase in markup: `px ms pp kps bpm`. `%`, `×`, `★` take `kit-unit tight` (no gap). |
| Code | `kit-code` | IBM Plex Mono 500 caps | 14 / 1 | `--text-2` | Things that are caps in the game: mods `HDDT`, keys `K1 M2`, `FAIL`. |
| Tick | `kit-tick` | IBM Plex Mono 400 | 11 / 1 | `--text-3` | Purely decorative axis ticks a viewer never needs. The only role below 14. |
| Fraction | `kit-frac` | inherits | 60 % | `--text-2` | The small decimal after a hero (`1,075.3`), inside the hero element. |

Label style: one style everywhere, **sentence case Barlow** (`If FC`, `Peak`, `Keys per second`), chosen because mono caps are the part that turns to fuzz at 720p and made the set look like a dev-tool dashboard. Mono survives only as `kit-code` for things that are codes in the game.

## Colour roles

All in `kit.css`. Never use a game colour for anything but its game meaning, and never tint a value that carries judgement meaning with the map.

| Role | Value | Meaning, and only this |
| --- | --- | --- |
| `--text-1` / `--text-2` / `--text-3` | `#efece5` / `#d3cfc6` / `#ada99f` | Values / labels, units, secondary text / captions, dash. Warm-tinted; all pass 4.5:1 at 14 px on the scrim over a white background. |
| `--hair`, `--hair-strong` | 22 % / 40 % warm white | Hairlines, tracks, unplayed outlines / axes, panel edge. |
| `--you` (`--on-you`) | `#ff963f` 18-LAB amber | You and the signature: your leaderboard row's rule and rank, the registration marks, lit/pressed keys (as an underline), a "you" hero accent. Constant on every map. |
| `--map` | map tone 80 (`--map-accent`) or `--map-neutral` `#c9c4ba` | Map identity only: progress fill, playhead, strain fill, the title's star, map-derived graphics. Neutral without a palette or with `mapTint` off. |
| `--j-max` `--j-great` `--j-good` `--j-ok` `--j-meh` `--j-miss` | `#efece5` `#7fa6cf` `#6fbf8e` `#b8b5ad` `#dcc35a` `#ef5b4f` | Judgements (MAX/320, 300, 200/katu, 100, 50, miss/slider break/FAIL). `--j-meh` moved from amber to yellow so 50s never read as "you". |
| `--early`, `--late` | `#69b7d6`, `#e58aa6` | Timing direction on hit-error displays only. Not amber, not judgement colours. |
| `--don`, `--kat` | `#e8573e`, `#4f9fc4` | Taiko colours (zones, notes). |

Not roles: there is no "accent" any more, no caution colour (a budget running out goes to `--j-miss`), no dash/fruit colours (catch dash is your action: `--you`; fruit types are neutral). Highlight helpers: `kit-you` (amber text), `kit-map`, `kit-lit` (amber underline + numeral; the body stays graphite), `kit-own` (your row: +8 % fill and a 2 px amber leading rule), `kit-track` (hairline track with a `--map` fill child scaled by `transform`).

## Numbers

One convention for the set, implemented by `formatNumber(value, kind)` and the allocation-aware `numberFormatter(kind)` (returns the same string object until the shown value changes; integers below 10,000 come from a shared table). Units are markup, never part of the formatted string.

| Kind | Decimals | Example | Unit markup |
| --- | --- | --- | --- |
| `count` | 0, comma groups from 1,000 | `1,395`, `3,683,232` | none (`×` after combo, tight) |
| `pp` | 0 (a hero may add `.3` as `kit-frac`) | `1,075` | `pp` |
| `stars` | 2 | `7.01` | `★` tight |
| `accuracy` | 2 | `99.60` | `%` tight |
| `ur` | 1 | `87.4` | label `UR` |
| `ms` | 1, always signed | `+3.2`, `−1.4`, `±0.0` | `ms` |
| `kps` | 0 | `12` | `kps` |
| `bpm` | 0 | `222` | `bpm` |
| `stat` | ≤ 1, trailing zero dropped | `9`, `10.3` | label `AR`… |
| `rate` | ≤ 2, trailing zeros dropped | `1.5`, `0.75` | `×` tight |
| `percent` | 0 | `47` | `%` tight |
| `px` | 1 | `0.7` | `px` |
| `ratio` | 1, `∞` for a perfect ratio | `12.3`, `∞` | ` : 1` |
| `delta` | 0, always signed | `+12`, `−88,938`, `±0` | as the quantity |

Rules: comma thousands separator everywhere (osu!'s own); the real minus `−` (U+2212), never a hyphen; signed quantities (`ms`, `delta`) always show `+`/`−`, zero is `±0`; rank as `#8,412`; times as `m:ss` (`formatDuration`), remaining time never negative; rank movement as `▲1`/`▼2`; percentages of a whole that must sum to 100 are rounded so they do (or show the remainder).

### Unknown values

`known(value, zeroIsUnknown)` returns the value or `UNKNOWN` (`NaN`); `isKnown(v)` tests it; every formatter renders it as `DASH` (`—`). Render UNKNOWN as a dash in `--text-3`, or hide the row; never `0`, never a full bar. `mean()`/`unstableRate()` predate the rule and return `null`, which `known()` maps to UNKNOWN. Fields where **0 means "not computed"** (use `known(v, true)`): `/play/pp/fc`, `/play/pp/maxAchievable`, `/play/pp/maxAchieved` (renderer, failed calculation, unsubmitted maps, rejected converts); `/beatmap/stats/stars/*` and `/beatmap/stats/bpm/*` of an unparsed map; `/beatmap/time/mp3Length`; `/profile/globalRank`, `/profile/pp` while the profile is idle (renderer); `/play/unstableRate` with fewer than two hits. Absent fields (tosu: `keys.all`, `catcher`, `hitOffsets`) are UNKNOWN too: `createKps().at()` returns UNKNOWN without `keys.all`.

## Backing

`data-backing` on `.kit`, setting `backing`, default **`scrim`**.

- **scrim** (default): `rgb(11 12 13 / .8)` under the content, fading to transparent across the padding (`--feather` 12 px inside `--pad` 16 px), so the backing has no hard edge. 80 % is the least that keeps `--text-3` at 4.5:1 over an undimmed white background (the bright-wallpaper method: `dev/kit.html?bg=wallpaper.jpg`).
- **panel**: `rgb(11 12 13 / .9)`, a 1 px `--hair` edge, 2 px radius. For busy skins or when a hard edge reads better.
- **none**: no backing, a contrast shadow (`--shade`). Only for dimmed backgrounds; it fails on bright maps (see the kit demo).

Every backing, `none` included, gets the same `--pad` padding from `.kit`, so the registration marks never sit on content and switching backing never moves it; lay out inside it. Canvas overlays draw on top of the backing; never draw your own panel.

## Signature

**Amber registration marks** on every overlay: two L-shaped marks, 2 px stroke, 12 px arms (× `--u`), on the top-left and bottom-right corners of the `.kit` box, in `--you`. They are drawn by `.kit::after` from static gradients (no DOM, painted once), identical on every overlay and every backing, and they fade out with the card (`--dur-base`) when the root gets `data-view="hidden"`. They make the set read as authored drafting work (registration marks are the drafting sheet's own device, and DRAFTING is 18-LAB's second mode) without a logo, in the one colour that never changes. Do not add other corner brackets, rules or badges; `data-signature="off"` exists only for the kit demo.

## Spacing

4 px base, scaled by `--u`: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24, `--s-6` 32. `--pad` 16 (backing padding), `--feather` 12. On the screen, one **24 px page gutter** (`--page-gutter`, not scaled): between overlays, from the screen edges, and from the playfield/lane/stage.

## Motion

Tokens (`kit.css`, mirrored in JS as `MOTION_MS`):

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120 ms | Event flashes (a miss row flashing its judgement colour), press feedback, small nudges. |
| `--dur-base` | 240 ms | Enter/exit, a value settling, a leaderboard reorder (FLIP), the if-FC detach. |
| `--dur-slow` | 400 ms | One-time reveals (results), the map-change identity fade. |
| `--dur-ambient` | 1600 ms | Kiai breathing, only while kiai is on. |
| `--ease-draft` | `cubic-bezier(.65, 0, .2, 1)` (tokens.css) | State changes. |
| `--ease-out` | `cubic-bezier(.16, 1, .3, 1)` | Arrivals and values settling (expo-out). |
| `--ease-in` | `cubic-bezier(.7, 0, .84, 0)` | Exits. |

Levels (setting `motion`, attribute `data-motion`, JS `motionLevel()`):

- **full** (default): everything below.
- **reduced**: values and enter/exit still ease; pulses, flashes and ambience stop. `--dur-ambient` is 0, and anything marked `kit-pulse`, `kit-flash` or `kit-ambient` loses its animation.
- **off**: instant (v3 behaviour). All `--dur-*` are 0 and every transition/animation inside the root is forced to 0 ms.

Rules (with the motion brief):
- Motion answers a game event (judgement, miss, combo break, new peak, overtake, kiai start/end, map change, entering/leaving play) or continuity (values easing, elements entering). Never decoration.
- Idle is free: no infinite CSS animation and no rAF loop unless something is moving; `kit-ambient` runs only while kiai is on in play (toggle the class, do not leave it on).
- Deterministic in the replay renderer: drive motion from page clocks (rAF timestamps, `performance.now()`, CSS/Web Animations).
- Snap fast counters (key counts, combo, judgement counts); do not tween them. Above ~15 KPS press feedback snaps.
- Compositor-friendly properties only (`transform`, `opacity`); create `Animation`s once and restart them.
- Under `off` a 0 ms transition never fires `transitionend`: do not hang state on it (use `Animation.finished` with duration 0 when `motionLevel()` is `off`, or apply the end state directly).
- Beat sync: `createBeatClock()` gives the beat from vosu's `/json/sc` timing points; without it (tosu, replay renderer) it reports kiai only, and the overlay uses kiai ambience, never a free-running timer. Beat pulses are for `stream-interstitial`; on gameplay overlays prefer kiai ambience (the critique: peripheral pulsing steals the player's attention).

## Settings

Every overlay carries `motion` and `backing`; `mapTint` only where it has a map-identity element (progress, playhead, star, strain fill, map-derived graphics), since it would be a no-op elsewhere; `hudFields` only where it shows HUD data; `show…` toggles only for shared secondary values. Copy these into `settings.json` (edit only the description's overlay-specific part):

```json
{"uniqueID":"motion","type":"options","title":"Motion","options":["full","reduced","off"],"description":"full = values ease, events flash, kiai sections breathe. reduced = values and enter/exit still ease; no pulses, flashes or kiai ambience. off = everything instant.","value":"full"}
```
```json
{"uniqueID":"backing","type":"options","title":"Backing","options":["scrim","panel","none"],"description":"scrim = a dark field with soft edges that keeps small text readable on bright maps. panel = a solid graphite panel. none = text straight on the game with a contrast shadow; only for a dimmed background.","value":"scrim"}
```
```json
{"uniqueID":"mapTint","type":"checkbox","title":"Map colour","description":"Colour the map's identity (progress, star, strain fill) from the map's background. Off = neutral. Your own highlights stay 18-LAB amber either way.","value":true}
```
```json
{"uniqueID":"hudFields","type":"checkbox","title":"Show what osu!'s HUD shows","description":"Also show score, accuracy, combo and the per-judgement counts (300/100/50/miss and their equivalents), which osu!'s own HUD already shows. Derived figures (ratios, budgets, misses left) are always shown.","value":false}
```
```json
{"uniqueID":"showKps","type":"checkbox","title":"Keys per second","description":"Live and peak keys per second (the same number as key-counter and kps-graph).","value":false}
```

- **`accent` is removed.** Amber is no longer a choice: it is "you", constant. What used to follow the map is now `--map`, used only on identity elements, switched by `mapTint`.
- **`hudFields`** covers exactly: score, accuracy, current/max combo, and the per-judgement count table (300/100/50/miss; MAX/300/200/100/50/miss; GREAT/OK/MISS; fruits/drops/droplets caught and missed). It does not cover ratios (MAX : 300), budgets (OKs left), droplet-miss subtotals, combo-break counts or derived pp, and it does not apply to other players' rows on the leaderboard. Default off everywhere.
- **Hide toggles** are `show<Value>` checkboxes, one per shared secondary value, default as in [Data ownership](#data-ownership). The main job of an overlay never gets a toggle. Use the same uniqueID and title everywhere: `showKps` "Keys per second", `showProgress` "Progress" (a hairline, a clock, or both: say which in the description), `showStars` "Star rating", `showPp` "pp", `showUr` "Unstable rate".
- Existing `orientation` and `align` settings stay.

## Data ownership

Each value several overlays show has one computation (in `vosu-overlay.js`) and one owner. Secondary copies use the same computation, so they always agree, and get a `show…` toggle.

| Value | Shared computation | Owner (main job) | Secondary copies: toggle, default |
| --- | --- | --- | --- |
| Keys per second, peak | `createKps()`: presses whose gameplay `pressedAt` falls in the last second of real time (1000 × rate map ms); no smoothing (a press leaves the count exactly 1 s later); peak = highest window count at any press this attempt; total = sum of the keys' counts; UNKNOWN without `keys.all`. **Cost:** the live count needs `/beatmap/time/live`, so the overlay parses a message on every vosu tick (+13–16 KB/s client allocation in `JSON.parse`, measured in taiko-drum and judgement-ratio). Keep the definition (values must agree); where KPS is secondary it is opt-in and the overlay subscribes to the clock only while it is on. | key-counter (osu!, taiko, catch), kps-graph (mania) | key-counter in mania `showKps` on (it is its own owner elsewhere); key-overlay `showKps` off; taiko-drum `showKps` off; judgement-ratio `showKps` off |
| Map time, progress | `createMapClock()`: span first → last hit object (audio length if none), real time (÷ rate), lead-in reads 0:00, progress = elapsed ÷ total | strain-graph (playhead + clock) | now-playing `showProgress` on; now-playing-ticker `showProgress` on (hairline) |
| Star rating | `known(/beatmap/stats/stars/total, true)`, `stars` format; the map's rating is the hero, not live strain | now-playing | now-playing-ticker `showStars` on |
| BPM | `known(/beatmap/stats/bpm/realtime, true)` (fallback `common`), `bpm` format | now-playing | — |
| pp current / if-FC / max | `/play/pp/current`, `known(fc, true)`, `known(maxAchievable, true)`, `pp` format | pp-counter | results-card `showPp` on (the if-FC gap only); taiko-pace `showPp` off |
| UR, hit-error mean | `unstableRate()` / `mean()` → `known()`, `ur` / `ms` formats | results-card | taiko-pace `showUr` off |
| Kiai, beat | `createBeatClock()` (`/json/sc` per checksum, `/beatmap/isKiai`) | — (motion only) | — |
| Score, accuracy, combo, judgement counts | none: osu!'s HUD owns them | — | `hudFields` off (judgement-ratio, taiko-pace, fruit-ledger) |

Declared alternatives (pick one; they share a slot and overlap by design, or sit in separate slots where there is room): **now-playing / now-playing-ticker** (map identity; in osu!, catch and taiko the ticker has its own top slot, in mania they share the top-left); **catcher-trail / catcher-heatmap** (the same catcher data); **taiko-drum / key-overlay / key-counter** in taiko (the taiko input display); **key-overlay / key-counter** in catch (shared slot) and in mania (separate slots: both are caps with counts there; key-overlay's tape is opt-in in mania).

## Shared JS (vosu-overlay.js)

All allocation-free on the per-frame path once V8 has optimised them; create objects once at load. Every number they return or keep is a small integer (times are whole milliseconds), a number taken from vosu's data, a fraction from a table allocated once (progress and beat phase in 1/4096 steps), or UNKNOWN. Measured in a page calling them every frame (5 s window): map clock and beat clock 0.0 KB/s after a 20 s warm-up, KPS 0.3 (in `ingest`, fed a new list every frame); after a 5 s warm-up, while baseline-compiled code still boxes intermediate doubles, map clock 1.9, beat clock 1.8, KPS 0.6 KB/s, down from 15.6, 2.9 and 20.1 before. Number text comes from digit tables (`toFixed(0)`, no `String(n)`/template conversions), so only a changed value costs a string.

| Export | Use |
| --- | --- |
| `UNKNOWN`, `DASH`, `known(v, zeroIsUnknown)`, `isKnown(v)` | The unknown-value rule. |
| `NUMBER_FORMATS`, `formatNumber(v, kind)`, `numberFormatter(kind)` | Number conventions; `numberFormatter` returns one cached string per shown value. |
| `createKps()` → `.ingest(keysAll, live, rate)`, `.at(live)`, `.peak`, `.total`, `.available`, `.expiresAt`, `.reset()`; `KPS_WINDOW_MS` | Keys per second. Feed `/keys/all` with `/beatmap/time/live` and the clock rate; `expiresAt` is the map time of the next drop (schedule one wake-up, no loop). |
| `createMapClock()` → `.sample(live, rate, first, last, mp3, pageNow)`, `.now(pageNow)`, `.elapsed(mapMs)`, `.total()`, `.progress(mapMs)`; `MAP_TIME_POINTERS` | Map time and progress. |
| `createBeatClock({ onChange })` → `.setMap(checksum)`, `.setKiai(on)`, `.at(mapMs)` (sets `.index`, `.phase`, `.beatLength`), `.hasBeat`, `.kiai`; `BEAT_POINTERS` | Beat phase for beat-synced motion; kiai only without `/json/sc`. |
| `motionLevel(v)`, `applyKitSettings(root, settings)`, `MOTION_LEVELS`, `MOTION_MS`, `BACKINGS` | Shared settings → `data-motion` / `data-backing` / `data-map-tint`. |
| `subscribe`, `settings`, `fit`, `activeMode`, `isPlaying`, `mean`, `unstableRate`, `formatDuration`, `osuLayout`, `maniaSkin`, `mapPalette`, `applyPalette` | Unchanged. |

## Placement

`placement = {"<mode>":[x, y, w, h]}` in `metadata.txt`; every entry carries its box. A box is laid out for that size; the overlay re-flows to other boxes.

### Anchors

| Axis | Anchor | Page edge it sets | Resolves to |
| --- | --- | --- | --- |
| x | `left+N`, `right-N`, `center±N` | left / right / centre | screen |
| x | `hud-gap±N` | centre | the gap in the top HUD between the health bar and the score: stable 1125 (HP bar ends 735, score starts 1515), lazer Argon 1112 (wedge ends 534, accuracy column starts 1690) |
| x | `stage-left-N`, `stage-right+N`, `stage-center±N` | right / left / centre | mania stage: stable left edge at ColumnStart (skin.ini, default 136 × 2.25), lazer centred; width from the skin's columns |
| y | `top+N`, `bottom-N`, `center±N` | top / bottom / centre | screen |
| y | `lane-top-N`, `lane-bottom+N` | bottom / top | taiko lane (other rulesets: playfield/stage): stable 304–585, lazer 604–886 |

Numbers are px on 1920×1080. Stage, lane and HUD anchors resolve per client in the mock (`client=stable|lazer`).

### Game geometry (1920×1080)

| Ruleset | osu!stable | osu!lazer |
| --- | --- | --- |
| osu!, catch playfield | 384–1536 × 126–990; objects reach 82 px further (CS 4 radius) | 384–1536 × 108–972 (8 osu! px higher), same reach |
| taiko lane | 0–1920 × 304–585; mascot top-left (40–340 × 80–290) | review frames (replay renderer, owner's layout): 0–1920 × 604–886, mascot 0–300 × 330–610. Stock lazer puts the lane where stable does (`TaikoPlayfieldAdjustmentContainer`, Y = 135/480), so anchors that clear both clear stock lazer. |
| mania stage | left edge at ColumnStart; owner's skin: 4K 645–1257, 7K 488–1381; HP bar just right of the stage | centred: 4K 654–1266, 7K 513–1407 |
| HUD (default) | HP bar 15–735 × 12–48; score 1515–1905 × 8–80; accuracy to y 122; combo 15–275 × 981–1075 (osu!, catch); hit error 760–1160 × 1048–1074 (osu!) | Argon: score/health 16–550 × 8–124; accuracy + pp 1690–1904 × 20–136; **song progress along the bottom 96–1824 × 1016–1072** (also in Triangles and the owner's skin); combo 50–300 × 897–987 (osu!, taiko); hit-error bars at the side edges 330–750 |

### Grid

- **Page gutter 24 px** from screen edges and between overlays; at least 24 px from the taiko lane and the mania stage. In osu!/catch the side columns sit 104 px from the playfield, outside the object reach (22 px past a CS 4 circle centred on the playfield edge; lower CS reaches further, which is rare at the very edge).
- **Columns** in osu!/catch: left 24–280, right 1640–1896 (256 wide: the space outside the object reach). Column tops at y 144 (below both clients' top HUD). Left column ends at y 952 (stable combo); the bottom row ends at **y 1008 (`bottom-72`)**, above lazer's song progress.
- **Taiko**: a top band (y 144–256, from x 368, right of the stable mascot) for identity, a focus row directly under the lane (`lane-bottom+24`, from x 320, right of lazer's combo) for input and pace, and a bottom-right row (`bottom-72`) for pp and the player tag.
- **Mania**: screen-edge columns (left 24–280, right 1640–1896, both starting at y 144 like the other rulesets, below lazer Argon's score/health block at 16–550 × 8–124) plus two stage-hugging vertical strips (`stage-left-24`, `stage-right+72`, clear of the skin's HP bar).
- `results-card` (results only) sits at the top right (1056–1896 × 24–120), where no overlay that shows on results lives.

### Slots

Positions are `x,y` of the box's top-left, stable · lazer.

**osu!**

| Slot | Overlay | Anchor | Box | x,y stable · lazer |
| --- | --- | --- | --- | --- |
| T | now-playing-ticker | `hud-gap`, `top+4` | 720×32 | 765,4 · 752,4 |
| L1 | leaderboard | `left+24`, `top+144` | 256×400 | 24,144 |
| L2 | key-overlay | `left+24`, `bottom-248` | 256×264 | 24,568 |
| L3 | key-counter | `left+24`, `bottom-128` | 256×96 | 24,856 |
| R1 | now-playing | `right-24`, `top+144` | 256×192 | 1640,144 |
| R2 | strain-graph | `right-24`, `top+360` | 256×96 | 1640,360 |
| R3 | profile-card | `right-24`, `bottom-504` | 256×96 | 1640,480 |
| R4 | aim-scatter | `right-24`, `bottom-240` | 256×240 | 1640,600 |
| R5 | pp-counter | `right-24`, `bottom-72` | 256×144 | 1640,864 |
| X | results-card (results) | `right-24`, `top+24` | 840×96 | 1056,24 |

**osu!catch**: the osu! grid with catch overlays in the same slots: T ticker, L1 leaderboard, L2 key-overlay (key-counter is its alternative here: `left+24`, `bottom-248`, 256×96 → 24,736), L3 fruit-ledger (`left+24`, `bottom-128`, 256×96 → 24,856), R1 now-playing, R2 strain-graph, R3 profile-card, **R4 catcher-heatmap or catcher-trail** (`right-24`, `bottom-240`, 256×240 → 1640,600), R5 pp-counter, X results-card.

**osu!taiko**

| Slot | Overlay | Anchor | Box | x,y stable · lazer |
| --- | --- | --- | --- | --- |
| T | now-playing-ticker | `hud-gap`, `top+4` | 720×32 | 765,4 · 752,4 |
| A1 | now-playing | `right-1032`, `top+144` | 520×104 | 368,144 |
| A2 | strain-graph | `right-528`, `top+144` | 480×112 | 912,144 |
| A3 | leaderboard | `right-24`, `top+144` | 480×72 | 1416,144 |
| F1 | taiko-drum, or key-overlay, or key-counter | `left+320`, `lane-bottom+24` | 560×96 | 320,609 · 320,910 |
| F2 | taiko-pace | `left+904`, `lane-bottom+24` | 280×80 | 904,609 · 904,910 |
| B1 | pp-counter | `right-376`, `bottom-72` | 336×80 | 1208,928 |
| B2 | profile-card | `right-24`, `bottom-72` | 328×96 | 1568,912 |
| X | results-card (results) | `right-24`, `top+24` | 840×96 | 1056,24 |

**osu!mania** (x for 4K stable · 4K lazer · 7K stable · 7K lazer where it differs)

| Slot | Overlay | Anchor | Box | x,y |
| --- | --- | --- | --- | --- |
| L1 | now-playing (or the ticker: `stage-left-24`, `top+144`, 432×32 → x 189 · 198 · 32 · 57) | `left+24`, `top+144` | 256×192 | 24,144 |
| L2 | leaderboard | `left+24`, `top+360` | 256×400 | 24,360 |
| L3 | key-overlay (caps and counts; tape users resize it upward), the alternative to R4 | `left+24`, `bottom-72` | 256×96 | 24,912 |
| SL | kps-graph | `stage-left-24`, `bottom-72` | 152×400 | 469 · 478 · 312 · 337, 608 |
| SR | strain-graph | `stage-right+72`, `bottom-72` | 112×560 | 1329 · 1338 · 1453 · 1479, 448 |
| R1 | pp-counter | `right-24`, `top+144` | 256×144 | 1640,144 |
| R2 | judgement-ratio | `right-24`, `top+312` | 256×352 | 1640,312 |
| R3 | profile-card | `right-24`, `bottom-192` | 256×96 | 1640,792 |
| R4 | key-counter, the alternative to L3 | `right-24`, `bottom-72` | 256×96 | 1640,912 |
| X | results-card (results) | `right-24`, `top+24` | 840×96 | 1056,24 |

`ratings-timeline` and `stream-interstitial` are full-screen pages (1920×1080) and have no placement.

Checked on the stage (`?id=*&boxes=1&layout=2`, boxes from `#placements`, busy rect from `#geometry`) for every ruleset × client above, mania at 4K and 7K: no two boxes outside a declared alternative group come closer than 24 px; every box clears the playfield/lane/stage by 24 px or more and stays outside the osu!/catch object reach, except the ticker in lazer, whose bottom 10 px meet the reach of a circle at the very top edge of lazer's playfield (the critique's prescription: ≤ 32 px tall at `top+4`, with the scrim).

### Changes from the earlier rules

Kept: osu!/catch a top ticker and side columns; mania horizontal key displays (key-counter) and vertical data; taiko horizontal; the leaderboard where osu!'s board sits; nothing over a playfield, lane or stage.

Changed:
- **The screen-ellipse rule is replaced by the busy-region rule** (clear of playfield/lane/stage and the object reach). The ellipse only allowed the four corners, which is why nine overlays claimed bottom-right; stacking in columns (the critique's fix) puts column middles inside the ellipse but still 104 px from the playfield. Calm overlays take the column middles (strain-graph, profile-card, leaderboard); per-hit overlays take the corners (pp-counter, key-counter).
- **Mania vertical strips hug the stage** (kps-graph left with its zero on the stage side, strain-graph right): they are read with the stage (critique #16).
- **Taiko focus data sits directly under the lane** (`lane-bottom+24`), per client, instead of at fixed coordinates fitted to one layout (critique #10, #11).
- **The ticker uses `hud-gap`**, a named HUD-relative anchor, instead of `left+764`, and is 32 px tall (critique #2). It is not centred because a centred 720 px ticker overlaps the default stable health bar.
- **Bottom row at `bottom-72`**, clear of lazer's bottom song progress, which all of lazer's default layouts and the owner's skin draw.

Known conflicts left to the user (HUD layouts are skin choices): lazer Argon's combo (bottom-left) meets osu!'s L3 key-counter; Argon's side hit-error bars (16 px wide inside the gutter) meet the side columns between y 330 and 750; osu!stable's own key overlay (the skin's `inputoverlay-key` caps, x ≈ 1862–1916 × y ≈ 466–716; always in replays, in play only when the player turns it on; the stable backdrops show it in osu! and catch) meets the outer ≈ 34 px of R3 profile-card and R4 aim-scatter / catcher-heatmap / catcher-trail; the owner's lazer skin puts the score at top centre, under the ticker. The right column is not narrowed for the stable key overlay because a narrower column would move it into the object reach (x 1618); overlays in R3/R4 keep nothing essential in their outer 40 px between y 466 and 716 when they can. Stable's default mania stage (no skin.ini, ColumnStart 136 → 306) leaves only 306 px left of the stage: kps-graph then meets key-overlay; move one.

## Proof and tools

- `bun dev/mock-vosu.js --port 24100` with `VOSU_STAGE_BACKDROPS=<dir>`; the directory holds stable skin captures (`osu.png`, `mania-4k.png`, …) and lazer frames as `<mode>-lazer.png` / `mania-<keys>k-lazer.png` (the owner's: the review `*-clean-dense.png` frames), plus `wallpaper.jpg` for the bright test. Private; never committed.
- `/__dev/kit/` (`dev/kit.html`): every type role, colour role, backing, the signature and the motion tokens, with the number table formatted live by `formatNumber()`. `?bg=wallpaper.jpg` (bright, undimmed), `?bg=white&over=osu.png`, `?bg=osu-lazer.png` (dark), `?motion=reduced`.
- `/__dev/scenario?client=lazer` (or `stable`), then `/__dev/stage?id=*&boxes=1&layout=2`: every overlay with a placement for the ruleset, outlined and labelled, over the backdrop with the busy regions and default HUD drawn on top; `content=0` leaves the pages out. `#geometry` in the page holds the busy rect for scripted checks.

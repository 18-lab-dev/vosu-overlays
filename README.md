# vosu overlays

18-LAB's official overlays for vosu. Each `v*` release publishes the self-contained overlays under `overlays/` as packages plus a `catalog.json`, and vosu lists `18-lab-dev/vosu-overlays` as a default catalog source, so they install from its **Available** page.

Three transparent browser overlays for OBS and vosulay, backed by the vosu v2 HTTP/WebSocket API:

- `/lyrics` — synchronized LRCLIB lyrics, falling back to local CUDA Qwen3-ASR transcription with official forced alignment;
- `/map` — current map metadata, difficulty, ruleset, background, and live progress;
- `/keys` — live keypress lanes generated only from `/websocket/v2/precise` telemetry, including active ruleset, actual key count, labels, press state, and counts.

Every route shows connection, unavailable, and error states. The shared client reconnects with exponential backoff. It defaults to `http://127.0.0.1:24050`; override it with an encoded `server` query parameter, for example `?server=http%3A%2F%2F127.0.0.1%3A24051`.

## Local setup

Python 3.12, [uv](https://docs.astral.sh/uv/), an NVIDIA CUDA driver, and a running vosu are required. On the RTX 5090 workstation:

```sh
./setup.sh
./run.sh
```

`setup.sh` creates `.venv`, installs the official `qwen-asr` package, and caches the ungated `Qwen/Qwen3-ASR-0.6B` and `Qwen/Qwen3-ForcedAligner-0.6B` models. Models are loaded lazily on CUDA only when LRCLIB has no synchronized lyrics. The first fallback can therefore take longer. Results are cached under `~/.cache/vosu-overlays`; set `VOSU_OVERLAYS_CACHE` to change this location. An existing `~/.cache/vosu-counters` cache from before the rename is moved there once on startup.

The launcher listens only on `127.0.0.1:8765` by default. Options such as `./run.sh --port 9000` are passed to the sidecar.

## OBS / browser URLs

Add an OBS **Browser** source with a transparent background and one of:

- <http://127.0.0.1:8765/lyrics> — recommended 1920 × 500
- <http://127.0.0.1:8765/map> — recommended 1280 × 720
- <http://127.0.0.1:8765/keys> — recommended 1280 × 420

Use the same URLs in a vosulay browser/web overlay. Keep vosu and `./run.sh` running. The pages never invent a map, lyric line, or key lane when telemetry or lookup is unavailable.

## Lyrics resolution

For each current beatmap, the sidecar queries the public [LRCLIB API](https://lrclib.net) by vosu artist/title metadata. If no synchronized result exists, it downloads the current map audio from vosu's `/files/beatmap/audio`, invokes `Qwen3ASRModel.from_pretrained("Qwen/Qwen3-ASR-0.6B", device_map="cuda:0")`, and requests timestamps from the official `Qwen/Qwen3-ForcedAligner-0.6B`. Failures are returned to the overlay explicitly; untimed or fabricated fallback text is not emitted.

## Map analysis timeline (local prototype)

`overlays/ratings-timeline/` is a self-contained overlay folder, independent of
the Python sidecar. Copy this folder to vosu's static root and use
`http://127.0.0.1:24050/ratings-timeline/` as a 1920 × 1080 browser source.
Install the **Map analysis** vosu tool separately. Missing tools and unavailable maps
are stated explicitly in the strip instead of showing invented ratings.

The default strip occupies just 520 × 104 px, 24 px from the top-right corner.
Its vosu settings control width (320–900 px), corner, horizontal/vertical inset,
and system (Etterna local MSD, Etterna native strain, Quaver, Interlude or
osu!mania; a system that cannot rate the chart's key count falls back to the
first one that can). The overlay reads
settings live through the standard command socket; no browser storage is used.

It subscribes to `/websocket/v2/subscribe` for selected checksum, chart play
position, mod rate and game state, and calls same-origin
`/tools/map-analysis/api/v1/beatmap/current` and cached `/timeline` read routes.
A 404 from Map analysis falls back to `/tools/mania-ratings/api/` for users
who have not migrated yet. It never requests the removed rate-curve route.
Song select shows the complete curve; gameplay adds a position marker and dims
the unplayed portion. The overall chip follows the selected rating system;
the top-pattern chip uses the Map analysis dashboard's labels: MinaCalc's top
skillset (chordstream/bracketing outside 4K), and is empty on key counts
MinaCalc does not rate. Rates use 0.05 steps from 0.50–2.00×;
outside this range the strip reports unsupported rate rather than stale values.

The default Etterna curve (`etterna`) is **actual local MSD**: independent
MinaCalc calculations on centered **12 s chart-time windows / 1 s hop**.
Each window resets context and rebases note timestamps to its start; windows
are clipped at chart edges. This measures the local head pattern, not full-map
stamina. No post-smoothing or strain-to-MSD conversion is applied.
The dotted horizontal line is the map's whole-chart overall MSD. The scale starts
at 0–40 MSD and expands in tens if necessary. Discrete warm 18-LAB colour bands
are `<10`, `10–20`, `20–30`, `30–40`, `40+`, not a rainbow gradient.

`etterna-native` retains the original native base-adjusted interval strain
(max hand), using 1 s chart-time windows / 0.5 s hop / maximum aggregation.
Quaver/Interlude expose their own native strains; these are not local MSD.
NPS counts tap/hold heads per playback second. Independent systems have different
scales. The service caches timelines by chart, rate, window, hop and mode; the
overlay never recalculates them locally. Reform estimates are not displayed
as ranks or clear guarantees.

## Official overlay set (candidates)

Self-contained overlays in `overlays/`, each served by vosu from its static root (copy the folder there, or install the packaged ZIP) at `http://127.0.0.1:24050/<id>/`. They are candidates for publication; none is released. Fields marked *vosu* are vosu-only and absent on tosu; each overlay says so on screen instead of inventing values. Overlays carry no 18-LAB tag: they show game data, and the design is the signature.

Each overlay is a content-sized page that re-flows to whatever box its host gives it: an OBS browser source, a vosulay layer, or a vosu-tools replay-renderer cell (474×1080 per player for mania four-player, 1920×264 for taiko four-player). The box's shape picks the form (`orientation`, default `auto`) and the content scales with the box; asymmetrical overlays have an `align` setting. The page does not position itself, so where it goes is up to the host. Each `metadata.txt` suggests a spot and box per ruleset in `placement`.

The set shares one system, specified in [docs/overlay-system.md](docs/overlay-system.md) and implemented by `shared/kit.css` and `shared/vosu-overlay.js`: the type scale (no text a viewer needs below a computed 14 px at its placement box, essential captions 16 px), fixed colour roles (game colours only for game meaning, the map's tint only for map identity and never amber, 18-LAB amber for "you"), a dark `scrim` backing by default, registration marks as the signature (neutral by default, amber on request), one number convention, one name per key and one truncation rule, motion tokens with a `motion` setting, the shared settings (`motion`, `backing`, `marks`, `mapTint`, `hudFields`, `show…` toggles) and one computation per shared value (keys per second, map time, star rating, pp) so copies never disagree. Overlays never show beatmap background art. They show during gameplay; in song select and on results they show only what osu! does not already show there; what osu!'s HUD shows (score, accuracy, combo, judgement counts) appears only with `hudFields` on.

Placements follow one slot plan (docs/overlay-system.md "Placement"): 216 px side columns in osu!/catch, outside the hit objects' reach, with a 720×32 ticker at the top between the stable HP bar and score; a band above and a focus row under the taiko lane; screen-edge columns plus stage-hugging strips in mania; 24 px gutters, nothing over a playfield, lane or stage in osu!stable or osu!lazer. Overlays people run together do not overlap. Declared alternatives (now-playing / ticker, key-overlay / key-counter, catcher-trail / catcher-heatmap, the taiko input displays) show the same thing: run one of each pair. Nothing enforces that, since each overlay is a separate browser source; alternatives share a slot where they can, so running both overlaps visibly. The full plan places every overlay; for a stream, start from the lean layouts (at most three overlays per side) in docs/overlay-system.md "Recommended layouts", whose overlays come first in each column.

| Overlay | Rulesets | Placement box (osu!/catch; others noted) | Shows |
| --- | --- | --- | --- |
| `now-playing` | all | 216×192 column (mania 256, taiko 520×104 strip) | Map identity, star rating with a live-rating bar, BPM, mods, mod-adjusted AR/CS/OD/HP, progress hairline; strip in wide boxes (gameplay only) |
| `now-playing-ticker` | all | 720×32 line (mania 432×32) | One-line map bar with progress hairline, the alternative to `now-playing`; two-line stack or side column in taller boxes (gameplay only) |
| `key-overlay` | all | 216×264 columns (catch 216×160, mania 256×96, taiko 560×96) | Scrolling key-press tape with counts, optional KPS; rows in wide boxes; mania shows caps and counts unless the tape is on (*vosu* `keys.all`) |
| `key-counter` | all | 216×96 strip (mania 256×96, taiko 560×96) | Key caps with counts and the set's KPS readout (osu!, taiko, catch) with peak; 10 s KPS history where there is room; peak and average KPS on results (*vosu* `keys.all`) |
| `pp-counter` | all | 216×144 column (mania 256, taiko 336×80) | Live pp on a 0→SS rail (max achievable hatched, If FC tick), pp breakdown, If FC split out after a choke; accuracy→pp ladder in song select; If FC gap on results |
| `strain-graph` | all | 216×96 strip (mania 112×560, taiko 480×112) | Map strain on the shared map clock: played portion in the map colour, kiai band, breaks as gaps; time runs upward in tall boxes; preview in song select |
| `results-card` | all | 840×96 row | Results-only strip: UR, timing mean, early/late split, hit-error histogram and the pp a full combo would have added; stacked in upright boxes |
| `leaderboard` | all | 216×400 list (mania 256, taiko 480×72 strip) | In-game-style board on the left where osu!'s sits (taiko: strip above the lane): your position as the hero, your row always in view with the gap to the next place, rows slide on overtakes; rival style optional; nothing when the leaderboard is idle |
| `profile-card` | all | 216×96 card (mania 256, taiko 328×96) | Player tag: global rank as the hero, name, country, avatar, pp, session deltas; every field can be overridden with a custom value (shown in the replay renderer too) |
| `aim-scatter` | osu | 216×240 column | Cursor offsets per hit with spread ellipse and aim bias (*vosu* `ENABLE_HIT_OFFSETS`) |
| `taiko-drum` | taiko | 560×96 row | The taiko input display: four zones lit on press, zone counts, hand split, alternation rate, optional KPS (*vosu* `keys.all`) |
| `taiko-pace` | taiko | 280×80 chip | OKs (or misses) still affordable for a target accuracy, with a gauge that drains as you spend them |
| `catcher-trail` | catch | 216×240 column | The catcher's path over the last seconds: dashes in amber, misses pinned where the catcher was, kiai stretches, dash share; direction changes on results (*vosu* `catcher`) |
| `catcher-heatmap` | catch | 216×240 column | Where the catcher spends time, its centre, the live catcher, dash share and left/right split; alternative to `catcher-trail` (*vosu* `catcher`) |
| `fruit-ledger` | catch | 216×96 chip | What the HUD never counts: droplets missed and combo breaks, flashing as they happen; caught counts, accuracy and combo optional (gameplay only) |
| `judgement-ratio` | mania | 256×352 column | MAX:300 ratio and the judgement mix as one bar with 50/miss marks; counts, accuracy, combo and KPS optional; kept on results |
| `kps-graph` | mania | 152×400 column | Live KPS (the mania KPS owner) as a strip beside the stage, zero on the stage side, with peak, average and the map's upcoming density when sent; horizontal in wide boxes |
| `stream-interstitial` | all | 1920×1080 | Starting soon / be right back / ending scene (a full scene, not an overlay over gameplay) |

Mode-specific overlays render nothing outside their ruleset. In the replay renderer, which always reports gameplay, profile and leaderboard are idle, `/performance/graph` is empty and `hitOffsets`/`catcher` are not served: `aim-scatter`, `catcher-heatmap` and `catcher-trail` show a one-line notice there, `strain-graph` falls back to a progress track, `leaderboard` renders nothing, and `profile-card` shows the replay's player name unless custom values are set.

## Developing official overlays

Self-contained overlays live in `overlays/<id>/` and follow vosu's counter layout: `index.html`, `metadata.txt`, `settings.json`, optional `preview.webp` (a stage screenshot; WebP keeps packages small). Each folder bundles a generated copy of vosu's `tokens.css` and `fonts/` (18-LAB tokens and fonts; SIL OFL text is added to packages), because the replay renderer and tosu do not serve vosu's `/assets/`, and of the overlay kit `kit.css` ([docs/overlay-system.md](docs/overlay-system.md) says how to adopt it). It follows the game through `vosu-overlay.js`, a byte-identical copy of `shared/vosu-overlay.js`. Edit the shared files, then run:

```sh
python scripts/sync_shared.py                                   # refresh every overlay's copies
python scripts/sync_shared.py --tokens <vosu>/assets/server     # regenerate shared/tokens.css and fonts/ from vosu
python scripts/sync_shared.py --check                           # CI: fail on drift or on /assets/ references
```

`metadata.txt` uses vosu's counter format, one `Key: value` per line (keys are case-insensitive; `##` starts a comment), with `Author: 18-LAB` on every official overlay. It declares the default box as `Resolution: WxH` and the suggested spot per ruleset as `Placement: {"<mode>":[x,y,w,h]}` (`[x,y]` takes the default box). `x`/`y` are pixels on a 1920×1080 screen or anchors: `left+N`, `right-N`, `center±N`, `top+N`, `bottom-N`; for mania `stage-left-N`, `stage-right+N`, `stage-center±N`; for taiko `lane-top-N`, `lane-bottom+N`. Stage and lane anchors resolve per client (docs/overlay-system.md "Anchors").

`dev/mock-vosu.js` is a development-only stand-in for the vosu routes overlays use (`/websocket/v2/subscribe`, `/websocket/commands`, `/json/v2`, `/json/sc`, `/files/beatmap/background`, `/files/beatmap/file`, `/files/skin/`), driven by a deterministic synthetic attempt in any ruleset, so overlays can be designed without osu! running. Its values are plausible, not real; the `.osu` at `/files/beatmap/file` carries only the scenario's metadata, timing points (kiai 30–52 s and 100–125 s) and break (61.5–66.5 s), matching the live `isKiai`/`isBreak` flags, and is served with `compat=tosu` too, as tosu serves it. Overlay pages get 404 for `/assets/` so a missing bundled file shows up here rather than in the renderer; the dev pages read `/assets/` from a running vosu or `VOSU_ASSETS=<vosu>/assets/server`. `VOSU_STAGE_BACKDROPS=<dir>` puts local captures (not committed) behind the stage: stable skin frames (`osu.png`, `mania-4k.png`, …) and, for `client=lazer`, `<name>-lazer.png` (`osu-lazer.png`, `mania-7k-lazer.png`, …); without a lazer frame the stage draws lazer's geometry as a wireframe.

```sh
bun dev/mock-vosu.js --port 24100
# http://127.0.0.1:24100/__dev/gallery   every overlay live, with ruleset/state switches
# http://127.0.0.1:24100/__dev/stage?id=<id>&guide=1
#     the page at its suggested placement for the scenario's ruleset and client; guide=1 draws the focus ellipse,
#     w/h/x/y override the box, cell=474x1080 simulates a replay-renderer cell, layout=1 a wireframe HUD
# http://127.0.0.1:24100/__dev/stage?id=*&boxes=1&layout=2
#     placement proof: every overlay's box for the ruleset over the backdrop with playfield/lane/stage and HUD drawn
# http://127.0.0.1:24100/__dev/kit/?bg=wallpaper.jpg   the overlay kit specimen (dev/kit.html)
node dev/shoot.mjs --port 24100 --id <id>     # screenshots of every state plus live perf numbers
node dev/shoot.mjs --port 24100 --id <id> --cases ";" --perf "mode=osu&state=play&start=40000" --warm 10000 --gpu 1
```

The perf run reports script, layout and style time per second, and the allocation rate (`allocKBps`, objects already collected included) split into the overlay's own files, the shared client and the harness, with the top overlay allocation sites. `--warm` lets V8 optimise the hot paths before the 5 s window opens, which is the state a long stream runs in. The bar for an overlay: with frozen data it allocates nothing and runs no animation loop; while live, its frame and draw code allocates nothing (histories live in typed-array rings, scratch objects and canvas state are reused, layout reads happen on resize), and new strings are made only for displayed numbers that changed. `subscribe()` reuses its `values` object and `changed` Set for every frame, so read them inside the callback and never keep them.

Perf runs load the overlay page alone at its box size, as OBS, vosulay and the replay renderer do, and also report CPU per Chromium process (`cpuPct`: renderer = script, style, layout and paint; gpu = compositing and rasterisation) over a 5 s window before the frame counter starts. `--gpu 1` renders on the hardware GPU (ANGLE over Vulkan) and adds `gpuSm`, the GPU process's peak SM load from `nvidia-smi pmon` (below 1 % reads 0); without it Chromium uses SwiftShader, so GPU work shows as CPU, the case of a host without hardware acceleration. The mock serves vosu's `/json/sc` timing points (404 with `compat=tosu`) for beat-synced motion.

## Internal packaging / future releases

Packaging is retained for local development and possible future publication, not as a currently available install source. Only self-contained folders under `overlays/` are packaged. The root `/lyrics`, `/map`, and `/keys` overlays depend on the Python sidecar and are deliberately excluded from the generated catalog; continue serving them with `./run.sh`.

```sh
python scripts/package.py --base-url https://example.invalid/releases/test
python -m unittest discover -s scripts -p 'test*.py'
```

The packager writes deterministic `dist/vosu-overlay-<id>-<version>.zip` files and `dist/catalog.json`, with package SHA-256/size, source metadata, and optional preview assets. It checks vosu's regular-file/path, entry-count, expanded-size, and root `index.html` rules. Each folder's `metadata.txt` must use `Key: value` lines: vosu skips lines without a colon, so an overlay whose `Name` it cannot read is not listed, and the packager rejects such lines. `Name`, `Author`, `Version` and `Description` are required; `RequiresTools` is a JSON array of `{"id","version"}` requirements; `Resolution` is `WxH`; `Preview` may name an image within the folder (otherwise `preview.png`, `.jpg`, `.jpeg`, or `.webp` is detected). The release workflow builds and uploads packages, catalog, and preview images on a `v*` tag.

Package and artwork URLs are pinned to the producing tag under `https://github.com/18-lab-dev/vosu-overlays/releases/download/<tag>/`. vosu reads the newest release's catalog from `https://github.com/18-lab-dev/vosu-overlays/releases/latest/download/catalog.json`.

Optional `Icon` and `Banner` metadata name artwork paths inside the overlay folder; absent fields discover a single `icon.*` / `banner.*` file. Icons must be square SVG or PNG, at least 256×256. Banners accept SVG, PNG, JPEG or WebP with a 3:1 aspect ratio (±2%, recommended 1200×400). Each image is limited to 1 MiB. Invalid declarations, mismatched image types, unsafe paths and ambiguous fallback files fail packaging. Art stays in the ZIP and is also generated as `vosu-overlay-<id>-icon.<ext>` / `vosu-overlay-<id>-banner.<ext>`; the generated catalog's optional HTTPS `icon_url` / `banner_url` fields point to those assets for pre-install cards.


## License and sources

Project code is copyright © 2026 18-LAB and MIT licensed; branding and artwork are copyright © sxlvia. External services, models, packages, and source acknowledgements are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Beatmap audio and lyrics remain subject to their respective owners' rights; this software does not redistribute cached source audio.

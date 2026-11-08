# vosu overlays

This repository is private. No overlay releases or catalog are published, and it is not a default vosu catalog source. The Available page continues to use the existing tosu community overlay catalog.

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

Self-contained 18-LAB overlays in `overlays/`, each served by vosu from its static root (copy the folder there, or install the packaged ZIP) at `http://127.0.0.1:24050/<id>/`. They are candidates for publication; none is released. Fields marked *vosu* are vosu-only and absent on tosu; each overlay says so on screen instead of inventing values.

Every overlay is a transparent 1920×1080 source laid over the full-screen osu! window. It places itself in the empty parts of osu!'s layout for the active ruleset (`osuLayout()` in the shared client; the mania stage comes from the player's own `skin.ini` through vosu's `/files/skin/`), floats without an opaque panel by default, and never shows beatmap background art: its accent can instead follow the map's Material 3 tonal-spot colour (`mapPalette()`). Overlays show during gameplay; in song select and on results they show only what osu! does not already show there. Every overlay has zone, nudge, scale, backing (`none`/`scrim`/`panel`) and accent (`map`/`18-lab`) settings.

| Overlay | Rulesets | Shows |
| --- | --- | --- |
| `now-playing` | all | Map identity, live stars, mod-adjusted stats, BPM, rate-adjusted length, progress (gameplay only) |
| `now-playing-ticker` | all | One-line map bar with progress hairline in the strip between HP bar and score (gameplay only) |
| `stream-scene` | all | Streamer layer over full-screen osu!: webcam frame in a free band, handle, live play strip; session ledger in song select/results |
| `stream-interstitial` | all | Starting soon / be right back / ending scene (0.1.0; a full scene, not an overlay over gameplay) |
| `hit-error` | osu, taiko, mania | Hit error bar beside the playfield/stage or under the lane; judgement windows in song select; final distribution on stable results |
| `hit-error-arc` | osu, taiko, mania | Hit error dial with needle, UR and histogram; final strip on stable results |
| `timing-drift` | osu, taiko, mania | Rolling mean and UR across the attempt |
| `key-overlay` | all | Scrolling key-press tape with counts and KPS; per-key summary on results (*vosu* `keys.all`) |
| `key-counter` | all | Key caps, counts and KPS sparkline; per-key summary on results (*vosu* `keys.all`) |
| `pp-counter` | all | Live pp, if-FC and max achievable; accuracy→pp ladder in song select; if-FC gap on results |
| `strain-graph` | all | Map strain with playhead, kiai and breaks; full preview in song select |
| `combo-hud` | all | HUD replacement in osu!'s own HUD spots (for streams that hide the in-game HUD) |
| `results-card` | all | Results-only strip: UR, timing histogram, pp and if-FC |
| `leaderboard` | all | Rival readout (above/below with score gaps) or a full board where osu!'s sits; final standing on results |
| `profile-card` | all | Player tag during your own plays: rank, pp, session deltas |
| `session-tracker` | all | Session ledger in song select; minimal attempt strip in play; session line on results |
| `aim-scatter` | osu | Cursor offsets per hit with spread ellipse and aim bias (*vosu* `ENABLE_HIT_OFFSETS`) |
| `tap-meter` | osu | Stream BPM, consistency, alternation and finger balance (*vosu* `keys.all`) |
| `skill-radar` | osu | Aim/speed/accuracy/flashlight pp, live vs FC, over the map's skill profile |
| `taiko-drum` | taiko | Four-zone drum, hand balance, alternation, KPS (*vosu* `keys.all`) |
| `taiko-pace` | taiko | OK and miss budget for a target accuracy, max achievable accuracy |
| `taiko-lanes` | taiko | Color/rhythm/stamina strain lanes with the leading skill; map lanes in song select |
| `catcher-trail` | catch | Catcher position seismograph with dash, travel and turns (*vosu* `catcher`) |
| `catcher-heatmap` | catch | Where the catcher spends time, centre of gravity, dash share (*vosu* `catcher`) |
| `fruit-ledger` | catch | Fruits/drops/droplets caught and missed, combo status; map composition in song select |
| `column-timing` | mania | Per-column bias and UR with the weakest column called out (*vosu* `ENABLE_MANIA_KEY_HIT_ERRORS`) |
| `judgement-ratio` | mania | MAX…MISS, MAX:300 ratio, accuracy, live and peak KPS |
| `ln-timing` | mania | Long-note press vs release distributions |
| `kps-graph` | mania | KPS over the attempt against the map's density; density preview in song select |

Mode-specific overlays render nothing outside their ruleset. Default placements are chosen per overlay, so several overlays that target the same free band can overlap until their zone settings are adjusted.

## Developing official overlays

Self-contained overlays live in `overlays/<id>/` and follow vosu's counter layout: `index.html`, `metadata.txt`, `settings.json`, optional `preview.webp` (a stage screenshot; WebP keeps packages small). They link vosu's own `/assets/tokens.css` (18-LAB tokens and fonts) rather than copying it, and follow the game through `vosu-overlay.js`, a byte-identical copy of `shared/vosu-overlay.js` (packages must be self-contained). Edit the shared file, then run:

```sh
python scripts/sync_shared.py          # refresh every overlay's copy
python scripts/sync_shared.py --check  # CI: fail on drift
```

`dev/mock-vosu.js` is a development-only stand-in for the vosu routes overlays use (`/websocket/v2/subscribe`, `/websocket/commands`, `/json/v2`, `/files/beatmap/background`, `/assets/`), driven by a deterministic synthetic attempt in any ruleset, so overlays can be designed without osu! running. Its values are plausible, not real. `/assets/` is proxied from a running vosu, or read from `VOSU_ASSETS=<vosu>/assets/server`.

```sh
bun dev/mock-vosu.js --port 24100
# http://127.0.0.1:24100/__dev/gallery   every overlay live, with ruleset/state switches
# http://127.0.0.1:24100/__dev/stage?id=<id>   one overlay over a dimmed gameplay backdrop
node dev/shoot.mjs --port 24100 --id <id>     # screenshots of every state plus live perf numbers
```

## Internal packaging / future releases

Packaging is retained for local development and possible future publication, not as a currently available install source. Only self-contained folders under `overlays/` are packaged. The root `/lyrics`, `/map`, and `/keys` overlays depend on the Python sidecar and are deliberately excluded from the generated catalog; continue serving them with `./run.sh`.

```sh
python scripts/package.py --base-url https://example.invalid/releases/test
python -m unittest discover -s scripts -p 'test*.py'
```

The packager writes deterministic `dist/vosu-overlay-<id>-<version>.zip` files and `dist/catalog.json`, with package SHA-256/size, source metadata, and optional preview assets. It checks vosu's regular-file/path, entry-count, expanded-size, and root `index.html` rules. Each folder's `metadata.txt` uses `key = value` lines. `requires_tools` is a JSON array of `{"id","version"}` requirements; `resolution` is a JSON `[width,height]`; `preview` may name an image within the folder (otherwise `preview.png`, `.jpg`, `.jpeg`, or `.webp` is detected). The retained release workflow would upload packages, catalog, and preview images on a `v*` tag; do not create release tags while the repository remains private.

If publication is enabled later, package and artwork URLs will be pinned to the producing tag under `https://github.com/18-lab-dev/vosu-overlays/releases/download/<tag>/`. There is no live catalog endpoint to add to vosu.

Optional `icon` and `banner` metadata name artwork paths inside the overlay folder; absent fields discover a single `icon.*` / `banner.*` file. Icons must be square SVG or PNG, at least 256×256. Banners accept SVG, PNG, JPEG or WebP with a 3:1 aspect ratio (±2%, recommended 1200×400). Each image is limited to 1 MiB. Invalid declarations, mismatched image types, unsafe paths and ambiguous fallback files fail packaging. Art stays in the ZIP and is also generated as `vosu-overlay-<id>-icon.<ext>` / `vosu-overlay-<id>-banner.<ext>`; the generated catalog's optional HTTPS `icon_url` / `banner_url` fields point to those assets for pre-install cards.


## License and sources

Project code is copyright © 2026 18-LAB and MIT licensed; branding and artwork are copyright © sxlvia. External services, models, packages, and source acknowledgements are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Beatmap audio and lyrics remain subject to their respective owners' rights; this software does not redistribute cached source audio.

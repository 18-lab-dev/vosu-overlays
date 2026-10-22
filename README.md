# vosu overlays

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

## Mania ratings timeline (vosu-installable)

`overlays/ratings-timeline/` is a self-contained overlay folder, independent of
the Python sidecar. Copy this folder to vosu's static root and use
`http://127.0.0.1:24050/ratings-timeline/` as a 1920 × 1080 browser source.
Install the **Mania ratings** vosu tool separately. Missing tools and unavailable maps
are stated explicitly in the strip instead of showing invented ratings.

The default strip occupies just 520 × 104 px, 24 px from the top-right corner.
Its vosu settings control width (320–900 px), corner, horizontal/vertical inset,
and system (Etterna local MSD, Etterna native strain, Quaver, Interlude, osu!mania or NPS). The overlay reads
settings live through the standard command socket; no browser storage is used.

It subscribes to `/websocket/v2/subscribe` for selected checksum, chart play
position, mod rate and game state, and calls same-origin
`/tools/mania-ratings/api/v1/beatmap/current` and cached `/timeline` read routes.
Song select shows the complete curve; gameplay adds a position marker and dims
the unplayed portion. The overall chip follows the selected rating system;
the top-pattern chip is always MinaCalc. Rates use 0.05 steps from 0.50–2.00×;
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

## Release packages

Only self-contained folders under `overlays/` are vosu-installable. The root `/lyrics`, `/map`, and `/keys` overlays depend on the Python sidecar and are deliberately excluded from the catalog; continue serving them with `./run.sh`.

```sh
python scripts/package.py --base-url https://github.com/shiruviaa/vosu-overlays/releases/download/v0.1.0
python -m unittest discover -s scripts -p 'test*.py'
```

The packager writes deterministic `dist/vosu-overlay-<id>-<version>.zip` files and `dist/catalog.json`, with package SHA-256/size, source metadata, and optional preview assets. It checks vosu's regular-file/path, entry-count, expanded-size, and root `index.html` rules. Each folder's `metadata.txt` uses `key = value` lines. `requires_tools` is a JSON array of `{"id","version"}` requirements; `resolution` is a JSON `[width,height]`; `preview` may name an image within the folder (otherwise `preview.png`, `.jpg`, `.jpeg`, or `.webp` is detected). The release workflow uploads packages, catalog, and preview images on a `v*` tag.

Optional `icon` and `banner` metadata name artwork paths inside the overlay folder; absent fields discover a single `icon.*` / `banner.*` file. Icons must be square SVG or PNG, at least 256×256. Banners accept SVG, PNG, JPEG or WebP with a 3:1 aspect ratio (±2%, recommended 1200×400). Each image is limited to 1 MiB. Invalid declarations, mismatched image types, unsafe paths and ambiguous fallback files fail packaging. Art stays in the ZIP and is also published as `vosu-overlay-<id>-icon.<ext>` / `vosu-overlay-<id>-banner.<ext>`; the catalog's optional HTTPS `icon_url` / `banner_url` fields point to those assets for pre-install cards.


## License and sources

Project code is MIT licensed. External services, models, packages, and source acknowledgements are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Beatmap audio and lyrics remain subject to their respective owners' rights; this software does not redistribute cached source audio.

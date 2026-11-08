# Third-party notices

- **vosu** — telemetry HTTP/WebSocket API consumed at runtime. Source: <https://github.com/18-lab-dev/vosu>. See that repository for its license.
- **Qwen3-ASR / qwen-asr** — official inference package and `Qwen/Qwen3-ASR-0.6B` model by the Qwen team. Source: <https://github.com/QwenLM/Qwen3-ASR>; model: <https://huggingface.co/Qwen/Qwen3-ASR-0.6B>. Apache License 2.0.
- **Qwen3-ForcedAligner** — official `Qwen/Qwen3-ForcedAligner-0.6B` model used for timed transcription. Model: <https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B>. Apache License 2.0.
- **LRCLIB** — public synchronized-lyrics API queried at runtime. Service: <https://lrclib.net>; source: <https://github.com/tranxuanthang/lrclib>. Server source is MIT licensed. Returned lyric text remains subject to the rights of its respective authors and publishers.
- **osu! beatmap media** — current audio/background is requested locally through vosu. Rights remain with the relevant beatmap and media rights holders.

- **Material Color Utilities** 0.4.0 — `shared/m3.js` (and each overlay's identical `m3.js` copy) is a minified bundle of its quantizer, scoring, HCT and tonal-palette modules, used to derive a map's tonal-spot accent from its background. Copyright 2021 Google LLC. Source: <https://github.com/material-foundation/material-color-utilities>. Apache License 2.0; the full text is in `licenses/material-color-utilities-Apache-2.0.txt`, which `scripts/package.py` adds to every overlay package containing `m3.js`.

Apart from that bundle, no third-party source code or model weights are committed to this repository.

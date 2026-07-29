#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }
[[ -x .venv/bin/python ]] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
for model in ("Qwen/Qwen3-ASR-0.6B", "Qwen/Qwen3-ForcedAligner-0.6B"):
    print(f"Caching {model}", flush=True)
    snapshot_download(model, token=False)
PY
printf '\nReady. Start with ./run.sh\n'

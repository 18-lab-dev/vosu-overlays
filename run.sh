#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "Runtime missing. Run ./setup.sh first." >&2
  exit 1
fi
exec .venv/bin/python server.py "$@"

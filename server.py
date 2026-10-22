#!/usr/bin/env python3
"""Local static server and lyrics resolver for vosu-overlays."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
_LEGACY_CACHE_DIR = Path.home() / ".cache" / "vosu-counters"
CACHE_DIR = Path(os.environ.get("VOSU_OVERLAYS_CACHE", Path.home() / ".cache" / "vosu-overlays"))
MODEL_ID = os.environ.get("VOSU_OVERLAYS_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
ALIGNER_ID = os.environ.get("VOSU_OVERLAYS_ALIGNER_MODEL", "Qwen/Qwen3-ForcedAligner-0.6B")
USER_AGENT = "vosu-overlays/1.0 (+https://github.com/shiruviaa/vosu-overlays)"
LRC_RE = re.compile(r"\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\](.*)")
_model: Any = None
_model_lock = threading.Lock()


def fetch_json(url: str, timeout: float = 15) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def valid_server(raw: str) -> str:
    parsed = urllib.parse.urlsplit(raw or "http://127.0.0.1:24050")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("server must be an http(s) URL")
    port = f":{parsed.port}" if parsed.port else ""
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    return f"{parsed.scheme}://{host}{port}{parsed.path.rstrip('/')}"


def cache_key(beatmap: dict[str, Any]) -> str:
    identity = [beatmap.get(key) for key in ("checksum", "id", "set", "artist", "title", "version")]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()


def parse_lrc(synced: str) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for raw in synced.splitlines():
        match = LRC_RE.match(raw.strip())
        if not match:
            continue
        start_ms = round((int(match.group(1)) * 60 + float(match.group(2))) * 1000)
        lyric = match.group(3).strip()
        if lyric:
            lines.append({"start_ms": start_ms, "text": lyric})
    lines.sort(key=lambda line: line["start_ms"])
    return lines


def lookup_lrclib(beatmap: dict[str, Any]) -> list[dict[str, Any]] | None:
    artist = str(beatmap.get("artist") or beatmap.get("artistUnicode") or "").strip()
    title = str(beatmap.get("title") or beatmap.get("titleUnicode") or "").strip()
    if not artist or not title:
        return None
    query = urllib.parse.urlencode({"artist_name": artist, "track_name": title})
    try:
        matches = fetch_json(f"https://lrclib.net/api/search?{query}")
    except (OSError, ValueError, urllib.error.HTTPError):
        return None
    if not isinstance(matches, list):
        return None
    for match in matches:
        if isinstance(match, dict) and isinstance(match.get("syncedLyrics"), str):
            lines = parse_lrc(match["syncedLyrics"])
            if lines:
                return lines
    return None


def get_model() -> Any:
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except ImportError as error:
            raise RuntimeError("ASR dependencies are not installed; run ./setup.sh") from error
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; local Qwen3-ASR fallback requires an NVIDIA GPU")
        _model = Qwen3ASRModel.from_pretrained(
            MODEL_ID,
            dtype=torch.bfloat16,
            device_map="cuda:0",
            forced_aligner=ALIGNER_ID,
            forced_aligner_kwargs={"dtype": torch.bfloat16, "device_map": "cuda:0"},
            max_inference_batch_size=1,
            max_new_tokens=4096,
        )
        return _model


def transcribe(server: str) -> tuple[list[dict[str, Any]], str]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        f"{server}/files/beatmap/audio", headers={"User-Agent": USER_AGENT, "Accept": "audio/*"}
    )
    suffix = ".audio"
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get_content_type()
        suffix = {"audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav"}.get(content_type, suffix)
        with tempfile.NamedTemporaryFile(dir=CACHE_DIR, suffix=suffix, delete=False) as audio:
            while chunk := response.read(1024 * 1024):
                audio.write(chunk)
            audio_path = Path(audio.name)
    try:
        model = get_model()
        with _model_lock:
            results = model.transcribe(audio=str(audio_path), language=None, return_time_stamps=True)
        if not results or not getattr(results[0], "time_stamps", None):
            raise RuntimeError("Qwen3-ASR returned no timed transcription")
        lines = []
        for stamp in results[0].time_stamps:
            lyric = str(getattr(stamp, "text", "")).strip()
            start = getattr(stamp, "start_time", None)
            if lyric and isinstance(start, (int, float)):
                lines.append({"start_ms": max(0, round(float(start) * 1000)), "text": lyric})
        if not lines:
            raise RuntimeError("Qwen3-ASR returned no usable timed lines")
        return lines, str(getattr(results[0], "language", "") or "unknown")
    finally:
        audio_path.unlink(missing_ok=True)


def resolve_lyrics(server: str) -> dict[str, Any]:
    snapshot = fetch_json(f"{server}/json/v2", timeout=5)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("beatmap"), dict):
        raise RuntimeError("vosu did not return current beatmap metadata")
    beatmap = snapshot["beatmap"]
    if not beatmap.get("title") and not beatmap.get("artist"):
        raise RuntimeError("no current beatmap is available")
    key = cache_key(beatmap)
    path = CACHE_DIR / f"{key}.json"
    try:
        cached = json.loads(path.read_text())
        if cached.get("status") == "ok" and cached.get("lines"):
            cached["cached"] = True
            return cached
    except (OSError, ValueError, AttributeError):
        pass

    lines = lookup_lrclib(beatmap)
    if lines:
        result = {"status": "ok", "source": "lrclib", "lines": lines, "cached": False}
    else:
        lines, language = transcribe(server)
        result = {
            "status": "ok", "source": "qwen-asr", "model": MODEL_ID,
            "aligner": ALIGNER_ID, "language": language, "lines": lines, "cached": False,
        }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False))
    temporary.replace(path)
    return result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: HTTPStatus, value: dict[str, Any]) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/lyrics":
            try:
                query = urllib.parse.parse_qs(parsed.query)
                server = valid_server(query.get("server", [""])[0])
                self.send_json(HTTPStatus.OK, resolve_lyrics(server))
            except Exception as error:
                self.log_error("lyrics lookup failed: %s", error)
                self.send_json(HTTPStatus.BAD_GATEWAY, {"status": "error", "error": str(error)})
            return
        if parsed.path in {"/", "/lyrics", "/map", "/keys"}:
            self.path = "/static/index.html"
        super().do_GET()


def migrate_legacy_cache() -> None:
    """Move the pre-rename vosu-counters cache once, so lyrics and transcripts survive the rename."""
    if "VOSU_OVERLAYS_CACHE" in os.environ or CACHE_DIR.exists() or not _LEGACY_CACHE_DIR.is_dir():
        return
    CACHE_DIR.parent.mkdir(parents=True, exist_ok=True)
    _LEGACY_CACHE_DIR.rename(CACHE_DIR)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve vosu browser overlays and local lyrics sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()
    migrate_legacy_cache()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"vosu-overlays listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

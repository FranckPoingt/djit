#!/usr/bin/env python3
"""Exercise a packaged backend with synthetic audio and a disposable database."""
import json
import math
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave

bundle = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/DJ-IT.app").resolve()
backend = bundle / "Contents/Resources/djit-server/djit-server"
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
origin = f"http://127.0.0.1:{port}"


def request(path, data=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        origin + "/api/v1" + path, data=body, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


with tempfile.TemporaryDirectory(prefix="djit-smoke-") as folder:
    root = Path(folder)
    source = root / "source"
    source.mkdir()
    track_file = source / "Synthetic tone.wav"
    with wave.open(str(track_file), "wb") as audio:
        audio.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
        audio.writeframes(b"".join(
            struct.pack("<h", int(4000 * math.sin(2 * math.pi * 440 * n / 22050)))
            for n in range(22050 * 3)
        ))
    with (root / "backend.log").open("w+") as log:
        child = subprocess.Popen([str(backend)], stdout=log, stderr=log, env={
            **os.environ, "DJIT_DB_PATH": str(root / "smoke.db"),
            "DJIT_BACKEND_PORT": str(port), "DJIT_ANALYSIS_WORKERS": "1",
            "DJIT_ANALYSIS_DSP_CONCURRENCY": "1",
        })
        try:
            for attempt in range(120):
                try:
                    assert request("/health")["ok"]
                    break
                except (urllib.error.URLError, ConnectionError):
                    if child.poll() is not None:
                        raise RuntimeError("Packaged backend exited before health check")
                    time.sleep(0.5)
            else:
                raise TimeoutError("Packaged backend never became healthy")
            with urllib.request.urlopen(origin + "/api/v1/events/analysis", timeout=10) as events:
                assert events.headers.get_content_type() == "text/event-stream"
            request("/library/import?" + urllib.parse.urlencode({"folder_path": str(source)}), method="POST")
            for attempt in range(100):
                status = request("/library/status")
                if status["status"] != "scanning":
                    break
                time.sleep(0.1)
            tracks = request("/tracks")
            assert tracks["total"] == 1, tracks
            track_id = tracks["items"][0]["id"]
            request(f"/tracks/{track_id}", {"triage_decision": "keep"}, "PATCH")
            with urllib.request.urlopen(origin + f"/api/v1/audio/{track_id}/stream", timeout=10) as response:
                assert response.read() == track_file.read_bytes()
            playlist_id = request("/playlists", {"name": "Release smoke"})["id"]
            request(f"/playlists/{playlist_id}/tracks", {"track_ids": [track_id]})
            result = request(f"/playlists/{playlist_id}/extract", {
                "playlist_id": playlist_id, "destination_path": str(root / "usb"),
            })
            assert result["copied"] == 1 and not result["errors"], result
            manifest = json.loads(Path(result["manifest_path"]).read_text())
            copied = Path(manifest["tracks"][0]["copied_path"])
            assert copied.read_bytes() == track_file.read_bytes()
            assert Path(result["playlist_path"]).read_text().startswith("#EXTM3U\n")
            print("Packaged smoke passed: health, event stream, import, triage, audio, playlist, extraction")
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

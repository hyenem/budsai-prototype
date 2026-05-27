"""End-to-end smoke test you can run against ANY server URL.

Usage:
    # Against locally-running server on :8000
    python scripts/demo_flow.py

    # Against deployed Railway URL
    python scripts/demo_flow.py --base https://budsai.up.railway.app

What it does, top to bottom:
    1. Generates a fresh Ed25519 keypair
    2. POST /v1/devices/register
    3. Builds a fake "buds" envelope (no real Opus yet — placeholder bytes)
    4. Signs it with the private key
    5. POST /v1/sessions  (server verifies the signature)
    6. Opens SSE on /v1/stream/{id} and prints every stage event
    7. Stops when {"event": "end"} arrives

Exit code 0 = full happy path; non-zero = something fell over.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

# Make `shared/python/*` importable when run from repo root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from shared.python.key import generate_keypair  # noqa: E402
from shared.python.packet import sign_envelope  # noqa: E402


def color(s: str, c: str) -> str:
    codes = {"green": 32, "red": 31, "blue": 34, "magenta": 35, "yellow": 33, "dim": 90}
    return f"\033[{codes[c]}m{s}\033[0m"


def step(n: int, label: str) -> None:
    print(color(f"[{n}] {label}", "blue"))


def ok(s: str) -> None:
    print(color(f"  ✓ {s}", "green"))


def info(s: str) -> None:
    print(color(f"    {s}", "dim"))


def fail(s: str) -> int:
    print(color(f"  ✗ {s}", "red"))
    return 1


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8000",
                   help="Server base URL (default: http://127.0.0.1:8000)")
    args = p.parse_args()
    base = args.base.rstrip("/")
    device_id = f"buds-demo-{int(time.time())}"

    print(color(f"\n=== BudsAI demo flow against {base} ===\n", "magenta"))

    with httpx.Client(timeout=15.0) as c:
        # 1. Health check
        step(1, "GET /healthz")
        r = c.get(f"{base}/healthz")
        if r.status_code != 200:
            return fail(f"healthz returned {r.status_code}")
        ok(f"server alive · {r.json()}")

        # 2. Key generation
        step(2, "Generate Ed25519 keypair")
        kp = generate_keypair()
        ok(f"public_key = {kp.public_b64[:24]}...")

        # 3. Register
        step(3, f"POST /v1/devices/register  device_id={device_id}")
        r = c.post(f"{base}/v1/devices/register",
                   json={"device_id": device_id, "public_key_b64": kp.public_b64})
        if r.status_code != 201:
            return fail(f"register returned {r.status_code}: {r.text}")
        ok(f"registered_at = {r.json()['registered_at']}")

        # 4. Build envelope
        step(4, "Build & sign envelope (placeholder PCM bytes)")
        fake_pcm = base64.urlsafe_b64encode(b"\x00\x01" * 16).rstrip(b"=").decode()
        envelope = {
            "v": 1,
            "device": device_id,
            "session": f"demo-{int(time.time() * 1000)}",
            "ts": int(time.time() * 1000),
            "trigger": "long_press",
            "tracks": {
                "lookback": {"codec": "pcm16", "duration_ms": 30000,
                             "audio_b64": fake_pcm, "sha256": "deadbeef"},
                "question": {"codec": "pcm16", "duration_ms": 1500,
                             "audio_b64": fake_pcm, "sha256": "cafef00d"},
            },
        }
        signed = sign_envelope(envelope, kp)
        ok(f"sig = {signed['sig'][:24]}...")

        # 5. POST sessions
        step(5, "POST /v1/sessions  (with X-Device-Id + signed body)")
        r = c.post(f"{base}/v1/sessions",
                   headers={"X-Device-Id": device_id},
                   json=signed)
        if r.status_code != 200:
            return fail(f"sessions returned {r.status_code}: {r.text}")
        session_id = r.json()["session_id"]
        ok(f"session_id = {session_id}")

        # 6. SSE stream
        step(6, f"GET {r.json()['stream_url']}  (SSE)")
        events_seen = 0
        stages_seen = []
        with httpx.stream("GET", f"{base}/v1/stream/{session_id}",
                          timeout=httpx.Timeout(60.0, read=60.0)) as resp:
            if resp.status_code != 200:
                return fail(f"stream returned {resp.status_code}")
            current_event = "message"
            for raw in resp.iter_lines():
                if not raw:
                    continue
                if raw.startswith("event:"):
                    current_event = raw.split(":", 1)[1].strip()
                elif raw.startswith("data:"):
                    data = raw.split(":", 1)[1].strip()
                    if current_event == "stage":
                        events_seen += 1
                        payload = json.loads(data)
                        stages_seen.append(payload.get("stage"))
                        info(f"stage = {payload.get('stage'):<14} · {data[:80]}")
                    elif current_event == "end":
                        ok(f"end event · {data}")
                        break
                    elif current_event == "ping":
                        info("(ping)")
        ok(f"received {events_seen} stage event(s): {', '.join(stages_seen)}")

    print(color("\n=== happy path ✅ ===", "green"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

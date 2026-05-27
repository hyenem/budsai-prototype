"""End-to-end auth + session tests using the in-process app.

Covers:
  - device registration
  - signed envelope is accepted (200/201)
  - unsigned / wrong-key / wrong-device envelopes are rejected (401)
"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from src._shared import generate_keypair, sign_envelope
from src.main import app
from src.storage import store

client = TestClient(app)


def _fresh_device(prefix: str = "test"):
    """Generate keypair, register it, return (device_id, keypair)."""
    device_id = f"{prefix}-{int(time.time() * 1_000_000)}"
    kp = generate_keypair()
    r = client.post(
        "/v1/devices/register",
        json={"device_id": device_id, "public_key_b64": kp.public_b64},
    )
    assert r.status_code == 201, r.text
    return device_id, kp


def _envelope(device_id: str, session_id: str = "test-session"):
    return {
        "v": 1,
        "device": device_id,
        "session": session_id,
        "ts": int(time.time() * 1000),
        "trigger": "long_press",
        "tracks": {
            "lookback": {"codec": "pcm16", "duration_ms": 30000,
                         "audio_b64": "AAAA", "sha256": "deadbeef"},
            "question": {"codec": "pcm16", "duration_ms": 1500,
                         "audio_b64": "BBBB", "sha256": "cafef00d"},
        },
    }


def test_signed_envelope_creates_session():
    device_id, kp = _fresh_device("happy")
    env = sign_envelope(_envelope(device_id, "sess-happy-1"), kp)

    r = client.post(
        "/v1/sessions",
        headers={"X-Device-Id": device_id},
        json=env,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"] == "sess-happy-1"
    assert body["stream_url"] == "/v1/stream/sess-happy-1"

    # The session is recorded server-side
    assert store.get_session("sess-happy-1") is not None


def test_missing_device_header_is_401():
    _device_id, kp = _fresh_device("no-hdr")
    env = sign_envelope(_envelope("no-hdr-anyone"), kp)
    r = client.post("/v1/sessions", json=env)
    assert r.status_code == 401
    assert "X-Device-Id" in r.json()["detail"]


def test_unregistered_device_is_401():
    kp = generate_keypair()
    env = sign_envelope(_envelope("never-registered"), kp)
    r = client.post(
        "/v1/sessions",
        headers={"X-Device-Id": "never-registered"},
        json=env,
    )
    assert r.status_code == 401
    assert "not registered" in r.json()["detail"]


def test_wrong_key_signature_is_401():
    device_id, real_kp = _fresh_device("wrong-key")
    forger_kp = generate_keypair()  # different key, same envelope
    env = sign_envelope(_envelope(device_id), forger_kp)
    r = client.post(
        "/v1/sessions",
        headers={"X-Device-Id": device_id},
        json=env,
    )
    assert r.status_code == 401
    assert "signature" in r.json()["detail"].lower()


def test_tampered_payload_is_401():
    device_id, kp = _fresh_device("tamper")
    env = sign_envelope(_envelope(device_id), kp)
    # Modify the payload after signing → signature no longer matches
    env["trigger"] = "double_tap"
    r = client.post(
        "/v1/sessions",
        headers={"X-Device-Id": device_id},
        json=env,
    )
    assert r.status_code == 401


def test_envelope_device_mismatch_is_401():
    device_id, kp = _fresh_device("mismatch")
    env = sign_envelope(_envelope("OTHER-DEVICE-IN-BODY"), kp)
    r = client.post(
        "/v1/sessions",
        headers={"X-Device-Id": device_id},
        json=env,
    )
    assert r.status_code == 401
    assert "match" in r.json()["detail"].lower()


def test_duplicate_device_registration_same_key_ok():
    device_id, kp = _fresh_device("dup")
    r = client.post(
        "/v1/devices/register",
        json={"device_id": device_id, "public_key_b64": kp.public_b64},
    )
    assert r.status_code == 201


def test_duplicate_device_registration_diff_key_conflict():
    device_id, _kp = _fresh_device("conflict")
    other_kp = generate_keypair()
    r = client.post(
        "/v1/devices/register",
        json={"device_id": device_id, "public_key_b64": other_kp.public_b64},
    )
    assert r.status_code == 409


def test_stream_for_unknown_session_is_404():
    r = client.get("/v1/stream/does-not-exist")
    assert r.status_code == 404

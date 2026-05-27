"""Signed packet envelope format used between buds-sim → host → server.

For Sprint 1 we use a deliberately simple JSON envelope (not yet the
full TLV from packet.html). This keeps debugging trivial while we wire
up the auth + transport path. We'll switch the body to TLV+Opus in
Sprint 2 without changing the signature scheme.

Wire format:

    {
      "v":        1,
      "device":   "buds-demo-001",
      "session":  "01HZAB...",
      "ts":       1716123456789,
      "trigger":  "long_press",
      "tracks": {
        "lookback":  { "codec": "pcm16", "duration_ms": 30000,
                       "audio_b64": "...", "sha256": "..." },
        "question":  { "codec": "pcm16", "duration_ms":  2300,
                       "audio_b64": "...", "sha256": "..." }
      },
      "sig":      "<base64url(ed25519(canonical_bytes(body_without_sig)))>"
    }

`canonical_bytes()` produces a deterministic byte string the same way
on Python and TypeScript: JSON with sorted keys, no spaces, UTF-8.
"""
from __future__ import annotations

import json
from typing import Any, TypedDict


class Track(TypedDict):
    codec: str
    duration_ms: int
    audio_b64: str
    sha256: str


class Envelope(TypedDict, total=False):
    v: int
    device: str
    session: str
    ts: int
    trigger: str
    tracks: dict[str, Track]
    sig: str  # base64url(signature) — added by sign_envelope


def canonical_bytes(envelope: dict[str, Any]) -> bytes:
    """Deterministic JSON serialization for signing.

    - keys sorted
    - separators with no spaces  (',':' → ',',':')
    - ASCII-safe (ensure_ascii=False allows UTF-8; but no payload has
      non-ASCII identifiers, so this is just future-proofing)
    - `sig` field excluded (you sign the body, not the signature itself)
    """
    body = {k: v for k, v in envelope.items() if k != "sig"}
    return json.dumps(
        body,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def sign_envelope(envelope: dict[str, Any], keypair) -> dict[str, Any]:
    """Returns a new dict with `sig` appended."""
    msg = canonical_bytes(envelope)
    signed = dict(envelope)
    signed["sig"] = keypair.sign_b64(msg)
    return signed


def verify_envelope(envelope: dict[str, Any], public_b64: str) -> bool:
    """True iff `envelope['sig']` is a valid Ed25519 signature."""
    from .key import verify
    sig = envelope.get("sig")
    if not isinstance(sig, str) or not sig:
        return False
    msg = canonical_bytes(envelope)
    return verify(public_b64, msg, sig)

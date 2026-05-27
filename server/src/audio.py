"""PCM16 helpers used by the OpenAI pipeline.

The browser uploads raw 16-bit little-endian mono PCM at 16 kHz inside
the envelope's `audio_b64` field. Whisper needs a real audio container,
so we wrap PCM in a minimal WAV header before forwarding it.
"""
from __future__ import annotations

import base64
import struct


def b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def pcm16_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    """Wrap raw PCM16 LE mono bytes in a RIFF/WAVE header."""
    n_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * n_channels * bits_per_sample // 8
    block_align = n_channels * bits_per_sample // 8
    data_size = len(pcm)
    riff_size = 36 + data_size

    header = b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
    fmt = b"fmt " + struct.pack(
        "<IHHIIHH",
        16,                      # PCM chunk size
        1,                       # PCM format
        n_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
    )
    data = b"data" + struct.pack("<I", data_size) + pcm
    return header + fmt + data


def track_to_wav(track: dict, fallback_rate: int = 16000) -> bytes | None:
    """Decode a track sub-object of the envelope to a WAV blob.

    Returns None if the audio_b64 is empty (so callers can skip Whisper).
    """
    if not track:
        return None
    b64 = track.get("audio_b64") or ""
    if not b64:
        return None
    return pcm16_to_wav(b64u_decode(b64), sample_rate=fallback_rate)

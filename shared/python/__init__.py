"""Shared crypto and packet utilities for BudsAI prototype.

Used by:
- server/      (imported as `from shared.python.key import ...`)
- scripts/     (test/demo flows generate keys & sign packets here)

The TypeScript counterpart in shared/ts/ mirrors this exact behavior so
buds-sim can sign packets that this code can verify byte-for-byte.
"""
from .key import (
    Ed25519KeyPair,
    generate_keypair,
    load_public_key,
    load_private_key,
)
from .packet import (
    Envelope,
    sign_envelope,
    verify_envelope,
    canonical_bytes,
)

__all__ = [
    "Ed25519KeyPair",
    "generate_keypair",
    "load_public_key",
    "load_private_key",
    "Envelope",
    "sign_envelope",
    "verify_envelope",
    "canonical_bytes",
]

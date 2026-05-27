"""Vendored copy of shared/python — see project root README.

Mirror of shared/python kept in-tree so the Docker build context can
stay at server/ without contortions. Resync manually when shared/ changes;
Sprint 6 turns this into a proper monorepo build.
"""
from .key import (
    Ed25519KeyPair,
    generate_keypair,
    load_public_key,
    load_private_key,
    verify,
)
from .packet import (
    canonical_bytes,
    sign_envelope,
    verify_envelope,
)

__all__ = [
    "Ed25519KeyPair",
    "generate_keypair",
    "load_public_key",
    "load_private_key",
    "verify",
    "canonical_bytes",
    "sign_envelope",
    "verify_envelope",
]

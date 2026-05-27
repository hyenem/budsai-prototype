"""Ed25519 keypair utilities.

We use Ed25519 because it's:
- 32-byte public keys, 64-byte signatures (fits in a TLV slot easily)
- deterministic (same input → same signature, easier to test)
- supported by the browser via WebCrypto + tweetnacl in shared/ts
- supported by Python via the `cryptography` stdlib-class library
"""
from __future__ import annotations

import base64
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


@dataclass(frozen=True)
class Ed25519KeyPair:
    """A keypair held in raw 32-byte form, with base64url helpers."""

    private_raw: bytes  # 32 bytes
    public_raw: bytes   # 32 bytes

    @property
    def public_b64(self) -> str:
        return _b64e(self.public_raw)

    @property
    def private_b64(self) -> str:
        return _b64e(self.private_raw)

    def sign(self, message: bytes) -> bytes:
        return Ed25519PrivateKey.from_private_bytes(self.private_raw).sign(message)

    def sign_b64(self, message: bytes) -> str:
        return _b64e(self.sign(message))


def generate_keypair() -> Ed25519KeyPair:
    sk = Ed25519PrivateKey.generate()
    private_raw = sk.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = sk.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return Ed25519KeyPair(private_raw=private_raw, public_raw=public_raw)


def load_public_key(b64: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(_b64d(b64))


def load_private_key(b64: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(_b64d(b64))


def verify(public_b64: str, message: bytes, signature_b64: str) -> bool:
    """Return True iff the signature is valid for `message` under `public_b64`."""
    from cryptography.exceptions import InvalidSignature
    try:
        load_public_key(public_b64).verify(_b64d(signature_b64), message)
        return True
    except InvalidSignature:
        return False

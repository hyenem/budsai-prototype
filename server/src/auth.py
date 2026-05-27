"""Device-signed-request authentication.

Every endpoint that takes a signed envelope (e.g. POST /v1/sessions)
runs this dependency first. Flow:

1. Read `X-Device-Id` header.
2. Look up the device's registered Ed25519 public key in the in-mem store.
3. Verify the envelope's `sig` field against `canonical_bytes(envelope)`.
4. Reject with 401 if any step fails.

The signature scheme matches the TypeScript code in shared/ts/ so
buds-sim can sign packets that this verifier accepts byte-for-byte.
"""
from __future__ import annotations

from typing import Any

from fastapi import Header, HTTPException, Request, status

from ._shared import verify_envelope
from .storage import store


async def authenticate_envelope(
    request: Request,
    x_device_id: str | None = Header(default=None, alias="X-Device-Id"),
) -> tuple[str, dict[str, Any]]:
    """Returns (device_id, envelope) on success; raises 401 otherwise."""
    if not x_device_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing X-Device-Id header",
        )

    device = store.get_device(x_device_id)
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"device '{x_device_id}' is not registered",
        )

    try:
        envelope = await request.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="body is not valid JSON",
        ) from exc

    if not isinstance(envelope, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="body must be a JSON object",
        )

    if envelope.get("device") != x_device_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="envelope.device does not match X-Device-Id header",
        )

    if not verify_envelope(envelope, device.public_key_b64):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="signature verification failed",
        )

    return x_device_id, envelope

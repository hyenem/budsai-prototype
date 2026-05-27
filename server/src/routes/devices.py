"""POST /v1/devices/register — store a device's Ed25519 public key.

In production this would require attestation from the buds firmware
(signed by a Samsung CA, etc.). For the prototype, anyone can register
a (device_id, pubkey) pair — but only the holder of the matching
private key can then sign envelopes that pass /v1/sessions auth.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..storage import store

router = APIRouter(prefix="/v1/devices", tags=["devices"])


class RegisterRequest(BaseModel):
    device_id: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_\-:.]+$")
    public_key_b64: str = Field(min_length=20, max_length=128)


class RegisterResponse(BaseModel):
    device_id: str
    registered_at: int


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(req: RegisterRequest) -> RegisterResponse:
    existing = store.get_device(req.device_id)
    if existing and existing.public_key_b64 != req.public_key_b64:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"device '{req.device_id}' is already registered with a different key",
        )
    d = store.register_device(req.device_id, req.public_key_b64)
    return RegisterResponse(device_id=d.id, registered_at=d.registered_at)

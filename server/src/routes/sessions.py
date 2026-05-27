"""POST /v1/sessions — receive a signed envelope and route it.

Pipeline lives in src/pipeline.py — real OpenAI when OPENAI_API_KEY is
set, deterministic mock otherwise.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import authenticate_envelope
from ..pipeline import run_pipeline
from ..storage import store

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])


class SessionCreated(BaseModel):
    session_id: str
    stream_url: str
    accepted_at: int


@router.post("", response_model=SessionCreated)
async def create_session(
    auth: tuple[str, dict[str, Any]] = Depends(authenticate_envelope),
) -> SessionCreated:
    device_id, envelope = auth

    # The envelope already carries a session id from the buds-side.
    # If it's missing (sometimes useful for ad-hoc tests), the server
    # uses the request timestamp as a fallback id.
    session_id = envelope.get("session") or f"srv-{int(time.time() * 1000)}"

    # Store the verified body (minus the signature) for replay/audit.
    body = {k: v for k, v in envelope.items() if k != "sig"}
    store.create_session(session_id, device_id, body)

    # Fire-and-forget the pipeline (real or mock — picked by env).
    asyncio.create_task(run_pipeline(session_id, body))

    return SessionCreated(
        session_id=session_id,
        stream_url=f"/v1/stream/{session_id}",
        accepted_at=int(time.time() * 1000),
    )

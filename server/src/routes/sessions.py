"""POST /v1/sessions — receive a signed envelope and route it.

Sprint 1 uses a mock LLM that always answers the canned BTS / Dynamite
scenario, so end-to-end wiring can be verified before any OpenAI calls
go out (Sprint 2).
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import authenticate_envelope
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

    # Fire-and-forget the (mock) pipeline. Real LLM/STT calls in Sprint 2.
    asyncio.create_task(_run_mock_pipeline(session_id, body))

    return SessionCreated(
        session_id=session_id,
        stream_url=f"/v1/stream/{session_id}",
        accepted_at=int(time.time() * 1000),
    )


# ---------------------------------------------------------------
# Mock pipeline — emulates: decode → STT → intent → LLM → TTS plan
# Emits an SSE event after each pseudo-stage so the buds-sim UI can
# light up its code-line highlights in lockstep.
# ---------------------------------------------------------------

_MOCK_STAGES: list[tuple[str, float, dict[str, Any]]] = [
    ("decoded", 0.30, {"note": "Opus → PCM (mocked; no codec yet)"}),
    ("stt",     0.50, {"transcript": "방금 그거 뭐였어?"}),
    ("intent",  0.40, {"intent": "identify_audio", "confidence": 0.94}),
    ("fingerprint", 0.70, {
        "match": True,
        "song": {"title": "Dynamite", "artist": "BTS", "album": "BE", "year": 2020},
    }),
    ("llm_answer", 0.60, {
        "answer": "방금 들으신 곡은 BTS의 'Dynamite'예요. 2020년 발표 곡입니다.",
        "follow_ups": [
            {"id": "play_full",   "label": "전곡 재생"},
            {"id": "add_library", "label": "내 라이브러리에 추가"},
            {"id": "share",       "label": "공유"},
        ],
    }),
    ("tts", 0.50, {"voice": "alloy", "duration_ms": 3200}),
]


async def _run_mock_pipeline(session_id: str, body: dict[str, Any]) -> None:
    for stage, delay_s, payload in _MOCK_STAGES:
        await asyncio.sleep(delay_s)
        store.append_event(session_id, {
            "stage": stage,
            "ts": int(time.time() * 1000),
            **payload,
        })
    store.append_event(session_id, {"stage": "complete", "ts": int(time.time() * 1000)})
    store.mark_done(session_id)

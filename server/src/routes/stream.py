"""GET /v1/stream/{session_id} — Server-Sent Events.

Subscribers (buds-sim, demo-shell) receive every pipeline stage as it
happens. Closes the connection once the session emits {"stage":"complete"}.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, status
from sse_starlette.sse import EventSourceResponse

from ..storage import store

router = APIRouter(prefix="/v1/stream", tags=["stream"])

# Heartbeat keeps idle connections alive through proxies (Railway edge,
# Cloudflare, etc. all close idle HTTP after ~60s).
_PING_INTERVAL_S = 15.0


@router.get("/{session_id}")
async def stream(session_id: str):
    if store.get_session(session_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"unknown session '{session_id}'",
        )

    async def event_source() -> AsyncIterator[dict]:
        sent = 0
        last_heartbeat = asyncio.get_event_loop().time()
        ev = store.get_session_event(session_id)

        # Flush any events that arrived before the client connected.
        s = store.get_session(session_id)
        if s is None:
            return
        while sent < len(s.events):
            yield {"event": "stage", "data": json.dumps(s.events[sent])}
            sent += 1

        while True:
            if s.done and sent >= len(s.events):
                yield {"event": "end", "data": json.dumps({"session": session_id})}
                return

            # Wait for new events with a heartbeat-sized timeout.
            try:
                await asyncio.wait_for(ev.wait(), timeout=_PING_INTERVAL_S)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "{}"}
                last_heartbeat = asyncio.get_event_loop().time()
                continue
            ev.clear()

            while sent < len(s.events):
                yield {"event": "stage", "data": json.dumps(s.events[sent])}
                sent += 1

    return EventSourceResponse(event_source())

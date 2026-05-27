"""In-memory store for devices and sessions.

Sprint 1: deliberately not persistent. Restarting the server wipes all
device registrations. We swap this for SQLite + Alembic in Sprint 6.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Device:
    id: str
    public_key_b64: str
    registered_at: int  # epoch ms


@dataclass
class Session:
    id: str
    device_id: str
    created_at: int                       # epoch ms
    request: dict[str, Any]               # the verified envelope (without sig)
    events: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False
    # asyncio.Event isn't dataclass-friendly across event loops in tests,
    # so we lazily create it via Store.get_session_event().


class Store:
    """All shared state lives here. Single-process only."""

    def __init__(self) -> None:
        self.devices: dict[str, Device] = {}
        self.sessions: dict[str, Session] = {}
        self._session_events: dict[str, asyncio.Event] = {}
        self._lock = asyncio.Lock()

    # ---- devices ----
    def register_device(self, device_id: str, public_key_b64: str) -> Device:
        d = Device(
            id=device_id,
            public_key_b64=public_key_b64,
            registered_at=int(time.time() * 1000),
        )
        self.devices[device_id] = d
        return d

    def get_device(self, device_id: str) -> Device | None:
        return self.devices.get(device_id)

    # ---- sessions ----
    def create_session(self, session_id: str, device_id: str, request: dict[str, Any]) -> Session:
        s = Session(
            id=session_id,
            device_id=device_id,
            created_at=int(time.time() * 1000),
            request=request,
        )
        self.sessions[session_id] = s
        return s

    def get_session(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    def append_event(self, session_id: str, event: dict[str, Any]) -> None:
        s = self.sessions[session_id]
        s.events.append(event)
        ev = self._session_events.get(session_id)
        if ev is not None:
            ev.set()

    def mark_done(self, session_id: str) -> None:
        self.sessions[session_id].done = True
        ev = self._session_events.get(session_id)
        if ev is not None:
            ev.set()

    def get_session_event(self, session_id: str) -> asyncio.Event:
        ev = self._session_events.get(session_id)
        if ev is None:
            ev = asyncio.Event()
            self._session_events[session_id] = ev
        return ev


# Singleton — imported by routes
store = Store()

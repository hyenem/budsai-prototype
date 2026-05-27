"""BudsAI prototype server.

Sprint 0: hello world + /healthz.
Sprint 1: packet ingestion (signed envelopes), device auth, SSE stream,
          mocked LLM pipeline (Dynamite scenario).
Sprint 2: real OpenAI Whisper + GPT-4o + TTS.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import devices as devices_routes
from .routes import sessions as sessions_routes
from .routes import stream as stream_routes

VERSION = "0.2.0"

settings = get_settings()

app = FastAPI(
    title="BudsAI Prototype Server",
    version=VERSION,
    description="Routes signed packets from buds-sim → LLM → response.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


app.include_router(devices_routes.router)
app.include_router(sessions_routes.router)
app.include_router(stream_routes.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "version": VERSION, "env": settings.env}


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "budsai-prototype-server",
        "version": VERSION,
        "docs": "/docs",
        "health": "/healthz",
        "register": "POST /v1/devices/register",
        "session": "POST /v1/sessions  (X-Device-Id + signed body)",
        "stream": "GET  /v1/stream/{session_id}  (SSE)",
    }

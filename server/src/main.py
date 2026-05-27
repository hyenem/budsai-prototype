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

VERSION = "0.4.0"

settings = get_settings()

app = FastAPI(
    title="BudsAI Prototype Server",
    version=VERSION,
    description="Routes signed packets from buds-sim → LLM → response.",
)

# Demo/prototype CORS: accept any origin so the GitHub Pages bundle works.
# Real security lives in the device signature scheme — every meaningful
# endpoint requires a valid Ed25519 signature, so opening CORS doesn't
# expose anything an attacker couldn't already hit with curl.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",
    allow_credentials=False,   # required when origin matches via regex/wildcard
    allow_methods=["*"],
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

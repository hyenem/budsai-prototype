"""BudsAI prototype server.

Sprint 0: hello world + /healthz only.
Sprint 1+ adds packet ingestion, device auth, SSE stream, LLM router.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings

VERSION = "0.1.0"

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
    }

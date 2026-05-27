# BudsAI — Prototype

> 🟢 **Live**:
> · API → <https://budsai.up.railway.app/healthz>
> · Static (placeholder, populated through Sprint 1+) → <https://hyenem.github.io/budsai-prototype/>

A live, in-browser walkthrough of the [BudsAI design](https://hyenem.github.io)
running entirely on a laptop. No earbud hardware required:

| Module | Role | Where it runs |
| --- | --- | --- |
| `buds-sim/` | Galaxy Buds firmware simulator — mic capture, ring buffers, Opus, VAD, packet signing | Browser (local mic + speakers) |
| `galaxy-host/` | Galaxy phone bridge — receives packets, forwards to server, renders action cards | Browser |
| `others-host/` | "Others" host bridge — BNEP unwrap + passthrough (cannot read payload) | Browser |
| `server/` | LLM router + auth — only accepts signed packets from registered devices | Railway (Python + FastAPI) |
| `demo-shell/` | 4-panel cockpit — runs all modules side-by-side with live code highlight | Browser |
| `shared/` | Packet format, key generation, signing — used by every module | Source-only |

## Architecture

```
   ┌────────────┐   signed pkt    ┌─────────────────┐    HTTPS     ┌─────────────┐
   │  buds-sim  │ ──────────────► │  galaxy-host    │ ───────────► │   server    │
   │  (browser) │                 │  (browser)      │              │  (Railway)  │
   │            │ ◄────────────── │                 │ ◄─────────── │             │
   └────────────┘    TTS audio    └─────────────────┘   action +   └─────────────┘
         │                                                 TTS            ▲
         │  (BT PAN scenario)                                              │
         │                          ┌─────────────────┐                    │
         └────────────────────────► │  others-host    │ ───────────────────┘
                                    │  BNEP unwrap    │
                                    └─────────────────┘
```

All four browser modules show the **exact source code that's executing right now**,
with the active line highlighted as packets move through the system.

## Quick start (Sprint 0 — Hello world)

```bash
# server only — proves the deployment pipeline works
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn src.main:app --reload --port 8000

# in another terminal:
curl http://localhost:8000/healthz
# → {"status":"ok","version":"0.1.0"}
```

## Deployment

| Component | Platform | Trigger |
| --- | --- | --- |
| `server/` | [Railway](https://railway.app) | `git push` (auto-detects Dockerfile) |
| `buds-sim/`, `galaxy-host/`, `others-host/`, `demo-shell/` | GitHub Pages (`hyenem.github.io/prototype/...`) | Built artifacts copied to design-doc repo |

## Sprint plan

- **Sprint 0** — repo + FastAPI hello world + Railway deploy ✅ **done** (2026-05-27)
- **Sprint 1** — packet format, device auth, buds-sim → server full round-trip (mocked LLM)
- **Sprint 2** — real OpenAI integration (Whisper + GPT-4o + TTS)
- **Sprint 3** — galaxy-host with action cards
- **Sprint 4** — others-host with BNEP unwrap visualization
- **Sprint 5** — demo-shell 4-panel cockpit

Full plan and design rationale: <https://hyenem.github.io/appendix-final.html>

## Stack

- **Server**: Python 3.12, FastAPI, uvicorn, OpenAI SDK
- **Front-end**: Vite + TypeScript (vanilla, no React for code-clarity)
- **Auth**: Ed25519 device keys + JWT session tokens
- **Audio**: Web Audio API + [opus-recorder](https://github.com/chris-rudmin/opus-recorder)
- **Deploy**: Railway (server) + GitHub Pages (static modules)

## License

Prototype / research. See parent design doc.

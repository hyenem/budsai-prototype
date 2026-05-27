"""Real OpenAI pipeline + deterministic mock fallback.

Stages emitted (same order in both modes so the buds-sim UI doesn't
have to branch on mode):

    decoded → stt → intent → fingerprint → llm_answer → tts → complete

When `settings.has_openai` is False (no API key set) we fall back to
the mock that ships with Sprint 1-A. This keeps:

  - pytest passing without API access
  - the server bootable on a fresh Railway deploy before the operator
    adds OPENAI_API_KEY (the landing page still works)

Audio response (TTS) is emitted as a separate "audio" event right
before "complete" so the buds-sim can pipe it to <audio> for playback.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any

from openai import AsyncOpenAI

from .audio import track_to_wav, track_to_whisper_file
from .config import get_settings
from .storage import store

logger = logging.getLogger("budsai.pipeline")

# ----- prompt -----
_SYSTEM_PROMPT = """\
You are a quick assistant living inside Galaxy Buds. The user just
triggered you. You receive both the QUESTION transcript and the
ACTUAL AUDIO of what they were listening to.

Two audio attachments may be present:
  • SYSTEM  audio = what the buds were PLAYING into the user's ear
                    (music, podcast, call audio). Use your audio
                    understanding to identify songs, genres, lyrics,
                    speakers, or sounds.
  • EXTERNAL audio = what the world OUTSIDE the user sounded like
                     (ANC mic capture). Useful for "what did the
                     announcement say?" or "what's that noise?".

Plus a text transcript:
  • QUESTION  = what the USER themselves just said.

Use whichever of the inputs are relevant. Examples:
  - "방금 그 노래 뭐였어?"            → identify from SYSTEM audio
  - "옆에서 뭐라고 했어?"              → summarize EXTERNAL audio
  - "내일 오전 9시 회의 일정 추가"     → only QUESTION matters

Return STRICT JSON (no prose, no code fences):

{
  "intent":     "<snake_case label>",
  "confidence": <float 0..1>,
  "answer":     "<concise reply in the language the user used>",
  "track_used": "<system|external|question|combined>",
  "follow_ups": [
    {"id": "<snake_case_id>", "label": "<short button label>"}
  ]
}

If the SYSTEM audio is clearly synthetic / not a real song, say so
honestly in `answer` rather than guessing. Keep `answer` under 220
characters (it will be spoken via TTS).

Good intent values: identify_audio, summarize_overheard, add_calendar,
web_search, play_music, ask_followup, smalltalk.
"""


# =====================================================================
#                          public entry point
# =====================================================================

async def run_pipeline(session_id: str, body: dict[str, Any]) -> None:
    settings = get_settings()
    try:
        if settings.has_openai:
            await _run_real(session_id, body, settings)
        else:
            await _run_mock(session_id, body)
    except Exception as exc:
        logger.exception("pipeline error for %s: %s", session_id, exc)
        store.append_event(session_id, {
            "stage": "error",
            "ts": int(time.time() * 1000),
            "message": str(exc),
        })
        store.mark_done(session_id)


# =====================================================================
#                              REAL path
# =====================================================================

async def _run_real(session_id: str, body: dict[str, Any], settings) -> None:
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    t0 = time.time()

    # ---- 1. decoded ----
    tracks = body.get("tracks") or {}
    system_t  = tracks.get("system")   or {}
    external_t = tracks.get("external") or {}
    question_t = tracks.get("question") or {}
    store.append_event(session_id, {
        "stage": "decoded",
        "ts": int(time.time() * 1000),
        "note": "PCM16 / WebM-Opus · 3 tracks",
        "system_ms":   system_t.get("duration_ms", 0),
        "external_ms": external_t.get("duration_ms", 0),
        "question_ms": question_t.get("duration_ms", 0),
        "system_codec":   system_t.get("codec"),
        "external_codec": external_t.get("codec"),
        "question_codec": question_t.get("codec"),
    })

    # ---- 2. stt — QUESTION TRACK ONLY ----
    # System and external get sent to GPT-4o-audio in step 5; transcribing
    # music with Whisper just extracts lyrics, which the text LLM can't
    # use to actually identify a song. The user's question, on the other
    # hand, is exactly what Whisper is built for.
    q_text = await _transcribe_question(client, question_t, settings.openai_stt_model)
    store.append_event(session_id, {
        "stage": "stt",
        "ts": int(time.time() * 1000),
        "model": settings.openai_stt_model,
        "scope": "question only — system+external go to audio LLM next",
        "question_text": q_text or "(no speech detected)",
    })

    # ---- 3. intent (cheap pre-classifier; LLM refines later) ----
    store.append_event(session_id, {
        "stage": "intent",
        "ts": int(time.time() * 1000),
        "note": "ambient pre-classifier; audio LLM picks intent + track_used next",
        "system_kind":   _classify_track(system_t,   ""),
        "external_kind": _classify_track(external_t, ""),
    })

    # ---- 4. fingerprint placeholder ----
    store.append_event(session_id, {
        "stage": "fingerprint",
        "ts": int(time.time() * 1000),
        "match": False,
        "note": "GPT-4o-audio does song-recognition-like reasoning in next stage",
    })

    # ---- 5. llm_answer (audio LLM if available, falls back to text) ----
    llm = await _llm_reply_audio(client, q_text, system_t, external_t, settings)
    store.append_event(session_id, {
        "stage": "llm_answer",
        "ts": int(time.time() * 1000),
        "model": llm.pop("_model", settings.openai_llm_model),
        **llm,
    })

    # ---- 6. tts ----
    tts_b64, tts_ms = await _tts(client, llm["answer"], settings)
    store.append_event(session_id, {
        "stage": "tts",
        "ts": int(time.time() * 1000),
        "voice": settings.openai_tts_voice,
        "duration_ms": tts_ms,
        "audio_b64": tts_b64,
        "audio_mime": "audio/mpeg",
    })

    store.append_event(session_id, {
        "stage": "complete",
        "ts": int(time.time() * 1000),
        "elapsed_ms": int((time.time() - t0) * 1000),
    })
    store.mark_done(session_id)


# ----- OpenAI calls -----

async def _whisper(client: AsyncOpenAI, fname: str, audio_bytes: bytes, model: str) -> str:
    # Whisper accepts wav / mp3 / mp4 / mpeg / mpga / m4a / wav / webm / ogg.
    mime = "audio/wav" if fname.endswith(".wav") else (
        "audio/webm" if fname.endswith(".webm") else (
            "audio/ogg" if fname.endswith(".ogg") else "application/octet-stream"
        )
    )
    file_arg = (fname, audio_bytes, mime)
    r = await client.audio.transcriptions.create(model=model, file=file_arg)
    return (r.text or "").strip()


async def _transcribe_question(
    client: AsyncOpenAI,
    question_t: dict[str, Any],
    model: str,
) -> str:
    pair = track_to_whisper_file(question_t)
    if not pair or len(pair[1]) < 800:
        return ""
    fname, audio_bytes = pair
    stem, _, ext = fname.rpartition(".")
    named = f"question.{ext}" if ext else "question.bin"
    try:
        return await _whisper(client, named, audio_bytes, model)
    except Exception as exc:
        logger.warning("whisper(question) failed: %s", exc)
        return ""


def _track_to_audio_part(track: dict[str, Any], label: str) -> dict[str, Any] | None:
    """Build an `input_audio` chat message part if the track has content."""
    pair = track_to_whisper_file(track)
    if not pair or len(pair[1]) < 800:
        return None
    fname, audio_bytes = pair
    fmt = "wav" if fname.endswith(".wav") else (
        "webm" if fname.endswith(".webm") else (
            "ogg" if fname.endswith(".ogg") else "wav"
        )
    )
    # The GPT-4o-audio API accepts a small subset of formats. WAV is the
    # safest; the rest may be rejected depending on model version.
    if fmt not in ("wav", "mp3"):
        # Re-wrap raw audio in WAV via track_to_wav only if it was PCM.
        # For webm/opus we currently send the webm and let the API try.
        pass
    return {
        "type": "input_audio",
        "input_audio": {
            "data": base64.b64encode(audio_bytes).decode("ascii"),
            "format": fmt if fmt in ("wav", "mp3") else "wav",
        },
    }


async def _llm_reply_audio(
    client: AsyncOpenAI,
    question_text: str,
    system_t: dict[str, Any],
    external_t: dict[str, Any],
    settings,
) -> dict[str, Any]:
    """Audio-modality LLM call. Falls back to text-only on errors."""
    audio_model = getattr(settings, "openai_audio_llm_model", "") or ""
    user_parts: list[dict[str, Any]] = [
        {"type": "text", "text": (
            f"QUESTION (user's speech): {question_text or '(silence)'}\n"
            "If SYSTEM and/or EXTERNAL audio attachments are present below, "
            "analyze them to answer. Return only the JSON contract."
        )},
    ]
    # Only PCM tracks are safe to attach right now — webm/opus question
    # is for Whisper, not the audio LLM. System/external are PCM so they
    # become WAV via track_to_whisper_file.
    sys_part = _track_to_audio_part(system_t, "SYSTEM")
    if sys_part:
        user_parts.append({"type": "text", "text": "--- SYSTEM (what the buds were playing) ---"})
        user_parts.append(sys_part)
    ext_part = _track_to_audio_part(external_t, "EXTERNAL")
    if ext_part:
        user_parts.append({"type": "text", "text": "--- EXTERNAL (ANC mic) ---"})
        user_parts.append(ext_part)

    has_audio = sys_part is not None or ext_part is not None

    if has_audio and audio_model:
        try:
            r = await client.chat.completions.create(
                model=audio_model,
                modalities=["text"],
                temperature=0.4,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user",   "content": user_parts},
                ],
            )
            raw = r.choices[0].message.content or "{}"
            data = json.loads(raw) if raw.strip().startswith("{") else \
                   {"answer": raw[:200]}
            data.setdefault("intent", "smalltalk")
            data.setdefault("confidence", 0.5)
            data.setdefault("answer", "")
            data.setdefault("track_used", "combined" if sys_part and ext_part else
                                          ("system" if sys_part else "external"))
            data.setdefault("follow_ups", [])
            data["_model"] = audio_model
            return data
        except Exception as exc:
            logger.warning("audio LLM (%s) failed, falling back to text: %s",
                           audio_model, exc)

    # Text-only fallback — pass just the question transcript.
    return await _llm_reply(client, {
        "system_text":   "(audio attached but not processed; falling back to text-only)",
        "external_text": "",
        "question_text": question_text,
    }, settings.openai_llm_model)


async def _transcribe_tracks(
    client: AsyncOpenAI,
    system_t: dict[str, Any],
    external_t: dict[str, Any],
    question_t: dict[str, Any],
    model: str,
) -> dict[str, str]:
    """Whisper on each non-empty track in parallel. Honors track.codec —
    PCM gets WAV-wrapped, container formats (webm/opus) go straight to API."""
    async def one(track: dict[str, Any], name: str) -> str:
        pair = track_to_whisper_file(track)
        if not pair or len(pair[1]) < 800:
            return ""
        fname, audio_bytes = pair
        # Stamp track name into the filename so server logs are readable.
        stem, _, ext = fname.rpartition(".")
        named = f"{name}.{ext}" if ext else f"{name}.bin"
        try:
            return await _whisper(client, named, audio_bytes, model)
        except Exception as exc:
            logger.warning("whisper(%s) failed: %s", name, exc)
            return ""

    sys_text, ext_text, q_text = await asyncio.gather(
        one(system_t,   "system"),
        one(external_t, "external"),
        one(question_t, "question"),
    )
    return {
        "system_text":   sys_text,
        "external_text": ext_text,
        "question_text": q_text,
    }


async def _llm_reply(
    client: AsyncOpenAI,
    stt: dict[str, str],
    model: str,
) -> dict[str, Any]:
    user_msg = (
        f"SYSTEM:   {stt['system_text']   or '(empty)'}\n"
        f"EXTERNAL: {stt['external_text'] or '(empty)'}\n"
        f"QUESTION: {stt['question_text'] or '(silence)'}\n"
        "Reply per the JSON contract."
    )
    r = await client.chat.completions.create(
        model=model,
        temperature=0.4,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ],
    )
    raw = r.choices[0].message.content or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {"intent": "smalltalk", "confidence": 0.3, "answer": raw[:200],
                "track_used": "question", "follow_ups": []}
    data.setdefault("intent", "smalltalk")
    data.setdefault("confidence", 0.5)
    data.setdefault("answer", "")
    data.setdefault("track_used", "question")
    data.setdefault("follow_ups", [])
    data["_model"] = model
    return data


async def _tts(client: AsyncOpenAI, text: str, settings) -> tuple[str, int]:
    if not text:
        return "", 0
    r = await client.audio.speech.create(
        model=settings.openai_tts_model,
        voice=settings.openai_tts_voice,
        input=text,
        response_format="mp3",
    )
    mp3 = r.read() if hasattr(r, "read") else r.content
    return base64.b64encode(mp3).decode("ascii"), int(len(text) * 60)  # rough ms


# ----- tiny ambient classifier -----

def _classify_track(track: dict[str, Any], transcript: str) -> str:
    """Cheap pre-tag for each track. Sprint 4 swaps in real spectral analysis."""
    dur = track.get("duration_ms", 0)
    if dur < 800:
        return "silence"
    if transcript and len(transcript) > 20:
        # Lots of words → likely speech (podcast, conversation)
        return "speech"
    if transcript:
        # A few words → could be vocal music
        return "music_with_vocals"
    return "music_or_noise"


# =====================================================================
#                              MOCK path
# =====================================================================

_MOCK_STAGES: list[tuple[str, float, dict[str, Any]]] = [
    ("decoded",     0.30, {"note": "PCM16 16kHz mono · 3 tracks (mocked; no OPENAI_API_KEY)"}),
    ("stt",         0.50, {
        "model": "mock-whisper",
        "system_text":   "♪ ♪ Dynamite in my veins, dancing in the flames ♪",
        "external_text": "(faint café ambient)",
        "question_text": "방금 그거 뭐였어?",
    }),
    ("intent",      0.40, {
        "system_kind": "music_with_vocals",
        "external_kind": "music_or_noise",
        "note": "ambient pre-classifier",
    }),
    ("fingerprint", 0.70, {
        "match": True,
        "song": {"title": "Dynamite", "artist": "BTS", "album": "BE", "year": 2020},
    }),
    ("llm_answer",  0.60, {
        "intent": "identify_audio",
        "confidence": 0.94,
        "track_used": "system",
        "answer": "방금 들으신 곡은 BTS의 'Dynamite'예요. 2020년 발표 곡입니다.",
        "follow_ups": [
            {"id": "play_full",   "label": "전곡 재생"},
            {"id": "add_library", "label": "내 라이브러리에 추가"},
            {"id": "share",       "label": "공유"},
        ],
    }),
    ("tts",         0.50, {"voice": "alloy", "duration_ms": 3200,
                           "audio_b64": "", "audio_mime": "audio/mpeg"}),
]


async def _run_mock(session_id: str, body: dict[str, Any]) -> None:
    t0 = time.time()
    for stage, delay_s, payload in _MOCK_STAGES:
        await asyncio.sleep(delay_s)
        store.append_event(session_id, {
            "stage": stage,
            "ts": int(time.time() * 1000),
            **payload,
        })
    store.append_event(session_id, {
        "stage": "complete",
        "ts": int(time.time() * 1000),
        "elapsed_ms": int((time.time() - t0) * 1000),
    })
    store.mark_done(session_id)

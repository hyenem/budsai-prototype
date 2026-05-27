// Signed packet envelope — TS/JS side.
//
// Mirrors shared/python/packet.py exactly so the server (Python)
// verifies signatures produced here (browser) without ambiguity.
//
// Canonical-bytes contract:
//   1. Take the envelope, drop the `sig` field.
//   2. JSON.stringify with keys deeply sorted, separators (",",":").
//   3. UTF-8 encode the resulting string.
//   4. That byte string is what gets Ed25519-signed.

export function canonicalBytes(envelope) {
  const withoutSig = {};
  for (const k of Object.keys(envelope)) {
    if (k !== "sig") withoutSig[k] = envelope[k];
  }
  const json = stableStringify(withoutSig);
  return new TextEncoder().encode(json);
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k =>
    JSON.stringify(k) + ":" + stableStringify(v[k])
  ).join(",") + "}";
}

export async function signEnvelope(envelope, keypair) {
  const msg = canonicalBytes(envelope);
  const sig = await keypair.signB64(msg);
  return { ...envelope, sig };
}

// Helper for buds-sim — produces an envelope from raw track data.
//
// THREE independent tracks:
//   system   — what the buds were PLAYING  (PCM16 raw for now)
//   external — what the ANC mic was hearing (PCM16 raw for now)
//   question — what the user SAID          (WebM/Opus when MediaRecorder
//                                           supports it, otherwise PCM16)
//
// Each track carries its own `codec` field so the server knows whether
// to WAV-wrap raw PCM or feed Opus straight to Whisper.
export function buildEnvelope({
  deviceId,
  sessionId,
  trigger = "long_press",
  systemBytes,    systemMs,
  externalBytes,  externalMs,
  // question is Opus-preferred; main.js may pass questionOpus_b64 +
  // questionOpus_mime instead of questionBytes.
  questionBytes,  questionMs,
  questionOpus_b64,
  questionOpus_mime,
}) {
  const pcmTrack = (bytes, ms) => ({
    codec: "pcm16",
    duration_ms: ms | 0,
    audio_b64: bytesToB64u(bytes),
    sha256: "placeholder",
  });

  const opusTrack = (b64, mime, ms) => ({
    codec: mime || "audio/webm;codecs=opus",
    duration_ms: ms | 0,
    audio_b64: b64,
    sha256: "placeholder",
  });

  const question = questionOpus_b64
    ? opusTrack(questionOpus_b64, questionOpus_mime, questionMs)
    : pcmTrack(questionBytes, questionMs);

  return {
    v: 1,
    device: deviceId,
    session: sessionId,
    ts: Date.now(),
    trigger,
    tracks: {
      system:   pcmTrack(systemBytes,   systemMs),
      external: pcmTrack(externalBytes, externalMs),
      question,
    },
  };
}

function bytesToB64u(bytes) {
  if (!bytes || bytes.length === 0) return "";
  // Avoid stack blow-up on very large arrays
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

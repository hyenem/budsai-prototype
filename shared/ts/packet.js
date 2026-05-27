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

// Helper for buds-sim — produces an envelope from raw track data
// without yet doing Opus encoding (real codec lands later).
//
// THREE independent tracks, all Int16 mono 16 kHz:
//   system   — what the buds were PLAYING (music/podcast/call)
//   external — what the ANC mic was hearing OUTSIDE the user
//   question — what the user SAID after long-press
export function buildEnvelope({
  deviceId,
  sessionId,
  trigger = "long_press",
  systemBytes,    systemMs,
  externalBytes,  externalMs,
  questionBytes,  questionMs,
}) {
  const track = (bytes, ms) => ({
    codec: "pcm16",
    duration_ms: ms | 0,
    audio_b64: bytesToB64u(bytes),
    sha256: "placeholder",
  });

  return {
    v: 1,
    device: deviceId,
    session: sessionId,
    ts: Date.now(),
    trigger,
    tracks: {
      system:   track(systemBytes,   systemMs),
      external: track(externalBytes, externalMs),
      question: track(questionBytes, questionMs),
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

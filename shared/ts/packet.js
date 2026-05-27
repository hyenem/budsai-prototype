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

export function signEnvelope(envelope, keypair) {
  const msg = canonicalBytes(envelope);
  return { ...envelope, sig: keypair.signB64(msg) };
}

// Helper for buds-sim — produces an envelope from raw track data
// without yet doing Opus encoding (Sprint 2 swaps in real codec).
export function buildEnvelope({
  deviceId,
  sessionId,
  trigger = "long_press",
  lookbackBytes,    // Uint8Array — raw PCM placeholder
  questionBytes,    // Uint8Array
  lookbackMs,
  questionMs,
}) {
  return {
    v: 1,
    device: deviceId,
    session: sessionId,
    ts: Date.now(),
    trigger,
    tracks: {
      lookback: {
        codec: "pcm16",
        duration_ms: lookbackMs,
        audio_b64: bytesToB64u(lookbackBytes),
        sha256: "placeholder",
      },
      question: {
        codec: "pcm16",
        duration_ms: questionMs,
        audio_b64: bytesToB64u(questionBytes),
        sha256: "placeholder",
      },
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

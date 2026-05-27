// MediaRecorder wrapper that captures the question track as WebM/Opus.
//
// Real buds compress in firmware with libopus before sending. The
// browser equivalent — without shipping libopus.wasm ourselves — is
// MediaRecorder with mimeType 'audio/webm;codecs=opus'. The server
// can feed the resulting WebM directly to Whisper (it accepts webm).
//
// We use this ONLY for the question track for now. The 30 s lookback
// tracks (system + external) stay raw PCM because driving a rolling
// 30 s recorder + splicing valid WebM clusters is materially more
// complex than the simple PCM ring buffer we already have.

export class OpusRecorder {
  /**
   * @param {MediaStream} stream  the same mic stream that feeds Mic.js
   */
  constructor(stream) {
    this.stream = stream;
    this.recorder = null;
    this.chunks = [];
    this._supportedMime = pickMime();
  }

  static isSupported() {
    return typeof MediaRecorder !== "undefined" && !!pickMime();
  }

  start() {
    this.chunks = [];
    if (!OpusRecorder.isSupported()) {
      throw new Error("MediaRecorder/Opus not supported in this browser");
    }
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this._supportedMime,
      audioBitsPerSecond: 16000,        // ~16 kbps Opus, plenty for STT
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);            // flush a chunk every 250 ms
  }

  /** Stops the recorder and resolves with the assembled Blob. */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        return resolve(new Blob(this.chunks, { type: this._supportedMime }));
      }
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this._supportedMime }));
      };
      this.recorder.stop();
    });
  }

  get mime() { return this._supportedMime || "audio/webm"; }
}

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return null;
}

// Helper: Blob → base64url (no padding) for envelope.audio_b64
export async function blobToB64u(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

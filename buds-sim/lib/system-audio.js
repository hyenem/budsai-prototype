// Simulator for "what the buds are PLAYING into the user's ear".
//
// In real buds this would be the audio decoder's output (the music
// being rendered by the SoC's DAC). In the simulator we play an mp3
// in the page and tap the AudioContext graph just before it reaches
// destination — same idea, different source.
//
// Routing:
//
//   <audio> ─► MediaElementSource ─┬─► destination   (so user hears it)
//                                  │
//                                  └─► AnalyserNode  (level meter)
//                                  └─► onSamples cb  (Int16 16 kHz → ring A)
//
// The mic stays untouched; this is a parallel capture path that
// doesn't pick up environmental sound.

const TARGET_SAMPLE_RATE = 16000;

export class SystemAudio {
  constructor() {
    this.ctx = null;
    this.elementSource = null;
    this.synthNodes = null;   // { osc, gain } when in synthetic mode
    this.analyser = null;
    this.processor = null;
    this.sampleListeners = [];
    this.levelListeners = [];
    this.audioEl = null;
    this.mode = "element";    // "element" | "synthetic-melody" | "synthetic-podcast"
  }

  /** Attach to an existing <audio> element (used in element mode). */
  attach(audioEl) {
    if (this.audioEl === audioEl) return;
    this.audioEl = audioEl;
    audioEl.addEventListener("play", () => this._ensureElementGraph(), { once: true });
  }

  /** Switch to synthetic mode. Stops any element playback. */
  startSynthetic(kind = "synthetic-melody") {
    this.mode = kind;
    if (this.audioEl) {
      try { this.audioEl.pause(); } catch {}
      this.audioEl.src = "";
    }
    if (this.synthNodes) this._stopSynth();
    this._ensureSyntheticGraph(kind);
  }

  /** Stop any current synthesizer and revert to silent element mode. */
  stopSynthetic() {
    if (this.synthNodes) this._stopSynth();
    this.mode = "element";
  }

  _ensureElementGraph() {
    if (this.ctx && this.elementSource) return;
    this._ensureCtx();
    this.elementSource = this.ctx.createMediaElementSource(this.audioEl);
    this._wireTap(this.elementSource);
  }

  _ensureSyntheticGraph(kind) {
    this._ensureCtx();
    const ctx = this.ctx;

    // Build a small chain: oscillator → gain → tap point
    const gain = ctx.createGain();
    gain.gain.value = 0.35;

    const osc = ctx.createOscillator();
    osc.type = kind === "synthetic-podcast" ? "sawtooth" : "triangle";
    osc.connect(gain);

    // Schedule a melody / spoken-cadence pattern over time
    const t0 = ctx.currentTime + 0.05;
    if (kind === "synthetic-podcast") {
      schedulePodcastCadence(osc, gain, t0);
    } else {
      scheduleMelody(osc, gain, t0);
    }

    osc.start(t0);
    this.synthNodes = { osc, gain };
    this._wireTap(gain);
  }

  _stopSynth() {
    try { this.synthNodes.osc.stop(); } catch {}
    try { this.synthNodes.osc.disconnect(); } catch {}
    try { this.synthNodes.gain.disconnect(); } catch {}
    this.synthNodes = null;
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    // Tap nodes are built once and reused across source switches.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const i16 = downsampleAndQuantize(input, this.ctx.sampleRate, TARGET_SAMPLE_RATE);
      for (const l of this.sampleListeners) l(i16);
    };
    this.processor.connect(this.ctx.destination);
    this._pumpLevel();
  }

  /** Connect any source node into both the analyser tap and audible out. */
  _wireTap(source) {
    try { source.disconnect(); } catch {}
    source.connect(this.analyser);
    source.connect(this.processor);
    source.connect(this.ctx.destination);
  }

  _pumpLevel() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      for (const l of this.levelListeners) l(rms);
      requestAnimationFrame(tick);
    };
    tick();
  }

  onSamples(cb) { this.sampleListeners.push(cb); }
  onLevel(cb)   { this.levelListeners.push(cb); }
}

function downsampleAndQuantize(input, inRate, outRate) {
  if (outRate === inRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp16(input[i] * 32767);
    return out;
  }
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  let oi = 0, ii = 0;
  while (oi < outLen) {
    const next = Math.floor((oi + 1) * ratio);
    let sum = 0; let cnt = 0;
    for (let i = ii; i < next && i < input.length; i++) { sum += input[i]; cnt++; }
    out[oi++] = clamp16((sum / cnt) * 32767);
    ii = next;
  }
  return out;
}

function clamp16(x) { return Math.max(-32768, Math.min(32767, x | 0)); }

// ---------------------------------------------------------------------
// Tiny WebAudio "music" synth — schedules a pleasant 30s loop so the
// system track has something audible without shipping any mp3.
// ---------------------------------------------------------------------

const MELODY_HZ = [
  // A major-ish arpeggio loop, ~250ms per step. Picked to vaguely
  // resemble "Dynamite"'s upbeat feel without any actual lyrics.
  330, 415, 494, 587, 494, 415, 330, 392,
  370, 494, 587, 740, 587, 494, 370, 440,
];

function scheduleMelody(osc, gain, startSec) {
  const STEP = 0.25;       // 250 ms per note
  const LOOP_LEN = MELODY_HZ.length * STEP;
  const FORWARD = 30;      // schedule 30 s of audio so the buffer fills
  for (let t = 0; t < FORWARD; t += STEP) {
    const idx = Math.floor((t / STEP) % MELODY_HZ.length);
    osc.frequency.setValueAtTime(MELODY_HZ[idx], startSec + t);
  }
  // Gentle envelope every beat
  for (let t = 0; t < FORWARD; t += STEP) {
    gain.gain.setValueAtTime(0.05, startSec + t);
    gain.gain.linearRampToValueAtTime(0.3, startSec + t + 0.02);
    gain.gain.linearRampToValueAtTime(0.05, startSec + t + STEP - 0.02);
  }
}

function schedulePodcastCadence(osc, gain, startSec) {
  // Simulates speech-like pitch contour: rising-then-falling intonation
  // over phrases ~1.5s long, with brief silences between.
  const PHRASE = 1.4;
  const PAUSE = 0.3;
  const FORWARD = 30;
  let t = 0;
  while (t < FORWARD) {
    const baseHz = 110 + Math.random() * 40;
    osc.frequency.setValueAtTime(baseHz, startSec + t);
    osc.frequency.linearRampToValueAtTime(baseHz + 60, startSec + t + PHRASE * 0.5);
    osc.frequency.linearRampToValueAtTime(baseHz - 20, startSec + t + PHRASE);
    gain.gain.setValueAtTime(0.0, startSec + t);
    gain.gain.linearRampToValueAtTime(0.22, startSec + t + 0.05);
    gain.gain.linearRampToValueAtTime(0.0, startSec + t + PHRASE);
    t += PHRASE + PAUSE;
  }
}

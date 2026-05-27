// Web Audio mic capture + level meter.
//
// We capture mic input via AudioContext, route it through an
// AnalyserNode (for the live level meter) and through a
// ScriptProcessorNode-style worklet for raw PCM samples that
// the ring buffer can consume.
//
// We deliberately resample to 16 kHz mono Int16 to match what
// real buds would send. Browsers usually run AudioContext at
// 44.1 or 48 kHz; we downsample with a simple decimation pass.

const TARGET_SAMPLE_RATE = 16000;

export class Mic {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.processor = null;
    this.sampleListeners = [];
    this.levelListeners = [];
    this._rafId = null;
  }

  isRunning() { return !!this.ctx; }

  async start() {
    if (this.ctx) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    this.stream = stream;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.source = this.ctx.createMediaStreamSource(stream);

    // Level meter
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this._pumpLevel();

    // Raw sample tap (deprecated but universally supported and small).
    // 2048 samples ≈ 46 ms @ 44.1 kHz; resampled to ~22 ms @ 16 kHz.
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer.getChannelData(0);  // Float32 in [-1, 1]
      const i16 = downsampleAndQuantize(inBuf, this.ctx.sampleRate, TARGET_SAMPLE_RATE);
      for (const l of this.sampleListeners) l(i16);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.processor) { try { this.processor.disconnect(); } catch {} }
    if (this.source)    { try { this.source.disconnect(); } catch {} }
    if (this.ctx)       { try { this.ctx.close(); } catch {} }
    this.ctx = this.source = this.analyser = this.processor = null;
  }

  onSamples(cb)  { this.sampleListeners.push(cb); }
  onLevel(cb)    { this.levelListeners.push(cb); }

  _pumpLevel() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      // Compute simple RMS [0,1]
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      for (const l of this.levelListeners) l(rms);
      this._rafId = requestAnimationFrame(tick);
    };
    tick();
  }
}

/** Decimate Float32 input to int16 at the target rate. */
function downsampleAndQuantize(input, inRate, outRate) {
  if (outRate === inRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp16(input[i] * 32767);
    return out;
  }
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  let oi = 0;
  let ii = 0;
  // Box-filter average over the input window for each output sample.
  while (oi < outLen) {
    const next = Math.floor((oi + 1) * ratio);
    let sum = 0; let cnt = 0;
    for (let i = ii; i < next && i < input.length; i++) {
      sum += input[i]; cnt++;
    }
    out[oi++] = clamp16((sum / cnt) * 32767);
    ii = next;
  }
  return out;
}

function clamp16(x) {
  return Math.max(-32768, Math.min(32767, x | 0));
}

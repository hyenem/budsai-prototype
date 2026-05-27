// Dual ring buffer matching shared/python/packet.py contract.
//
//   Buffer A — environmental lookback (mic): rolling N seconds
//   Buffer B — user-speech question:       latched on trigger, ends on VAD
//
// Sample format: Int16 mono @ 16 kHz.

export class RingBuffer {
  /**
   * @param {object} opts
   * @param {number} opts.durationMs   total buffer window in ms
   * @param {number} opts.sampleRate   in Hz (16000 default)
   */
  constructor({ durationMs, sampleRate = 16000, name = "" }) {
    this.name = name;
    this.sampleRate = sampleRate;
    this.capacity = Math.floor(sampleRate * durationMs / 1000);
    this.buf = new Int16Array(this.capacity);
    this.writeIdx = 0;       // next write position
    this.filled = 0;         // number of valid samples (≤ capacity)
    this.listeners = [];
  }

  write(int16) {
    const n = int16.length;
    const cap = this.capacity;
    let src = 0;
    let dst = this.writeIdx;
    while (src < n) {
      const room = cap - dst;
      const take = Math.min(room, n - src);
      this.buf.set(int16.subarray(src, src + take), dst);
      src += take;
      dst = (dst + take) % cap;
    }
    this.writeIdx = dst;
    this.filled = Math.min(cap, this.filled + n);
    for (const l of this.listeners) l(this);
  }

  /** Return a linearized copy of the entire buffer (oldest → newest). */
  snapshot() {
    if (this.filled < this.capacity) {
      return this.buf.slice(0, this.filled);
    }
    const out = new Int16Array(this.capacity);
    const head = this.writeIdx;
    const tail = this.capacity - head;
    out.set(this.buf.subarray(head, head + tail), 0);
    out.set(this.buf.subarray(0, head), tail);
    return out;
  }

  reset() {
    this.writeIdx = 0;
    this.filled = 0;
    for (const l of this.listeners) l(this);
  }

  fillRatio() { return this.filled / this.capacity; }

  /** Position of the most-recently-written sample in [0,1]. */
  headRatio() {
    if (this.filled < this.capacity) return this.filled / this.capacity;
    return this.writeIdx / this.capacity;
  }

  /** Convert Int16Array → Uint8Array little-endian byte view (zero-copy). */
  asBytes() {
    const snap = this.snapshot();
    return new Uint8Array(snap.buffer, snap.byteOffset, snap.byteLength);
  }

  onUpdate(cb) { this.listeners.push(cb); }
}

// Tiny canvas visualizer: draws the ring buffer as a filled bar with
// a head marker that moves left-to-right and wraps.
export function attachRingViz(canvas, ring, color) {
  const ctx = canvas.getContext("2d");
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const fillW = cssW * ring.fillRatio();
    ctx.fillStyle = color + "30";  // hex + alpha
    ctx.fillRect(0, 0, fillW, cssH);

    // tick marks every 5s
    const ticks = Math.floor((ring.capacity / ring.sampleRate));
    ctx.fillStyle = color + "55";
    for (let s = 5; s < ticks; s += 5) {
      const x = (s / ticks) * cssW;
      ctx.fillRect(x, 0, 1, cssH);
    }

    // head marker
    const headX = ring.headRatio() * cssW;
    ctx.fillStyle = color;
    ctx.fillRect(Math.max(0, headX - 1), 0, 2, cssH);
  };
  ring.onUpdate(draw);
  // Initial paint + on resize
  draw();
  window.addEventListener("resize", draw);
  return draw;
}

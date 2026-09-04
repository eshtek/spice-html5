/* A pipe with latency, jitter and a bit rate between the fake server and
   the client. Bytes leave in order, as they would over TCP: each write
   serialises after the previous one at the configured rate, then travels
   the latency plus a seeded jitter, and never overtakes an earlier write.
   The clock and timers are injectable so the unit test can drive it by
   hand; the server uses the real ones. */

export interface ShapeConfig {
  /* One-way delay added to every write. */
  latencyMs?: number;
  /* Uniform random extra delay in [0, jitterMs), seeded so a run repeats. */
  jitterMs?: number;
  /* Link rate; a write of n bytes takes n * 8 / kbps milliseconds to leave. */
  kbps?: number;
  seed?: number;
}

export interface Timers<T = unknown> {
  set(fn: () => void, ms: number): T;
  clear(t: T): void;
}

const REAL_TIMERS: Timers<ReturnType<typeof setTimeout>> = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t),
};

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Item {
  bytes: Uint8Array;
  at: number;
}

export class Shaper<T = unknown> {
  private queue: Item[] = [];
  private timer: T | null = null;
  /* When the last byte handed in finishes leaving the sender. */
  private lineFreeAt = 0;
  /* Delivery time of the last item, the floor for the next. */
  private lastDeliverAt = 0;
  private rnd: () => number;
  pendingBytes = 0;
  delivered = 0;

  constructor(
    private readonly cfg: ShapeConfig,
    private readonly deliver: (bytes: Uint8Array) => void,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers<T> = REAL_TIMERS as unknown as Timers<T>,
  ) {
    this.rnd = seeded(cfg.seed ?? 1);
  }

  push(bytes: Uint8Array) {
    const now = this.now();
    const start = Math.max(now, this.lineFreeAt);
    const serialise = this.cfg.kbps ? (bytes.length * 8) / this.cfg.kbps : 0;
    this.lineFreeAt = start + serialise;
    const jitter = this.cfg.jitterMs ? this.rnd() * this.cfg.jitterMs : 0;
    const at = Math.max(this.lineFreeAt + (this.cfg.latencyMs ?? 0) + jitter, this.lastDeliverAt);
    this.lastDeliverAt = at;
    this.queue.push({ bytes, at });
    this.pendingBytes += bytes.length;
    this.schedule();
  }

  /* Everything due by now, in order; then wait for the next. */
  flush() {
    const now = this.now();
    while (this.queue.length > 0 && this.queue[0].at <= now) {
      const item = this.queue.shift()!;
      this.pendingBytes -= item.bytes.length;
      this.delivered++;
      this.deliver(item.bytes);
    }
    this.schedule();
  }

  /* Whether the sender still has bytes to put on the wire.  Bytes in
     flight across the latency do not count: a sender paced by this,
     like one paced by TCP's window, keeps the line full rather than
     waiting for each write to arrive. */
  lineBusy(): boolean {
    return this.lineFreeAt > this.now();
  }

  clear() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.queue = [];
    this.pendingBytes = 0;
  }

  private schedule() {
    if (this.timer !== null || this.queue.length === 0) return;
    const wait = Math.max(0, this.queue[0].at - this.now());
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }
}

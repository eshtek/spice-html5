/* The shaper under a hand-driven clock: serialisation at the link rate,
   latency on top, seeded jitter that never reorders, and a clear that
   drops what has not left. */
import { describe, expect, test } from "bun:test";
import { Shaper, type Timers } from "../server/shape.ts";

/* A clock and a single pending timer the test advances by hand. */
function harness(cfg: ConstructorParameters<typeof Shaper>[0]) {
  let now = 1000;
  let pending: { fn: () => void; at: number } | null = null;
  const timers: Timers<number> = {
    set(fn, ms) {
      pending = { fn, at: now + ms };
      return 1;
    },
    clear() {
      pending = null;
    },
  };
  const out: Array<{ bytes: number; at: number }> = [];
  const shaper = new Shaper<number>(cfg, (b) => out.push({ bytes: b.length, at: now }), () => now, timers);
  const advance = (ms: number) => {
    const target = now + ms;
    while (pending && pending.at <= target) {
      now = pending.at;
      const p = pending;
      pending = null;
      p.fn();
    }
    now = target;
  };
  return { shaper, out, advance, nowFn: () => now, nextAt: () => pending?.at ?? null };
}

const bytes = (n: number) => new Uint8Array(n);

describe("shaper", () => {
  test("latency alone delays every write by the same amount, in order", () => {
    const h = harness({ latencyMs: 50 });
    h.shaper.push(bytes(10));
    h.shaper.push(bytes(20));
    expect(h.out).toHaveLength(0);
    h.advance(49);
    expect(h.out).toHaveLength(0);
    h.advance(1);
    expect(h.out.map((o) => o.bytes)).toEqual([10, 20]);
    expect(h.out.every((o) => o.at === 1050)).toBe(true);
    expect(h.shaper.pendingBytes).toBe(0);
  });

  test("the link rate serialises writes back to back", () => {
    /* 1000 kbps = 125 bytes per ms: a 1250-byte write takes 10 ms. */
    const h = harness({ kbps: 1000 });
    h.shaper.push(bytes(1250));
    h.shaper.push(bytes(1250));
    h.shaper.push(bytes(1250));
    h.advance(10);
    expect(h.out.map((o) => o.at)).toEqual([1010]);
    h.advance(10);
    expect(h.out.map((o) => o.at)).toEqual([1010, 1020]);
    h.advance(10);
    expect(h.out.map((o) => o.at)).toEqual([1010, 1020, 1030]);
  });

  test("an idle line does not bank credit", () => {
    const h = harness({ kbps: 1000 });
    h.shaper.push(bytes(1250));
    h.advance(100);
    h.shaper.push(bytes(1250));
    h.advance(10);
    expect(h.out.map((o) => o.at)).toEqual([1010, 1110]);
  });

  test("latency and rate add, and jitter never reorders", () => {
    const h = harness({ latencyMs: 100, jitterMs: 30, kbps: 1000, seed: 7 });
    for (let i = 0; i < 20; i++) h.shaper.push(bytes(125));
    h.advance(1000);
    expect(h.out).toHaveLength(20);
    for (let i = 1; i < h.out.length; i++) expect(h.out[i].at).toBeGreaterThanOrEqual(h.out[i - 1].at);
    /* Each write serialises in 1 ms, so the earliest possible delivery of
       write i is 1000 + (i + 1) + 100 and the latest 30 ms after that. */
    for (let i = 0; i < h.out.length; i++) {
      expect(h.out[i].at).toBeGreaterThanOrEqual(1000 + i + 1 + 100);
      expect(h.out[i].at).toBeLessThan(1000 + i + 1 + 100 + 30 + 1);
    }
  });

  test("the same seed gives the same schedule", () => {
    const a = harness({ latencyMs: 20, jitterMs: 50, seed: 3 });
    const b = harness({ latencyMs: 20, jitterMs: 50, seed: 3 });
    for (let i = 0; i < 10; i++) {
      a.shaper.push(bytes(1));
      b.shaper.push(bytes(1));
    }
    a.advance(200);
    b.advance(200);
    expect(a.out.map((o) => o.at)).toEqual(b.out.map((o) => o.at));
  });

  test("the line is busy while serialising, not while bytes are in flight", () => {
    const h = harness({ latencyMs: 100, kbps: 1000 });
    h.shaper.push(bytes(1250));
    expect(h.shaper.lineBusy()).toBe(true);
    h.advance(10);
    expect(h.shaper.lineBusy()).toBe(false);
    expect(h.shaper.pendingBytes).toBe(1250);
    h.advance(100);
    expect(h.shaper.pendingBytes).toBe(0);
  });

  test("clear drops what has not left and stops the timer", () => {
    const h = harness({ latencyMs: 50 });
    h.shaper.push(bytes(10));
    h.shaper.push(bytes(10));
    expect(h.shaper.pendingBytes).toBe(20);
    h.shaper.clear();
    expect(h.shaper.pendingBytes).toBe(0);
    expect(h.nextAt()).toBeNull();
    h.advance(100);
    expect(h.out).toHaveLength(0);
  });
});

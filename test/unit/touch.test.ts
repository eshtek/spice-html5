/* The touch recogniser under a hand-driven clock: what each gesture turns
   into, and that nothing it presses is ever left held. */
import { describe, expect, test } from "bun:test";
import { TouchGestures, pointer_gain } from "../../src/touch.js";

const LEFT = 1;
const MIDDLE = 2;
const RIGHT = 3;

type Extra = { zoom?: boolean; panning?: () => boolean; trackpad?: boolean };

function harness(options?: Record<string, number>, extra: Extra = {}) {
  let now = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const timers = {
    set(fn: () => void, ms: number) {
      pending = { fn, at: now + ms };
      return 1;
    },
    clear() {
      pending = null;
    },
  };
  const out: Array<[string, ...unknown[]]> = [];
  const sink = {
    move: (x: number, y: number) => out.push(["move", x, y]),
    press: (b: number) => out.push(["press", b]),
    release: (b: number) => out.push(["release", b]),
    wheel: (up: boolean) => out.push(["wheel", up ? "up" : "down"]),
    pan: (dx: number, dy: number) => out.push(["pan", dx, dy]),
    ...(extra.trackpad ? { trackpad: () => true, nudge: (dx: number, dy: number) => out.push(["nudge", dx, dy]) } : {}),
    ...(extra.panning ? { panning: extra.panning } : {}),
    ...(extra.zoom ? { zoom: (ratio: number, cx: number, cy: number) => out.push(["zoom", Math.round(ratio * 1000) / 1000, cx, cy]) } : {}),
  };
  const g = new TouchGestures(sink, options, timers);
  const at = (t: number) => {
    if (pending && pending.at <= t) {
      now = pending.at;
      const p = pending;
      pending = null;
      p.fn();
    }
    now = t;
  };
  return {
    g,
    out,
    down: (id: number, x: number, y: number, t: number, cx?: number, cy?: number) => (at(t), g.down(id, x, y, t, cx, cy)),
    move: (id: number, x: number, y: number, t: number, cx?: number, cy?: number) => (at(t), g.move(id, x, y, t, cx, cy)),
    up: (id: number, x: number, y: number, t: number) => (at(t), g.up(id, x, y, t)),
    cancel: (id: number, t: number) => (at(t), g.cancel(id)),
    at,
  };
}

const held = (out: Array<[string, ...unknown[]]>) => {
  const down = new Set<unknown>();
  for (const [name, b] of out) {
    if (name === "press") down.add(b);
    if (name === "release") down.delete(b);
  }
  return [...down];
};

describe("one finger", () => {
  test("a tap is a left click where the finger landed", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.move(1, 53, 42, 40);
    h.up(1, 53, 42, 80);
    expect(h.out).toEqual([["move", 50, 40], ["press", LEFT], ["release", LEFT]]);
  });

  test("a second tap nearby lands exactly on the first", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.up(1, 50, 40, 60);
    h.down(2, 61, 33, 200);
    h.up(2, 61, 33, 260);
    expect(h.out.filter((a) => a[0] === "move")).toEqual([["move", 50, 40], ["move", 50, 40]]);
  });

  test("a second tap far away or late is its own click", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.up(1, 50, 40, 60);
    h.down(2, 150, 40, 200);
    h.up(2, 150, 40, 260);
    h.down(3, 150, 40, 2000);
    h.up(3, 150, 40, 2060);
    expect(h.out.filter((a) => a[0] === "move")).toEqual([["move", 50, 40], ["move", 150, 40], ["move", 150, 40]]);
    expect(h.out.filter((a) => a[0] === "press").length).toBe(3);
  });

  test("a third tap starts over rather than chaining onto the pair", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.up(1, 50, 40, 50);
    h.down(2, 55, 44, 150);
    h.up(2, 55, 44, 200);
    h.down(3, 58, 47, 300);
    h.up(3, 58, 47, 350);
    expect(h.out.filter((a) => a[0] === "move")).toEqual([["move", 50, 40], ["move", 50, 40], ["move", 58, 47]]);
  });

  test("a long press is a right click, and lifting adds nothing", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.at(600);
    expect(h.out).toEqual([["move", 50, 40], ["press", RIGHT], ["release", RIGHT]]);
    h.move(1, 90, 90, 700);
    h.up(1, 90, 90, 800);
    expect(h.out.length).toBe(3);
  });

  test("a moving finger drags with the left button from where it landed", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.move(1, 56, 40, 20);
    h.move(1, 70, 40, 40);
    h.move(1, 90, 45, 60);
    h.up(1, 95, 50, 80);
    expect(h.out).toEqual([["move", 50, 40], ["press", LEFT], ["move", 70, 40], ["move", 90, 45], ["move", 95, 50], ["release", LEFT]]);
  });

  test("a drag that outlasts the long press stays a drag", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.move(1, 80, 40, 100);
    h.at(900);
    h.up(1, 80, 40, 1000);
    expect(h.out.filter((a) => a[0] === "press")).toEqual([["press", LEFT]]);
    expect(held(h.out)).toEqual([]);
  });

  test("the slop is measured in page pixels, so a small screen forgives the same wobble", () => {
    const h = harness();
    /* A screen drawn at a third: 8 page pixels of wobble are 24 of the guest's. */
    h.down(1, 300, 300, 0, 100, 100);
    h.move(1, 324, 300, 30, 108, 100);
    h.up(1, 324, 300, 60);
    expect(h.out).toEqual([["move", 300, 300], ["press", LEFT], ["release", LEFT]]);
  });

  test("a double tap is judged where the fingers fell on the page, and sent where the first fell on the guest", () => {
    const h = harness();
    h.down(1, 300, 300, 0, 100, 100);
    h.up(1, 300, 300, 50);
    h.down(2, 345, 330, 150, 115, 110);
    h.up(2, 345, 330, 200);
    expect(h.out.filter((a) => a[0] === "move")).toEqual([["move", 300, 300], ["move", 300, 300]]);
  });
});

describe("more fingers", () => {
  test("two fingers moving turn the wheel, content following the fingers", () => {
    const h = harness();
    h.down(1, 100, 100, 0);
    h.down(2, 140, 100, 10);
    h.move(1, 100, 150, 30);
    h.move(2, 140, 150, 40);
    expect(h.out).toEqual([["wheel", "up"], ["wheel", "up"]]);
    h.move(1, 100, 50, 60);
    h.move(2, 140, 50, 70);
    expect(h.out.slice(2)).toEqual([["wheel", "down"], ["wheel", "down"], ["wheel", "down"], ["wheel", "down"]]);
    h.up(1, 100, 50, 80);
    h.up(2, 140, 50, 90);
    expect(h.out.some((a) => a[0] === "press")).toBe(false);
  });

  test("a two finger tap is a right click where the first finger landed", () => {
    const h = harness();
    h.down(1, 100, 100, 0);
    h.down(2, 140, 100, 20);
    h.up(2, 140, 100, 90);
    h.up(1, 100, 100, 100);
    expect(h.out).toEqual([["move", 100, 100], ["press", RIGHT], ["release", RIGHT]]);
  });

  test("a three finger tap is a middle click", () => {
    const h = harness();
    h.down(1, 100, 100, 0);
    h.down(2, 140, 100, 10);
    h.down(3, 180, 100, 20);
    h.up(1, 100, 100, 90);
    h.up(2, 140, 100, 95);
    h.up(3, 180, 100, 100);
    expect(h.out).toEqual([["move", 100, 100], ["press", MIDDLE], ["release", MIDDLE]]);
  });

  test("two fingers resting are not a tap", () => {
    const h = harness();
    h.down(1, 100, 100, 0);
    h.down(2, 140, 100, 20);
    h.up(2, 140, 100, 900);
    h.up(1, 100, 100, 910);
    expect(h.out).toEqual([]);
  });

  test("a second finger landing mid-drag lets the button go first", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.move(1, 90, 40, 30);
    h.down(2, 140, 40, 60);
    expect(held(h.out)).toEqual([]);
    h.move(1, 90, 100, 90);
    h.move(2, 140, 100, 100);
    h.up(1, 90, 100, 120);
    h.up(2, 140, 100, 130);
    expect(h.out.filter((a) => a[0] === "press").length).toBe(1);
    expect(h.out.some((a) => a[0] === "wheel")).toBe(true);
  });
});

describe("a touch the browser takes away", () => {
  test("mid-drag, the button is released and no click follows", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.move(1, 90, 40, 30);
    h.cancel(1, 60);
    expect(held(h.out)).toEqual([]);
    const n = h.out.length;
    h.down(2, 10, 10, 500);
    h.up(2, 10, 10, 550);
    expect(h.out.slice(n)).toEqual([["move", 10, 10], ["press", LEFT], ["release", LEFT]]);
  });

  test("before it moved, nothing is sent and the long press never fires", () => {
    const h = harness();
    h.down(1, 50, 40, 0);
    h.cancel(1, 100);
    h.at(2000);
    expect(h.out).toEqual([]);
  });
});

describe("a page that zooms", () => {
  test("two fingers parting are a pinch about their centre, and turn no wheel", () => {
    const h = harness(undefined, { zoom: true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 80, 100, 30);
    h.move(2, 220, 100, 40);
    h.move(1, 50, 100, 60);
    h.move(2, 250, 100, 70);
    h.up(1, 50, 100, 90);
    h.up(2, 250, 100, 100);
    const zooms = h.out.filter((a) => a[0] === "zoom");
    expect(zooms.length).toBeGreaterThanOrEqual(3);
    /* 100 apart to 200 apart, whatever the steps between. */
    expect(zooms.reduce((z, a) => z * (a[1] as number), 1)).toBeCloseTo(2, 1);
    expect(zooms[0].slice(2)).toEqual([150, 100]);
    /* Each finger moved as far as the other, so the slides cancel out. */
    expect(h.out.filter((a) => a[0] === "pan").reduce((sum, a) => sum + (a[1] as number), 0)).toBe(0);
  });

  test("a pinch that drifts zooms about where the centre was and then slides to where it is", () => {
    const h = harness(undefined, { zoom: true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    /* One finger alone: the centre goes from 150 to 130 as the spread grows. */
    h.move(1, 60, 100, 30);
    expect(h.out).toEqual([["zoom", 1.4, 150, 100], ["pan", -20, 0]]);
    expect(h.out.some((a) => a[0] === "wheel" || a[0] === "press")).toBe(false);
  });

  test("two fingers keeping their distance still scroll", () => {
    const h = harness(undefined, { zoom: true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 100, 130, 30);
    h.move(2, 200, 130, 40);
    h.move(1, 100, 160, 60);
    h.move(2, 200, 160, 70);
    expect(h.out.some((a) => a[0] === "zoom")).toBe(false);
    expect(h.out.filter((a) => a[0] === "wheel")).toEqual([["wheel", "up"], ["wheel", "up"]]);
  });

  test("a gesture is one or the other to the end: a scroll that wanders does not start zooming", () => {
    const h = harness(undefined, { zoom: true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 100, 130, 30);
    h.move(2, 200, 130, 40);
    h.move(2, 260, 160, 60);
    expect(h.out.some((a) => a[0] === "zoom")).toBe(false);
  });

  test("while the view is zoomed, two fingers slide it instead of scrolling the guest", () => {
    const h = harness(undefined, { zoom: true, panning: () => true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 100, 130, 30);
    h.move(2, 200, 130, 40);
    h.move(1, 130, 130, 50);
    h.move(2, 230, 130, 60);
    expect(h.out.some((a) => a[0] === "wheel")).toBe(false);
    const pans = h.out.filter((a) => a[0] === "pan");
    expect(pans.reduce((sum, a) => sum + (a[1] as number), 0)).toBe(30);
    expect(pans.reduce((sum, a) => sum + (a[2] as number), 0)).toBe(30);
  });

  test("a finger lifting mid-pinch does not read as the fingers snapping together", () => {
    const h = harness(undefined, { zoom: true });
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 60, 100, 30);
    h.move(2, 240, 100, 40);
    const n = h.out.length;
    h.up(2, 240, 100, 60);
    h.move(1, 90, 100, 80);
    h.up(1, 90, 100, 100);
    expect(h.out.slice(n)).toEqual([]);
  });

  test("without a page to zoom, parting fingers are just two fingers", () => {
    const h = harness();
    h.down(1, 100, 100, 0);
    h.down(2, 200, 100, 10);
    h.move(1, 60, 100, 30);
    h.move(2, 240, 100, 40);
    expect(h.out).toEqual([]);
  });
});

describe("trackpad mode", () => {
  const pad = () => harness(undefined, { trackpad: true });

  test("a moving finger moves the pointer by its own travel and presses nothing", () => {
    const h = pad();
    h.down(1, 300, 300, 0, 100, 100);
    h.move(1, 300, 300, 20, 112, 100);
    h.move(1, 300, 300, 40, 120, 106);
    h.up(1, 300, 300, 60);
    expect(h.out).toEqual([["nudge", 12, 0], ["nudge", 8, 6]]);
  });

  test("the travel that proved a touch a move is not replayed as one jump", () => {
    const h = pad();
    h.down(1, 0, 0, 0, 100, 100);
    h.move(1, 0, 0, 10, 104, 100);
    h.move(1, 0, 0, 20, 108, 100);
    h.move(1, 0, 0, 30, 112, 100);
    expect(h.out).toEqual([["nudge", 4, 0]]);
  });

  test("a tap clicks where the pointer stands, not where the finger fell", () => {
    const h = pad();
    h.down(1, 300, 300, 0);
    h.up(1, 300, 300, 50);
    expect(h.out).toEqual([["press", LEFT], ["release", LEFT]]);
  });

  test("two taps are two clicks on the same spot, as a double click needs", () => {
    const h = pad();
    h.down(1, 10, 10, 0);
    h.up(1, 10, 10, 50);
    h.down(2, 200, 200, 150);
    h.up(2, 200, 200, 200);
    expect(h.out).toEqual([["press", LEFT], ["release", LEFT], ["press", LEFT], ["release", LEFT]]);
  });

  test("a finger that moves right after a tap drags", () => {
    const h = pad();
    h.down(1, 0, 0, 0, 100, 100);
    h.up(1, 0, 0, 50);
    h.down(2, 0, 0, 150, 100, 100);
    h.move(2, 0, 0, 170, 120, 100);
    h.move(2, 0, 0, 190, 140, 110);
    h.up(2, 0, 0, 210);
    expect(h.out.slice(2)).toEqual([["press", LEFT], ["nudge", 20, 0], ["nudge", 20, 10], ["release", LEFT]]);
  });

  test("a finger that moves long after a tap only points", () => {
    const h = pad();
    h.down(1, 0, 0, 0, 100, 100);
    h.up(1, 0, 0, 50);
    h.down(2, 0, 0, 900, 100, 100);
    h.move(2, 0, 0, 920, 120, 100);
    h.up(2, 0, 0, 940);
    expect(h.out.slice(2)).toEqual([["nudge", 20, 0]]);
  });

  test("a long press and a two finger tap right-click where the pointer stands", () => {
    const h = pad();
    h.down(1, 50, 50, 0);
    h.at(600);
    h.up(1, 50, 50, 700);
    h.down(2, 100, 100, 1000);
    h.down(3, 140, 100, 1010);
    h.up(2, 100, 100, 1080);
    h.up(3, 140, 100, 1090);
    expect(h.out).toEqual([["press", RIGHT], ["release", RIGHT], ["press", RIGHT], ["release", RIGHT]]);
  });

  test("two fingers still scroll", () => {
    const h = pad();
    h.down(1, 100, 100, 0);
    h.down(2, 140, 100, 10);
    h.move(1, 100, 150, 30);
    h.move(2, 140, 150, 40);
    expect(h.out).toEqual([["wheel", "up"], ["wheel", "up"]]);
  });

  test("a second finger landing mid-drag lets the button go", () => {
    const h = pad();
    h.down(1, 0, 0, 0, 100, 100);
    h.up(1, 0, 0, 50);
    h.down(2, 0, 0, 150, 100, 100);
    h.move(2, 0, 0, 170, 130, 100);
    h.down(3, 0, 0, 190, 200, 100);
    expect(held(h.out)).toEqual([]);
  });

  test("the pointer keeps pace with a slow finger and runs ahead of a fast one", () => {
    expect(pointer_gain(1)).toBe(1);
    expect(pointer_gain(4)).toBe(1);
    expect(pointer_gain(10)).toBeGreaterThan(1.5);
    expect(pointer_gain(200)).toBe(2.5);
  });
});

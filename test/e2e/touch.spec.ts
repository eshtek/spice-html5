/* Real touch events through the browser: CDP's Input.dispatchTouchEvent is
   the only way to hold a finger down and move it, so this runs on Chromium. */
import type { CDPSession } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ hasTouch: true });
test.skip(({ browserName }) => browserName !== "chromium", "multi-touch is driven over CDP");

type Point = { x: number; y: number; id?: number };

let cdp: CDPSession;
let origin: { x: number; y: number };

const touch = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: Point[]) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, i) => ({ x: origin.x + p.x, y: origin.y + p.y, id: p.id ?? i })),
  });

const mouse = (events: Array<{ name: string; fields: Record<string, unknown> }>) =>
  events.filter((e) => /^mouse_(press|release)$/.test(e.name)).map((e) => [e.name, e.fields.button, e.fields.buttonsState]);

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await expect(client.surface()).toBeVisible();
  const bb = (await client.surface().boundingBox())!;
  origin = { x: bb.x, y: bb.y };
  cdp = await client.page.context().newCDPSession(client.page);
});

test("a tap clicks once: the browser's made-up mouse events are suppressed", async ({ client, spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 50, y: 40 }]);
  await touch("touchEnd", []);
  await spice.waitFor("inputs", "mouse_release");
  await client.page.waitForTimeout(400);
  const events = await spice.inbound("inputs", "*", before);
  expect(mouse(events)).toEqual([
    ["mouse_press", 1, 1],
    ["mouse_release", 1, 0],
  ]);
  const pos = events.find((e) => e.name === "mouse_position")!.fields as { x: number; y: number };
  expect(Math.abs(pos.x - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(pos.y - 40)).toBeLessThanOrEqual(1);
});

test("a moving finger holds the left button from where it landed to where it lifted", async ({ client, spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 50, y: 40 }]);
  for (const x of [60, 80, 100, 120]) {
    await touch("touchMove", [{ x, y: 60 }]);
    await client.page.waitForTimeout(30);
  }
  await touch("touchEnd", []);
  await spice.waitFor("inputs", "mouse_release");
  const events = (await spice.inbound("inputs", "*", before)).filter((e) => e.name.startsWith("mouse_"));
  expect(mouse(events)).toEqual([
    ["mouse_press", 1, 1],
    ["mouse_release", 1, 0],
  ]);
  const press = events.findIndex((e) => e.name === "mouse_press");
  const release = events.findIndex((e) => e.name === "mouse_release");
  const first = events[press - 1].fields as { x: number; y: number };
  const last = events[release - 1].fields as { x: number; y: number; buttonsState: number };
  expect(Math.abs(first.x - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(last.x - 120)).toBeLessThanOrEqual(1);
  expect(Math.abs(last.y - 60)).toBeLessThanOrEqual(1);
  expect(last.buttonsState).toBe(1);
});

test("a long press is a right click", async ({ spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 50, y: 40 }]);
  await spice.waitFor("inputs", "mouse_release");
  await touch("touchEnd", []);
  expect(mouse(await spice.inbound("inputs", "*", before))).toEqual([
    ["mouse_press", 3, 4],
    ["mouse_release", 3, 0],
  ]);
});

test("two fingers moving turn the wheel and press nothing else", async ({ client, spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 100, y: 100, id: 0 }]);
  await touch("touchStart", [
    { x: 100, y: 100, id: 0 },
    { x: 150, y: 100, id: 1 },
  ]);
  for (const y of [120, 140, 160]) {
    await touch("touchMove", [
      { x: 100, y, id: 0 },
      { x: 150, y, id: 1 },
    ]);
    await client.page.waitForTimeout(30);
  }
  await touch("touchEnd", []);
  await client.page.waitForTimeout(200);
  const buttons = mouse(await spice.inbound("inputs", "*", before)).map((e) => e[1]);
  expect(buttons.length).toBeGreaterThanOrEqual(4);
  expect(new Set(buttons)).toEqual(new Set([4]));
});

test("a two finger tap is a right click", async ({ spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 100, y: 100, id: 0 }]);
  await touch("touchStart", [
    { x: 100, y: 100, id: 0 },
    { x: 150, y: 100, id: 1 },
  ]);
  await touch("touchEnd", []);
  await spice.waitFor("inputs", "mouse_release");
  expect(mouse(await spice.inbound("inputs", "*", before))).toEqual([
    ["mouse_press", 3, 4],
    ["mouse_release", 3, 0],
  ]);
});

test("a cancelled drag lets the button go", async ({ client, spice }) => {
  const before = await spice.mark();
  await touch("touchStart", [{ x: 50, y: 40 }]);
  await touch("touchMove", [{ x: 90, y: 40 }]);
  await spice.waitFor("inputs", "mouse_press");
  await touch("touchCancel", []);
  await spice.waitFor("inputs", "mouse_release");
  await client.page.waitForTimeout(100);
  expect(mouse(await spice.inbound("inputs", "*", before))).toEqual([
    ["mouse_press", 1, 1],
    ["mouse_release", 1, 0],
  ]);
});

test("a tap focuses the screen unless the page keeps focus for a field of its own", async ({ client }) => {
  const active = () => client.page.evaluate(() => document.activeElement?.id);
  await client.page.evaluate(() => {
    const field = document.createElement("textarea");
    field.id = "page-field";
    document.body.appendChild(field);
    field.focus();
  });
  await client.page.evaluate(() => ((window as unknown as { harness: { sc: { touch_focus?: boolean } } }).harness.sc.touch_focus = false));
  await touch("touchStart", [{ x: 30, y: 30 }]);
  await touch("touchEnd", []);
  await client.page.waitForTimeout(200);
  expect(await active()).toBe("page-field");

  await client.page.evaluate(() => ((window as unknown as { harness: { sc: { touch_focus?: boolean } } }).harness.sc.touch_focus = true));
  await touch("touchStart", [{ x: 30, y: 30 }]);
  await touch("touchEnd", []);
  await expect.poll(active).toBe("spice_surface_0");
});

test("positions stay in guest pixels under a CSS scale", async ({ client, spice }) => {
  await client.page.evaluate(() => {
    const screen = document.getElementById("spice-area") ?? document.querySelector("canvas")!.parentElement!;
    (screen as HTMLElement).style.transformOrigin = "0 0";
    (screen as HTMLElement).style.transform = "scale(0.5)";
  });
  const bb = (await client.surface().boundingBox())!;
  origin = { x: bb.x, y: bb.y };
  /* Half of 320 and the themed border. */
  expect(Math.abs(bb.width - 160)).toBeLessThanOrEqual(2);
  const before = await spice.mark();
  await touch("touchStart", [{ x: 100, y: 80 }]);
  await touch("touchEnd", []);
  await spice.waitFor("inputs", "mouse_release");
  const pos = (await spice.inbound("inputs", "mouse_position", before))[0].fields as { x: number; y: number };
  expect(Math.abs(pos.x - 200)).toBeLessThanOrEqual(2);
  expect(Math.abs(pos.y - 160)).toBeLessThanOrEqual(2);
});

test("a pinch is reported to a page that asked, and the guest hears none of it", async ({ client, spice }) => {
  await client.page.evaluate(() => {
    const w = window as unknown as { harness: { sc: Record<string, unknown> }; zooms: number[] };
    w.zooms = [];
    w.harness.sc.ontouchzoom = (ratio: number) => w.zooms.push(ratio);
  });
  /* The hook read the option when the surface appeared; a fresh surface reads it again. */
  await spice.send("display", "surfaceDestroy", {});
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await expect(client.surface()).toBeVisible();
  const bb = (await client.surface().boundingBox())!;
  origin = { x: bb.x, y: bb.y };

  const before = await spice.mark();
  await touch("touchStart", [{ x: 140, y: 100, id: 0 }]);
  await touch("touchStart", [
    { x: 140, y: 100, id: 0 },
    { x: 180, y: 100, id: 1 },
  ]);
  for (const d of [30, 45, 60]) {
    await touch("touchMove", [
      { x: 160 - d, y: 100, id: 0 },
      { x: 160 + d, y: 100, id: 1 },
    ]);
    await client.page.waitForTimeout(30);
  }
  await touch("touchEnd", []);
  await client.page.waitForTimeout(200);
  const zooms = await client.page.evaluate(() => (window as unknown as { zooms: number[] }).zooms);
  expect(zooms.reduce((z, r) => z * r, 1)).toBeCloseTo(3, 0);
  expect((await spice.inbound("inputs", "*", before)).filter((e) => e.name.startsWith("mouse_"))).toEqual([]);
});

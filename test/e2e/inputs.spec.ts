import { box, expect, test } from "./fixtures";

const codes = (records: Array<{ name: string; fields: Record<string, unknown> }>) => records.map((r) => [r.name, r.fields.code]);

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await expect(client.surface()).toBeVisible();
});

test("a key press sends make and break scancodes", async ({ client, spice }) => {
  await client.surface().click({ position: { x: 10, y: 10 } });
  const before = await spice.mark();
  await client.page.keyboard.press("a");
  await spice.waitFor("inputs", "key_up");
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x1e],
    ["key_up", 0x9e],
  ]);
});

test("Num Lock is the plain scancode a guest toggles on, not the E0-prefixed one", async ({ client, spice }) => {
  await client.surface().click({ position: { x: 10, y: 10 } });
  const before = await spice.mark();
  await client.page.keyboard.press("NumLock");
  await spice.waitFor("inputs", "key_up");
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x45],
    ["key_up", 0xc5],
  ]);
});

test("F13 and up use the scancodes QEMU reads as those keys", async ({ client, spice }) => {
  await client.surface().click({ position: { x: 10, y: 10 } });
  const before = await spice.mark();
  /* Playwright's keyboard has no F13. */
  await client.pressWithLocks("F13", 124, {});
  await client.pressWithLocks("F17", 128, {});
  await spice.waitFor("inputs", "key_up", 2);
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x5d],
    ["key_up", 0xdd],
    ["key_down", 0x03e0],
    ["key_up", 0x83e0],
  ]);
});

test("Meta uses the real extended scancode with the break bit in the high byte", async ({ client, spice }) => {
  await client.surface().click({ position: { x: 10, y: 10 } });
  const before = await spice.mark();
  await client.page.keyboard.press("Meta");
  await spice.waitFor("inputs", "key_up");
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x5be0],
    ["key_up", 0xdbe0],
  ]);
});

test("sendCtrlAltDel presses and releases the whole chord", async ({ client, spice }) => {
  const before = await spice.mark();
  await client.sendCtrlAltDel();
  await spice.waitFor("inputs", "key_up", 3);
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x1d],
    ["key_down", 0x38],
    ["key_down", 0x53],
    ["key_up", 0xd3],
    ["key_up", 0x9d],
    ["key_up", 0xb8],
  ]);
});

test("typeText holds each key and wraps shifted characters", async ({ client, spice }) => {
  const before = await spice.mark();
  const result = await client.typeText("Hi!", 20);
  expect(result).toEqual({ typed: 3, skipped: [], aborted: false });
  const keys = (await spice.inbound("inputs", "*", before)).filter((r) => r.name.startsWith("key_"));
  expect(codes(keys)).toEqual([
    ["key_down", 0x2a],
    ["key_down", 0x23],
    ["key_up", 0xa3],
    ["key_up", 0xaa],
    ["key_down", 0x17],
    ["key_up", 0x97],
    ["key_down", 0x2a],
    ["key_down", 0x02],
    ["key_up", 0x82],
    ["key_up", 0xaa],
  ]);
  const hDown = keys[1].t;
  const hUp = keys[2].t;
  expect(hUp - hDown).toBeGreaterThanOrEqual(8);
});

test("typeText aborts when the inputs channel dies mid-string", async ({ client, spice }) => {
  const text = "x".repeat(200);
  const typing = client.typeText(text, 20) as Promise<{ typed: number; aborted: boolean }>;
  await spice.waitFor("inputs", "key_up", 3);
  await spice.run({ cmd: "close", channel: "inputs" });
  const result = await typing;
  expect(result.aborted).toBe(true);
  expect(result.typed).toBeLessThan(text.length);
});

test("typeText reports characters with no US-layout key", async ({ client }) => {
  const result = (await client.typeText("aé", 5)) as { typed: number; skipped: string[] };
  expect(result.typed).toBe(1);
  expect(result.skipped).toEqual(["é"]);
});

test("client mouse mode sends absolute positions and button events", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 50, bb.y + 40);
  await client.page.mouse.down();
  await client.page.mouse.up();
  await spice.waitFor("inputs", "mouse_release");
  const events = await spice.inbound("inputs", "*", before);
  const pos = events.find((e) => e.name === "mouse_position")?.fields as { x: number; y: number };
  /* offsetX/Y are measured from the padding edge, so a themed border shifts them by a pixel. */
  expect(Math.abs(pos.x - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(pos.y - 40)).toBeLessThanOrEqual(1);
  expect(events.find((e) => e.name === "mouse_press")?.fields).toMatchObject({ button: 1, buttonsState: 1 });
  expect(events.find((e) => e.name === "mouse_release")?.fields).toMatchObject({ button: 1, buttonsState: 0 });
});

test("wheel sends button 4/5 press and release pairs", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 20, bb.y + 20);
  const before = await spice.mark();
  await client.page.mouse.wheel(0, 120);
  await spice.waitFor("inputs", "mouse_release");
  const buttons = (await spice.inbound("inputs", "*", before)).filter((e) => /mouse_(press|release)/.test(e.name)).map((e) => [e.name, e.fields.button]);
  expect(buttons).toEqual([
    ["mouse_press", 5],
    ["mouse_release", 5],
  ]);
});

test("motion is throttled until the server acknowledges", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 10, bb.y + 10);
  await client.page.mouse.move(bb.x + 200, bb.y + 200, { steps: 40 });
  await client.page.waitForTimeout(200);
  const sent = (await spice.inbound("inputs", "mouse_position", before)).length;
  expect(sent).toBeLessThanOrEqual(8);
  await spice.send("inputs", "mouseMotionAck");
  await spice.send("inputs", "mouseMotionAck");
  await client.page.mouse.move(bb.x + 20, bb.y + 20, { steps: 4 });
  await expect.poll(async () => (await spice.inbound("inputs", "mouse_position", before)).length).toBeGreaterThan(sent);
});

test("server mouse mode sends relative motion", async ({ client, spice }) => {
  await client.disconnect();
  await spice.reset({ mouseModes: { supported: 1, current: 1 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 100, bb.y + 100);
  await spice.waitFor("inputs", "mouse_motion");
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 110, bb.y + 95);
  await expect.poll(async () => (await spice.inbound("inputs", "mouse_motion", before)).map((m) => [m.fields.x, m.fields.y])).toEqual([[10, -5]]);
});

test("server mouse mode measures motion from where the server last put the pointer", async ({ client, spice }) => {
  await client.disconnect();
  await spice.reset({ mouseModes: { supported: 1, current: 1 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 100, bb.y + 100);
  await spice.waitFor("inputs", "mouse_motion");
  /* The guest warps its pointer to (40, 60); the next motion is relative to that. */
  await spice.send("cursor", "cursorMove", { x: 40, y: 60 });
  await client.page.waitForTimeout(100);
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 110, bb.y + 95);
  /* The canvas sits at a fractional page offset, so allow a pixel. */
  await expect.poll(async () => (await spice.inbound("inputs", "mouse_motion", before)).length).toBe(1);
  const [m] = await spice.inbound("inputs", "mouse_motion", before);
  expect(Math.abs((m.fields.x as number) - 70)).toBeLessThanOrEqual(1);
  expect(Math.abs((m.fields.y as number) - 35)).toBeLessThanOrEqual(1);
});

test("server mouse mode under guest pointer acceleration keeps sending the mouse's own deltas", async ({ client, spice }) => {
  /* Open design question: motion is measured from where the guest last
     put its pointer, so a guest that accelerates (Windows' default)
     overshoots the browser pointer and the next delta swings back.
     spice-gtk sends the mouse's own deltas and lets the guest run ahead. */
  test.fail(true, "motion is anchored on the guest cursor, which oscillates under acceleration");
  await client.disconnect();
  await spice.reset({ mouseModes: { supported: 1, current: 1 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 100, bb.y + 100);
  await spice.waitFor("inputs", "mouse_motion");
  const guest = { x: 100, y: 100 };
  await spice.send("cursor", "cursorMove", guest);
  await client.page.waitForTimeout(100);
  const deltas: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const before = await spice.mark();
    await client.page.mouse.move(bb.x + 100 + 10 * i, bb.y + 100);
    await expect.poll(async () => (await spice.inbound("inputs", "mouse_motion", before)).length).toBe(1);
    const [m] = await spice.inbound("inputs", "mouse_motion", before);
    deltas.push(m.fields.x as number);
    /* The guest moves its pointer twice as far as told. */
    guest.x += 2 * (m.fields.x as number);
    await spice.send("cursor", "cursorMove", guest);
    await client.page.waitForTimeout(60);
  }
  for (const dx of deltas) expect(Math.abs(dx - 10)).toBeLessThanOrEqual(1);
});

test("a held button is carried in the motion that follows", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 50, bb.y + 50);
  await client.page.mouse.down();
  await spice.waitFor("inputs", "mouse_press");
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 60, bb.y + 60);
  await expect.poll(async () => (await spice.inbound("inputs", "mouse_position", before)).map((m) => m.fields.buttonsState)).toEqual([1]);
  await client.page.mouse.up();
  await spice.waitFor("inputs", "mouse_release");
  const after = await spice.mark();
  await client.page.mouse.move(bb.x + 70, bb.y + 70);
  await expect.poll(async () => (await spice.inbound("inputs", "mouse_position", after)).map((m) => m.fields.buttonsState)).toEqual([0]);
});

/* The canvas sits at a fractional page offset, so a position may land a pixel short. */
const near = (want: [number, number]) => (got: Array<[unknown, unknown]>) =>
  got.length === 1 && Math.abs((got[0][0] as number) - want[0]) <= 1 && Math.abs((got[0][1] as number) - want[1]) <= 1;
const lastPos = async (spice: { inbound: (c: string, n: string, s: number) => Promise<Array<{ fields: Record<string, unknown> }>> }, since: number) =>
  (await spice.inbound("inputs", "mouse_position", since)).slice(-1).map((m) => [m.fields.x, m.fields.y] as [unknown, unknown]);

test.describe("motion coalescing", () => {
  test("a burst sends at most one position per frame and ends on the final position", async ({ client, spice }) => {
    await client.disconnect();
    await spice.reset({ motionAck: true });
    await client.connectReady();
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    const bb = (await client.surface().boundingBox())!;
    await client.page.mouse.move(bb.x + 10, bb.y + 10);
    const before = await spice.mark();
    /* 200 events over 50 frames: at most a leading and a trailing send per frame. */
    await client.mouseStorm({ frames: 50, perFrame: 4, from: [10, 10], to: [210, 110] });
    await expect.poll(async () => near([210, 110])(await lastPos(spice, before))).toBe(true);
    await client.page.waitForTimeout(100);
    const sent = (await spice.inbound("inputs", "mouse_position", before)).length;
    expect(sent).toBeLessThanOrEqual(102);
    expect(sent).toBeGreaterThan(1);
  });

  test("the newest position waits for an ack instead of being dropped", async ({ client, spice }) => {
    const bb = (await client.surface().boundingBox())!;
    await client.page.mouse.move(bb.x + 10, bb.y + 10);
    const before = await spice.mark();
    /* No acks: the window of 8 fills within the burst. */
    await client.page.mouse.move(bb.x + 200, bb.y + 200, { steps: 40 });
    await client.page.waitForTimeout(150);
    const stalled = await spice.inbound("inputs", "mouse_position", before);
    expect(stalled.length).toBeLessThanOrEqual(8);
    expect(near([200, 200])(stalled.slice(-1).map((m) => [m.fields.x, m.fields.y] as [unknown, unknown]))).toBe(false);
    await spice.send("inputs", "mouseMotionAck");
    await expect.poll(async () => near([200, 200])(await lastPos(spice, before))).toBe(true);
    expect((await spice.inbound("inputs", "mouse_position", before)).length).toBe(stalled.length + 1);
  });

  test("coalesce_motion: false sends every event and drops the excess", async ({ client, spice }) => {
    await client.disconnect();
    await client.connectReady({ coalesce_motion: false });
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    const bb = (await client.surface().boundingBox())!;
    await client.page.mouse.move(bb.x + 10, bb.y + 10);
    const before = await spice.mark();
    await client.page.mouse.move(bb.x + 200, bb.y + 200, { steps: 40 });
    await client.page.waitForTimeout(150);
    const sent = await spice.inbound("inputs", "mouse_position", before);
    expect(sent.length).toBe(7);
    await spice.send("inputs", "mouseMotionAck");
    await client.page.waitForTimeout(150);
    expect((await spice.inbound("inputs", "mouse_position", before)).length).toBe(7);
  });

  test("a button event carries the position parked by the coalescer ahead of it", async ({ client, spice }) => {
    const bb = (await client.surface().boundingBox())!;
    await client.page.mouse.move(bb.x + 10, bb.y + 10);
    const before = await spice.mark();
    /* Two moves and a click in one task: the second move is parked for the
       frame, and the press must not overtake it. */
    await client.page.evaluate(() => {
      const c = document.querySelector("#spice-screen canvas") as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const at = (type: string, x: number, y: number) =>
        c.dispatchEvent(new MouseEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0 }));
      at("mousemove", 20, 20);
      at("mousemove", 100, 80);
      at("mousedown", 100, 80);
      at("mouseup", 100, 80);
    });
    await expect.poll(async () => (await spice.inbound("inputs", "mouse_release", before)).length).toBe(1);
    const seen = await spice.inbound("inputs", "*", before);
    const press = seen.findIndex((m) => m.name === "mouse_press");
    const positions = seen.slice(0, press).filter((m) => m.name === "mouse_position");
    expect(near([100, 80])(positions.slice(-1).map((m) => [m.fields.x, m.fields.y] as [unknown, unknown]))).toBe(true);
  });

  test("stopping the session cancels a pending flush", async ({ client, spice }) => {
    const bb = (await client.surface().boundingBox())!;
    await client.page.mouse.move(bb.x + 10, bb.y + 10);
    await client.page.mouse.move(bb.x + 200, bb.y + 200, { steps: 40 });
    await client.disconnect();
    await client.page.waitForTimeout(150);
    expect(await client.errors()).toEqual([]);
  });
});

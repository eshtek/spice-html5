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

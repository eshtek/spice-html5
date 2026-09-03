import { PALETTE, QUADRANT, box, expect, test } from "./fixtures";

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [32, 32, 32]);
});

test("MJPEG frames paint in order at the stream destination", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 0, frames: 5, fps: 20, width: 160, height: 120, dest: { left: 100, top: 100 } } });
  await client.expectPixel(140, 130, PALETTE[4], 24);
  await client.expectPixel(220, 130, QUADRANT.topRight, 24);
  await client.expectPixel(140, 190, QUADRANT.bottomLeft, 24);
  await client.expectPixel(220, 190, QUADRANT.bottomRight, 24);
  await client.expectPixelStays(50, 50, [32, 32, 32]);
});

test("sized frames paint at their own destination", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 1, frames: 2, fps: 30, width: 80, height: 60, dest: { left: 400, top: 300 }, sized: true } });
  await client.expectPixel(420, 315, PALETTE[1], 24);
  await client.expectPixel(460, 345, QUADRANT.bottomRight, 24);
});

test("a TOP_DOWN stream renders upright", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 0, frames: 2, fps: 30, width: 160, height: 120, dest: { left: 0, top: 0 }, flags: 1 } });
  await client.expectPixel(40, 30, PALETTE[1], 24);
  await client.expectPixel(40, 90, QUADRANT.bottomLeft, 24);
});

test("a bottom-up stream (TOP_DOWN clear) is flipped upright by the client", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 0, frames: 2, fps: 30, width: 160, height: 120, dest: { left: 0, top: 0 }, flags: 0, flip: true } });
  await client.expectPixel(40, 30, PALETTE[1], 24);
  await client.expectPixel(40, 90, QUADRANT.bottomLeft, 24);
});

test("stream reports are sent once the report window fills", async ({ client, spice }) => {
  await spice.send("display", "streamCreate", { id: 2, width: 64, height: 64, dest: box(0, 0, 64, 64) });
  await spice.send("display", "streamActivateReport", { id: 2, uniqueId: 77, maxWindow: 3, timeoutMs: 600000 });
  await spice.run({ cmd: "stream", args: { id: 2, create: false, frames: 5, fps: 30, width: 64, height: 64 } });
  const [report] = await spice.waitFor("display", "stream_report");
  expect(report.fields).toMatchObject({ streamId: 2, uniqueId: 77 });
  expect(report.fields.numFrames as number).toBeGreaterThanOrEqual(4);
});

test("data and clip for a destroyed stream do not desync the channel", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 0, frames: 1, fps: 30, width: 64, height: 64, destroy: true } });
  await spice.send("display", "streamData", { id: 0, mmLead: 0, image: { kind: "solid", width: 64, height: 64, color: [255, 0, 0] } });
  await spice.send("display", "streamClip", { id: 0, clip: { type: "none" } });
  await spice.send("display", "streamDestroy", { id: 0 });
  await spice.send("display", "drawFill", { box: box(0, 0, 32, 32), color: 0x00ff00 });
  await client.expectPixel(16, 16, [0, 255, 0]);
  expect(await client.errors()).toEqual([]);
});

test("destroy releases the stream slot", async ({ client, spice }) => {
  await spice.run({ cmd: "stream", args: { id: 3, frames: 2, fps: 30, width: 64, height: 64, destroy: true } });
  await expect
    .poll(() => client.page.evaluate(() => Boolean((window as unknown as { harness: { sc: { display: { streams?: unknown[] } } } }).harness.sc.display.streams?.[3])))
    .toBe(false);
});

test("frames for an unknown stream are ignored", async ({ client, spice }) => {
  await spice.send("display", "streamData", { id: 9, mmLead: 0, image: { kind: "solid", width: 16, height: 16, color: [255, 0, 0] } });
  await spice.send("display", "drawFill", { box: box(0, 0, 32, 32), color: 0x00ff00 });
  await client.expectPixel(16, 16, [0, 255, 0]);
});

/* Draws are applied in the order the server sent them, whatever each one
   needs to decode, and a burst is presented from one animation frame. */
import { QUADRANT, box, expect, frameColor, test } from "./fixtures";

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [32, 32, 32]);
});

test("a fill sent after a JPEG lands on top of it", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { box: box(100, 100, 128, 128), image: { kind: "quadrants", width: 128, height: 128, frame: 3 } } },
    { cmd: "send", channel: "display", msg: "drawFill", args: { box: box(100, 100, 128, 128), color: 0x00ff00 } },
  );
  await client.expectPixel(164, 164, [0, 255, 0]);
  await client.expectPixelStays(164, 164, [0, 255, 0]);
});

test("a copyBits sent after a JPEG copies the JPEG", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { box: box(0, 0, 128, 128), image: { kind: "quadrants", width: 128, height: 128, frame: 2 } } },
    { cmd: "send", channel: "display", msg: "copyBits", args: { box: box(300, 300, 128, 128), src: { x: 0, y: 0 } } },
  );
  await client.expectPixel(332, 332, frameColor(2), 24);
  await client.expectPixel(396, 396, QUADRANT.bottomRight, 24);
});

test("a cache draw sent right after a cached JPEG finds it", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { box: box(0, 0, 64, 64), cache: true, cacheId: 7, image: { kind: "solid", width: 64, height: 64, color: [0, 0, 255] } } },
    { cmd: "send", channel: "display", msg: "drawCopyFromCache", args: { box: box(200, 200, 64, 64), cacheId: 7 } },
  );
  await client.expectPixel(232, 232, [0, 0, 255], 24);
  expect((await client.messages()).filter((m) => /did not find image/.test(m))).toEqual([]);
});

test("a JPEG that fails to decode does not hold the draws behind it", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { box: box(0, 0, 64, 64), jpegHex: "ffd8ffe000104a46494600deadbeef" } },
    { cmd: "send", channel: "display", msg: "drawFill", args: { box: box(0, 0, 32, 32), color: 0xff0000 } },
  );
  await client.expectPixel(16, 16, [255, 0, 0]);
  expect(await client.errors()).toEqual([]);
});

test("a surface copy reads the source after the draws queued for it", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "surfaceCreate", args: { id: 1, width: 64, height: 64, primary: false } },
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { surface: 1, box: box(0, 0, 64, 64), image: { kind: "solid", width: 64, height: 64, color: [255, 255, 0] } } },
    { cmd: "send", channel: "display", msg: "drawCopyFromSurface", args: { box: box(400, 400, 64, 64), sourceSurface: 1 } },
  );
  await client.expectPixel(432, 432, [255, 255, 0], 24);
});

test("destroying a surface waits for the draws queued for it", async ({ client, spice }) => {
  await spice.run(
    { cmd: "send", channel: "display", msg: "drawCopyJpeg", args: { box: box(0, 0, 64, 64), image: { kind: "solid", width: 64, height: 64, color: [0, 255, 255] } } },
    { cmd: "send", channel: "display", msg: "surfaceDestroy", args: { id: 0 } },
  );
  await expect(client.surface()).toHaveCount(0);
  expect(await client.errors()).toEqual([]);
});

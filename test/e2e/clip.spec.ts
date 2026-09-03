/* SPICE_CLIP_TYPE_RECTS on draw operations and stream frames, the way
   spice-gtk clips every operation. */
import { QUADRANT, box, expect, frameColor, test } from "./fixtures";

const blue: [number, number, number] = [0, 0, 255];
const red: [number, number, number] = [255, 0, 0];
const clipTL = { type: "rects" as const, rects: [box(0, 0, 100, 100)] };

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.send("display", "drawFill", { box: box(0, 0, 320, 240), color: 0x0000ff });
  await client.expectPixel(150, 150, blue);
});

test("drawFill honours clip rects", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: box(0, 0, 200, 200), color: 0xff0000, clip: clipTL });
  await client.expectPixel(50, 50, red);
  await client.expectPixelStays(150, 150, blue);
});

test("drawCopy bitmap honours clip rects", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(0, 0, 200, 200), clip: clipTL, image: { kind: "solid", width: 200, height: 200, color: red } });
  await client.expectPixel(50, 50, red);
  await client.expectPixelStays(150, 150, blue);
});

test("async jpeg draw honours clip rects inside onload", async ({ client, spice }) => {
  await spice.send("display", "drawCopyJpeg", { box: box(0, 0, 200, 200), clip: clipTL, image: { kind: "solid", width: 200, height: 200, color: red } });
  await client.expectPixel(50, 50, red, 16);
  await client.expectPixelStays(150, 150, blue, 16);
});

test("copyBits honours clip rects", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: box(200, 0, 100, 200), color: 0xff0000 });
  await spice.send("display", "copyBits", { box: box(0, 0, 100, 200), clip: clipTL, src: { x: 200, y: 0 } });
  await client.expectPixel(50, 50, red);
  await client.expectPixelStays(50, 150, blue);
});

test("stream frames honour the stream clip and STREAM_CLIP updates", async ({ client, spice }) => {
  /* One quadrant frame per phase, each with a different top-left colour:
     the second frame's top-left must not replace the first's, which only
     holds if the client applied the updated clip. */
  await spice.run({
    cmd: "stream",
    args: { id: 0, frames: 1, fps: 30, width: 200, height: 200, dest: { left: 0, top: 0 }, clip: clipTL, quality: 95 },
  });
  await client.expectPixel(50, 50, frameColor(0), 24);
  await client.expectPixelStays(150, 150, blue, 24);
  await spice.send("display", "streamClip", { id: 0, clip: { type: "rects", rects: [box(100, 100, 100, 100)] } });
  await spice.run({ cmd: "stream", args: { id: 0, create: false, frames: 1, fps: 30, width: 200, height: 200, quality: 95, frameOffset: 1 } });
  await client.expectPixel(150, 150, QUADRANT.bottomRight, 24);
  await client.expectPixelStays(50, 50, frameColor(0), 24);
});

test("a clip with zero rects paints nothing", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: box(0, 0, 200, 200), color: 0xff0000, clip: { type: "rects", rects: [] } });
  await client.expectPixelStays(50, 50, blue);
  expect(await client.errors()).toEqual([]);
});

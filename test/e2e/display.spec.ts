import { QUADRANT, box, expect, frameColor, test } from "./fixtures";

const full = box(0, 0, 640, 480);

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await expect(client.surface()).toHaveAttribute("width", "640");
});

test("a fresh primary surface is black and sized", async ({ client }) => {
  await expect(client.surface()).toHaveAttribute("height", "480");
  await client.expectPixel(5, 5, [0, 0, 0]);
  await client.expectPixel(634, 474, [0, 0, 0]);
});

test("drawFill paints a solid colour", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: box(10, 10, 100, 50), color: 0xff8000 });
  await client.expectPixel(20, 20, [255, 128, 0]);
  await client.expectPixel(5, 5, [0, 0, 0]);
});

test("top-down bitmap paints the right way up", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(64, 64, 128, 128), image: { kind: "quadrants", width: 128, height: 128, frame: 0 } });
  await client.expectPixel(96, 96, frameColor(0));
  await client.expectPixel(160, 96, QUADRANT.topRight);
  await client.expectPixel(96, 160, QUADRANT.bottomLeft);
  await client.expectPixel(160, 160, QUADRANT.bottomRight);
});

test("bottom-up bitmap paints the right way up", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", {
    box: box(64, 64, 128, 128),
    topDown: false,
    image: { kind: "quadrants", width: 128, height: 128, frame: 0, flip: true },
  });
  await client.expectPixel(96, 96, frameColor(0));
  await client.expectPixel(96, 160, QUADRANT.bottomLeft);
});

test("jpeg draw copy decodes asynchronously and paints", async ({ client, spice }) => {
  await spice.send("display", "drawCopyJpeg", { box: box(200, 100, 128, 128), image: { kind: "quadrants", width: 128, height: 128, frame: 3 } });
  await client.expectPixel(232, 132, frameColor(3), 24);
  await client.expectPixel(296, 196, QUADRANT.bottomRight, 24);
});

test("copyBits blits within the surface", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: box(0, 0, 64, 64), color: 0xff0000 });
  await spice.send("display", "copyBits", { box: box(128, 128, 64, 64), src: { x: 0, y: 0 } });
  await client.expectPixel(160, 160, [255, 0, 0]);
  await client.expectPixel(100, 100, [0, 0, 0]);
});

test("a cached image can be drawn again from the cache", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", {
    box: box(0, 0, 64, 64),
    cache: true,
    cacheId: 42,
    image: { kind: "solid", width: 64, height: 64, color: [0, 255, 0] },
  });
  await client.expectPixel(32, 32, [0, 255, 0]);
  await spice.send("display", "drawCopyFromCache", { box: box(200, 200, 64, 64), cacheId: 42 });
  await client.expectPixel(232, 232, [0, 255, 0]);
  await spice.send("display", "invalList", { ids: [42] });
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0x0000ff });
  await client.expectPixel(4, 4, [0, 0, 255]);
});

test("mark, reset and inval-all-palettes are quiet no-ops", async ({ client, spice }) => {
  await spice.send("display", "displayMark");
  await spice.send("display", "invalAllPalettes");
  await spice.send("display", "displayReset");
  await spice.send("display", "drawFill", { box: full, color: 0x336699 });
  await client.expectPixel(320, 240, [51, 102, 153]);
  expect((await client.messages()).filter((m) => /Unknown message|not implemented/i.test(m))).toEqual([]);
});

test("destroying the primary surface removes its canvas", async ({ client, spice }) => {
  await spice.send("display", "surfaceDestroy", { id: 0 });
  await expect(client.surface()).toHaveCount(0);
  expect(await client.errors()).toEqual([]);
});

test("a burst of draws all land", async ({ client, spice }) => {
  await spice.send("display", "drawFill", { box: full, color: 0x000000 });
  await spice.run({ cmd: "drawBurst", args: { count: 200, size: 32, seed: 11 } });
  await spice.send("display", "drawFill", { box: box(0, 0, 4, 4), color: 0xffffff });
  await client.expectPixel(1, 1, [255, 255, 255]);
  const s = await spice.state();
  expect(s.connections.find((c) => c.channel === "display")?.messagesOut).toBeGreaterThanOrEqual(203);
  expect(await client.errors()).toEqual([]);
});

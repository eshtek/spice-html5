/* DrawCopy's src_area: the part of the image that lands in the box, and a
   box of another size scales it. Quadrant images make the offsets visible:
   only the addressed quadrant's colour may appear in the box. */
import { QUADRANT, box, expect, frameColor, test } from "./fixtures";

const grey = [32, 32, 32] as const;
const img = { kind: "quadrants", width: 128, height: 128, frame: 0 } as const;
/* Bottom-right quadrant of the 128x128 image. */
const br = { left: 64, top: 64, right: 128, bottom: 128 };

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [...grey]);
});

test("a bitmap draw copies only its src_area", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 64, 64), srcArea: br, image: img });
  await client.expectPixel(210, 210, QUADRANT.bottomRight);
  await client.expectPixel(253, 253, QUADRANT.bottomRight);
  await client.expectPixelStays(199, 199, [...grey]);
  await client.expectPixelStays(264, 264, [...grey]);
  expect((await client.messages()).filter((m) => /FIXME/.test(m))).toEqual([]);
});

test("a clipped bitmap draw copies only its src_area inside the clip", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 64, 64), srcArea: br, clip: { type: "rects", rects: [box(200, 200, 32, 64)] }, image: img });
  await client.expectPixel(210, 230, QUADRANT.bottomRight);
  await client.expectPixelStays(250, 230, [...grey]);
});

test("a JPEG draw copies only its src_area", async ({ client, spice }) => {
  await spice.send("display", "drawCopyJpeg", { box: box(300, 100, 64, 64), srcArea: br, image: img });
  await client.expectPixel(310, 110, QUADRANT.bottomRight, 24);
  await client.expectPixel(353, 153, QUADRANT.bottomRight, 24);
  await client.expectPixelStays(299, 99, [...grey]);
});

test("a cached image is drawn again from an offset", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(0, 0, 128, 128), cache: true, cacheId: 5, image: img });
  await client.expectPixel(96, 96, QUADRANT.bottomRight);
  await spice.send("display", "drawCopyFromCache", { box: box(400, 300, 64, 64), srcArea: { left: 64, top: 0, right: 128, bottom: 64 }, cacheId: 5 });
  await client.expectPixel(432, 332, QUADRANT.topRight);
  await client.expectPixelStays(400 + 70, 300 + 32, [...grey]);
});

test("a cached JPEG keeps its whole image for later offset draws", async ({ client, spice }) => {
  await spice.send("display", "drawCopyJpeg", { box: box(0, 0, 64, 64), srcArea: { left: 0, top: 0, right: 64, bottom: 64 }, cache: true, cacheId: 6, image: img });
  await client.expectPixel(32, 32, frameColor(0), 24);
  await spice.send("display", "drawCopyFromCache", { box: box(400, 300, 64, 64), srcArea: br, cacheId: 6 });
  await client.expectPixel(432, 332, QUADRANT.bottomRight, 24);
});

test("a box larger than src_area scales the image up", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 128, 128), srcArea: br, scaleMode: 1, image: img });
  await client.expectPixel(210, 210, QUADRANT.bottomRight);
  await client.expectPixel(317, 317, QUADRANT.bottomRight);
  await client.expectPixelStays(330, 330, [...grey]);
});

test("a box smaller than src_area scales the image down", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 64, 64), srcArea: { left: 0, top: 0, right: 128, bottom: 128 }, scaleMode: 1, image: img });
  await client.expectPixel(208, 208, frameColor(0));
  await client.expectPixel(255, 208, QUADRANT.topRight);
  await client.expectPixel(208, 255, QUADRANT.bottomLeft);
  await client.expectPixel(255, 255, QUADRANT.bottomRight);
});

test("an RGBA bitmap on an ARGB surface honours src_area", async ({ client, spice }) => {
  await spice.send("display", "surfaceDestroy", { id: 0 });
  await spice.send("display", "surfaceCreate", { width: 640, height: 480, format: 96 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [...grey]);
  await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 64, 64), srcArea: br, format: "rgba", image: img });
  await client.expectPixel(210, 210, QUADRANT.bottomRight);
  await client.expectPixelStays(199, 199, [...grey]);
});

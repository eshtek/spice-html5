/* The QXL 2D commands the Windows 7 XPDM driver sends: alpha-blended
   images, raster text, xor fills (the caret) and stroked paths. */
import { box, expect, test } from "./fixtures";

const grey = [32, 32, 32] as const;

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.send("display", "drawFill", { box: box(0, 0, 320, 240), color: 0x202020 });
  await client.expectPixel(5, 5, [...grey]);
});

const red = { kind: "solid", width: 32, height: 32, color: [255, 0, 0] } as const;

test.describe("alpha blend", () => {
  test("blends the image over the surface at the given alpha", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 320, 240), color: 0x0000ff });
    await spice.send("display", "drawAlphaBlendBitmap", { box: box(10, 10, 32, 32), alpha: 128, image: red });
    await client.expectPixel(20, 20, [128, 0, 127], 10);
    await client.expectPixelStays(50, 50, [0, 0, 255]);
  });

  test("alpha 255 replaces and alpha 0 leaves the surface alone", async ({ client, spice }) => {
    await spice.send("display", "drawAlphaBlendBitmap", { box: box(10, 10, 32, 32), alpha: 255, image: red });
    await client.expectPixel(20, 20, [255, 0, 0]);
    await spice.send("display", "drawAlphaBlendBitmap", { box: box(100, 10, 32, 32), alpha: 0, image: red });
    await client.expectPixelStays(110, 20, [...grey]);
  });

  test("respects the clip and src_area", async ({ client, spice }) => {
    const quad = { kind: "quadrants", width: 64, height: 64, frame: 0 } as const;
    await spice.send("display", "drawAlphaBlendBitmap", { box: box(10, 10, 32, 32), alpha: 255, image: quad, srcArea: { left: 32, top: 32, right: 64, bottom: 64 }, clip: { type: "rects", rects: [box(10, 10, 16, 32)] } });
    await client.expectPixel(15, 20, [230, 230, 230]);
    await client.expectPixelStays(35, 20, [...grey]);
  });

  test("a cached image blends again from the cache", async ({ client, spice }) => {
    await spice.send("display", "drawCopyBitmap", { box: box(200, 200, 32, 32), cache: true, cacheId: 3, image: red });
    await client.expectPixel(210, 210, [255, 0, 0]);
    await spice.send("display", "drawFill", { box: box(0, 0, 100, 100), color: 0x0000ff });
    await spice.send("display", "drawAlphaBlendFromCache", { box: box(10, 10, 32, 32), alpha: 128, cacheId: 3 });
    await client.expectPixel(20, 20, [128, 0, 127], 10);
  });

  test("an RGBA image keeps its own transparency", async ({ client, spice }) => {
    /* Solid pixels are red; the image's own alpha is what BGRA carries. */
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      pixels[i * 4] = 0;
      pixels[i * 4 + 1] = 0;
      pixels[i * 4 + 2] = 255;
      pixels[i * 4 + 3] = i % 32 < 16 ? 255 : 0;
    }
    await spice.send("display", "drawAlphaBlendBitmap", { box: box(10, 10, 32, 32), alpha: 255, format: "rgba", pixels: Array.from(pixels) });
    await client.expectPixel(15, 20, [255, 0, 0]);
    await client.expectPixelStays(35, 20, [...grey]);
  });
});

test.describe("text", () => {
  /* A 4x3 glyph with only its top row set: bottom-up packing must land it at the top. */
  const glyph = { x: 20, y: 30, originX: 0, originY: -3, rows: ["####", "....", "...."] };

  test("paints the back area and the glyph pixels in the fore colour", async ({ client, spice }) => {
    await spice.send("display", "drawText", { box: box(20, 27, 40, 3), fore: 0xff0000, back: 0x00ff00, backArea: { left: 20, top: 27, right: 60, bottom: 30 }, glyphs: [glyph] });
    await client.expectPixel(21, 27, [255, 0, 0]);
    await client.expectPixel(21, 28, [0, 255, 0]);
    await client.expectPixel(50, 29, [0, 255, 0]);
    await client.expectPixelStays(21, 31, [...grey]);
  });

  test("top-down glyphs land where they say", async ({ client, spice }) => {
    await spice.send("display", "drawText", { box: box(20, 27, 40, 3), fore: 0xff0000, topDown: true, glyphs: [glyph] });
    await client.expectPixel(21, 27, [255, 0, 0]);
    await client.expectPixelStays(21, 29, [...grey]);
  });

  test("A8 coverage blends the fore colour", async ({ client, spice }) => {
    const g = { x: 20, y: 30, originY: -2, rows: [[255, 128], [0, 0]] };
    await spice.send("display", "drawText", { box: box(20, 28, 2, 2), fore: 0xffffff, bits: 8, glyphs: [g] });
    await client.expectPixel(20, 28, [255, 255, 255]);
    await client.expectPixel(21, 28, [144, 144, 144], 12);
    await client.expectPixelStays(20, 29, [...grey]);
  });

  test("a clipped string only paints inside the clip", async ({ client, spice }) => {
    await spice.send("display", "drawText", { box: box(20, 27, 4, 3), fore: 0xff0000, clip: { type: "rects", rects: [box(20, 27, 2, 3)] }, glyphs: [glyph] });
    await client.expectPixel(21, 27, [255, 0, 0]);
    await client.expectPixelStays(23, 27, [...grey]);
  });
});

test.describe("fill rops", () => {
  test("xor with a white brush inverts, and inverts back", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 64, 64), color: 0xff0000 });
    await client.expectPixel(10, 10, [255, 0, 0]);
    await spice.send("display", "drawFill", { box: box(0, 0, 32, 64), color: 0xffffff, ropd: 64 });
    await client.expectPixel(10, 10, [0, 255, 255]);
    await client.expectPixelStays(40, 10, [255, 0, 0]);
    await spice.send("display", "drawFill", { box: box(0, 0, 32, 64), color: 0xffffff, ropd: 64 });
    await client.expectPixel(10, 10, [255, 0, 0]);
  });

  test("xor honours the clip", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 64, 64), color: 0xff0000, ropd: 64, clip: { type: "rects", rects: [box(0, 0, 16, 16)] } });
    await client.expectPixel(8, 8, [223, 32, 32]);
    await client.expectPixelStays(30, 30, [...grey]);
  });

  test("blackness and whiteness ignore the brush", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0xff0000, ropd: 128 });
    await spice.send("display", "drawFill", { box: box(20, 0, 16, 16), color: 0xff0000, ropd: 256 });
    await client.expectPixel(8, 8, [0, 0, 0]);
    await client.expectPixel(28, 8, [255, 255, 255]);
  });
});

test.describe("stroke", () => {
  test("a horizontal line covers one row of pixels", async ({ client, spice }) => {
    await spice.send("display", "drawStroke", { box: box(10, 20, 40, 1), color: 0x00ff00, segments: [{ points: [[10, 20], [49, 20]] }] });
    await client.expectPixel(30, 20, [0, 255, 0]);
    await client.expectPixelStays(30, 21, [...grey]);
    await client.expectPixelStays(30, 19, [...grey]);
    await client.expectPixelStays(55, 20, [...grey]);
  });

  test("a closed path outlines a rectangle", async ({ client, spice }) => {
    await spice.send("display", "drawStroke", { box: box(10, 10, 41, 31), color: 0x00ff00, segments: [{ flags: 1 | 2 | 8, points: [[10, 10], [50, 10], [50, 40], [10, 40]] }] });
    await client.expectPixel(30, 10, [0, 255, 0]);
    await client.expectPixel(50, 25, [0, 255, 0]);
    await client.expectPixel(30, 40, [0, 255, 0]);
    await client.expectPixel(10, 25, [0, 255, 0]);
    await client.expectPixelStays(30, 25, [...grey]);
  });

  test("a dashed line leaves gaps", async ({ client, spice }) => {
    await spice.send("display", "drawStroke", { box: box(10, 20, 40, 1), color: 0x00ff00, dash: [4, 4], segments: [{ points: [[10, 20], [49, 20]] }] });
    await client.expectPixel(11, 20, [0, 255, 0]);
    await client.expectPixelStays(16, 20, [...grey]);
  });

  test("a bezier segment draws a curve", async ({ client, spice }) => {
    await spice.send("display", "drawStroke", { box: box(10, 10, 60, 40), color: 0x00ff00, segments: [{ flags: 1 | 2 | 16, points: [[10, 40], [10, 10], [60, 10], [60, 40]] }] });
    /* The midpoint of this cubic is at (35, 17.5); antialiasing may put
       the covered pixel on either row. */
    await expect.poll(async () => Math.max(...(await Promise.all([16, 17, 18, 19].map(async (y) => (await client.pixel(35, y))?.[1] ?? 0))))).toBeGreaterThan(100);
    await client.expectPixelStays(35, 40, [...grey]);
  });
});

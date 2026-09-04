/* The rest of the QXL 2D command set: rops between source, brush and
   destination, masks, colour keys, palettised bitmaps and Composite. */
import { box, expect, test } from "./fixtures";

const grey = [32, 32, 32] as const;
const solid = (w: number, h: number, bgr: [number, number, number], alpha = 255) => {
  const p = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) p.set([...bgr, alpha], i * 4);
  return Array.from(p);
};
const red16 = solid(16, 16, [0, 0, 255]);

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 160, height: 120 });
  await spice.send("display", "drawFill", { box: box(0, 0, 160, 120), color: 0x202020 });
  await client.expectPixel(5, 5, [...grey]);
});

test.describe("blend and opaque", () => {
  test("blend ORs the source into the destination", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0x0000ff });
    await spice.send("display", "drawBlendBitmap", { box: box(0, 0, 16, 16), pixels: red16, ropd: 16 });
    await client.expectPixel(8, 8, [255, 0, 255]);
  });

  test("blend with an inverted result is NOR", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0x0000ff });
    await spice.send("display", "drawBlendBitmap", { box: box(0, 0, 16, 16), pixels: red16, ropd: 16 | 1024 });
    await client.expectPixel(8, 8, [0, 255, 0]);
  });

  test("opaque with a put rop paints the brush, with AND keeps the source's brush bits", async ({ client, spice }) => {
    await spice.send("display", "drawOpaqueBitmap", { box: box(0, 0, 16, 16), pixels: red16, color: 0x00ff00, ropd: 8 });
    await client.expectPixel(8, 8, [0, 255, 0]);
    await spice.send("display", "drawOpaqueBitmap", { box: box(20, 0, 16, 16), pixels: solid(16, 16, [0, 255, 255]), color: 0xff00ff, ropd: 32 });
    await client.expectPixel(28, 8, [255, 0, 0]);
  });

  test("a source taller than the scratch canvas scales into the whole box", async ({ client, spice }) => {
    /* AND with a white brush leaves the source as it is; the 160-row source plus
       the 40-row box outgrow a 150-high scratch canvas, so the bottom of the
       box shows whether the scaled copy was read back complete. */
    await spice.send("display", "drawOpaqueBitmap", {
      box: box(0, 0, 40, 40), pixels: solid(160, 160, [0, 0, 255]), imageWidth: 160, imageHeight: 160,
      srcArea: { left: 0, top: 0, right: 160, bottom: 160 }, color: 0xffffff, ropd: 32, scaleMode: 1,
    });
    await client.expectPixel(20, 2, [255, 0, 0]);
    await client.expectPixel(20, 38, [255, 0, 0]);
  });
});

test.describe("masks", () => {
  const halves = { rows: Array.from({ length: 8 }, () => "####...."), x: 0, y: 0 };

  test("a fill only lands where the mask allows", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(10, 10, 8, 8), color: 0xff0000, mask: halves });
    await client.expectPixel(11, 12, [255, 0, 0]);
    await client.expectPixelStays(16, 12, [...grey]);
  });

  test("a JPEG copy honours its mask", async ({ client, spice }) => {
    await spice.send("display", "drawCopyJpeg", { box: box(10, 10, 8, 8), mask: halves, image: { kind: "solid", width: 8, height: 8, color: [255, 0, 0] } });
    await client.expectPixel(11, 12, [255, 0, 0]);
    await client.expectPixelStays(16, 12, [...grey]);
  });

  test("an inverted mask flips which half", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(10, 10, 8, 8), color: 0xff0000, mask: { ...halves, invers: true } });
    await client.expectPixel(16, 12, [255, 0, 0]);
    await client.expectPixelStays(11, 12, [...grey]);
  });

  test("LE bit order and bottom-up rows are honoured", async ({ client, spice }) => {
    const topRow = { rows: ["####", "....", "....", "...."], le: true, topDown: false };
    await spice.send("display", "drawFill", { box: box(10, 10, 4, 4), color: 0xff0000, mask: topRow });
    await client.expectPixel(11, 10, [255, 0, 0]);
    await client.expectPixelStays(11, 13, [...grey]);
  });

  test("a mask offset by pos selects a different part of it", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(10, 10, 4, 8), color: 0xff0000, mask: { ...halves, x: 4 } });
    await client.expectPixelStays(11, 12, [...grey]);
  });

  test("a masked copy leaves the excluded pixels alone", async ({ client, spice }) => {
    await spice.send("display", "drawCopyBitmap", { box: box(10, 10, 16, 16), pixels: red16, mask: { rows: Array.from({ length: 16 }, () => "########........") } });
    await client.expectPixel(12, 18, [255, 0, 0]);
    await client.expectPixelStays(22, 18, [...grey]);
  });
});

test.describe("blackness, whiteness, invers", () => {
  test("paint black, white and the inverse", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 48, 16), color: 0xff0000 });
    await spice.send("display", "drawMaskOnly", { type: "blackness", box: box(0, 0, 16, 16) });
    await spice.send("display", "drawMaskOnly", { type: "whiteness", box: box(16, 0, 16, 16) });
    await spice.send("display", "drawMaskOnly", { type: "invers", box: box(32, 0, 16, 16) });
    await client.expectPixel(8, 8, [0, 0, 0]);
    await client.expectPixel(24, 8, [255, 255, 255]);
    await client.expectPixel(40, 8, [0, 255, 255]);
  });

  test("with a mask they touch only the allowed pixels", async ({ client, spice }) => {
    await spice.send("display", "drawMaskOnly", { type: "whiteness", box: box(10, 10, 8, 8), mask: { rows: Array.from({ length: 8 }, () => "####....") } });
    await client.expectPixel(11, 12, [255, 255, 255]);
    await client.expectPixelStays(16, 12, [...grey]);
  });
});

test.describe("rop3 and transparent", () => {
  test("PATINVERT xors the brush into the destination", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0xff0000 });
    await spice.send("display", "drawRop3Bitmap", { box: box(0, 0, 16, 16), pixels: red16, color: 0xffffff, rop3: 0x5a });
    await client.expectPixel(8, 8, [0, 255, 255]);
  });

  test("SRCAND keeps the destination's source bits", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0xffff00 });
    await spice.send("display", "drawRop3Bitmap", { box: box(0, 0, 16, 16), pixels: red16, color: 0, rop3: 0x88 });
    await client.expectPixel(8, 8, [255, 0, 0]);
  });

  test("transparent skips the key colour", async ({ client, spice }) => {
    const p = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i++) p.set(i % 16 < 8 ? [0, 0, 255, 0] : [255, 0, 255, 0], i * 4);
    await spice.send("display", "drawTransparentBitmap", { box: box(10, 10, 16, 16), pixels: Array.from(p), trueColor: 0xff00ff });
    await client.expectPixel(12, 18, [255, 0, 0]);
    await client.expectPixelStays(22, 18, [...grey]);
  });
});

test.describe("bitmap formats", () => {
  test("8-bit with its own palette, and again from the palette cache", async ({ client, spice }) => {
    const palette = [0x202020, 0xff0000, 0x00ff00, 0x0000ff];
    const pixels = Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 1 : 3));
    await spice.send("display", "drawCopyBitmap", { box: box(10, 10, 8, 8), format: "8bit", pixels, palette, paletteId: 77, paletteCache: true });
    await client.expectPixel(11, 12, [255, 0, 0]);
    await client.expectPixel(16, 12, [0, 0, 255]);
    await spice.send("display", "drawCopyBitmap", { box: box(30, 10, 8, 8), format: "8bit", pixels: pixels.map((v) => (v === 1 ? 2 : 1)), paletteId: 77, paletteFromCache: true });
    await client.expectPixel(31, 12, [0, 255, 0]);
    await spice.send("display", "invalPalette", { id: 77 });
    await spice.send("display", "drawCopyBitmap", { box: box(50, 10, 8, 8), format: "8bit", pixels, paletteId: 77, paletteFromCache: true });
    await expect.poll(() => client.messages()).toContainEqual(expect.stringMatching(/palette 77 not in cache/));
  });

  test("4-bit BE and LE nibble orders", async ({ client, spice }) => {
    const palette = [0x202020, 0xff0000, 0x00ff00];
    /* Two pixels a byte: 0x12 is index 1 then 2 in BE, 2 then 1 in LE. */
    const pixels = Array.from({ length: 4 }, () => 0x12);
    await spice.send("display", "drawCopyBitmap", { box: box(10, 10, 2, 4), format: "4bit-be", pixels, palette });
    await client.expectPixel(10, 12, [255, 0, 0]);
    await client.expectPixel(11, 12, [0, 255, 0]);
    await spice.send("display", "drawCopyBitmap", { box: box(20, 10, 2, 4), format: "4bit-le", pixels, palette });
    await client.expectPixel(20, 12, [0, 255, 0]);
    await client.expectPixel(21, 12, [255, 0, 0]);
  });

  test("1-bit BE and LE bit orders", async ({ client, spice }) => {
    const palette = [0x0000ff, 0xff0000];
    await spice.send("display", "drawCopyBitmap", { box: box(10, 10, 8, 2), format: "1bit-be", pixels: [0x80, 0x80], palette });
    await client.expectPixel(10, 10, [255, 0, 0]);
    await client.expectPixel(11, 10, [0, 0, 255]);
    await spice.send("display", "drawCopyBitmap", { box: box(20, 10, 8, 2), format: "1bit-le", pixels: [0x80, 0x80], palette });
    await client.expectPixel(27, 10, [255, 0, 0]);
    await client.expectPixel(20, 10, [0, 0, 255]);
  });

  test("16-bit 555 and 24-bit BGR", async ({ client, spice }) => {
    /* 555 red: r=31 -> 0x7c00; green: 0x03e0. */
    await spice.send("display", "drawCopyBitmap", { box: box(10, 10, 2, 2), format: "16bit", pixels: [0x00, 0x7c, 0xe0, 0x03, 0x00, 0x7c, 0xe0, 0x03] });
    await client.expectPixel(10, 10, [255, 0, 0]);
    await client.expectPixel(11, 11, [0, 255, 0]);
    await spice.send("display", "drawCopyBitmap", { box: box(20, 10, 2, 1), format: "24bit", pixels: [0, 0, 255, 255, 0, 0] });
    await client.expectPixel(20, 10, [255, 0, 0]);
    await client.expectPixel(21, 10, [0, 0, 255]);
  });
});

test.describe("composite", () => {
  test("OVER blends an RGBA source by its alpha", async ({ client, spice }) => {
    await spice.send("display", "drawFill", { box: box(0, 0, 16, 16), color: 0x0000ff });
    await spice.send("display", "drawComposite", { box: box(0, 0, 16, 16), op: 3, src: { box: box(0, 0, 16, 16), format: "rgba", pixels: solid(16, 16, [0, 0, 255], 128) } });
    await client.expectPixel(8, 8, [128, 0, 127], 10);
  });

  test("OVER with a mask paints only where the mask covers", async ({ client, spice }) => {
    const maskPixels = Array.from({ length: 256 }, (_, i) => (i % 16 < 8 ? 255 : 0));
    await spice.send("display", "drawComposite", { box: box(10, 10, 16, 16), op: 3, src: { box: box(0, 0, 16, 16), pixels: red16 }, mask: { box: box(0, 0, 16, 16), format: "8bit-a", pixels: maskPixels } });
    await client.expectPixel(12, 18, [255, 0, 0]);
    await client.expectPixelStays(22, 18, [...grey]);
  });

  test("SRC with a mask leaves transparent black where the mask excludes, as Render does", async ({ client, spice }) => {
    const maskPixels = Array.from({ length: 256 }, (_, i) => (i % 16 < 8 ? 255 : 0));
    await spice.send("display", "drawComposite", { box: box(10, 10, 16, 16), op: 1, src: { box: box(0, 0, 16, 16), pixels: red16 }, mask: { box: box(0, 0, 16, 16), format: "8bit-a", pixels: maskPixels } });
    await client.expectPixel(12, 18, [255, 0, 0]);
    await client.expectPixel(22, 18, [0, 0, 0]);
  });

  test("a source origin and a repeat tile the source", async ({ client, spice }) => {
    /* A 2x2 checker: red, blue / blue, red; tiled with the origin shifted by one. */
    const p = new Uint8Array(2 * 2 * 4);
    p.set([0, 0, 255, 0], 0); p.set([255, 0, 0, 0], 4); p.set([255, 0, 0, 0], 8); p.set([0, 0, 255, 0], 12);
    await spice.send("display", "drawComposite", { box: box(10, 10, 8, 8), op: 1, srcRepeat: 1, srcOrigin: [1, 0], src: { box: box(0, 0, 2, 2), imageWidth: 2, imageHeight: 2, pixels: Array.from(p) } });
    await client.expectPixel(10, 10, [0, 0, 255]);
    await client.expectPixel(11, 10, [255, 0, 0]);
    /* Dest (6, 7) samples source (7, 7) -> (1, 1): red. */
    await client.expectPixel(16, 17, [255, 0, 0]);
    await client.expectPixel(17, 17, [0, 0, 255]);
  });

  test("a transform scales the source", async ({ client, spice }) => {
    /* Dest->source scale of 0.5: a 8x8 source covers the 16x16 box. */
    const p = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) p.set(i % 8 < 4 ? [0, 0, 255, 0] : [255, 0, 0, 0], i * 4);
    await spice.send("display", "drawComposite", { box: box(10, 10, 16, 16), op: 1, srcTransform: [0.5, 0, 0, 0, 0.5, 0], src: { box: box(0, 0, 8, 8), imageWidth: 8, imageHeight: 8, pixels: Array.from(p) } });
    await client.expectPixel(12, 18, [255, 0, 0]);
    await client.expectPixel(23, 18, [0, 0, 255]);
  });

  test("an A8 surface can be created and used as a mask", async ({ client, spice }) => {
    await spice.send("display", "surfaceCreate", { id: 1, width: 16, height: 16, format: 8, primary: false });
    await spice.send("display", "drawCopyBitmap", { surface: 1, box: box(0, 0, 16, 16), format: "8bit-a", pixels: Array.from({ length: 256 }, (_, i) => (i % 16 < 8 ? 255 : 0)) });
    await spice.send("display", "drawCopyFromSurface", { box: box(10, 10, 16, 16), sourceSurface: 1 });
    /* Alpha-only surface copied onto xRGB paints black where opaque. */
    await client.expectPixel(12, 18, [0, 0, 0]);
    expect((await client.messages()).filter((m) => /FIXME|cannot handle surface/.test(m))).toEqual([]);
  });
});

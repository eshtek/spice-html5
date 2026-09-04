/* LZ4 images and the preferred-compression request that makes a server
   send them. The request goes out once, after display init, only when
   the application asked and the server advertised taking it. */
import { QUADRANT, box, expect, frameColor, test } from "./fixtures";

const grey = [32, 32, 32] as const;
const img = { kind: "quadrants", width: 128, height: 128, frame: 0 } as const;
const br = { left: 64, top: 64, right: 128, bottom: 128 };

async function displayCaps(spice: { state(): Promise<unknown> }): Promise<number> {
  const s = (await spice.state()) as { connections: Array<{ channel: string; channelCaps: number[] }> };
  return s.connections.find((c) => c.channel === "display")!.channelCaps[0];
}

test.describe("preferred compression", () => {
  test("the display link announces LZ4", async ({ client, spice }) => {
    await client.connectReady();
    expect(await displayCaps(spice)).toBeGreaterThan(0);
    expect((await displayCaps(spice)) & (1 << 5)).toBeTruthy();
  });

  test("asks for LZ4 after display init when told to", async ({ client, spice }) => {
    await client.connectReady({ preferred_compression: "lz4" });
    const [init] = await spice.waitFor("display", "display_init");
    const [pref] = await spice.waitFor("display", "preferred_compression");
    expect(pref.fields.compression).toBe(7);
    expect(pref.seq).toBeGreaterThan(init.seq);
    expect(await spice.inbound("display", "preferred_compression")).toHaveLength(1);
  });

  test("takes the enum value too", async ({ client, spice }) => {
    await client.connectReady({ preferred_compression: 4 });
    const [pref] = await spice.waitFor("display", "preferred_compression");
    expect(pref.fields.compression).toBe(4);
  });

  test("sends nothing when the application did not ask", async ({ client, spice }) => {
    await client.connectReady();
    await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
    await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
    await client.expectPixel(4, 4, [255, 255, 255]);
    expect(await spice.inbound("display", "preferred_compression")).toHaveLength(0);
  });

  test("sends nothing to a server without the cap", async ({ client, spice }) => {
    await spice.reset({ prefCompressionCap: false });
    await client.connectReady({ preferred_compression: "lz4" });
    await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
    await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
    await client.expectPixel(4, 4, [255, 255, 255]);
    expect(await spice.inbound("display", "preferred_compression")).toHaveLength(0);
    expect(await client.errors()).toEqual([]);
  });

  test("an unknown name is ignored with a warning", async ({ client, spice }) => {
    await client.connectReady({ preferred_compression: "zstd" });
    await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
    await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
    await client.expectPixel(4, 4, [255, 255, 255]);
    expect(await spice.inbound("display", "preferred_compression")).toHaveLength(0);
    expect((await client.messages()).filter((m) => /unknown preferred_compression/i.test(m))).toHaveLength(1);
  });
});

test.describe("lz4 draws", () => {
  test.beforeEach(async ({ client, spice }) => {
    await client.connectReady({ preferred_compression: "lz4" });
    await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
    await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
    await client.expectPixel(5, 5, [...grey]);
  });

  for (const format of ["32bit", "rgba", "24bit", "16bit"] as const) {
    test(`a ${format} image drawn from several blocks`, async ({ client, spice }) => {
      await spice.send("display", "drawCopyLz4", { box: box(100, 100, 128, 128), image: img, format, blockRows: 13 });
      await client.expectPixel(110, 110, frameColor(0));
      await client.expectPixel(210, 110, QUADRANT.topRight);
      await client.expectPixel(110, 210, QUADRANT.bottomLeft);
      await client.expectPixel(210, 210, QUADRANT.bottomRight);
      await client.expectPixelStays(99, 99, [...grey]);
      expect((await client.messages()).filter((m) => /FIXME|unhandled/i.test(m))).toEqual([]);
    });
  }

  test("a bottom-up image lands the right way up", async ({ client, spice }) => {
    await spice.send("display", "drawCopyLz4", { box: box(100, 100, 128, 128), image: img, topDown: false });
    await client.expectPixel(110, 110, frameColor(0));
    await client.expectPixel(210, 210, QUADRANT.bottomRight);
  });

  test("src_area picks out part of the image", async ({ client, spice }) => {
    await spice.send("display", "drawCopyLz4", { box: box(200, 200, 64, 64), srcArea: br, image: img });
    await client.expectPixel(210, 210, QUADRANT.bottomRight);
    await client.expectPixel(253, 253, QUADRANT.bottomRight);
    await client.expectPixelStays(199, 199, [...grey]);
    await client.expectPixelStays(264, 264, [...grey]);
  });

  test("a cached image is drawn again from the cache", async ({ client, spice }) => {
    await spice.send("display", "drawCopyLz4", { box: box(0, 0, 128, 128), cache: true, cacheId: 9, image: img });
    await client.expectPixel(96, 96, QUADRANT.bottomRight);
    await spice.send("display", "drawCopyFromCache", { box: box(400, 300, 64, 64), srcArea: { left: 64, top: 0, right: 128, bottom: 64 }, cacheId: 9 });
    await client.expectPixel(432, 332, QUADRANT.topRight);
    await client.expectPixelStays(470, 332, [...grey]);
  });

  test("a clipped draw stays inside the clip", async ({ client, spice }) => {
    await spice.send("display", "drawCopyLz4", { box: box(200, 200, 128, 128), clip: { type: "rects", rects: [box(200, 200, 64, 128)] }, image: img });
    await client.expectPixel(210, 210, frameColor(0));
    await client.expectPixel(210, 300, QUADRANT.bottomLeft);
    await client.expectPixelStays(300, 210, [...grey]);
  });
});

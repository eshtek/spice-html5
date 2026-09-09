/* Regression: on a Win7 XPDM guest the Paint status bar and the Notepad
   menu bar painted as solid black blocks. An LZ RGBA image is decoded in
   two passes over one buffer — colour, then alpha — and the bottom-up
   flip sat between them, so the two planes ended up mirrors of each
   other and a glyph mask's empty rows took the opaque alpha of its full
   ones. Only DRAW_ALPHA_BLEND reads that alpha, so the fault stayed
   invisible until that op was implemented. */
import { expect, test } from "./fixtures";

/* Regions the guest paints as light UI chrome; neither is ever black.
   (The desktop also carries a Command Prompt window, which legitimately
   is, so this cannot assert over the whole screen.) */
const REGIONS = [
  { name: "Paint status bar", x: 69, y: 495, w: 156, h: 24 },
  { name: "Notepad menu bar", x: 771, y: 580, w: 191, h: 19 },
];

test("the Win7 XPDM capture replays with no black UI chrome", async ({ client, spice }) => {
  test.setTimeout(180_000);
  await spice.reset({ replay: "fixtures/goldeye-win7-xpdm-blackrect.rec.json", replaySpeed: 4 });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
  await client.page.waitForFunction(() => !!document.querySelector("#spice-screen canvas"), null, { timeout: 60_000 });
  await expect.poll(() => client.litPercent(), { timeout: 60_000 }).toBeGreaterThanOrEqual(40);
  await client.page.waitForTimeout(15000);
  const black = await client.page.evaluate((regions) => {
    const c = document.querySelector("#spice-screen canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    return regions.map((r) => {
      const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 16 && d[i + 1] < 16 && d[i + 2] < 16 && d[i + 3] === 255) n++;
      /* Text strokes are black; a broken plane fills the whole region. */
      return { name: r.name, blackPercent: Math.round((100 * n) / (r.w * r.h)) };
    });
  }, REGIONS);
  for (const r of black) expect(r, r.name).toHaveProperty("blackPercent", expect.any(Number));
  expect(black.filter((r) => r.blackPercent > 25)).toEqual([]);
});

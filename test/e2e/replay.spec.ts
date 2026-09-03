/* A session recorded from a real box (test/README.md, "Recording real
   boxes") replayed through the fake server: real QUIC/LZ draw payloads,
   a real Windows cursor shape, and every channel a TrueNAS VM exposes. */
import { expect, test } from "./fixtures";

const FIXTURE = "fixtures/goldeye-win11-idle.rec.json";

test("the goldeye Windows 11 recording paints the whole desktop", async ({ client, spice }) => {
  await spice.reset({ replay: FIXTURE });
  await client.connectReady({ channels: ["display", "inputs", "cursor", "playback", "record"] });
  await expect(client.surface()).toHaveAttribute("width", "1400");
  await expect
    .poll(
      () =>
        client.page.evaluate(() => {
          const c = document.getElementById("spice_surface_0") as HTMLCanvasElement | null;
          if (!c) return 0;
          const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
          return Math.round((100 * lit) / (c.width * c.height));
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(95);
  await expect.poll(() => client.page.evaluate(() => document.getElementById("spice-screen")!.style.cursor)).toMatch(/^url\("?data:image\/png/);
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled/i.test(m))).toEqual([]);
});

test("a second session replays from the top", async ({ client, spice }) => {
  await spice.reset({ replay: FIXTURE });
  await client.connectReady({ channels: ["display"] });
  await expect(client.surface()).toHaveAttribute("width", "1400");
  await client.disconnect();
  await expect.poll(async () => (await spice.state()).connections.length).toBe(0);
  await client.connectReady({ channels: ["display"] });
  await expect(client.surface()).toHaveAttribute("width", "1400");
  expect(await client.errors()).toEqual([]);
});

test("loop mode plays the recording again after it ends", async ({ client, spice }) => {
  /* At 30x the 12 s recording ends in well under a second; each pass
     destroys and recreates the primary surface, so the canvas count is
     the number of passes the client has seen. */
  await spice.reset({ replay: FIXTURE, replaySpeed: 30, replayLoop: true });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
  await expect.poll(() => client.counters().then((c) => c.canvases), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(client.surface()).toHaveCount(1);
  expect(await client.errors()).toEqual([]);
  expect((await spice.state()).log.filter((l) => l === "replay: loop").length).toBeGreaterThanOrEqual(2);
});

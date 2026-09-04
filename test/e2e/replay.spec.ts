/* A session recorded from a real box (test/README.md, "Recording real
   boxes") replayed through the fake server: real QUIC/LZ draw payloads,
   a real Windows cursor shape, and every channel a TrueNAS VM exposes. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  expect((await spice.state()).log.filter((l) => /^replay: loop/.test(l)).length).toBeGreaterThanOrEqual(2);
});

/* The same Ubuntu guest after the client asked for LZ4: every fresh image
   arrives as type 109, and the replay must stay free of unhandled draws. */
test("the goldeye LZ4 recording paints the desktop from LZ4 images alone", async ({ client, spice }) => {
  await spice.reset({ replay: "fixtures/goldeye-ubuntu2004-xf86qxl-lz4.rec.json" });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
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
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(60);
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled/i.test(m))).toEqual([]);
});

/* Windows 7 with the XPDM QXL driver: DrawText, DrawStroke, DrawAlphaBlend
   and xor fills, none of which the client used to draw. */
test("the goldeye Windows 7 recording paints its desktop with no unhandled draw", async ({ client, spice }) => {
  await spice.reset({ replay: "fixtures/goldeye-win7-xpdm.rec.json" });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
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
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(60);
  await client.page.waitForTimeout(500);
  if (process.env.SHOT) await client.page.screenshot({ path: process.env.SHOT });
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled|unimplemented/i.test(m))).toEqual([]);
});

/* Recorded with the client advertising Composite and A8 surfaces: the X
   driver kept to copies and fills (its caps are read when X starts) and
   used seven ARGB offscreen surfaces. */
test("the xf86-video-qxl recording with the composite caps replays clean", async ({ client, spice }) => {
  await spice.reset({ replay: "fixtures/goldeye-ubuntu2004-xf86qxl-composite.rec.json" });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
  await client.page.waitForTimeout(6000);
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled|unimplemented|cannot handle/i.test(m))).toEqual([]);
});

/* The Windows 7 lock screen: cursor shapes cached and referred back to. */
test("the busier Windows 7 recording uses the cursor cache without a warning", async ({ client, spice }) => {
  await spice.reset({ replay: "fixtures/goldeye-win7-xpdm-busy.rec.json" });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
  await client.page.waitForTimeout(6000);
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled|unimplemented|cannot handle/i.test(m))).toEqual([]);
});

/* Recorded after a guest reboot with the client connected, so X started
   with Composite in the QXL ROM: 20 composites from offscreen surfaces,
   A8 surfaces fed by 8BIT_A bitmaps and LZ A8 images. */
test("the xf86-video-qxl recording with Composite in use replays clean", async ({ client, spice }) => {
  const fixture = "fixtures/goldeye-ubuntu2004-xf86qxl-composite-reboot.rec.json";
  const speed = 8;
  /* Wait out the whole recording: its last message's time, at replay speed. */
  const rec = JSON.parse(readFileSync(join(HERE, "..", fixture), "utf8")) as { connections: Array<{ server: Array<{ t: number }> }> };
  const lastMs = Math.max(...rec.connections.flatMap((c) => c.server.map((m) => m.t)));
  test.setTimeout(lastMs / speed + 60_000);
  await spice.reset({ replay: fixture, replaySpeed: speed });
  await client.connectReady({ channels: ["display", "inputs", "cursor"] });
  await client.page.waitForTimeout(lastMs / speed + 3000);
  if (process.env.SHOT) await client.page.screenshot({ path: process.env.SHOT });
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /Unknown message|FIXME|unhandled|unimplemented|cannot handle/i.test(m))).toEqual([]);
});

/* Two clients on one replaying server, side by side: each gets the
   recording from the top on its own clock, and neither disturbs the other. */
test("a second session replays alongside the first without restarting it", async ({ client, spice }) => {
  await spice.reset({ replay: FIXTURE, replaySpeed: 2 });
  await client.connectReady({ channels: ["display"] });
  await expect(client.surface()).toHaveAttribute("width", "1400");
  const before = (await spice.state()).connections.find((c) => c.channel === "display")!;
  const page2 = await client.page.context().newPage();
  await page2.goto(`${spice.baseUrl}/page.html`);
  await page2.waitForFunction(() => Boolean((window as unknown as { harness?: unknown }).harness));
  await page2.evaluate(() => (window as unknown as { harness: { connect: (o: unknown) => Promise<string> } }).harness.connect({}));
  await expect.poll(async () => (await spice.state()).connections.filter((c) => c.channel === "main").length).toBe(2);
  await expect.poll(() => page2.evaluate(() => (document.getElementById("spice_surface_0") as HTMLCanvasElement | null)?.width ?? 0)).toBe(1400);
  const state = await spice.state();
  const mains = state.connections.filter((c) => c.channel === "main").map((c) => c.session);
  expect(new Set(mains).size).toBe(2);
  /* The first client's display channel keeps its session and keeps receiving. */
  const first = state.connections.find((c) => c.channel === "display" && c.session === mains[0])!;
  expect(first.messagesOut).toBeGreaterThanOrEqual(before.messagesOut);
  await expect.poll(async () => (await spice.state()).connections.find((c) => c.channel === "display" && c.session === mains[0])!.messagesOut).toBeGreaterThan(first.messagesOut);
  const ids = await Promise.all([
    client.page.evaluate(() => (window as unknown as { harness: { sc: { connection_id: number } } }).harness.sc.connection_id),
    page2.evaluate(() => (window as unknown as { harness: { sc: { connection_id: number } } }).harness.sc.connection_id),
  ]);
  expect(ids[0]).not.toBe(ids[1]);
  expect(await client.errors()).toEqual([]);
  await page2.close();
});

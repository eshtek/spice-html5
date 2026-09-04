/* The shaped pipe from the client's side: the handshake survives a slow
   link, a draw arrives no sooner than the latency, order holds under
   jitter, and a stream starved by the link rate degrades without error. */
import { box, expect, test } from "./fixtures";

test("a 200 ms link still connects, and a draw takes at least the latency to land", async ({ client, spice }) => {
  await spice.reset({ shape: { latencyMs: 200 } });
  const t0 = Date.now();
  await client.connectReady();
  /* Five round trips of handshake per channel, each paying the latency. */
  expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  const t1 = Date.now();
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255]);
  expect(Date.now() - t1).toBeGreaterThanOrEqual(200);
  expect(await client.errors()).toEqual([]);
});

test("jitter never reorders draws", async ({ client, spice }) => {
  await spice.reset({ shape: { latencyMs: 20, jitterMs: 60, seed: 11 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  /* Later fills fully cover earlier ones; only the last colour may survive. */
  for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x101010]) {
    await spice.run({ cmd: "send", channel: "display", msg: "drawFill", args: { box: box(0, 0, 64, 64), color } });
  }
  await client.expectPixel(32, 32, [16, 16, 16]);
  await client.expectPixelStays(32, 32, [16, 16, 16]);
});

test("a link too slow for the stream leaves the client sane", async ({ client, spice }) => {
  /* 320x240 JPEG at 30 fps needs a few Mbit/s; give it 500 kbit/s. */
  await spice.reset({ shape: { latencyMs: 30, kbps: 500 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.run({ cmd: "stream", args: { id: 0, frames: 30, fps: 30, width: 320, height: 240, destroy: true } });
  const before = (await spice.state()).connections.find((c) => c.channel === "display")!;
  expect(before.shapedBytes).toBeGreaterThan(0);
  await expect.poll(async () => (await spice.state()).connections.find((c) => c.channel === "display")?.shapedBytes, { timeout: 30_000 }).toBe(0);
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255], 8, 10_000);
  expect(await client.errors()).toEqual([]);
});

test("closing a connection drops what the pipe still held", async ({ client, spice }) => {
  await spice.reset({ shape: { latencyMs: 500 } });
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  await spice.send("display", "drawFill", { box: box(0, 0, 64, 64), color: 0xffffff });
  await spice.run({ cmd: "close", channel: "display" });
  expect((await spice.state()).connections.find((c) => c.channel === "display")).toBeUndefined();
  await client.page.waitForTimeout(600);
  expect(await client.errors()).toContainEqual(expect.stringMatching(/Unexpected close/));
});

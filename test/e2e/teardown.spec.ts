/* Teardown and reconnect hygiene. Everything a session creates must be
   gone once stop() returns, or a console left open for a day leaks. */
import { box, expect, frameColor, test } from "./fixtures";

const screenChildren = (client: import("./fixtures").SpiceClient) =>
  client.page.evaluate(() => document.getElementById("spice-screen")!.children.length);

test("connect/disconnect cycles leave no DOM, sockets or blobs behind", async ({ client, spice }) => {
  for (let i = 0; i < 5; i++) {
    await client.connectReady();
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await spice.send("display", "drawCopyJpeg", { box: box(0, 0, 64, 64), image: { kind: "quadrants", width: 64, height: 64, frame: i } });
    await client.expectPixel(16, 16, frameColor(i), 24);
    await client.disconnect();
    await expect.poll(() => screenChildren(client)).toBe(0);
    await expect.poll(async () => (await spice.state()).connections.length).toBe(0);
  }
  expect(await client.errors()).toEqual([]);
  const c = await client.counters();
  expect(c.websockets).toBe(20);
  await expect.poll(() => client.counters().then((c) => c.objectUrlsCreated - c.objectUrlsRevoked)).toBe(0);
});

test("stopping mid-stream tears the stream down and revokes every frame", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  const streaming = spice.run({ cmd: "stream", args: { id: 0, frames: 30, fps: 60, width: 160, height: 120 } });
  await client.page.waitForTimeout(150);
  await client.disconnect();
  await streaming.catch(() => {});
  await expect.poll(() => screenChildren(client)).toBe(0);
  await expect.poll(() => client.page.locator("video").count()).toBe(0);
  await expect.poll(() => client.counters().then((c) => c.objectUrlsCreated - c.objectUrlsRevoked), { timeout: 5000 }).toBe(0);
  expect(client.pageErrors).toEqual([]);
});

test("sessions the library ends on its own do not keep their paste listener", async ({ client, spice }) => {
  await spice.reset({ password: "right" });
  /* Three rejected attempts, none followed by stop(): the way a page that
     re-prompts for a password behaves. */
  for (let i = 0; i < 3; i++) await expect(client.connect({ password: "wrong" })).rejects.toThrow(/Permission denied/);
  await expect.poll(() => client.counters().then((c) => c.pasteListeners)).toBeLessThanOrEqual(3);
  /* Dead sessions drop their listener on the first paste they see. */
  await client.page.evaluate(() => document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true })));
  expect((await client.counters()).pasteListeners).toBe(0);
  /* A connect timeout is a library-initiated teardown and must not wait for a paste. */
  await spice.reset({ authDelayMs: 40_000 });
  await client.page.evaluate(() => {
    (window as unknown as { harness: { Constants: { SPICE_CONNECT_TIMEOUT: number } } }).harness.Constants.SPICE_CONNECT_TIMEOUT = 500;
  });
  await expect(client.connect()).rejects.toThrow(/timed out/i);
  expect((await client.counters()).pasteListeners).toBe(0);
});

test("frames still decoding when the session stops do not throw", async ({ client, spice, browserName }) => {
  /* Firefox finishes a 2048x2048 decode before a timer tick can observe
     it, so the window this pins is only reachable in Chromium. */
  test.skip(browserName === "firefox", "decode completes before a timer tick can observe it");
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 2048, height: 2048 });
  /* Large frames take long enough to decode that stop() can land while
     one is in flight; its onload then fires against a torn-down stream
     table. The poll waits for the stream's own in-flight counter. */
  const streaming = spice.run({ cmd: "stream", args: { id: 0, frames: 8, fps: 1000, width: 2048, height: 2048, quality: 95 } });
  /* Stop from inside the page, on the first timer tick that sees a frame
     in flight: that tick runs before the decode's onload task can. */
  const stopped = await client.page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const h = (window as unknown as { harness: { sc: { display: { streams?: Array<{ frames_loading: number }> } }; disconnect: () => void } }).harness;
        const t0 = Date.now();
        const tick = setInterval(() => {
          const loading = h.sc.display.streams?.[0]?.frames_loading ?? 0;
          if (loading > 0 || Date.now() - t0 > 10_000) {
            clearInterval(tick);
            h.disconnect();
            resolve(loading);
          }
        }, 0);
      }),
  );
  expect(stopped).toBeGreaterThan(0);
  await streaming.catch(() => {});
  await client.page.waitForTimeout(500);
  expect(client.pageErrors).toEqual([]);
});

test("a second connection after a server-side drop starts clean", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.run({ cmd: "close", channel: "main" });
  await expect.poll(() => client.errors()).not.toEqual([]);
  await client.disconnect();
  await expect.poll(() => screenChildren(client)).toBe(0);
  await spice.reset();
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.send("display", "drawFill", { box: box(0, 0, 32, 32), color: 0x00ff00 });
  await client.expectPixel(16, 16, [0, 255, 0]);
  expect(await screenChildren(client)).toBe(1);
});

/* One bad message must cost one message, not the channel: the wire reader
   is re-armed only after a handler returns, so a handler that threw used to
   leave the channel reading every later byte as a header. */
import { box, expect, test } from "./fixtures";

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [32, 32, 32]);
});

test("a draw to a surface that does not exist does not desync the channel", async ({ client, spice }) => {
  /* Surface 7 was never created; the DrawCopy handler throws on it. */
  await spice.send("display", "drawCopyBitmap", { surface: 7, box: box(0, 0, 32, 32), image: { kind: "solid", width: 32, height: 32, color: [255, 0, 0] } });
  await spice.send("display", "drawFill", { box: box(100, 100, 50, 50), color: 0x00ff00 });
  await client.expectPixel(125, 125, [0, 255, 0]);
  await client.expectPixelStays(5, 5, [32, 32, 32]);
  const messages = await client.messages();
  expect(messages.filter((m) => /exception handling message type 304/.test(m)).length).toBe(1);
  expect(messages.filter((m) => /Unknown message type/.test(m))).toEqual([]);
  expect(await client.errors()).toEqual([]);
  expect(await client.channelStates()).toMatchObject({ display: "ready" });
});

test("a burst after a bad message all lands", async ({ client, spice }) => {
  await spice.send("display", "drawCopyBitmap", { surface: 7, box: box(0, 0, 32, 32), image: { kind: "solid", width: 32, height: 32, color: [255, 0, 0] } });
  await spice.run({ cmd: "drawBurst", args: { count: 50, size: 32, seed: 3 } });
  await spice.send("display", "drawFill", { box: box(0, 0, 4, 4), color: 0xffffff });
  await client.expectPixel(1, 1, [255, 255, 255]);
  expect((await client.messages()).filter((m) => /Unknown message type/.test(m))).toEqual([]);
});

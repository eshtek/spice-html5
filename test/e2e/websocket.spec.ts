/* Where the client's sockets come from: a URI it opens itself, a socket
   the application opened and hands over, or a factory that opens every
   channel's socket (upstream issue #10). */
import { box, expect, test } from "./fixtures";

test("a socket opened by the application carries the main channel", async ({ client, spice }) => {
  await client.connectReady({ preopen: true });
  expect(await client.channelStates()).toMatchObject({ main: "ready", display: "ready", inputs: "ready", cursor: "ready" });
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255]);
  expect(await client.errors()).toEqual([]);
});

test("a pre-opened socket needs no uri; the child channels take its url", async ({ client }) => {
  await client.connectReady({ preopen: true, omitUri: true });
  expect(await client.channelStates()).toMatchObject({ main: "ready", display: "ready" });
});

test("a factory opens every channel's socket and hears which channel it is for", async ({ client, spice }) => {
  await client.connectReady({ factory: true });
  const calls = await client.factoryCalls();
  expect(calls.map(([type, id]) => `${type}:${id}`).sort()).toEqual(["1:0", "2:0", "3:0", "4:0"]);
  expect(calls.every(([, , uri]) => uri.startsWith("ws://"))).toBe(true);
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0x00ff00 });
  await client.expectPixel(4, 4, [0, 255, 0]);
});

test("neither a uri nor a socket is an error, not a hang", async ({ client }) => {
  await expect(client.connect({ omitUri: true })).rejects.toThrow(/uri/);
});

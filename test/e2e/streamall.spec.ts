/* STREAM_DESTROY_ALL tears every stream down, the way STREAM_DESTROY does one. */
import { box, expect, test } from "./fixtures";

test("destroy all ends every stream and is not reported as unimplemented", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await spice.send("display", "streamCreate", { id: 0, codec: 1, width: 64, height: 64, dest: box(0, 0, 64, 64) });
  await spice.send("display", "streamCreate", { id: 1, codec: 1, width: 64, height: 64, dest: box(100, 0, 64, 64) });
  await expect.poll(() => client.page.evaluate(() => (window as unknown as { harness: { sc: { display: { streams: unknown[] } } } }).harness.sc.display.streams.filter(Boolean).length)).toBe(2);
  await spice.send("display", "streamDestroyAll");
  await expect.poll(() => client.page.evaluate(() => (window as unknown as { harness: { sc: { display: { streams: unknown[] } } } }).harness.sc.display.streams.filter(Boolean).length)).toBe(0);
  expect((await client.messages()).filter((m) => /Unimplemented|Unknown/.test(m))).toEqual([]);
});

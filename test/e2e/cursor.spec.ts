import { expect, test } from "./fixtures";

const screenCursor = (client: import("./fixtures").SpiceClient) =>
  client.page.evaluate(() => document.getElementById("spice-screen")!.style.cursor);

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
});

test("HIDE hides the pointer and RESET restores it", async ({ client, spice }) => {
  await spice.send("cursor", "cursorHide");
  await expect.poll(() => screenCursor(client)).toBe("none");
  await spice.send("cursor", "cursorReset");
  await expect.poll(() => screenCursor(client)).toBe("auto");
});

test("a CURSOR_SET carrying FLAGS_NONE hides the pointer and leaves the channel alive", async ({ client, spice }) => {
  await spice.send("cursor", "cursorSet", { shape: null });
  await expect.poll(() => screenCursor(client)).toBe("none");
  await spice.send("cursor", "cursorReset");
  await expect.poll(() => screenCursor(client)).toBe("auto");
});

test("an ALPHA cursor becomes a data-URL pointer with its hotspot", async ({ client, spice }) => {
  await spice.send("cursor", "cursorSet", { shape: { width: 16, height: 16, hotX: 3, hotY: 5, image: { kind: "quadrants", width: 16, height: 16 } } });
  await expect.poll(() => screenCursor(client)).toMatch(/^url\("?data:image\/png/);
  expect(await screenCursor(client)).toMatch(/\)\s*3(px)? 5(px)?/);
});

test("a MONO cursor is converted rather than dropped", async ({ client, spice }) => {
  const and = "ff".repeat(32);
  const xor = "00".repeat(32);
  await spice.send("cursor", "cursorSet", { shape: { type: 1, width: 16, height: 16, dataHex: and + xor } });
  await expect.poll(() => screenCursor(client)).toMatch(/^url\("?data:image\/png/);
  expect((await client.messages()).filter((m) => /Unknown message type/.test(m))).toEqual([]);
});

test("a session that ends with the pointer hidden does not hide the next one's", async ({ client, spice }) => {
  await spice.send("cursor", "cursorHide");
  await expect.poll(() => screenCursor(client)).toBe("none");
  await client.disconnect();
  /* The screen div outlives the session; stop() must hand it back with a
     visible pointer, since the next guest's CURSOR_INIT shape is ignored. */
  expect(await screenCursor(client)).toBe("auto");
  await spice.reset();
  await client.connectReady();
  expect(await screenCursor(client)).toBe("auto");
});

test("cursor move is accepted silently in client mouse mode", async ({ client, spice }) => {
  await spice.send("cursor", "cursorMove", { x: 10, y: 20 });
  await spice.send("cursor", "cursorHide");
  await expect.poll(() => screenCursor(client)).toBe("none");
  expect((await client.messages()).filter((m) => /Unknown message|not implemented/i.test(m))).toEqual([]);
});

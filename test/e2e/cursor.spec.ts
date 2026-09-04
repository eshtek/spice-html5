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

test("a shape flagged CACHE_ME is reused FROM_CACHE and dropped by INVAL_ONE", async ({ client, spice }) => {
  await spice.send("cursor", "cursorSet", { flags: 2, shape: { unique: 42, width: 16, height: 16, hotX: 3, hotY: 5, image: { kind: "quadrants", width: 16, height: 16 } } });
  await expect.poll(() => screenCursor(client)).toMatch(/^url\("?data:image\/png/);
  const cached = await screenCursor(client);
  await spice.send("cursor", "cursorSet", { shape: { unique: 43, width: 8, height: 8, image: { kind: "solid", width: 8, height: 8, color: [255, 0, 0] } } });
  await expect.poll(() => screenCursor(client)).not.toBe(cached);
  await spice.send("cursor", "cursorSet", { flags: 4, shape: { unique: 42, width: 16, height: 16, hotX: 3, hotY: 5 } });
  await expect.poll(() => screenCursor(client)).toBe(cached);
  await spice.send("cursor", "cursorInvalOne", { id: 42 });
  await spice.send("cursor", "cursorSet", { flags: 4, shape: { unique: 42, width: 16, height: 16 } });
  await expect.poll(() => client.messages()).toContainEqual(expect.stringMatching(/cursor 42 not in cache/));
  expect((await client.messages()).filter((m) => /No support for cursor flags/.test(m))).toEqual([]);
});

test("INVAL_ALL empties the cache", async ({ client, spice }) => {
  await spice.send("cursor", "cursorSet", { flags: 2, shape: { unique: 7, width: 8, height: 8, image: { kind: "solid", width: 8, height: 8, color: [0, 255, 0] } } });
  await expect.poll(() => screenCursor(client)).toMatch(/^url\("?data:image\/png/);
  await spice.send("cursor", "cursorInvalAll");
  await spice.send("cursor", "cursorSet", { flags: 4, shape: { unique: 7, width: 8, height: 8 } });
  await expect.poll(() => client.messages()).toContainEqual(expect.stringMatching(/cursor 7 not in cache/));
});

test("a cursor delivered with INIT is shown", async ({ client, spice }) => {
  await spice.send("cursor", "cursorInit", { x: 5, y: 5, shape: { unique: 9, width: 8, height: 8, image: { kind: "solid", width: 8, height: 8, color: [0, 0, 255] } } });
  await expect.poll(() => screenCursor(client)).toMatch(/^url\("?data:image\/png/);
});

/* A cursor the browser will not take (over 128 px) falls back to an image
   moved under the pointer. That image lives inside the screen element,
   which this page centres, so page coordinates would put it off by the
   screen's offset: the cursor half of upstream issue #14. */
test("a simulated cursor sits under the pointer on a screen that is not at the page origin", async ({ client, spice }) => {
  await expect(client.surface()).toBeVisible();
  await spice.send("cursor", "cursorSet", { shape: { width: 200, height: 200, hotX: 7, hotY: 11, image: { kind: "solid", width: 200, height: 200, color: [255, 0, 0] } } });
  await expect.poll(() => client.page.locator("#spice-screen img").count()).toBe(1);
  const bb = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb.x + 100, bb.y + 60);
  await expect
    .poll(() => client.page.evaluate(() => { const i = document.querySelector("#spice-screen img") as HTMLImageElement; return [parseFloat(i.style.left), parseFloat(i.style.top)]; }))
    .toEqual([100 - 7, 60 - 11]);
  /* With the screen scaled, the image is placed in the screen's own units. */
  await client.page.evaluate(() => { (document.getElementById("spice-screen") as HTMLElement).style.transform = "scale(0.5)"; (document.getElementById("spice-screen") as HTMLElement).style.transformOrigin = "0 0"; });
  const bb2 = (await client.surface().boundingBox())!;
  await client.page.mouse.move(bb2.x + 50, bb2.y + 30);
  await expect
    .poll(() => client.page.evaluate(() => { const i = document.querySelector("#spice-screen img") as HTMLImageElement; return [Math.round(parseFloat(i.style.left)), Math.round(parseFloat(i.style.top))]; }))
    .toEqual([100 - 7, 60 - 11]);
});

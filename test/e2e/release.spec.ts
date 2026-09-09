import { expect, test } from "./fixtures";

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
  await expect(client.surface()).toBeVisible();
});

test("a button released off the screen element is still released in the guest", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 20, bb.y + 20);
  await client.page.mouse.down();
  await spice.waitFor("inputs", "mouse_press");
  /* Off the canvas, still inside the page, and let go there. */
  await client.page.mouse.move(bb.x + bb.width + 60, bb.y + bb.height + 60, { steps: 6 });
  await client.page.mouse.up();
  await spice.waitFor("inputs", "mouse_release");
  const events = (await spice.inbound("inputs", "*", before)).filter((e) => /mouse_(press|release)/.test(e.name));
  expect(events.map((e) => [e.name, e.fields.button])).toEqual([
    ["mouse_press", 1],
    ["mouse_release", 1],
  ]);
});

test("a button the browser no longer reports is released in the guest", async ({ client, spice }) => {
  const bb = (await client.surface().boundingBox())!;
  const before = await spice.mark();
  await client.page.mouse.move(bb.x + 20, bb.y + 20);
  await client.page.mouse.down();
  await spice.waitFor("inputs", "mouse_press");
  /* The button goes up where this page cannot see it at all -- over
     another window, say -- so the next move is the first news of it. */
  await client.page.evaluate(() => {
    const c = document.querySelector("#spice-screen canvas") as HTMLCanvasElement;
    c.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5, buttons: 0 }));
  });
  await spice.waitFor("inputs", "mouse_release");
  const events = (await spice.inbound("inputs", "*", before)).filter((e) => /mouse_(press|release)/.test(e.name));
  expect(events.map((e) => [e.name, e.fields.button, e.fields.buttonsState])).toEqual([
    ["mouse_press", 1, 1],
    ["mouse_release", 1, 0],
  ]);
  await client.page.mouse.up();
});

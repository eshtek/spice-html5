import { QUADRANT, expect, frameColor, test } from "./fixtures";

test.describe("link handshake", () => {
  test("connects and brings up every default channel", async ({ client, spice }) => {
    await client.connectReady();
    const s = await spice.state();
    const ready = s.connections.filter((c) => c.state === "ready").map((c) => c.channel).sort();
    expect(ready).toEqual(["cursor", "display", "inputs", "main"]);
    expect(await client.errors()).toEqual([]);
  });

  test("authenticates with the right password and rejects the wrong one", async ({ client, spice }) => {
    await spice.reset({ password: "p@ss-w0rd!" });
    await expect(client.connect({ password: "nope" })).rejects.toThrow(/Permission denied/);
    await client.disconnect();
    await client.connectReady({ password: "p@ss-w0rd!" });
  });

  test("a server with the wrong magic is reported, not hung", async ({ client, spice }) => {
    await spice.reset({ serverMagic: "NOPE" });
    await expect(client.connect()).rejects.toThrow(/magic mismatch/);
  });

  test("a link error code reaches onerror", async ({ client, spice }) => {
    await spice.reset({ linkError: 9 });
    await expect(client.connect()).rejects.toThrow(/reply link error 9/);
  });

  test("a socket dropped during link reads as a protocol mismatch", async ({ client, spice }) => {
    await spice.reset({ dropDuring: "link" });
    await expect(client.connect()).rejects.toThrow(/Unexpected protocol mismatch/);
  });

  test("a socket dropped during ticket reads as a bad password", async ({ client, spice }) => {
    await spice.reset({ dropDuring: "ticket" });
    await expect(client.connect()).rejects.toThrow(/Bad password/);
  });

  test("a stalled auth reply times out on the client", async ({ client, spice }) => {
    test.slow();
    test.setTimeout(60_000);
    await spice.reset({ authDelayMs: 40_000 });
    await expect(client.connect()).rejects.toThrow(/time/i);
  });

  test("child channel death reaches the application", async ({ client, spice }) => {
    await client.connectReady();
    await spice.run({ cmd: "close", channel: "display" });
    await expect.poll(() => client.errors()).toContainEqual(expect.stringMatching(/Unexpected close while ready/));
  });
});

test.describe("wire framing", () => {
  const paints = async (client: import("./fixtures").SpiceClient) => {
    await client.connectReady();
    await client.spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await client.spice.send("display", "drawFill", { box: { left: 0, top: 0, right: 320, bottom: 240 }, color: 0x102030 });
    await client.spice.send("display", "drawCopyBitmap", {
      box: { left: 32, top: 32, right: 96, bottom: 96 },
      image: { kind: "quadrants", width: 64, height: 64, frame: 1 },
    });
    await client.expectPixel(48, 48, frameColor(1));
    await client.expectPixel(80, 80, QUADRANT.bottomRight);
    await client.expectPixel(200, 200, [16, 32, 48]);
  };

  test("one byte per websocket frame", async ({ client, spice }) => {
    await spice.reset({ fragment: { kind: "chunk", size: 1 } });
    await paints(client);
  });

  test("random fragment sizes", async ({ client, spice }) => {
    await spice.reset({ fragment: { kind: "random", seed: 7, max: 13 } });
    await paints(client);
  });

  test("several messages coalesced into one frame", async ({ client, spice }) => {
    await spice.reset({ fragment: { kind: "coalesce", ms: 25 } });
    await paints(client);
  });
});

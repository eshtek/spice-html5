import { expect, test } from "./fixtures";

test("ping is answered with a pong carrying id and timestamp", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("main", "ping", { id: 7, timestamp: 123456, extra: 40 });
  /* The server's own keepalive pings can be pending too; pick ours by id. */
  await expect.poll(async () => (await spice.inbound("main", "pong")).map((p) => p.fields.id)).toContain(7);
  const pong = (await spice.inbound("main", "pong")).find((p) => p.fields.id === 7)!;
  expect(pong.fields).toMatchObject({ id: 7, timestamp: 123456 });
});

test("SET_ACK is acknowledged and ACKs follow every window", async ({ client, spice }) => {
  await spice.reset({ ackWindow: 4 });
  await client.connectReady();
  const [sync] = await spice.waitFor("main", "ack_sync");
  expect(sync.fields.generation).toBe(1);
  /* The client counts every message from SET_ACK onwards, so by the time
     main is ready it has seen SET_ACK, INIT and CHANNELS_LIST: one more
     fills the first window, then every four. */
  const acks = async (since: number) => (await spice.inbound("main", "ack", since)).length;
  const before = await spice.mark();
  await spice.send("main", "notify", { severity: 0, message: "n0" });
  await expect.poll(() => acks(before)).toBe(1);
  for (let i = 1; i <= 3; i++) await spice.send("main", "notify", { severity: 0, message: `n${i}` });
  await client.page.waitForTimeout(200);
  expect(await acks(before)).toBe(1);
  await spice.send("main", "notify", { severity: 0, message: "n4" });
  await expect.poll(() => acks(before)).toBe(2);
});

test("an error NOTIFY lands in the message area", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("main", "notify", { severity: 2, message: "guest exploded" });
  await expect.poll(() => client.messages()).toContainEqual(expect.stringContaining("guest exploded"));
});

test("client asks for client mouse mode when the server starts in server mode", async ({ client, spice }) => {
  await spice.reset({ mouseModes: { supported: 3, current: 1 } });
  await client.connectReady();
  const [req] = await spice.waitFor("main", "mouse_mode_request");
  expect(req.fields.mode).toBe(2);
});

test("an agent announced at INIT is started and sent our capabilities", async ({ client, spice }) => {
  await spice.reset({ agentConnected: true });
  await client.connectReady();
  await spice.waitFor("main", "agent_start");
  const [caps] = await spice.waitFor("main", "agent_data");
  expect(caps.fields.agentType).toBe(6);
});

test("MULTI_MEDIA_TIME resynchronises the client clock", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("main", "multiMediaTime", { time: 999000 });
  await expect
    .poll(() => client.page.evaluate(() => (window as unknown as { harness: { sc: { mm_time: number } } }).harness.sc.mm_time))
    .toBe(999000);
});

test("an unknown message type is logged and framing survives", async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 64, height: 64 });
  await spice.run({ cmd: "raw", channel: "display", hex: "f30100000000" });
  await spice.run({ cmd: "raw", channel: "display", hex: "f401" + "03000000" + "aabbcc" });
  await spice.send("display", "drawFill", { box: { left: 0, top: 0, right: 64, bottom: 64 }, color: 0x00ff00 });
  await client.expectPixel(32, 32, [0, 255, 0]);
  await expect.poll(() => client.messages()).toContainEqual(expect.stringMatching(/Unknown message type 499/));
});

test("DISCONNECTING from the server closes without an error", async ({ client, spice }) => {
  test.fail(true, "the client has no SPICE_MSG_DISCONNECTING handler yet, so the close that follows is reported as unexpected");
  await client.connectReady();
  await spice.send("main", "disconnecting", { reason: 0 });
  await spice.run({ cmd: "close", channel: "main" });
  await expect.poll(async () => (await spice.state()).connections.some((c) => c.channel === "main")).toBe(false);
  await client.page.waitForTimeout(100);
  expect(await client.errors()).toEqual([]);
});

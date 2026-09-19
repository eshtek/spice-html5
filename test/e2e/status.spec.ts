/* What the application can watch: every channel's state changes through
   onstate, the guest's lock keys through onmodifiers, and, opted in, the
   client pressing a lock key so the guest matches the keyboard. */
import { box, expect, test } from "./fixtures";

const seq = (events: Array<{ name: string; state: string }>, name: string) => events.filter((e) => e.name === name).map((e) => e.state);
const keys = (records: Array<{ name: string; fields: Record<string, unknown> }>) => records.filter((r) => r.name.startsWith("key_")).map((r) => [r.name, r.fields.code]);

test.describe("onstate", () => {
  test("a connection walks every channel through the handshake to ready", async ({ client }) => {
    await client.connectReady();
    const events = await client.states();
    expect(seq(events, "main")).toEqual(["connecting", "start", "link", "ticket", "ready"]);
    for (const name of ["display", "inputs", "cursor"]) expect(seq(events, name)).toEqual(["connecting", "start", "link", "ticket", "ready"]);
    expect(events.find((e) => e.name === "display")).toMatchObject({ channel: 2, id: 0 });
  });

  test("the first state reaches onstate only after the constructor has returned", async ({ client }) => {
    const seen = await client.page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const seen: string[] = [];
          const w = window as unknown as { harness: { Spice: { SpiceMainConn: new (o: object) => { stop: () => void } } } };
          let sc: { stop: () => void } | undefined;
          sc = new w.harness.Spice.SpiceMainConn({
            uri: `ws://${location.host}/spice`,
            password: "",
            screen_id: "spice-screen",
            message_id: "message-div",
            onstate(s: { name: string; state: string }) {
              if (s.name === "main" && s.state === "connecting") seen.push(sc ? "after" : "during");
            },
            onsuccess() {
              sc?.stop();
              resolve(seen);
            },
            onerror() {
              resolve(seen);
            },
          });
        }),
    );
    expect(seen).toEqual(["after"]);
  });

  test("stopping the session ends every channel closing then closed", async ({ client }) => {
    await client.connectReady();
    await client.disconnect();
    await expect.poll(async () => seq(await client.states(), "main").slice(-2)).toEqual(["closing", "closed"]);
    const events = await client.states();
    for (const name of ["display", "inputs", "cursor"]) expect(seq(events, name).slice(-2)).toEqual(["closing", "closed"]);
    const closed = events.find((e) => e.name === "main" && e.state === "closed");
    expect(closed?.detail?.code).toBeGreaterThan(0);
  });

  test("a server-side close reports closed with the socket's code", async ({ client, spice }) => {
    await client.connectReady();
    await spice.run({ cmd: "close", channel: "display", code: 4001 });
    await expect.poll(async () => seq(await client.states(), "display").slice(-1)).toEqual(["closed"]);
    const closed = (await client.states()).find((e) => e.name === "display" && e.state === "closed");
    expect(closed?.detail).toMatchObject({ code: 4001 });
    expect(seq(await client.states(), "main").slice(-1)).toEqual(["ready"]);
  });

  test("a bad password ends in error, and closing does not overwrite it", async ({ client, spice }) => {
    await spice.reset({ password: "secret" });
    await expect(client.connect({ password: "wrong" })).rejects.toThrow();
    await expect.poll(async () => (await client.states()).some((e) => e.name === "main" && e.state === "error")).toBe(true);
    await client.page.waitForTimeout(300);
    expect(seq(await client.states(), "main").slice(-1)).toEqual(["error"]);
    expect(await client.channelStates()).toMatchObject({ main: "error" });
  });
});

test.describe("onmodifiers", () => {
  test("the inputs init report and later changes reach the application", async ({ client, spice }) => {
    await client.connectReady();
    await expect.poll(() => client.modifiers()).toHaveLength(1);
    expect((await client.modifiers())[0]).toEqual({ scroll_lock: false, num_lock: false, caps_lock: false, raw: 0 });
    await spice.send("inputs", "keyModifiers", { modifiers: 2 | 4 });
    await expect.poll(() => client.modifiers()).toHaveLength(2);
    expect((await client.modifiers())[1]).toEqual({ scroll_lock: false, num_lock: true, caps_lock: true, raw: 6 });
  });
});

test.describe("sync_lock_keys", () => {
  test("a keystroke from a Num Lock keyboard first turns the guest's on", async ({ client, spice }) => {
    await client.connectReady({ sync_lock_keys: true });
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await expect(client.surface()).toBeVisible();
    const before = await spice.mark();
    await client.pressWithLocks("KeyA", 65, { NumLock: true });
    await spice.waitFor("inputs", "key_up", 2);
    expect(keys(await spice.inbound("inputs", "*", before))).toEqual([
      ["key_down", 0x45],
      ["key_down", 0x1e],
      ["key_up", 0x9e],
      ["key_up", 0xc5],
    ]);
    /* Another keystroke before the guest reports back sends no second press. */
    const again = await spice.mark();
    await client.pressWithLocks("KeyB", 66, { NumLock: true });
    await spice.waitFor("inputs", "key_up", 1, 2000);
    expect(keys(await spice.inbound("inputs", "*", again))).toEqual([
      ["key_down", 0x30],
      ["key_up", 0xb0],
    ]);
    /* The guest confirms; a keyboard that has since turned Num Lock off is
       brought back into line. */
    await spice.send("inputs", "keyModifiers", { modifiers: 2 });
    await expect.poll(() => client.modifiers()).toHaveLength(2);
    const third = await spice.mark();
    await client.pressWithLocks("KeyC", 67, { NumLock: false });
    await spice.waitFor("inputs", "key_up", 2);
    expect(keys(await spice.inbound("inputs", "*", third))[0]).toEqual(["key_down", 0x45]);
  });

  test("pressing a lock key itself is passed through untouched", async ({ client, spice }) => {
    await client.connectReady({ sync_lock_keys: true });
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await expect(client.surface()).toBeVisible();
    const before = await spice.mark();
    /* Num Lock differs too, and still nothing but the Caps Lock press goes. */
    await client.pressWithLocks("CapsLock", 20, { CapsLock: true, NumLock: true });
    await spice.waitFor("inputs", "key_up");
    expect(keys(await spice.inbound("inputs", "*", before))).toEqual([
      ["key_down", 0x3a],
      ["key_up", 0xba],
    ]);
  });

  test("an Apple keyboard, which has no Num Lock, turns the guest's on at the first keypad key", async ({ client, spice }) => {
    await client.connectReady({ sync_lock_keys: true });
    await client.setPlatform("MacIntel");
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await expect(client.surface()).toBeVisible();
    /* The browser reports Num Lock off there whatever the keypad types,
       so an ordinary key leaves a guest that has it on alone. */
    await spice.send("inputs", "keyModifiers", { modifiers: 2 });
    await expect.poll(() => client.modifiers()).toHaveLength(2);
    const before = await spice.mark();
    await client.pressWithLocks("KeyA", 65, { NumLock: false });
    await spice.waitFor("inputs", "key_up");
    expect(keys(await spice.inbound("inputs", "*", before))).toEqual([
      ["key_down", 0x1e],
      ["key_up", 0x9e],
    ]);
    /* With the guest's off, a keypad digit would arrive as End. */
    await spice.send("inputs", "keyModifiers", { modifiers: 0 });
    await expect.poll(() => client.modifiers()).toHaveLength(3);
    const keypad = await spice.mark();
    await client.pressWithLocks("Numpad1", 97, { NumLock: false });
    /* Counted from the connection's start: the A, the 1, the Num Lock. */
    await spice.waitFor("inputs", "key_up", 3);
    expect(keys(await spice.inbound("inputs", "*", keypad))).toEqual([
      ["key_down", 0x45],
      ["key_down", 0x4f],
      ["key_up", 0xcf],
      ["key_up", 0xc5],
    ]);
  });

  test("without the option a mismatch is left alone", async ({ client, spice }) => {
    await client.connectReady();
    await spice.send("display", "surfaceCreate", { width: 320, height: 240 });
    await expect(client.surface()).toBeVisible();
    const before = await spice.mark();
    await client.pressWithLocks("KeyA", 65, { NumLock: true, CapsLock: true });
    await spice.waitFor("inputs", "key_up");
    expect(keys(await spice.inbound("inputs", "*", before))).toEqual([
      ["key_down", 0x1e],
      ["key_up", 0x9e],
    ]);
  });
});

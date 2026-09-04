/* The agent messages beyond clipboard and file transfer: desktop effects
   the application asks the guest to drop, and the guest's mixer level
   reaching the console's audio. */
import { expect, test } from "./fixtures";

const DISPLAY_CONFIG_CAP = 1 << 4;
const AUDIO_VOLUME_SYNC_CAP = 1 << 11;

test.describe("display config", () => {
  test.beforeEach(async ({ spice }) => {
    await spice.reset({ agentConnected: true });
  });

  test("is sent once the agent says it takes it, with the flags asked for", async ({ client, spice }) => {
    await client.connectReady({ disable_effects: ["wallpaper", "font-smooth", "animation"], color_depth: 16 });
    await spice.waitFor("main", "agent_start");
    const [ours] = await spice.waitFor("main", "agent_data");
    expect(ours.fields.agentType).toBe(6);
    expect((ours.fields.caps as number) & AUDIO_VOLUME_SYNC_CAP).toBeTruthy();
    await spice.send("main", "agentAnnounceCapabilities", { caps: DISPLAY_CONFIG_CAP, request: 0 });
    const config = (await spice.waitFor("main", "agent_data", 2)).find((m) => m.fields.agentType === 5);
    expect(config?.fields).toMatchObject({ flags: 0b1111, depth: 16 });
  });

  test("carries only the effects named, and no depth flag without a depth", async ({ client, spice }) => {
    await client.connectReady({ disable_effects: ["animation"] });
    await spice.send("main", "agentAnnounceCapabilities", { caps: DISPLAY_CONFIG_CAP, request: 0 });
    const config = (await spice.waitFor("main", "agent_data", 2)).find((m) => m.fields.agentType === 5);
    expect(config?.fields).toMatchObject({ flags: 0b100, depth: 0 });
  });

  test("is not sent when nothing was asked for", async ({ client, spice }) => {
    await client.connectReady();
    await spice.send("main", "agentAnnounceCapabilities", { caps: DISPLAY_CONFIG_CAP, request: 1 });
    /* The request makes the client re-announce, so a second agent_data
       arrives either way; it must be the announcement, not a config. */
    const [, second] = await spice.waitFor("main", "agent_data", 2);
    expect(second.fields.agentType).toBe(6);
    await client.page.waitForTimeout(200);
    expect((await spice.inbound("main", "agent_data")).filter((m) => m.fields.agentType === 5)).toHaveLength(0);
  });

  test("is not sent to an agent without the capability", async ({ client, spice }) => {
    await client.connectReady({ disable_effects: ["wallpaper"] });
    await spice.send("main", "agentAnnounceCapabilities", { caps: 0, request: 1 });
    const [, second] = await spice.waitFor("main", "agent_data", 2);
    expect(second.fields.agentType).toBe(6);
    await client.page.waitForTimeout(200);
    expect((await spice.inbound("main", "agent_data")).filter((m) => m.fields.agentType === 5)).toHaveLength(0);
  });

  test("an unknown effect name is ignored with a warning", async ({ client, spice }) => {
    await client.connectReady({ disable_effects: ["wallpaper", "bling"] });
    await spice.send("main", "agentAnnounceCapabilities", { caps: DISPLAY_CONFIG_CAP, request: 0 });
    const config = (await spice.waitFor("main", "agent_data", 2)).find((m) => m.fields.agentType === 5);
    expect(config?.fields).toMatchObject({ flags: 0b1 });
    expect((await client.messages()).filter((m) => /unknown disable_effects/i.test(m))).toHaveLength(1);
  });
});

test.describe("volume sync", () => {
  test("the guest's playback level reaches the application and the playback channel", async ({ client, spice }) => {
    await spice.reset({ agentConnected: true, channels: [{ type: 2, id: 0 }, { type: 3, id: 0 }, { type: 4, id: 0 }, { type: 5, id: 0 }] });
    await client.connectReady({ channels: ["display", "inputs", "cursor", "playback"] });
    await spice.send("main", "agentAudioVolumeSync", { playback: true, mute: false, volumes: [32768, 32768] });
    await expect.poll(() => client.volumes()).toHaveLength(1);
    const [v] = await client.volumes();
    expect(v).toMatchObject({ playback: true, mute: false, volumes: [32768, 32768] });
    expect(v.level).toBeCloseTo(0.5, 2);
    const stored = await client.page.evaluate(() => (window as unknown as { harness: { sc: { playback_volume: { mute: boolean; level: number } } } }).harness.sc.playback_volume);
    expect(stored.mute).toBe(false);
    expect(stored.level).toBeCloseTo(0.5, 2);
    await spice.send("main", "agentAudioVolumeSync", { playback: true, mute: true, volumes: [65535] });
    await expect.poll(() => client.volumes()).toHaveLength(2);
    expect((await client.volumes())[1]).toMatchObject({ mute: true, level: 1 });
  });

  test("a record-side report is passed on but does not touch playback", async ({ client, spice }) => {
    await spice.reset({ agentConnected: true });
    await client.connectReady();
    await spice.send("main", "agentAudioVolumeSync", { playback: false, mute: false, volumes: [1000] });
    await expect.poll(() => client.volumes()).toHaveLength(1);
    expect((await client.volumes())[0].playback).toBe(false);
    const stored = await client.page.evaluate(() => (window as unknown as { harness: { sc: { playback_volume?: unknown } } }).harness.sc.playback_volume);
    expect(stored).toBeUndefined();
    expect((await client.messages()).filter((m) => /Unknown|unhandled/i.test(m))).toEqual([]);
  });
});

/* The WebCodecs playback path, driven without real audio: what the
   client does with the control messages and with data it cannot decode. */
import { expect, test } from "./fixtures";

const AUDIO_CHANNELS = [
  { type: 2, id: 0 },
  { type: 3, id: 0 },
  { type: 4, id: 0 },
  { type: 5, id: 0 },
];

test.beforeEach(async ({ client, spice }) => {
  await spice.reset({ channels: AUDIO_CHANNELS });
  await client.connectReady({ channels: ["display", "inputs", "cursor", "playback"] });
  const webcodecs = await client.page.evaluate(() => "AudioDecoder" in window);
  test.skip(!webcodecs, "no WebCodecs in this browser");
});

test("data in a mode the player refused is dropped, not decoded as opus", async ({ client, spice }) => {
  await spice.send("playback", "playbackStart", { channels: 2, frequency: 48000, time: "now" });
  /* CELT (mode 2) is what an old server negotiates; the player declines it. */
  await spice.send("playback", "playbackMode", { time: "now", mode: 2 });
  for (let i = 0; i < 30; i++) await spice.send("playback", "playbackData", { time: "now", dataHex: "ff".repeat(40) });
  await expect.poll(() => client.messages()).toContainEqual(expect.stringMatching(/cannot handle mode 2/));
  await client.page.waitForTimeout(300);
  const decodeErrors = (await client.messages()).filter((m) => /Opus decode failed/.test(m));
  expect(decodeErrors).toEqual([]);
  expect(client.pageErrors).toEqual([]);
});

test("a decoder that fails is not rebuilt for every packet", async ({ client, spice }) => {
  await spice.send("playback", "playbackStart", { channels: 2, frequency: 48000, time: "now" });
  await spice.send("playback", "playbackMode", { time: "now", mode: 3 });
  /* Not opus: every packet fails to decode. Paced like a real stream, so
     each packet meets the decoder after the previous failure has landed
     (a burst is discarded wholesale by the closed decoder). One report,
     not one per packet. */
  const steps: Parameters<typeof spice.run> = [];
  for (let i = 0; i < 30; i++) {
    steps.push({ cmd: "send", channel: "playback", msg: "playbackData", args: { time: "now", dataHex: "ff".repeat(40) } });
    steps.push({ cmd: "wait", ms: 15 });
  }
  await spice.run(...steps);
  await expect.poll(() => client.messages().then((ms) => ms.filter((m) => /Opus decode failed/.test(m)).length)).toBeGreaterThan(0);
  await client.page.waitForTimeout(300);
  const decodeErrors = (await client.messages()).filter((m) => /Opus decode failed/.test(m));
  expect(decodeErrors.length).toBeLessThanOrEqual(1);
  expect(client.pageErrors).toEqual([]);
});

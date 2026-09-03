/* Streams decoded by a WebCodecs VideoDecoder (VP8, VP9, H.264) and
   drawn into the surface through the draw queue. The frames are encoded
   in the page by VideoEncoder, so the suite carries no binary fixtures;
   H.264 is asked for in Annex B, the format spice-server's x264 emits. */
import { PALETTE, QUADRANT, type RGB, box, expect, test } from "./fixtures";

const CODECS = [
  { name: "VP8", type: 2, codec: "vp8" },
  { name: "VP9", type: 4, codec: "vp09.00.10.08" },
  { name: "H.264", type: 3, codec: "avc1.42E01E" },
] as const;

/* Quadrant frames like the fake server's MJPEG ones: top-left cycles the
   palette, the other three quadrants are fixed. Flipped frames carry
   their rows bottom-up, the way a stream without TOP_DOWN does. */
async function encodeFrames(page: import("@playwright/test").Page, o: { codec: string; width: number; height: number; frames: number; flip?: boolean; frameOffset?: number }) {
  return page.evaluate(
    async ({ codec, width, height, frames, flip, frameOffset, palette, quadrant }) => {
      const out: string[] = [];
      const enc = new VideoEncoder({
        output: (c) => {
          const b = new Uint8Array(c.byteLength);
          c.copyTo(b);
          let s = "";
          for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
          out.push(btoa(s));
        },
        error: (e) => {
          throw e;
        },
      });
      const cfg: VideoEncoderConfig = { codec, width, height, bitrate: 4_000_000, framerate: 30, latencyMode: "realtime" };
      if (codec.startsWith("avc1")) cfg.avc = { format: "annexb" };
      enc.configure(cfg);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
      for (let i = 0; i < frames; i++) {
        const tl = palette[(i + (frameOffset ?? 0)) % palette.length];
        const q = [
          [tl, quadrant.topRight],
          [quadrant.bottomLeft, quadrant.bottomRight],
        ];
        for (let r = 0; r < 2; r++)
          for (let c = 0; c < 2; c++) {
            const row = flip ? 1 - r : r;
            ctx.fillStyle = rgb(q[row][c]);
            ctx.fillRect(c * (width / 2), r * (height / 2), width / 2, height / 2);
          }
        const frame = new VideoFrame(canvas, { timestamp: i * 33333 });
        enc.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      await enc.flush();
      enc.close();
      return out;
    },
    { ...o, palette: PALETTE as unknown as number[][], quadrant: QUADRANT as unknown as Record<string, number[]> },
  );
}

/* 4:2:0 chroma subsampling and limited-range YUV cost saturated primaries
   up to ~40 per channel; the background is >150 away. */
const tol = 48;
const grey: RGB = [32, 32, 32];

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, grey);
});

test("the display channel advertises VP8, H.264 and VP9 decoding", async ({ spice }) => {
  const display = (await spice.state()).connections.find((c) => c.channel === "display");
  const caps = display?.channelCaps[0] ?? 0;
  expect(caps & (1 << 10), "VP8").toBeTruthy();
  expect(caps & (1 << 11), "H264").toBeTruthy();
  expect(caps & (1 << 13), "VP9").toBeTruthy();
});

for (const c of CODECS) {
  test(`a ${c.name} stream decodes and paints at its destination`, async ({ client, spice }) => {
    const frames64 = await encodeFrames(client.page, { codec: c.codec, width: 160, height: 120, frames: 5 });
    await spice.run({ cmd: "stream", args: { id: 0, codec: c.type, frames: 5, fps: 30, width: 160, height: 120, dest: { left: 100, top: 100 }, frames64 } });
    await client.expectPixel(140, 130, PALETTE[4], tol);
    await client.expectPixel(220, 130, QUADRANT.topRight, tol);
    await client.expectPixel(140, 190, QUADRANT.bottomLeft, tol);
    await client.expectPixel(220, 190, QUADRANT.bottomRight, tol);
    await client.expectPixelStays(50, 50, grey);
    expect(await client.errors()).toEqual([]);
    expect((await client.messages()).filter((m) => /decoder|failed|Skipping/i.test(m))).toEqual([]);
    expect((await client.counters()).videos).toBe(0);
  });
}

test("a bottom-up VP8 stream is flipped upright", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 160, height: 120, frames: 2, flip: true });
  await spice.run({ cmd: "stream", args: { id: 0, codec: 2, frames: 2, fps: 30, width: 160, height: 120, dest: { left: 0, top: 0 }, flags: 0, frames64 } });
  await client.expectPixel(40, 30, PALETTE[1], tol);
  await client.expectPixel(40, 90, QUADRANT.bottomLeft, tol);
});

test("a decoded stream honours its clip rects", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 160, height: 120, frames: 3 });
  await spice.run({
    cmd: "stream",
    args: { id: 0, codec: 2, frames: 3, fps: 30, width: 160, height: 120, dest: { left: 100, top: 100 }, clip: { type: "rects", rects: [box(100, 100, 160, 60)] }, frames64 },
  });
  await client.expectPixel(140, 130, PALETTE[2], tol);
  await client.expectPixelStays(140, 190, grey);
});

test("sized frames paint at their own destination", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 80, height: 60, frames: 2 });
  await spice.run({ cmd: "stream", args: { id: 1, codec: 2, frames: 2, fps: 30, width: 80, height: 60, dest: { left: 400, top: 300 }, sized: true, frames64 } });
  await client.expectPixel(420, 315, PALETTE[1], tol);
  await client.expectPixel(460, 345, QUADRANT.bottomRight, tol);
});

test("inter frames before the first key frame are dropped, not decoded", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 160, height: 120, frames: 4 });
  /* Frames 1-3 depend on frame 0; sending them first must draw nothing
     and raise nothing, and the key frame that follows must still paint. */
  await spice.run({ cmd: "stream", args: { id: 0, codec: 2, frames: 3, fps: 60, width: 160, height: 120, dest: { left: 100, top: 100 }, frames64: frames64.slice(1) } });
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255]);
  await client.expectPixelStays(140, 130, grey);
  await spice.run({ cmd: "stream", args: { id: 0, create: false, frames: 1, fps: 60, width: 160, height: 120, dest: { left: 100, top: 100 }, frames64: frames64.slice(0, 1) } });
  await client.expectPixel(140, 130, PALETTE[0], tol);
  expect(await client.errors()).toEqual([]);
  expect((await client.messages()).filter((m) => /decoder|failed|Skipping/i.test(m))).toEqual([]);
});

test("a fill sent after a stream frame lands on top of it", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 160, height: 120, frames: 2 });
  await spice.run(
    { cmd: "stream", args: { id: 0, codec: 2, frames: 2, fps: 1000, width: 160, height: 120, dest: { left: 100, top: 100 }, frames64 } },
    { cmd: "send", channel: "display", msg: "drawFill", args: { box: box(100, 100, 160, 120), color: 0x00ff00 } },
  );
  await client.expectPixel(140, 130, [0, 255, 0]);
  await client.expectPixelStays(140, 130, [0, 255, 0]);
});

test("destroying the stream closes its decoder and frees the slot", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 64, height: 64, frames: 2 });
  await spice.run({ cmd: "stream", args: { id: 3, codec: 2, frames: 2, fps: 30, width: 64, height: 64, destroy: true, frames64 } });
  await expect
    .poll(() => client.page.evaluate(() => Boolean((window as unknown as { harness: { sc: { display: { streams?: unknown[] } } } }).harness.sc.display.streams?.[3])))
    .toBe(false);
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255]);
  expect(await client.errors()).toEqual([]);
});

test("stream reports count decoded frames", async ({ client, spice }) => {
  const frames64 = await encodeFrames(client.page, { codec: "vp8", width: 64, height: 64, frames: 5 });
  await spice.send("display", "streamCreate", { id: 2, codec: 2, width: 64, height: 64, dest: box(0, 0, 64, 64) });
  await spice.send("display", "streamActivateReport", { id: 2, uniqueId: 77, maxWindow: 3, timeoutMs: 600000 });
  await spice.run({ cmd: "stream", args: { id: 2, codec: 2, create: false, frames: 5, fps: 30, width: 64, height: 64, frames64 } });
  const [report] = await spice.waitFor("display", "stream_report");
  expect(report.fields).toMatchObject({ streamId: 2, uniqueId: 77 });
  expect(report.fields.numFrames as number).toBeGreaterThanOrEqual(4);
});

test("a stream the decoder cannot take makes the client ask for MJPEG instead", async ({ client, spice }) => {
  /* Bytes that pass the H.264 key-frame check (an IDR start code) but
     are not a decodable frame: the decoder errors, the client strikes
     H.264 off, tells the server its new preference, and later draws
     still land. */
  const bogus = Buffer.from([0, 0, 0, 1, 0x67, 0xff, 0xff, 0, 0, 0, 1, 0x65, 0xff, 0xff, 0xff, 0xff]).toString("base64");
  const since = await spice.mark();
  await spice.run({ cmd: "stream", args: { id: 0, codec: 3, frames: 3, fps: 60, width: 160, height: 120, dest: { left: 100, top: 100 }, frames64: [bogus] } });
  const [pref] = await spice.waitFor("display", "preferred_video_codec_type");
  expect(pref.seq).toBeGreaterThan(since);
  expect((pref.fields.codecs as number[])[0]).toBe(1);
  expect(pref.fields.codecs as number[]).not.toContain(3);
  await spice.send("display", "drawFill", { box: box(0, 0, 8, 8), color: 0xffffff });
  await client.expectPixel(4, 4, [255, 255, 255]);
  expect(await client.errors()).toEqual([]);
  /* Chromium's decoder errors; Firefox's takes the frame and never
     outputs, which the queue's stale check reports before giving up. */
  expect((await client.messages()).filter((m) => /decoder .* failed|Skipping a draw/.test(m)).length).toBeGreaterThan(0);
});

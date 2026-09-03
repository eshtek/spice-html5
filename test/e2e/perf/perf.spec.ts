/* Browser-side cost of fixed workloads, measured over CDP (Chromium only).
   The fake server replays the same bytes on the same schedule every run,
   so the numbers are comparable across commits. Results always land in
   perf/results/; a baseline in perf/baselines.json turns them into a gate.
   PERF_UPDATE_BASELINES=1 rewrites the baseline from this run. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession } from "@playwright/test";
import { type Counters, type SpiceClient, type SpiceControl, box, expect, test } from "../fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "baselines.json");
const RESULTS = join(HERE, "results");

interface Sample {
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  heapDeltaMB: number;
  longTasks: number;
  longTaskMs: number;
  images: number;
  canvases: number;
  urlsLeaked: number;
  wallMs: number;
  puts: number;
  putMPx: number;
  draws: number;
  gets: number;
}

type Baselines = Record<string, Partial<Sample>>;

/* Metrics where higher is worse and a relative gate makes sense. A sample
   may exceed its baseline by TOLERANCE plus the metric's noise floor: the
   floor keeps sub-100 ms baselines from failing on scheduler jitter, and
   it is what makes the gate loose in absolute terms for small workloads. */
const GATED: Array<keyof Sample> = ["taskMs", "scriptMs", "heapDeltaMB", "longTaskMs"];
const TOLERANCE = 0.25;
const NOISE_FLOOR: Partial<Record<keyof Sample, number>> = { taskMs: 50, scriptMs: 50, longTaskMs: 50, heapDeltaMB: 2 };

function loadBaselines(): Baselines {
  try {
    return JSON.parse(readFileSync(BASELINES, "utf8"));
  } catch {
    return {};
  }
}

async function metrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { task: get("TaskDuration") * 1000, script: get("ScriptDuration") * 1000, layout: get("LayoutDuration") * 1000, heap: get("JSHeapUsedSize") };
}

async function measure(page: import("@playwright/test").Page, cdp: CDPSession, work: () => Promise<void>, counters: () => Promise<Counters>): Promise<Sample> {
  await cdp.send("HeapProfiler.collectGarbage");
  const c0 = await counters();
  const m0 = await metrics(cdp);
  const t0 = Date.now();
  await work();
  const wallMs = Date.now() - t0;
  await page.waitForTimeout(250);
  await cdp.send("HeapProfiler.collectGarbage");
  const m1 = await metrics(cdp);
  const c1 = await counters();
  return {
    taskMs: Math.round(m1.task - m0.task),
    scriptMs: Math.round(m1.script - m0.script),
    layoutMs: Math.round(m1.layout - m0.layout),
    heapDeltaMB: Math.round(((m1.heap - m0.heap) / 1048576) * 100) / 100,
    longTasks: c1.longTasks - c0.longTasks,
    longTaskMs: Math.round(c1.longTaskMs - c0.longTaskMs),
    images: c1.images - c0.images,
    canvases: c1.canvases - c0.canvases,
    urlsLeaked: c1.objectUrlsCreated - c1.objectUrlsRevoked,
    wallMs,
    puts: c1.putImageData - c0.putImageData,
    putMPx: Math.round((c1.putPixels - c0.putPixels) / 1e5) / 10,
    draws: c1.drawImage - c0.drawImage,
    gets: c1.getImageData - c0.getImageData,
  };
}

function record(name: string, sample: Sample) {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), ...sample }, null, 2));
  console.log(`perf ${name}: ${JSON.stringify(sample)}`);
  const baselines = loadBaselines();
  if (process.env.PERF_UPDATE_BASELINES) {
    baselines[name] = Object.fromEntries(GATED.map((k) => [k, sample[k]]));
    writeFileSync(BASELINES, `${JSON.stringify(baselines, null, 2)}\n`);
    return;
  }
  const base = baselines[name];
  if (!base) {
    console.log(`perf ${name}: no baseline; run with PERF_UPDATE_BASELINES=1 to set one`);
    return;
  }
  for (const k of GATED) {
    const want = base[k];
    if (typeof want !== "number") continue;
    const limit = want * (1 + TOLERANCE) + (NOISE_FLOOR[k] ?? 0);
    expect.soft(sample[k], `${name}.${k} regressed: ${sample[k]} vs baseline ${want} (limit ${limit})`).toBeLessThanOrEqual(limit);
  }
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ client, spice }) => {
  await client.connectReady();
  await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
  await spice.send("display", "drawFill", { box: box(0, 0, 640, 480), color: 0x202020 });
  await client.expectPixel(5, 5, [32, 32, 32]);
  /* Warm-up: first JPEG decode and first canvas ops carry one-time costs. */
  await spice.run({ cmd: "stream", args: { id: 7, frames: 10, fps: 60, width: 160, height: 120, destroy: true } });
  await client.page.waitForTimeout(200);
});

test("mjpeg 640x480 @30fps for 5s", async ({ client, spice }) => {
  const cdp = await client.page.context().newCDPSession(client.page);
  await cdp.send("Performance.enable");
  const sample = await measure(
    client.page,
    cdp,
    async () => {
      await spice.run({ cmd: "stream", args: { id: 0, frames: 150, fps: 30, width: 640, height: 480, destroy: true } });
    },
    () => client.counters(),
  );
  expect(sample.images).toBeGreaterThanOrEqual(140);
  expect(sample.urlsLeaked).toBe(0);
  record("mjpeg-640x480-30fps-5s", sample);
});

test("mjpeg 320x240 @60fps for 5s", async ({ client, spice }) => {
  const cdp = await client.page.context().newCDPSession(client.page);
  await cdp.send("Performance.enable");
  const sample = await measure(
    client.page,
    cdp,
    async () => {
      await spice.run({ cmd: "stream", args: { id: 0, frames: 300, fps: 60, width: 320, height: 240, destroy: true } });
    },
    () => client.counters(),
  );
  expect(sample.urlsLeaked).toBe(0);
  record("mjpeg-320x240-60fps-5s", sample);
});

test("500 bitmap draw copies of 128x128", async ({ client, spice }) => {
  const cdp = await client.page.context().newCDPSession(client.page);
  await cdp.send("Performance.enable");
  const sample = await measure(
    client.page,
    cdp,
    async () => {
      await spice.run({ cmd: "drawBurst", args: { count: 500, size: 128, seed: 5 } });
      await spice.send("display", "drawFill", { box: box(0, 0, 4, 4), color: 0xffffff });
      await client.expectPixel(1, 1, [255, 255, 255]);
    },
    () => client.counters(),
  );
  expect(sample.urlsLeaked).toBe(0);
  record("bitmap-burst-500x128", sample);
});

test("300 jpeg draw copies of 128x128", async ({ client, spice }) => {
  const cdp = await client.page.context().newCDPSession(client.page);
  await cdp.send("Performance.enable");
  const sample = await measure(
    client.page,
    cdp,
    async () => {
      await spice.run({ cmd: "drawBurst", args: { count: 300, size: 128, seed: 9, jpeg: true } });
      await spice.send("display", "drawFill", { box: box(0, 0, 4, 4), color: 0xffffff });
      await client.expectPixel(1, 1, [255, 255, 255]);
      await expect.poll(() => client.counters().then((c) => c.objectUrlsCreated - c.objectUrlsRevoked)).toBe(0);
    },
    () => client.counters(),
  );
  expect(sample.urlsLeaked).toBe(0);
  record("jpeg-burst-300x128", sample);
});

/* The 128x128 bursts above never leave the noise floor: at desktop sizes the
   per-pixel conversion and the clipped/alpha scratch-canvas path are what
   a drag or a full repaint pays for. Each burst ends with a fill the client
   must have processed after every draw. */
async function burst(client: SpiceClient, spice: SpiceControl, args: Record<string, unknown>) {
  const d0 = await drawCount(client);
  await spice.run({ cmd: "drawBurst", args: { count: 1, size: 1, ...args } });
  /* Every draw must reach the canvas: a dropped or skipped message would
     read as a faster client. The count is the marker, not a pixel: a
     draw can leave any pixel any colour. */
  const count = Number(args.count) * (1 + Number(args.cacheRedraws ?? 0));
  await expect.poll(() => drawCount(client).then((d) => d - d0), { timeout: 60_000 }).toBe(count);
  expect((await spice.state()).connections.find((c) => c.channel === "display")?.dropped).toBe(0);
}
/* draw_count on surface 0, from the connection page.html exposes. */
function drawCount(client: SpiceClient) {
  return client.page.evaluate(() => (window as any).harness.sc.display.surfaces[0].draw_count as number);
}

async function bigSurface(client: SpiceClient, spice: SpiceControl, format?: number) {
  await spice.send("display", "surfaceDestroy", { id: 0 });
  await spice.send("display", "surfaceCreate", { width: 1400, height: 800, format });
  await spice.send("display", "drawFill", { box: box(0, 0, 1400, 800), color: 0x202020 });
  await client.expectPixel(5, 5, [32, 32, 32]);
}

for (const [name, args, surfaceFormat] of [
  ["bitmap-large-60x1280x720", { count: 60, width: 1280, height: 720, seed: 11, surfaceWidth: 1400, surfaceHeight: 800 }, undefined],
  ["bitmap-large-bottomup-60x1280x720", { count: 60, width: 1280, height: 720, seed: 11, bottomUp: true, surfaceWidth: 1400, surfaceHeight: 800 }, undefined],
  ["bitmap-clipped-300x256", { count: 300, size: 256, seed: 13, clipRects: 3, surfaceWidth: 1400, surfaceHeight: 800 }, undefined],
  ["bitmap-rgba-on-argb-100x512", { count: 100, size: 512, seed: 17, rgba: true, surfaceWidth: 1400, surfaceHeight: 800 }, 96],
  ["bitmap-cache-redraw-50x256x10", { count: 50, size: 256, seed: 19, cacheRedraws: 10, surfaceWidth: 1400, surfaceHeight: 800 }, undefined],
  ["bitmap-cache-redraw-clipped-50x256x10", { count: 50, size: 256, seed: 23, cacheRedraws: 10, clipRects: 2, surfaceWidth: 1400, surfaceHeight: 800 }, undefined],
] as const) {
  test(name, async ({ client, spice }) => {
    await bigSurface(client, spice, surfaceFormat);
    const cdp = await client.page.context().newCDPSession(client.page);
    await cdp.send("Performance.enable");
    const sample = await measure(client.page, cdp, () => burst(client, spice, { ...args }), () => client.counters());
    expect(sample.urlsLeaked).toBe(0);
    expect(await client.errors()).toEqual([]);
    record(name, sample);
  });
}

/* Self time by function over the goldeye Windows 11 replay (real LZ and
   QUIC payloads) and over the large bitmap burst, from the V8 sampling
   profiler. Written next to the samples; printed so a run's hot list is in
   the log. */
async function profile(page: import("@playwright/test").Page, cdp: CDPSession, name: string, work: () => Promise<void>) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  await work();
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map<string, number>();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const deltas = profile.timeDeltas ?? [];
  const samples = profile.samples ?? [];
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    if (!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1}`;
    const dt = (deltas[i] ?? 0) / 1000;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: Math.round((1000 * ms) / total) / 10 }));
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `profile-${name}.json`), JSON.stringify({ at: new Date().toISOString(), totalMs: Math.round(total), top }, null, 2));
  console.log(`profile ${name} (${Math.round(total)} ms sampled):\n` + top.map((t) => `  ${String(t.pct).padStart(5)}%  ${String(t.ms).padStart(6)} ms  ${t.fn}`).join("\n"));
}

test("profile: large bitmap burst", async ({ client, spice }) => {
  await bigSurface(client, spice);
  const cdp = await client.page.context().newCDPSession(client.page);
  await profile(client.page, cdp, "bitmap-large", () => burst(client, spice, { count: 60, width: 1280, height: 720, seed: 11, surfaceWidth: 1400, surfaceHeight: 800 }));
  await profile(client.page, cdp, "bitmap-clipped", () => burst(client, spice, { count: 300, size: 256, seed: 13, clipRects: 3, surfaceWidth: 1400, surfaceHeight: 800 }));
});

test("profile: goldeye win11 replay", async ({ client, spice }) => {
  await client.disconnect();
  await spice.reset({ replay: "fixtures/goldeye-win11-idle.rec.json" });
  const cdp = await client.page.context().newCDPSession(client.page);
  await profile(client.page, cdp, "replay-win11", async () => {
    await client.connectReady({ channels: ["display", "inputs", "cursor", "playback", "record"] });
    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const c = document.getElementById("spice_surface_0") as HTMLCanvasElement | null;
            if (!c) return 0;
            const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
            let lit = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
            return Math.round((100 * lit) / (c.width * c.height));
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(95);
  });
});

test("20 connect/disconnect cycles hold the heap flat", async ({ client, spice }) => {
  const cdp = await client.page.context().newCDPSession(client.page);
  await cdp.send("Performance.enable");
  await client.disconnect();
  const sample = await measure(
    client.page,
    cdp,
    async () => {
      for (let i = 0; i < 20; i++) {
        await client.connectReady();
        await spice.send("display", "surfaceCreate", { width: 640, height: 480 });
        await spice.run({ cmd: "stream", args: { id: 0, frames: 5, fps: 60, width: 160, height: 120, destroy: true } });
        await client.disconnect();
        await expect.poll(async () => (await spice.state()).connections.length).toBe(0);
      }
    },
    () => client.counters(),
  );
  expect(sample.urlsLeaked).toBe(0);
  expect(sample.heapDeltaMB).toBeLessThan(8);
  record("connect-cycles-20", sample);
});

/* Playwright fixtures: a Bun-hosted fake SPICE server per worker (driven
   over its HTTP control API) and a page wrapper around test/e2e/page.html.
   Playwright runs under Node, so the server is a subprocess, not an import. */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
/* Type-only imports are erased, so the server's types are shared without
   the Node-hosted runner ever loading Bun-only modules. */
import type { ImageSpec, RGB } from "../server/frames";
import type { InboundRecord, ServerConfig, Step } from "../server/server";
import type { Clip, Rect } from "../server/wire";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEST_ROOT = join(HERE, "..");

export { PALETTE, QUADRANT, frameColor } from "../server/frames";
export type { Clip, ImageSpec, Rect, RGB, Step };
export type Inbound = InboundRecord;
export type ResetOptions = Partial<ServerConfig>;

export function box(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height };
}

export class SpiceControl {
  constructor(
    readonly port: number,
    private readonly proc: ChildProcess,
  ) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.port}/spice`;
  }

  private async call<T>(action: string, body?: unknown, query = ""): Promise<T> {
    const res = await fetch(`${this.baseUrl}/__control/${action}${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`control ${action}: ${data.error ?? res.status}`);
    return data;
  }

  reset(opts: ResetOptions = {}) {
    return this.call<{ ok: true }>("reset", opts);
  }

  run(...steps: Step[]) {
    return this.call<{ ok: true }>("run", { steps });
  }

  send(channel: string, msg: string, args: Record<string, unknown> = {}) {
    return this.run({ cmd: "send", channel, msg, args });
  }

  state() {
    return this.call<{
      mmNow: number;
      inboundCount: number;
      connections: Array<{ channel: string; channelId: number; state: string; messagesIn: number; messagesOut: number; bytesOut: number; dropped: number; channelCaps: number[] }>;
      log: string[];
    }>("state");
  }

  inbound(channel = "*", name = "*", since = -1) {
    return this.call<Inbound[]>("inbound", undefined, `?channel=${channel}&name=${name}&since=${since}`);
  }

  /* The seq of the newest inbound record, for `inbound(..., since)`. */
  async mark() {
    return (await this.state()).inboundCount - 1;
  }

  waitFor(channel: string, name: string, count = 1, timeoutMs = 5000) {
    return this.call<Inbound[]>("waitFor", { channel, name, count, timeoutMs });
  }

  async mmNow() {
    return (await this.call<{ mmNow: number }>("mm")).mmNow;
  }

  close() {
    this.proc.kill();
  }
}

export async function startServer(): Promise<SpiceControl> {
  const proc = spawn("bun", [join(TEST_ROOT, "server", "cli.ts"), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("fake server did not start")), 10_000);
    proc.stdout!.on("data", (d) => {
      out += String(d);
      const m = out.match(/SPICE_FAKE_PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake server exited (${code}) before listening: ${out}`));
    });
  });
  return new SpiceControl(port, proc);
}

/* Per-viewer instrumentation, installed before the page's own scripts so
   the client under test needs no hooks. Counts what teardown must reclaim. */
export const COUNTER_SCRIPT = `
(() => {
  const c = { objectUrlsCreated: 0, objectUrlsRevoked: 0, canvases: 0, images: 0, websockets: 0, audioContexts: 0, longTasks: 0, longTaskMs: 0, videos: 0, pasteListeners: 0, putImageData: 0, putPixels: 0, drawImage: 0, getImageData: 0, getPixels: 0, wsMessages: 0, wsBytes: 0 };
  window.__counters = c;
  const addL = document.addEventListener.bind(document), removeL = document.removeEventListener.bind(document);
  document.addEventListener = (t, fn, o) => { if (t === 'paste') c.pasteListeners++; return addL(t, fn, o); };
  document.removeEventListener = (t, fn, o) => { if (t === 'paste') c.pasteListeners--; return removeL(t, fn, o); };
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { c.objectUrlsCreated++; return create(b); };
  URL.revokeObjectURL = (u) => { c.objectUrlsRevoked++; return revoke(u); };
  const createElement = document.createElement.bind(document);
  document.createElement = function (tag, opts) {
    const t = String(tag).toLowerCase();
    if (t === 'canvas') c.canvases++;
    if (t === 'video') c.videos++;
    if (t === 'img') c.images++;
    return createElement(tag, opts);
  };
  const Img = window.Image;
  window.Image = function (w, h) { c.images++; return new Img(w, h); };
  window.Image.prototype = Img.prototype;
  const WS = window.WebSocket;
  window.WebSocket = function (url, proto) { c.websockets++; const ws = new WS(url, proto); ws.addEventListener('message', (e) => { c.wsMessages++; c.wsBytes += (e.data && (e.data.byteLength || e.data.size)) || 0; }); return ws; };
  window.WebSocket.prototype = WS.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
  if (window.AudioContext) {
    const AC = window.AudioContext;
    window.AudioContext = function (o) { c.audioContexts++; return new AC(o); };
    window.AudioContext.prototype = AC.prototype;
  }
  const P = CanvasRenderingContext2D.prototype;
  const put = P.putImageData, draw = P.drawImage, get = P.getImageData;
  P.putImageData = function (d, x, y, dx, dy, dw, dh) { c.putImageData++; c.putPixels += (dw === undefined ? d.width * d.height : Math.abs(dw * dh)); return arguments.length > 3 ? put.call(this, d, x, y, dx, dy, dw, dh) : put.call(this, d, x, y); };
  P.drawImage = function (...a) { c.drawImage++; return draw.apply(this, a); };
  P.getImageData = function (x, y, w, h, o) { c.getImageData++; c.getPixels += w * h; return get.call(this, x, y, w, h, o); };
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) { c.longTasks++; c.longTaskMs += e.duration; } }).observe({ entryTypes: ['longtask'] });
    } catch {}
  }
})();
`;

export interface Counters {
  objectUrlsCreated: number;
  objectUrlsRevoked: number;
  canvases: number;
  images: number;
  websockets: number;
  audioContexts: number;
  longTasks: number;
  longTaskMs: number;
  videos: number;
  /* Document-level paste listeners currently registered. */
  pasteListeners: number;
  /* 2D canvas traffic: calls and the pixels they carried. */
  putImageData: number;
  putPixels: number;
  drawImage: number;
  getImageData: number;
  getPixels: number;
  /* WebSocket messages delivered to the page, and their bytes. */
  wsMessages: number;
  wsBytes: number;
}

export class SpiceClient {
  /* Uncaught exceptions in the page: the client must never throw out of
     a websocket, image or timer callback, whatever the session state. */
  readonly pageErrors: string[] = [];

  constructor(
    readonly page: Page,
    readonly spice: SpiceControl,
  ) {
    page.on("pageerror", (e) => this.pageErrors.push(e.message));
  }

  async open() {
    await this.page.goto(`${this.spice.baseUrl}/page.html`);
    await this.page.waitForFunction(() => Boolean((window as unknown as { harness?: unknown }).harness));
  }

  /* Resolves with the onsuccess payload, rejects with the onerror message. */
  connect(opts: { password?: string; uri?: string } = {}) {
    return this.page.evaluate((o) => (window as unknown as { harness: { connect: (o: unknown) => Promise<string> } }).harness.connect(o), opts);
  }

  /* Connects and waits until every default child channel is ready. */
  async connectReady(opts: { password?: string; channels?: string[] } = {}) {
    await this.connect({ password: opts.password });
    const channels = opts.channels ?? ["display", "inputs", "cursor"];
    await this.page.waitForFunction(
      (names) => {
        const h = (window as unknown as { harness: { channelStates: () => Record<string, string> | null } }).harness;
        const s = h.channelStates();
        return Boolean(s) && names.every((n) => s![n] === "ready");
      },
      channels,
      { timeout: 5000 },
    );
  }

  disconnect() {
    return this.page.evaluate(() => (window as unknown as { harness: { disconnect: () => void } }).harness.disconnect());
  }

  errors() {
    return this.page.evaluate(() => (window as unknown as { harness: { errors: string[] } }).harness.errors);
  }

  channelStates() {
    return this.page.evaluate(() => (window as unknown as { harness: { channelStates: () => Record<string, string> | null } }).harness.channelStates());
  }

  messages() {
    return this.page.evaluate(() => (window as unknown as { harness: { messages: () => string[] } }).harness.messages());
  }

  pixel(x: number, y: number, surface = 0): Promise<RGB | null> {
    return this.page.evaluate(
      ([x, y, s]) => (window as unknown as { harness: { pixel: (x: number, y: number, s: number) => RGB | null } }).harness.pixel(x, y, s),
      [x, y, surface] as const,
    );
  }

  /* Waits for a pixel to reach a colour, tolerating codec error. */
  async expectPixel(x: number, y: number, rgb: RGB, tolerance = 8, timeout = 5000) {
    await expect
      .poll(async () => this.pixel(x, y), { timeout, message: `pixel (${x},${y}) to be ${rgb}` })
      .toEqual(expect.arrayContaining([expect.anything()]));
    await expect
      .poll(
        async () => {
          const p = await this.pixel(x, y);
          if (!p) return null;
          const off = Math.max(...p.map((v, i) => Math.abs(v - rgb[i])));
          return off <= tolerance ? "match" : `${p.join(",")} (off by ${off})`;
        },
        { timeout, message: `pixel (${x},${y}) to be ${rgb.join(",")}` },
      )
      .toBe("match");
  }

  async expectPixelStays(x: number, y: number, rgb: RGB, tolerance = 8, settleMs = 300) {
    await this.page.waitForTimeout(settleMs);
    const p = await this.pixel(x, y);
    expect(p, `pixel (${x},${y})`).not.toBeNull();
    const off = Math.max(...p!.map((v, i) => Math.abs(v - rgb[i])));
    expect(off, `pixel (${x},${y}) is ${p!.join(",")}, wanted ${rgb.join(",")}`).toBeLessThanOrEqual(tolerance);
  }

  counters(): Promise<Counters> {
    return this.page.evaluate(() => (window as unknown as { __counters: Counters }).__counters);
  }

  surface(surface = 0) {
    return this.page.locator(`#spice_surface_${surface}`);
  }

  sendCtrlAltDel() {
    return this.page.evaluate(() => (window as unknown as { harness: { sendCtrlAltDel: () => void } }).harness.sendCtrlAltDel());
  }

  typeText(text: string, delay?: number) {
    return this.page.evaluate(
      ([t, d]) => (window as unknown as { harness: { typeText: (t: string, d?: number) => Promise<unknown> } }).harness.typeText(t, d),
      [text, delay] as const,
    );
  }
}

export const test = base.extend<{ client: SpiceClient; spice: SpiceControl }, { server: SpiceControl }>({
  server: [
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      server.close();
    },
    { scope: "worker" },
  ],
  spice: async ({ server }, use) => {
    await server.reset();
    await use(server);
  },
  client: async ({ page, spice }, use) => {
    await page.addInitScript(COUNTER_SCRIPT);
    const client = new SpiceClient(page, spice);
    await client.open();
    await use(client);
  },
});

export { expect };

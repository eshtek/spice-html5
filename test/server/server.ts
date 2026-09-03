/* A fake SPICE server for driving spice-html5 under test. It speaks the real
   link handshake (RSA-OAEP ticket included), mini-header framing and the
   subset of messages the client understands, and exposes an HTTP control API
   so a test runner outside Bun can script it. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket, Socket, TCPSocketListener } from "bun";
import { C, CHANNEL_TYPES, channelName } from "./constants.ts";
import * as frames from "./frames.ts";
import * as M from "./messages.ts";
import { TicketKey } from "./rsa.ts";
import { type Clip, type Rect, Reader, Writer, concat, mini } from "./wire.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ROOT = join(ROOT, "test");

export type FragmentMode =
  | { kind: "whole" }
  | { kind: "chunk"; size: number }
  | { kind: "random"; seed: number; max: number }
  | { kind: "coalesce"; ms: number };

export interface ServerConfig {
  password: string;
  channels: Array<{ type: number; id: number }>;
  fragment: FragmentMode;
  linkError: number;
  serverMagic: string;
  linkReplyDelayMs: number;
  authDelayMs: number;
  dropDuring: "link" | "ticket" | null;
  mouseModes: { supported: number; current: number };
  agentConnected: boolean;
  ackWindow: number;
  autoInit: boolean;
  scenario: string | null;
  replay: string | null;
  replaySpeed: number;
  /* Start the recorded display/cursor/inputs streams over when the recording ends. */
  replayLoop: boolean;
}

export const DEFAULT_CONFIG: ServerConfig = {
  password: "",
  channels: [
    { type: C.SPICE_CHANNEL_DISPLAY, id: 0 },
    { type: C.SPICE_CHANNEL_INPUTS, id: 0 },
    { type: C.SPICE_CHANNEL_CURSOR, id: 0 },
  ],
  fragment: { kind: "whole" },
  linkError: 0,
  serverMagic: "REDQ",
  linkReplyDelayMs: 0,
  authDelayMs: 0,
  dropDuring: null,
  mouseModes: { supported: 3, current: C.SPICE_MOUSE_MODE_CLIENT },
  agentConnected: false,
  ackWindow: 0,
  autoInit: true,
  scenario: null,
  replay: null,
  replaySpeed: 1,
  replayLoop: false,
};

type State = "link-header" | "link-mess" | "ticket" | "ready" | "closed";

interface Conn {
  id: number;
  /* WebSocket or TCP; the SPICE bytes are the same either way. */
  ws: Transport;
  state: State;
  chunks: Uint8Array[];
  buffered: number;
  channelType: number;
  channelId: number;
  connectionId: number;
  commonCaps: number[];
  channelCaps: number[];
  messagesIn: number;
  messagesOut: number;
  dropped: number;
  bytesOut: number;
  coalesce: Uint8Array[];
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  need: number;
}

export interface InboundRecord extends M.ClientMessage {
  seq: number;
  t: number;
  channel: string;
  channelId: number;
  connId: number;
}

interface Waiter {
  channel: string;
  name: string;
  count: number;
  resolve: (records: InboundRecord[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Recording {
  connections: Array<{
    channelType: number;
    channelId: number;
    readyAt: number;
    server: Array<{ t: number; type: number; data: string }>;
  }>;
}

export type Step =
  | { cmd: "send"; channel: string; channelId?: number; msg: string; args?: Record<string, unknown> }
  | { cmd: "wait"; ms: number }
  | { cmd: "waitFor"; channel: string; name: string; count?: number; timeoutMs?: number }
  | { cmd: "close"; channel: string; channelId?: number; code?: number }
  | { cmd: "stream"; args: StreamArgs }
  | { cmd: "drawBurst"; args: BurstArgs }
  | { cmd: "raw"; channel: string; channelId?: number; hex: string };

export interface StreamArgs {
  id?: number;
  surface?: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  dest?: { left: number; top: number };
  flags?: number;
  flip?: boolean;
  sized?: boolean;
  mmLead?: number;
  quality?: number;
  create?: boolean;
  destroy?: boolean;
  clip?: import("./wire.ts").Clip;
  /* Palette index of the first synthetic frame, so two runs can differ. */
  frameOffset?: number;
  /* Pre-encoded frames from a recording, base64. Overrides synthetic frames. */
  jpegs?: string[];
  /* Codec type for STREAM_CREATE (default MJPEG) and its pre-encoded frames, base64. */
  codec?: number;
  frames64?: string[];
}

export interface BurstArgs {
  count: number;
  size: number;
  /* Rectangular images; both default to size. */
  width?: number;
  height?: number;
  seed?: number;
  surface?: number;
  surfaceWidth?: number;
  surfaceHeight?: number;
  jpeg?: boolean;
  /* Rows last-first with the TOP_DOWN flag clear. */
  bottomUp?: boolean;
  /* FMT_RGBA with a real alpha channel (opaque pixels, alpha 255). */
  rgba?: boolean;
  /* Each draw carries this many random clip rectangles. */
  clipRects?: number;
  /* Draw i is cached under id i+1 and then redrawn from the cache this many times. */
  cacheRedraws?: number;
  gapMs?: number;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Pause between a replay's last message and its next pass in loop mode. */
const LOOP_GAP_MS = 500;


/* Keepalive pings carry an id no spec would pick, so their pongs are
   distinguishable from the ones a test is waiting for. */
export const KEEPALIVE_PING_ID = 0x4b454550;

/* A connection can close while pump() is awaiting a configured delay; a
   plain comparison here is narrowed away by the enclosing branch. */
const closed = (conn: { state: State }) => conn.state === "closed";

/* What a connection needs from its socket, satisfied by Bun's ServerWebSocket
   as it is and by a small adapter over a TCP socket. sendBinary returns the
   bytes written, -1 when the rest was queued, 0 when refused. */
export interface Transport {
  sendBinary(bytes: Uint8Array): number;
  getBufferedAmount(): number;
  close(code?: number): void;
}

interface TcpData {
  id: number;
  pending: Uint8Array[];
  pendingBytes: number;
}

function flushTcp(s: Socket<TcpData>) {
  const d = s.data;
  while (d.pending.length > 0) {
    const b = d.pending[0];
    const n = Math.max(0, s.write(b));
    d.pendingBytes -= n;
    if (n < b.length) {
      d.pending[0] = b.subarray(n);
      return;
    }
    d.pending.shift();
  }
}

function tcpTransport(s: Socket<TcpData>): Transport {
  return {
    sendBinary(b) {
      const d = s.data;
      if (d.pending.length > 0) {
        d.pending.push(b);
        d.pendingBytes += b.length;
        return -1;
      }
      const n = Math.max(0, s.write(b));
      if (n < b.length) {
        d.pending.push(b.subarray(n));
        d.pendingBytes += b.length - n;
        return -1;
      }
      return n;
    },
    getBufferedAmount() {
      return s.data.pendingBytes;
    },
    close() {
      s.end();
    },
  };
}

export class FakeSpiceServer {
  config: ServerConfig = { ...DEFAULT_CONFIG };
  private key = new TicketKey();
  private server: Server<{ id: number }> | null = null;
  private tcp: TCPSocketListener<TcpData> | null = null;
  private conns = new Map<number, Conn>();
  private nextConnId = 1;
  private sessionId = 0x5eed0001;
  private mmEpoch = Date.now();
  private mmBase = 1000;
  inbound: InboundRecord[] = [];
  private waiters: Waiter[] = [];
  private seq = 0;
  private recording: Recording | null = null;
  private replayConsumed = new Set<number>();
  private replayEpoch = 0;
  private replayTimers: Array<ReturnType<typeof setTimeout>> = [];
  log: string[] = [];

  get port() {
    return this.server?.port ?? 0;
  }

  mmNow() {
    return (this.mmBase + (Date.now() - this.mmEpoch)) >>> 0;
  }

  private keepalive: ReturnType<typeof setInterval> | null = null;

  listen(port = 0): number {
    const self = this;
    this.keepalive = setInterval(() => {
      if (this.recording) return;
      for (const c of this.conns.values()) {
        if (c.state === "ready") this.send(c, M.ping(KEEPALIVE_PING_ID, Date.now()));
      }
    }, 20_000);
    this.server = Bun.serve<{ id: number }>({
      port,
      fetch(req, server) {
        return self.handleHttp(req, server);
      },
      websocket: {
        /* Bun closes a websocket that has been silent for idleTimeout seconds;
           a parked console is silent for hours, so keep the limit at the
           maximum and ping through it like a real server does. */
        idleTimeout: 960,
        /* Bun drops (not queues) a message once the socket's buffered bytes
           pass backpressureLimit, and the default 16 MB is a fraction of one
           draw burst. */
        backpressureLimit: 1024 * 1024 * 1024,
        closeOnBackpressureLimit: false,
        open(ws) {
          self.onOpen(ws.data.id, ws);
        },
        message(ws, msg) {
          if (typeof msg === "string") return;
          self.onMessage(ws.data.id, new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
        },
        close(ws) {
          self.onClose(ws.data.id);
        },
      },
    });
    return this.server.port ?? 0;
  }

  /* Plain SPICE over TCP on the side, for native clients such as spicy;
     the server's own parsing already copes with arbitrary chunking. */
  listenTcp(port = 0, hostname = "127.0.0.1"): number {
    const self = this;
    this.tcp = Bun.listen<TcpData>({
      hostname,
      port,
      socket: {
        open(s) {
          s.data = { id: self.nextConnId++, pending: [], pendingBytes: 0 };
          self.onOpen(s.data.id, tcpTransport(s));
        },
        data(s, chunk) {
          self.onMessage(s.data.id, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        },
        close(s) {
          self.onClose(s.data.id);
        },
        error(s, e) {
          self.log.push(`tcp ${s.data.id}: ${e.message}`);
        },
        drain(s) {
          flushTcp(s);
        },
      },
    });
    return this.tcp.port;
  }

  stop() {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const c of [...this.conns.values()]) this.closeConn(c, "stop");
    this.server?.stop(true);
    this.server = null;
    this.tcp?.stop(true);
    this.tcp = null;
  }

  /* ---------- config / reset ---------- */

  reset(partial: Partial<ServerConfig> = {}) {
    for (const c of [...this.conns.values()]) this.closeConn(c, "reset");
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("server reset"));
    }
    this.waiters = [];
    for (const t of this.replayTimers) clearTimeout(t);
    this.replayTimers = [];
    this.inbound = [];
    this.log = [];
    this.seq = 0;
    this.mmEpoch = Date.now();
    this.mmBase = 1000;
    this.config = { ...DEFAULT_CONFIG, ...partial };
    this.recording = null;
    this.replayConsumed.clear();
    if (this.config.replay) {
      /* Relative to the test tree, not to wherever the runner was launched. */
      const path = isAbsolute(this.config.replay) ? this.config.replay : resolve(TEST_ROOT, this.config.replay);
      this.recording = JSON.parse(readFileSync(path, "utf8"));
      const main = this.recording?.connections.find((c) => c.channelType === C.SPICE_CHANNEL_MAIN);
      const list = new Set<string>();
      for (const c of this.recording?.connections ?? []) {
        if (c.channelType !== C.SPICE_CHANNEL_MAIN) list.add(`${c.channelType}:${c.channelId}`);
      }
      this.config.channels = [...list].map((s) => {
        const parts = s.split(":").map(Number);
        return { type: parts[0] ?? 0, id: parts[1] ?? 0 };
      });
      this.config.autoInit = false;
      if (main) this.mmBase = 0;
    }
  }

  /* ---------- websocket lifecycle ---------- */

  private onOpen(id: number, ws: Transport) {
    const conn: Conn = {
      id,
      ws,
      state: "link-header",
      chunks: [],
      buffered: 0,
      channelType: 0,
      channelId: 0,
      connectionId: 0,
      commonCaps: [],
      channelCaps: [],
      messagesIn: 0,
      messagesOut: 0,
      dropped: 0,
      bytesOut: 0,
      coalesce: [],
      coalesceTimer: null,
      need: 0,
    };
    this.conns.set(conn.id, conn);
  }

  private onClose(id: number) {
    const conn = this.conns.get(id);
    if (conn) this.closeConn(conn, "close");
  }

  /* The one transition out of a connection: state, timers, socket and map
     membership all change together, so a pump parked in a delay or a timer
     that fires later sees a closed connection whichever path closed it. */
  private closeConn(conn: Conn, reason: string, code?: number) {
    if (conn.state === "closed") return;
    conn.state = "closed";
    if (conn.coalesceTimer) clearTimeout(conn.coalesceTimer);
    conn.coalesceTimer = null;
    conn.coalesce = [];
    this.conns.delete(conn.id);
    this.log.push(`${reason} ${channelName(conn.channelType)}:${conn.channelId}`);
    try {
      conn.ws.close(code);
    } catch {}
  }

  private onMessage(id: number, bytes: Uint8Array) {
    const conn = this.conns.get(id);
    if (!conn || conn.state === "closed") return;
    conn.chunks.push(bytes);
    conn.buffered += bytes.length;
    void this.pump(conn);
  }

  private take(conn: Conn, n: number): Uint8Array {
    const all = concat(conn.chunks);
    const out = all.slice(0, n);
    conn.chunks = all.length > n ? [all.slice(n)] : [];
    conn.buffered = all.length - n;
    return out;
  }

  private peekU32(conn: Conn, at: number): number {
    const all = concat(conn.chunks);
    return new DataView(all.buffer, all.byteOffset).getUint32(at, true);
  }

  private pumping = new Set<number>();

  private async pump(conn: Conn) {
    if (this.pumping.has(conn.id)) return;
    this.pumping.add(conn.id);
    try {
      for (;;) {
        if (conn.state === "closed") return;
        if (conn.state === "link-header") {
          if (conn.buffered < 16) return;
          const hdr = new Reader(this.take(conn, 16));
          const magic = String.fromCharCode(hdr.u8(), hdr.u8(), hdr.u8(), hdr.u8());
          const major = hdr.u32();
          const minor = hdr.u32();
          const size = hdr.u32();
          if (magic !== "REDQ") {
            this.closeConn(conn, `bad client magic ${magic}`);
            return;
          }
          this.log.push(`link header v${major}.${minor} size ${size}`);
          conn.state = "link-mess";
          conn.need = size;
          continue;
        }
        if (conn.state === "link-mess") {
          if (conn.buffered < conn.need) return;
          const r = new Reader(this.take(conn, conn.need));
          conn.connectionId = r.u32();
          conn.channelType = r.u8();
          conn.channelId = r.u8();
          const nCommon = r.u32();
          const nChannel = r.u32();
          r.u32(); // caps offset: always immediately after the header here
          conn.commonCaps = [];
          for (let i = 0; i < nCommon; i++) conn.commonCaps.push(r.u32());
          conn.channelCaps = [];
          for (let i = 0; i < nChannel; i++) conn.channelCaps.push(r.u32());
          this.log.push(`link ${channelName(conn.channelType)}:${conn.channelId} conn ${conn.connectionId}`);
          if (this.config.dropDuring === "link") {
            this.closeConn(conn, "drop during link");
            return;
          }
          if (this.config.linkReplyDelayMs) await sleep(this.config.linkReplyDelayMs);
          if (closed(conn)) return;
          this.sendRaw(conn, this.linkReply(conn));
          if (this.config.linkError) {
            this.closeConn(conn, `link error ${this.config.linkError}`);
            return;
          }
          conn.state = "ticket";
          continue;
        }
        if (conn.state === "ticket") {
          if (conn.buffered < 4 + 128) return;
          const r = new Reader(this.take(conn, 132));
          const mechanism = r.u32();
          const ticket = this.key.decrypt(r.take(128));
          if (this.config.dropDuring === "ticket") {
            this.closeConn(conn, "drop during ticket");
            return;
          }
          if (this.config.authDelayMs) await sleep(this.config.authDelayMs);
          if (closed(conn)) return;
          const ok = mechanism === C.SPICE_COMMON_CAP_AUTH_SPICE && ticket === this.config.password;
          this.log.push(`ticket ${channelName(conn.channelType)} ${ok ? "ok" : `denied (${JSON.stringify(ticket)})`}`);
          this.sendRaw(conn, new Writer().u32(ok ? C.SPICE_LINK_ERR_OK : C.SPICE_LINK_ERR_PERMISSION_DENIED).toBytes());
          if (!ok) {
            this.closeConn(conn, "denied");
            return;
          }
          conn.state = "ready";
          this.onChannelReady(conn);
          continue;
        }
        if (conn.state === "ready") {
          if (conn.buffered < 6) return;
          const size = this.peekU32(conn, 2);
          if (conn.buffered < 6 + size) return;
          const r = new Reader(this.take(conn, 6 + size));
          const type = r.u16();
          r.u32();
          const data = r.take(size);
          conn.messagesIn++;
          this.onClientMessage(conn, type, data);
          continue;
        }
      }
    } finally {
      this.pumping.delete(conn.id);
    }
  }

  private linkReply(conn: Conn): Uint8Array {
    const body = new Writer().u32(this.config.linkError).bytes(this.key.spki);
    const common = (1 << C.SPICE_COMMON_CAP_PROTOCOL_AUTH_SELECTION) | (1 << C.SPICE_COMMON_CAP_AUTH_SPICE) | (1 << C.SPICE_COMMON_CAP_MINI_HEADER);
    let channel = 0;
    if (conn.channelType === C.SPICE_CHANNEL_DISPLAY) {
      channel =
        (1 << C.SPICE_DISPLAY_CAP_SIZED_STREAM) |
        (1 << C.SPICE_DISPLAY_CAP_STREAM_REPORT) |
        (1 << C.SPICE_DISPLAY_CAP_MULTI_CODEC) |
        (1 << C.SPICE_DISPLAY_CAP_PREF_VIDEO_CODEC_TYPE) |
        (1 << C.SPICE_DISPLAY_CAP_CODEC_MJPEG);
    } else if (conn.channelType === C.SPICE_CHANNEL_MAIN) {
      channel = 1 << C.SPICE_MAIN_CAP_AGENT_CONNECTED_TOKENS;
    } else if (conn.channelType === C.SPICE_CHANNEL_PLAYBACK) {
      channel = 1 << C.SPICE_PLAYBACK_CAP_OPUS;
    } else if (conn.channelType === C.SPICE_CHANNEL_RECORD) {
      channel = 1 << C.SPICE_RECORD_CAP_OPUS;
    }
    body.u32(1).u32(1).u32(4 + this.key.spki.length + 12).u32(common).u32(channel);
    const payload = body.toBytes();
    const header = new Writer().ascii(this.config.serverMagic.padEnd(4).slice(0, 4)).u32(2).u32(2).u32(payload.length);
    return concat([header.toBytes(), payload]);
  }

  private onChannelReady(conn: Conn) {
    const type = conn.channelType;
    if (this.recording) {
      this.scheduleReplay(conn);
      return;
    }
    if (this.config.ackWindow > 0) this.send(conn, M.setAck(1, this.config.ackWindow));
    if (!this.config.autoInit) return;
    if (type === C.SPICE_CHANNEL_MAIN) {
      this.send(
        conn,
        M.mainInit({
          sessionId: this.sessionId,
          supportedMouseModes: this.config.mouseModes.supported,
          currentMouseMode: this.config.mouseModes.current,
          agentConnected: this.config.agentConnected ? 1 : 0,
          agentTokens: this.config.agentConnected ? 10 : 0,
          multiMediaTime: this.mmNow(),
        }),
      );
    } else if (type === C.SPICE_CHANNEL_INPUTS) {
      this.send(conn, M.inputsInit(0));
    } else if (type === C.SPICE_CHANNEL_CURSOR) {
      this.send(conn, M.cursorInit({ x: 0, y: 0 }));
    }
  }

  private onClientMessage(conn: Conn, type: number, data: Uint8Array) {
    const decoded = M.decodeClient(conn.channelType, type, data);
    const record: InboundRecord = {
      ...decoded,
      seq: this.seq++,
      t: Date.now(),
      channel: channelName(conn.channelType),
      channelId: conn.channelId,
      connId: conn.id,
    };
    this.inbound.push(record);
    this.settleWaiters();
    if (this.recording) return;
    if (conn.channelType === C.SPICE_CHANNEL_MAIN && decoded.name === "attach_channels") {
      this.send(conn, M.channelsList(this.config.channels));
    } else if (conn.channelType === C.SPICE_CHANNEL_DISPLAY && decoded.name === "display_init") {
      if (this.config.scenario) void this.runScenario(this.config.scenario);
    }
  }

  /* ---------- sending ---------- */

  /* sendBinary returns -1 when the message is queued behind backpressure
     and 0 when Bun refused it; a refusal is counted so a test can tell a
     fast client from a lossy socket. */
  private push(conn: Conn, bytes: Uint8Array) {
    if (conn.ws.sendBinary(bytes) === 0 && conn.state !== "closed") conn.dropped++;
  }

  private sendRaw(conn: Conn, bytes: Uint8Array) {
    if (conn.state === "closed") return;
    conn.bytesOut += bytes.length;
    const mode = this.config.fragment;
    if (mode.kind === "whole") {
      this.push(conn, bytes);
    } else if (mode.kind === "chunk") {
      for (let at = 0; at < bytes.length; at += mode.size) this.push(conn, bytes.subarray(at, at + mode.size));
    } else if (mode.kind === "random") {
      const rnd = seeded(mode.seed + conn.id + conn.messagesOut);
      let at = 0;
      while (at < bytes.length) {
        const n = 1 + Math.floor(rnd() * mode.max);
        this.push(conn, bytes.subarray(at, at + n));
        at += n;
      }
    } else {
      conn.coalesce.push(bytes);
      if (!conn.coalesceTimer) {
        conn.coalesceTimer = setTimeout(() => {
          conn.coalesceTimer = null;
          const merged = concat(conn.coalesce);
          conn.coalesce = [];
          if (conn.state !== "closed") this.push(conn, merged);
        }, mode.ms);
      }
    }
  }

  send(conn: Conn, message: Uint8Array) {
    conn.messagesOut++;
    this.sendRaw(conn, message);
  }

  channel(name: string, id = 0): Conn | undefined {
    const type = CHANNEL_TYPES[name];
    for (const c of this.conns.values()) {
      if (c.channelType === type && c.channelId === id && c.state === "ready") return c;
    }
    return undefined;
  }

  private requireChannel(name: string, id = 0): Conn {
    const c = this.channel(name, id);
    if (!c) throw new Error(`channel ${name}:${id} is not connected`);
    return c;
  }

  /* ---------- waiting on client traffic ---------- */

  private matches(r: InboundRecord, channel: string, name: string) {
    return (channel === "*" || r.channel === channel) && (name === "*" || r.name === name);
  }

  private settleWaiters() {
    this.waiters = this.waiters.filter((w) => {
      const hits = this.inbound.filter((r) => this.matches(r, w.channel, w.name));
      if (hits.length < w.count) return true;
      clearTimeout(w.timer);
      w.resolve(hits);
      return false;
    });
  }

  waitFor(channel: string, name: string, count = 1, timeoutMs = 5000): Promise<InboundRecord[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`timed out waiting for ${count}x ${channel}/${name}; saw ${this.inbound.filter((r) => this.matches(r, channel, name)).length}`));
      }, timeoutMs);
      this.waiters.push({ channel, name, count, resolve, reject, timer });
      this.settleWaiters();
    });
  }

  /* ---------- message resolution for the control API ---------- */

  private resolveArgs(msg: string, args: Record<string, unknown>): Record<string, unknown> {
    const out = { ...args };
    const image = args.image as frames.ImageSpec | undefined;
    if (image) {
      if (msg === "drawCopyBitmap") {
        out.pixels = frames.rgbaToBGRx(frames.renderRGBA(image));
        out.imageWidth = image.width;
        out.imageHeight = image.height;
      } else if (msg === "drawCopyJpeg") {
        out.jpeg = frames.renderJpeg(image, (args.quality as number) ?? 90);
        out.imageWidth = image.width;
        out.imageHeight = image.height;
      }
      else if (msg === "streamData" || msg === "streamDataSized") out.data = frames.renderJpeg(image, (args.quality as number) ?? 90);
      delete out.image;
    }
    const shape = args.shape as (Record<string, unknown> & { image?: frames.ImageSpec; dataHex?: string }) | undefined;
    if (shape?.image) {
      out.shape = { ...shape, data: frames.rgbaToBGRA(frames.renderRGBA(shape.image)) };
      delete (out.shape as Record<string, unknown>).image;
    } else if (shape?.dataHex) {
      out.shape = { ...shape, data: Buffer.from(shape.dataHex, "hex") };
      delete (out.shape as Record<string, unknown>).dataHex;
    }
    if (typeof args.mmLead === "number") {
      out.mmTime = (this.mmNow() + (args.mmLead as number)) >>> 0;
      delete out.mmLead;
    }
    if (typeof args.time === "string" && args.time === "now") out.time = this.mmNow();
    if (typeof args.jpegHex === "string") {
      out.jpeg = Buffer.from(args.jpegHex, "hex");
      delete out.jpegHex;
    }
    if (typeof args.dataHex === "string") {
      out.data = Buffer.from(args.dataHex, "hex");
      delete out.dataHex;
    }
    if (typeof args.dataBase64 === "string") {
      out.data = Buffer.from(args.dataBase64, "base64");
      delete out.dataBase64;
    }
    return out;
  }

  buildMessage(msg: string, args: Record<string, unknown> = {}): Uint8Array {
    const builder = (M as unknown as Record<string, (...a: unknown[]) => Uint8Array>)[msg];
    if (typeof builder !== "function") throw new Error(`unknown message builder ${msg}`);
    const resolved = this.resolveArgs(msg, args);
    /* Builders that take positional scalars are called with the fields in
       declaration order; object-taking builders get the object. */
    const positional: Record<string, string[]> = {
      setAck: ["generation", "window"],
      ping: ["id", "timestamp", "extra"],
      notify: ["severity", "message", "what", "visibility"],
      channelsList: ["channels"],
      mouseMode: ["supported", "current"],
      multiMediaTime: ["time"],
      agentConnectedTokens: ["tokens"],
      agentToken: ["tokens"],
      agentAnnounceCapabilities: ["caps", "request"],
      agentData: ["type", "data"],
      surfaceDestroy: ["id"],
      streamDestroy: ["id"],
      inputsInit: ["modifiers"],
      keyModifiers: ["modifiers"],
      cursorMove: ["x", "y"],
      invalList: ["ids"],
      disconnecting: ["reason"],
    };
    if (positional[msg]) return builder(...positional[msg].map((k) => resolved[k]));
    return builder(resolved);
  }

  /* ---------- steps ---------- */

  async runSteps(steps: Step[]): Promise<void> {
    for (const step of steps) await this.runStep(step);
  }

  async runStep(step: Step): Promise<void> {
    switch (step.cmd) {
      case "send": {
        const conn = this.requireChannel(step.channel, step.channelId ?? 0);
        this.send(conn, this.buildMessage(step.msg, step.args ?? {}));
        return;
      }
      case "raw": {
        const conn = this.requireChannel(step.channel, step.channelId ?? 0);
        this.send(conn, Buffer.from(step.hex, "hex"));
        return;
      }
      case "wait":
        await sleep(step.ms);
        return;
      case "waitFor":
        await this.waitFor(step.channel, step.name, step.count ?? 1, step.timeoutMs ?? 5000);
        return;
      case "close": {
        const conn = this.requireChannel(step.channel, step.channelId ?? 0);
        this.closeConn(conn, "scripted close", step.code ?? 1000);
        return;
      }
      case "stream":
        await this.runStream(step.args);
        return;
      case "drawBurst":
        await this.runBurst(step.args);
        return;
    }
  }

  async runStream(a: StreamArgs): Promise<void> {
    const conn = this.requireChannel("display");
    const id = a.id ?? 0;
    const left = a.dest?.left ?? 0;
    const top = a.dest?.top ?? 0;
    const dest = { left, top, right: left + a.width, bottom: top + a.height };
    if (a.create !== false) {
      this.send(conn, M.streamCreate({ surface: a.surface ?? 0, id, codec: a.codec, flags: a.flags ?? 1, width: a.width, height: a.height, dest, clip: a.clip }));
    }
    /* Every frame is encoded before the clock starts, so a cold JPEG cache
       cannot bunch the first frames and skew what the client is timed on. */
    const firstFrame = a.frameOffset ?? 0;
    const pre = a.frames64 ?? a.jpegs;
    const encoded: Uint8Array[] = pre
      ? pre.map((b64) => new Uint8Array(Buffer.from(b64, "base64")))
      : frames.PALETTE.map((_, f) => frames.renderJpeg({ kind: "quadrants", width: a.width, height: a.height, frame: f, flip: a.flip }, a.quality ?? 85));
    const interval = 1000 / a.fps;
    const start = Date.now();
    for (let i = 0; i < a.frames; i++) {
      const due = start + i * interval;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (conn.state !== "ready") return;
      const data = encoded[(firstFrame + i) % encoded.length];
      const mmTime = (this.mmNow() + (a.mmLead ?? 0)) >>> 0;
      this.send(conn, a.sized ? M.streamDataSized({ id, mmTime, width: a.width, height: a.height, dest, data }) : M.streamData({ id, mmTime, data }));
    }
    if (a.destroy) this.send(conn, M.streamDestroy(id));
  }

  async runBurst(a: BurstArgs): Promise<void> {
    const conn = this.requireChannel("display");
    const rnd = seeded(a.seed ?? 1);
    const W = a.surfaceWidth ?? 640;
    const H = a.surfaceHeight ?? 480;
    const iw = a.width ?? a.size;
    const ih = a.height ?? a.size;
    const surface = a.surface ?? 0;
    /* Pixels are rendered once per palette entry, so the timed loop is the
       client's cost plus the socket, not the server's rasteriser. */
    const rendered = frames.PALETTE.map((_, f) => {
      const spec: frames.ImageSpec = { kind: "quadrants", width: iw, height: ih, frame: f };
      if (a.jpeg) return { jpeg: frames.renderJpeg(spec) };
      const rgba = frames.renderRGBA(spec);
      let pixels = a.rgba ? frames.rgbaToBGRA(rgba) : frames.rgbaToBGRx(rgba);
      if (a.bottomUp) pixels = frames.flipRows(pixels, iw, ih);
      return { pixels };
    });
    const clipFor = (box: Rect): Clip | undefined => {
      if (!a.clipRects) return undefined;
      const rects: Rect[] = [];
      for (let r = 0; r < a.clipRects; r++) {
        const cw = Math.max(1, Math.floor(rnd() * iw));
        const ch = Math.max(1, Math.floor(rnd() * ih));
        const cl = box.left + Math.floor(rnd() * (iw - cw));
        const ct = box.top + Math.floor(rnd() * (ih - ch));
        rects.push({ left: cl, top: ct, right: cl + cw, bottom: ct + ch });
      }
      return { type: "rects", rects };
    };
    /* One message in Bun's send queue at a time, the way a real server's
       flow control paces a burst; the wait is idle time, not client cost.
       The trailing drain means the burst has left the server when the
       control call returns. */
    const drained = async () => {
      while (conn.state === "ready" && conn.ws.getBufferedAmount() > 0) await sleep(1);
    };
    for (let i = 0; i < a.count; i++) {
      await drained();
      const left = Math.floor(rnd() * Math.max(1, W - iw));
      const top = Math.floor(rnd() * Math.max(1, H - ih));
      const box = { left, top, right: left + iw, bottom: top + ih };
      const img = rendered[i % rendered.length];
      const clip = clipFor(box);
      const cache = a.cacheRedraws ? { cacheId: i + 1, cache: true } : {};
      const msg = img.jpeg
        ? M.drawCopyJpeg({ surface, box, clip, jpeg: img.jpeg, ...cache })
        : M.drawCopyBitmap({ surface, box, clip, pixels: img.pixels!, topDown: !a.bottomUp, format: a.rgba ? "rgba" : "32bit", ...cache });
      this.send(conn, msg);
      for (let r = 0; r < (a.cacheRedraws ?? 0); r++) {
        await drained();
        const rl = Math.floor(rnd() * Math.max(1, W - iw));
        const rt = Math.floor(rnd() * Math.max(1, H - ih));
        const rbox = { left: rl, top: rt, right: rl + iw, bottom: rt + ih };
        this.send(conn, M.drawCopyFromCache({ surface, box: rbox, clip: clipFor(rbox), cacheId: i + 1 }));
      }
      if (a.gapMs) await sleep(a.gapMs);
    }
    await drained();
  }

  async runScenario(name: string): Promise<void> {
    const mod = (await import(`./scenarios/${name}.ts`)) as { steps: (server: FakeSpiceServer) => Step[] };
    await this.runSteps(mod.steps(this));
  }

  /* ---------- replay ---------- */

  private scheduleReplay(conn: Conn) {
    const rec = this.recording;
    if (!rec) return;
    /* A new main channel is a new session: hand it the recording from the
       top, and stop feeding whatever the previous session had left. */
    if (conn.channelType === C.SPICE_CHANNEL_MAIN) {
      for (const t of this.replayTimers) clearTimeout(t);
      this.replayTimers = [];
      this.replayConsumed.clear();
      this.replayEpoch = 0;
    }
    const idx = rec.connections.findIndex(
      (c, i) => !this.replayConsumed.has(i) && c.channelType === conn.channelType && c.channelId === conn.channelId,
    );
    if (idx === -1) {
      this.log.push(`replay: no recorded connection for ${channelName(conn.channelType)}:${conn.channelId}`);
      return;
    }
    this.replayConsumed.add(idx);
    const recConn = rec.connections[idx];
    if (conn.channelType === C.SPICE_CHANNEL_MAIN || !this.replayEpoch) {
      this.replayEpoch = Date.now() - recConn.readyAt / this.config.replaySpeed;
    }
    this.scheduleRecorded(conn, recConn);
    if (conn.channelType === C.SPICE_CHANNEL_MAIN && this.config.replayLoop) this.scheduleLoop();
  }

  private scheduleRecorded(conn: Conn, recConn: Recording["connections"][number], skip?: (type: number) => boolean) {
    /* Every message goes on a timer measured from one clock reading, and
       overdue ones get a zero delay rather than firing inline: decoding a
       long recording takes long enough that a later message could come
       due while an earlier one still sat on a short timer, and firing it
       on the spot sent a draw ahead of the surface it drew on. Timers with
       equal delays fire in order, and delays never decrease along the
       recording, so this keeps the recorded order. */
    const now = Date.now();
    for (const m of recConn.server) {
      if (skip?.(m.type)) continue;
      const at = this.replayEpoch + m.t / this.config.replaySpeed;
      /* The recording keeps type and payload apart; the wire wants the
         mini header back in front. */
      const bytes = mini(m.type, new Uint8Array(Buffer.from(m.data, "base64")));
      const fire = () => {
        if (conn.state !== "ready") return;
        this.send(conn, bytes);
      };
      this.replayTimers.push(setTimeout(fire, Math.max(0, at - now)));
    }
  }

  /* Time (recording ms) of the last recorded server message on any channel. */
  private recordingEnd(): number {
    let end = 0;
    for (const c of this.recording?.connections ?? []) for (const m of c.server) if (m.t > end) end = m.t;
    return end;
  }

  private scheduleLoop() {
    const at = this.replayEpoch + this.recordingEnd() / this.config.replaySpeed + LOOP_GAP_MS;
    this.replayTimers.push(setTimeout(() => this.loopReplay(), Math.max(0, at - Date.now())));
  }

  /* Start the non-main channels over: the recording opens with the
     surfaces and a full repaint, so destroying what it created and
     replaying it from the top is a clean second pass for any client. The
     main channel keeps its session; a second MainInit would not be one. */
  private loopReplay() {
    const rec = this.recording;
    if (!rec) return;
    const live = [...this.conns.values()].filter((c) => c.state === "ready" && c.channelType !== C.SPICE_CHANNEL_MAIN);
    const pairs = live
      .map((conn) => ({ conn, recConn: rec.connections.find((r) => r.channelType === conn.channelType && r.channelId === conn.channelId) }))
      .filter((p): p is { conn: Conn; recConn: Recording["connections"][number] } => p.recConn !== undefined && p.recConn.server.length > 0);
    if (pairs.length === 0) return;
    for (const { conn, recConn } of pairs) {
      if (conn.channelType !== C.SPICE_CHANNEL_DISPLAY) continue;
      const ids = new Set<number>();
      for (const m of recConn.server) {
        if (m.type !== C.SPICE_MSG_DISPLAY_SURFACE_CREATE) continue;
        const d = Buffer.from(m.data, "base64");
        if (d.length >= 4) ids.add(d.readUInt32LE(0));
      }
      for (const id of ids) this.send(conn, M.surfaceDestroy(id));
    }
    const firstT = Math.min(...pairs.map((p) => p.recConn.server[0].t));
    this.replayEpoch = Date.now() + LOOP_GAP_MS - firstT / this.config.replaySpeed;
    this.log.push("replay: loop");
    /* A channel's init message is a once-per-connection thing: spice-gtk
       asserts on a second CURSOR_INIT, so later passes leave them out. */
    for (const { conn, recConn } of pairs) {
      const init =
        conn.channelType === C.SPICE_CHANNEL_CURSOR ? C.SPICE_MSG_CURSOR_INIT : conn.channelType === C.SPICE_CHANNEL_INPUTS ? C.SPICE_MSG_INPUTS_INIT : -1;
      this.scheduleRecorded(conn, recConn, (type) => type === init);
    }
    this.scheduleLoop();
  }

  /* ---------- HTTP ---------- */

  snapshot() {
    return {
      port: this.port,
      mmNow: this.mmNow(),
      inboundCount: this.inbound.length,
      connections: [...this.conns.values()].map((c) => ({
        id: c.id,
        channel: channelName(c.channelType),
        channelId: c.channelId,
        state: c.state,
        messagesIn: c.messagesIn,
        messagesOut: c.messagesOut,
        bytesOut: c.bytesOut,
        dropped: c.dropped,
        channelCaps: c.channelCaps,
      })),
      log: this.log,
    };
  }

  private async handleHttp(req: Request, server: Server<{ id: number }>): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const ok = server.upgrade(req, {
        data: { id: this.nextConnId++ },
        headers: { "Sec-WebSocket-Protocol": "binary" },
      });
      /* A successful upgrade must not be answered with a Response. */
      if (ok) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/__control/")) return this.handleControl(url.pathname.slice("/__control/".length), req);
    return this.serveStatic(url.pathname);
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handleControl(action: string, req: Request): Promise<Response> {
    try {
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      switch (action) {
        case "reset":
          this.reset(body as Partial<ServerConfig>);
          return this.json({ ok: true, port: this.port });
        case "state":
          return this.json(this.snapshot());
        case "inbound": {
          const url = new URL(req.url);
          const channel = url.searchParams.get("channel") ?? "*";
          const name = url.searchParams.get("name") ?? "*";
          const since = Number(url.searchParams.get("since") ?? -1);
          return this.json(this.inbound.filter((r) => r.seq > since && this.matches(r, channel, name)));
        }
        case "run":
          await this.runSteps(body.steps as Step[]);
          return this.json({ ok: true });
        case "waitFor": {
          const hits = await this.waitFor(
            (body.channel as string) ?? "*",
            (body.name as string) ?? "*",
            (body.count as number) ?? 1,
            (body.timeoutMs as number) ?? 5000,
          );
          return this.json(hits);
        }
        case "mm":
          return this.json({ mmNow: this.mmNow() });
        default:
          return this.json({ error: `unknown control action ${action}` }, 404);
      }
    } catch (e) {
      return this.json({ error: (e as Error).message }, 500);
    }
  }

  private serveStatic(pathname: string): Response {
    const map: Record<string, string> = {
      "/": "test/e2e/page.html",
      "/page.html": "test/e2e/page.html",
      "/spice.css": "spice.css",
    };
    if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="8" height="8" fill="#f00"/><rect x="8" width="8" height="8" fill="#0c0"/><rect y="8" width="8" height="8" fill="#00c"/><rect x="8" y="8" width="8" height="8" fill="#e6e6e6"/></svg>`;
      return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    }
    let rel = map[pathname];
    if (!rel && (pathname.startsWith("/src/") || pathname.startsWith("/thirdparty/"))) rel = pathname.slice(1);
    if (!rel || rel.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(ROOT, rel));
    const type = rel.endsWith(".js") ? "text/javascript" : rel.endsWith(".css") ? "text/css" : "text/html";
    return new Response(file, {
      headers: {
        "content-type": `${type}; charset=utf-8`,
        "cache-control": "no-store",
        /* Cross-origin isolation is what unlocks precise memory measurement in
           Chromium; the page loads nothing cross-origin so it costs nothing. */
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
    });
  }
}

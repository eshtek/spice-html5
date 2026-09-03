/* WebSocket tap: sits between spice-html5 and a real SPICE websocket
   endpoint, relays bytes both ways, and writes the server side of each
   channel as a replayable recording.

     bun server/record.ts --listen 5959 --upstream ws://box:5901 --out fixtures/win11-idle.rec.json

   Point the client at ws://localhost:5959, do what you want captured, then
   Ctrl-C. Handshake bytes are parsed but not stored: replay regenerates
   them with its own key. */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { concat } from "./wire.ts";

const { values: args } = parseArgs({
  options: {
    listen: { type: "string", default: "5959" },
    upstream: { type: "string" },
    out: { type: "string", default: `recording-${Date.now()}.rec.json` },
  },
});
const listen = Number(args.listen);
const upstream = args.upstream;
const out = args.out;
if (!upstream) {
  console.error("--upstream ws://host:port is required");
  process.exit(1);
}

interface Msg {
  t: number;
  type: number;
  data: string;
}

interface RecConn {
  index: number;
  channelType: number;
  channelId: number;
  readyAt: number;
  server: Msg[];
}

const startedAt = Date.now();
const connections: RecConn[] = [];

/* Incremental framer for one direction of one connection. */
class Framer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private phase: "header" | "body" | "auth" | "mini" = "header";
  private need = 16;

  constructor(
    private readonly onLink: (body: Uint8Array) => void,
    private readonly onMessage: (type: number, data: Uint8Array) => void,
    private readonly authBytes: number,
  ) {}

  push(bytes: Uint8Array) {
    this.chunks.push(bytes);
    this.size += bytes.length;
    for (;;) {
      if (this.phase === "mini" && this.size >= 6) {
        const all = concat(this.chunks);
        const dv = new DataView(all.buffer, all.byteOffset);
        const len = dv.getUint32(2, true);
        if (this.size < 6 + len) return;
        this.onMessage(dv.getUint16(0, true), all.slice(6, 6 + len));
        this.chunks = [all.slice(6 + len)];
        this.size -= 6 + len;
        continue;
      }
      if (this.phase !== "mini" && this.size >= this.need) {
        const all = concat(this.chunks);
        const head = all.slice(0, this.need);
        this.chunks = [all.slice(this.need)];
        this.size -= this.need;
        if (this.phase === "header") {
          this.need = new DataView(head.buffer, head.byteOffset).getUint32(12, true);
          this.phase = "body";
        } else if (this.phase === "body") {
          this.onLink(head);
          this.need = this.authBytes;
          this.phase = "auth";
        } else {
          this.phase = "mini";
        }
        continue;
      }
      return;
    }
  }
}

interface Tap {
  rec: RecConn | null;
  up: WebSocket | null;
  pending: Uint8Array[];
  framer: Framer | null;
}

Bun.serve<Tap>({
  port: listen,
  fetch(req, server) {
    const ok = server.upgrade(req, { data: { rec: null, up: null, pending: [], framer: null }, headers: { "Sec-WebSocket-Protocol": "binary" } });
    return ok ? new Response(null, { status: 101 }) : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      /* Only a socket that actually upgraded becomes a recorded connection. */
      const rec: RecConn = { index: connections.length, channelType: 0, channelId: 0, readyAt: 0, server: [] };
      connections.push(rec);
      ws.data.rec = rec;
      /* The client side is framed only to learn which channel this is;
         its messages are not part of a replay. */
      ws.data.framer = new Framer(
        (body) => {
          rec.channelType = body[4];
          rec.channelId = body[5];
        },
        () => {},
        132,
      );
      const serverFramer = new Framer(
        () => {},
        (type, data) => {
          if (!rec.readyAt) rec.readyAt = Date.now() - startedAt;
          rec.server.push({ t: Date.now() - startedAt, type, data: Buffer.from(data).toString("base64") });
        },
        4,
      );
      const up = new WebSocket(upstream, "binary");
      up.binaryType = "arraybuffer";
      ws.data.up = up;
      up.onopen = () => {
        for (const p of ws.data.pending) up.send(p);
        ws.data.pending = [];
      };
      up.onmessage = (e) => {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        serverFramer.push(bytes);
        ws.sendBinary(bytes);
      };
      up.onclose = () => ws.close();
      up.onerror = () => ws.close();
    },
    message(ws, msg) {
      if (typeof msg === "string") return;
      const bytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      ws.data.framer?.push(bytes);
      const up = ws.data.up;
      if (up && up.readyState === WebSocket.OPEN) up.send(bytes);
      else ws.data.pending.push(bytes.slice());
    },
    close(ws) {
      ws.data.up?.close();
    },
  },
});

function save() {
  const doc = { version: 1, upstream, startedAt: new Date(startedAt).toISOString(), connections };
  writeFileSync(out, JSON.stringify(doc));
  const total = connections.reduce((n, c) => n + c.server.length, 0);
  console.log(`\nwrote ${out}: ${connections.length} connections, ${total} server messages`);
}

process.on("SIGINT", () => {
  save();
  process.exit(0);
});
console.log(`recording ws://localhost:${listen} -> ${upstream}; Ctrl-C to write ${out}`);

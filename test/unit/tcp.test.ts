/* The TCP listener feeds the same connection machinery as the WebSocket
   one: a client link header over plain TCP gets a link reply back. */
import { describe, expect, test } from "bun:test";
import { SpiceLinkHeader, SpiceLinkMess } from "../../src/spicemsg.js";
import { C } from "../server/constants.ts";
import { FakeSpiceServer } from "../server/server.ts";

describe("tcp listener", () => {
  test("answers a link message with a link reply", async () => {
    const server = new FakeSpiceServer();
    server.reset({});
    server.listen(0);
    const port = server.listenTcp(0);
    try {
      const hdr = new SpiceLinkHeader();
      const msg = new SpiceLinkMess();
      msg.connection_id = 0;
      msg.channel_type = C.SPICE_CHANNEL_MAIN;
      msg.channel_id = 0;
      msg.common_caps.push((1 << C.SPICE_COMMON_CAP_PROTOCOL_AUTH_SELECTION) | (1 << C.SPICE_COMMON_CAP_MINI_HEADER));
      msg.channel_caps.push(0);
      hdr.size = msg.buffer_size();
      const mb = new ArrayBuffer(hdr.buffer_size() + msg.buffer_size());
      hdr.to_buffer(mb);
      msg.to_buffer(mb, hdr.buffer_size());

      const reply = await new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const timer = setTimeout(() => reject(new Error("no link reply over tcp")), 3000);
        Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            open(s) {
              s.write(new Uint8Array(mb));
            },
            data(s, d) {
              chunks.push(new Uint8Array(d));
              const total = chunks.reduce((n, c) => n + c.length, 0);
              if (total >= 16) {
                clearTimeout(timer);
                const all = new Uint8Array(total);
                let at = 0;
                for (const c of chunks) {
                  all.set(c, at);
                  at += c.length;
                }
                resolve(all);
                s.end();
              }
            },
            error(_s, e) {
              clearTimeout(timer);
              reject(e);
            },
          },
        });
      });
      expect(String.fromCharCode(...reply.subarray(0, 4))).toBe("REDQ");
      expect(server.snapshot().connections.some((c) => c.channel === "main")).toBe(true);
    } finally {
      server.stop();
    }
  });
});

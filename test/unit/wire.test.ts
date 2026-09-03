/* Every builder is checked against the client's own parser, so a layout
   mistake on either side shows up here before any browser is involved. */
import { describe, expect, test } from "bun:test";
import { C } from "../server/constants.ts";
import * as M from "../server/messages.ts";
import { rect } from "../server/wire.ts";
import * as ClientMessages from "../../src/spicemsg.js";

/* The client's message classes fill their fields from prototype methods,
   which TypeScript cannot see through; treat them as loosely typed. */
type Parsed = new (a: ArrayBuffer) => Record<string, any>;
const {
  SpiceLinkReply,
  SpiceMiniData,
  SpiceMsgChannels,
  SpiceMsgCursorSet,
  SpiceMsgDisplayDrawCopy,
  SpiceMsgDisplayDrawFill,
  SpiceMsgDisplayStreamCreate,
  SpiceMsgDisplayStreamDataSized,
  SpiceMsgMainInit,
  SpiceMsgNotify,
  SpiceMsgSetAck,
  SpiceMsgSurfaceCreate,
} = ClientMessages as unknown as Record<string, Parsed>;

const toAB = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

/* Splits a mini-header message exactly as the client does. */
function parseMini(msg: Uint8Array) {
  const mini = new SpiceMiniData(toAB(msg.subarray(0, 6)));
  expect(mini.size).toBe(msg.length - 6);
  return { type: mini.type as number, data: toAB(msg.subarray(6)) };
}

describe("common", () => {
  test("setAck", () => {
    const { type, data } = parseMini(M.setAck(3, 32));
    expect(type).toBe(C.SPICE_MSG_SET_ACK);
    const ack = new SpiceMsgSetAck(data);
    expect(ack.generation).toBe(3);
    expect(ack.window).toBe(32);
  });

  test("notify carries the message text", () => {
    const { type, data } = parseMini(M.notify(C.SPICE_NOTIFY_SEVERITY_WARN, "hello there"));
    expect(type).toBe(C.SPICE_MSG_NOTIFY);
    const n = new SpiceMsgNotify(data);
    expect(n.severity).toBe(C.SPICE_NOTIFY_SEVERITY_WARN);
    expect(n.message).toBe("hello there");
  });
});

describe("main", () => {
  test("mainInit", () => {
    const { type, data } = parseMini(M.mainInit({ sessionId: 77, multiMediaTime: 4242, agentConnected: 1, agentTokens: 9 }));
    expect(type).toBe(C.SPICE_MSG_MAIN_INIT);
    const init = new SpiceMsgMainInit(data);
    expect(init.session_id).toBe(77);
    expect(init.multi_media_time).toBe(4242);
    expect(init.agent_connected).toBe(1);
    expect(init.agent_tokens).toBe(9);
    expect(init.current_mouse_mode).toBe(C.SPICE_MOUSE_MODE_CLIENT);
  });

  test("channelsList", () => {
    const { data } = parseMini(M.channelsList([{ type: 2, id: 0 }, { type: 3, id: 0 }, { type: 4, id: 1 }]));
    const list = new SpiceMsgChannels(data);
    expect(list.channels.map((c: { type: number; id: number }) => [c.type, c.id])).toEqual([[2, 0], [3, 0], [4, 1]]);
  });
});

describe("display", () => {
  test("surfaceCreate", () => {
    const { data } = parseMini(M.surfaceCreate({ width: 800, height: 600 }));
    const s = new SpiceMsgSurfaceCreate(data).surface;
    expect([s.surface_id, s.width, s.height, s.format, s.flags]).toEqual([0, 800, 600, C.SPICE_SURFACE_FMT_32_xRGB, C.SPICE_SURFACE_FLAGS_PRIMARY]);
  });

  test("drawFill with clip rects", () => {
    const { data } = parseMini(
      M.drawFill({ box: rect(10, 20, 110, 220), color: 0x123456, clip: { type: "rects", rects: [rect(1, 2, 3, 4), rect(5, 6, 7, 8)] } }),
    );
    const fill = new SpiceMsgDisplayDrawFill(data);
    expect(fill.base.box).toMatchObject({ left: 10, top: 20, right: 110, bottom: 220 });
    expect(fill.base.clip.type).toBe(C.SPICE_CLIP_TYPE_RECTS);
    expect(fill.base.clip.rects.num_rects).toBe(2);
    expect(fill.base.clip.rects.rects[1]).toMatchObject({ left: 5, top: 6, right: 7, bottom: 8 });
    expect(fill.data.brush.type).toBe(C.SPICE_BRUSH_TYPE_SOLID);
    expect(fill.data.brush.color).toBe(0x123456);
    expect(fill.data.rop_descriptor).toBe(C.SPICE_ROPD_OP_PUT);
    expect(fill.data.mask.bitmap).toBeNull();
  });

  test("drawCopyBitmap resolves the image offset and keeps every pixel byte", () => {
    const pixels = new Uint8Array(4 * 4 * 4).map((_, i) => i & 0xff);
    const { type, data } = parseMini(M.drawCopyBitmap({ box: rect(5, 6, 9, 10), pixels, cache: true, cacheId: 99 }));
    expect(type).toBe(C.SPICE_MSG_DISPLAY_DRAW_COPY);
    const copy = new SpiceMsgDisplayDrawCopy(data);
    expect(copy.base.clip.type).toBe(C.SPICE_CLIP_TYPE_NONE);
    const img = copy.data.src_bitmap;
    expect(img.descriptor.type).toBe(C.SPICE_IMAGE_TYPE_BITMAP);
    expect(img.descriptor.flags).toBe(C.SPICE_IMAGE_FLAGS_CACHE_ME);
    expect(Number(img.descriptor.id)).toBe(99);
    expect([img.descriptor.width, img.descriptor.height]).toEqual([4, 4]);
    expect(img.bitmap.format).toBe(C.SPICE_BITMAP_FMT_32BIT);
    expect(img.bitmap.flags & C.SPICE_BITMAP_FLAGS_TOP_DOWN).toBeTruthy();
    expect(img.bitmap.stride).toBe(16);
    expect(new Uint8Array(img.bitmap.data)).toEqual(pixels);
    expect(copy.data.src_area).toMatchObject({ left: 0, top: 0, right: 4, bottom: 4 });
    expect(copy.data.mask.bitmap).toBeNull();
  });

  test("drawCopyJpeg", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const { data } = parseMini(M.drawCopyJpeg({ box: rect(0, 0, 2, 2), jpeg }));
    const copy = new SpiceMsgDisplayDrawCopy(data);
    expect(copy.data.src_bitmap.descriptor.type).toBe(C.SPICE_IMAGE_TYPE_JPEG);
    expect(copy.data.src_bitmap.jpeg.data_size).toBe(jpeg.length);
    expect(new Uint8Array(copy.data.src_bitmap.jpeg.data)).toEqual(jpeg);
  });

  test("streamCreate + sized data", () => {
    const { data } = parseMini(M.streamCreate({ id: 3, flags: 0, width: 320, height: 240, dest: rect(10, 10, 330, 250), clip: { type: "rects", rects: [rect(0, 0, 5, 5)] } }));
    const s = new SpiceMsgDisplayStreamCreate(data);
    expect([s.surface_id, s.id, s.flags, s.codec_type]).toEqual([0, 3, 0, C.SPICE_VIDEO_CODEC_TYPE_MJPEG]);
    expect([s.stream_width, s.stream_height, s.src_width, s.src_height]).toEqual([320, 240, 320, 240]);
    expect(s.dest).toMatchObject({ left: 10, top: 10, right: 330, bottom: 250 });
    expect(s.clip.rects.num_rects).toBe(1);

    const frame = new Uint8Array([9, 8, 7]);
    const sized = parseMini(M.streamDataSized({ id: 3, mmTime: 555, width: 16, height: 8, dest: rect(1, 2, 17, 10), data: frame }));
    const d = new SpiceMsgDisplayStreamDataSized(sized.data);
    expect([d.base.id, d.base.multi_media_time, d.width, d.height, d.data_size]).toEqual([3, 555, 16, 8, 3]);
    expect(Array.from(d.data)).toEqual([9, 8, 7]);
  });
});

describe("cursor", () => {
  test("cursorSet with an ALPHA shape", () => {
    const px = new Uint8Array(2 * 2 * 4).fill(0xab);
    const { data } = parseMini(M.cursorSet({ x: 3, y: 4, shape: { width: 2, height: 2, hotX: 1, hotY: 1, data: px } }));
    const set = new SpiceMsgCursorSet(data);
    expect([set.position.x, set.position.y, set.visible]).toEqual([3, 4, 1]);
    expect(set.cursor.flags).toBe(0);
    expect(set.cursor.header.type).toBe(C.SPICE_CURSOR_TYPE_ALPHA);
    expect([set.cursor.header.width, set.cursor.header.height, set.cursor.header.hot_spot_x]).toEqual([2, 2, 1]);
    expect(new Uint8Array(set.cursor.data)).toEqual(px);
  });

  test("cursorSet NONE has no header", () => {
    const { data } = parseMini(M.cursorSet({ shape: null }));
    const set = new SpiceMsgCursorSet(data);
    expect(set.cursor.flags & C.SPICE_CURSOR_FLAGS_NONE).toBeTruthy();
    expect(set.cursor.header).toBeNull();
  });
});

describe("link reply", () => {
  test("client parses the key and caps the server advertises", async () => {
    const { FakeSpiceServer } = await import("../server/server.ts");
    const server = new FakeSpiceServer();
    const reply = (server as unknown as { linkReply: (c: { channelType: number }) => Uint8Array }).linkReply({ channelType: C.SPICE_CHANNEL_DISPLAY });
    const body = reply.subarray(16);
    const parsed = new SpiceLinkReply(toAB(body));
    expect(parsed.error).toBe(0);
    expect(parsed.pub_key.n.bitLength()).toBe(1024);
    expect(parsed.common_caps[0] & (1 << C.SPICE_COMMON_CAP_MINI_HEADER)).toBeTruthy();
    expect(parsed.channel_caps[0] & (1 << C.SPICE_DISPLAY_CAP_CODEC_MJPEG)).toBeTruthy();
  });
});

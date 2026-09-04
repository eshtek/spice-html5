/* The new builders against the client's parsers: glyph packing, fixed
   point paths, the alpha blend header. */
import { describe, expect, test } from "bun:test";
import { C } from "../server/constants.ts";
import * as M from "../server/messages.ts";
import { rect } from "../server/wire.ts";
import * as ClientMessages from "../../src/spicemsg.js";

type Parsed = new (a: ArrayBuffer) => Record<string, any>;
const { SpiceMsgDisplayDrawText, SpiceMsgDisplayDrawStroke, SpiceMsgDisplayDrawAlphaBlend, SpiceMsgDisplayDrawFill } = ClientMessages as unknown as Record<string, Parsed>;

function parseMini(msg: Uint8Array) {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  return { type: dv.getUint16(0, true), data: msg.slice(6).buffer as ArrayBuffer };
}

describe("draw ops on the wire", () => {
  test("drawText packs A1 rows bottom-up, most significant bit first", () => {
    const { type, data } = parseMini(M.drawText({ box: rect(0, 0, 10, 10), fore: 0x123456, back: 0xabcdef, backArea: rect(1, 2, 3, 4), glyphs: [{ x: 5, y: 9, originX: 1, originY: -3, rows: ["#..#.....#", "..........", "#........."] }] }));
    expect(type).toBe(C.SPICE_MSG_DISPLAY_DRAW_TEXT);
    const t = new SpiceMsgDisplayDrawText(data);
    expect(t.data.fore_brush.color).toBe(0x123456);
    expect(t.data.back_brush.color).toBe(0xabcdef);
    expect([t.data.back_area.left, t.data.back_area.top, t.data.back_area.right, t.data.back_area.bottom]).toEqual([1, 2, 3, 4]);
    expect(t.data.fore_mode).toBe(C.SPICE_ROPD_OP_PUT);
    const s = t.data.str;
    expect(s.flags).toBe(C.SPICE_STRING_FLAGS_RASTER_A1);
    expect(s.bits).toBe(1);
    expect(s.glyphs).toHaveLength(1);
    const g = s.glyphs[0];
    expect([g.render_pos.x, g.render_pos.y, g.glyph_origin.x, g.glyph_origin.y, g.width, g.height, g.stride]).toEqual([5, 9, 1, -3, 10, 3, 2]);
    /* Rows on the wire: last row first. */
    expect(Array.from(g.data)).toEqual([0x80, 0x00, 0x00, 0x00, 0x90, 0x40]);
  });

  test("drawText packs A4 nibbles high first and A8 bytes as they are", () => {
    const a4 = new SpiceMsgDisplayDrawText(parseMini(M.drawText({ box: rect(0, 0, 4, 4), fore: 0, bits: 4, topDown: true, glyphs: [{ x: 0, y: 0, rows: [[255, 0, 128]] }] })).data);
    expect(a4.data.str.bits).toBe(4);
    expect(a4.data.str.flags & C.SPICE_STRING_FLAGS_RASTER_TOP_DOWN).toBeTruthy();
    expect(Array.from(a4.data.str.glyphs[0].data)).toEqual([0xf0, 0x80]);
    const a8 = new SpiceMsgDisplayDrawText(parseMini(M.drawText({ box: rect(0, 0, 4, 4), fore: 0, bits: 8, glyphs: [{ x: 0, y: 0, rows: [[1, 2], [3, 4]] }] })).data);
    expect(Array.from(a8.data.str.glyphs[0].data)).toEqual([3, 4, 1, 2]);
  });

  test("drawStroke carries 28.4 points, flags and a dash style", () => {
    const { type, data } = parseMini(M.drawStroke({ box: rect(0, 0, 10, 10), color: 0x00ff00, dash: [4, 2.5], segments: [{ flags: 1 | 2 | 8, points: [[1, 2], [3.5, 4]] }, { flags: 16, points: [[5, 6]] }] }));
    expect(type).toBe(C.SPICE_MSG_DISPLAY_DRAW_STROKE);
    const s = new SpiceMsgDisplayDrawStroke(data);
    expect(s.data.brush.color).toBe(0x00ff00);
    expect(s.data.attr.flags).toBe(C.SPICE_LINE_FLAGS_STYLED);
    expect(s.data.attr.style).toEqual([4, 2.5]);
    expect(s.data.path.segments).toHaveLength(2);
    expect(s.data.path.segments[0].flags).toBe(11);
    expect(s.data.path.segments[0].points).toEqual([{ x: 1, y: 2 }, { x: 3.5, y: 4 }]);
    expect(s.data.path.segments[1].flags).toBe(C.SPICE_PATH_BEZIER);
  });

  test("drawAlphaBlendBitmap carries the alpha and the image", () => {
    const pixels = new Uint8Array(2 * 2 * 4).fill(7);
    const { type, data } = parseMini(M.drawAlphaBlendBitmap({ box: rect(3, 4, 5, 6), alpha: 77, alphaFlags: 1, pixels, cache: true, cacheId: 9 }));
    expect(type).toBe(C.SPICE_MSG_DISPLAY_DRAW_ALPHA_BLEND);
    const b = new SpiceMsgDisplayDrawAlphaBlend(data);
    expect(b.data.alpha).toBe(77);
    expect(b.data.alpha_flags).toBe(1);
    expect([b.data.src_area.left, b.data.src_area.top, b.data.src_area.right, b.data.src_area.bottom]).toEqual([0, 0, 2, 2]);
    expect(b.data.src_bitmap.descriptor.type).toBe(C.SPICE_IMAGE_TYPE_BITMAP);
    expect(Number(b.data.src_bitmap.descriptor.id)).toBe(9);
    expect(new Uint8Array(b.data.src_bitmap.bitmap.data)).toEqual(new Uint8Array(pixels));
  });

  test("drawFill takes a rop descriptor", () => {
    const f = new SpiceMsgDisplayDrawFill(parseMini(M.drawFill({ box: rect(0, 0, 1, 1), color: 0xffffff, ropd: 64 })).data);
    expect(f.data.rop_descriptor).toBe(C.SPICE_ROPD_OP_XOR);
  });
});

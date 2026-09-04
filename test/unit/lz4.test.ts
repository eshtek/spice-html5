/* The harness encoder against the client's decoder, and the LZ4 image
   builder against the client's DrawCopy parser. */
import { describe, expect, test } from "bun:test";
import { C } from "../server/constants.ts";
import { flipRows, quadrantsRGBA, rgbaToBGR24, rgbaToBGRA, rgbaToBGRx, rgbaToRGB555 } from "../server/frames.ts";
import { lz4EncodeBlocks, lz4LiteralBlock, spiceLz4Payload } from "../server/lz4.ts";
import * as M from "../server/messages.ts";
import { rect } from "../server/wire.ts";
import { convert_spice_lz4_to_web, decode_spice_lz4, lz4_block_decode } from "../../src/lz4.js";
import * as ClientMessages from "../../src/spicemsg.js";

/* The client's message classes fill their fields from prototype methods,
   which TypeScript cannot see through. */
type Parsed = new (a: ArrayBuffer) => Record<string, any>;
const { SpiceMsgDisplayDrawCopy } = ClientMessages as unknown as Record<string, Parsed>;

/* The decoder wants only createImageData from the canvas context. */
const context = {
  createImageData(width: number, height: number) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  },
};

function decodeBlocks(blocks: Uint8Array[], size: number): Uint8Array | null {
  const out = new Uint8Array(size);
  let dp = 0;
  for (const b of blocks) {
    dp = lz4_block_decode(b, 0, b.length, out, dp);
    if (dp < 0) return null;
  }
  return dp === size ? out : null;
}

function parseMini(msg: Uint8Array) {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  return { type: dv.getUint16(0, true), data: msg.slice(6).buffer as ArrayBuffer };
}

function patterned(n: number): Uint8Array {
  /* Repeats with a period the hash finds, plus noise so literals appear. */
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 97 < 60 ? (i * 7) & 0xff : (i * 31 + (i >> 5)) & 0xff;
  return out;
}

describe("lz4 block decoder", () => {
  test("a literal-only block", () => {
    const input = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
    expect(decodeBlocks([lz4LiteralBlock(input)], input.length)).toEqual(input);
  });

  test("a long literal run needs the count extension bytes", () => {
    const input = new Uint8Array(600).map((_, i) => (i * 13) & 0xff);
    const block = lz4LiteralBlock(input);
    expect(block.length).toBe(input.length + 1 + 3);
    expect(decodeBlocks([block], input.length)).toEqual(input);
  });

  test("an overlapping match repeats bytes it is still producing", () => {
    const input = new Uint8Array(2000).fill(0xab);
    const [block] = lz4EncodeBlocks(input, [input.length]);
    expect(block.length).toBeLessThan(40);
    expect(decodeBlocks([block], input.length)).toEqual(input);
  });

  test("patterned data round-trips with matches", () => {
    const input = patterned(20000);
    const [block] = lz4EncodeBlocks(input, [input.length]);
    expect(block.length).toBeLessThan(input.length / 2);
    expect(decodeBlocks([block], input.length)).toEqual(input);
  });

  test("a match may reach into an earlier block", () => {
    const first = patterned(4000);
    const input = new Uint8Array(8000);
    input.set(first, 0);
    input.set(first, 4000);
    const blocks = lz4EncodeBlocks(input, [4000, 4000]);
    /* The second block is the first one again, so it compresses to
       almost nothing only if it may refer back across the boundary. */
    expect(blocks[1].length).toBeLessThan(64);
    expect(decodeBlocks(blocks, input.length)).toEqual(input);
  });

  test("malformed input is refused, not read past the end", () => {
    const input = patterned(3000);
    const [block] = lz4EncodeBlocks(input, [input.length]);
    const out = new Uint8Array(input.length);
    expect(lz4_block_decode(block, 0, block.length - 20, out, 0)).toBe(-1);
    expect(lz4_block_decode(block, 0, block.length, new Uint8Array(100), 0)).toBe(-1);
    /* One literal, then a 4-byte match at offset 0: nothing to copy from. */
    const zeroOffset = Uint8Array.from([0x10, 0x42, 0, 0, 0x00]);
    expect(lz4_block_decode(zeroOffset, 0, zeroOffset.length, out, 0)).toBe(-1);
    /* Offset 2 with only one byte produced so far. */
    const early = Uint8Array.from([0x10, 0x42, 2, 0, 0x00]);
    expect(lz4_block_decode(early, 0, early.length, out, 0)).toBe(-1);
  });
});

describe("spice lz4 image", () => {
  const width = 24;
  const height = 10;
  const rgba = quadrantsRGBA(width, height, 0);
  const descriptor = { width, height };

  test("decodes the header and a stream of blocks into packed rows", () => {
    const pixels = rgbaToBGRx(rgba);
    const payload = spiceLz4Payload(true, C.SPICE_BITMAP_FMT_32BIT, lz4EncodeBlocks(pixels, [width * 4 * 3, width * 4 * 7]));
    const bitmap = decode_spice_lz4(descriptor, { data: payload.buffer });
    expect(bitmap).toBeDefined();
    expect(bitmap!.format).toBe(C.SPICE_BITMAP_FMT_32BIT);
    expect(bitmap!.flags & C.SPICE_BITMAP_FLAGS_TOP_DOWN).toBeTruthy();
    expect(bitmap!.stride).toBe(width * 4);
    expect(new Uint8Array(bitmap!.data)).toEqual(new Uint8Array(pixels));
  });

  test("refuses a short header, an unknown format, a truncated block and a short image", () => {
    const pixels = rgbaToBGRx(rgba);
    const good = spiceLz4Payload(true, C.SPICE_BITMAP_FMT_32BIT, lz4EncodeBlocks(pixels, [pixels.length]));
    expect(decode_spice_lz4(descriptor, { data: new Uint8Array([1]).buffer })).toBeUndefined();
    expect(decode_spice_lz4(descriptor, { data: spiceLz4Payload(true, C.SPICE_BITMAP_FMT_8BIT, []).buffer })).toBeUndefined();
    expect(decode_spice_lz4(descriptor, { data: good.slice(0, good.length - 5).buffer })).toBeUndefined();
    const half = spiceLz4Payload(true, C.SPICE_BITMAP_FMT_32BIT, lz4EncodeBlocks(pixels.subarray(0, pixels.length / 2), [pixels.length / 2]));
    expect(decode_spice_lz4(descriptor, { data: half.buffer })).toBeUndefined();
  });

  for (const [format, fmt, convert, tolerance] of [
    ["32bit", C.SPICE_BITMAP_FMT_32BIT, rgbaToBGRx, 0],
    ["rgba", C.SPICE_BITMAP_FMT_RGBA, rgbaToBGRA, 0],
    ["24bit", C.SPICE_BITMAP_FMT_24BIT, rgbaToBGR24, 0],
    ["16bit", C.SPICE_BITMAP_FMT_16BIT, rgbaToRGB555, 8],
  ] as const) {
    test(`${format} converts to ImageData, top-down and bottom-up`, () => {
      const pixels = convert(rgba);
      for (const topDown of [true, false]) {
        const rows = topDown ? pixels : flipRows(pixels, width, height, pixels.length / (width * height));
        const payload = spiceLz4Payload(topDown, fmt, lz4EncodeBlocks(rows, [rows.length]));
        const img = convert_spice_lz4_to_web(context, descriptor, { data: payload.buffer });
        expect(img).toBeDefined();
        for (let i = 0; i < rgba.length; i += 4) {
          expect(Math.abs(img.data[i] - rgba[i])).toBeLessThanOrEqual(tolerance);
          expect(Math.abs(img.data[i + 1] - rgba[i + 1])).toBeLessThanOrEqual(tolerance);
          expect(Math.abs(img.data[i + 2] - rgba[i + 2])).toBeLessThanOrEqual(tolerance);
          expect(img.data[i + 3]).toBe(255);
        }
      }
    });
  }

  test("drawCopyLz4 parses as an LZ4 image the decoder accepts", () => {
    const pixels = rgbaToBGRx(rgba);
    const { type, data } = parseMini(M.drawCopyLz4({ box: rect(5, 6, 5 + width, 6 + height), pixels, blockRows: 4, cache: true, cacheId: 7 }));
    expect(type).toBe(C.SPICE_MSG_DISPLAY_DRAW_COPY);
    const copy = new SpiceMsgDisplayDrawCopy(data);
    const img = copy.data.src_bitmap;
    expect(img.descriptor.type).toBe(C.SPICE_IMAGE_TYPE_LZ4);
    expect(img.descriptor.flags).toBe(C.SPICE_IMAGE_FLAGS_CACHE_ME);
    expect(Number(img.descriptor.id)).toBe(7);
    expect(img.lz4.data.byteLength).toBe(img.lz4.data_size);
    const bitmap = decode_spice_lz4(img.descriptor, img.lz4);
    expect(new Uint8Array(bitmap!.data)).toEqual(new Uint8Array(pixels));
  });
});

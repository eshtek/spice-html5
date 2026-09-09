/* The LZ decoder's row order. An RGBA image is two passes over one
   buffer -- colour, then alpha -- and an XXXA image is that alpha pass
   alone, which is how a JPEG_ALPHA image's alpha arrives. A bottom-up
   image carries its last row first, so both passes have to land before
   the image is turned over: flipping between them, or not flipping the
   alpha at all, leaves the planes mirrors of each other. */
import { describe, expect, test } from "bun:test";
import { Constants } from "../../src/enums.js";
import { convert_spice_lz_to_web } from "../../src/lz.js";

/* The decoder wants only createImageData from the canvas context. */
const context = {
  createImageData(width: number, height: number) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  },
};

/* Literal-only LZ: a control byte under 32 means the next (ctrl + 1)
   pixels are stored plainly. One byte a pixel for an alpha stream. */
function literals(bytes: number[], perPixel: number) {
  const out: number[] = [];
  const pixels = bytes.length / perPixel;
  for (let i = 0; i < pixels; ) {
    const n = Math.min(32, pixels - i);
    out.push(n - 1);
    for (let j = 0; j < n * perPixel; j++) out.push(bytes[i * perPixel + j]);
    i += n;
  }
  return out;
}

const W = 4;
const H = 3;

/* Alpha 255 on the stream's first row, 0 on the rest. */
function alphaStream() {
  const a: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.push(y === 0 ? 255 : 0);
  return literals(a, 1);
}

/* Colour red on the stream's first row, blue on the rest. Stored BGR. */
function colourStream() {
  const c: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) c.push(...(y === 0 ? [0, 0, 255] : [255, 0, 0]));
  return literals(c, 3);
}

function image(type: number, top_down: boolean, stream: number[]) {
  return { type, width: W, height: H, top_down, data: new Uint8Array(stream).buffer };
}

const alphaRow = (img: { data: Uint8ClampedArray }, y: number) =>
  Array.from({ length: W }, (_, x) => img.data[(y * W + x) * 4 + 3]);
const redRow = (img: { data: Uint8ClampedArray }, y: number) =>
  Array.from({ length: W }, (_, x) => img.data[(y * W + x) * 4]);

describe("XXXA, the alpha plane on its own", () => {
  test("a top-down image keeps the stream's row order", () => {
    const img = convert_spice_lz_to_web(context, image(Constants.LZ_IMAGE_TYPE_XXXA, true, alphaStream()));
    expect(alphaRow(img, 0)).toEqual([255, 255, 255, 255]);
    expect(alphaRow(img, H - 1)).toEqual([0, 0, 0, 0]);
  });

  test("a bottom-up image puts the stream's first row last", () => {
    const img = convert_spice_lz_to_web(context, image(Constants.LZ_IMAGE_TYPE_XXXA, false, alphaStream()));
    expect(alphaRow(img, H - 1)).toEqual([255, 255, 255, 255]);
    expect(alphaRow(img, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("RGBA, colour and alpha over one buffer", () => {
  test("a bottom-up image keeps its two planes aligned", () => {
    const img = convert_spice_lz_to_web(
      context,
      image(Constants.LZ_IMAGE_TYPE_RGBA, false, [...colourStream(), ...alphaStream()]),
    );
    /* The stream's first row is the image's last, in both planes. */
    expect(redRow(img, H - 1)).toEqual([255, 255, 255, 255]);
    expect(alphaRow(img, H - 1)).toEqual([255, 255, 255, 255]);
    expect(redRow(img, 0)).toEqual([0, 0, 0, 0]);
    expect(alphaRow(img, 0)).toEqual([0, 0, 0, 0]);
  });

  test("a top-down image keeps its two planes aligned", () => {
    const img = convert_spice_lz_to_web(
      context,
      image(Constants.LZ_IMAGE_TYPE_RGBA, true, [...colourStream(), ...alphaStream()]),
    );
    expect(redRow(img, 0)).toEqual([255, 255, 255, 255]);
    expect(alphaRow(img, 0)).toEqual([255, 255, 255, 255]);
    expect(redRow(img, H - 1)).toEqual([0, 0, 0, 0]);
    expect(alphaRow(img, H - 1)).toEqual([0, 0, 0, 0]);
  });
});

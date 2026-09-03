import { expect, test } from "bun:test";
import jpeg from "jpeg-js";
import { QUADRANT, encodeJpeg, flipRows, frameColor, quadrantsRGBA, rgbaToBGRx } from "../server/frames.ts";

const px = (buf: Uint8Array, w: number, x: number, y: number) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 3));

test("quadrants put the frame colour top-left", () => {
  const f = quadrantsRGBA(8, 8, 2);
  expect(px(f, 8, 1, 1)).toEqual(frameColor(2));
  expect(px(f, 8, 6, 1)).toEqual(QUADRANT.topRight);
  expect(px(f, 8, 1, 6)).toEqual(QUADRANT.bottomLeft);
  expect(px(f, 8, 6, 6)).toEqual(QUADRANT.bottomRight);
});

test("flipRows reverses row order", () => {
  const f = flipRows(quadrantsRGBA(8, 8, 0), 8, 8);
  expect(px(f, 8, 1, 1)).toEqual(QUADRANT.bottomLeft);
  expect(px(f, 8, 1, 6)).toEqual(frameColor(0));
});

test("BGRx swaps the channel order", () => {
  const b = rgbaToBGRx(new Uint8Array([10, 20, 30, 255]));
  expect(Array.from(b)).toEqual([30, 20, 10, 255]);
});

test("jpeg survives a round trip within codec error", () => {
  const w = 64;
  const rgba = quadrantsRGBA(w, w, 3);
  const dec = jpeg.decode(Buffer.from(encodeJpeg(rgba, w, w, 90)), { useTArray: true });
  const got = px(new Uint8Array(dec.data), w, 16, 16);
  const want = frameColor(3);
  for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(16);
});

/* The cursor PNG encoder: its zlib stream must inflate back to the
   scanlines, at sizes below and well above one stored block. */
import { inflateSync } from "node:zlib";
import { expect, test } from "bun:test";
import { create_rgba_png } from "../../src/png.js";

function decodePng(pngstr: string) {
  /* create_rgba_png percent-encodes for a data: URI, with the signature's
     letters left literal. */
  const out: number[] = [];
  for (let i = 0; i < pngstr.length; i++) {
    if (pngstr[i] === "%") {
      out.push(Number.parseInt(pngstr.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(pngstr.charCodeAt(i));
  }
  const bytes = Uint8Array.from(out);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  while (at < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return chunks;
}

for (const [w, h] of [[16, 16], [200, 200], [129, 130]] as const) {
  test(`a ${w}x${h} RGBA image round-trips through inflate`, () => {
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 7 + 3) & 255);
    const chunks = decodePng(create_rgba_png(w, h, rgba));
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const raw = inflateSync(chunks[1].data);
    expect(raw.length).toBe(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
      expect(raw[y * (1 + w * 4)]).toBe(0);
      expect(Array.from(raw.subarray(y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4)))).toEqual(Array.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
    }
  });
}

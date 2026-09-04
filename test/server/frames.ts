/* Synthetic test images. Quadrant frames put a per-frame colour top-left
   and fixed colours elsewhere, so a pixel probe can tell which frame landed
   and whether it landed the right way up. */
import jpeg from "jpeg-js";

export type RGB = [number, number, number];

export const PALETTE: RGB[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 128, 0],
  [128, 0, 255],
];

export const QUADRANT = {
  topRight: [0, 200, 0] as RGB,
  bottomLeft: [0, 0, 200] as RGB,
  bottomRight: [230, 230, 230] as RGB,
};

export function frameColor(frame: number): RGB {
  return PALETTE[frame % PALETTE.length];
}

/* RGBA rows, top-down. */
export function quadrantsRGBA(width: number, height: number, frame = 0): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const tl = frameColor(frame);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const top = y < height / 2;
      const left = x < width / 2;
      const c = top ? (left ? tl : QUADRANT.topRight) : left ? QUADRANT.bottomLeft : QUADRANT.bottomRight;
      const o = (y * width + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

export function solidRGBA(width: number, height: number, c: RGB): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let o = 0; o < out.length; o += 4) {
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return out;
}

export function rgbaToBGRx(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let o = 0; o < rgba.length; o += 4) {
    out[o] = rgba[o + 2];
    out[o + 1] = rgba[o + 1];
    out[o + 2] = rgba[o];
    out[o + 3] = 255;
  }
  return out;
}

/* BGRA with real alpha, the layout of an ALPHA cursor. */
export function rgbaToBGRA(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let o = 0; o < rgba.length; o += 4) {
    out[o] = rgba[o + 2];
    out[o + 1] = rgba[o + 1];
    out[o + 2] = rgba[o];
    out[o + 3] = rgba[o + 3];
  }
  return out;
}

/* Packed BGR rows, stride = width * 3. */
export function rgbaToBGR24(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i + 2];
    out[o + 1] = rgba[i + 1];
    out[o + 2] = rgba[i];
  }
  return out;
}

/* x1r5g5b5 little-endian words, stride = width * 2. */
export function rgbaToRGB555(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 2);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 2) {
    const v = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    out[o] = v & 0xff;
    out[o + 1] = v >> 8;
  }
  return out;
}

export function flipRows(pixels: Uint8Array, width: number, height: number, bpp = 4): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    out.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  }
  return out;
}

export function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality = 90): Uint8Array {
  const { data } = jpeg.encode({ data: Buffer.from(rgba), width, height }, quality);
  return new Uint8Array(data);
}

export interface ImageSpec {
  kind: "quadrants" | "solid";
  width: number;
  height: number;
  frame?: number;
  color?: RGB;
  /* Emit rows bottom-first, as a bottom-up bitmap or a non-TOP_DOWN stream would. */
  flip?: boolean;
}

export function renderRGBA(spec: ImageSpec): Uint8Array {
  const rgba =
    spec.kind === "solid"
      ? solidRGBA(spec.width, spec.height, spec.color ?? [255, 255, 255])
      : quadrantsRGBA(spec.width, spec.height, spec.frame ?? 0);
  return spec.flip ? flipRows(rgba, spec.width, spec.height) : rgba;
}

const jpegCache = new Map<string, Uint8Array>();

export function renderJpeg(spec: ImageSpec, quality = 90): Uint8Array {
  const key = JSON.stringify({ ...spec, quality });
  let hit = jpegCache.get(key);
  if (!hit) {
    hit = encodeJpeg(renderRGBA(spec), spec.width, spec.height, quality);
    jpegCache.set(key, hit);
  }
  return hit;
}

/* Little-endian struct helpers mirroring the layouts in src/spicemsg.js and
   src/spicetype.js. Every offset written here is relative to the start of a
   message payload, which is how the client resolves them. */

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type Clip = { type: "none" } | { type: "rects"; rects: Rect[] };

export const NO_CLIP: Clip = { type: "none" };

export function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { top, left, bottom, right };
}

export class Writer {
  private buf = new Uint8Array(512);
  private dv = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  u8(v: number) {
    this.ensure(1);
    this.dv.setUint8(this.length, v);
    this.length += 1;
    return this;
  }

  u16(v: number) {
    this.ensure(2);
    this.dv.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }

  u32(v: number) {
    this.ensure(4);
    this.dv.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  u64(v: number | bigint) {
    this.ensure(8);
    this.dv.setBigUint64(this.length, BigInt(v), true);
    this.length += 8;
    return this;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  ascii(s: string) {
    return this.bytes(new TextEncoder().encode(s));
  }

  rect(r: Rect) {
    return this.u32(r.top).u32(r.left).u32(r.bottom).u32(r.right);
  }

  point(x: number, y: number) {
    return this.u32(x).u32(y);
  }

  point16(x: number, y: number) {
    return this.u16(x).u16(y);
  }

  clip(c: Clip) {
    if (c.type === "none") return this.u8(0);
    this.u8(1).u32(c.rects.length);
    for (const r of c.rects) this.rect(r);
    return this;
  }

  /* Reserve a u32 to be filled once the offset it points at is known. */
  placeholderU32(): number {
    const at = this.length;
    this.u32(0);
    return at;
  }

  patchU32(at: number, v: number) {
    this.dv.setUint32(at, v >>> 0, true);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class Reader {
  private dv: DataView;
  at = 0;

  constructor(public readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining() {
    return this.bytes.length - this.at;
  }

  u8() {
    const v = this.dv.getUint8(this.at);
    this.at += 1;
    return v;
  }

  u16() {
    const v = this.dv.getUint16(this.at, true);
    this.at += 2;
    return v;
  }

  u32() {
    const v = this.dv.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  u64() {
    const v = this.dv.getBigUint64(this.at, true);
    this.at += 8;
    return v;
  }

  rest(): Uint8Array {
    const v = this.bytes.subarray(this.at);
    this.at = this.bytes.length;
    return v;
  }

  take(n: number): Uint8Array {
    const v = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
}

/* Mini header: type u16, size u32, payload. */
export function mini(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const w = new Writer();
  w.u16(type).u32(payload.length).bytes(payload);
  return w.toBytes();
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

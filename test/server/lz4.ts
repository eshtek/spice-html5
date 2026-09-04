/* LZ4 block encoder for the fake server. Enough of the real thing to
   exercise every path in the client's decoder: hash-table matches,
   overlapping runs, long literal and match counts, and the streaming
   dictionary the server uses across blocks (LZ4_compress_fast_continue),
   where a block's match may reach into an earlier block's bytes. */

const MINMATCH = 4;
/* The reference decoder's fast paths need the last match to start at
   least 12 bytes before the block end and the last 5 bytes to be
   literals; the client does not, but the harness should emit what a
   real server would. */
const MFLIMIT = 12;
const LASTLITERALS = 5;
const MAX_DISTANCE = 65535;

function read32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function hash(v: number): number {
  return (Math.imul(v, 2654435761) >>> 16) & 0xffff;
}

function pushCount(out: number[], n: number) {
  while (n >= 255) {
    out.push(255);
    n -= 255;
  }
  out.push(n);
}

function pushLiterals(out: number[], input: Uint8Array, from: number, to: number) {
  for (let i = from; i < to; i++) out.push(input[i]);
}

function encodeBlock(input: Uint8Array, start: number, end: number, table: Int32Array): Uint8Array {
  const out: number[] = [];
  let anchor = start;
  let ip = start;
  const mflimit = end - MFLIMIT;
  const matchLimit = end - LASTLITERALS;
  while (ip < mflimit) {
    const v = read32(input, ip);
    const k = hash(v);
    const ref = table[k];
    table[k] = ip;
    if (ref < 0 || ip - ref > MAX_DISTANCE || read32(input, ref) !== v) {
      ip++;
      continue;
    }
    let len = MINMATCH;
    while (ip + len < matchLimit && input[ref + len] === input[ip + len]) len++;
    const lit = ip - anchor;
    const token = (Math.min(lit, 15) << 4) | Math.min(len - MINMATCH, 15);
    out.push(token);
    if (lit >= 15) pushCount(out, lit - 15);
    pushLiterals(out, input, anchor, ip);
    const offset = ip - ref;
    out.push(offset & 0xff, offset >>> 8);
    if (len - MINMATCH >= 15) pushCount(out, len - MINMATCH - 15);
    ip += len;
    anchor = ip;
  }
  const lit = end - anchor;
  out.push(Math.min(lit, 15) << 4);
  if (lit >= 15) pushCount(out, lit - 15);
  pushLiterals(out, input, anchor, end);
  return Uint8Array.from(out);
}

/* Splits `input` into consecutive blocks of the given byte sizes and
   compresses them as one stream. Sizes must sum to the input length. */
export function lz4EncodeBlocks(input: Uint8Array, blockSizes: number[]): Uint8Array[] {
  const table = new Int32Array(1 << 16).fill(-1);
  const blocks: Uint8Array[] = [];
  let start = 0;
  for (const size of blockSizes) {
    blocks.push(encodeBlock(input, start, start + size, table));
    start += size;
  }
  if (start !== input.length) throw new Error(`block sizes cover ${start} of ${input.length} bytes`);
  return blocks;
}

/* A block that is nothing but literals, which is still valid LZ4. */
export function lz4LiteralBlock(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  out.push(Math.min(input.length, 15) << 4);
  if (input.length >= 15) pushCount(out, input.length - 15);
  pushLiterals(out, input, 0, input.length);
  return Uint8Array.from(out);
}

/* The SPICE image payload: header, then each block behind a big-endian
   byte count. */
export function spiceLz4Payload(topDown: boolean, format: number, blocks: Uint8Array[]): Uint8Array {
  let size = 2;
  for (const b of blocks) size += 4 + b.length;
  const out = new Uint8Array(size);
  out[0] = topDown ? 1 : 0;
  out[1] = format;
  let at = 2;
  for (const b of blocks) {
    out[at++] = b.length >>> 24;
    out[at++] = (b.length >>> 16) & 0xff;
    out[at++] = (b.length >>> 8) & 0xff;
    out[at++] = b.length & 0xff;
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/* The ticket path end to end: the client's OAEP encryption against the
   server's private key, through the client's own to_buffer so that the
   ticket padding is exercised as it is on the wire. Around one connect in
   fifty produced a plaintext with a leading zero byte before the left-pad
   fix; enough iterations makes that regression certain to show. */
import { expect, test } from "bun:test";
import { TicketKey } from "../server/rsa.ts";
import { SpiceLinkAuthTicket } from "../../src/spicemsg.js";
import { create_rsa_from_mb, rsa_encrypt } from "../../src/ticket.js";

function encryptTicket(key: TicketKey, password: string): Uint8Array {
  const spki = key.spki;
  const ab = spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength);
  const pub = create_rsa_from_mb(ab, 0);
  const ticket = new SpiceLinkAuthTicket();
  ticket.encrypted_data = rsa_encrypt(pub, `${password}\0`);
  const out = new ArrayBuffer(ticket.buffer_size());
  ticket.to_buffer(out);
  return new Uint8Array(out, 4);
}

test("a ticket encrypted by the client decrypts to the password", () => {
  const key = new TicketKey();
  expect(key.decrypt(encryptTicket(key, "s3cret"))).toBe("s3cret");
  expect(key.decrypt(encryptTicket(key, ""))).toBe("");
});

test("300 tickets in a row all decrypt (left-padding regression)", () => {
  const key = new TicketKey();
  let failures = 0;
  for (let i = 0; i < 300; i++) {
    if (key.decrypt(encryptTicket(key, "pw")) !== "pw") failures++;
  }
  expect(failures).toBe(0);
});

test("garbage does not decrypt", () => {
  const key = new TicketKey();
  expect(key.decrypt(new Uint8Array(128).fill(7))).toBeNull();
});

/* MGF1 against an independent SHA-1 build of RFC 8017's B.2.1: the mask
   is SHA1(seed || C) for C = 0, 1, ... as 32-bit big-endian counters,
   truncated to the requested length. It also reports success the way
   OpenSSL's PKCS1_MGF1 does, which the OAEP caller checks. */
import { createHash } from "node:crypto";
import { MGF1 } from "../../src/ticket.js";

function mgf1Reference(seed: number[], length: number): number[] {
  const out: number[] = [];
  for (let counter = 0; out.length < length; counter++) {
    const h = createHash("sha1");
    h.update(Uint8Array.from(seed));
    h.update(Uint8Array.from([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]));
    for (const b of h.digest()) if (out.length < length) out.push(b);
  }
  return out;
}

test("MGF1 matches an independent SHA-1 mask generator and returns 0", () => {
  const seed = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 255);
  for (const length of [1, 20, 21, 41, 107]) {
    const mask = new Array<number>(length);
    expect(MGF1(mask, seed)).toBe(0);
    expect(mask).toEqual(mgf1Reference(seed, length));
  }
  /* The OAEP caller masks a 107-byte db with a 20-byte seed, then the seed with the db. */
  const db = Array.from({ length: 107 }, (_, i) => (i * 3) & 255);
  const seedmask = new Array<number>(20);
  expect(MGF1(seedmask, db)).toBe(0);
  expect(seedmask).toEqual(mgf1Reference(db, 20));
});

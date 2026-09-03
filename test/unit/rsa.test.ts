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

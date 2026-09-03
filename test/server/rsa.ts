import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";

/* The link reply carries a 1024-bit RSA public key as a 162-byte DER
   SubjectPublicKeyInfo; the client encrypts the ticket with PKCS#1 OAEP
   (SHA-1, the spice-server default) and pads it to 128 bytes. */
export class TicketKey {
  readonly spki: Uint8Array;
  private readonly priv: KeyObject;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const der = publicKey.export({ type: "spki", format: "der" });
    if (der.length !== 162) throw new Error(`unexpected SPKI length ${der.length}`);
    this.spki = new Uint8Array(der);
    this.priv = privateKey;
  }

  /* Returns the decrypted ticket without its terminating NUL, or null when
     the ciphertext does not decrypt (garbage, or padded wrongly). */
  decrypt(ciphertext: Uint8Array): string | null {
    try {
      const plain = privateDecrypt(
        { key: this.priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
        Buffer.from(ciphertext),
      );
      const nul = plain.indexOf(0);
      return plain.subarray(0, nul === -1 ? plain.length : nul).toString("latin1");
    } catch {
      return null;
    }
  }
}

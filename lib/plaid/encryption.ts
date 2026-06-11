/**
 * lib/plaid/encryption.ts
 *
 * AES-256-GCM encryption for Plaid access tokens.
 * Tokens are encrypted before writing to the DB and decrypted only when needed
 * for API calls — never logged, never sent to the client.
 *
 * ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).
 * Generate: openssl rand -hex 32
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters. Run: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string.
 * Returns a colon-delimited string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(16);

  const cipher    = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();

  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decrypt a value produced by `encrypt`.
 * Throws if the ciphertext has been tampered with (GCM auth tag mismatch).
 */
export function decrypt(ciphertext: string): string {
  const key   = getKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) throw new Error("Invalid ciphertext format");

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv        = Buffer.from(ivHex,        "hex");
  const tag       = Buffer.from(tagHex,       "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

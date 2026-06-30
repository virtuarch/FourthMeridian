/**
 * lib/plaid/encryption.ts
 *
 * AES-256-GCM encryption with HKDF per-purpose key derivation (D14).
 *
 * One root ENCRYPTION_KEY (64 hex chars / 32 bytes). Purpose-derived subkeys
 * are produced via HKDF-SHA-256 — one subkey per named purpose — so rotating
 * or isolating one secret field never affects the others.
 *
 * Ciphertext formats
 * ──────────────────
 *   Legacy (v1): iv:authTag:ciphertext          (3 hex segments, root key)
 *   Current (v2): v2:iv:authTag:ciphertext       (4 segments, derived key)
 *
 * Dual-format reads: decryptWithPurpose() accepts both formats, so existing
 * rows continue to work without any data migration. New writes always produce
 * v2 ciphertext via encryptWithPurpose().
 *
 * ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).
 * Generate: openssl rand -hex 32
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

// ─── Purpose registry (Slice 2) ──────────────────────────────────────────────
//
// Each constant is the HKDF "info" label that isolates subkeys by domain.
// Adding a new secret field = adding a constant here.

export const EncryptionPurpose = {
  /** PlaidItem.encryptedToken — Plaid OAuth access token */
  PLAID_ACCESS_TOKEN:    "plaid_access_token",
  /** User.totpSecret — TOTP seed */
  TOTP_SECRET:           "totp_secret",
  /** User.dateOfBirthEncrypted — ISO date string */
  DATE_OF_BIRTH:         "date_of_birth",
  /** Connection.credential — provider OAuth token / API key (non-Plaid) */
  CONNECTION_CREDENTIAL: "connection_credential",
} as const;

export type EncryptionPurpose = typeof EncryptionPurpose[keyof typeof EncryptionPurpose];

// ─── Root key ────────────────────────────────────────────────────────────────

function getRootKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters. Run: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

// ─── HKDF helper (Slice 1) ───────────────────────────────────────────────────

/**
 * Derive a 32-byte AES-256 subkey from the root key for the given purpose.
 * Uses HKDF-SHA-256 with an empty salt (root key already has full entropy)
 * and the purpose string as the info label.
 */
function deriveKey(purpose: EncryptionPurpose): Buffer {
  const rootKey = getRootKey();
  return Buffer.from(
    crypto.hkdfSync("sha256", rootKey, Buffer.alloc(0), purpose, 32),
  );
}

// ─── AES-256-GCM primitives ──────────────────────────────────────────────────

function aesgcmEncrypt(key: Buffer, plaintext: string): string {
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

function aesgcmDecrypt(key: Buffer, ivHex: string, tagHex: string, encHex: string): string {
  const iv      = Buffer.from(ivHex,  "hex");
  const tag     = Buffer.from(tagHex, "hex");
  const enc     = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

// ─── Purpose-aware API (Slice 3) ─────────────────────────────────────────────

/**
 * Encrypt plaintext with a purpose-derived subkey.
 * Returns v2 ciphertext: "v2:iv:authTag:ciphertext" (all hex-encoded).
 */
export function encryptWithPurpose(plaintext: string, purpose: EncryptionPurpose): string {
  return "v2:" + aesgcmEncrypt(deriveKey(purpose), plaintext);
}

/**
 * Decrypt a ciphertext that was produced by encryptWithPurpose() OR the
 * legacy encrypt(). Dual-format so existing DB rows need no migration.
 *
 *   v2 format  — "v2:iv:authTag:ciphertext" — uses derived key for purpose
 *   v1 format  — "iv:authTag:ciphertext"    — uses root key (backward compat)
 */
export function decryptWithPurpose(ciphertext: string, purpose: EncryptionPurpose): string {
  const parts = ciphertext.split(":");

  if (parts.length === 4 && parts[0] === "v2") {
    // v2: purpose-derived subkey
    return aesgcmDecrypt(deriveKey(purpose), parts[1], parts[2], parts[3]);
  }

  if (parts.length === 3) {
    // v1 legacy: root key — backward compatibility
    return aesgcmDecrypt(getRootKey(), parts[0], parts[1], parts[2]);
  }

  throw new Error("Invalid ciphertext format");
}

// ─── Legacy API (kept for backward compatibility) ────────────────────────────
//
// These functions still work; call sites have been migrated to the
// purpose-aware variants above (Slice 4). Do not remove until Slice 5
// (data migration / re-encryption) is complete and all rows are v2.

/**
 * @deprecated Use encryptWithPurpose() instead.
 * Encrypt a plaintext string with the root key.
 * Returns "iv:authTag:ciphertext" (all hex-encoded).
 */
export function encrypt(plaintext: string): string {
  return aesgcmEncrypt(getRootKey(), plaintext);
}

/**
 * @deprecated Use decryptWithPurpose() instead.
 * Decrypt a value produced by encrypt() (root key, v1 format).
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format");
  return aesgcmDecrypt(getRootKey(), parts[0], parts[1], parts[2]);
}

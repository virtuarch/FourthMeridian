/**
 * lib/totp.ts
 *
 * Native TOTP (RFC 6238) implementation using Node's built-in crypto module.
 * Zero external dependencies — avoids otplib v13's async plugin system.
 *
 * Compatible with: Google Authenticator, Microsoft Authenticator, Authy,
 *                  1Password, Bitwarden, iCloud Passwords.
 *
 * Algorithm:
 *   1. Base32-decode the secret
 *   2. Counter = floor(unix_seconds / period)
 *   3. HMAC-SHA1(secret_bytes, 8-byte big-endian counter)
 *   4. Dynamic truncation → 6-digit code
 */

import crypto from "crypto";

// ── Base32 ────────────────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of s) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ── Core TOTP ─────────────────────────────────────────────────────────────────

const PERIOD  = 30; // seconds per time step
const DIGITS  = 6;

/** Generate a cryptographically random base32 secret (20 bytes = 160 bits). */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secretBytes: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // Write 64-bit big-endian counter (only lower 32 bits used for typical counters)
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac   = crypto.createHmac("sha1", secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   =
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff);

  return String(code % Math.pow(10, DIGITS)).padStart(DIGITS, "0");
}

function timeStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / PERIOD);
}

/** Generate the current TOTP code for a base32-encoded secret. */
export function generateTOTP(secret: string): string {
  const secretBytes = base32Decode(secret);
  return hotp(secretBytes, timeStep());
}

/**
 * Verify a TOTP token against a base32-encoded secret.
 * `window` accepts this many steps before/after the current step
 * to tolerate clock drift (default 1 = ±30 seconds).
 */
export function verifyTOTP(token: string, secret: string, window = 1): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secretBytes = base32Decode(secret);
  const step        = timeStep();
  for (let i = -window; i <= window; i++) {
    if (hotp(secretBytes, step + i) === token) return true;
  }
  return false;
}

/**
 * Build the otpauth:// URI that authenticator apps parse from QR codes.
 * Format: otpauth://totp/Issuer:account?secret=SECRET&issuer=Issuer&...
 */
export function otpauthUri(account: string, secret: string, issuer = "FinTracker"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits:    String(DIGITS),
    period:    String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * lib/plaid/encryption.test.ts
 *
 * SEC-1 / KD-6 — Slice 5a unit coverage for the D14 encryption module.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/space-nav.test.ts and lib/ai/output-validator.test.ts:
 *
 *     ENCRYPTION_KEY=$(openssl rand -hex 32) npx tsx lib/plaid/encryption.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 *
 * Covers: v1 detection, v2 detection, malformed detection, round-trip
 * encrypt/decrypt, decryptWithPurpose dual-format compatibility, and idempotent
 * version detection. No writes, no DB, no behavioral change to the module.
 */

import crypto from "crypto";
import {
  EncryptionPurpose,
  encryptWithPurpose,
  decryptWithPurpose,
  detectCiphertextVersion,
} from "./encryption";

// A deterministic 32-byte key so this test never depends on the environment.
process.env.ENCRYPTION_KEY = "a".repeat(64);

// Test-only v1 fixture generator. Reproduces the retired encrypt() format
// (root-key AES-256-GCM, "iv:authTag:ciphertext") so the suite can still assert
// v1 detection + dual-format reads without a production v1 encryptor.
function makeV1Fixture(plaintext: string): string {
  const rootKey = Buffer.from(process.env.ENCRYPTION_KEY as string, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", rootKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── detectCiphertextVersion ──────────────────────────────────────────────────

console.log("detectCiphertextVersion — v2 detection");
{
  const v2 = encryptWithPurpose("hello", EncryptionPurpose.TOTP_SECRET);
  check("real v2 ciphertext is 'v2'", detectCiphertextVersion(v2) === "v2");
  check("v2 value carries the v2: prefix", v2.startsWith("v2:"));
  check("v2 value has 4 colon-segments", v2.split(":").length === 4);
}

console.log("detectCiphertextVersion — v1 detection");
{
  const v1 = makeV1Fixture("hello"); // legacy root-key format: iv:tag:ct
  check("real legacy ciphertext is 'v1'", detectCiphertextVersion(v1) === "v1");
  check("v1 value has 3 colon-segments", v1.split(":").length === 3);
  check("v1 value has no v2: prefix", !v1.startsWith("v2:"));
}

console.log("detectCiphertextVersion — malformed / invalid");
{
  check("empty string is invalid", detectCiphertextVersion("") === "invalid");
  check("single token is invalid", detectCiphertextVersion("garbage") === "invalid");
  check("two segments is invalid", detectCiphertextVersion("a:b") === "invalid");
  check("five segments is invalid", detectCiphertextVersion("v2:a:b:c:d") === "invalid");
  check("4 segments without v2 prefix is invalid (not v2)",
    detectCiphertextVersion("v1:a:b:c") === "invalid");
  // Faithful-to-decryptWithPurpose edge: ANY 3-segment value routes to the v1
  // branch, even a "v2:"-prefixed one. A genuine v1 IV is 32 hex chars and can
  // never equal "v2", so this only affects corrupt junk — which Slice 5b's
  // round-trip verify would quarantine. Classifier must match how the decrypt
  // path would treat it: "v1", not "invalid".
  check("'v2:a:b' (3 segments) classifies as v1, mirroring decryptWithPurpose",
    detectCiphertextVersion("v2:a:b") === "v1");
}

console.log("detectCiphertextVersion — idempotent / deterministic");
{
  const v1 = makeV1Fixture("payload");
  const v2 = encryptWithPurpose("payload", EncryptionPurpose.DATE_OF_BIRTH);
  check("v1 classification is stable across calls",
    detectCiphertextVersion(v1) === detectCiphertextVersion(v1));
  check("v2 classification is stable across calls",
    detectCiphertextVersion(v2) === detectCiphertextVersion(v2));
  // Re-classifying a value that is already v2 never reports it as needing work.
  check("re-detecting v2 stays 'v2' (no phantom v1)",
    detectCiphertextVersion(v2) === "v2" && detectCiphertextVersion(v2) === "v2");
}

// ── round-trip encrypt/decrypt ───────────────────────────────────────────────

console.log("round-trip — encryptWithPurpose / decryptWithPurpose");
{
  for (const purpose of Object.values(EncryptionPurpose)) {
    const plain = `secret-for-${purpose}`;
    const ct = encryptWithPurpose(plain, purpose);
    check(`round-trips for purpose '${purpose}'`,
      decryptWithPurpose(ct, purpose) === plain);
  }

  const unicode = "dob-1990-05-01 · ünïcödé · 🔐";
  const ct = encryptWithPurpose(unicode, EncryptionPurpose.DATE_OF_BIRTH);
  check("round-trips a unicode payload",
    decryptWithPurpose(ct, EncryptionPurpose.DATE_OF_BIRTH) === unicode);

  // Two encryptions of the same plaintext differ (random IV) but both decrypt back.
  const a = encryptWithPurpose("same", EncryptionPurpose.PLAID_ACCESS_TOKEN);
  const b = encryptWithPurpose("same", EncryptionPurpose.PLAID_ACCESS_TOKEN);
  check("distinct IVs produce distinct ciphertext", a !== b);
  check("both distinct ciphertexts decrypt to same plaintext",
    decryptWithPurpose(a, EncryptionPurpose.PLAID_ACCESS_TOKEN) === "same" &&
    decryptWithPurpose(b, EncryptionPurpose.PLAID_ACCESS_TOKEN) === "same");
}

// ── decryptWithPurpose dual-format compatibility ─────────────────────────────

console.log("decryptWithPurpose — dual-format (v1 + v2) compatibility");
{
  // v1 was written with the root key (no purpose), so it decrypts under ANY
  // purpose — decryptWithPurpose uses the root key for the v1 branch.
  const plain = "legacy-access-token";
  const v1 = makeV1Fixture(plain);
  check("reads a v1 (legacy root-key) value",
    decryptWithPurpose(v1, EncryptionPurpose.PLAID_ACCESS_TOKEN) === plain);
  check("v1 read is purpose-independent (root key)",
    decryptWithPurpose(v1, EncryptionPurpose.TOTP_SECRET) === plain);

  // v2 is purpose-bound: decrypting under the WRONG purpose must fail (GCM tag).
  const v2 = encryptWithPurpose(plain, EncryptionPurpose.PLAID_ACCESS_TOKEN);
  check("reads a v2 value under the correct purpose",
    decryptWithPurpose(v2, EncryptionPurpose.PLAID_ACCESS_TOKEN) === plain);
  check("v2 under the WRONG purpose throws (auth-tag mismatch)",
    throws(() => decryptWithPurpose(v2, EncryptionPurpose.TOTP_SECRET)));

  check("malformed ciphertext throws in decryptWithPurpose",
    throws(() => decryptWithPurpose("not-a-ciphertext", EncryptionPurpose.TOTP_SECRET)));

  // The audit classifier and decryptWithPurpose agree on what is/ isn't legacy.
  check("classifier 'v1' ⇒ decryptWithPurpose accepts it as legacy",
    detectCiphertextVersion(v1) === "v1" &&
    decryptWithPurpose(v1, EncryptionPurpose.PLAID_ACCESS_TOKEN) === plain);
}

// ── tamper detection (GCM integrity) ─────────────────────────────────────────

console.log("integrity — tampered ciphertext is rejected");
{
  const v2 = encryptWithPurpose("intact", EncryptionPurpose.CONNECTION_CREDENTIAL);
  const parts = v2.split(":");
  const badTag = crypto.randomBytes(16).toString("hex");
  const tampered = [parts[0], parts[1], badTag, parts[3]].join(":");
  check("tampered auth tag causes decrypt to throw",
    throws(() => decryptWithPurpose(tampered, EncryptionPurpose.CONNECTION_CREDENTIAL)));
}

// ---------------------------------------------------------------------------

console.log("");
if (failures === 0) {
  console.log("All SEC-1/KD-6 encryption cases passed.");
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}

/**
 * lib/plaid/encryption.test.ts
 *
 * SEC-1 / KD-6 — Slice 5a unit coverage for the D14 encryption module, plus the
 * PRIV-004 KEYRING matrix (v3 + key ids + ENCRYPTION_KEY_PREVIOUS).
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`:
 *
 *     npx tsx lib/plaid/encryption.test.ts
 *
 * Every key below is generated IN THIS PROCESS (crypto.randomBytes) or is a
 * fixed obviously-fake constant; no real key is ever read.
 *
 * Covers: v1/v2/v3 detection, malformed detection, round-trip, dual-format
 * (legacy) reads, tamper detection, and the keyring: current, previous, unknown
 * kid throws, legacy v1/v2 under current AND previous, tampered tag throws,
 * PREVIOUS unset = the pre-keyring behaviour, compact seals across a rotation.
 */

import crypto from "crypto";
import {
  EncryptionPurpose,
  encryptWithPurpose,
  decryptWithPurpose,
  decryptWithPurposeReportingKey,
  detectCiphertextVersion,
  ciphertextKeyId,
  keyIdOf,
  keyringKeyIds,
  previousKeyProblem,
  sealWithPurpose,
  openWithPurpose,
  openWithPurposeReportingKey,
} from "./encryption";

// A deterministic 32-byte key so this test never depends on the environment.
const KEY_A = "a".repeat(64);
process.env.ENCRYPTION_KEY = KEY_A;
delete process.env.ENCRYPTION_KEY_PREVIOUS;

// ── Test-only legacy fixture generators ──────────────────────────────────────
// They reproduce the RETIRED write formats exactly, so the suite can still
// assert that every value already at rest decrypts, without a production
// encryptor for either format.

/** v1: root-key AES-256-GCM, "iv:authTag:ciphertext". */
function makeV1Fixture(plaintext: string, keyHex = process.env.ENCRYPTION_KEY as string): string {
  const rootKey = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", rootKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

/** v2: HKDF(root, purpose) subkey, "v2:iv:authTag:ciphertext" — the pre-keyring write format. */
function makeV2Fixture(plaintext: string, purpose: string, keyHex = process.env.ENCRYPTION_KEY as string): string {
  const sub = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(keyHex, "hex"), Buffer.alloc(0), purpose, 32));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", sub, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", iv.toString("hex"), cipher.getAuthTag().toString("hex"), enc.toString("hex")].join(":");
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

function throws(fn: () => unknown, match?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return match ? match.test(e instanceof Error ? e.message : String(e)) : true;
  }
}

/** Run `fn` with the keyring set to (current, previous); restores afterwards. */
function withKeys<T>(current: string, previous: string | undefined, fn: () => T): T {
  const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
  process.env.ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS;
  else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  try { return fn(); } finally {
    process.env.ENCRYPTION_KEY = saved.c;
    if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS;
    else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
  }
}

const freshKey = () => crypto.randomBytes(32).toString("hex");
const kidOfHex = (hex: string) => keyIdOf(Buffer.from(hex, "hex"));

// ── detectCiphertextVersion ──────────────────────────────────────────────────

console.log("detectCiphertextVersion — v3 detection (the current write format)");
{
  const v3 = encryptWithPurpose("hello", EncryptionPurpose.TOTP_SECRET);
  check("a fresh encryptWithPurpose value is 'v3'", detectCiphertextVersion(v3) === "v3");
  check("v3 value carries the v3: prefix", v3.startsWith("v3:"));
  check("v3 value has 5 colon-segments", v3.split(":").length === 5);
  check("v3 segment 2 is the current key id (8 lowercase hex = sha256(key)[0..8])",
    v3.split(":")[1] === kidOfHex(KEY_A) && /^[0-9a-f]{8}$/.test(v3.split(":")[1])
      && kidOfHex(KEY_A) === crypto.createHash("sha256").update(Buffer.from(KEY_A, "hex")).digest("hex").slice(0, 8));
  check("ciphertextKeyId reads the kid of a v3 value without decrypting", ciphertextKeyId(v3) === kidOfHex(KEY_A));
  check("the kid is not the key (a fingerprint, not a prefix of the hex)", !KEY_A.startsWith(kidOfHex(KEY_A)));
}

console.log("detectCiphertextVersion — v2 detection");
{
  const v2 = makeV2Fixture("hello", EncryptionPurpose.TOTP_SECRET);
  check("a v2 value is 'v2'", detectCiphertextVersion(v2) === "v2");
  check("v2 value carries the v2: prefix", v2.startsWith("v2:"));
  check("v2 value has 4 colon-segments", v2.split(":").length === 4);
  check("ciphertextKeyId of a legacy v2 value is null (it names no key)", ciphertextKeyId(v2) === null);
}

console.log("detectCiphertextVersion — v1 detection");
{
  const v1 = makeV1Fixture("hello"); // legacy root-key format: iv:tag:ct
  check("real legacy ciphertext is 'v1'", detectCiphertextVersion(v1) === "v1");
  check("v1 value has 3 colon-segments", v1.split(":").length === 3);
  check("v1 value has no v2: prefix", !v1.startsWith("v2:"));
  check("ciphertextKeyId of a legacy v1 value is null", ciphertextKeyId(v1) === null);
}

console.log("detectCiphertextVersion — malformed / invalid");
{
  check("empty string is invalid", detectCiphertextVersion("") === "invalid");
  check("single token is invalid", detectCiphertextVersion("garbage") === "invalid");
  check("two segments is invalid", detectCiphertextVersion("a:b") === "invalid");
  check("five segments with a v2 prefix is invalid", detectCiphertextVersion("v2:a:b:c:d") === "invalid");
  check("4 segments without v2 prefix is invalid (not v2)",
    detectCiphertextVersion("v1:a:b:c") === "invalid");
  check("v3 with a kid that is not 8 lowercase hex is invalid",
    detectCiphertextVersion("v3:ABCDEF12:a:b:c") === "invalid" && detectCiphertextVersion("v3:abc:a:b:c") === "invalid");
  check("v3 with 4 or 6 segments is invalid",
    detectCiphertextVersion("v3:abcdef12:a:b") === "invalid" && detectCiphertextVersion("v3:abcdef12:a:b:c:d") === "invalid");
  // Faithful-to-decryptWithPurpose edge: ANY 3-segment value routes to the v1
  // branch, even a "v2:"-prefixed one. A genuine v1 IV is 32 hex chars and can
  // never equal "v2", so this only affects corrupt junk. Classifier must match
  // how the decrypt path would treat it: "v1", not "invalid".
  check("'v2:a:b' (3 segments) classifies as v1, mirroring decryptWithPurpose",
    detectCiphertextVersion("v2:a:b") === "v1");
  check("a malformed v3 kid throws 'Invalid ciphertext format' in decryptWithPurpose (classifier and decrypt agree)",
    throws(() => decryptWithPurpose("v3:ABCDEF12:00:00:00", EncryptionPurpose.TOTP_SECRET), /Invalid ciphertext format/));
}

console.log("detectCiphertextVersion — idempotent / deterministic");
{
  const v1 = makeV1Fixture("payload");
  const v2 = makeV2Fixture("payload", EncryptionPurpose.DATE_OF_BIRTH);
  const v3 = encryptWithPurpose("payload", EncryptionPurpose.DATE_OF_BIRTH);
  check("v1 classification is stable across calls",
    detectCiphertextVersion(v1) === detectCiphertextVersion(v1));
  check("v2 classification is stable across calls",
    detectCiphertextVersion(v2) === detectCiphertextVersion(v2));
  check("v3 classification is stable across calls (no phantom legacy)",
    detectCiphertextVersion(v3) === "v3" && detectCiphertextVersion(v3) === "v3");
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

  // v3 keeps v2's per-purpose derivation: the body after the kid is decryptable
  // with exactly the v2 subkey, and a v3 value under the wrong purpose fails.
  const v3 = encryptWithPurpose("derivation", EncryptionPurpose.TOTP_SECRET);
  const [, , iv, tag, body] = v3.split(":");
  check("v3 body opens as a v2 value under the same key (derivation unchanged: HKDF-SHA-256, empty salt, purpose label)",
    decryptWithPurpose(["v2", iv, tag, body].join(":"), EncryptionPurpose.TOTP_SECRET) === "derivation");
  check("v3 under the WRONG purpose throws (purpose isolation kept)",
    throws(() => decryptWithPurpose(v3, EncryptionPurpose.DATE_OF_BIRTH)));
}

// ── decryptWithPurpose dual-format compatibility ─────────────────────────────

console.log("decryptWithPurpose — legacy (v1 + v2) compatibility");
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
  const v2 = makeV2Fixture(plain, EncryptionPurpose.PLAID_ACCESS_TOKEN);
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
  const v3 = encryptWithPurpose("intact", EncryptionPurpose.CONNECTION_CREDENTIAL);
  const p3 = v3.split(":");
  const badTag = crypto.randomBytes(16).toString("hex");
  check("tampered auth tag on a v3 value causes decrypt to throw",
    throws(() => decryptWithPurpose([p3[0], p3[1], p3[2], badTag, p3[4]].join(":"), EncryptionPurpose.CONNECTION_CREDENTIAL)));
  const v2 = makeV2Fixture("intact", EncryptionPurpose.CONNECTION_CREDENTIAL);
  const p2 = v2.split(":");
  check("tampered auth tag on a v2 value causes decrypt to throw",
    throws(() => decryptWithPurpose([p2[0], p2[1], badTag, p2[3]].join(":"), EncryptionPurpose.CONNECTION_CREDENTIAL)));
}

// ── KEYRING matrix (PRIV-004) ────────────────────────────────────────────────

console.log("keyring — PREVIOUS unset is the pre-keyring behaviour (only new writes change, to v3)");
{
  const K = freshKey();
  withKeys(K, undefined, () => {
    const ids = keyringKeyIds();
    check("keyring has the current kid and no previous", ids.current === kidOfHex(K) && ids.previous === null);
    const v2 = makeV2Fixture("old-row", EncryptionPurpose.TOTP_SECRET, K);
    const v1 = makeV1Fixture("older-row", K);
    check("an existing v2 value still decrypts", decryptWithPurpose(v2, EncryptionPurpose.TOTP_SECRET) === "old-row");
    check("an existing v1 value still decrypts", decryptWithPurpose(v1, EncryptionPurpose.TOTP_SECRET) === "older-row");
    const v3 = encryptWithPurpose("new-row", EncryptionPurpose.TOTP_SECRET);
    check("a new write is v3 under the current kid", detectCiphertextVersion(v3) === "v3" && ciphertextKeyId(v3) === kidOfHex(K));
    // Pre-keyring failure surface: a value under another key fails GCM authentication.
    const foreignV2 = makeV2Fixture("x", EncryptionPurpose.TOTP_SECRET, freshKey());
    check("a v2 value under a key not in the keyring still fails GCM authentication (same error class as before)",
      throws(() => decryptWithPurpose(foreignV2, EncryptionPurpose.TOTP_SECRET), /unable to authenticate|Unsupported state/i));
    check("missing ENCRYPTION_KEY keeps its exact message (lib/plaid/errors.ts matches on it)",
      withKeys("", undefined, () => throws(() => encryptWithPurpose("x", EncryptionPurpose.TOTP_SECRET), /^ENCRYPTION_KEY must be exactly 64 hex characters/)));
    check("an empty ENCRYPTION_KEY_PREVIOUS is the same as unset",
      withKeys(K, "", () => keyringKeyIds().previous === null && decryptWithPurpose(v2, EncryptionPurpose.TOTP_SECRET) === "old-row"));
    check("a PREVIOUS equal to the current key collapses to no previous",
      withKeys(K, K, () => keyringKeyIds().previous === null));
  });
}

console.log("keyring — current and previous during a rotation");
{
  const OLD = freshKey();
  const NEW = freshKey();
  // Values written before the rotation, under OLD only.
  const before = withKeys(OLD, undefined, () => ({
    v3: encryptWithPurpose("plaid-token", EncryptionPurpose.PLAID_ACCESS_TOKEN),
    seal: sealWithPurpose("evidence", EncryptionPurpose.BETA_ABUSE_EVIDENCE),
  }));
  const legacyV2Old = makeV2Fixture("totp-seed", EncryptionPurpose.TOTP_SECRET, OLD);
  const legacyV1Old = makeV1Fixture("dob", OLD);
  const legacyV2New = makeV2Fixture("totp-seed-2", EncryptionPurpose.TOTP_SECRET, NEW);
  const legacyV1New = makeV1Fixture("dob-2", NEW);

  withKeys(NEW, OLD, () => {
    const ids = keyringKeyIds();
    check("keyring reports both kids (current = new, previous = old)", ids.current === kidOfHex(NEW) && ids.previous === kidOfHex(OLD));
    const fresh = encryptWithPurpose("fresh", EncryptionPurpose.PLAID_ACCESS_TOKEN);
    check("new writes are under the CURRENT kid", ciphertextKeyId(fresh) === kidOfHex(NEW));
    check("current: a v3 value under the current kid decrypts and reports that kid",
      JSON.stringify(decryptWithPurposeReportingKey(fresh, EncryptionPurpose.PLAID_ACCESS_TOKEN)) === JSON.stringify({ plaintext: "fresh", kid: kidOfHex(NEW) }));
    check("previous: a v3 value under the previous kid decrypts and reports the previous kid",
      JSON.stringify(decryptWithPurposeReportingKey(before.v3, EncryptionPurpose.PLAID_ACCESS_TOKEN)) === JSON.stringify({ plaintext: "plaid-token", kid: kidOfHex(OLD) }));
    check("legacy v2 under CURRENT decrypts (reported under the current kid)",
      decryptWithPurposeReportingKey(legacyV2New, EncryptionPurpose.TOTP_SECRET).kid === kidOfHex(NEW)
        && decryptWithPurpose(legacyV2New, EncryptionPurpose.TOTP_SECRET) === "totp-seed-2");
    check("legacy v2 under PREVIOUS decrypts (current fails GCM cleanly, previous is tried)",
      decryptWithPurposeReportingKey(legacyV2Old, EncryptionPurpose.TOTP_SECRET).kid === kidOfHex(OLD)
        && decryptWithPurpose(legacyV2Old, EncryptionPurpose.TOTP_SECRET) === "totp-seed");
    check("legacy v1 under CURRENT decrypts", decryptWithPurposeReportingKey(legacyV1New, EncryptionPurpose.DATE_OF_BIRTH).kid === kidOfHex(NEW));
    check("legacy v1 under PREVIOUS decrypts",
      decryptWithPurposeReportingKey(legacyV1Old, EncryptionPurpose.DATE_OF_BIRTH).kid === kidOfHex(OLD)
        && decryptWithPurpose(legacyV1Old, EncryptionPurpose.DATE_OF_BIRTH) === "dob");
    check("a compact seal from before the rotation opens under PREVIOUS",
      openWithPurposeReportingKey(before.seal, EncryptionPurpose.BETA_ABUSE_EVIDENCE).kid === kidOfHex(OLD)
        && openWithPurpose(before.seal, EncryptionPurpose.BETA_ABUSE_EVIDENCE) === "evidence");
    check("a new compact seal is under CURRENT",
      openWithPurposeReportingKey(sealWithPurpose("e2", EncryptionPurpose.BETA_ABUSE_EVIDENCE), EncryptionPurpose.BETA_ABUSE_EVIDENCE).kid === kidOfHex(NEW));

    // Unknown kid: fail closed — never tried against the keys that exist.
    const STRANGER = freshKey();
    const foreign = withKeys(STRANGER, undefined, () => encryptWithPurpose("x", EncryptionPurpose.PLAID_ACCESS_TOKEN));
    check("unknown kid THROWS (fail closed)",
      throws(() => decryptWithPurpose(foreign, EncryptionPurpose.PLAID_ACCESS_TOKEN), /key id is not in the keyring/));
    // Same bytes, kid rewritten to the current kid: the kid is not trusted as a hint — GCM still decides.
    const relabelled = ["v3", kidOfHex(NEW), ...foreign.split(":").slice(2)].join(":");
    check("a value relabelled with a known kid still fails GCM (the kid selects a key; it authenticates nothing)",
      throws(() => decryptWithPurpose(relabelled, EncryptionPurpose.PLAID_ACCESS_TOKEN)));
    const msg = (() => { try { decryptWithPurpose(foreign, EncryptionPurpose.PLAID_ACCESS_TOKEN); return ""; } catch (e) { return (e as Error).message; } })();
    check("the unknown-kid error names no kid and no key material",
      !msg.includes(kidOfHex(STRANGER)) && !msg.includes(kidOfHex(NEW)) && !msg.includes(NEW) && !msg.includes(OLD) && !msg.includes(STRANGER));

    // Tampered tag under each key throws — on BOTH keys for kid-less values.
    const badTag = crypto.randomBytes(16).toString("hex");
    const pv = before.v3.split(":");
    check("tampered tag on a previous-kid v3 value throws",
      throws(() => decryptWithPurpose([pv[0], pv[1], pv[2], badTag, pv[4]].join(":"), EncryptionPurpose.PLAID_ACCESS_TOKEN)));
    const p2 = legacyV2Old.split(":");
    check("tampered tag on a legacy v2 value throws after both keys are tried",
      throws(() => decryptWithPurpose([p2[0], p2[1], badTag, p2[3]].join(":"), EncryptionPurpose.TOTP_SECRET), /unable to authenticate|Unsupported state/i));
    const p1 = legacyV1Old.split(":");
    check("tampered tag on a legacy v1 value throws after both keys are tried",
      throws(() => decryptWithPurpose([p1[0], badTag, p1[2]].join(":"), EncryptionPurpose.TOTP_SECRET)));
  });

  // After the rotation completes and PREVIOUS is removed: old-kid values are gone for good.
  withKeys(NEW, undefined, () => {
    check("PREVIOUS removed: a previous-kid v3 value now fails closed (unknown kid)",
      throws(() => decryptWithPurpose(before.v3, EncryptionPurpose.PLAID_ACCESS_TOKEN), /key id is not in the keyring/));
    check("PREVIOUS removed: a legacy value under the old key no longer decrypts",
      throws(() => decryptWithPurpose(legacyV2Old, EncryptionPurpose.TOTP_SECRET)));
    check("PREVIOUS removed: an old compact seal no longer opens", throws(() => openWithPurpose(before.seal, EncryptionPurpose.BETA_ABUSE_EVIDENCE)));
  });
}

console.log("keyring — ENCRYPTION_KEY_PREVIOUS validation (value-free)");
{
  check("unset ⇒ no problem", previousKeyProblem({} as unknown as NodeJS.ProcessEnv) === null);
  check("64 hex ⇒ no problem", previousKeyProblem({ ENCRYPTION_KEY_PREVIOUS: freshKey() } as unknown as NodeJS.ProcessEnv) === null);
  const bad = "zz" + "1".repeat(62);
  const p = previousKeyProblem({ ENCRYPTION_KEY_PREVIOUS: bad } as unknown as NodeJS.ProcessEnv);
  check("non-hex ⇒ a problem that does not echo the value", p !== null && !p.includes(bad));
  check("wrong length ⇒ a problem", previousKeyProblem({ ENCRYPTION_KEY_PREVIOUS: "ab" } as unknown as NodeJS.ProcessEnv) !== null);
  check("a malformed PREVIOUS makes every keyring use throw (never silently ignored)",
    withKeys(freshKey(), "not-a-key", () => throws(() => encryptWithPurpose("x", EncryptionPurpose.TOTP_SECRET), /ENCRYPTION_KEY_PREVIOUS/)));
}

// ---------------------------------------------------------------------------

console.log("");
if (failures === 0) {
  console.log("All SEC-1/KD-6 + keyring encryption cases passed.");
  process.exit(0);
} else {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}

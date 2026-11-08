/**
 * lib/plaid/encryption.ts
 *
 * AES-256-GCM encryption with HKDF per-purpose key derivation (D14), over a
 * KEYRING of root keys (PRIV-004 rotation, 2026-11).
 *
 * Root keys: ENCRYPTION_KEY (the CURRENT key — every new write) plus an
 * optional ENCRYPTION_KEY_PREVIOUS (read-only, exists only during a rotation;
 * docs/operations/key-rotation.md). Each is 64 hex chars / 32 bytes. Each root
 * key has a KEY ID (kid): the first 8 hex characters of SHA-256(key bytes) — a
 * non-secret fingerprint that names WHICH root key sealed a value without
 * revealing it. Purpose-derived subkeys are produced from the root via
 * HKDF-SHA-256 — one subkey per named purpose — so a value sealed for one field
 * can never be opened as another.
 *
 * Ciphertext formats
 * ──────────────────
 *   Legacy (v1):   iv:authTag:ciphertext             root key, no kid
 *   Default (v2):  v2:iv:authTag:ciphertext          purpose-derived key, no kid
 *                                                     (every write outside a rotation)
 *   Rotation (v3): v3:kid:iv:authTag:ciphertext      purpose-derived key (same
 *                                                     HKDF as v2) of the root
 *                                                     key whose kid is `kid`
 *
 * v3 is v2 plus the key id: the derivation is unchanged, so the only thing a
 * rotation changes is WHICH root key the derivation starts from.
 *
 * Reads (decryptWithPurpose):
 *   v3  the kid selects the root key. A kid not in the keyring THROWS — fail
 *       closed: an unknown kid is never "tried" against whatever keys exist.
 *   v2 / v1 (no kid)  tried under the current key, then the previous one. A
 *       wrong key fails GCM authentication, which is caught and the next key is
 *       tried; if none authenticates, the call throws.
 * Writes (encryptWithPurpose) are under the current key, and their FORMAT
 * follows whether a rotation is in progress (S2 ruling, B10 rollback safety):
 *   no rotation (PREVIOUS unset, or EQUAL to the current key — ignored with a
 *     boot warning)            → v2, byte-for-byte the pre-keyring write format
 *   rotation (a DISTINCT PREVIOUS is set) → v3 under the current kid
 * Why: the release before the keyring reads only v1/v2. While no rotation has
 * started, every value this module writes stays readable by that release, so
 * rolling the deploy back loses nothing (lib/plaid/encryption-b9-compat.test.ts
 * proves it against that release's own frozen code). From step (b) of
 * docs/operations/key-rotation.md on, writes are v3 and the rollback boundary is
 * crossed for good.
 *
 * With ENCRYPTION_KEY_PREVIOUS unset the keyring holds one key and the module
 * behaves exactly as the pre-keyring one did: v2 writes, and every existing
 * v1/v2 value decrypts exactly as before.
 *
 * ⚠️ Nothing here logs. Key material, the kid→key association and plaintext
 * must never reach a log line, an error message or a report; thrown messages
 * name the rule, never a value.
 *
 * Generate a key: openssl rand -hex 32
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
  /**
   * The AI conversation's runtime state as it crosses the browser boundary.
   *
   * ⚠️ NOT A STORED FIELD — the only purpose here that seals something the
   * SERVER hands out and takes back. A stateless chat turn must carry the
   * hypothetical under discussion across an HTTP hop; sealing it with an
   * authenticated cipher is what makes the thing that comes back trustworthy
   * without trusting the client that returned it. Same mechanism, same root
   * key, its own subkey — inventing a second signing scheme for one cookie
   * would be two idioms for one problem.
   */
  AI_RUNTIME_STATE:      "ai_runtime_state",
  /**
   * BetaAbuseEvidence.sealedPayload — the preserved earliest verified
   * suspicious beta application (owner P2-1, 2026-11-01). Sealed with
   * sealWithPurpose (authenticated, compact); opened only by a fresh
   * SYSTEM_ADMIN read that is audited (lib/platform/growth/beta-abuse-evidence.ts).
   */
  BETA_ABUSE_EVIDENCE:   "beta_abuse_evidence",
  /**
   * PlatformAiMessage.contentEncrypted — one operator's Platform AI message
   * (B11; docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §2.3): the SCRUBBED
   * question, or the rendered answer as versioned segment JSON. Cipher format
   * (v2 outside a rotation, v3 during one — #364); written only by
   * lib/platform/intelligence/ai/conversations/store.ts.
   */
  PLATFORM_AI_MESSAGE:   "platform_ai_message",
  /**
   * PlatformAiMemoryFact.noteEncrypted — the operator's own ≤ 140-character note
   * on a Platform AI memory fact (operational memory design v2, D2). Written only
   * by lib/platform/intelligence/ai/memory/store.ts.
   */
  PLATFORM_AI_MEMORY:    "platform_ai_memory",
  /**
   * The Platform AI memory PROPOSAL TOKEN (design v2 §2, B5) — NOT A STORED FIELD:
   * a sealed proposal the server hands to the confirm card and takes back
   * (15 minutes, single-use jti), and the subkey of the HMAC shingles it carries
   * (key_memory). Its own purpose, never the conversations key.
   */
  PLATFORM_AI_MEMORY_TOKEN: "platform_ai_memory_token",
} as const;

export type EncryptionPurpose = typeof EncryptionPurpose[keyof typeof EncryptionPurpose];

// ─── Keyring (PRIV-004 rotation) ─────────────────────────────────────────────

/** First 8 hex chars of SHA-256(root key bytes). Non-secret; names a key without revealing it. */
export function keyIdOf(rootKey: Buffer): string {
  return crypto.createHash("sha256").update(rootKey).digest("hex").slice(0, 8);
}

const KID = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

interface KeyringEntry { kid: string; rootKey: Buffer }
interface Keyring { current: KeyringEntry; previous: KeyringEntry | null }

function getRootKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters. Run: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Why ENCRYPTION_KEY_PREVIOUS is unusable, or null when it is unset or valid.
 * Value-free: the message names the rule, never the value. Shared by the
 * keyring (throws on use) and lib/env.ts validateEnv() (refuses to boot).
 */
export function previousKeyProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const hex = env.ENCRYPTION_KEY_PREVIOUS;
  if (hex === undefined || hex === "") return null;
  if (!HEX64.test(hex)) return "ENCRYPTION_KEY_PREVIOUS, when set, must be exactly 64 hex characters.";
  const cur = env.ENCRYPTION_KEY;
  if (!cur || cur.length !== 64) return null;
  const curKey = Buffer.from(cur, "hex"), prevKey = Buffer.from(hex, "hex");
  // The SAME key is a harmless copy-paste slip: it collapses to "no previous"
  // with a boot warning (previousKeyWarning) and must never take the app down.
  if (curKey.equals(prevKey)) return null;
  // DISTINCT keys whose 32-bit fingerprints collide would make a v3 kid name two
  // keys — refused rather than guessed.
  if (keyIdOf(curKey) === keyIdOf(prevKey)) {
    return "ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS are different keys with the same key id (a fingerprint collision); generate a new key.";
  }
  return null;
}

export const PREVIOUS_EQUALS_CURRENT_WARNING = "ENCRYPTION_KEY_PREVIOUS equals ENCRYPTION_KEY — ignored; rotation not in progress";

/**
 * The boot WARNING (never a failure) for ENCRYPTION_KEY_PREVIOUS === ENCRYPTION_KEY,
 * or null. The keyring treats that state as "no previous"; the rotation script
 * refuses it (a rotation needs two different keys). Value-free.
 */
export function previousKeyWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const cur = env.ENCRYPTION_KEY, prev = env.ENCRYPTION_KEY_PREVIOUS;
  if (!cur || !prev || cur.length !== 64 || !HEX64.test(prev)) return null;
  return Buffer.from(cur, "hex").equals(Buffer.from(prev, "hex")) ? PREVIOUS_EQUALS_CURRENT_WARNING : null;
}

/**
 * The keyring, read from the environment on every call (as the single-key
 * module always did — tests and scripts change the key between calls).
 * A malformed PREVIOUS, or a DISTINCT one whose kid collides with the current
 * kid, THROWS — see previousKeyProblem(). A PREVIOUS equal to the current key
 * collapses to "no previous" (see previousKeyWarning()).
 */
function getKeyring(): Keyring {
  const rootKey = getRootKey();
  const current = { kid: keyIdOf(rootKey), rootKey };
  const problem = previousKeyProblem();
  if (problem) throw new Error(problem);
  const prevHex = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (!prevHex) return { current, previous: null };
  const prevKey = Buffer.from(prevHex, "hex");
  if (prevKey.equals(rootKey)) return { current, previous: null };
  return { current, previous: { kid: keyIdOf(prevKey), rootKey: prevKey } };
}

/** Key ids only — never key material. `previous` is null outside a rotation. */
export function keyringKeyIds(): { current: string; previous: string | null } {
  const k = getKeyring();
  return { current: k.current.kid, previous: k.previous?.kid ?? null };
}

/** Current first: the order a kid-less (legacy) value is tried in. */
function keysInReadOrder(k: Keyring): KeyringEntry[] {
  return k.previous ? [k.current, k.previous] : [k.current];
}

// ─── HKDF helper (Slice 1) ───────────────────────────────────────────────────

/**
 * Derive a 32-byte AES-256 subkey from a root key for the given purpose.
 * Uses HKDF-SHA-256 with an empty salt (root key already has full entropy)
 * and the purpose string as the info label. Identical for v2 and v3.
 */
function deriveKey(purpose: EncryptionPurpose, rootKey: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", rootKey, Buffer.alloc(0), purpose, 32),
  );
}

/**
 * Try each key in order; return the first result that authenticates. A GCM
 * authentication failure (wrong key, tampered value) moves to the next key;
 * when none authenticates, the FIRST key's error is rethrown, so a single-key
 * keyring fails exactly as the single-key module did.
 */
function firstAuthenticating<T>(keys: KeyringEntry[], attempt: (e: KeyringEntry) => T): { value: T; kid: string } {
  let firstError: unknown = null;
  for (const entry of keys) {
    try {
      return { value: attempt(entry), kid: entry.kid };
    } catch (e) {
      if (firstError === null) firstError = e;
    }
  }
  throw firstError ?? new Error("No key available");
}

// ─── AES-256-GCM primitives ──────────────────────────────────────────────────

function aesgcmEncrypt(key: Buffer, plaintext: string): string {
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

/** GCM tag length, pinned on decrypt for v1/v2/v3 alike: a truncated tag is refused, never accepted as a shorter one. */
const GCM_TAG_BYTES = 16;

function aesgcmDecrypt(key: Buffer, ivHex: string, tagHex: string, encHex: string): string {
  const iv      = Buffer.from(ivHex,  "hex");
  const tag     = Buffer.from(tagHex, "hex");
  const enc     = Buffer.from(encHex, "hex");
  if (tag.length !== GCM_TAG_BYTES) throw new Error("Invalid authentication tag length");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

// ─── Purpose-aware API (Slice 3) ─────────────────────────────────────────────

/**
 * Encrypt plaintext with a purpose-derived subkey of the CURRENT root key.
 *
 *   no rotation in progress (no DISTINCT ENCRYPTION_KEY_PREVIOUS):
 *     v2 — "v2:iv:authTag:ciphertext", exactly the pre-keyring format, so the
 *     previous release can still read it (rollback-safe)
 *   rotation in progress (a DISTINCT ENCRYPTION_KEY_PREVIOUS is set):
 *     v3 — "v3:kid:iv:authTag:ciphertext" under the current kid, so the
 *     rotation script can tell it apart from values under the previous key
 *
 * All segments hex-encoded. A PREVIOUS equal to the current key is "no previous"
 * (getKeyring), so it writes v2.
 */
export function encryptWithPurpose(plaintext: string, purpose: EncryptionPurpose): string {
  const { current, previous } = getKeyring();
  const body = aesgcmEncrypt(deriveKey(purpose, current.rootKey), plaintext);
  return previous ? `v3:${current.kid}:${body}` : `v2:${body}`;
}

/**
 * Decrypt a ciphertext in any supported format, reporting the kid of the root
 * key that opened it. Shared by decryptWithPurpose() and the rotation script
 * (scripts/rotate-encryption-key.ts), which needs to know whether a legacy
 * value is already under the current key — never the key itself.
 *
 *   v3  — "v3:kid:iv:authTag:ciphertext" — the root key named by kid; an
 *          unknown kid THROWS (fail closed)
 *   v2  — "v2:iv:authTag:ciphertext"    — derived key; current, then previous
 *   v1  — "iv:authTag:ciphertext"       — root key;    current, then previous
 */
export function decryptWithPurposeReportingKey(ciphertext: string, purpose: EncryptionPurpose): { plaintext: string; kid: string } {
  const parts = ciphertext.split(":");

  if (parts.length === 5 && parts[0] === "v3") {
    if (!KID.test(parts[1])) throw new Error("Invalid ciphertext format");
    const entry = keysInReadOrder(getKeyring()).find((k) => k.kid === parts[1]);
    if (!entry) throw new Error("Ciphertext key id is not in the keyring (ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS)");
    return { plaintext: aesgcmDecrypt(deriveKey(purpose, entry.rootKey), parts[2], parts[3], parts[4]), kid: entry.kid };
  }

  if (parts.length === 4 && parts[0] === "v2") {
    const r = firstAuthenticating(keysInReadOrder(getKeyring()),
      (e) => aesgcmDecrypt(deriveKey(purpose, e.rootKey), parts[1], parts[2], parts[3]));
    return { plaintext: r.value, kid: r.kid };
  }

  if (parts.length === 3) {
    // v1 legacy: root key — backward compatibility
    const r = firstAuthenticating(keysInReadOrder(getKeyring()),
      (e) => aesgcmDecrypt(e.rootKey, parts[0], parts[1], parts[2]));
    return { plaintext: r.value, kid: r.kid };
  }

  throw new Error("Invalid ciphertext format");
}

/**
 * Decrypt a ciphertext produced by encryptWithPurpose() (v2, or v3 during a
 * rotation) or the retired root-key encrypt() (v1). See
 * decryptWithPurposeReportingKey() for the per-format key rules.
 */
export function decryptWithPurpose(ciphertext: string, purpose: EncryptionPurpose): string {
  return decryptWithPurposeReportingKey(ciphertext, purpose).plaintext;
}

// ─── Version classifier (Slice 5a — SEC-1/KD-6 audit support) ─────────────────
//
// Pure, read-only. Does NOT decrypt and touches no key material. Mirrors the
// format discriminator inside decryptWithPurpose() so the re-encryption audit
// and its tests share one source of truth. Additive only — no existing
// behavior, write path, or compatibility branch is changed by this.

export type CiphertextVersion = "v1" | "v2" | "v3" | "invalid";

/**
 * Classify a stored ciphertext string by format, without decrypting it.
 *
 *   "v3"      — "v3:kid:iv:authTag:ciphertext" (5 segments, kid = 8 lowercase hex)
 *   "v2"      — "v2:iv:authTag:ciphertext" (4 segments, derived-key format)
 *   "v1"      — "iv:authTag:ciphertext"    (3 segments, legacy root-key format)
 *   "invalid" — anything else (would throw in decryptWithPurpose)
 *
 * Callers are responsible for handling null/empty before calling this.
 * Faithful to decryptWithPurpose(): a value classified "v1", "v2" or "v3" is
 * one it would attempt to decrypt; "invalid" is one it would reject.
 */
export function detectCiphertextVersion(value: string): CiphertextVersion {
  const parts = value.split(":");
  if (parts.length === 5 && parts[0] === "v3" && KID.test(parts[1])) return "v3";
  if (parts.length === 4 && parts[0] === "v2") return "v2";
  if (parts.length === 3) return "v1";
  return "invalid";
}

/** The kid a v3 value names, or null for a legacy (kid-less) or invalid value. No decryption. */
export function ciphertextKeyId(value: string): string | null {
  return detectCiphertextVersion(value) === "v3" ? value.split(":")[1] : null;
}

// ─── Legacy API removed (Slice 5c) ───────────────────────────────────────────
//
// The deprecated root-key encrypt()/decrypt() exports were removed once every
// call site had migrated to the purpose-aware variants above (Slice 4) and the
// KD-6 audit confirmed zero v1 rows. Reading any residual legacy v1 ciphertext
// is still supported via the v1 branch of decryptWithPurpose() above; that
// backward-compatibility branch is retained until its own removal gate (0 v1
// rows across all environments + backup-retention window) is met.

// ─── Compact sealed tokens (FM-AUDIT-018) ────────────────────────────────────
//
// For a value the SERVER hands out and takes back through a size-limited
// carrier (the AI runtime-state cookie), not for a stored field. Same purpose
// subkey, same AES-256-GCM — only the transport encoding differs: one base64url
// string ("c1." + iv‖tag‖ciphertext) instead of three hex segments. Hex spends
// two characters per byte; base64url spends 1.33, so the same cookie carries
// ~50% more plaintext without the cookie growing a byte. The IV is the 12 bytes
// GCM is specified for, and the tag length is pinned to 16 on BOTH sides, so a
// truncated tag is refused rather than accepted as a shorter one.

const COMPACT_PREFIX = "c1.";
const COMPACT_IV_BYTES = 12;
const COMPACT_TAG_BYTES = 16;

// KEYRING: the compact form carries NO kid — its one stored user
// (BetaAbuseEvidence.sealedPayload) is a low-volume table and its other user is a
// cookie whose byte budget is pinned (lib/ai/conversation/runtime-state.ts), so
// the format is unchanged. Seals are written under the CURRENT key; opens try
// current, then previous (exactly as a kid-less v1/v2 value is read). The
// rotation script tells which key opened a stored seal through
// openWithPurposeReportingKey() and re-seals the ones the current key did not.

export function sealWithPurpose(plaintext: string, purpose: EncryptionPurpose): string {
  const key = deriveKey(purpose, getKeyring().current.rootKey);
  const iv = crypto.randomBytes(COMPACT_IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: COMPACT_TAG_BYTES });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return COMPACT_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

export function openWithPurposeReportingKey(sealed: string, purpose: EncryptionPurpose): { plaintext: string; kid: string } {
  if (!sealed.startsWith(COMPACT_PREFIX)) throw new Error("Invalid sealed token format");
  const raw = Buffer.from(sealed.slice(COMPACT_PREFIX.length), "base64url");
  if (raw.length < COMPACT_IV_BYTES + COMPACT_TAG_BYTES) throw new Error("Sealed token too short");
  const iv = raw.subarray(0, COMPACT_IV_BYTES);
  const tag = raw.subarray(COMPACT_IV_BYTES, COMPACT_IV_BYTES + COMPACT_TAG_BYTES);
  const enc = raw.subarray(COMPACT_IV_BYTES + COMPACT_TAG_BYTES);
  const r = firstAuthenticating(keysInReadOrder(getKeyring()), (e) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(purpose, e.rootKey), iv, { authTagLength: COMPACT_TAG_BYTES });
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  });
  return { plaintext: r.value, kid: r.kid };
}

// ─── Purpose-keyed HMAC (Platform AI memory shingles, design v2 B5) ──────────

/**
 * HMAC-SHA256 of `message` under the PURPOSE subkey of a keyring root key (the
 * same HKDF derivation as the ciphers, so the MAC key is domain-separated by
 * purpose and never the root key). `kid` selects the keyring entry (current by
 * default; the previous key during a rotation) — a proposal token records the
 * kid its shingles were computed under, and its confirm recomputes under the
 * same one. Throws (value-free) for an unknown kid. Never logs.
 */
export function macWithPurpose(message: string, purpose: EncryptionPurpose, opts: { kid?: string } = {}): { mac: Buffer; kid: string } {
  const k = getKeyring();
  const entry = opts.kid === undefined ? k.current : [k.current, k.previous].find((e) => e !== null && e.kid === opts.kid) ?? null;
  if (!entry) throw new Error("Unknown key id for this keyring");
  return { mac: crypto.createHmac("sha256", deriveKey(purpose, entry.rootKey)).update(message, "utf8").digest(), kid: entry.kid };
}

export function openWithPurpose(sealed: string, purpose: EncryptionPurpose): string {
  return openWithPurposeReportingKey(sealed, purpose).plaintext;
}

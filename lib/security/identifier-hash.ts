/**
 * lib/security/identifier-hash.ts  (Comms Center A-2b — owner decision O-8, AUDIT R-3)
 *
 * The salted hash that replaces a raw login identifier or IP address wherever
 * the Security Ops anomaly detector leaves a value OUTSIDE the AuditLog: the
 * staff notification's `metadata.anomalyKey` and its `dedupeKey`
 * ("SECURITY_ANOMALY_DETECTED:{anomalyKey}:open").
 *
 *   identifier:<login identifier>  →  identifier:h<32 hex>
 *   recovery:<login identifier>    →  recovery:h<32 hex>
 *   ip:<address>                   →  ip:h<32 hex>
 *   system_admin_disabled          →  unchanged (it names no person or address)
 *
 * The hash is HMAC-SHA256(salt, value) over the trimmed, lower-cased value,
 * truncated to 128 bits. Deterministic for a given salt, so suppress-while-open
 * dedupe still works (the same identifier ⇒ the same key ⇒ one open bell). The
 * KIND prefix is kept: it is not personal data and Security Ops reads it.
 *
 * SALT: SECURITY_IDENTIFIER_HASH_SALT, a server-side secret. It is deliberately
 * NOT COMMS_RECIPIENT_HASH_SALT: that salt keys the delivery ledger's hash of
 * recipient ADDRESSES (correlation for the account purge); this one keys
 * attacker-controlled login identifiers and source IPs for Security Ops. The
 * two have different owners, consumers and rotation needs, and sharing one
 * salt would let a value hashed in one place be matched in the other.
 *
 * UNSET SALT: never a plaintext value and never an unsalted hash (an unsalted
 * SHA-256 of an IPv4 address is a 2^32 lookup away from the address). The
 * fallback is STABLE and DOMAIN-SEPARATED: HMAC-SHA256(NEXTAUTH_SECRET,
 * "fm:sec-id-hash:v1") — every instance of a deployment derives the same salt,
 * so dedupe holds across instances, and the derived value reveals nothing about
 * the session secret. Only with NEXTAUTH_SECRET unset too (a broken
 * deployment: auth itself cannot run) does it fall back to a random
 * per-process salt — still never plaintext. The env report is a "fail" in
 * Production while SECURITY_IDENTIFIER_HASH_SALT is unset (lib/env.ts); nothing
 * on the login path throws over it.
 *
 * OPERATOR CORRELATION: the raw key stays on the SECURITY_ANOMALY_DETECTED
 * AuditLog row (`metadata.key`), unchanged, and that row now also carries
 * `metadata.keyHash` — the exact value in the bell's anomalyKey — so an
 * operator holding a bell finds its trip row by keyHash, and from there the
 * raw identifier/IP under the audit log's own access controls.
 *
 * Pure apart from reading the injected env and the one-time random fallback.
 */

import { createHmac, randomBytes } from "node:crypto";

/** The env var holding the salt. Secret: set per environment, never committed, never logged. */
export const SECURITY_IDENTIFIER_HASH_SALT_ENV = "SECURITY_IDENTIFIER_HASH_SALT";

/** A structural subset of process.env (the index signature lets process.env itself be passed). */
export interface IdentifierHashEnv {
  SECURITY_IDENTIFIER_HASH_SALT?: string;
  /** Only the stable fallback reads it (domain-separated derivation, never used directly). */
  NEXTAUTH_SECRET?: string;
  [key: string]: string | undefined;
}

/** The domain-separation label of the fallback derivation. Bump the version to rotate. */
export const FALLBACK_SALT_LABEL = "fm:sec-id-hash:v1";

/** Hex characters kept from the HMAC (128 bits). */
const HASH_HEX_LENGTH = 32;

/** The detector key kinds whose value identifies a person or an address. */
const HASHED_KINDS = ["identifier", "recovery", "ip", "platform-denied"] as const;

let processFallbackSalt: string | null = null;

function saltFrom(env: IdentifierHashEnv): string {
  const configured = env.SECURITY_IDENTIFIER_HASH_SALT;
  if (configured) return configured;
  // Stable across instances: derived from the deployment's session secret, domain-separated.
  if (env.NEXTAUTH_SECRET) return createHmac("sha256", env.NEXTAUTH_SECRET).update(FALLBACK_SALT_LABEL).digest("hex");
  // Last resort (no server secret at all): random per process — never plaintext, never unsalted.
  if (processFallbackSalt === null) processFallbackSalt = randomBytes(32).toString("hex");
  return processFallbackSalt;
}

/** True when a deployment salt is configured (tests and the env report). */
export function identifierHashSaltConfigured(env: IdentifierHashEnv): boolean {
  return Boolean(env.SECURITY_IDENTIFIER_HASH_SALT);
}

/** HMAC-SHA256(salt, trimmed lower-cased value), first 128 bits, hex. */
export function hashSecurityIdentifier(value: string, env: IdentifierHashEnv = process.env): string {
  return createHmac("sha256", saltFrom(env))
    .update(value.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}

/** True when a key is already in the hashed form (idempotence guard). */
export function isHashedAnomalyKey(key: string): boolean {
  return new RegExp(`^(${HASHED_KINDS.join("|")}):h[0-9a-f]{${HASH_HEX_LENGTH}}$`).test(key);
}

/**
 * The detector's raw anomaly key → the form that may leave the AuditLog.
 * Idempotent. An unrecognised key with a ":" is hashed whole under "other:"
 * (fail safe: an unknown shape is assumed to carry a value).
 */
export function hashedAnomalyKey(rawKey: string, env: IdentifierHashEnv = process.env): string {
  if (isHashedAnomalyKey(rawKey)) return rawKey;
  const i = rawKey.indexOf(":");
  if (i === -1) return rawKey === "system_admin_disabled" ? rawKey : `other:h${hashSecurityIdentifier(rawKey, env)}`;
  const kind = rawKey.slice(0, i);
  const value = rawKey.slice(i + 1);
  if ((HASHED_KINDS as readonly string[]).includes(kind)) return `${kind}:h${hashSecurityIdentifier(value, env)}`;
  return `other:h${hashSecurityIdentifier(rawKey, env)}`;
}

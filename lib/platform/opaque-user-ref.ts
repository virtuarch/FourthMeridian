/**
 * lib/platform/opaque-user-ref.ts  (PRIV-ref — THE opaque customer reference)
 *
 * The ONE definition of the opaque per-customer reference every operator
 * surface shows (AI spend and budget, the budget-calls drilldown, cost
 * controls, policy-assignment health, connection diagnostics, removed
 * connections, provider cleanup, the spend and assignment alerts):
 *
 *   ref = "user #" + hex( HMAC-SHA256( K, userId ) )[0..8]
 *   K   = HMAC-SHA256( NEXTAUTH_SECRET, "fm/opaque-user-ref/v1" )
 *
 * WHY A KEYED DIGEST. It used to be `user …${userId.slice(-6)}` — the literal
 * tail of the cuid. Anyone who sees full ids elsewhere (Customer Success, a
 * URL, an export) could match it, and the budget drilldown now lays out a
 * per-call timeline per reference. A keyed digest is stable (the same user
 * gives the same reference on every surface and every instance, so it still
 * correlates rows) but cannot be computed or reversed without the server key.
 *
 * WHY NEXTAUTH_SECRET. No new env var (that would need Vercel configuration the
 * owner controls). NEXTAUTH_SECRET is the server-only secret REQUIRED in every
 * environment (lib/env.ts REQUIRED_KEYS — auth cannot run without it). It is
 * never used directly: K is derived under a fixed, versioned label, so the
 * reference key is domain-separated from the session-signing key and from the
 * other derivation on the same secret (lib/security/identifier-hash.ts,
 * "fm:sec-id-hash:v1"). Bump the label to rotate the references on purpose.
 *
 * CONSEQUENCES (owner-visible): references changed format at this release; and
 * rotating NEXTAUTH_SECRET rotates every reference (old ones stop matching).
 *
 * FAIL CLOSED: with no NEXTAUTH_SECRET the reference is "customer" — never the
 * raw suffix, never an unkeyed hash.
 *
 * DEDUPE TOKENS (opaqueDedupeToken) are what alert dedupe keys and Attention
 * row ids carry. With the secret they are the reference's own 8 hex (same K).
 * Without it they must NOT collapse to "customer" — that would let one
 * customer's open breach suppress another's — so they fall back to a RANDOM
 * per-process key (the lib/security/identifier-hash.ts posture): distinct per
 * customer, stable within an instance, at worst a duplicate notification per
 * instance, never a suppressed one. Never the raw id (dedupe keys are
 * persisted: notification dedupeKey, JobRun summary) and never an unkeyed
 * SHA-256 of a cuid (low entropy, matchable against an id list). SERVER-ONLY: the key never leaves this
 * module and the user id is never logged.
 */

import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { OPAQUE_USER_REF_FALLBACK, OPAQUE_USER_REF_HEX, OPAQUE_USER_REF_PREFIX } from "./opaque-user-ref-format";

/** The domain-separation label. Versioned: a new label is a deliberate rotation. */
export const OPAQUE_USER_REF_LABEL = "fm/opaque-user-ref/v1";

let cache: { secret: string; key: Buffer } | null = null;

function keyFor(secret: string): Buffer {
  if (cache && cache.secret === secret) return cache.key;
  const key = createHmac("sha256", secret).update(OPAQUE_USER_REF_LABEL).digest();
  cache = { secret, key };
  return key;
}

/** The reference for `userId` under an explicit secret (tests; the env-reading form is below). */
export function opaqueUserRefWith(userId: string, secret: string | undefined | null): string {
  if (!secret) return OPAQUE_USER_REF_FALLBACK;
  const hex = createHmac("sha256", keyFor(secret)).update(userId, "utf8").digest("hex");
  return `${OPAQUE_USER_REF_PREFIX}${hex.slice(0, OPAQUE_USER_REF_HEX)}`;
}

/** THE opaque customer reference. Reads NEXTAUTH_SECRET at call time; "customer" when it is absent. */
export function opaqueUserRef(userId: string): string {
  return opaqueUserRefWith(userId, process.env.NEXTAUTH_SECRET);
}

let processDedupeKey: Buffer | null = null;

/** The dedupe token under an explicit secret: the ref's 8 hex with one; a random per-process key without. */
export function opaqueDedupeTokenWith(userId: string, secret: string | undefined | null): string {
  let key: Buffer;
  if (secret) key = keyFor(secret);
  else {
    // Never "customer", never unkeyed, never the id: random per process (duplicates possible, suppression never).
    if (processDedupeKey === null) processDedupeKey = randomBytes(32);
    key = processDedupeKey;
  }
  return createHmac("sha256", key).update(userId, "utf8").digest("hex").slice(0, OPAQUE_USER_REF_HEX);
}

/** THE dedupe token for alert keys and Attention row ids. Distinct per customer even with no secret. */
export function opaqueDedupeToken(userId: string): string {
  return opaqueDedupeTokenWith(userId, process.env.NEXTAUTH_SECRET);
}

/**
 * A KEYED fingerprint (8 hex) of `value` under the SAME mechanism as the reference — HMAC-SHA256 keyed by a
 * key derived from NEXTAUTH_SECRET under a versioned label — but with ITS OWN purpose label (domain-separated
 * from the reference key and from every other purpose). For audit correlation of operator input that must
 * never be stored (Platform AI people-picker search, S2 09fc P4). No secret ⇒ null (never an unkeyed hash).
 */
export function opaquePurposeFingerprintWith(purpose: string, value: string, secret: string | undefined | null): string | null {
  if (!secret || !purpose || purpose === OPAQUE_USER_REF_LABEL) return null;
  const key = createHmac("sha256", secret).update(purpose).digest();
  return createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, OPAQUE_USER_REF_HEX);
}

/** The keyed purpose fingerprint under the server secret (null without it). */
export function opaquePurposeFingerprint(purpose: string, value: string): string | null {
  return opaquePurposeFingerprintWith(purpose, value, process.env.NEXTAUTH_SECRET);
}

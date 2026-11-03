/**
 * lib/platform/opaque-user-ref-format.ts  (PRIV-ref — the opaque customer reference's SHAPE)
 *
 * The client-safe half of the opaque customer reference: its format, its
 * token, and the fail-closed word. No key, no digest, no crypto — the value
 * itself is computed ONLY on the server (opaque-user-ref.ts). Client views and
 * pure folds import this module to parse or filter a reference they were given.
 *
 *   "user #3fa9c21b"   a keyed digest of the user id (8 hex), never a slice of it
 *   "customer"         the fail-closed reference when the server has no key
 */

export const OPAQUE_USER_REF_PREFIX = "user #";
/** Hex characters of the truncated HMAC kept in a reference (32 bits). */
export const OPAQUE_USER_REF_HEX = 8;
/** The reference when no key is available: correlates nothing, reveals nothing. */
export const OPAQUE_USER_REF_FALLBACK = "customer";

/** An owner-filter token: exactly the 8 hex of a reference. */
export const OPAQUE_USER_REF_TOKEN = /^[0-9a-f]{8}$/;

/** "user #3fa9c21b" → "3fa9c21b"; null for "customer", "—" or anything else. */
export function opaqueRefToken(ref: string | null | undefined): string | null {
  if (!ref || !ref.startsWith(OPAQUE_USER_REF_PREFIX)) return null;
  const t = ref.slice(OPAQUE_USER_REF_PREFIX.length);
  return OPAQUE_USER_REF_TOKEN.test(t) ? t : null;
}

/** "3fa9c21b" → "user #3fa9c21b" (the owner filter matches whole references). */
export function opaqueRefOfToken(token: string): string {
  return `${OPAQUE_USER_REF_PREFIX}${token}`;
}

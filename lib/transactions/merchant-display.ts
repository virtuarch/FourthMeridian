/**
 * lib/transactions/merchant-display.ts
 *
 * Merchant Intelligence — M6 read-cutover presentation helpers (MI1).
 *
 * Pure, deterministic, no I/O. The single place that decides how a resolved
 * Merchant is presented, so every read surface (list serializer, detail, AI
 * assembler) cuts over identically:
 *   • display name  = Merchant.displayName when a Merchant is resolved, else the
 *                     original provider descriptor (never lost).
 *   • logo url      = Merchant.logoUrl when present, else null (surfaces fall
 *                     back to their existing icons).
 * Additive by construction — the raw descriptor is always the caller's own
 * `merchant` field; these helpers never replace it.
 */

/** The resolved-Merchant fields the read surfaces select (via `resolvedMerchant`). */
export interface ResolvedMerchantLike {
  displayName: string;
  logoUrl: string | null;
}

/** Display name: the resolved Merchant's name, else the raw provider descriptor. */
export function merchantDisplayName(
  rawMerchant: string,
  resolved: ResolvedMerchantLike | null | undefined,
): string {
  return resolved?.displayName ?? rawMerchant;
}

/** Logo url: the resolved Merchant's logo, else null (caller falls back to an icon). */
export function merchantLogoUrl(resolved: ResolvedMerchantLike | null | undefined): string | null {
  return resolved?.logoUrl ?? null;
}

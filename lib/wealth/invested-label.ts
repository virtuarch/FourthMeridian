/**
 * lib/wealth/invested-label.ts  (2026-10-07)
 *
 * The name of the `invested` figure, from the asset classes the user actually
 * holds. The figure itself is canonical — SpaceSnapshot stocks + crypto — and is
 * never touched here; only its label is.
 *
 * It used to be the static "Investments & crypto" for everyone, so a user with a
 * $23,952.74 401(k) and IRA and no crypto at all read a heading implying crypto
 * was part of their wealth (Preview dogfood, 2026-10-07). The evidence is the
 * as-of composition's own `investments` and `crypto` components — two disjoint
 * snapshot buckets — never an inference from the combined total.
 *
 * Neither class present ⇒ null: callers omit the line rather than manufacture a
 * category to keep a label.
 */

/** Below half a cent is no holding at all (float residue of a balance sum). */
const PRESENT = 0.005;

export type InvestedLabel = "Investments" | "Investments & crypto" | "Crypto";

export function investedClassLabel(c: { investments: number; crypto: number }): InvestedLabel | null {
  const investments = Math.abs(c.investments) >= PRESENT;
  const crypto      = Math.abs(c.crypto) >= PRESENT;
  if (investments && crypto) return "Investments & crypto";
  if (investments) return "Investments";
  if (crypto) return "Crypto";
  return null;
}

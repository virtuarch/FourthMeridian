/**
 * lib/assets/manual-asset.ts   (RWA-1 — real-world assets, UI exposure)
 *
 * The small, pure vocabulary the manual-asset surfaces share. No React, no DB,
 * no ambient clock — `now` is an argument wherever age is computed.
 *
 * A manual asset is a FinancialAccount the user typed in (type `other`,
 * syncStatus `"manual"`, created by POST /api/accounts/manual). Its balance is
 * the USER'S ESTIMATE — never an observation of a feed and never a verified
 * market price — and every surface that shows one must say so. The wording that
 * makes that claim lives here, once, so the card, the forms and the empty states
 * cannot drift apart.
 */

import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";

/**
 * The currencies a manual asset may be entered in — EXACTLY the server's
 * allowlist (`isSupportedCurrency`, which POST /api/accounts/manual enforces).
 * The form used to offer 7 of these 25, so most valid currencies could not be
 * chosen; a list kept anywhere else would drift the other way.
 */
export const MANUAL_ASSET_CURRENCIES: readonly string[] = [FX_BASE, ...SUPPORTED_QUOTES];

/** The one-sentence disclosure every manual value carries somewhere on screen. */
export const ESTIMATE_DISCLOSURE =
  "This is your estimate, not a verified market price.";

/** The short tag beside a manual value. */
export const ESTIMATE_TAG = "Your estimate";

/** The value field's label — names the currency actually selected. */
export function estimateValueLabel(currency: string): string {
  return `Your estimate of its value (${currency})`;
}

/**
 * Parse a typed amount. Commas and surrounding spaces are tolerated; anything
 * that is not a finite, non-negative number is null (the server refuses the
 * same set — `balance < 0` and NaN — so the form never submits what it rejects).
 */
export function parseEstimateInput(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const MS_PER_DAY = 86_400_000;

/**
 * "updated today" / "updated 3 days ago" / "updated 2 months ago" /
 * "updated over a year ago". Coarse on purpose: an estimate's age matters in
 * weeks and months, and a precise timestamp would imply a precision the value
 * itself does not have. Null for an unparseable instant — never a made-up age.
 */
export function describeEstimateAge(updatedAt: string | null | undefined, now: Date): string | null {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, Math.floor((now.getTime() - t) / MS_PER_DAY));
  if (days === 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 31) return `updated ${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (days < 365) return `updated ${months} month${months === 1 ? "" : "s"} ago`;
  return "updated over a year ago";
}

/** The full caption under a manual value: "Your estimate · updated 2 months ago". */
export function estimateCaption(updatedAt: string | null | undefined, now: Date): string {
  const age = describeEstimateAge(updatedAt, now);
  return age ? `${ESTIMATE_TAG} · ${age}` : ESTIMATE_TAG;
}

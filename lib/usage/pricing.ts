/**
 * lib/usage/pricing.ts  (Wave 2 S7 — OPTIONAL, off by default)
 *
 * Per-unit price constants for turning raw usage counters into an *approximate*
 * dollar estimate. This is deliberately code (not schema, not PlatformSetting):
 * prices are contract-specific, change over time, and true billing is NOT
 * programmatically reconcilable from Plaid/OpenAI (their billing APIs aren't
 * pollable by this app). So this is a leading-indicator estimate only.
 *
 * SHIPS EMPTY: with no entries populated, `estimateSpendUsd` returns null and
 * the widget shows NO dollar figure at all — the honest default. Populate a key
 * (e.g. from your actual OpenAI pricing sheet) to opt into the estimate; the
 * widget then labels it explicitly as an estimate, never as billed cost.
 *
 * Key shape: `${provider}:${metric}:${unit}` → USD per single unit.
 *   e.g. "OPENAI:chat.completions:gpt-4o-mini:prompt_tokens": 0.00000015
 * (metric already contains the model, so the model is captured without a
 * separate dimension.)
 */

/** USD per one unit, keyed `${provider}:${metric}:${unit}`. Empty = no estimate. */
export const UNIT_PRICES_USD: Record<string, number> = {
  // Intentionally empty. Add entries to enable the estimated-spend figure, e.g.:
  // "OPENAI:chat.completions:gpt-4o-mini:prompt_tokens":     0.00000015,
  // "OPENAI:chat.completions:gpt-4o-mini:completion_tokens": 0.00000060,
};

/** True iff any price is configured (drives whether the widget shows an estimate). */
export function isPricingConfigured(): boolean {
  return Object.keys(UNIT_PRICES_USD).length > 0;
}

/**
 * Estimate USD for a single (provider, metric, unit, count) tuple, or null when
 * no price is configured for it. Callers sum the non-null results; if the whole
 * price map is empty, the total is null and no figure is shown.
 */
export function estimateUnitSpendUsd(provider: string, metric: string, unit: string, count: number): number | null {
  const price = UNIT_PRICES_USD[`${provider}:${metric}:${unit}`];
  if (price === undefined) return null;
  return price * count;
}

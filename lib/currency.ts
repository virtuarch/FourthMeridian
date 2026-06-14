/**
 * Display currency constants
 *
 * This is the single source of truth for the app's display currency.
 * Currently hardcoded to USD — replace the source here (user preference,
 * workspace preference, or app-wide setting) when multi-currency support
 * is added. No changes to individual components should be needed.
 *
 * Future shape:
 *   export const DEFAULT_DISPLAY_CURRENCY = userPreference ?? workspacePreference ?? "USD";
 */

export const DEFAULT_DISPLAY_CURRENCY = "USD";

/**
 * Shared formatter. Pass `currency` explicitly when you have a native account
 * currency that differs from the display currency (e.g. a EUR savings account).
 * Leave it undefined to fall back to the app display currency.
 */
export function formatCurrency(
  amount: number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
  compact = false,
): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    notation:              compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  }).format(amount);
}

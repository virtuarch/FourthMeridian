/**
 * Display currency constants
 *
 * DEFAULT_DISPLAY_CURRENCY is the build-time constant and universal FALLBACK.
 * The runtime per-Space display currency (MC1 Phase 4, plan D-1) is supplied
 * by lib/currency-context.tsx: the dashboard layout mounts
 * DisplayCurrencyProvider with Space.reportingCurrency, and AGGREGATE surfaces
 * read it via useDisplayCurrency() (which falls back to this constant when no
 * provider is mounted — the kill switch). ITEMIZED rows (a single account's
 * balance, a single transaction) format in their own native row `currency`,
 * never the display currency.
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

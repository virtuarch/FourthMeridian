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

/**
 * Whole-currency label (no fractional digits) — the canonical formatter for
 * aggregate/balance figures. Identical to `formatCurrency(amount, currency)`;
 * kept as a named export because it is the historical spelling used across the
 * Space dashboard and section renderers. Consolidated here (SEC-3) so there is
 * ONE implementation instead of the former per-module copies.
 */
export function formatBalance(amount: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  return formatCurrency(amount, currency);
}

/**
 * The bare currency symbol for a currency code (e.g. "$", "€", "﷼") — used for
 * form-toggle glyphs, axis ticks, and slider bound labels. USD ⇒ "$", so
 * all-USD surfaces render unchanged. For every valid ISO 4217 code `Intl`
 * always yields a currency part; the `?? currency` fallback only matters for an
 * invalid code (unreachable — currencies come from validated Space/account
 * fields), so this is behavior-identical to the former per-module copies for
 * all real inputs. Consolidated here (SEC-3).
 */
export function currencySymbol(currency: string): string {
  const part = new Intl.NumberFormat("en-US", { style: "currency", currency })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? currency;
}

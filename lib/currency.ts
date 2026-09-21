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
 * MONEY-PRECISION-1 — THE money presentation contract, in one place.
 *
 *   INSIDE A SPACE      money is shown to the cent: $7,273.88 · $50.00 · −$861.30
 *   OUTSIDE A SPACE     whole dollars, unchanged: `formatCurrencyWhole`
 *
 * A Space is where the user reads their own finances to the cent — a reconciled
 * total, a refund of $861.30, a $24.00 final payment. Rounding those to the
 * dollar was a display decision taken once, in this function's
 * `maximumFractionDigits: 0`, and it made figures that reconcile exactly look
 * like they do not ($9,007.64 spending shown beside two $4,503 halves).
 *
 * The boundary is enforced by WHICH FORMATTER A SURFACE CALLS, not by a runtime
 * flag: `formatCurrency` (this one, cents) is what the Space tree already calls
 * everywhere, so the contract holds without touching those call sites; the few
 * launcher / cross-Space surfaces call `formatCurrencyWhole` explicitly and say
 * why. No caller rounds a value to change its display, and nothing here alters a
 * number: `Intl` rounds for presentation exactly as it always did.
 *
 * COMPACT IS THE ONE EXCEPTION (`compact: true` / `formatCompactCurrency`):
 * "$1.2M" is a deliberate constrained-space notation for chart axes and the
 * Spaces cards, where "$1,234,567.89" cannot fit. Unchanged.
 *
 * Pass `currency` explicitly when you have a native account currency that
 * differs from the display currency (e.g. a EUR savings account); leave it
 * undefined to fall back to the app display currency.
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
    ...(compact
      ? { maximumFractionDigits: 1 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(amount);
}

/**
 * Whole dollars — the OUTSIDE-A-SPACE presentation (MONEY-PRECISION-1).
 *
 * The launcher and cross-Space surfaces compare Spaces at a glance rather than
 * reconciling one Space's figures, so they keep the whole-dollar reading they
 * have always had. Every caller is an explicit, named decision; a surface that
 * shows a Space's own money uses `formatCurrency` and shows the cents.
 */
export function formatCurrencyWhole(
  amount: number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  return new Intl.NumberFormat("en-US", {
    style:                 "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * The canonical formatter for aggregate/balance figures. Identical to
 * `formatCurrency(amount, currency)` — so, since MONEY-PRECISION-1, to the cent
 * inside a Space. Kept as a named export because it is the historical spelling
 * used across the Space dashboard and section renderers. Consolidated here
 * (SEC-3) so there is ONE implementation instead of the former per-module copies.
 * (The name is historical: "balance", not "whole". Whole dollars are
 * `formatCurrencyWhole`.)
 */
export function formatBalance(amount: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  return formatCurrency(amount, currency);
}

/**
 * "$1,234.56" — with cents, SSR-safe. The exact-amount formatter for
 * transaction rows and anywhere cents are material. Moved verbatim from
 * lib/format.ts (REVIEW-3 wave 3) so lib/currency is the ONE currency module;
 * no counterpart previously existed here.
 */
export function formatCurrencyExact(
  amount:   number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  // MONEY-PRECISION-1 — the same format `formatCurrency` now produces. Kept as
  // the name a surface uses when cents are the POINT (a transaction row, a final
  // payment), so that intent stays legible at the call site; one implementation.
  return formatCurrency(amount, currency);
}

/**
 * "$1.2K", "$3.4M" — compact notation, SSR-safe. Use for summary cards and
 * charts. Identical output to `formatCurrency(amount, currency, true)`
 * (verified byte-equivalent across an input battery, REVIEW-3 wave 3); kept as
 * a named export because it is the historical spelling across the widgets.
 */
export function formatCompactCurrency(
  amount:   number,
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  return formatCurrency(amount, currency, true);
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

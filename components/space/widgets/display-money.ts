"use client";

/**
 * components/space/widgets/display-money.ts
 *
 * REVIEW-3 B-5 (E5, matrix row 34) — the ONE fallback rule for widget money
 * labels when no ConversionContext is present.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 * ~20 widgets carried `ctx?.target ?? DEFAULT_DISPLAY_CURRENCY` (or an inline
 * `Intl.NumberFormat(..., { currency: DEFAULT_DISPLAY_CURRENCY })`). With no
 * context, amounts pass through NATIVE and unconverted (the deliberate
 * kill-switch of classifyAccounts/convertMoney) — but the label asserted USD.
 * A failed /api/money/view-context fetch therefore rendered native amounts
 * relabelled USD in the default engaged lens of every category. The honesty
 * doctrine (lib/money/convert.ts) is `amount: null`, never a relabel — the
 * LABEL must obey the same rule as the number.
 *
 * ── The two sanctioned fallbacks ────────────────────────────────────────────
 *   useAggregateCurrency(ctx)   for COMPONENT bodies: the context's target
 *                               when present, else the display-currency
 *                               AUTHORITY (useDisplayCurrency — the Space's
 *                               EFFECTIVE reporting currency, server-resolved
 *                               by the shell layout), never a build-time USD
 *                               literal.
 *   formatAggregateMoney(v,ctx) for PURE render helpers with no hook context:
 *                               with a context, the standard aggregate format
 *                               in ctx.target; without one, the MAGNITUDE with
 *                               NO currency claim ("1,234") — a number of
 *                               unknown currency is stated as a number, not
 *                               dressed as dollars.
 *
 * All-USD production reality: contexts are present after load and every Space
 * is USD, so both fallbacks are visually unreachable today — this closes the
 * latent mislabel, it moves no live pixel.
 */

import { useDisplayCurrency } from "@/lib/currency-context";
import { formatCurrency, formatCurrencyExact } from "@/lib/currency";

/** Minimal structural shape — accepts ConversionContext or its serialized form. */
export interface HasTarget { target: string }

/**
 * The display currency for AGGREGATE labels in a component body: the
 * conversion context's target when one exists, else the display-currency
 * authority. React hook — call unconditionally at the top of the component.
 */
export function useAggregateCurrency(ctx?: HasTarget | null): string {
  const display = useDisplayCurrency();
  return ctx?.target ?? display;
}

/**
 * Aggregate money label for pure helpers: `ctx.target` when a context exists;
 * otherwise the magnitude with NO currency claim. `digits` mirrors the two
 * house formats (0 = formatCurrency, 2 = formatCurrencyExact).
 */
export function formatAggregateMoney(
  v: number,
  ctx?: HasTarget | null,
  digits: 0 | 2 = 0,
): string {
  if (ctx) return digits === 2 ? formatCurrencyExact(v, ctx.target) : formatCurrency(v, ctx.target);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);
}

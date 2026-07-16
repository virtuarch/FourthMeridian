/**
 * lib/liquidity/display-conversion.ts  (SD-6B)
 *
 * THE pure display-currency transform for the Liquidity workspace — the Liquidity
 * analogue of `convertInvestmentsSpaceData` (SD-4D). It converts a canonical
 * `LiquiditySpaceData` (every endpoint valued in the Space REPORTING currency) into
 * the member's selected DISPLAY currency for presentation ONLY:
 *
 *   LiquiditySpaceData (reporting) → convertLiquiditySpaceData(data, ctx)
 *                                  → LiquiditySpaceData (display)
 *
 * WHY this exists (the correctness bug it forecloses): the historical engine
 * (loadLiquiditySpaceData) values every endpoint in the Space reporting currency —
 * the splice stamps investment rows in reporting currency so they identity-convert,
 * so the target MUST stay reporting server-side. Formatting those reporting-currency
 * numbers with a *different* selected display symbol would be a SILENT symbol-only
 * relabel (USD 10,000 shown as “€10,000” with no conversion). This pass performs the
 * actual numeric conversion through the ONE canonical money authority (`convertMoney`
 * / `ConversionContext`, lib/money) — never a bespoke rate, never a second source.
 *
 * PER-DATE (money doctrine D-6/D-8): each historical endpoint converts at its OWN
 * date — `atAsOf` at asOf, `atCompareTo` at compareTo — and the delta is RECOMPUTED
 * from the converted endpoints (by re-running the pure `assembleLiquiditySpaceData`),
 * NOT by converting the reporting-currency delta at a single rate. This is the
 * per-date-correct comparison the mission requires; it never applies today's rate to
 * a historical leg.
 *
 * HONESTY (the money contract, D-3): a missing rate passes the native (reporting)
 * amount through flagged `estimated` — `convertMoney` owns that; we never fabricate a
 * rate. The endpoint's `estimated` flag is OR'd up so the lede shows “≈” and the
 * workspace can note that some values are FX-estimated. Symbol-only relabeling is
 * therefore impossible: a value is either truly converted or honestly flagged.
 *
 * IDENTITY: when the target already IS the reporting currency (the overwhelmingly
 * common case — the display currency defaults to the Space reporting currency), the
 * whole transform short-circuits to the input unchanged (byte-identical, no rate
 * lookups). The all-single-currency path is untouched.
 *
 * `current` is intentionally NOT transformed here — its provenance is dual: on the
 * present-day (client-synthesized) contract it is ALREADY in the display currency
 * (the host fetches the present lens with the view-as target), and on the historical
 * (server) contract it is never surfaced by the workspace (the as-of endpoint drives
 * the lede when a past date is selected). Converting it would double-convert the
 * present-day case. The lede prose (`verdict`) is likewise left as the engine built
 * it — a self-consistent reporting-currency sentence — since regenerating template
 * prose is out of this value-transform's scope (documented workspace limitation).
 *
 * PURE: no DB, no clock, no network. Unit-testable under tsx.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { LensMetric, LensResult } from "@/lib/perspective-engine/types";
import { assembleLiquiditySpaceData, type LiquiditySpaceData } from "./space-data-core";

/** Convert one metric if it is a currency number; report whether the conversion was
 *  estimated (rate walked back / missing / null-residue). Non-currency metrics
 *  (percent/count/text) and string values pass through untouched. */
function convMetric(
  m: LensMetric,
  from: string,
  dateISO: string,
  ctx: ConversionContext,
): { metric: LensMetric; estimated: boolean } {
  if (m.format !== "currency" || typeof m.value !== "number") return { metric: m, estimated: false };
  const c = convertMoney({ amount: m.value, currency: from }, dateISO, ctx);
  return { metric: { ...m, value: c.amount }, estimated: c.estimated };
}

/** Convert every currency metric (and the headline) of ONE endpoint at its own date.
 *  Non-ok endpoints (empty/error/null) pass through unchanged. The endpoint's
 *  `estimated` flag is OR'd with any FX estimation so downstream honesty holds. */
function convLens(
  lens: LensResult | null,
  from: string,
  dateISO: string,
  ctx: ConversionContext,
): LensResult | null {
  if (!lens || lens.status !== "ok") return lens;
  let estimated = lens.estimated ?? false;
  const metrics = lens.metrics.map((m) => {
    const r = convMetric(m, from, dateISO, ctx);
    estimated = estimated || r.estimated;
    return r.metric;
  });
  const headline = lens.headline ? convMetric(lens.headline, from, dateISO, ctx) : null;
  if (headline) estimated = estimated || headline.estimated;
  return {
    ...lens,
    metrics,
    ...(headline ? { headline: headline.metric } : {}),
    estimated,
  };
}

/**
 * Convert a reporting-currency LiquiditySpaceData into the context's display target.
 * Identity when the target already is the reporting currency. Pure.
 */
export function convertLiquiditySpaceData(
  data: LiquiditySpaceData,
  ctx?: ConversionContext,
): LiquiditySpaceData {
  // Identity fast path — no conversion, no rate lookups (all-single-currency path).
  if (!ctx || ctx.target === data.reportingCurrency) return data;

  const from = data.reportingCurrency;
  const atAsOf = convLens(data.atAsOf, from, data.asOf, ctx);
  // compareTo endpoint converts at compareTo's own date (fallback to asOf only when a
  // compareTo endpoint somehow exists without a date — assembleLiquidity ignores it).
  const atCompareTo = convLens(data.atCompareTo, from, data.compareTo ?? data.asOf, ctx);

  // Recompose through the PURE contract so the per-tier delta + net + worst-of trust
  // are rederived from the CONVERTED endpoints — one delta authority, never duplicated
  // here. `current` is carried verbatim (see file header).
  return assembleLiquiditySpaceData({
    asOf: data.asOf,
    compareTo: data.compareTo,
    reportingCurrency: ctx.target,
    current: data.current,
    atAsOf,
    atCompareTo,
  });
}

/**
 * lib/liquidity/display-conversion.test.ts  (SD-6B)
 *
 * Pure fixture test for the Liquidity display-currency transform (house convention,
 * no prisma generate):  npx tsx lib/liquidity/display-conversion.test.ts
 *
 * Pins the FX-correctness contract that forecloses the symbol-only relabel bug:
 *   1. IDENTITY when target === reportingCurrency (byte-unchanged, no relabel).
 *   2. Every currency metric of atAsOf / atCompareTo is NUMERICALLY converted
 *      (scaled by the known rate) — never left at its reporting magnitude.
 *   3. PER-DATE: atAsOf converts at asOf's rate, atCompareTo at compareTo's rate
 *      (different rates per date ⇒ different scale factors applied).
 *   4. delta is RECOMPUTED from the converted endpoints (per-date-correct), not the
 *      reporting delta relabeled.
 *   5. A rate MISS passes the reporting amount through flagged `estimated` (honest
 *      degradation) — never a silent relabel.
 *   6. reportingCurrency is restamped to the target.
 */

import { convertLiquiditySpaceData } from "./display-conversion";
import { assembleLiquiditySpaceData } from "./space-data-core";
import type { ConversionContext } from "@/lib/money/types";
import type { Completeness, LensMetric, LensResult } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function approx(a: number, b: number): boolean { return Math.abs(a - b) < 1e-9; }

function lens(
  values: { cashNow: number; marketable: number; illiquid: number; credit?: number },
  completeness?: Completeness,
): LensResult {
  const metrics: LensMetric[] = [
    { id: "cashNow", label: "Available as cash now", value: values.cashNow, format: "currency" },
    { id: "marketable", label: "Raisable by selling investments", value: values.marketable, format: "currency" },
    { id: "illiquid", label: "Held in other assets", value: values.illiquid, format: "currency" },
  ];
  if (values.credit != null) {
    metrics.push({ id: "availableCredit", label: "Unused credit", value: values.credit, format: "currency" });
  }
  return {
    lensId: "liquidity", lensVersion: 1, scope: { spaceId: "s1", userId: "u1" },
    computedAt: "2026-07-16T00:00:00.000Z", status: "ok", verdict: "About $4,000 …",
    headline: metrics[0], metrics, assumptions: [],
    provenance: { accountIds: ["a"], tierCounts: { full: 1, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: null, redactions: [] },
    ...(completeness ? { completeness } : {}),
  };
}

const DERIVED: Completeness = { tier: "derived", conflict: false, reason: "derived" };
const ESTIMATED: Completeness = { tier: "estimated", conflict: false, reason: "estimated" };

const ASOF = "2026-06-30";
const COMPARE = "2026-05-31";

/** A rate context: USD→EUR at 0.90 on asOf, 0.80 on compareTo (distinct per date), and
 *  a MISS on any other date. metric(v) at asOf ⇒ v*0.90; at compareTo ⇒ v*0.80. */
function eurCtx(): ConversionContext {
  const RATES: Record<string, number> = { [ASOF]: 0.9, [COMPARE]: 0.8 };
  return {
    target: "EUR",
    resolve: (from, dateISO) => {
      const rate = from === "USD" ? RATES[dateISO] : undefined;
      return rate != null
        ? { kind: "rate", rate, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO };
    },
  };
}

function metric(l: LensResult | null, id: string): number {
  const m = l?.metrics.find((x) => x.id === id);
  return m && typeof m.value === "number" ? m.value : NaN;
}

// ── 1. Identity when target === reportingCurrency ────────────────────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: ASOF, compareTo: COMPARE, reportingCurrency: "USD",
    current: lens({ cashNow: 5000, marketable: 3000, illiquid: 0 }),
    atAsOf: lens({ cashNow: 4000, marketable: 5000, illiquid: 1000 }, DERIVED),
    atCompareTo: lens({ cashNow: 3000, marketable: 4200, illiquid: 1000 }, ESTIMATED),
  });
  const usdCtx: ConversionContext = { target: "USD", resolve: (f, d) => ({ kind: "miss", quote: f, requestedDateISO: d }) };
  const out = convertLiquiditySpaceData(data, usdCtx);
  check("identity: returns the SAME object (no relabel) when target === reporting", out === data);
  const outNoCtx = convertLiquiditySpaceData(data, undefined);
  check("identity: no ctx ⇒ unchanged", outNoCtx === data);
}

// ── 2/3/4. Numeric per-date conversion + recomputed delta ────────────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: ASOF, compareTo: COMPARE, reportingCurrency: "USD",
    current: lens({ cashNow: 5000, marketable: 3000, illiquid: 0 }),
    atAsOf: lens({ cashNow: 4000, marketable: 5000, illiquid: 1000, credit: 9000 }, DERIVED),
    atCompareTo: lens({ cashNow: 3000, marketable: 4200, illiquid: 1000, credit: 8000 }, ESTIMATED),
  });
  const out = convertLiquiditySpaceData(data, eurCtx());

  check("reportingCurrency restamped to target", out.reportingCurrency === "EUR");
  // atAsOf @ 0.90
  check("atAsOf cashNow 4000 → 3600 (×0.90)", approx(metric(out.atAsOf, "cashNow"), 3600));
  check("atAsOf marketable 5000 → 4500 (×0.90)", approx(metric(out.atAsOf, "marketable"), 4500));
  check("atAsOf credit 9000 → 8100 (×0.90)", approx(metric(out.atAsOf, "availableCredit"), 8100));
  check("atAsOf headline converted too", approx((out.atAsOf?.headline?.value as number), 3600));
  // atCompareTo @ 0.80 (DISTINCT per-date rate)
  check("atCompareTo cashNow 3000 → 2400 (×0.80)", approx(metric(out.atCompareTo, "cashNow"), 2400));
  check("atCompareTo marketable 4200 → 3360 (×0.80)", approx(metric(out.atCompareTo, "marketable"), 3360));
  // delta recomputed from CONVERTED endpoints (per-date): 3600−2400, 4500−3360, ...
  check("Δcash = 3600 − 2400 = 1200 (per-date, not a relabeled 1000×rate)", approx(out.delta!.cashNow, 1200));
  check("Δmarketable = 4500 − 3360 = 1140", approx(out.delta!.marketable, 1140));
  check("delta.net = 1200 + 1140 + (900−800) = 2440 (credit excluded)", approx(out.delta!.net, 1200 + 1140 + 100));
  check("delta trust preserved (worst-of endpoints)", out.delta!.trust.tier === "estimated");
  // NOT the naive relabel: reporting Δcash was 1000; a symbol-only relabel would show 1000.
  check("delta is NOT the reporting number relabeled (1000)", !approx(out.delta!.cashNow, 1000));
}

// ── 5. Rate MISS ⇒ estimated passthrough (honest, never silent) ──────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: "2026-01-15", compareTo: null, reportingCurrency: "USD",
    current: lens({ cashNow: 5000, marketable: 0, illiquid: 0 }),
    atAsOf: lens({ cashNow: 10000, marketable: 0, illiquid: 0 }, DERIVED),
  });
  const out = convertLiquiditySpaceData(data, eurCtx()); // asOf 2026-01-15 has NO rate
  check("miss: reporting amount passes through (10000, not fabricated)", approx(metric(out.atAsOf, "cashNow"), 10000));
  check("miss: endpoint flagged estimated (≈), never a silent relabel", out.atAsOf?.estimated === true);
  check("miss: currency still restamped to target (honest label + estimated)", out.reportingCurrency === "EUR");
}

if (failures > 0) { console.error(`\ndisplay-conversion.test.ts: ${failures} failure(s)`); process.exit(1); }
console.log("\ndisplay-conversion.test.ts: all checks passed");

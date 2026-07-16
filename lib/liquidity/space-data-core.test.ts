/**
 * lib/liquidity/space-data-core.test.ts  (LIQ-H1)
 *
 * Pure fixture test for the Liquidity composition contract (house convention, no
 * prisma generate):  npx tsx lib/liquidity/space-data-core.test.ts
 *
 * Pins: per-tier delta = pure subtraction; credit EXCLUDED from net; delta only
 * when both endpoints present and ok; worst-of-endpoints trust (tier + conflict +
 * byComponent merge); atAsOf completeness re-surfaced as `trust`; a pure current-
 * state read carries no delta and null trust.
 */

import { assembleLiquiditySpaceData, worstOfCompleteness } from "./space-data-core";
import type { Completeness, LensMetric, LensResult } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function lens(
  values: { cashNow: number; marketable: number; illiquid: number; credit?: number },
  completeness?: Completeness,
  status: "ok" | "empty" = "ok",
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
    lensId: "liquidity",
    lensVersion: 1,
    scope: { spaceId: "s1", userId: "u1" },
    computedAt: "2026-07-16T00:00:00.000Z",
    status,
    headline: metrics[0],
    metrics,
    assumptions: [],
    provenance: { accountIds: ["a"], tierCounts: { full: 1, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: null, redactions: [] },
    ...(completeness ? { completeness } : {}),
  };
}

const DERIVED: Completeness = { tier: "derived", conflict: false, reason: "derived", byComponent: { cash: "derived", marketable: "derived" } };
const ESTIMATED: Completeness = { tier: "estimated", conflict: false, reason: "estimated", byComponent: { cash: "derived", marketable: "estimated" } };

// ── Pure current-state read: no historical endpoints ─────────────────────────
{
  const data = assembleLiquiditySpaceData({ asOf: "2026-07-16", current: lens({ cashNow: 5000, marketable: 3000, illiquid: 0 }) });
  check("current always present", data.current.status === "ok");
  check("no atAsOf on current-only read", data.atAsOf === null);
  check("no atCompareTo", data.atCompareTo === null);
  check("no delta without endpoints", data.delta === null);
  check("null trust on current-only read", data.trust === null);
  check("compareTo defaults null", data.compareTo === null);
  check("reportingCurrency carried (defaulted when omitted)", typeof data.reportingCurrency === "string" && data.reportingCurrency.length > 0);
}

// ── reportingCurrency is carried through verbatim when supplied ───────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: "2026-07-16", reportingCurrency: "EUR",
    current: lens({ cashNow: 1, marketable: 0, illiquid: 0 }),
  });
  check("reportingCurrency = supplied value", data.reportingCurrency === "EUR");
}

// ── asOf only: trust re-surfaced, still no delta ─────────────────────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: "2026-06-30",
    current: lens({ cashNow: 5000, marketable: 3000, illiquid: 0 }),
    atAsOf: lens({ cashNow: 4000, marketable: 2500, illiquid: 0 }, DERIVED),
  });
  check("atAsOf carried", data.atAsOf?.status === "ok");
  check("trust = atAsOf.completeness (pointer)", data.trust === DERIVED);
  check("no delta with only one endpoint", data.delta === null);
}

// ── asOf + compareTo: per-tier delta, credit excluded from net ───────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: "2026-06-30",
    compareTo: "2026-05-31",
    current: lens({ cashNow: 5000, marketable: 3000, illiquid: 0 }),
    atAsOf: lens({ cashNow: 4000, marketable: 5000, illiquid: 1000, credit: 9000 }, DERIVED),
    atCompareTo: lens({ cashNow: 3000, marketable: 4200, illiquid: 1000, credit: 8000 }, ESTIMATED),
  });
  const d = data.delta!;
  check("delta present with both endpoints", d != null);
  check("Δcash = 4000 − 3000 = 1000", d.cashNow === 1000);
  check("Δmarketable = 5000 − 4200 = 800", d.marketable === 800);
  check("Δilliquid = 0", d.illiquid === 0);
  check("Δcredit = 9000 − 8000 = 1000 (reported)", d.credit === 1000);
  check("net = Δcash + Δmarketable + Δilliquid = 1800 (credit EXCLUDED)", d.net === 1800);
  check("delta.from = compareTo, delta.to = asOf", d.from === "2026-05-31" && d.to === "2026-06-30");
  check("delta trust = worst-of endpoints (estimated)", d.trust.tier === "estimated");
  check("delta trust byComponent merged worst (marketable estimated)", d.trust.byComponent?.marketable === "estimated");
}

// ── Delta suppressed when an endpoint is not ok (empty) ───────────────────────
{
  const data = assembleLiquiditySpaceData({
    asOf: "2026-06-30",
    compareTo: "2026-05-31",
    current: lens({ cashNow: 5000, marketable: 0, illiquid: 0 }),
    atAsOf: lens({ cashNow: 4000, marketable: 0, illiquid: 0 }, DERIVED),
    atCompareTo: lens({ cashNow: 0, marketable: 0, illiquid: 0 }, undefined, "empty"),
  });
  check("no delta when an endpoint is not ok", data.delta === null);
}

// ── worstOfCompleteness direct ───────────────────────────────────────────────
{
  const a: Completeness = { tier: "derived", conflict: false, reason: "d", byComponent: { cash: "derived" } };
  const b: Completeness = { tier: "incomplete", conflict: true, reason: "i", byComponent: { cash: "estimated", marketable: "incomplete" } };
  const w = worstOfCompleteness(a, b, "2026-06-30");
  check("worst tier = incomplete", w.tier === "incomplete");
  check("conflict OR'd", w.conflict === true);
  check("byComponent cash worst = estimated", w.byComponent?.cash === "estimated");
  check("byComponent marketable = incomplete", w.byComponent?.marketable === "incomplete");
  check("reason drawn from liquidity vocabulary", w.reason.includes("2026-06-30"));
}

if (failures > 0) {
  console.error(`\nspace-data-core.test.ts: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nspace-data-core.test.ts: all checks passed");

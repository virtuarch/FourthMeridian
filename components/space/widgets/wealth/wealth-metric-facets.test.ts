/**
 * components/space/widgets/wealth/wealth-metric-facets.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). V25-CLOSE-4A.
 *
 * The load-bearing property of this slice is METRIC/COMPONENT ALIGNMENT: the set
 * of driver components a metric shows must reconcile with that metric's delta, so
 * "What moved your assets" adds up to deltas.totalAssets and never silently
 * mixes in a liability. That reconciliation is a fact about the composition
 * algebra, so it can be proven here without React:
 *
 *   totalAssets      = cash + investments + crypto + real      (assets, no debt)
 *   totalLiabilities = liabilities                             (the debt scalar)
 *   liquidNetWorth   = cash − liabilities   (cash folds savings; liab = debt)
 *   netWorth         = assets − liabilities                    (all five)
 *
 * We rebuild each metric's value from a synthetic composition using ONLY its
 * declared components + the known signs, and assert it equals the metric the
 * wealth authority computes from the same numbers. If a component is ever added
 * to or dropped from a metric's set incorrectly, the reconstruction diverges.
 *
 *   npx tsx components/space/widgets/wealth/wealth-metric-facets.test.ts
 */

import {
  METRIC_COMPOSITION_REGIME,
  METRIC_DRIVER_COMPONENTS,
  METRIC_POSSESSIVE,
  showsLiabilityContribution,
  type WealthComponentId,
} from "./wealth-metric-facets";
import type { WealthMetricKey } from "./WealthTrendChart";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ALL_METRICS: WealthMetricKey[] = ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth"];
const ALL_COMPONENTS: WealthComponentId[] = ["cash", "investments", "crypto", "real", "liabilities"];

/**
 * Sign a component contributes to a given metric. Assets are always +1. The
 * `liabilities` sign is metric-dependent and this is the load-bearing subtlety:
 * it is −1 when the metric is net-worth-framed (netWorth, liquidNetWorth — debt
 * reduces the figure), but +1 for `totalLiabilities`, which is measured in its
 * OWN positive-debt space (a bigger debt is a bigger liabilities number). The
 * ledger reflects exactly this: in Liabilities mode a rising debt row and the
 * Net Change total are both positive and both red.
 */
function signFor(metric: WealthMetricKey, id: WealthComponentId): number {
  if (id !== "liabilities") return +1;
  return metric === "totalLiabilities" ? +1 : -1;
}

/**
 * The metric each composition maps to, from first principles — the SAME algebra
 * wealth-time-machine.toState uses (cash already folds savings; liabilities is
 * the debt scalar; real is the residual). This is the independent oracle.
 */
function metricFromComposition(metric: WealthMetricKey, comp: Record<WealthComponentId, number>): number {
  const assets = comp.cash + comp.investments + comp.crypto + comp.real;
  switch (metric) {
    case "totalAssets":      return assets;
    case "totalLiabilities": return comp.liabilities;
    case "liquidNetWorth":   return comp.cash - comp.liabilities;
    case "netWorth":         return assets - comp.liabilities;
  }
}

function main(): void {
  console.log("shape — every metric is mapped, exactly once");
  for (const m of ALL_METRICS) {
    check(`${m}: has a regime`, METRIC_COMPOSITION_REGIME[m] != null);
    check(`${m}: has driver components`, Array.isArray(METRIC_DRIVER_COMPONENTS[m]) && METRIC_DRIVER_COMPONENTS[m].length > 0);
    check(`${m}: has a possessive phrase`, /^your /.test(METRIC_POSSESSIVE[m]));
    check(`${m}: components are all valid + unique`, (() => {
      const c = METRIC_DRIVER_COMPONENTS[m];
      return new Set(c).size === c.length && c.every((x) => ALL_COMPONENTS.includes(x));
    })());
  }

  console.log("RECONCILIATION — a metric's components rebuild its delta (signed)");
  // A representative non-trivial composition. Any composition works; a delta is
  // just a difference of two of these, and the algebra is linear, so proving it
  // on values proves it on deltas.
  const comp: Record<WealthComponentId, number> = {
    cash: 4000, investments: 9000, crypto: 1500, real: 250000, liabilities: 180000,
  };
  for (const m of ALL_METRICS) {
    const reconstructed = METRIC_DRIVER_COMPONENTS[m].reduce((s, id) => s + signFor(m, id) * comp[id], 0);
    const oracle = metricFromComposition(m, comp);
    check(`${m}: Σ(sign × component) equals the metric value`, reconstructed === oracle,
      `rebuilt ${reconstructed} vs ${oracle}`);
  }

  console.log("regime correctness — a liabilities/liquid metric never draws assets");
  check("netWorth renders the assets regime", METRIC_COMPOSITION_REGIME.netWorth === "assets");
  check("totalAssets renders the assets regime", METRIC_COMPOSITION_REGIME.totalAssets === "assets");
  check("totalLiabilities renders the liabilities regime", METRIC_COMPOSITION_REGIME.totalLiabilities === "liabilities");
  check("liquidNetWorth renders the liquid regime", METRIC_COMPOSITION_REGIME.liquidNetWorth === "liquid");

  console.log("assets exclude liabilities; liabilities exclude assets");
  check("Assets driver set has NO liabilities component",
    !METRIC_DRIVER_COMPONENTS.totalAssets.includes("liabilities"));
  check("Liabilities driver set is liabilities-ONLY",
    METRIC_DRIVER_COMPONENTS.totalLiabilities.length === 1 &&
    METRIC_DRIVER_COMPONENTS.totalLiabilities[0] === "liabilities");
  check("Liquid driver set is cash + liabilities only (no investments/crypto/real)",
    METRIC_DRIVER_COMPONENTS.liquidNetWorth.includes("cash") &&
    METRIC_DRIVER_COMPONENTS.liquidNetWorth.includes("liabilities") &&
    !["investments", "crypto", "real"].some((x) => METRIC_DRIVER_COMPONENTS.liquidNetWorth.includes(x as WealthComponentId)));
  check("Net Worth driver set is all five components",
    ALL_COMPONENTS.every((c) => METRIC_DRIVER_COMPONENTS.netWorth.includes(c)));

  console.log("liability contribution row shows for Net Worth only");
  check("netWorth shows the liabilities contribution", showsLiabilityContribution("netWorth"));
  check("totalAssets does NOT", !showsLiabilityContribution("totalAssets"));
  check("totalLiabilities does NOT (it IS the liabilities view)", !showsLiabilityContribution("totalLiabilities"));
  check("liquidNetWorth does NOT", !showsLiabilityContribution("liquidNetWorth"));

  console.log("headings");
  check("net worth phrase", METRIC_POSSESSIVE.netWorth === "your net worth");
  check("assets phrase", METRIC_POSSESSIVE.totalAssets === "your assets");
  check("liabilities phrase", METRIC_POSSESSIVE.totalLiabilities === "your liabilities");
  check("liquid phrase", METRIC_POSSESSIVE.liquidNetWorth === "your liquid net worth");

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

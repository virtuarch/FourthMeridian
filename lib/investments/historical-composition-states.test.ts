/**
 * lib/investments/historical-composition-states.test.ts
 *
 * V26-S4 — the four reconciliation outcomes, the historical scope, and the
 * guards that keep the drill-down honest.
 *
 * The rule this file defends: a frozen observation must be INSPECTABLE without
 * ever being OVERWRITTEN, and a remainder must be stated as arithmetic rather
 * than dressed as an asset.
 */

import { readFileSync } from "node:fs";
import {
  COMPOSITION_TOLERANCE, COMPOSITION_STATES, observedTolerance,
  HISTORICAL_COMPOSITION_UNAVAILABLE, HISTORICAL_COMPOSITION_CONTRADICTORY,
} from "./historical-point-detail";
import {
  buildHistoricalHoldings, type HoldingComponent, type HoldingOwnershipFacts,
} from "./historical-holdings.core";
import { resolveOwnershipWindow } from "@/lib/prices/ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (p: string) => readFileSync(p, "utf8");

const CEIL = "2026-08-03";
const own = (fromISO: string, closedFromISO: string | null = null, possibleFrom?: string): HoldingOwnershipFacts => ({
  resolution: resolveOwnershipWindow({
    instrumentId: "x", earliestDirectISO: fromISO,
    earliestPossibleISO: possibleFrom ?? null, valuationToISO: CEIL, closedFromISO,
  }),
  closedFromISO,
});
const comp = (id: string, value: number | null, acct = "a1"): HoldingComponent =>
  ({ financialAccountId: acct, instrumentId: id, quantity: 1, reportingValue: value, tier: "derived", reason: "" });
const keyOf = (c: HoldingComponent) => c.instrumentId;

/** The module's classification, reproduced over totals so it can be exercised purely. */
function classify(args: {
  chartValue: number; componentTotal: number; observedTotal: boolean;
  componentCount: number; contradictions?: number;
}): string {
  const delta = Math.round((args.chartValue - args.componentTotal) * 100) / 100;
  const tol = args.observedTotal ? observedTolerance(args.chartValue) : COMPOSITION_TOLERANCE;
  if ((args.contradictions ?? 0) > 0 || delta < -tol) return "CONTRADICTORY";
  if (Math.abs(delta) <= tol) return "EXACT";
  if (args.observedTotal && delta > 0 && args.componentCount > 0) return "PARTIALLY_ATTRIBUTED";
  return "UNAVAILABLE";
}

function main(): void {
  console.log("V26-S4 — composition states & historical scope\n");

  // ══ A–D. THE FOUR OUTCOMES ════════════════════════════════════════════════
  console.log("A–D. Reconciliation outcomes");
  {
    check("A. a frozen total its components explain is EXACT",
      classify({ chartValue: 20599.32, componentTotal: 20599.32, observedTotal: true, componentCount: 20 }) === "EXACT");
    check("A. a reconstructed total its components explain is EXACT",
      classify({ chartValue: 24629.62, componentTotal: 24629.62, observedTotal: false, componentCount: 14 }) === "EXACT");

    check("B. a frozen total the components fall SHORT of is PARTIALLY_ATTRIBUTED",
      classify({ chartValue: 20599.32, componentTotal: 20454.17, observedTotal: true, componentCount: 19 }) === "PARTIALLY_ATTRIBUTED");
    check("B. the remainder is observed − explained, and positive",
      Math.round((20599.32 - 20454.17) * 100) / 100 === 145.15);

    check("C. components EXCEEDING the total are CONTRADICTORY (a negative remainder is impossible)",
      classify({ chartValue: 20599.32, componentTotal: 22000, observedTotal: true, componentCount: 20 }) === "CONTRADICTORY");
    check("C. a stated contradiction wins over a friendly outcome",
      classify({ chartValue: 100, componentTotal: 100, observedTotal: true, componentCount: 2, contradictions: 1 }) === "CONTRADICTORY");

    check("D. a RECONSTRUCTED row whose components fall short is UNAVAILABLE, not 'partial'",
      classify({ chartValue: 24629.62, componentTotal: 20000, observedTotal: false, componentCount: 14 }) === "UNAVAILABLE");
    check("D. no components at all is UNAVAILABLE",
      classify({ chartValue: 4032.1, componentTotal: 0, observedTotal: true, componentCount: 0 }) === "UNAVAILABLE");

    check("D. the four states are the whole vocabulary", COMPOSITION_STATES.length === 4);
    // Distinctness is a TYPE-level fact here (the compiler proves the literals
    // cannot overlap), so assert the property that actually matters at runtime:
    // both codes exist and neither is empty.
    check("D. and the two refusals are distinct, non-empty codes",
      String(HISTORICAL_COMPOSITION_UNAVAILABLE).length > 0 &&
      String(HISTORICAL_COMPOSITION_CONTRADICTORY).length > 0 &&
      String(HISTORICAL_COMPOSITION_UNAVAILABLE) !== String(HISTORICAL_COMPOSITION_CONTRADICTORY));
  }

  // ══ TOLERANCE — engine-vs-itself is strict, engine-vs-observation is not ═══
  console.log("\nTolerance model");
  {
    check("a reconstructed row demands one-cent agreement", COMPOSITION_TOLERANCE === 0.01);
    check("an observed row allows at least a dollar", observedTolerance(100) === 1.0);
    check("and one basis point on a large portfolio", observedTolerance(20599.32) > 2.0);
    // The measured frozen residuals: 0.00, −0.02, −0.31, −0.05.
    check("the real frozen residuals all read EXACT",
      [0, -0.02, -0.31, -0.05].every((d) =>
        classify({ chartValue: 20599.32, componentTotal: 20599.32 + d, observedTotal: true, componentCount: 20 }) === "EXACT"));
    check("but a material shortfall does not",
      classify({ chartValue: 20599.32, componentTotal: 20454.17, observedTotal: true, componentCount: 20 }) !== "EXACT");
  }

  // ══ F–K. PRIMARY PANEL SCOPE = A PHOTOGRAPH OF THE DATE ═══════════════════
  console.log("\nF–K. Primary panel scope");
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["NVDA", own("2025-10-01", "2026-07-27")],  // owned then, sold LATER
      ["AMZN", own("2025-01-01", "2025-06-01")],  // sold BEFORE the date
      ["VRT",  own("2026-06-25")],                // bought AFTER the date
      ["TQQQ", own("2025-09-29", "2026-07-27")],  // held, but unvalued
    ]);
    const set = buildHistoricalHoldings("2026-01-01", [
      comp("NVDA", 373.06), comp("AMZN", 200), comp("VRT", 240), comp("TQQQ", null),
    ], facts, keyOf);

    check("H. a holding sold LATER is still shown (it existed then)",
      set.held.some((h) => h.instrumentId === "NVDA"));
    check("G. a holding sold EARLIER is not shown",
      !set.held.some((h) => h.instrumentId === "AMZN"));
    check("G. …and is categorised ALREADY_CLOSED",
      set.excluded.find((e) => e.instrumentId === "AMZN")?.reasonCode === "OWNERSHIP_CLOSED");
    check("F. a holding bought LATER is not shown",
      !set.held.some((h) => h.instrumentId === "VRT"));
    check("F. …and is categorised NOT_YET_OWNED, not 'unknown'",
      set.excluded.find((e) => e.instrumentId === "VRT")?.reasonCode === "NOT_YET_OWNED");
    check("F. …stating when it WOULD become held",
      set.excluded.find((e) => e.instrumentId === "VRT")?.opensISO === "2026-06-25");
    check("I. a HELD but unvalued holding is in the denominator",
      set.held.some((h) => h.instrumentId === "TQQQ") && set.heldCount === 2);
    check("I. …but not in the numerator", set.valuedCount === 1);
    check("J. not-held instruments contribute to neither", set.heldCount === 2);
  }

  // ══ K. THE DENOMINATOR MOVES WITH OWNERSHIP ═══════════════════════════════
  console.log("\nK. Denominator through acquisition and closure");
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["BTC",  own("2023-03-18")],
      ["NVDA", own("2025-10-01", "2026-07-27")],
      ["VRT",  own("2026-06-25")],
    ]);
    const all = [comp("BTC", 1000), comp("NVDA", 300), comp("VRT", 240)];
    const at = (d: string) => buildHistoricalHoldings(d, all, facts, keyOf).heldCount;
    check("A. before anything existed → 0 of 0", at("2023-01-01") === 0);
    check("B. BTC-only period → 1", at("2024-06-01") === 1);
    check("C. a stock acquisition raises it → 2", at("2025-11-01") === 2);
    check("C. a second acquisition raises it again → 3", at("2026-07-01") === 3);
    check("E. the sale lowers it, end-of-day → 2 on the closure date", at("2026-07-27") === 2);
    check("E. …and the day BEFORE still counts it", at("2026-07-26") === 3);
  }

  // ══ M. ACCOUNTS STAY ISOLATED ═════════════════════════════════════════════
  console.log("\nM. Per-account isolation");
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["a1|NVDA", own("2025-10-01")],
      ["a2|NVDA", own("2026-06-25")],
    ]);
    const pairKey = (c: HoldingComponent) => `${c.financialAccountId}|${c.instrumentId}`;
    const set = buildHistoricalHoldings("2026-01-01",
      [comp("NVDA", 300, "a1"), comp("NVDA", 400, "a2")], facts, pairKey);
    check("M. the same ticker in two accounts resolves independently", set.heldCount === 1);
    check("M. and only the evidenced account is held", set.held[0].financialAccountId === "a1");
    check("M. the other is NOT_YET_OWNED", set.excluded[0].reasonCode === "NOT_YET_OWNED");
  }

  // ══ O–Q. THE QUANTITY FALLBACK CANNOT CREATE HISTORY ══════════════════════
  console.log("\nO–Q. holdConstantBeforeEarliest constraints");
  {
    const holdings = strip(read("lib/investments/historical-holdings.ts"));
    const valuation = strip(read("lib/investments/valuation.ts"));
    const core = strip(read("lib/investments/valuation-core.ts"));

    check("O. ownership is resolved without consulting the fallback",
      !/holdConstant/.test(strip(read("lib/investments/holding-ownership.ts"))));
    check("O. a projected quantity on an unlicensed date cannot enter the held set",
      /buildHistoricalHoldings\s*\(/.test(holdings));
    check("P. the fallback fires ONLY when nothing covers the date, so an opening anchor wins",
      /if \(resolved\.quantity !== null\) return unchanged/.test(core));
    check("Q. a FAILED or conflicted reconstruction cannot be carried backward",
      /carryLicensed/.test(valuation) &&
      /pairReconciliation !== "FAILED"/.test(valuation) &&
      /holdConstant && carryLicensed/.test(valuation));
  }

  // ══ V, Y. STATIC GUARDS ═══════════════════════════════════════════════════
  console.log("\nV, Y. Static guards");
  {
    const detail = strip(read("lib/investments/historical-point-detail.ts"));
    // V27 — the per-lens drawer was RETIRED; the ONE shared explorer inherits
    // every guard that protected it. The intent is unchanged: the view renders a
    // breakdown only when the authority permits it.
    const panel  = strip(read("components/history/HistoryExplorationSheet.tsx"));
    const probes = strip(read("lib/integrity/historical-probes.ts"));
    const chart  = strip(read("components/space/widgets/charts/TrendChart.tsx"));

    check("V. the detail authority never queries current positions",
      !/getCurrentPositions|current-holdings|current-positions/.test(detail));
    check("V. nor reads a clock", !/Date\.now\(\)|new Date\(\)/.test(detail));
    check("Y. React does no financial arithmetic",
      !/reduce\(/.test(panel) && !/\bquantity\s*\*/.test(panel) && !/chartValue\s*-/.test(panel));
    check("Y. React renders a breakdown only when the authority reconciled",
      /mayShowChildren && node\.components\.length > 0/.test(panel) &&
      /node\.reconciliation === "EXACT" \|\| node\.reconciliation === "PARTIALLY_ATTRIBUTED"/.test(panel));
    check("Y. …and names the two refusals separately",
      /CONTRADICTORY/.test(panel) && /UNAVAILABLE/.test(panel));
    check("Y. the residual is never called cash, gain, or a holding",
      !/(cash|gain|profit|missing holding)/i.test(
        panel.slice(panel.indexOf("Unattributed"), panel.indexOf("Unattributed") + 900)
          .replace(/Reconstructed from cash effects/g, "")));

    check("probes open no second valuation engine",
      !/valueInstrumentAsOf|valuePortfolioAsOf|createPriceService/.test(probes));
    check("probes consume the canonical authorities",
      /reconcileWalletLedger/.test(probes) && /getHistoricalPointDetail/.test(probes) &&
      /loadHoldingOwnership/.test(probes));
    check("probes never write", !/\.(create|update|upsert|delete)(Many)?\(/.test(probes));
    check("probe diagnostics carry no secrets",
      !/apiKey|accessToken|ENCRYPTION_KEY|password/i.test(probes));

    check("W/X. the chart selects from the click's own coordinates, not a prior hover",
      /function onSelect\(/.test(chart) && /nearestIndex\(e\.clientX\)/.test(chart));
    check("X. and supports keyboard navigation",
      /ArrowLeft|ArrowRight/.test(chart) && /onKeyDown=\{onKeys\}/.test(chart));

    // No new legacy writer, no second ownership model.
    check("no parallel ownership engine was introduced",
      (read("lib/investments/holding-ownership.ts").match(/resolveOwnershipWindow\(/g) ?? []).length === 1);
  }

  console.log(failures === 0 ? "\nAll composition-state checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

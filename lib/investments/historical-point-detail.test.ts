/**
 * lib/investments/historical-point-detail.test.ts
 *
 * V26-S3-DETAIL — the chart-point reconciliation invariant, and the structural
 * guards that keep the drill-down from becoming a second engine.
 *
 * The reconciliation is not decoration. During this slice it caught a real
 * divergence in the drill-down's own code: passing a per-date ownership ceiling
 * lost five holdings worth $696.14 against the stored point, and the refusal is
 * what surfaced it instead of shipping a breakdown that was quietly short.
 */

import { readFileSync } from "node:fs";
import { COMPOSITION_TOLERANCE, HISTORICAL_COMPOSITION_UNAVAILABLE } from "./historical-point-detail";
import { valueCryptoDay } from "@/lib/crypto/historical-crypto-valuation.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (p: string) => readFileSync(p, "utf8");

/** The module's reconciliation rule, applied to a pair of totals. */
function reconciles(chartValue: number, componentTotal: number): boolean {
  return Math.abs(Math.round((chartValue - componentTotal) * 100) / 100) <= COMPOSITION_TOLERANCE;
}

function main(): void {
  console.log("V26-S3-DETAIL — chart-point reconciliation\n");

  // ══ A. THE INVARIANT ══════════════════════════════════════════════════════
  console.log("A. A breakdown may render only when it sums to the point");
  {
    check("A. an exact match reconciles", reconciles(24629.62, 24629.62));
    check("A. a sub-cent difference reconciles (float noise, not disagreement)",
      reconciles(24629.62, 24629.6249));
    check("A. a one-cent difference still reconciles (the stated tolerance)",
      reconciles(100.00, 99.99));
    check("A. two cents does NOT", !reconciles(100.00, 99.98));
    // The real divergence this slice caught.
    check("A. the measured $696.14 shortfall is REFUSED",
      !reconciles(24629.62, 23933.47));
    check("A. the refusal constant is the single coded outcome",
      HISTORICAL_COMPOSITION_UNAVAILABLE === "HISTORICAL_COMPOSITION_UNAVAILABLE");
  }

  // ══ B. THE SHARED CRYPTO VALUATION ════════════════════════════════════════
  console.log("\nB. Crypto is valued once, for both the total and the breakdown");
  {
    const accounts = [{ financialAccountId: "w1", name: "Cold Wallet", nativeBalance: 0.24060252, symbol: "BTC" }];
    const ok = valueCryptoDay({ accounts, unitPrice: 87575.05, quantityLicensed: true });
    check("B. one position, valued", ok.licensed && ok.positions.length === 1);
    check("B. the position value equals the total (one call, one answer)",
      Math.abs(ok.positions[0].nativeValue - ok.nativeTotal) < 1e-9);
    check("B. quantity × price is the value",
      Math.abs(ok.nativeTotal - 0.24060252 * 87575.05) < 1e-9);

    const noPrice = valueCryptoDay({ accounts, unitPrice: null, quantityLicensed: true });
    check("B. no price ⇒ NO positions and no total, never a carried balance",
      !noPrice.licensed && noPrice.positions.length === 0 && noPrice.refusal === "NO_PRICE");
    check("B. …but the position still EXISTED, so it stays in the denominator",
      noPrice.positionCount === 1);

    const unlicensed = valueCryptoDay({ accounts, unitPrice: 87575.05, quantityLicensed: false });
    check("B. an unlicensed quantity refuses too", !unlicensed.licensed && unlicensed.refusal === "QUANTITY_UNLICENSED");

    const empty = valueCryptoDay({ accounts: [{ financialAccountId: "w2", name: "Empty", nativeBalance: 0, symbol: "BTC" }], unitPrice: 1, quantityLicensed: true });
    check("B. a zero-balance wallet is not a position at all",
      empty.positionCount === 0 && empty.positions.length === 0);
  }

  // ══ C. STATIC GUARDS — no second engine, no React arithmetic ══════════════
  console.log("\nC. Structural guards");
  {
    const detail = strip(read("lib/investments/historical-point-detail.ts"));
    check("C. the authority uses the canonical holdings query",
      /historicalHoldingsForWindow\s*\(/.test(detail));
    check("C. and the canonical crypto day valuation",
      /valueCryptoDay\s*\(/.test(detail));
    check("C. it never queries CURRENT positions as its historical authority",
      !/getCurrentPositions|current-positions|current-holdings/.test(detail));
    check("C. it reads no clock",
      !/Date\.now\(\)|new Date\(\)/.test(detail));
    check("C. it does not resolve prices itself (no second price authority)",
      !/priceArchive|createPriceService|getPriceAsOf/.test(detail));
    check("C. it does not open a second ownership model",
      !/resolveOwnershipWindow\s*\(/.test(detail));
    check("C. it pins the ownership ceiling to NOTHING (derived, so it matches regeneration)",
      !/ownershipToISO:/.test(detail));

    const route = strip(read("app/api/spaces/[id]/investments/point-detail/route.ts"));
    check("C. the route delegates to the authority", /getHistoricalPointDetail\s*\(/.test(route));
    check("C. the route computes no money",
      !/reduce\(/.test(route) && !/\*/.test(route.replace(/import[^;]+;/g, "")));
    check("C. the route strips the diagnostic from the user-facing payload",
      /diagnostic, \.\.\.safe/.test(route));

    // v2.6 — retired per-lens drawer; the shared explorer carries these guards.
    const panel = strip(read("components/history/HistoryExplorationSheet.tsx"));
    check("C. the panel does no arithmetic on money",
      !/reduce\(/.test(panel) && !/\bquantity\s*\*/.test(panel) && !/\/\s*quantity/.test(panel));
    check("C. the panel renders a breakdown ONLY when reconciled",
      /mayShowChildren && node\.components\.length > 0/.test(panel));
    // V26-S4 — two refusals now, named separately: a contradiction and an
    // absence of evidence are different things to tell a reader.
    check("C. and shows a refusal sentence otherwise",
      /Composition is unavailable for this date/.test(panel) &&
      /Historical composition is unavailable because the stored\s+observations conflict/.test(panel));
    check("C. the panel never reads today's holdings",
      !/getCurrentPositions|data\.current/.test(panel));

    const chart = strip(read("components/space/widgets/charts/TrendChart.tsx"));
    // V26-S4 — selection resolves from the click's OWN coordinates so a first
    // click works without a prior hover (touch, keyboard, assistive tech).
    check("C. the chart reports a DATE and nothing else",
      /onSelectPoint\(geom\.pts\[i\]\.date\)/.test(chart));
    // The property, not the vocabulary: the chart must not resolve components,
    // ownership, prices or a reconciliation. (An aria-label may say "holdings";
    // a guard that forbids the WORD tests spelling, not architecture.)
    check("C. the chart computes no composition of its own",
      !/componentTotal|reconciled|ownership|priceSource|getHistoricalPointDetail/.test(chart));
    check("C. and never fetches financial data",
      !/fetch\(/.test(chart));
  }

  // ══ D. ONE COMPOSITION PATH ═══════════════════════════════════════════════
  console.log("\nD. Regeneration and the drill-down share one composition");
  {
    const regen = strip(read("lib/snapshots/regenerate-history.ts"));
    const detail = strip(read("lib/investments/historical-point-detail.ts"));
    check("D. both call historicalHoldingsForWindow",
      /historicalHoldingsForWindow\s*\(/.test(regen) && /historicalHoldingsForWindow\s*\(/.test(detail));
    check("D. both call valueCryptoDay",
      /valueCryptoDay\s*\(/.test(regen) && /valueCryptoDay\s*\(/.test(detail));
    check("D. neither pins its own ownership ceiling",
      !/ownershipToISO:/.test(regen) && !/ownershipToISO:/.test(detail));
    check("D. regeneration still does not call the valuation engine directly",
      !/getInvestmentValueForWindow\s*\(/.test(regen));

    const holdings = strip(read("lib/investments/historical-holdings.ts"));
    check("D. the ceiling is DERIVED from account-set evidence, not a caller",
      /resolveEvidenceCeiling\s*\(/.test(holdings));
    check("D. and that derivation reads no clock",
      !/Date\.now\(\)|new Date\(\)/.test(strip(read("lib/investments/historical-holdings.ts"))));
  }

  // ══ E. THE INVESTMENTS TOTAL, NOT NET WORTH ═══════════════════════════════
  console.log("\nE. The breakdown explains the Investments total only");
  {
    const detail = strip(read("lib/investments/historical-point-detail.ts"));
    check("E. the chart value is stocks + crypto",
      /snapshot\.stocks \+ \(cryptoAssertable \? snapshot\.crypto : 0\)/.test(detail));
    check("E. banking cash / savings / debt are never summed in",
      !/snapshot\.cash/.test(detail) && !/snapshot\.savings/.test(detail) && !/snapshot\.debt/.test(detail));
    check("E. brokerage cash IS included (it arrives as a holding, not a bank balance)",
      /excludeDigitalAssetAccounts: true/.test(detail));
  }

  console.log(failures === 0 ? "\nAll point-detail checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

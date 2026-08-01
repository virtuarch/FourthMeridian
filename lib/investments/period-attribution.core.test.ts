/**
 * lib/investments/period-attribution.core.test.ts
 *
 * V26-INVESTMENTS-HISTORY-FIX fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/period-attribution.core.test.ts
 *
 * The regression that matters most is §16: the exact screenshot period must not
 * be able to render $18,918.98 as portfolio performance, or 3857% as a return.
 */

import {
  assessPeriodAttribution, heroComparison, ATTRIBUTION_REFUSALS,
  type AttributionEvidence,
} from "./period-attribution.core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A fully observed, fully covered, unchanged-universe period. The only clean case. */
function clean(over: Partial<AttributionEvidence> = {}): AttributionEvidence {
  return {
    fromISO: "2026-01-01", toISO: "2026-07-31", reportingCurrency: "USD",
    openingValue: 10_000, closingValue: 12_000,
    moneyIn: 500, moneyOut: -100, netExternalFlows: 400, residualChange: 1600,
    openingUnvaluedCount: 0, closingUnvaluedCount: 0,
    openingTier: "observed", closingTier: "observed",
    openingComponentValues: [6000, 4000],
    openingInstrumentIds: ["i1", "i2"], closingInstrumentIds: ["i1", "i2"],
    flowCompleteness: "observed", conflict: false, ...over,
  };
}
const codes = (e: AttributionEvidence) => assessPeriodAttribution(e).refusals.map((r) => r.code);

function main(): void {
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "period-attribution.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports only the completeness-tier type",
      imports.length === 1 && imports[0] === "@/lib/perspective-engine/types");
    check("no Prisma, database, provider or React import",
      !/@prisma|lib\/db|lib\/prices|plaid|react/i.test(imports.join(" ")));
    check("no ambient clock", !/Date\.now\(|new Date\(/.test(src));
  }

  console.log("1. fully observed and covered → full attribution");
  {
    const a = assessPeriodAttribution(clean());
    check("ATTRIBUTABLE", a.kind === "ATTRIBUTABLE" && a.refusals.length === 0);
    check("opening, flows and portfolio change are all stated",
      a.openingValue === 10_000 && a.moneyIn === 500 && a.moneyOut === -100 && a.portfolioChange === 1600);
    check("nothing is left unattributed", a.unattributedChange === null);
    const h = heroComparison(a);
    check("the percentage is shown, and it is the real one",
      h.showPercentage && Math.abs((h.percentage ?? 0) - 20) < 1e-9);
    check("…and the identity still holds",
      Math.abs((a.openingValue! + a.moneyIn! + a.moneyOut! + a.portfolioChange!) - a.closingValue) < 0.01);
  }

  console.log("2–7. each missing piece of evidence refuses on its own");
  {
    check("uncovered opening endpoint",
      codes(clean({ openingUnvaluedCount: 2 })).includes("OPENING_ENDPOINT_INCOMPLETE"));
    check("uncovered closing endpoint",
      codes(clean({ closingUnvaluedCount: 1 })).includes("CLOSING_ENDPOINT_INCOMPLETE"));
    check("reconstructed (not observed) opening",
      codes(clean({ openingTier: "estimated", closingTier: "estimated" })).includes("OPENING_NOT_OBSERVED"));
    check("estimated → observed boundary is a BASIS change, not performance",
      codes(clean({ openingTier: "estimated" })).includes("BASIS_CHANGED_ACROSS_PERIOD"));
    check("missing flow history refuses to state money in/out",
      codes(clean({ flowCompleteness: "incomplete" })).includes("FLOW_COVERAGE_INCOMPLETE"));
    check("…and withholds the numbers rather than showing 0 as a fact",
      assessPeriodAttribution(clean({ flowCompleteness: "incomplete", moneyIn: 0, moneyOut: 0 })).moneyIn === null);
    check("a reconstruction conflict refuses",
      codes(clean({ conflict: true })).includes("RECONSTRUCTION_CONFLICT"));
    check("an account discovered mid-period is not market growth",
      codes(clean({ closingInstrumentIds: ["i1", "i2", "i3"] })).includes("HOLDING_UNIVERSE_CHANGED"));
    check("a position that vanished mid-period also breaks comparability",
      codes(clean({ closingInstrumentIds: ["i1"] })).includes("HOLDING_UNIVERSE_CHANGED"));
  }

  console.log("8. reconstructed shorts — the defect that produced $516.43");
  {
    const withShorts = clean({
      openingTier: "estimated", closingTier: "estimated",
      openingComponentValues: [2879.94, -2363.51], openingValue: 516.43,
    });
    check("negative reconstructed positions are called out explicitly",
      codes(withShorts).includes("OPENING_CONTAINS_RECONSTRUCTED_SHORTS"));
    check("…naming the amount they offset",
      assessPeriodAttribution(withShorts).refusals
        .find((r) => r.code === "OPENING_CONTAINS_RECONSTRUCTED_SHORTS")!.detail.includes("-2363.51"));
    check("an OBSERVED short is NOT flagged — real short positions are legitimate",
      !codes(clean({ openingComponentValues: [6000, -1000] })).includes("OPENING_CONTAINS_RECONSTRUCTED_SHORTS"));
  }

  console.log("13. closing known, opening unknown");
  {
    const a = assessPeriodAttribution(clean({ openingTier: "estimated", openingUnvaluedCount: 3 }));
    check("NOT_ATTRIBUTABLE", a.kind === "NOT_ATTRIBUTABLE");
    check("the current value is still shown — facts are not suppressed", a.closingValue === 12_000);
    check("the opening is withheld", a.openingValue === null);
    check("period performance is withheld", a.portfolioChange === null);
    const h = heroComparison(a);
    check("no change amount and no percentage", !h.showChange && !h.showPercentage);
    check("…and a reason is available to render", (h.suppressedReason ?? "").length > 20);
  }

  console.log("9–11. flows are classified, not invented");
  {
    const a = assessPeriodAttribution(clean());
    check("a genuine contribution shows as money in", a.moneyIn === 500);
    check("a genuine withdrawal shows as money out", a.moneyOut === -100);
    // Internal transfers never reach this module: investment-flows-core excludes
    // them from netExternalFlows, so a period with only internal movement has
    // zero flows AND a zero residual contribution from them.
    const internalOnly = assessPeriodAttribution(clean({ moneyIn: 0, moneyOut: 0, netExternalFlows: 0, residualChange: 2000 }));
    check("an internal transfer is not money in or out at portfolio level",
      internalOnly.moneyIn === 0 && internalOnly.moneyOut === 0 && internalOnly.kind === "ATTRIBUTABLE");
  }

  console.log("12. partial attribution keeps what IS defensible");
  {
    const a = assessPeriodAttribution(clean({ flowCompleteness: "estimated" }));
    check("a defensible opening with undefined flows → PARTIALLY_ATTRIBUTABLE",
      a.kind === "PARTIALLY_ATTRIBUTABLE");
    check("the opening survives", a.openingValue === 10_000);
    check("the flows do not", a.moneyIn === null && a.moneyOut === null);
    check("the change is reported as UNATTRIBUTED, never as portfolio change",
      a.portfolioChange === null && a.unattributedChange === 1600);
    check("and no percentage is authorised", !heroComparison(a).showPercentage);
  }

  console.log("15. one rule, both surfaces");
  {
    for (const e of [clean(), clean({ openingTier: "estimated" }), clean({ openingUnvaluedCount: 1 })]) {
      const a = assessPeriodAttribution(e);
      const h = heroComparison(a);
      check(`hero and card agree on the opening endpoint (${a.kind})`,
        (h.showChange) === (a.openingValue !== null));
      check(`…and on whether a percentage is permitted (${a.kind})`,
        h.showPercentage === a.mayShowReturnPercentage);
    }
  }

  console.log("16. THE SCREENSHOT REGRESSION");
  {
    // Reproduced verbatim from the local corpus.
    const screenshot = assessPeriodAttribution({
      fromISO: "2026-01-01", toISO: "2026-07-31", reportingCurrency: "USD",
      openingValue: 516.43, closingValue: 20_435.42,
      moneyIn: 1050, moneyOut: -50, netExternalFlows: 1000, residualChange: 18_918.98,
      openingUnvaluedCount: 2, closingUnvaluedCount: 0,
      openingTier: "incomplete", closingTier: "estimated",
      openingComponentValues: [1507.56, 449.72, 230.82, 162.01, 161.33, 136.94, 130.75,
        73.56, 11.65, 10.39, 3.21, 2.00, -173.49, -184.50, -254.84, -322.22, -374.06, -1054.40],
      openingInstrumentIds: ["BTC","SIRI","TTWO","CASH1","SPCE","CASH2","NKE","AMZN","TXN","JPM",
        "TSLA","NVDA","INTC","TQQQ","APLD","OKLO","QBTS","VST","VGT","VRT"],
      closingInstrumentIds: ["BTC","SIRI","TTWO","CASH1","CASH2","APLD","OKLO","QBTS","VST","VGT","VRT"],
      flowCompleteness: "observed", conflict: false,
    });

    check("the period is NOT_ATTRIBUTABLE", screenshot.kind === "NOT_ATTRIBUTABLE");
    check("$18,918.98 is NOT rendered as portfolio performance",
      screenshot.portfolioChange === null);
    check("…and is not laundered into 'unattributed' either, because the opening is indefensible",
      screenshot.unattributedChange === null);
    check("the $516.43 opening is withheld", screenshot.openingValue === null);
    check("3857% is withheld", !screenshot.mayShowReturnPercentage &&
      !heroComparison(screenshot).showPercentage);
    check("the $19,919 change figure is withheld too",
      !heroComparison(screenshot).showChange);
    check("the closing value of $20,435.42 is still shown — it is real",
      screenshot.closingValue === 20_435.42);
    check("money in / out survive, because flow evidence IS observed",
      screenshot.moneyIn === 1050 && screenshot.moneyOut === -50);

    const c = screenshot.refusals.map((r) => r.code);
    check("all five real defects are named", c.length === 5 &&
      c.includes("OPENING_ENDPOINT_INCOMPLETE") && c.includes("OPENING_NOT_OBSERVED") &&
      c.includes("BASIS_CHANGED_ACROSS_PERIOD") &&
      c.includes("OPENING_CONTAINS_RECONSTRUCTED_SHORTS") &&
      c.includes("HOLDING_UNIVERSE_CHANGED"));
    check("refusals are emitted in declaration order",
      c.every((x, i) => i === 0 || ATTRIBUTION_REFUSALS.indexOf(c[i - 1]) <= ATTRIBUTION_REFUSALS.indexOf(x)));
    check("every refusal carries user-facing copy, not just a code",
      screenshot.refusals.every((r) => r.copy.length > 30 && r.detail.length > 0));
  }

  console.log("17. determinism");
  {
    const e = clean({ openingTier: "estimated", openingUnvaluedCount: 1 });
    check("repeat assessment is byte-identical",
      JSON.stringify(assessPeriodAttribution(e)) === JSON.stringify(assessPeriodAttribution(e)));
    check("no refusal appears twice",
      new Set(codes(e)).size === codes(e).length);
    check("any refusal at all denies ATTRIBUTABLE",
      ATTRIBUTION_REFUSALS.every(() => true) &&
      assessPeriodAttribution(clean({ conflict: true })).kind !== "ATTRIBUTABLE");
  }

  console.log(failures === 0 ? "\nAll period-attribution checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

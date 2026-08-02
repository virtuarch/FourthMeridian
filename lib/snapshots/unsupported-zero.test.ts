/**
 * lib/snapshots/unsupported-zero.test.ts
 *
 * V26-INVESTMENTS-HISTORY — A ZERO SUBTOTAL MAY ONLY BE ASSERTED WHEN EVIDENCE
 * SUPPORTS ZERO.
 *
 * The regression: after the 2026-08 regeneration, 27 days (2025-07-31 →
 * 2025-08-26) persisted `stocks = 0.00` at 0/14 and 0/15 coverage, producing a
 * false ~$5,626 cliff on 2025-07-31. `applyOwnershipEligibility` reports
 * `hasEligibleHoldings` from OWNERSHIP inclusion alone, so a day whose holdings
 * were all ownership-KNOWN but none of which could be VALUED reached the writer
 * with valuedSubtotal 0 and was recorded as a financial fact.
 *
 * The five states that must stay distinct:
 *
 *   1. no holdings in scope           → zero may be valid
 *   2. holdings explicitly closed     → zero may be valid
 *   3. holdings exist, none valued    → REFUSED (this fix)
 *   4. some contribute, some unvalued → partial subtotal, degraded metadata
 *   5. all contribute                 → supported subtotal
 *
 * Standalone tsx script:  npx tsx lib/snapshots/unsupported-zero.test.ts
 */

import {
  regenerateDay, hasNoValuedComponents, NO_VALUED_COMPONENTS_REASON_CODE,
  type DayRegenInput,
} from "./regenerate-history.core";
import { applyOwnershipEligibility } from "./ownership-eligibility.core";
import type { OwnershipResolution } from "@/lib/prices/ownership-window.core";
import type { ClassifyTotals } from "./backfill-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Cash/savings present so a written row is never trivially empty. */
const BASE: ClassifyTotals = {
  totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 500,
  totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0,
};

function dayInput(over: Partial<DayRegenInput> = {}): DayRegenInput {
  return {
    date: "2025-07-31",
    existingIsEstimated: true,
    base: BASE,
    investmentValue: 0,
    investmentTier: "unknown",
    hasInvestmentEvidence: true,
    digitalAssetValue: 0,
    digitalAssetTier: "estimated",
    hasDigitalAssetEvidence: false,
    cashCardTier: "derived",
    membershipChangedSince: false,
    ...over,
  };
}

function known(fromISO = "2020-01-01", toISO = "2030-01-01"): OwnershipResolution {
  return { kind: "resolved", segments: [{ confidence: "KNOWN", fromISO, toISO }] } as OwnershipResolution;
}

function main(): void {
  // ══ A. 14 holdings exist, 0 contribute, tier unknown ══════════════════════
  console.log("A. 14 holdings in scope, none valued — the 2025-07-31 shape");
  {
    const res = regenerateDay(dayInput({
      investmentValue: 0, investmentTier: "unknown",
      contributingComponentCount: 0, totalComponentCount: 14,
    }));
    check("the day is REFUSED, not written", res.action === "skip-unsupported");
    check("no fields are produced, so stocks=0 cannot be persisted", res.fields === null);
    check("carries the machine-searchable reason code", res.reason.startsWith(NO_VALUED_COMPONENTS_REASON_CODE));
    check("the reason names how many holdings were in scope", res.reason.includes("14 holding(s)"));
    check("the reason does not claim the user held nothing",
      !/held nothing|no holdings|zero holdings/i.test(res.reason));
    check("no completeness metadata is persisted for a refused day",
      res.contributingComponentCount === null && res.totalComponentCount === null);
    check("15-of-0 variant is refused too (the other observed shape)",
      regenerateDay(dayInput({ contributingComponentCount: 0, totalComponentCount: 15 })).action === "skip-unsupported");
  }

  // ══ B. Partial subtotal is UNCHANGED ══════════════════════════════════════
  console.log("B. 1 of 19 contributes $11.65 — partial behaviour explicitly unchanged");
  {
    const res = regenerateDay(dayInput({
      investmentValue: 11.65, investmentTier: "unknown",
      contributingComponentCount: 1, totalComponentCount: 19,
    }));
    check("the day is still WRITTEN", res.action === "write" && res.fields !== null);
    check("the partial subtotal is preserved exactly, not zeroed", res.fields!.stocks === 11.65);
    check("completeness stays degraded", res.tier === "unknown");
    check("the composition is still recorded",
      res.contributingComponentCount === 1 && res.totalComponentCount === 19);
    check("7 of 19 (the June shape) is also still written",
      regenerateDay(dayInput({ investmentValue: 1065.67, contributingComponentCount: 7, totalComponentCount: 19 })).action === "write");
  }

  // ══ C. No holdings in scope — legitimate zero ═════════════════════════════
  console.log("C. No holdings in scope — legitimate zero must NOT be blocked");
  {
    // A8 returned nothing: no components at all, so no valuation was attempted.
    const noComponents = regenerateDay(dayInput({
      hasInvestmentEvidence: false, investmentValue: 0,
      contributingComponentCount: null, totalComponentCount: null,
      base: { ...BASE, totalInvestments: 0 },
    }));
    check("a day with no components is still written", noComponents.action === "write");
    check("its investment component is zero, honestly", noComponents.fields!.stocks === 0);

    // Counts recorded but total is 0 — nothing existed to value.
    const zeroOfZero = regenerateDay(dayInput({
      contributingComponentCount: 0, totalComponentCount: 0,
    }));
    check("0 of 0 is NOT refused — nothing was in scope", zeroOfZero.action === "write");
    check("the predicate itself is silent on an empty scope",
      !hasNoValuedComponents({ contributingComponentCount: 0, totalComponentCount: 0 }));
    check("the predicate is silent when counts were never recorded",
      !hasNoValuedComponents({ contributingComponentCount: null, totalComponentCount: null }) &&
      !hasNoValuedComponents({}));
  }

  // ══ D. Explicitly closed positions — legitimate zero ══════════════════════
  console.log("D. All positions explicitly closed — legitimate zero must survive");
  {
    // valuation.ts skips a KNOWN ZERO (`quantity === 0`) before it can become a
    // component, so a fully-closed portfolio reaches eligibility with an EMPTY
    // holdings list — proven here rather than assumed.
    const own = new Map<string, OwnershipResolution>([["SOLD", known()]]);
    const closedPortfolio = applyOwnershipEligibility("2025-07-31", [], own);
    check("a closed portfolio yields zero holdings in scope", closedPortfolio.totalCount === 0);
    check("and therefore zero contributors", closedPortfolio.contributingCount === 0);
    check("which the guard deliberately ignores",
      !hasNoValuedComponents({
        contributingComponentCount: closedPortfolio.contributingCount,
        totalComponentCount: closedPortfolio.totalCount,
      }));
    const res = regenerateDay(dayInput({
      contributingComponentCount: closedPortfolio.contributingCount,
      totalComponentCount: closedPortfolio.totalCount,
      investmentValue: closedPortfolio.valuedSubtotal,
    }));
    check("a sold-everything day is still written as a real zero", res.action === "write");
    check("with stocks 0 — a supported zero", res.fields!.stocks === 0);

    // A cash-only portfolio: one holding, and it DOES contribute.
    const cashOnly = applyOwnershipEligibility("2025-07-31",
      [{ instrumentId: "CASH", reportingValue: 11.65 }], new Map([["CASH", known()]]));
    check("a supported cash-only portfolio still contributes", cashOnly.contributingCount === 1);
    check("and is not refused",
      !hasNoValuedComponents({ contributingComponentCount: cashOnly.contributingCount, totalComponentCount: cashOnly.totalCount }));
  }

  // ══ E. Frozen observed rows ═══════════════════════════════════════════════
  console.log("E. Frozen observed rows — untouched, and the guard never reaches them");
  {
    const res = regenerateDay(dayInput({
      existingIsEstimated: false,
      contributingComponentCount: 0, totalComponentCount: 14,
    }));
    check("the frozen guard still wins, ahead of this one", res.action === "skip-frozen");
    check("no fields are produced", res.fields === null);
    check("the reason is the frozen reason, not the new one",
      res.reason === "Observed row is frozen." );
  }

  // ══ F. The exact defect shape, end to end through eligibility ═════════════
  console.log("F. Reproducing 2025-07-31 from eligibility through to the writer");
  {
    // 14 holdings, all ownership-KNOWN, none with a resolvable value.
    const ids = Array.from({ length: 14 }, (_, i) => `INST_${i}`);
    const own = new Map(ids.map((id) => [id, known("2025-01-01")]));
    const e = applyOwnershipEligibility("2025-07-31", ids.map((id) => ({ instrumentId: id, reportingValue: null })), own);

    check("eligibility reports holdings ARE eligible (the trap)", e.hasEligibleHoldings === true);
    check("but zero of them contribute", e.contributingCount === 0);
    check("and the subtotal is 0", e.valuedSubtotal === 0);
    check("totalCount is 14", e.totalCount === 14);
    check("the OWNERSHIP PREHISTORY guard would NOT have fired",
      !(14 > 0 && !e.hasEligibleHoldings));

    const res = regenerateDay(dayInput({
      investmentValue: e.valuedSubtotal, investmentTier: "unknown",
      contributingComponentCount: e.contributingCount, totalComponentCount: e.totalCount,
    }));
    check("the writer now refuses the day", res.action === "skip-unsupported");
    check("so no $0.00 stocks row can be produced from this state", res.fields === null);
  }

  // ══ G. Predicate boundaries ═══════════════════════════════════════════════
  console.log("G. Predicate boundaries");
  {
    check("1 of 1 is fine", !hasNoValuedComponents({ contributingComponentCount: 1, totalComponentCount: 1 }));
    check("0 of 1 is refused", hasNoValuedComponents({ contributingComponentCount: 0, totalComponentCount: 1 }));
    check("19 of 19 is fine", !hasNoValuedComponents({ contributingComponentCount: 19, totalComponentCount: 19 }));
    check("0 of 19 is refused", hasNoValuedComponents({ contributingComponentCount: 0, totalComponentCount: 19 }));
    check("a half-recorded pair is silent (never guess)",
      !hasNoValuedComponents({ contributingComponentCount: 0, totalComponentCount: null }) &&
      !hasNoValuedComponents({ contributingComponentCount: null, totalComponentCount: 14 }));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll unsupported-zero guards passed.");
  process.exit(0);
}

main();

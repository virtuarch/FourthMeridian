/**
 * lib/snapshots/snapshot-completeness.test.ts
 *
 * V26-INVESTMENTS-HISTORY — persisted snapshot confidence.
 *
 * `isEstimated` is `tier !== "observed"`: a five-value ordinal collapsed into
 * one bit. It cannot separate a day worth $5,056 with every holding valued from
 * a day worth $11.65 with 18 of 19 holdings unaccounted for. This suite pins the
 * distinction now that the tier and the composition counts are persisted, and
 * pins the invariants that keep the two signals from becoming two truths.
 *
 * Standalone tsx script:  npx tsx lib/snapshots/snapshot-completeness.test.ts
 */

import {
  resolveSnapshotCompleteness, isEstimatedFromTier, snapshotConfidence,
} from "./snapshot-completeness.core";
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import { applyOwnershipEligibility } from "./ownership-eligibility.core";
import type { OwnershipResolution } from "@/lib/prices/ownership-window.core";
import { COMPLETENESS_TIERS } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { ClassifyTotals } from "./backfill-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BASE: ClassifyTotals = {
  totalInvestments: 1000, totalDigitalAssets: 0, totalChecking: 500,
  totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0,
};

function dayInput(over: Partial<DayRegenInput> = {}): DayRegenInput {
  return {
    date: "2026-06-25",
    existingIsEstimated: true,
    base: BASE,
    investmentValue: 1000,
    investmentTier: "estimated",
    hasInvestmentEvidence: true,
    digitalAssetValue: 0,
    digitalAssetTier: "estimated",
    hasDigitalAssetEvidence: false,
    cashCardTier: "derived",
    membershipChangedSince: false,
    ...over,
  };
}

/** An ownership resolution that is KNOWN across the whole window. */
function known(fromISO = "2020-01-01", toISO = "2030-01-01"): OwnershipResolution {
  return { kind: "resolved", segments: [{ confidence: "KNOWN", fromISO, toISO }] } as OwnershipResolution;
}

function main(): void {
  // ══ A. Existing rows with null fields ═════════════════════════════════════
  console.log("A. Pre-existing rows (all three columns null) still resolve, and behave as before");
  {
    // A legacy ESTIMATED row: the flag proves it is a reconstruction, but which
    // kind was never written down.
    const legacy = resolveSnapshotCompleteness({ isEstimated: true });
    check("legacy estimated row does not crash", typeof legacy.tier === "string");
    check("resolves to a canonical tier", COMPLETENESS_TIERS.includes(legacy.tier));
    check("is NOT reported as recorded", legacy.recorded === false);
    check("basis names it legacy, so a pessimistic default is never a claim",
      legacy.basis === "legacy-unrecorded");
    check("counts stay null — never coerced to 0",
      legacy.contributingComponentCount === null && legacy.totalComponentCount === null);
    check("still reads as a reconstruction (existing behaviour preserved)",
      isEstimatedFromTier(legacy.tier) === true);

    // Totally empty row (defensive: no flag at all).
    const empty = resolveSnapshotCompleteness({});
    check("a row with no flag at all is total, not thrown", empty.tier === "unknown" && empty.recorded === false);

    // A junk value in the reserved String column must not be trusted OR fatal.
    const junk = resolveSnapshotCompleteness({ isEstimated: true, completenessTier: "very-good" });
    check("a non-canonical tier string is treated as absent, not trusted",
      junk.recorded === false && junk.basis === "legacy-unrecorded");
  }

  // ══ B. Frozen observed rows ═══════════════════════════════════════════════
  console.log("B. Frozen observed rows — never mutated, inference sound");
  {
    const frozen = resolveSnapshotCompleteness({ isEstimated: false });
    check("null tier + isEstimated=false infers observed", frozen.tier === "observed");
    check("marked as an inference, not a recorded fact",
      frozen.recorded === false && frozen.basis === "inferred-observed");
    check("the inference round-trips the FLIP rule", isEstimatedFromTier(frozen.tier) === false);

    // The writer can never persist anything for a frozen day.
    const res = regenerateDay(dayInput({ existingIsEstimated: false }));
    check("regenerateDay refuses a frozen row", res.action === "skip-frozen");
    check("no fields are produced, so nothing can be written", res.fields === null);
    check("no tier is persisted for a frozen row",
      res.contributingComponentCount === null && res.totalComponentCount === null);

    // A recorded tier still wins over the inference (an amendment may write one).
    const explicit = resolveSnapshotCompleteness({ isEstimated: false, completenessTier: "observed" });
    check("an explicitly recorded observed tier is reported as recorded",
      explicit.tier === "observed" && explicit.recorded === true && explicit.basis === "recorded");
  }

  // ══ C. Estimated but MOSTLY UNKNOWN ═══════════════════════════════════════
  console.log("C. Estimated + incomplete — tier unknown, 1 of 19 contributing (the 2026-06-24 shape)");
  {
    const res = regenerateDay(dayInput({
      investmentTier: "unknown",
      contributingComponentCount: 1,
      totalComponentCount: 19,
    }));
    check("the day is written", res.action === "write" && res.fields !== null);
    check("row tier is unknown (worst of derived cash + unknown investments)", res.tier === "unknown");
    check("isEstimated is true", res.isEstimated === true);
    check("contributing count persisted as 1", res.contributingComponentCount === 1);
    check("total count persisted as 19", res.totalComponentCount === 19);

    const r = resolveSnapshotCompleteness({
      isEstimated: res.isEstimated, completenessTier: res.tier,
      contributingComponentCount: res.contributingComponentCount,
      totalComponentCount: res.totalComponentCount,
    });
    check("read back as a RECORDED unknown", r.tier === "unknown" && r.recorded === true);
    check("composition survives the round trip",
      r.contributingComponentCount === 1 && r.totalComponentCount === 19);
  }

  // ══ D. Estimated but COMPLETE ═════════════════════════════════════════════
  console.log("D. Estimated + complete — tier estimated, 19 of 19 contributing");
  {
    const res = regenerateDay(dayInput({
      investmentTier: "estimated",
      contributingComponentCount: 19,
      totalComponentCount: 19,
    }));
    check("the day is written", res.action === "write");
    check("row tier is estimated", res.tier === "estimated");
    check("isEstimated is true — same bit as case C", res.isEstimated === true);
    check("all 19 contributed", res.contributingComponentCount === 19 && res.totalComponentCount === 19);
  }

  // ══ The point of the whole slice ══════════════════════════════════════════
  console.log("E. The two cases are now distinguishable — and were not before");
  {
    const incomplete = regenerateDay(dayInput({ investmentTier: "unknown", contributingComponentCount: 1, totalComponentCount: 19 }));
    const complete   = regenerateDay(dayInput({ investmentTier: "estimated", contributingComponentCount: 19, totalComponentCount: 19 }));

    check("BEFORE: isEstimated cannot tell them apart",
      incomplete.isEstimated === complete.isEstimated);
    check("AFTER: the tier can", incomplete.tier !== complete.tier);
    check("AFTER: the composition can",
      incomplete.contributingComponentCount !== complete.contributingComponentCount);

    const a = resolveSnapshotCompleteness({ isEstimated: true, completenessTier: incomplete.tier, contributingComponentCount: 1, totalComponentCount: 19 });
    const b = resolveSnapshotCompleteness({ isEstimated: true, completenessTier: complete.tier, contributingComponentCount: 19, totalComponentCount: 19 });
    check("resolved through the ONE interpretation, they still differ",
      a.tier !== b.tier && a.contributingComponentCount !== b.contributingComponentCount);
    check("both are recorded facts", a.recorded && b.recorded);
  }

  // ══ Counts come from the valuation output, not a re-derivation ════════════
  console.log("F. Composition counts describe exactly the set that was summed");
  {
    const own = new Map<string, OwnershipResolution>([
      ["CASH", known()], ["APLD", known("2026-06-25")], ["TSLA", known("2026-07-19")],
    ]);
    // 2026-06-24 shape: CASH contributes; APLD/TSLA are ownership prehistory;
    // RESIDUE is ownership-eligible but unvalued (a refused quantity).
    const holdings = [
      { instrumentId: "CASH",    reportingValue: 11.65 },
      { instrumentId: "APLD",    reportingValue: 125.94 },
      { instrumentId: "TSLA",    reportingValue: 375.53 },
      { instrumentId: "CASH",    reportingValue: null },   // unvalued (no price)
    ];
    const e = applyOwnershipEligibility("2026-06-24", holdings, own);
    check("subtotal counts only the contributing holding", Math.abs(e.valuedSubtotal - 11.65) < 1e-9);
    check("contributingCount matches the set that was summed", e.contributingCount === 1);
    check("an ownership-eligible but UNVALUED holding does not count as contributing",
      e.contributingCount === 1 && e.includedInstrumentIds.length === 2);
    check("totalCount counts every holding considered", e.totalCount === 4);
    check("ownership prehistory is excluded, not counted", e.excludedInstrumentIds.length === 2);

    // 2026-06-25 shape: APLD's ownership window has opened.
    const e2 = applyOwnershipEligibility("2026-06-25", holdings, own);
    check("the next day, the count moves 1 -> 2 while the tier would not move",
      e2.contributingCount === 2 && e2.totalCount === 4);
  }

  // ══ Vocabulary ════════════════════════════════════════════════════════════
  console.log("G. No parallel trust vocabulary");
  {
    for (const t of COMPLETENESS_TIERS) {
      const r = resolveSnapshotCompleteness({ isEstimated: t !== "observed", completenessTier: t });
      check(`"${t}" round-trips as a recorded tier`, r.tier === t && r.recorded === true);
    }
    const nonMember: string[] = ["partial", "high", "OBSERVED", ""];
    check("non-members are never accepted",
      nonMember.every((s) => resolveSnapshotCompleteness({ isEstimated: true, completenessTier: s }).recorded === false));
    check("isEstimatedFromTier is the FLIP rule for every tier",
      COMPLETENESS_TIERS.every((t: CompletenessTier) => isEstimatedFromTier(t) === (t !== "observed")));
  }


  // ══ H. Presentation classification (V26 chart consumption) ════════════════
  console.log("H. snapshotConfidence — three states, and the legacy safety rule");
  {
    const conf = (row: Parameters<typeof resolveSnapshotCompleteness>[0]) =>
      snapshotConfidence(resolveSnapshotCompleteness(row));

    // The rule that makes this slice a no-op until a regeneration runs.
    check("legacy estimated row (tier unrecorded) is reconstructed, NOT unreliable",
      conf({ isEstimated: true }) === "reconstructed");
    check("legacy row with junk tier is still only reconstructed",
      conf({ isEstimated: true, completenessTier: "great" }) === "reconstructed");
    check("a frozen observed row is observed", conf({ isEstimated: false }) === "observed");

    // Recorded tiers.
    check("recorded observed is observed",
      conf({ isEstimated: false, completenessTier: "observed" }) === "observed");
    check("recorded derived is reconstructed",
      conf({ isEstimated: true, completenessTier: "derived" }) === "reconstructed");
    check("recorded estimated is reconstructed",
      conf({ isEstimated: true, completenessTier: "estimated" }) === "reconstructed");
    check("recorded incomplete is UNRELIABLE",
      conf({ isEstimated: true, completenessTier: "incomplete" }) === "unreliable");
    check("recorded unknown is UNRELIABLE",
      conf({ isEstimated: true, completenessTier: "unknown" }) === "unreliable");

    // The two cases this whole arc exists to separate.
    const mostlyUnknown = conf({ isEstimated: true, completenessTier: "unknown", contributingComponentCount: 1, totalComponentCount: 19 });
    const complete      = conf({ isEstimated: true, completenessTier: "estimated", contributingComponentCount: 19, totalComponentCount: 19 });
    check("$11.65 @ 1/19 and $5,056 @ 19/19 now classify DIFFERENTLY",
      mostlyUnknown === "unreliable" && complete === "reconstructed");

    // Counts are disclosure, never a rule.
    check("counts do not change the classification",
      conf({ isEstimated: true, completenessTier: "estimated", contributingComponentCount: 1, totalComponentCount: 19 }) ===
      conf({ isEstimated: true, completenessTier: "estimated", contributingComponentCount: 19, totalComponentCount: 19 }));
    check("an unreliable classification never depends on a coverage ratio",
      conf({ isEstimated: true, completenessTier: "unknown", contributingComponentCount: 19, totalComponentCount: 19 }) === "unreliable");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll snapshot-completeness guards passed.");
  process.exit(0);
}

main();

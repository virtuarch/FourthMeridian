/**
 * lib/snapshots/amendment-whole-day.regression.test.ts   (F1 — 2026-10-15)
 *
 * REPRODUCES the Preview finding behind the owner's F1 ruling, at the pure
 * day-regeneration seam every amendment runs through (regenerateDay):
 *
 *   A frozen, observed day holds stocks 50,000 · cash 10,000 · net worth 60,000.
 *   The user adds a $1 real asset whose history reaches that day. The amendment
 *   engine (isAmendment: true — frozen-row guard bypassed by consent) rebuilds
 *   the WHOLE day from today's data: the A8 investment valuation for that day
 *   now says 51,496, so the rewritten row moves by 1,497 — of which 1,496 has
 *   nothing to do with the asset the user consented to add.
 *
 * The owner ruled this is NOT a valid historical asset amendment: an amendment
 * may change only the affected asset's contribution; every unrelated balance
 * and observation must stay as recorded. Until the engine can amend one
 * account's SLICE, the action is disabled (lib/snapshots/amendment-availability.ts).
 *
 * This file therefore pins THREE things:
 *   1. the defect, as it is today (so the reproduction cannot silently vanish);
 *   2. that the switch is OFF while the defect stands (users cannot reach it);
 *   3. the INVARIANT the correction must satisfy — asserted only once the
 *      switch is turned ON, so flipping the switch without the fix fails here.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/amendment-whole-day.regression.test.ts
 */
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import type { ClassifyTotals, SnapshotFields } from "./backfill-core";
import { HISTORICAL_AMENDMENT_ENABLED } from "./amendment-availability";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// The frozen day as it was recorded (observed), before the asset existed.
const recorded: SnapshotFields = {
  stocks: 50_000, crypto: 0, total: 50_000, cash: 10_000, savings: 0, debt: 0,
  netWorth: 60_000, totalAssets: 60_000, netLiquid: 10_000, cashOnHand: 10_000,
};

// What the engine computes for that day TODAY: cash walked back to the same
// 10,000, no crypto, and the $1 asset — but the investment valuation from
// today's holdings × that day's price reads 51,496, not the recorded 50,000.
const today: ClassifyTotals = {
  totalInvestments: 50_000, totalDigitalAssets: 0, totalChecking: 10_000,
  totalSavings: 0, totalLiabilities: 0, totalRealAssets: 1,
};
const ASSET_CONTRIBUTION = 1;
const UNRELATED_REVALUATION = 51_496 - 50_000;

const amendment: DayRegenInput = {
  date: "2026-10-14",
  existingIsEstimated: false,      // FROZEN — only an amendment may rewrite it
  existing: recorded,
  base: today,
  investmentValue: 51_496, investmentTier: "derived", hasInvestmentEvidence: true,
  digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: true,
  cashCardTier: "derived",
  realAssetTier: "estimated",      // the asset's value on that day is modeled
  membershipChangedSince: false,
  isAmendment: true,
};

console.log("1. the defect, reproduced at the day seam");
{
  const r = regenerateDay(amendment);
  const f = r.fields;
  check("the consented amendment rewrites the frozen day", r.action === "write" || r.action === "write-partial", r.action);
  check("…and its stocks component moves from the recorded 50,000 to today's 51,496 — an UNRELATED re-valuation",
    f?.stocks === 51_496 && recorded.stocks === 50_000, JSON.stringify(f));
  const delta = (f?.netWorth ?? NaN) - recorded.netWorth;
  check(`net worth moves by ${ASSET_CONTRIBUTION + UNRELATED_REVALUATION}, of which only ${ASSET_CONTRIBUTION} is the asset the user consented to`,
    Math.abs(delta - (ASSET_CONTRIBUTION + UNRELATED_REVALUATION)) < 0.5, `delta=${delta}`);
  check("the rewritten row is marked estimated (an amendment never lands observed)", r.isEstimated === true);
}

console.log("2. the same day WITHOUT consent is left alone (the frozen-row invariant still holds)");
{
  const r = regenerateDay({ ...amendment, isAmendment: false });
  check("automatic regeneration skips the frozen day", r.action === "skip-frozen", r.action);
}

console.log("3. while the defect stands, the action is OFF");
{
  check("HISTORICAL_AMENDMENT_ENABLED is false", HISTORICAL_AMENDMENT_ENABLED === false);
}

console.log("4. the invariant the correction must satisfy (enforced once the switch is ON)");
if (HISTORICAL_AMENDMENT_ENABLED) {
  const r = regenerateDay(amendment);
  const f = r.fields;
  check("SLICE AMENDMENT: stocks, crypto, cash, savings and debt stay exactly as recorded",
    f?.stocks === recorded.stocks && f?.crypto === recorded.crypto && f?.cash === recorded.cash
    && f?.savings === recorded.savings && f?.debt === recorded.debt, JSON.stringify(f));
  check("SLICE AMENDMENT: net worth moves by the asset's contribution only",
    Math.abs((f?.netWorth ?? NaN) - recorded.netWorth - ASSET_CONTRIBUTION) < 0.005, String(f?.netWorth));
} else {
  console.log("  · skipped (switch OFF) — flip HISTORICAL_AMENDMENT_ENABLED only with the slice correction; this section then becomes the gate");
}

if (failures > 0) { console.error(`\namendment-whole-day regression: ${failures} failure(s).`); process.exit(1); }
console.log("\namendment-whole-day regression: all passed.");

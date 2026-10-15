/**
 * lib/snapshots/manual-asset-history.core.test.ts   (RWA-2B)
 *
 * How a manual real-world asset enters a reconstructed historical day:
 *   - the per-day value is THE valuation policy's answer (anchors → recorded /
 *     modeled / carried), never today's balance painted backward;
 *   - nothing before the first anchor (held-but-unvalued days contribute nothing);
 *   - carried flat after the last anchor, never extrapolated;
 *   - the floor is the first anchor in a PERSONAL Space and max(first anchor,
 *     link date) in a SHARED Space — through the ONE floor authority
 *     (computeAccountFloors), not a second rule;
 *   - a LEGACY asset (no ledger rows, no profile) is byte-identical to the
 *     pre-RWA-2B engine: floor = today, absent from every reconstructed day;
 *   - the live "today" writer (FinancialAccount.balance = latest anchor) and the
 *     engine agree on every day at or after the latest anchor;
 *   - a modeled/carried day is an ESTIMATE (tier "estimated"); a recorded day
 *     adds no constraint.
 *
 *   npx tsx lib/snapshots/manual-asset-history.core.test.ts
 */
import {
  resolveAnchors, latestAnchor, type ProfileFacts, type ValuationRow,
} from "@/lib/assets/valuation-series.core";
import { computeAccountFloors, fromISO, isoDate } from "./backfill-core";
import { regenerateDay, type DayRegenInput } from "./regenerate-history.core";
import {
  isLegacyManualAsset, manualAssetHistoryFloor, manualAssetValueOn, realAssetTierFor,
  type ManualAssetHistoryInput,
} from "./manual-asset-history.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const row = (id: string, effectiveDate: string, value: number, recordedAt = `${effectiveDate}T12:00:00.000Z`): ValuationRow =>
  ({ id, effectiveDate, value, currency: "USD", recordedAt });
const profile = (over: Partial<ProfileFacts> = {}): ProfileFacts =>
  ({ acquisitionDate: null, purchasePrice: null, purchaseCurrency: null, purchasePriceIsStartingValue: false, ...over });
const TODAY = "2026-10-15";

function input(args: { valuations: ValuationRow[]; profile?: ProfileFacts | null; legacy?: { balance: number; lastUpdated: string } | null }): ManualAssetHistoryInput {
  const resolved = resolveAnchors({
    currency: "USD", valuations: args.valuations, profile: args.profile ?? null,
    legacy: args.legacy ? { balance: args.legacy.balance, currency: "USD", lastUpdated: args.legacy.lastUpdated } : null,
  });
  return { resolved, isLegacy: isLegacyManualAsset({ resolved, hasProfile: (args.profile ?? null) !== null }) };
}

console.log("1. anchors → per-day values (the one policy, reused)");
{
  // Bought 2026-01-01 for 100,000 (opted in as the starting value); valued 120,000 on 2026-07-01.
  const a = input({
    valuations: [row("v1", "2026-07-01", 120_000)],
    profile: profile({ acquisitionDate: "2026-01-01", purchasePrice: 100_000, purchaseCurrency: "USD", purchasePriceIsStartingValue: true }),
  });
  check("not legacy", !a.isLegacy);
  check("on the purchase anchor → recorded 100,000",
    JSON.stringify(manualAssetValueOn(a, "2026-01-01")) === JSON.stringify({ value: 100_000, basis: "recorded" }));
  const mid = manualAssetValueOn(a, "2026-04-01");
  check("between the anchors → MODELED, strictly between the two values",
    mid !== null && mid.basis === "modeled" && mid.value > 100_000 && mid.value < 120_000, JSON.stringify(mid));
  check("modeled values are whole units", mid !== null && Number.isInteger(mid.value));
  check("on the valuation anchor → recorded 120,000",
    JSON.stringify(manualAssetValueOn(a, "2026-07-01")) === JSON.stringify({ value: 120_000, basis: "recorded" }));
  check("after the last anchor → CARRIED flat, never extrapolated",
    JSON.stringify(manualAssetValueOn(a, "2026-10-14")) === JSON.stringify({ value: 120_000, basis: "carried" }));
  check("the day before acquisition → nothing (not held)", manualAssetValueOn(a, "2025-12-31") === null);
  check("floor (PERSONAL) = the first anchor = acquisition date", manualAssetHistoryFloor(a, TODAY) === "2026-01-01");
}

console.log("2. nothing before the first anchor — held but unvalued days contribute nothing");
{
  // Acquired 2020-10-15 WITHOUT opting the purchase price in; first value dated 2026-07-01.
  const a = input({
    valuations: [row("v1", "2026-07-01", 500_000)],
    profile: profile({ acquisitionDate: "2020-10-15", purchasePrice: 400_000, purchaseCurrency: "USD" }),
  });
  check("ownership starts at acquisition (resolver)", a.resolved.startDate === "2020-10-15");
  check("…but the HISTORY floor is the first ANCHOR, not the acquisition date", manualAssetHistoryFloor(a, TODAY) === "2026-07-01");
  check("a held-but-unvalued day contributes nothing (no value invented)", manualAssetValueOn(a, "2023-01-01") === null);
  check("the purchase price is never used as a value without the opt-in", manualAssetValueOn(a, "2020-10-15") === null);
}

console.log("3. floors — PERSONAL vs SHARED, through computeAccountFloors (single authority)");
{
  const a = input({
    valuations: [row("v1", "2026-07-01", 120_000)],
    profile: profile({ acquisitionDate: "2026-01-01", purchasePrice: 100_000, purchaseCurrency: "USD", purchasePriceIsStartingValue: true }),
  });
  const today = fromISO(TODAY);
  const earliest = new Map<string, Date>([["asset", fromISO(manualAssetHistoryFloor(a, TODAY))]]);
  const linkedAt = new Date("2026-03-10T15:30:00Z"); // shared into the Space mid-March
  const personal = computeAccountFloors([{ id: "asset", linkCreatedAt: linkedAt }], earliest, new Set(), false, today);
  const shared   = computeAccountFloors([{ id: "asset", linkCreatedAt: linkedAt }], earliest, new Set(), true,  today);
  check("PERSONAL: floor = first anchor (the link date does not bound the home Space)", isoDate(personal.get("asset")!) === "2026-01-01");
  check("SHARED: floor = max(first anchor, link date) — never earlier history imported", isoDate(shared.get("asset")!) === "2026-03-10");
  const linkedBefore = new Date("2025-06-01T00:00:00Z");
  const sharedEarlyLink = computeAccountFloors([{ id: "asset", linkCreatedAt: linkedBefore }], earliest, new Set(), true, today);
  check("SHARED with a link older than the first anchor: floor = first anchor", isoDate(sharedEarlyLink.get("asset")!) === "2026-01-01");
}

console.log("4. legacy asset = byte-identical to the pre-RWA-2B engine (no change without a user action)");
{
  const legacy = input({ valuations: [], profile: null, legacy: { balance: 250_000, lastUpdated: "2026-05-20T09:00:00Z" } });
  check("detected as legacy (one LEGACY_BALANCE anchor, no profile)", legacy.isLegacy);
  check("floor = today ⇒ zero reconstructable days, exactly as before", manualAssetHistoryFloor(legacy, TODAY) === TODAY);
  check("contributes nothing on any historical day", manualAssetValueOn(legacy, "2026-06-01") === null && manualAssetValueOn(legacy, "2026-05-20") === null);
  const today = fromISO(TODAY);
  const earliest = new Map<string, Date>([["legacy", fromISO(manualAssetHistoryFloor(legacy, TODAY))]]);
  const withSeed    = computeAccountFloors([{ id: "legacy", linkCreatedAt: new Date("2025-01-01T00:00:00Z") }], earliest, new Set(), false, today);
  const withoutSeed = computeAccountFloors([{ id: "legacy", linkCreatedAt: new Date("2025-01-01T00:00:00Z") }], new Map(), new Set(), false, today);
  check("the seeded floor equals the unseeded (pre-RWA-2B) floor", withSeed.get("legacy")!.getTime() === withoutSeed.get("legacy")!.getTime());

  // The moment a value is recorded (PATCH writes the legacy balance as a dated
  // row + the new row), the asset is no longer legacy and the resolver drives it.
  const afterPatch = input({ valuations: [row("legacy", "2026-05-20", 250_000, "2026-05-20T09:00:00Z"), row("v2", TODAY, 260_000)], profile: null });
  check("after the first PATCH it is no longer legacy", !afterPatch.isLegacy);
  check("…its floor is the legacy balance's date", manualAssetHistoryFloor(afterPatch, TODAY) === "2026-05-20");
  check("…and the days between are modeled", manualAssetValueOn(afterPatch, "2026-08-01")?.basis === "modeled");
  const newToday = input({ valuations: [row("v1", TODAY, 10_000)], profile: null });
  check("an asset first valued TODAY has floor = today (no history to rebuild)", manualAssetHistoryFloor(newToday, TODAY) === TODAY && !newToday.isLegacy);
}

console.log("5. the live today writer and the engine agree");
{
  // PATCH sets FinancialAccount.balance = the latest-dated anchor's value.
  const a = input({ valuations: [row("v1", "2026-01-01", 100_000), row("v2", "2026-09-01", 90_000)], profile: null });
  const liveBalance = latestAnchor(a.resolved)!.value;
  check("balance follows the latest-dated anchor", liveBalance === 90_000);
  for (const d of ["2026-09-01", "2026-09-15", "2026-10-14", TODAY]) {
    const v = manualAssetValueOn(a, d);
    check(`engine on ${d} = live balance (${v?.basis})`, v !== null && v.value === liveBalance);
  }
  // A backdated correction older than the latest anchor changes the past, not today.
  const corrected = input({ valuations: [row("v1", "2026-01-01", 100_000), row("v2", "2026-09-01", 90_000), row("v3", "2026-05-01", 95_000)], profile: null });
  check("a backdated correction leaves today's value exactly as it was", manualAssetValueOn(corrected, TODAY)?.value === 90_000);
  check("…and re-models the days between", manualAssetValueOn(corrected, "2026-03-01")?.value !== manualAssetValueOn(a, "2026-03-01")?.value);
}

console.log("6. tier — a modeled or carried day is an estimate; a recorded day adds nothing");
{
  check("no manual asset valued → null (no constraint)", realAssetTierFor([]) === null);
  check("recorded only → observed (lifts nothing)", realAssetTierFor(["recorded", "recorded"]) === "observed");
  check("any modeled → estimated", realAssetTierFor(["recorded", "modeled"]) === "estimated");
  check("any carried → estimated", realAssetTierFor(["carried"]) === "estimated");

  const base: DayRegenInput = {
    date: "2026-04-01", existingIsEstimated: null,
    base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 0, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 110_000 },
    investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
    digitalAssetValue: 0, digitalAssetTier: "estimated", hasDigitalAssetEvidence: false,
    cashCardTier: "derived", membershipChangedSince: false,
  };
  const modeled = regenerateDay({ ...base, realAssetTier: "estimated" });
  check("a modeled day writes isEstimated=true with tier estimated",
    modeled.action === "write" && modeled.isEstimated === true && modeled.tier === "estimated", `${modeled.action}/${modeled.tier}`);
  check("…and names the ledger in its reason", /dated estimates/.test(modeled.reason));
  check("the real-asset value reaches totalAssets and netWorth through the shared formula",
    modeled.fields?.totalAssets === 110_000 && modeled.fields?.netWorth === 110_000 && modeled.fields?.netLiquid === 0);
  const recorded = regenerateDay({ ...base, realAssetTier: "observed" });
  const absent   = regenerateDay(base);
  check("a recorded day is no more trusted than the rest of the row", recorded.tier === absent.tier && recorded.isEstimated === absent.isEstimated);
  check("omitting realAssetTier preserves prior behaviour exactly",
    absent.tier === "derived" && absent.isEstimated === true && JSON.stringify(absent.fields) === JSON.stringify(recorded.fields));
  const frozen = regenerateDay({ ...base, existingIsEstimated: false, realAssetTier: "estimated" });
  check("the frozen-row guard is untouched (an observed row is never rewritten automatically)", frozen.action === "skip-frozen");
}

if (failures > 0) { console.error(`\nmanual-asset-history: ${failures} failure(s).`); process.exit(1); }
console.log("\nmanual-asset-history: all passed.");

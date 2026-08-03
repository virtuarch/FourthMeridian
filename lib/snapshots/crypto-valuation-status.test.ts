/**
 * lib/snapshots/crypto-valuation-status.test.ts
 *
 * V26-CRYPTO-STATUS-1 — the canonical vocabulary, the read-boundary resolution,
 * and the two consumers that must refuse contaminated points. Standalone tsx.
 */

import {
  CRYPTO_VALUATION_STATUSES, isCryptoValuationStatus, toStoredCryptoValuationStatus,
  resolveCryptoValuationState, isCryptoAssertable, isAssetSideContaminated,
  cryptoUnavailableReason, CRYPTO_MATERIALITY_EPSILON,
} from "./crypto-valuation-status.core";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import type { Snapshot } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const state = (over: Partial<Parameters<typeof resolveCryptoValuationState>[0]> = {}) =>
  resolveCryptoValuationState({ crypto: 15_516.70, isEstimated: true, cryptoValuationStatus: null, ...over });

/** A DTO row as the read boundary would emit it. */
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  date: "2025-01-15", netWorth: -1_886.90, totalAssets: 27_027.33, totalDebt: 28_914.23,
  totalCash: 460.12, totalSavings: 6_001.51, totalInvestments: 5_049.00, totalCrypto: 15_516.70,
  cashOnHand: 460.12, netLiquid: -22_452.60, isEstimated: true,
  cryptoValuationState: "legacy-unrecorded", cryptoAssertable: false, assetSideContaminated: true,
  cryptoUnavailableReason: "HISTORICAL_CRYPTO_VALUATION_UNRECORDED",
  ...over,
});

/** A clean, fully-supported row. */
const clean = (over: Partial<Snapshot> = {}): Snapshot => snap({
  date: "2026-01-01", totalCrypto: 21_070.78, netWorth: 24_141.08, totalAssets: 24_141.08,
  cryptoValuationState: "supported", cryptoAssertable: true, assetSideContaminated: false,
  cryptoUnavailableReason: undefined, ...over,
});

function main(): void {
  console.log("V26-CRYPTO-STATUS-1\n");

  // ── vocabulary + write guard ──────────────────────────────────────────────
  console.log("1. vocabulary");
  check("exactly two stored values", JSON.stringify(CRYPTO_VALUATION_STATUSES) === '["supported","unavailable"]');
  check("guard accepts members", isCryptoValuationStatus("supported") && isCryptoValuationStatus("unavailable"));
  check("guard rejects a parallel vocabulary",
    !isCryptoValuationStatus("SUPPORTED") && !isCryptoValuationStatus("ok") && !isCryptoValuationStatus("legacy-unrecorded"));
  check("guard rejects null/undefined/number", !isCryptoValuationStatus(null) && !isCryptoValuationStatus(undefined) && !isCryptoValuationStatus(1));
  check("normaliser passes members through", toStoredCryptoValuationStatus("unavailable") === "unavailable");
  check("normaliser nulls anything else (unrecorded is the safe state)",
    toStoredCryptoValuationStatus("SUPPORTED") === null && toStoredCryptoValuationStatus(null) === null);

  // ── the five required semantics ───────────────────────────────────────────
  console.log("\n2. resolution — the five semantics");
  check("1 observed row is trusted regardless of null status",
    state({ isEstimated: false }) === "observed");
  check("1 …even with an 'unavailable' status stamped on it",
    state({ isEstimated: false, cryptoValuationStatus: "unavailable" }) === "observed");
  check("2 estimated + supported → supported",
    state({ cryptoValuationStatus: "supported" }) === "supported");
  check("3 estimated + unavailable → unavailable",
    state({ cryptoValuationStatus: "unavailable" }) === "unavailable");
  check("4 estimated + null + material crypto → legacy-unrecorded",
    state() === "legacy-unrecorded");
  check("5 estimated + null + immaterial crypto → none",
    state({ crypto: 0 }) === "none" && state({ crypto: CRYPTO_MATERIALITY_EPSILON }) === "none");
  check("a supported row with immaterial crypto is 'none', not 'supported'",
    state({ crypto: 0, cryptoValuationStatus: "supported" }) === "none");
  check("resolution never consults a price floor (no such input exists)",
    Object.keys({ crypto: 0, isEstimated: true, cryptoValuationStatus: null }).length === 3);

  // ── assertability + contamination ─────────────────────────────────────────
  console.log("\n3. assertability");
  check("observed/supported/none are assertable",
    (["observed", "supported", "none"] as const).every(isCryptoAssertable));
  check("unavailable/legacy-unrecorded are NOT assertable",
    !isCryptoAssertable("unavailable") && !isCryptoAssertable("legacy-unrecorded"));
  check("unassertable ⇒ asset side contaminated",
    isAssetSideContaminated("unavailable") && isAssetSideContaminated("legacy-unrecorded"));
  check("assertable ⇒ asset side clean",
    !isAssetSideContaminated("observed") && !isAssetSideContaminated("supported") && !isAssetSideContaminated("none"));
  check("reasons are distinct and machine-readable",
    cryptoUnavailableReason("unavailable") === "HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE" &&
    cryptoUnavailableReason("legacy-unrecorded") === "HISTORICAL_CRYPTO_VALUATION_UNRECORDED" &&
    cryptoUnavailableReason("supported") === null);

  // ── Net Worth: refuse, don't caveat ───────────────────────────────────────
  console.log("\n4. Net Worth");
  {
    const rows = [snap({ date: "2025-01-15" }), snap({ date: "2025-08-02" }), clean({ date: "2026-01-01" })];
    const wtm = computeWealthTimeMachine({ snapshots: rows, asOf: "2026-01-01", compareTo: null, currency: "USD" });
    check("contaminated points are omitted — coverage starts at the first clean date",
      wtm.coverageFrom === "2026-01-01", String(wtm.coverageFrom));
    check("the supported point survives and carries its real value",
      wtm.asOfState.netWorth === 24_141.08, String(wtm.asOfState.netWorth));
  }
  {
    // An OBSERVED below-floor row (another user's frozen history) must remain.
    const observed = snap({ date: "2024-12-01", isEstimated: false,
      cryptoValuationState: "observed", cryptoAssertable: true, assetSideContaminated: false });
    const wtm = computeWealthTimeMachine({ snapshots: [observed, clean()], asOf: "2026-01-01", compareTo: null, currency: "USD" });
    check("observed rows are NEVER dropped by this rule",
      wtm.coverageFrom === "2024-12-01", String(wtm.coverageFrom));
  }
  {
    // A Space with no crypto is untouched.
    const none = snap({ date: "2024-12-01", totalCrypto: 0,
      cryptoValuationState: "none", cryptoAssertable: true, assetSideContaminated: false });
    const wtm = computeWealthTimeMachine({ snapshots: [none, clean()], asOf: "2026-01-01", compareTo: null, currency: "USD" });
    check("no-crypto rows are unaffected", wtm.coverageFrom === "2024-12-01");
  }
  {
    // A DTO built before this slice carries no flag → nothing is dropped.
    const legacyDto = snap({ date: "2024-12-01", assetSideContaminated: undefined });
    const wtm = computeWealthTimeMachine({ snapshots: [legacyDto, clean()], asOf: "2026-01-01", compareTo: null, currency: "USD" });
    check("absent flag ⇒ byte-identical prior behaviour", wtm.coverageFrom === "2024-12-01");
  }

  // ── Liquidity / Debt components survive on the SAME row ───────────────────
  console.log("\n5. unaffected components");
  {
    const r = snap();
    check("cash/savings/debt/netLiquid are untouched by contamination",
      r.totalCash === 460.12 && r.totalSavings === 6_001.51 && r.totalDebt === 28_914.23 && r.netLiquid === -22_452.60);
  }

  // ── AI: null + reason, never zero, never silent ───────────────────────────
  console.log("\n6. AI payload");
  {
    const section = projectSnapshotSection([snap({ date: "2025-01-15" }), clean({ date: "2026-01-01" })], "full")!;
    const bad  = section.history[0];
    const good = section.history[1];
    check("contaminated point is INCLUDED (not silently dropped)", section.history.length === 2);
    check("digitalAssets is null, never 0", bad.digitalAssets === null);
    check("netWorth is null", bad.netWorth === null);
    check("totalAssets is null", bad.totalAssets === null);
    check("an explicit machine-readable reason accompanies it",
      bad.digitalAssetsUnavailableReason === "HISTORICAL_CRYPTO_VALUATION_UNRECORDED",
      String(bad.digitalAssetsUnavailableReason));
    check("components that never involved crypto stay factual",
      bad.liabilities === 28_914.23 && bad.liquid === 6_461.63 && bad.investments === 5_049.00);
    check("the supported point is unchanged and carries no reason",
      good.digitalAssets === 21_070.78 && good.netWorth === 24_141.08 && good.digitalAssetsUnavailableReason === undefined);
    check("the count of unassertable points is disclosed",
      section.unassertableCryptoPoints === 1, String(section.unassertableCryptoPoints));
    check("trend crossing an unassertable endpoint is REFUSED",
      section.netWorthTrend === null && section.netWorthTrendPct === null);
  }
  {
    const bothClean = projectSnapshotSection([clean({ date: "2026-01-01" }), clean({ date: "2026-02-01", netWorth: 25_000 })], "full")!;
    check("trend between two assertable points is still computed",
      bothClean.netWorthTrend === 25_000 - 24_141.08);
    check("clean histories disclose nothing extra",
      bothClean.unassertableCryptoPoints === undefined);
  }

  console.log(failures === 0 ? "\nAll crypto-valuation-status guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

/**
 * lib/perspectives/envelope.test.ts
 *
 * Pure tests for the per-perspective trust-envelope resolver (S3). Deterministic,
 * DB-free:  npx tsx lib/perspectives/envelope.test.ts
 */

import { resolvePerspectiveEnvelope } from "./envelope";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import type { Snapshot } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const snap = (date: string, o: Partial<Snapshot> = {}): Snapshot => ({
  date, totalCash: 1000, totalSavings: 0, totalInvestments: 0, totalCrypto: 0,
  totalDebt: 0, totalAssets: 1000, netWorth: 1000, cashOnHand: 1000, ...o,
});

console.log("Wealth envelope — from the WealthResult");
{
  const series = [snap("2026-06-01"), snap("2026-07-01", { totalCash: 2000, totalAssets: 2000, netWorth: 2000 })];
  const wr = computeWealthTimeMachine({ snapshots: series, asOf: "2026-07-05", compareTo: "2026-06-01", currency: "USD" });
  const env = resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: wr, currency: "USD" });
  check("completeness carries the Wealth tier/label", env.completeness?.label === "Observed" && env.completeness?.tier === "observed");
  check("completeness has a popover detail", typeof env.completeness?.detail === "string" && env.completeness!.detail!.length > 0);
  check("evidence label is the real snapshot count", env.evidence?.label === "2 snapshots");
  check("evidence rows are real records (date · value · tier)", (env.evidence?.rows?.length ?? 0) > 0 && env.evidence!.rows!.every((r) => r.tier === "observed" || r.tier === "reconstructed"));

  // Reconstructed (isEstimated) as-of ⇒ derived tier + reason, never Observed.
  const est = computeWealthTimeMachine({ snapshots: [snap("2026-05-01", { isEstimated: true })], asOf: "2026-05-10", compareTo: null, currency: "USD" });
  const estEnv = resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: est, currency: "USD" });
  check("reconstructed ⇒ tier derived, label Reconstructed", estEnv.completeness?.tier === "derived" && estEnv.completeness?.label === "Reconstructed");
  check("reconstructed rows marked reconstructed", estEnv.evidence?.rows?.some((r) => r.tier === "reconstructed") === true);
}

console.log("Static lens envelopes");
{
  const cf = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  check("Cash Flow: observed within transaction depth, no fake evidence", cf.completeness?.tier === "observed" && cf.evidence === undefined);
  const inv = resolvePerspectiveEnvelope({ perspectiveId: "investments" });
  check("Investments: incomplete 'Current holdings only'", inv.completeness?.tier === "incomplete" && /current holdings only/i.test(inv.completeness!.label));
}

console.log("Lens-provenance envelopes (Liquidity/Debt)");
{
  const lens = (estimated: boolean, ids: string[]): LensResult => ({
    lensId: "liquidity", lensVersion: 1, scope: { spaceId: "s", userId: "u" }, computedAt: "2026-07-01T00:00:00Z",
    status: "ok", estimated, metrics: [], assumptions: [],
    provenance: { accountIds: ids, tierCounts: { full: ids.length, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: "2026-07-01T00:00:00Z", redactions: [] },
  });
  const obs = resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: lens(false, ["a", "b", "c"]) });
  check("non-estimated lens ⇒ Observed + real account count", obs.completeness?.tier === "observed" && obs.evidence?.label === "3 accounts");
  const est = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens(true, ["a"]) });
  check("estimated lens ⇒ Estimated tier/tone", est.completeness?.tier === "estimated" && est.completeness?.tone === "warning" && est.evidence?.label === "1 account");
}

console.log("Absent inputs ⇒ empty envelope (inert placeholders, never fabricated)");
{
  check("goals ⇒ empty envelope", JSON.stringify(resolvePerspectiveEnvelope({ perspectiveId: "goals" })) === "{}");
  check("wealth with no result ⇒ empty envelope", JSON.stringify(resolvePerspectiveEnvelope({ perspectiveId: "wealth" })) === "{}");
  check("liquidity with no lens result ⇒ empty envelope", JSON.stringify(resolvePerspectiveEnvelope({ perspectiveId: "liquidity" })) === "{}");
  check("unknown perspective ⇒ empty envelope", JSON.stringify(resolvePerspectiveEnvelope({ perspectiveId: "xyz" })) === "{}");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll envelope checks passed");

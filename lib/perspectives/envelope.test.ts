/**
 * lib/perspectives/envelope.test.ts
 *
 * Pure tests for the per-perspective trust-envelope resolver (S3). Deterministic,
 * DB-free:  npx tsx lib/perspectives/envelope.test.ts
 */

import { resolvePerspectiveEnvelope } from "./envelope";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import type { Snapshot } from "@/types";
import type { LensResult, CompletenessTier, Completeness } from "@/lib/perspective-engine/types";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import type { InvestmentsTimeMachineResult } from "@/lib/investments/investments-time-machine-core";

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
  // Investments: absent result ⇒ empty envelope (A10 — the old static
  // "Current holdings only" text is DELIBERATELY removed; the case is now
  // driven by the InvestmentsTimeMachineResult).
  const inv = resolvePerspectiveEnvelope({ perspectiveId: "investments" });
  check("Investments: absent result ⇒ empty envelope (inert chips)", inv.completeness === undefined && inv.evidence === undefined);
  check("Investments: no stale 'Current holdings only' text", !/current holdings only/i.test(JSON.stringify(inv)));
}

console.log("Investments dynamic envelope (A10 — from the InvestmentsTimeMachineResult)");
{
  const invResult = (o: { tier: CompletenessTier; conflict?: boolean; reason?: string; valuedCount?: number; unvaluedCount?: number }): InvestmentsTimeMachineResult => ({
    asOf: "2026-07-01", compareTo: null, reportingCurrency: "USD",
    holdings: [],
    portfolio: {
      reportingCurrency: "USD", valuedSubtotal: 0,
      valuedCount: o.valuedCount ?? 3, unvaluedCount: o.unvaluedCount ?? 1, unvalued: [],
      coverage: {
        valuedValue: 0, observedValue: 0, estimatedValue: 0,
        valuedCount: o.valuedCount ?? 3, unavailableCount: o.unvaluedCount ?? 1, unavailableValue: null,
        coverageByCount: (o.valuedCount ?? 3) / ((o.valuedCount ?? 3) + (o.unvaluedCount ?? 1)),
        fullyObserved: (o.unvaluedCount ?? 1) === 0,
      },
      completeness: { tier: o.tier, conflict: o.conflict ?? false, reason: o.reason ?? "", byInstrument: {} },
    },
    flows: null, reconciliation: null,
    completeness: { tier: o.tier, conflict: o.conflict ?? false, reason: o.reason ?? "All 3 holdings valued for 2026-07-01." },
  });

  const observed = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "observed", reason: "All 3 holdings valued for 2026-07-01." }) });
  check("observed ⇒ Fully valued / positive tone", observed.completeness?.tier === "observed" && observed.completeness?.label === "Fully valued" && observed.completeness?.tone === "positive");
  check("detail = result.completeness.reason", observed.completeness?.detail === "All 3 holdings valued for 2026-07-01.");
  check("evidence = real valued/total counts", observed.evidence?.label === "3 of 4 positions valued");

  const conflicted = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "observed", conflict: true }) });
  check("conflict ⇒ warning tone even at a good tier", conflicted.completeness?.tone === "warning" && conflicted.completeness?.tier === "observed");

  const incomplete = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "incomplete", valuedCount: 2, unvaluedCount: 3 }) });
  check("incomplete ⇒ Partially valued / warning", incomplete.completeness?.tier === "incomplete" && incomplete.completeness?.label === "Partially valued" && incomplete.completeness?.tone === "warning");
  check("incomplete ⇒ evidence counts reflect the partial", incomplete.evidence?.label === "2 of 5 positions valued");

  // Convergence: `unknown` is now its OWN canonical tier (UNAVAILABLE), no longer
  // collapsed into `incomplete` — the drift the single-vocabulary slice removed.
  const unknown = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "unknown" }) });
  check("unknown tier ⇒ carried through (not collapsed), Valuation unavailable / warning", unknown.completeness?.tier === "unknown" && unknown.completeness?.label === "Valuation unavailable" && unknown.completeness?.tone === "warning");

  const derived = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "derived" }) });
  check("derived ⇒ Reconstructed / neutral tone", derived.completeness?.tier === "derived" && derived.completeness?.label === "Reconstructed" && derived.completeness?.tone === "neutral");

  const noPositions = resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: invResult({ tier: "observed", valuedCount: 0, unvaluedCount: 0 }) });
  check("zero positions ⇒ no fabricated evidence chip", noPositions.evidence === undefined);
}

console.log("Cash Flow dynamic envelope (S4 — from cashFlowStamp)");
{
  const observedStamp: CashFlowStamp = { completeness: { tier: "observed", conflict: false, reason: "Computed from posted transactions within cash-flow history.", coverageFrom: "2026-04-03" }, dataAsOf: "2026-06-10" };
  const obs = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: observedStamp });
  check("observed stamp ⇒ observed tier, static-toned label", obs.completeness?.tier === "observed" && obs.completeness?.tone === "neutral");
  check("observed stamp ⇒ detail names the latest transaction on file", /2026-06-10/.test(obs.completeness?.detail ?? ""));

  const incompleteStamp: CashFlowStamp = { completeness: { tier: "incomplete", conflict: false, reason: "Requested period reaches before cash-flow history begins on 2026-04-03.", coverageFrom: "2026-04-03" }, dataAsOf: "2026-06-10" };
  const inc = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: incompleteStamp });
  check("incomplete stamp ⇒ incomplete tier, History-limited/warning", inc.completeness?.tier === "incomplete" && inc.completeness?.label === "History-limited" && inc.completeness?.tone === "warning");
  check("incomplete stamp ⇒ detail carries the stamp reason (coverage floor)", /2026-04-03/.test(inc.completeness?.detail ?? ""));

  // Backward-compatible: absent stamp ⇒ the static observed boundary, unchanged.
  const fallback = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  check("absent stamp ⇒ static observed fallback (unchanged wording)", fallback.completeness?.tier === "observed" && /within transaction depth/i.test(fallback.completeness!.label));
}

console.log("Lens-provenance envelopes (Liquidity/Debt) — tier from completeness, FX orthogonal");
{
  const lens = (o: { estimated?: boolean; ids: string[]; completeness?: Completeness }): LensResult => ({
    lensId: "liquidity", lensVersion: 1, scope: { spaceId: "s", userId: "u" }, computedAt: "2026-07-01T00:00:00Z",
    status: "ok", estimated: o.estimated ?? false, metrics: [], assumptions: [],
    ...(o.completeness ? { completeness: o.completeness } : {}),
    provenance: { accountIds: o.ids, tierCounts: { full: o.ids.length, balanceOnly: 0, summaryOnly: 0 }, dataAsOf: "2026-07-01T00:00:00Z", redactions: [] },
  });
  const cmpl = (tier: CompletenessTier, reason = ""): Completeness => ({ tier, conflict: false, reason });

  // A live "now" read carries no completeness envelope ⇒ observed (not fabricated).
  const obs = resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: lens({ ids: ["a", "b", "c"] }) });
  check("no completeness (live now) ⇒ Observed + real account count", obs.completeness?.tier === "observed" && obs.evidence?.label === "3 accounts");
  check("no completeness ⇒ no warnings", obs.warnings === undefined);

  // THE Phase-2 correctness fix: the tier is the lens's OWN completeness tier, NOT
  // lens.estimated. Reconstructed + estimated=false ⇒ the shell reads RECONSTRUCTED.
  const recon = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens({ ids: ["a"], estimated: false, completeness: cmpl("derived", "Balances reconstructed for 2026-05-01.") }) });
  check("completeness=derived, estimated=false ⇒ Reconstructed (NOT Estimated), no warning",
    recon.completeness?.tier === "derived" && recon.completeness?.label === "Reconstructed" && recon.completeness?.tone === "neutral" && recon.warnings === undefined);
  check("completeness reason flows into the popover detail", recon.completeness?.detail === "Balances reconstructed for 2026-05-01.");

  // FX is now an ORTHOGONAL warning — it must NOT flip the completeness tier.
  const fxOnly = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens({ ids: ["a"], estimated: true }) });
  check("estimated (FX) with no completeness ⇒ tier stays observed + an FX warning",
    fxOnly.completeness?.tier === "observed" && (fxOnly.warnings?.some((w) => w.kind === "fx") ?? false));

  // The two axes coexist: reconstructed tier AND an FX caveat, neither collapsing the other.
  const both = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens({ ids: ["a"], estimated: true, completeness: cmpl("derived") }) });
  check("reconstructed + FX ⇒ derived tier AND an fx warning (orthogonal)",
    both.completeness?.tier === "derived" && (both.warnings?.some((w) => w.kind === "fx") ?? false));

  // A conflict still forces a warning tone even at a good tier (unchanged doctrine).
  const conflict = resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: lens({ ids: ["a"], completeness: { tier: "observed", conflict: true, reason: "" } }) });
  check("conflict ⇒ warning tone even at observed", conflict.completeness?.tier === "observed" && conflict.completeness?.tone === "warning");
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

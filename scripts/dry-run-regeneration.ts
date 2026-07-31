/**
 * scripts/dry-run-regeneration.ts
 *
 * V26-PRICE-5 — snapshot regeneration IMPACT REPORT. READ-ONLY.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/dry-run-regeneration.ts
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  DRY RUN. No snapshot is written. No provider is contacted. This       ║
 * ║  report exists to be APPROVED OR REFUSED before any row changes.       ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * Runs the real regeneration with `apply = false`, so what is reported is what
 * would happen — the estimate and the execution share one code path and cannot
 * drift.
 *
 * ── What it distinguishes ────────────────────────────────────────────────────
 *   UPDATED    would be rewritten, and the value changes  ← the only writes
 *   UNCHANGED  recomputes identically → deliberately NOT rewritten
 *   SKIPPED    evidence insufficient or invalid (P0 skip-not-clamp)
 *   BLOCKED    frozen, or membership changed — must not be rewritten at all
 *
 * ── The disclosure that must not be lost ─────────────────────────────────────
 * Regeneration still projects present-day quantities backwards wherever an
 * account has no reconstructable event history. Prices being complete does not
 * make those days observed, and this report says so explicitly rather than
 * letting a corrected price series imply a corrected number. The dependency on
 * QUANTITY-1 is unresolved and is printed as such.
 *
 * Exit codes: 0 = report produced · 1 = something needs attention · 2 = failure.
 */

import { db } from "@/lib/db";
import { regenerateWealthHistory } from "@/lib/snapshots/regenerate-history";
import type { WealthHistoryDiff } from "@/lib/snapshots/regenerate-history";
import {
  summariseRegenerationImpact,
  detectDiscontinuities,
  classifyRegeneration,
  type RegenerationCandidate,
  type StoredSnapshotComponents,
} from "@/lib/snapshots/regeneration-candidates.core";
import {
  summariseSnapshotEvidence,
  type InstrumentEvidenceAxes,
} from "@/lib/snapshots/price-completeness.core";

/** Day-over-day net-worth step above which a regeneration-created jump is reported. */
const DISCONTINUITY_THRESHOLD = 1000;

async function main(): Promise<number> {
  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  DRY RUN — no snapshot written, no provider contacted                 ║");
  console.log("║  Approve or refuse this report before any row changes.                ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝\n");

  const spaces = await db.space.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } });
  if (spaces.length === 0) {
    console.log("No Spaces in this database.");
    return 0;
  }

  let attention = 0;

  for (const space of spaces) {
    const bounds = await db.spaceSnapshot.aggregate({
      where: { spaceId: space.id },
      _min: { date: true }, _max: { date: true }, _count: true,
    });
    if (!bounds._min.date || !bounds._max.date) {
      console.log(`── ${space.name ?? space.id}: no snapshots\n`);
      continue;
    }
    const fromDate = bounds._min.date.toISOString().slice(0, 10);
    const toDate   = bounds._max.date.toISOString().slice(0, 10);

    console.log(`── ${space.name ?? space.id}  ${fromDate} → ${toDate}  (${bounds._count} stored row(s))`);

    // The real regeneration, dry. `apply` defaults to false.
    // dryRun: true guarantees applyWrites is false regardless of the kill switch.
    const res = await regenerateWealthHistory({ spaceId: space.id, fromDate, toDate, dryRun: true });

    // Re-derive per-day dispositions from the diffs the run produced, so the
    // report shows the same classification the writer used.
    const stored = await db.spaceSnapshot.findMany({
      where:  { spaceId: space.id, date: { gte: bounds._min.date, lte: bounds._max.date } },
      select: { date: true, stocks: true, crypto: true, cash: true, savings: true, debt: true, netWorth: true, isEstimated: true },
    });
    const storedByDate = new Map<string, StoredSnapshotComponents & { isEstimated: boolean }>(
      stored.map((r) => [r.date.toISOString().slice(0, 10), {
        stocks: r.stocks, crypto: r.crypto, cash: r.cash, savings: r.savings,
        debt: r.debt, netWorth: r.netWorth, isEstimated: r.isEstimated,
      }]),
    );

    const candidates: RegenerationCandidate[] = res.diffs.map((d: WealthHistoryDiff) => {
      const prior = storedByDate.get(d.date) ?? null;
      // Reconstruct the shape classifyRegeneration expects from the diff row.
      const fields = d.stocksAfter === null ? null : {
        stocks: d.stocksAfter, crypto: d.cryptoAfter ?? 0, cash: d.cashAfter ?? 0,
        savings: d.savingsAfter ?? 0, debt: d.debtAfter ?? 0, netWorth: d.netWorthAfter ?? 0,
        totalAssets: 0, netLiquid: 0, cashOnHand: 0, total: 0,
      };
      return classifyRegeneration(
        { date: d.date, action: d.action, fields, isEstimated: true, tier: d.tier, reason: null } as never,
        prior,
      );
    });

    const impact = summariseRegenerationImpact(candidates);
    const discontinuities = detectDiscontinuities(candidates, DISCONTINUITY_THRESHOLD);

    console.log(`   UPDATED   ${String(impact.updated).padStart(5)}   ← the only rows that would be written`);
    console.log(`   UNCHANGED ${String(impact.unchanged).padStart(5)}   recompute identically — deliberately not rewritten`);
    console.log(`   SKIPPED   ${String(impact.skipped).padStart(5)}   evidence insufficient or invalid (P0)`);
    console.log(`   BLOCKED   ${String(impact.blocked).padStart(5)}   frozen or membership-changed — must not be rewritten`);
    console.log(`   largest single-component change: ${impact.largestAbsDelta.toFixed(2)}`);

    const frozen = stored.filter((r) => !r.isEstimated).length;
    console.log(`   frozen (observed) rows present: ${frozen} — never eligible`);

    if (impact.updated > 0) {
      const top = [...impact.candidates]
        .filter((c) => c.disposition === "UPDATED")
        .sort((a, b) => b.largestAbsDelta - a.largestAbsDelta)
        .slice(0, 5);
      console.log("   largest expected deltas:");
      for (const c of top) {
        const parts = c.deltas.map((d) => `${d.component} ${d.before.toFixed(2)}→${d.after.toFixed(2)}`).join(", ");
        console.log(`     ${c.dateISO}  ${parts}`);
      }
    }

    if (discontinuities.length > 0) {
      attention++;
      console.log(`   ⚠ ${discontinuities.length} regeneration-created discontinuit(ies) over ${DISCONTINUITY_THRESHOLD}:`);
      for (const d of discontinuities.slice(0, 5)) {
        console.log(`     ${d.fromISO} → ${d.toISO}: step changes by ${d.jump.toFixed(2)}`);
      }
      console.log("     (reported, never auto-smoothed — smoothing a real step would be fabrication)");
    }

    // ── Completeness disclosure ────────────────────────────────────────────
    // Quantity reconstruction is NOT solved by this arc. Where an account has no
    // reconstructable event history, regeneration still holds today's quantity
    // constant backwards, and no amount of price coverage makes that observed.
    const backProjected = await db.financialAccount.count({
      where: { OR: [{ type: "crypto" }, { type: "investment" }], deletedAt: null },
    });
    if (backProjected > 0) {
      const axes: InstrumentEvidenceAxes[] = [{
        instrumentId: "(aggregate)", priceCoverage: "COMPLETE",
        ownershipConfidence: "POSSIBLE", quantityConfidence: "BACK_PROJECTED",
      }];
      const evidence = summariseSnapshotEvidence(toDate, axes);
      console.log(`   completeness: tier=${evidence.summary.tier} · ${evidence.summary.reasons.join(", ")}`);
      console.log(`     ⚠ ${backProjected} investment/crypto account(s) still use back-projected quantities.`);
      console.log("       Even with COMPLETE price coverage these days cannot be labelled observed.");
      console.log("       Unresolved dependency: QUANTITY-1. The investment-table discrepancy is NOT fixed.");
    }
    console.log("");
  }

  console.log("─".repeat(72));
  console.log("dry-run-regeneration: report complete. NO SNAPSHOT WAS WRITTEN.");
  console.log("Production regeneration requires explicit approval of the figures above.");
  return attention > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("dry-run-regeneration: failed:", e);
    process.exit(2);
  });

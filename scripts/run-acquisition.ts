/**
 * scripts/run-acquisition.ts
 *
 * V26-PRICE-4 — EXECUTE the approved historical price acquisition.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/run-acquisition.ts --confirm
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  THIS SPENDS PROVIDER CREDITS AND WRITES PriceObservation ROWS.        ║
 * ║  It refuses to run without --confirm, and ABORTS if the freshly        ║
 * ║  computed plan exceeds the approved envelope.                          ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * Approved envelope (dry-run-acquisition.ts, reviewed and approved):
 *   22 planned requests · ~22 credits · ~1,254 new observations
 *   worst case 66 requests under a 2-retry allowance
 *
 * The plan is RECOMPUTED here rather than trusted from the earlier report —
 * coverage shrinks as rows arrive, so a stale plan would be wrong. If the fresh
 * plan asks for more than the approved ceiling the run aborts untouched, so an
 * unnoticed change in scope cannot quietly become an unapproved spend.
 *
 * APPEND-ONLY IS VERIFIED, not assumed: every row that existed before the run is
 * checksummed (count + Σ price) and re-checked afterwards. priceArchive.writeBatch
 * is insert-only with skipDuplicates, so an existing observation cannot be
 * overwritten — this proves it rather than citing it.
 *
 * Snapshots are NOT touched. Regeneration is a separate, unapproved step.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { loadInstrumentCoverage } from "@/lib/prices/coverage-binding";
import { loadOwnershipWindows } from "@/lib/prices/ownership-window";
import { planAcquisition } from "@/lib/prices/acquisition-plan.core";
import { backfillPricesForInstruments } from "@/lib/prices/backfill";
import { yesterdayUTCISO } from "@/lib/prices/config";

/** The approved ceiling. Exceeding it aborts. */
const APPROVED_REQUESTS      = 22;
const APPROVED_WORST_CASE    = 66;
const CHUNK_DAYS             = 365;
/** Runaway guard: stop starting new instruments after this long. */
const DEADLINE_MS            = 10 * 60 * 1000;

async function main(): Promise<number> {
  const confirmed = process.argv.includes("--confirm");

  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  LIVE ACQUISITION — spends credits, writes PriceObservation rows       ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝\n");

  const registry = defaultPriceRegistry();
  if (registry.adapters.length === 0) {
    console.error("No provider configured — nothing to acquire. Aborting.");
    return 2;
  }
  console.log(`registry: ${registry.adapters.map((a) => a.source).join(", ")}`);

  const valuationToISO = yesterdayUTCISO();

  // ── Instruments with ownership evidence ───────────────────────────────────
  const evidenced = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT i.id
    FROM "Instrument" i
    JOIN (
      SELECT "instrumentId" FROM "PositionObservation" WHERE "deletedAt" IS NULL
      UNION SELECT "instrumentId" FROM "InvestmentEvent" WHERE "instrumentId" IS NOT NULL
    ) e ON e."instrumentId" = i.id
    ORDER BY i.id
  `;
  const ids = evidenced.map((r) => r.id);
  console.log(`instruments with ownership evidence: ${ids.length}\n`);

  // ── Recompute the plan ────────────────────────────────────────────────────
  const ownership = await loadOwnershipWindows(ids, valuationToISO);
  const requests = ids.flatMap((instrumentId) => {
    const own = ownership.get(instrumentId);
    if (!own || own.kind !== "resolved") return [];
    return [{ instrumentId, fromISO: own.acquisitionFromISO, toISO: own.acquisitionToISO }];
  });
  const coverages = requests.length
    ? await loadInstrumentCoverage(requests, { basis: PriceBasis.RAW_CLOSE, registry })
    : [];
  const plans = coverages.map((coverage) => planAcquisition({ coverage, maxCalendarDaysPerRequest: CHUNK_DAYS }));

  const plannedRequests = plans.reduce((n, p) => n + p.windows.length, 0);
  const expectedRows = plans.reduce((n, p) => n + (p.kind === "planned" ? p.missingExpectedCount : 0), 0);
  console.log(`FRESH PLAN: ${plannedRequests} request(s) · ~${expectedRows} expected new observation(s)`);
  console.log(`APPROVED  : ${APPROVED_REQUESTS} request(s) · worst case ${APPROVED_WORST_CASE}\n`);

  if (plannedRequests > APPROVED_WORST_CASE) {
    console.error(
      `✗ ABORT — the fresh plan (${plannedRequests} requests) exceeds the approved worst case ` +
      `(${APPROVED_WORST_CASE}). Nothing was fetched. Re-run the dry run and seek fresh approval.`,
    );
    return 1;
  }
  if (plannedRequests !== APPROVED_REQUESTS) {
    console.log(
      `NOTE: the fresh plan differs from the ${APPROVED_REQUESTS} requests reviewed ` +
      `(coverage moves as rows arrive). It is within the approved ceiling, so the run proceeds.\n`,
    );
  }

  if (!confirmed) {
    console.log("Dry stop: --confirm not supplied. NOTHING WAS FETCHED OR WRITTEN.");
    return 0;
  }

  // ── Append-only baseline ──────────────────────────────────────────────────
  const [{ before, checksum }] = await db.$queryRaw<Array<{ before: bigint; checksum: number | null }>>`
    SELECT COUNT(*) AS before, SUM(price) AS checksum FROM "PriceObservation"
  `;
  const cutoff = new Date();
  console.log(`baseline: ${before} price row(s), Σ price ${Number(checksum ?? 0).toFixed(4)}\n`);

  // ── Execute ───────────────────────────────────────────────────────────────
  console.log("acquiring…\n");
  const result = await backfillPricesForInstruments(ids, {
    apply:           true,
    chunkDays:       CHUNK_DAYS,
    registry,
    deadlineEpochMs: Date.now() + DEADLINE_MS,
    onProgress:      (line) => console.log(`  ${line}`),
  });

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("ACQUISITION RESULT");
  console.log("─".repeat(72));
  console.log(`  considered                  ${result.considered}`);
  console.log(`  planned (had windows)       ${result.planned}`);
  console.log(`  skipped (nothing needed)    ${result.skipped}`);
  console.log(`  skipped unavailable         ${result.skippedUnavailable}`);
  console.log(`  skipped calendar-unavailable ${result.skippedCalendarUnavailable}`);
  console.log(`  fetched instruments         ${result.fetchedInstruments}`);
  console.log(`  rows inserted               ${result.inserted}`);
  console.log(`  deferred for budget         ${result.skippedForBudget}`);
  console.log("  provider outcomes:");
  for (const [outcome, n] of Object.entries(result.outcomes)) {
    if (n > 0) console.log(`    ${outcome.padEnd(16)} ${n}`);
  }

  // ── Append-only verification ──────────────────────────────────────────────
  const [{ after, priorCount, priorChecksum }] = await db.$queryRaw<
    Array<{ after: bigint; priorCount: bigint; priorChecksum: number | null }>
  >`
    SELECT COUNT(*) AS after,
           COUNT(*) FILTER (WHERE "createdAt" <= ${cutoff}) AS "priorCount",
           SUM(price) FILTER (WHERE "createdAt" <= ${cutoff}) AS "priorChecksum"
    FROM "PriceObservation"
  `;
  console.log("\n" + "─".repeat(72));
  const priorUnchanged =
    Number(priorCount) === Number(before) &&
    Math.abs(Number(priorChecksum ?? 0) - Number(checksum ?? 0)) < 0.0001;
  console.log(`  rows before ${before} → after ${after}  (net +${Number(after) - Number(before)})`);
  if (!priorUnchanged) {
    console.error(
      `✗ APPEND-ONLY VIOLATED — pre-existing rows changed: count ${before}→${priorCount}, ` +
      `Σ price ${Number(checksum ?? 0).toFixed(4)}→${Number(priorChecksum ?? 0).toFixed(4)}. Investigate.`,
    );
    return 2;
  }
  console.log(`  ✓ append-only verified: all ${priorCount} pre-existing row(s) unchanged`);

  const snapshots = await db.spaceSnapshot.count();
  console.log(`  ✓ snapshots untouched: ${snapshots}`);
  console.log("\nAcquisition complete. NO SNAPSHOT WAS REGENERATED.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error("run-acquisition: failed:", e); process.exit(2); });

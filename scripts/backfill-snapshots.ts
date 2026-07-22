/**
 * scripts/backfill-snapshots.ts
 *
 * D2.x Slice 4 — one-time manual runner for the historical snapshot backfill.
 *
 * The automatic backfill only fires inside runDeferredHistorySync after a
 * *future* first-run sync. Spaces whose accounts were already synced before
 * Slice 4 shipped therefore still show only today's snapshot. This script
 * invokes the SAME lib/snapshots/backfill.ts:backfillSpaceSnapshots() for
 * existing Spaces so current data gets its 30-day estimated history.
 *
 * It changes nothing about the backfill semantics — it only calls the existing
 * function, which is create-if-absent (never overwrites), excludes today, and
 * self-gates to Spaces with ≤ 1 existing snapshot.
 *
 * Modes:
 *   (default)                          Dry run — list eligible (new-Space-gated)
 *                                      Spaces, write nothing.
 *   --apply                            Backfill each eligible Space.
 *   --force-missing-estimated-all      Dry run — target ALL Spaces without
 *                                      estimated rows, BYPASSING the new-Space
 *                                      gate (includes multi-day live Spaces).
 *   --force-missing-estimated-all --apply   Write missing estimated rows for all.
 *   --dev-seed-target-spaces-30d       DEV ONLY — dry run for a fixed list of
 *                                      dev-DB Space IDs; bypasses the new-Space
 *                                      gate AND ignores account/link createdAt
 *                                      floors so up to 30 days reconstruct.
 *   --dev-seed-target-spaces-30d --apply    Write missing estimated rows for them.
 *   --repair-july2-christian           Surgical one-off — show the bad 2026-07-02
 *                                      LIVE row for Christian's Space.
 *   --repair-july2-christian --apply   Delete only that one LIVE row, then
 *                                      recreate July 2 as an estimated row.
 *   --rollback                         Dry run — count isEstimated rows to delete.
 *   --rollback --apply                 Delete all isEstimated (backfilled) rows.
 *
 * Run:
 *   npx tsx scripts/backfill-snapshots.ts                                  # preview (gated)
 *   npx tsx scripts/backfill-snapshots.ts --apply                         # backfill (gated)
 *   npx tsx scripts/backfill-snapshots.ts --force-missing-estimated-all           # preview (all)
 *   npx tsx scripts/backfill-snapshots.ts --force-missing-estimated-all --apply   # backfill (all)
 *   npx tsx scripts/backfill-snapshots.ts --rollback --apply              # delete estimated rows
 *
 * Eligibility (default backfill mode): a Space is a target when it has ZERO
 * isEstimated rows yet AND ≤ 1 total snapshot (so backfillSpaceSnapshots'
 * new-Space gate will proceed). --force-missing-estimated-all drops the ≤1
 * condition and targets every Space without estimated rows. In BOTH modes,
 * existing snapshots are never overwritten — only missing dates are written,
 * today is always excluded, isEstimated=true.
 */

import { db } from "@/lib/db";
import { backfillSpaceSnapshots } from "@/lib/snapshots/backfill";

const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const FORCE_ALL = process.argv.includes("--force-missing-estimated-all");
const DEV_SEED = process.argv.includes("--dev-seed-target-spaces-30d");
const REPAIR_JULY2 = process.argv.includes("--repair-july2-christian");

// Surgical one-off repair: Christian's Space had a partial/incomplete LIVE
// snapshot on 2026-07-02 (cash ~1152 vs ~6439 on adjacent days). This mode
// deletes ONLY that one LIVE row, then reruns the backfill so July 2 is
// recreated as isEstimated=true. Never deletes estimated rows; never touches
// other Spaces or dates.
const REPAIR_SPACE_ID = "cmr456dtb0004117fjb6qavmm";
const REPAIR_DATE_FROM = new Date("2026-07-02T00:00:00.000Z");
const REPAIR_DATE_TO   = new Date("2026-07-03T00:00:00.000Z"); // exclusive

// DEV-ONLY targeted seeding. These specific dev-DB Spaces get up to 30 days of
// estimated history so charts render a trend. Isolated to this flag; never used
// by the app runtime.
const DEV_SEED_TARGET_SPACE_IDS = [
  "cmr456dtb0004117fjb6qavmm",
  "cmr4652a3067z117fqu32m3sc",
  "cmr469jxx068s117f687bid5b",
  "cmr46amp806ag117fnhownjvh",
  "cmr46bn5n06c4117fjzzg84rn",
  "cmr46ch5w06ct117fjtcyr8dq",
  "cmr46dejs06ej117fux87wlq0",
  "cmr46ebfj06fg117fz6mkwzsv",
  "cmr46fz8706g6117f0xdq6ch5",
];

async function rollback(): Promise<void> {
  const grouped = await db.spaceSnapshot.groupBy({
    by: ["spaceId"],
    where: { isEstimated: true },
    _count: { _all: true },
  });
  const totalRows = grouped.reduce((s, g) => s + g._count._all, 0);

  console.log(`Rollback — isEstimated (backfilled) snapshot rows`);
  console.log(`  Spaces with backfilled rows: ${grouped.length}`);
  console.log(`  Rows total:                  ${totalRows}`);

  if (!APPLY) {
    console.log("\nDry run only — nothing deleted. Re-run with --rollback --apply to delete these rows.");
    return;
  }

  const res = await db.spaceSnapshot.deleteMany({ where: { isEstimated: true } });
  console.log(`\nDeleted ${res.count} isEstimated snapshot row(s).`);
}

async function backfill(): Promise<void> {
  // Non-deleted, non-archived Spaces.
  const spaces = await db.space.findMany({
    where:   { archivedAt: null, deletedAt: null },
    select:  { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  // Per-space snapshot counts (total + estimated) in two grouped queries.
  const [totalBySpace, estBySpace] = await Promise.all([
    db.spaceSnapshot.groupBy({ by: ["spaceId"], _count: { _all: true } }),
    db.spaceSnapshot.groupBy({ by: ["spaceId"], where: { isEstimated: true }, _count: { _all: true } }),
  ]);
  const totalCount = new Map(totalBySpace.map((g) => [g.spaceId, g._count._all]));
  const estCount = new Map(estBySpace.map((g) => [g.spaceId, g._count._all]));

  const targets: { id: string; name: string; snapshots: number }[] = [];
  let alreadyBackfilled = 0;
  let gatedMultiDay = 0;

  for (const s of spaces) {
    const total = totalCount.get(s.id) ?? 0;
    const est = estCount.get(s.id) ?? 0;
    if (est > 0) { alreadyBackfilled++; continue; }     // already has estimated history
    if (total > 1) { gatedMultiDay++; continue; }        // backfillSpaceSnapshots gate will skip
    targets.push({ id: s.id, name: s.name, snapshots: total });
  }

  console.log(`Snapshot backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  Spaces scanned:            ${spaces.length}`);
  console.log(`  Already backfilled:        ${alreadyBackfilled}`);
  console.log(`  Skipped (multi-day live):  ${gatedMultiDay}`);
  console.log(`  Eligible targets:          ${targets.length}`);
  for (const t of targets) {
    console.log(`    - ${t.name} (${t.id}) — ${t.snapshots} snapshot(s)`);
  }

  if (!APPLY) {
    console.log("\nDry run only — no rows written. Re-run with --apply to backfill these Spaces.");
    return;
  }

  let written = 0;
  let spacesWritten = 0;
  for (const t of targets) {
    const n = await backfillSpaceSnapshots(t.id);
    if (n > 0) { written += n; spacesWritten++; console.log(`    ✓ ${t.name} — ${n} estimated row(s)`); }
    else console.log(`    · ${t.name} — 0 rows (no reconstructable history in window)`);
  }
  console.log(`\nBackfilled ${written} estimated snapshot row(s) across ${spacesWritten} Space(s).`);
}

async function forceMissingEstimatedAll(): Promise<void> {
  console.log("⚠️  FORCE MODE — this BYPASSES the new-Space gate and targets every");
  console.log("    Space without estimated rows, including multi-day live Spaces.");
  console.log("    Existing snapshots are never overwritten; only missing past");
  console.log("    dates are written (today excluded, isEstimated=true).\n");

  const spaces = await db.space.findMany({
    where:   { archivedAt: null, deletedAt: null },
    select:  { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  // Spaces that already have any estimated rows are skipped.
  const estBySpace = await db.spaceSnapshot.groupBy({
    by: ["spaceId"],
    where: { isEstimated: true },
    _count: { _all: true },
  });
  const hasEstimated = new Set(estBySpace.map((g) => g.spaceId));

  const targets = spaces.filter((s) => !hasEstimated.has(s.id));

  console.log(`Force backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  Spaces scanned:                 ${spaces.length}`);
  console.log(`  Skipped (already have estimated): ${spaces.length - targets.length}`);
  console.log(`  Targets (no estimated rows):    ${targets.length}\n`);

  let wouldOrDid = 0;
  let spacesTouched = 0;
  for (const t of targets) {
    // dryRun computes the exact number of missing dates without writing.
    const n = await backfillSpaceSnapshots(t.id, { ignoreNewSpaceGate: true, dryRun: !APPLY });
    if (n > 0) {
      wouldOrDid += n;
      spacesTouched++;
      console.log(`    ${APPLY ? "✓" : "•"} ${t.name} (${t.id}) — ${n} estimated row(s) ${APPLY ? "written" : "would be inserted"}`);
    } else {
      console.log(`    · ${t.name} (${t.id}) — 0 (no reconstructable missing dates)`);
    }
  }

  console.log(`\n${APPLY ? "Wrote" : "Would insert"} ${wouldOrDid} estimated row(s) across ${spacesTouched} Space(s).`);
  if (!APPLY) console.log("Dry run only — no rows written. Re-run with --apply to write.");
}

async function devSeedTargetSpaces30d(): Promise<void> {
  console.log("⚠️  DEV SEED — targeted, local/dev only. For the fixed target Space list");
  console.log("    it bypasses the new-Space gate AND ignores account/link createdAt");
  console.log("    floors so up to 30 days reconstruct. Live rows are never touched;");
  console.log("    only missing dates are inserted (today excluded, isEstimated=true).\n");

  console.log(`Dev seed — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  Target Spaces: ${DEV_SEED_TARGET_SPACE_IDS.length}\n`);

  let totalRows = 0;
  let spacesTouched = 0;

  for (const id of DEV_SEED_TARGET_SPACE_IDS) {
    const space = await db.space.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!space) { console.log(`  ! ${id} — not found, skipped`); continue; }

    // Existing rows for reporting (live vs estimated).
    const rows = await db.spaceSnapshot.findMany({ where: { spaceId: id }, select: { isEstimated: true } });
    const live = rows.filter((r) => !r.isEstimated).length;
    const est = rows.filter((r) => r.isEstimated).length;

    // dryRun returns the exact number of missing dates that WOULD be inserted.
    const n = await backfillSpaceSnapshots(id, {
      ignoreNewSpaceGate: true,
      ignoreFloors:       true,
      dryRun:             !APPLY,
    });

    console.log(`  ${n > 0 ? (APPLY ? "✓" : "•") : "·"} ${space.name} (${id})`);
    console.log(`      live rows: ${live}   estimated rows: ${est}   missing dates ${APPLY ? "written" : "to insert"}: ${n}`);

    if (n > 0) { totalRows += n; spacesTouched++; }
  }

  console.log(`\n${APPLY ? "Wrote" : "Would insert"} ${totalRows} estimated row(s) across ${spacesTouched} target Space(s).`);
  if (!APPLY) console.log("Dry run only — no rows written. Re-run with --apply to write.");
}

function fmtRow(r: { date: Date; cash: number; debt: number; totalAssets: number; netWorth: number; isEstimated: boolean }): string {
  const d = r.date.toISOString().slice(0, 10);
  return `date=${d} cash=${r.cash} debt=${r.debt} totalAssets=${r.totalAssets} netWorth=${r.netWorth} isEstimated=${r.isEstimated}`;
}

async function repairJuly2Christian(): Promise<void> {
  console.log(`Repair July 2 — Christian's Space — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  spaceId=${REPAIR_SPACE_ID}  date=2026-07-02\n`);

  const SELECT = { id: true, date: true, cash: true, debt: true, totalAssets: true, netWorth: true, isEstimated: true };

  // All rows on 2026-07-02 for this Space (should be exactly one).
  const rows = await db.spaceSnapshot.findMany({
    where:  { spaceId: REPAIR_SPACE_ID, date: { gte: REPAIR_DATE_FROM, lt: REPAIR_DATE_TO } },
    select: SELECT,
  });
  if (rows.length === 0) { console.log("  No snapshot row on 2026-07-02 — nothing to repair."); return; }
  console.log("  Rows on 2026-07-02:");
  for (const r of rows) console.log(`    id=${r.id}  ${fmtRow(r)}`);

  const live = rows.filter((r) => !r.isEstimated);
  if (live.length === 0) {
    console.log("\n  No LIVE row on 2026-07-02 — nothing to delete. (This mode NEVER deletes estimated rows.)");
    return;
  }
  if (live.length > 1) {
    console.log(`\n  ⚠ ${live.length} LIVE rows found for 2026-07-02 — ambiguous; aborting for safety.`);
    return;
  }
  const target = live[0];
  console.log(`\n  Target LIVE row to delete: id=${target.id}  cash=${target.cash} (adjacent days ~6438.95)`);

  if (!APPLY) {
    console.log("\n  Dry run only — nothing deleted or written. Re-run with --apply to repair.");
    return;
  }

  // Delete EXACTLY this one row, guarded on id AND isEstimated=false so an
  // estimated row can never be removed here.
  const del = await db.spaceSnapshot.deleteMany({ where: { id: target.id, isEstimated: false } });
  console.log(`\n  Deleted ${del.count} LIVE row (id=${target.id}).`);

  // Recreate July 2. backfillSpaceSnapshots is create-if-absent and skips every
  // date that still has a row, so with only July 2 now missing it writes just
  // that one date as isEstimated=true. Gate bypass + floor bypass ensure July 2
  // is inside the reconstructable window.
  const written = await backfillSpaceSnapshots(REPAIR_SPACE_ID, { ignoreNewSpaceGate: true, ignoreFloors: true });
  console.log(`  Backfill wrote ${written} estimated row(s) (missing dates only).`);

  const repaired = await db.spaceSnapshot.findFirst({
    where:  { spaceId: REPAIR_SPACE_ID, date: { gte: REPAIR_DATE_FROM, lt: REPAIR_DATE_TO } },
    select: SELECT,
  });
  if (repaired) console.log(`\n  Repaired July 2 row: ${fmtRow(repaired)}`);
  else console.log("\n  ⚠ No July 2 row after backfill — reconstruction floored out (no data in window). Investigate.");
}

async function main(): Promise<void> {
  if (REPAIR_JULY2) await repairJuly2Christian();
  else if (ROLLBACK) await rollback();
  else if (DEV_SEED) await devSeedTargetSpaces30d();
  else if (FORCE_ALL) await forceMissingEstimatedAll();
  else await backfill();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());

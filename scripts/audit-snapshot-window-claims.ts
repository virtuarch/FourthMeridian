/**
 * scripts/audit-snapshot-window-claims.ts
 *
 * v2.6-WINDOW-1 — every surface that states a net-worth change must name a
 * window the product DEFINES, and compute it through the canonical authority.
 * READ-ONLY: writes nothing, ever.
 *
 * ── The defect it measures ──────────────────────────────────────────────────
 *
 * `SnapshotSectionData.snapshotCount` is a ROW COUNT. It comes from
 * `getRecentSnapshots(SNAPSHOT_HISTORY_LIMIT)`, whose `days` parameter is used as
 * `take: -days` — a row limit, not a date range. Four surfaces render that count
 * as a number of DAYS:
 *
 *   app/api/brief/route.ts                      "over the last N days"
 *   lib/ai/signals/detectors/snapshot.ts        "Net worth up $X over N days"
 *   lib/ai/prompts/assessment-serializer.ts     "N-day history in 90-day window"
 *   lib/ai/intelligence/.../engines.ts          "N-day span in 90-day window"
 *
 * The count equals the day span only when snapshots are daily AND contiguous.
 * Nothing enforces that, and the trend attached to the claim is measured across
 * whatever those rows happen to span — which is not a window the product defines.
 *
 * Measured on the live corpus at the time this was written:
 *
 *   Brief          "up 14.9% over the last 90 days"   baseline 2026-05-10
 *   Space  1M      "26.8% vs Jul 7, 2026"             baseline 2026-07-07
 *   Space  90d     "47.4% vs May 7, 2026"             baseline 2026-05-07
 *
 * Both the Brief and the Space said "90 days" and differed by a factor of three,
 * because the Brief's baseline was the 90th ROW (89 days back) while the Space's
 * was `subMonths(asOf, 3)` (92 days back) — and a $4,985 debt paydown between
 * May 7 and May 8 sits between them. Same metric, same corpus, two windows, one
 * label. This is the defect v2.6-L4F already fixed for the Space launcher
 * ("25.0% outside vs 49.2% inside"); the Brief was its surviving instance.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *
 * INVARIANT (corpus-independent): a snapshot section's `spanDays` is the true
 * calendar distance between its oldest and newest point, and its `canonicalChange`
 * — when present — is reproducible from those points by the SAME
 * `compareToForPreset` authority the inside-Space selector and the Space launcher
 * use. It also refuses the shape that caused the defect: `spanDays` must never
 * simply equal `snapshotCount` unless the points really are daily and contiguous.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-snapshot-window-claims.ts
 */

// ⚠️ Imports the PURE window module, never `lib/data/snapshots.ts` or the
// assembler: both reach `@/lib/space` → `@/lib/auth` → `server-only`, which only
// Next resolves, so the audit runner (plain `tsx`, no preload) cannot load them.
// This is the same constraint that produced `lib/data/banking-population.ts`.
//
// The assembler half — that `projectSnapshotSection` EMITS these values — is
// pinned on fixtures in lib/ai/assemblers/snapshot-window.test.ts, which needs
// neither a database nor Next. Split so each half is asserted where it can be
// asserted honestly.
import { db } from "@/lib/db";
import { canonicalWindowChange, seriesSpanDays } from "@/lib/data/snapshot-window";

/** The row cap the snapshot assembler applies. Mirrored, not imported. */
const SNAPSHOT_HISTORY_LIMIT = 90;

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

async function main(): Promise<void> {
  console.log(`\n[AUDIT] snapshot window claims — READ-ONLY`);

  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true },
  });

  let measured = 0;
  for (const space of spaces) {
    // The same rows the assembler reads: the last N by date, ascending.
    const rows = await db.spaceSnapshot.findMany({
      where:   { spaceId: space.id },
      orderBy: { date: "asc" },
      take:    -SNAPSHOT_HISTORY_LIMIT,
      select:  { date: true, netWorth: true },
    });
    if (rows.length < 2) continue;
    measured++;

    bar(`${space.name}`);

    const points = rows.map((r) => ({ date: new Date(r.date), value: r.netWorth ?? 0 }));
    const spanDays = seriesSpanDays(points);
    const trueSpan = Math.round(
      (points[points.length - 1].date.getTime() - points[0].date.getTime()) / 86_400_000,
    );

    console.log(`  snapshot ROWS            : ${rows.length}`);
    console.log(`  oldest → newest          : ${points[0].date.toISOString().slice(0, 10)} → ${points[points.length - 1].date.toISOString().slice(0, 10)}`);
    console.log(`  spanDays (CALENDAR)      : ${spanDays}`);

    check(
      "seriesSpanDays is the true calendar distance between the endpoints",
      spanDays === trueSpan,
      `authority says ${spanDays}, the dates say ${trueSpan}`,
    );

    // The shape that caused the defect: a ROW COUNT standing in for a duration.
    // Equal only when the points really are daily and contiguous.
    if (rows.length !== trueSpan + 1) {
      check(
        "the row count is NOT usable as a day span on this corpus",
        rows.length !== spanDays,
        `${rows.length} rows span ${spanDays} days — any surface printing the count as ` +
        `"N days" is off by ${Math.abs(rows.length - spanDays)}`,
      );
    }

    const change = canonicalWindowChange(points, "PAST_MONTH");
    if (change === null) {
      console.log(`  canonicalChange          : (refused — history does not reach a month back)`);
      continue;
    }

    console.log(`  canonicalChange (${change.preset})`);
    console.log(`      window   : ${change.fromDate} → ${change.toDate}`);
    console.log(`      abs/pct  : ${change.abs.toFixed(2)}  ${change.pct === null ? "(refused)" : `${change.pct.toFixed(1)}%`}`);

    // The window opens on a CALENDAR month back from the close, never a row
    // offset. This is the assertion that would have caught the Brief.
    const expectedFrom = new Date(`${change.toDate}T00:00:00Z`);
    expectedFrom.setUTCMonth(expectedFrom.getUTCMonth() - 1);
    check(
      "the window opens at or before one calendar month back from its close",
      change.fromDate <= expectedFrom.toISOString().slice(0, 10),
      `opens ${change.fromDate}, a calendar month back is ${expectedFrom.toISOString().slice(0, 10)}`,
    );

    // The opening point must be a REAL observation at or before that date, never
    // "the oldest row we happen to hold".
    check(
      "the opening value comes from a point at or before the window's opening date",
      points.some((p) => p.date.toISOString().slice(0, 10) <= change.fromDate && p.value === change.fromValue),
      `no point at or before ${change.fromDate} carries ${change.fromValue}`,
    );
  }

  bar("VERDICT");
  console.log(`  Spaces measured: ${measured}`);
  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} window claim(s) do not hold.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[AUDIT] PASSED — every stated window is a defined one. ✓\n`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });

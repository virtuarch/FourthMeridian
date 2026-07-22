/**
 * lib/prices/backfill-core.test.ts
 *
 * A8-3A — pure backfill-planning tests. Standalone tsx script:
 *
 *     npx tsx lib/prices/backfill-core.test.ts
 *
 * Covers window resolution (defensible bound + resume-from-covered),
 * chunking/pagination, and daily missing-date selection — no DB, no network.
 */

import { resolveBackfillWindow, resolveForceBackfillWindows, chunkWindow, selectInstrumentsMissingDate } from "./backfill-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  // ── 1. resolveBackfillWindow ──────────────────────────────────────────────
  console.log("1. resolveBackfillWindow");
  {
    // No coverage yet → from = earliest activity.
    const w = resolveBackfillWindow("2026-01-01", null, "2026-06-09");
    check("fresh instrument → [earliestActivity, yesterday]", w?.fromISO === "2026-01-01" && w?.toISO === "2026-06-09");
    // Resume: covered through 05-01 → from = 05-02 (missing-only, resumable).
    const r = resolveBackfillWindow("2026-01-01", "2026-05-01", "2026-06-09");
    check("resume from day after latest covered", r?.fromISO === "2026-05-02" && r?.toISO === "2026-06-09");
    // Fully covered through yesterday → null (re-run fetches nothing).
    check("fully covered → null", resolveBackfillWindow("2026-01-01", "2026-06-09", "2026-06-09") === null);
    // Covered date after activity but window past 'to' → null.
    check("covered beyond target → null", resolveBackfillWindow("2026-01-01", "2026-06-20", "2026-06-09") === null);
    // No activity → null (never backfill an unused instrument).
    check("no activity → null (no arbitrary history)", resolveBackfillWindow(null, null, "2026-06-09") === null);
    // Latest covered earlier than activity → clamp to activity.
    const c = resolveBackfillWindow("2026-03-01", "2026-01-15", "2026-06-09");
    check("resume never precedes earliest activity", c?.fromISO === "2026-03-01");
  }

  // ── 1b. resolveForceBackfillWindows (A9 force-backfill, 2026-07-15 fix) ───
  console.log("1b. resolveForceBackfillWindows");
  {
    // No coverage at all → the whole forced span, unchanged from today's behavior.
    const fresh = resolveForceBackfillWindows("2024-07-14", "2026-07-13", null, null);
    check("no coverage → single window spanning the whole force range",
      JSON.stringify(fresh) === JSON.stringify([{ fromISO: "2024-07-14", toISO: "2026-07-13" }]));

    // The actual bug: daily-cron front-edge coverage exists (2026-06-12..2026-07-13).
    // The OLD resolveBackfillWindow(forceFrom, latestCovered, forceTo) collapsed to
    // null here (dayAfter(2026-07-13) > 2026-07-13). The fix must instead return the
    // gap BEHIND that block.
    const behind = resolveForceBackfillWindows("2024-07-14", "2026-07-13", "2026-06-12", "2026-07-13");
    check("front-edge coverage exists → returns the OLDER gap, not null/empty", behind.length === 1);
    check("older gap runs up to the day before earliest covered",
      behind[0]?.fromISO === "2024-07-14" && behind[0]?.toISO === "2026-06-11");

    // Symmetric case: coverage exists only for an OLDER block; force range extends
    // past it into the present → returns the NEWER gap.
    const ahead = resolveForceBackfillWindows("2024-07-14", "2026-07-13", "2024-07-14", "2024-08-01");
    check("existing coverage precedes force range's tail → returns the NEWER gap", ahead.length === 1);
    check("newer gap starts the day after latest covered",
      ahead[0]?.fromISO === "2024-08-02" && ahead[0]?.toISO === "2026-07-13");

    // Coverage sits in the middle of the force range → BOTH gaps returned.
    const both = resolveForceBackfillWindows("2024-07-14", "2026-07-13", "2025-01-01", "2025-06-01");
    check("coverage in the middle → both older and newer gaps returned", both.length === 2);
    check("older gap correct", both[0]?.fromISO === "2024-07-14" && both[0]?.toISO === "2024-12-31");
    check("newer gap correct", both[1]?.fromISO === "2025-06-02" && both[1]?.toISO === "2026-07-13");

    // Force range fully inside existing coverage → no gaps at all.
    const covered = resolveForceBackfillWindows("2026-06-15", "2026-06-20", "2026-06-01", "2026-07-01");
    check("force range fully covered → no windows", covered.length === 0);

    // Invalid range → no windows (defensive, matches resolveBackfillWindow's null).
    check("forceFrom > forceTo → no windows", resolveForceBackfillWindows("2026-06-20", "2026-06-01", null, null).length === 0);
  }

  // ── 2. chunkWindow (batched/paginated) ────────────────────────────────────
  console.log("2. chunkWindow");
  {
    const chunks = chunkWindow("2026-01-01", "2026-01-10", 4);
    check("splits into ceil(N/maxDays) chunks",
      JSON.stringify(chunks) === JSON.stringify([
        { fromISO: "2026-01-01", toISO: "2026-01-04" },
        { fromISO: "2026-01-05", toISO: "2026-01-08" },
        { fromISO: "2026-01-09", toISO: "2026-01-10" },
      ]));
    check("chunks are contiguous and non-overlapping (day-after boundaries)",
      chunks.every((c, i) => i === 0 || c.fromISO > chunks[i - 1].toISO));
    check("single-day window → one chunk", JSON.stringify(chunkWindow("2026-01-01", "2026-01-01", 30)) === JSON.stringify([{ fromISO: "2026-01-01", toISO: "2026-01-01" }]));
    check("window smaller than maxDays → one chunk", chunkWindow("2026-01-01", "2026-01-05", 30).length === 1);
    check("from > to → no chunks", chunkWindow("2026-02-01", "2026-01-01", 30).length === 0);
    let threw = false;
    try { chunkWindow("2026-01-01", "2026-01-10", 0); } catch { threw = true; }
    check("maxDays <= 0 throws (programmer error)", threw);
  }

  // ── 3. selectInstrumentsMissingDate (daily job list) ──────────────────────
  console.log("3. selectInstrumentsMissingDate");
  {
    const covered = new Map<string, Set<string>>([
      ["i1", new Set(["2026-06-09"])],       // has yesterday → not missing
      ["i2", new Set(["2026-06-08"])],       // has an older date only → missing yesterday
      // i3 absent entirely → never priced → missing
    ]);
    const missing = selectInstrumentsMissingDate(["i3", "i1", "i2"], covered, "2026-06-09");
    check("returns only instruments missing the target date, sorted", JSON.stringify(missing) === JSON.stringify(["i2", "i3"]));
    // Full coverage → empty (daily job no-op).
    const full = new Map<string, Set<string>>([["i1", new Set(["2026-06-09"])], ["i2", new Set(["2026-06-09"])]]);
    check("complete coverage → empty list (daily job no-op)", selectInstrumentsMissingDate(["i1", "i2"], full, "2026-06-09").length === 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll backfill-core checks passed.");
  process.exit(0);
}

main();

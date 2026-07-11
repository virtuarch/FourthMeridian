/**
 * lib/perspectives/time-range.test.ts
 *
 * Pure tests for the shared Perspective shell's time-range resolver. Deterministic
 * (all dates injected — no ambient clock):
 *
 *   npx tsx lib/perspectives/time-range.test.ts
 *
 * Covers default state, every to-date and rolling preset, calendar clamping, the
 * As Of-shift recompute, preset inference (match / CUSTOM), and ALL coverage.
 */

import {
  resolvePerspectiveTimeRange,
  inferPerspectiveTimePreset,
  defaultPerspectiveTimeState,
  compareToForPreset,
  startOfWeek,
  subMonths,
  subYears,
} from "./time-range";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Injected "today" so the suite never reads the real clock.
const TODAY = "2026-07-12"; // a Sunday
const resolve = (preset: Parameters<typeof resolvePerspectiveTimeRange>[0]["preset"], asOf = TODAY, coverageFrom: string | null = null) =>
  resolvePerspectiveTimeRange({ preset, asOf, coverageFrom });

console.log("Default shell state");
{
  const d = defaultPerspectiveTimeState(TODAY);
  check("1. default preset is MTD", d.preset === "MTD");
  check("2. default As Of is the injected today", d.asOf === TODAY);
  check("3. default Compare To is the first of that month", d.compareTo === "2026-07-01");
}

console.log("To-date presets set the correct period start");
{
  check("4. WTD → start of week containing As Of", resolve("WTD").compareTo === startOfWeek(TODAY));
  check("5. MTD → first day of the month", resolve("MTD").compareTo === "2026-07-01");
  check("6. QTD → first day of the quarter (Q3 → Jul 1)", resolve("QTD").compareTo === "2026-07-01");
  check("6b. QTD for a May date → Apr 1", resolve("QTD", "2026-05-20").compareTo === "2026-04-01");
  check("7. YTD → January 1 of the year", resolve("YTD").compareTo === "2026-01-01");
}

console.log("Rolling presets use calendar arithmetic (not fixed day counts)");
{
  check("8. 1W (PAST_WEEK) subtracts one week", resolve("PAST_WEEK").compareTo === "2026-07-05");
  check("9. 1M (PAST_MONTH) subtracts one calendar month", resolve("PAST_MONTH").compareTo === "2026-06-12");
  check("10. 3M (PAST_QUARTER) subtracts three calendar months", resolve("PAST_QUARTER").compareTo === "2026-04-12");
  check("11/12. 1Y (PAST_YEAR) subtracts one calendar year", resolve("PAST_YEAR").compareTo === "2025-07-12");
}

console.log("Month-end and leap-year clamping");
{
  check("13a. Mar 31 − 1 month clamps to Feb 28 (2026 non-leap)", subMonths("2026-03-31", 1) === "2026-02-28");
  check("13b. Mar 31 − 1 month clamps to Feb 29 (2028 leap)", subMonths("2028-03-31", 1) === "2028-02-29");
  check("13c. Feb 29 − 1 year clamps to Feb 28 (leap → non-leap)", subYears("2028-02-29", 1) === "2027-02-28");
  check("13d. Jul 31 − 3 months → Apr 30 (clamped)", subMonths("2026-07-31", 3) === "2026-04-30");
}

console.log("Changing As Of under an active preset recomputes Compare To");
{
  check("14. As Of shift under MTD recomputes the month start",
    resolve("MTD", "2026-05-20").compareTo === "2026-05-01");
  check("15. As Of shift under 1M recomputes one calendar month back",
    resolve("PAST_MONTH", "2026-05-20").compareTo === "2026-04-20");
}

console.log("Inference from a manual date pair (exact match only)");
{
  const infer = (asOf: string, compareTo: string | null, coverageFrom: string | null = null) =>
    inferPerspectiveTimePreset({ asOf, compareTo, coverageFrom });
  check("16a. As Of Jul 12 + Compare To Jul 1 → MTD", infer("2026-07-12", "2026-07-01") === "MTD");
  check("16b. As Of Jul 12 + Compare To Jan 1 → YTD", infer("2026-07-12", "2026-01-01") === "YTD");
  check("16c. As Of Jul 12 + Compare To Jun 12 → 1M", infer("2026-07-12", "2026-06-12") === "PAST_MONTH");
  check("16d. As Of Jul 12 + Compare To Jul 5 → 1W", infer("2026-07-12", "2026-07-05") === "PAST_WEEK");
  check("17a. An incompatible pair → CUSTOM", infer("2026-07-12", "2026-06-30") === "CUSTOM");
  check("17b. No comparison date → CUSTOM", infer("2026-07-12", null) === "CUSTOM");
}

console.log("ALL uses real coverageFrom, never fabricates");
{
  check("18. ALL → coverageFrom when available", resolve("ALL", TODAY, "2025-03-04").compareTo === "2025-03-04");
  check("19. ALL → null when no coverage (no fabricated start)", resolve("ALL", TODAY, null).compareTo === null);
  check("18b. inference recognizes ALL from coverageFrom",
    inferPerspectiveTimePreset({ asOf: TODAY, compareTo: "2025-03-04", coverageFrom: "2025-03-04" }) === "ALL");
}

console.log("Round-trip: resolve then infer yields a consistent preset (same date pair)");
{
  // Identity isn't guaranteed when two presets genuinely coincide (e.g. in the
  // first month of a quarter, MTD == QTD); deterministic priority then picks one.
  // The invariant is that the inferred preset reproduces the SAME Compare To.
  const consistent = (["WTD", "MTD", "QTD", "YTD", "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_YEAR"] as const)
    .every((p) => {
      const compareTo = compareToForPreset(p, TODAY, null);
      const inferred = inferPerspectiveTimePreset({ asOf: TODAY, compareTo, coverageFrom: null });
      return inferred !== "CUSTOM" && compareToForPreset(inferred, TODAY, null) === compareTo;
    });
  check("resolve→infer reproduces the same date pair for every preset", consistent);
  // And the genuinely-coincident case resolves deterministically (MTD over QTD).
  check("MTD/QTD coincidence in a quarter's first month picks MTD deterministically",
    inferPerspectiveTimePreset({ asOf: "2026-07-12", compareTo: "2026-07-01", coverageFrom: null }) === "MTD");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll time-range checks passed");

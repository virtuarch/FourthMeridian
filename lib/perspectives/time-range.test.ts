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
  clampAsOf,
  isValidYmd,
  mapPresetToCashFlowPeriod,
  shellTimeReducer,
  serializeShellTimeState,
  hydrateShellTimeState,
  type PerspectiveTimeState,
  type TimePreset,
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

console.log("Rolling 6M (PAST_6_MONTHS) preset");
{
  check("6M subtracts six calendar months", compareToForPreset("PAST_6_MONTHS", TODAY, null) === "2026-01-12");
  check("6M clamps end-of-month (Aug 31 − 6M → Feb 28)", compareToForPreset("PAST_6_MONTHS", "2026-08-31", null) === "2026-02-28");
  check("6M round-trips through inference", inferPerspectiveTimePreset({ asOf: TODAY, compareTo: "2026-01-12", coverageFrom: null }) === "PAST_6_MONTHS");
}

console.log("clampAsOf + isValidYmd");
{
  check("valid past date passes through", clampAsOf("2026-06-01", TODAY) === "2026-06-01");
  check("future date clamps to today", clampAsOf("2027-01-01", TODAY) === TODAY);
  check("invalid date falls back to today", clampAsOf("2026-02-30", TODAY) === TODAY);
  check("isValidYmd rejects impossible calendar days", !isValidYmd("2026-02-30") && !isValidYmd("nope") && isValidYmd("2028-02-29"));
}

console.log("mapPresetToCashFlowPeriod (identity + CUSTOM→last)");
{
  check("relative presets map to themselves", mapPresetToCashFlowPeriod("MTD", "ALL") === "MTD" && mapPresetToCashFlowPeriod("PAST_6_MONTHS", "MTD") === "PAST_6_MONTHS");
  check("CUSTOM holds the last period", mapPresetToCashFlowPeriod("CUSTOM", "PAST_QUARTER") === "PAST_QUARTER");
}

console.log("shellTimeReducer — the §3.3 transition table");
{
  const ctx = { today: TODAY, coverageFrom: "2025-03-04" };
  const start: PerspectiveTimeState = defaultPerspectiveTimeState(TODAY); // MTD / today / Jul 1
  const invariantHolds = (s: PerspectiveTimeState) =>
    s.preset === "CUSTOM" || s.compareTo === compareToForPreset(s.preset, s.asOf, ctx.coverageFrom);

  const ytd = shellTimeReducer(start, { type: "selectPreset", preset: "YTD" }, ctx);
  check("selectPreset YTD → Compare To Jan 1, As Of unchanged", ytd.preset === "YTD" && ytd.compareTo === "2026-01-01" && ytd.asOf === TODAY && invariantHolds(ytd));

  const movedAsOf = shellTimeReducer(ytd, { type: "setAsOf", asOf: "2025-05-20" }, ctx);
  check("setAsOf under YTD recomputes to Jan 1 of the new year", movedAsOf.compareTo === "2025-01-01" && movedAsOf.preset === "YTD" && invariantHolds(movedAsOf));

  const clampedAsOf = shellTimeReducer(start, { type: "setAsOf", asOf: "2030-01-01" }, ctx);
  check("setAsOf future clamps to today", clampedAsOf.asOf === TODAY);

  const custom = shellTimeReducer(start, { type: "setCompareTo", compareTo: "2026-06-30" }, ctx);
  check("setCompareTo to a non-preset date → CUSTOM (no highlight)", custom.preset === "CUSTOM" && custom.compareTo === "2026-06-30");

  const snapped = shellTimeReducer(custom, { type: "setCompareTo", compareTo: "2026-01-01" }, ctx);
  check("setCompareTo to Jan 1 snaps to YTD", snapped.preset === "YTD" && invariantHolds(snapped));

  const cleared = shellTimeReducer(ytd, { type: "clearCompareTo" }, ctx);
  check("clearCompareTo → CUSTOM, compareTo null", cleared.preset === "CUSTOM" && cleared.compareTo === null);

  const swapNoop = shellTimeReducer(cleared, { type: "swap" }, ctx);
  check("swap with null Compare To is a no-op", swapNoop === cleared);

  const swapped = shellTimeReducer(ytd, { type: "swap" }, ctx);
  check("swap exchanges the dates and re-infers", swapped.asOf === "2026-01-01" && swapped.compareTo === TODAY && invariantHolds(swapped));

  const all = shellTimeReducer(start, { type: "selectPreset", preset: "ALL" }, ctx);
  check("ALL uses the real coverageFrom", all.preset === "ALL" && all.compareTo === "2025-03-04" && invariantHolds(all));
  const allNoCoverage = shellTimeReducer(start, { type: "selectPreset", preset: "ALL" }, { today: TODAY, coverageFrom: null });
  check("ALL with no coverage keeps Compare To null (no fabrication)", allNoCoverage.compareTo === null);

  // Ambiguity: on Mar 31, Q1 start (Jan 1) coincides with the year start, so the
  // pair (Mar 31, Jan 1) matches both QTD and YTD — the ACTIVE preset wins.
  const mar31Ctx = { today: "2026-03-31", coverageFrom: null };
  const mar31Q = shellTimeReducer(defaultPerspectiveTimeState("2026-03-31"), { type: "selectPreset", preset: "QTD" }, mar31Ctx);
  const stillQ = shellTimeReducer(mar31Q, { type: "setCompareTo", compareTo: "2026-01-01" }, mar31Ctx);
  check("active QTD is preferred over YTD on the coincident boundary", mar31Q.preset === "QTD" && mar31Q.compareTo === "2026-01-01" && stillQ.preset === "QTD");
  // From YTD, the same pair infers YTD first (display order), confirming both are valid.
  const fromYtd = shellTimeReducer({ preset: "YTD", asOf: "2026-03-31", compareTo: "2026-01-01" }, { type: "setCompareTo", compareTo: "2026-01-01" }, mar31Ctx);
  check("active YTD is preferred over QTD on the same boundary", fromYtd.preset === "YTD");
}

console.log("URL serialize/hydrate round-trip + invalid fallback");
{
  const ctx = { today: TODAY, coverageFrom: "2025-03-04" };
  const roundtrip = (s: PerspectiveTimeState) => hydrateShellTimeState(serializeShellTimeState(s), ctx);
  const cases: PerspectiveTimeState[] = [
    defaultPerspectiveTimeState(TODAY),
    resolvePerspectiveTimeRange({ preset: "YTD", asOf: TODAY, coverageFrom: ctx.coverageFrom }),
    resolvePerspectiveTimeRange({ preset: "ALL", asOf: TODAY, coverageFrom: ctx.coverageFrom }),
    { preset: "CUSTOM", asOf: TODAY, compareTo: "2026-06-30" },
    { preset: "CUSTOM", asOf: TODAY, compareTo: null },
  ];
  check("serialize → hydrate is identity for every canonical state",
    cases.every((s) => JSON.stringify(roundtrip(s)) === JSON.stringify(s)));
  const fallback = hydrateShellTimeState({ asOf: "2030-13-40", preset: "bogus", compareTo: "x" }, ctx);
  check("invalid/future params fall back to the default MTD state",
    JSON.stringify(fallback) === JSON.stringify(defaultPerspectiveTimeState(TODAY)));
  const futureAsOf = hydrateShellTimeState({ asOf: "2099-01-01", preset: "MTD" }, ctx);
  check("a future As Of clamps to today on hydrate", futureAsOf.asOf === TODAY);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll time-range checks passed");

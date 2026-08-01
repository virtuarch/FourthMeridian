/**
 * components/space/widgets/charts/trend-runs.core.test.ts
 *
 * V26-INVESTMENTS-HISTORY — chart honesty at evidence boundaries.
 *
 * The regression pinned here is the Investments chart's June/July seam. Everything
 * before the first connect is RECONSTRUCTED; from the connect date on it is
 * OBSERVED. The step between the last reconstructed value and the first observed
 * one is a change of measurement, not a change in the portfolio — and the chart
 * used to draw it as market movement.
 *
 * Invariants:
 *   - a run NEVER spans a basis change (no stroke between two differently
 *     measured values);
 *   - every adjacent basis change is reported as a seam so the break can be DRAWN;
 *   - a boundary that is also a date hole yields the hole only — the two marks
 *     never stack;
 *   - no point is dropped, reordered, resampled or interpolated by any of it.
 *
 * Standalone tsx script:  npx tsx components/space/widgets/charts/trend-runs.core.test.ts
 */

import {
  basisOf, medianSpacingDays, toRuns, toDateGaps, toBasisSeams, DAY_MS,
  type TrendGeomPoint,
} from "./trend-runs.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const t = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
function pt(date: string, value: number, estimated: boolean): TrendGeomPoint {
  return { date, t: t(date), value, estimated };
}

/**
 * The real shape of the incident window: a reconstructed run that sags to ~1.6k,
 * then the connect date where observation begins at ~5.1k, then the observed/
 * estimated flapping that follows when the provider syncs on some days only.
 */
const INCIDENT: TrendGeomPoint[] = [
  pt("2026-07-16", 1586.68, true),
  pt("2026-07-17", 1565.62, true),
  pt("2026-07-18", 1565.62, true),
  pt("2026-07-19", 5069.02, false), // ← connect: reconstructed → observed
  pt("2026-07-20", 5082.62, false),
  pt("2026-07-21", 5262.50, false),
  pt("2026-07-22", 5265.16, false),
  pt("2026-07-23", 5265.16, true),  // ← observed → reconstructed (no sync)
  pt("2026-07-24", 5265.16, true),
  pt("2026-07-25", 5265.16, true),
  pt("2026-07-26", 5265.16, true),
  pt("2026-07-27", 4966.20, false), // ← reconstructed → observed
  pt("2026-07-28", 4966.20, true),  // ← observed → reconstructed
  pt("2026-07-29", 4966.20, true),
  pt("2026-07-30", 4966.20, true),
  pt("2026-07-31", 4843.24, false), // ← reconstructed → observed
  pt("2026-08-01", 4843.39, false),
];
const GAP_DAYS = Math.max(medianSpacingDays(INCIDENT.map((p) => p.t)) * 3,
                          medianSpacingDays(INCIDENT.map((p) => p.t)) + 2);

function main(): void {
  // ── 1. Basis identity ─────────────────────────────────────────────────────
  console.log("1. Basis identity");
  check("estimated ⇒ reconstructed", basisOf({ estimated: true }) === "reconstructed");
  check("not estimated ⇒ observed", basisOf({ estimated: false }) === "observed");

  // ── 2. No run may span a basis change ─────────────────────────────────────
  console.log("2. A run never bridges two differently-measured values");
  {
    const runs = toRuns(INCIDENT, GAP_DAYS);
    check("every run is internally single-basis",
      runs.every((r) => r.points.every((p) => basisOf(p) === r.basis)));
    check("no run contains both the last reconstructed and the first observed point",
      !runs.some((r) => r.points.some((p) => p.date === "2026-07-18") &&
                        r.points.some((p) => p.date === "2026-07-19")));
    check("the connect step is NOT inside any single run (no false bridge)",
      runs.every((r) => {
        const ds = r.points.map((p) => p.date);
        return !(ds.includes("2026-07-18") && ds.includes("2026-07-19"));
      }));
  }

  // ── 3. Every basis change is reported so it can be drawn ──────────────────
  console.log("3. Every adjacent basis change surfaces as a seam");
  {
    const seams = toBasisSeams(INCIDENT, GAP_DAYS);
    const at = seams.map((s) => s.toDate);
    check("the connect date is a seam", at.includes("2026-07-19"));
    check("finds all five basis flips in the window", seams.length === 5, `found ${seams.length}: ${at.join(", ")}`);
    check("seams are exactly the flips", JSON.stringify(at) ===
      JSON.stringify(["2026-07-19", "2026-07-23", "2026-07-27", "2026-07-28", "2026-07-31"]));
    check("the connect seam runs reconstructed → observed",
      seams[0].fromBasis === "reconstructed" && seams[0].toBasis === "observed");
    check("each seam names both sides", seams.every((s) => s.fromDate < s.toDate));
    check("each seam separates ADJACENT points only",
      seams.every((s) => s.toIndex === s.fromIndex + 1));
    check("run count is seams + gaps + 1 — one break per reported boundary",
      toRuns(INCIDENT, GAP_DAYS).length === seams.length + toDateGaps(INCIDENT, GAP_DAYS).length + 1);
  }

  // ── 4. A seam is not a gap ────────────────────────────────────────────────
  console.log("4. A basis seam and a date hole are different claims");
  {
    check("the incident window has no date holes", toDateGaps(INCIDENT, GAP_DAYS).length === 0);

    // The gap scale is derived from the MEDIAN spacing, so a hole only exists
    // relative to a series that is otherwise regular — hence the daily run before
    // each jump. (A bare two-point fixture cannot express a hole at all: its one
    // spacing IS the median.)
    const gapScale = (ps: TrendGeomPoint[]) =>
      Math.max(medianSpacingDays(ps.map((p) => p.t)) * 3, medianSpacingDays(ps.map((p) => p.t)) + 2);

    // Same basis on both sides, but two months apart ⇒ a hole, never a seam.
    const holed = [
      pt("2026-01-01", 100, true), pt("2026-01-02", 110, true), pt("2026-01-03", 120, true),
      pt("2026-03-01", 400, true),
    ];
    check("a same-basis hole is a gap", toDateGaps(holed, gapScale(holed)).length === 1);
    check("a same-basis hole is NOT a seam", toBasisSeams(holed, gapScale(holed)).length === 0);

    // A hole AND a basis change on the same boundary ⇒ the hole only.
    const both = [
      pt("2026-01-01", 100, true), pt("2026-01-02", 110, true), pt("2026-01-03", 120, true),
      pt("2026-03-01", 400, false),
    ];
    check("a boundary that is both reports the hole", toDateGaps(both, gapScale(both)).length === 1);
    check("a boundary that is both does NOT also report a seam — marks never stack",
      toBasisSeams(both, gapScale(both)).length === 0);
    check("the run is still broken there", toRuns(both, gapScale(both)).length === 2);
  }

  // ── 5. Nothing is invented, dropped, moved or smoothed ────────────────────
  console.log("5. Values and provenance survive untouched");
  {
    const runs = toRuns(INCIDENT, GAP_DAYS);
    const flat = runs.flatMap((r) => r.points);
    check("every input point appears exactly once", flat.length === INCIDENT.length);
    check("in the original order", flat.every((p, i) => p.date === INCIDENT[i].date));
    check("with its original value — no interpolation or smoothing",
      flat.every((p, i) => p.value === INCIDENT[i].value));
    check("with its original provenance bit",
      flat.every((p, i) => p.estimated === INCIDENT[i].estimated));
    check("no synthetic point was inserted at any seam",
      !flat.some((p) => !INCIDENT.some((q) => q.date === p.date)));
    check("the input array is not mutated",
      INCIDENT[3].date === "2026-07-19" && INCIDENT[3].value === 5069.02 && INCIDENT[3].estimated === false);
  }

  // ── 6. Degenerate inputs ──────────────────────────────────────────────────
  console.log("6. Degenerate inputs stay safe");
  check("empty series → no runs", toRuns([], 3).length === 0);
  check("empty series → no seams", toBasisSeams([], 3).length === 0);
  check("empty series → no gaps", toDateGaps([], 3).length === 0);
  {
    const one = [pt("2026-07-19", 5069.02, false)];
    check("single point → one run, no seam", toRuns(one, 3).length === 1 && toBasisSeams(one, 3).length === 0);
  }
  {
    const allObs = [pt("2026-07-19", 1, false), pt("2026-07-20", 2, false), pt("2026-07-21", 3, false)];
    check("an all-observed series has no seams — the mark never appears without cause",
      toBasisSeams(allObs, 3).length === 0 && toRuns(allObs, 3).length === 1);
  }
  {
    const allRec = [pt("2026-07-19", 1, true), pt("2026-07-20", 2, true), pt("2026-07-21", 3, true)];
    check("an all-reconstructed series has no seams either",
      toBasisSeams(allRec, 3).length === 0 && toRuns(allRec, 3).length === 1);
  }
  check("median spacing of a single time is 1", medianSpacingDays([t("2026-07-19")]) === 1);
  check("median spacing of daily points is 1", medianSpacingDays(INCIDENT.map((p) => p.t)) === 1);
  check("DAY_MS is a day", DAY_MS === 24 * 60 * 60 * 1000);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll trend-run boundary guards passed.");
  process.exit(0);
}

main();

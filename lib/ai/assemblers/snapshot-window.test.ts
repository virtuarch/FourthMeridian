/**
 * lib/ai/assemblers/snapshot-window.test.ts
 *
 * v2.6-WINDOW-1 — the snapshot section states a window the product DEFINES.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `snapshotCount` is a ROW COUNT: `getRecentSnapshots` uses its `days` parameter
 * as `take: -days`. Four surfaces rendered it as a number of DAYS, and the
 * trend beside it spanned oldest→newest of whatever rows were fetched — a real
 * number over an ACCIDENTAL window.
 *
 * Measured on the live corpus:
 *
 *   Daily Brief    "up 14.9% over the last 90 days"   baseline 2026-05-10
 *   Space  1M      "26.8% vs Jul 7, 2026"             baseline 2026-07-07
 *   Space  90d     "47.4% vs May 7, 2026"             baseline 2026-05-07
 *
 * The Brief's baseline was the 90th ROW — 89 days back — while the Space's was
 * `subMonths(asOf, 3)`, 92 days back, and a $4,985 debt paydown between May 7
 * and May 8 sat between the two. Both screens said "90 days" and differed by a
 * factor of three.
 *
 * ── Why fixtures rather than a corpus ───────────────────────────────────────
 *
 * `scripts/audit-snapshot-window-claims.ts` measures the corpus but cannot load
 * the assembler (its import graph reaches `server-only`). This half — that
 * `projectSnapshotSection` EMITS a true span and a canonical change — is a
 * property of a pure function, so it belongs on fixtures where it runs in CI
 * with no database and cannot pass vacuously on a thin seed.
 *
 * ⚠️ The cadence fixture is the one that matters. On a daily contiguous series
 * the row count and the day span nearly coincide, which is exactly why the
 * defect survived so long. A weekly series makes them disagree by a factor of
 * seven, and that is what these assertions pin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import type { Snapshot } from "@/types";

/** A minimal usable snapshot row. Only the fields the projection reads. */
function snap(dateIso: string, netWorth: number): Snapshot {
  return {
    date: dateIso,
    netWorth,
    totalAssets: netWorth,
    totalDebt: 0,
    totalCash: 0,
    totalSavings: 0,
    totalInvestments: 0,
    totalCrypto: 0,
    total: netWorth,
    cashOnHand: 0,
    netLiquid: 0,
    fxMiss: false,
    isEstimated: false,
  } as unknown as Snapshot;
}

/** N points, `stepDays` apart, ending on `endIso`. */
function series(endIso: string, count: number, stepDays: number, from: number, to: number): Snapshot[] {
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  const out: Snapshot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end - i * stepDays * 86_400_000).toISOString().slice(0, 10);
    const t = count === 1 ? 1 : (count - 1 - i) / (count - 1);
    out.push(snap(d, from + (to - from) * t));
  }
  return out;
}

test("WINDOW-1: spanDays is the calendar distance, NOT the row count", () => {
  // 13 WEEKLY points: 13 rows, 84 days. A surface printing the count would say
  // "13 days" about three months of history — or, in the shape that shipped,
  // "90 days" about 89.
  const weekly = projectSnapshotSection(series("2026-08-07", 13, 7, 20_000, 28_000), "full");
  assert.ok(weekly);
  assert.equal(weekly.snapshotCount, 13, "13 rows");
  assert.equal(
    weekly.spanDays, 84,
    "spanDays must be the calendar distance between the endpoints, not the number of rows",
  );
  assert.notEqual(
    weekly.spanDays, weekly.snapshotCount,
    "a weekly series is exactly the case where count and span diverge — if these are " +
    "equal, spanDays is being derived from the count again",
  );
});

test("WINDOW-1: the canonical change opens a CALENDAR month back, not a row offset", () => {
  // Daily series across a month boundary. The canonical window must open on
  // 2026-07-07 (subMonths), whatever row that happens to be.
  const daily = projectSnapshotSection(series("2026-08-07", 90, 1, 10_000, 28_000), "full");
  assert.ok(daily);
  assert.ok(daily.canonicalChange, "a 90-day daily series reaches back one month");
  assert.equal(daily.canonicalChange.fromDate, "2026-07-07");
  assert.equal(daily.canonicalChange.toDate, "2026-08-07");
  assert.equal(daily.canonicalChange.preset, "PAST_MONTH");

  // The change is measured between those two points — not oldest→newest.
  assert.notEqual(
    daily.canonicalChange.abs, daily.netWorthTrend,
    "canonicalChange must not equal the oldest→newest trend: that is the accidental " +
    "window it exists to replace",
  );
  assert.equal(
    daily.canonicalChange.toValue - daily.canonicalChange.fromValue,
    daily.canonicalChange.abs,
  );
});

test("WINDOW-1: a history shorter than the window is REFUSED, not approximated", () => {
  // Ten days of history cannot support a one-month claim. The authority must
  // return null rather than comparing against the earliest point it holds —
  // which is precisely how an accidental window gets presented as a real one.
  const short = projectSnapshotSection(series("2026-08-07", 10, 1, 27_000, 28_000), "full");
  assert.ok(short);
  assert.equal(
    short.canonicalChange, null,
    "history that does not reach the window must refuse, never fall back to oldest→newest",
  );
  // The accidental trend still exists for anything that legitimately wants
  // "across the data we hold" — it simply must not be labelled a window.
  assert.ok(short.netWorthTrend !== null);
  assert.equal(short.spanDays, 9);
});

test("WINDOW-1: an unassertable endpoint does not silently become a window", () => {
  // A single point cannot produce a change of any kind.
  const one = projectSnapshotSection([snap("2026-08-07", 28_000)], "full");
  assert.ok(one);
  assert.equal(one.spanDays, 0);
  assert.equal(one.netWorthTrend, null);
  assert.equal(one.canonicalChange, null);
});

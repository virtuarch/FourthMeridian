/**
 * components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.test.ts
 *
 * Fixture tests for the Transactions calendar's pure day-bucketing (§2.4 / plan
 * §7). Net-per-day sums, in/out breakdown, the loaded-range derivation, and the
 * zero-vs-unavailable contract (§9.6). Pure, DB-free.
 *
 *   npx tsx --test components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Transaction } from "@/types";
import {
  bucketNetByDay,
  bucketInOutByDay,
  transactionsDateRange,
} from "./TransactionsCalendarHeatmap";

// Minimal rows — the pure functions read only `date` + the amount accessor.
const row = (date: string, amount: number): Transaction =>
  ({ date, amount } as unknown as Transaction);

const amountOf = (t: Transaction) => t.amount;

const FIXTURE: Transaction[] = [
  row("2026-06-02", 100),   // day A: +100
  row("2026-06-02", -30),   //        −30  → net 70
  row("2026-06-05", -50),   // day B: −50
  row("2026-06-09", 20),    // day C: +20
  row("2026-06-09", -20),   //        −20  → net 0 (zero, but activity present)
  row("2026-07-01", 200),   // day D (next month): +200
];

test("bucketNetByDay: signed net per day, accumulates multiple rows", () => {
  const net = bucketNetByDay(FIXTURE, amountOf);
  assert.equal(net.get("2026-06-02"), 70);
  assert.equal(net.get("2026-06-05"), -50);
  assert.equal(net.get("2026-06-09"), 0);   // present, net zero (not the same as absent)
  assert.equal(net.get("2026-07-01"), 200);
  // Matches an independent per-day reduce for every day.
  const days = [...new Set(FIXTURE.map((t) => t.date))];
  for (const d of days) {
    const manual = FIXTURE.filter((t) => t.date === d).reduce((s, t) => s + t.amount, 0);
    assert.equal(net.get(d), manual, `day ${d}`);
  }
});

test("bucketInOutByDay: money-in and money-out magnitudes split by sign", () => {
  const io = bucketInOutByDay(FIXTURE, amountOf);
  assert.deepEqual(io.get("2026-06-02"), { in: 100, out: 30 });
  assert.deepEqual(io.get("2026-06-05"), { in: 0, out: 50 });
  assert.deepEqual(io.get("2026-06-09"), { in: 20, out: 20 });   // nets 0 but both sides present
  assert.deepEqual(io.get("2026-07-01"), { in: 200, out: 0 });
});

test("transactionsDateRange: the loaded/filtered [min, max] span; null when empty", () => {
  assert.deepEqual(transactionsDateRange(FIXTURE), { start: "2026-06-02", end: "2026-07-01" });
  assert.equal(transactionsDateRange([]), null);
});

test("zero-vs-unavailable (§9.6): in-range gap days are absent (→ neutral zero), out-of-range never painted", () => {
  const net = bucketNetByDay(FIXTURE, amountOf);
  const range = transactionsDateRange(FIXTURE)!;

  // June 3 is INSIDE the loaded range but has no transactions → absent from the
  // map. The grid renders absent-in-range as net 0 (a neutral empty cell), NOT a
  // colored zero — distinct from an out-of-range "unavailable" day.
  const gapDay = "2026-06-03";
  assert.ok(gapDay >= range.start && gapDay <= range.end, "gap day is within the loaded range");
  assert.equal(net.has(gapDay), false, "no-activity in-range day carries no value");

  // A day BEFORE the loaded range is outside [start, end] entirely → the grid
  // paints it as unavailable, never as a zero data point.
  const beforeLoaded = "2026-05-31";
  assert.ok(beforeLoaded < range.start, "out-of-range day is below the loaded span");
  assert.equal(net.has(beforeLoaded), false);

  // A day with real activity that happens to net to zero IS in the map (value 0)
  // — an in-range zero, correctly distinct from a gap day (absent).
  assert.equal(net.get("2026-06-09"), 0);
  assert.equal(net.has("2026-06-09"), true);
});

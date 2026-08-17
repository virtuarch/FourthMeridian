/**
 * lib/transactions/event-live-row-count.test.ts
 *
 * v2.6-EVENT-2 — the proof that INV-4's COUNTER was wrong while its INVARIANT
 * was right, preserved so the audit change is checkable rather than asserted.
 *
 *   npx tsx lib/transactions/event-live-row-count.test.ts
 *
 * ── The invariant, unchanged ───────────────────────────────────────────────
 *
 *   "no event has two LIVE transaction rows"
 *
 * ── What the counter actually counted ──────────────────────────────────────
 *
 * Both audits incremented ONCE PER OBSERVATION whose row is live:
 *
 *     for (const o of observations)
 *       if (live(o.transactionId)) liveByEvent[o.eventId] += 1
 *
 * That counts OBSERVATIONS, not ROWS. An event that observed ONE row twice
 * scores 2 and fails a check about how many rows it has.
 *
 * ⚠️ Observing one row twice is not a defect — it is DF-4 working. When Plaid
 * re-keys a row (same account, date, amount, descriptor, pending; new
 * `transaction_id`), `syncTransactions` reuses the existing row rather than
 * duplicating it — the fix for the six-Amazon-rows incident. The row is then
 * genuinely observed under two provider ids, and both observations are true.
 *
 * So the counter had to change and the invariant did not. This file pins both
 * halves: the OLD counter is kept here, executable, so "the old one was wrong"
 * is demonstrated rather than claimed.
 *
 * ⚠️ Test 3 is the one that must fail if `countLiveRowsPerEvent` is ever
 * loosened back into counting observations.
 */

import { countLiveRowsPerEvent, eventsWithMultipleLiveRows } from "./event-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The counter as BOTH audits implemented it before this slice. Kept for contrast. */
function legacyCounter(
  observations: readonly { eventId: string; transactionId: string | null }[],
  liveIds: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of observations) {
    if (o.transactionId && liveIds.has(o.transactionId)) {
      out.set(o.eventId, (out.get(o.eventId) ?? 0) + 1);
    }
  }
  return out;
}

async function main(): Promise<void> {

// ── 1. The legitimate DF-4 shape: ONE row, observed twice ──────────────────
console.log("1. A DF-4 re-key — one live row observed under two provider ids");
{
  // This is the measured Amex "Uber" −7.12 shape: Plaid delivered `xDPnbp5g…`
  // and then `JMBKp97L…` for the same row; the sync adopted rather than
  // duplicated, so one row carries two observations.
  const obs = [
    { eventId: "e1", transactionId: "t1" },
    { eventId: "e1", transactionId: "t1" },
  ];
  const live = new Set(["t1"]);

  check("the event has ONE live row, which is the invariant's subject",
    countLiveRowsPerEvent(obs, live).get("e1") === 1,
    `${countLiveRowsPerEvent(obs, live).get("e1")}`);
  check("the corrected check does NOT flag it",
    eventsWithMultipleLiveRows(obs, live).length === 0);
  // The proof that the change was a bug fix, not a relaxation:
  check("the LEGACY counter falsely scored it 2",
    legacyCounter(obs, live).get("e1") === 2,
    `${legacyCounter(obs, live).get("e1")}`);
}

// ── 2. The real violation: TWO DISTINCT live rows on one event ─────────────
console.log("\n2. Two DISTINCT live rows on one event — still a violation");
{
  const obs = [
    { eventId: "e1", transactionId: "t1" },
    { eventId: "e1", transactionId: "t2" },
  ];
  const live = new Set(["t1", "t2"]);

  check("counted as TWO live rows", countLiveRowsPerEvent(obs, live).get("e1") === 2,
    `${countLiveRowsPerEvent(obs, live).get("e1")}`);
  check("the corrected check STILL flags it",
    eventsWithMultipleLiveRows(obs, live).includes("e1"));
}

// ── 3. Distinctness is what changed, and only that ─────────────────────────
console.log("\n3. Only distinctness changed — everything else is identical");
{
  // A pending→posted chain: the pending row is tombstoned, the posted row lives.
  const chain = [
    { eventId: "e1", transactionId: "tPending" },
    { eventId: "e1", transactionId: "tPosted" },
  ];
  const live = new Set(["tPosted"]);
  check("a normal succession counts ONE live row",
    countLiveRowsPerEvent(chain, live).get("e1") === 1);
  check("and is not flagged", eventsWithMultipleLiveRows(chain, live).length === 0);

  // A withdrawn pending: no live row at all.
  const withdrawn = [{ eventId: "e1", transactionId: "tPending" }];
  check("a withdrawn event counts ZERO live rows",
    (countLiveRowsPerEvent(withdrawn, new Set()).get("e1") ?? 0) === 0);
  check("and is not flagged", eventsWithMultipleLiveRows(withdrawn, new Set()).length === 0);

  // Observations with no row at all are ignored by both counters.
  const orphan = [{ eventId: "e1", transactionId: null }];
  check("a row-less observation counts ZERO",
    (countLiveRowsPerEvent(orphan, new Set(["t1"])).get("e1") ?? 0) === 0);

  // ⚠️ THREE distinct live rows must still be caught — the check is about
  // "more than one", not "exactly two".
  const three = [
    { eventId: "e1", transactionId: "t1" }, { eventId: "e1", transactionId: "t2" },
    { eventId: "e1", transactionId: "t3" },
  ];
  check("three distinct live rows are flagged",
    eventsWithMultipleLiveRows(three, new Set(["t1", "t2", "t3"])).includes("e1"));

  // And duplicate observations of MULTIPLE rows are still flagged — the fix must
  // not let repetition mask a genuine second row.
  const mixed = [
    { eventId: "e1", transactionId: "t1" }, { eventId: "e1", transactionId: "t1" },
    { eventId: "e1", transactionId: "t2" }, { eventId: "e1", transactionId: "t2" },
  ];
  check("duplicated observations of TWO rows are still flagged",
    eventsWithMultipleLiveRows(mixed, new Set(["t1", "t2"])).includes("e1"));
}

console.log(failures === 0 ? "\nAll live-row-count checks passed.\n" : `\n${failures} check(s) failed\n`);
if (failures > 0) process.exit(1);
}

main();

/**
 * lib/transactions/event-projection.test.ts   (L8 — Phase B1)
 *
 * One row per logical event, and the refusal that fires when that fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  eventProjectionWhere, findDuplicateEvents, assertOneRowPerEvent,
} from "./event-projection";

const row = (id: string, transactionEventId: string | null) => ({ id, transactionEventId });

test("the filter keeps eventless rows AND current projections, and nothing else", () => {
  const w = eventProjectionWhere();
  assert.ok(Array.isArray(w.OR), "the filter must be a disjunction of the two admissible cases");
  assert.equal(w.OR!.length, 2);
  // Case 1 — outside the banking event domain (self-custody crypto). 33 live
  // rows are in this state; dropping them would change real totals.
  assert.deepEqual(w.OR![0], { transactionEventId: null });
  // Case 2 — inside it, and this row is the one the event projects to.
  assert.deepEqual(w.OR![1], { currentOfEvent: { isNot: null } });
});

test("a clean projection has no duplicates", () => {
  const rows = [row("t1", "e1"), row("t2", "e2"), row("t3", "e3")];
  assert.deepEqual(findDuplicateEvents(rows), []);
  assert.doesNotThrow(() => assertOneRowPerEvent(rows, "test"));
});

test("eventless rows never collide with each other", () => {
  // Every crypto row has a null event. They must not be read as "all the same
  // event" — that would be a spectacular false positive.
  const rows = [row("c1", null), row("c2", null), row("c3", null)];
  assert.deepEqual(findDuplicateEvents(rows), []);
  assert.doesNotThrow(() => assertOneRowPerEvent(rows, "test"));
});

test("a pending and its posting in one result set is CAUGHT", () => {
  // The failure this exists to prevent: one economic event, two live rows, every
  // total silently doubled for that money.
  const rows = [row("pending1", "e1"), row("posted1", "e1"), row("t2", "e2")];
  const dupes = findDuplicateEvents(rows);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].eventId, "e1");
  assert.deepEqual(dupes[0].transactionIds.sort(), ["pending1", "posted1"]);
});

test("the guard THROWS rather than degrading, and names the read", () => {
  const rows = [row("pending1", "e1"), row("posted1", "e1")];
  assert.throws(
    () => assertOneRowPerEvent(rows, "getTransactions"),
    (e: Error) => {
      // The message must say WHERE, WHAT and HOW TO FIX — an operator reading a
      // stack trace at 2am should not have to guess.
      assert.match(e.message, /getTransactions/);
      assert.match(e.message, /double-count/);
      assert.match(e.message, /eventProjectionWhere/);
      assert.match(e.message, /e1/);
      return true;
    },
  );
});

test("three rows of one event are still one violation, not three", () => {
  const dupes = findDuplicateEvents([row("a", "e1"), row("b", "e1"), row("c", "e1")]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].transactionIds.length, 3);
});

test("an empty result set is fine", () => {
  assert.deepEqual(findDuplicateEvents([]), []);
  assert.doesNotThrow(() => assertOneRowPerEvent([], "test"));
});

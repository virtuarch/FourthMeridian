/**
 * lib/account-deletion/revocation.test.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 3 — bounded provider-revocation policy
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/account-deletion/revocation.test.ts
 *
 * Two invariants that pull in opposite directions:
 *   1. we must not silently lose the ability to revoke upstream after a
 *      transient Plaid failure;
 *   2. a Plaid outage must not block a user's deletion forever.
 * The bounded retry is the resolution, so these tests pin BOTH ends: the hold
 * that protects (1) and the terminal completion that protects (2).
 */

import {
  classifyRevocationFailure, decideRevocation, countPriorFailureDays, dayKey,
  MAX_REVOCATION_ATTEMPT_DAYS, TERMINAL_ALREADY_GONE_CODES,
} from "./revocation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Success / already-gone ───────────────────────────────────────────────
console.log("1. Success and terminal already-gone");
{
  check("no failures ⇒ proceed", decideRevocation({ retryableFailures: 0, priorFailureDays: 0 }).action === "proceed");
  check("no failures ⇒ proceed even with prior failure days (a later success wins)",
    decideRevocation({ retryableFailures: 0, priorFailureDays: 2 }).action === "proceed");

  check("ITEM_NOT_FOUND is terminal already-gone", classifyRevocationFailure("ITEM_NOT_FOUND") === "already-gone");
  check("the already-gone set is exactly ITEM_NOT_FOUND",
    TERMINAL_ALREADY_GONE_CODES.length === 1 && TERMINAL_ALREADY_GONE_CODES[0] === "ITEM_NOT_FOUND");

  // Deliberately NOT terminal — could be a malformed/rotated token rather than a
  // removed item. Treating it as success would claim a revocation we never made.
  check("INVALID_ACCESS_TOKEN is NOT treated as already-gone",
    classifyRevocationFailure("INVALID_ACCESS_TOKEN") === "retryable");
  check("an outage code is retryable", classifyRevocationFailure("INSTITUTION_DOWN") === "retryable");
  check("an unknown/absent code is retryable (fail safe)", classifyRevocationFailure(undefined) === "retryable");
}

// ── 2-4. The three-attempt ladder ───────────────────────────────────────────
console.log("2-4. The bounded ladder — hold, hold, then complete");
{
  const d1 = decideRevocation({ retryableFailures: 1, priorFailureDays: 0 });
  check("attempt 1 ⇒ HOLD", d1.action === "hold");
  check("attempt 1 is day 1", d1.action === "hold" && d1.attemptDay === 1);
  check("attempt 1 reports 2 remaining", d1.action === "hold" && d1.attemptsRemaining === 2);

  const d2 = decideRevocation({ retryableFailures: 1, priorFailureDays: 1 });
  check("attempt 2 ⇒ HOLD", d2.action === "hold");
  check("attempt 2 is day 2", d2.action === "hold" && d2.attemptDay === 2);

  const d3 = decideRevocation({ retryableFailures: 1, priorFailureDays: 2 });
  check("attempt 3 ⇒ PROCEED-UNREVOKED (deletion is not held hostage)", d3.action === "proceed-unrevoked");
  check("attempt 3 is day 3", d3.action === "proceed-unrevoked" && d3.attemptDay === 3);
  check("policy is 3 daily attempts", MAX_REVOCATION_ATTEMPT_DAYS === 3);

  // Never loops past the budget.
  check("day 4+ still terminal, never re-holds",
    decideRevocation({ retryableFailures: 1, priorFailureDays: 5 }).action === "proceed-unrevoked");
}

// ── 5. Concurrency — same-day runs cannot burn the budget ───────────────────
console.log("5. Concurrency — day-counting, not row-counting");
{
  const now = new Date("2026-07-22T06:00:00Z");
  // Three failure audits, all written TODAY by duplicate/manual cron runs.
  const sameDay = [
    new Date("2026-07-22T06:00:00Z"),
    new Date("2026-07-22T06:00:01Z"),
    new Date("2026-07-22T09:30:00Z"),
  ];
  check("three same-day audits ⇒ 0 PRIOR days (today is excluded)",
    countPriorFailureDays(sameDay, now) === 0, `${countPriorFailureDays(sameDay, now)}`);
  check("⇒ a duplicate run still decides HOLD, not terminal",
    decideRevocation({ retryableFailures: 1, priorFailureDays: countPriorFailureDays(sameDay, now) }).action === "hold");

  // Row-counting would have said 3 and terminally deleted after ~1 day.
  check("row-counting WOULD have wrongly hit the threshold", sameDay.length >= MAX_REVOCATION_ATTEMPT_DAYS);

  const threeDays = [
    new Date("2026-07-19T06:00:00Z"),
    new Date("2026-07-20T06:00:00Z"), new Date("2026-07-20T07:00:00Z"), // duplicate same day
    new Date("2026-07-21T06:00:00Z"),
  ];
  check("three distinct prior days ⇒ 3", countPriorFailureDays(threeDays, now) === 3, `${countPriorFailureDays(threeDays, now)}`);
  check("⇒ terminal on the next run",
    decideRevocation({ retryableFailures: 1, priorFailureDays: countPriorFailureDays(threeDays, now) }).action === "proceed-unrevoked");

  check("dayKey is UTC calendar day", dayKey(new Date("2026-07-22T23:59:59Z")) === "2026-07-22");
}

// ── 6. Success after prior failures ─────────────────────────────────────────
console.log("6. Success after prior failures completes normally");
{
  // Attempt 1 failed yesterday; today itemRemove succeeds ⇒ zero retryable
  // failures ⇒ proceed. The prior failure audit remains as history, and NO
  // terminal unrevoked record is written.
  const d = decideRevocation({ retryableFailures: 0, priorFailureDays: 1 });
  check("recovery on attempt 2 ⇒ proceed", d.action === "proceed");
  check("recovery does NOT emit a terminal unrevoked decision", d.action !== "proceed-unrevoked");
}

// ── 7. Partial failure across items ─────────────────────────────────────────
console.log("7. Any unrevoked item holds the deletion");
{
  check("1 of 3 items failing still holds",
    decideRevocation({ retryableFailures: 1, priorFailureDays: 0 }).action === "hold");
  check("all items revoked ⇒ proceed",
    decideRevocation({ retryableFailures: 0, priorFailureDays: 0 }).action === "proceed");
}

console.log(failures === 0
  ? "\n✅ revocation policy: all checks passed"
  : `\n❌ revocation policy: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

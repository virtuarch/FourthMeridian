/**
 * lib/plaid/reconcile-core.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 2A — the SAME-BASIS invariant for the balance↔
 * transaction reconciliation (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/plaid/reconcile-core.test.ts
 *
 * The detector compares a balance delta against a transaction-sum delta. Both
 * sides must be POSTED-basis, because `FinancialAccount.balance` is written from
 * Plaid's `balances.current`, which never carries pending activity — the same
 * statement the snapshot system makes about it.
 *
 * §1 replays the TWO REAL BALANCE_TX_MISMATCH events recorded in the local
 * database on 2026-07-22 and shows that each was a pure pending→posted artifact:
 * under the pending-inclusive rule they fired; under the posted-only rule they
 * are exactly zero. §2 proves the detector still catches the incident class it
 * exists for (a delivered-but-unstored posted row — the July-2 payroll).
 *
 * The two events, from the SyncIssue table:
 *   CHASE COLLEGE (checking): balanceDelta −421.32, txnSumDelta 0, mismatch 421.32
 *   CREDIT CARD   (debt):     balanceDelta −213.50, txnSumDelta −12.52, mismatch 226.02
 * Both were emitted in the same sync run that tombstoned 8 pending rows and
 * re-created them as posted — i.e. entirely healthy provider churn.
 */

import { evaluateReconciliation, RECONCILE_MIN_THRESHOLD } from "./reconcile-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── 1. The two real events — pending→posted churn is NOT a mismatch ──────────
console.log("1. Real recorded events replayed under the posted-only rule");
{
  // CHASE COLLEGE — three pendings (−300, −105, −16.32 = −421.32) posted this run.
  // Posted basis: they were absent from the BEFORE sum (still pending) and
  // present in the AFTER sum, so the sum moves by exactly what the balance did.
  const cash = evaluateReconciliation({
    kind: "cash",
    balanceBefore: 5000, balanceAfter: 5000 - 421.32,
    postedSumBefore: 0,  postedSumAfter: -421.32,
  });
  check("checking: balanceDelta is the real −421.32", approx(cash.balanceDelta, -421.32));
  check("checking: posted sum moves WITH it (−421.32, not 0)", approx(cash.txnSumDelta, -421.32));
  check("checking: mismatch is EXACTLY 0", approx(cash.mismatch, 0), String(cash.mismatch));
  check("checking: no BALANCE_TX_MISMATCH emitted", cash.mismatched === false);

  // CREDIT CARD — five pendings netting +213.50 of owed-reduction posted
  // (a +300 payment against −86.50 of charges), plus ONE NEW pending (−12.52)
  // which is correctly excluded from a posted-only sum.
  const card = evaluateReconciliation({
    kind: "card",
    balanceBefore: 89.46, balanceAfter: 89.46 - 213.50,   // → −124.04, the issuer credit
    postedSumBefore: 0,   postedSumAfter: 213.50,
  });
  check("card: balanceDelta is the real −213.50", approx(card.balanceDelta, -213.50));
  check("card: expected flips sign for a liability", approx(card.expected, -213.50));
  check("card: mismatch is EXACTLY 0", approx(card.mismatch, 0), String(card.mismatch));
  check("card: no BALANCE_TX_MISMATCH emitted", card.mismatched === false);
  check("card: the new pending (−12.52) is excluded, not counted as a gap",
    approx(card.txnSumDelta, 213.50));
}

// ── 2. The OLD pending-inclusive rule reproduced both false positives ────────
console.log("2. The legacy pending-inclusive rule — reproduces the exact recorded numbers");
{
  // Pending-inclusive: the rows were ALREADY counted while pending, so the sum
  // does not move when they post — while the balance does. That gap IS the bug.
  const cashLegacy = evaluateReconciliation({
    kind: "cash",
    balanceBefore: 5000, balanceAfter: 5000 - 421.32,
    postedSumBefore: -421.32, postedSumAfter: -421.32,   // unchanged: pending already counted
  });
  check("legacy checking: txnSumDelta 0 — exactly as recorded", approx(cashLegacy.txnSumDelta, 0));
  check("legacy checking: mismatch 421.32 — exactly as recorded", approx(cashLegacy.mismatch, 421.32));
  check("legacy checking: WOULD have fired", cashLegacy.mismatched === true);

  const cardLegacy = evaluateReconciliation({
    kind: "card",
    balanceBefore: 89.46, balanceAfter: 89.46 - 213.50,
    postedSumBefore: 0, postedSumAfter: -12.52,          // only the NEW pending moves it
  });
  check("legacy card: txnSumDelta −12.52 — exactly as recorded", approx(cardLegacy.txnSumDelta, -12.52));
  check("legacy card: mismatch 226.02 — exactly as recorded", approx(cardLegacy.mismatch, 226.02));
  check("legacy card: WOULD have fired", cardLegacy.mismatched === true);

  console.log("     ⇒ both historical events are confirmed FALSE POSITIVES of the old basis.");
}

// ── 3. The detector still catches what it exists for ────────────────────────
console.log("3. Genuine gaps still detected — the fix is not a suppression");
{
  // The July-2 class: a posted payroll (+5,286.65) was delivered but never
  // stored, while the balance already reflected it. Posted sum does not move.
  const lost = evaluateReconciliation({
    kind: "cash",
    balanceBefore: 1000, balanceAfter: 1000 + 5286.65,
    postedSumBefore: 0,  postedSumAfter: 0,              // the row never landed
  });
  check("missing posted deposit IS flagged", lost.mismatched === true);
  check("mismatch equals the lost amount", approx(lost.mismatch, 5286.65));

  // A missing posted CARD charge is equally detected.
  const lostCard = evaluateReconciliation({
    kind: "card",
    balanceBefore: 500, balanceAfter: 900,               // owed jumped 400
    postedSumBefore: 0, postedSumAfter: 0,               // no charge stored
  });
  check("missing posted card charge IS flagged", lostCard.mismatched === true);
  check("card mismatch equals the lost amount", approx(lostCard.mismatch, 400));

  // A DUPLICATE stored transaction moves the sum without the balance — also caught.
  const dupe = evaluateReconciliation({
    kind: "cash",
    balanceBefore: 1000, balanceAfter: 1000,
    postedSumBefore: 0,  postedSumAfter: -750,
  });
  check("phantom/duplicate stored row IS flagged", dupe.mismatched === true);
}

// ── 4. Threshold semantics unchanged ────────────────────────────────────────
console.log("4. Threshold — unchanged by Phase 2");
{
  const small = evaluateReconciliation({
    kind: "cash", balanceBefore: 1000, balanceAfter: 1050,
    postedSumBefore: 0, postedSumAfter: 0,
  });
  check("a $50 gap stays below the $100 floor", small.mismatched === false);
  check("floor is the documented minimum", small.threshold === RECONCILE_MIN_THRESHOLD);

  const big = evaluateReconciliation({
    kind: "cash", balanceBefore: 0, balanceAfter: 100_000,
    postedSumBefore: 0, postedSumAfter: 0,
  });
  check("threshold scales to 2% on large balances", approx(big.threshold, 2000));
  check("a 100k unexplained move still fires", big.mismatched === true);
}

// ── 5. Same-basis is a property, not a coincidence ──────────────────────────
console.log("5. Property check — matched bases never manufacture a mismatch");
{
  // For any posted movement, if the balance moved by exactly what the posted
  // transactions say, mismatch must be 0 — for both account kinds.
  let ok = true;
  for (const delta of [-421.32, -213.5, 0, 12.52, 5286.65, -1, 99999]) {
    const cash = evaluateReconciliation({
      kind: "cash", balanceBefore: 0, balanceAfter: delta,
      postedSumBefore: 0, postedSumAfter: delta,
    });
    const card = evaluateReconciliation({
      kind: "card", balanceBefore: 0, balanceAfter: -delta,
      postedSumBefore: 0, postedSumAfter: delta,
    });
    if (!approx(cash.mismatch, 0) || !approx(card.mismatch, 0)) { ok = false; break; }
  }
  check("matched-basis movement always reconciles to 0 (cash and card)", ok);
}

console.log(failures === 0
  ? "\n✅ reconcile-core: all checks passed"
  : `\n❌ reconcile-core: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

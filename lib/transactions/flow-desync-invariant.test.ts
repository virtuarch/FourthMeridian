/**
 * lib/transactions/flow-desync-invariant.test.ts
 *
 * Desync Remediation — permanent REGRESSION TEST (pure, no DB).
 *
 * Pins the classifier contract that the corpus certification depends on: the
 * three TransactionCategory values that scripts/audit-flow-desync.ts treats as
 * UNCONDITIONAL must map 1:1 to their flowType regardless of amount sign or
 * account context. If a future classifier change breaks any of these, the
 * standing audit's predicate would silently stop meaning what it claims — this
 * test fails first, at build time, before the corpus can drift.
 *
 * CCPAY-2B narrowed exactly ONE of the three: Payment → DEBT_PAYMENT is now
 * unconditional EXCEPT on a liability outflow (a charge, never a payment). That
 * exception is pinned at the bottom of this file, alongside the depository
 * source-leg case it must not touch. Transfer and Fee remain unconditional.
 *
 * Mirrors the project's framework-free test convention (standalone tsx script,
 * exits 0 on pass / 1 on first failure). Imports ONLY the Prisma-free
 * flow-classifier module, so it runs without `prisma generate`.
 *
 *     npx tsx lib/transactions/flow-desync-invariant.test.ts
 *
 * See docs/initiatives/desync/DESYNC_REMEDIATION_2026-07-06.md §Phase 4.
 */

import { classifyFlow, type FlowType } from "./flow-classifier";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Assert category → flowType holds for BOTH sign legs and with/without account. */
function invariant(category: string, want: FlowType): void {
  const cases = [
    { category, amount: 1 },
    { category, amount: -1 },
    { category, amount: 1, accountType: "debt", debtSubtype: "credit_card" },
    { category, amount: -1, accountType: "checking" },
  ];
  for (const input of cases) {
    const got = classifyFlow(input).flowType;
    check(
      `${category} (amount ${input.amount}, acct ${input.accountType ?? "none"}) → ${want}`,
      got === want,
      `got ${got}`,
    );
  }
}

// The three unconditional deterministic-category contracts the audit enforces.
invariant("Transfer", "TRANSFER");
invariant("Payment", "DEBT_PAYMENT");
invariant("Fee", "FEE");

// Guard the specific historical defect this initiative remediated: a positive
// amount in a Payment category (the CC-1 destination leg) must classify as
// DEBT_PAYMENT, NOT REFUND. This is the exact flip the 51-row fix performs.
check(
  "CC-1 regression: Payment + amount>0 is DEBT_PAYMENT, not REFUND",
  classifyFlow({ category: "Payment", amount: 300 }).flowType === "DEBT_PAYMENT",
  `got ${classifyFlow({ category: "Payment", amount: 300 }).flowType}`,
);

// ── CCPAY-2B — the ONE documented exception to Payment → DEBT_PAYMENT ─────────
// The Payment contract above is unconditional EXCEPT on a liability OUTFLOW:
// money leaving a liability account raises what you owe, which is structurally a
// charge, never a debt payment. Pinned explicitly so the exception is a stated
// contract rather than an accident of which cases `invariant()` happens to try.
//
// scripts/audit-flow-desync.ts still encodes the OLD unconditional predicate
// (category='Payment' AND flowType IS DISTINCT FROM 'DEBT_PAYMENT' ⇒ desync). No
// stored row violates it today — CCPAY-2A/2B changed no data — but the first
// liability outflow Plaid tags LOAN_PAYMENTS will be a legitimate
// category='Payment' + flowType='SPENDING' row that the audit would false-alarm
// on. Reconciling that audit is a CCPAY-2F decision, flagged, not silently done.
for (const liability of [
  { accountType: "debt" },
  { accountType: "other", debtSubtype: "credit_card" },
]) {
  const got = classifyFlow({ category: "Payment", amount: -387.24, ...liability });
  check(
    `CCPAY-2B: Payment + amount<0 on a liability (${JSON.stringify(liability)}) is NOT DEBT_PAYMENT`,
    got.flowType === "SPENDING",
    `got ${got.flowType}`,
  );
}

// The veto is scoped to liabilities: the SOURCE leg of a real card payment is a
// negative row on a DEPOSITORY account and must stay DEBT_PAYMENT/INTERNAL.
// This is the 116-row population the veto must never touch.
const sourceLeg = classifyFlow({ category: "Payment", amount: -5000, accountType: "checking" });
check(
  "CCPAY-2B: source leg (Payment + amount<0 on checking) stays DEBT_PAYMENT/INTERNAL",
  sourceLeg.flowType === "DEBT_PAYMENT" && sourceLeg.flowDirection === "INTERNAL",
  `got ${sourceLeg.flowType}/${sourceLeg.flowDirection}`,
);

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`flow-desync-invariant: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`flow-desync-invariant: all ${passed} checks passed ✓`);

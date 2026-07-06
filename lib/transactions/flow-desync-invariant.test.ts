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

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`flow-desync-invariant: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`flow-desync-invariant: all ${passed} checks passed ✓`);

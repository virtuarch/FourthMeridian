/**
 * lib/debt.golden.test.ts
 *
 * MC1 Phase 2 Slice 4 golden gate, evolved into MC1 Phase 3 Slice 2
 * EQUIVALENCE GATES (plan D-10): pure-USD fixtures stay byte-identical
 * (kill switch); residue/mixed fixtures stay NUMERICALLY identical under
 * identity while `estimated` (new, D-7) turns honest; real-rate contexts
 * convert with correct flags. Pure: no DB, no network.
 */

import { rollupDebtPaymentsByAccount, totalDebtPaid, type DebtPaymentTxnLike } from "./debt";
import { identityContext } from "./money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "./currency";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

const numbersOf = (entries: ReturnType<typeof rollupDebtPaymentsByAccount>) =>
  entries.map(({ accountId, total, count }) => ({ accountId, total, count }));

// ── pure-USD fixture: byte-identity (kill-switch gate) ────────────────────────

const pureUsd: DebtPaymentTxnLike[] = [
  { accountId: "cardA", amount: -300.25, flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-01" },
  { accountId: "cardA", amount: 150.5,   flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-15" },
  { accountId: "cardB", amount: -99.99,  flowType: "DEBT_PAYMENT", currency: "USD" }, // no dateISO — identity never reads it
  { accountId: "cardA", amount: -55,     flowType: "SPENDING",     currency: "USD" }, // excluded by flow
  { accountId: "cardC", amount: -10,     flowType: null,           currency: "USD" }, // null flow excluded
];

{
  check("kill switch: totalDebtPaid byte-identical (pure-USD)",
    JSON.stringify(totalDebtPaid(pureUsd)) === JSON.stringify(totalDebtPaid(pureUsd, CTX)));
  check("kill switch: rollup byte-identical incl. estimated:false (pure-USD)",
    JSON.stringify(rollupDebtPaymentsByAccount(pureUsd)) ===
    JSON.stringify(rollupDebtPaymentsByAccount(pureUsd, CTX)));
  check("abs-sum shape preserved (300.25 + 150.5 + 99.99)",
    totalDebtPaid(pureUsd, CTX) === 300.25 + 150.5 + 99.99);
  check("estimated: false on every pure-USD entry (both paths)",
    rollupDebtPaymentsByAccount(pureUsd, CTX).every((e) => e.estimated === false) &&
    rollupDebtPaymentsByAccount(pureUsd).every((e) => e.estimated === false));
}

// ── residue/mixed: numbers identical under identity, flags honest ─────────────

{
  const mixed: DebtPaymentTxnLike[] = [
    ...pureUsd,
    { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" },
    { accountId: "cardD", amount: -75,  flowType: "DEBT_PAYMENT", currency: null },   // null-residue
    { accountId: "cardE", amount: -120, flowType: "DEBT_PAYMENT" },                    // bare legacy shape
  ];
  check("mixed: totalDebtPaid numerically identical under identity",
    totalDebtPaid(mixed) === totalDebtPaid(mixed, CTX));
  check("mixed: rollup numbers identical under identity (flags aside)",
    JSON.stringify(numbersOf(rollupDebtPaymentsByAccount(mixed))) ===
    JSON.stringify(numbersOf(rollupDebtPaymentsByAccount(mixed, CTX))));
  const withCtx = rollupDebtPaymentsByAccount(mixed, CTX);
  check("mixed: EUR/null entries flagged estimated with context",
    withCtx.find((e) => e.accountId === "cardD")?.estimated === true &&
    withCtx.find((e) => e.accountId === "cardE")?.estimated === true);
  check("mixed: pure-USD entries stay unflagged",
    withCtx.find((e) => e.accountId === "cardA")?.estimated === false);
  check("mixed: context-less path never flags",
    rollupDebtPaymentsByAccount(mixed).every((e) => e.estimated === false));
}

// ── real-rate context: converts + flags correctly (seam liveness) ─────────────

{
  const realCtx = {
    target: "USD",
    resolve: (from: string, dateISO: string) =>
      from === "EUR" && dateISO === "2026-06-10"
        ? ({ kind: "rate", rate: 1.2, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as const)
        : ({ kind: "miss", quote: from, requestedDateISO: dateISO } as const),
  };
  const rows: DebtPaymentTxnLike[] = [
    { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" },
    { accountId: "cardE", amount: -100, flowType: "DEBT_PAYMENT", currency: "SAR", dateISO: "2026-06-10" },
  ];
  const rollup = rollupDebtPaymentsByAccount(rows, realCtx);
  check("real: EUR converts at its row date (500 × 1.2 = 600), exact ⇒ not estimated",
    rollup[0].total === 600 && rollup[0].estimated === false);
  check("real: missed SAR stays native + estimated (D-3, never excluded)",
    rollup[1].total === 100 && rollup[1].estimated === true);
  check("real: totalDebtPaid includes both (600 + 100)", totalDebtPaid(rows, realCtx) === 700);
}

if (failures.length > 0) {
  console.error(`\nMC1 P3 debt equivalence gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 debt equivalence gates: all ${passed} checks passed.`);
process.exit(0);

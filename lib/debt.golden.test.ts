/**
 * lib/debt.golden.test.ts
 *
 * MC1 Phase 2 Slice 4 — byte-identical golden gate for the debt-payment
 * rollups (transaction family). Pure: no DB, no network. House-style
 * standalone tsx script, auto-discovered by scripts/run-tests.ts.
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

// ── USD fixture (incl. legacy rows without currency/dateISO fields) ──────────

const usdFixture: DebtPaymentTxnLike[] = [
  { accountId: "cardA", amount: -300.25, flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-01" },
  { accountId: "cardA", amount: 150.5,   flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-15" },
  { accountId: "cardB", amount: -99.99,  flowType: "DEBT_PAYMENT", currency: "USD" }, // no dateISO
  { accountId: "cardB", amount: -20,     flowType: "DEBT_PAYMENT" },                   // bare legacy shape
  { accountId: "cardA", amount: -55,     flowType: "SPENDING",     currency: "USD" }, // excluded by flow
  { accountId: "cardC", amount: -10,     flowType: null },                             // null flow excluded
];

{
  check("golden: totalDebtPaid byte-identical (USD fixture)",
    JSON.stringify(totalDebtPaid(usdFixture)) === JSON.stringify(totalDebtPaid(usdFixture, CTX)));
  check("golden: rollup byte-identical (USD fixture)",
    JSON.stringify(rollupDebtPaymentsByAccount(usdFixture)) ===
    JSON.stringify(rollupDebtPaymentsByAccount(usdFixture, CTX)));
  check("golden: abs-sum shape preserved (300.25 + 150.5 + 99.99 + 20)",
    totalDebtPaid(usdFixture, CTX) === 300.25 + 150.5 + 99.99 + 20);
}

// ── mixed/non-USD fixture: STILL byte-identical under identity (D-3) ─────────

{
  const mixed: DebtPaymentTxnLike[] = [
    ...usdFixture,
    { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" },
    { accountId: "cardD", amount: -75,  flowType: "DEBT_PAYMENT", currency: null }, // null-residue
    { accountId: "cardE", amount: -120, flowType: "DEBT_PAYMENT", currency: "SAR" },
  ];
  check("golden: mixed-currency totalDebtPaid byte-identical under identity",
    JSON.stringify(totalDebtPaid(mixed)) === JSON.stringify(totalDebtPaid(mixed, CTX)));
  check("golden: mixed-currency rollup byte-identical under identity (incl. sort order)",
    JSON.stringify(rollupDebtPaymentsByAccount(mixed)) ===
    JSON.stringify(rollupDebtPaymentsByAccount(mixed, CTX)));
}

// ── seam liveness (unit-level only — NOT product behavior) ────────────────────

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
  check("seam live: EUR leg converts at its row date (500 × 1.2 = 600)",
    rollupDebtPaymentsByAccount(rows, realCtx)[0].total === 600);
  check("seam live: missed SAR leg stays native (D-3, never excluded)",
    totalDebtPaid(rows, realCtx) === 600 + 100);
}

if (failures.length > 0) {
  console.error(`\nMC1 P2 debt goldens: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P2 debt goldens: all ${passed} checks passed.`);
process.exit(0);

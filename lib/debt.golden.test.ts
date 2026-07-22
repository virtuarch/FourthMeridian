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
  const eurPayment = { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" } as const;
  const mixed: DebtPaymentTxnLike[] = [
    ...pureUsd,
    eurPayment,                                                                        // EUR miss → excluded under identity
    { accountId: "cardD", amount: -75,  flowType: "DEBT_PAYMENT", currency: null },   // null-residue → passthrough (kept)
    { accountId: "cardE", amount: -120, flowType: "DEBT_PAYMENT" },                    // bare legacy shape → null-residue (kept)
  ];
  // V25-FINAL-1 — the unavailable EUR payment (500) is EXCLUDED (contributes 0)
  // under identity, but the row is still PRESENT (2 occurrences on cardD). So the
  // with-context cardD total is the null-residue 75 alone, NOT 575, while the
  // context-less raw addition still blends the EUR native 500 in.
  const cardDWithCtx = rollupDebtPaymentsByAccount(mixed, CTX).find((e) => e.accountId === "cardD")!.total;
  const cardDRaw     = rollupDebtPaymentsByAccount(mixed).find((e) => e.accountId === "cardD")!.total;
  check("mixed: cardD reporting total EXCLUDES the unavailable EUR 500 (75, not 575)",
    cardDWithCtx === 75, `got ${cardDWithCtx}`);
  check("mixed: raw addition still blends the EUR native magnitude in (575)",
    cardDRaw === 575, `got ${cardDRaw}`);
  check("mixed: totalDebtPaid also excludes the EUR (context differs from raw addition)",
    totalDebtPaid(mixed) !== totalDebtPaid(mixed, CTX) &&
    totalDebtPaid(mixed) - totalDebtPaid(mixed, CTX) === 500);
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
  check("real: missed SAR EXCLUDED to 0 + estimated (V25-FINAL-1, not native 100)",
    rollup[1].total === 0 && rollup[1].estimated === true);
  check("real: totalDebtPaid is the convertible-only sum (600 + 0)", totalDebtPaid(rows, realCtx) === 600);
}

// ── base rollup semantics (merged from lib/debt.test.ts, TEST-2) ──────────────
// The equivalence gates above compare CODE PATHS (no-ctx vs identity-ctx). These
// pin the literal base semantics that nothing else does: flow-predicate
// exclusion, mixed-sign abs-sum, group-by-account, descending sort by total, and
// per-account count. Block-scoped so its `tx`/`mixed` locals stay isolated.
{
  const tx = (accountId: string, amount: number, flowType: string | null): DebtPaymentTxnLike =>
    ({ accountId, amount, flowType });

  check("empty input → 0", totalDebtPaid([]) === 0);
  check(
    "non-DEBT_PAYMENT rows ignored",
    totalDebtPaid([tx("a", -50, "SPENDING"), tx("a", 100, "INCOME"), tx("a", -35, "FEE")]) === 0,
  );
  check(
    "null flowType excluded (legacy Payment rows not counted by flow predicate)",
    totalDebtPaid([tx("a", -300, null)]) === 0,
  );
  check(
    "abs-sums across mixed signs (INTERNAL negative + INFLOW positive legs)",
    totalDebtPaid([tx("a", -300, "DEBT_PAYMENT"), tx("b", 200, "DEBT_PAYMENT")]) === 500,
    `got ${totalDebtPaid([tx("a", -300, "DEBT_PAYMENT"), tx("b", 200, "DEBT_PAYMENT")])}`,
  );

  check("empty input → empty rollup", rollupDebtPaymentsByAccount([]).length === 0);
  const mixedRows = [
    tx("amex", -300, "DEBT_PAYMENT"),
    tx("chase", 500, "DEBT_PAYMENT"),
    tx("amex", -100, "DEBT_PAYMENT"),
    tx("amex", -20, "SPENDING"), // purchase on the card — not a payment
    tx("chase", -15, null), // unclassified — excluded
  ];
  const rollup = rollupDebtPaymentsByAccount(mixedRows);
  check("groups by account id", rollup.length === 2, `got ${rollup.length} entries`);
  check(
    "sorted descending by total",
    rollup[0]?.accountId === "chase" && rollup[0]?.total === 500,
    `got [0]=${rollup[0]?.accountId}:${rollup[0]?.total}`,
  );
  check(
    "per-account total + count (abs-summed)",
    rollup[1]?.accountId === "amex" && rollup[1]?.total === 400 && rollup[1]?.count === 2,
    `got [1]=${rollup[1]?.accountId}:${rollup[1]?.total} count=${rollup[1]?.count}`,
  );
  check(
    "rollup totals reconcile to totalDebtPaid over the same rows",
    rollup.reduce((s, e) => s + e.total, 0) === totalDebtPaid(mixedRows),
  );
}

if (failures.length > 0) {
  console.error(`\nMC1 P3 debt equivalence gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 debt equivalence gates: all ${passed} checks passed.`);
process.exit(0);

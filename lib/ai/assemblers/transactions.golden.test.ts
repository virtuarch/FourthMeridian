/**
 * lib/ai/assemblers/transactions.golden.test.ts
 *
 * MC1 Phase 2 Slice 4 — byte-identical golden gate for the AI transaction
 * accumulators, exercised through the exported pure seam buildMonthlyBreakdown
 * (the same monthly/category/flow accumulation rules as the assembler's main
 * window loop — see the "same rules as the main loop" contract in the source).
 * With ctx omitted the function runs the pre-threading raw path (kd17's call
 * shape); with the assembler's identityContext the output must be
 * byte-identical. Flow totals (income/expense/refund/debtPayment/transfer per
 * month) ARE the server-side flow-total surface, so this gate covers both the
 * "AI transaction summary" and "flow totals" golden requirements at the pure
 * seam. The main-loop accumulators use the identical amountInTarget helper —
 * same identity guarantee by construction; kd17's invariant/tripwire suite
 * remains the regression net over the loop's KD-17 rules.
 *
 * NOTE: importing the assembler transitively constructs the Prisma client
 * (lib/db) — no query is issued; pure fixtures only (same note as kd17).
 */

import { buildMonthlyBreakdown } from "./transactions";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

// TxnRow-shaped fixtures (category cast — enum values are plain strings at runtime).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(dateISO: string, amount: number, flowType: string, category: string, currency: string | null, pending = false): any {
  return {
    date: new Date(`${dateISO}T00:00:00Z`),
    merchant: "M",
    category,
    amount,
    pending,
    currency,
    flowType,
    flowDirection: null,
  };
}

const settled = [
  row("2026-05-03", -120.55, "SPENDING", "Food", "USD"),
  row("2026-05-10", 2500,    "INCOME",   "Income", "USD"),
  row("2026-05-12", -300,    "DEBT_PAYMENT", "Payment", "USD"),
  row("2026-05-14", 45.5,    "REFUND",   "Shopping", "USD"),
  row("2026-05-20", -80,     "TRANSFER", "Transfer", "USD"),
  row("2026-06-01", -60.25,  "FEE",      "Fees", "USD"),
  row("2026-06-02", -10,     "SPENDING", "Food", null),      // Phase 0 null-residue
  row("2026-06-05", 15,      "SPENDING", "Food", "USD"),     // credit in a spending category (KD-17)
];
const pending = [row("2026-06-06", -25, "SPENDING", "Food", "USD", true)];

// ── golden: with vs without identity ctx byte-identical ──────────────────────

{
  const without = buildMonthlyBreakdown(settled, pending, "2026-05-01", "2026-06-30", null);
  const withCtx = buildMonthlyBreakdown(settled, pending, "2026-05-01", "2026-06-30", null, CTX);
  check("golden: monthly breakdown byte-identical (USD fixture incl. null-residue)",
    JSON.stringify(without) === JSON.stringify(withCtx));
  check("golden: flow totals identical per month",
    without[0].incomeTotal === withCtx[0].incomeTotal &&
    without[0].debtPaymentTotal === withCtx[0].debtPaymentTotal &&
    without[0].transferTotal === withCtx[0].transferTotal &&
    without[0].refundTotal === withCtx[0].refundTotal &&
    without[1].expenseTotal === withCtx[1].expenseTotal);
}

// ── golden: mixed/non-USD rows still byte-identical under identity ───────────

{
  const mixed = [
    ...settled,
    row("2026-06-07", -200, "SPENDING", "Food", "EUR"),
    row("2026-06-08", -50,  "SPENDING", "Travel", "SAR"),
  ];
  const a = buildMonthlyBreakdown(mixed, [], "2026-05-01", "2026-06-30", null);
  const b = buildMonthlyBreakdown(mixed, [], "2026-05-01", "2026-06-30", null, CTX);
  check("golden: mixed-currency months byte-identical under identity", JSON.stringify(a) === JSON.stringify(b));
}

// ── truncated-month flag unaffected by threading ──────────────────────────────

{
  const a = buildMonthlyBreakdown(settled, [], "2026-05-01", "2026-06-30", "2026-05");
  const b = buildMonthlyBreakdown(settled, [], "2026-05-01", "2026-06-30", "2026-05", CTX);
  check("golden: KD-7 truncated-month handling byte-identical", JSON.stringify(a) === JSON.stringify(b));
}

// ── seam liveness (unit-level only — NOT product behavior) ────────────────────

{
  const realCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR"
        ? { kind: "rate", rate: 1.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const rows = [row("2026-06-07", -200, "SPENDING", "Food", "EUR")];
  const m = buildMonthlyBreakdown(rows, [], "2026-06-01", "2026-06-30", null, realCtx);
  check("seam live: EUR spending converts at row date (200 × 1.5 = 300)", m[0].expenseTotal === 300);
  const missRows = [row("2026-06-07", -100, "SPENDING", "Food", "SAR")];
  const mm = buildMonthlyBreakdown(missRows, [], "2026-06-01", "2026-06-30", null, realCtx);
  check("seam live: missed rate stays native (D-3)", mm[0].expenseTotal === 100);
}

if (failures.length > 0) {
  console.error(`\nMC1 P2 assembler goldens: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P2 assembler goldens: all ${passed} checks passed.`);
process.exit(0);

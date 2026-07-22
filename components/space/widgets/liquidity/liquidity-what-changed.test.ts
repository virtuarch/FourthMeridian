/**
 * components/space/widgets/liquidity/liquidity-what-changed.test.ts
 *
 * S4 — pure tests for the What Changed row-builder. Deterministic (explicit
 * period + injected clock), DB-free (house pattern):
 *
 *   npx tsx components/space/widgets/liquidity/liquidity-what-changed.test.ts
 *
 * Locks: loading / empty sentinels; top cash-in + cash-out driver rows with
 * signed amounts (in positive, out negative) and the ≤3-per-side cap.
 */

import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { type LiquidityTx } from "@/lib/transactions/liquidity";
import { buildWhatChangedRows } from "./liquidity-what-changed";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CLOCK = () => new Date(2026, 5, 15); // 2026-06-15 local

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Groceries",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}

const accounts = [{ id: "chk", type: "checking" }];
const rows: LiquidityTx[] = [
  tx({ amount: 5000, date: "2026-05-04", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -200, date: "2026-05-12", category: "Groceries", flowType: "SPENDING" }),
  tx({ amount: -80,  date: "2026-05-20", category: "Dining",    flowType: "SPENDING" }),
];
const MAY: CashFlowPeriod = { kind: "month", year: 2026, month: 5 };
const JAN: CashFlowPeriod = { kind: "month", year: 2026, month: 1 }; // no data

console.log("1. Loading / empty sentinels");
{
  check("null transactions ⇒ loading", buildWhatChangedRows({ transactions: null, accounts, period: MAY, now: CLOCK }).state === "loading");
  check("no rows in the window ⇒ empty", buildWhatChangedRows({ transactions: rows, accounts, period: JAN, now: CLOCK }).state === "empty");
  check("empty transactions ⇒ empty", buildWhatChangedRows({ transactions: [], accounts, period: MAY, now: CLOCK }).state === "empty");
}

console.log("2. Top drivers — signed, in positive / out negative");
{
  const r = buildWhatChangedRows({ transactions: rows, accounts, period: MAY, now: CLOCK });
  check("state ok", r.state === "ok");
  if (r.state === "ok") {
    const inRows = r.rows.filter((x) => x.direction === "in");
    const outRows = r.rows.filter((x) => x.direction === "out");
    check("has a cash-in driver with positive amount", inRows.length > 0 && inRows.every((x) => x.amount > 0), JSON.stringify(inRows));
    check("has a cash-out driver with negative amount", outRows.length > 0 && outRows.every((x) => x.amount < 0), JSON.stringify(outRows));
    check("cash-in driver equals the income (5000)", inRows[0].amount === 5000, `${inRows[0].amount}`);
    check("cash-out driver equals the combined spend (−280)", outRows[0].amount === -280, `${outRows[0].amount}`);
    check("at most 3 cash-in rows", inRows.length <= 3, `${inRows.length}`);
    check("at most 3 cash-out rows", outRows.length <= 3, `${outRows.length}`);
    check("netCash reconciles (5000 − 280)", Math.round(r.netCash) === 4720, `${r.netCash}`);
  }
}

if (failures > 0) { console.error(`\n${failures} liquidity-what-changed check(s) failed`); process.exit(1); }
console.log("\nAll liquidity-what-changed checks passed");

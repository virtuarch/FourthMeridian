/**
 * components/space/widgets/cashflow/cash-flow-insights.test.ts
 *
 * S4 — pure tests for the Key Insights bullet-builder. Deterministic (injected
 * clock), DB-free (house pattern):
 *
 *   npx tsx components/space/widgets/cashflow/cash-flow-insights.test.ts
 *
 * Locks:
 *   1. previousEquivalentPeriod — explicit month/quarter/year step-back with
 *      rollover; to-date MTD/QTD/YTD → previous full calendar period; WTD /
 *      rolling / ALL → null (no fabricated window).
 *   2. buildCashFlowInsights — compare bullet present only when a "then" exists;
 *      top-category / top-source / credit bullets; empty ⇒ single "none" bullet;
 *      loading (null) ⇒ no bullets; the incomplete-tier caveat is the final line
 *      and the list stays ≤5.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { type LiquidityTx } from "@/lib/transactions/liquidity";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { previousEquivalentPeriod, buildCashFlowInsights } from "./cash-flow-insights";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const keyOf = (p: CashFlowPeriod | null): string => (p == null ? "null" : typeof p === "string" ? p : JSON.stringify(p));

// Fixed local clock (periodRange reads local Y/M/D). 2026-06-15 ⇒ current quarter Q2.
const CLOCK = () => new Date(2026, 5, 15);

let n = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Groceries",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}

console.log("1. previousEquivalentPeriod — explicit step-back with rollover");
{
  check("month June 2026 → May 2026", keyOf(previousEquivalentPeriod({ kind: "month", year: 2026, month: 6 }, CLOCK())) === keyOf({ kind: "month", year: 2026, month: 5 }));
  check("month Jan 2026 → Dec 2025 (year rollover)", keyOf(previousEquivalentPeriod({ kind: "month", year: 2026, month: 1 }, CLOCK())) === keyOf({ kind: "month", year: 2025, month: 12 }));
  check("quarter Q3 2026 → Q2 2026", keyOf(previousEquivalentPeriod({ kind: "quarter", year: 2026, quarter: 3 }, CLOCK())) === keyOf({ kind: "quarter", year: 2026, quarter: 2 }));
  check("quarter Q1 2026 → Q4 2025 (year rollover)", keyOf(previousEquivalentPeriod({ kind: "quarter", year: 2026, quarter: 1 }, CLOCK())) === keyOf({ kind: "quarter", year: 2025, quarter: 4 }));
  check("year 2026 → 2025", keyOf(previousEquivalentPeriod({ kind: "year", year: 2026 }, CLOCK())) === keyOf({ kind: "year", year: 2025 }));
}

console.log("2. previousEquivalentPeriod — to-date maps to previous full calendar period; others null");
{
  check("MTD (June) → full month May 2026", keyOf(previousEquivalentPeriod("MTD", CLOCK())) === keyOf({ kind: "month", year: 2026, month: 5 }));
  check("QTD (Q2) → full quarter Q1 2026", keyOf(previousEquivalentPeriod("QTD", CLOCK())) === keyOf({ kind: "quarter", year: 2026, quarter: 1 }));
  check("YTD → full year 2025", keyOf(previousEquivalentPeriod("YTD", CLOCK())) === keyOf({ kind: "year", year: 2025 }));
  check("WTD → null (no calendar-week equivalent)", previousEquivalentPeriod("WTD", CLOCK()) === null);
  check("PAST_MONTH → null (rolling)", previousEquivalentPeriod("PAST_MONTH", CLOCK()) === null);
  check("ALL → null", previousEquivalentPeriod("ALL", CLOCK()) === null);
}

// History spans 2026-04 → 2026-06 on a liquid checking account.
const rows: LiquidityTx[] = [
  tx({ amount: 5000, date: "2026-04-03", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -100, date: "2026-04-10", category: "Groceries", flowType: "SPENDING" }),
  tx({ amount: 5200, date: "2026-05-04", category: "Income",    flowType: "INCOME" }),
  tx({ amount: -200, date: "2026-05-12", category: "Groceries", flowType: "SPENDING" }),
  tx({ amount: -80,  date: "2026-05-20", category: "Dining",    flowType: "SPENDING" }),
  tx({ amount: 30,   date: "2026-05-25", category: "Groceries", flowType: "REFUND" }),
];
const accounts = [{ id: "chk", type: "checking" }];
const MAY: CashFlowPeriod = { kind: "month", year: 2026, month: 5 };

console.log("3. buildCashFlowInsights — compare present for an explicit period, top category + source");
{
  const ins = buildCashFlowInsights({ transactions: rows, accounts, period: MAY, perspective: "economic", now: CLOCK });
  const ids = ins.map((i) => i.id);
  check("compare bullet present (then = April 2026)", ids.includes("compare-net"));
  check("compare bullet names the previous period label", ins.find((i) => i.id === "compare-net")!.text.includes("April 2026"));
  check("top spending category is Groceries", ins.some((i) => i.id === "top-category" && /Groceries/.test(i.text)));
  check("a top income source bullet is present", ids.includes("top-source"));
  check("no fabricated credit bullet (all liquid)", !ids.includes("credit"));
  check("at most 5 bullets", ins.length <= 5, `${ins.length}`);
}

console.log("4. buildCashFlowInsights — no then for ALL / rolling (honestly omitted)");
{
  const insAll = buildCashFlowInsights({ transactions: rows, accounts, period: "ALL", perspective: "economic", now: CLOCK });
  check("ALL: no compare bullet", !insAll.some((i) => i.id === "compare-net"));
  check("ALL: still surfaces non-compare bullets", insAll.length > 0 && insAll[0].id !== "none");
}

console.log("5. buildCashFlowInsights — loading and empty degrade honestly");
{
  check("null transactions ⇒ no bullets (loading)", buildCashFlowInsights({ transactions: null, accounts, period: MAY, perspective: "economic", now: CLOCK }).length === 0);
  const empty = buildCashFlowInsights({ transactions: [], accounts, period: MAY, perspective: "economic", now: CLOCK });
  check("empty period ⇒ single 'none' bullet", empty.length === 1 && empty[0].id === "none");
}

console.log("6. buildCashFlowInsights — credit usage + incomplete caveat is the final line, ≤5 total");
{
  // A liability-account cost flow ⇒ creditCardSpending > 0. Give MAY enough bullets
  // (compare + category + source + credit) so the caveat forces a cap to ≤5.
  const ccRows: LiquidityTx[] = [
    ...rows,
    tx({ amount: -300, date: "2026-05-18", category: "Shopping", flowType: "SPENDING", accountId: "cc", financialAccountId: "cc" }),
  ];
  const ccAccounts = [{ id: "chk", type: "checking" }, { id: "cc", type: "debt" }];
  const stamp: CashFlowStamp = { completeness: { tier: "incomplete", conflict: false, reason: "Requested period reaches before cash-flow history begins on 2026-04-03.", coverageFrom: "2026-04-03" }, dataAsOf: "2026-06-10" };
  const ins = buildCashFlowInsights({ transactions: ccRows, accounts: ccAccounts, period: MAY, perspective: "economic", now: CLOCK, stamp });
  check("credit bullet present when spend is charged to a liability", ins.some((i) => i.id === "credit"));
  check("incomplete caveat is the final bullet", ins[ins.length - 1].id === "completeness");
  check("caveat carries the stamp reason", /2026-04-03/.test(ins[ins.length - 1].text));
  check("total bullets ≤ 5 with the caveat", ins.length <= 5, `${ins.length}`);

  // No caveat when the stamp is observed.
  const obs = buildCashFlowInsights({ transactions: ccRows, accounts: ccAccounts, period: MAY, perspective: "economic", now: CLOCK, stamp: { completeness: { tier: "observed", conflict: false, reason: "ok" }, dataAsOf: "2026-06-10" } });
  check("observed stamp ⇒ no completeness caveat", !obs.some((i) => i.id === "completeness"));
}

console.log("7. P2-1B — credit insight is a two-fact statement (no unpaid-balance overclaim)");
{
  const ccAccounts = [{ id: "chk", type: "checking" }, { id: "cc", type: "debt" }];
  const creditSpend = tx({ amount: -300, date: "2026-05-18", category: "Shopping", flowType: "SPENDING", accountId: "cc", financialAccountId: "cc" });
  const debtPay = tx({ amount: -800, date: "2026-05-20", category: "Payment", flowType: "DEBT_PAYMENT" }); // liquid chk → debt payment

  // (a) credit spend + visible debt payments → combined two-fact sentence.
  const combined = buildCashFlowInsights({ transactions: [...rows, creditSpend, debtPay], accounts: ccAccounts, period: MAY, perspective: "economic", now: CLOCK });
  const cCombined = combined.find((i) => i.id === "credit")!;
  check("combined bullet present", !!cCombined);
  check("combined bullet states BOTH facts (on credit + debt payments)",
    /went on credit this period/.test(cCombined.text) && /of cash went to debt payments/.test(cCombined.text));
  check("combined bullet carries the no-subtraction clarifier (earlier periods)",
    /earlier periods/.test(cCombined.text) && /won.t necessarily match/.test(cCombined.text));
  check("combined bullet NEVER implies unpaid balance / subtraction",
    !/isn.t yet paid|not yet paid|remaining|unpaid|exceeded/i.test(cCombined.text));

  // (b) credit spend + ZERO visible debt payments → timing-only fallback.
  const fallback = buildCashFlowInsights({ transactions: [...rows, creditSpend], accounts: ccAccounts, period: MAY, perspective: "economic", now: CLOCK });
  const cFallback = fallback.find((i) => i.id === "credit")!;
  check("fallback bullet is the timing sentence", /counts as spending now/.test(cFallback.text) && /the cash leaves when you pay the balance/.test(cFallback.text));
  check("fallback bullet drops the old 'not yet paid as cash' overclaim", !/not yet paid as cash|isn.t yet paid as cash/i.test(cFallback.text));
  check("fallback bullet never announces a $0 debt payment", !/debt payments/.test(cFallback.text));

  // (c) no liability spend → no credit bullet at all (all-liquid fixture).
  const liquidOnly = buildCashFlowInsights({ transactions: rows, accounts, period: MAY, perspective: "economic", now: CLOCK });
  check("no credit bullet when nothing is charged to a liability", !liquidOnly.some((i) => i.id === "credit"));

  // (d) compare-net noun is perspective-aware.
  const ecoCmp = buildCashFlowInsights({ transactions: rows, accounts, period: MAY, perspective: "economic", now: CLOCK }).find((i) => i.id === "compare-net")!;
  const liqCmp = buildCashFlowInsights({ transactions: rows, accounts, period: MAY, perspective: "liquidity", now: CLOCK }).find((i) => i.id === "compare-net")!;
  check("economic compare → 'Income after spending' (not 'Net cash')", /Income after spending/.test(ecoCmp.text) && !/Net cash/.test(ecoCmp.text));
  check("liquidity compare → 'Net cash' (not 'Income after spending')", /Net cash/.test(liqCmp.text) && !/Income after spending/.test(liqCmp.text));
}

console.log("8. P2-1B — source-scan: overclaim wording removed, no subtraction");
{
  const insSrc = readFileSync(join(process.cwd(), "components", "space", "widgets", "cashflow", "cash-flow-insights.ts"), "utf8");
  const sumSrc = readFileSync(join(process.cwd(), "components", "space", "widgets", "CashFlowSummaryWidget.tsx"), "utf8");
  check("insights: 'isn't yet paid as cash' is gone", !/isn.t yet paid as cash/.test(insSrc));
  check("insights: 'not yet paid as cash' is gone", !/not yet paid as cash/.test(insSrc));
  check("Summary context row: 'not yet paid as cash' is gone", !/not yet paid as cash/.test(sumSrc));
  // Arithmetic guard runs on comment-stripped CODE (a comment can't be a subtraction).
  const insCode = insSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("insights: credit spend is never subtracted from debt payments (no unpaid-debt math)",
    !/creditCardSpending\s*[-−]\s*[^;]*DEBT_PAYMENT/.test(insCode) && !/DEBT_PAYMENT[^;]*[-−]\s*[^;]*creditCardSpending/.test(insCode));
}

if (failures > 0) { console.error(`\n${failures} cash-flow-insights check(s) failed`); process.exit(1); }
console.log("\nAll cash-flow-insights checks passed");

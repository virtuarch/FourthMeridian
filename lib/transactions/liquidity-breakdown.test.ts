/**
 * lib/transactions/liquidity-breakdown.test.ts
 *
 * Cash Flow Summary consuming the LIQUIDITY axis — proves the summary's headline
 * (the DayFacts fold, aggregateDayFacts) and its reason breakdown (the pure
 * projection groupLiquidityByReason(facts)) agree, and that the economic axis is
 * untouched. Also pins the LIQUIDITY_REASON_SIDE partition by exercising real
 * reasons. Runnable with tsx.
 */

import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { aggregateDayFacts, economicSpend } from "@/lib/transactions/cash-flow-projection";
import type { FlowType, TransactionCategory } from "@/types";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const ACCOUNTS = [
  { id: "chk",  type: "checking" },  // liquid
  { id: "sav",  type: "savings" },   // liquid
  { id: "cb",   type: "crypto" },    // asset (Coinbase)
  { id: "card", type: "debt" },      // liability (credit card)
];
const ctx = tierResolver(ACCOUNTS);

function tx(over: Partial<LiquidityTx> & { ownAccount: string; amount: number; flowType: FlowType }): LiquidityTx {
  const { ownAccount, ...rest } = over;
  return {
    id: `${ownAccount}-${rest.amount}-${rest.flowType}-${Math.random()}`,
    accountId: ownAccount, financialAccountId: ownAccount,
    date: "2026-02-27", merchant: "m", category: "Other" as TransactionCategory, pending: false,
    ...rest,
  } as LiquidityTx;
}

// ── Feb 27 Coinbase → Chase: two transfers → Asset Liquidation under Cash In ────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 8141.98, flowType: "TRANSFER", counterpartyAccountId: "cb" }),
    tx({ ownAccount: "chk", amount: 1902.12, flowType: "TRANSFER", counterpartyAccountId: "cb" }),
  ];
  const f = aggregateDayFacts(rows, ctx);
  const bd = groupLiquidityByReason(f);
  check("Feb 27 Coinbase→Chase: Cash In = 8141.98 + 1902.12 = 10044.10",
    Math.abs(f.cashIn - 10044.10) < 1e-9, JSON.stringify(f));
  check("Feb 27: breakdown line is Asset liquidation with the full total",
    bd.cashIn.length === 1 && bd.cashIn[0].reason === "ASSET_LIQUIDATION" &&
    bd.cashIn[0].label === "Asset liquidation" &&
    Math.abs(bd.cashIn[0].amount - 10044.10) < 1e-9, JSON.stringify(bd.cashIn));
  check("Feb 27: not classified as earned income", !bd.cashIn.some((l) => l.reason === "EARNED_INCOME"));
}

// ── Salary + liquidation compose correctly ─────────────────────────────────────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 6000, flowType: "INCOME" }),
    tx({ ownAccount: "chk", amount: 10044, flowType: "TRANSFER", counterpartyAccountId: "cb" }),
    tx({ ownAccount: "chk", amount: -1500, flowType: "SPENDING" }),
    tx({ ownAccount: "cb",  amount: 10044, flowType: "INVESTMENT" }),  // the sale itself → neutral
  ];
  const f = aggregateDayFacts(rows, ctx);
  const bd = groupLiquidityByReason(f);

  check("salary+liquidation: Cash In = 16044 (DayFacts)", f.cashIn === 16044);
  check("salary+liquidation: Cash Out = 1500", f.cashOut === 1500);
  check("salary+liquidation: Net Cash = 14544", f.cashIn - f.cashOut === 14544);

  const earned = bd.cashIn.find((l) => l.reason === "EARNED_INCOME");
  const liq    = bd.cashIn.find((l) => l.reason === "ASSET_LIQUIDATION");
  check("breakdown splits earned income ($6,000) and asset liquidation ($10,044)",
    earned?.amount === 6000 && liq?.amount === 10044, JSON.stringify(bd.cashIn));
  check("breakdown is descending (liquidation before earned income)",
    bd.cashIn[0].reason === "ASSET_LIQUIDATION" && bd.cashIn[1].reason === "EARNED_INCOME");
  check("Cash Out breakdown = Spending $1,500",
    bd.cashOut.length === 1 && bd.cashOut[0].reason === "REAL_COST" && bd.cashOut[0].amount === 1500);

  // Drill-down totals match displayed values (headline == sum of breakdown lines).
  check("Cash In breakdown total === displayed Cash In",
    bd.cashInTotal === f.cashIn && bd.cashIn.reduce((s, l) => s + l.amount, 0) === f.cashIn);
  check("Cash Out breakdown total === displayed Cash Out",
    bd.cashOutTotal === f.cashOut && bd.cashOut.reduce((s, l) => s + l.amount, 0) === f.cashOut);

  // Economic axis unchanged — crypto sale is NOT income economically.
  check("economic axis income = 6000 only (crypto NOT income)", f.income === 6000);
  check("economic axis === economicTotals (unchanged)",
    f.income === economicTotals(rows).income &&
    economicSpend(f) === economicTotals(rows).spend &&
    (f.income - economicSpend(f)) === economicTotals(rows).net);
}

// ── Non-zero only + unresolved surfaced separately ─────────────────────────────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 500, flowType: "TRANSFER" }),  // unknown counterparty → unresolved
    tx({ ownAccount: "chk", amount: 200, flowType: "INCOME" }),
  ];
  const bd = groupLiquidityByReason(aggregateDayFacts(rows, ctx));
  check("breakdown lists only non-zero reasons",
    bd.cashIn.every((l) => l.amount > 0) && bd.cashOut.every((l) => l.amount > 0));
  check("Cash In has only Earned income (unresolved not counted as cash in)",
    bd.cashIn.length === 1 && bd.cashIn[0].reason === "EARNED_INCOME" && bd.cashInTotal === 200);
  check("unresolved surfaced separately (500), excluded from net", bd.unresolved === 500 && bd.netCash === 200);
}

// ── Q2-style case: direct cash spending vs card purchases vs debt payments ─────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk",  amount: -73,     flowType: "SPENDING" }),      // direct cash spending (liquid)
    tx({ ownAccount: "chk",  amount: -30829,  flowType: "DEBT_PAYMENT" }),  // paid the card (cash out)
    tx({ ownAccount: "card", amount: -23047,  flowType: "SPENDING" }),      // credit card purchases (context)
  ];
  const f = aggregateDayFacts(rows, ctx);
  const bd = groupLiquidityByReason(f);

  check("Cash Out = direct cash spending + debt payments (73 + 30829 = 30902)",
    f.cashOut === 30902 && bd.cashOutTotal === 30902, JSON.stringify(f));
  check("Cash Out does NOT double-count credit-card purchases",
    f.cashOut === 30902 && !bd.cashOut.some((l) => l.amount === 23047));
  check("direct cash spending row = REAL_COST relabeled 'Direct cash spending' ($73)",
    bd.cashOut.some((l) => l.reason === "REAL_COST" && l.label === "Direct cash spending" && l.amount === 73));
  check("debt payments row present ($30,829)",
    bd.cashOut.some((l) => l.reason === "DEBT_PAYMENT" && l.amount === 30829));
  check("credit card purchases surfaced as context ($23,047), liability-tier SPENDING",
    bd.creditCardPurchases === 23047);
  check("credit card purchases NOT in cashOut total (context is separate)",
    bd.cashOutTotal === 30902 && bd.cashOutTotal !== bd.cashOutTotal + bd.creditCardPurchases);
  check("Cash Out breakdown lines sum to displayed Cash Out (no context leakage)",
    bd.cashOut.reduce((s, l) => s + l.amount, 0) === f.cashOut);
}

// ── Context rows composition: none enter Cash Out ──────────────────────────────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk",  amount: -73,    flowType: "SPENDING" }),                                  // Cash Out: direct cash
    tx({ ownAccount: "chk",  amount: -30829, flowType: "DEBT_PAYMENT" }),                              // Cash Out: debt payment
    tx({ ownAccount: "card", amount: -23047, flowType: "SPENDING" }),                                  // context: credit card
    tx({ ownAccount: "chk",  amount: -500,   flowType: "TRANSFER", counterpartyAccountId: "sav" }),    // context: internal (liquid→liquid)
    tx({ ownAccount: "chk",  amount: 800,    flowType: "TRANSFER" }),                                  // context: unresolved (unknown cp)
  ];
  const f = aggregateDayFacts(rows, ctx);
  const bd = groupLiquidityByReason(f);

  check("Cash Out = direct cash + debt payments only (30902)", f.cashOut === 30902 && bd.cashOutTotal === 30902);
  check("credit card purchases context = 23047", bd.creditCardPurchases === 23047);
  check("internal transfers context = 500 (liquid↔liquid)", bd.internalTransfers === 500);
  check("unresolved context = 800 (unknown counterparty)", bd.unresolved === 800);
  check("no context figure is inside Cash Out total",
    bd.cashOutTotal === 30902 &&
    !bd.cashOut.some((l) => l.amount === 23047 || l.amount === 500 || l.amount === 800));
  check("Cash Out lines still only Direct cash spending + Debt payments",
    bd.cashOut.map((l) => l.reason).sort().join(",") === "DEBT_PAYMENT,REAL_COST");
}

// credit-card purchases figure ignores liquid-account cost flows (those are Cash Out)
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk",  amount: -100, flowType: "SPENDING" }),  // liquid → direct cash spending
    tx({ ownAccount: "card", amount: -250, flowType: "SPENDING" }),  // liability → credit purchase
  ];
  const bd = groupLiquidityByReason(aggregateDayFacts(rows, ctx));
  check("creditCardPurchases = only liability-tier cost flows (250, not 350)", bd.creditCardPurchases === 250);
  check("direct cash spending still in Cash Out (100)",
    bd.cashOutTotal === 100 && bd.cashOut.some((l) => l.reason === "REAL_COST" && l.amount === 100));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Liquidity breakdown tests FAILED."); process.exit(1); }
console.log("Liquidity breakdown tests passed.");
process.exit(0);

/**
 * lib/transactions/liquidity.test.ts
 *
 * Cash Flow LIQUIDITY axis — pure derivation. Runnable with tsx:
 *   npx tsx lib/transactions/liquidity.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module (no DB/React).
 */

import {
  classifyLiquidity,
  deriveCashFlowAxes,
  tierResolver,
  type LiquidityTx,
  type LiquidityContext,
} from "@/lib/transactions/liquidity";
import { aggregateCashFlow } from "@/lib/transactions/cash-flow";
import type { FlowType, FlowDirection, TransactionCategory } from "@/types";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// Account universe (id → type) — the caller's tier resolver reads these.
const ACCOUNTS = [
  { id: "chk",  type: "checking" },   // liquid
  { id: "sav",  type: "savings" },    // liquid
  { id: "brk",  type: "investment" }, // asset
  { id: "cb",   type: "crypto" },     // asset (Coinbase-like)
  { id: "card", type: "debt" },       // liability
  { id: "loan", type: "debt" },       // liability
];
const ctx: LiquidityContext = tierResolver(ACCOUNTS);

function tx(over: Partial<LiquidityTx> & { ownAccount: string; amount: number; flowType: FlowType }): LiquidityTx {
  const { ownAccount, ...rest } = over;
  return {
    id: `${ownAccount}-${rest.amount}-${rest.flowType}-${Math.random()}`,
    accountId: ownAccount,
    financialAccountId: ownAccount,
    date: "2026-02-27",
    merchant: "m",
    category: "Other" as TransactionCategory,
    pending: false,
    ...rest,
  } as LiquidityTx;
}

const cls = (o: Parameters<typeof tx>[0]) => classifyLiquidity(tx(o), ctx);

// ── Validation scenarios ──────────────────────────────────────────────────────

// paycheck → checking : earned income + liquidity in
{
  const c = cls({ ownAccount: "chk", amount: 3800, flowType: "INCOME" });
  check("paycheck → checking = CASH_IN / EARNED_INCOME",
    c.effect === "CASH_IN" && c.reason === "EARNED_INCOME", JSON.stringify(c));
}

// income routed into a brokerage (asset) : earned but not spendable → neutral
{
  const c = cls({ ownAccount: "brk", amount: 88, flowType: "INCOME" });
  check("income into asset account = NEUTRAL / EARNED_INCOME (not spendable)",
    c.effect === "NEUTRAL" && c.reason === "EARNED_INCOME");
}

// Coinbase (asset) → Chase (liquid) : asset liquidation + liquidity in
{
  const c = cls({ ownAccount: "chk", amount: 8141.98, flowType: "TRANSFER", counterpartyAccountId: "cb" });
  check("asset → liquid = CASH_IN / ASSET_LIQUIDATION (crypto sale proceeds)",
    c.effect === "CASH_IN" && c.reason === "ASSET_LIQUIDATION", JSON.stringify(c));
  check("asset liquidation is NOT earned income", c.reason !== "EARNED_INCOME");
}

// Chase (liquid) → brokerage (asset) : asset deployment + liquidity out
{
  const c = cls({ ownAccount: "chk", amount: -2000, flowType: "TRANSFER", counterpartyAccountId: "brk" });
  check("liquid → asset = CASH_OUT / ASSET_DEPLOYMENT",
    c.effect === "CASH_OUT" && c.reason === "ASSET_DEPLOYMENT", JSON.stringify(c));
}

// checking → savings : neutral (both liquid)
{
  const c = cls({ ownAccount: "chk", amount: -500, flowType: "TRANSFER", counterpartyAccountId: "sav" });
  check("liquid → liquid = NEUTRAL / INTERNAL_TRANSFER",
    c.effect === "NEUTRAL" && c.reason === "INTERNAL_TRANSFER");
}

// checking → credit card : debt payment + liquidity out
{
  const c1 = cls({ ownAccount: "chk", amount: -300, flowType: "TRANSFER", counterpartyAccountId: "card" });
  check("checking → credit card (TRANSFER) = CASH_OUT / DEBT_PAYMENT",
    c1.effect === "CASH_OUT" && c1.reason === "DEBT_PAYMENT", JSON.stringify(c1));
  const c2 = cls({ ownAccount: "chk", amount: -300, flowType: "DEBT_PAYMENT" });
  check("checking → credit card (DEBT_PAYMENT flowType) = CASH_OUT / DEBT_PAYMENT",
    c2.effect === "CASH_OUT" && c2.reason === "DEBT_PAYMENT");
}

// loan proceeds (liability → checking) : debt proceeds + liquidity in
{
  const c = cls({ ownAccount: "chk", amount: 10000, flowType: "TRANSFER", counterpartyAccountId: "loan" });
  check("loan → checking = CASH_IN / DEBT_PROCEEDS (borrowed, NOT income)",
    c.effect === "CASH_IN" && c.reason === "DEBT_PROCEEDS", JSON.stringify(c));
  check("debt proceeds is not earned income", c.reason !== "EARNED_INCOME");
}

// unknown counterparty transfer into liquid : unresolved (not guessed), low conf
{
  const c = cls({ ownAccount: "chk", amount: 8141.98, flowType: "TRANSFER" }); // no counterpartyAccountId
  check("transfer into liquid, unknown counterparty = UNRESOLVED, low confidence",
    c.effect === "UNRESOLVED" && c.reason === "UNRESOLVED" && c.confidence <= 0.3, JSON.stringify(c));
}

// crypto/stock sale that STAYS on the platform (INVESTMENT on asset acct) : neutral, never income
{
  const c = cls({ ownAccount: "cb", amount: 1500, flowType: "INVESTMENT" });
  check("INVESTMENT on asset account = NEUTRAL / ASSET_CONVERSION (never income)",
    c.effect === "NEUTRAL" && c.reason === "ASSET_CONVERSION" && c.reason !== ("EARNED_INCOME" as string));
}

// BTC outbound send (INVESTMENT on crypto wallet) : neutral, not spending, not income
{
  const c = cls({ ownAccount: "cb", amount: -0.085, flowType: "INVESTMENT", flowDirection: "INTERNAL" as FlowDirection });
  check("BTC send (INVESTMENT) = NEUTRAL, not CASH_OUT/CASH_IN",
    c.effect === "NEUTRAL" && c.reason === "ASSET_CONVERSION");
}

// spending from checking (liquid) : real cost, cash out
{
  const c = cls({ ownAccount: "chk", amount: -92.4, flowType: "SPENDING" });
  check("SPENDING from liquid = CASH_OUT / REAL_COST", c.effect === "CASH_OUT" && c.reason === "REAL_COST");
}

// spending on a credit card (liability) : cost incurred, but no spendable cash moved yet
{
  const c = cls({ ownAccount: "card", amount: -92.4, flowType: "SPENDING" });
  check("SPENDING on credit card = NEUTRAL / REAL_COST (spendable drain deferred to payment)",
    c.effect === "NEUTRAL" && c.reason === "REAL_COST");
}

// refund back to checking : cash in
{
  const c = cls({ ownAccount: "chk", amount: 40, flowType: "REFUND" });
  check("REFUND to liquid = CASH_IN / REFUND", c.effect === "CASH_IN" && c.reason === "REFUND");
}

// asset withdrawal → checking (brokerage → checking) : liquidation
{
  const c = cls({ ownAccount: "chk", amount: 3000, flowType: "TRANSFER", counterpartyAccountId: "brk" });
  check("brokerage → checking = CASH_IN / ASSET_LIQUIDATION", c.effect === "CASH_IN" && c.reason === "ASSET_LIQUIDATION");
}

// non-liquid leg of a transfer (asset side of a deposit) : neutral (avoid double count)
{
  const c = cls({ ownAccount: "cb", amount: -8141.98, flowType: "TRANSFER", counterpartyAccountId: "chk" });
  check("asset-side transfer leg = NEUTRAL (spendable effect on the liquid leg)",
    c.effect === "NEUTRAL" && c.reason === "INTERNAL_TRANSFER");
}

// ── deriveCashFlowAxes: the salary + crypto-liquidation composition ────────────
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 6000, flowType: "INCOME" }),                                  // earned income
    tx({ ownAccount: "chk", amount: 10044, flowType: "TRANSFER", counterpartyAccountId: "cb" }),  // liquidation
    tx({ ownAccount: "chk", amount: -1500, flowType: "SPENDING" }),                               // real cost
    tx({ ownAccount: "cb",  amount: 10044, flowType: "INVESTMENT" }),                             // the sale itself (neutral)
  ];
  const axes = deriveCashFlowAxes(rows, ctx);
  check("cashIn = 6000 earned + 10044 liquidation = 16044", axes.cashIn === 16044, JSON.stringify(axes));
  check("cashOut = 1500", axes.cashOut === 1500);
  check("netCash = 14544", axes.netCash === 14544);
  check("byReason splits earned income vs liquidation",
    axes.byReason.EARNED_INCOME === 6000 && axes.byReason.ASSET_LIQUIDATION === 10044);
  check("economic axis income = 6000 only (crypto NOT income)", axes.economic.income === 6000);
  check("economic axis spend = 1500", axes.economic.spend === 1500);
  check("INVESTMENT sale contributes to neither economic income nor cashIn double-count",
    axes.byReason.ASSET_CONVERSION === 10044 && axes.cashIn === 16044);
}

// unresolved surfaced separately, never in net
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 500, flowType: "TRANSFER" }), // unknown counterparty
  ];
  const axes = deriveCashFlowAxes(rows, ctx);
  check("unresolved magnitude surfaced, excluded from net",
    axes.unresolved === 500 && axes.cashIn === 0 && axes.netCash === 0);
}

// ── aggregateCashFlow parity: economic axis is byte-identical to the existing fn ──
{
  const rows: LiquidityTx[] = [
    tx({ ownAccount: "chk", amount: 6000, flowType: "INCOME" }),
    tx({ ownAccount: "chk", amount: -200, flowType: "SPENDING" }),
    tx({ ownAccount: "cb",  amount: 10044, flowType: "INVESTMENT" }),
    tx({ ownAccount: "chk", amount: -500, flowType: "TRANSFER", counterpartyAccountId: "sav" }),
  ];
  const axes = deriveCashFlowAxes(rows, ctx);
  const direct = aggregateCashFlow(rows);
  check("economic axis === aggregateCashFlow (unchanged)",
    axes.economic.income === direct.income && axes.economic.spend === direct.spend &&
    axes.economic.net === direct.net && axes.economic.refunds === direct.refunds);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Liquidity axis tests FAILED."); process.exit(1); }
console.log("Liquidity axis tests passed.");
process.exit(0);

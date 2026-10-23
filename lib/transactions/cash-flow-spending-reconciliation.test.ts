/**
 * lib/transactions/cash-flow-spending-reconciliation.test.ts   (CF-RECON-1)
 *
 * TWO CASH FLOW SURFACES THAT SAY "SPENDING" OVER THE SAME WINDOW AND POPULATION
 * PRINT THE SAME NUMBER — because they read the same authority, not because two
 * computations usually agree.
 *
 *   npx tsx lib/transactions/cash-flow-spending-reconciliation.test.ts
 *
 * The defect this pins: the Spending tile printed economicSpend(summary) (refunds
 * netted against ALL spending, floored once), while "Total spending" under the
 * category list was a React sum of per-category FLOORED nets. A refund dated in the
 * window whose category had no charge in the window (a September refund of an August
 * booking) was taken off the tile and off no category — the two "spending" totals
 * differed by exactly the ledger's `refundsUnapplied`, and nothing on screen said so.
 * Separately the tile's own card/direct split was `min(cardGross, net)` in React,
 * which credited every card refund to DIRECT spending.
 *
 * Contract pinned here (every expected value derived by hand in the comments):
 *   1. contract.spending.net === economicSpend(summary) === economicTotals(rows).spend  (raw, exact)
 *   2. Σ category lines − refundsUnapplied === net                     (the on-screen bridge)
 *   3. creditCard + direct − tier.refundsUnapplied === gross − refunds (tier parts)
 *   4. card payments, transfers and debt payments are in NO spending figure
 *   5. "Cash Out" (liquidity) is a DIFFERENT measure, bridged by card net − debt payments
 *   6. every surface reads ONE window (1M / MTD / explicit month / 3M / past anchor)
 *
 * No live personal value appears here.
 */

import { buildCashFlowSpaceData } from "./cash-flow-space-data";
import { economicTotals, periodRange, type CashFlowPeriod } from "./cash-flow";
import { economicSpend, economicSpendByTier } from "./cash-flow-projection";
import { isCostFlow, isRefund } from "./flow-predicates";
import type { Transaction } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const ACCOUNTS = [
  { id: "chk", type: "checking" },
  { id: "sav", type: "savings" },
  { id: "cc",  type: "debt" },
];

let seq = 0;
const tx = (o: Partial<Transaction> & { date: string; amount: number; account: string }): Transaction => ({
  id: o.id ?? `t${++seq}`, date: o.date, amount: o.amount,
  category: (o.category ?? "Other") as Transaction["category"], description: "x",
  merchant: null, merchantDisplayName: null, flowType: o.flowType ?? "SPENDING",
  currency: "USD", pending: o.pending ?? false,
  accountId: o.account, financialAccountId: o.account,
  counterpartyAccountId: o.counterpartyAccountId ?? null,
} as unknown as Transaction);

// ── AUGUST — a complete historical month ───────────────────────────────────
//  cost flows: 1000 (cc Travel) + 200 (chk Groceries) + 30 (cc INTEREST) + 5 (chk FEE)
//              + 100 (cc Dining)                                  = 1,335 gross
//  refunds:    40 (cc Dining, partial)                            =    40
//  net                                                            = 1,295
//  card: gross 1,130 · refunds 40 · net 1,090     direct: gross 205 · net 205
const AUG = [
  tx({ id: "a-inc",  date: "2026-08-05", amount: 3000,  account: "chk", flowType: "INCOME", category: "Income" }),
  tx({ id: "a-trv",  date: "2026-08-10", amount: -1000, account: "cc",  category: "Travel" }),
  tx({ id: "a-gro",  date: "2026-08-12", amount: -200,  account: "chk", category: "Groceries" }),
  tx({ id: "a-int",  date: "2026-08-15", amount: -30,   account: "cc",  flowType: "INTEREST", category: "Interest" }),
  tx({ id: "a-fee",  date: "2026-08-15", amount: -5,    account: "chk", flowType: "FEE", category: "Fee" }),
  tx({ id: "a-din",  date: "2026-08-20", amount: -100,  account: "cc",  category: "Dining" }),
  tx({ id: "a-ref",  date: "2026-08-25", amount: 40,    account: "cc",  flowType: "REFUND", category: "Dining" }),
  // Card payment: cash leaves checking toward the card (both legs). Never spending.
  tx({ id: "a-pay",  date: "2026-08-28", amount: -900,  account: "chk", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "cc" }),
  tx({ id: "a-payr", date: "2026-08-28", amount: 900,   account: "cc",  flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "chk" }),
  // Own-account transfer (both legs). Never spending.
  tx({ id: "a-xfr",  date: "2026-08-29", amount: -500,  account: "chk", flowType: "TRANSFER", category: "Transfer", counterpartyAccountId: "sav" }),
  tx({ id: "a-xfrr", date: "2026-08-29", amount: 500,   account: "sav", flowType: "TRANSFER", category: "Transfer", counterpartyAccountId: "chk" }),
];

// ── SEPTEMBER — the current, incomplete month (clock 2026-09-21) ────────────
//  cost flows: 300 (cc Shopping) + 600 (chk Groceries) + 80 (cc Dining, PENDING) = 980
//  refunds:    300 (cc Shopping, FULL) + 400 (cc Travel — refund of the AUGUST
//              booking; no Travel charge in September) + 50 (chk Groceries)      = 750
//  net = 980 − 750                                                                = 230
//  categories: Shopping 0 · Travel 0 (unapplied 400) · Groceries 550 · Dining 80
//              Σ lines 630;  630 − 400 = 230
//  tiers: card gross 380 · refunds 700 → net 0, unapplied 320;
//         direct gross 600 · refunds 50 → net 550;   0 + 550 − 320 = 230
const SEP = [
  tx({ id: "s-shp",  date: "2026-09-02", amount: -300, account: "cc",  category: "Shopping" }),
  tx({ id: "s-shpr", date: "2026-09-03", amount: 300,  account: "cc",  flowType: "REFUND", category: "Shopping" }),
  tx({ id: "s-trvr", date: "2026-09-05", amount: 400,  account: "cc",  flowType: "REFUND", category: "Travel" }),
  tx({ id: "s-gro",  date: "2026-09-06", amount: -600, account: "chk", category: "Groceries" }),
  tx({ id: "s-din",  date: "2026-09-10", amount: -80,  account: "cc",  category: "Dining", pending: true }),
  tx({ id: "s-gror", date: "2026-09-12", amount: 50,   account: "chk", flowType: "REFUND", category: "Groceries" }),
  tx({ id: "s-pay",  date: "2026-09-15", amount: -700, account: "chk", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "cc" }),
  tx({ id: "s-payr", date: "2026-09-15", amount: 700,  account: "cc",  flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "chk" }),
];

const ALL = [...AUG, ...SEP];
const clock = (iso: string) => () => new Date(`${iso}T00:00:00`);
const build = (period: CashFlowPeriod, asOf = "2026-09-21") =>
  buildCashFlowSpaceData({ transactions: ALL, accounts: ACCOUNTS, period, now: clock(asOf) });
const catSum = (d: ReturnType<typeof build>) => d.outflowByCategory.reduce((s, c) => s + c.value, 0);

/** The invariants every window must satisfy — the convergence contract. */
function invariants(label: string, d: ReturnType<typeof build>) {
  const s = d.summary;
  check(`${label} · Total spending IS the Spending tile (raw, exact)`, d.spending.net === economicSpend(s),
    `${d.spending.net} vs ${economicSpend(s)}`);
  check(`${label} · …and the rows-only projection agrees exactly`, d.spending.net === economicTotals(d.rows).spend);
  check(`${label} · gross and refunds are the fold's`, d.spending.gross === s.spendGross && d.spending.refunds === s.refunds);
  if (s.spendGross >= s.refunds) {
    check(`${label} · Σ category lines − refundsUnapplied === Total spending`,
      eq(catSum(d) - d.spending.refundsUnapplied, d.spending.net), `${catSum(d)} − ${d.spending.refundsUnapplied} vs ${d.spending.net}`);
  }
  const tier = economicSpendByTier(s);
  check(`${label} · card + direct − tier unapplied === gross − refunds`,
    eq(tier.creditCard + tier.direct - tier.refundsUnapplied, s.spendGross - s.refunds));
  check(`${label} · refund tiers partition refunds`, eq(s.creditCardRefunds + s.directRefunds, s.refunds));
  const spendIds = new Set(d.outflowByCategory.flatMap((c) => c.transactionIds));
  const notSpend = d.rows.filter((r) => spendIds.has(r.id) && !isCostFlow(r.flowType ?? null) && !isRefund(r.flowType ?? null));
  check(`${label} · no card payment / transfer / debt payment / income in any spending line`, notSpend.length === 0,
    notSpend.map((r) => r.id).join(","));
  const { start, end } = d.range;
  check(`${label} · every surface reads ONE window (rows ⊂ range)`, d.rows.every((r) => r.date >= start && r.date <= end));
}

console.log("1. complete historical month (August) — ordinary, partial refund, interest, fee");
{
  const d = build({ kind: "month", year: 2026, month: 8 });
  invariants("Aug", d);
  check("Aug · gross 1,335 · refunds 40 · net 1,295", eq(d.spending.gross, 1335) && eq(d.spending.refunds, 40) && eq(d.spending.net, 1295));
  check("Aug · nothing unapplied (the refund's purchase is in the window)", eq(d.spending.refundsUnapplied, 0));
  const t = economicSpendByTier(d.summary);
  check("Aug · card net 1,090 (the $40 card refund reduces CARD spending)", eq(t.creditCard, 1090));
  check("Aug · direct net 205 (untouched by a card refund)", eq(t.direct, 205));
  // The OLD React split: min(cardGross 1,130, net 1,295) = 1,130 card; 1,295 − 1,130 = 165 direct.
  check("Aug · the old min(cardGross, net) split would have printed direct 165 — it no longer does",
    !eq(t.direct, Math.max(0, economicSpend(d.summary) - Math.min(d.summary.creditCardSpending, economicSpend(d.summary)))));
  check("Aug · income 3,000 is not spending; card payment + transfer excluded", eq(d.summary.income, 3000));
}

console.log("2. current incomplete month (MTD) — full refund, refund of a PRIOR-period purchase, pending, direct refund");
{
  const d = build("MTD");
  invariants("MTD", d);
  check("MTD · window is 2026-09-01 … 2026-09-21", d.range.start === "2026-09-01" && d.range.end === "2026-09-21");
  check("MTD · gross 980 · refunds 750 · net 230", eq(d.spending.gross, 980) && eq(d.spending.refunds, 750) && eq(d.spending.net, 230));
  check("MTD · the August booking's September refund is disclosed: refundsUnapplied 400", eq(d.spending.refundsUnapplied, 400));
  check("MTD · the category lines alone sum to 630 — the figure the list used to print as 'Total spending'", eq(catSum(d), 630));
  check("MTD · …so the former React total disagreed with the Spending tile by exactly the unapplied 400",
    eq(catSum(d) - economicSpend(d.summary), d.spending.refundsUnapplied));
  const t = economicSpendByTier(d.summary);
  check("MTD · card net 0 (380 charged − 700 refunded, floored), tier unapplied 320", eq(t.creditCard, 0) && eq(t.refundsUnapplied, 320));
  check("MTD · direct net 550 (600 − 50) — the old split printed 0 here", eq(t.direct, 550));
  check("MTD · a PENDING row is in the population of both surfaces (80 in gross and in Dining)",
    d.outflowByCategory.some((c) => c.id === "Dining" && eq(c.value, 80)) && d.rows.some((r) => r.id === "s-din"));
  check("MTD · Shopping (fully refunded) is not a listed line", !d.outflowByCategory.some((c) => c.id === "Shopping"));
}

console.log("3. rolling 1 month (the page default) — a window that splits a purchase from its refund");
{
  const d = build("PAST_MONTH");
  invariants("1M", d);
  check("1M · window is 2026-08-21 … 2026-09-21 (canonical parser)",
    d.range.start === "2026-08-21" && d.range.end === "2026-09-21" && JSON.stringify(d.range) === JSON.stringify(periodRange("PAST_MONTH", clock("2026-09-21")())));
  // gross 980 (Sep); refunds 40 (Aug 25) + 750 = 790; net 190.
  check("1M · gross 980 · refunds 790 · net 190", eq(d.spending.gross, 980) && eq(d.spending.refunds, 790) && eq(d.spending.net, 190));
  // Dining: 80 charged, 40 refunded (its Aug 20 purchase is outside) → 40; Travel unapplied 400.
  check("1M · Dining nets its in-window refund (80 − 40 = 40)", d.outflowByCategory.some((c) => c.id === "Dining" && eq(c.value, 40)));
}

console.log("4. multi-month (3M) — every refund meets its category's charges");
{
  const d = build("PAST_QUARTER");
  invariants("3M", d);
  // gross 1,335 + 980 = 2,315; refunds 790; net 1,525; Travel 1,000 − 400 = 600.
  check("3M · gross 2,315 · refunds 790 · net 1,525 · nothing unapplied",
    eq(d.spending.gross, 2315) && eq(d.spending.refunds, 790) && eq(d.spending.net, 1525) && eq(d.spending.refundsUnapplied, 0));
  check("3M · Travel nets the later refund (1,000 − 400 = 600)", d.outflowByCategory.some((c) => c.id === "Travel" && eq(c.value, 600)));
}

console.log("5. past anchor — the window travels with As-of");
{
  const d = build("PAST_MONTH", "2026-08-31");
  invariants("1M@08-31", d);
  check("1M@08-31 · window 2026-07-31 … 2026-08-31 holds exactly August: net 1,295", d.range.start === "2026-07-31" && eq(d.spending.net, 1295));
  check("1M@08-31 · no September row leaks in", !d.rows.some((r) => r.date >= "2026-09-01"));
}

console.log("6. Cash Out is a DIFFERENT measure — and the bridge between them is exact");
{
  const d = build({ kind: "month", year: 2026, month: 8 });
  const s = d.summary;
  const t = economicSpendByTier(s);
  // Liquidity Cash Out (August) = direct cash cost 205 + card payment 900 = 1,105; the
  // transfer to savings is NEUTRAL; the card purchases move no cash at purchase.
  check("Aug · Cash Out 1,105 (205 direct + 900 card payment)", eq(s.cashOut, 1105), String(s.cashOut));
  check("Aug · Spending 1,295 ≠ Cash Out 1,105 — two concepts, two labels", !eq(economicSpend(s), s.cashOut));
  // Spending − Cash Out = card net (1,090) − cash sent to the card (900) − direct refunds (0) = 190
  check("Aug · bridge: Spending − Cash Out === card net − debt payments (1,090 − 900 = 190)",
    eq(economicSpend(s) - s.cashOut, t.creditCard - (s.byReason.DEBT_PAYMENT ?? 0)));
  check("Aug · 'Charged on credit' (gross 1,130) is not the card NET (1,090) — gross is labelled 'charged'",
    eq(s.creditCardSpending, 1130) && eq(t.creditCard, 1090));
}

console.log("7. no charge at all, only refunds — every figure floors at 0 together");
{
  const onlyRefund = [tx({ id: "r-only", date: "2026-09-05", amount: 120, account: "cc", flowType: "REFUND", category: "Travel" })];
  const d = buildCashFlowSpaceData({ transactions: onlyRefund, accounts: ACCOUNTS, period: "MTD", now: clock("2026-09-21") });
  check("refund-only · Total spending 0 === Spending tile 0", d.spending.net === 0 && economicSpend(d.summary) === 0);
  check("refund-only · no listed category", d.outflowByCategory.length === 0);
  check("refund-only · the 120 is disclosed as unapplied, not lost", eq(d.spending.refundsUnapplied, 120));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall cash-flow spending reconciliation checks passed");

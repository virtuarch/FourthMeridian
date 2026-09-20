/**
 * lib/transactions/debt-service.test.ts   (post-M1 D3)
 *
 * The debt-service decomposition, and the double count it makes impossible.
 *
 * Every assertion is an ECONOMIC INVARIANT over a synthetic household — a
 * relation that must hold whatever the amounts are. No live value appears here.
 * The economic net each case is compared against comes from the canonical fold
 * (`economicTotals`), and the cash-basis identity is cross-checked against the
 * liquidity axis's own aggregate (`aggregateDayFacts`), so the module is tested
 * against the two authorities it sits between rather than against itself.
 *
 * Pure: no DB, no network.   npx tsx lib/transactions/debt-service.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDebtService, netAfterDebtPaydown, type DebtService } from "./debt-service";
import { tierResolver, type LiquidityTx } from "./liquidity";
import { totalDebtPaid } from "./debt-payment-authority";
import { economicTotals } from "./cash-flow";
import { aggregateDayFacts } from "./cash-flow-projection";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── A household: two liquid accounts, two cards, one loan, one brokerage, and
//    one account the Space does not know (tier "unknown"). ────────────────────
const TIERS = tierResolver([
  { id: "chk", type: "checking" }, { id: "sav", type: "savings" },
  { id: "cardA", type: "debt" }, { id: "cardB", type: "debt" }, { id: "loan", type: "debt" },
  { id: "brk", type: "investment" },
]);

let seq = 0;
type RowIn = { own: string; amount: number; flowType: string; cp?: string | null;
  incomeClass?: string | null; incomeSubtype?: string | null; transferMaturity?: string | null };
const row = (o: RowIn): LiquidityTx => ({
  id: `r${++seq}`, accountId: o.own, financialAccountId: o.own,
  counterpartyAccountId: o.cp ?? null, amount: o.amount, flowType: o.flowType,
  incomeClass: o.incomeClass ?? (o.flowType === "INCOME" ? "EARNED_INCOME" : null),
  incomeSubtype: o.incomeSubtype ?? null, transferMaturity: o.transferMaturity ?? null,
  currency: "USD", date: "2026-05-10", merchant: "m", category: "Other", pending: false,
} as unknown as LiquidityTx);

const income   = (amount: number)                 => row({ own: "chk", amount, flowType: "INCOME" });
const buy      = (own: string, amount: number)    => row({ own, amount: -amount, flowType: "SPENDING" });
const refund   = (own: string, amount: number)    => row({ own, amount, flowType: "REFUND" });
const interest = (own: string, amount: number)    => row({ own, amount: -amount, flowType: "INTEREST" });
const fee      = (own: string, amount: number)    => row({ own, amount: -amount, flowType: "FEE" });
/** BOTH legs of one payment from checking to an owned liability. */
const pay = (to: string, amount: number): LiquidityTx[] => [
  row({ own: "chk", amount: -amount, flowType: "DEBT_PAYMENT", cp: to }),
  row({ own: to, amount, flowType: "DEBT_PAYMENT", cp: "chk" }),
];

const abs = (t: LiquidityTx) => Math.abs(t.amount);
const service = (rows: LiquidityTx[]) => computeDebtService(rows, TIERS, abs);
const econNet = (rows: LiquidityTx[]) => economicTotals(rows).net;
const after   = (rows: LiquidityTx[]) => netAfterDebtPaydown(econNet(rows), service(rows));

/** The relations that hold for EVERY household, asserted on every fixture below. */
function universal(name: string, rows: LiquidityTx[]): DebtService {
  const s = service(rows);
  check(`${name}: every component is ≥ 0`, Object.values(s).every((v) => v >= 0), s);
  check(`${name}: paydown and new borrowing are never both non-zero`, s.netPaydown === 0 || s.netNewBorrowing === 0, s);
  check(`${name}: payments − new charges − proceeds = paydown − new borrowing`,
    near(s.payments - s.newChargesOnLiabilities - s.debtProceeds, s.netPaydown - s.netNewBorrowing), s);
  check(`${name}: payments IS the debt-payment authority's total`, near(s.payments, totalDebtPaid(rows, TIERS, abs).total));
  check(`${name}: the after-paydown net never exceeds the economic net`, after(rows) <= econNet(rows) + 1e-9);
  check(`${name}: new charges on liabilities are a subset of economic spending`,
    s.newChargesOnLiabilities <= economicTotals(rows).spend + 1e-9);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("1. FULL-PAY CARD USER — settlement of spending already counted is not a deficit");
{
  const rows = [income(10_000), buy("cardA", 4_000), buy("cardA", 2_000), buy("chk", 1_500), ...pay("cardA", 6_000)];
  const s = universal("full-pay", rows);
  check("the economic net is income − ALL spending, card purchases included", near(econNet(rows), 2_500));
  check("the payments settle exactly the new charges ⇒ net paydown 0", s.netPaydown === 0 && s.netNewBorrowing === 0, s);
  check("⇒ the after-paydown net IS the economic net (no deficit manufactured)", near(after(rows), econNet(rows)));
  check("the retired subtraction would have reported a deficit here — the defect, reproduced",
    econNet(rows) - s.payments < 0 && after(rows) > 0);
}

console.log("\n2. A CARD PURCHASE AND ITS SETTLEMENT IN ONE WINDOW COUNT ONCE");
{
  const base = [income(8_000), buy("chk", 3_000)];
  for (const x of [1, 250, 4_999.99]) {
    const withPair = [...base, buy("cardB", x), ...pay("cardB", x)];
    check(`adding a $${x} card purchase + its payment lowers BOTH nets by exactly that amount`,
      near(econNet(base) - econNet(withPair), x) && near(after(base) - after(withPair), x),
      { econ: econNet(base) - econNet(withPair), after: after(base) - after(withPair) });
  }
  universal("pair", [...base, buy("cardB", 250), ...pay("cardB", 250)]);
}

console.log("\n3. REVOLVING USER — charges outrun payments: new borrowing, never a surplus");
{
  const rows = [income(5_000), buy("cardA", 3_000), buy("chk", 1_000), ...pay("cardA", 1_000)];
  const s = universal("revolving", rows);
  check("net paydown is 0 and the shortfall is disclosed as new borrowing", s.netPaydown === 0 && near(s.netNewBorrowing, 2_000), s);
  check("borrowing is NOT credited: the after-paydown net equals the economic net", near(after(rows), econNet(rows)));

  const over = [income(3_000), buy("cardA", 5_000), ...pay("cardA", 500)];
  universal("financed overspending", over);
  check("overspending financed on a card still reads as a negative economic net AND a negative after-paydown net",
    econNet(over) < 0 && near(after(over), econNet(over)));
}

console.log("\n4. GENUINE PRINCIPAL REDUCTION — a real use of cash that is not consumption");
{
  const rows = [income(6_000), buy("chk", 4_000), ...pay("cardA", 5_000)]; // pre-existing balance, no new charges
  const s = universal("paydown", rows);
  check("the whole payment is net paydown", near(s.netPaydown, 5_000), s);
  check("economic net is a surplus; after paydown it is a deficit of exactly surplus − paydown",
    near(econNet(rows), 2_000) && near(after(rows), -3_000));

  const partial = [income(6_000), buy("cardA", 1_200), ...pay("cardA", 2_000)];
  check("payments beyond new charges: only the EXCESS is paydown", near(universal("partial paydown", partial).netPaydown, 800));
}

console.log("\n5. INTEREST AND FEES — cost flows already in spending; never counted a second time");
{
  const rows = [income(4_000), interest("cardA", 50), fee("cardA", 25), ...pay("cardA", 75)];
  const s = universal("interest+fee", rows);
  check("interest and fees charged to a card ARE economic spending, once", near(economicTotals(rows).spend, 75));
  check("the payment that covers them is settlement, not paydown", s.netPaydown === 0 && near(s.newChargesOnLiabilities, 75), s);
  check("⇒ they reduce the after-paydown net exactly once", near(after(rows), 4_000 - 75));
}

console.log("\n6. NON-CARD LIABILITIES — principal is in spending nowhere");
{
  const posted = [income(7_000), interest("loan", 500), ...pay("loan", 2_000)];
  const s = universal("loan with posted interest", posted);
  check("the lender's interest row nets out; the principal (payment − interest) is the paydown", near(s.netPaydown, 1_500), s);
  check("after-paydown net = income − interest − principal = income − the cash that left", near(after(posted), 7_000 - 2_000));

  // A liability the Space does not hold: no liability leg, no charges — attested by the transfer authority.
  const unconnected = [income(7_000), row({ own: "chk", amount: -1_800, flowType: "DEBT_PAYMENT", transferMaturity: "DEBT_PAYMENT" })];
  const u = universal("unconnected loan", unconnected);
  check("an unconnected liability contributes no charges, so its payment stays whole (nothing to double count)",
    near(u.netPaydown, 1_800) && u.newChargesOnLiabilities === 0, u);

  const unattested = [income(7_000), row({ own: "chk", amount: -900, flowType: "DEBT_PAYMENT" })];
  check("an UNATTESTED provider-categorised row is not a payment here either (the authority refused it)",
    universal("unattested", unattested).payments === 0);
}

console.log("\n7. BORROWED CASH — financing is not paydown, and never a surplus");
{
  const advance = row({ own: "chk", amount: 3_000, flowType: "TRANSFER", cp: "cardB" });       // card → checking
  const advanceLeg = row({ own: "cardB", amount: -3_000, flowType: "TRANSFER", cp: "chk" });
  const roundTrip = [income(2_000), advance, advanceLeg, ...pay("cardB", 3_000)];
  const s = universal("advance repaid", roundTrip);
  check("a cash advance is DEBT_PROCEEDS, counted once (the liquid leg)", near(s.debtProceeds, 3_000), s);
  check("borrowing and repaying the same money is not a paydown", s.netPaydown === 0 && near(after(roundTrip), econNet(roundTrip)));

  const loanIn = row({ own: "chk", amount: 10_000, flowType: "INCOME", incomeClass: "NOT_INCOME", incomeSubtype: "LOAN_PROCEEDS" });
  const consolidation = [income(5_000), buy("chk", 4_000), loanIn, ...pay("cardA", 10_000)];
  const c = universal("consolidation", consolidation);
  check("loan proceeds the income taxonomy named are not income…", near(economicTotals(consolidation).income, 5_000));
  check("…and refinancing a card with them is not a paydown", c.netPaydown === 0 && near(c.debtProceeds, 10_000), c);

  const unusedAdvance = [income(2_000), advance, advanceLeg];
  check("unspent borrowed cash is new borrowing, and the after-paydown net is still just the economic net",
    near(universal("unused advance", unusedAdvance).netNewBorrowing, 3_000) && near(after(unusedAdvance), econNet(unusedAdvance)));
}

console.log("\n8. BALANCE TRANSFER — liability → liability moves nothing here");
{
  const rows = [income(3_000),
    row({ own: "cardA", amount: 2_500, flowType: "TRANSFER", cp: "cardB" }),
    row({ own: "cardB", amount: -2_500, flowType: "TRANSFER", cp: "cardA" })];
  const s = universal("balance transfer", rows);
  check("no payment, no charge, no proceeds", s.payments === 0 && s.newChargesOnLiabilities === 0 && s.debtProceeds === 0, s);
}

console.log("\n9. REFUNDS TO A CARD reduce what a payment has to settle");
{
  const rows = [income(5_000), buy("cardA", 1_000), refund("cardA", 300), ...pay("cardA", 1_000)];
  const s = universal("card refund", rows);
  check("new charges are net of refunds to the liability", near(s.newChargesOnLiabilities, 700), s);
  check("paying the gross statement anyway is a paydown of the refunded part", near(s.netPaydown, 300));
  const clamp = [income(5_000), refund("cardA", 900), buy("cardA", 100)];
  check("refunds beyond charges clamp at 0 (the shared clamp authority) — never negative charges",
    universal("refund clamp", clamp).newChargesOnLiabilities === 0);
}

console.log("\n10. MIXED ACCOUNTS — one full-pay card, one card being paid down, a loan, direct spending");
{
  const rows = [
    income(12_000), buy("chk", 2_000), buy("sav", 100),
    buy("cardA", 3_000), ...pay("cardA", 3_000),                 // full pay
    buy("cardB", 400), interest("cardB", 60), ...pay("cardB", 1_460), // 1,000 of real paydown
    interest("loan", 200), ...pay("loan", 900),                  // 700 principal
  ];
  const s = universal("mixed", rows);
  check("paydown is the sum of the real reductions only", near(s.netPaydown, 1_000 + 700), s);
  check("after-paydown net = economic net − that", near(after(rows), econNet(rows) - 1_700));
  // The cash-basis identity, against the liquidity axis's OWN aggregate.
  const f = aggregateDayFacts(rows, TIERS);
  const r = f.byReason;
  const liquidityNetWrtLiabilities = (r.EARNED_INCOME ?? 0) + (r.REFUND ?? 0) + (r.DEBT_PROCEEDS ?? 0) - (r.REAL_COST ?? 0) - (r.DEBT_PAYMENT ?? 0);
  check("economic net + new charges + proceeds − payments IS the liquidity axis's cash net (two authorities, one number)",
    near(econNet(rows) + s.newChargesOnLiabilities + s.debtProceeds - s.payments, liquidityNetWrtLiabilities),
    { lhs: econNet(rows) + s.newChargesOnLiabilities + s.debtProceeds - s.payments, liquidityNetWrtLiabilities });
  check("…and DayFacts.creditCardSpending is the same gross membership as the charges here", near(f.creditCardSpending, 3_000 + 400 + 60 + 200));
}

console.log("\n11. NO DEBT PAYMENTS, AND EVIDENCE MUST BE POSITIVE");
{
  const none = [income(4_000), buy("chk", 1_000)];
  const s = universal("no debt", none);
  check("nothing paid ⇒ every component 0 and the two nets are equal", Object.values(s).every((v) => v === 0) && near(after(none), econNet(none)));
  check("an empty window is all zeros", Object.values(service([])).every((v) => v === 0));

  const unknownTier = [income(4_000), buy("ghost", 2_000), ...pay("cardA", 2_000)];
  const u = universal("unknown-tier charges", unknownTier);
  check("a charge on an account of UNKNOWN tier offsets nothing — absence of contradiction is not evidence",
    u.newChargesOnLiabilities === 0 && near(u.netPaydown, 2_000), u);
  check("a charge on an ASSET-tier account offsets nothing either",
    universal("asset-tier charges", [income(4_000), buy("brk", 500), ...pay("cardA", 500)]).newChargesOnLiabilities === 0);
}

console.log("\n12. SELECTION IS THE MODULE'S JOB — leg order, duplicates of shape, and exclusions");
{
  const rows = [income(9_000), buy("cardA", 2_000), ...pay("cardA", 2_600)];
  const a = service(rows), b = service([...rows].reverse());
  check("row order does not matter", JSON.stringify(a) === JSON.stringify(b));
  check("only the liability legs ⇒ no payment counted (the cash leg is the counted one)",
    service(rows.filter((r) => TIERS.tierOf(r.accountId) === "liability")).payments === 0);
  const excluded = computeDebtService(rows, TIERS, (r) => (r.flowType === "SPENDING" ? null : Math.abs(r.amount)));
  check("a row the caller's magnitude refuses (null) folds into nothing", excluded.newChargesOnLiabilities === 0 && near(excluded.netPaydown, 2_600), excluded);
}

console.log("\n13. SOURCE — the module adds no predicate of its own");
{
  const src = readFileSync(join(process.cwd(), "lib/transactions/debt-service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("payments come from selectDebtPaymentCashLegs", /selectDebtPaymentCashLegs\(/.test(src));
  check("refunds net through the shared clamp", /clampEconomicSpend\(/.test(src));
  check("no descriptor, merchant or category is consulted", !/merchant|description|category|pfc/i.test(src));
  const assembler = readFileSync(join(process.cwd(), "lib/ai/assemblers/transactions.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("the AI assembler derives the after-paydown net from this module", /netAfterDebtPaydown\(netCashFlow, debtService\)/.test(assembler));
  check("the retired subtraction (economic net − payment total) is gone from the assembler",
    !/netCashFlow\s*-\s*debtPaymentTotal/.test(assembler));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll debt-service checks passed.");

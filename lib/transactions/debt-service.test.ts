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
import { computeDebtService, debtServiceBucket, debtServiceForAi, netAfterDebtPaydown, type DebtService, type DebtServiceLiability, type DebtServiceOptions } from "./debt-service";
import { UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND, UNSPLIT_LOAN_PAYMENT_AI_NOTE } from "@/lib/debt/liability-kind";
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
  check(`${name}: every component is ≥ 0`, Object.values(s).every((v) => typeof v !== "number" || v >= 0), s);
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
  check("nothing paid ⇒ every component 0 and the two nets are equal", Object.values(s).every((v) => typeof v !== "number" || v === 0) && near(after(none), econNet(none)));
  check("an empty window is all zeros", Object.values(service([])).every((v) => typeof v !== "number" || v === 0));

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

console.log("\n14. OWNER F6 — installment-loan payments are unsplit loan payments, never paydown");
{
  // The Space's liabilities, by the canonical debt-type model (lib/debt/liability-kind.ts).
  const LIAB: Record<string, DebtServiceLiability> = {
    cardA: { type: "debt", providerSubtype: "credit card", creditLimit: 5_000, labelAccess: "FINE" },
    cardB: { type: "debt", creditLimit: 3_000, labelAccess: "FINE" },            // legacy untyped card (limit-bearing)
    loan:  { type: "debt", debtSubtype: "mortgage", labelAccess: "FINE" },
  };
  const opts = (liab: Record<string, DebtServiceLiability>): DebtServiceOptions => ({
    liabilityOf: (id) => liab[id],
    hasNonRevolvingLiability: Object.values(liab).some((l) => debtServiceBucket(l) !== "revolving"),
  });
  const cardsOnly = { cardA: LIAB.cardA, cardB: LIAB.cardB };
  const f6 = (rows: LiquidityTx[], liab = LIAB) => computeDebtService(rows, TIERS, abs, opts(liab));
  const untrackedLeg = (amount: number, detail: string): LiquidityTx => ({
    ...row({ own: "chk", amount: -amount, flowType: "DEBT_PAYMENT", cp: null, transferMaturity: "UNTRACKED_LOAN_PAYMENT" }),
    loanPaymentDetail: detail,
  } as unknown as LiquidityTx);
  /** The cash truth: the total subtracted is the pre-F6 figure, whatever the attribution. */
  const sameCash = (name: string, rows: LiquidityTx[], liab = LIAB) => {
    const legacy = service(rows), now = f6(rows, liab);
    check(`${name}: net-after is IDENTICAL to the pre-F6 figure`, near(netAfterDebtPaydown(econNet(rows), now), netAfterDebtPaydown(econNet(rows), legacy)), { legacy, now });
    check(`${name}: revolving paydown + unsplit = pre-F6 paydown + untracked`,
      near(now.netPaydown + now.unsplitLoanPayments, legacy.netPaydown + legacy.untrackedLoanPayments), { legacy, now });
    check(`${name}: payments / charges / proceeds / new borrowing unchanged`,
      now.payments === legacy.payments && now.newChargesOnLiabilities === legacy.newChargesOnLiabilities
      && now.debtProceeds === legacy.debtProceeds && now.netNewBorrowing === legacy.netNewBorrowing, { legacy, now });
    return now;
  };

  // (a) Regression guard — a cards-only household reads exactly as before.
  const cardFixtures: [string, LiquidityTx[]][] = [
    ["full payer",         [income(10_000), buy("cardA", 6_000), ...pay("cardA", 6_000)]],
    ["revolver paydown",   [income(10_000), buy("cardA", 1_000), ...pay("cardA", 3_000), interest("cardA", 50)]],
    ["two cards + refund", [income(8_000), buy("cardA", 2_000), refund("cardA", 300), buy("cardB", 900), ...pay("cardA", 2_500), ...pay("cardB", 400)]],
    ["financed overspend", [income(3_000), buy("cardB", 4_000), ...pay("cardB", 500), fee("cardB", 35)]],
  ];
  for (const [name, rows] of cardFixtures) {
    const legacy = service(rows), now = f6(rows, cardsOnly);
    check(`cards only — ${name}: every figure identical to before`,
      now.payments === legacy.payments && now.netPaydown === legacy.netPaydown && now.netNewBorrowing === legacy.netNewBorrowing
      && now.newChargesOnLiabilities === legacy.newChargesOnLiabilities && now.unsplitLoanPayments === 0
      && netAfterDebtPaydown(econNet(rows), now) === netAfterDebtPaydown(econNet(rows), legacy), { legacy, now });
    sameCash(`cards only — ${name}`, rows, cardsOnly);
  }

  // (b) Mortgage + card household.
  const mix = [income(10_000), buy("cardA", 3_000), ...pay("cardA", 3_500), ...pay("loan", 2_500)];
  const m = sameCash("mortgage + card", mix);
  check("mortgage + card: card paydown (500) is netPaydown", m.netPaydown === 500, m);
  check("mortgage + card: the mortgage payment (2,500) is an unsplit loan payment, not paydown", m.unsplitLoanPayments === 2_500, m);
  check("mortgage + card: labelled principal + interest + escrow, not split",
    m.unsplitLoanKind === "mortgage" && m.unsplitLoanPaymentLabel === UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND.mortgage, m);
  check("mortgage + card: net-after = 10,000 − 3,000 − 500 − 2,500 = 4,000", netAfterDebtPaydown(econNet(mix), m) === 4_000);

  // (c) A lender-posted interest row on the mortgage is already in spending — netted, never twice.
  const wi = sameCash("mortgage + lender interest row", [income(10_000), ...pay("loan", 2_500), interest("loan", 1_000)]);
  check("mortgage + lender interest row: unsplit 1,500, netPaydown 0", wi.unsplitLoanPayments === 1_500 && wi.netPaydown === 0, wi);

  // (d) S2 condition 2 — connected mortgage AND an untracked (F10) auto loan: ONE figure, no double count.
  const both = [income(10_000), ...pay("loan", 2_500), untrackedLeg(400, "LOAN_PAYMENTS_CAR_PAYMENT")];
  const b = sameCash("connected mortgage + untracked auto loan", both);
  check("both: unsplit = 2,500 connected + 400 untracked = 2,900, counted once",
    b.unsplitLoanPayments === 2_900 && b.untrackedLoanPayments === 400 && b.netPaydown === 0, b);
  check("both: mixed loan types ⇒ the neutral label (no escrow claim on an auto loan)",
    b.unsplitLoanKind === "unknown" && b.unsplitLoanPaymentLabel === UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND.unknown, b);
  check("both: net-after = 10,000 − 2,900", netAfterDebtPaydown(econNet(both), b) === 7_100);
  const ai = debtServiceForAi(b) as unknown as Record<string, unknown>;
  check("both: the AI view carries ONE unsplit figure and its label, not the subset",
    ai.unsplitLoanPayments === 2_900 && ai.unsplitLoanPaymentLabel === b.unsplitLoanPaymentLabel
    && !("untrackedLoanPayments" in ai) && !("unsplitLoanKind" in ai), ai);

  // (e) S2 PRIVACY P1-R1 — a non-FULL viewer's label comes from the COARSE type: no escrow, no "mortgage".
  const coarse = f6(mix, { ...LIAB, loan: { ...LIAB.loan, labelAccess: "COARSE" } });
  check("COARSE viewer: same figures, P+I label only (no escrow disclosure)",
    coarse.unsplitLoanPayments === 2_500 && coarse.unsplitLoanKind === "installment"
    && !/escrow/i.test(coarse.unsplitLoanPaymentLabel), coarse);

  // (f) New borrowing still offsets: card charges outrun card payments ⇒ nothing is paid down or claimed.
  const fi = sameCash("borrowing funded the loan payment", [income(10_000), buy("cardA", 5_000), ...pay("cardA", 1_000), ...pay("loan", 2_500)]);
  check("borrowing edge: net = 3,500 − 5,000 < 0 ⇒ unsplit 0, netPaydown 0, new borrowing 1,500",
    fi.unsplitLoanPayments === 0 && fi.netPaydown === 0 && fi.netNewBorrowing === 1_500, fi);
  const pa = sameCash("borrowing funded part of the loan payment", [income(10_000), buy("cardA", 2_000), ...pay("cardA", 1_000), ...pay("loan", 2_500)]);
  check("borrowing edge: the loan share is capped at the window's positive net (1,500)", pa.unsplitLoanPayments === 1_500 && pa.netPaydown === 0, pa);

  // (g) Unknown-type liability (no subtype, no limit) — conservative: unsplit, neutral label.
  const unk = f6([income(5_000), ...pay("loan", 800)], { loan: { type: "debt", labelAccess: "FINE" } });
  check("unknown-type liability: payment is an unsplit loan payment, never paydown",
    unk.netPaydown === 0 && unk.unsplitLoanPayments === 800 && unk.unsplitLoanPaymentLabel === UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND.unknown, unk);

  // (h) HELOC is revolving (same definition as utilization): its paydown stays netPaydown.
  const heloc = f6([income(5_000), ...pay("loan", 800)], { loan: { type: "debt", debtSubtype: "heloc", labelAccess: "FINE" } });
  check("HELOC: revolving ⇒ netPaydown 800, unsplit 0", heloc.netPaydown === 800 && heloc.unsplitLoanPayments === 0, heloc);

  // (i) Randomised: the cash truth holds for every attribution.
  let rnd = 7;
  const r = () => { rnd = (rnd * 48271) % 2147483647; return rnd / 2147483647; };
  let randomFailures = 0;
  for (let i = 0; i < 200; i++) {
    const rows: LiquidityTx[] = [income(Math.round(r() * 10_000))];
    for (let k = 0; k < 6; k++) {
      const acct = ["cardA", "cardB", "loan"][Math.floor(r() * 3)];
      const amt = Math.round(r() * 3_000) + 1;
      const pick = r();
      if (pick < 0.35) rows.push(...pay(acct, amt));
      else if (pick < 0.65) rows.push(buy(acct, amt));
      else if (pick < 0.75) rows.push(interest(acct, Math.round(amt / 10)));
      else if (pick < 0.85) rows.push(refund(acct, Math.round(amt / 5)));
      else rows.push(untrackedLeg(amt, "LOAN_PAYMENTS_MORTGAGE_PAYMENT"));
    }
    const legacy = service(rows), now = f6(rows);
    if (!near(netAfterDebtPaydown(econNet(rows), now), netAfterDebtPaydown(econNet(rows), legacy))
        || !near(now.netPaydown + now.unsplitLoanPayments, legacy.netPaydown + legacy.untrackedLoanPayments)
        || now.netPaydown < 0 || now.unsplitLoanPayments < 0) {
      randomFailures++;
      check(`random household ${i}: cash truth preserved`, false, { legacy, now });
    }
  }
  check("200 random households: net-after and total debt cash identical under F6 attribution", randomFailures === 0);
}

console.log("\n15. SOURCE — the AI assembler wires F6");
{
  const assembler = readFileSync(join(process.cwd(), "lib/ai/assemblers/transactions.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("the assembler passes the liability resolver (debt-type model) to the decomposition", /\}, debtServiceOpts\);/.test(assembler));
  check("the assembler's label tier comes from debtLabelAccess (P1-R1)", /labelAccess:\s+debtLabelAccess\(\{ visibilityLevel: l\.visibilityLevel \}\)/.test(assembler));
  check("the AI note fires on ANY unsplit loan payment (tracked OR untracked)",
    assembler.includes("debtService.unsplitLoanPayments > 0 ? { unsplitLoanPaymentNote: UNSPLIT_LOAN_PAYMENT_AI_NOTE } : {}"));
  check("the AI receives the AI view (one unsplit figure)", /debtService: debtServiceForAi\(debtService\)/.test(assembler));
  check("the AI note forbids principal amounts and payoff progress",
    /principal reduction/.test(UNSPLIT_LOAN_PAYMENT_AI_NOTE) && /payoff progress/.test(UNSPLIT_LOAN_PAYMENT_AI_NOTE));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll debt-service checks passed.");

/**
 * lib/transactions/refund-economics.test.ts   (REFUND-1)
 *
 * THE REFUND MATRIX — what a refund does to spending, category totals, measured
 * figures and downstream evidence, end to end through the PURE chain:
 *
 *   provider fields → mapPlaidCategory → the three category rescues (payment,
 *   payroll, merchant credit) → classifyFlow → the ONE economic fold →
 *   categorySpendLedger / outflowByCategory → M1 measure → baseline → Brief row.
 *
 * No DB. Every expected figure below is HAND ARITHMETIC written beside the case —
 * never the implementation called a second time.
 *
 * Several cases exist to DEFEAT a sign test: a card payment, a transfer in, a
 * reward credit, a reimbursement and an income deposit are all positive amounts,
 * and none of them may reduce a category.
 *
 * Run:  npx tsx lib/transactions/refund-economics.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transaction, FlowType, TransactionCategory } from "@/types";
import { mapPlaidCategory, type PlaidCategoryInput } from "@/lib/transactions/plaid-category";
import { resolveLiabilityPaymentCategory } from "@/lib/transactions/liability-payment";
import { resolvePayrollIncomeCategory } from "@/lib/transactions/descriptor-evidence";
import {
  resolveLiabilityMerchantCreditCategory, needsMerchantCreditEvidence,
} from "@/lib/transactions/merchant-credit";
import { priorPurchaseWhere } from "@/lib/transactions/merchant-credit-evidence";
import { classifyFlow, isGenuineSpendCategory, FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import {
  economicTotals, categorySpendLedger, outflowByCategory, filterByPeriod, foldEconomicRow,
} from "@/lib/transactions/cash-flow";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { attributeIncome } from "@/lib/transactions/income-source";
import { describeRowNature } from "@/lib/transactions/flow-presentation";
import { measure, compare, type MonthRow, type DataCoverage } from "@/lib/ai/measures/measure";
import { resolvePeriod, type PeriodSpec } from "@/lib/ai/measures/period";
import { computeAverageMonthlySpending } from "@/lib/ai/intelligence/annotations/metrics";
import { projectRecentActivity } from "@/lib/ai/brief/recent-activity";
import type { TransactionsSummaryData } from "@/lib/ai/types";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const cents = (n: number) => Math.round(n * 100);
const eq = (a: number, b: number) => cents(a) === cents(b);

// ── The ingest chain, in the seam's order (pinned against the source below) ───
interface Provider {
  id: string; date: string; amount: number;        // FM sign: + into the account
  account: "card" | "checking" | "savings";
  pfcPrimary: string | null; pfcDetailed: string | null;
  merchant: string; name?: string;
  /** Categories of the same merchant's prior purchases on the same account. */
  history?: string[];
  pending?: boolean;
}
const ACCOUNT_TYPE = { card: "debt", checking: "checking", savings: "savings" } as const;

function ingest(p: Provider): Transaction {
  const accountType = ACCOUNT_TYPE[p.account];
  const name = p.name ?? p.merchant;
  // `string`: the mapper returns Prisma's enum, the DTO carries the app's — the
  // chain itself is generic over either, exactly as the real seam uses it.
  let category: string = mapPlaidCategory({
    personal_finance_category: p.pfcPrimary ? { primary: p.pfcPrimary, detailed: p.pfcDetailed ?? "" } : null,
    category: null, merchant_name: p.merchant, name,
  } as unknown as PlaidCategoryInput);
  category = resolveLiabilityPaymentCategory(category, "Payment", { accountType, debtSubtype: null, amount: p.amount, merchant: p.merchant, description: name });
  category = resolvePayrollIncomeCategory(category, "Income", { amount: p.amount, merchant: p.merchant, description: name });
  if (needsMerchantCreditEvidence(category, "Income", { accountType, debtSubtype: null, amount: p.amount })) {
    category = resolveLiabilityMerchantCreditCategory<string>(category, "Income", "Other", {
      accountType, debtSubtype: null, amount: p.amount, priorPurchaseCategories: p.history ?? [],
    }).category;
  }
  const c = classifyFlow({ category, amount: p.amount, accountType, pfcPrimary: p.pfcPrimary, pfcDetailed: p.pfcDetailed });
  return {
    id: p.id, accountId: p.account, date: p.date, merchant: p.merchant, category: category as TransactionCategory,
    amount: p.amount, pending: p.pending ?? false, flowType: c.flowType as FlowType,
  };
}

const purchase = (id: string, date: string, amount: number, o: Partial<Provider> = {}): Provider => ({
  id, date, amount: -Math.abs(amount), account: "card", pfcPrimary: "TRAVEL", pfcDetailed: "TRAVEL_LODGING", merchant: "Stayline", ...o,
});
/** A refund the PROVIDER labels in the purchase's own family (the explicit case). */
const labelledRefund = (id: string, date: string, amount: number, o: Partial<Provider> = {}): Provider => ({
  id, date, amount: Math.abs(amount), account: "card", pfcPrimary: "TRAVEL", pfcDetailed: "TRAVEL_LODGING", merchant: "Stayline", ...o,
});
/** A refund the provider files as INCOME from the brand (the live defect). */
const misfiledRefund = (id: string, date: string, amount: number, history: string[], o: Partial<Provider> = {}): Provider => ({
  id, date, amount: Math.abs(amount), account: "card", pfcPrimary: "INCOME", pfcDetailed: "INCOME_RENTAL", merchant: "Stayline", history, ...o,
});

const SEP = { kind: "month", year: 2026, month: 9 } as const;
const AUG = { kind: "month", year: 2026, month: 8 } as const;
const OCT = { kind: "month", year: 2026, month: 10 } as const;
const line = (rows: Transaction[], category: string) => categorySpendLedger(rows).find((l) => l.category === category);
const conserved = (rows: Transaction[]) => {
  const l = categorySpendLedger(rows);
  const gross = l.reduce((n, x) => n + x.gross, 0), refunds = l.reduce((n, x) => n + x.refunds, 0);
  const net = l.reduce((n, x) => n + x.net, 0), un = l.reduce((n, x) => n + x.refundsUnapplied, 0);
  return eq(gross - refunds, net - un) && l.every((x) => x.gross >= 0 && x.refunds >= 0 && x.net >= 0 && x.refundsUnapplied >= 0);
};

console.log("1. purchase only");
{
  const rows = [ingest(purchase("p1", "2026-09-05", 1500))];
  const t = line(rows, "Travel")!;
  check("gross 1,500 · refunds 0 · net 1,500", eq(t.gross, 1500) && eq(t.refunds, 0) && eq(t.net, 1500));
  const c = outflowByCategory(rows)[0];
  check("no refund ⇒ the contribution carries NO gross/refunds clutter", c.gross === undefined && c.refunds === undefined && eq(c.value, 1500));
}

console.log("2. purchase + partial refund, same period — the headline case");
{
  const rows = [ingest(purchase("p1", "2026-09-05", 1500)), ingest(labelledRefund("r1", "2026-09-12", 500))];
  const t = line(rows, "Travel")!;
  check("gross 1,500 / refunds 500 / net 1,000 (1,500 − 500)", eq(t.gross, 1500) && eq(t.refunds, 500) && eq(t.net, 1000));
  check("partial refund reduces the category by EXACTLY the refund", eq(t.gross - t.net, 500));
  const c = outflowByCategory(rows)[0];
  check("the contribution explains itself: value 1,000, gross 1,500, refunds 500", eq(c.value, 1000) && eq(c.gross!, 1500) && eq(c.refunds!, 500));
  check("the drill-down holds BOTH rows, so the drawer reconciles", c.transactionIds.join() === "p1,r1");
  const tot = economicTotals(rows);
  check("headline: spend 1,000, refunds 500, income 0", eq(tot.spend, 1000) && eq(tot.refunds, 500) && eq(tot.income, 0));
}

console.log("3. purchase + full refund, same period");
{
  const rows = [ingest(purchase("p1", "2026-09-05", 1500)), ingest(labelledRefund("r1", "2026-09-06", 1500))];
  const t = line(rows, "Travel")!;
  check("net 0, nothing unapplied (1,500 − 1,500)", eq(t.net, 0) && eq(t.refundsUnapplied, 0));
  check("a fully refunded category is not listed as spending", outflowByCategory(rows).length === 0);
  check("economic contribution of the pair is 0", eq(economicTotals(rows).spend, 0) && eq(economicTotals(rows).net, 0));
}

console.log("4. purchase LAST month, refund THIS month (refund exceeds same-window purchases)");
{
  const all = [
    ingest(purchase("p1", "2026-08-20", 1500)),
    ingest(labelledRefund("r1", "2026-09-10", 500)),
    ingest(purchase("d1", "2026-09-11", 800, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_RESTAURANT", merchant: "Bistro" })),
  ];
  const aug = filterByPeriod(all, AUG), sep = filterByPeriod(all, SEP);
  check("August is NOT rewritten: Travel gross = net = 1,500", eq(line(aug, "Travel")!.net, 1500) && eq(line(aug, "Travel")!.refunds, 0));
  const t = line(sep, "Travel")!;
  check("September Travel: gross 0 · refunds 500 · net 0 · unapplied 500", eq(t.gross, 0) && eq(t.refunds, 500) && eq(t.net, 0) && eq(t.refundsUnapplied, 500));
  check("a category never goes negative, and is not listed at 0", !outflowByCategory(sep).some((c) => c.id === "Travel"));
  check("September headline spend = 800 − 500 = 300", eq(economicTotals(sep).spend, 300));
  check("category lines reconcile to the headline THROUGH the unapplied refund (800 − 500)", eq(line(sep, "Dining")!.net - t.refundsUnapplied, 300));
  check("conservation holds across both months and the union", conserved(aug) && conserved(sep) && conserved(all));
}

console.log("5. purchase THIS month, refund NEXT month");
{
  const all = [ingest(purchase("p1", "2026-09-25", 1500)), ingest(labelledRefund("r1", "2026-10-03", 500))];
  check("September shows the full 1,500 — a later refund does not reach back", eq(line(filterByPeriod(all, SEP), "Travel")!.net, 1500));
  const o = line(filterByPeriod(all, OCT), "Travel")!;
  check("October carries the refund: refunds 500, unapplied 500, net 0", eq(o.refunds, 500) && eq(o.refundsUnapplied, 500) && eq(o.net, 0));
  check("over the two months together: 1,500 − 500 = 1,000", eq(line(all, "Travel")!.net, 1000));
}

console.log("6. several purchases from one merchant + one refund — NO pairing");
{
  const rows = [
    ingest(purchase("a", "2026-09-02", 300)), ingest(purchase("b", "2026-09-09", 200)), ingest(purchase("c", "2026-09-16", 100)),
    ingest(labelledRefund("r", "2026-09-18", 150)),
  ];
  const t = line(rows, "Travel")!;
  check("gross 600 (300+200+100) · refunds 150 · net 450", eq(t.gross, 600) && eq(t.refunds, 150) && eq(t.net, 450));
  check("the refund equals NO purchase amount and still nets — it is not matched to one", ![300, 200, 100].includes(150) && eq(t.net, 450));
}

console.log("7. refund the provider labels in the purchase's own family (explicit)");
{
  const c = classifyFlow({ category: "Travel", amount: 500, accountType: "debt", pfcPrimary: "TRAVEL", pfcDetailed: "TRAVEL_LODGING" });
  check("REFUND / INFLOW from PLAID_PFC_PRIMARY at 0.7", c.flowType === "REFUND" && c.flowDirection === "INFLOW" && c.reason === "PLAID_PFC_PRIMARY" && c.confidence === 0.7);
  const dep = ingest(labelledRefund("r", "2026-09-10", 40, { account: "checking", pfcPrimary: "GENERAL_MERCHANDISE", pfcDetailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", merchant: "Marketplace" }));
  check("it holds on a DEBIT-card / checking refund too", dep.flowType === "REFUND" && dep.category === "Shopping");
}

console.log("8. refund WITHOUT a usable provider label — the live defect (INCOME_RENTAL on a card)");
{
  const tenTravel = Array(10).fill("Travel");
  const r = ingest(misfiledRefund("r", "2026-09-18", 521.34, tenTravel));
  check("unanimous merchant history ⇒ Travel / REFUND", r.category === "Travel" && r.flowType === "REFUND");
  const c = classifyFlow({ category: "Travel", amount: 521.34, accountType: "debt", pfcPrimary: "INCOME", pfcDetailed: "INCOME_RENTAL" });
  check("…decided by ACCOUNT_TYPE_CONTEXT at 0.6 — below a provider-labelled refund's 0.7", c.reason === "ACCOUNT_TYPE_CONTEXT" && c.confidence === 0.6);

  const rows = [ingest(purchase("p1", "2026-09-09", 1098.88)), ingest(purchase("p2", "2026-09-14", 732.48)),
    ingest(misfiledRefund("r1", "2026-09-14", 339.96, tenTravel)), r];
  const t = line(rows, "Travel")!;
  // 1,098.88 + 732.48 = 1,831.36 ; 339.96 + 521.34 = 861.30 ; 1,831.36 − 861.30 = 970.06
  check("gross 1,831.36 · refunds 861.30 · net 970.06", eq(t.gross, 1831.36) && eq(t.refunds, 861.30) && eq(t.net, 970.06));
  check("and NOT ONE CENT of it is income", eq(economicTotals(rows).income, 0));

  for (const [label, history] of [["no history", []], ["split history", ["Travel", "Dining"]], ["Other-only history", ["Other", "Other"]]] as const) {
    const u = ingest(misfiledRefund("u", "2026-09-18", 280.45, [...history]));
    check(`${label} ⇒ Other / UNKNOWN — never income, never a fabricated refund`, u.category === "Other" && u.flowType === "UNKNOWN");
    const solo = [ingest(purchase("p", "2026-09-01", 1000)), u];
    check(`…and it moves NOTHING: income 0, refunds 0, Travel still 1,000 (${label})`,
      eq(economicTotals(solo).income, 0) && eq(economicTotals(solo).refunds, 0) && eq(line(solo, "Travel")!.net, 1000));
  }
  check("the SAME provider label on a CHECKING account stays income (the veto is structural, not a brand rule)",
    ingest(misfiledRefund("h", "2026-09-18", 900, tenTravel, { account: "checking" })).flowType === "INCOME");
  check("history is never consulted off a liability", !needsMerchantCreditEvidence("Income", "Income", { accountType: "checking", debtSubtype: null, amount: 900 }));
  check("…nor for a purchase, nor for any category but the income claim",
    !needsMerchantCreditEvidence("Income", "Income", { accountType: "debt", debtSubtype: null, amount: -5 })
    && !needsMerchantCreditEvidence("Travel", "Income", { accountType: "debt", debtSubtype: null, amount: 5 }));
  check("a category-only `Income` row on a card (CSV / manual, no provider family) is vetoed too",
    classifyFlow({ category: "Income", amount: 50, accountType: "debt" }).flowType === "UNKNOWN"
    && classifyFlow({ category: "Income", amount: 50, accountType: "checking" }).flowType === "INCOME");
  check("a manual liability (debtSubtype, no account type) is a liability", classifyFlow({ category: "Income", amount: 50, debtSubtype: "credit_card" }).flowType === "UNKNOWN");
}

console.log("8b. the evidence read is exact, account-scoped and never looks forward");
{
  const w = priorPurchaseWhere({ financialAccountId: "acct", merchantEntityId: "ent", merchant: "Stayline", description: "STAYLINE * ABC", onOrBefore: new Date("2026-09-18") });
  check("same account, active, purchases only, SPENDING only", w.financialAccountId === "acct" && w.deletedAt === null
    && JSON.stringify(w.amount) === '{"lt":0}' && w.flowType === "SPENDING");
  check("on or before the credit", (w.date as { lte: Date }).lte.toISOString().startsWith("2026-09-18"));
  check("exact equality on entity id, merchant name, raw descriptor — nothing else",
    JSON.stringify(w.OR) === JSON.stringify([{ merchantEntityId: "ent" }, { merchant: "Stayline" }, { description: "STAYLINE * ABC" }]));
  const bare = priorPurchaseWhere({ financialAccountId: "acct", merchantEntityId: null, merchant: "X", description: null, onOrBefore: new Date("2026-01-01") });
  check("absent identifiers add no arm (never `merchantEntityId: null` — that would match every unenriched row)",
    JSON.stringify(bare.OR) === JSON.stringify([{ merchant: "X" }]));
  const src = readFileSync(join(__dirname, "merchant-credit-evidence.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("no fuzzy operator in the read", !/contains|startsWith|endsWith|mode:|insensitive|similar/i.test(src));
}

console.log("9. card payment — positive, on the same card, and NOT a refund");
{
  const rows = [
    ingest(purchase("p1", "2026-09-05", 1500)),
    ingest({ id: "pay-card", date: "2026-09-11", amount: 2000, account: "card", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", merchant: "MOBILE PAYMENT - THANK YOU" }),
    ingest({ id: "pay-card2", date: "2026-09-12", amount: 750, account: "card", pfcPrimary: "LOAN_DISBURSEMENTS", pfcDetailed: "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT", merchant: "Payment Thank You-Mobile" }),
    ingest({ id: "pay-chk", date: "2026-09-11", amount: -2000, account: "checking", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", merchant: "CARD AUTOPAY" }),
  ];
  check("both card-side legs and the cash leg are DEBT_PAYMENT", rows.slice(1).every((r) => r.flowType === "DEBT_PAYMENT"));
  check("Travel stays 1,500; refunds 0; spend 1,500", eq(line(rows, "Travel")!.net, 1500) && eq(economicTotals(rows).refunds, 0) && eq(economicTotals(rows).spend, 1500));
  check("no payment row is in any category line", !categorySpendLedger(rows).some((l) => l.transactionIds.some((id) => id.startsWith("pay"))));
}

console.log("10. bank transfer");
{
  const rows = [
    ingest(purchase("p1", "2026-09-05", 1500)),
    ingest({ id: "t-in", date: "2026-09-11", amount: 1000, account: "savings", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER", merchant: "Online Transfer from CHK" }),
    ingest({ id: "t-out", date: "2026-09-11", amount: -1000, account: "checking", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", merchant: "Online Transfer to SAV" }),
  ];
  check("both legs TRANSFER", rows[1].flowType === "TRANSFER" && rows[2].flowType === "TRANSFER");
  check("spend 1,500, refunds 0, income 0", eq(economicTotals(rows).spend, 1500) && eq(economicTotals(rows).refunds, 0) && eq(economicTotals(rows).income, 0));
}

console.log("11. cashback / reward / statement credit — existing semantics: an issuer credit is NOT a purchase refund");
{
  const reward = ingest({ id: "pts", date: "2026-09-11", amount: 76.06, account: "card", pfcPrimary: "OTHER", pfcDetailed: "OTHER_OTHER", merchant: "POINTS FOR AMEX TRVL" });
  check("Other / UNKNOWN — the provider named no spend family, so nothing is reversed", reward.category === "Other" && reward.flowType === "UNKNOWN");
  const rows = [ingest(purchase("p1", "2026-09-05", 1500)), reward];
  check("Travel stays 1,500 even though the descriptor says TRVL (no descriptor decides a category here)", eq(line(rows, "Travel")!.net, 1500));
  check("not income either", eq(economicTotals(rows).income, 0));
}

console.log("12. reimbursement — related to spending in the user's head, not in the data");
{
  const friend = ingest({ id: "zelle", date: "2026-09-12", amount: 400, account: "checking", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER", merchant: "Zelle payment from A FRIEND" });
  const employer = ingest({ id: "exp", date: "2026-09-15", amount: 250, account: "checking", pfcPrimary: "INCOME", pfcDetailed: "INCOME_OTHER_INCOME", merchant: "ACME EXPENSE REIMB" });
  const rows = [ingest(purchase("d1", "2026-09-10", 800, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_RESTAURANT", merchant: "Bistro" })), friend, employer];
  check("neither is silently a refund", friend.flowType === "TRANSFER" && employer.flowType === "INCOME");
  check("Dining stays 800 (the split is not netted by guesswork)", eq(line(rows, "Dining")!.net, 800) && eq(economicTotals(rows).refunds, 0));
}

console.log("13. chargeback / dispute credit — the provider has no dispute flag");
{
  const provisional = ingest(labelledRefund("cb", "2026-09-20", 1500, { merchant: "Stayline" }));
  check("a credit the provider files in the purchase's family IS a refund of that category (indistinguishable from a merchant refund)", provisional.flowType === "REFUND" && provisional.category === "Travel");
  const rebill = ingest(purchase("rebill", "2026-10-15", 1500));
  const all = [ingest(purchase("p1", "2026-09-05", 1500)), provisional, rebill];
  check("September nets to 0 while the credit stands", eq(line(filterByPeriod(all, SEP), "Travel")!.net, 0));
  check("a lost dispute re-bills as a NEW charge in ITS month — 1,500 in October, September untouched", eq(line(filterByPeriod(all, OCT), "Travel")!.net, 1500));
  const issuerSide = ingest({ id: "cb2", date: "2026-09-20", amount: 1500, account: "card", pfcPrimary: "OTHER", pfcDetailed: "OTHER_OTHER", merchant: "DISPUTE CREDIT" });
  check("the SAME credit posted by the issuer with no family ⇒ UNKNOWN, not a refund (descriptor is not evidence)", issuerSide.flowType === "UNKNOWN");
}

console.log("14. reversal — same-day charge and credit");
{
  const rows = [ingest(purchase("p", "2026-06-02", 2871.20)), ingest(labelledRefund("r", "2026-06-02", 2871.20))];
  check("net 0.00 to the cent", cents(line(rows, "Travel")!.net) === 0 && cents(economicTotals(rows).spend) === 0);
}

console.log("15/16. pending → posted (purchase and refund)");
{
  // The read boundary serves ONE row per event: the pending observation is
  // tombstoned when its posted successor arrives (event identity, L8), so the two
  // are never folded together. What THIS layer owes is that either observation
  // classifies and folds identically.
  const pendP = ingest(purchase("pp", "2026-09-13", 732.48, { pending: true })), postP = ingest(purchase("pp2", "2026-09-14", 732.48));
  check("pending purchase and its posted successor classify alike", pendP.flowType === postP.flowType && pendP.category === postP.category);
  const hist = Array(3).fill("Travel");
  const pendR = ingest(misfiledRefund("pr", "2026-09-17", 521.34, hist, { pending: true })), postR = ingest(misfiledRefund("pr2", "2026-09-18", 521.34, hist));
  check("a PENDING misfiled refund is already Travel / REFUND — it never spends a day as income", pendR.flowType === "REFUND" && pendR.category === "Travel");
  check("…and posts as the same thing", postR.flowType === "REFUND" && postR.category === "Travel");
  check("folding the pending observation OR the posted one gives the same figures",
    eq(line([postP, pendR], "Travel")!.net, 732.48 - 521.34) && eq(line([postP, postR], "Travel")!.net, 732.48 - 521.34));
  check("a refund's own pending twin is a CREDIT and can never be its purchase evidence (amount < 0 only)",
    JSON.stringify(priorPurchaseWhere({ financialAccountId: "a", merchantEntityId: null, merchant: "m", description: null, onOrBefore: new Date() }).amount) === '{"lt":0}');
}

console.log("17. duplicate provider delivery");
{
  const p = misfiledRefund("r", "2026-09-18", 521.34, ["Travel"]);
  const a = ingest(p), b = ingest(p);
  check("re-delivery classifies byte-identically, so the upsert on the provider id is a no-op", JSON.stringify(a) === JSON.stringify(b));
  // Identity (one row per plaidTransactionId / event) is the ingest layer's and is
  // pinned there; the fold is a plain sum and deliberately does not dedupe.
}

console.log("18. category attribution is preserved per category");
{
  const rows = [
    ingest(purchase("t", "2026-09-01", 1000)),
    ingest(purchase("d", "2026-09-02", 300, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_FAST_FOOD", merchant: "Delivery Co" })),
    ingest(purchase("s", "2026-09-03", 200, { pfcPrimary: "GENERAL_MERCHANDISE", pfcDetailed: "GENERAL_MERCHANDISE_SUPERSTORES", merchant: "Mart" })),
    ingest(misfiledRefund("dr", "2026-09-04", 18.38, Array(14).fill("Dining"), { pfcDetailed: "INCOME_CONTRACTOR", merchant: "Delivery Co" })),
    ingest(labelledRefund("sr", "2026-09-05", 50, { pfcPrimary: "GENERAL_MERCHANDISE", pfcDetailed: "GENERAL_MERCHANDISE_SUPERSTORES", merchant: "Mart" })),
  ];
  check("Travel 1,000 · Dining 281.62 (300 − 18.38) · Shopping 150 (200 − 50)",
    eq(line(rows, "Travel")!.net, 1000) && eq(line(rows, "Dining")!.net, 281.62) && eq(line(rows, "Shopping")!.net, 150));
  check("there is no generic 'Refund' bucket soaking them up", !categorySpendLedger(rows).some((l) => /refund/i.test(l.category)));
  check("only spend categories may carry a refund", isGenuineSpendCategory("Travel") && !isGenuineSpendCategory("Other")
    && !["Income", "Payment", "Transfer", "Interest", "Fee", "Dividend", "Buy"].some(isGenuineSpendCategory));
}

console.log("19. conservation + invariants");
{
  const rows = [
    ingest(purchase("a", "2026-09-01", 1500)), ingest(labelledRefund("b", "2026-09-02", 500)),
    ingest(purchase("c", "2026-09-03", 90, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_RESTAURANT", merchant: "Bistro" })),
    ingest(labelledRefund("d", "2026-09-04", 240, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_RESTAURANT", merchant: "Bistro" })),
    ingest({ id: "e", date: "2026-09-05", amount: 5306.12, account: "checking", pfcPrimary: "INCOME", pfcDetailed: "INCOME_SALARY", merchant: "ACME PAYROLL" }),
    ingest({ id: "f", date: "2026-09-06", amount: 2000, account: "card", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", merchant: "MOBILE PAYMENT - THANK YOU" }),
  ];
  const tot = economicTotals(rows);
  // gross 1,590 ; refunds 740 ; Travel net 1,000 ; Dining net 0 with 150 unapplied ; headline 850
  check("Σgross − Σrefunds === Σnet − Σunapplied (1,590 − 740 = 1,000 − 150 = 850)", conserved(rows) && eq(tot.spend, 850));
  check("income is the paycheck alone (5,306.12)", eq(tot.income, 5306.12));
  check("every row is AT MOST one of spending / refund / income",
    rows.every((r) => [isCostFlow(r.flowType), isRefund(r.flowType), isIncome(r.flowType)].filter(Boolean).length <= 1));
  check("a refund is never earned income: the income taxonomy names it REFUND_REVERSAL / NOT_INCOME",
    attributeIncome({ flowType: "REFUND", accountType: "debt", amount: 500 }).incomeClass === "NOT_INCOME");
  const acc = { income: 0, spendGross: 0, refunds: 0 };
  foldEconomicRow(acc, "REFUND", 500);
  check("the fold puts a refund in `refunds` and nowhere else", acc.refunds === 500 && acc.income === 0 && acc.spendGross === 0);
  check("classifier version is bumped for the rule change", FLOW_CLASSIFIER_VERSION === 5);
}

console.log("20. Transaction Analysis output (Cash Flow ▸ Spending by category) + row label");
{
  const rows = [ingest(purchase("p1", "2026-09-05", 1500)), ingest(misfiledRefund("r1", "2026-09-12", 500, ["Travel"])),
    ingest(purchase("g", "2026-09-06", 120, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_GROCERIES", merchant: "Grocer" }))];
  const out = outflowByCategory(rows);
  check("ranked by NET: Travel 1,000 then Dining 120", out.map((c) => `${c.id}:${cents(c.value)}`).join() === "Travel:100000,Dining:12000");
  check("only the category WITH a refund carries the offset", out[0].refunds !== undefined && out[1].refunds === undefined);
  const nature = describeRowNature({ flowType: rows[1].flowType, amount: rows[1].amount });
  check("the refund row reads 'Refund', neutral, money IN — not an expense, not income", nature.label === "Refund" && nature.tone === "neutral" && nature.direction === "IN");
  const ui = readFileSync(join(__dirname, "..", "..", "components/space/widgets/CashFlowCategoryBreakdown.tsx"), "utf8");
  check("the widget prints the ledger's figures and subtracts nothing", /c\.gross !== undefined && c\.refunds !== undefined/.test(ui) && !/c\.gross\s*-\s*c\.refunds/.test(ui));
  check("and never words a refund as a saving", !/\bsaved?\b|\bsavings?\b/i.test(ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")));
}

// ── M1 / baseline / Brief ────────────────────────────────────────────────────
function months(rows: Transaction[]): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const t of rows) {
    const month = t.date.slice(0, 7);
    const m = by.get(month) ?? { month, incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, byCategory: [] };
    by.set(month, m);
    const acc = { income: 0, spendGross: 0, refunds: 0 };
    foldEconomicRow(acc, t.flowType ?? null, Math.abs(t.amount));
    m.incomeTotal += acc.income; m.expenseTotal += acc.spendGross; m.refundTotal += acc.refunds;
    if (acc.spendGross > 0 || acc.refunds > 0) {
      let c = m.byCategory.find((x) => x.category === t.category);
      if (!c) { c = { category: t.category, total: 0, count: 0 }; m.byCategory.push(c); }
      c.total += acc.spendGross;
      if (acc.refunds > 0) c.refundTotal = (c.refundTotal ?? 0) + acc.refunds;
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}
const COV: DataCoverage = { corpusFrom: "2026-01-01", corpusTo: "2026-09-30", fetchCapHit: false };
const m1 = (rows: Transaction[], spec: PeriodSpec, category?: string) => {
  const p = resolvePeriod(spec, "2026-10-20");
  return measure("spending", months(rows.filter((r) => r.date >= p.from && r.date <= p.to)), p, COV, category);
};

console.log("21. M1 measure_flows — category and total, net computed by CODE");
{
  const rows = [
    ingest(purchase("a", "2026-08-10", 600)),
    ingest(purchase("b", "2026-09-05", 1500)), ingest(misfiledRefund("r", "2026-09-12", 500, ["Travel"])),
    ingest(purchase("g", "2026-09-06", 400, { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_RESTAURANT", merchant: "Bistro" })),
  ];
  const sepTravel = m1(rows, { month: "2026-09" }, "Travel");
  check("Travel September: total stays GROSS 1,500 (named), netOfRefunds 1,000 with refunds 500",
    eq(sepTravel.total, 1500) && eq(sepTravel.netOfRefunds!.total, 1000) && eq(sepTravel.netOfRefunds!.refunds, 500));
  check("the basis tells the model which is which", /gross of refunds/.test(sepTravel.basis) && /netOfRefunds/.test(sepTravel.basis));
  const sepAll = m1(rows, { month: "2026-09" });
  check("all spending September: gross 1,900 · net 1,400 (1,900 − 500)", eq(sepAll.total, 1900) && eq(sepAll.netOfRefunds!.total, 1400));
  check("a window with no refund carries NO netOfRefunds", m1(rows, { month: "2026-08" }, "Travel").netOfRefunds === undefined);
  const c = compare(sepTravel, m1(rows, { month: "2026-08" }, "Travel"));
  // gross: 1,500 − 600 = +900 (150%) ; net: 1,000 − 600 = +400 (66.67%)
  check("comparison on gross: +900 / +150%", eq(c.change!.abs, 900) && eq(c.change!.pct!, 150));
  check("comparison NET of refunds is computed too: 1,000 vs 600 = +400 / +66.67%",
    eq(c.changeNetOfRefunds!.left, 1000) && eq(c.changeNetOfRefunds!.right, 600) && eq(c.changeNetOfRefunds!.abs, 400) && eq(c.changeNetOfRefunds!.pct!, 66.67));
  const before = [rows[0], rows[1], rows[3], { ...rows[2], category: "Income" as TransactionCategory, flowType: "INCOME" as FlowType }];
  check("BEFORE the fix the same data gave the model no Travel refund at all", m1(before, { month: "2026-09" }, "Travel").netOfRefunds === undefined);
}

console.log("22. expense baseline — impact stated, not hidden");
{
  // Two whole months. Aug: 3,000 spent. Sep: 5,000 charged, 2,000 refunded.
  const mk = (month: string, expenseTotal: number, refundTotal: number) => ({ month, incomeTotal: 0, expenseTotal, refundTotal,
    debtPaymentTotal: 0, transferTotal: 0, transactionCount: 1, byCategory: [], topCategories: [] });
  const txn = { monthlyBreakdown: [mk("2026-08", 3000, 0), mk("2026-09", 5000, 2000)] } as unknown as TransactionsSummaryData;
  // GROSS mean = (3,000 + 5,000) / 2 = 4,000 ; NET mean = (3,000 + 3,000) / 2 = 3,000.
  // REFUND-1 left the measured baseline GROSS and said so here. NET-BASELINE-1
  // supersedes that: "how much do I spend a month" is net economic spending
  // (full matrix: lib/transactions/net-expense-baseline.test.ts).
  check("the MEASURED baseline is the NET mean, 3,000 — not the gross 4,000 (NET-BASELINE-1)",
    eq(computeAverageMonthlySpending(txn)!, 3000));
  const p = resolvePeriod({ from: "2026-08-01", to: "2026-09-30" }, "2026-10-20");
  const r = measure("spending", txn.monthlyBreakdown as unknown as MonthRow[], p, COV);
  check("M1 agrees with it on gross (4,000/month) and ALSO states the net rate (3,000/month)",
    eq(r.perCompleteMonth!, 4000) && eq(r.netOfRefunds!.perCompleteMonth!, 3000));
  check("what a correct classification changes TODAY: a refund no longer inflates INCOME, so the surplus is not overstated",
    eq(economicTotals([ingest(misfiledRefund("r", "2026-09-12", 2000, ["Travel"]))]).income, 0));
}

console.log("23. Daily Brief recent-activity evidence");
{
  const refund = ingest(misfiledRefund("r", "2026-09-18", 521.34, ["Travel"], { merchant: "Stayline" }));
  const top = projectRecentActivity([refund], { from: "2026-09-14", to: "2026-09-20" }, true).top[0];
  check("the Brief is handed flow REFUND / category Travel — never 'INCOME' from a lodging brand", top.flow === "REFUND" && top.category === "Travel" && eq(top.amount, 521.34));
}

console.log("24. the ingest seam runs the chain in THIS order");
{
  const src = readFileSync(join(__dirname, "..", "plaid", "syncTransactions.ts"), "utf8");
  const at = (s: string) => src.indexOf(s);
  const order = [at("category = resolveLiabilityPaymentCategory("), at("category = resolvePayrollIncomeCategory("),
    at("category = resolveLiabilityMerchantCreditCategory("), at("const classification = classifyFlow(input)")];
  check("payment rescue → payroll rescue → merchant credit → classifyFlow", order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]));
  check("the history read is gated, so it runs only for the affected population", at("if (needsMerchantCreditEvidence(") > 0 && at("if (needsMerchantCreditEvidence(") < at("readPriorPurchaseCategories("));
}

console.log(`\nREFUND ECONOMICS: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);

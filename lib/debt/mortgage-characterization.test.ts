/**
 * lib/debt/mortgage-characterization.test.ts
 *
 * CHARACTERIZATION — documents current behaviour, not desired behaviour; see
 * mortgage-investigation (private path map + ranked hypotheses H1–H8).
 *
 * Every block below pins what the code does TODAY for a mortgage, using only
 * fabricated fixture values (a $10k checking account, a $300k mortgage, a $5k
 * card, a $500k property). Nothing here is a customer figure.
 *
 * Where today's behaviour looks wrong, a `// SUSPECTED DEFECT:` comment states
 * the behaviour we believe is correct. Those are PROPOSALS to be decided with
 * S2 / the owner — this file changes no product code, and when a fix lands the
 * matching assertion here is expected to flip (update it in the same PR).
 *
 * Pure: no DB, no network, no clock (dates injected).
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/mortgage-characterization.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyAccounts, unvaluedBalanceLabel } from "@/lib/account-classifier";
import {
  computeSnapshotFields, computeLiquidSplit, isReconstructableCard, isHeldFlatBalanceAccount,
  computeAccountFloors, reconstructDailyLiabilityBalances, addDaysUTC, isoDate,
} from "@/lib/snapshots/backfill-core";
import { classifyFlow } from "@/lib/transactions/flow-classifier";
import { mapPlaidCategory } from "@/lib/transactions/plaid-category";
import { computeDebtService, netAfterDebtPaydown } from "@/lib/transactions/debt-service";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { LIABILITY_PAYMENT_DETAILS } from "@/lib/transactions/transfer-debt-payment-correction";
import { computeDebtAggregate } from "@/lib/debt/aggregates";
import { computeInterestCost } from "@/lib/debt/interest-cost";
import { resolveEffectiveDebtTerms } from "@/lib/debt/effective-terms";
import { planPayoff } from "@/lib/debt/payoff";
import { isRevolvingLine, creditUtilization } from "@/lib/accounts/credit-utilization";
import { resolveAccountBalances } from "@/lib/balances/account-balances";
import { resolveAccountFreshness } from "@/lib/freshness/observation";
import { resolveWalletBalance } from "@/lib/crypto/wallet-current-value";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const near = (a: number | null | undefined, b: number, eps = 0.005) => typeof a === "number" && Math.abs(a - b) < eps;
const LABEL = "CHARACTERIZATION — documents current behaviour, not desired behaviour; see mortgage-investigation";

// ── Shared fabricated fixtures ───────────────────────────────────────────────
const CHECKING = { id: "chk", type: "checking", balance: 10_000, currency: "USD" };
const MORTGAGE = { id: "mtg", type: "debt", balance: 300_000, currency: "USD", providerSubtype: "mortgage" };
const CARD     = { id: "card", type: "debt", balance: 5_000, currency: "USD", providerSubtype: "credit card" };

/** A Plaid mortgage-payment row as the import path would classify it. */
function plaidFlow(accountType: string, amount: number, detailed = "LOAN_PAYMENTS_MORTGAGE_PAYMENT") {
  const pfc = { primary: "LOAN_PAYMENTS", detailed, confidence_level: "HIGH" };
  const category = mapPlaidCategory({ personal_finance_category: pfc, category: null, merchant_name: "Mortgage Servicer", name: "MORTGAGE PMT" } as never);
  return { category, ...classifyFlow({ category, amount, accountType, debtSubtype: null, pfcPrimary: pfc.primary, pfcDetailed: pfc.detailed }) };
}

let seq = 0;
function tx(o: { own: string; amount: number; flowType: string; cp?: string | null; transferMaturity?: string | null; incomeClass?: string | null }): LiquidityTx {
  return {
    id: `t${++seq}`, accountId: o.own, financialAccountId: o.own, counterpartyAccountId: o.cp ?? null,
    amount: o.amount, flowType: o.flowType, incomeClass: o.incomeClass ?? (o.flowType === "INCOME" ? "EARNED_INCOME" : null),
    incomeSubtype: null, transferMaturity: o.transferMaturity ?? null,
    currency: "USD", date: "2026-05-10", merchant: "m", category: "Other", pending: false,
  } as unknown as LiquidityTx;
}
const abs = (r: LiquidityTx) => Math.abs(r.amount);

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H1. Liquid net worth with a mortgage — ${LABEL}`);
{
  const c = classifyAccounts([CHECKING, MORTGAGE]);
  const f = computeSnapshotFields(c);
  check("H1 netWorth = 10,000 − 300,000 = −290,000", f.netWorth === -290_000, f.netWorth);
  // SUSPECTED DEFECT: "Liquid net worth" subtracts the whole mortgage from cash.
  // A long-dated installment loan is not a liquid claim; expected (to decide with
  // S2/owner) is liquid NW = cash + savings − revolving/short-term debt only
  // (≈ +10,000 here), with the mortgage counted in total net worth only.
  check("H1 netLiquid = cash + savings − ALL debt (mortgage included) = −290,000", f.netLiquid === -290_000, f.netLiquid);
  const split = computeLiquidSplit(c);
  check("H1 Hero-basis netLiquidUnrestricted also subtracts the mortgage (−290,000)", split?.netLiquidUnrestricted === -290_000, split);
  // Contrast: the same household with a $5k card instead — the formula is debt-type blind.
  const fc = computeSnapshotFields(classifyAccounts([CHECKING, CARD]));
  check("H1 contrast: card-only household netLiquid = 5,000 (same formula)", fc.netLiquid === 5_000, fc.netLiquid);
  const lens = readFileSync(join(process.cwd(), "lib/history/lens-root-node.ts"), "utf8");
  check("H1 lens root 'Liquid net worth' formula is 'Cash + Savings − Debt' (no debt-type filter)",
    lens.includes('formula: "Cash + Savings − Debt"') && lens.includes('subtracts: ["debt"]'));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H2. Mortgage payment from checking: paydown vs spending — ${LABEL}`);
{
  const cashLeg = plaidFlow("checking", -2_500);
  check("H2 PFC LOAN_PAYMENTS → category 'Payment'", cashLeg.category === "Payment", cashLeg.category);
  check("H2 checking −2,500 mortgage payment classifies DEBT_PAYMENT / INTERNAL", cashLeg.flowType === "DEBT_PAYMENT" && cashLeg.flowDirection === "INTERNAL", cashLeg);
  check("H2 LOAN_PAYMENTS_MORTGAGE_PAYMENT is a provider-named liability detail (unpaired leg stays DEBT_PAYMENT)",
    LIABILITY_PAYMENT_DETAILS.has("LOAN_PAYMENTS_MORTGAGE_PAYMENT"));

  // (a) Mortgage connected, both legs present, lender posted NO interest row.
  const ctx = tierResolver([{ id: "chk", type: "checking" }, { id: "mtg", type: "debt" }]);
  const liabLeg = plaidFlow("debt", 2_500);
  check("H2 liability leg +2,500 classifies DEBT_PAYMENT / INFLOW", liabLeg.flowType === "DEBT_PAYMENT" && liabLeg.flowDirection === "INFLOW", liabLeg);
  const rows = [
    tx({ own: "chk", amount: 8_000, flowType: "INCOME" }),
    tx({ own: "chk", amount: -2_500, flowType: cashLeg.flowType, cp: "mtg" }),
    tx({ own: "mtg", amount: 2_500, flowType: liabLeg.flowType, cp: "chk" }),
  ];
  const s = computeDebtService(rows, ctx, abs);
  const econ = economicTotals(rows as never);
  check("H2a counted payments = 2,500 (cash leg only)", s.payments === 2_500, s);
  // SUSPECTED DEFECT: the whole 2,500 is treated as principal reduction. A real
  // mortgage payment is principal + interest (+ escrow: tax/insurance). Expected:
  // interest and escrow are housing COSTS (in spending), and only principal is
  // netPaydown — which needs a P/I/escrow split (Plaid /liabilities or user terms).
  check("H2a netPaydown = 2,500 (100% treated as principal)", s.netPaydown === 2_500, s);
  check("H2a economic spending = 0 (no part of the payment reaches spending)", econ.spend === 0, econ);
  check("H2a economic net = 8,000; after-paydown net = 5,500", econ.net === 8_000 && netAfterDebtPaydown(econ.net, s) === 5_500,
    { net: econ.net, after: netAfterDebtPaydown(econ.net, s) });

  // (b) Lender DOES post a 1,500 interest row on the mortgage account.
  const rowsI = [...rows, tx({ own: "mtg", amount: -1_500, flowType: "INTEREST" })];
  const sI = computeDebtService(rowsI, ctx, abs);
  const econI = economicTotals(rowsI as never);
  check("H2b with a lender interest row: netPaydown = 1,000, spending = 1,500", sI.netPaydown === 1_000 && econI.spend === 1_500, { sI, spend: econI.spend });

  // (c) Mortgage NOT connected: unpaired cash leg, no counterparty, no maturity.
  const ctxU = tierResolver([{ id: "chk", type: "checking" }]);
  const unpaired = [tx({ own: "chk", amount: 8_000, flowType: "INCOME" }), tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT" })];
  const sel = selectDebtPaymentCashLegs(unpaired, ctxU);
  const sU = computeDebtService(unpaired, ctxU, abs);
  const econU = economicTotals(unpaired as never);
  console.log(`    observed (c): counted=${sel.counted.length} payments=${sU.payments} netPaydown=${sU.netPaydown} spend=${econU.spend}`);
  check("H2c unattested unpaired leg: NOT counted as a debt payment (payments = 0)", sel.counted.length === 0 && sU.payments === 0, sU);
  check("H2c ... and still not in spending (spend = 0) — the 2,500 is in neither figure", econU.spend === 0, econU);
  // SUSPECTED DEFECT (c): an unconnected mortgage payment vanishes from both
  // spending and paydown on the economic axis. Expected: at least the housing
  // cost (interest + escrow) is visible somewhere, or the gap is disclosed.

  // (d) Unpaired leg, transfer authority proved a liability destination TYPE.
  const attested = [tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", transferMaturity: "DEBT_PAYMENT" })];
  const sA = computeDebtService(attested, ctxU, abs);
  check("H2d unpaired leg with transferMaturity=DEBT_PAYMENT: payments = netPaydown = 2,500", sA.payments === 2_500 && sA.netPaydown === 2_500, sA);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H3. Plaid mortgage with no terms (debtSubtype/interestRate/minimumPayment null) — ${LABEL}`);
{
  const terms = resolveEffectiveDebtTerms({ interestRate: null, minimumPayment: null, debtProfile: null });
  check("H3 effective terms for a Plaid mortgage: apr null, minimumPayment null", terms.apr === null && terms.minimumPayment === null, terms);

  const agg = computeDebtAggregate([
    { balance: 300_000, apr: null, minimumPayment: null }, // mortgage — nothing from Plaid
    { balance: 5_000,   apr: 25,   minimumPayment: 150  }, // card
  ]);
  check("H3 totalOwed = 305,000", agg.totalOwed === 305_000, agg);
  // SUSPECTED DEFECT: Σ minimums omits the mortgage entirely (it contributes 0),
  // so monthly obligations read ~150 instead of ~150 + the mortgage payment.
  // Expected: mortgage payment sourced from /liabilities or user terms, or the
  // total flagged as partial wherever it is shown (missingMinimumCount exists).
  check("H3 Σ minimumPayment = 150 (mortgage contributes 0); missingMinimumCount = 1",
    agg.minimumPayment === 150 && agg.missingMinimumCount === 1, agg);
  // SUSPECTED DEFECT: the "weighted APR" over 305k of debt reads 25% because
  // only the card is rated. Expected: disclose as partial (unratedCount=1) or
  // avoid presenting it as the household's rate.
  check("H3 weightedApr = 25 (card only); unratedCount = 1", agg.weightedApr === 25 && agg.unratedCount === 1, agg);

  const ic = computeInterestCost([{ id: "mtg", balance: 300_000, aprPct: null }, { id: "card", balance: 5_000, aprPct: 25 }]);
  check("H3 monthly interest = 104.17 (card only); mortgage unknown, sorted last", near(ic.totalMonthly, 104.1667, 0.01) && ic.unknownCount === 1 && ic.rows[1]?.id === "mtg", ic);

  const plan = planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [
    { id: "mtg", balance: 300_000, aprPct: null }, { id: "card", balance: 5_000, aprPct: 25 },
  ] });
  const mtg = plan.status === "paid_off" ? plan.liabilities.find((l) => l.id === "mtg") : undefined;
  const basis = "basis" in plan ? plan.basis : null;
  console.log(`    observed: status=${plan.status} basis=${basis?.interest} mtgBasis=${mtg?.interestBasis} mtgInterest=${mtg?.interestPaid}`);
  check("H3 payoff basis = PARTIAL_INTEREST", basis?.interest === "PARTIAL_INTEREST", basis);
  // SUSPECTED DEFECT (disclosed, but material at mortgage scale): the mortgage
  // is modelled at an ASSUMED 0%, so its payoff date and total interest are
  // wildly optimistic. Expected: require/collect a rate before projecting a
  // mortgage, or exclude it from the payoff plan.
  check("H3 mortgage modelled ASSUMED_ZERO_UNKNOWN_APR with interestPaid = 0",
    mtg?.interestBasis === "ASSUMED_ZERO_UNKNOWN_APR" && mtg?.interestPaid === 0, mtg);

  // Rate label: keyed on debtSubtype ONLY (never providerSubtype, which is the
  // field Plaid actually sets). resolveRateLabel is module-private → source scan.
  const src = readFileSync(join(process.cwd(), "lib/ai/assemblers/accounts.ts"), "utf8");
  const fn = src.slice(src.indexOf("function resolveRateLabel("), src.indexOf("function resolveRateLabel(") + 700);
  check("H3 rate label resolver switches on debtSubtype", fn.includes("switch (debtSubtype)") && fn.includes("case 'mortgage':       return 'Mortgage Rate';"));
  check("H3 rate label resolver never reads providerSubtype; default is 'APR'", !fn.includes("providerSubtype") && fn.includes("default:               return 'APR';"));
  check("H3 call site passes fa.debtSubtype (null for Plaid) ⇒ a Plaid mortgage is labelled 'APR'",
    src.includes("label:       resolveRateLabel(fa.debtSubtype),"));
  // SUSPECTED DEFECT: expected label "Mortgage Rate" when providerSubtype is "mortgage".
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H4. Payoff allocation: $300k mortgage + $5k card, $3k/month — ${LABEL}`);
{
  const run = (mtgApr: number | null) => planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [
    { id: "mtg", balance: 300_000, aprPct: mtgApr }, { id: "card", balance: 5_000, aprPct: 25 },
  ] });
  const pinned = { "6.5": { payoff: "2039-02-18", count: 158 }, "null": { payoff: "2034-10-31", count: 106 } } as const;
  for (const apr of [6.5, null] as const) {
    const p = run(apr);
    const cardFirst = p.status === "paid_off" ? p.payments[0]?.allocations.find((a) => a.id === "card") : undefined;
    const card = p.status === "paid_off" ? p.liabilities.find((l) => l.id === "card") : undefined;
    const mtg  = p.status === "paid_off" ? p.liabilities.find((l) => l.id === "mtg") : undefined;
    console.log(`    observed (mortgage APR ${apr}): status=${p.status} card payoff=${card?.payoffISO} (${card?.paymentCount} pmts) cardFirstAlloc=${cardFirst?.paid} mortgage payoff=${mtg?.payoffISO}`);
    check(`H4 [mtg APR ${apr}] plan is paid_off under PRO_RATA_BY_BALANCE`, p.status === "paid_off" && p.allocation === "PRO_RATA_BY_BALANCE", p.status);
    check(`H4 [mtg APR ${apr}] card's first allocation is ~1.6% of 3,000 (< 60)`, !!cardFirst && cardFirst.paid < 60, cardFirst);
    // SUSPECTED DEFECT: pro-rata by balance lets the mortgage absorb ~98% of the
    // budget, so a 25% card is carried for years (its card interest outruns its
    // share at first). Expected (owner/S2 decision): avalanche/snowball or
    // "minimums first, surplus to highest APR", or exclude installment loans.
    check(`H4 [mtg APR ${apr}] card is NOT paid off within 24 months (it would be in 2 alone)`,
      !!card && card.paymentCount > 24, card?.paymentCount);
    const pin = pinned[String(apr) as keyof typeof pinned];
    check(`H4 [mtg APR ${apr}] card payoff ${pin.payoff} after ${pin.count} payments — same day as the mortgage`,
      card?.payoffISO === pin.payoff && card?.paymentCount === pin.count && mtg?.payoffISO === pin.payoff, { card: card?.payoffISO, n: card?.paymentCount, mtg: mtg?.payoffISO });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H5. Mortgage carrying a creditLimit (balances.limit from Plaid) — ${LABEL}`);
{
  const withLimit = { type: "debt", debtSubtype: null, creditLimit: 400_000, providerSubtype: "mortgage" };
  // FIXED by F2 — desired behaviour: a Plaid `loan` subtype (mortgage/auto/
  // student/…) is never reconstructable/revolving; its creditLimit is ignored
  // (lib/debt/liability-kind.ts isInstallmentLoan).
  check("H5 isReconstructableCard = FALSE for a limit-bearing mortgage (debtSubtype null)", isReconstructableCard(withLimit) === false);
  check("H5 contrast: same mortgage with creditLimit null ⇒ not walked", isReconstructableCard({ ...withLimit, creditLimit: null }) === false);
  check("H5 contrast: debtSubtype 'mortgage' ⇒ not walked even with a limit", isReconstructableCard({ ...withLimit, debtSubtype: "mortgage" }) === false);
  check("H5 isRevolvingLine = FALSE (not in the utilization population)", isRevolvingLine(withLimit) === false);
  const util = creditUtilization([{ id: "mtg", name: "Mortgage", type: "debt", balance: 300_000, creditLimit: 400_000, providerSubtype: "mortgage" }]);
  check("H5 credit utilization: no row for a limit-bearing mortgage", util.rows.length === 0 && util.missingLimit.length === 0, util);
  const utilNo = creditUtilization([{ id: "mtg", name: "Mortgage", type: "debt", balance: 300_000, creditLimit: null, providerSubtype: "mortgage" }]);
  check("H5 contrast: limit-less mortgage is NOT in missingLimit (no 'add limit' affordance)", utilNo.missingLimit.length === 0, utilNo);

  const NOW = new Date("2026-06-30T12:00:00.000Z");
  const fresh = resolveAccountFreshness({ accountId: "mtg", ingestedAt: new Date(NOW.getTime() - 86_400_000).toISOString(), providerBalanceAt: null }, NOW);
  const bal = resolveAccountBalances({ accountId: "mtg", accountType: "debt", debtSubtype: null, providerSubtype: "mortgage", currency: "USD",
    balance: 300_000, availableBalance: 100_000, creditLimit: 400_000, freshness: fresh });
  check("H5 availableBalance 100,000 is NOT read as AVAILABLE_CREDIT (NOT_APPLICABLE)",
    !JSON.stringify(bal.available).includes("AVAILABLE_CREDIT") && JSON.stringify(bal.available).includes("NOT_APPLICABLE"), bal.available);

  // Walk: three +2,500 payments (FM sign: into the liability) 10/40/70 days ago.
  // The walk population is chosen by isReconstructableCard, so the mortgage is
  // held flat — its past owed is never rebuilt from whole payments.
  const today = new Date("2026-06-30T00:00:00.000Z");
  const deltas = new Map([["mtg", new Map([
    [isoDate(addDaysUTC(today, -10)), 2_500], [isoDate(addDaysUTC(today, -40)), 2_500], [isoDate(addDaysUTC(today, -70)), 2_500],
  ])]]);
  const walked = [{ id: "mtg", balance: 300_000, ...withLimit }].filter(isReconstructableCard).map((a) => ({ id: a.id, balance: a.balance }));
  const walk = reconstructDailyLiabilityBalances(walked, deltas, today, addDaysUTC(today, -90));
  const d80 = walk.get(isoDate(addDaysUTC(today, -80)))?.get("mtg");
  check("H5 not walked as a card: no reconstructed owed for the mortgage (held flat)", walked.length === 0 && d80 === undefined, d80);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H6. Sign of the payment row on the mortgage account itself — ${LABEL}`);
{
  const ctx = tierResolver([{ id: "chk", type: "checking" }, { id: "mtg", type: "debt" }]);
  const debitRow  = plaidFlow("debt", -2_500); // servicer posts payment received as a DEBIT
  const creditRow = plaidFlow("debt", 2_500);  // conventional: payment reduces owed
  check("H6 mortgage-account −2,500 LOAN_PAYMENTS ⇒ SPENDING (CCPAY-2B liability-outflow veto)",
    debitRow.flowType === "SPENDING" && debitRow.reason === "ACCOUNT_TYPE_CONTEXT", debitRow);
  check("H6 contrast: mortgage-account +2,500 ⇒ DEBT_PAYMENT / INFLOW", creditRow.flowType === "DEBT_PAYMENT", creditRow);

  const inverted = [
    tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", cp: "mtg" }),
    tx({ own: "mtg", amount: -2_500, flowType: debitRow.flowType }),
  ];
  const s = computeDebtService(inverted, ctx, abs);
  const econ = economicTotals(inverted as never);
  // SUSPECTED DEFECT: with a sign-inverted servicer row the same payment is a
  // DEBT_PAYMENT cash leg AND a 2,500 "purchase" on the mortgage: spending +2,500
  // and netPaydown 0. Expected: detect the pair (same amount/date, counterparty
  // mortgage) and treat the liability row as the payment's receiving leg.
  check("H6 inverted pair: economic spending = 2,500 (payment counted as a charge)", econ.spend === 2_500, econ);
  check("H6 inverted pair: payments 2,500, newChargesOnLiabilities 2,500, netPaydown 0",
    s.payments === 2_500 && s.newChargesOnLiabilities === 2_500 && s.netPaydown === 0, s);
  const ok = [
    tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", cp: "mtg" }),
    tx({ own: "mtg", amount: 2_500, flowType: creditRow.flowType, cp: "chk" }),
  ];
  const econOk = economicTotals(ok as never);
  check("H6 contrast: conventional pair ⇒ spending 0, netPaydown 2,500",
    econOk.spend === 0 && computeDebtService(ok, ctx, abs).netPaydown === 2_500, econOk);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H7. History: past mortgage balances — ${LABEL}`);
{
  // Mirrors the per-day assembly in lib/snapshots/backfill.ts with its own pure
  // authorities (floors, held-flat, card walk, classify, snapshot fields). The
  // source scan at the end pins that backfill.ts still assembles days this way.
  const today = new Date("2026-06-30T00:00:00.000Z");
  const connected = addDaysUTC(today, -30);
  const dayDebt = (mtgHasTx: boolean, earliestTx: Date | null, daysAgo: number) => {
    const accounts = [
      { ...CHECKING, debtSubtype: null, creditLimit: null, providerSubtype: null },
      { ...MORTGAGE, debtSubtype: null, creditLimit: null },
    ];
    const earliest = new Map<string, Date>();
    if (mtgHasTx && earliestTx) earliest.set("mtg", earliestTx);
    const heldFlat = new Set(accounts.filter((a) => isHeldFlatBalanceAccount(a, earliest.has(a.id))).map((a) => a.id));
    const floors = computeAccountFloors(
      accounts.map((a) => ({ id: a.id, linkCreatedAt: connected, type: a.type, accountCreatedAt: connected })),
      earliest, heldFlat, false, today,
    );
    const d = addDaysUTC(today, -daysAgo);
    const walked = accounts.filter(isReconstructableCard).map((a) => a.id);
    const dayAccounts = accounts.filter((a) => floors.get(a.id)!.getTime() <= d.getTime());
    const f = computeSnapshotFields(classifyAccounts(dayAccounts));
    return { debt: f.debt, netWorth: f.netWorth, heldFlat: heldFlat.has("mtg"), walked: walked.includes("mtg"), floor: isoDate(floors.get("mtg")!) };
  };

  // (a) Mortgage WITH 12 months of payment transactions, first one 365 days ago.
  const withTx = dayDebt(true, addDaysUTC(today, -365), 364);
  check("H7a with tx: not held flat, not walked; floor = earliest tx", !withTx.heldFlat && !withTx.walked && withTx.floor === isoDate(addDaysUTC(today, -365)), withTx);
  // SUSPECTED DEFECT: 364 days ago the mortgage is shown at TODAY's 300,000,
  // understating past debt by the principal repaid since (and flattening the NW
  // trend). Expected: walk installment principal back from payments (needs the
  // P/I split) or mark the liability component explicitly flat/estimated.
  check("H7a day −364 debt = 300,000 (held at today's balance)", withTx.debt === 300_000, withTx);

  // (b) Mortgage with NO transactions: held flat from its connection date (PB-8).
  const noTxAfter  = dayDebt(false, null, 10);
  const noTxBefore = dayDebt(false, null, 60);
  check("H7b no tx: held flat, floor = connection date", noTxAfter.heldFlat && noTxAfter.floor === isoDate(connected), noTxAfter);
  check("H7b no tx: day −10 debt = 300,000", noTxAfter.debt === 300_000, noTxAfter);
  // SUSPECTED DEFECT (by design per PB-8 "UNKNOWN before", but visible): before
  // the connection date the mortgage drops out, so NW steps from +10,000 to
  // −290,000 on the connection day. Expected: the pre-connection range is
  // shown as unknown/partial rather than as a debt-free household.
  check("H7b no tx: day −60 debt = 0, netWorth = +10,000 (mortgage absent before connection)", noTxBefore.debt === 0 && noTxBefore.netWorth === 10_000, noTxBefore);

  const bf = readFileSync(join(process.cwd(), "lib/snapshots/backfill.ts"), "utf8");
  check("H7 backfill.ts: non-cash, non-card accounts keep their current (flat) balance per day",
    bf.includes("everything else keeps its current (flat) balance") && bf.includes(".filter(isReconstructableCard)"));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H8. Property + mortgage; unobserved mortgage balance — ${LABEL}`);
{
  const property = { id: "house", type: "other", balance: 500_000, currency: "USD" };
  const c = classifyAccounts([CHECKING, property, MORTGAGE]);
  check("H8 property 500,000 + mortgage 300,000 + checking 10,000 ⇒ netWorth 210,000", c.netWorth === 210_000, c.netWorth);
  // No property↔mortgage link exists, so an equity-entered property is not detected.
  const equityEntered = classifyAccounts([CHECKING, { ...property, balance: 200_000 }, MORTGAGE]);
  // SUSPECTED DEFECT (user-entry risk): a property entered at EQUITY (200,000)
  // while the mortgage is also connected subtracts the loan twice: NW −90,000
  // instead of 210,000. Expected: a property↔mortgage link / entry guidance
  // ("enter market value, not equity").
  check("H8 property entered at equity 200,000 + connected mortgage ⇒ netWorth −90,000 (double subtraction)", equityEntered.netWorth === -90_000, equityEntered.netWorth);

  const wb = resolveWalletBalance(300_000, undefined, false); // balanceObserved=false
  const unobserved = { ...MORTGAGE, balance: wb.balance, valuationUnknown: wb.valuationUnknown };
  const cu = classifyAccounts([CHECKING, property, unobserved]);
  check("H8 balanceObserved=false mortgage ⇒ valuationUnknown, balance 0", wb.valuationUnknown === true && wb.balance === 0, wb);
  // Disclosed (unvaluedCount + "Balance unavailable") but NW is overstated by the
  // whole mortgage. Expected: keep exclusion, but surface it prominently as
  // "net worth excludes an unvalued liability" on every NW surface.
  check("H8 unobserved mortgage drops out: totalLiabilities 0, netWorth 510,000", cu.totalLiabilities === 0 && cu.netWorth === 510_000, { l: cu.totalLiabilities, nw: cu.netWorth });
  check("H8 ... disclosed: unvaluedCount = 1, label 'Balance unavailable'", cu.unvaluedCount === 1 && unvaluedBalanceLabel(unobserved) === "Balance unavailable", cu.unvaluedCount);
}

if (failures > 0) { console.error(`\n${failures} characterization check(s) failed`); process.exit(1); }
console.log("\nAll mortgage characterization checks pass (current behaviour pinned).");

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
import { classifyFlow, isInstallmentServicerPaymentLeg } from "@/lib/transactions/flow-classifier";
import { mapPlaidCategory } from "@/lib/transactions/plaid-category";
import { computeDebtService, netAfterDebtPaydown } from "@/lib/transactions/debt-service";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { tierResolver, classifyLiquidity, type LiquidityContext, type LiquidityTx } from "@/lib/transactions/liquidity";
import { LIQUIDITY_REASON_LABEL } from "@/lib/transactions/liquidity-breakdown";
import { resolveDestinationEvidence, maturityForEvidence } from "@/lib/transactions/transfer-maturation";
import { UNSPLIT_MORTGAGE_PAYMENT_LABEL, unsplitLoanPaymentLabel } from "@/lib/debt/liability-kind";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { LIABILITY_PAYMENT_DETAILS } from "@/lib/transactions/transfer-debt-payment-correction";
import { computeDebtAggregate } from "@/lib/debt/aggregates";
import { computeInterestCost } from "@/lib/debt/interest-cost";
import { resolveEffectiveDebtTerms } from "@/lib/debt/effective-terms";
import { planPayoff } from "@/lib/debt/payoff";
import { computeDebtStrategy } from "@/lib/ai/intelligence/annotations/metrics";
import { rateLabel } from "@/lib/debt/rate-label";
import { payoffUnknownRateNote } from "@/components/space/widgets/debt/payoff-copy";
import { isRevolvingLine, creditUtilization } from "@/lib/accounts/credit-utilization";
import { resolveAccountBalances } from "@/lib/balances/account-balances";
import { resolveAccountFreshness } from "@/lib/freshness/observation";
import { resolveWalletBalance } from "@/lib/crypto/wallet-current-value";
import { excludedAccountCounts, unobservedTotalCoverage } from "@/lib/balances/unobserved-totals";
import { liabilityKind } from "@/lib/debt/liability-kind";
import { resolveAccountsAsOf } from "@/lib/data/accounts-asof.core";
import { resolveAccountCoverage, coverageClassFor } from "@/lib/data/account-coverage.core";
import {
  deriveBalanceCoverage, writerAlignedFloorISO, estimatedCoverageLabel, markPartialBalanceCoverage,
} from "@/lib/connections/balance-coverage.core";
import { isEstimatedOn } from "@/lib/ai/conversation/tools/history";

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

/** A Plaid mortgage-payment row as the import path would classify it.
 *  `providerSubtype` (Mortgage F5) is the account's Plaid subtype — the sync path
 *  now hands it to the classifier as liability-kind evidence. */
function plaidFlow(accountType: string, amount: number, detailed = "LOAN_PAYMENTS_MORTGAGE_PAYMENT", providerSubtype: string | null = null, primary = "LOAN_PAYMENTS") {
  const pfc = { primary, detailed, confidence_level: "HIGH" };
  const category = mapPlaidCategory({ personal_finance_category: pfc, category: null, merchant_name: "Mortgage Servicer", name: "MORTGAGE PMT" } as never);
  return { category, ...classifyFlow({ category, amount, accountType, debtSubtype: null, providerSubtype, pfcPrimary: pfc.primary, pfcDetailed: pfc.detailed }) };
}

/** Σ|amount| of rows the liquidity authority files as CASH_OUT (household Cash Out). */
function cashOut(rows: readonly LiquidityTx[], ctx: LiquidityContext): number {
  return rows.reduce((t, r) => t + (classifyLiquidity(r, ctx).effect === "CASH_OUT" ? Math.abs(r.amount) : 0), 0);
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
  // FIXED by F1 (owner 2026-11-08) — a long-dated installment loan is not a
  // liquid claim: liquid NW = cash + savings − revolving/unknown debt only; the
  // mortgage stays in total net worth (above) and in debt.
  check("H1 netLiquid excludes the mortgage (installment) = +10,000 — FIXED by F1", f.netLiquid === 10_000, f.netLiquid);
  check("H1 ... the mortgage is still in debt (300,000) and the classifier names it installment", f.debt === 300_000 && c.totalInstallmentLiabilities === 300_000, { debt: f.debt, inst: c.totalInstallmentLiabilities });
  const split = computeLiquidSplit(c);
  check("H1 Hero-basis netLiquidUnrestricted also excludes the mortgage (+10,000) — FIXED by F1", split?.netLiquidUnrestricted === 10_000, split);
  // Contrast: the same household with a $5k card instead — revolving debt stays in liquid NW.
  const fc = computeSnapshotFields(classifyAccounts([CHECKING, CARD]));
  check("H1 contrast: card-only household netLiquid = 5,000 (revolving debt still subtracted)", fc.netLiquid === 5_000, fc.netLiquid);
  const lens = readFileSync(join(process.cwd(), "lib/history/lens-root-node.ts"), "utf8");
  check("H1 lens root 'Liquid net worth' formula names the installment exclusion — FIXED by F1",
    lens.includes("formula: LIQUID_NET_WORTH_FORMULA") && lens.includes("notSubtracted:"));
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

  // (c) Mortgage NOT connected: unpaired cash leg, no counterparty. The transfer
  //     authority sees the provider's mortgage-payee detail and NO owned
  //     destination, and names the leaf UNTRACKED_LOAN_PAYMENT (Mortgage F10).
  const ctxU = tierResolver([{ id: "chk", type: "checking" }]);
  const noDest = resolveDestinationEvidence([], { movementForm: null, competingSourceCount: 1 });
  const untrackedMaturity = maturityForEvidence(noDest, {
    accountType: "checking", amount: -2_500, providerFamily: "LOAN_PAYMENTS", persistedCounterpartyAccountId: null,
    railType: null, venueClass: null, counterpartyClass: null, pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
  });
  check("H2c the transfer authority names an unconnected mortgage payment UNTRACKED_LOAN_PAYMENT (F10)", untrackedMaturity === "UNTRACKED_LOAN_PAYMENT", untrackedMaturity);
  const unpaired = [
    tx({ own: "chk", amount: 8_000, flowType: "INCOME" }),
    tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", transferMaturity: untrackedMaturity }),
  ];
  const sel = selectDebtPaymentCashLegs(unpaired, ctxU);
  const sU = computeDebtService(unpaired, ctxU, abs);
  const econU = economicTotals(unpaired as never);
  const liqU = classifyLiquidity(unpaired[1], ctxU);
  console.log(`    observed (c): counted=${sel.counted.length} payments=${sU.payments} netPaydown=${sU.netPaydown} untracked=${sU.untrackedLoanPayments} spend=${econU.spend} cashOut=${cashOut(unpaired, ctxU)}`);
  // FIXED by F10 — desired behaviour: still NOT a counted (tracked) debt payment
  // and NOT paydown — there is no tracked liability for it to pay down …
  check("H2c FIXED by F10 — not a tracked debt payment: payments = 0, netPaydown = 0", sel.counted.length === 0 && sU.payments === 0 && sU.netPaydown === 0, sU);
  // FIXED by F10 — … and not discretionary spending …
  check("H2c FIXED by F10 — not in spending (spend = 0)", econU.spend === 0, econU);
  // FIXED by F10 — desired behaviour: … but VISIBLE: counted once in Cash Out as
  // debt service to an untracked loan, labelled as an unsplit loan payment, and
  // subtracted once from the after-debt net (it was a vanishing payment before).
  check("H2c FIXED by F10 — in Cash Out once (2,500) as UNTRACKED_LOAN_PAYMENT, labelled 'loan payment (principal + interest + escrow, not split)'",
    cashOut(unpaired, ctxU) === 2_500 && liqU.effect === "CASH_OUT" && liqU.reason === "UNTRACKED_LOAN_PAYMENT"
      && LIQUIDITY_REASON_LABEL.UNTRACKED_LOAN_PAYMENT.startsWith("Loan payment not matched to a connected loan")
      && unsplitLoanPaymentLabel("LOAN_PAYMENTS_MORTGAGE_PAYMENT") === UNSPLIT_MORTGAGE_PAYMENT_LABEL
      && UNSPLIT_MORTGAGE_PAYMENT_LABEL === "loan payment (principal + interest + escrow, not split)", liqU);
  check("H2c FIXED by F10 — untrackedLoanPayments = 2,500; after-debt net = 8,000 − 2,500 = 5,500",
    sU.untrackedLoanPayments === 2_500 && netAfterDebtPaydown(econU.net, sU) === 5_500, { sU, net: econU.net });

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
  // FIXED by F3 — desired behaviour: the Σ minimums still covers only the card
  // (150 — the mortgage's unknown minimum is never invented), but it is a TYPED
  // PARTIAL that says how many debts and what share of the balance lack it.
  check("H3 Σ minimumPayment = 150 (known only) — FIXED by F3: minimumCoverage PARTIAL, 'minimum payment known for 1 of 2 debts (2% of what you owe)'",
    agg.minimumPayment === 150 && agg.missingMinimumCount === 1
      && agg.minimumCoverage.status === "PARTIAL" && agg.minimumCoverage.unknownCount === 1 && agg.minimumCoverage.owingCount === 2
      && agg.minimumCoverage.unknownOwed === 300_000 && near(agg.minimumCoverage.unknownOwedShare, 300_000 / 305_000, 1e-9)
      && agg.minimumCoverage.note === "minimum payment known for 1 of 2 debts (2% of what you owe)", agg.minimumCoverage);
  // FIXED by F3 — desired behaviour: the 25% is over the card only and is never
  // averaged over the unknown mortgage; rateCoverage PARTIAL travels with it.
  check("H3 weightedApr = 25 over known rates only — FIXED by F3: rateCoverage PARTIAL, 'rate known for 1 of 2 debts (2% of what you owe)', not sufficient (< 50%)",
    agg.weightedApr === 25 && agg.unratedCount === 1
      && agg.rateCoverage.status === "PARTIAL" && agg.rateCoverage.note === "rate known for 1 of 2 debts (2% of what you owe)"
      && agg.rateCoverage.sufficient === false, agg.rateCoverage);

  const ic = computeInterestCost([{ id: "mtg", balance: 300_000, aprPct: null }, { id: "card", balance: 5_000, aprPct: 25 }]);
  check("H3 monthly interest = 104.17 (card only); mortgage unknown, sorted last", near(ic.totalMonthly, 104.1667, 0.01) && ic.unknownCount === 1 && ic.rows[1]?.id === "mtg", ic);

  const plan = planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [
    { id: "mtg", balance: 300_000, aprPct: null }, { id: "card", balance: 5_000, aprPct: 25 },
  ] });
  const mtg = plan.status === "paid_off" ? plan.liabilities.find((l) => l.id === "mtg") : undefined;
  const basis = "basis" in plan ? plan.basis : null;
  console.log(`    observed: status=${plan.status} basis=${basis?.interest} mtgBasis=${mtg?.interestBasis} mtgRate=${mtg?.rateStatus}`);
  check("H3 payoff basis = PARTIAL_INTEREST", basis?.interest === "PARTIAL_INTEREST", basis);
  // FIXED by F3 — desired behaviour: the mortgage is never SILENTLY at 0%. Its
  // projection is labelled RATE_UNKNOWN, the plan's interest total is scoped to
  // known-rate debts, and the surfaced note gives the count AND the owed share.
  // (The allocation itself is H4's subject — FIXED by F4.)
  check("H3 mortgage projection — FIXED by F3: rateStatus RATE_UNKNOWN, interest total KNOWN_RATE_ONLY, '1 of 2 debts' counts",
    mtg?.rateStatus === "RATE_UNKNOWN" && mtg?.aprPct === null
      && plan.status === "paid_off" && plan.interestTotalScope === "KNOWN_RATE_ONLY"
      && plan.totalInterest === plan.liabilities.find((l) => l.id === "card")?.interestPaid
      && basis?.unknownAprCount === 1 && basis?.owingCount === 2, { mtg, scope: plan.status === "paid_off" ? plan.interestTotalScope : null });
  check("H3 payoff note — FIXED by F3: 'Rate known for 1 of 2 debts (2% of what you owe) — …left out of the interest total.'",
    payoffUnknownRateNote(plan) === "Rate known for 1 of 2 debts (2% of what you owe) — no rate is assumed for the others, and they are left out of the interest total.", payoffUnknownRateNote(plan));

  // FIXED by F3 — desired behaviour: the label follows the liability KIND
  // (providerSubtype), in the UI and in the AI tool contract alike.
  check("H3 rate label — FIXED by F3: Plaid mortgage (debtSubtype null) ⇒ 'Mortgage rate', card ⇒ 'APR'",
    rateLabel(MORTGAGE) === "Mortgage rate" && rateLabel(CARD) === "APR");
  const src = readFileSync(join(process.cwd(), "lib/ai/assemblers/accounts.ts"), "utf8");
  check("H3 AI assembler — FIXED by F3: knowledge-gap label and per-row rateLabel come from rateLabel(fa); resolveRateLabel(debtSubtype) is gone",
    src.includes("label:       rateLabel(fa),") && src.includes("base.rateLabel            = rateLabel(fa);") && !src.includes("resolveRateLabel("));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H4. Payoff allocation: $300k mortgage + $5k card, $3k/month — ${LABEL}`);
{
  // FIXED by F4 (owner decision 2026-11-08) — desired behaviour: no pro-rata.
  // Every debt gets its required payment, the surplus goes to ONE revolving
  // target at a time (avalanche by default), the mortgage (an installment loan,
  // lib/debt/liability-kind.ts) gets only its scheduled payment and is never
  // projected from a gross payment that may carry escrow or at an assumed rate.
  const run = (mtgApr: number | null, mtgRequired: number | null) => planPayoff({ payment: 3_000, startISO: "2026-01-01", liabilities: [
    { id: "mtg", balance: 300_000, aprPct: mtgApr, requiredPayment: mtgRequired, kind: MORTGAGE },
    { id: "card", balance: 5_000, aprPct: 25, requiredPayment: 100, kind: CARD },
  ] });
  for (const apr of [6.5, null] as const) {
    for (const req of [null, 2_000] as const) {
      const p = run(apr, req);
      const cardFirst = p.status === "paid_off" ? p.payments[0]?.allocations.find((a) => a.id === "card") : undefined;
      const card = p.status === "paid_off" ? p.liabilities.find((l) => l.id === "card") : undefined;
      const mtg  = p.status === "paid_off" ? p.liabilities.find((l) => l.id === "mtg") : undefined;
      const tag = `[mtg rate ${apr}, payment ${req}]`;
      console.log(`    observed ${tag}: status=${p.status} card payoff=${card?.payoffISO} (${card?.paymentCount} pmts) cardFirstAlloc=${cardFirst?.paid} mortgage payoff=${mtg?.payoffISO} reasons=${mtg?.unknownReasons}`);
      check(`H4 ${tag} FIXED by F4: REQUIRED_THEN_TARGETED, avalanche, card is the only surplus target`,
        p.status === "paid_off" && p.allocation === "REQUIRED_THEN_TARGETED" && p.strategy === "avalanche" && p.targetOrder.join() === "card", p.status);
      check(`H4 ${tag} FIXED by F4: card's first allocation is the whole budget less the mortgage's reserved payment`,
        !!cardFirst && cardFirst.paid === 3_000 - (req ?? 0), cardFirst);
      check(`H4 ${tag} FIXED by F4: card paid off within 6 months (was 106–158 payments)`, !!card && card.paymentCount <= 6, card?.paymentCount);
      check(`H4 ${tag} FIXED by F4: mortgage payoff UNKNOWN — no 0% rate, no gross-as-P&I; never extra`,
        !!mtg && mtg.payoffISO === null && mtg.projection === "UNKNOWN" && !mtg.surplusTarget
          && (apr === null) === mtg.unknownReasons.includes("RATE_UNKNOWN")
          && (req === null ? mtg.unknownReasons.includes("REQUIRED_PAYMENT_UNKNOWN") : mtg.unknownReasons.includes("MORTGAGE_PAYMENT_SPLIT_UNKNOWN"))
          && p.status === "paid_off" && p.debtFreeISO === null && p.coverage.status === "PARTIAL", mtg);
    }
  }
}

// FIXED by F4 — the AI's avalanche / snowball candidates follow the same rule:
// an installment loan (here a 31% "mortgage" and the smallest balance) is never one.
{
  const row = (id: string, name: string, bal: number, apr: number | null, kind: "installment" | "revolving") =>
    ({ id, name, type: "debt", balance: bal, reportingBalance: bal, currency: "USD", visibilityLevel: "FULL", apr, liabilityKind: kind });
  const strat = computeDebtStrategy(
    { accounts: [row("mtg", "Mortgage", 900, 31, "installment"), row("card", "Card", 5_000, 25, "revolving")] } as never,
    { totalLiabilities: 5_900, classification: "WARNING", confidence: "HIGH", monthlyInterestBurden: null, aprGapAccountNames: [], hasBalanceOnlyDebt: false } as never,
  );
  check("H4 AI strategy — FIXED by F4: avalanche AND snowball candidate are the card, never the installment loan; it is listed as scheduled-only",
    strat.avalancheCandidate?.accountName === "Card" && strat.snowballCandidate?.accountName === "Card"
      && strat.scheduledOnlyAccountNames.join() === "Mortgage" && strat.targetPolicy.includes("Installment loans"), strat);
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
console.log(`F7. Revolving lines WITHOUT a limit — history replay — ${LABEL}`);
{
  // Every genuine revolving kind per liabilityKind (credit card, HELOC, line of
  // credit, overdraft) — with no creditLimit on the row.
  const REVOLVING_NO_LIMIT = [
    ["Plaid 'credit card'",     { type: "debt", debtSubtype: null,            providerSubtype: "credit card",    creditLimit: null }],
    ["debtSubtype credit_card", { type: "debt", debtSubtype: "credit_card",   providerSubtype: null,             creditLimit: null }],
    ["debtSubtype heloc",       { type: "debt", debtSubtype: "heloc",         providerSubtype: null,             creditLimit: null }],
    ["debtSubtype line_of_credit", { type: "debt", debtSubtype: "line_of_credit", providerSubtype: null,         creditLimit: null }],
    ["Plaid 'line of credit'",  { type: "debt", debtSubtype: null,            providerSubtype: "line of credit", creditLimit: null }],
    ["Plaid 'overdraft'",       { type: "debt", debtSubtype: null,            providerSubtype: "overdraft",      creditLimit: null }],
  ] as const;
  for (const [label, a] of REVOLVING_NO_LIMIT) {
    check(`F7 ${label}, no limit: liabilityKind = revolving`, liabilityKind(a) === "revolving");
  }
  check("F7 Plaid credit card, no limit ⇒ walked (PB-8)", isReconstructableCard(REVOLVING_NO_LIMIT[0][1]) === true);
  check("F7 debtSubtype credit_card, no limit ⇒ walked", isReconstructableCard(REVOLVING_NO_LIMIT[1][1]) === true);
  // FIXED by F7 — desired behaviour: every revolving kind (liabilityKind) is
  // replayed from its posted ledger, limit or no limit. (Was: HELOC / line of
  // credit / overdraft without a limit, or with an explicit FM revolving
  // debtSubtype, held flat at today's balance.)
  for (const [label, a] of REVOLVING_NO_LIMIT.slice(2)) {
    check(`F7 ${label}, no limit ⇒ walked — FIXED by F7`, isReconstructableCard(a) === true);
  }
  check("F7 debtSubtype heloc WITH a limit ⇒ walked — FIXED by F7",
    isReconstructableCard({ type: "debt", debtSubtype: "heloc", providerSubtype: null, creditLimit: 50_000 }) === true);

  // Installment kinds with a limit stay out of the walk and utilization.
  for (const sub of ["mortgage", "auto", "student"]) {
    const a = { type: "debt", debtSubtype: null, providerSubtype: sub, creditLimit: 400_000 };
    check(`F7 Plaid '${sub}' + limit ⇒ installment, not walked, no utilization`,
      liabilityKind(a) === "installment" && isReconstructableCard(a) === false && isRevolvingLine(a) === false);
  }
  check("F7 debtSubtype personal_loan + limit ⇒ not walked, no utilization",
    isReconstructableCard({ type: "debt", debtSubtype: "personal_loan", providerSubtype: null, creditLimit: 9_000 }) === false
      && isRevolvingLine({ debtSubtype: "personal_loan", providerSubtype: null, creditLimit: 9_000 }) === false);
  check("F7 Plaid 'home equity' with NO limit ⇒ installment, not walked (S2 HELOC ruling)",
    isReconstructableCard({ type: "debt", debtSubtype: null, providerSubtype: "home equity", creditLimit: null }) === false);
  check("F7 legacy untyped row with a limit ⇒ walked; without ⇒ held flat (unknown kind)",
    isReconstructableCard({ type: "debt", debtSubtype: null, providerSubtype: null, creditLimit: 5_000 }) === true
      && isReconstructableCard({ type: "debt", debtSubtype: null, providerSubtype: null, creditLimit: null }) === false);

  // A HELOC (no limit) with a +1,000 payment (FM sign: into the liability) 10 days ago.
  const today = new Date("2026-06-30T00:00:00.000Z");
  const heloc = { id: "heloc", balance: 21_000, ...REVOLVING_NO_LIMIT[2][1] };
  const walked = [heloc].filter(isReconstructableCard).map((a) => ({ id: a.id, balance: a.balance }));
  const walk = reconstructDailyLiabilityBalances(walked, new Map([["heloc", new Map([[isoDate(addDaysUTC(today, -10)), 1_000]])]]), today, addDaysUTC(today, -30));
  const d20 = walk.get(isoDate(addDaysUTC(today, -20)))?.get("heloc");
  // FIXED by F7 — the payment is reversed: day −20 owed = 21,000 + 1,000.
  check("F7 HELOC (no limit) history replayed — day −20 owed 22,000 — FIXED by F7", walked.length === 1 && d20 === 22_000, d20);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`H6. Sign of the payment row on the mortgage account itself — ${LABEL}`);
{
  const ctx = tierResolver([{ id: "chk", type: "checking" }, { id: "mtg", type: "debt" }]);
  const debitRow  = plaidFlow("debt", -2_500, undefined, "mortgage"); // servicer posts payment received as a DEBIT
  const creditRow = plaidFlow("debt", 2_500, undefined, "mortgage");  // conventional: payment reduces owed
  // FIXED by F5 — desired behaviour: on an INSTALLMENT loan a payment-shaped
  // debit is the servicer's sign-inverted RECEIVING leg, not a purchase. (Was:
  // SPENDING via the CCPAY-2B liability-outflow veto.)
  check("H6 mortgage-account −2,500 LOAN_PAYMENTS ⇒ DEBT_PAYMENT / INFLOW (receiving leg) — FIXED by F5",
    debitRow.flowType === "DEBT_PAYMENT" && debitRow.flowDirection === "INFLOW" && debitRow.reason === "ACCOUNT_TYPE_CONTEXT", debitRow);
  check("H6 contrast: mortgage-account +2,500 ⇒ DEBT_PAYMENT / INFLOW", creditRow.flowType === "DEBT_PAYMENT", creditRow);

  const inverted = [
    tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", cp: "mtg" }),
    tx({ own: "mtg", amount: -2_500, flowType: debitRow.flowType }),
  ];
  const s = computeDebtService(inverted, ctx, abs);
  const econ = economicTotals(inverted as never);
  // FIXED by F5 — desired behaviour: the payment is counted exactly once on each
  // axis. (Was: spending 2,500, newChargesOnLiabilities 2,500, netPaydown 0.)
  check("H6 inverted pair: economic spending = 0 (no part of the payment is a charge) — FIXED by F5", econ.spend === 0, econ);
  check("H6 inverted pair: payments 2,500, newChargesOnLiabilities 0, netPaydown 2,500 — FIXED by F5",
    s.payments === 2_500 && s.newChargesOnLiabilities === 0 && s.netPaydown === 2_500, s);
  check("H6 inverted pair: Cash Out = 2,500 — the checking leg only, once — FIXED by F5", cashOut(inverted, ctx) === 2_500, cashOut(inverted, ctx));
  const ok = [
    tx({ own: "chk", amount: -2_500, flowType: "DEBT_PAYMENT", cp: "mtg" }),
    tx({ own: "mtg", amount: 2_500, flowType: creditRow.flowType, cp: "chk" }),
  ];
  const econOk = economicTotals(ok as never);
  check("H6 contrast: conventional pair ⇒ spending 0, netPaydown 2,500",
    econOk.spend === 0 && computeDebtService(ok, ctx, abs).netPaydown === 2_500, econOk);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F5. Installment-loan servicer leg (S2 ruling) — desired behaviour");
{
  const ctx = tierResolver([{ id: "chk", type: "checking" }, { id: "mtg", type: "debt" }, { id: "card", type: "debt" }]);
  const sum = (rows: LiquidityTx[]) => ({ econ: economicTotals(rows as never), s: computeDebtService(rows, ctx, abs), out: cashOut(rows, ctx) });

  // (1) Inverted debit on the mortgage PAIRED with the checking outflow ⇒ once.
  const inv = plaidFlow("debt", -2_500, undefined, "mortgage");
  const chkLeg = plaidFlow("checking", -2_500);
  const paired = [
    tx({ own: "chk", amount: 8_000, flowType: "INCOME" }),
    tx({ own: "chk", amount: -2_500, flowType: chkLeg.flowType, cp: "mtg" }),
    tx({ own: "mtg", amount: -2_500, flowType: inv.flowType, cp: "chk" }),
  ];
  const p = sum(paired);
  check("F5.1 paired inverted posting: Cash Out 2,500 · payments 2,500 · netPaydown 2,500 · spending 0 · net 8,000",
    p.out === 2_500 && p.s.payments === 2_500 && p.s.netPaydown === 2_500 && p.s.newChargesOnLiabilities === 0
      && p.econ.spend === 0 && p.econ.net === 8_000, p);
  check("F5.1 the loan-side row is the excluded liability leg, not a counted cash leg",
    selectDebtPaymentCashLegs(paired, ctx).counted.length === 1 && selectDebtPaymentCashLegs(paired, ctx).excludedLiabilityLegs.length === 1);
  // The same answer whether the kind comes from Plaid's subtype or FM's debtSubtype.
  const viaDebtSubtype = classifyFlow({ category: "Payment", amount: -2_500, accountType: "debt", debtSubtype: "mortgage", pfcPrimary: null, pfcDetailed: null });
  check("F5.1 Payment-category inverted posting on debtSubtype 'mortgage' ⇒ DEBT_PAYMENT / INFLOW",
    viaDebtSubtype.flowType === "DEBT_PAYMENT" && viaDebtSubtype.flowDirection === "INFLOW", viaDebtSubtype);
  for (const sub of ["auto", "student", "loan", "home equity"]) {
    const r = plaidFlow("debt", -400, "LOAN_PAYMENTS_OTHER_PAYMENT", sub);
    check(`F5.1 installment subtype '${sub}' (no limit) inverted LOAN_PAYMENTS ⇒ DEBT_PAYMENT`, r.flowType === "DEBT_PAYMENT", r);
  }

  // (2) Normal-sign posting unchanged.
  const normal = plaidFlow("debt", 2_500, undefined, "mortgage");
  check("F5.2 normal-sign +2,500 on the mortgage ⇒ DEBT_PAYMENT / INFLOW at 0.8 PLAID_PFC_PRIMARY (unchanged)",
    normal.flowType === "DEBT_PAYMENT" && normal.flowDirection === "INFLOW" && normal.confidence === 0.8 && normal.reason === "PLAID_PFC_PRIMARY", normal);
  check("F5.2 the predicate is outflow-only", !isInstallmentServicerPaymentLeg({ category: "Payment", amount: 2_500, accountType: "debt", providerSubtype: "mortgage" }));

  // (3) A genuine fee / interest / other charge on the loan stays a cost.
  const fee = plaidFlow("debt", -35, "BANK_FEES_LATE_PAYMENT", "mortgage", "BANK_FEES");
  check("F5.3 late fee −35 on the mortgage (BANK_FEES) ⇒ FEE / OUTFLOW (unchanged)", fee.flowType === "FEE" && fee.flowDirection === "OUTFLOW", fee);
  const feeCat = classifyFlow({ category: "Fee", amount: -35, accountType: "debt", debtSubtype: "mortgage" });
  check("F5.3 `Fee` category −35 on the mortgage ⇒ FEE (unchanged)", feeCat.flowType === "FEE", feeCat);
  const interest = plaidFlow("debt", -1_200, "LOAN_PAYMENTS_INTEREST", "mortgage");
  check("F5.3 interest-detailed row on the mortgage ⇒ INTEREST (unchanged)", interest.flowType === "INTEREST", interest);
  const otherCharge = classifyFlow({ category: "Other", amount: -90, accountType: "debt", providerSubtype: "mortgage" });
  check("F5.3 a payment-less `Other` −90 on the mortgage ⇒ SPENDING (no payment semantics ⇒ unchanged)", otherCharge.flowType === "SPENDING", otherCharge);
  const withFee = sum([...paired, tx({ own: "mtg", amount: -35, flowType: fee.flowType })]);
  check("F5.3 pair + 35 fee: spending 35 (the fee only), newCharges 35, netPaydown 2,465, Cash Out 2,500",
    withFee.econ.spend === 35 && withFee.s.newChargesOnLiabilities === 35 && withFee.s.netPaydown === 2_465 && withFee.out === 2_500, withFee);

  // (4) Revolving lines unaffected — the CCPAY-2B veto holds byte-for-byte.
  const cardInv = plaidFlow("debt", -506.98, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "credit card");
  check("F5.4 credit-card −506.98 LOAN_PAYMENTS ⇒ SPENDING / OUTFLOW 0.7 ACCOUNT_TYPE_CONTEXT (CCPAY-2B unchanged)",
    cardInv.flowType === "SPENDING" && cardInv.flowDirection === "OUTFLOW" && cardInv.confidence === 0.7 && cardInv.reason === "ACCOUNT_TYPE_CONTEXT", cardInv);
  for (const [label, input] of [
    ["debtSubtype credit_card", { debtSubtype: "credit_card" }],
    ["Plaid 'line of credit'", { providerSubtype: "line of credit" }],
    ["Plaid 'home equity' WITH a limit (HELOC)", { providerSubtype: "home equity", creditLimit: 50_000 }],
    ["unknown kind (no subtype at all)", {}],
  ] as const) {
    const r = classifyFlow({ category: "Payment", amount: -400, accountType: "debt", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT", ...input });
    check(`F5.4 ${label}: inverted LOAN_PAYMENTS ⇒ SPENDING (veto unchanged)`, r.flowType === "SPENDING", r);
  }
  const cardRows = [
    tx({ own: "chk", amount: -506.98, flowType: "DEBT_PAYMENT", cp: "card" }),
    tx({ own: "card", amount: -506.98, flowType: cardInv.flowType }),
  ];
  check("F5.4 card: the vetoed row stays a charge (spending 506.98)", sum(cardRows).econ.spend === 506.98, sum(cardRows).econ);

  // (5) Unpaired inverted debit on the loan (checking not connected) ⇒ receiving leg.
  const ctxLoanOnly = tierResolver([{ id: "mtg", type: "debt" }]);
  const unpaired = [tx({ own: "mtg", amount: -2_500, flowType: inv.flowType })];
  const su = computeDebtService(unpaired, ctxLoanOnly, abs);
  const eu = economicTotals(unpaired as never);
  check("F5.5 unpaired inverted debit ⇒ DEBT_PAYMENT receiving leg: spending 0, newCharges 0, Cash Out 0, not a counted cash leg",
    inv.flowType === "DEBT_PAYMENT" && eu.spend === 0 && su.newChargesOnLiabilities === 0 && su.payments === 0
      && cashOut(unpaired, ctxLoanOnly) === 0, { su, eu });
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

  // F7 (d) — the held-at-today value is LABELLED, never presented as observed
  // or reconstructed: per-account tier `estimated` (method held-flat), coverage
  // class HELD_FLAT, the aggregate point basis `carried` + "Estimated" line, and
  // no amortization is invented (value stays today's balance).
  {
    const d364 = addDaysUTC(today, -364);
    const floorISO = isoDate(addDaysUTC(today, -365));
    const mtgIn = { id: "mtg", type: "debt", balance: 300_000, debtSubtype: null, creditLimit: null, providerSubtype: "mortgage", floorISO };
    const r = resolveAccountsAsOf([mtgIn], new Map(), new Map(), today, d364).get("mtg")!;
    check("H7a per-account: method held-flat, tier estimated, balance 300,000 (no amortization)",
      r.method === "held-flat" && r.tier === "estimated" && r.balance === 300_000, r);
    const cls = coverageClassFor("debt", isReconstructableCard(mtgIn));
    const cov = resolveAccountCoverage({
      accountId: "mtg", coverageClass: cls, connectionFloorISO: isoDate(connected), earliestPostedTxISO: floorISO,
      earliestPositionObservationISO: null, earliestReconstructionAnchorISO: null, earliestInvestmentEventISO: null,
    });
    const bc = deriveBalanceCoverage([{ side: "liability", coverageClass: cls, balance: 300_000,
      floorISO: writerAlignedFloorISO(cov, cls, isoDate(connected), isoDate(connected), false) }]);
    check("H7a coverage class HELD_FLAT; listed in estimatedLiabilityFloors", cls === "HELD_FLAT" && bc?.estimatedLiabilityFloors.length === 1, { cls, bc });
    const label = estimatedCoverageLabel(bc, ["liability"], isoDate(d364));
    const [pt] = markPartialBalanceCoverage<{ date: string; estimated?: boolean; basis?: string; coverageLabel?: string | null; value: number }>(
      [{ date: isoDate(d364), estimated: true, value: 300_000 }], bc, ["liability"]);
    check("H7a aggregate point flagged estimated: basis 'carried' + 'Estimated' coverage line, value unchanged",
      label !== null && label.startsWith("Estimated:") && pt.basis === "carried" && pt.coverageLabel === label && pt.value === 300_000, { label, pt });
    check("H7a AI history tool: the day is flagged `estimated: true`", isEstimatedOn(bc, isoDate(d364), true) === true);
  }

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
  // FIXED by F8 — desired behaviour. The exclusion stays (no balance is
  // invented: totalLiabilities 0, netWorth 510,000 are the figures over the
  // OBSERVED accounts), but every total that drops the mortgage is PARTIAL AT
  // THE TOTAL with its direction — never a clean, higher net worth.
  const f8 = excludedAccountCounts([CHECKING, property, unobserved]);
  const nwCov = unobservedTotalCoverage("NET_WORTH", f8);
  const debtCov = unobservedTotalCoverage("TOTAL_DEBT", f8);
  const liqCov = unobservedTotalCoverage("LIQUID_NET_WORTH", f8);
  check("H8 unobserved mortgage stays excluded (no invented balance) but net worth / debt are PARTIAL with direction — FIXED by F8; liquid NW COMPLETE (F1 excludes installment loans)",
    cu.totalLiabilities === 0 && cu.netWorth === 510_000
      && nwCov.status === "PARTIAL" && nwCov.directions.join() === "TRUE_TOTAL_LOWER"
      && nwCov.notes[0] === "Excludes a debt of unknown balance — the true total is lower"
      && debtCov.status === "PARTIAL" && debtCov.directions.join() === "TRUE_TOTAL_HIGHER"
      // F1 — liquid NW never subtracts a mortgage, so its unknown balance leaves liquid NW COMPLETE.
      && liqCov.status === "COMPLETE",
    { l: cu.totalLiabilities, nw: cu.netWorth, nwCov, debtCov, liqCov });
  check("H8 ... disclosed: unvaluedCount = 1, label 'Balance unavailable'", cu.unvaluedCount === 1 && unvaluedBalanceLabel(unobserved) === "Balance unavailable", cu.unvaluedCount);
}

if (failures > 0) { console.error(`\n${failures} characterization check(s) failed`); process.exit(1); }
console.log("\nAll mortgage characterization checks pass (current behaviour pinned).");

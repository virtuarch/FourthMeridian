/**
 * lib/transactions/untracked-loan-payment.test.ts
 *
 * Mortgage F10 (S2 ruling) — a payment to an installment loan that is NOT
 * connected stays VISIBLE as unsplit debt service: counted once in Cash Out,
 * labelled as an unsplit loan payment — "(principal + interest + escrow, not
 * split)" for a mortgage, "(principal + interest, not split)" for auto / student /
 * personal loans (owner F6 / S2 D3) — never a tracked debt payment, never paydown, never spending. Connected loans and
 * card payments keep the existing pairing paths.
 *
 * End to end over the pure authorities: transfer matcher → maturity →
 * liquidity → DayFacts / breakdown → debt service → economic fold → resolved
 * nature. Fabricated fixtures only. Pure: no DB, no network, no clock.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/transactions/untracked-loan-payment.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchTransferCandidate, type RelationshipTransaction } from "@/lib/transactions/RelationshipResolver";
import { tierResolver, classifyLiquidity, type LiquidityTx } from "@/lib/transactions/liquidity";
import { aggregateDayFacts } from "@/lib/transactions/cash-flow-projection";
import { groupLiquidityByReason, LIQUIDITY_REASON_LABEL, LIQUIDITY_REASON_SIDE } from "@/lib/transactions/liquidity-breakdown";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { computeDebtService, netAfterDebtPaydown } from "@/lib/transactions/debt-service";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { resolveTransactionNature, categoryForNature, NATURE_DESCRIPTION, natureDescription } from "@/lib/transactions/resolved-nature";
import { describeRowNature } from "@/lib/transactions/flow-presentation";
import {
  LIABILITY_PAYMENT_DETAILS, decideTransferDebtPaymentCorrection,
} from "@/lib/transactions/transfer-debt-payment-correction";
import {
  INSTALLMENT_LOAN_PAYMENT_DETAILS, isInstallmentLoanPaymentDetail,
  UNSPLIT_MORTGAGE_PAYMENT_LABEL, UNSPLIT_INSTALLMENT_LOAN_PAYMENT_LABEL, UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL,
} from "@/lib/debt/liability-kind";
import { impliedFlowType, MATURITY_LABEL, TERMINAL_MATURITIES, isUnresolvedMaturity } from "@/lib/transactions/transfer-maturation";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const ACCOUNTS = new Map<string, string>([
  ["chk", "checking"], ["sav", "savings"], ["mtg", "debt"], ["card", "debt"], ["stu", "debt"],
]);
const MATCH_CTX = { accountTypeById: ACCOUNTS };

/** A matcher row (the transfer authority's input shape). */
function rel(o: Partial<RelationshipTransaction> & { id: string; financialAccountId: string; amount: number }): RelationshipTransaction {
  const date = new Date("2026-05-10");
  return {
    plaidTransactionId: null, pendingTransactionRef: null, date, merchant: "Servicer", pending: false,
    deletedAt: null, ownerUserId: "u1", settlementState: "POSTED", pfcDetailed: null, pfcPrimary: null,
    persistedCounterpartyAccountId: null, category: "Payment", counterpartyClass: null, institutionId: null,
    descriptor: null, description: null, transactionEventId: null, flowType: "DEBT_PAYMENT", currency: "USD",
    economicDate: date,
    ...o,
  } as RelationshipTransaction;
}

/** The read-path DTO a cash-flow surface folds, carrying the authority's verdict. */
function dto(id: string, own: string, amount: number, flowType: string, maturity: string | null, cp: string | null = null, loanPaymentDetail?: string): LiquidityTx {
  return {
    id, accountId: own, financialAccountId: own, counterpartyAccountId: cp, amount, flowType,
    flowDirection: amount < 0 ? "INTERNAL" : "INFLOW",
    incomeClass: flowType === "INCOME" ? "EARNED_INCOME" : null, incomeSubtype: null,
    transferMaturity: maturity, ...(loanPaymentDetail ? { loanPaymentDetail } : {}), currency: "USD", date: "2026-05-10", merchant: "m",
    category: flowType === "INCOME" ? "Income" : flowType === "DEBT_PAYMENT" ? "Payment" : "Other", pending: false,
  } as unknown as LiquidityTx;
}
const abs = (r: LiquidityTx) => Math.abs(r.amount);
const ctxChkOnly = tierResolver([{ id: "chk", type: "checking" }]);
const ctxAll = tierResolver([...ACCOUNTS].map(([id, type]) => ({ id, type })));

/** The whole untracked-loan story for one detailed category. */
function untrackedCase(label: string, pfcDetailed: string): void {
  const leg = rel({ id: "pay", financialAccountId: "chk", amount: -2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed });
  const m = matchTransferCandidate(leg, [], MATCH_CTX);
  check(`${label}: maturity UNTRACKED_LOAN_PAYMENT, no counterparty, terminal (not unresolved)`,
    m.maturity === "UNTRACKED_LOAN_PAYMENT" && m.counterpartyAccountId === null
      && TERMINAL_MATURITIES.has("UNTRACKED_LOAN_PAYMENT") && !isUnresolvedMaturity(m.maturity) && m.unresolvedReason === null, m);

  const rows = [dto("inc", "chk", 8_000, "INCOME", null), dto("pay", "chk", -2_500, "DEBT_PAYMENT", m.maturity, null, pfcDetailed)];
  const facts = aggregateDayFacts(rows, ctxChkOnly);
  // Owner F6 / S2 D3 — escrow is named ONLY for a mortgage payment.
  const isMortgage = pfcDetailed === "LOAN_PAYMENTS_MORTGAGE_PAYMENT";
  const unsplit = isMortgage ? UNSPLIT_MORTGAGE_PAYMENT_LABEL : UNSPLIT_INSTALLMENT_LOAN_PAYMENT_LABEL;
  const breakdown = groupLiquidityByReason(facts);
  const line = breakdown.cashOut.find((l) => l.reason === "UNTRACKED_LOAN_PAYMENT");
  check(`${label}: Cash Out = 2,500 exactly once, under the unsplit-loan label`,
    facts.cashOut === 2_500 && breakdown.cashOut.length === 1 && line?.amount === 2_500
      && line.label === `Loan payment not matched to a connected loan — ${unsplit}` && facts.unresolved === 0, { facts, breakdown });
  check(`${label}: Cash Out label names escrow ${isMortgage ? "(mortgage)" : "NEVER (not a mortgage)"}`,
    /escrow/.test(line?.label ?? "") === isMortgage, line);

  const sel = selectDebtPaymentCashLegs(rows, ctxChkOnly);
  const svc = computeDebtService(rows, ctxChkOnly, abs);
  check(`${label}: not a tracked debt payment and not paydown (payments 0, netPaydown 0)`,
    sel.counted.length === 0 && svc.payments === 0 && svc.netPaydown === 0, svc);
  check(`${label}: reported as untracked loan debt service (2,500)`, svc.untrackedLoanPayments === 2_500, svc);

  const econ = economicTotals(rows as never);
  check(`${label}: not in discretionary/economic spending (spend 0)`, econ.spend === 0, econ);
  check(`${label}: after-debt net = 8,000 − 2,500 = 5,500 (never silently surplus)`,
    netAfterDebtPaydown(econ.net, svc) === 5_500, { net: econ.net, svc });

  const nature = resolveTransactionNature({
    flowType: "DEBT_PAYMENT", amount: -2_500, flowAuthority: "CLASSIFIER", transferMaturity: m.maturity,
    ownAccountType: "checking", hasOwnedCounterparty: false,
  });
  check(`${label}: resolved nature UNTRACKED_LOAN_PAYMENT, narrated as a debt payment, reducesDebt false`,
    nature.nature === "UNTRACKED_LOAN_PAYMENT" && nature.flow === "DEBT_PAYMENT" && nature.reducesDebt === false
      && natureDescription(nature.nature, pfcDetailed).includes(unsplit)
      && /escrow/.test(natureDescription(nature.nature, pfcDetailed)) === isMortgage, nature);
  check(`${label}: category stays 'Payment' (never relabelled Transfer)`,
    categoryForNature("Payment", { flowType: "DEBT_PAYMENT", amount: -2_500, transferMaturity: m.maturity, hasOwnedCounterparty: false }) === "Payment");
  const row = describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: m.maturity, amount: -2_500 });
  check(`${label}: row reads as a debt payment, not 'Transfer out'`, row.nature !== "TRANSFER_OUT", row);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-1. Unconnected MORTGAGE payment from checking");
untrackedCase("mortgage", "LOAN_PAYMENTS_MORTGAGE_PAYMENT");

console.log("F10-2. Unconnected STUDENT LOAN payment behaves the same");
untrackedCase("student loan", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT");

console.log("F10-2b. Unconnected AUTO and PERSONAL loan payments behave the same");
untrackedCase("auto loan", "LOAN_PAYMENTS_CAR_PAYMENT");
untrackedCase("personal loan", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT");

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-3. CONNECTED mortgage — the pairing path keeps precedence (no double count)");
{
  const cash = rel({ id: "pay", financialAccountId: "chk", amount: -2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" });
  const recv = rel({ id: "recv", financialAccountId: "mtg", amount: 2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" });
  const m = matchTransferCandidate(cash, [recv], MATCH_CTX);
  check("connected: matures DEBT_PAYMENT to the mortgage account", m.maturity === "DEBT_PAYMENT" && m.counterpartyAccountId === "mtg", m);
  const rows = [
    dto("inc", "chk", 8_000, "INCOME", null),
    dto("pay", "chk", -2_500, "DEBT_PAYMENT", m.maturity, m.counterpartyAccountId),
    dto("recv", "mtg", 2_500, "DEBT_PAYMENT", null, "chk"),
  ];
  const facts = aggregateDayFacts(rows, ctxAll);
  const svc = computeDebtService(rows, ctxAll, abs);
  check("connected: Cash Out 2,500 once, as DEBT_PAYMENT (no untracked line)",
    facts.cashOut === 2_500 && facts.byReason.DEBT_PAYMENT === 2_500 && !facts.byReason.UNTRACKED_LOAN_PAYMENT, facts);
  check("connected: payments = netPaydown = 2,500, untrackedLoanPayments = 0 (unchanged H2a)",
    svc.payments === 2_500 && svc.netPaydown === 2_500 && svc.untrackedLoanPayments === 0, svc);
  check("connected: after-debt net = 5,500 — the payment is subtracted once, not twice",
    netAfterDebtPaydown(economicTotals(rows as never).net, svc) === 5_500);
  // A stale DTO that still says UNTRACKED but now carries a counterparty is NOT untracked.
  const stale = dto("pay", "chk", -2_500, "DEBT_PAYMENT", "UNTRACKED_LOAN_PAYMENT", "sav");
  check("guard: an UNTRACKED maturity beside an owned counterparty is never the untracked reason",
    classifyLiquidity(stale, ctxAll).reason !== "UNTRACKED_LOAN_PAYMENT", classifyLiquidity(stale, ctxAll));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-4. Card payments are unchanged");
{
  const cash = rel({ id: "cc", financialAccountId: "chk", amount: -500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
  const recv = rel({ id: "ccr", financialAccountId: "card", amount: 500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
  const m = matchTransferCandidate(cash, [recv], MATCH_CTX);
  const rows = [dto("cc", "chk", -500, "DEBT_PAYMENT", m.maturity, m.counterpartyAccountId), dto("ccr", "card", 500, "DEBT_PAYMENT", null, "chk")];
  const svc = computeDebtService(rows, ctxAll, abs);
  check("connected card: DEBT_PAYMENT to the card; payments 500, untracked 0",
    m.maturity === "DEBT_PAYMENT" && m.counterpartyAccountId === "card" && svc.payments === 500 && svc.untrackedLoanPayments === 0, { m, svc });

  // Out of F10's scope (a card is not a loan): an UNCONNECTED card payment keeps
  // today's answer — unresolved, never relabelled as an unsplit loan payment.
  const lone = matchTransferCandidate(cash, [], MATCH_CTX);
  check("unconnected card payment: still UNRESOLVED_TRANSFER (not an untracked loan)", lone.maturity === "UNRESOLVED_TRANSFER", lone);
  const other = matchTransferCandidate(rel({ id: "o", financialAccountId: "chk", amount: -300, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" }), [], MATCH_CTX);
  check("LOAN_PAYMENTS_OTHER_PAYMENT (names no loan): still UNRESOLVED_TRANSFER", other.maturity === "UNRESOLVED_TRANSFER", other);
  const csv = matchTransferCandidate(rel({ id: "csv", financialAccountId: "chk", amount: -300, pfcPrimary: null, pfcDetailed: null }), [], MATCH_CTX);
  check("Payment category with no provider loan detail: still UNRESOLVED_TRANSFER", csv.maturity === "UNRESOLVED_TRANSFER", csv);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-5. Boundaries");
{
  // Money INTO checking tagged as a mortgage payment is not a payment we made.
  const inflow = matchTransferCandidate(rel({ id: "in", financialAccountId: "chk", amount: 2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" }), [], MATCH_CTX);
  check("depository INFLOW with a mortgage detail is not an untracked loan payment", inflow.maturity !== "UNTRACKED_LOAN_PAYMENT", inflow);
  // A matching leg on ANOTHER owner's loan: a named limitation, never claimed untracked.
  const cash = rel({ id: "x", financialAccountId: "chk", amount: -2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" });
  const theirs = rel({ id: "y", financialAccountId: "mtg2", amount: 2_500, ownerUserId: "u2", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" });
  const xo = matchTransferCandidate(cash, [theirs], { accountTypeById: new Map([...ACCOUNTS, ["mtg2", "debt"]]) });
  check("cross-owner candidate: stays UNRESOLVED_TRANSFER / CROSS_OWNER_BOUNDARY",
    xo.maturity === "UNRESOLVED_TRANSFER" && xo.unresolvedReason === "CROSS_OWNER_BOUNDARY", xo);

  check("leaf implies DEBT_PAYMENT (a debt payment, just not a tracked one)", impliedFlowType("UNTRACKED_LOAN_PAYMENT") === "DEBT_PAYMENT");
  check("presentation label is 'Loan payment (not matched to a connected loan)'",
    MATURITY_LABEL.UNTRACKED_LOAN_PAYMENT === "Loan payment (not matched to a connected loan)");
  check("liquidity side of UNTRACKED_LOAN_PAYMENT is 'out'", LIQUIDITY_REASON_SIDE.UNTRACKED_LOAN_PAYMENT === "out");
  check("row-free liquidity label is the NEUTRAL unsplit variant (no escrow)",
    LIQUIDITY_REASON_LABEL.UNTRACKED_LOAN_PAYMENT === `Loan payment not matched to a connected loan — ${UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL}`
      && !/escrow/.test(LIQUIDITY_REASON_LABEL.UNTRACKED_LOAN_PAYMENT) && !/escrow/.test(NATURE_DESCRIPTION.UNTRACKED_LOAN_PAYMENT));
  check("isInstallmentLoanPaymentDetail is case-insensitive and refuses card/other",
    isInstallmentLoanPaymentDetail("loan_payments_mortgage_payment") && !isInstallmentLoanPaymentDetail("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT")
      && !isInstallmentLoanPaymentDetail("LOAN_PAYMENTS_OTHER_PAYMENT") && !isInstallmentLoanPaymentDetail(null));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-6. Agreement with the write-time transfer correction");
{
  check("INSTALLMENT_LOAN_PAYMENT_DETAILS ⊂ LIABILITY_PAYMENT_DETAILS (the correction KEEPs every F10 row)",
    [...INSTALLMENT_LOAN_PAYMENT_DETAILS].every((d) => LIABILITY_PAYMENT_DETAILS.has(d)));
  for (const d of INSTALLMENT_LOAN_PAYMENT_DETAILS) {
    const decision = decideTransferDebtPaymentCorrection({
      ownAccountType: "checking", flowType: "DEBT_PAYMENT", flowAuthority: "CLASSIFIER", rowCategorySource: null,
      category: "Payment", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: d, classificationReason: "PLAID_PFC_PRIMARY",
      classificationConfidence: 0.8, deleted: false, supersededByPosted: false, persistedCounterpartyAccountType: null,
      assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNTRACKED_LOAN_PAYMENT", unresolvedReason: null },
    });
    check(`correction keeps an unpaired ${d} leg as DEBT_PAYMENT (never rewritten to TRANSFER)`,
      decision.action === "KEEP" && "code" in decision && decision.code === "LIABILITY_EVIDENCE", decision);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F10-7. CONNECTED mortgage, servicer posts no pairable receiving leg (S2 deviation 3)");
{
  // The mortgage account IS owned and connected (mtg in the matcher context and
  // the liquidity tier map); only the receiving leg is missing. The leaf is still
  // UNTRACKED_LOAN_PAYMENT, so no copy for it may claim the loan is not connected.
  const leg = rel({ id: "pay", financialAccountId: "chk", amount: -2_500, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" });
  const m = matchTransferCandidate(leg, [], MATCH_CTX);
  check("connected mortgage, no receiving leg: leaf UNTRACKED_LOAN_PAYMENT, no counterparty",
    MATCH_CTX.accountTypeById.get("mtg") === "debt" && m.maturity === "UNTRACKED_LOAN_PAYMENT" && m.counterpartyAccountId === null, m);
  const rows = [dto("inc", "chk", 8_000, "INCOME", null), dto("pay", "chk", -2_500, "DEBT_PAYMENT", m.maturity, null, "LOAN_PAYMENTS_MORTGAGE_PAYMENT")];
  const facts = aggregateDayFacts(rows, ctxAll);
  const breakdown = groupLiquidityByReason(facts);
  check("connected mortgage, no receiving leg: counted once in Cash Out (2,500) as UNTRACKED_LOAN_PAYMENT",
    facts.cashOut === 2_500 && breakdown.cashOut.length === 1 && facts.byReason.UNTRACKED_LOAN_PAYMENT === 2_500, { facts, breakdown });
  const svc = computeDebtService(rows, ctxAll, abs);
  check("connected mortgage, no receiving leg: untracked = 2,500, payments = netPaydown = 0",
    svc.untrackedLoanPayments === 2_500 && svc.payments === 0 && svc.netPaydown === 0, svc);
  const nature = resolveTransactionNature({
    flowType: "DEBT_PAYMENT", amount: -2_500, flowAuthority: "CLASSIFIER", transferMaturity: m.maturity,
    ownAccountType: "checking", hasOwnedCounterparty: false,
  });
  check("connected mortgage, no receiving leg: nature UNTRACKED_LOAN_PAYMENT", nature.nature === "UNTRACKED_LOAN_PAYMENT", nature);
  const copy = [
    MATURITY_LABEL.UNTRACKED_LOAN_PAYMENT, LIQUIDITY_REASON_LABEL.UNTRACKED_LOAN_PAYMENT,
    NATURE_DESCRIPTION.UNTRACKED_LOAN_PAYMENT, breakdown.cashOut[0]?.label ?? "",
    natureDescription("UNTRACKED_LOAN_PAYMENT", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"),
  ];
  check("connected mortgage, no receiving leg: no label/description claims 'not connected' or 'untracked'",
    copy.every((c) => !/not connected|untracked/i.test(c)), copy);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F6. Unsplit label by loan type (owner F6 / S2 D3) — aggregate Cash Out line");
{
  const leg = (id: string, d: string | undefined) => dto(id, "chk", -1_000, "DEBT_PAYMENT", "UNTRACKED_LOAN_PAYMENT", null, d);
  const lineOf = (rows: LiquidityTx[]) =>
    groupLiquidityByReason(aggregateDayFacts(rows, ctxChkOnly)).cashOut.find((l) => l.reason === "UNTRACKED_LOAN_PAYMENT");
  const mm = lineOf([leg("a", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"), leg("b", "LOAN_PAYMENTS_MORTGAGE_PAYMENT")]);
  check("two mortgage payments: escrow variant, 2,000", mm?.amount === 2_000 && mm.label.endsWith(UNSPLIT_MORTGAGE_PAYMENT_LABEL), mm);
  const inst = lineOf([leg("a", "LOAN_PAYMENTS_CAR_PAYMENT"), leg("b", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT"), leg("c", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT")]);
  check("auto + student + personal: P+I variant, no escrow", inst?.amount === 3_000
    && inst.label.endsWith(UNSPLIT_INSTALLMENT_LOAN_PAYMENT_LABEL) && !/escrow/.test(inst.label), inst);
  const mixed = lineOf([leg("a", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"), leg("b", "LOAN_PAYMENTS_CAR_PAYMENT")]);
  check("mortgage + auto mixed: neutral variant (names no component), amount 2,000", mixed?.amount === 2_000
    && mixed.label.endsWith(UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL) && !/escrow/.test(mixed.label), mixed);
  const unknown = lineOf([leg("a", undefined)]);
  check("no loan detail on the DTO: neutral variant", unknown?.label.endsWith(UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL) === true, unknown);
  check("natureDescription: unknown detail ⇒ neutral; non-untracked natures unchanged",
    natureDescription("UNTRACKED_LOAN_PAYMENT", null).includes(UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL)
      && natureDescription("LIABILITY_PAYMENT", "LOAN_PAYMENTS_MORTGAGE_PAYMENT") === NATURE_DESCRIPTION.LIABILITY_PAYMENT);
  // The whole payment is never principal / paydown, whatever the type.
  const svc = computeDebtService([leg("a", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"), leg("b", "LOAN_PAYMENTS_CAR_PAYMENT")], ctxChkOnly, abs);
  check("whole unsplit payments never counted as payments / netPaydown (F6)",
    svc.payments === 0 && svc.netPaydown === 0 && svc.untrackedLoanPayments === 2_000, svc);
  const mixFacts = aggregateDayFacts([leg("a", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"), leg("b", "LOAN_PAYMENTS_CAR_PAYMENT")], ctxChkOnly);
  check("unsplit payments never reach byReason.DEBT_PAYMENT (the 'debt paid' insight input)",
    mixFacts.byReason.DEBT_PAYMENT === undefined && mixFacts.byReason.UNTRACKED_LOAN_PAYMENT === 2_000, mixFacts);

  // Wiring (source pins — these surfaces need a DB / tool context to run).
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  check("list DTO exposes loanPaymentDetail ONLY on the UNTRACKED_LOAN_PAYMENT leaf",
    /a\?\.maturity === "UNTRACKED_LOAN_PAYMENT" \? \{ loanPaymentDetail: r\.pfcDetailed \?\? null \} : \{\}/.test(src("lib/data/transactions.ts")));
  check("AI natureNote is the row's type-aware description",
    src("lib/ai/conversation/tools/transactions.ts").includes("natureNote: natureDescription(resolved.nature, r.loanPaymentDetail)"));
  check("AI assembler attaches the F6 'not individually verified' note whenever unsplit payments are present",
    src("lib/ai/assemblers/transactions.ts").includes("debtService.untrackedLoanPayments > 0 ? { unsplitLoanPaymentNote: UNSPLIT_LOAN_PAYMENT_AI_NOTE } : {}"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Mortgage F10 untracked-loan-payment checks passed.");

/**
 * lib/transactions/classification-regression-matrix.test.ts   (v2.7 Workstream B)
 *
 * TRANSFER / PAYMENT CLASSIFICATION — REGRESSION MATRIX.
 *
 *     Moving money must not be confused with earning, spending, paying down
 *     debt, or creating new assets.            (owner priority, 2026-10-27)
 *
 * Every row here goes through the REAL pipeline, in the order production runs it:
 *
 *   ingest   mapPlaidCategory → resolveLiabilityPaymentCategory (card-payment
 *            rescue) → classifyFlow                                (sync write)
 *   read     matchTransferCandidate over the prefilter corpus      (read-time
 *            transfer authority, as resolveTransferAssessments runs it)
 *   write    decideTransferDebtPaymentCorrection                   (PR #58 rule)
 *   DTO      serializeTransactionRow + deriveTransactionContext    (list read)
 *   consume  resolveTransactionNature · describeRowNature · classifyLiquidity ·
 *            aggregateDayFacts (Cash Flow) · categorySpendLedger (donut) ·
 *            totalDebtPaid / computeDebtService (Debt payments, payoff)
 *
 * No DB, no Plaid, no model. Account balances (net worth, debt balance) are a
 * provider STOCK fact read from FinancialAccount and are never derived from a
 * row's classification, so no case here can move them; the matrix asserts the
 * FLOW consumers only and says so (docs/plans/V2.7-TRANSFER-PAYMENT-
 * CLASSIFICATION-AUDIT-2026-10-27.md §5).
 *
 * Where today's behaviour meets the owner contract it is PINNED. Where it does
 * not, the CURRENT behaviour is recorded in KNOWN_GAPS beside the EXPECTED one
 * and asserted as current — so this file passes today, a fix flips exactly one
 * named entry, and nothing wrong is ever encoded as correct.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mapPlaidCategory, type PlaidCategoryInput } from "./plaid-category";
import { resolveLiabilityPaymentCategory } from "./liability-payment";
import { classifyFlow, type FlowClassificationInput } from "./flow-classifier";
import { matchTransferCandidate, type RelationshipTransaction, type TransferCandidateRelationship } from "./RelationshipResolver";
import { isTransferPrefilterCandidate } from "./transfer-maturation";
import { decideTransferDebtPaymentCorrection } from "./transfer-debt-payment-correction";
import { serializeTransactionRow } from "./serialize";
import { deriveTransactionContext } from "./transaction-context";
import { plaidTransferEvidence } from "./plaid-transfer-evidence";
import { resolveTransactionNature, natureEvidenceFromRow, type ResolvedTransactionNature } from "./resolved-nature";
import { describeRowNature, isHumanCategorySource } from "./flow-presentation";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "./liquidity";
import { aggregateDayFacts, economicSpend } from "./cash-flow-projection";
import { categorySpendLedger } from "./cash-flow";
import { totalDebtPaid } from "./debt-payment-authority";
import { computeDebtService } from "./debt-service";
import { findDuplicateEvents } from "./event-projection";
import type { Transaction } from "@/types";

// ── Accounts (one owner) ─────────────────────────────────────────────────────

const ACCOUNTS: { id: string; type: string; owner?: string }[] = [
  { id: "chk", type: "checking" },          // institution A
  { id: "sav", type: "savings" },           // institution A
  { id: "hysa", type: "savings" },          // institution B (bank-and-card issuer)
  { id: "mm", type: "savings" },            // Plaid Sandbox "Money Market"
  { id: "cd", type: "savings" },            // Plaid Sandbox "CD"
  { id: "card", type: "debt" },             // credit card
  { id: "loan", type: "debt" },             // auto loan
  { id: "brk", type: "investment" },        // brokerage, institution C
  { id: "jointChk", type: "checking", owner: "u2" }, // a co-member's account (cross-owner)
];
const TYPE = new Map(ACCOUNTS.map((a) => [a.id, a.type]));
const OWNER = new Map(ACCOUNTS.map((a) => [a.id, a.owner ?? "u1"]));
const typeOf = (id: string) => TYPE.get(id);
const LIQ = tierResolver(ACCOUNTS);

// ── Raw provider rows (FM sign: + into the row's own account) ────────────────

interface Raw {
  id: string; acct: string; date: string; amount: number; name: string;
  pfc?: [primary: string, detailed: string] | null;
  /** No PFC at all (CSV / manual import): the category is given directly. */
  csvCategory?: string;
  pending?: boolean; eventId?: string; deleted?: boolean;
  /** A human's category correction (USER_OVERRIDE). */
  userCategory?: string;
}

interface Stored extends Raw {
  category: string; flowType: string; flowDirection: string;
  classificationReason: string; classificationConfidence: number;
  flowAuthority: string; categorySource: string | null;
}

/** INGEST — exactly the sync write order: category → rescue → classifier. */
function ingest(r: Raw): Stored {
  const accountType = typeOf(r.acct) ?? null;
  let category: string = r.csvCategory ?? mapPlaidCategory({
    personal_finance_category: r.pfc ? { primary: r.pfc[0], detailed: r.pfc[1], confidence_level: null } : null,
    category: null, merchant_name: r.name, name: r.name,
  } as unknown as PlaidCategoryInput);
  category = resolveLiabilityPaymentCategory(category, "Payment", {
    accountType, debtSubtype: null, amount: r.amount, merchant: r.name, description: r.name,
  });
  const user = r.userCategory != null;
  if (user) category = r.userCategory!;
  const input: FlowClassificationInput = {
    category, amount: r.amount, accountType, debtSubtype: null,
    pfcPrimary: r.pfc?.[0] ?? null, pfcDetailed: r.pfc?.[1] ?? null,
    ...(user ? { providerTaxonomySuppressed: true } : {}),
  };
  const c = classifyFlow(input);
  return {
    ...r, category, flowType: c.flowType, flowDirection: c.flowDirection,
    classificationReason: c.reason, classificationConfidence: c.confidence,
    flowAuthority: "CLASSIFIER", categorySource: user ? "USER_OVERRIDE" : (r.pfc ? "PLAID_PFC" : null),
  };
}

const MATCH_CTX = { accountTypeById: TYPE };

function rel(s: Stored): RelationshipTransaction {
  const d = new Date(`${s.date}T12:00:00Z`);
  return {
    id: s.id, financialAccountId: s.acct, plaidTransactionId: null, pendingTransactionRef: null,
    date: d, economicDate: d, amount: s.amount, merchant: s.name, description: s.name,
    transactionEventId: s.eventId ?? null, pending: s.pending ?? false, deletedAt: s.deleted ? d : null,
    flowType: s.flowType, currency: "USD", ownerUserId: OWNER.get(s.acct) ?? null,
    settlementState: null, pfcDetailed: s.pfc?.[1] ?? null, pfcPrimary: s.pfc?.[0] ?? null,
    persistedCounterpartyAccountId: null, category: s.category, counterpartyClass: null,
    institutionId: null, descriptor: s.name,
  };
}

/** READ-TIME transfer authority, as resolveTransferAssessments runs it (prefilter targets + corpus). */
function assess(rows: Stored[]): Map<string, TransferCandidateRelationship> {
  const live = rows.filter((r) => !r.deleted);
  const corpus = live.filter((r) => isTransferPrefilterCandidate(r.flowType)).map(rel);
  const out = new Map<string, TransferCandidateRelationship>();
  for (const t of live) {
    if (!isTransferPrefilterCandidate(t.flowType)) continue;
    out.set(t.id, matchTransferCandidate(rel(t), corpus, MATCH_CTX));
  }
  return out;
}

/** WRITE — the PR #58 transfer-authority correction, applied as the sync / repair would. */
function correct(rows: Stored[], a: Map<string, TransferCandidateRelationship>): Stored[] {
  return rows.map((r) => {
    const x = a.get(r.id);
    const d = decideTransferDebtPaymentCorrection({
      ownAccountType: typeOf(r.acct) ?? null, flowType: r.flowType, flowAuthority: r.flowAuthority,
      rowCategorySource: r.categorySource, category: r.category,
      pfcPrimary: r.pfc?.[0] ?? null, pfcDetailed: r.pfc?.[1] ?? null,
      classificationReason: r.classificationReason, classificationConfidence: r.classificationConfidence,
      deleted: r.deleted ?? false, supersededByPosted: false, persistedCounterpartyAccountType: null,
      assessment: x ? { evidenceLevel: x.evidenceLevel, maturity: x.maturity, unresolvedReason: x.unresolvedReason } : null,
    });
    return d.action === "WRITE" ? { ...r, ...d.write, flowAuthority: "TRANSFER_AUTHORITY" } as Stored : r;
  });
}

/** DTO — what every surface reads (projectTransactionListRows), over the live projection only. */
function project(rows: Stored[]): Transaction[] {
  const live = rows.filter((r) => !r.deleted);
  const a = assess(live);
  return live.map((s) => {
    const x = a.get(s.id);
    const cp = x?.persistableCounterparty ? x.counterpartyAccountId : null;
    const ev = plaidTransferEvidence({ pfcDetailed: s.pfc?.[1] ?? null, amount: s.amount, name: s.name });
    const dto = serializeTransactionRow({
      id: s.id, financialAccountId: s.acct, date: new Date(`${s.date}T00:00:00Z`),
      economicDate: new Date(`${s.date}T00:00:00Z`), transactionEventId: s.eventId ?? null,
      merchant: s.name, description: s.name, category: s.category, amount: s.amount,
      pending: s.pending ?? false, settlementState: null, authorizedAt: null, currency: "USD",
      flowType: s.flowType, flowDirection: s.flowDirection,
      classificationConfidence: s.classificationConfidence, classificationReason: s.classificationReason,
      flowAuthority: s.flowAuthority as never, categorySource: s.categorySource,
      counterpartyAccountId: cp, pfcPrimary: s.pfc?.[0] ?? null, pfcDetailed: s.pfc?.[1] ?? null,
      accountType: typeOf(s.acct) ?? null,
    });
    const ctx = deriveTransactionContext({
      flowType: s.flowType, classificationReason: s.classificationReason,
      transferRail: ev.railType ?? null, transferMovementForm: ev.movementForm ?? null,
      transferVenueClass: ev.venueClass ?? null, transferEvidenceConfidence: ev.evidenceConfidence,
      transferEvidenceReason: ev.reason, transferEvidenceSource: ev.source ?? null,
      transferEvidenceVersion: ev.version ?? null, hasResolvedMerchant: false,
      isOwnedCounterparty: cp != null, transferMaturity: x?.maturity ?? null,
    });
    return { ...dto, transferDisposition: ctx.transferDisposition, transferMaturity: x?.maturity ?? null } as Transaction;
  });
}

/** The full pipeline: ingest → assess → correct → project. */
function pipeline(raws: Raw[]): { stored: Stored[]; dtos: Transaction[] } {
  const ingested = raws.map(ingest);
  const stored = correct(ingested, assess(ingested));
  return { stored, dtos: project(stored) };
}

// ── Consumers ────────────────────────────────────────────────────────────────

interface RowView {
  flowType: string | null; category: string; nature: ResolvedTransactionNature["nature"];
  reducesDebt: boolean; label: string; liquidity: string; maturity: string | null;
}
function view(dto: Transaction): RowView {
  const n = resolveTransactionNature(natureEvidenceFromRow(dto as never, typeOf));
  const label = describeRowNature({
    flowType: dto.flowType ?? null, transferMaturity: dto.transferMaturity ?? null,
    incomeSubtype: dto.incomeSubtype ?? null, amount: dto.amount,
    hasOwnedCounterparty: dto.counterpartyAccountId != null,
    humanCategorized: isHumanCategorySource(dto.categorySource),
  }).label;
  const l = classifyLiquidity(dto as LiquidityTx, LIQ);
  return {
    flowType: dto.flowType ?? null, category: dto.category, nature: n.nature, reducesDebt: n.reducesDebt,
    label, liquidity: `${l.effect}/${l.reason}`, maturity: dto.transferMaturity ?? null,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Totals {
  income: number; spending: number; cashIn: number; cashOut: number; netCash: number;
  unresolved: number; chargedOnCredit: number; debtPaid: number; netPaydown: number; netNewBorrowing: number;
}
function totals(dtos: Transaction[]): Totals {
  const f = aggregateDayFacts(dtos as LiquidityTx[], LIQ);
  const abs = (t: LiquidityTx) => Math.abs(t.amount);
  const svc = computeDebtService(dtos as LiquidityTx[], LIQ, abs);
  return {
    income: r2(f.income), spending: r2(economicSpend(f)), cashIn: r2(f.cashIn), cashOut: r2(f.cashOut),
    netCash: r2(f.cashIn - f.cashOut), unresolved: r2(f.unresolved), chargedOnCredit: r2(f.creditCardSpending),
    debtPaid: r2(totalDebtPaid(dtos as LiquidityTx[], LIQ, abs).total),
    netPaydown: svc.netPaydown, netNewBorrowing: svc.netNewBorrowing,
  };
}

const viewOf = (dtos: Transaction[], id: string) => {
  const d = dtos.find((x) => x.id === id);
  assert.ok(d, `row ${id} missing from the projection`);
  return view(d!);
};

// ── KNOWN GAPS — current vs contract, asserted as CURRENT ────────────────────

interface Gap { id: string; case: number; row: string; field: keyof RowView | keyof Totals; current: unknown; expected: unknown; note: string }
const KNOWN_GAPS: Gap[] = [];
function gap(g: Gap, actual: unknown) {
  KNOWN_GAPS.push(g);
  assert.deepEqual(actual, g.current, `${g.id}: current behaviour moved — if this is the fix, move the gap to a pin`);
}

// ═════════════════════════════════════════════════════════════════════════════
// F-1 — the Plaid Sandbox fixture (docs/plans/V2.7-CASHFLOW-SPENDING-FIXTURE-
// RECONCILIATION-2026-10-27.md), reproduced through the pipeline.
// ═════════════════════════════════════════════════════════════════════════════

const CC_PAY: [string, string] = ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
const SANDBOX: Raw[] = [
  { id: "sbRefundUnited", acct: "chk", date: "2026-10-20", amount: 500, name: "United Airlines", pfc: ["TRAVEL", "TRAVEL_FLIGHTS"] },
  { id: "sbFun", acct: "chk", date: "2026-10-10", amount: -89.4, name: "FUN", pfc: ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"] },
  { id: "sbMcd", acct: "chk", date: "2026-10-11", amount: -12, name: "McDonald's", pfc: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD"] },
  { id: "sbUber1", acct: "chk", date: "2026-10-12", amount: -6.33, name: "Uber", pfc: ["TRAVEL", "TRAVEL_TAXIS_AND_RIDE_SHARES"] },
  { id: "sbUber2", acct: "chk", date: "2026-10-13", amount: -5.4, name: "Uber", pfc: ["TRAVEL", "TRAVEL_TAXIS_AND_RIDE_SHARES"] },
  { id: "sbSbux", acct: "chk", date: "2026-10-14", amount: -4.33, name: "Starbucks", pfc: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"] },
  // F-1: the card-side "payment" with a balance-INCREASING sign.
  { id: "sbAutoPay", acct: "card", date: "2026-10-15", amount: -2078.5, name: "AUTOMATIC PAYMENT - THANK", pfc: CC_PAY },
  { id: "sbUnitedCard", acct: "card", date: "2026-10-16", amount: -500, name: "United Airlines", pfc: ["TRAVEL", "TRAVEL_FLIGHTS"] },
  { id: "sbTectra", acct: "card", date: "2026-10-17", amount: -500, name: "Tectra Inc", pfc: ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_OTHER_UTILITIES"] },
  { id: "sbMadison", acct: "card", date: "2026-10-18", amount: -500, name: "Madison Bicycle Center", pfc: ["ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS"] },
  { id: "sbKfc", acct: "card", date: "2026-10-19", amount: -500, name: "KFC", pfc: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD"] },
  { id: "sbTouchstone", acct: "card", date: "2026-10-21", amount: -78.5, name: "Touchstone Climbing", pfc: ["ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS"] },
  // The unresolved movements.
  { id: "sbGusto", acct: "mm", date: "2026-10-05", amount: -5850, name: "GUSTO PAY 123456", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "sbCdInit", acct: "cd", date: "2026-10-06", amount: -1000, name: "CD DEPOSIT .INITIAL.", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "sbCc3333", acct: "sav", date: "2026-10-07", amount: -25, name: "CREDIT CARD 3333 PAYMENT *//", pfc: CC_PAY },
  { id: "sbIntrst", acct: "sav", date: "2026-10-08", amount: 4.22, name: "INTRST PYMNT", pfc: ["TRANSFER_IN", "TRANSFER_IN_OTHER_TRANSFER_IN"] },
];

test("F-1 · the Sandbox window through the real pipeline (classifier v6: the AUTOMATIC PAYMENT row leaves spending)", () => {
  const { dtos } = pipeline(SANDBOX);
  const t = totals(dtos);
  // Before v6 (the Preview figures): card 4,157.00 · spending 3,774.46 · unresolved 6,879.22.
  assert.equal(t.cashIn, 500);
  assert.equal(t.cashOut, 117.46);
  assert.equal(t.netCash, 382.54);
  assert.equal(t.chargedOnCredit, 2078.5);
  assert.equal(t.spending, 1695.96);
  assert.equal(t.unresolved, 8957.72);
  assert.equal(t.debtPaid, 0, "the window has no attested card payment — 'No debt payments in this period'");
  assert.equal(t.income, 0);
});

test("F-1 · the AUTOMATIC PAYMENT row: raw facts, current verdict on every consumer, expected verdict", () => {
  const { stored, dtos } = pipeline(SANDBOX);
  const s = stored.find((r) => r.id === "sbAutoPay")!;
  // Raw provider facts survive untouched.
  assert.deepEqual(s.pfc, CC_PAY);
  assert.equal(s.amount, -2078.5);             // money OUT of a liability = the balance owed went UP
  assert.equal(typeOf(s.acct), "debt");
  assert.equal(s.category, "Payment");         // mapPlaidCategory CC-1: CREDIT_CARD_PAYMENT ⇒ Payment
  // v6 (GAP-1): a payment-shaped liability OUTFLOW is the honest UNKNOWN valve —
  // neither a purchase (the CCPAY-2B veto's old answer) nor a debt payment.
  assert.equal(s.flowType, "UNKNOWN");
  assert.equal(s.flowDirection, "OUTFLOW");
  assert.equal(s.classificationReason, "ACCOUNT_TYPE_CONTEXT");
  assert.equal(s.classificationConfidence, 0.3);
  // Matching evidence: an UNKNOWN row enters the prefilter, but admission refuses a
  // liability charge, and no equal depository leg (±2,078.50) exists in the window anyway.
  assert.equal(SANDBOX.filter((r) => r.acct !== "card" && Math.abs(r.amount) === 2078.5).length, 0);
  const v = viewOf(dtos, "sbAutoPay");
  assert.equal(v.liquidity, "UNRESOLVED/UNRESOLVED");  // never Cash out; disclosed as unresolved
  assert.equal(v.reducesDebt, false);
  assert.deepEqual([v.nature, v.label], ["UNCLASSIFIED", "Unclassified"]);
  // Category donut: the row is no longer spending; "Other" is Madison 500 + Touchstone 78.50.
  const other = categorySpendLedger(dtos).find((l) => l.category === "Other")!;
  assert.equal(r2(other.net), 578.5);
  assert.ok(!other.transactionIds.includes("sbAutoPay"));
});

test("F-1 · the $25 Saving 'CREDIT CARD 3333 PAYMENT': unattested ⇒ unresolved money, not a debt payment", () => {
  const { stored, dtos } = pipeline(SANDBOX);
  assert.equal(stored.find((r) => r.id === "sbCc3333")!.flowType, "DEBT_PAYMENT");   // provider category kept (keep: LIABILITY_EVIDENCE)
  const v = viewOf(dtos, "sbCc3333");
  assert.equal(v.maturity, "UNRESOLVED_TRANSFER");
  assert.equal(v.liquidity, "UNRESOLVED/UNRESOLVED");
  assert.equal(v.nature, "UNCLASSIFIED_MOVEMENT");
  assert.equal(v.reducesDebt, false);
  assert.equal(v.label, "Transfer out", "label must not claim a debt payment the money layer refuses");
});

// ═════════════════════════════════════════════════════════════════════════════
// The 10-case matrix
// ═════════════════════════════════════════════════════════════════════════════

// Case 1 — card purchase vs card bill payment (both legs; paired & unpaired)
const C1: Raw[] = [
  { id: "c1Buy", acct: "card", date: "2026-10-02", amount: -640, name: "BEST BUY 0042", pfc: ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS"] },
  { id: "c1PayCash", acct: "chk", date: "2026-10-05", amount: -300, name: "CHASE CREDIT CRD AUTOPAY", pfc: CC_PAY },
  { id: "c1PayCard", acct: "card", date: "2026-10-05", amount: 300, name: "Payment Thank You-Mobile", pfc: CC_PAY },
  // Unpaired card-side credit: paid from a bank that is not connected.
  { id: "c1PayCardOnly", acct: "card", date: "2026-10-20", amount: 450, name: "MOBILE PAYMENT - THANK YOU", pfc: CC_PAY },
  // Unpaired cash-side payment to a card that is not connected.
  { id: "c1PayCashOnly", acct: "chk", date: "2026-10-22", amount: -125, name: "DISCOVER E-PAYMENT", pfc: CC_PAY },
];
test("case 1 · card purchase = spending when incurred; bill payment = cash movement + debt settlement, counted once", () => {
  const { dtos } = pipeline(C1);
  const buy = viewOf(dtos, "c1Buy");
  assert.deepEqual([buy.flowType, buy.nature, buy.liquidity, buy.label], ["SPENDING", "SPENDING", "NEUTRAL/REAL_COST", "Spending"]);
  const cash = viewOf(dtos, "c1PayCash");
  assert.deepEqual([cash.flowType, cash.maturity, cash.nature, cash.reducesDebt, cash.liquidity, cash.label],
    ["DEBT_PAYMENT", "DEBT_PAYMENT", "LIABILITY_PAYMENT", true, "CASH_OUT/DEBT_PAYMENT", "Debt payment"]);
  const card = viewOf(dtos, "c1PayCard");
  assert.deepEqual([card.flowType, card.nature, card.reducesDebt, card.liquidity], ["DEBT_PAYMENT", "LIABILITY_PAYMENT", true, "NEUTRAL/DEBT_PAYMENT"]);
  const cardOnly = viewOf(dtos, "c1PayCardOnly");
  assert.deepEqual([cardOnly.nature, cardOnly.reducesDebt, cardOnly.liquidity], ["LIABILITY_PAYMENT", true, "NEUTRAL/DEBT_PAYMENT"]);
  const cashOnly = viewOf(dtos, "c1PayCashOnly");
  assert.deepEqual([cashOnly.flowType, cashOnly.nature, cashOnly.reducesDebt, cashOnly.liquidity, cashOnly.label],
    ["DEBT_PAYMENT", "UNCLASSIFIED_MOVEMENT", false, "UNRESOLVED/UNRESOLVED", "Transfer out"]);
  const t = totals(dtos);
  assert.equal(t.spending, 640, "no payment leg is ever spending");
  assert.equal(t.debtPaid, 300, "the paired payment is counted once (cash leg); the card leg is neutral");
  assert.equal(t.cashOut, 300);
  assert.equal(t.unresolved, 125, "an unattested cash-side payment is unresolved, never asserted");
  assert.equal(t.income, 0);
});

// Case 2 — checking / savings / HYSA owned transfers (incl. the bank-and-card issuer mislabel)
const C2: Raw[] = [
  { id: "c2Out", acct: "chk", date: "2026-10-03", amount: -1000, name: "Online Transfer to SAV", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c2In", acct: "sav", date: "2026-10-03", amount: 1000, name: "Online Transfer from CHK", pfc: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"] },
  // ACH pull by a bank-and-card issuer into its HYSA, tagged LOAN_PAYMENTS by the provider.
  { id: "c2HysaOut", acct: "chk", date: "2026-10-08", amount: -1500, name: "ISSUER B ACH PMT", pfc: ["LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT"] },
  { id: "c2HysaIn", acct: "hysa", date: "2026-10-09", amount: 1500, name: "TRANSFER FROM CHECKING", pfc: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"] },
];
test("case 2 · owned transfers: no income, spending, debt payoff or cash effect — the issuer mislabel is corrected", () => {
  const ingested = C2.map(ingest);
  assert.equal(ingested.find((r) => r.id === "c2HysaOut")!.flowType, "DEBT_PAYMENT", "provider LOAN_PAYMENTS at ingest");
  const { stored, dtos } = pipeline(C2);
  const out = stored.find((r) => r.id === "c2HysaOut")!;
  assert.equal(out.flowType, "TRANSFER", "the transfer authority's write corrects it");
  assert.equal(out.flowAuthority, "TRANSFER_AUTHORITY");
  for (const id of ["c2Out", "c2In", "c2HysaOut", "c2HysaIn"]) {
    const v = viewOf(dtos, id);
    assert.equal(v.reducesDebt, false, id);
    assert.equal(v.liquidity, "NEUTRAL/INTERNAL_TRANSFER", id);
    assert.equal(v.label, "Internal transfer", id);
  }
  assert.equal(viewOf(dtos, "c2HysaOut").nature, "INTERNAL_SAVINGS_TRANSFER");
  const t = totals(dtos);
  assert.deepEqual([t.income, t.spending, t.cashIn, t.cashOut, t.debtPaid, t.unresolved], [0, 0, 0, 0, 0, 0]);
});

// Case 3 — ACH pull/push with one side visible
const C3: Raw[] = [
  { id: "c3Push", acct: "chk", date: "2026-10-04", amount: -2000, name: "ACH TRANSFER OUT", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c3Pull", acct: "chk", date: "2026-10-06", amount: 750, name: "ACH CREDIT", pfc: ["TRANSFER_IN", "TRANSFER_IN_OTHER_TRANSFER_IN"] },
];
test("case 3 · one-sided ACH: 'destination not yet confirmed' / unresolved — never spending, income, or external by assumption", () => {
  const { dtos } = pipeline(C3);
  const push = viewOf(dtos, "c3Push");
  assert.deepEqual([push.maturity, push.nature, push.liquidity, push.label],
    ["EXTERNAL_DEPOSITORY_TRANSFER", "TRANSFER_DESTINATION_UNCONFIRMED", "UNRESOLVED/UNRESOLVED", "Transfer out"]);
  const pull = viewOf(dtos, "c3Pull");
  assert.deepEqual([pull.maturity, pull.nature, pull.liquidity, pull.label],
    ["UNRESOLVED_TRANSFER", "UNCLASSIFIED_MOVEMENT", "UNRESOLVED/UNRESOLVED", "Transfer in"]);
  const t = totals(dtos);
  assert.deepEqual([t.income, t.spending, t.cashIn, t.cashOut, t.unresolved], [0, 0, 0, 0, 2750]);
});

// Case 4 — pending debit + posted destination credit, then the debit posts (pending → posted)
const C4_PENDING: Raw[] = [
  { id: "c4Pend", acct: "chk", date: "2026-10-10", amount: -700, name: "Online Transfer to SAV", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"], pending: true, eventId: "e4" },
  { id: "c4Dest", acct: "sav", date: "2026-10-11", amount: 700, name: "Online Transfer from CHK", pfc: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"], eventId: "e4d" },
];
// The posted successor arrives on the SAME event; the pending predecessor is tombstoned.
const C4_POSTED: Raw[] = [
  { ...C4_PENDING[0], deleted: true },
  { ...C4_PENDING[0], id: "c4Post", date: "2026-10-12", pending: false },
  C4_PENDING[1],
];
test("case 4 · pending debit pairs with its posted credit; posting changes no nature and no total; one row per event", () => {
  const before = pipeline(C4_PENDING);
  const after = pipeline(C4_POSTED);
  assert.deepEqual(findDuplicateEvents(after.dtos as never), []);
  assert.equal(after.dtos.length, 2, "the tombstoned pending row is not in the projection");
  assert.equal(viewOf(before.dtos, "c4Pend").nature, "INTERNAL_SAVINGS_TRANSFER");
  assert.equal(viewOf(after.dtos, "c4Post").nature, "INTERNAL_SAVINGS_TRANSFER");
  assert.deepEqual(totals(after.dtos), totals(before.dtos));
  assert.equal(totals(after.dtos).unresolved, 0);
});

// Case 5 — posted debit + pending / missing destination credit
const C5: Raw[] = [
  { id: "c5Out", acct: "chk", date: "2026-10-14", amount: -800, name: "Online Transfer to SAV", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c5InPending", acct: "sav", date: "2026-10-15", amount: 800, name: "Online Transfer from CHK", pfc: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"], pending: true },
  { id: "c5Missing", acct: "chk", date: "2026-10-16", amount: -900, name: "Online Transfer", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_OTHER_TRANSFER_OUT"] },
];
test("case 5 · a pending destination still pairs; a missing one stays unresolved (not external, not spending, no 'in transit' guess)", () => {
  const { dtos } = pipeline(C5);
  assert.equal(viewOf(dtos, "c5Out").nature, "INTERNAL_SAVINGS_TRANSFER");
  const m = viewOf(dtos, "c5Missing");
  assert.deepEqual([m.maturity, m.nature, m.liquidity, m.reducesDebt], ["UNRESOLVED_TRANSFER", "UNCLASSIFIED_MOVEMENT", "UNRESOLVED/UNRESOLVED", false]);
  const t = totals(dtos);
  assert.deepEqual([t.spending, t.cashOut, t.unresolved, t.income], [0, 0, 900, 0]);
});

// Case 6 — loan principal vs interest/fees
const C6: Raw[] = [
  { id: "c6PayCash", acct: "chk", date: "2026-10-01", amount: -450, name: "AUTO LOAN PMT", pfc: ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT"] },
  { id: "c6PayLoan", acct: "loan", date: "2026-10-01", amount: 450, name: "PAYMENT RECEIVED", pfc: ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT"] },
  { id: "c6Interest", acct: "loan", date: "2026-10-01", amount: -35, name: "INTEREST CHARGED", pfc: ["BANK_FEES", "BANK_FEES_INTEREST_CHARGE"] },
  { id: "c6CardFee", acct: "card", date: "2026-10-03", amount: -39, name: "LATE FEE", pfc: ["BANK_FEES", "BANK_FEES_LATE_FEE"] },
];
test("case 6 · loan payment reduces debt (cash leg once); evidenced interest/fees are spending; no invented split", () => {
  const { dtos } = pipeline(C6);
  assert.deepEqual([viewOf(dtos, "c6PayCash").nature, viewOf(dtos, "c6PayCash").reducesDebt], ["LIABILITY_PAYMENT", true]);
  assert.equal(viewOf(dtos, "c6PayLoan").liquidity, "NEUTRAL/DEBT_PAYMENT");
  assert.deepEqual([viewOf(dtos, "c6Interest").flowType, viewOf(dtos, "c6Interest").nature], ["INTEREST", "SPENDING"]);
  assert.deepEqual([viewOf(dtos, "c6CardFee").flowType, viewOf(dtos, "c6CardFee").label], ["FEE", "Fee"]);
  const t = totals(dtos);
  assert.equal(t.debtPaid, 450, "the whole payment: the feed carries no principal/interest split");
  assert.equal(t.spending, 74, "interest 35 + fee 39, only because the lender/issuer posted them as rows");
  assert.equal(t.netPaydown, 376, "payments 450 − charges on liabilities 74");
});

// Case 7 — refunds, reversals, chargebacks, returned payments
const C7: Raw[] = [
  { id: "c7Buy", acct: "card", date: "2026-10-02", amount: -220, name: "DELTA AIR", pfc: ["TRAVEL", "TRAVEL_FLIGHTS"] },
  { id: "c7Refund", acct: "card", date: "2026-10-09", amount: 220, name: "DELTA AIR", pfc: ["TRAVEL", "TRAVEL_FLIGHTS"] },
  { id: "c7Chargeback", acct: "card", date: "2026-10-12", amount: 60, name: "DISPUTE CREDIT", pfc: ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"] },
  { id: "c7FeeReversal", acct: "card", date: "2026-10-13", amount: 39, name: "LATE FEE REVERSAL", pfc: ["BANK_FEES", "BANK_FEES_LATE_FEE"] },
  // A card payment that is RETURNED (NSF): the original two legs, then the reversal on both sides.
  { id: "c7PayCash", acct: "chk", date: "2026-10-15", amount: -300, name: "CARD AUTOPAY", pfc: CC_PAY },
  { id: "c7PayCard", acct: "card", date: "2026-10-15", amount: 300, name: "Payment Thank You-Mobile", pfc: CC_PAY },
  { id: "c7ReturnCard", acct: "card", date: "2026-10-19", amount: -300, name: "PAYMENT RETURNED", pfc: CC_PAY },
  { id: "c7ReturnCash", acct: "chk", date: "2026-10-19", amount: 300, name: "RETURNED ITEM CREDIT", pfc: ["TRANSFER_IN", "TRANSFER_IN_OTHER_TRANSFER_IN"] },
];
test("case 7 · refunds reverse their category without income; returned payments are the open gap", () => {
  const { dtos } = pipeline(C7);
  assert.deepEqual([viewOf(dtos, "c7Refund").flowType, viewOf(dtos, "c7Refund").label], ["REFUND", "Refund"]);
  assert.equal(viewOf(dtos, "c7Chargeback").flowType, "REFUND");
  const travel = categorySpendLedger(dtos).find((l) => l.category === "Travel")!;
  assert.equal(travel.net, 0, "the refund nets its own category");
  const ret = viewOf(dtos, "c7ReturnCard");
  assert.deepEqual([ret.flowType, ret.nature, ret.liquidity], ["UNKNOWN", "UNCLASSIFIED", "UNRESOLVED/UNRESOLVED"],
    "v6: a returned card payment is not a purchase");
  const back = viewOf(dtos, "c7ReturnCash");
  assert.deepEqual([back.nature, back.liquidity], ["UNCLASSIFIED_MOVEMENT", "UNRESOLVED/UNRESOLVED"], "returned money is never income");
  const t = totals(dtos);
  assert.equal(t.income, 0);
  assert.equal(t.spending, 0, "v6: gross 220 − credits 319, floored (was 201 with the returned payment counted)");
  gap({ id: "GAP-4", case: 7, row: "(window)", field: "debtPaid", current: 300, expected: 0,
    note: "the returned payment is not netted against the payment it reverses (no reversal pairing exists)" }, t.debtPaid);
  // The fee reversal itself: the money layers agree it is a CREDIT (economic fold, liquidity REFUND).
  const rev = viewOf(dtos, "c7FeeReversal");
  assert.equal(rev.liquidity, "NEUTRAL/REFUND");
  assert.deepEqual([rev.nature, rev.label], ["REFUND", "Refund"], "a cost-flow credit reads as the reversal every total treats it as");
  assert.equal(t.chargedOnCredit, 220, "DayFacts: Delta 220 only — neither the fee reversal nor (v6) the returned payment is a charge");
});

// Debt service — a cost-flow CREDIT on a liability (independent of every other gap)
const C7B: Raw[] = [
  { id: "c7bBuy", acct: "card", date: "2026-10-02", amount: -100, name: "GROCER", pfc: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"] },
  { id: "c7bFeeRev", acct: "card", date: "2026-10-03", amount: 39, name: "LATE FEE REVERSAL", pfc: ["BANK_FEES", "BANK_FEES_LATE_FEE"] },
  { id: "c7bPayCash", acct: "chk", date: "2026-10-05", amount: -100, name: "CARD AUTOPAY", pfc: CC_PAY },
  { id: "c7bPayCard", acct: "card", date: "2026-10-05", amount: 100, name: "Payment Thank You-Mobile", pfc: CC_PAY },
];
test("debt service · a fee reversal on a card is a credit in every money layer except the debt-service decomposition", () => {
  const { dtos } = pipeline(C7B);
  const t = totals(dtos);
  assert.equal(t.spending, 61, "economic fold: 100 − 39");
  assert.equal(t.chargedOnCredit, 100, "DayFacts: the reversal is not a charge");
  assert.equal(t.debtPaid, 100);
  gap({ id: "GAP-5", case: 7, row: "c7bFeeRev", field: "netPaydown", current: 0, expected: 39,
    note: "computeDebtService adds a positive cost-flow row on a liability to new CHARGES (139) instead of refunds (charges 100 − 39 = 61; payment 100 ⇒ paydown 39)" }, t.netPaydown);
  gap({ id: "GAP-5", case: 7, row: "c7bFeeRev", field: "netNewBorrowing", current: 39, expected: 0, note: "same rows" }, t.netNewBorrowing);
});

// Case 8 — external payments / withdrawals / unknown counterparties
const C8: Raw[] = [
  { id: "c8Atm", acct: "chk", date: "2026-10-05", amount: -200, name: "ATM WITHDRAWAL", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL"] },
  { id: "c8Zelle", acct: "chk", date: "2026-10-06", amount: -150, name: "Zelle payment to J", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c8Csv", acct: "chk", date: "2026-10-07", amount: -80, name: "CHECK 1043", csvCategory: "Other" },
];
test("case 8 · cash withdrawal = form change; P2P = cash out through an app (purpose unknown); unknown check = sign-default", () => {
  const { dtos } = pipeline(C8);
  const atm = viewOf(dtos, "c8Atm");
  assert.equal(atm.nature, "CASH_MOVEMENT");
  const z = viewOf(dtos, "c8Zelle");
  assert.deepEqual([z.maturity, z.nature, z.liquidity], ["EXTERNAL_PERSON_TRANSFER", "EXTERNAL_TRANSFER", "CASH_OUT/PAYMENT_APP_OUTFLOW"]);
  const c = viewOf(dtos, "c8Csv");
  // SR-1 doctrine: a NEGATIVE `Other` is a cost with no finer label (not a matching failure).
  assert.deepEqual([c.flowType, c.label], ["SPENDING", "Spending"]);
  const t = totals(dtos);
  assert.equal(t.spending, 80);
  assert.equal(aggregateDayFacts(dtos as LiquidityTx[], LIQ).cashWithdrawals, 200);
  assert.equal(t.income, 0);
});

// Case 9 — provider category contradicting account type / direction / matched counterparty
const C9: Raw[] = [
  // Real card purchase Plaid tagged CREDIT_CARD_PAYMENT (an issuer-branded travel booking).
  { id: "c9TravelBooking", acct: "card", date: "2026-10-03", amount: -506.98, name: "ISSUER TRAVEL BOOKING", pfc: CC_PAY },
  // Card POS Plaid filed as an account transfer (CF-4).
  { id: "c9PosAsTransfer", acct: "card", date: "2026-10-04", amount: -88, name: "DEPT STORE", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  // Merchant credit on a card Plaid filed as income (REFUND-1).
  { id: "c9IncomeOnCard", acct: "card", date: "2026-10-05", amount: 45.09, name: "RIDESHARE", pfc: ["INCOME", "INCOME_OTHER_INCOME"] },
  // Owned transfer whose destination leg the provider tagged INCOME.
  { id: "c9XferOut", acct: "chk", date: "2026-10-06", amount: -1200, name: "Online Transfer to SAV", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c9XferInAsIncome", acct: "sav", date: "2026-10-06", amount: 1200, name: "DEPOSIT FROM CHK", pfc: ["INCOME", "INCOME_OTHER_INCOME"] },
];
test("case 9 · account context outranks the provider category — pinned where it works, gaps where it does not", () => {
  const { dtos } = pipeline(C9);
  // THE v6 TRADE-OFF (owner-approved or not at all): a REAL purchase the provider
  // tagged CREDIT_CARD_PAYMENT is no longer counted as spending — it is UNKNOWN,
  // surfaced for review, and a user correction restores it. Before v6: SPENDING.
  assert.deepEqual([viewOf(dtos, "c9TravelBooking").flowType, viewOf(dtos, "c9TravelBooking").nature], ["UNKNOWN", "UNCLASSIFIED"]);
  const fixed = pipeline([{ ...C9[0], userCategory: "Travel" }]);
  assert.equal(viewOf(fixed.dtos, "c9TravelBooking").flowType, "SPENDING", "a USER_OVERRIDE restores the purchase");
  assert.equal(viewOf(dtos, "c9PosAsTransfer").flowType, "SPENDING");
  const credit = viewOf(dtos, "c9IncomeOnCard");
  assert.notEqual(credit.flowType, "INCOME", "never income on a card");
  const t = totals(dtos);
  gap({ id: "GAP-3", case: 9, row: "c9XferInAsIncome", field: "nature", current: "INCOME", expected: "INTERNAL_CHECKING_TRANSFER/INTERNAL_TRANSFER (owned leg)",
    note: "the read-time transfer authority never assesses an INCOME row, so a provider-INCOME destination leg of an owned transfer counts as income and strands its source leg" },
    viewOf(dtos, "c9XferInAsIncome").nature);
  gap({ id: "GAP-3", case: 9, row: "(window)", field: "income", current: 1200, expected: 0, note: "same rows, totals" }, t.income);
  gap({ id: "GAP-3", case: 9, row: "c9XferOut", field: "liquidity", current: "UNRESOLVED/UNRESOLVED", expected: "NEUTRAL/INTERNAL_TRANSFER", note: "the source leg is left unmatched" },
    viewOf(dtos, "c9XferOut").liquidity);
});

// Case 10 — transfers across institutions / providers / owners
const C10: Raw[] = [
  { id: "c10ToBrk", acct: "chk", date: "2026-10-07", amount: -2000, name: "TRANSFER TO BROKERAGE", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"] },
  { id: "c10BrkIn", acct: "brk", date: "2026-10-08", amount: 2000, name: "CONTRIBUTION", pfc: ["TRANSFER_IN", "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS"] },
  // A CSV-imported leg (no PFC) pairing with a Plaid leg at another institution.
  { id: "c10PlaidOut", acct: "sav", date: "2026-10-09", amount: -333.33, name: "XFER", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c10CsvIn", acct: "hysa", date: "2026-10-10", amount: 333.33, name: "Incoming transfer", csvCategory: "Transfer" },
  // Cross-owner (a co-member's account): never paired across the ownership boundary.
  { id: "c10ToJoint", acct: "chk", date: "2026-10-11", amount: -444, name: "Online Transfer", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] },
  { id: "c10JointIn", acct: "jointChk", date: "2026-10-11", amount: 444, name: "Online Transfer", pfc: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"] },
];
test("case 10 · cross-institution and cross-provider transfers pair; brokerage = asset deployment (not spending); cross-owner stays unresolved", () => {
  const { dtos } = pipeline(C10);
  const brk = viewOf(dtos, "c10ToBrk");
  assert.deepEqual([brk.nature, brk.liquidity, brk.reducesDebt], ["BROKERAGE_TRANSFER", "CASH_OUT/ASSET_DEPLOYMENT", false]);
  assert.equal(viewOf(dtos, "c10PlaidOut").nature, "INTERNAL_SAVINGS_TRANSFER");
  assert.equal(viewOf(dtos, "c10CsvIn").liquidity, "NEUTRAL/INTERNAL_TRANSFER");
  const j = viewOf(dtos, "c10ToJoint");
  assert.notEqual(j.nature, "EXTERNAL_TRANSFER", "an unmatched leg is never assumed external");
  assert.equal(j.reducesDebt, false);
  const t = totals(dtos);
  assert.deepEqual([t.income, t.spending], [0, 0]);
});

// ═════════════════════════════════════════════════════════════════════════════
// Resync idempotence + category drift
// ═════════════════════════════════════════════════════════════════════════════

const ALL: Raw[] = [...SANDBOX, ...C1, ...C2, ...C3, ...C5, ...C6, ...C7, ...C8, ...C9, ...C10];

test("resync · the same rows re-classified twice give identical stored facts, natures and totals", () => {
  const once = pipeline(ALL);
  // A resync re-runs ingest on the provider payload and the correction on the result.
  const twice = pipeline(ALL);
  assert.deepEqual(twice.stored, once.stored);
  assert.deepEqual(totals(twice.dtos), totals(once.dtos));
  // Re-applying the transfer-authority write to already-corrected rows changes nothing.
  assert.deepEqual(correct(once.stored, assess(once.stored)), once.stored);
});

test("resync · provider category drift cannot reverse a well-supported classification", () => {
  const base = pipeline(C2);
  // The classifier re-runs on a later sync and writes the provider's DEBT_PAYMENT
  // back over the corrected row BEFORE the transfer authority runs again.
  const drifted = base.stored.map((r) => r.id === "c2HysaOut" ? ingest(C2.find((x) => x.id === r.id)!) : r);
  assert.equal(drifted.find((r) => r.id === "c2HysaOut")!.flowType, "DEBT_PAYMENT");
  const dtos = project(drifted);
  assert.equal(viewOf(dtos, "c2HysaOut").nature, "INTERNAL_SAVINGS_TRANSFER", "the read-time nature holds");
  assert.deepEqual(totals(dtos), totals(base.dtos), "and no total moves in the gap");
  // The card payment cash leg re-tagged by the provider as a plain transfer still settles the card.
  const retag = C1.map((r) => r.id === "c1PayCash" ? { ...r, pfc: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"] as [string, string] } : r);
  const t = totals(pipeline(retag).dtos);
  assert.equal(t.debtPaid, 300);
  assert.equal(t.spending, 640);
});

test("user correction · a scoped, reversible USER_OVERRIDE exists and takes a payment-shaped card outflow out of spending", () => {
  const corrected = pipeline([{ ...SANDBOX.find((r) => r.id === "sbAutoPay")!, userCategory: "Transfer" }]);
  const v = viewOf(corrected.dtos, "sbAutoPay");
  assert.deepEqual([v.flowType, v.nature, v.liquidity], ["TRANSFER", "UNCLASSIFIED_MOVEMENT", "NEUTRAL/INTERNAL_TRANSFER"]);
  assert.equal(totals(corrected.dtos).spending, 0);
  // …but a human "Payment" on a liability OUTFLOW is still vetoed to spending (CCPAY-2B is structural).
  const asPayment = pipeline([{ ...SANDBOX.find((r) => r.id === "sbAutoPay")!, userCategory: "Payment" }]);
  assert.equal(viewOf(asPayment.dtos, "sbAutoPay").flowType, "SPENDING");
});

// ═════════════════════════════════════════════════════════════════════════════
// The whole matrix — totals table + the gap register
// ═════════════════════════════════════════════════════════════════════════════

test("matrix totals (printed for the audit doc) and the gap register", () => {
  const sandbox = totals(pipeline(SANDBOX).dtos);
  const matrix = totals(pipeline(ALL.filter((r) => !SANDBOX.includes(r))).dtos);
  console.log("SANDBOX_TOTALS", JSON.stringify(sandbox));
  console.log("MATRIX_TOTALS", JSON.stringify(matrix));
  const ids = [...new Set(KNOWN_GAPS.map((g) => g.id))].sort();
  console.log("KNOWN_GAPS", JSON.stringify(KNOWN_GAPS.map(({ id, row, field, current, expected }) => ({ id, row, field, current, expected }))));
  assert.deepEqual(ids, ["GAP-3", "GAP-4", "GAP-5"]);
});

test("labels · an unattested provider payment reads as a transfer; a human's 'Payment' is honoured", () => {
  const base = { flowType: "DEBT_PAYMENT", transferMaturity: "UNRESOLVED_TRANSFER", amount: -25 };
  assert.equal(describeRowNature(base).label, "Transfer out");
  assert.equal(describeRowNature({ ...base, humanCategorized: isHumanCategorySource("USER_OVERRIDE") }).label, "Debt payment");
  // The card-side leg (money ARRIVING on a liability) stays a payment whatever its leaf.
  assert.equal(describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: "UNRESOLVED_LIABILITY_INFLOW", amount: 450 }).label, "Debt payment");
  assert.equal(describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: "DEBT_PAYMENT", amount: -300 }).label, "Debt payment");
});

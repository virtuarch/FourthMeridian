/**
 * lib/transactions/transfer-debt-payment-correction.test.ts
 *
 * v2.7-P1 — the transfer authority's debt-payment correction, end to end over the
 * schema-driven in-memory Prisma (lib/test-support/fake-prisma.ts — no Postgres,
 * no network; the run-tests doctrine):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/transactions/transfer-debt-payment-correction.test.ts
 *
 * The evidence is the REAL canonical authority (resolveTransferAssessments →
 * matchTransferCandidate → resolveDestinationEvidenceFor), never a stub, so the
 * fixtures below exercise the mutuality guard, admission and the cross-owner
 * detection exactly as Production does.
 *
 * Fixture (one owner, u1, unless stated). Each scenario is ≥ 3 weeks from every
 * other and uses its own amount, so no scenario can pair with another:
 *   S1  Amex HYSA       checking −1,000 LOAN_PAYMENTS  ↔ savings +1,000      → TRANSFER (SAVINGS_TRANSFER)
 *   S2  Amex checking   checking −747.26 LOAN_PAYMENTS ↔ amex checking +747.26 → TRANSFER (CASH_TRANSFER)
 *   S3  Schwab          checking −1,500 TRANSFER       ↔ schwab +1,500         → untouched, stays TRANSFER
 *   S4  Chase card      checking −300 CC_PAYMENT       ↔ card +300             → DEBT_PAYMENT kept
 *   S5  ambiguous       checking −432.10 OTHER_PAYMENT ↔ savings2 +432.10 AND card +432.10 → TRANSFER @0.2
 *   S6  unpaired card   checking −88.88 CC_PAYMENT, no pair                     → DEBT_PAYMENT kept
 *   S7  unpaired other  checking −1,234.56 OTHER_PAYMENT, no pair               → TRANSFER @0.2
 *   S8  USER_OVERRIDE   checking −2,000 (human said Payment) ↔ savings +2,000  → untouched
 *   S9  pending→posted  checking pending −125.41 + posted twin ↔ savings +125.41 → posted corrected, pending retires
 *   S10 reversal        checking +650 LOAN_PAYMENTS    ↔ savings −650          → TRANSFER
 *   S11 cross-owner     checking −777 OTHER_PAYMENT    ↔ u2 savings +777       → untouched (CROSS_OWNER_BOUNDARY)
 *   S12 brokerage       checking −5,000 LOAN_PAYMENTS  ↔ brokerage +5,000      → TRANSFER (INVESTMENT_TRANSFER)
 *   S13 coincidence     checking −1,000 Shopping on S1's day (same amount)     → never selected, never a rival
 */

import { FakePrisma } from "@/lib/test-support/fake-prisma";
import {
  decideTransferDebtPaymentCorrection,
  resolvedCategory,
  resolvedFlowType,
  type CorrectionInput,
} from "@/lib/transactions/transfer-debt-payment-correction";
import {
  applyTransferDebtPaymentCorrections,
  candidateWhere,
  correctTransferDebtPaymentsAfterSync,
  loadCorrectionCandidates,
  planTransferDebtPaymentCorrections,
  type CorrectionClient,
} from "@/lib/transactions/transfer-debt-payment-correction-write";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import { classifyFlow } from "@/lib/transactions/flow-classifier";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import { computeDebtService } from "@/lib/transactions/debt-service";
import { economicTotals } from "@/lib/transactions/cash-flow";
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";
import { buildMonthlyBreakdown } from "@/lib/ai/assemblers/transactions";
import { projectRecentActivity } from "@/lib/ai/brief/recent-activity";
import { associatesUnconnectedMovement } from "@/lib/ai/brief/contract";
import { basePackage } from "@/lib/ai/brief/fixtures";
import type { Transaction } from "@/types";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); return; }
  failures.push(name);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const SPACE = "space_u1";
const ACCOUNTS: { id: string; type: string; owner: string; mask: string }[] = [
  { id: "fa_chk",     type: "checking",   owner: "u1", mask: "1111" },
  { id: "fa_hysa",    type: "savings",    owner: "u1", mask: "2222" },
  { id: "fa_amexchk", type: "checking",   owner: "u1", mask: "3333" },
  { id: "fa_schwab",  type: "checking",   owner: "u1", mask: "4444" },
  { id: "fa_card",    type: "debt",       owner: "u1", mask: "5555" },
  { id: "fa_amexcard",type: "debt",       owner: "u1", mask: "6666" },
  { id: "fa_sav2",    type: "savings",    owner: "u1", mask: "7777" },
  { id: "fa_broker",  type: "investment", owner: "u1", mask: "8888" },
  { id: "fa_u2sav",   type: "savings",    owner: "u2", mask: "9999" },
  { id: "fa_u2chk",   type: "checking",   owner: "u2", mask: "9990" },
];

type Seed = {
  id: string; acct: string; day: string; amount: number;
  flowType: string; category: string; pfcPrimary?: string | null; pfcDetailed?: string | null;
  pending?: boolean; plaidTransactionId?: string; pendingTransactionRef?: string;
  categorySource?: string | null; reason?: string; confidence?: number;
};

function classifierRow(s: Seed) {
  const date = new Date(`${s.day}T00:00:00.000Z`);
  return {
    id: s.id, financialAccountId: s.acct, date, economicDate: date,
    amount: s.amount, currency: "USD",
    merchant: s.id.startsWith("s1") || s.id.startsWith("s9") ? "AMERICANEXPRESS CO" : `M ${s.id}`,
    description: s.id.startsWith("s1") || s.id.startsWith("s9")
      ? "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER" : `D ${s.id}`,
    category: s.category, flowType: s.flowType,
    flowDirection: s.flowType === "DEBT_PAYMENT" ? (s.amount < 0 ? "INTERNAL" : "INFLOW")
      : s.flowType === "TRANSFER" ? "INTERNAL" : s.amount < 0 ? "OUTFLOW" : "INFLOW",
    flowAuthority: "CLASSIFIER", classifierVersion: 5,
    classificationReason: s.reason ?? "PLAID_PFC_PRIMARY", classificationConfidence: s.confidence ?? 0.8,
    pfcPrimary: s.pfcPrimary ?? null, pfcDetailed: s.pfcDetailed ?? null,
    pending: s.pending ?? false, settlementState: s.pending ? "PENDING" : "POSTED",
    plaidTransactionId: s.plaidTransactionId ?? `plaid_${s.id}`,
    pendingTransactionRef: s.pendingTransactionRef ?? null,
    categorySource: s.categorySource ?? "PLAID_PFC",
  };
}

const LP = "LOAN_PAYMENTS";
const OTHER = "LOAN_PAYMENTS_OTHER_PAYMENT";
const CC = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const SEEDS: Seed[] = [
  // S1 Amex HYSA
  { id: "s1_out", acct: "fa_chk",  day: "2026-01-05", amount: -1000, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s1_in",  acct: "fa_hysa", day: "2026-01-06", amount: 1000,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // S13 coincidence: same amount, same day, ordinary purchase.
  { id: "s13_buy", acct: "fa_chk", day: "2026-01-05", amount: -1000, flowType: "SPENDING", category: "Shopping", pfcPrimary: "GENERAL_MERCHANDISE", pfcDetailed: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE" },
  // S2 Amex checking
  { id: "s2_out", acct: "fa_chk",     day: "2026-02-05", amount: -747.26, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s2_in",  acct: "fa_amexchk", day: "2026-02-05", amount: 747.26,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // S3 Schwab
  { id: "s3_out", acct: "fa_chk",    day: "2026-03-05", amount: -1500, flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
  { id: "s3_in",  acct: "fa_schwab", day: "2026-03-05", amount: 1500,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // S4 Chase card payment
  { id: "s4_out", acct: "fa_chk",  day: "2026-04-05", amount: -300, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: CC },
  { id: "s4_in",  acct: "fa_card", day: "2026-04-05", amount: 300,  flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: CC },
  // S5 ambiguous: a savings and a card candidate of equal amount
  { id: "s5_out",  acct: "fa_chk",      day: "2026-05-05", amount: -432.10, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s5_sav",  acct: "fa_sav2",     day: "2026-05-06", amount: 432.10,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  { id: "s5_card", acct: "fa_amexcard", day: "2026-05-06", amount: 432.10,  flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: CC },
  // S6 unpaired credit-card payment
  { id: "s6_out", acct: "fa_chk", day: "2026-06-05", amount: -88.88, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: CC },
  // S7 unpaired OTHER_PAYMENT
  { id: "s7_out", acct: "fa_chk", day: "2026-07-05", amount: -1234.56, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  // S8 USER_OVERRIDE
  { id: "s8_out", acct: "fa_chk",  day: "2026-08-05", amount: -2000, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER, categorySource: "USER_OVERRIDE", reason: "CATEGORY_FLOW_VALUE", confidence: 1 },
  { id: "s8_in",  acct: "fa_hysa", day: "2026-08-05", amount: 2000,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // S9 pending → posted
  { id: "s9_pend", acct: "fa_chk",  day: "2026-09-05", amount: -125.41, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER, pending: true, plaidTransactionId: "p_s9_pending" },
  { id: "s9_post", acct: "fa_chk",  day: "2026-09-06", amount: -125.41, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER, pendingTransactionRef: "p_s9_pending" },
  { id: "s9_in",   acct: "fa_hysa", day: "2026-09-06", amount: 125.41,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // S10 reversal
  { id: "s10_back", acct: "fa_chk",  day: "2026-10-05", amount: 650,  flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s10_out",  acct: "fa_hysa", day: "2026-10-05", amount: -650, flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
  // S11 cross-owner
  { id: "s11_out", acct: "fa_chk",   day: "2026-11-05", amount: -777, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s11_in",  acct: "fa_u2sav", day: "2026-11-05", amount: 777,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
  // u2's own unrelated card payment — puts u2's account graph in the authority's
  // scope, which is what lets it SEE (and name) the cross-owner boundary. The
  // read path gathers by the owners of its targets, exactly like this.
  { id: "s11_u2", acct: "fa_u2chk", day: "2026-11-25", amount: -55.55, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: CC },
  // S12 brokerage
  { id: "s12_out", acct: "fa_chk",    day: "2026-12-05", amount: -5000, flowType: "DEBT_PAYMENT", category: "Payment", pfcPrimary: LP, pfcDetailed: OTHER },
  { id: "s12_in",  acct: "fa_broker", day: "2026-12-05", amount: 5000,  flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" },
];

function buildWorld(): { fake: FakePrisma; client: CorrectionClient } {
  const fake = new FakePrisma();
  fake.seed("Space", { id: SPACE, name: "Mine" });
  for (const a of ACCOUNTS) {
    fake.seed("FinancialAccount", {
      id: a.id, ownerType: "USER", ownerUserId: a.owner, name: `acct ${a.id}`, type: a.type,
      institution: "Bank", mask: a.mask, currency: "USD",
    });
    if (a.owner === "u1") {
      fake.seed("SpaceAccountLink", { spaceId: SPACE, financialAccountId: a.id, kind: "HOME", visibilityLevel: "FULL", status: "ACTIVE" });
    }
  }
  for (const s of SEEDS) fake.seed("Transaction", classifierRow(s));
  const client = { ...fake.txClient(), $transaction: (a: unknown) => fake.transaction(a) } as unknown as CorrectionClient;
  return { fake, client };
}

const row = (fake: FakePrisma, id: string) => fake.one("Transaction", { id }) as Record<string, unknown>;

// ── The product's money totals, computed by the real authorities ─────────────

async function moneyTotals(fake: FakePrisma, client: CorrectionClient) {
  const live = fake.rows("Transaction", { deletedAt: null }) as Record<string, unknown>[];
  const assess = await resolveTransferAssessments(client as never, live as never, { spaceId: SPACE });
  const ctx = tierResolver(ACCOUNTS.map((a) => ({ id: a.id, type: a.type })));
  const settled = live.filter((r) => !r.pending);
  const lrows = settled.map((r) => {
    const a = assess.get(r.id as string);
    return {
      id: r.id, accountId: r.financialAccountId, financialAccountId: r.financialAccountId,
      amount: r.amount, flowType: r.flowType, flowDirection: r.flowDirection, category: r.category,
      date: (r.date as Date).toISOString().slice(0, 10),
      counterpartyAccountId: (r.counterpartyAccountId as string | null) ?? a?.counterpartyAccountId ?? null,
      transferMaturity: a?.maturity ?? null,
    } as unknown as LiquidityTx;
  });
  const eco = economicTotals(lrows as unknown as Transaction[]);
  const byReason: Record<string, number> = {};
  let cashIn = 0, cashOut = 0;
  for (const r of lrows) {
    const c = classifyLiquidity(r, ctx);
    byReason[`${c.effect}:${c.reason}`] = Math.round(((byReason[`${c.effect}:${c.reason}`] ?? 0) + Math.abs(r.amount)) * 100) / 100;
    if (c.effect === "CASH_IN") cashIn += Math.abs(r.amount);
    if (c.effect === "CASH_OUT") cashOut += Math.abs(r.amount);
  }
  const debt = selectDebtPaymentCashLegs(lrows, ctx);
  const service = computeDebtService(lrows, ctx, (r) => r.amount);
  return {
    income: eco.income, spend: eco.spend, net: eco.net,
    cashIn: Math.round(cashIn * 100) / 100, cashOut: Math.round(cashOut * 100) / 100,
    debtPaymentCount: debt.counted.length,
    debtPaymentTotal: Math.round(debt.counted.reduce((n, r) => n + Math.abs(r.amount), 0) * 100) / 100,
    debtPaymentIds: debt.counted.map((r) => r.id).sort(),
    netPaydown: service.netPaydown,
    byReason,
  };
}

async function main(): Promise<void> {

console.log("1. the pure rule");
{
  const base: CorrectionInput = {
    ownAccountType: "checking", flowType: "DEBT_PAYMENT", flowAuthority: "CLASSIFIER",
    rowCategorySource: "PLAID_PFC", category: "Payment", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: OTHER,
    classificationReason: "PLAID_PFC_PRIMARY", classificationConfidence: 0.8,
    deleted: false, supersededByPosted: false, persistedCounterpartyAccountType: null,
    assessment: { evidenceLevel: "ACCOUNT_CERTAIN", maturity: "SAVINGS_TRANSFER" },
  };
  const d = (over: Partial<CorrectionInput>) => decideTransferDebtPaymentCorrection({ ...base, ...over });
  const w = d({});
  check("paired to owned savings ⇒ TRANSFER_CERTAIN", w.action === "WRITE" && w.kind === "TRANSFER_CERTAIN");
  check("…writes the registered TRANSFER|ACCOUNT_TYPE_CONTEXT|1 signature",
    w.action === "WRITE" && w.write.flowType === "TRANSFER" && w.write.category === "Transfer"
    && w.write.classificationReason === "ACCOUNT_TYPE_CONTEXT" && w.write.classificationConfidence === 1);
  for (const lvl of ["PROVIDER_LINKED", "ACCOUNT_CERTAIN_LEG_AMBIGUOUS", "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS"]) {
    const x = d({ assessment: { evidenceLevel: lvl, maturity: "CASH_TRANSFER" } });
    check(`${lvl} + CASH_TRANSFER ⇒ TRANSFER_CERTAIN`, x.action === "WRITE" && x.kind === "TRANSFER_CERTAIN");
  }
  for (const m of ["INVESTMENT_TRANSFER", "INTERNAL_TRANSFER"]) {
    const x = d({ assessment: { evidenceLevel: "ACCOUNT_CERTAIN", maturity: m } });
    check(`${m} is a transfer leaf`, x.action === "WRITE" && x.kind === "TRANSFER_CERTAIN");
  }
  const liab = d({ assessment: { evidenceLevel: "ACCOUNT_CERTAIN", maturity: "DEBT_PAYMENT" } });
  check("liability counterparty ⇒ KEEP DEBT_PAYMENT", liab.action === "KEEP" && liab.code === "LIABILITY_COUNTERPARTY");
  const amb = d({ assessment: { evidenceLevel: "TYPE_AMBIGUOUS", maturity: "UNRESOLVED_TRANSFER" } });
  check("TYPE_AMBIGUOUS ⇒ TRANSFER @0.2 (R1 precedent)",
    amb.action === "WRITE" && amb.kind === "TRANSFER_UNRESOLVED" && amb.write.classificationConfidence === 0.2
    && amb.write.classificationReason === "AMBIGUOUS_UNKNOWN");
  const unpairedCc = d({ pfcDetailed: CC, assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNRESOLVED_TRANSFER" } });
  check("unpaired + CREDIT_CARD_PAYMENT ⇒ KEEP", unpairedCc.action === "KEEP" && unpairedCc.code === "LIABILITY_EVIDENCE");
  for (const det of ["LOAN_PAYMENTS_MORTGAGE_PAYMENT", "LOAN_PAYMENTS_CAR_PAYMENT", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT"]) {
    const x = d({ pfcDetailed: det, assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNRESOLVED_TRANSFER" } });
    check(`unpaired + ${det} ⇒ KEEP (provider named a liability)`, x.action === "KEEP");
  }
  const unpairedOther = d({ assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNRESOLVED_TRANSFER" } });
  check("unpaired + OTHER_PAYMENT ⇒ TRANSFER @0.2", unpairedOther.action === "WRITE" && unpairedOther.kind === "TRANSFER_UNRESOLVED");
  const ext = d({ assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "EXTERNAL_DEPOSITORY_TRANSFER" } });
  check("unpaired external leaf ⇒ TRANSFER @0.2, never silently asserted", ext.action === "WRITE" && ext.kind === "TRANSFER_UNRESOLVED");
  const xo = d({ assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNRESOLVED_TRANSFER", unresolvedReason: "CROSS_OWNER_BOUNDARY" } });
  check("cross-owner boundary ⇒ untouched", xo.action === "SKIP" && xo.code === "CROSS_OWNER_BOUNDARY");
  const cash = d({ assessment: { evidenceLevel: "CASH_NO_COUNTERPARTY", maturity: "CASH_MOVEMENT" } });
  check("cash movement ⇒ untouched", cash.action === "SKIP");
  check("USER_OVERRIDE wins", d({ rowCategorySource: "USER_OVERRIDE" }).action === "SKIP");
  check("USER_RULE wins", d({ rowCategorySource: "USER_RULE" }).action === "SKIP");
  check("a liability own account is never touched", d({ ownAccountType: "debt" }).action === "SKIP");
  check("investment own account is never touched", d({ ownAccountType: "investment" }).action === "SKIP");
  check("a non-provider DEBT_PAYMENT (no LOAN_PAYMENTS, not Payment) is untouched",
    (() => { const x = d({ pfcPrimary: null, category: "Other" }); return x.action === "SKIP" && x.code === "NO_PROVIDER_PROVENANCE"; })());
  check("the `Payment` category alone is provenance (no PFC)", d({ pfcPrimary: null }).action === "WRITE");
  check("TRANSFER_AUTHORITY's other DEBT_PAYMENT writes are not re-opened", d({ flowAuthority: "TRANSFER_AUTHORITY" }).action === "SKIP");
  check("a superseded pending row retires", (() => { const x = d({ supersededByPosted: true }); return x.action === "SKIP" && x.code === "PENDING_SUPERSEDED"; })());
  check("a persisted liability counterparty ⇒ KEEP", d({ persistedCounterpartyAccountType: "debt" }).action === "KEEP");
  check("deleted ⇒ untouched", d({ deleted: true }).action === "SKIP");
  // (B) — this rule's own low-confidence write, re-opened only to SETTLE it.
  const own = { ...base, flowType: "TRANSFER", flowAuthority: "TRANSFER_AUTHORITY", category: "Transfer",
    classificationReason: "AMBIGUOUS_UNKNOWN", classificationConfidence: 0.2 };
  const up = decideTransferDebtPaymentCorrection(own);
  check("(B) own unresolved write + now-certain savings ⇒ upgraded to TRANSFER_CERTAIN", up.action === "WRITE" && up.arm === "B" && up.kind === "TRANSFER_CERTAIN");
  const back = decideTransferDebtPaymentCorrection({ ...own, assessment: { evidenceLevel: "ACCOUNT_CERTAIN", maturity: "DEBT_PAYMENT" } });
  check("(B) own unresolved write + now-certain liability ⇒ DEBT_PAYMENT restored", back.action === "WRITE" && back.kind === "DEBT_PAYMENT_RESTORED");
  const still = decideTransferDebtPaymentCorrection({ ...own, assessment: { evidenceLevel: "NO_DESTINATION_EVIDENCE", maturity: "UNRESOLVED_TRANSFER" } });
  check("(B) still unsettled ⇒ nothing new to write (idempotent)", still.action === "SKIP" && still.code === "NOT_YET_SETTLED");
  const r1 = decideTransferDebtPaymentCorrection({ ...own, category: "Payment" });
  check("(B) the L4-REPAIR-3 R1 rows (category kept Payment) are NOT re-opened", r1.action === "SKIP" && r1.code === "NOT_ELIGIBLE_FLOW");
}

console.log("2. the read-time resolved nature");
{
  check("DEBT_PAYMENT + SAVINGS_TRANSFER ⇒ TRANSFER", resolvedFlowType("DEBT_PAYMENT", "SAVINGS_TRANSFER") === "TRANSFER");
  check("DEBT_PAYMENT + DEBT_PAYMENT ⇒ DEBT_PAYMENT", resolvedFlowType("DEBT_PAYMENT", "DEBT_PAYMENT") === "DEBT_PAYMENT");
  check("DEBT_PAYMENT + no maturity ⇒ DEBT_PAYMENT", resolvedFlowType("DEBT_PAYMENT", null) === "DEBT_PAYMENT");
  check("SPENDING is never re-read", resolvedFlowType("SPENDING", "SAVINGS_TRANSFER") === "SPENDING");
  check("Payment on a resolved transfer reads Transfer", resolvedCategory("Payment", "DEBT_PAYMENT", "CASH_TRANSFER") === "Transfer");
  check("Payment on a real card payment stays Payment", resolvedCategory("Payment", "DEBT_PAYMENT", "DEBT_PAYMENT") === "Payment");
  check("any other category is unchanged", resolvedCategory("Dining", "DEBT_PAYMENT", "SAVINGS_TRANSFER") === "Dining");
}

console.log("3. classifyFlow stays institution- and descriptor-blind (purity probe)");
{
  const input = { category: "Payment", amount: -1000, accountType: "checking", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: OTHER } as Parameters<typeof classifyFlow>[0];
  const a = classifyFlow(input);
  const b = classifyFlow({ ...input, merchant: "AMERICANEXPRESS CO", description: "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER" } as never);
  const c = classifyFlow({ ...input, merchant: "Totally Different Bank", description: "SOMETHING ELSE" } as never);
  check("the classifier still says DEBT_PAYMENT for the context-free row (the fix is NOT here)", a.flowType === "DEBT_PAYMENT");
  check("descriptor/institution text changes nothing", JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(c));
}

console.log("4. plan over the fixture — the real transfer authority decides");
const { fake, client } = buildWorld();
const before = await moneyTotals(fake, client);
const depIds = ACCOUNTS.filter((a) => a.type === "checking" || a.type === "savings").map((a) => a.id);
// ⚠️ Cross-owner DETECTION needs the other owner's graph in scope (above). When it
// is not, the authority sees an unpaired leg and the rule writes TRANSFER @0.2 +
// needsClassification — never a silent assertion either way.
const candidates = await loadCorrectionCandidates(client, candidateWhere(depIds));
const plan = await planTransferDebtPaymentCorrections(client, candidates);
const kindOf = new Map(plan.writes.map((p) => [p.row.id, p]));
{
  check("S1 Amex HYSA leg ⇒ TRANSFER_CERTAIN / SAVINGS_TRANSFER",
    kindOf.get("s1_out")?.kind === "TRANSFER_CERTAIN" && kindOf.get("s1_out")?.maturity === "SAVINGS_TRANSFER",
    JSON.stringify(kindOf.get("s1_out") && { k: kindOf.get("s1_out")!.kind, m: kindOf.get("s1_out")!.maturity, e: kindOf.get("s1_out")!.evidenceLevel }));
  check("S2 Amex checking leg ⇒ TRANSFER_CERTAIN / CASH_TRANSFER",
    kindOf.get("s2_out")?.kind === "TRANSFER_CERTAIN" && kindOf.get("s2_out")?.maturity === "CASH_TRANSFER");
  check("S3 Schwab transfer is not a candidate (already TRANSFER)", !candidates.some((c) => c.id.startsWith("s3")));
  check("S4 Chase card payment cash leg is KEPT", !kindOf.has("s4_out"));
  check("S5 savings/card ambiguity ⇒ TRANSFER_UNRESOLVED @0.2",
    kindOf.get("s5_out")?.kind === "TRANSFER_UNRESOLVED" && kindOf.get("s5_out")?.evidenceLevel === "TYPE_AMBIGUOUS",
    JSON.stringify(kindOf.get("s5_out")?.evidenceLevel));
  check("S6 unpaired CREDIT_CARD_PAYMENT is KEPT", !kindOf.has("s6_out"));
  check("S7 unpaired OTHER_PAYMENT ⇒ TRANSFER_UNRESOLVED", kindOf.get("s7_out")?.kind === "TRANSFER_UNRESOLVED");
  check("S8 USER_OVERRIDE untouched", !kindOf.has("s8_out"));
  check("S9 posted twin corrected", kindOf.get("s9_post")?.kind === "TRANSFER_CERTAIN",
    JSON.stringify(kindOf.get("s9_post")?.evidenceLevel));
  check("S9 pending twin retires — never rewritten", !kindOf.has("s9_pend") && plan.retiringPending.some((c) => c.id === "s9_pend"));
  check("S10 reversal ⇒ TRANSFER", kindOf.get("s10_back")?.kind === "TRANSFER_CERTAIN");
  check("S11 cross-owner untouched", !kindOf.has("s11_out") && (plan.untouched.CROSS_OWNER_BOUNDARY ?? 0) >= 1);
  check("S12 checking → brokerage ⇒ INVESTMENT_TRANSFER", kindOf.get("s12_out")?.maturity === "INVESTMENT_TRANSFER");
  check("S13 the same-amount purchase is never selected", !candidates.some((c) => c.id === "s13_buy"));
  check("liability-side legs are never written", !kindOf.has("s4_in") && !kindOf.has("s5_card"));
  check("exactly the expected write set",
    [...kindOf.keys()].sort().join(",") === ["s10_back", "s12_out", "s1_out", "s2_out", "s5_out", "s7_out", "s9_post"].sort().join(","),
    [...kindOf.keys()].sort().join(","));
  check("planning wrote nothing", row(fake, "s1_out").flowType === "DEBT_PAYMENT");
}

console.log("5. apply — TRANSFER_AUTHORITY owns the row, nothing else moves");
{
  const snapshot = new Map(SEEDS.map((s) => [s.id, { ...row(fake, s.id) }]));
  const res = await applyTransferDebtPaymentCorrections(client, plan.writes);
  check("every planned row written, no conflicts", res.written === plan.writes.length && res.conflicts.length === 0, JSON.stringify(res));
  const r = row(fake, "s1_out");
  check("flowType TRANSFER", r.flowType === "TRANSFER");
  check("category Transfer", r.category === "Transfer");
  check("flowAuthority TRANSFER_AUTHORITY", r.flowAuthority === "TRANSFER_AUTHORITY");
  check("classifierVersion nulled (no false classifier claim)", r.classifierVersion === null);
  check("amount, date, direction, counterparty, PFC untouched",
    r.amount === -1000 && (r.date as Date).toISOString().startsWith("2026-01-05") && r.flowDirection === "INTERNAL"
    && r.counterpartyAccountId == null && r.pfcPrimary === LP && r.pfcDetailed === OTHER);
  check("categorySource is not stamped by this writer", r.categorySource === "PLAID_PFC");
  const s7 = row(fake, "s7_out");
  check("S7 written at the low-confidence signature", s7.flowType === "TRANSFER" && s7.classificationReason === "AMBIGUOUS_UNKNOWN" && s7.classificationConfidence === 0.2);
  check("S7 now surfaces needsClassification", shouldSurfaceAsNeedsClassification({
    flowType: s7.flowType as string, classificationReason: s7.classificationReason as string,
    transferRail: null, hasResolvedMerchant: false, hasResolvedCounterparty: false,
  }).needsClassification === true);
  check("…and a corrected CERTAIN row does not", !shouldSurfaceAsNeedsClassification({
    flowType: "TRANSFER", classificationReason: "ACCOUNT_TYPE_CONTEXT", transferRail: null,
    hasResolvedMerchant: false, hasResolvedCounterparty: false,
  }).needsClassification);
  const untouched = ["s11_u2", "s1_in", "s3_out", "s3_in", "s4_out", "s4_in", "s5_sav", "s5_card", "s6_out", "s8_out", "s8_in", "s9_pend", "s11_out", "s13_buy"];
  check("every other row is byte-identical", untouched.every((id) => JSON.stringify(row(fake, id)) === JSON.stringify(snapshot.get(id))),
    untouched.filter((id) => JSON.stringify(row(fake, id)) !== JSON.stringify(snapshot.get(id))).join(","));
  check("S8 USER_OVERRIDE still DEBT_PAYMENT/Payment", row(fake, "s8_out").flowType === "DEBT_PAYMENT" && row(fake, "s8_out").category === "Payment");
  check("no row created or deleted (no duplicate)", fake.rows("Transaction").length === SEEDS.length
    && fake.rows("Transaction", { deletedAt: null }).length === SEEDS.length);
}

console.log("6. money totals are IDENTICAL before vs after");
{
  const after = await moneyTotals(fake, client);
  check("income identical", after.income === before.income, `${before.income} → ${after.income}`);
  check("spending identical", after.spend === before.spend, `${before.spend} → ${after.spend}`);
  check("net cash flow identical", after.net === before.net);
  check("Cash In / Cash Out identical", after.cashIn === before.cashIn && after.cashOut === before.cashOut,
    `${before.cashIn}/${before.cashOut} → ${after.cashIn}/${after.cashOut}`);
  check("liquidity reasons identical", JSON.stringify(after.byReason) === JSON.stringify(before.byReason),
    `${JSON.stringify(before.byReason)} → ${JSON.stringify(after.byReason)}`);
  check("debt payments identical (count + total)", after.debtPaymentCount === before.debtPaymentCount && after.debtPaymentTotal === before.debtPaymentTotal);
  check("debt-service netPaydown identical", after.netPaydown === before.netPaydown);
  check("Chase card payment counted ONCE — the cash leg only (no double count with the card leg)",
    JSON.stringify(after.debtPaymentIds) === JSON.stringify(["s4_out"]) && after.debtPaymentTotal === 300,
    JSON.stringify(after.debtPaymentIds));
}

console.log("7. idempotent — a second pass proposes nothing");
{
  const again = await planTransferDebtPaymentCorrections(client, await loadCorrectionCandidates(client, candidateWhere(depIds)));
  check("second plan = 0 writes", again.writes.length === 0, again.writes.map((w) => w.row.id).join(","));
  const res = await applyTransferDebtPaymentCorrections(client, plan.writes);
  check("replaying the OLD plan writes 0 rows (BEFORE-shape guard)", res.written === 0 && res.conflicts.length === plan.writes.length);
}

console.log("8. (B) a far leg arriving later settles the unresolved row");
{
  // S7's savings leg arrives on a later sync of another Item.
  fake.seed("Transaction", classifierRow({ id: "s7_in", acct: "fa_sav2", day: "2026-07-06", amount: 1234.56, flowType: "TRANSFER", category: "Transfer", pfcPrimary: "TRANSFER_IN", pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }));
  const res = await correctTransferDebtPaymentsAfterSync(client, ["s7_in"]);
  const s7 = row(fake, "s7_out");
  check("sync-time pass re-opened the row this rule left unresolved", res.written === 1, JSON.stringify(res));
  check("…and upgraded it to the certain signature", s7.flowType === "TRANSFER" && s7.classificationReason === "ACCOUNT_TYPE_CONTEXT" && s7.classificationConfidence === 1);
}

console.log("9. sync-time seam corrects only what the sync touched");
{
  const w = buildWorld();
  const res = await correctTransferDebtPaymentsAfterSync(w.client, ["s1_out", "s1_in", "s4_out", "s4_in"]);
  check("touched S1 corrected, S4 kept", res.written === 1 && row(w.fake, "s1_out").flowType === "TRANSFER" && row(w.fake, "s4_out").flowType === "DEBT_PAYMENT");
  check("untouched S2 left for the repair", row(w.fake, "s2_out").flowType === "DEBT_PAYMENT");
  const none = await correctTransferDebtPaymentsAfterSync(w.client, []);
  check("no touched rows ⇒ no work", none.planned === 0 && none.written === 0);
}

console.log("10. AI transferTotal counts the resolved legs (monthly fold)");
{
  const w = buildWorld();
  const live = w.fake.rows("Transaction", { deletedAt: null }) as Record<string, unknown>[];
  const assess = await resolveTransferAssessments(w.client as never, live as never, { spaceId: SPACE });
  const jan = live.filter((r) => (r.date as Date).toISOString().startsWith("2026-01") && !r.pending) as never[];
  const resolvedIds = new Set((jan as Record<string, unknown>[])
    .filter((r) => r.flowType === "DEBT_PAYMENT" && ["SAVINGS_TRANSFER", "CASH_TRANSFER", "INVESTMENT_TRANSFER", "INTERNAL_TRANSFER"].includes(assess.get(r.id as string)?.maturity ?? ""))
    .map((r) => r.id as string));
  const withFix = buildMonthlyBreakdown(jan, [], "2026-01-01", "2026-01-31", null, undefined, { debtCountedIds: new Set(), transferResolvedIds: resolvedIds });
  const withoutFix = buildMonthlyBreakdown(jan, [], "2026-01-01", "2026-01-31", null, undefined, { debtCountedIds: new Set() });
  const jan1 = withFix.find((m) => m.month === "2026-01");
  const jan0 = withoutFix.find((m) => m.month === "2026-01");
  check("the HYSA leg is a resolved transfer", resolvedIds.has("s1_out"));
  check("transferTotal includes it (both legs, as for any internal transfer)", jan1?.transferTotal === 2000, String(jan1?.transferTotal));
  check("…where before it was silently dropped", jan0?.transferTotal === 1000, String(jan0?.transferTotal));
  check("spending is unchanged by it", jan1?.expenseTotal === jan0?.expenseTotal);
}

console.log("11. Brief recent activity sends the resolved nature");
{
  const mk = (over: Partial<Transaction>): Transaction => ({
    id: "t", accountId: "fa_chk", date: "2026-10-26", amount: -125.41, merchant: "AMERICANEXPRESS CO",
    category: "Payment", flowType: "DEBT_PAYMENT", pending: true, ...over,
  } as unknown as Transaction);
  const act = projectRecentActivity([
    mk({ id: "a", transferMaturity: "SAVINGS_TRANSFER", counterpartyAccountId: "fa_hysa" } as never),
    mk({ id: "b", amount: -300, merchant: "PAYMENT TO CHASE CARD", transferMaturity: "DEBT_PAYMENT", counterpartyAccountId: "fa_card" } as never),
  ], { from: "2026-10-20", to: "2026-10-26" }, true, (id) => ACCOUNTS.find((a) => a.id === id)?.type);
  const hysa = act.top.find((r) => r.amount === -125.41)!;
  const card = act.top.find((r) => r.amount === -300)!;
  check("a SAVINGS_TRANSFER row is never sent as DEBT_PAYMENT", hysa.flow === "TRANSFER", hysa.flow);
  check("…and its category reads Transfer", hysa.category === "Transfer");
  check("…and the other side is named LIQUID", hysa.otherLegAccount === "LIQUID");
  check("a real card payment is still DEBT_PAYMENT", card.flow === "DEBT_PAYMENT" && card.category === "Payment" && card.otherLegAccount === undefined);

  // classesTouched — the contract guard. Citing the DEBT balance beside the
  // savings transfer is an unconnected association; beside the card payment it
  // is not.
  const pkg = basePackage();
  pkg.recentActivity = act;
  const iHysa = act.top.indexOf(hysa), iCard = act.top.indexOf(card);
  const ob = (i: number, balance: string) => ({ title: "t", body: "b", importance: "CONTEXT", evidence: [balance, `recentActivity.top.${i}`] }) as never;
  check("a SAVINGS_TRANSFER row touches no LIABILITY (debt + savings transfer = unconnected)",
    associatesUnconnectedMovement(ob(iHysa, "currentState.debt"), pkg) === true);
  check("…but it does touch LIQUID", associatesUnconnectedMovement(ob(iHysa, "currentState.liquid"), pkg) === false);
  check("a real card payment still touches LIABILITY", associatesUnconnectedMovement(ob(iCard, "currentState.debt"), pkg) === false);
}

console.log(`\ntransfer-debt-payment-correction: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

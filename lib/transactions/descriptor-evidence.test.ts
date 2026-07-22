/**
 * lib/transactions/descriptor-evidence.test.ts
 *
 * SR-2 / SR-6 — the descriptor-evidence resolver + the doctrine it enforces,
 * tested at the CLASSIFICATION LAYER (descriptor/category evidence → flowType),
 * which the aggregation-level doctrine oracle deliberately starts too late to
 * cover. Pure, dependency-free, runnable with tsx:
 *
 *     npx tsx lib/transactions/descriptor-evidence.test.ts
 *
 * The chain under test is the REAL one every ingest seam runs per row:
 *   descriptor evidence
 *     → resolveLiabilityPaymentCategory   (card-payment rescue, Other → Payment)
 *     → resolvePayrollIncomeCategory      (payroll rescue,       Other → Income)
 *     → classifyFlow                      (descriptor-blind economics)
 * so a fixture proves the whole "provider evidence → economic kind" path, not a
 * reproduction of it.
 */

import {
  resolvePayrollIncomeCategory,
  isPayrollIncomeDescriptor,
} from "./descriptor-evidence";
import { resolveLiabilityPaymentCategory } from "./liability-payment";
import { classifyFlow, type FlowType } from "./flow-classifier";
import {
  buildFlowInputFromRow,
  buildFlowWriteFields,
  withDescriptorEvidenceReason,
} from "./plaid-flow-input";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// The exact per-row sequence the Plaid sync + CSV import seams run (see
// lib/plaid/syncTransactions.ts and app/api/accounts/[id]/import/route.ts).
interface Row {
  category:    string;
  amount:      number;
  merchant:    string | null;
  description: string | null;
  accountType?: string | null;
  debtSubtype?: string | null;
  pfcPrimary?: string | null;
  pfcDetailed?: string | null;
}

function resolveCategory(r: Row): string {
  const acct = { accountType: r.accountType ?? null, debtSubtype: r.debtSubtype ?? null };
  const afterPayment = resolveLiabilityPaymentCategory(r.category, "Payment", {
    ...acct, amount: r.amount, merchant: r.merchant, description: r.description,
  });
  return resolvePayrollIncomeCategory(afterPayment, "Income", {
    amount: r.amount, merchant: r.merchant, description: r.description,
  });
}

function flowOf(r: Row): FlowType {
  const category = resolveCategory(r);
  return classifyFlow({
    category,
    amount:      r.amount,
    accountType: r.accountType ?? null,
    debtSubtype: r.debtSubtype ?? null,
    pfcPrimary:  r.pfcPrimary ?? null,
    pfcDetailed: r.pfcDetailed ?? null,
  }).flowType;
}

// ─────────────────────────────────────────────────────────────────────────────
// SR-6 Case 1 — pending payroll: NOT REFUND, INCOME after descriptor resolution
// ─────────────────────────────────────────────────────────────────────────────
{
  const pendingPayroll: Row = {
    category: "Other", amount: 5286.63,
    merchant: "VECTRUS SYSTEMS", description: "VECTRUS SYSTEMS CORP PAYROLL SEC:PPD",
    pfcPrimary: "OTHER", pfcDetailed: "OTHER_OTHER", accountType: "checking",
  };
  const category = resolveCategory(pendingPayroll);
  check("Case 1: pending payroll category rescued Other → Income", category === "Income", `got ${category}`);
  check("Case 1: pending payroll flow is INCOME, not REFUND", flowOf(pendingPayroll) === "INCOME", `got ${flowOf(pendingPayroll)}`);
  check("Case 1: pending payroll is never REFUND", flowOf(pendingPayroll) !== "REFUND");
}

// ─────────────────────────────────────────────────────────────────────────────
// SR-6 Case 2 — generic positive Other (no descriptor evidence): UNKNOWN, never REFUND
// ─────────────────────────────────────────────────────────────────────────────
{
  const genericInflow: Row = {
    category: "Other", amount: 250,
    merchant: "SOME COUNTERPARTY", description: "TRANSFER FROM UNKNOWN", accountType: "checking",
  };
  check("Case 2: generic positive Other category stays Other", resolveCategory(genericInflow) === "Other");
  check("Case 2: generic positive Other → UNKNOWN", flowOf(genericInflow) === "UNKNOWN", `got ${flowOf(genericInflow)}`);
  check("Case 2: generic positive Other is NEVER REFUND", flowOf(genericInflow) !== "REFUND");
}

// ─────────────────────────────────────────────────────────────────────────────
// SR-6 Case 3 — genuine merchant refund (Dining + positive): stays REFUND
// ─────────────────────────────────────────────────────────────────────────────
{
  const genuineRefund: Row = {
    category: "Dining", amount: 15,
    merchant: "SOME RESTAURANT", description: "REFUND", accountType: "checking",
  };
  check("Case 3: genuine Dining refund stays REFUND", flowOf(genuineRefund) === "REFUND", `got ${flowOf(genuineRefund)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SR-6 Case 4 — pending debt-payment leg (Other, positive, no LOAN_PAYMENT PFC): NOT REFUND
// ─────────────────────────────────────────────────────────────────────────────
{
  // A positive Other with NO card-payment descriptor and NO liability signal — an
  // ambiguous inflow. It must NOT fabricate a REFUND; UNKNOWN is the honest answer.
  const debtLeg: Row = {
    category: "Other", amount: 800,
    merchant: "BANK TRANSFER", description: "PAYMENT", accountType: "checking",
  };
  check("Case 4: pending debt-ish positive Other is NOT REFUND", flowOf(debtLeg) !== "REFUND", `got ${flowOf(debtLeg)}`);
  // And the real card-payment leg (liability + positive + payment descriptor) still
  // resolves to DEBT_PAYMENT via the untouched card-payment rescue — regression guard.
  const cardPaymentLeg: Row = {
    category: "Other", amount: 5000,
    merchant: "PAYMENT-THANK YOU", description: "PAYMENT-THANK YOU",
    accountType: "debt", debtSubtype: "credit_card",
  };
  check("Case 4: card-payment leg still resolves DEBT_PAYMENT (card rescue intact)",
    flowOf(cardPaymentLeg) === "DEBT_PAYMENT", `got ${flowOf(cardPaymentLeg)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SR-6 Case 5 — settlement invariance: pending vs posted of the SAME event agree
// ─────────────────────────────────────────────────────────────────────────────
{
  // Same economic event, two settlement snapshots. Pending arrives before Plaid
  // enriches it (Other / OTHER_OTHER); posted arrives with the INCOME PFC. Both
  // must land on the SAME economic kind — INCOME — never REFUND for one and
  // INCOME for the other. Pending is a settlement state, not an economic type.
  const pending: Row = {
    category: "Other", amount: 5286.63,
    merchant: "VECTRUS SYSTEMS", description: "VECTRUS SYSTEMS CORP PAYROLL",
    pfcPrimary: "OTHER", pfcDetailed: "OTHER_OTHER", accountType: "checking",
  };
  const posted: Row = {
    category: "Income", amount: 5286.63,
    merchant: "VECTRUS SYSTEMS", description: "VECTRUS SYSTEMS CORP PAYROLL",
    pfcPrimary: "INCOME", pfcDetailed: "INCOME_WAGES", accountType: "checking",
  };
  check("Case 5: pending payroll is INCOME", flowOf(pending) === "INCOME", `got ${flowOf(pending)}`);
  check("Case 5: posted payroll is INCOME", flowOf(posted) === "INCOME", `got ${flowOf(posted)}`);
  check("Case 5: settlement invariance — pending kind === posted kind", flowOf(pending) === flowOf(posted));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver unit contract (rescue-only, inflow-guarded, veto vocabulary)
// ─────────────────────────────────────────────────────────────────────────────

// Only acts on the Other sentinel — never downgrades / overrides a real category.
check("resolver never overrides a non-Other category",
  resolvePayrollIncomeCategory("Dining", "Income", { amount: 5000, merchant: "X PAYROLL", description: "PAYROLL" }) === "Dining");
check("resolver never overrides Income already set",
  resolvePayrollIncomeCategory("Income", "Income", { amount: 5000, merchant: "PAYROLL", description: "PAYROLL" }) === "Income");

// Inflow guard: a NEGATIVE amount carrying payroll text is never promoted.
check("resolver rejects outflow payroll text (inflow guard)",
  resolvePayrollIncomeCategory("Other", "Income", { amount: -5000, merchant: "PAYROLL", description: "PAYROLL DEDUCTION" }) === "Other");
check("resolver rejects zero amount",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 0, merchant: "PAYROLL", description: "PAYROLL" }) === "Other");

// Positive payroll credit promotes.
check("resolver promotes positive payroll credit",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 5000, merchant: "ACME", description: "ACME CORP PAYROLL" }) === "Income");
check("resolver promotes DIRECT DEP",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 5000, merchant: "", description: "DIRECT DEP" }) === "Income");
check("resolver promotes DIRECT DEPOSIT",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 5000, merchant: "", description: "COMPANY DIRECT DEPOSIT" }) === "Income");
check("resolver promotes SALARY",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 5000, merchant: "", description: "MONTHLY SALARY" }) === "Income");

// Veto vocabulary: a POSITIVE amount whose text is a deduction/tax reversal is NOT income.
check("resolver vetoes positive 'payroll deduction'",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 12, merchant: "", description: "PAYROLL DEDUCTION REFUND" }) === "Other");
check("resolver vetoes positive 'payroll tax'",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 12, merchant: "", description: "PAYROLL TAX ADJUSTMENT" }) === "Other");

// No descriptor evidence at all → no rescue.
check("resolver leaves a bare positive Other alone",
  resolvePayrollIncomeCategory("Other", "Income", { amount: 5000, merchant: "SOMEONE", description: "TRANSFER" }) === "Other");

// Word-boundary safety: 'salary' must be a WORD, not a substring accident.
check("isPayrollIncomeDescriptor is word-boundary (no substring false positive)",
  isPayrollIncomeDescriptor("SALARYMAN NOODLES", "SALARYMAN NOODLES BAR") === false);
check("isPayrollIncomeDescriptor matches a real payroll word",
  isPayrollIncomeDescriptor("ACME", "ACME CORP PAYROLL") === true);

// ─────────────────────────────────────────────────────────────────────────────
// SR-4 — DESCRIPTOR_EVIDENCE provenance is stamped by the WRITE LAYER, never the
// descriptor-blind classifier. classifyFlow still reports CATEGORY_FLOW_VALUE for
// the rescued `Income`; withDescriptorEvidenceReason overrides the persisted
// reason to DESCRIPTOR_EVIDENCE, recording that the resolver — not sign/category
// defaulting — decided the kind.
// ─────────────────────────────────────────────────────────────────────────────

// A descriptor-blind view of the rescued Income row: the classifier's own reason.
{
  const c = classifyFlow({ category: "Income", amount: 5286.63 });
  check("classifier stays descriptor-blind: rescued Income → CATEGORY_FLOW_VALUE (not DESCRIPTOR_EVIDENCE)",
    c.reason === "CATEGORY_FLOW_VALUE", `got ${c.reason}`);
}

// Build the persisted flow columns exactly as an ingest seam / the repair does,
// then apply the write-layer provenance stamp.
function writeFieldsFor(r: Row, descriptorRescued: boolean) {
  const { input, captured } = buildFlowInputFromRow(
    { category: descriptorRescued ? "Income" : r.category, amount: r.amount,
      pfcPrimary: r.pfcPrimary ?? null, pfcDetailed: r.pfcDetailed ?? null,
      pfcConfidenceLevel: null, merchantEntityId: null },
    { accountType: r.accountType ?? null, debtSubtype: r.debtSubtype ?? null },
  );
  return withDescriptorEvidenceReason(
    buildFlowWriteFields(classifyFlow(input), input, captured, 4),
    descriptorRescued,
  );
}

{
  const payroll: Row = { category: "Other", amount: 5286.63, merchant: "VECTRUS SYSTEMS",
    description: "VECTRUS SYSTEMS CORP PAYROLL SEC:PPD", accountType: "checking" };
  const rescued = resolveCategory(payroll) === "Income";
  check("payroll row rescues to Income", rescued);
  const wf = writeFieldsFor(payroll, rescued);
  check("SR-4: rescued payroll persists reason=DESCRIPTOR_EVIDENCE", wf.classificationReason === "DESCRIPTOR_EVIDENCE", `got ${wf.classificationReason}`);
  check("SR-4: rescued payroll persists flowType=INCOME", wf.flowType === "INCOME", `got ${wf.flowType}`);
  check("SR-4: rescued payroll persists classifierVersion=4", wf.classifierVersion === 4);
}

// No-op when nothing was descriptor-rescued: a native Income keeps its classifier reason.
{
  const nativeIncome: Row = { category: "Income", amount: 100, merchant: "X", description: "X", accountType: "checking" };
  const wf = writeFieldsFor(nativeIncome, false);
  check("SR-4: un-rescued Income keeps CATEGORY_FLOW_VALUE (stamp is a strict no-op)",
    wf.classificationReason === "CATEGORY_FLOW_VALUE", `got ${wf.classificationReason}`);
}

// A no-evidence positive Other is NOT descriptor-rescued → honest UNKNOWN, no stamp.
{
  const unknownInflow: Row = { category: "Other", amount: 250, merchant: "X", description: "INBOUND", accountType: "checking" };
  const rescued = resolveCategory(unknownInflow) === "Income";
  check("no-evidence positive Other is not rescued", rescued === false);
  const wf = writeFieldsFor(unknownInflow, rescued);
  check("SR-4: no-evidence positive Other persists UNKNOWN/AMBIGUOUS_UNKNOWN (never DESCRIPTOR_EVIDENCE)",
    wf.flowType === "UNKNOWN" && wf.classificationReason === "AMBIGUOUS_UNKNOWN",
    `got ${wf.flowType}/${wf.classificationReason}`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`descriptor-evidence: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`descriptor-evidence: all ${passed} checks passed ✓`);
console.log("  · SR-6 Cases 1–5 pass through the real rescue → classify chain");
process.exit(0);

/**
 * lib/transactions/plaid-flow-write.test.ts
 *
 * FlowType P3 Phase B — write-fields builder tests (pure, no DB). Standalone
 * `tsx` script, exit 0/1:
 *
 *     npx tsx lib/transactions/plaid-flow-write.test.ts
 *
 * Verifies buildFlowWriteFields() produces the exact Transaction flow columns
 * Phase B persists: identity enum mapping (runtime totality), counterparty null
 * by design, classifierVersion wiring, pfc/merchant pass-through, and the
 * all-null failure object. The COMPILE-time enum parity guard lives in
 * plaid-flow-input.ts (Record<classifierUnion, PrismaEnum>); this suite adds the
 * runtime coverage that every classifier value maps to a defined, equal string.
 */

import {
  buildFlowWriteFields,
  NULL_FLOW_WRITE_FIELDS,
  type CapturedPlaidMetadata,
} from "./plaid-flow-input";
import {
  classifyFlow,
  FLOW_CLASSIFIER_VERSION,
  type FlowClassification,
  type FlowType,
  type FlowDirection,
  type FlowReason,
} from "./flow-classifier";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const NO_META: CapturedPlaidMetadata = {
  pfcConfidenceLevel: null,
  merchantEntityId:   null,
  counterparties:     [],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Shape + wiring from a real classification
// ─────────────────────────────────────────────────────────────────────────────

{
  const input = {
    category: "Payment", amount: -300, accountType: "checking", debtSubtype: null,
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD",
  };
  const captured: CapturedPlaidMetadata = {
    pfcConfidenceLevel: "HIGH", merchantEntityId: "ent_chase", counterparties: [],
  };
  const classification = classifyFlow(input);
  const w = buildFlowWriteFields(classification, input, captured, FLOW_CLASSIFIER_VERSION);

  check("flowType wired", w.flowType === classification.flowType, `${w.flowType}`);
  check("flowDirection wired", w.flowDirection === classification.flowDirection);
  check("confidence wired", w.classificationConfidence === classification.confidence);
  check("reason wired", w.classificationReason === classification.reason);
  check("classifierVersion wired", w.classifierVersion === FLOW_CLASSIFIER_VERSION && w.classifierVersion === 1);
  check("counterpartyAccountId is null (Phase B)", w.counterpartyAccountId === null);
  check("pfcPrimary pass-through", w.pfcPrimary === "LOAN_PAYMENTS");
  check("pfcDetailed pass-through", w.pfcDetailed === "LOAN_PAYMENTS_CREDIT_CARD");
  check("pfcConfidenceLevel from captured", w.pfcConfidenceLevel === "HIGH");
  check("merchantEntityId from captured", w.merchantEntityId === "ent_chase");
  check("exactly 10 keys", Object.keys(w).length === 10, `${Object.keys(w).length}`);
}

// pfc fields null when Plaid supplied none
{
  const input = { category: "Dining", amount: -20, pfcPrimary: null, pfcDetailed: null };
  const w = buildFlowWriteFields(classifyFlow(input), input, NO_META, FLOW_CLASSIFIER_VERSION);
  check("null pfc → null columns", w.pfcPrimary === null && w.pfcDetailed === null && w.pfcConfidenceLevel === null);
  check("null merchant entity", w.merchantEntityId === null);
  check("flowType still defined", w.flowType === "SPENDING");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Runtime enum-map totality — every classifier value maps to an equal string
// ─────────────────────────────────────────────────────────────────────────────

const ALL_FLOW_TYPES: FlowType[] = [
  "SPENDING", "INCOME", "REFUND", "DEBT_PAYMENT", "TRANSFER",
  "INVESTMENT", "FEE", "INTEREST", "ADJUSTMENT", "UNKNOWN",
];
const ALL_DIRECTIONS: FlowDirection[] = ["INFLOW", "OUTFLOW", "INTERNAL", "UNKNOWN"];
const ALL_REASONS: FlowReason[] = [
  "PLAID_PFC_DETAILED", "PLAID_PFC_PRIMARY", "CATEGORY_FLOW_VALUE",
  "CATEGORY_INVESTMENT_VALUE", "ACCOUNT_TYPE_CONTEXT", "SIGN_DEFAULT_SPENDING",
  "SIGN_DEFAULT_INFLOW", "AMBIGUOUS_UNKNOWN",
];

const baseInput = { category: "Other", amount: -1 };
for (const ft of ALL_FLOW_TYPES) {
  const c: FlowClassification = { flowType: ft, flowDirection: "OUTFLOW", confidence: 0.5, reason: "AMBIGUOUS_UNKNOWN" };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`flowType map total: ${ft}`, w.flowType === ft, `got ${w.flowType}`);
}
for (const d of ALL_DIRECTIONS) {
  const c: FlowClassification = { flowType: "UNKNOWN", flowDirection: d, confidence: 0.2, reason: "AMBIGUOUS_UNKNOWN" };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`direction map total: ${d}`, w.flowDirection === d, `got ${w.flowDirection}`);
}
for (const r of ALL_REASONS) {
  const c: FlowClassification = { flowType: "UNKNOWN", flowDirection: "UNKNOWN", confidence: 0.2, reason: r };
  const w = buildFlowWriteFields(c, baseInput, NO_META, 1);
  check(`reason map total: ${r}`, w.classificationReason === r, `got ${w.classificationReason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. NULL_FLOW_WRITE_FIELDS — the classification-failure fallback
// ─────────────────────────────────────────────────────────────────────────────

check("NULL fallback has 10 keys", Object.keys(NULL_FLOW_WRITE_FIELDS).length === 10);
check("NULL fallback all null", Object.values(NULL_FLOW_WRITE_FIELDS).every((v) => v === null));

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P3 Phase B write-fields: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`FlowType P3 Phase B write-fields: all ${passed} checks passed.`);
process.exit(0);

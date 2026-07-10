/**
 * lib/transactions/flow-row-input.test.ts
 *
 * FlowType P4 Slice 1 — buildFlowInputFromRow tests (pure, no DB). Standalone
 * `tsx` script, exit 0/1:
 *
 *     npx tsx lib/transactions/flow-row-input.test.ts
 *
 * Verifies the row→classifier-input marshalling used by the (future) backfill:
 * field pass-through, pfc/merchant preservation, empty counterparties (no
 * inference, nothing persisted), legacy-vs-FinancialAccount debtSubtype, and the
 * composed helper→classifyFlow→buildFlowWriteFields path (counterparty null,
 * classifierVersion set, determinism). No classification logic is exercised
 * beyond the frozen classifier.
 */

import {
  buildFlowInputFromRow,
  buildFlowWriteFields,
  type FlowRowInput,
  type FlowRowAccountContext,
} from "./plaid-flow-input";
import { classifyFlow, FLOW_CLASSIFIER_VERSION } from "./flow-classifier";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function row(over: Partial<FlowRowInput> = {}): FlowRowInput {
  return {
    category:           "Dining",
    amount:             -42.5,
    merchant:           "Blue Bottle Coffee",
    description:        "BLUE BOTTLE #123",
    pfcPrimary:         null,
    pfcDetailed:        null,
    pfcConfidenceLevel: null,
    merchantEntityId:   null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Field pass-through
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input, captured } = buildFlowInputFromRow(
    row(),
    { accountType: "checking", debtSubtype: null },
  );
  check("category", input.category === "Dining");
  check("amount (not re-flipped)", input.amount === -42.5, `${input.amount}`);
  check("merchant", input.merchant === "Blue Bottle Coffee");
  check("description", input.description === "BLUE BOTTLE #123");
  check("accountType", input.accountType === "checking");
  check("debtSubtype null", input.debtSubtype === null);
  check("captured counterparties empty", Array.isArray(captured.counterparties) && captured.counterparties.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PFC / merchant preservation (P2-forward rows)
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input, captured } = buildFlowInputFromRow(
    row({
      category: "Payment", amount: -300,
      pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD",
      pfcConfidenceLevel: "HIGH", merchantEntityId: "ent_chase",
    }),
    { accountType: "checking", debtSubtype: null },
  );
  check("pfcPrimary preserved", input.pfcPrimary === "LOAN_PAYMENTS");
  check("pfcDetailed preserved", input.pfcDetailed === "LOAN_PAYMENTS_CREDIT_CARD");
  check("pfcConfidenceLevel preserved", captured.pfcConfidenceLevel === "HIGH");
  check("merchantEntityId preserved", captured.merchantEntityId === "ent_chase");
}

// Historical row: pfc/merchant null → carried through as null (coarse classification)
{
  const { input, captured } = buildFlowInputFromRow(row(), { accountType: "checking", debtSubtype: null });
  check("historical pfc null", input.pfcPrimary === null && input.pfcDetailed === null);
  check("historical confidence null", captured.pfcConfidenceLevel === null);
  check("historical merchantEntityId null", captured.merchantEntityId === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Account context: FinancialAccount vs legacy Account
// ─────────────────────────────────────────────────────────────────────────────

{
  // FinancialAccount path — debtSubtype present
  const fa: FlowRowAccountContext = { accountType: "debt", debtSubtype: "credit_card" };
  const { input } = buildFlowInputFromRow(row({ category: "Interest", amount: -40 }), fa);
  check("FA debtSubtype passed", input.debtSubtype === "credit_card");
  check("FA accountType passed", input.accountType === "debt");
  // Interest on a debt account classifies as INTEREST (account-type context)
  check("debt interest → INTEREST", classifyFlow(input).flowType === "INTEREST");
}
{
  // Legacy Account path — no debtSubtype column → null
  const legacy: FlowRowAccountContext = { accountType: "checking", debtSubtype: null };
  const { input } = buildFlowInputFromRow(row(), legacy);
  check("legacy debtSubtype null", input.debtSubtype === null);
}
{
  // Missing account context entirely (defensive) → nulls, still classifies coarse
  const { input } = buildFlowInputFromRow(row(), { accountType: null, debtSubtype: null });
  check("null account context safe", input.accountType === null && input.debtSubtype === null);
  check("coarse spending still works", classifyFlow(input).flowType === "SPENDING");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Null-safety — never throws on sparse rows
// ─────────────────────────────────────────────────────────────────────────────

for (const over of [
  { merchant: null, description: null },
  { category: "", amount: 0 },
] as Partial<FlowRowInput>[]) {
  let threw = false;
  try { buildFlowInputFromRow(row(over), { accountType: null, debtSubtype: null }); } catch { threw = true; }
  check(`never throws on ${JSON.stringify(over)}`, !threw);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Composed path: row → classify → write-fields (the backfill's per-row unit)
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input, captured } = buildFlowInputFromRow(
    row({ category: "Payment", amount: -300 }),
    { accountType: "checking", debtSubtype: null },
  );
  const w = buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
  check("composed flowType", w.flowType === "DEBT_PAYMENT");
  check("composed counterparty NULL (no inference)", w.counterpartyAccountId === null);
  check("composed classifierVersion set", w.classifierVersion === FLOW_CLASSIFIER_VERSION && w.classifierVersion === 2);
  check("composed 10 columns", Object.keys(w).length === 10);
}

// Determinism → idempotency: same row yields byte-identical write fields twice
{
  const r = row({ category: "Groceries", amount: -88.2 });
  const a = buildFlowInputFromRow(r, { accountType: "checking", debtSubtype: null });
  const b = buildFlowInputFromRow(r, { accountType: "checking", debtSubtype: null });
  const wa = buildFlowWriteFields(classifyFlow(a.input), a.input, a.captured, FLOW_CLASSIFIER_VERSION);
  const wb = buildFlowWriteFields(classifyFlow(b.input), b.input, b.captured, FLOW_CLASSIFIER_VERSION);
  check("deterministic write fields", JSON.stringify(wa) === JSON.stringify(wb));
}

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P4 Slice 1 flow-row-input: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`FlowType P4 Slice 1 flow-row-input: all ${passed} checks passed.`);
process.exit(0);

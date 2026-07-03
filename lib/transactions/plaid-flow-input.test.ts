/**
 * lib/transactions/plaid-flow-input.test.ts
 *
 * FlowType P2 — Plaid import-fidelity mapper + shadow accumulator tests
 * (pure, no DB). Standalone `tsx` script, exit 0/1, mirroring the P1 suite:
 *
 *     npx tsx lib/transactions/plaid-flow-input.test.ts
 *
 * Imports only lib/transactions/plaid-flow-input.ts (which imports the
 * Prisma-free classifier and structural Plaid types), so it runs without
 * `prisma generate`.
 *
 * Covers: PFC extraction, captured-metadata sidecar, the account_numbers
 * deny-list, null-safety, classifier-through-mapper wiring, and the pure
 * shadow accumulator.
 */

import {
  buildPlaidFlowInput,
  createShadowStats,
  accumulateShadow,
  summarizeShadow,
} from "./plaid-flow-input";
import { classifyFlow } from "./flow-classifier";

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// Minimal structural Plaid-transaction factory (only the fields we read).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plaidTxn(over: Record<string, any> = {}): any {
  return {
    transaction_id: "txn_1",
    account_id:     "acc_1",
    name:           "RAW BANK DESCRIPTOR",
    merchant_name:  "Blue Bottle Coffee",
    amount:         4.5,
    date:           "2026-06-01",
    pending:        false,
    personal_finance_category: {
      primary:          "FOOD_AND_DRINK",
      detailed:         "FOOD_AND_DRINK_COFFEE",
      confidence_level: "VERY_HIGH",
    },
    merchant_entity_id: "ent_bluebottle",
    counterparties: [],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PFC + field extraction
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input, captured } = buildPlaidFlowInput(plaidTxn(), {
    category: "Dining", amount: -4.5, accountType: "checking", debtSubtype: null,
  });
  check("pfcPrimary extracted",  input.pfcPrimary === "FOOD_AND_DRINK");
  check("pfcDetailed extracted", input.pfcDetailed === "FOOD_AND_DRINK_COFFEE");
  check("confidence captured",   captured.pfcConfidenceLevel === "VERY_HIGH");
  check("merchantEntityId captured", captured.merchantEntityId === "ent_bluebottle");
  check("category passed through", input.category === "Dining");
  check("amount passed through (not re-flipped)", input.amount === -4.5, `got ${input.amount}`);
  check("accountType passed", input.accountType === "checking");
  check("merchant = merchant_name", input.merchant === "Blue Bottle Coffee");
}

// merchant fallback to name when merchant_name is null
{
  const { input } = buildPlaidFlowInput(plaidTxn({ merchant_name: null }), { category: "Other", amount: -10 });
  check("merchant falls back to name", input.merchant === "RAW BANK DESCRIPTOR");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deny-list: account_numbers must never survive capture
// ─────────────────────────────────────────────────────────────────────────────

{
  const txn = plaidTxn({
    counterparties: [
      {
        name: "Chase", entity_id: "ent_chase", type: "financial_institution",
        website: "chase.com", logo_url: "https://x/chase.png", confidence_level: "HIGH",
        account_numbers: { account: "1234567890", routing: "021000021" },
      },
    ],
  });
  const { captured } = buildPlaidFlowInput(txn, { category: "Payment", amount: -300 });
  check("counterparty captured", captured.counterparties.length === 1);
  check("counterparty name kept", captured.counterparties[0].name === "Chase");
  check("counterparty type stringified", captured.counterparties[0].type === "financial_institution");
  check("counterparty confidence kept", captured.counterparties[0].confidenceLevel === "HIGH");
  // The deny-list guarantee: no account/routing number anywhere in the captured struct.
  const serialized = JSON.stringify(captured);
  check("no account_numbers key", !serialized.includes("account_numbers"));
  check("no account number value", !serialized.includes("1234567890"));
  check("no routing number value", !serialized.includes("021000021"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check("no account_numbers on object", (captured.counterparties[0] as any).account_numbers === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Null-safety — no throws on sparse payloads
// ─────────────────────────────────────────────────────────────────────────────

for (const over of [
  { personal_finance_category: null, counterparties: undefined, merchant_name: null, merchant_entity_id: null },
  { personal_finance_category: undefined },
  { counterparties: null },
]) {
  let threw = false;
  let result;
  try { result = buildPlaidFlowInput(plaidTxn(over), { category: "Other", amount: -1 }); } catch { threw = true; }
  check(`never throws on sparse ${JSON.stringify(over)}`, !threw);
  if (result) {
    check("sparse: pfc null-safe", result.input.pfcPrimary === null || typeof result.input.pfcPrimary === "string");
    check("sparse: counterparties array", Array.isArray(result.captured.counterparties));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Classifier-through-mapper wiring (P1 doctrine reached via PFC)
// ─────────────────────────────────────────────────────────────────────────────

{
  const { input } = buildPlaidFlowInput(
    plaidTxn({ personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD", confidence_level: "HIGH" } }),
    { category: "Payment", amount: -300 },
  );
  check("PFC LOAN_PAYMENTS → DEBT_PAYMENT", classifyFlow(input).flowType === "DEBT_PAYMENT");
}
{
  const { input } = buildPlaidFlowInput(
    plaidTxn({ personal_finance_category: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", confidence_level: "HIGH" } }),
    { category: "Transfer", amount: 500 },
  );
  const c = classifyFlow(input);
  check("PFC TRANSFER_IN → TRANSFER/INFLOW", c.flowType === "TRANSFER" && c.flowDirection === "INFLOW");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Shadow accumulator (pure, non-PII)
// ─────────────────────────────────────────────────────────────────────────────

{
  const acc = createShadowStats();
  const rows: { category: string; amount: number }[] = [
    { category: "Dining",   amount: -20 },  // SPENDING → expense (legacy expense) ✓
    { category: "Income",   amount: 4200 }, // INCOME → income ✓
    { category: "Transfer", amount: -500 }, // TRANSFER → transfer ✓
    { category: "Payment",  amount: -300 }, // DEBT_PAYMENT → debtPayment ✓
    { category: "Dining",   amount: 15 },   // REFUND → none; legacy none ✓
  ];
  for (const r of rows) accumulateShadow(acc, classifyFlow(r), r.category, r.amount);

  check("accumulator total", acc.total === 5);
  check("accumulator counts flowType", (acc.byFlowType["SPENDING"] ?? 0) === 1 && (acc.byFlowType["REFUND"] ?? 0) === 1);
  check("accumulator counts reason", Object.keys(acc.byReason).length > 0);
  check("legacy comparisons counted", acc.legacyBucketComparisons === 5);
  check("full agreement on banking rows", acc.legacyBucketAgreements === 5, `got ${acc.legacyBucketAgreements}`);
  check("unknown count", acc.unknown === 0);

  const summary = summarizeShadow(acc);
  check("summary is non-PII (no merchant/counterparty tokens)",
    !/Blue Bottle|Chase|021000021|1234567890/.test(summary));
  check("summary reports agreement", summary.includes("legacyBucketAgreement=5/5"));
  check("summary reports 100%", summary.includes("(100%)"), summary);
}

// UNKNOWN is counted, never hidden
{
  const acc = createShadowStats();
  accumulateShadow(acc, classifyFlow({ category: "Zzz", amount: -10 }), "Zzz", -10);
  check("unknown tallied", acc.unknown === 1 && (acc.byFlowType["UNKNOWN"] ?? 0) === 1);
}

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nFlowType P2 plaid-flow-input: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`FlowType P2 plaid-flow-input: all ${passed} checks passed.`);
process.exit(0);

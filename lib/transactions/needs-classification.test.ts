/**
 * lib/transactions/needs-classification.test.ts
 *
 * TE-2B — proves the semantic boundary of shouldSurfaceAsNeedsClassification():
 * it surfaces ONLY payment-app movements with unknown purpose and inflows with no
 * identifiable source, and leaves ordinary low-confidence purchases alone. It is
 * NOT a confidence threshold. Pure — no DB, no Prisma runtime.
 *   npx tsx --test lib/transactions/needs-classification.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  shouldSurfaceAsNeedsClassification,
  type NeedsClassificationInput,
} from "./needs-classification";

/** Default = an ordinary identified card purchase (should NOT surface). */
function tx(over: Partial<NeedsClassificationInput> = {}): NeedsClassificationInput {
  return {
    flowType: "SPENDING",
    classificationReason: "PLAID_PFC_PRIMARY",
    transferRail: null,
    hasResolvedMerchant: true,
    hasResolvedCounterparty: false,
    ...over,
  };
}

// 1 — payment-app movement, unknown purpose → true
test("payment-app movement with unknown purpose surfaces (UNKNOWN_PAYMENT_APP_PURPOSE)", () => {
  const r = shouldSurfaceAsNeedsClassification(tx({ flowType: "TRANSFER", classificationReason: "PLAID_PFC_PRIMARY", transferRail: "PAYMENT_APP", hasResolvedMerchant: false }));
  assert.deepEqual(r, { needsClassification: true, reason: "UNKNOWN_PAYMENT_APP_PURPOSE" });
});

// 2 — payment-app with stronger known meaning (matched owned transfer) → false
test("payment-app movement resolved to an owned counterparty does NOT surface", () => {
  const r = shouldSurfaceAsNeedsClassification(tx({ flowType: "TRANSFER", transferRail: "PAYMENT_APP", hasResolvedCounterparty: true, hasResolvedMerchant: false }));
  assert.equal(r.needsClassification, false);
});

// 3 — identified income → false
test("identified income (strong reason / resolved merchant) does NOT surface", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "INCOME", classificationReason: "PLAID_PFC_PRIMARY", hasResolvedMerchant: true })).needsClassification, false);
  // Even a sign-default income surfaces ONLY when the source is unresolved:
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", hasResolvedMerchant: true })).needsClassification, false);
});

// 4 — unidentified inflow → true
test("inflow with no identifiable source surfaces (UNKNOWN_INFLOW_SOURCE)", () => {
  const r = shouldSurfaceAsNeedsClassification(tx({ flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", hasResolvedMerchant: false }));
  assert.deepEqual(r, { needsClassification: true, reason: "UNKNOWN_INFLOW_SOURCE" });
});

// 5 — refund → false
test("a refund does NOT surface (condition B is INCOME-only)", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "REFUND", classificationReason: "SIGN_DEFAULT_INFLOW", hasResolvedMerchant: false })).needsClassification, false);
});

// 6 — ordinary sign-default spending at conf 0.5 → false (NOT a confidence threshold)
test("ordinary sign-default spending does NOT surface (confidence is not the definition)", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "SPENDING", classificationReason: "SIGN_DEFAULT_SPENDING", hasResolvedMerchant: false })).needsClassification, false);
});

// 7 — known-merchant spending → false
test("known-merchant spending does NOT surface even with weak category", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "SPENDING", classificationReason: "SIGN_DEFAULT_SPENDING", hasResolvedMerchant: true })).needsClassification, false);
});

// 8 — internal owned-account transfer → false
test("an internal owned-account transfer does NOT surface", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "TRANSFER", transferRail: null, hasResolvedCounterparty: true, hasResolvedMerchant: false })).needsClassification, false);
});

// 9 — cash movement → false (investigation did not surface cash)
test("a cash movement does NOT surface (only PAYMENT_APP rail triggers cluster A)", () => {
  // A cash withdrawal is a TRANSFER with no payment-app rail — never surfaced.
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "TRANSFER", transferRail: null, hasResolvedMerchant: false })).needsClassification, false);
});

// 10 — provider-neutral: no Plaid/PFC strings in the module code
test("the predicate module is provider-neutral (no Plaid/PFC strings in code)", () => {
  const src = readFileSync(join(process.cwd(), "lib", "transactions", "needs-classification.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // strip comments
  for (const token of [/plaid/i, /\bpfc/i, /TRANSFER_OUT/, /TRANSFER_IN/, /FROM_APPS/]) {
    assert.ok(!token.test(code), `predicate code must not mention ${token}`);
  }
});

// 11 — deterministic and pure
test("predicate is deterministic and does not mutate its input", () => {
  const input = tx({ flowType: "TRANSFER", transferRail: "PAYMENT_APP", hasResolvedMerchant: false });
  const snapshot = JSON.stringify(input);
  assert.deepEqual(shouldSurfaceAsNeedsClassification(input), shouldSurfaceAsNeedsClassification(input));
  assert.equal(JSON.stringify(input), snapshot);
});

// Extra: a payment-app INFLOW (received) also surfaces; self-heal when merchant resolves
test("payment-app received surfaces; an inflow self-heals once a merchant resolves", () => {
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "TRANSFER", transferRail: "PAYMENT_APP", hasResolvedMerchant: false })).needsClassification, true);
  // The unidentified inflow drops out once merchant normalization resolves a source.
  assert.equal(shouldSurfaceAsNeedsClassification(tx({ flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", hasResolvedMerchant: true })).needsClassification, false);
});

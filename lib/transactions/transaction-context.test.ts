/**
 * lib/transactions/transaction-context.test.ts
 *
 * CF-1 — proves the per-row read-time projection: transferDisposition (TRANSFER
 * rows only) + the TE-2B needsClassification flag, from canonical fields.
 *   npx tsx --test lib/transactions/transaction-context.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveTransactionContext, type TransactionContextInput } from "./transaction-context";

function row(over: Partial<TransactionContextInput> = {}): TransactionContextInput {
  return {
    flowType: "SPENDING", classificationReason: "PLAID_PFC_PRIMARY",
    transferRail: null, transferMovementForm: null, transferVenueClass: null,
    transferEvidenceConfidence: null, transferEvidenceReason: null,
    transferEvidenceSource: null, transferEvidenceVersion: null,
    hasResolvedMerchant: true, isOwnedCounterparty: false, ...over,
  };
}

test("transfer dispositions derive from evidence + ownership; needsClassification flags payment-app", () => {
  const app = deriveTransactionContext(row({ flowType: "TRANSFER", transferRail: "PAYMENT_APP", hasResolvedMerchant: false }));
  assert.equal(app.transferDisposition, "PAYMENT_APP_MOVEMENT");
  assert.equal(app.needsClassification, true);

  assert.equal(deriveTransactionContext(row({ flowType: "TRANSFER", transferMovementForm: "CASH" })).transferDisposition, "CASH_MOVEMENT");
  assert.equal(deriveTransactionContext(row({ flowType: "TRANSFER", transferVenueClass: "EXCHANGE" })).transferDisposition, "ASSET_VENUE_TRANSFER");
  assert.equal(deriveTransactionContext(row({ flowType: "TRANSFER", transferVenueClass: "DEPOSITORY", isOwnedCounterparty: true })).transferDisposition, "INTERNAL_TRANSFER");
  assert.equal(deriveTransactionContext(row({ flowType: "TRANSFER", transferVenueClass: "DEPOSITORY", isOwnedCounterparty: false })).transferDisposition, "EXTERNAL_BANK_TRANSFER");
});

test("non-transfer rows get null disposition (never labeled a movement)", () => {
  assert.equal(deriveTransactionContext(row({ flowType: "SPENDING" })).transferDisposition, null);
  assert.equal(deriveTransactionContext(row({ flowType: "SPENDING", classificationReason: "SIGN_DEFAULT_SPENDING" })).needsClassification, false);
});

test("unidentified inflow → needsClassification true, no disposition (it is not a transfer)", () => {
  const inflow = deriveTransactionContext(row({ flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", hasResolvedMerchant: false }));
  assert.equal(inflow.transferDisposition, null);
  assert.equal(inflow.needsClassification, true);
});

test("an owned payment-app transfer is internal, not needs-classification", () => {
  const r = deriveTransactionContext(row({ flowType: "TRANSFER", transferRail: "PAYMENT_APP", isOwnedCounterparty: true, hasResolvedMerchant: false }));
  assert.equal(r.transferDisposition, "INTERNAL_TRANSFER");
  assert.equal(r.needsClassification, false);
});

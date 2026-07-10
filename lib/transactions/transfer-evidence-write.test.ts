/**
 * lib/transactions/transfer-evidence-write.test.ts
 *
 * Proves the PERSISTENCE + REPLAY layer for provider-neutral transfer evidence:
 *  - Plaid writes provider-neutral fields with NO raw PFC strings in the values;
 *  - a recognized exact family persists exactly one descriptive axis + provenance;
 *  - payment-app persists no purpose/spending/income/P2P claim;
 *  - cash persists movement FORM with no counterparty/venue fabrication;
 *  - brokerage/crypto persist venue evidence;
 *  - no-detailed / unrecognized persists no fabricated evidence;
 *  - non-Plaid rows stay unclassified (no Plaid-derived default);
 *  - replay is idempotent; a version change is detected and replayed;
 *  - higher-authority stored facts are never overwritten;
 *  - a mock second provider flows through the SAME mapper/reconcile unchanged;
 *  - liquidity / cash-flow / liquidity-breakdown import none of these modules.
 *
 * Pure — no DB, no Prisma runtime (type-only Prisma imports in the SUT).
 *   npx tsx --test lib/transactions/transfer-evidence-write.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { plaidTransferEvidence, PLAID_TRANSFER_ADAPTER_VERSION } from "./plaid-transfer-evidence";
import {
  transferEvidenceWriteFields,
  reconcileTransferEvidence,
  sourceAuthority,
  NULL_TRANSFER_EVIDENCE_FIELDS,
  type TransferEvidenceFields,
} from "./transfer-evidence-write";
import { planTransferEvidence } from "./transfer-evidence-plan";
import type { TransferEvidence } from "./transfer-evidence";

/** Persisted fields for a Plaid detailed code (recognized). */
function fieldsFor(pfcDetailed: string, amount = -100): TransferEvidenceFields {
  return transferEvidenceWriteFields(plaidTransferEvidence({ pfcDetailed, amount }));
}

// ── 1. Persisted DESCRIPTIVE AXES carry canonical vocabulary, not raw PFC codes ─
// (transferEvidenceReason/Source are provenance — they legitimately name the
// provider, exactly as classificationReason=PLAID_PFC_PRIMARY does — so they are
// not part of the "no-leak" surface; the descriptive axes are.)
test("persisted descriptive axes are canonical enum values, never raw Plaid PFC codes", () => {
  const RAILS = new Set([null, "PAYMENT_APP"]);
  const FORMS = new Set([null, "CASH"]);
  const VENUES = new Set([null, "DEPOSITORY", "BROKERAGE", "EXCHANGE"]);
  const families = [
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS", "TRANSFER_OUT_WITHDRAWAL", "TRANSFER_OUT_CRYPTO",
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", "TRANSFER_OUT_ACCOUNT_TRANSFER", "TRANSFER_OUT_SAVINGS",
  ];
  for (const d of families) {
    const f = fieldsFor(d);
    assert.ok(RAILS.has(f.transferRail), `rail not canonical: ${f.transferRail}`);
    assert.ok(FORMS.has(f.transferMovementForm), `form not canonical: ${f.transferMovementForm}`);
    assert.ok(VENUES.has(f.transferVenueClass), `venue not canonical: ${f.transferVenueClass}`);
    // No axis value ever carries a raw Plaid PFC token.
    for (const v of [f.transferRail, f.transferMovementForm, f.transferVenueClass]) {
      assert.ok(v == null || !/TRANSFER_(IN|OUT)|FROM_APPS/i.test(v), `axis leaked a raw PFC code: ${v}`);
    }
  }
});

// ── 2. Recognized family → one descriptive axis + full provenance ──────────────
test("a recognized family persists exactly one descriptive axis and full provenance", () => {
  const f = fieldsFor("TRANSFER_OUT_CRYPTO");
  assert.equal(f.transferVenueClass, "EXCHANGE");
  assert.equal(f.transferRail, null);
  assert.equal(f.transferMovementForm, null);
  assert.equal(f.transferEvidenceSource, "plaid");
  assert.equal(f.transferEvidenceVersion, PLAID_TRANSFER_ADAPTER_VERSION);
  assert.equal(f.transferEvidenceConfidence, 1);
  assert.ok((f.transferEvidenceReason ?? "").length > 0);
});

// ── 3. Payment-app persists a rail, never a purpose/economic claim ─────────────
test("payment-app persists rail only — no purpose/spending/income/P2P field or claim", () => {
  const f = fieldsFor("TRANSFER_OUT_TRANSFER_OUT_FROM_APPS");
  assert.equal(f.transferRail, "PAYMENT_APP");
  assert.equal(f.transferVenueClass, null);
  assert.equal(f.transferMovementForm, null);
  // There is no purpose/spending/income column, and the reason makes no such claim.
  assert.ok(!/p2p|spending|income|gift|reimburse|purpose/i.test(f.transferEvidenceReason ?? ""));
});

// ── 4. Cash persists FORM with no counterparty/venue fabrication ───────────────
test("cash withdrawal persists movement form, no venue/counterparty fabrication", () => {
  const f = fieldsFor("TRANSFER_OUT_WITHDRAWAL");
  assert.equal(f.transferMovementForm, "CASH");
  assert.equal(f.transferVenueClass, null);
  assert.equal(f.transferRail, null);
});

// ── 5. Brokerage & crypto persist venue evidence ───────────────────────────────
test("brokerage and crypto persist venue evidence", () => {
  assert.equal(fieldsFor("TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", 500).transferVenueClass, "BROKERAGE");
  assert.equal(fieldsFor("TRANSFER_OUT_CRYPTO").transferVenueClass, "EXCHANGE");
});

// ── 6. No-detailed / unrecognized persist no fabricated evidence ───────────────
test("no-detailed and unrecognized Plaid rows persist no fabricated evidence", () => {
  const noSignal = planTransferEvidence({ plaidTransactionId: "p1", pfcDetailed: null, amount: -100, stored: NULL_TRANSFER_EVIDENCE_FIELDS });
  assert.equal(noSignal.signal, "no_signal");
  assert.deepEqual(noSignal.proposed, NULL_TRANSFER_EVIDENCE_FIELDS);
  assert.equal(noSignal.reconcile.write, false);

  const unrec = planTransferEvidence({ plaidTransactionId: "p2", pfcDetailed: "TRANSFER_OUT_OTHER_TRANSFER_OUT", amount: -100, stored: NULL_TRANSFER_EVIDENCE_FIELDS });
  assert.equal(unrec.signal, "unrecognized");
  assert.deepEqual(unrec.proposed, NULL_TRANSFER_EVIDENCE_FIELDS);
  assert.equal(unrec.reconcile.write, false);
});

// ── 7. Non-Plaid rows stay unclassified (no Plaid-derived default) ─────────────
test("a non-Plaid row gets no adapter and stays fully unclassified", () => {
  // Even if a stray pfcDetailed were present, a non-Plaid row must not be classified.
  const plan = planTransferEvidence({ plaidTransactionId: null, pfcDetailed: "TRANSFER_OUT_CRYPTO", amount: -100, stored: NULL_TRANSFER_EVIDENCE_FIELDS });
  assert.equal(plan.signal, "non_provider");
  assert.deepEqual(plan.proposed, NULL_TRANSFER_EVIDENCE_FIELDS);
  assert.equal(plan.reconcile.write, false);
});

// ── 8. Replay is idempotent ────────────────────────────────────────────────────
test("replaying the same adapter version is idempotent (no write)", () => {
  const stored = fieldsFor("TRANSFER_OUT_ACCOUNT_TRANSFER", -500);
  const plan = planTransferEvidence({ plaidTransactionId: "p3", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: -500, stored });
  assert.equal(plan.reconcile.reason, "unchanged");
  assert.equal(plan.reconcile.write, false);
});

// ── 9. A mapping-version change is detected and replayed ───────────────────────
test("a mapping-version change is detected and replayed", () => {
  const current = fieldsFor("TRANSFER_OUT_CRYPTO");
  const staleStored: TransferEvidenceFields = { ...current, transferEvidenceVersion: "plaid-transfer/0" };
  const r = reconcileTransferEvidence(staleStored, current);
  assert.equal(r.reason, "version_change");
  assert.equal(r.write, true);
});

// ── 10. Higher-authority stored facts are never overwritten ────────────────────
test("higher-authority (manual) stored evidence is preserved against a provider write", () => {
  const manualStored: TransferEvidenceFields = { ...fieldsFor("TRANSFER_OUT_CRYPTO"), transferEvidenceSource: "manual" };
  const providerIncoming = fieldsFor("TRANSFER_OUT_ACCOUNT_TRANSFER", -500);
  const r = reconcileTransferEvidence(manualStored, providerIncoming);
  assert.equal(r.reason, "preserved_higher_authority");
  assert.equal(r.write, false);
  assert.ok(sourceAuthority("manual") > sourceAuthority("plaid"));
});

// ── 11. A mock second provider flows through the SAME mapper/reconcile ─────────
test("a mock second-provider's evidence uses the same neutral mapper + reconcile", () => {
  const mock: TransferEvidence = {
    venueClass: "EXCHANGE", direction: "IN", evidenceConfidence: 1,
    reason: "mock:fiat→venue=exchange", source: "mock-exchange", version: "mock-exchange/1",
  };
  const fields = transferEvidenceWriteFields(mock);
  assert.equal(fields.transferVenueClass, "EXCHANGE");
  assert.equal(fields.transferEvidenceSource, "mock-exchange");
  // Same-tier providers reconcile without special-casing; no canonical change needed.
  assert.equal(reconcileTransferEvidence(NULL_TRANSFER_EVIDENCE_FIELDS, fields).write, true);
});

test("liquidity / cash-flow / liquidity-breakdown import none of the transfer-evidence write modules", () => {
  for (const f of ["liquidity.ts", "cash-flow.ts", "liquidity-breakdown.ts"]) {
    const src = readFileSync(join(process.cwd(), "lib", "transactions", f), "utf8");
    for (const mod of ["transfer-evidence", "transfer-evidence-write", "transfer-evidence-plan", "plaid-transfer-evidence"]) {
      assert.ok(!src.includes(mod), `${f} must not import ${mod}`);
    }
    assert.ok(!/pfc/i.test(src), `${f} must stay provider-agnostic`);
  }
});

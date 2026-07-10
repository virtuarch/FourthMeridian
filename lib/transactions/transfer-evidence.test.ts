/**
 * lib/transactions/transfer-evidence.test.ts
 *
 * Proves the corrected two-stage, multi-axis, provider-neutral transfer ontology:
 *   - evidence axes (rail / form / venue / direction) are INDEPENDENT;
 *   - payment-app evidence stays a rail, never an economic purpose;
 *   - cash withdrawal/deposit is a movement FORM, not a fake counterparty;
 *   - brokerage/crypto stay VENUE evidence;
 *   - owned-account status enters ONLY as canonical relationship context;
 *   - unknown/no-signal stays unknown (no fabricated axis);
 *   - direction, confidence, reason, version pass through deterministically;
 *   - every distinct live Plaid detailed-code family is covered;
 *   - a mock second-provider adapter feeds the SAME canonical derivation;
 *   - liquidity / cash-flow / liquidity-breakdown import no provider adapter and
 *     mention no Plaid category strings; the canonical module has neither.
 *
 * Pure — no DB, no Prisma runtime.
 *   npx tsx --test lib/transactions/transfer-evidence.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  deriveTransferDisposition,
  type TransferEvidence,
  type TransferDisposition,
} from "./transfer-evidence";
import { plaidTransferEvidence, PLAID_TRANSFER_ADAPTER_VERSION } from "./plaid-transfer-evidence";

// ── 1. Evidence axes are independent (canonical derivation, no provider input) ──

test("each evidence axis derives independently; unset axes stay undefined", () => {
  const rail: TransferEvidence = { railType: "PAYMENT_APP", evidenceConfidence: 1, reason: "r", source: "s", version: "v" };
  const form: TransferEvidence = { movementForm: "CASH", evidenceConfidence: 1, reason: "r", source: "s", version: "v" };
  const venue: TransferEvidence = { venueClass: "DEPOSITORY", evidenceConfidence: 1, reason: "r", source: "s", version: "v" };

  // Setting one axis leaves the others undefined — no cross-contamination.
  assert.equal(rail.movementForm, undefined);
  assert.equal(rail.venueClass, undefined);
  assert.equal(form.railType, undefined);
  assert.equal(venue.railType, undefined);

  assert.equal(deriveTransferDisposition(rail), "PAYMENT_APP_MOVEMENT");
  assert.equal(deriveTransferDisposition(form), "CASH_MOVEMENT");
  assert.equal(deriveTransferDisposition(venue), "EXTERNAL_BANK_TRANSFER");
});

test("payment-app evidence does NOT become an economic purpose (no P2P/spending claim)", () => {
  const d = deriveTransferDisposition({ railType: "PAYMENT_APP", direction: "OUT", evidenceConfidence: 1, reason: "r", source: "s", version: "v" });
  assert.equal(d, "PAYMENT_APP_MOVEMENT");
  assert.notEqual(d as string, "P2P_PAYMENT");
  assert.notEqual(d as string, "SPENDING");
});

// ── CF-P1 — known payment-app brand names the RAIL over a generic account transfer ──

test("CF-P1: Apple Cash OUT tagged ACCOUNT_TRANSFER → rail PAYMENT_APP, not DEPOSITORY", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: -101.47, name: "APPLE CASH SENT MONEY" });
  assert.equal(ev.railType, "PAYMENT_APP");
  assert.equal(ev.venueClass, undefined);            // depository venue suppressed
  assert.equal(deriveTransferDisposition(ev), "PAYMENT_APP_MOVEMENT");  // was EXTERNAL_BANK_TRANSFER
});

test("CF-P1: Apple Cash IN (FROM_APPS) is unchanged — still rail PAYMENT_APP", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_IN_TRANSFER_IN_FROM_APPS", amount: 200, name: "APPLE CASH RECEIVED" });
  assert.equal(ev.railType, "PAYMENT_APP");
  assert.equal(deriveTransferDisposition(ev), "PAYMENT_APP_MOVEMENT");
});

test("CF-P1: a NON-payment-app ACCOUNT_TRANSFER stays DEPOSITORY (no over-reach)", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: -500, name: "Chase QuickPay to Savings" });
  assert.equal(ev.venueClass, "DEPOSITORY");
  assert.equal(ev.railType, undefined);
});

test("CF-P1: a payment-app name does NOT override CASH form (physical cash dominates)", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_WITHDRAWAL", amount: -100, name: "APPLE CASH" });
  assert.equal(ev.movementForm, "CASH");
  assert.equal(ev.railType, undefined);
});

test("CF-P1: payment-app name with no detailed still yields rail PAYMENT_APP", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: null, amount: -50, name: "Venmo" });
  assert.equal(ev.railType, "PAYMENT_APP");
});

test("cash withdrawal/deposit is a movement FORM with no counterparty/venue", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_WITHDRAWAL", amount: -200 });
  assert.equal(ev.movementForm, "CASH");
  assert.equal(ev.venueClass, undefined);   // not a "cash counterparty/venue"
  assert.equal(ev.railType, undefined);
  assert.equal(deriveTransferDisposition(ev), "CASH_MOVEMENT");
});

test("brokerage and crypto stay VENUE evidence → ASSET_VENUE_TRANSFER", () => {
  const crypto = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_CRYPTO", amount: -100 });
  const brok = plaidTransferEvidence({ pfcDetailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", amount: 500 });
  assert.equal(crypto.venueClass, "EXCHANGE");
  assert.equal(brok.venueClass, "BROKERAGE");
  assert.equal(deriveTransferDisposition(crypto), "ASSET_VENUE_TRANSFER");
  assert.equal(deriveTransferDisposition(brok), "ASSET_VENUE_TRANSFER");
});

// ── 2. Ownership is canonical context only, never evidence ─────────────────────

test("owned-account status is supplied ONLY via relationship context and upgrades depository→internal", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: -500 });
  // Evidence carries no ownership axis at all.
  assert.equal("counterpartyIsOwned" in ev, false);
  assert.equal(deriveTransferDisposition(ev), "EXTERNAL_BANK_TRANSFER");
  assert.equal(deriveTransferDisposition(ev, { counterpartyIsOwned: true }), "INTERNAL_TRANSFER");
});

test("an asset venue stays ASSET_VENUE_TRANSFER even when owned (tier crossing, not internal)", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_CRYPTO", amount: -100 });
  assert.equal(deriveTransferDisposition(ev, { counterpartyIsOwned: true }), "ASSET_VENUE_TRANSFER");
});

// ── 3. Unknown stays unknown; provenance always populated ──────────────────────

test("no-signal Plaid input yields UNKNOWN evidence (no fabricated axis), with explicit reason", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: null, amount: -100 });
  assert.equal(ev.railType, undefined);
  assert.equal(ev.movementForm, undefined);
  assert.equal(ev.venueClass, undefined);
  assert.equal(ev.evidenceConfidence, 0);
  assert.equal(ev.reason, "plaid:no_signal");
  assert.equal(deriveTransferDisposition(ev), "UNKNOWN_MOVEMENT");
});

test("an unrecognized detailed code yields UNKNOWN, not a guessed venue", () => {
  const ev = plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_OTHER_TRANSFER_OUT", amount: -100 });
  assert.equal(ev.venueClass, undefined);
  assert.equal(ev.evidenceConfidence, 0);
  assert.equal(ev.reason, "plaid:unrecognized_detailed");
  assert.equal(deriveTransferDisposition(ev), "UNKNOWN_MOVEMENT");
});

test("direction, confidence, reason, version pass through deterministically", () => {
  const a = plaidTransferEvidence({ pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER", amount: 500 });
  const b = plaidTransferEvidence({ pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER", amount: 500 });
  assert.deepEqual(a, b);                 // deterministic
  assert.equal(a.direction, "IN");
  assert.equal(a.evidenceConfidence, 1);
  assert.equal(a.source, "plaid");
  assert.equal(a.version, PLAID_TRANSFER_ADAPTER_VERSION);
  assert.ok(a.reason.length > 0);
  assert.equal(plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", amount: 0 }).direction, undefined);
});

// ── 4. Coverage: every distinct live Plaid detailed-code family ────────────────
// Enumerated read-only from the local DB (pfcPrimary in TRANSFER_IN/TRANSFER_OUT):
//   *_ACCOUNT_TRANSFER, *_SAVINGS, *_FROM_APPS, *_WITHDRAWAL, *_DEPOSIT,
//   *_CRYPTO, *_INVESTMENT_AND_RETIREMENT_FUNDS  (+ the doubled *_FROM_APPS artifact).

test("every distinct live detailed-code family maps to the correct axis + disposition", () => {
  const cases: Array<[string, keyof TransferEvidence | null, string, TransferDisposition]> = [
    // pfcDetailed, axis it sets, axis value, disposition (no ownership context)
    ["TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",          "railType",     "PAYMENT_APP", "PAYMENT_APP_MOVEMENT"],
    ["TRANSFER_IN_TRANSFER_IN_FROM_APPS",            "railType",     "PAYMENT_APP", "PAYMENT_APP_MOVEMENT"],
    ["TRANSFER_OUT_ACCOUNT_TRANSFER",                "venueClass",   "DEPOSITORY",  "EXTERNAL_BANK_TRANSFER"],
    ["TRANSFER_IN_ACCOUNT_TRANSFER",                 "venueClass",   "DEPOSITORY",  "EXTERNAL_BANK_TRANSFER"],
    ["TRANSFER_OUT_SAVINGS",                         "venueClass",   "DEPOSITORY",  "EXTERNAL_BANK_TRANSFER"],
    ["TRANSFER_OUT_WITHDRAWAL",                      "movementForm", "CASH",        "CASH_MOVEMENT"],
    ["TRANSFER_IN_DEPOSIT",                          "movementForm", "CASH",        "CASH_MOVEMENT"],
    ["TRANSFER_OUT_CRYPTO",                          "venueClass",   "EXCHANGE",    "ASSET_VENUE_TRANSFER"],
    ["TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", "venueClass",  "BROKERAGE",   "ASSET_VENUE_TRANSFER"],
    ["TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",  "venueClass",  "BROKERAGE",   "ASSET_VENUE_TRANSFER"],
  ];
  for (const [detailed, axis, value, disposition] of cases) {
    const ev = plaidTransferEvidence({ pfcDetailed: detailed, amount: -100 });
    if (axis) assert.equal(ev[axis], value, `${detailed} → ${axis}=${value}`);
    // Exactly ONE of the three descriptive axes is set (orthogonality holds per row).
    const setAxes = [ev.railType, ev.movementForm, ev.venueClass].filter((x) => x !== undefined);
    assert.equal(setAxes.length, 1, `${detailed} must set exactly one descriptive axis`);
    assert.equal(deriveTransferDisposition(ev), disposition, `${detailed} → ${disposition}`);
  }
});

// ── 5. A different provider feeds the SAME canonical derivation ─────────────────

/**
 * A MOCK second-provider adapter (a stand-in for a future exchange/brokerage/
 * wallet/CSV adapter), defined entirely here. It speaks its OWN raw vocabulary and
 * emits the SAME TransferEvidence contract; the canonical derivation is unchanged.
 */
type MockExchangeEvent = "FIAT_DEPOSIT" | "FIAT_WITHDRAWAL" | "ATM_CASHOUT";
function mockExchangeTransferEvidence(evt: MockExchangeEvent, amount: number): TransferEvidence {
  const direction: "IN" | "OUT" = amount > 0 ? "IN" : "OUT";
  const base = { direction, evidenceConfidence: 0.95, source: "mock-exchange", version: "mock-exchange/1" };
  if (evt === "ATM_CASHOUT") return { ...base, movementForm: "CASH", reason: "mock:atm→form=cash" };
  return { ...base, venueClass: "EXCHANGE", reason: "mock:fiat_rail→venue=exchange" };
}

test("a mock second-provider adapter yields identical canonical dispositions", () => {
  assert.equal(deriveTransferDisposition(mockExchangeTransferEvidence("FIAT_DEPOSIT", 1000)), "ASSET_VENUE_TRANSFER");
  assert.equal(
    deriveTransferDisposition(mockExchangeTransferEvidence("FIAT_DEPOSIT", 1000)),
    deriveTransferDisposition(plaidTransferEvidence({ pfcDetailed: "TRANSFER_IN_CRYPTO", amount: 1000 })),
  );
  // A different provider's cash movement lands on the same disposition as Plaid's.
  assert.equal(
    deriveTransferDisposition(mockExchangeTransferEvidence("ATM_CASHOUT", -100)),
    deriveTransferDisposition(plaidTransferEvidence({ pfcDetailed: "TRANSFER_OUT_WITHDRAWAL", amount: -100 })),
  );
});

// ── 6. Provider-neutrality tripwires (source scans) ────────────────────────────

test("the canonical module contains NO provider strings and NO provider imports", () => {
  const src = readFileSync(join(process.cwd(), "lib", "transactions", "transfer-evidence.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // strip comments
  for (const token of [/pfc/i, /TRANSFER_OUT/, /TRANSFER_IN/, /FROM_APPS/, /plaid/i, /coinbase/i]) {
    assert.ok(!token.test(code), `canonical code must not mention ${token}`);
  }
  const imports = [...src.matchAll(/^import\s.*?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!/plaid|coinbase|provider/i.test(spec), `canonical must not import a provider module: ${spec}`);
  }
});

test("liquidity, cash-flow, and liquidity-breakdown import no provider adapter and no PFC strings", () => {
  for (const f of ["liquidity.ts", "cash-flow.ts", "liquidity-breakdown.ts"]) {
    const src = readFileSync(join(process.cwd(), "lib", "transactions", f), "utf8");
    assert.ok(!/plaid-transfer-evidence/.test(src), `${f} must not import the Plaid transfer adapter`);
    assert.ok(!/pfc/i.test(src), `${f} must stay provider-agnostic (no PFC references)`);
  }
});

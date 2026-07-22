/**
 * lib/transactions/debt-payments.test.ts
 *
 * Phase 3 — the Debt Payments widget aggregates canonical DEBT_PAYMENT rows by
 * CREDITOR. Proves the pure grouping helper:
 *   1. normalizeCreditor collapses the volatile per-payment tokens (dates,
 *      "ending in ####", ACH trace, WEB/REF ids) so ONE creditor is ONE group;
 *   2. distinct creditors never merge;
 *   3. Σ(group values) == Σ(row magnitudes) and every row lands in exactly one
 *      group (no double-count), with a payment count per group.
 * Pure — no DB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreditor, rawCreditorLabel, groupDebtPaymentsByCreditor } from "./debt-payments";
import type { Transaction } from "@/types";

function dp(over: Partial<Transaction> & { amount: number }): Transaction {
  return {
    id: Math.random().toString(36).slice(2), accountId: "chk", date: "2026-06-01",
    merchant: over.merchant ?? "Debt payment", category: "Payment" as Transaction["category"],
    pending: false, flowType: "DEBT_PAYMENT", ...over,
  } as Transaction;
}

test("normalizeCreditor collapses statement dates + card last-4 into one creditor", () => {
  const a = normalizeCreditor("Payment to Chase card ending in 0202 02/27");
  const b = normalizeCreditor("Payment to Chase card ending in 0202 01/10");
  assert.equal(a, b);
  assert.equal(a, "Payment To Chase Card");
});

test("normalizeCreditor collapses ACH trace + WEB ID", () => {
  const a = normalizeCreditor("AMERICAN EXPRESS ACH PMT M6410 WEB ID: 2005032111");
  const b = normalizeCreditor("AMERICAN EXPRESS ACH PMT M3518 WEB ID: 2005032111");
  assert.equal(a, b);
  assert.equal(a, "American Express Ach Pmt");
});

test("distinct creditors never merge", () => {
  assert.notEqual(normalizeCreditor("Beacon Mortgage Pmt"), normalizeCreditor("American Express Ach Pmt"));
  assert.notEqual(normalizeCreditor("Beacon Mortgage Pmt"), normalizeCreditor("Beacon Auto Loan Pmt"));
});

test("empty / whitespace descriptor falls back to a stable label", () => {
  assert.equal(normalizeCreditor(""), "Debt payment");
  assert.equal(normalizeCreditor("   "), "Debt payment");
});

test("rawCreditorLabel prefers merchantDisplayName then merchant then description", () => {
  assert.equal(rawCreditorLabel({ merchantDisplayName: "Amex", merchant: "raw", description: "d" }), "Amex");
  assert.equal(rawCreditorLabel({ merchantDisplayName: undefined, merchant: "raw", description: "d" }), "raw");
  assert.equal(rawCreditorLabel({ merchantDisplayName: "", merchant: "", description: "d" }), "d");
});

test("groupDebtPaymentsByCreditor reconciles Σ and counts, no double-count", () => {
  const payments = [
    dp({ amount: -1000, merchant: "Payment to Chase card ending in 0202 02/27" }),
    dp({ amount: -2000, merchant: "Payment to Chase card ending in 0202 01/10" }),
    dp({ amount: -500,  merchant: "AMERICAN EXPRESS ACH PMT M6410 WEB ID: 2005032111" }),
    dp({ amount: -700,  merchant: "AMERICAN EXPRESS ACH PMT M3518 WEB ID: 2005032111" }),
    dp({ amount: -300,  merchant: "Beacon Mortgage Pmt" }),
  ];
  const groups = groupDebtPaymentsByCreditor(payments, (t) => Math.abs(t.amount));
  assert.equal(groups.length, 3, "3 distinct creditors");
  const total = groups.reduce((s, g) => s + g.value, 0);
  assert.equal(total, 4500, "Σ groups == Σ magnitudes");
  const totalCount = groups.reduce((s, g) => s + g.count, 0);
  assert.equal(totalCount, payments.length, "every row counted exactly once");
  const chase = groups.find((g) => g.label === "Payment To Chase Card")!;
  assert.equal(chase.value, 3000);
  assert.equal(chase.count, 2);
  // Descending by value.
  for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].value >= groups[i].value);
});

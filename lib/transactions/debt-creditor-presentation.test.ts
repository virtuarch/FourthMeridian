/**
 * lib/transactions/debt-creditor-presentation.test.ts   (v2.6-TRUTH-9)
 *
 * The nine standing guards for debt-payment PRESENTATION.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 *
 * "Is this a debt payment?" and "which creditor received it?" are different
 * questions with different authorities. Grouping used to answer the second one
 * from the payment DESCRIPTOR, so 18 rows whose creditor account is permanently
 * unknowable — the user paid two cards on the same day for the same amount —
 * appeared beneath confident headings like "American Express Ach".
 *
 * The total was right. The breakdown claimed more than the evidence carried.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  attributeCreditor, groupDebtPaymentsByCreditor, selectDebtPaymentCashLegs, totalDebtPaid,
  UNRESOLVED_CREDITOR_KEY, UNRESOLVED_CREDITOR_LABEL, type CreditorAccountRef,
} from "./debt-payment-authority";
import { tierResolver, type LiquidityTx } from "./liquidity";

const ACCOUNTS = new Map<string, CreditorAccountRef>([
  ["chk",       { id: "chk",       name: "CHASE COLLEGE",  type: "checking" }],
  ["chaseCard", { id: "chaseCard", name: "CREDIT CARD",    type: "debt" }],
  ["amexCard",  { id: "amexCard",  name: "Platinum Card®", type: "debt" }],
  ["amexSav",   { id: "amexSav",   name: "High Yield Savings Account", type: "savings" }],
]);
const TIERS = tierResolver([...ACCOUNTS.values()].map((a) => ({ id: a.id, type: a.type })));

const row = (o: {
  id: string; amount: number; cp?: string | null;
  maturity?: string | null; merchant?: string; own?: string;
}) => ({
  id: o.id, accountId: o.own ?? "chk", financialAccountId: o.own ?? "chk",
  counterpartyAccountId: o.cp ?? null,
  transferMaturity: o.maturity ?? null,
  amount: o.amount, flowType: "DEBT_PAYMENT", currency: "USD",
  date: "2026-08-03", merchant: o.merchant ?? "m", description: o.merchant ?? "m",
  category: "Other", pending: false,
}) as unknown as LiquidityTx & { id: string };

const abs = (t: { amount: number }) => Math.abs(t.amount);

// The live shapes: 1 nameable creditor, 1 unknowable one.
const CERTAIN = row({ id: "certain", amount: -650, cp: "chaseCard" });
const AMBIGUOUS = row({ id: "ambiguous", amount: -2000, cp: null, maturity: "DEBT_PAYMENT",
                        merchant: "AMERICAN EXPRESS ACH PMT M4082 WEB ID: 2005032111" });

// ── 1 ────────────────────────────────────────────────────────────────────────

test("1. descriptor text never determines creditor identity", () => {
  // Identical evidence, wildly different descriptors — same attribution, always.
  for (const d of [
    "AMERICAN EXPRESS ACH PMT M4082 WEB ID: 2005032111",
    "Payment to Chase card ending in 0202 12/24",
    "AMERICANEXPRESS TRANSFER 000320046315336",
    "Platinum Card payment",
    "zzzz nonsense",
  ]) {
    const a = attributeCreditor({ counterpartyAccountId: null, transferMaturity: "DEBT_PAYMENT" }, ACCOUNTS);
    assert.equal(a.certainty, "ACCOUNT_AMBIGUOUS", `descriptor moved the verdict: ${d}`);
    assert.equal(a.accountId, null, `descriptor named an account: ${d}`);
    const groups = groupDebtPaymentsByCreditor([row({ id: d, amount: -100, maturity: "DEBT_PAYMENT", merchant: d })], ACCOUNTS, abs);
    assert.equal(groups[0].id, UNRESOLVED_CREDITOR_KEY, `descriptor produced a creditor heading: ${d}`);
    assert.equal(groups[0].label, UNRESOLVED_CREDITOR_LABEL);
  }

  // Source proof: the authority may not read a descriptor at all.
  const code = readFileSync(join(process.cwd(), "lib/transactions/debt-payment-authority.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (const forbidden of [/\bmerchant\b/i, /\bdescription\b/i, /institution/i, /normalizeCreditor/]) {
    assert.ok(!forbidden.test(code), `the authority reads a descriptor: ${forbidden}`);
  }
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test("2. account ambiguity never removes a valid debt payment", () => {
  const both = [CERTAIN, AMBIGUOUS];
  const t = totalDebtPaid(both, TIERS, abs);
  assert.equal(t.total, 2650, "an unnameable creditor dropped its payment from the total");
  assert.equal(t.count, 2);
  // …and it is still present in the grouping, under the honest bucket.
  const groups = groupDebtPaymentsByCreditor(both, ACCOUNTS, abs);
  assert.equal(groups.reduce((s, g) => s + g.value, 0), 2650);
  assert.ok(groups.some((g) => g.transactionIds.includes("ambiguous")));
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test("3. grouping cannot change event membership", () => {
  const rows = [CERTAIN, AMBIGUOUS, row({ id: "amex", amount: -300, cp: "amexCard" })];
  const selected = selectDebtPaymentCashLegs(rows, TIERS).counted.map((r) => r.id).sort();
  const grouped = groupDebtPaymentsByCreditor(rows, ACCOUNTS, abs).flatMap((g) => g.transactionIds).sort();
  assert.deepEqual(grouped, selected, "grouping added or dropped rows");
  // Every row lands in EXACTLY one group.
  assert.equal(new Set(grouped).size, grouped.length, "a row appears in two groups");
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test("4. group totals equal the drawer rows they hand over", () => {
  const rows = [CERTAIN, AMBIGUOUS, row({ id: "amex", amount: -300, cp: "amexCard" })];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const g of groupDebtPaymentsByCreditor(rows, ACCOUNTS, abs)) {
    const drawerSum = g.transactionIds.reduce((s, id) => s + Math.abs(byId.get(id)!.amount), 0);
    assert.equal(g.value, drawerSum, `${g.label}: heading ${g.value} ≠ drawer ${drawerSum}`);
    assert.equal(g.count, g.transactionIds.length);
  }
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test("5. Σ(groups) equals the canonical total — the card and its breakdown agree", () => {
  const rows = [CERTAIN, AMBIGUOUS, row({ id: "amex", amount: -300, cp: "amexCard" })];
  const total = totalDebtPaid(rows, TIERS, abs).total;
  const grouped = groupDebtPaymentsByCreditor(rows, ACCOUNTS, abs).reduce((s, g) => s + g.value, 0);
  assert.equal(grouped, total, "the breakdown does not sum to the headline");
});

// ── 6 ────────────────────────────────────────────────────────────────────────

test("6. an unconvertible row leaves BOTH the total and the group, together", () => {
  // V25-FINAL-1 — never a fake 0, and never in one place but not the other.
  const rows = [CERTAIN, AMBIGUOUS];
  const mag = (t: { id: string; amount: number }) => (t.id === "ambiguous" ? null : Math.abs(t.amount));
  const total = totalDebtPaid(rows, TIERS, mag as never);
  const groups = groupDebtPaymentsByCreditor(rows, ACCOUNTS, mag as never);
  assert.equal(total.total, 650);
  assert.equal(total.unconverted, true);
  assert.equal(groups.reduce((s, g) => s + g.value, 0), 650);
  assert.ok(!groups.flatMap((g) => g.transactionIds).includes("ambiguous"));
});

// ── 7 ────────────────────────────────────────────────────────────────────────

test("7. every NAMED creditor group is structurally proven", () => {
  const rows = [CERTAIN, AMBIGUOUS, row({ id: "amex", amount: -300, cp: "amexCard" })];
  for (const g of groupDebtPaymentsByCreditor(rows, ACCOUNTS, abs)) {
    if (g.creditorAccountId === null) continue;              // the honest bucket
    const acct = ACCOUNTS.get(g.creditorAccountId);
    assert.ok(acct, `${g.label} names an account that does not exist`);
    assert.equal(acct!.type, "debt", `${g.label} is not a liability account`);
    assert.equal(g.label, acct!.name, "the heading is not the ACCOUNT's own name");
  }
});

// ── 8 ────────────────────────────────────────────────────────────────────────

test("8. ambiguous rows always appear under the unresolved bucket, which sorts last", () => {
  // The big unnameable group must not outrank a small named creditor: it is a
  // disclosure, not a creditor.
  const rows = [
    row({ id: "small", amount: -1, cp: "chaseCard" }),
    row({ id: "huge", amount: -99999, maturity: "DEBT_PAYMENT" }),
  ];
  const groups = groupDebtPaymentsByCreditor(rows, ACCOUNTS, abs);
  assert.equal(groups[0].creditorAccountId, "chaseCard", "the unresolved bucket outranked a real creditor");
  assert.equal(groups[groups.length - 1].id, UNRESOLVED_CREDITOR_KEY);
  assert.deepEqual(groups[groups.length - 1].transactionIds, ["huge"]);

  // A row with NO destination proof lands there too — never in a named group.
  const none = groupDebtPaymentsByCreditor([row({ id: "n", amount: -5 })], ACCOUNTS, abs);
  assert.equal(none[0].id, UNRESOLVED_CREDITOR_KEY);
  assert.equal(attributeCreditor({}, ACCOUNTS).certainty, "NONE");
});

// ── 9 ────────────────────────────────────────────────────────────────────────

test("9. no React component derives creditor identity", () => {
  const walk = (d: string, out: string[] = []): string[] => {
    let entries: string[] = [];
    try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = `${d}/${e}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
    return out;
  };
  const offenders = ["components", "app"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/"))
    .filter((f) => {
      const code = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      // The retired shape: turning a descriptor into a creditor label.
      return /normalizeCreditor|rawCreditorLabel/.test(code)
          || /creditor[A-Za-z]*\s*=\s*[^;]*\b(merchant|description)\b/i.test(code);
    });
  assert.deepEqual(offenders, [], "these components infer a creditor from a descriptor");

  // And the retired module stays retired.
  const retired = readFileSync(join(process.cwd(), "lib/transactions/debt-payments.ts"), "utf8");
  assert.ok(!/export function (normalizeCreditor|rawCreditorLabel|groupDebtPaymentsByCreditor)/.test(retired),
    "descriptor grouping came back");
});

/**
 * lib/transactions/cash-flow-convergence.test.ts
 *
 * A CARD AND ITS DRAWER MUST NOT DISAGREE.
 *
 * Every Cash Flow grouping function skips a row whose amount cannot be converted
 * (V25-FINAL-1: excluded, never a native relabel or a fake zero). The drill-down
 * re-derived its rows in React with its own predicate — which had no such skip —
 * so a category could LIST a row its own total EXCLUDED.
 *
 * The fix is not a matching predicate. It is identity: each total records the
 * ids it summed, on the same pass and under the same skip rules, and the slice
 * looks those up.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outflowByCategory, incomeBySource } from "./cash-flow";
import { groupDebtPaymentsByCreditor } from "./debt-payments";
import type { Transaction } from "@/types";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

const tx = (over: Partial<Transaction> & { id: string }): Transaction => ({
  date: "2026-02-10", amount: -10, category: "Groceries" as Transaction["category"], description: "x",
  merchant: null, merchantDisplayName: null, flowType: "SPENDING",
  currency: "USD", pending: false, financialAccountId: "a1",
  ...over,
} as unknown as Transaction);

/** The invariant: a slice contains exactly the rows the total summed. */
const sliceOf = (rows: Transaction[], ids: readonly string[]) => {
  const want = new Set(ids);
  return rows.filter((r) => want.has(r.id));
};

// ── SPENDING · total and slice come from ONE pass ─────────────────────────
{
  const rows = [
    tx({ id: "t1", amount: -10, category: "Groceries" }),
    tx({ id: "t2", amount: -15, category: "Groceries" }),
    tx({ id: "t3", amount: -20, category: "Travel" }),
    tx({ id: "t4", amount: 5, category: "Groceries", flowType: "REFUND" }),
    tx({ id: "t5", amount: -99, category: "Groceries", flowType: "TRANSFER" }), // not a cost
  ];
  const groups = outflowByCategory(rows);
  const food = groups.find((g) => g.id === "Groceries")!;

  assert.equal(food.value, 20, "10 + 15 − 5 refund");
  assert.deepEqual(food.transactionIds, ["t1", "t2", "t4"],
    "the ids are exactly the rows that moved the total — the transfer is absent");
  const slice = sliceOf(rows, food.transactionIds);
  assert.equal(slice.length, 3);
  assert.ok(!slice.some((r) => r.id === "t5"), "a transfer is never in the spending slice");
  ok("SPENDING · the slice is exactly the rows the category total summed");
}

// ── THE DEFECT · the skip and the id are the SAME decision ───────────────
//
// `rowAmount` returns null for a row whose currency cannot be converted, and the
// grouping skips it (V25-FINAL-1: excluded, never a native relabel or a fake
// zero). The old React predicate — `t.category === id && isCostFlow(...)` — had
// no such skip, so the drawer listed a row the total had excluded.
//
// Asserted structurally rather than by faking a broken FX context: the id is
// recorded AFTER the skip that governs the value, in the same loop, so no input
// can put a row in one and not the other.
{
  const src = readFileSync(new URL("./cash-flow.ts", import.meta.url), "utf8");
  for (const fn of ["outflowByCategory", "incomeBySource"]) {
    const body = src.slice(src.indexOf(`export function ${fn}`));
    const loop = body.slice(0, body.indexOf("\n}"));
    const skipAt = loop.indexOf("if (raw === null) continue;");
    const idAt = loop.search(/ids\w*\.set\(/);
    assert.ok(skipAt >= 0, `${fn} skips unconvertible rows`);
    assert.ok(idAt > skipAt,
      `${fn}: the id must be recorded AFTER the skip that governs the value`);
  }
  const debt = readFileSync(new URL("./debt-payments.ts", import.meta.url), "utf8");
  assert.ok(debt.indexOf("g.ids.push(t.id)") > debt.indexOf("if (m === null) continue;"),
    "debt payments record the id after the same FX skip");
  ok("the skip and the id are one decision — a row cannot be in the total but not the slice");
}

// ── INCOME · same guarantee ───────────────────────────────────────────────
{
  const rows = [
    tx({ id: "i1", amount: 100, flowType: "INCOME", merchantDisplayName: "Acme" }),
    tx({ id: "i2", amount: 50, flowType: "INCOME", merchantDisplayName: "Acme" }),
    tx({ id: "i3", amount: 70, flowType: "INCOME", merchantDisplayName: "Other" }),
    tx({ id: "i4", amount: -10, flowType: "SPENDING", merchantDisplayName: "Acme" }),
  ];
  const acme = incomeBySource(rows).find((g) => g.id === "Acme")!;
  assert.equal(acme.value, 150);
  assert.deepEqual(acme.transactionIds, ["i1", "i2"], "the cost row is not income");
  const slice = sliceOf(rows, acme.transactionIds);
  assert.equal(slice.reduce((n, r) => n + Math.abs(r.amount), 0), acme.value,
    "Σ the sliced rows === the card total");
  ok("INCOME · Σ sliced rows === the source total, and a cost row never leaks in");
}

// ── DEBT PAYMENTS · same guarantee, including the FX skip ─────────────────
{
  const rows = [
    tx({ id: "d1", amount: -200, merchantDisplayName: "Chase" }),
    tx({ id: "d2", amount: -100, merchantDisplayName: "Chase" }),
    tx({ id: "d3", amount: -75, merchantDisplayName: "Amex" }),
    tx({ id: "d4", amount: -999, merchantDisplayName: "Chase" }), // FX-unavailable
  ];
  const groups = groupDebtPaymentsByCreditor(rows, (t) => (t.id === "d4" ? null : Math.abs(t.amount)));
  const chase = groups.find((g) => g.label.toLowerCase().includes("chase"))!;

  assert.equal(chase.value, 300, "the FX-unavailable row is excluded from the total");
  assert.ok(!chase.transactionIds.includes("d4"), "…and from the slice");
  assert.equal(chase.count, chase.transactionIds.length, "count === the ids it counted");
  ok("DEBT PAYMENTS · an FX-unavailable row leaves both the total and the slice");
}

// ── inflows − outflows === net, from the same rows ────────────────────────
{
  const rows = [
    tx({ id: "n1", amount: 500, flowType: "INCOME", merchantDisplayName: "Pay" }),
    tx({ id: "n2", amount: -120, category: "Groceries" }),
    tx({ id: "n3", amount: -80, category: "Travel" }),
  ];
  const inflow = incomeBySource(rows).reduce((n, g) => n + g.value, 0);
  const outflow = outflowByCategory(rows).reduce((n, g) => n + g.value, 0);
  assert.equal(inflow, 500);
  assert.equal(outflow, 200);
  assert.equal(inflow - outflow, 300, "inflows − outflows === net");
  // …and the identities partition the rows without overlap.
  const inIds = new Set(incomeBySource(rows).flatMap((g) => g.transactionIds));
  const outIds = new Set(outflowByCategory(rows).flatMap((g) => g.transactionIds));
  assert.equal([...inIds].filter((i) => outIds.has(i)).length, 0,
    "no row is counted as both an inflow and an outflow");
  ok("inflows − outflows === net, over disjoint row identities");
}

// ── STATIC · no React re-derivation survives ──────────────────────────────
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const surfaces = [
    "../../components/space/widgets/cash-flow-adapters.tsx",
    "../../components/space/widgets/cashflow/CashFlowWorkspace.tsx",
    "../../components/space/widgets/DebtPaymentsWidget.tsx",
  ];
  for (const rel of surfaces) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    const slices = [...src.matchAll(/sliceFor=\{[^}]*\}/g)].map((m) => m[0]);
    assert.ok(slices.length > 0, `${rel} has slices`);
    for (const s of slices) {
      assert.ok(/byId\(/.test(s), `${rel}: every slice is an identity lookup — got ${s}`);
      for (const forbidden of ["isCostFlow", "isRefund", "isIncome", "classifyLiquidity",
                               "normalizeCreditor", "incomeSourceLabel"]) {
        assert.ok(!s.includes(forbidden),
          `${rel}: a slice must not re-classify (${forbidden})`);
      }
    }
  }
  ok("STATIC · every Cash Flow slice is an identity lookup; React classifies nothing");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`cash-flow-convergence: ${checks.length} checks passed`);

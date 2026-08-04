/**
 * lib/transactions/cash-flow-window-identity.test.ts
 *
 * END-TO-END: every Cash Flow surface reads ONE window and ONE row set.
 *
 * The previous slice made a card and its drawer share one classification pass.
 * This one closes the window: the headline, the chart buckets, the category
 * cards and the drawer must all describe the SAME transactions over the SAME
 * interval — and no component may derive that interval itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCashFlowSpaceData } from "./cash-flow-space-data";
import { resolveFinancialWindow } from "@/lib/perspectives/financial-window";
import { compareToForPreset } from "@/lib/perspectives/time-range";
import type { Transaction } from "@/types";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ASOF = "2026-08-04";
const clock = () => new Date(`${ASOF}T00:00:00`);

const tx = (over: Partial<Transaction> & { id: string; date: string }): Transaction => ({
  amount: -10, category: "Groceries" as Transaction["category"], description: "x",
  merchant: null, merchantDisplayName: null, flowType: "SPENDING",
  currency: "USD", pending: false, financialAccountId: "a1",
  ...over,
} as unknown as Transaction);

const ACCOUNTS = [{ id: "a1", type: "checking" }];

const ROWS: Transaction[] = [
  tx({ id: "in1", date: "2026-07-10", amount: 5_000, flowType: "INCOME", merchantDisplayName: "Payroll" }),
  tx({ id: "out1", date: "2026-07-12", amount: -120, category: "Dining" as Transaction["category"] }),
  tx({ id: "out2", date: "2026-07-20", amount: -80, category: "Dining" as Transaction["category"] }),
  tx({ id: "out3", date: "2026-08-01", amount: -200, category: "Shopping" as Transaction["category"] }),
  tx({ id: "before", date: "2026-05-01", amount: -999, category: "Dining" as Transaction["category"] }),
];

// ── the composer's window IS the canonical FLOW interval ──────────────────
{
  const data = buildCashFlowSpaceData({ transactions: ROWS, accounts: ACCOUNTS, period: "PAST_MONTH", now: clock });
  const w = resolveFinancialWindow({ preset: "PAST_MONTH", asOf: ASOF, compareTo: null });

  assert.equal(data.range.start, w.flow.fromInclusiveISO, "composer start === canonical FLOW start");
  assert.equal(data.range.end, w.flow.toInclusiveISO, "composer end === canonical FLOW end");
  assert.equal(data.range.start, compareToForPreset("PAST_MONTH", ASOF, null),
    "…and the start came from the ONE preset parser");
  ok("the composer's window IS the canonical FLOW interval, from the one parser");
}

// ── one row set: headline, chart, cards and drawer describe the SAME rows ──
{
  const data = buildCashFlowSpaceData({ transactions: ROWS, accounts: ACCOUNTS, period: "PAST_MONTH", now: clock });

  // DRAWER SOURCE — the windowed rows.
  const drawerIds = new Set(data.rows.map((r) => r.id));
  assert.ok(!drawerIds.has("before"), "a row outside the window never reaches any surface");
  assert.equal(drawerIds.size, 4);

  // CARDS — every id a card can slice is one of the windowed rows.
  const cardIds = [
    ...data.outflowByCategory.flatMap((c) => c.transactionIds),
    ...data.incomeBySource.flatMap((c) => c.transactionIds),
  ];
  for (const id of cardIds) {
    assert.ok(drawerIds.has(id), `card id ${id} is a windowed row — cards and drawer share one set`);
  }

  // CHART — buckets are the same projection over the same window.
  const bucketed = data.buckets.reduce((n, b) => n + b.cashOut, 0);
  const headline = data.summary.cashOut;
  assert.ok(Math.abs(bucketed - headline) < 0.005,
    `chart buckets sum to the headline (${bucketed} vs ${headline})`);
  ok("headline, chart, cards and drawer all describe the same windowed rows");
}

// ── inflows − outflows === net ────────────────────────────────────────────
{
  const data = buildCashFlowSpaceData({ transactions: ROWS, accounts: ACCOUNTS, period: "PAST_MONTH", now: clock });
  const s = data.summary;
  assert.ok(Math.abs((s.cashIn - s.cashOut) - (s.cashIn - s.cashOut)) < 0.005);
  // The category cards partition the same money the headline counted.
  const cardOut = data.outflowByCategory.reduce((n, c) => n + c.value, 0);
  const cardIn = data.incomeBySource.reduce((n, c) => n + c.value, 0);
  assert.equal(cardIn, 5_000, "income cards sum to the income in the window");
  assert.equal(cardOut, 400, "spending cards sum to the spending in the window");
  assert.equal(cardIn - cardOut, 4_600, "inflows − outflows === net");
  ok("inflows − outflows === net, over the cards' own totals");
}

// ── the window travels with asOf, not with the wall clock ────────────────
{
  const earlier = buildCashFlowSpaceData({
    transactions: ROWS, accounts: ACCOUNTS, period: "PAST_MONTH",
    now: () => new Date("2026-06-15T00:00:00"),
  });
  assert.notEqual(earlier.range.end, ASOF, "a different as-of yields a different window");
  assert.equal(earlier.range.end, "2026-06-15");
  assert.equal(earlier.range.start, compareToForPreset("PAST_MONTH", "2026-06-15", null));
  ok("the window travels with the selected as-of, through the same parser");
}

// ── STATIC · no Cash Flow component derives a window ──────────────────────
{
  // The CONVERGED surfaces: the workspace and everything it renders.
  const surfaces = [
    "../../components/space/widgets/cashflow/CashFlowWorkspace.tsx",
    "../../components/space/widgets/cashflow/CashFlowHero.tsx",
    "../../components/space/widgets/cashflow/CashFlowInsightsCard.tsx",
  ];
  for (const rel of surfaces) {
    let src: string;
    try { src = strip(readFileSync(new URL(rel, import.meta.url), "utf8")); }
    catch { continue; }
    assert.ok(!/\bperiodRange\s*\(/.test(src),
      `${rel}: a component must not derive a window — call resolveFinancialWindow`);
    assert.ok(!/\bfilterByPeriod\s*\(/.test(src),
      `${rel}: a component must not window rows itself`);
    for (const dateMath of ["subMonths(", "startOfMonth(", "setMonth(", "setFullYear("]) {
      assert.ok(!src.includes(dateMath), `${rel}: no local date math (${dateMath})`);
    }
  }
  // …and the workspace consumes the authority explicitly.
  const ws = strip(readFileSync(
    new URL("../../components/space/widgets/cashflow/CashFlowWorkspace.tsx", import.meta.url), "utf8"));
  assert.ok(/resolveFinancialWindow\(/.test(ws), "the workspace consumes the authority");
  assert.ok(/\.flow\.fromInclusiveISO/.test(ws), "…and explicitly reads the FLOW interval");
  ok("STATIC · no Cash Flow component derives a window; the workspace reads FLOW explicitly");
}

// ── KNOWN GAP, tracked so it cannot grow ─────────────────────────────────
//
// `cash-flow-adapters.tsx` calls `filterByPeriod(transactions, period)` with no
// clock, so `now` defaults to `new Date()` — the WALL CLOCK, not the selected
// as-of. Its six section widgets therefore window against today whatever date
// the user selected.
//
// It is NOT fixed here: the render signature is `(transactions, period, ctx)`
// and `SectionRegistry` carries no as-of, so threading one is a registry change
// — the card-matrix work, deliberately out of this slice.
//
// Pinned rather than ignored: the count is exact, so a NEW wall-clock window
// fails this test even while the known one is outstanding.
{
  const adapters = strip(readFileSync(
    new URL("../../components/space/widgets/cash-flow-adapters.tsx", import.meta.url), "utf8"));
  const debtWidget = strip(readFileSync(
    new URL("../../components/space/widgets/DebtPaymentsWidget.tsx", import.meta.url), "utf8"));

  const unclocked = (src: string) => [...src.matchAll(/filterByPeriod\([^)]*\)/g)]
    .filter((m) => m[0].split(",").length < 3).length;

  assert.equal(unclocked(adapters), 1,
    "exactly ONE wall-clock window in the section adapters (the shared `scoped` helper)");
  assert.ok(/function scoped\(/.test(adapters), "…and it is shared, not scattered");

  // The debt widget uses the workspace's canonical rows WHEN GIVEN; the
  // wall-clock call is only its section-path fallback.
  assert.equal(unclocked(debtWidget), 1, "exactly ONE fallback window in the debt widget");
  assert.ok(/windowRows \?\? filterByPeriod/.test(debtWidget),
    "…and the canonical rows take precedence over it");
  ok("KNOWN GAP · two wall-clock windows remain on the SECTION path, pinned so they cannot grow");
}

// ── STATIC · comparison ranges come from the authority ───────────────────
{
  const ws = strip(readFileSync(
    new URL("../../components/space/widgets/cashflow/CashFlowWorkspace.tsx", import.meta.url), "utf8"));
  const memo = ws.slice(ws.indexOf("const change = useMemo"), ws.indexOf("const displayCurrency"));
  assert.equal((memo.match(/resolveFinancialWindow\(/g) ?? []).length, 2,
    "both the primary and the comparison window come from the authority");
  assert.ok(/cmpWindow[\s\S]{0,200}flow\.fromInclusiveISO[\s\S]{0,120}flow\.toInclusiveISO/.test(memo),
    "the comparison LABEL is the comparison window's own FLOW bounds");
  ok("STATIC · both the primary and comparison ranges come from the canonical authority");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`cash-flow-window-identity: ${checks.length} checks passed`);

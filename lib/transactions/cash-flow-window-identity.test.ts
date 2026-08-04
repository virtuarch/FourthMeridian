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
import { readFileSync, readdirSync } from "node:fs";
import { buildCashFlowSpaceData } from "./cash-flow-space-data";
import { filterByPeriod, asOfAnchor } from "./cash-flow";
import { resolveFinancialWindow, inFlowInterval } from "@/lib/perspectives/financial-window";
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

// ── STATIC · NO widget windows against the wall clock ────────────────────
//
// This replaces a pinned KNOWN GAP. `filterByPeriod(rows, period)` with no third
// argument defaults `now` to `new Date()`, so a section widget showed TODAY's
// period while the dashboard displayed a historical date. The as-of now reaches
// every widget through `SectionRenderProps.asOf`, and the anchor is derived in
// ONE place (`asOfAnchor`).
//
// Repo-wide rather than per-file: the gap was pinned to two known files and the
// real question is whether ANY component re-introduces one.
{
  const WIDGET_DIRS = ["components/space/widgets", "components/space/sections", "components/dashboard"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (e.name.includes(".test.")) continue;
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.tsx?$/.test(e.name)) files.push(`${dir}/${e.name}`);
    }
  };
  WIDGET_DIRS.forEach(walk);

  const offenders: string[] = [];
  for (const f of files) {
    const src = strip(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    for (const m of src.matchAll(/filterByPeriod\(([^)]*)\)/g)) {
      if (m[1].split(",").length < 3) offenders.push(`${f}: ${m[0]}`);
    }
    // `periodRange(period, now?.())` is the same defect wearing a clock's clothes.
    for (const m of src.matchAll(/periodRange\(([^)]*)\)/g)) {
      if (m[1].split(",").length < 2) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    `every widget window must take an explicit anchor; unclocked: ${offenders.join(" | ")}`);
  ok(`STATIC · ${files.length} widget/section/dashboard files, ZERO wall-clock financial windows`);
}

// ── STATIC · the anchor is derived in exactly ONE place ───────────────────
{
  const core = strip(readFileSync(new URL("./cash-flow.ts", import.meta.url), "utf8"));
  assert.ok(/export function asOfAnchor\(/.test(core), "asOfAnchor is exported from the authority");
  assert.ok(/T00:00:00/.test(core.slice(core.indexOf("export function asOfAnchor"))),
    "…and it builds LOCAL midnight, because periodRange does local-time arithmetic");

  // No component may hand-roll the same conversion.
  const rolled: string[] = [];
  for (const f of ["components/space/widgets/cash-flow-adapters.tsx",
                   "components/space/widgets/DebtPaymentsWidget.tsx",
                   "components/space/widgets/CashFlowSummaryWidget.tsx",
                   "components/space/widgets/CashFlowHistoryWidget.tsx"]) {
    const src = strip(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    if (/new Date\(`\$\{asOf\}/.test(src)) rolled.push(f);
  }
  assert.deepEqual(rolled, [], `anchors must come from asOfAnchor, hand-rolled in: ${rolled.join(", ")}`);
  ok("STATIC · one anchor derivation, no hand-rolled duplicates");
}

// ── STATIC · the as-of reaches the widgets through the registry ───────────
{
  const registry = strip(readFileSync(
    new URL("../../components/space/sections/SectionRegistry.tsx", import.meta.url), "utf8"));
  assert.ok(/asOf\?:\s*string/.test(registry), "SectionRenderProps carries the selected as-of");

  const CASH_FLOW_SECTIONS = ["cash_flow_summary", "cash_flow_history", "income_vs_spending",
                              "cash_flow_by_category", "income_by_source", "debt_payments"];
  const missing = CASH_FLOW_SECTIONS.filter((id) => {
    const i = registry.indexOf(`"${id}":`);
    if (i < 0) return true;
    return !registry.slice(i, registry.indexOf("\n", i)).includes("p.asOf");
  });
  assert.deepEqual(missing, [], `every interval section must forward the as-of; missing: ${missing.join(", ")}`);

  const card = strip(readFileSync(
    new URL("../../components/space/sections/SectionCard.tsx", import.meta.url), "utf8"));
  assert.ok(/asOf\?:\s*string/.test(card) && /\basOf\b/.test(card.slice(card.indexOf("render"))),
    "SectionCard accepts the as-of and forwards it to the renderer");

  const shell = strip(readFileSync(
    new URL("../../components/dashboard/SpaceDashboard.tsx", import.meta.url), "utf8"));
  assert.ok(/asOf=\{asOf\}/.test(shell), "the shell supplies its own selected as-of to the section cards");
  ok("STATIC · shell → SectionCard → registry → widget, the as-of is threaded end-to-end");
}

// ── STATIC · the trend hero baseline is anchored to the SERIES, not today ─
{
  const hero = strip(readFileSync(
    new URL("../../components/dashboard/widgets/SpaceTrendHero.tsx", import.meta.url), "utf8"));
  const memo = hero.slice(hero.indexOf("const { latest, delta"), hero.indexOf("if (loading)"));
  assert.ok(!/new Date\(\)/.test(memo),
    "the 30-day baseline may not come from the wall clock — the series ends at the selected as-of");
  assert.ok(/last\.date/.test(memo), "…it is measured back from the last point in the series");
  ok("STATIC · trend-hero delta baseline is anchored to the series end");
}

// ── BEHAVIOURAL · the section window IS the selected window ──────────────
//
// The static probes prove an anchor is PASSED. This proves it is OBEYED: at a
// historical as-of the section path must select the historical month, not the
// month the machine happens to be in.
{
  const rows: Transaction[] = [
    { id: "old", date: "2026-03-14", amount: -10, name: "in window",  category: "Groceries" },
    { id: "new", date: "2026-08-02", amount: -20, name: "today only", category: "Groceries" },
  ] as unknown as Transaction[];

  const historical = filterByPeriod(rows, "MTD", asOfAnchor("2026-03-20"));
  assert.deepEqual(historical.map((r) => r.id), ["old"],
    "a historical as-of selects the historical month");

  const today = filterByPeriod(rows, "MTD", asOfAnchor("2026-08-04"));
  assert.deepEqual(today.map((r) => r.id), ["new"], "…and a current as-of selects the current one");

  // The same rows, through the canonical authority, must agree.
  const w = resolveFinancialWindow({ preset: "PAST_MONTH", asOf: "2026-03-20", compareTo: null });
  const viaAuthority = rows.filter((r) => inFlowInterval(r.date, w.flow));
  assert.ok(viaAuthority.some((r) => r.id === "old") && !viaAuthority.some((r) => r.id === "new"),
    "the canonical FLOW interval agrees with the widget's window on which rows are in scope");
  ok("BEHAVIOURAL · the section window follows the selected as-of, not the wall clock");
}

// ── BEHAVIOURAL · the anchor is LOCAL midnight ───────────────────────────
//
// `new Date("2026-03-01")` is UTC midnight, which is Feb 28 for anyone west of
// Greenwich — a month boundary that moves by a day depending on the viewer.
{
  const a = asOfAnchor("2026-03-01")!;
  assert.equal(a.getFullYear(), 2026, "local year");
  assert.equal(a.getMonth(), 2, "local month is March, not February");
  assert.equal(a.getDate(), 1, "local day is the 1st");
  assert.equal(asOfAnchor(null), undefined, "no selection ⇒ no fabricated anchor");
  assert.equal(asOfAnchor(undefined), undefined, "…and undefined behaves the same");
  ok("BEHAVIOURAL · asOfAnchor builds local midnight and never fabricates a date");
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

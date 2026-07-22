/**
 * components/space/widgets/wealth/wealth-metric-surfaces.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). V25-CLOSE-4A.
 *
 * RENDERS both metric-aware surfaces (renderToStaticMarkup) — a source scan
 * cannot answer "does Liabilities mode draw an assets donut?" or "does the Net
 * Change total equal deltas.totalAssets?". Proves the four verification claims
 * that are checkable off a static render; the interactive claim (switching
 * metrics clears a stale selection panel) is browser-verified and noted in the
 * slice report.
 *
 *   npx tsx components/space/widgets/wealth/wealth-metric-surfaces.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WealthChangeLedger } from "./WealthChangeLedger";
import { WealthCompositionCard } from "./WealthCompositionCard";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import type { WealthMetricKey } from "./WealthTrendChart";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const delta = (abs: number) => ({ abs, pct: null });

/** A comparison result with a known per-component move and per-metric deltas. */
const RESULT: WealthResult = {
  asOf: "2026-07-20", compareTo: "2026-06-20", hasHistory: true, coverageFrom: "2026-01-01",
  asOfState: {
    found: true, date: "2026-07-20", isEstimated: false,
    netWorth: 100_000, totalAssets: 300_000, totalLiabilities: 200_000, liquidNetWorth: 24_000,
    composition: { cash: 20_000, investments: 30_000, crypto: 5_000, real: 245_000, liabilities: 200_000 },
  },
  compareState: {
    found: true, date: "2026-06-20", isEstimated: false,
    netWorth: 88_000, totalAssets: 290_000, totalLiabilities: 202_000, liquidNetWorth: 18_000,
    composition: { cash: 18_000, investments: 27_000, crypto: 4_000, real: 241_000, liabilities: 202_000 },
  },
  deltas: {
    netWorth: delta(12_000), totalAssets: delta(10_000), totalLiabilities: delta(-2_000), liquidNetWorth: delta(6_000),
    composition: { cash: 2_000, investments: 3_000, crypto: 1_000, real: 4_000, liabilities: -2_000 },
  },
  drivers: [
    { id: "real",        label: "Real World Assets", delta: 4_000 },
    { id: "investments", label: "Investments",       delta: 3_000 },
    { id: "cash",        label: "Cash",              delta: 2_000 },
    { id: "liabilities", label: "Liabilities",       delta: -2_000 },
    { id: "crypto",      label: "Crypto",            delta: 1_000 },
  ],
  chart: { points: [], compareSeries: [], asOfDate: "2026-07-20", compareDate: "2026-06-20" },
  completeness: { tier: "observed", label: "Observed", tone: "positive" },
  evidence: null, explanation: null,
} as unknown as WealthResult;

const ACCOUNTS = [
  { id: "a1", name: "Chase Checking", type: "checking",   institution: "Chase",    balance: 20_000, currency: "USD" },
  { id: "a2", name: "Brokerage",      type: "investment",  institution: "Vanguard", balance: 30_000, currency: "USD" },
  { id: "d1", name: "Chase Card",     type: "debt",        institution: "Chase",    balance: 5_000,  currency: "USD", interestRate: 19.99 },
  { id: "d2", name: "Auto Loan",      type: "debt",        institution: "Ally",     balance: 12_000, currency: "USD" },
] as never;

const ledger = (metric: WealthMetricKey) =>
  renderToStaticMarkup(createElement(WealthChangeLedger, { result: RESULT, currency: "USD", metric }));
const card = (metric: WealthMetricKey) =>
  renderToStaticMarkup(createElement(WealthCompositionCard, { result: RESULT, currency: "USD", accounts: ACCOUNTS, metric }));

function main(): void {
  console.log("Change ledger — heading names the selected metric");
  check("Net Worth → 'What moved your net worth?'", ledger("netWorth").includes("What moved your net worth?"));
  check("Assets → 'What moved your assets?'", ledger("totalAssets").includes("What moved your assets?"));
  check("Liabilities → 'What moved your liabilities?'", ledger("totalLiabilities").includes("What moved your liabilities?"));
  check("Liquid → 'What moved your liquid net worth?'", ledger("liquidNetWorth").includes("What moved your liquid net worth?"));

  console.log("Change ledger — Net Change reconciles to the metric's delta");
  // deltas: netWorth 12,000 · assets 10,000 · liabilities 2,000 · liquid 6,000
  check("Net Worth total shows 12,000", ledger("netWorth").includes("12,000"));
  check("Assets total shows 10,000 (not 12,000)",
    ledger("totalAssets").includes("10,000") && !ledger("totalAssets").includes("12,000"));
  check("Liabilities total shows 2,000 (not 12,000)",
    ledger("totalLiabilities").includes("2,000") && !ledger("totalLiabilities").includes("12,000"));
  check("Liquid total shows 6,000 (not 12,000)",
    ledger("liquidNetWorth").includes("6,000") && !ledger("liquidNetWorth").includes("12,000"));

  console.log("Change ledger — drivers filtered to the metric's components");
  check("Assets ledger shows no Liabilities driver row",
    !ledger("totalAssets").includes(">Liabilities<"));
  check("Liabilities ledger shows the Liabilities driver row",
    ledger("totalLiabilities").includes(">Liabilities<"));
  check("Liabilities ledger omits the asset drivers (no Crypto row)",
    !ledger("totalLiabilities").includes(">Crypto<"));
  check("Liquid ledger shows Cash but not Crypto",
    ledger("liquidNetWorth").includes(">Cash<") && !ledger("liquidNetWorth").includes(">Crypto<"));

  console.log("Composition card — regime follows the metric");
  const nw = card("netWorth");
  const assets = card("totalAssets");
  const liab = card("totalLiabilities");
  const liquid = card("liquidNetWorth");

  check("Net Worth shows the liabilities contribution row", nw.includes("Liabilities (shown separately)"));
  check("Assets does NOT show the liabilities contribution row", !assets.includes("Liabilities (shown separately)"));

  check("Liabilities mode shows debt composition (a debt account)",
    liab.includes("Chase Card") || liab.includes("Auto Loan"));
  check("Liabilities mode draws NO asset-class donut (no 'asset class' noun)",
    !liab.toLowerCase().includes("asset class"));
  check("Liabilities mode shows the current-only note",
    liab.includes("Current classification"));

  check("Liquid mode shows the reachability ladder (Available now)",
    liquid.includes("Available now"));
  check("Liquid mode is current-only",
    liquid.includes("Current classification"));
  check("Liquid mode draws no asset-class donut",
    !liquid.toLowerCase().includes("asset class"));

  console.log("Composition card — the (asset-only) grouping switcher shows in asset regimes only");
  // The Dropdown renders its selected label + an aria-label; options only appear
  // once opened, so presence is proven via the switcher's stable aria-label.
  const SWITCHER = 'aria-label="Composition grouping"';
  check("Net Worth regime shows the grouping switcher", nw.includes(SWITCHER));
  check("Assets regime shows the grouping switcher", assets.includes(SWITCHER));
  check("Liabilities regime does NOT show the grouping switcher", !liab.includes(SWITCHER));
  check("Liquid regime does NOT show the grouping switcher", !liquid.includes(SWITCHER));

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

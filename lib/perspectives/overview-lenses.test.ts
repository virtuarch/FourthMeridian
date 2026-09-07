/**
 * lib/perspectives/overview-lenses.test.ts  (OVERVIEW-CONSOLIDATION)
 *
 * The consolidated Overview information architecture:
 *
 *   Overview:   Net Worth | Cash Flow
 *   Net Worth:  Total | Assets | Debt      (Assets contains Cash + Investments)
 *
 * Proves the lens rail, the registry ↔ renderer parity, the legacy-URL
 * resolution, the declarative per-mode data gating, the sidebar anchor
 * validity (every published row has an element; Debt publishes no absent
 * section), the one-emitter trust rule, and that Cash Flow / Total are untouched.
 *
 *   npx tsx lib/perspectives/overview-lenses.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { openPerspectiveDataNeeds } from "@/lib/space/workspace-resources";
import { CORE_LENS_IDS, NET_WORTH_LENS_ID, resolveUrlLens } from "@/lib/space/use-space-navigation";
import { WORKSPACE_RENDERERS } from "@/components/space/workspaces/workspaceRenderers";
import { assetsSections, WEALTH_TOTAL_SECTIONS } from "@/components/space/widgets/wealth/WealthWorkspace";
import { debtSections } from "@/components/space/widgets/debt/DebtWorkspace";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const WEALTH = read("components/space/widgets/wealth/WealthWorkspace.tsx");
const WEALTHC = strip(WEALTH);
const DEBT = read("components/space/widgets/debt/DebtWorkspace.tsx");
const LIQ = strip(read("components/space/widgets/liquidity/LiquidityWorkspace.tsx"));
const INV = strip(read("components/space/widgets/investments/InvestmentsWorkspace.tsx"));
const CASHFLOW = read("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
const HOST = strip(read("components/dashboard/SpaceDashboard.tsx"));
const CHART = strip(read("components/space/widgets/wealth/WealthTrendChart.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. Overview exposes only Net Worth + Cash Flow");
check("the default lens is Net Worth", NET_WORTH_LENS_ID === "networth");
check("the only other engageable lens is Cash Flow", CORE_LENS_IDS.join() === "cashFlow");
check("liquidity / investments / debt are not lens-rail ids", !CORE_LENS_IDS.some((id) => ["liquidity", "investments", "debt"].includes(id)));
check("the host builds the rail from NET_WORTH_LENS_ID + CORE_LENS_IDS only",
  HOST.includes("id: NET_WORTH_LENS_ID") && HOST.includes("CORE_LENS_IDS.map"));

console.log("2. Registry ↔ renderer parity");
{
  const rendererIds = Object.keys(WORKSPACE_RENDERERS).sort();
  check("renderer map is exactly {cashFlow, wealth}", rendererIds.join() === "cashFlow,wealth");
  check("every renderer id is a registered, available perspective",
    rendererIds.every((id) => PERSPECTIVE_LIBRARY[id]?.kind === "perspective" && PERSPECTIVE_LIBRARY[id].status === "available"));
  check("every lens-rail destination has a renderer (Net Worth → wealth, Cash Flow → cashFlow)",
    !!WORKSPACE_RENDERERS.wealth && CORE_LENS_IDS.every((id) => !!WORKSPACE_RENDERERS[id]));
  check("the retired peer lenses keep their registry entries (engine lenses / verdicts still read them)",
    ["liquidity", "investments", "debt"].every((id) => PERSPECTIVE_LIBRARY[id]?.status === "available"));
  check("…but have NO renderer of their own", ["liquidity", "investments", "debt"].every((id) => !WORKSPACE_RENDERERS[id]));
}

console.log("3. Old liquidity / investments / debt URLs resolve into the new IA");
{
  const liq = resolveUrlLens({ tab: "overview", perspective: "liquidity" });
  const inv = resolveUrlLens({ tab: "overview", perspective: "investments" });
  const debt = resolveUrlLens({ tab: "overview", perspective: "debt" });
  check("?perspective=liquidity → no engaged lens, Assets / Cash", liq.perspective === null && liq.legacy?.mode === "assets" && liq.legacy.slice === "cash");
  check("?perspective=investments → Assets / Investments", inv.perspective === null && inv.legacy?.mode === "assets" && inv.legacy.slice === "investments");
  check("?perspective=debt → Debt", debt.perspective === null && debt.legacy?.mode === "debt");
  const tabDebt = resolveUrlLens({ tab: "debt", perspective: null });
  const tabCredit = resolveUrlLens({ tab: "credit", perspective: null });
  const tabInv = resolveUrlLens({ tab: "investments", perspective: null });
  check("older ?tab=debt / ?tab=credit → Net Worth → Debt", tabDebt.legacy?.mode === "debt" && tabCredit.legacy?.mode === "debt");
  check("older ?tab=investments → Net Worth → Assets / Investments", tabInv.legacy?.mode === "assets" && tabInv.legacy.slice === "investments");
  const cf = resolveUrlLens({ tab: "overview", perspective: "cash-flow" });
  check("?perspective=cash-flow still engages Cash Flow", cf.perspective === "cashFlow" && cf.legacy === null);
  const none = resolveUrlLens({ tab: "overview", perspective: null });
  check("no perspective ⇒ Net Worth default, no legacy", none.perspective === null && none.legacy === null);
  const wealth = resolveUrlLens({ tab: "overview", perspective: "wealth" });
  check("?perspective=wealth canonicalises to the Net Worth default", wealth.perspective === null && wealth.legacy === null);
}

console.log("4. Declarative per-mode data gating (the union the consolidated page needs)");
{
  const total = openPerspectiveDataNeeds("OVERVIEW", "wealth", "total");
  const assets = openPerspectiveDataNeeds("OVERVIEW", "wealth", "assets");
  const debt = openPerspectiveDataNeeds("OVERVIEW", "wealth", "debt");
  check("Total needs accounts + snapshots only (no eager transaction read)", [...total].sort().join() === "accounts,snapshots");
  check("Assets adds transactions + lens + investmentsHistory (the former Liquidity + Investments needs)",
    [...assets].sort().join() === "accounts,investmentsHistory,lens,snapshots,transactions");
  check("Debt adds lens + fico (the former Debt needs)", [...debt].sort().join() === "accounts,fico,lens,snapshots");
  check("no mode ⇒ base needs (behaviour-preserving)", [...openPerspectiveDataNeeds("OVERVIEW", "wealth")].sort().join() === "accounts,snapshots");
  check("Cash Flow is unaffected by mode", [...openPerspectiveDataNeeds("OVERVIEW", "cashFlow", "assets")].sort().join() === "accounts,transactions");
  check("the host passes the mode into the gate", HOST.includes("openPerspectiveDataNeeds(activeTab, activePerspectiveId, wealthMode)"));
}

console.log("5. Sidebar — every published anchor renders");
{
  const idsIn = (src: string) => new Set([...src.matchAll(/\bid=["']([a-z-]+)["']/g)].map((m) => m[1]));
  const wealthIds = idsIn(WEALTHC);
  const liqIds = idsIn(LIQ);
  const invIds = idsIn(INV);
  const debtIds = idsIn(strip(DEBT));
  check("Total publishes Summary → Balance history → Composition → What moved it → Explanation",
    WEALTH_TOTAL_SECTIONS.map((s) => s.label).join(" · ") === "Summary · Balance history · Composition · What moved it · Explanation");
  check("every Total anchor is an id in WealthWorkspace", WEALTH_TOTAL_SECTIONS.every((s) => s.anchor && wealthIds.has(s.anchor)));
  const assets = assetsSections({ hasHistory: true });
  check("Assets publishes the wealth slots + Cash + Investments",
    assets.map((s) => s.label).join(" · ") === "Summary · Balance history · Composition · What moved it · Cash · Investments");
  check("every Assets anchor is an id in WealthWorkspace", assets.every((s) => s.anchor && wealthIds.has(s.anchor)));
  check("with no snapshot history Assets publishes only Cash + Investments (the sections that still render)",
    assetsSections({ hasHistory: false }).map((s) => s.label).join() === "Cash,Investments");
  check("Explanation is Total-only (not an Assets anchor)", !assets.some((s) => s.label === "Explanation"));
  check("the embedded sections keep their inner ids for deep anchors", liqIds.has("liquidity-sources") && invIds.has("investments-holdings"));
  // Debt — the pre-existing absent-anchor bug is fixed.
  const full = debtSections({ hasLiabilities: true, hasDebt: true });
  const paidOff = debtSections({ hasLiabilities: true, hasDebt: false });
  const none = debtSections({ hasLiabilities: false, hasDebt: false });
  check("Debt (owing) publishes all six", full.map((s) => s.label).join(" · ") === "Summary · Balance history · Liabilities · Cost & risk · Payoff · Credit health");
  check("Debt (all paid off) keeps the STRUCTURAL Liabilities row, drops Cost & risk + Payoff",
    paidOff.map((s) => s.label).join(" · ") === "Summary · Balance history · Liabilities · Credit health");
  check("Debt (no liability accounts) drops Liabilities too", none.map((s) => s.label).join(" · ") === "Summary · Balance history · Credit health");
  check("every Debt anchor is an id in DebtWorkspace", full.every((s) => s.anchor && debtIds.has(s.anchor)));
  check("the liabilities ledger gate matches the anchor gate (liabilityCount > 0)", DEBT.includes("{liabilityCount > 0 && (") && DEBT.includes("hasLiabilities = liabilityCount > 0"));
  check("the cost/payoff gate matches the anchor gate (hasDebt)", DEBT.includes("{hasDebt && (") && DEBT.includes("debtSections({ hasLiabilities, hasDebt })"));
  check("embedded Cash / Investments publish nothing (one publisher per mode)", LIQ.includes("if (embedded) return;") && INV.includes("if (embedded) return;"));
  check("in Debt mode the Net Worth workspace publishes nothing (DebtWorkspace does)", /if \(mode === "debt"\) return;\s*publishSections\(/.test(WEALTHC));
}

console.log("6. Trust — ONE shell envelope per mode, per-figure disclosures kept");
{
  check("Total/Assets: WealthWorkspace emits; Debt: it yields to DebtWorkspace", /if \(mode === "debt"\) return;\s*onEnvelopeChange\(envelope\)/.test(WEALTHC));
  check("the embedded Cash section has no shell callback wired", !/onEnvelopeChange=/.test(WEALTHC.slice(WEALTHC.indexOf("<LiquidityWorkspace"), WEALTHC.indexOf("<InvestmentsWorkspace"))));
  check("the embedded Investments section has no shell callback wired", !/onEnvelopeChange=/.test(WEALTHC.slice(WEALTHC.indexOf("<InvestmentsWorkspace"), WEALTHC.indexOf("</section>", WEALTHC.indexOf("<InvestmentsWorkspace")))));
  check("the unified chart carries the Investments per-point basis through", CHART.includes("investedSeries") && WEALTHC.includes("buildPortfolioValueSeries("));
}

console.log("7. Total stays net-worth scoped; Liquid NW survives as a stat");
{
  const RESULT = {
    asOf: "2026-07-20", compareTo: "2026-06-20", hasHistory: true, coverageFrom: "2026-01-01",
    asOfState: { found: true, date: "2026-07-20", isEstimated: false, netWorth: 100, totalAssets: 300, totalLiabilities: 200, liquidNetWorth: 24, cash: 20, invested: 35,
      composition: { cash: 20, investments: 30, crypto: 5, real: 245, liabilities: 200 } },
    compareState: { found: true, date: "2026-06-20", isEstimated: false, netWorth: 88, totalAssets: 290, totalLiabilities: 202, liquidNetWorth: 18, cash: 18, invested: 31,
      composition: { cash: 18, investments: 27, crypto: 4, real: 241, liabilities: 202 } },
    deltas: { netWorth: { abs: 12, pct: null }, totalAssets: { abs: 10, pct: null }, totalLiabilities: { abs: -2, pct: null }, liquidNetWorth: { abs: 6, pct: null },
      cash: { abs: 2, pct: null }, invested: { abs: 4, pct: null }, composition: { cash: 2, investments: 3, crypto: 1, real: 4, liabilities: -2 } },
    drivers: [], chart: { points: [], compareSeries: [], asOfDate: "2026-07-20", compareDate: "2026-06-20" },
    completeness: { tier: "observed", label: "Observed", tone: "positive" }, evidence: null, explanation: null, basis: null,
  } as unknown as WealthResult;
  const hero = (metric: "netWorth" | "totalAssets") =>
    renderToStaticMarkup(createElement(WealthHero, { result: RESULT, currency: "USD", envelope: {}, metric }));
  const total = hero("netWorth");
  const assets = hero("totalAssets");
  check("Total headline is Net worth", total.includes("Net worth") && total.includes("$100"));
  check("Total secondary stats: Assets · Liabilities · Liquid NW", total.includes("Assets") && total.includes("Liabilities") && total.includes("Liquid NW") && total.includes("$24"));
  check("Assets headline is Total assets", assets.includes("Total assets") && assets.includes("$300"));
  check("Assets secondary stats: Cash · Investments (disjoint dimensions)", assets.includes("Cash") && assets.includes("Investments") && assets.includes("$20") && assets.includes("$35"));
  check("Explanation renders only in Total", /mode === "total" && \([\s\S]*?<WealthExplanationCard/.test(WEALTHC));
  check("Total does NOT mount the Cash / Investments sections (mode === \"assets\" gate)", WEALTHC.includes('mode === "assets" ? (') );
  check("the page-level selector is Total | Assets | Debt (Chips, WEALTH_MODES)", WEALTHC.includes("WEALTH_MODES.map") && WEALTHC.includes('ariaLabel="Net worth view"'));
  check("the chart header no longer owns a metric switcher", !CHART.includes("<Chips") && CHART.includes("headerRight={headerRight}"));
}

console.log("8. Cash Flow is unchanged");
{
  check("Cash Flow sections unchanged", /Summary[\s\S]*cashflow-summary[\s\S]*Activity[\s\S]*cashflow-activity[\s\S]*Spending[\s\S]*cashflow-spending[\s\S]*Income[\s\S]*cashflow-income[\s\S]*What changed[\s\S]*cashflow-insights/.test(CASHFLOW));
  check("Cash Flow still composes hero + summary + history + spending + debt payments + income + insights",
    ["<CashFlowHero", "<CashFlowSummaryWidget", "<CashFlowHistoryWidget", "<DebtPaymentsWidget", "<CashFlowCategoryLedger", "<CashFlowInsightsCard"].every((n) => CASHFLOW.includes(n)));
  check("Cash Flow renderer entry unchanged (period / asOf / compareTo / onSelectPeriod / envelope)",
    /cashFlow: \(ctx\) => \([\s\S]*?period=\{ctx\.cashFlowPeriod\}[\s\S]*?onSelectPeriod=\{ctx\.onSelectCashFlowPeriod\}[\s\S]*?onEnvelopeChange=\{ctx\.onEnvelopeChange\}/.test(read("components/space/workspaces/workspaceRenderers.tsx")));
}

if (failures > 0) { console.error(`\n${failures} overview-lenses check(s) failed`); process.exit(1); }
console.log("\nAll overview-lenses checks passed");

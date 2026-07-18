/**
 * components/space/widgets/investments/InvestmentsWorkspace.test.ts
 *
 * SD-4 (final) durable-invariant ratchets for the Investments WORKSPACE (pure, DB-free).
 * TEST-3 cleanup: brittle layout (grid-cols/h-[)/JSX-source-order/interaction-handler
 * pins removed; the durable invariants kept: data OWNERSHIP + envelope BRIDGE;
 * SpaceSnapshot valuation chart (no double-count, no N×date sampler, crypto-once);
 * display-currency + hook honesty; SHARED holdings grid/detail reused by inline Section
 * AND Modal (no divergent impls, single overlay); contract boundary; do-not-fake.
 *
 *   npx tsx components/space/widgets/investments/InvestmentsWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/investments";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC     = read(`${DIR}/InvestmentsWorkspace.tsx`);
const CODE    = strip(SRC);
const KPI     = strip(read(`${DIR}/InvestmentKpiStrip.tsx`));
const HOOK    = read(`${DIR}/useInvestmentsSpaceData.ts`);
const ROUTE   = read("app/api/spaces/[id]/investments/space-data/route.ts");
const ALLOC   = strip(read(`${DIR}/InvestmentAllocationPanel.tsx`));
const CONV    = read("lib/investments/display-conversion.ts");
const SERIES  = strip(read("lib/investments/portfolio-series.ts"));
// The LIVE balance-history component (owns the window clip); the old PortfolioValueChart
// is retired from the composition.
const CHART   = strip(read(`${DIR}/InvestmentsBalanceHistory.tsx`));
const GRID    = strip(read(`${DIR}/HoldingsGrid.tsx`));
const DETAIL  = strip(read(`${DIR}/HoldingDetail.tsx`));
const SECTION = strip(read(`${DIR}/HoldingsSection.tsx`));
const MODAL   = strip(read(`${DIR}/HoldingsModal.tsx`));
const ROUTEC  = strip(ROUTE);
const HOSTC   = strip(read("components/dashboard/SpaceDashboard.tsx"));
// SD-2 closeout — perspective render impls live in the component-layer renderer map.
const REND    = strip(read("components/space/workspaces/workspaceRenderers.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. Render boundary — composes its EDITORIAL research surfaces (v2)");
{
  const LEDGER = strip(read(`${DIR}/HoldingsLedger.tsx`));
  const BALANCE = strip(read(`${DIR}/InvestmentsBalanceHistory.tsx`));
  const WEALTHCHART = strip(read("components/space/widgets/wealth/WealthTrendChart.tsx"));
  // v2 research surfaces: hero → balance history → this period → holdings → allocation
  // → concentration → activity.
  for (const surface of [
    "<InvestmentsHero", "<InvestmentsBalanceHistory", "<InvestmentsBridgeCard",
    "<HoldingsLedger", "<InvestmentAllocationPanel", "<HoldingsConcentration", "<InvestmentsActivityCard",
  ]) {
    check(`composes ${surface}`, SRC.includes(surface));
  }
  // The dense KPI strip, the card grid, and the OLD chart are retired from the
  // composition (value/coverage → hero; grid → ledger; chart → shared TrendChart).
  for (const gone of ["<InvestmentKpiStrip", "<HoldingsSection", "<PortfolioValueChart"]) {
    check(`no longer composes ${gone}`, !SRC.includes(gone));
  }
  // Balance history uses the SAME chart core as Net Worth — one chart, not two.
  check("balance history + Net Worth share the ONE TrendChart core (no duplicate chart)",
    BALANCE.includes("TrendChart") && WEALTHCHART.includes("TrendChart"));
  // Holdings: top-few by value + "View all" opens the LeftPanel browser; a row opens
  // the RightPanel detail. The bar IS the allocation view (share of portfolio).
  check("ledger shows a top subset + View all → LeftPanel browser",
    LEDGER.includes("slice(0, topN") && LEDGER.includes("LeftPanel") && LEDGER.includes("View all"));
  check("ledger opens detail in the Atlas RightPanel + reuses HoldingDetail",
    LEDGER.includes("RightPanel") && LEDGER.includes("<HoldingDetail"));
  check("ledger renders inline weight bars from row.share", LEDGER.includes("row.share"));
  // Allocation vs Concentration are DISTINCT surfaces; the panel's inline concentration
  // line is suppressed so it isn't said twice.
  check("allocation suppresses its inline concentration line (dedicated widget renders it)",
    SRC.includes("showConcentrationInsight={false}"));
  // Editorial rhythm + section anchors published to the sidebar (like Net Worth).
  check("editorial layout with section anchors", CODE.includes("space-y-8") && CODE.includes("useSpaceSectionsPublisher"));
}

console.log("2. Data OWNERSHIP + envelope BRIDGE");
{
  check("Workspace owns the hook", CODE.includes("useInvestmentsSpaceData("));
  check("host does NOT call the hook", !HOSTC.includes("useInvestmentsSpaceData"));
  check("host retains no Investments data", !HOSTC.includes("investments.data"));
  check("Workspace emits envelope via canonical resolver", CODE.includes("onEnvelopeChange(") && CODE.includes("resolvePerspectiveEnvelope("));
  check("renderer wires envelope up + host relays it (consolidated)",
    REND.includes("<InvestmentsWorkspace") && REND.includes("onEnvelopeChange={ctx.onEnvelopeChange}") && HOSTC.includes("useActiveEnvelope"));
  check("renderer map mounts <InvestmentsWorkspace> + host dispatches via WORKSPACE_RENDERERS",
    REND.includes("<InvestmentsWorkspace") && HOSTC.includes("WORKSPACE_RENDERERS["));
}

console.log("3. Valuation chart — canonical SpaceSnapshot series, no double-count, no N×date");
{
  check("route builds the series from SpaceSnapshot (getRecentSnapshots + buildPortfolioValueSeries)",
    ROUTE.includes("getRecentSnapshots") && ROUTE.includes("buildPortfolioValueSeries"));
  check("series value = investments + crypto (disjoint buckets, each once)",
    SERIES.includes("totalInvestments + s.totalCrypto"));
  check("series drops fxMiss points (honest)", SERIES.includes("fxMiss"));
  check("NO per-date valuation sampler (getInvestmentValueAsOf) in route or series",
    !ROUTEC.includes("getInvestmentValueAsOf") && !SERIES.includes("getInvestmentValueAsOf"));
  check("chart does NOT reconstruct from holdings", !CHART.includes("getCurrentPositions") && !CHART.includes("holdings"));
  check("chart responds to the time window (clips to asOf / compareTo)",
    CHART.includes("p.date <= asOf") && CHART.includes("compareTo"));
  check("Workspace display-converts the series (convertPortfolioValueSeries)", CODE.includes("convertPortfolioValueSeries("));
  check("hook exposes the series", HOOK.includes("series"));
}

console.log("4. Display currency + activation + hook honesty");
{
  check("Workspace converts the contract (convertInvestmentsSpaceData)", CODE.includes("convertInvestmentsSpaceData("));
  check("transform identity when reporting === target", CONV.includes("from === ctx.target") && CONV.includes("return data"));
  check("reads current + historical + trust", CODE.includes("data.current") && CODE.includes("data.historical") && CODE.includes("data.trust"));
  check("no raw-loader call in the Workspace", !CODE.includes("getCurrentPositions") && !CODE.includes("getInvestmentsTimeMachine"));
  check("hook honesty guards intact", HOOK.includes("compareTo < asOf") && HOOK.includes("if (!active) return") && !HOOK.includes("setData(null)"));
}

console.log("5. Holdings — inline reuses the shared grid, shows a subset");
{
  check("inline default renders the shared grid (no divergent impl)", SECTION.includes("<HoldingsGrid"));
  check("inline shows a top subset only (slice)", SECTION.includes("slice(0,"));
}

console.log("6. SHARED holdings components — one grid/detail, single overlay");
{
  check("modal reuses the SHARED HoldingsGrid + HoldingDetail", MODAL.includes("<HoldingsGrid") && MODAL.includes("<HoldingDetail"));
  check("modal renders exactly ONE GlassModal (no nested/second overlay)", (MODAL.match(/<GlassModal/g) || []).length === 1 && !MODAL.includes("<HoldingsModal"));
  check("section AND modal import the SAME shared grid + detail (no divergent impls)",
    SECTION.includes('from "./HoldingsGrid"') && SECTION.includes('from "./HoldingDetail"') &&
    MODAL.includes('from "./HoldingsGrid"') && MODAL.includes('from "./HoldingDetail"'));
}

console.log("7. Contract boundary — no ad hoc asset-detail fetches in cards");
{
  for (const [name, code] of [["HoldingsGrid", GRID], ["HoldingDetail", DETAIL], ["HoldingsSection", SECTION]] as const) {
    check(`${name} does not fetch ad hoc`, !code.includes("fetch(") && !code.includes("useInvestmentsSpaceData") && !/prisma|@\/lib\/db/.test(code));
  }
}

console.log("8. DO NOT FAKE DATA");
{
  const FORBIDDEN = ["IRR", "Sharpe", "S&P", "VTI", "Benchmark", "Best Month", "Worst Month", "Realized", "Unrealized", "Held since"];
  for (const t of FORBIDDEN) {
    check(`KPI does not render "${t}"`, !KPI.includes(t));
    check(`holding detail does not render "${t}"`, !DETAIL.includes(t));
  }
  check("income disclosed as combined", KPI.includes("combined"));
  check("detail uses honest 'Value vs cost' (native, not unrealized)", DETAIL.includes("Value vs cost"));
  check("allocation keeps dropdown + shared donut (unchanged, §15)", ALLOC.includes("<select") && ALLOC.includes("BreakdownWidget"));
}

if (failures > 0) { console.error(`\n${failures} InvestmentsWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll InvestmentsWorkspace checks passed");

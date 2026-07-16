/**
 * components/space/widgets/cashflow/CashFlowWorkspace.test.ts  (SD-6C)
 *
 * Source-scan tests for the Cash Flow Workspace extraction (house pattern — pure,
 * DB-free, no live services). These lock the SD-6C contract without rendering React:
 *
 *   1. CashFlowWorkspace is the render boundary (host mounts it; old Perspective gone).
 *   2. CashFlowSpaceData is the composition boundary (buildCashFlowSpaceData, once).
 *   3. The workspace duplicates NO projection (no filterByPeriod / aggregate / project /
 *      bucket in the workspace — those come from the contract).
 *   4. Canonical time is preserved (period + onSelectPeriod props; no local date
 *      authority; the host still derives cashFlowPeriod).
 *   5. The Calendar Heatmap is retained via the metric-agnostic CalendarHeatmapGrid.
 *   6. Semantic slice controls (perspective/filter) are workspace-owned (relocated).
 *   7. Calendar / Cards modes are workspace-owned (inside the History widget).
 *   8. Display currency (FX) is not regressed (txCtx threaded as moneyCtx + ctx).
 *   9. The old Cash Flow host composition is retired/reduced.
 *
 *   npx tsx components/space/widgets/cashflow/CashFlowWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const WS   = read("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
const DASH = read("components/dashboard/SpaceDashboard.tsx");
const CAL  = read("components/space/widgets/CashFlowCalendar.tsx");
const HIST = read("components/space/widgets/CashFlowHistoryWidget.tsx");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. CashFlowWorkspace is the render boundary");
{
  check("host imports CashFlowWorkspace", DASH.includes('import { CashFlowWorkspace } from "@/components/space/widgets/cashflow/CashFlowWorkspace"'));
  check("host mounts <CashFlowWorkspace", DASH.includes("<CashFlowWorkspace"));
  check("host no longer imports the old cashflow/CashFlowPerspective", !DASH.includes("cashflow/CashFlowPerspective"));
  check("host no longer references CashFlowPerspectiveWorkspace", !DASH.includes("CashFlowPerspectiveWorkspace"));
  const branchIdx  = DASH.indexOf('activePerspectiveId === "cashFlow"');
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("cashFlow branch exists and precedes the generic virtual-sections branch", branchIdx >= 0 && genericIdx > branchIdx);
}

console.log("2. CashFlowSpaceData is the composition boundary");
{
  check("imports buildCashFlowSpaceData", WS.includes('from "@/lib/transactions/cash-flow-space-data"') && WS.includes("buildCashFlowSpaceData"));
  check("builds the contract exactly once", count(WS, "buildCashFlowSpaceData(") === 1);
  // Every panel is fed from the contract slices — not raw re-projection.
  check("Summary fed data.summary + data.context", WS.includes("facts={data?.summary}") && WS.includes("context={data?.context}"));
  check("History fed data.daily + data.buckets", WS.includes("daily={data?.daily}") && WS.includes("buckets={data?.buckets}"));
  check("windowed rows threaded from the contract", WS.includes("windowRows={data?.rows}"));
  check("Spending fed data.outflowByCategory", WS.includes("items={data.outflowByCategory}"));
  check("Income fed data.cashInByReason / data.incomeBySource", WS.includes("data.cashInByReason") && WS.includes("items={data.incomeBySource}"));
}

console.log("3. The workspace duplicates NO canonical projection");
{
  for (const banned of ["filterByPeriod(", "aggregateDayFacts(", "projectDailyFacts(", "bucketDayFacts("]) {
    check(`workspace does not call ${banned} (comes from the contract)`, !WS.includes(banned));
  }
}

console.log("4. Canonical time is preserved (no duplicate date authority)");
{
  check("workspace receives period as a prop", WS.includes("period:") && WS.includes("period={period}"));
  check("workspace receives onSelectPeriod as a prop", WS.includes("onSelectPeriod:"));
  check("workspace does NOT own a local period/date authority", !WS.includes("useState<CashFlowPeriod") && !WS.includes("usePerspectiveShellState") && !WS.includes("cashFlowExplicitPeriod"));
  check("host still derives the canonical cashFlowPeriod", DASH.includes("const cashFlowPeriod"));
  check("workspace passes canonical period to buildCashFlowSpaceData", WS.includes("period,") && WS.includes("buildCashFlowSpaceData({ transactions, accounts, period"));
}

console.log("5. Calendar Heatmap retained via metric-agnostic CalendarHeatmapGrid");
{
  check("Calendar imports the shared CalendarHeatmapGrid", CAL.includes('from "@/components/space/widgets/shared/CalendarHeatmapGrid"'));
  check("Calendar renders <CalendarHeatmapGrid", CAL.includes("<CalendarHeatmapGrid"));
  check("no mode= coupling on the grid (domain content supplied from outside)", !CAL.includes('mode="cashflow"') && !CAL.includes("mode={"));
  check("Calendar supplies the domain content (values + tooltipRowsFor)", CAL.includes("values={values}") && CAL.includes("tooltipRowsFor={tooltipRowsFor}"));
  check("Calendar consumes the contract's pre-projected daily (no re-project when supplied)", CAL.includes("dailyProp ?? projectDailyFacts"));
}

console.log("6. Semantic slice controls are workspace-owned (relocated from host)");
{
  check("workspace owns the perspective state", WS.includes('useState<CashFlowPerspectiveMode>("liquidity")'));
  check("workspace owns the filter state", WS.includes("useState<string>(DEFAULT_FILTER_ID)"));
  check("workspace exposes changePerspective to its widgets", WS.includes("changePerspective") && WS.includes("onPerspectiveChange={changePerspective}"));
  check("host no longer owns the perspective slice state", !DASH.includes("setCashFlowPerspective") && !DASH.includes("onCashFlowPerspectiveChange"));
}

console.log("7. Calendar / Cards modes are workspace-owned (inside the History widget)");
{
  check("workspace mounts the History widget (which hosts the mode toggle)", WS.includes("<CashFlowHistoryWidget"));
  check("History widget owns the Calendar/Cards mode toggle", HIST.includes("ModeToggle") && HIST.includes("getCashFlowHistoryModes"));
  check("History renders both Calendar and Cards views", HIST.includes("<CashFlowCalendar") && HIST.includes("CardsView"));
  check("mode is workspace-local widget state, not host", HIST.includes("useState<CashFlowHistoryMode>") && !DASH.includes("CashFlowHistoryMode"));
}

console.log("8. Display currency (FX) is not regressed");
{
  check("workspace threads txCtx into the contract as moneyCtx", WS.includes("moneyCtx: txCtx"));
  check("workspace passes ctx={txCtx} to its panels", WS.includes("ctx={txCtx}"));
  check("host still passes the tx conversion context to the workspace", DASH.includes("txCtx={txConversionCtx}"));
}

console.log("9. Old Cash Flow host composition retired/reduced");
{
  check("host removed the cashFlowPerspective/filterId state block", !DASH.includes("const [cashFlowPerspective") && !DASH.includes("const [cashFlowFilterId"));
  check("host dropped the now-unused DEFAULT_FILTER_ID import", !DASH.includes("DEFAULT_FILTER_ID"));
  check("host mount seam is minimal (no perspective/filterId/onPerspectiveChange props on the workspace)", (() => {
    const i = DASH.indexOf("<CashFlowWorkspace");
    const j = DASH.indexOf("/>", i);
    const jsx = i >= 0 && j >= 0 ? DASH.slice(i, j) : "";
    return jsx.includes("transactions=") && jsx.includes("period=") && jsx.includes("onSelectPeriod=") && jsx.includes("stamp=")
      && !jsx.includes("perspective=") && !jsx.includes("filterId=") && !jsx.includes("onPerspectiveChange=");
  })());
}

if (failures > 0) { console.error(`\n${failures} CashFlowWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll CashFlowWorkspace checks passed");

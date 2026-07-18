/**
 * components/space/widgets/cashflow/CashFlowWorkspace.test.ts  (SD-6C)
 *
 * Durable-invariant ratchets for the Cash Flow Workspace extraction (house pattern —
 * pure, DB-free). TEST-3 cleanup: brittle import-path/prop-spelling/mount-seam/branch-
 * order/composed-once pins removed; the durable SD-6C contract kept:
 *
 *   1. CashFlowWorkspace is the render boundary (host mounts it; old Perspective gone).
 *   2. CashFlowSpaceData is the composition boundary (buildCashFlowSpaceData); panels
 *      consume the contract slices, not raw re-projection.
 *   3. The workspace duplicates NO canonical projection.
 *   4. Canonical time is preserved (period as prop; no local date authority; host still
 *      derives cashFlowPeriod).
 *   5. The Calendar Heatmap is retained via the metric-agnostic CalendarHeatmapGrid.
 *   6. Semantic slice controls (perspective/filter) are workspace-owned (relocated).
 *   7. Calendar / Cards modes are workspace-owned (inside the History widget).
 *   8. Display currency (FX) is not regressed.
 *   9. The old Cash Flow host composition is retired/reduced.
 *  10. Trust OWNERSHIP: the workspace owns the completeness stamp AND emits its own
 *      trust envelope; the host merely relays cashFlowEnvelope.
 *
 *   npx tsx components/space/widgets/cashflow/CashFlowWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const WS   = read("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
const DASH = read("components/dashboard/SpaceDashboard.tsx");
// SD-2 closeout — perspective render impls live in the component-layer renderer map.
const REND = read("components/space/workspaces/workspaceRenderers.tsx");
const CAL  = read("components/space/widgets/CashFlowCalendar.tsx");
const HIST = read("components/space/widgets/CashFlowHistoryWidget.tsx");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. CashFlowWorkspace is the render boundary");
{
  check("renderer map mounts <CashFlowWorkspace (the cashFlow destination's renderer)", REND.includes("<CashFlowWorkspace"));
  check("host dispatches perspective renderers via WORKSPACE_RENDERERS", DASH.includes("WORKSPACE_RENDERERS["));
  check("neither host nor renderer references the old CashFlowPerspective",
    !DASH.includes("cashflow/CashFlowPerspective") && !REND.includes("cashflow/CashFlowPerspective") && !DASH.includes("CashFlowPerspectiveWorkspace"));
  check("cashFlow workspace is registered in the renderer map", REND.includes("cashFlow: (ctx) =>") && REND.includes("<CashFlowWorkspace"));
  // SD-2C — the renderer passes canonical asOf + compareTo so Cash Flow is historical.
  check("renderer passes canonical asOf + compareTo to CashFlowWorkspace",
    /asOf=\{ctx\.asOf\}/.test(REND) && /compareTo=\{ctx\.historicalCompareTo\}/.test(REND));
}

console.log("1b. Cash Flow is anchored at canonical As-of, not today (SD-2C historical)");
{
  const WSRC = read("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
  // The workspace builds ONE asOf clock and feeds it to every period→range resolver
  // (contract fold, stamp, calendar, insights) — no `new Date()` (today) anchor remains.
  check("workspace derives an asOf clock", /const asOfClock\s*=/.test(WSRC) && /new Date\(`\$\{asOf\}/.test(WSRC));
  check("contract fold is asOf-anchored (buildCashFlowSpaceData now: asOfClock)",
    /buildCashFlowSpaceData\(\{[\s\S]*now:\s*asOfClock/.test(WSRC));
  check("completeness stamp is asOf-anchored (no today clock)",
    /cashFlowStamp\(\{[\s\S]*now:\s*asOfClock/.test(WSRC) && !/now:\s*\(\)\s*=>\s*new Date\(\)/.test(WSRC));
  check("calendar + insights receive the asOf clock", /now=\{asOfClock\}/.test(WSRC));
  check("insights receive canonical compareTo", /compareTo=\{compareTo\}/.test(WSRC));
}

console.log("2. CashFlowSpaceData is the composition boundary");
{
  check("imports buildCashFlowSpaceData from the canonical contract module",
    WS.includes('from "@/lib/transactions/cash-flow-space-data"') && WS.includes("buildCashFlowSpaceData"));
  check("composes via the contract", WS.includes("buildCashFlowSpaceData("));
  // Every panel is fed from the contract slices — not raw re-projection.
  check("panels consume the contract's summary/context slices", WS.includes("data?.summary") && WS.includes("data?.context"));
  check("panels consume the contract's daily/buckets slices", WS.includes("data?.daily") && WS.includes("data?.buckets"));
  check("windowed rows come from the contract", WS.includes("data?.rows"));
  check("spending consumes data.outflowByCategory", WS.includes("data.outflowByCategory"));
  check("income consumes data.cashInByReason / data.incomeBySource", WS.includes("data.cashInByReason") && WS.includes("data.incomeBySource"));
}

console.log("3. The workspace duplicates NO canonical projection");
{
  for (const banned of ["filterByPeriod(", "aggregateDayFacts(", "projectDailyFacts(", "bucketDayFacts("]) {
    check(`workspace does not call ${banned} (comes from the contract)`, !WS.includes(banned));
  }
}

console.log("4. Canonical time is preserved (no duplicate date authority)");
{
  check("workspace receives period as a prop", WS.includes("period:"));
  check("workspace receives onSelectPeriod as a prop", WS.includes("onSelectPeriod:"));
  check("workspace does NOT own a local period/date authority", !WS.includes("useState<CashFlowPeriod") && !WS.includes("usePerspectiveShellState") && !WS.includes("cashFlowExplicitPeriod"));
  check("host still derives the canonical cashFlowPeriod", DASH.includes("const cashFlowPeriod"));
  check("workspace passes the canonical period into the contract", WS.includes("buildCashFlowSpaceData(") && WS.includes("period,"));
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
  check("workspace owns the perspective state", WS.includes("useState<CashFlowPerspectiveMode>"));
  check("workspace owns the filter state", WS.includes("useState<string>(DEFAULT_FILTER_ID)"));
  check("workspace exposes changePerspective to its widgets", WS.includes("changePerspective"));
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
  check("workspace passes the tx conversion context to its panels", WS.includes("ctx={txCtx}"));
  check("host still passes the tx conversion context to the workspace", DASH.includes("txCtx={txConversionCtx}"));
}

console.log("9. Old Cash Flow host composition retired/reduced");
{
  check("host removed the cashFlowPerspective/filterId state block", !DASH.includes("const [cashFlowPerspective") && !DASH.includes("const [cashFlowFilterId"));
  check("host dropped the now-unused DEFAULT_FILTER_ID import", !DASH.includes("DEFAULT_FILTER_ID"));
  // The relocated slice controls are no longer passed down from the host.
  check("the renderer no longer passes the relocated slice controls to the workspace", (() => {
    const i = REND.indexOf("<CashFlowWorkspace");
    const j = REND.indexOf("/>", i);
    const jsx = i >= 0 && j >= 0 ? REND.slice(i, j) : "";
    return !jsx.includes("perspective=") && !jsx.includes("filterId=") && !jsx.includes("onPerspectiveChange=");
  })());
}

console.log("10. Trust OWNERSHIP — workspace owns the stamp AND emits its own envelope (SD-6 gate)");
{
  // The completeness stamp moved OUT of the host and INTO the workspace: it owns the ONE
  // computation and feeds BOTH the Insights caveat and the shell chip envelope (emitted
  // up) — which can never disagree. The host merely relays cashFlowEnvelope.
  check("workspace computes its own cashFlowStamp", WS.includes("cashFlowStamp("));
  check("stamp feeds the Insights caveat", WS.includes("stamp={stamp}"));
  check("workspace emits its trust envelope via the canonical resolver",
    WS.includes("onEnvelopeChange(") && WS.includes("resolvePerspectiveEnvelope(") && WS.includes('perspectiveId: "cashFlow"'));
  check("host no longer computes cashFlowStampValue", !DASH.includes("cashFlowStampValue"));
  check("host no longer imports cashFlowStamp / LiquidityTx for the stamp", !DASH.includes("cash-flow-compare") && !DASH.includes("import type { LiquidityTx }"));
  check("renderer wires envelope up + host relays it (consolidated)",
    REND.includes("<CashFlowWorkspace") && REND.includes("onEnvelopeChange={ctx.onEnvelopeChange}") && DASH.includes("useActiveEnvelope"));
}

if (failures > 0) { console.error(`\n${failures} CashFlowWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll CashFlowWorkspace checks passed");

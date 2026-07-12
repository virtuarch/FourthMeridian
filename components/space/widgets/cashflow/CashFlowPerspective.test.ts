/**
 * components/space/widgets/cashflow/CashFlowPerspective.test.ts
 *
 * Source-scan tests for the Cash Flow Perspective composition (house pattern —
 * pure, DB-free, no live services). These lock the layout contract from the
 * redesign plan §7 without rendering React:
 *
 *   1. All five mounted widgets appear exactly once (no dropped/duplicated mount).
 *   2. The grid classes + specified lg:/xl: spans + min-w-0 on every child exist,
 *      and no panel pins a fixed height (h-[…] / max-h-[…]).
 *   3. Source order (= mobile stacking order) is Summary → History → Spending →
 *      Debt → Income.
 *   4. No import from the Wealth workspace and no import of usePerspectiveShellState
 *      (time stays host-owned).
 *   5. The SpaceDashboard `cashFlow` branch threads the full shell/host prop set.
 *
 *   npx tsx components/space/widgets/cashflow/CashFlowPerspective.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = readFileSync(path.join(ROOT, "components/space/widgets/cashflow/CashFlowPerspective.tsx"), "utf8");
const DASH = readFileSync(path.join(ROOT, "components/dashboard/SpaceDashboard.tsx"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
/** Count non-overlapping occurrences of a literal substring. */
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

console.log("1. All five widgets mounted exactly once");
{
  const mounts: [string, string][] = [
    ["Cash Flow Summary", "renderCashFlowSummary("],
    ["Cash Flow History", "renderCashFlowHistory("],
    ["Spending by Category", "<CashFlowCategoryBreakdown"],
    ["Income by Source", "renderIncomeBySource("],
    ["Debt Payments", "renderDebtPayments("],
    ["Key Insights", "<CashFlowInsightsCard"],
  ];
  for (const [label, needle] of mounts) {
    check(`${label} mounted exactly once`, count(SRC, needle) === 1, `${count(SRC, needle)} occurrence(s) of ${needle}`);
  }
  // income_vs_spending is retired — it must not be remounted here.
  check("retired income_vs_spending is not mounted", count(SRC, "renderIncomeVsSpending") === 0);
}

console.log("2. Grid + span + overflow contract");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-stretch balances rows", SRC.includes("items-stretch"));
  const spans = ["lg:col-span-5 xl:col-span-4", "lg:col-span-7 xl:col-span-5", "lg:col-span-6 xl:col-span-3", "lg:col-span-6 xl:col-span-7", "lg:col-span-12 xl:col-span-5"];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  // Every grid child + the panel carries min-w-0.
  check("min-w-0 appears on every column + the panel (≥5)", count(SRC, "min-w-0") >= 5, `${count(SRC, "min-w-0")}`);
  // No fixed/max heights on panels — content defines height (plan §3.3).
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
  check("narrow-column card grid override present", SRC.includes("sm:grid-cols-2 xl:grid-cols-1"));
}

console.log("3. Source order = mobile stacking order (Summary → History → Spending → Debt → Income → Insights)");
{
  // Scan the grid return block only — the Spending panel mounts via {renderSpending()}
  // in the return; its <CashFlowCategoryBreakdown> lives in the helper defined above,
  // so anchor Spending on the call site to reflect true stacking order.
  const gridIdx = SRC.indexOf('grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch');
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = ["renderCashFlowSummary(", "renderCashFlowHistory(", "renderSpending()", "renderDebtPayments(", "renderIncomeBySource(", "<CashFlowInsightsCard"];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present in the return block", positions.every((p) => p >= 0), positions.join(","));
  const ascending = positions.every((p, i) => i === 0 || positions[i - 1] < p);
  check("panels appear in the mandated source order", ascending, positions.join(","));
}

console.log("4. No forbidden imports (time stays host-owned)");
{
  check("no import from the Wealth workspace", !SRC.includes("components/space/widgets/wealth/"));
  check("no import of usePerspectiveShellState", !SRC.includes("usePerspectiveShellState"));
}

console.log("5. SpaceDashboard cashFlow branch threads the full prop set");
{
  const branchIdx = DASH.indexOf('activePerspectiveId === "cashFlow"');
  check("cashFlow branch exists", branchIdx >= 0);
  // Scan the CashFlowPerspective JSX block for each prop.
  const jsxStart = DASH.indexOf("<CashFlowPerspective", branchIdx);
  const jsxEnd = DASH.indexOf("/>", jsxStart);
  const jsx = jsxStart >= 0 && jsxEnd >= 0 ? DASH.slice(jsxStart, jsxEnd) : "";
  for (const prop of ["transactions=", "txCtx=", "accounts=", "period=", "onSelectPeriod=", "perspective=", "filterId=", "onPerspectiveChange="]) {
    check(`branch passes ${prop.replace("=", "")}`, jsx.includes(prop));
  }
  // The bounded branch precedes the generic virtual-sections fallback.
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("cashFlow branch precedes the generic virtual-sections branch", branchIdx >= 0 && genericIdx > branchIdx);
}

if (failures > 0) { console.error(`\n${failures} CashFlowPerspective check(s) failed`); process.exit(1); }
console.log("\nAll CashFlowPerspective checks passed");

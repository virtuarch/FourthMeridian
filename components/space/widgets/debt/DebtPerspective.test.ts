/**
 * components/space/widgets/debt/DebtPerspective.test.ts
 *
 * Source-scan tests for the Debt Perspective composition (house pattern — pure,
 * DB-free). Template: liquidity/LiquidityPerspective.test.ts. Locks the layout
 * contract AND the decided CURRENT-STATE-ONLY constraint (plan §7):
 *
 *   1. All seven mounted widgets/presenters appear exactly once.
 *   2. Grid classes + §3.3 span pairs + min-w-0 on every child; no fixed height.
 *   3. Source order (= mobile stacking): Lede → KPI → Balance Over Time →
 *      Credit Utilization → Interest Cost → Debt by Account → Payoff Planner →
 *      Credit Health → Complete Details.
 *   4. CURRENT-STATE LOCK: no asOf, no accounts-asof, no getAccountsAsOf, no
 *      compareTo, no usePerspectiveShellState, no import from wealth/, cashflow/,
 *      or liquidity/ component folders.
 *   5. Planner parity: the composition passes false/undefined for fullscreen (no
 *      new fullscreen trigger — plan §3.6).
 *   6. SpaceDashboard `debt` branch: exists once, passes accounts / ctx /
 *      snapshots / ficoScore / ficoUpdatedAt / lensResult, threads no asOf,
 *      and precedes the generic virtual-sections fallback (plan §7 check 6 —
 *      added now that the host branch has landed on primary, §3.2 "Modify").
 *
 *   npx tsx components/space/widgets/debt/DebtPerspective.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = readFileSync(path.join(ROOT, "components/space/widgets/debt/DebtPerspective.tsx"), "utf8");
const DASH = readFileSync(path.join(ROOT, "components/dashboard/SpaceDashboard.tsx"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

console.log("1. All seven mounted widgets/presenters appear exactly once");
{
  const mounts: [string, string][] = [
    ["Debt by Account", "renderDebtByAccount("],
    ["Interest Cost", "renderDebtCost("],
    ["Credit Utilization", "<CreditUtilizationWidget"],
    ["Balance Over Time (S3 presenter)", "<DebtHistoryPanel"],
    ["Payoff Planner", "renderDebtPayoffCalculator("],
    ["Credit Score (FICO)", "renderCreditScore("],
    ["Complete Debt Details", "renderDebtCompleteInfo("],
  ];
  for (const [label, needle] of mounts) {
    check(`${label} mounted exactly once`, count(SRC, needle) === 1, `${count(SRC, needle)} occurrence(s) of ${needle}`);
  }
  // The generic-path history renderer stays in the registry — never remounted here.
  check("registry renderDebtHistory is not remounted", count(SRC, "renderDebtHistory(") === 0);
  // The orphaned snapshot renderer is reused as MATH only — never remounted.
  check("renderDebtPayoffSnapshot is not remounted", count(SRC, "renderDebtPayoffSnapshot(") === 0);
  // KPI band mounted once.
  check("DebtKpiStrip mounted exactly once", count(SRC, "<DebtKpiStrip") === 1);
}

console.log("2. Grid + span + overflow contract");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-stretch balances rows", SRC.includes("items-stretch"));
  const spans = [
    "lg:col-span-12",              // lede + KPI
    "lg:col-span-7 xl:col-span-8", // Balance Over Time (dominant)
    "lg:col-span-5 xl:col-span-4", // cost-risk column + Credit Health
    "lg:col-span-6 xl:col-span-7", // Debt by Account
    "lg:col-span-6 xl:col-span-5", // Payoff Planner
  ];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  check("min-w-0 appears on every column + the panel (≥9)", count(SRC, "min-w-0") >= 9, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
}

console.log("3. Source order = mobile stacking order");
{
  const gridIdx = SRC.indexOf("grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch");
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = [
    "renderLede(",
    "<DebtKpiStrip",
    "<DebtHistoryPanel",
    "<CreditUtilizationWidget",
    "renderDebtCost(",
    "renderDebtByAccount(",
    "renderDebtPayoffCalculator(",
    "renderCreditScore(",
    "renderDebtCompleteInfo(",
  ];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present in the return block", positions.every((p) => p >= 0), positions.join(","));
  const ascending = positions.every((p, i) => i === 0 || positions[i - 1] < p);
  check("panels appear in the mandated source order", ascending, positions.join(","));
}

console.log("4. CURRENT-STATE lock — no historical/asOf machinery, no cross-workspace imports");
{
  // Case-sensitive: the forbidden identifier is `asOf` (lowercase a). The
  // legitimate `provenance.dataAsOf` read carries a capital A and the display
  // copy "as of" carries a space — neither matches.
  check("no `asOf` token", !SRC.includes("asOf"));
  check("no `compareTo` token", !SRC.includes("compareTo"));
  check("no `accounts-asof` import", !SRC.includes("accounts-asof"));
  check("no `getAccountsAsOf` call", !SRC.includes("getAccountsAsOf"));
  check("no `usePerspectiveShellState`", !SRC.includes("usePerspectiveShellState"));
  check("no import from the Wealth workspace", !SRC.includes("components/space/widgets/wealth/"));
  check("no import from the Cash Flow workspace", !SRC.includes("components/space/widgets/cashflow/"));
  check("no import from the Liquidity workspace", !SRC.includes("components/space/widgets/liquidity/"));
}

console.log("5. Planner parity — embedded only, no new fullscreen trigger (plan §3.6)");
{
  const callIdx = SRC.indexOf("renderDebtPayoffCalculator(");
  const call = callIdx >= 0 ? SRC.slice(callIdx, SRC.indexOf(")", callIdx) + 1) : "";
  check("planner is called embedded (false, undefined for fullscreen)", call.includes("false") && call.includes("undefined"), call);
}

console.log("6. SpaceDashboard debt branch threads accounts / ctx / snapshots / fico / lensResult, precedes generic branch");
{
  // Uniqueness is asserted on the JSX MOUNT (defensive): since SD-3 the snapshot
  // fetch activates on the registry-derived `perspectiveNeedsSnapshots`, so the
  // `activePerspectiveId === "debt"` render-branch condition is the only occurrence.
  check("debt render branch condition exists", DASH.includes('activePerspectiveId === "debt"'));
  check("DebtPerspective mounted exactly once in the host", count(DASH, "<DebtPerspective") === 1, `${count(DASH, "<DebtPerspective")}`);
  const jsxStart = DASH.indexOf("<DebtPerspective");
  const jsxEnd = DASH.indexOf("/>", jsxStart);
  const jsx = jsxStart >= 0 && jsxEnd >= 0 ? DASH.slice(jsxStart, jsxEnd) : "";
  for (const prop of ["accounts=", "ctx=", "snapshots=", "ficoScore=", "ficoUpdatedAt=", "lensResult="]) {
    check(`branch passes ${prop.replace("=", "")}`, jsx.includes(prop));
  }
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("debt branch precedes the generic virtual-sections branch", jsxStart >= 0 && genericIdx > jsxStart);
  // The current-state constraint reaches the host branch too: no asOf threaded in.
  check("host branch threads no asOf into Debt", !jsx.includes("asOf"));
}

if (failures > 0) { console.error(`\n${failures} DebtPerspective check(s) failed`); process.exit(1); }
console.log("\nAll DebtPerspective checks passed");

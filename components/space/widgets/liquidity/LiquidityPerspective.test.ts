/**
 * components/space/widgets/liquidity/LiquidityPerspective.test.ts
 *
 * Source-scan tests for the Liquidity Perspective composition (house pattern —
 * pure, DB-free). Template: cashflow/CashFlowPerspective.test.ts. Locks the
 * layout contract AND the decided CURRENT-STATE-ONLY constraint (plan §7):
 *
 *   1. All four mounted widgets/presenters appear exactly once.
 *   2. Grid classes + §3.3 span pairs + min-w-0 on every child; no fixed height.
 *   3. Source order (= mobile stacking): Lede → Accessible Cash → EFR → Ladder →
 *      Reachability → Concentration.
 *   4. CURRENT-STATE LOCK: no asOf, no accounts-asof, no getAccountsAsOf, no
 *      compareTo, no usePerspectiveShellState, no import from wealth/ or cashflow/.
 *   5. SpaceDashboard `liquidity` branch threads accounts / ctx / lensResult and
 *      precedes the generic virtual-sections branch.
 *
 *   npx tsx components/space/widgets/liquidity/LiquidityPerspective.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";

const ROOT = process.cwd();
const SRC = readFileSync(path.join(ROOT, "components/space/widgets/liquidity/LiquidityPerspective.tsx"), "utf8");
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

console.log("1. All four mounted widgets/presenters appear exactly once");
{
  const mounts: [string, string][] = [
    ["Accessible Cash", "renderAccessibleCash("],
    ["Emergency Fund Readiness", "renderEmergencyFundReadiness("],
    ["Liquidity Ladder (tier presenter)", "<LiquidityLadderTiers"],
    ["Liquidity Concentration", "renderLiquidityConcentration("],
    ["What Changed (S4)", "<LiquidityWhatChangedCard"],
  ];
  for (const [label, needle] of mounts) {
    check(`${label} mounted exactly once`, count(SRC, needle) === 1, `${count(SRC, needle)} occurrence(s) of ${needle}`);
  }
  // The generic-path ladder renderer stays in the registry — never remounted here.
  check("registry renderLiquidityLadder is not remounted", count(SRC, "renderLiquidityLadder(") === 0);
}

console.log("2. Grid + span + overflow contract");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-stretch balances rows", SRC.includes("items-stretch"));
  const spans = [
    "lg:col-span-12",              // lede
    "lg:col-span-5 xl:col-span-4", // KPI column
    "lg:col-span-7 xl:col-span-8", // Ladder (dominant)
    "lg:col-span-6 xl:col-span-5", // Reachability
    "lg:col-span-6 xl:col-span-7", // Concentration
  ];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  check("min-w-0 appears on every column + the panel (≥6)", count(SRC, "min-w-0") >= 6, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
}

console.log("3. Source order = mobile stacking order (Lede → Accessible Cash → EFR → Ladder → Reachability → Concentration)");
{
  // Scan the grid return block only — helper bodies (renderLede/renderReachability)
  // are defined above the return, so anchor on their call sites in the return.
  const gridIdx = SRC.indexOf('grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch');
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = ["renderLede(", "renderAccessibleCash(", "renderEmergencyFundReadiness(", "<LiquidityLadderTiers", "renderReachability(", "renderLiquidityConcentration(", "<LiquidityWhatChangedCard"];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present in the return block", positions.every((p) => p >= 0), positions.join(","));
  const ascending = positions.every((p, i) => i === 0 || positions[i - 1] < p);
  check("panels appear in the mandated source order", ascending, positions.join(","));
}

console.log("4. CURRENT-STATE lock — no historical/asOf machinery, no cross-workspace imports");
{
  // Case-sensitive: the forbidden identifier is `asOf` (lowercase a). The
  // legitimate `provenance.dataAsOf` field read carries a capital A and the
  // display copy "as of" carries a space — neither matches.
  check("no `asOf` token", !SRC.includes("asOf"));
  check("no `compareTo` token", !SRC.includes("compareTo"));
  check("no `accounts-asof` import", !SRC.includes("accounts-asof"));
  check("no `getAccountsAsOf` call", !SRC.includes("getAccountsAsOf"));
  check("no `usePerspectiveShellState`", !SRC.includes("usePerspectiveShellState"));
  check("no import from the Wealth workspace", !SRC.includes("components/space/widgets/wealth/"));
  check("no import from the Cash Flow workspace", !SRC.includes("components/space/widgets/cashflow/"));
}

console.log("5. SpaceDashboard liquidity branch threads accounts / ctx / lensResult (+ S4), precedes generic branch");
{
  const branchIdx = DASH.indexOf('activePerspectiveId === "liquidity"');
  check("liquidity branch exists", branchIdx >= 0);
  const jsxStart = DASH.indexOf("<LiquidityPerspective", branchIdx);
  const jsxEnd = DASH.indexOf("/>", jsxStart);
  const jsx = jsxStart >= 0 && jsxEnd >= 0 ? DASH.slice(jsxStart, jsxEnd) : "";
  for (const prop of ["accounts=", "ctx=", "lensResult=", "transactions=", "txCtx=", "period=", "onOpenCashFlow="]) {
    check(`branch passes ${prop.replace("=", "")}`, jsx.includes(prop));
  }
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("liquidity branch precedes the generic virtual-sections branch", branchIdx >= 0 && genericIdx > branchIdx);
  // The current-state constraint reaches the host branch too: no asOf threaded in.
  check("host branch threads no asOf into Liquidity", !jsx.includes("asOf"));
  // The fetch-trigger guarantee (§3.2): Liquidity opening first must load tx rows.
  // SD-3 — this is now DECLARATIVE: Liquidity declares the `transactions` dataNeed in
  // the canonical registry, and the host's tx fetch guard activates on the
  // registry-derived `perspectiveNeedsTransactions` (openPerspectiveDataNeeds). So the
  // former `!liquidityWorkspaceActive` literal is gone by design; the guarantee now
  // lives in the registry + the orchestrator, and is pinned here instead.
  check("Liquidity declares the `transactions` dataNeed (registry-driven activation)",
    (PERSPECTIVE_LIBRARY.liquidity.dataNeeds ?? []).includes("transactions"));
  check("host tx fetch guard activates on the declared need (perspectiveNeedsTransactions)",
    DASH.includes("!perspectiveNeedsTransactions"));
}

if (failures > 0) { console.error(`\n${failures} LiquidityPerspective check(s) failed`); process.exit(1); }
console.log("\nAll LiquidityPerspective checks passed");

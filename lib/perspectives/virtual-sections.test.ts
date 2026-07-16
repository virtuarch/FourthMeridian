/**
 * lib/perspectives/virtual-sections.test.ts
 *
 * UX-PER-3 — Perspective Workspace Renderer invariants.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx lib/perspectives/virtual-sections.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 *
 * These import cleanly (pure modules — no DB / React / next).
 */

import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { WIDGET_REGISTRY } from "@/lib/widget-registry";
import {
  toVirtualSections,
  isVirtualSectionId,
  VIRTUAL_SECTION_PREFIX,
} from "@/lib/perspectives/virtual-sections";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
/** Order-independent set equality — a workspace's widget MEMBERSHIP is the
 *  invariant; presentation order is a free UX knob and must not fail the ratchet. */
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ── 1. Registry parity — every PerspectiveDef.widgets[] key exists in
//      WIDGET_REGISTRY and is a real (implemented, non-deprecated) widget. ──
//
// EXCEPTION (P1 closeout): the Investments perspective renders via
// SpaceDashboard's dedicated `activePerspectiveId === "investments"` branch, NOT
// through toVirtualSections. Its former `investment_accounts` registry widget
// was retired; it now carries a non-registry AFFORDANCE MARKER kept only so
// `widgets.length > 0` (default-pick / Overview-doorway clickability / tab
// hasWorkspace). The marker is intentionally NOT a registry widget — every OTHER
// perspective's keys must still be real registry widgets.
const DEDICATED_BRANCH_MARKERS = new Set(["investments_workspace"]);

// Compensating assertions so a typo/rename can't silently slip through the
// exemption: investments must use exactly this marker, and the marker must be
// absent from the registry (proving no dead `investment_accounts` entry lingers).
check("investments perspective uses exactly the dedicated-branch affordance marker",
  sameSet(PERSPECTIVE_LIBRARY.investments.widgets ?? [], ["investments_workspace"]));
check("the affordance marker is intentionally NOT a registry widget",
  !WIDGET_REGISTRY.has("investments_workspace"));
check("the retired investment_accounts widget is gone from the registry",
  !WIDGET_REGISTRY.has("investment_accounts"));

const withWidgets = Object.values(PERSPECTIVE_LIBRARY).filter((p) => p.widgets && p.widgets.length > 0);
check("at least one Perspective has a widgets[] workspace (wealth)",
  withWidgets.some((p) => p.id === "wealth"));

for (const p of withWidgets) {
  for (const key of p.widgets!) {
    if (DEDICATED_BRANCH_MARKERS.has(key)) continue; // dedicated-branch affordance marker (see above)
    const entry = WIDGET_REGISTRY.get(key);
    check(`perspective "${p.id}" widget "${key}" exists in WIDGET_REGISTRY`, entry !== undefined);
    if (entry) {
      check(`perspective "${p.id}" widget "${key}" is implemented`, entry.implemented === true);
      check(`perspective "${p.id}" widget "${key}" is not a deprecated alias`,
        entry.meta.deprecatedAlias === undefined);
    }
  }
}

// ── 2. Wealth workspace uses its purpose-built, assets-only widgets. ──
// MEMBERSHIP is the doctrine (these four assets-only widgets, no Overview reuse);
// presentation order is a free UX knob (e.g. asset_allocation first) and is NOT pinned.
check("wealth workspace set === {asset_allocation, wealth_by_account, institution_allocation, wealth_concentration}",
  sameSet(PERSPECTIVE_LIBRARY.wealth.widgets ?? [],
    ["asset_allocation", "wealth_by_account", "institution_allocation", "wealth_concentration"]));
// Doctrine: Wealth must NOT reuse the Overview widgets.
check("wealth workspace excludes Overview widgets (net_worth / net_worth_chart / allocation)",
  !(PERSPECTIVE_LIBRARY.wealth.widgets ?? []).some((k) =>
    k === "net_worth" || k === "net_worth_chart" || k === "allocation"));

// ── 2b. Liquidity workspace uses its purpose-built access/readiness widgets. ──
check("liquidity workspace set === {liquidity_ladder, accessible_cash, emergency_fund_readiness, liquidity_concentration}",
  sameSet(PERSPECTIVE_LIBRARY.liquidity.widgets ?? [],
    ["liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration"]));
// Doctrine: Liquidity must NOT reuse Overview or Wealth widgets.
check("liquidity workspace excludes Overview/Wealth widgets",
  !(PERSPECTIVE_LIBRARY.liquidity.widgets ?? []).some((k) =>
    k === "net_worth" || k === "net_worth_chart" || k === "allocation" ||
    k === "wealth_by_account" || k === "asset_allocation"));

// ── 2c. Cash Flow workspace uses its movement-over-time widgets. ──
// "Refine Cash Flow experience": income_vs_spending retired from the active
// list (Cash Flow History carries that read), income_by_source added beneath
// Spending by Category, and CF-2C debt_payments (the liquidity-axis twin).
check("cashFlow workspace set === {cash_flow_summary, cash_flow_history, cash_flow_by_category, income_by_source, debt_payments}",
  sameSet(PERSPECTIVE_LIBRARY.cashFlow.widgets ?? [],
    ["cash_flow_summary", "cash_flow_history", "cash_flow_by_category", "income_by_source", "debt_payments"]));
// Doctrine: Cash Flow must NOT reuse Overview / Wealth / Liquidity widgets.
check("cashFlow workspace excludes Overview/Wealth/Liquidity widgets",
  !(PERSPECTIVE_LIBRARY.cashFlow.widgets ?? []).some((k) =>
    k === "net_worth" || k === "net_worth_chart" || k === "allocation" ||
    k === "wealth_by_account" || k === "liquidity_ladder"));

// ── 2d. Debt workspace uses its liabilities-only widgets (incl. reused ones). ──
check("debt workspace set === {debt_by_account, debt_cost, credit_utilization, debt_history, debt_payoff_calculator, credit_score, debt_complete_info}",
  sameSet(PERSPECTIVE_LIBRARY.debt.widgets ?? [],
    [
      "debt_by_account", "debt_cost", "credit_utilization", "debt_history",
      "debt_payoff_calculator", "credit_score", "debt_complete_info",
    ]));
check("debt workspace includes the reused payoff calculator", (PERSPECTIVE_LIBRARY.debt.widgets ?? []).includes("debt_payoff_calculator"));
// Doctrine: Debt must NOT reuse asset/net-worth/spending/goals widgets.
check("debt workspace excludes asset/overview/cashflow widgets",
  !(PERSPECTIVE_LIBRARY.debt.widgets ?? []).some((k) =>
    k === "net_worth" || k === "allocation" || k === "wealth_by_account" ||
    k === "asset_allocation" || k === "cash_flow_summary" || k === "cash_flow_by_category"));

// ── 2e. Goals workspace uses its trajectory-vs-target widgets. ──
check("goals workspace set === {goal_progress, goal_on_track, goal_required_pace, goal_funding_gap}",
  sameSet(PERSPECTIVE_LIBRARY.goals.widgets ?? [],
    ["goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap"]));
// Doctrine: Goals must NOT reuse net-worth/allocation/debt/spending/investment widgets.
check("goals workspace excludes balance/debt/spending widgets",
  !(PERSPECTIVE_LIBRARY.goals.widgets ?? []).some((k) =>
    k === "net_worth" || k === "allocation" || k === "wealth_by_account" ||
    k === "debt_by_account" || k === "cash_flow_summary" || k === "asset_allocation"));

// ── 3. toVirtualSections shape + virtual-id safety. ──
const vs = toVirtualSections("wealth", ["net_worth", "net_worth_chart", "allocation"]);
check("produces one virtual section per widget", vs.length === 3);
check("preserves widget order", vs.map((s) => s.key).join(",") === "net_worth,net_worth_chart,allocation");
check("order index is 0..n-1", vs.every((s, i) => s.order === i));
check("every id is prefixed virtual:", vs.every((s) => s.id.startsWith(VIRTUAL_SECTION_PREFIX)));
check("isVirtualSectionId recognizes generated ids", vs.every((s) => isVirtualSectionId(s.id)));
check("a real cuid-style id is NOT virtual", !isVirtualSectionId("ckxyz123realrow"));
check("labels resolve from WIDGET_REGISTRY (net_worth → Net Worth)",
  vs[0].label === (WIDGET_REGISTRY.get("net_worth")?.meta.label ?? "net_worth"));
check("config is null and enabled is true (render-only)",
  vs.every((s) => s.config === null && s.enabled === true));

// ── 4. No second compositor / no mutation wiring in the workspace mount. ──
// Source-scan SpaceDashboard: the Perspective workspace must render through the
// existing SectionCard, and must NOT send virtual ids to the reorder endpoint.
import { readFileSync } from "fs";
import { join } from "path";
const dash = readFileSync(join(process.cwd(), "components", "dashboard", "SpaceDashboard.tsx"), "utf8");
const code = dash.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
check("workspace renders via toVirtualSections", /toVirtualSections\(/.test(code));
check("workspace feeds virtual sections into the existing SectionCard",
  /toVirtualSections\([\s\S]{0,400}?<SectionCard/.test(code));
check("reorder endpoint is never called with a virtual: id",
  !/virtual:[\s\S]{0,200}\/sections\/reorder/.test(code) &&
  !/\/sections\/reorder[\s\S]{0,200}virtual:/.test(code));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("UX-PER-3 virtual-section tests FAILED."); process.exit(1); }
console.log("UX-PER-3 virtual-section tests passed.");
process.exit(0);

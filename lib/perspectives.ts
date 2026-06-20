/**
 * lib/perspectives.ts
 *
 * Perspectives are "different lenses through which the same underlying
 * Space data is viewed" — Wealth, Cash Flow, Investments, Debt, Retirement,
 * Goals, Tax, Property, Business Health, etc. They are a first-class
 * concept, parallel to lib/workspace-presets.ts's section presets, but
 * answer a different question: presets decide *which widgets* a Space's
 * Overview/Accounts/etc. show; Perspectives decide *which lenses* a user
 * can open onto that same data.
 *
 * Scope for this pass (explicitly bounded — see project instructions):
 * this file defines the lens library and which category gets which lenses.
 * It does NOT implement Perspective business logic. A lens is either:
 *   - "available": a real, already-working feature exists somewhere in the
 *     current dashboard (e.g. Investments, Debt, Retirement, Goals) — the
 *     host dashboard wires `targetTab` to route straight to that existing,
 *     unmodified tab/content. No new logic, just a new entry point.
 *   - "comingSoon": no real feature exists yet (Wealth, Cash Flow, Tax,
 *     Property, Business Health as dedicated views) — the host renders a
 *     calm placeholder card. No `targetTab`.
 *
 * Host dashboards (DashboardClient.tsx, WorkspaceDashboard.tsx) each keep
 * their own short id-to-internal-tab map, because the two dashboards use
 * different internal tab id vocabularies (e.g. "credit" vs. "DEBT") for
 * historical reasons this pass intentionally leaves alone. Keeping that
 * map at the call site — instead of here — keeps this file honest about
 * being host-agnostic, the same separation lib/workspace-presets.ts uses.
 */

export type PerspectiveStatus = "available" | "comingSoon";

/**
 * Sub-nav grouping for the full Perspectives tab — lets a Space with many
 * lenses (today 9, eventually more) be filtered down instead of scrolled
 * through. "All" is the implicit default and is not itself a lens group.
 */
export const PERSPECTIVE_GROUPS = [
  "All", "Financial", "Tax", "Goals", "Retirement", "Business", "Property",
] as const;
export type PerspectiveGroup = Exclude<(typeof PERSPECTIVE_GROUPS)[number], "All">;

export interface PerspectiveDef {
  /** Stable id — also the key into PERSPECTIVE_LIBRARY. */
  id: string;
  label: string;
  description: string;
  /** Lucide icon name (string) — see icon-name convention in lib/widget-registry.ts and lib/timeline-types.ts. */
  icon: string;
  status: PerspectiveStatus;
  /** Sub-nav bucket on the full Perspectives tab — see PERSPECTIVE_GROUPS. */
  group: PerspectiveGroup;
}

export const PERSPECTIVE_LIBRARY: Record<string, PerspectiveDef> = {
  /**
   * The default, always-on lens — the dashboard-composition every Space
   * opens to (KPI strip + Net Worth/Allocation/Brief + Perspectives row +
   * Timeline/Transactions previews). Distinct from every other entry here:
   * it is never rendered as a clickable Perspective *card* (a host would
   * be opening a modal of the page it's already standing on), only as the
   * active value of the PerspectiveSwitcher dropdown atop Overview. See
   * PerspectiveSwitcher's host-side filtering of this id out of card grids.
   */
  overview: {
    id: "overview", label: "Atlas", icon: "Compass", status: "available", group: "Financial",
    description: "Your full financial picture — net worth, cash flow, and recent activity in one view.",
  },
  wealth: {
    id: "wealth", label: "Wealth", icon: "Gem", status: "comingSoon", group: "Financial",
    description: "Net worth trend across every account in this Space.",
  },
  cashFlow: {
    id: "cashFlow", label: "Cash Flow", icon: "Waves", status: "comingSoon", group: "Financial",
    description: "Income versus spending over time.",
  },
  investments: {
    id: "investments", label: "Investments", icon: "TrendingUp", status: "available", group: "Financial",
    description: "Holdings, allocation, and performance.",
  },
  debt: {
    id: "debt", label: "Debt", icon: "CreditCard", status: "available", group: "Financial",
    description: "Balances, payoff pace, and credit health.",
  },
  retirement: {
    id: "retirement", label: "Retirement", icon: "PiggyBank", status: "available", group: "Retirement",
    description: "Progress toward retirement targets.",
  },
  goals: {
    id: "goals", label: "Goals", icon: "Target", status: "available", group: "Goals",
    description: "Savings and habit goals tied to this Space.",
  },
  tax: {
    id: "tax", label: "Tax", icon: "FileText", status: "comingSoon", group: "Tax",
    description: "Tax-relevant activity and documents.",
  },
  property: {
    id: "property", label: "Property", icon: "Home", status: "comingSoon", group: "Property",
    description: "Equity, mortgage, and value over time.",
  },
  businessHealth: {
    id: "businessHealth", label: "Business Health", icon: "Briefcase", status: "comingSoon", group: "Business",
    description: "Revenue, runway, and payroll at a glance.",
  },
};

/**
 * Ordered lens ids per Space category. Mirrors the shape (not the content)
 * of PRESET_MAP in lib/workspace-presets.ts: configuration over branching,
 * so adding a category here is a one-line change, not a new code path.
 */
const PERSPECTIVES_BY_CATEGORY: Record<string, string[]> = {
  PERSONAL:        ["overview", "wealth", "cashFlow", "investments", "debt", "goals"],
  HOUSEHOLD:       ["overview", "wealth", "cashFlow", "goals", "debt"],
  FAMILY:          ["overview", "wealth", "cashFlow", "goals", "debt"],
  RETIREMENT:      ["overview", "wealth", "retirement", "investments", "cashFlow"],
  INVESTMENT:      ["overview", "investments", "wealth", "cashFlow"],
  PROPERTY:        ["overview", "property", "cashFlow", "wealth"],
  VEHICLE:         ["overview", "wealth", "cashFlow"],
  BUSINESS:        ["overview", "businessHealth", "cashFlow", "wealth"],
  DEBT_PAYOFF:     ["overview", "debt", "cashFlow", "wealth"],
  EMERGENCY_FUND:  ["overview", "wealth", "goals", "cashFlow"],
  GOAL:            ["overview", "goals", "wealth", "cashFlow"],
  TRIP:            ["overview", "cashFlow", "goals"],
  EQUIPMENT:       ["overview", "wealth", "cashFlow"],
  CUSTOM:          ["overview", "wealth", "cashFlow", "goals"],
  OTHER:           ["overview", "wealth", "cashFlow", "goals"],
};

const DEFAULT_PERSPECTIVES = ["overview", "wealth", "cashFlow", "goals"];

/** Returns the ordered Perspective definitions for a Space category. */
export function getPerspectivesForCategory(category: string): PerspectiveDef[] {
  const ids = PERSPECTIVES_BY_CATEGORY[category] ?? DEFAULT_PERSPECTIVES;
  return ids.map((id) => PERSPECTIVE_LIBRARY[id]).filter(Boolean);
}

/**
 * Subset of a category's Perspectives that are alternate full-canvas
 * *compositions* of the Overview tab itself — the PerspectiveSwitcher
 * dropdown (IA refactor point 2/3) — as opposed to card-based modal
 * launchers onto a different feature (Investments, Debt, Goals,
 * Retirement, etc. — see each host's own PERSPECTIVE_TARGET_TAB-style map
 * for those). A lens belongs here when it's the default "overview" lens,
 * or any other "Financial"-group lens that's still comingSoon — i.e.
 * lenses that would reshape the *same* canvas rather than open a
 * different one. Investments/Debt are also "Financial" but excluded here
 * (status "available", real modal targets) so there's exactly one
 * navigation path to each, not two competing ones.
 */
export function getCompositionSwitcherItems(category: string): PerspectiveDef[] {
  return getPerspectivesForCategory(category).filter(
    (p) => p.group === "Financial" && (p.id === "overview" || p.status === "comingSoon")
  );
}

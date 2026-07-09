/**
 * lib/perspectives.ts
 *
 * Perspectives are "different lenses through which the same underlying
 * Space data is viewed" — Wealth, Cash Flow, Investments, Debt, Retirement,
 * Goals, Tax, Property, Business Health, etc. They are a first-class
 * concept, parallel to lib/space-presets.ts's section presets, but
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
 * The host dashboard (SpaceDashboard.tsx) keeps its own short
 * id-to-internal-tab map (e.g. the "debt" perspective routes to the "DEBT"
 * tab). Keeping that map at the call site — instead of here — keeps this
 * file honest about being host-agnostic, the same separation
 * lib/space-presets.ts uses.
 */

// Type-only import — erased at compile time, so this client-safe config file
// pulls no engine (server) code into any bundle. The engine itself never
// imports this file; the coupling is one-directional and nominal.
import type { LensId } from "@/lib/perspective-engine/types";

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
  /**
   * Present when this lens is backed by a Perspective Engine lens
   * (lib/perspective-engine) that computes a real deterministic answer for
   * its card. Invariant (guard-tested in lib/perspectives.test.ts): an
   * entry with a lensId must be status "available" — a computed answer can
   * never be "coming soon" — and must have a matching registered lens
   * module at lib/perspective-engine/lenses/<lensId>.ts. Entries WITHOUT a
   * lensId keep today's behavior exactly (host tab routing or comingSoon
   * placeholder).
   */
  lensId?: LensId;
  /**
   * UX-PER-3 (Perspective Workspace) — the ordered widget keys this Perspective
   * renders as its workspace body. Each key MUST exist in WIDGET_REGISTRY
   * (parity-tested in lib/perspectives/virtual-sections.test.ts) and reuse the
   * same SectionCard/SectionRegistry compositor as tab sections. Rendered as
   * VIRTUAL, render-only sections (no DB rows, no persistence, no drag/drop yet).
   * Absent ⇒ today's behavior (host tab routing / lens card / comingSoon).
   */
  widgets?: readonly string[];
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
    id: "wealth", label: "Wealth", icon: "Gem", status: "available", group: "Financial",
    description: "Where your money is — assets by account, institution, and class.",
    // UX-PER-3 Wealth workspace. Doctrine: Wealth answers "Where is my money?"
    // and is ASSETS ONLY. It deliberately does NOT reuse the Overview widgets
    // (net_worth / net_worth_chart / allocation-incl-debt) — those answer
    // "What?" on the executive dashboard. These are purpose-built, assets-only
    // analytical widgets rendered through the same SectionCard compositor.
    widgets: ["wealth_by_account", "asset_allocation", "institution_allocation", "wealth_concentration"],
  },
  cashFlow: {
    id: "cashFlow", label: "Cash Flow", icon: "Waves", status: "available", group: "Financial",
    description: "Income versus spending over time.",
    // UX-PER-3 Cash Flow workspace. Doctrine: Cash Flow answers "Where does my
    // money move?" — movement over time from transaction history, FlowType-aware
    // (no net worth / allocation / debt / goals). Widgets share the workspace
    // period selector. Rendered through the same SectionCard compositor.
    widgets: ["cash_flow_summary", "cash_flow_history", "income_vs_spending", "cash_flow_by_category"],
  },
  investments: {
    id: "investments", label: "Investments", icon: "TrendingUp", status: "available", group: "Financial",
    description: "Holdings, allocation, and performance.",
  },
  debt: {
    id: "debt", label: "Debt", icon: "CreditCard", status: "available", group: "Financial",
    description: "Balances, payoff pace, and credit health.",
    lensId: "debt",
    // UX-PER-3 Debt workspace. Doctrine: Debt answers "What do I owe?" and is
    // LIABILITIES ONLY — it explains the shape, cost, and risk of debt (no
    // assets / net worth / allocation / spending / goals). Reuses the existing
    // Debt payoff calculator, credit-score card, and missing-info editor.
    widgets: [
      "debt_by_account", "debt_cost", "credit_utilization", "debt_history",
      "debt_payoff_calculator", "credit_score", "debt_complete_info",
    ],
  },
  /**
   * First library entry born lens-backed: no host tab behind it, no
   * comingSoon placeholder — its card content IS the engine's answer
   * (verdict + headline via /api/spaces/[id]/perspectives). Until hosts
   * render lens results, the card falls back to this static description.
   */
  liquidity: {
    id: "liquidity", label: "Liquidity", icon: "Droplets", status: "available", group: "Financial",
    description: "How much you could get at, and how fast.",
    lensId: "liquidity",
    // UX-PER-3 Liquidity workspace. Doctrine: Liquidity answers "How accessible
    // is my money?" — access and readiness, not total wealth. Assets only;
    // purpose-built widgets (no Overview / Wealth widget reuse). Rendered
    // through the same SectionCard compositor as virtual sections.
    widgets: ["liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration"],
  },
  retirement: {
    id: "retirement", label: "Retirement", icon: "PiggyBank", status: "available", group: "Retirement",
    description: "Progress toward retirement targets.",
  },
  goals: {
    id: "goals", label: "Goals", icon: "Target", status: "available", group: "Goals",
    description: "Savings and habit goals tied to this Space.",
    // UX-PER-3 Goals workspace. Doctrine: Goals answers "Am I on track?" —
    // trajectory vs target, not current balances (no net worth / allocation /
    // debt / spending / investment widgets). Rendered through the same
    // SectionCard compositor.
    widgets: ["goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap"],
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
 * of PRESET_MAP in lib/space-presets.ts: configuration over branching,
 * so adding a category here is a one-line change, not a new code path.
 */
const PERSPECTIVES_BY_CATEGORY: Record<string, string[]> = {
  // Liquidity (first lens-backed entry) joins a deliberately conservative
  // category set — the categories where "what could I get at, how fast?"
  // is a daily question (see PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md
  // §2.5). Other categories can adopt it later as one-line changes here.
  PERSONAL:        ["overview", "wealth", "cashFlow", "liquidity", "investments", "debt", "goals"],
  HOUSEHOLD:       ["overview", "wealth", "cashFlow", "liquidity", "goals", "debt"],
  FAMILY:          ["overview", "wealth", "cashFlow", "liquidity", "goals", "debt"],
  RETIREMENT:      ["overview", "wealth", "retirement", "investments", "cashFlow"],
  INVESTMENT:      ["overview", "investments", "wealth", "cashFlow"],
  PROPERTY:        ["overview", "property", "cashFlow", "wealth"],
  VEHICLE:         ["overview", "wealth", "cashFlow"],
  BUSINESS:        ["overview", "businessHealth", "cashFlow", "liquidity", "wealth"],
  DEBT_PAYOFF:     ["overview", "debt", "cashFlow", "wealth"],
  // Emergency funds exist to BE liquidity — the lens sits right up front.
  EMERGENCY_FUND:  ["overview", "liquidity", "wealth", "goals", "cashFlow"],
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

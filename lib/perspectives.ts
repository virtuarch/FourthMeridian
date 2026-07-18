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
// OPS-5 S6 — Platform Operations workspace identities, owned by their own domain
// module and unioned into the universal registry below (value import; the module is
// a client-safe config file with no engine/server code, exactly like this one).
import { PLATFORM_WORKSPACES } from "@/lib/platform/workspaces";

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

// ── SD-2 / SD-2B WorkspaceDefinition metadata ──────────────────────────────────
// The UNIVERSAL, shell-facing identity of every primary Space destination lives in
// `WorkspaceDefinition` (below). PerspectiveDef EXTENDS it — a Perspective is a
// specialization of Workspace (every Perspective is a Workspace; not every
// Workspace is a Perspective). WORKSPACE_REGISTRY (foot of file) is the ONE
// registry over both kinds. "Perspective" stays the user-facing lens label;
// "Workspace" is the architectural runtime unit. These fields consolidate metadata
// that used to be scattered across host-side maps (PERSPECTIVE_TARGET_TAB /
// PERSPECTIVE_ROUTED_TABS / PERSPECTIVE_MODAL_META) and per-workspace fetch/time
// booleans, so SD-3 (declarative data loading) reads one owner.

/** The data primitives a workspace reads at runtime. SD-3 consumes this to own
 *  fetch gating; declared now purely as the contract (no fetch behavior changes
 *  in SD-2). A closed union — not free strings — so needs stay deterministic. */
export type WorkspaceDataNeed =
  | "accounts"
  | "snapshots"
  | "transactions"
  | "lens"
  | "investmentsHistory"
  | "goals"
  | "sections"
  | "fico";

/** Which trust-envelope source resolvePerspectiveEnvelope (lib/perspectives/
 *  envelope.ts) uses for a workspace. A metadata POINTER only — the resolver
 *  still owns the calculation; this makes the association discoverable (P10). */
export type WorkspaceEnvelopeSource =
  | "wealth"
  | "cashFlow"
  | "investments"
  | "lens"
  | "none";

/** Legacy data-tab ids a workspace can route to — each presented as a GlassModal
 *  launched from the Overview doorway. The union of every routing.targetTab;
 *  ROUTED_WORKSPACE_TABS is derived from it. NOTE: these are the host's internal
 *  activeTab ids, deliberately NOT lib/space-nav SpaceTabIds — a Space TAB may
 *  host one or more workspaces (SD-2 P5), so the two identity spaces stay separate. */
export type RoutedWorkspaceTab = "GOALS" | "DEBT" | "INVESTMENTS" | "RETIREMENT";

export interface WorkspaceRouting {
  /** The top-level tab this workspace routes to from the Overview doorway (the
   *  legacy modal tabs). Absent ⇒ reachable only as a Perspectives-tab workspace. */
  targetTab?: RoutedWorkspaceTab;
}

/**
 * A workspace's KIND. "standard" = a structural primary destination that renders
 * directly in the SpaceShell workspace slot (Overview, Transactions, Accounts,
 * Activity, Members). "perspective" = a financial lens (Wealth, Cash Flow,
 * Investments, Debt, Liquidity, Goals, …). Every Perspective is a Workspace; not
 * every Workspace is a Perspective.
 */
export type WorkspaceKind = "standard" | "perspective";

/**
 * SD-2B — the UNIVERSAL, shell-facing identity of every primary Space destination.
 * PerspectiveDef extends this (below). WORKSPACE_REGISTRY (foot of file) is the ONE
 * registry keyed by `id` over both kinds; standard destinations declare only these
 * base fields, Perspectives add lens/card metadata.
 */
export interface WorkspaceDefinition {
  /** Stable id — also the key into WORKSPACE_REGISTRY. */
  id: string;
  label: string;
  /** Lucide icon NAME (string) — the consuming surface resolves it to a component. */
  icon: string;
  kind: WorkspaceKind;
  /**
   * OPS-5 S6 — which DOMAIN owns this workspace. Absent ⇒ "finance" (the original
   * and only domain until Platform Operations became the second real consumer).
   * The finance-scoped metadata below (routing/dataNeeds/consumesShellTime/envelope)
   * uses finance VOCABULARIES (WorkspaceDataNeed / WorkspaceEnvelopeSource /
   * RoutedWorkspaceTab); a "platform" workspace declares NONE of them (Platform
   * widgets self-fetch, have no finance envelope, and route via the platform rail,
   * not the finance modal tabs). This discriminator + the guard in
   * lib/platform/workspaces.test.ts is what keeps finance vocabularies from
   * polluting Platform definitions — WITHOUT a base/PersonalFinance type split
   * (which SD-3 forbids: dataNeeds is universal orchestration metadata by design).
   */
  domain?: "finance" | "platform";
  /** Routing/navigation identity — the ONE answer to "which top-level tab owns
   *  this workspace, and how is it presented?" (replaces the host-side
   *  PERSPECTIVE_TARGET_TAB / PERSPECTIVE_ROUTED_TABS / PERSPECTIVE_MODAL_META). */
  routing?: WorkspaceRouting;
  /** The data primitives this workspace consumes at runtime — declared for SD-3
   *  (no fetch behavior changes here). Empty ⇒ the workspace self-fetches. */
  dataNeeds?: readonly WorkspaceDataNeed[];
  /**
   * Whether this workspace participates in the SD-0B CANONICAL shell time model
   * (asOf / compareTo). Named `consumesShellTime`, NOT `consumesTime`, on purpose:
   * Cash Flow has its own period/calendar semantics but does NOT read the
   * canonical asOf/compareTo, so it is false. Only Wealth + Investments are true.
   */
  consumesShellTime?: boolean;
  /** The trust-envelope source for this workspace (see WorkspaceEnvelopeSource). */
  envelope?: WorkspaceEnvelopeSource;
}

/**
 * A Perspective — a financial-lens specialization of WorkspaceDefinition. Adds the
 * lens/card/sub-nav metadata the Perspectives surfaces need; identity/routing/
 * dataNeeds/time/envelope are inherited from the base.
 */
export interface PerspectiveDef extends WorkspaceDefinition {
  description: string;
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
    id: "overview", kind: "standard", label: "Atlas", icon: "Compass", status: "available", group: "Financial",
    description: "Your full financial picture — net worth, cash flow, and recent activity in one view.",
    // The default landing composition (section stack + trend hero + doorways).
    dataNeeds: ["accounts", "sections", "snapshots", "transactions", "lens"], consumesShellTime: false, envelope: "none",
  },
  wealth: {
    id: "wealth", kind: "perspective", label: "Wealth", icon: "Gem", status: "available", group: "Financial",
    description: "Where your money is — assets by account, institution, and class.",
    // UX-PER-3 Wealth workspace. Doctrine: Wealth answers "Where is my money?"
    // and is ASSETS ONLY. It deliberately does NOT reuse the Overview widgets
    // (net_worth / net_worth_chart / allocation-incl-debt) — those answer
    // "What?" on the executive dashboard. These are purpose-built, assets-only
    // analytical widgets rendered through the same SectionCard compositor.
    // EXPERIMENT (UX): asset_allocation is placed first so the richer multi-mode
    // allocation chart sits ABOVE the Wealth by Account cards. Reversible.
    widgets: ["asset_allocation", "wealth_by_account", "institution_allocation", "wealth_concentration"],
    dataNeeds: ["accounts", "snapshots"], consumesShellTime: true, envelope: "wealth",
  },
  cashFlow: {
    id: "cashFlow", kind: "perspective", label: "Cash Flow", icon: "Waves", status: "available", group: "Financial",
    description: "Income versus spending over time.",
    // UX-PER-3 Cash Flow workspace. Doctrine: Cash Flow answers "Where does my
    // money move?" — movement over time from transaction history, FlowType-aware
    // (no net worth / allocation / debt / goals). Widgets share the workspace
    // period selector. Rendered through the same SectionCard compositor.
    // (income_vs_spending retired from the active list — Cash Flow History's
    //  bucket cards now surface income/spending/net; renderer kept for reuse.)
    //  Order: History → Spending by Category → Income/Cash In by Source → Debt Payments.
    widgets: ["cash_flow_summary", "cash_flow_history", "cash_flow_by_category", "income_by_source", "debt_payments"],
    // A temporal Perspective: it consumes the canonical time model via the SD-0B
    // preset dimension (shell.derived.cashFlowPeriod → the workspace period), i.e.
    // its historical window follows the shared slice. (It reads the preset, not
    // asOf/compareTo directly; that is participation in canonical time.)
    dataNeeds: ["accounts", "transactions"], consumesShellTime: true, envelope: "cashFlow",
  },
  investments: {
    id: "investments", kind: "perspective", label: "Investments", icon: "TrendingUp", status: "available", group: "Financial",
    description: "What you own and what happened to it — holdings, weights, and the period's activity, valued as of any date.",
    // A10 Investments workspace. Doctrine: "What do I own, and what happened to
    // it?" — a real shell-driven time machine over the A10 Investments Time
    // Machine backend (holdings + weights, period activity, and the change
    // bridge), valued at the shell's resolved As Of / Compare To via REAL
    // historical pricing (the A8 price foundation). Wealth owns "how much am I
    // worth"; Investments never restates that hero. Per-holding gain/loss and
    // cost basis stay out — the data does not carry them, and unknown is
    // preferable to incorrect. SD-2 closeout: Investments carries NO widgets[] —
    // it renders via the dedicated WORKSPACE_RENDERERS.investments entry
    // (components/space/workspaces/workspaceRenderers.tsx), and "is this lens
    // workspace-backed?" is answered by that renderer map, not widget presence.
    // The former "investment_accounts" registry widget and the "investments_workspace"
    // affordance marker are both retired.
    // M2 canonical IA: Investments is a specialized Workspace (perspective)
    // selected through Overview — NOT a routed modal. Its former
    // `routing.targetTab: "INVESTMENTS"` (RoutedWorkspaceModal) is retired so it
    // has ONE runtime destination. Legacy `?tab=investments` links canonicalize
    // to `?perspective=investments` in the host URL layer.
    dataNeeds: ["accounts", "investmentsHistory"], consumesShellTime: true, envelope: "investments",
  },
  debt: {
    id: "debt", kind: "perspective", label: "Debt", icon: "CreditCard", status: "available", group: "Financial",
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
    // M2 canonical IA: Debt is a specialized Workspace (perspective) selected
    // through Overview — NOT a routed modal. Its former
    // `routing.targetTab: "DEBT"` (RoutedWorkspaceModal) is retired so it has ONE
    // runtime destination. Legacy `?tab=debt` / `?tab=credit` links canonicalize
    // to `?perspective=debt` in the host URL layer.
    // A temporal Perspective: current-state KPIs plus a historical Balance-Over-
    // Time view over the snapshot series. consumesShellTime is the intended
    // contract (asOf/compareTo windowing of that history); today the chart shows
    // the full series rather than clipping to the shell window — a runtime gap to
    // close during Debt workspace extraction, NOT a different category.
    dataNeeds: ["accounts", "snapshots", "lens", "fico"], consumesShellTime: true, envelope: "lens",
  },
  /**
   * First library entry born lens-backed: no host tab behind it, no
   * comingSoon placeholder — its card content IS the engine's answer
   * (verdict + headline via /api/spaces/[id]/perspectives). Until hosts
   * render lens results, the card falls back to this static description.
   */
  liquidity: {
    id: "liquidity", kind: "perspective", label: "Liquidity", icon: "Droplets", status: "available", group: "Financial",
    description: "How much you could get at, and how fast.",
    lensId: "liquidity",
    // UX-PER-3 Liquidity workspace. Doctrine: Liquidity answers "How accessible
    // is my money?" — access and readiness, not total wealth. Assets only;
    // purpose-built widgets (no Overview / Wealth widget reuse). Rendered
    // through the same SectionCard compositor as virtual sections.
    widgets: ["liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration"],
    // A temporal Perspective by contract (consumesShellTime: true) — and, as of
    // SD-6B, temporal in RUNTIME too: LiquidityWorkspace activates the historical
    // engine (LiquiditySpaceData) end-to-end, so asOf/compareTo reconstruct the
    // Liquidity Ladder and yield a per-tier delta. The former current-state-only gap
    // is closed; the per-account current-anchor widgets remain live-state readings.
    dataNeeds: ["accounts", "transactions", "lens"], consumesShellTime: true, envelope: "lens",
  },
  retirement: {
    id: "retirement", kind: "perspective", label: "Retirement", icon: "PiggyBank", status: "available", group: "Retirement",
    description: "Progress toward retirement targets.",
    // Routes to the legacy RETIREMENT tab (GlassModal); no Perspectives workspace
    // of its own (no widgets[]), so no dataNeeds/consumesShellTime/envelope.
    routing: { targetTab: "RETIREMENT" },
  },
  goals: {
    // SD-2B doctrine correction: Goals is a STANDARD (domain) Workspace, NOT a
    // Perspective. A Perspective is a temporal financial LENS over the canonical
    // financial knowledge (participates in asOf/compareTo); Goals is goal
    // management — its own domain (progress, forecasting, projections, guidance
    // may come later, but that does not make it a temporal lens). It is kept in
    // PERSPECTIVE_LIBRARY (so today's Perspectives sub-nav card + workspace render
    // are byte-unchanged) but tagged kind:"standard"; consumesShellTime is false.
    // Physical relocation to STANDARD_WORKSPACES (and out of the sub-nav) is a
    // functionality change deferred to the Goals workspace slice.
    id: "goals", kind: "standard", label: "Goals", icon: "Target", status: "available", group: "Goals",
    description: "Savings and habit goals tied to this Space.",
    routing: { targetTab: "GOALS" },
    dataNeeds: ["accounts", "goals"], consumesShellTime: false, envelope: "none",
    // Doctrine: Goals answers "Am I on track?" — trajectory vs target, not current
    // balances. Rendered through the same SectionCard compositor.
    widgets: ["goal_progress", "goal_on_track", "goal_required_pace", "goal_funding_gap"],
  },
  tax: {
    id: "tax", kind: "perspective", label: "Tax", icon: "FileText", status: "comingSoon", group: "Tax",
    description: "Tax-relevant activity and documents.",
  },
  property: {
    id: "property", kind: "perspective", label: "Property", icon: "Home", status: "comingSoon", group: "Property",
    description: "Equity, mortgage, and value over time.",
  },
  businessHealth: {
    id: "businessHealth", kind: "perspective", label: "Business Health", icon: "Briefcase", status: "comingSoon", group: "Business",
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

// ── SD-2B canonical UNIVERSAL workspace registry ───────────────────────────────
// WORKSPACE_REGISTRY is the ONE identity authority over every primary Space
// destination — both "standard" structural workspaces (Overview, Transactions,
// Accounts, Activity, Members) and "perspective" financial lenses. It is composed
// from two DISJOINT-id sources so there is no duplicate identity:
//   • STANDARD_WORKSPACES — the structural destinations that have no perspective
//     card/lens metadata (Transactions/Accounts/Activity/Members). "overview"
//     lives in PERSPECTIVE_LIBRARY already (it powers the composition switcher),
//     tagged kind:"standard", so it is NOT re-declared here.
//   • PERSPECTIVE_LIBRARY — the financial lenses (+ the overview composition).
// PERSPECTIVE_LIBRARY remains the narrower perspective-only view that the
// Perspectives sub-nav / cards / composition switcher read (getPerspectivesFor-
// Category etc. are unchanged). Routing helpers below answer "which tab owns this
// workspace / is it modal-routed / what chrome does the modal show?".

/**
 * The structural (non-Perspective) primary destinations that render directly in
 * the SpaceShell workspace slot. Base WorkspaceDefinitions — no lens/card
 * metadata. Icons mirror lib/space-nav-icons SPACE_TAB_ICON_MAP (the rail still
 * renders from that map; these are the canonical identity + SD-3 dataNeeds).
 * ACTIVITY/MEMBERS self-fetch (TimelineWidget / SpaceMembersWidget), so their
 * host-provided dataNeeds are minimal.
 */
export const STANDARD_WORKSPACES: Record<string, WorkspaceDefinition> = {
  transactions: {
    id: "transactions", kind: "standard", label: "Transactions", icon: "ArrowLeftRight",
    dataNeeds: ["accounts", "transactions"], consumesShellTime: false, envelope: "none",
  },
  accounts: {
    id: "accounts", kind: "standard", label: "Accounts", icon: "Landmark",
    dataNeeds: ["accounts", "sections", "snapshots"], consumesShellTime: false, envelope: "none",
  },
  activity: {
    id: "activity", kind: "standard", label: "Activity", icon: "Activity",
    // The recent_activity SECTION renders here; TimelineWidget self-fetches its rows.
    dataNeeds: ["sections"], consumesShellTime: false, envelope: "none",
  },
  members: {
    id: "members", kind: "standard", label: "Members", icon: "Users",
    // SpaceMembersWidget self-fetches; the host provides no primitives.
    dataNeeds: [], consumesShellTime: false, envelope: "none",
  },
};

/** The ONE canonical workspace registry — the UNIVERSAL identity authority over
 *  every primary Space destination, across domains: finance standard destinations
 *  + finance perspectives + (OPS-5 S6) Platform Operations workspaces. Keyed by id
 *  with disjoint id sets (Platform ids are "platform-*"-namespaced), so no identity
 *  is duplicated and no finance helper (getPerspectivesForCategory, ROUTED_WORKSPACE_
 *  TABS, …) ever sees a Platform entry: those read PERSPECTIVE_LIBRARY or filter on
 *  finance-only fields the Platform defs deliberately omit. This is the SD-2/SD-3
 *  "second real consumer" convergence — Platform reuses the universal registry, NOT
 *  a parallel identity system. PLATFORM_WORKSPACES lives in its own domain module
 *  (lib/platform/workspaces.ts); the finance file only unions it in here. */
export const WORKSPACE_REGISTRY: Record<string, WorkspaceDefinition> = {
  ...STANDARD_WORKSPACES,
  ...PERSPECTIVE_LIBRARY,
  ...PLATFORM_WORKSPACES,
};

/** Deterministic lookup by workspace id; undefined for unknown ids (fails safe). */
export function getWorkspaceDefinition(id: string): WorkspaceDefinition | undefined {
  return WORKSPACE_REGISTRY[id];
}

/**
 * The Workspace a top-level Space tab id resolves to (the tab's lowercased id is
 * the workspace id): OVERVIEW→overview, TRANSACTIONS→transactions, GOALS→goals,
 * DEBT→debt, … . Container/non-workspace tabs (PERSPECTIVES, FINANCES, DOCUMENTS,
 * SETTINGS) resolve to undefined. Lets SD-3 look up any primary destination's
 * dataNeeds uniformly, without a Transactions/Accounts exception path.
 */
export function getWorkspaceForTab(tab: string): WorkspaceDefinition | undefined {
  return getWorkspaceDefinition(tab.toLowerCase());
}

/** The legacy tab a workspace routes to from the Overview doorway (→ GlassModal),
 *  or undefined. Replaces the host-side PERSPECTIVE_TARGET_TAB map. */
export function getWorkspaceTargetTab(id: string): RoutedWorkspaceTab | undefined {
  return WORKSPACE_REGISTRY[id]?.routing?.targetTab;
}

/** Every distinct routed (modal) tab, derived from the registry. Replaces the
 *  host-side PERSPECTIVE_ROUTED_TABS array. */
export const ROUTED_WORKSPACE_TABS: readonly RoutedWorkspaceTab[] = Array.from(
  new Set(
    Object.values(WORKSPACE_REGISTRY)
      .map((d) => d.routing?.targetTab)
      .filter((t): t is RoutedWorkspaceTab => t != null),
  ),
);

/** Is this activeTab id a routed (modal-presented) workspace tab? */
export function isRoutedWorkspaceTab(tab: string): boolean {
  return (ROUTED_WORKSPACE_TABS as readonly string[]).includes(tab);
}

/**
 * Modal chrome for a routed tab, derived from the owning workspace's own label +
 * icon — replaces the host-side PERSPECTIVE_MODAL_META map. `icon` is the Lucide
 * icon NAME (resolve via lib/perspective-icons PERSPECTIVE_ICON_MAP, the same
 * resolver the tabs/cards use). Undefined for a non-routed tab.
 */
export function getWorkspaceModalMeta(tab: string): { title: string; icon: string } | undefined {
  const def = Object.values(WORKSPACE_REGISTRY).find((d) => d.routing?.targetTab === tab);
  return def ? { title: def.label, icon: def.icon } : undefined;
}

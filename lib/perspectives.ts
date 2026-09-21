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
 *     current dashboard (e.g. Investments, Debt) — rendered through its
 *     WORKSPACE_RENDERERS entry. No new logic, just a new entry point.
 *   - "comingSoon": no real feature exists yet (Tax, Property, Business
 *     Health as dedicated views) — the host renders a calm placeholder card.
 *
 * W2 (product decision, FINAL): the GOALS and RETIREMENT surfaces are
 * RETIRED outright — their library entries, the "goals" data need, the
 * widgets[] virtual-section path, and the whole routed-modal (GlassModal)
 * mechanism (RoutedWorkspaceTab / WorkspaceRouting / ROUTED_WORKSPACE_TABS /
 * isRoutedWorkspaceTab / getWorkspaceTargetTab / getWorkspaceModalMeta) went
 * with them: Goals and Retirement were its last two members. Do not
 * reintroduce either surface or the routed-modal mechanism; a future lens
 * ships as a WORKSPACE_RENDERERS-backed Perspective instead.
 */

// Type-only import — erased at compile time, so this client-safe config file
// pulls no engine (server) code into any bundle. The engine itself never
// imports this file; the coupling is one-directional and nominal.
import type { LensId } from "@/lib/perspective-engine/types";
// OPS-5 S6 — Platform Operations workspace identities, owned by their own domain
// module and unioned into the universal registry below (value import; the module is
// a client-safe config file with no engine/server code, exactly like this one).
import { PLATFORM_WORKSPACES } from "@/lib/platform/workspaces";
import { CONNECTIONS_WORKSPACES } from "@/lib/connections/workspaces";
import { SETTINGS_WORKSPACES } from "@/lib/settings/workspaces";

export type PerspectiveStatus = "available" | "comingSoon";

/**
 * Sub-nav grouping for the full Perspectives tab — lets a Space with many
 * lenses (today 9, eventually more) be filtered down instead of scrolled
 * through. "All" is the implicit default and is not itself a lens group.
 */
export const PERSPECTIVE_GROUPS = [
  "All", "Financial", "Tax", "Business", "Property",
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

/**
 * How much of a workspace INTERPRETS a given axis of canonical Space time.
 *   "full"    — the whole workspace reflects this axis.
 *   "partial" — the workspace PARTICIPATES in this axis, but only part of the
 *               current implementation reflects it (a capability GAP to close,
 *               NOT permanent non-participation — e.g. Liquidity's historical
 *               Ladder is temporal while its per-account panels stay current).
 *   "none"    — this axis is not part of the workspace's temporal model.
 * For the point-in-time axes (asOf/compareTo) the shell renders the EXPLICIT date
 * input iff the axis !== "none" ("partial" still renders — valid for the temporal
 * portions). The full/partial distinction is semantic metadata for future trust.
 */
export type TemporalCapabilityLevel = "full" | "partial" | "none";

/**
 * Per-workspace declaration of HOW a workspace interprets canonical Space time —
 * NOT whether the user may select it. The universal preset/time slicer
 * (WTD/MTD/QTD/YTD/1W/1M/…) is how EVERY Perspective selects canonical
 * {preset, asOf, compareTo}; it is always available and is NOT gated by this.
 *
 *   asOf / compareTo — does the workspace expose an EXPLICIT point-in-time date
 *                      input? (gates only that input — see temporalControlVisibility)
 *   period           — does the workspace interpret the selected canonical RANGE as
 *                      a period-native analytical window (Cash Flow's model)? Cash
 *                      Flow is `full` here and `none` on the explicit axes: it
 *                      participates in canonical time (via period) yet exposes no
 *                      literal As-of/Compare-to inputs. `period` does NOT gate the
 *                      slicer — it is a semantic descriptor of interpretation.
 *
 * Replaces the coarse (and stale) `consumesShellTime` boolean — that is now DERIVED
 * from any axis !== "none" (workspaceConsumesShellTime).
 */
export interface TemporalCapability {
  asOf:      TemporalCapabilityLevel;
  compareTo: TemporalCapabilityLevel;
  period:    TemporalCapabilityLevel;
}

// (W2) The routed-modal routing vocabulary (RoutedWorkspaceTab / WorkspaceRouting
// / the `routing` field) is DELETED: Debt & Investments left the routed path in
// M2, and Goals & Retirement — its last two members — are retired outright in W2.
// No workspace routes to a legacy modal tab anymore; do not reintroduce the
// mechanism.

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
   * and only domain until Platform Operations became the second real consumer;
   * UI-Convergence Wave 1 added the user-owned "connections" and "settings" utility
   * surfaces as further consumers). The finance-scoped metadata below
   * (dataNeeds/temporalCapability/envelope) uses finance VOCABULARIES
   * (WorkspaceDataNeed / WorkspaceEnvelopeSource); a non-finance
   * workspace ("platform" / "connections" / "settings") declares NONE of them: its
   * bodies self-fetch, carry no finance envelope, and navigate via their own rail.
   * This discriminator + the guards in
   * lib/platform/workspaces.test.ts and lib/{connections,settings}/workspaces.test.ts
   * is what keeps finance vocabularies from polluting non-finance definitions —
   * WITHOUT a base/PersonalFinance type split (which SD-3 forbids: dataNeeds is
   * universal orchestration metadata by design).
   */
  domain?: "finance" | "platform" | "connections" | "settings";
  /** The data primitives this workspace consumes at runtime — declared for SD-3
   *  (no fetch behavior changes here). Empty ⇒ the workspace self-fetches. */
  dataNeeds?: readonly WorkspaceDataNeed[];
  /**
   * Per-axis declaration of how this workspace INTERPRETS canonical Space time
   * (asOf / compareTo / period). The SINGLE source of truth for temporal
   * participation — the former coarse `consumesShellTime` boolean is now DERIVED
   * from this (workspaceConsumesShellTime). Absent ⇒ the workspace consumes no
   * canonical time axis. The shell gates only the EXPLICIT As-of/Compare-to date
   * inputs by these axes (temporalControlVisibility); the universal preset/time
   * slicer is rendered for every Perspective regardless.
   */
  temporalCapability?: TemporalCapability;
  /** The trust-envelope source for this workspace (see WorkspaceEnvelopeSource). */
  envelope?: WorkspaceEnvelopeSource;
  /**
   * OVERVIEW-CONSOLIDATION — data primitives a workspace consumes ONLY in one of
   * its page-level MODES, keyed by mode id. The Net Worth workspace hosts Total ·
   * Assets · Debt; opening Assets activates the former Liquidity + Investments
   * fetches, opening Debt the former Debt ones — declared here so the host keeps
   * reading ONE registry (openPerspectiveDataNeeds unions base + mode) instead
   * of growing per-mode booleans. Absent ⇒ the workspace has no modal needs.
   */
  modeDataNeeds?: Readonly<Record<string, readonly WorkspaceDataNeed[]>>;
}

/**
 * DERIVED — whether a workspace participates in canonical shell time at all
 * (any axis !== "none"). This is the single-source replacement for the former
 * stored `consumesShellTime` field: read this, never duplicate the boolean.
 */
export function workspaceConsumesShellTime(def: WorkspaceDefinition): boolean {
  const c = def.temporalCapability;
  return !!c && (c.asOf !== "none" || c.compareTo !== "none" || c.period !== "none");
}

/**
 * DERIVED — which EXPLICIT point-in-time controls (the As-of / Compare-to date
 * inputs) a workspace should render. Each shows iff its axis is not "none"
 * ("partial" still renders — valid for the temporal portions). Undefined
 * capability ⇒ both shown (the pre-declaration default).
 *
 * This does NOT govern the preset/time slicer — that is the UNIVERSAL way to select
 * canonical time and is rendered for every Perspective (the `period` axis describes
 * interpretation, not slicer availability).
 */
export function temporalControlVisibility(cap: TemporalCapability | undefined): {
  asOf: boolean; compareTo: boolean;
} {
  return {
    asOf:      cap ? cap.asOf      !== "none" : true,
    compareTo: cap ? cap.compareTo !== "none" : true,
  };
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
  // (W2) The UX-PER-3 `widgets?` virtual-section path is DELETED with its last
  // consumer (the Goals workspace): a Perspective is workspace-backed iff it has
  // a WORKSPACE_RENDERERS entry — there is no second (widgets[]/SectionCard)
  // render path anymore.
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
    dataNeeds: ["accounts", "sections", "snapshots", "transactions", "lens"], envelope: "none",
  },
  wealth: {
    id: "wealth", kind: "perspective", label: "Wealth", icon: "Gem", status: "available", group: "Financial",
    description: "Where your money is — assets by account, institution, and class.",
    // UX-PER-3 Wealth workspace. Doctrine: Wealth answers "Where is my money?"
    // (REVIEW-3: the widgets[] array was deleted — Wealth renders via its
    // dedicated WORKSPACE_RENDERERS entry, which always wins the dispatch.)
    //
    // OVERVIEW-CONSOLIDATION — this is the "Net Worth" Overview lens, read through
    // three page-level modes (Total · Assets · Debt). The former Liquidity and
    // Investments workspaces render INSIDE Assets (as Cash / Investments
    // sections) and the Debt workspace IS the Debt mode, so their data needs are
    // declared here PER MODE rather than on peer lenses: opening Assets or Debt
    // activates exactly the fetches the retired peer lens used to.
    dataNeeds: ["accounts", "snapshots"],
    modeDataNeeds: {
      assets: ["transactions", "lens", "investmentsHistory"],
      debt:   ["lens", "fico"],
    },
    temporalCapability: { asOf: "full", compareTo: "full", period: "none" },
    envelope: "wealth",
  },
  cashFlow: {
    id: "cashFlow", kind: "perspective", label: "Cash Flow", icon: "Waves", status: "available", group: "Financial",
    description: "Income versus spending over time.",
    // UX-PER-3 Cash Flow workspace. Doctrine: Cash Flow answers "Where does my
    // money move?" — movement over time from transaction history, FlowType-aware
    // (no net worth / allocation / debt / goals). (REVIEW-3: widgets[] deleted —
    // CashFlowWorkspace's WORKSPACE_RENDERERS entry always wins the dispatch.)
    // A temporal Perspective: it consumes the canonical time model via the SD-0B
    // preset dimension (shell.derived.cashFlowPeriod → the workspace period), i.e.
    // its historical window follows the shared slice. (It reads the preset, not
    // asOf/compareTo directly; that is participation in canonical time.)
    dataNeeds: ["accounts", "transactions"],
    // Fully temporal: the selected canonical range is anchored at asOf (the window's
    // END travels with asOf — historical Cash Flow), compareTo drives the then-vs-now
    // comparison (period@asOf vs period@compareTo), and the range is interpreted as a
    // period (Cash Flow's native model). It exposes the same As-of/Compare-to + slicer
    // controls as every lens; the difference is range interpretation, not participation.
    temporalCapability: { asOf: "full", compareTo: "full", period: "full" },
    envelope: "cashFlow",
  },
  // MARKETS (skeleton) — the third customer workspace: "How are my investments
  // and potential investments behaving?" Read through five views (Portfolio ·
  // Research · Fundamentals · Technicals · Watchlist — lib/markets/markets-mode).
  // Distinct from `investments` below: Net Worth → Assets VALUES holdings as
  // wealth; Markets will ANALYSE securities. A destination only for now — no
  // data needs, no engine lens (no lensId), no envelope, no time axis — so its
  // workspace self-renders empty states and the host activates no fetch for it.
  markets: {
    id: "markets", kind: "perspective", label: "Markets", icon: "ChartCandlestick", status: "available", group: "Financial",
    description: "How your investments, and the securities you follow, are behaving.",
    dataNeeds: [],
    temporalCapability: { asOf: "none", compareTo: "none", period: "none" },
    envelope: "none",
  },
  // OVERVIEW-CONSOLIDATION — `investments`, `debt` and `liquidity` are NO LONGER
  // Overview lens destinations: they render inside the Net Worth workspace
  // (Assets / Debt / Assets). Their registry entries remain because the engine
  // lenses (lensId), the category lists, the present-day verdict batch and the
  // Brief/AI consumers still read them; `?perspective=<id>` canonicalises to the
  // Net Worth mode (lib/wealth/wealth-mode.ts). None has a WORKSPACE_RENDERERS
  // entry any more.
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
    // selected through Overview — NOT a routed modal. Its former routed-modal
    // targetTab is retired so it has ONE runtime destination. Legacy
    // `?tab=investments` links canonicalize to `?perspective=investments` in
    // the host URL layer.
    dataNeeds: ["accounts", "investmentsHistory"],
    temporalCapability: { asOf: "full", compareTo: "full", period: "none" },
    envelope: "investments",
  },
  debt: {
    id: "debt", kind: "perspective", label: "Debt", icon: "CreditCard", status: "available", group: "Financial",
    description: "Balances, payoff pace, and credit health.",
    lensId: "debt",
    // UX-PER-3 Debt workspace. Doctrine: Debt answers "What do I owe?" and is
    // LIABILITIES ONLY — it explains the shape, cost, and risk of debt (no
    // assets / net worth / allocation / spending / goals). (REVIEW-3:
    // widgets[] deleted — DebtWorkspace's WORKSPACE_RENDERERS entry always
    // wins the dispatch.)
    // M2 canonical IA: Debt is a specialized Workspace (perspective) selected
    // through Overview — NOT a routed modal. Its former routed-modal targetTab
    // is retired so it has ONE runtime destination. Legacy `?tab=debt` /
    // `?tab=credit` links canonicalize to `?perspective=debt` in the host URL
    // layer.
    // temporalCapability PARTIAL: the lede + Balance-Over-Time chart + trust honor
    // asOf/compareTo, but the KPIs/utilization/payoff are present-day (dual-authority
    // from the accounts array) — a capability GAP to close, not a different category.
    dataNeeds: ["accounts", "snapshots", "lens", "fico"],
    temporalCapability: { asOf: "partial", compareTo: "partial", period: "none" },
    envelope: "lens",
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
    // is my money?" — access and readiness, not total wealth. Assets only.
    // (REVIEW-3: widgets[] deleted — LiquidityWorkspace's WORKSPACE_RENDERERS
    // entry always wins the dispatch.)
    // temporalCapability PARTIAL: asOf/compareTo reconstruct the Liquidity Ladder +
    // lede + per-tier delta (SD-6B historical engine), but the per-account panels
    // (Accessible Cash / Emergency Fund / Reachability / Concentration) remain
    // current-anchor live readings — a capability GAP to close, not a category.
    dataNeeds: ["accounts", "transactions", "lens"],
    temporalCapability: { asOf: "partial", compareTo: "partial", period: "none" },
    envelope: "lens",
  },
  // (W2, product decision FINAL) The "retirement" and "goals" entries are
  // DELETED — both surfaces are retired outright (no roadmap placeholder). An
  // unknown ?perspective= id degrades to the default lens in the host URL
  // layer, so old deep links resolve safely. Do not reintroduce either entry.
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
  // W2 — "goals" and "retirement" removed from every list: both lens entries
  // are deleted (surfaces retired outright).
  PERSONAL:        ["overview", "wealth", "cashFlow", "liquidity", "investments", "debt", "markets"],
  FAMILY:          ["overview", "wealth", "cashFlow", "liquidity", "debt", "markets"],
  RETIREMENT:      ["overview", "wealth", "investments", "cashFlow", "markets"],
  INVESTMENT:      ["overview", "investments", "wealth", "cashFlow", "markets"],
  // V25-CLOSE-4: `property` / `businessHealth` removed. They are comingSoon
  // lenses with no workspace, so as the 2nd id they led the Perspectives doorway
  // with a non-clickable "Soon" card — a template leading with something the user
  // cannot access. The equity hero (Property) and the cash-position hero +
  // cashFlow/liquidity lenses (Business) already carry each Space's story. Re-add
  // each id here only when its real workspace ships.
  PROPERTY:        ["overview", "cashFlow", "wealth", "markets"],
  VEHICLE:         ["overview", "wealth", "cashFlow", "markets"],
  BUSINESS:        ["overview", "cashFlow", "liquidity", "wealth", "markets"],
  DEBT_PAYOFF:     ["overview", "debt", "cashFlow", "wealth", "markets"],
  // Emergency funds exist to BE liquidity — the lens sits right up front.
  EMERGENCY_FUND:  ["overview", "liquidity", "wealth", "cashFlow", "markets"],
  GOAL:            ["overview", "wealth", "cashFlow", "markets"],
  TRIP:            ["overview", "cashFlow", "markets"],
  EQUIPMENT:       ["overview", "wealth", "cashFlow", "markets"],
  CUSTOM:          ["overview", "wealth", "cashFlow", "markets"],
  OTHER:           ["overview", "wealth", "cashFlow", "markets"],
};

const DEFAULT_PERSPECTIVES = ["overview", "wealth", "cashFlow", "markets"];

/** Returns the ordered Perspective definitions for a Space category. */
export function getPerspectivesForCategory(category: string): PerspectiveDef[] {
  const ids = PERSPECTIVES_BY_CATEGORY[category] ?? DEFAULT_PERSPECTIVES;
  return ids.map((id) => PERSPECTIVE_LIBRARY[id]).filter(Boolean);
}

// (REVIEW-3, slice F) getCompositionSwitcherItems was deleted with its sole
// consumer, the Overview summary canvas's PerspectiveSwitcher dropdown.

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
 * metadata. The rail renders text-only (lib/space-nav-icons was deleted in
 * REVIEW-3); these are the canonical identity + SD-3 dataNeeds.
 * ACTIVITY/MEMBERS self-fetch (TimelineWidget / MembersWorkspace's useSpaceMembers),
 * so their host-provided dataNeeds are minimal.
 */
export const STANDARD_WORKSPACES: Record<string, WorkspaceDefinition> = {
  transactions: {
    id: "transactions", kind: "standard", label: "Transactions", icon: "ArrowLeftRight",
    dataNeeds: ["accounts", "transactions"], envelope: "none",
  },
  accounts: {
    id: "accounts", kind: "standard", label: "Accounts", icon: "Landmark",
    dataNeeds: ["accounts", "sections", "snapshots"], envelope: "none",
  },
  activity: {
    id: "activity", kind: "standard", label: "Activity", icon: "Activity",
    // The recent_activity SECTION renders here; TimelineWidget self-fetches its rows.
    dataNeeds: ["sections"], envelope: "none",
  },
  members: {
    id: "members", kind: "standard", label: "Members", icon: "Users",
    // MembersWorkspace self-fetches its roster + invites; the host provides no primitives.
    dataNeeds: [], envelope: "none",
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
  // UI Convergence Wave 1 — the two GLOBAL, user-owned utility surfaces reuse the
  // universal identity authority (disjoint "connections-*"/"settings-*" namespaces,
  // domain:"connections"/"settings"), NOT a parallel registry. Their modules live
  // under lib/connections and lib/settings; this file only unions them in.
  ...CONNECTIONS_WORKSPACES,
  ...SETTINGS_WORKSPACES,
};

/** Deterministic lookup by workspace id; undefined for unknown ids (fails safe). */
export function getWorkspaceDefinition(id: string): WorkspaceDefinition | undefined {
  return WORKSPACE_REGISTRY[id];
}

/**
 * The Workspace a top-level Space tab id resolves to (the tab's lowercased id is
 * the workspace id): OVERVIEW→overview, TRANSACTIONS→transactions, DEBT→debt, … .
 * Container/non-workspace tabs (PERSPECTIVES, FINANCES, DOCUMENTS, SETTINGS)
 * resolve to undefined. Lets SD-3 look up any primary destination's dataNeeds
 * uniformly, without a Transactions/Accounts exception path.
 */
export function getWorkspaceForTab(tab: string): WorkspaceDefinition | undefined {
  return getWorkspaceDefinition(tab.toLowerCase());
}

// (W2) getWorkspaceTargetTab / ROUTED_WORKSPACE_TABS / isRoutedWorkspaceTab /
// getWorkspaceModalMeta are DELETED with the routed-modal (GlassModal) mechanism:
// Goals & Retirement were its last two members and both surfaces are retired
// outright. Every remaining workspace renders in place (rail tab or Overview
// lens); do not reintroduce a modal-routed tab path.

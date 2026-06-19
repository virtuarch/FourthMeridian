/**
 * Widget Registry
 *
 * Central source of truth for every section key the dashboard runtime knows
 * about. Each entry describes the widget's metadata, data requirements, config
 * schema, and implementation status.
 *
 * Design contract:
 *  - WorkspaceDashboard (the runtime compositor) looks up entries here.
 *  - Adding a new section type = add one entry here; no switch/case edits.
 *  - Placeholder entries keep the registry honest while real components land.
 *
 * ── Widget Primitive Rule ──────────────────────────────────────────────────────
 * Before creating a new widget component, ask:
 *   Can this be an AssetValue, Progress, Breakdown, Summary, or Timeline
 *   widget with a different adapter?
 *
 *   If yes  → write the adapter in WorkspaceDashboard SectionRegistry.
 *   If no   → define a new primitive in components/workspace/widgets/.
 *
 * This prevents widget sprawl. Every adapter-only addition costs ~15 lines.
 * Every new primitive costs ~200+ lines and a new mental model.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Companion to: WIDGET_META_ANALYSIS.md
 */

import { WorkspaceDashboardTab } from "@/lib/workspace-presets";

// ─── Data requirement ─────────────────────────────────────────────────────────

export type AccountVisibility = "FULL" | "BALANCE_ONLY" | "any";

export interface DataRequirement {
  /** account.type values that must be present in the workspace */
  accountTypes: string[];
  /** Minimum visibility level for those accounts */
  visibility: AccountVisibility;
  /** How many qualifying accounts must exist (default 1) */
  minCount?: number;
  /** Human-readable explanation shown in the widget picker when not met */
  reason: string;
}

// ─── Config schema ────────────────────────────────────────────────────────────

export type ConfigFieldType = "number" | "string" | "select" | "boolean" | "date";

export interface ConfigField {
  key:      string;
  label:    string;
  type:     ConfigFieldType;
  options?: { value: string; label: string }[];
  default?: unknown;
  hint?:    string;
}

// ─── Data tier ────────────────────────────────────────────────────────────────

/**
 * DataTier controls which API calls the dashboard shell must make before
 * rendering this widget.
 *
 * accounts      → GET /api/workspaces/[id]/accounts     (NormalizedAccount[])
 * goals         → GET /api/workspaces/[id]/goals         (WorkspaceGoal[])
 * activity      → GET /api/workspaces/[id]/activity      (TimelineEvent[])
 * holdings      → GET /api/workspaces/[id]/holdings      (future — Tier 4)
 * transactions  → aggregated tx data                      (future — Tier 5)
 * none          → no external data (config-only, etc.)
 */
export type DataTier = "accounts" | "goals" | "activity" | "holdings" | "transactions" | "none";

// ─── Widget meta ──────────────────────────────────────────────────────────────

export interface WidgetMeta {
  /** Stable machine-readable key — matches WorkspaceDashboardSection.key */
  key:              string;
  /** Display name in settings list and future picker */
  label:            string;
  /** One-line description shown in picker cards */
  description:      string;
  /** Default tab assignment */
  tab:              WorkspaceDashboardTab;
  /** Lucide icon name (string; caller imports the icon) */
  icon:             string;
  /** Which API data this widget needs */
  dataTier:         DataTier;
  /** Required data conditions — empty array = always renderable */
  requires:         DataRequirement[];
  /** Config fields read from WorkspaceDashboardSection.config */
  configSchema?:    ConfigField[];
  /** Card can be collapsed by the user. Default: true */
  collapsible?:     boolean;
  /** Card supports fullscreen/expand mode */
  fullscreenable?:  boolean;
  /**
   * If set, this key is a deprecated alias for another canonical key.
   * The registry will still render it (via whatever component is mapped),
   * but the settings UI can show a deprecation notice.
   */
  deprecatedAlias?: string;
}

// ─── Registry entry ───────────────────────────────────────────────────────────

export interface WidgetRegistryEntry {
  meta:        WidgetMeta;
  /**
   * True  → a real component is wired up in the SectionRegistry inside
   *          WorkspaceDashboard.tsx. Renders meaningful data.
   * False → falls back to ContextualCard (placeholder).
   */
  implemented: boolean;
  /**
   * True → registered, rendered, but the component is a stub ("coming soon").
   * Only set this when `implemented` is also true.
   */
  isStub?: boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry: WidgetRegistryEntry[] = [

  // ── Net Worth ───────────────────────────────────────────────────────────────

  {
    implemented: true,
    meta: {
      key:         "net_worth",
      label:       "Net Worth",
      description: "Total assets minus total debt across all shared accounts.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "LayoutDashboard",
      dataTier:    "accounts",
      requires:    [],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:              "net_worth_section",
      label:            "Net Worth (legacy alias)",
      description:      "Alias for net_worth. Deprecated — prefer net_worth.",
      tab:              WorkspaceDashboardTab.OVERVIEW,
      icon:             "LayoutDashboard",
      dataTier:         "accounts",
      requires:         [],
      collapsible:      true,
      deprecatedAlias:  "net_worth",
    },
  },

  // ── Accounts ────────────────────────────────────────────────────────────────

  {
    implemented: true,
    meta: {
      key:         "accounts_overview",
      label:       "Accounts Overview",
      description: "All shared accounts grouped by type with balances.",
      tab:         WorkspaceDashboardTab.ACCOUNTS,
      icon:        "Landmark",
      dataTier:    "accounts",
      requires:    [],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "business_accounts",
      label:       "Business Accounts",
      description: "Shared business accounts grouped by type with balances.",
      tab:         WorkspaceDashboardTab.ACCOUNTS,
      icon:        "Landmark",
      dataTier:    "accounts",
      requires:    [],
      collapsible: true,
    },
  },

  // ── Debt ────────────────────────────────────────────────────────────────────

  {
    implemented: true,
    meta: {
      key:         "debt_summary",
      label:       "Debt Summary",
      description: "Total outstanding debt across all shared debt accounts.",
      tab:         WorkspaceDashboardTab.DEBT,
      icon:        "CreditCard",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["debt"],
          visibility:   "any",
          reason:       "Share a debt account to see totals.",
        },
      ],
      collapsible: true,
    },
  },

  {
    // Placeholder — currently renders DebtCard (same as debt_summary).
    // Intended: per-account payoff progress bars.
    implemented: false,
    meta: {
      key:         "debt_payoff_tracker",
      label:       "Debt Payoff Tracker",
      description: "Per-account progress bars showing payoff progress toward zero.",
      tab:         WorkspaceDashboardTab.DEBT,
      icon:        "CreditCard",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["debt"],
          visibility:   "FULL",
          reason:       "Requires full account access to show payoff progress.",
        },
      ],
      configSchema: [
        {
          key:     "strategy",
          label:   "Payoff strategy",
          type:    "select",
          options: [
            { value: "avalanche", label: "Avalanche (highest rate first)" },
            { value: "snowball",  label: "Snowball (lowest balance first)" },
          ],
          default: "avalanche",
        },
      ],
      collapsible: true,
    },
  },

  {
    // Placeholder — currently renders DebtCard.
    // Intended: mortgage amortization progress, equity built, payoff date.
    implemented: false,
    meta: {
      key:         "mortgage_tracker",
      label:       "Mortgage Tracker",
      description: "Mortgage amortization progress: equity built and payoff date estimate.",
      tab:         WorkspaceDashboardTab.DEBT,
      icon:        "Home",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["debt"],
          visibility:   "FULL",
          reason:       "Share your mortgage account at full access to see amortization.",
        },
      ],
      configSchema: [
        { key: "originalBalance", label: "Original loan amount ($)", type: "number" },
        { key: "closingDate",     label: "Loan origination date",    type: "date"   },
      ],
      collapsible: true,
    },
  },

  {
    // Placeholder — currently renders DebtCard.
    // Intended: auto-loan payoff progress, same pattern as mortgage_tracker.
    implemented: false,
    meta: {
      key:         "auto_loan_tracker",
      label:       "Auto Loan Tracker",
      description: "Auto loan payoff progress and estimated payoff date.",
      tab:         WorkspaceDashboardTab.DEBT,
      icon:        "Car",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["debt"],
          visibility:   "FULL",
          reason:       "Share your auto loan account at full access.",
        },
      ],
      configSchema: [
        { key: "originalBalance", label: "Original loan amount ($)", type: "number" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "debt_breakdown_chart",
      label:       "Debt Breakdown",
      description: "Interactive donut chart breaking down debt by account.",
      tab:         WorkspaceDashboardTab.DEBT,
      icon:        "PieChart",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["debt"],
          visibility:   "FULL",
          reason:       "Requires full access to show interest rates and minimums.",
        },
      ],
      collapsible: false, // explicitly non-collapsible in current UI
    },
  },

  {
    implemented: true,
    meta: {
      key:            "debt_payoff_calculator",
      label:          "Payoff Planner",
      description:    "Simulate debt payoff timelines with avalanche and snowball strategies.",
      tab:            WorkspaceDashboardTab.DEBT,
      icon:           "Calculator",
      dataTier:       "accounts",
      requires:       [
        {
          accountTypes: ["debt"],
          visibility:   "FULL",
          minCount:     1,
          reason:       "Requires interest rate and minimum payment — share debt accounts at full access.",
        },
      ],
      configSchema: [
        {
          key:     "strategy",
          label:   "Default strategy",
          type:    "select",
          options: [
            { value: "avalanche", label: "Avalanche (highest rate first)" },
            { value: "snowball",  label: "Snowball (lowest balance first)" },
          ],
          default: "avalanche",
        },
      ],
      collapsible:    true,
      fullscreenable: true,
    },
  },

  // ── Investments ─────────────────────────────────────────────────────────────

  {
    // Placeholder — currently renders InvestmentsCard (balance list only).
    // Intended: portfolio summary with optional chart.
    implemented: false,
    meta: {
      key:         "investment_summary",
      label:       "Investment Summary",
      description: "Portfolio total and per-account balance list.",
      tab:         WorkspaceDashboardTab.INVESTMENTS,
      icon:        "TrendingUp",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["investment"],
          visibility:   "any",
          reason:       "Share an investment account to see your portfolio total.",
        },
      ],
      configSchema: [
        {
          key:     "timeRange",
          label:   "Chart time range",
          type:    "select",
          options: [
            { value: "1M",  label: "1 month"  },
            { value: "3M",  label: "3 months" },
            { value: "6M",  label: "6 months" },
            { value: "1Y",  label: "1 year"   },
            { value: "all", label: "All time" },
          ],
          default: "1Y",
        },
      ],
      collapsible: true,
    },
  },

  {
    // Placeholder — currently renders InvestmentsCard.
    // Intended: AllocationChart.tsx donut by asset class (needs holdings endpoint).
    implemented: false,
    meta: {
      key:         "investment_allocation",
      label:       "Investment Allocation",
      description: "Asset allocation breakdown across all investment accounts.",
      tab:         WorkspaceDashboardTab.INVESTMENTS,
      icon:        "PieChart",
      dataTier:    "holdings", // Tier 4 — needs GET /api/workspaces/[id]/holdings
      requires:    [
        {
          accountTypes: ["investment"],
          visibility:   "FULL",
          reason:       "Requires full access to show allocation details.",
        },
      ],
      collapsible: true,
    },
  },

  // ── Retirement ──────────────────────────────────────────────────────────────

  {
    // Placeholder — currently renders InvestmentsCard.
    // Intended: filtered investment list for retirement account types.
    implemented: false,
    meta: {
      key:         "retirement_accounts",
      label:       "Retirement Accounts",
      description: "IRA, 401k, Roth, and other retirement account balances.",
      tab:         WorkspaceDashboardTab.RETIREMENT,
      icon:        "Home",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["investment"],
          visibility:   "any",
          reason:       "Share retirement accounts to see balances.",
        },
      ],
      configSchema: [
        {
          key:     "retirementAccountTypes",
          label:   "Account types to include",
          type:    "select",
          options: [
            { value: "all",   label: "All investment accounts" },
            { value: "ira",   label: "IRA only"                },
            { value: "401k",  label: "401k only"               },
            { value: "roth",  label: "Roth only"               },
          ],
          default: "all",
          hint:    "Until sub-type tagging exists, this filters by name heuristic.",
        },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "retirement_progress",
      label:       "Retirement Progress",
      description: "Track progress toward a retirement savings target, with FV projection.",
      tab:         WorkspaceDashboardTab.RETIREMENT,
      icon:        "TrendingUp",
      dataTier:    "accounts", // reads investment account balances
      requires:    [
        {
          accountTypes: ["investment"],
          visibility:   "any",
          reason:       "Share investment accounts to track retirement progress.",
        },
      ],
      configSchema: [
        { key: "targetAmount",       label: "Retirement target ($)",         type: "number"             },
        { key: "retirementAge",      label: "Target retirement age",         type: "number"             },
        { key: "currentAge",         label: "Current age",                   type: "number"             },
        { key: "expectedReturn",     label: "Expected annual return (%)",    type: "number", default: 7 },
        { key: "annualContribution", label: "Annual contribution ($/year)",  type: "number"             },
      ],
      collapsible: true,
    },
  },

  // ── Goals ───────────────────────────────────────────────────────────────────

  {
    implemented: true,
    meta: {
      key:         "goals_progress",
      label:       "Goals",
      description: "Active, completed, and archived goals for this space.",
      tab:         WorkspaceDashboardTab.GOALS,
      icon:        "Target",
      dataTier:    "goals",
      requires:    [],
      collapsible: true,
    },
  },

  // ── Activity ────────────────────────────────────────────────────────────────

  {
    implemented: true,
    meta: {
      key:         "recent_activity",
      label:       "Recent Activity",
      description: "Member actions and account updates for this space.",
      tab:         WorkspaceDashboardTab.ACTIVITY,
      icon:        "Clock",
      dataTier:    "activity",   // fetches GET /api/workspaces/[id]/activity internally
      requires:    [],
      collapsible: true,
    },
  },

  // ── Overview / Cash Flow (Tier 5 — transaction widgets) ────────────────────
  // These cannot be built until transaction-level workspace data exists.
  // ContextualCard is rendered as placeholder.

  {
    implemented: false,
    meta: {
      key:         "cash_flow",
      label:       "Cash Flow",
      description: "Monthly income vs. expenses across shared accounts.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "ArrowLeftRight",
      dataTier:    "transactions", // Tier 5 — blocked
      requires:    [
        {
          accountTypes: ["checking", "savings"],
          visibility:   "FULL",
          reason:       "Requires transaction-level access. Not yet available.",
        },
      ],
      collapsible: true,
    },
  },

  {
    implemented: false,
    meta: {
      key:         "savings_rate",
      label:       "Savings Rate",
      description: "Monthly savings rate as a percentage of income.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Percent",
      dataTier:    "transactions", // Tier 5 — blocked
      requires:    [
        {
          accountTypes: ["checking", "savings"],
          visibility:   "FULL",
          reason:       "Requires transaction-level access. Not yet available.",
        },
      ],
      collapsible: true,
    },
  },

  {
    implemented: false,
    meta: {
      key:         "business_cash_flow",
      label:       "Business Cash Flow",
      description: "Business income vs. expenses across shared business accounts.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "ArrowLeftRight",
      dataTier:    "transactions", // Tier 5 — blocked
      requires:    [
        {
          accountTypes: ["checking", "savings"],
          visibility:   "FULL",
          reason:       "Requires transaction-level access. Not yet available.",
        },
      ],
      collapsible: true,
    },
  },

  {
    implemented: false,
    meta: {
      key:         "monthly_expenses",
      label:       "Monthly Expenses",
      description: "Total monthly spending broken down by category.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Receipt",
      dataTier:    "transactions", // Tier 5 — blocked
      requires:    [
        {
          accountTypes: ["checking"],
          visibility:   "FULL",
          reason:       "Requires transaction-level access. Not yet available.",
        },
      ],
      collapsible: true,
    },
  },

  // ── Config-driven asset value widgets ──────────────────────────────────────
  // All three share AssetValueWidget (components/workspace/widgets/AssetValueWidget.tsx).
  // The registry key distinguishes which assetType the widget advertises for
  // empty-state copy. Everything else — layout, maths, data contract — is identical.

  // ── NOTE on asset widget data model ─────────────────────────────────────────
  // Live value comes from FinancialAccount.balance (AccountType.other, syncStatus='manual').
  // WorkspaceDashboardSection.config holds rendering metadata ONLY — no dollar values.
  // The widget adapter in WorkspaceDashboard SectionRegistry filters accounts for
  // type='other' and passes the first match's balance as `accountBalance`.
  // TODO: when AccountType.asset lands, update requires[] to use 'asset' type.
  {
    implemented: true,
    meta: {
      key:         "property_value",
      label:       "Property Value",
      description: "Current estimated property value vs. purchase price, with gain/loss.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Home",
      dataTier:    "accounts", // reads balance from type=other account
      requires:    [
        {
          accountTypes: ["other"],
          visibility:   "any",
          reason:       "Add a manual asset account for your property to see its value here.",
        },
      ],
      configSchema: [
        // accountId pins this section to a specific FinancialAccount.
        // When set, the adapter skips name heuristics entirely.
        // Set via ManageWorkspaceModal asset section settings (account picker — TODO).
        { key: "accountId",       label: "Linked account (ID)",   type: "string" },
        // currentValue intentionally absent — lives in FinancialAccount.balance
        { key: "purchasePrice",   label: "Purchase price ($)",    type: "number" },
        { key: "purchaseDate",    label: "Purchase date",         type: "date"   },
        { key: "assetKind",       label: "Asset kind",            type: "select",
          options: [
            { value: "real_estate", label: "Real estate"  },
            { value: "land",        label: "Land"          },
            { value: "commercial",  label: "Commercial"    },
          ],
          default: "real_estate",
        },
        { key: "estimatedSource", label: "Estimate source",       type: "string" },
        { key: "notes",           label: "Notes (optional)",      type: "string" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "vehicle_value",
      label:       "Vehicle Value",
      description: "Current estimated vehicle value and depreciation since purchase.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Car",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["other"],
          visibility:   "any",
          reason:       "Add a manual asset account for your vehicle to see its value here.",
        },
      ],
      configSchema: [
        { key: "accountId",       label: "Linked account (ID)",   type: "string" },
        { key: "purchasePrice",   label: "Purchase price ($)",    type: "number" },
        { key: "purchaseDate",    label: "Purchase date",         type: "date"   },
        { key: "estimatedSource", label: "Estimate source",       type: "string" },
        { key: "notes",           label: "Notes (optional)",      type: "string" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "equipment_value",
      label:       "Equipment Value",
      description: "Current estimated equipment value and depreciation since purchase.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Wrench",
      dataTier:    "accounts",
      requires:    [
        {
          accountTypes: ["other"],
          visibility:   "any",
          reason:       "Add a manual asset account for your equipment to see its value here.",
        },
      ],
      configSchema: [
        { key: "accountId",       label: "Linked account (ID)",   type: "string" },
        { key: "purchasePrice",   label: "Purchase price ($)",    type: "number" },
        { key: "purchaseDate",    label: "Purchase date",         type: "date"   },
        { key: "estimatedSource", label: "Estimate source",       type: "string" },
        { key: "notes",           label: "Notes (optional)",      type: "string" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "trip_budget",
      label:       "Trip Budget",
      description: "Spending mode: track amount spent against a total trip budget cap.",
      tab:         WorkspaceDashboardTab.OVERVIEW,
      icon:        "Plane",
      dataTier:    "none", // config-only — spent amount is entered manually (no transactions yet)
      requires:    [],
      configSchema: [
        { key: "totalBudget",   label: "Total trip budget ($)",     type: "number" },
        { key: "amountSpent",   label: "Amount spent so far ($)",   type: "number" },
        { key: "departureDate", label: "Departure date",            type: "date"   },
        { key: "note",          label: "Note (optional)",           type: "string" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "trip_savings",
      label:       "Trip Savings",
      description: "Savings mode: track savings account balance toward a trip cost target.",
      tab:         WorkspaceDashboardTab.GOALS,
      icon:        "PiggyBank",
      dataTier:    "accounts", // reads savings account balances
      requires:    [
        {
          accountTypes: ["savings"],
          visibility:   "any",
          reason:       "Share a savings account to track trip savings balance.",
        },
      ],
      configSchema: [
        { key: "totalBudget",   label: "Trip savings target ($)", type: "number" },
        { key: "departureDate", label: "Departure date",          type: "date"   },
        { key: "note",          label: "Note (optional)",         type: "string" },
      ],
      collapsible: true,
    },
  },

  {
    implemented: true,
    meta: {
      key:         "emergency_fund_progress",
      label:       "Emergency Fund",
      description: "Savings mode: savings account balance vs. N months of expenses target.",
      tab:         WorkspaceDashboardTab.GOALS,
      icon:        "Shield",
      dataTier:    "accounts", // reads savings account balances
      requires:    [
        {
          accountTypes: ["savings"],
          visibility:   "any",
          reason:       "Share a savings account to track emergency fund balance.",
        },
      ],
      configSchema: [
        {
          key:     "targetMonths",
          label:   "Months of expenses to cover",
          type:    "select",
          options: [
            { value: "3",  label: "3 months"  },
            { value: "6",  label: "6 months"  },
            { value: "9",  label: "9 months"  },
            { value: "12", label: "12 months" },
          ],
          default: "6",
        },
        {
          key:   "monthlyExpenses",
          label: "Monthly expenses ($)",
          type:  "number",
          hint:  "Used to compute the target. Will auto-populate from the monthly_expenses widget when that widget is built.",
        },
      ],
      collapsible: true,
    },
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** Map of key → entry for O(1) lookup */
export const WIDGET_REGISTRY = new Map<string, WidgetRegistryEntry>(
  registry.map((e) => [e.meta.key, e]),
);

/** Returns the registry entry for a key, or undefined if not registered. */
export function getWidgetEntry(key: string): WidgetRegistryEntry | undefined {
  return WIDGET_REGISTRY.get(key);
}

/** Returns the WidgetMeta for a key, or undefined if not registered. */
export function getWidgetMeta(key: string): WidgetMeta | undefined {
  return WIDGET_REGISTRY.get(key)?.meta;
}

/** Returns true if the key is registered and has a real implementation. */
export function isWidgetImplemented(key: string): boolean {
  return WIDGET_REGISTRY.get(key)?.implemented === true;
}

/** Returns true if the key is a deprecated alias for another key. */
export function isDeprecatedAlias(key: string): boolean {
  return !!WIDGET_REGISTRY.get(key)?.meta.deprecatedAlias;
}

/** All registry entries as an array (useful for picker/settings UIs). */
export function getAllWidgets(): WidgetRegistryEntry[] {
  return registry;
}

/** All entries for a given tab, in registry order. */
export function getWidgetsForTab(tab: WorkspaceDashboardTab): WidgetRegistryEntry[] {
  return registry.filter((e) => e.meta.tab === tab);
}

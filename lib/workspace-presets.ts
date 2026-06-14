/**
 * Workspace preset definitions.
 *
 * Each workspace category maps to a list of default WorkspaceDashboardSection
 * records that are created automatically when a workspace is created.
 *
 * Rules:
 *  - Every workspace (regardless of category) gets a GOALS section.
 *  - Section keys are stable machine-readable identifiers — do not rename them
 *    once they exist in the database; update the label instead.
 *  - order is relative within the preset; 0 = first.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Local enum mirrors
// These match the Prisma schema values exactly. We define them locally so this
// file compiles before `prisma generate` has been re-run with the new schema.
// After `prisma generate`, you can optionally import from @prisma/client instead.
// ─────────────────────────────────────────────────────────────────────────────

export const WorkspaceCategory = {
  PERSONAL:       "PERSONAL",
  HOUSEHOLD:      "HOUSEHOLD",
  FAMILY:         "FAMILY",
  BUSINESS:       "BUSINESS",
  PROPERTY:       "PROPERTY",
  VEHICLE:        "VEHICLE",
  TRIP:           "TRIP",
  INVESTMENT:     "INVESTMENT",
  EQUIPMENT:      "EQUIPMENT",
  GOAL:           "GOAL",
  RETIREMENT:     "RETIREMENT",
  DEBT_PAYOFF:    "DEBT_PAYOFF",
  EMERGENCY_FUND: "EMERGENCY_FUND",
  CUSTOM:         "CUSTOM",
  OTHER:          "OTHER",
} as const;
export type WorkspaceCategory = typeof WorkspaceCategory[keyof typeof WorkspaceCategory];

export const WorkspaceDashboardTab = {
  OVERVIEW:    "OVERVIEW",
  GOALS:       "GOALS",
  ACCOUNTS:    "ACCOUNTS",
  DEBT:        "DEBT",
  INVESTMENTS: "INVESTMENTS",
  RETIREMENT:  "RETIREMENT",
  ACTIVITY:    "ACTIVITY",
  SETTINGS:    "SETTINGS",
} as const;
export type WorkspaceDashboardTab = typeof WorkspaceDashboardTab[keyof typeof WorkspaceDashboardTab];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionPreset {
  key:     string;
  label:   string;
  tab:     WorkspaceDashboardTab;
  enabled: boolean;
  order:   number;
  config?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared sections — injected into every workspace
// ─────────────────────────────────────────────────────────────────────────────

const GOALS_SECTION: SectionPreset = {
  key:     "goals_progress",
  label:   "Goals",
  tab:     WorkspaceDashboardTab.GOALS,
  enabled: true,
  order:   0,
};

const ACCOUNTS_SECTION: SectionPreset = {
  key:     "accounts_overview",
  label:   "Accounts",
  tab:     WorkspaceDashboardTab.ACCOUNTS,
  enabled: true,
  order:   0,
};

const ACTIVITY_SECTION: SectionPreset = {
  key:     "recent_activity",
  label:   "Recent Activity",
  tab:     WorkspaceDashboardTab.ACTIVITY,
  enabled: true,
  order:   0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-category overview sections
// ─────────────────────────────────────────────────────────────────────────────

const NET_WORTH_SECTION: SectionPreset = {
  key:     "net_worth",
  label:   "Net Worth",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const CASH_FLOW_SECTION: SectionPreset = {
  key:     "cash_flow",
  label:   "Cash Flow",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const SAVINGS_RATE_SECTION: SectionPreset = {
  key:     "savings_rate",
  label:   "Savings Rate",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   2,
};

const DEBT_SUMMARY_SECTION: SectionPreset = {
  key:     "debt_summary",
  label:   "Debt Summary",
  tab:     WorkspaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

const DEBT_PAYOFF_TRACKER: SectionPreset = {
  key:     "debt_payoff_tracker",
  label:   "Payoff Tracker",
  tab:     WorkspaceDashboardTab.DEBT,
  enabled: true,
  order:   1,
};

const DEBT_BREAKDOWN_SECTION: SectionPreset = {
  key:     "debt_breakdown_chart",
  label:   "Debt Breakdown",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const DEBT_PAYOFF_CALC_SECTION: SectionPreset = {
  key:     "debt_payoff_calculator",
  label:   "Payoff Planner",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const INVESTMENT_SUMMARY: SectionPreset = {
  key:     "investment_summary",
  label:   "Portfolio Summary",
  tab:     WorkspaceDashboardTab.INVESTMENTS,
  enabled: true,
  order:   0,
};

const INVESTMENT_ALLOCATION: SectionPreset = {
  key:     "investment_allocation",
  label:   "Asset Allocation",
  tab:     WorkspaceDashboardTab.INVESTMENTS,
  enabled: true,
  order:   1,
};

const RETIREMENT_PROGRESS: SectionPreset = {
  key:     "retirement_progress",
  label:   "Retirement Progress",
  tab:     WorkspaceDashboardTab.RETIREMENT,
  enabled: true,
  order:   0,
};

const RETIREMENT_ACCOUNTS: SectionPreset = {
  key:     "retirement_accounts",
  label:   "Retirement Accounts",
  tab:     WorkspaceDashboardTab.RETIREMENT,
  enabled: true,
  order:   1,
};

const EMERGENCY_FUND_PROGRESS: SectionPreset = {
  key:     "emergency_fund_progress",
  label:   "Emergency Fund",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const MONTHLY_EXPENSES: SectionPreset = {
  key:     "monthly_expenses",
  label:   "Monthly Expenses",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const PROPERTY_VALUE: SectionPreset = {
  key:     "property_value",
  label:   "Property Value",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const MORTGAGE_TRACKER: SectionPreset = {
  key:     "mortgage_tracker",
  label:   "Mortgage",
  tab:     WorkspaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

const VEHICLE_VALUE: SectionPreset = {
  key:     "vehicle_value",
  label:   "Vehicle Value",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const AUTO_LOAN_TRACKER: SectionPreset = {
  key:     "auto_loan_tracker",
  label:   "Auto Loan",
  tab:     WorkspaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

const TRIP_BUDGET: SectionPreset = {
  key:     "trip_budget",
  label:   "Trip Budget",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const TRIP_SAVINGS: SectionPreset = {
  key:     "trip_savings",
  label:   "Trip Savings",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const BUSINESS_CASH_FLOW: SectionPreset = {
  key:     "business_cash_flow",
  label:   "Cash Flow",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const BUSINESS_ACCOUNTS: SectionPreset = {
  key:     "business_accounts",
  label:   "Business Accounts",
  tab:     WorkspaceDashboardTab.ACCOUNTS,
  enabled: true,
  order:   0,
};

const EQUIPMENT_VALUE: SectionPreset = {
  key:     "equipment_value",
  label:   "Equipment Value",
  tab:     WorkspaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Preset map
// Every workspace always gets GOALS_SECTION, ACCOUNTS_SECTION, ACTIVITY_SECTION
// on top of the category-specific sections below.
// ─────────────────────────────────────────────────────────────────────────────

const UNIVERSAL_SECTIONS: SectionPreset[] = [
  GOALS_SECTION,
  ACCOUNTS_SECTION,
  ACTIVITY_SECTION,
];

const PRESET_MAP: Record<WorkspaceCategory, SectionPreset[]> = {
  [WorkspaceCategory.PERSONAL]: [
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
    SAVINGS_RATE_SECTION,
    DEBT_SUMMARY_SECTION,
    INVESTMENT_SUMMARY,
  ],

  [WorkspaceCategory.HOUSEHOLD]: [
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
    SAVINGS_RATE_SECTION,
    DEBT_SUMMARY_SECTION,
    DEBT_PAYOFF_TRACKER,
  ],

  [WorkspaceCategory.FAMILY]: [
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
    SAVINGS_RATE_SECTION,
    DEBT_SUMMARY_SECTION,
  ],

  [WorkspaceCategory.BUSINESS]: [
    BUSINESS_CASH_FLOW,
    BUSINESS_ACCOUNTS,
    DEBT_SUMMARY_SECTION,
    INVESTMENT_SUMMARY,
  ],

  [WorkspaceCategory.PROPERTY]: [
    PROPERTY_VALUE,
    MORTGAGE_TRACKER,
    CASH_FLOW_SECTION,
  ],

  [WorkspaceCategory.VEHICLE]: [
    VEHICLE_VALUE,
    AUTO_LOAN_TRACKER,
    CASH_FLOW_SECTION,
  ],

  [WorkspaceCategory.TRIP]: [
    TRIP_BUDGET,
    TRIP_SAVINGS,
    CASH_FLOW_SECTION,
  ],

  [WorkspaceCategory.INVESTMENT]: [
    INVESTMENT_SUMMARY,
    INVESTMENT_ALLOCATION,
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
  ],

  [WorkspaceCategory.EQUIPMENT]: [
    EQUIPMENT_VALUE,
    DEBT_SUMMARY_SECTION,
    CASH_FLOW_SECTION,
  ],

  [WorkspaceCategory.RETIREMENT]: [
    RETIREMENT_PROGRESS,
    RETIREMENT_ACCOUNTS,
    INVESTMENT_ALLOCATION,
    NET_WORTH_SECTION,
  ],

  [WorkspaceCategory.DEBT_PAYOFF]: [
    DEBT_BREAKDOWN_SECTION,
    DEBT_PAYOFF_CALC_SECTION,
    DEBT_SUMMARY_SECTION,
    DEBT_PAYOFF_TRACKER,
  ],

  [WorkspaceCategory.EMERGENCY_FUND]: [
    EMERGENCY_FUND_PROGRESS,
    MONTHLY_EXPENSES,
    SAVINGS_RATE_SECTION,
    CASH_FLOW_SECTION,
  ],

  // Legacy value — treat same as GENERAL/blank
  [WorkspaceCategory.GOAL]: [
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
  ],

  // Blank slate — user builds their own
  [WorkspaceCategory.CUSTOM]: [],

  [WorkspaceCategory.OTHER]: [
    NET_WORTH_SECTION,
    CASH_FLOW_SECTION,
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full ordered list of sections for a workspace of the given
 * category, including the universal sections (Goals, Accounts, Activity) that
 * every workspace receives.
 *
 * Deduplication: if a category preset includes a key that also appears in
 * UNIVERSAL_SECTIONS, the preset version wins (overrides label/tab/order).
 */
export function getPresetsForCategory(
  // Accept both the local type and plain string (for seed / API routes pre-generate)
  category: WorkspaceCategory | string
): SectionPreset[] {
  const categoryPresets = PRESET_MAP[category as WorkspaceCategory] ?? [];

  // Keys that the category preset explicitly defines
  const categoryKeys = new Set(categoryPresets.map((s) => s.key));

  // Universal sections not already covered by the category preset
  const universalSections = UNIVERSAL_SECTIONS.filter(
    (s) => !categoryKeys.has(s.key)
  );

  // Combine: category-specific first, then universal addendums
  const combined = [...categoryPresets, ...universalSections];

  // Re-assign stable order across the full combined list per tab
  const byTab: Record<string, SectionPreset[]> = {};
  for (const s of combined) {
    (byTab[s.tab] ??= []).push(s);
  }

  const result: SectionPreset[] = [];
  for (const sections of Object.values(byTab)) {
    sections.forEach((s, i) => {
      result.push({ ...s, order: i });
    });
  }

  return result;
}

/**
 * Human-readable label for a WorkspaceCategory value.
 */
export const CATEGORY_LABELS: Record<WorkspaceCategory, string> = {
  [WorkspaceCategory.PERSONAL]:       "Personal",
  [WorkspaceCategory.HOUSEHOLD]:      "Household",
  [WorkspaceCategory.FAMILY]:         "Family",
  [WorkspaceCategory.BUSINESS]:       "Business",
  [WorkspaceCategory.PROPERTY]:       "Property",
  [WorkspaceCategory.VEHICLE]:        "Vehicle",
  [WorkspaceCategory.TRIP]:           "Trip / Vacation",
  [WorkspaceCategory.INVESTMENT]:     "Investment Portfolio",
  [WorkspaceCategory.EQUIPMENT]:      "Equipment",
  [WorkspaceCategory.RETIREMENT]:     "Retirement",
  [WorkspaceCategory.DEBT_PAYOFF]:    "Debt Payoff",
  [WorkspaceCategory.EMERGENCY_FUND]: "Emergency Fund",
  [WorkspaceCategory.GOAL]:           "Goal",
  [WorkspaceCategory.CUSTOM]:         "Custom",
  [WorkspaceCategory.OTHER]:          "Other",
};

/**
 * Short description shown in the template picker.
 */
export const CATEGORY_DESCRIPTIONS: Record<WorkspaceCategory, string> = {
  [WorkspaceCategory.PERSONAL]:       "Track your personal finances, net worth, and spending.",
  [WorkspaceCategory.HOUSEHOLD]:      "Manage shared finances with a partner or housemates.",
  [WorkspaceCategory.FAMILY]:         "Coordinate budgets and savings across your family.",
  [WorkspaceCategory.BUSINESS]:       "Oversee cash flow and accounts for a business or LLC.",
  [WorkspaceCategory.PROPERTY]:       "Track property value, mortgage, and rental income.",
  [WorkspaceCategory.VEHICLE]:        "Monitor vehicle value and auto loan progress.",
  [WorkspaceCategory.TRIP]:           "Budget and save for a specific trip or vacation.",
  [WorkspaceCategory.INVESTMENT]:     "Focus on portfolio performance and asset allocation.",
  [WorkspaceCategory.EQUIPMENT]:      "Track equipment value, loans, and maintenance costs.",
  [WorkspaceCategory.RETIREMENT]:     "Monitor retirement accounts and progress toward FIRE.",
  [WorkspaceCategory.DEBT_PAYOFF]:    "Strategize and track debt elimination across accounts.",
  [WorkspaceCategory.EMERGENCY_FUND]: "Build and protect your emergency savings buffer.",
  [WorkspaceCategory.GOAL]:           "Track progress toward a specific financial goal.",
  [WorkspaceCategory.CUSTOM]:         "Start from a blank slate and add sections yourself.",
  [WorkspaceCategory.OTHER]:          "General-purpose financial workspace.",
};

/**
 * Icon name (Lucide) for each category — used in the template picker grid.
 */
export const CATEGORY_ICONS: Record<WorkspaceCategory, string> = {
  [WorkspaceCategory.PERSONAL]:       "User",
  [WorkspaceCategory.HOUSEHOLD]:      "Home",
  [WorkspaceCategory.FAMILY]:         "Users",
  [WorkspaceCategory.BUSINESS]:       "Briefcase",
  [WorkspaceCategory.PROPERTY]:       "Building2",
  [WorkspaceCategory.VEHICLE]:        "Car",
  [WorkspaceCategory.TRIP]:           "Plane",
  [WorkspaceCategory.INVESTMENT]:     "TrendingUp",
  [WorkspaceCategory.EQUIPMENT]:      "Wrench",
  [WorkspaceCategory.RETIREMENT]:     "Sunset",
  [WorkspaceCategory.DEBT_PAYOFF]:    "CreditCard",
  [WorkspaceCategory.EMERGENCY_FUND]: "Shield",
  [WorkspaceCategory.GOAL]:           "Target",
  [WorkspaceCategory.CUSTOM]:         "LayoutDashboard",
  [WorkspaceCategory.OTHER]:          "MoreHorizontal",
};

/** Categories shown as primary options in the template picker (first row). */
export const PRIMARY_CATEGORIES: WorkspaceCategory[] = [
  WorkspaceCategory.HOUSEHOLD,
  WorkspaceCategory.FAMILY,
  WorkspaceCategory.DEBT_PAYOFF,
  WorkspaceCategory.EMERGENCY_FUND,
  WorkspaceCategory.RETIREMENT,
  WorkspaceCategory.INVESTMENT,
];

/** Categories shown as secondary options (second row / "more" section). */
export const SECONDARY_CATEGORIES: WorkspaceCategory[] = [
  WorkspaceCategory.BUSINESS,
  WorkspaceCategory.PROPERTY,
  WorkspaceCategory.VEHICLE,
  WorkspaceCategory.TRIP,
  WorkspaceCategory.EQUIPMENT,
  WorkspaceCategory.CUSTOM,
  WorkspaceCategory.OTHER,
];

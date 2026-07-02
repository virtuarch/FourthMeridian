/**
 * Space preset definitions.
 *
 * Each space category maps to a list of default SpaceDashboardSection
 * records that are created automatically when a space is created.
 *
 * Rules:
 *  - Every space (regardless of category) gets a GOALS section.
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

export const SpaceCategory = {
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
export type SpaceCategory = typeof SpaceCategory[keyof typeof SpaceCategory];

export const SpaceDashboardTab = {
  OVERVIEW:    "OVERVIEW",
  GOALS:       "GOALS",
  ACCOUNTS:    "ACCOUNTS",
  DEBT:        "DEBT",
  INVESTMENTS: "INVESTMENTS",
  RETIREMENT:  "RETIREMENT",
  ACTIVITY:    "ACTIVITY",
  SETTINGS:    "SETTINGS",
} as const;
export type SpaceDashboardTab = typeof SpaceDashboardTab[keyof typeof SpaceDashboardTab];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionPreset {
  key:     string;
  label:   string;
  tab:     SpaceDashboardTab;
  enabled: boolean;
  order:   number;
  config?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared sections — injected into every space
// ─────────────────────────────────────────────────────────────────────────────

const GOALS_SECTION: SectionPreset = {
  key:     "goals_progress",
  label:   "Goals",
  tab:     SpaceDashboardTab.GOALS,
  enabled: true,
  order:   0,
};

const ACCOUNTS_SECTION: SectionPreset = {
  key:     "accounts_overview",
  label:   "Accounts",
  tab:     SpaceDashboardTab.ACCOUNTS,
  enabled: true,
  order:   0,
};

const ACTIVITY_SECTION: SectionPreset = {
  key:     "recent_activity",
  label:   "Recent Activity",
  tab:     SpaceDashboardTab.ACTIVITY,
  enabled: true,
  order:   0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-category overview sections
// ─────────────────────────────────────────────────────────────────────────────

const NET_WORTH_SECTION: SectionPreset = {
  key:     "net_worth",
  label:   "Net Worth",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

// Space Template Redesign (approved investigation): CASH_FLOW_SECTION,
// SAVINGS_RATE_SECTION, MONTHLY_EXPENSES, and BUSINESS_CASH_FLOW were
// removed from this file. Their keys have no SectionRegistry renderer, so
// every preset that referenced them seeded a PERMANENT "coming soon" card
// — a template promising a story the product can't tell ("the template
// earns its modules"). Re-add each one only together with its real widget.

const DEBT_SUMMARY_SECTION: SectionPreset = {
  key:     "debt_summary",
  label:   "Debt Summary",
  tab:     SpaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

// DEBT_PAYOFF_TRACKER removed (template redesign): its key rendered a
// debt-summary alias under a "Payoff Tracker" label — a real widget wearing
// a misleading name. Re-add when a real payoff tracker exists.

const DEBT_BREAKDOWN_SECTION: SectionPreset = {
  key:     "debt_breakdown_chart",
  label:   "Debt Breakdown",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const DEBT_PAYOFF_CALC_SECTION: SectionPreset = {
  key:     "debt_payoff_calculator",
  label:   "Payoff Planner",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const INVESTMENT_SUMMARY: SectionPreset = {
  key:     "investment_summary",
  label:   "Portfolio Summary",
  tab:     SpaceDashboardTab.INVESTMENTS,
  enabled: true,
  order:   0,
};

const INVESTMENT_ALLOCATION: SectionPreset = {
  key:     "investment_allocation",
  label:   "Asset Allocation",
  tab:     SpaceDashboardTab.INVESTMENTS,
  enabled: true,
  order:   1,
};

const RETIREMENT_PROGRESS: SectionPreset = {
  key:     "retirement_progress",
  label:   "Retirement Progress",
  tab:     SpaceDashboardTab.RETIREMENT,
  enabled: true,
  order:   0,
};

const RETIREMENT_ACCOUNTS: SectionPreset = {
  key:     "retirement_accounts",
  label:   "Retirement Accounts",
  tab:     SpaceDashboardTab.RETIREMENT,
  enabled: true,
  order:   1,
};

const EMERGENCY_FUND_PROGRESS: SectionPreset = {
  key:     "emergency_fund_progress",
  label:   "Emergency Fund",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const PROPERTY_VALUE: SectionPreset = {
  key:     "property_value",
  label:   "Property Value",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const MORTGAGE_TRACKER: SectionPreset = {
  key:     "mortgage_tracker",
  label:   "Mortgage",
  tab:     SpaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

const VEHICLE_VALUE: SectionPreset = {
  key:     "vehicle_value",
  label:   "Vehicle Value",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const AUTO_LOAN_TRACKER: SectionPreset = {
  key:     "auto_loan_tracker",
  label:   "Auto Loan",
  tab:     SpaceDashboardTab.DEBT,
  enabled: true,
  order:   0,
};

const TRIP_BUDGET: SectionPreset = {
  key:     "trip_budget",
  label:   "Trip Budget",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

const TRIP_SAVINGS: SectionPreset = {
  key:     "trip_savings",
  label:   "Trip Savings",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   1,
};

const BUSINESS_ACCOUNTS: SectionPreset = {
  key:     "business_accounts",
  label:   "Business Accounts",
  tab:     SpaceDashboardTab.ACCOUNTS,
  enabled: true,
  order:   0,
};

const EQUIPMENT_VALUE: SectionPreset = {
  key:     "equipment_value",
  label:   "Equipment Value",
  tab:     SpaceDashboardTab.OVERVIEW,
  enabled: true,
  order:   0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Preset map
// Every space always gets GOALS_SECTION, ACCOUNTS_SECTION, ACTIVITY_SECTION
// on top of the category-specific sections below.
// ─────────────────────────────────────────────────────────────────────────────

const UNIVERSAL_SECTIONS: SectionPreset[] = [
  GOALS_SECTION,
  ACCOUNTS_SECTION,
  ACTIVITY_SECTION,
];

// ── Space Template Redesign (approved) ────────────────────────────────────────
// Each preset below is an EDITED template, not a category's column-inches:
// one lede per Space type (the hero, rendered by SpaceDashboard from
// SpaceSnapshot — not a section), at most three signature modules, and no
// section whose key lacks a SectionRegistry renderer. Universal sections
// (Goals / Accounts / Activity) still append via getPresetsForCategory.
const PRESET_MAP: Record<SpaceCategory, SectionPreset[]> = {
  // Personal renders via DashboardClient, not sections — preset kept
  // minimal + real for the SpaceDashboard fallback path.
  [SpaceCategory.PERSONAL]: [
    NET_WORTH_SECTION,
    DEBT_SUMMARY_SECTION,
    INVESTMENT_SUMMARY,
  ],

  // Household story: "are WE on track" — hero is shared net worth;
  // signature = shared goals (universal) + obligations. Allocation is
  // deliberately NOT signature here (partial-scope allocation misleads);
  // it stays reachable via Perspectives.
  [SpaceCategory.HOUSEHOLD]: [
    DEBT_SUMMARY_SECTION,
  ],

  [SpaceCategory.FAMILY]: [
    DEBT_SUMMARY_SECTION,
  ],

  // Business story: "do we have cash" — hero is cash position; signature =
  // business accounts + obligations. investment_summary removed (edge case,
  // not signature). business_cash_flow removed until a real widget exists.
  [SpaceCategory.BUSINESS]: [
    BUSINESS_ACCOUNTS,
    DEBT_SUMMARY_SECTION,
  ],

  // Property story: "what is it worth minus what we owe" — hero is equity;
  // signature = the two components, BOTH on the Overview under the hero
  // (template polish D4: the mortgage is half of the equity story — it
  // can't live behind the Debt perspective modal).
  [SpaceCategory.PROPERTY]: [
    PROPERTY_VALUE,
    { ...MORTGAGE_TRACKER, tab: SpaceDashboardTab.OVERVIEW, order: 1 },
  ],

  [SpaceCategory.VEHICLE]: [
    VEHICLE_VALUE,
    AUTO_LOAN_TRACKER,
  ],

  [SpaceCategory.TRIP]: [
    TRIP_BUDGET,
    TRIP_SAVINGS,
  ],

  // Investment story: "what is the portfolio worth, what's it made of" —
  // hero is portfolio value; net_worth removed (duplicates the hero with a
  // broader, confusable scope).
  [SpaceCategory.INVESTMENT]: [
    INVESTMENT_SUMMARY,
    INVESTMENT_ALLOCATION,
  ],

  [SpaceCategory.EQUIPMENT]: [
    EQUIPMENT_VALUE,
    DEBT_SUMMARY_SECTION,
  ],

  [SpaceCategory.RETIREMENT]: [
    RETIREMENT_PROGRESS,
    RETIREMENT_ACCOUNTS,
    INVESTMENT_ALLOCATION,
  ],

  // Debt story: "how far have I come, when am I free" — hero is the payoff
  // arc (down-is-good); signature = composition ("what am I fighting") +
  // planner. debt_payoff_tracker removed: it rendered a debt-summary alias
  // under a misleading label.
  [SpaceCategory.DEBT_PAYOFF]: [
    DEBT_BREAKDOWN_SECTION,
    DEBT_PAYOFF_CALC_SECTION,
    DEBT_SUMMARY_SECTION,
  ],

  // Emergency-fund story: "how long could I last" — hero is the savings
  // trend; signature = months-covered progress. monthly_expenses removed
  // (config input masquerading as a module — it's collected in the
  // progress widget's settings).
  [SpaceCategory.EMERGENCY_FUND]: [
    EMERGENCY_FUND_PROGRESS,
  ],

  // Goal story: "how close am I" — the Goals section (ProgressWidget
  // family) IS the lede, so it lives on the Overview page itself (template
  // polish D3: preset-wins dedupe in getPresetsForCategory overrides the
  // universal GOALS-tab placement). Intentionally no chart until goal
  // history exists. Legacy category; goal-shaped types (TRIP/VEHICLE/
  // EQUIPMENT) are variants of the same template.
  [SpaceCategory.GOAL]: [
    { ...GOALS_SECTION, tab: SpaceDashboardTab.OVERVIEW },
  ],

  // Blank slate — user builds their own
  [SpaceCategory.CUSTOM]: [],

  [SpaceCategory.OTHER]: [
    NET_WORTH_SECTION,
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full ordered list of sections for a space of the given
 * category, including the universal sections (Goals, Accounts, Activity) that
 * every space receives.
 *
 * Deduplication: if a category preset includes a key that also appears in
 * UNIVERSAL_SECTIONS, the preset version wins (overrides label/tab/order).
 */
export function getPresetsForCategory(
  // Accept both the local type and plain string (for seed / API routes pre-generate)
  category: SpaceCategory | string
): SectionPreset[] {
  const categoryPresets = PRESET_MAP[category as SpaceCategory] ?? [];

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
 * Human-readable label for a SpaceCategory value.
 */
export const CATEGORY_LABELS: Record<SpaceCategory, string> = {
  [SpaceCategory.PERSONAL]:       "Personal",
  [SpaceCategory.HOUSEHOLD]:      "Household",
  [SpaceCategory.FAMILY]:         "Family",
  [SpaceCategory.BUSINESS]:       "Business",
  [SpaceCategory.PROPERTY]:       "Property",
  [SpaceCategory.VEHICLE]:        "Vehicle",
  [SpaceCategory.TRIP]:           "Trip / Vacation",
  [SpaceCategory.INVESTMENT]:     "Investment Portfolio",
  [SpaceCategory.EQUIPMENT]:      "Equipment",
  [SpaceCategory.RETIREMENT]:     "Retirement",
  [SpaceCategory.DEBT_PAYOFF]:    "Debt Payoff",
  [SpaceCategory.EMERGENCY_FUND]: "Emergency Fund",
  [SpaceCategory.GOAL]:           "Goal",
  [SpaceCategory.CUSTOM]:         "Custom",
  [SpaceCategory.OTHER]:          "Other",
};

/**
 * Short description shown in the template picker.
 */
export const CATEGORY_DESCRIPTIONS: Record<SpaceCategory, string> = {
  [SpaceCategory.PERSONAL]:       "Track your personal finances, net worth, and spending.",
  [SpaceCategory.HOUSEHOLD]:      "Manage shared finances with a partner or housemates.",
  [SpaceCategory.FAMILY]:         "Coordinate budgets and savings across your family.",
  [SpaceCategory.BUSINESS]:       "Oversee cash flow and accounts for a business or LLC.",
  [SpaceCategory.PROPERTY]:       "Track property value, mortgage, and rental income.",
  [SpaceCategory.VEHICLE]:        "Monitor vehicle value and auto loan progress.",
  [SpaceCategory.TRIP]:           "Budget and save for a specific trip or vacation.",
  [SpaceCategory.INVESTMENT]:     "Focus on portfolio performance and asset allocation.",
  [SpaceCategory.EQUIPMENT]:      "Track equipment value, loans, and maintenance costs.",
  [SpaceCategory.RETIREMENT]:     "Monitor retirement accounts and progress toward FIRE.",
  [SpaceCategory.DEBT_PAYOFF]:    "Strategize and track debt elimination across accounts.",
  [SpaceCategory.EMERGENCY_FUND]: "Build and protect your emergency savings buffer.",
  [SpaceCategory.GOAL]:           "Track progress toward a specific financial goal.",
  [SpaceCategory.CUSTOM]:         "Start from a blank slate and add sections yourself.",
  [SpaceCategory.OTHER]:          "General-purpose financial space.",
};

/**
 * Icon name (Lucide) for each category — used in the template picker grid.
 */
export const CATEGORY_ICONS: Record<SpaceCategory, string> = {
  [SpaceCategory.PERSONAL]:       "User",
  [SpaceCategory.HOUSEHOLD]:      "Home",
  [SpaceCategory.FAMILY]:         "Users",
  [SpaceCategory.BUSINESS]:       "Briefcase",
  [SpaceCategory.PROPERTY]:       "Building2",
  [SpaceCategory.VEHICLE]:        "Car",
  [SpaceCategory.TRIP]:           "Plane",
  [SpaceCategory.INVESTMENT]:     "TrendingUp",
  [SpaceCategory.EQUIPMENT]:      "Wrench",
  [SpaceCategory.RETIREMENT]:     "Sunset",
  [SpaceCategory.DEBT_PAYOFF]:    "CreditCard",
  [SpaceCategory.EMERGENCY_FUND]: "Shield",
  [SpaceCategory.GOAL]:           "Target",
  [SpaceCategory.CUSTOM]:         "LayoutDashboard",
  [SpaceCategory.OTHER]:          "MoreHorizontal",
};

/** Categories shown as primary options in the template picker (first row). */
export const PRIMARY_CATEGORIES: SpaceCategory[] = [
  SpaceCategory.HOUSEHOLD,
  SpaceCategory.FAMILY,
  SpaceCategory.DEBT_PAYOFF,
  SpaceCategory.EMERGENCY_FUND,
  SpaceCategory.RETIREMENT,
  SpaceCategory.INVESTMENT,
];

/** Categories shown as secondary options (second row / "more" section). */
export const SECONDARY_CATEGORIES: SpaceCategory[] = [
  SpaceCategory.BUSINESS,
  SpaceCategory.PROPERTY,
  SpaceCategory.VEHICLE,
  SpaceCategory.TRIP,
  SpaceCategory.EQUIPMENT,
  SpaceCategory.CUSTOM,
  SpaceCategory.OTHER,
];

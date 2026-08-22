/**
 * Space preset definitions.
 *
 * Each space category maps to a list of default SpaceDashboardSection
 * records that are created automatically when a space is created.
 *
 * Rules:
 *  - Section keys are stable machine-readable identifiers — do not rename them
 *    once they exist in the database; update the label instead.
 *  - order is relative within the preset; 0 = first.
 *  - W2: every preset is EMPTY today (see the note above GOALS retirement
 *    below) — an empty section plan is legal end-to-end (creation, planner,
 *    dashboard).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Local enum mirrors
// These match the Prisma schema values exactly. We define them locally so this
// file compiles before `prisma generate` has been re-run with the new schema.
// After `prisma generate`, you can optionally import from @prisma/client instead.
// ─────────────────────────────────────────────────────────────────────────────

export const SpaceCategory = {
  PERSONAL:       "PERSONAL",
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
// Shared sections
// ─────────────────────────────────────────────────────────────────────────────
//
// REVIEW-3 (slice F) cut the preset system to what the product renders from
// SpaceDashboardSection rows; W2 finishes the cut: the GOALS surface — the
// LAST seeded section (the universal goals_progress) — is RETIRED (product
// decision, final), together with the whole section RENDER stack. So:
//
//  - Every preset (universal + per-category) is now EMPTY. An empty section
//    plan is legal end-to-end: the planner plans nothing, POST /api/spaces
//    creates no rows, and the dashboard renders every rail tab regardless of
//    section rows. Do NOT invent replacement sections to fill the plan.
//  - Existing Spaces keep their rows untouched: nothing renders them, but
//    they remain visible/toggleable CONFIG in Manage → Overview.
//
// Re-adding a section to a template is a one-line PRESET_MAP entry — but the
// key must have a renderer AND a surface that renders it ("the template earns
// its modules"), and neither GOALS nor RETIREMENT may return.

// ─────────────────────────────────────────────────────────────────────────────
// Preset map
// ─────────────────────────────────────────────────────────────────────────────

const UNIVERSAL_SECTIONS: SectionPreset[] = [];

/** Per-category preset OVERRIDES on top of the universal set. Empty today —
 *  see the REVIEW-3 note above. Partial by design: a missing category gets
 *  the universal sections only. */
const PRESET_MAP: Partial<Record<SpaceCategory, SectionPreset[]>> = {};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full ordered list of sections for a space of the given
 * category, including the universal sections every space receives.
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
  [SpaceCategory.FAMILY]:         "Shared finances for your family or household — one net worth across everyone's accounts.",
  [SpaceCategory.BUSINESS]:       "Oversee cash flow and accounts for a business or LLC.",
  [SpaceCategory.PROPERTY]:       "See your equity — property value minus what you owe — over time.",
  [SpaceCategory.VEHICLE]:        "Group a vehicle's accounts and track its net worth over time.",
  [SpaceCategory.TRIP]:           "Budget and save for a specific trip or vacation.",
  [SpaceCategory.INVESTMENT]:     "Focus on portfolio performance and asset allocation.",
  [SpaceCategory.EQUIPMENT]:      "Group equipment accounts and track their net worth over time.",
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

/**
 * REVIEW-3 (slice F) — the CURRENTLY-SUPPORTED category set: the categories a
 * Space can be born with today (FAMILY/CUSTOM via live templates, PERSONAL at
 * registration, OTHER via the legacy create fallback) plus the set present in
 * production (OTHER, PERSONAL — nothing else, measured 2026-08-17).
 *
 * This is the ONE allowlist every category WRITE validates against:
 *   - PATCH /api/spaces/[id] (Manage → General) — previously wrote
 *     `category as never` with NO validation, accepting all 15 enum members
 *     (the only route by which a retired category could re-enter production);
 *   - POST /api/spaces' legacy `category` body field — previously resolved
 *     any category's hidden template, bypassing the live-template gate;
 *   - GeneralSettingsPanel's picker — previously offered all 13
 *     primary+secondary categories.
 *
 * HOUSEHOLD is RETIRED (W1, final product decision): FAMILY is the one
 * canonical shared-family-space concept (its description already reads
 * "for your family or household"). All HOUSEHOLD product code — template,
 * labels, lens lists, manifests, tints — was deleted in W1; production holds
 * zero HOUSEHOLD Spaces. Do NOT re-admit it, as a category or as an alias.
 * The ONLY residue is the SpaceCategory.HOUSEHOLD member of the Prisma enum,
 * which stays until the enum-retirement migration program (Postgres cannot
 * DROP an enum VALUE in place) — retired members are unwritable, not removed.
 */
export const SUPPORTED_SPACE_CATEGORIES: SpaceCategory[] = [
  SpaceCategory.PERSONAL,
  SpaceCategory.FAMILY,
  SpaceCategory.CUSTOM,
  SpaceCategory.OTHER,
];

/** Categories offered by the Manage → General category picker: the supported
 *  set minus PERSONAL (the Personal Space's category is fixed at birth; the
 *  picker only renders for re-categorizable Spaces). Replaces the former
 *  PRIMARY_CATEGORIES / SECONDARY_CATEGORIES two-row picker over all 13. */
export const RECATEGORIZE_CATEGORIES: SpaceCategory[] = [
  SpaceCategory.FAMILY,
  SpaceCategory.CUSTOM,
  SpaceCategory.OTHER,
];

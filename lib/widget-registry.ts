/**
 * Widget Registry
 *
 * Metadata for the section keys the dashboard runtime still consumes.
 *
 * REVIEW-3 (slice F) cut this file from ~1,100 lines to what is actually
 * read. The registry used to catalogue every section key ever conceived —
 * config schemas, tab/icon assignments, collapse/fullscreen flags,
 * deprecation aliases, and an `implemented` flag whose documented fallback
 * behavior ("implemented:false falls back to ContextualCard") was FALSE:
 * SectionCard never consulted it. Production reads exactly two things:
 *
 *   - `label`               (lib/perspectives/virtual-sections.ts — virtual
 *                            section titles for the Goals workspace; the
 *                            ContextualCard fallback's headline)
 *   - `requires[0].reason`  (ContextualCard's hint line)
 *
 * so WidgetMeta is now { key, label, description, requires } and the entry
 * list is the surviving consumers' key set: the Goals virtual-section widgets
 * and the goals_progress section that presets still seed. The renderer
 * dispatch authority is components/space/sections/SectionRegistry.tsx — NOT
 * this file. The platform ops dashboard uses its own, separate
 * PLATFORM_WIDGET_REGISTRY (components/platform/PlatformSpaceDashboard.tsx)
 * and reads nothing from here.
 */

// ─── Data requirement ─────────────────────────────────────────────────────────

export type AccountVisibility = "FULL" | "BALANCE_ONLY" | "any";

export interface DataRequirement {
  /** account.type values that must be present in the space */
  accountTypes: string[];
  /** Minimum visibility level for those accounts */
  visibility: AccountVisibility;
  /** How many qualifying accounts must exist (default 1) */
  minCount?: number;
  /** Human-readable explanation shown when the requirement is not met */
  reason: string;
}

// ─── Widget meta ──────────────────────────────────────────────────────────────

export interface WidgetMeta {
  /** Stable machine-readable key — matches SpaceDashboardSection.key */
  key:         string;
  /** Display name (virtual-section titles, ContextualCard headline) */
  label:       string;
  /** One-line description (documentation; not currently rendered) */
  description: string;
  /** Required data conditions — empty array = always renderable */
  requires:    DataRequirement[];
}

export interface WidgetRegistryEntry {
  meta: WidgetMeta;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry: WidgetRegistryEntry[] = [

  // ── Goals ───────────────────────────────────────────────────────────────────

  {
    meta: {
      key:         "goals_progress",
      label:       "Goals",
      description: "Active, completed, and archived goals for this space.",
      requires:    [],
    },
  },

  // ── Goals Perspective (UX-PER-3) — trajectory vs target. ────────────────────
  // Rendered as VIRTUAL sections in the Goals workspace (deep-link only —
  // kept per REVIEW-3's conservative rule: goals is live-but-orphaned, not
  // provably retired).
  {
    meta: {
      key:         "goal_progress",
      label:       "Goal Progress",
      description: "Each financial goal's progress toward its target.",
      requires:    [],
    },
  },
  {
    meta: {
      key:         "goal_on_track",
      label:       "On Track",
      description: "How many goals are on track by their deadline, and how many are overdue.",
      requires:    [],
    },
  },
  {
    meta: {
      key:         "goal_required_pace",
      label:       "Required Pace",
      description: "The monthly contribution needed to hit each dated goal on time.",
      requires:    [],
    },
  },
  {
    meta: {
      key:         "goal_funding_gap",
      label:       "Funding Gap",
      description: "Goals ranked by how much is still needed to reach target.",
      requires:    [],
    },
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** Map of key → entry for O(1) lookup */
export const WIDGET_REGISTRY = new Map<string, WidgetRegistryEntry>(
  registry.map((e) => [e.meta.key, e]),
);

/**
 * Returns the WidgetMeta for a key, or undefined if not registered.
 *
 * The ONE live consumer surface: SectionRegistry's ContextualCard fallback +
 * perspectives/virtual-sections read `.label` and `.requires[0].reason`.
 */
export function getWidgetMeta(key: string): WidgetMeta | undefined {
  return WIDGET_REGISTRY.get(key)?.meta;
}

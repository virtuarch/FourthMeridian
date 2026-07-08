/**
 * lib/space-templates/types.ts
 *
 * SP-1 — Space Template Foundation (see
 * docs/initiatives/d9/SP-1_SPACE_TEMPLATE_FOUNDATION_INVESTIGATION_2026-07-08.md).
 *
 * A Space Template is a named, versioned, declarative blueprint consumed
 * exactly once — at Space creation — that determines the Space's category,
 * display metadata, and initial dashboard sections.
 *
 * Invariants (enforced by lib/space-templates/*.test.ts):
 *  - Templates are pure data: this directory imports nothing beyond
 *    lib/space-presets (no DB, no Prisma runtime, no React, no TI, no AI).
 *  - A template implies a category; a category does NOT equal a template
 *    (today's 1:1 mapping is a coincidence of the initial set).
 *  - Materialization is a snapshot: a template feeds Space birth and never
 *    owns a Space afterward. Editing a template never changes existing Spaces.
 */

import type { SectionPreset, SpaceCategory } from "../space-presets";

/**
 * Exposure state of a template.
 *  - "live"   — offered wherever templates are listed (e.g. the future
 *               SP-2 creation selector via getLiveTemplates()).
 *  - "hidden" — resolvable by id/category (fallback paths) but never listed.
 *               Covers non-picker categories today (PERSONAL, legacy GOAL)
 *               and future deferred/internal templates.
 */
export type TemplateStatus = "live" | "hidden";

export interface SpaceTemplate {
  /** Stable slug identity (e.g. "debt-payoff"). Never rename once shipped. */
  id: string;
  /** Display name (built-ins: the category label). */
  name: string;
  /** One-line description shown in pickers. */
  description: string;
  /** Lucide icon name — same string convention as lib/widget-registry.ts. */
  icon: string;
  /** Semantic classification the template implies. Reuses SpaceCategory. */
  category: SpaceCategory;
  /**
   * The full, ordered section list a Space born from this template receives —
   * category signature sections merged with the universal sections, exactly
   * the shape POST /api/spaces materializes into SpaceDashboardSection rows.
   * Section keys reference lib/widget-registry.ts entries (validated in tests).
   */
  sections: readonly SectionPreset[];
  /** Template content version. Bump when `sections` meaningfully change. */
  version: number;
  status: TemplateStatus;
}

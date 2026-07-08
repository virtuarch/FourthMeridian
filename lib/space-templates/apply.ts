/**
 * lib/space-templates/apply.ts
 *
 * SP-1 — the pure template application planner.
 *
 * Computes which SpaceDashboardSection rows a template application should
 * create. Pure and synchronous: no DB access — the caller materializes the
 * plan (at Space creation, inside the existing db.$transaction).
 *
 * Rules (enforced by apply.test.ts):
 *  - Additive only: never updates, disables, reorders, or deletes existing
 *    sections. User customizations are untouchable.
 *  - Idempotent: sections whose key already exists on the Space are skipped
 *    (protects the SpaceDashboardSection @@unique([spaceId, key]) constraint;
 *    planning against an already-templated Space yields an empty plan).
 *  - Inputs are never mutated; returned sections are fresh copies.
 *  - Order, config, enabled, tab, and label pass through unchanged — at
 *    creation (empty key set) the plan is exactly template.sections, which is
 *    exactly getPresetsForCategory(category) (parity test).
 */

import type { SectionPreset } from "../space-presets";
import type { SpaceTemplate } from "./types";

export interface TemplateApplicationPlan {
  /** Sections to create, in template order. Empty = nothing to do. */
  sectionsToCreate: SectionPreset[];
}

export function planTemplateApplication(
  template: SpaceTemplate,
  existingSectionKeys: ReadonlySet<string>
): TemplateApplicationPlan {
  const sectionsToCreate = template.sections
    .filter((s) => !existingSectionKeys.has(s.key))
    .map((s) => ({
      ...s,
      // Copy config so callers can never mutate registry data through a plan.
      config: s.config === undefined ? undefined : { ...s.config },
    }));

  return { sectionsToCreate };
}

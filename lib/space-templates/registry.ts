/**
 * lib/space-templates/registry.ts
 *
 * SP-1 — the built-in Space Template registry.
 *
 * Formalizes the existing category presets (lib/space-presets.ts) into named
 * template objects. This file INVENTS NOTHING: every template's metadata comes
 * from CATEGORY_LABELS/_DESCRIPTIONS/_ICONS and every section list is the
 * getPresetsForCategory() output for its category — so registry content is
 * byte-identical to what POST /api/spaces already materializes today
 * (proven by the parity test in registry.test.ts).
 *
 * Runtime note (SP-1): nothing in the app reads this registry yet.
 * getPresetsForCategory() remains the runtime source for the create route;
 * rewiring the route through getTemplateForCategory() is SP-2.
 */

import {
  SpaceCategory,
  getPresetsForCategory,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_ICONS,
} from "../space-presets";
import type { SpaceTemplate, TemplateStatus } from "./types";

function makeTemplate(
  id: string,
  category: SpaceCategory,
  status: TemplateStatus = "live",
  featured = false
): SpaceTemplate {
  return {
    id,
    name:        CATEGORY_LABELS[category],
    description: CATEGORY_DESCRIPTIONS[category],
    icon:        CATEGORY_ICONS[category],
    category,
    sections:    getPresetsForCategory(category),
    version:     1,
    status,
    featured,
  };
}

/**
 * The built-in template set.
 *
 * live   — exactly the categories exposed in the create picker today
 *          (PRIMARY_CATEGORIES + SECONDARY_CATEGORIES order).
 * hidden — categories that have presets but are not user-selectable:
 *          PERSONAL (created at registration, renders through the shared
 *          SpaceDashboard shell) and GOAL (legacy — kept for the
 *          SpaceDashboard fallback path).
 */
export const SPACE_TEMPLATES: readonly SpaceTemplate[] = [
  // Primary picker row (featured — SP-2.2: mirrors the former PRIMARY_CATEGORIES)
  makeTemplate("household",      SpaceCategory.HOUSEHOLD,      "live", true),
  makeTemplate("family",         SpaceCategory.FAMILY,         "live", true),
  makeTemplate("debt-payoff",    SpaceCategory.DEBT_PAYOFF,    "live", true),
  makeTemplate("emergency-fund", SpaceCategory.EMERGENCY_FUND, "live", true),
  makeTemplate("retirement",     SpaceCategory.RETIREMENT,     "live", true),
  makeTemplate("investment",     SpaceCategory.INVESTMENT,     "live", true),
  // Secondary picker row
  makeTemplate("business",       SpaceCategory.BUSINESS),
  makeTemplate("property",       SpaceCategory.PROPERTY),
  makeTemplate("vehicle",        SpaceCategory.VEHICLE),
  makeTemplate("trip",           SpaceCategory.TRIP),
  makeTemplate("equipment",      SpaceCategory.EQUIPMENT),
  makeTemplate("custom",         SpaceCategory.CUSTOM),
  makeTemplate("other",          SpaceCategory.OTHER),
  // Not exposed in the picker
  makeTemplate("personal",       SpaceCategory.PERSONAL, "hidden"),
  makeTemplate("goal",           SpaceCategory.GOAL,     "hidden"),
];

/** Look up a template by its stable id. Resolves hidden templates too. */
export function getTemplate(id: string): SpaceTemplate | undefined {
  return SPACE_TEMPLATES.find((t) => t.id === id);
}

/** Templates offered for selection — excludes status "hidden". */
export function getLiveTemplates(): SpaceTemplate[] {
  return SPACE_TEMPLATES.filter((t) => t.status === "live");
}

/**
 * Back-compat bridge: the template a Space of the given category is born
 * from today. Accepts plain strings for the same pre-`prisma generate`
 * reason getPresetsForCategory does. With the current 1:1 built-in set this
 * is unique; if a category ever gains multiple templates, callers must
 * select by id instead and this returns the category's default.
 */
export function getTemplateForCategory(
  category: SpaceCategory | string
): SpaceTemplate | undefined {
  return SPACE_TEMPLATES.find((t) => t.category === category);
}

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
 * Runtime note: this registry IS now the runtime source. The create picker
 * lists templates via getLiveTemplates() / getComingSoonTemplates(), and POST
 * /api/spaces resolves the template via getTemplate()/getTemplateForCategory()
 * (SP-2). Exposure (live / comingSoon / hidden) is the picker's product truth.
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
  status: TemplateStatus = "live"
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
  };
}

/**
 * The built-in template set (V25-CLOSE-4B — picker product truth).
 *
 * The picker now reflects only concepts that are real today, while keeping
 * planned concepts visible-but-disabled:
 *
 *   live       — SELECTABLE. Only the two concepts that fully work today:
 *                Family (Household merged in — identical composition) and Custom.
 *   comingSoon — SHOWN DISABLED so the roadmap is visible: Retirement, Business,
 *                Property, Vehicle, Trip. Not creatable (the create route rejects
 *                any non-"live" id).
 *   hidden     — not in the picker, still resolvable for existing Spaces:
 *                Household (merged into Family), the retired Debt Payoff /
 *                Emergency Fund / Investment / Equipment / Other, plus the
 *                never-picker PERSONAL and legacy GOAL.
 *
 * Array order is the picker's display order within each status group.
 */
export const SPACE_TEMPLATES: readonly SpaceTemplate[] = [
  // Selectable today
  makeTemplate("family",         SpaceCategory.FAMILY,         "live"),
  makeTemplate("custom",         SpaceCategory.CUSTOM,         "live"),
  // Visible in the picker, disabled — planned concepts
  makeTemplate("retirement",     SpaceCategory.RETIREMENT,     "comingSoon"),
  makeTemplate("business",       SpaceCategory.BUSINESS,       "comingSoon"),
  makeTemplate("property",       SpaceCategory.PROPERTY,       "comingSoon"),
  makeTemplate("vehicle",        SpaceCategory.VEHICLE,        "comingSoon"),
  makeTemplate("trip",           SpaceCategory.TRIP,           "comingSoon"),
  // Retired from the picker — still resolvable so existing Spaces materialize
  makeTemplate("household",      SpaceCategory.HOUSEHOLD,      "hidden"),
  makeTemplate("debt-payoff",    SpaceCategory.DEBT_PAYOFF,    "hidden"),
  makeTemplate("emergency-fund", SpaceCategory.EMERGENCY_FUND, "hidden"),
  makeTemplate("investment",     SpaceCategory.INVESTMENT,     "hidden"),
  makeTemplate("equipment",      SpaceCategory.EQUIPMENT,      "hidden"),
  makeTemplate("other",          SpaceCategory.OTHER,          "hidden"),
  // Never exposed in the picker
  makeTemplate("personal",       SpaceCategory.PERSONAL,       "hidden"),
  makeTemplate("goal",           SpaceCategory.GOAL,           "hidden"),
];

/** Look up a template by its stable id. Resolves hidden templates too. */
export function getTemplate(id: string): SpaceTemplate | undefined {
  return SPACE_TEMPLATES.find((t) => t.id === id);
}

/** Selectable templates — status "live". These are creatable. */
export function getLiveTemplates(): SpaceTemplate[] {
  return SPACE_TEMPLATES.filter((t) => t.status === "live");
}

/** Planned templates shown DISABLED in the picker — status "comingSoon".
 *  Visible so the roadmap is legible; never creatable. */
export function getComingSoonTemplates(): SpaceTemplate[] {
  return SPACE_TEMPLATES.filter((t) => t.status === "comingSoon");
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

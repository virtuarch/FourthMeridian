/**
 * lib/ai/domain-manifest.ts
 *
 * Domain manifest for the AI Context Builder (D4).
 *
 * The manifest maps each SpaceCategory to the ordered list of ContextDomain
 * keys the builder should attempt to assemble for a Space in that category.
 * This is the primary declaration of "what domains belong to this Space type."
 *
 * AiAgent.agentScope (if set) is an optional restriction layer that narrows
 * the manifest — the builder assembles the intersection of the manifest and
 * agentScope. It is NOT a replacement for the manifest.
 *
 * D9 hook:
 *   getDomainManifest() accepts an optional `templateId` parameter. Until D9
 *   (SpaceTemplate) lands, this parameter is accepted but ignored. After D9,
 *   a SpaceTemplate row may override the category-level manifest.
 *
 * Adding a new Space category / template:
 *   1. Add a constant array below (e.g. TRAVEL_CORE).
 *   2. Add the category key to DOMAIN_MANIFEST_BY_CATEGORY.
 *   3. Register assemblers for any new domain strings in the appropriate
 *      lib/ai/assemblers/ file.
 *   No changes to types.ts or context-builder.ts are required.
 */

import { FinanceDomains, type ContextDomain } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Finance domain groups
// ---------------------------------------------------------------------------

/**
 * Core finance domains present in every finance-category Space.
 * Ordered so the most important data is assembled first.
 *
 * SNAPSHOT_HISTORY is included here (not just in FINANCE_WITH_HOLDINGS) so
 * that Personal, Business, Family, Debt-focused, and Goal-focused Spaces
 * can all answer 90-day net-worth and trend questions. It is pre-aggregated
 * data (SpaceSnapshot rows) — cheap to assemble, high advisory value.
 */
// REVIEW-3 C-10 — MEMBERS / PROVIDERS removed from every manifest: no
// assembler has ever been registered for either domain, so every context build
// recorded them as permanent skipped-domain noise ('no_assembler') and every
// manifest claimed data it could not assemble. Re-add them here WHEN their
// assemblers land (assembler-registry registration is the gate that matters).
// W2 — GOALS removed from every manifest list below (Goals retired; the
// domain, its assembler, and its payload types no longer exist).
const FINANCE_CORE: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
];

/**
 * Finance core + investment holdings.
 * Used for INVESTMENT and RETIREMENT categories.
 * SNAPSHOT_HISTORY is inherited from FINANCE_CORE via spread.
 */
const FINANCE_WITH_HOLDINGS: ContextDomain[] = [
  ...FINANCE_CORE,
  FinanceDomains.HOLDINGS_SUMMARY,
];

/**
 * ⚠️ FINANCE_WITH_MEMBERS / FINANCE_DEBT_FOCUSED / FINANCE_GOAL_FOCUSED DELETED
 * (V26-REASONING Slice 0).
 *
 * All three were byte-identical to FINANCE_CORE. The last one carried an
 * explicit argument for staying named — "their domain set is its own
 * declaration; aliasing it to FINANCE_CORE would silently couple those
 * categories to future core edits" — and that argument is why the duplication
 * survived W2. It is the wrong way round: three lists that no reader can tell
 * apart do not record an independent decision, they record a divergence that
 * does not exist, and the coupling they were meant to prevent is invisible
 * either way. When a category's domain set genuinely differs, it gets its own
 * list again at that moment, with the difference visible in the diff.
 *
 * (FAMILY's list was never about members in any case: REVIEW-3 C-10 removed
 * MEMBERS from every manifest because no assembler was ever registered for it.)
 */

// ---------------------------------------------------------------------------
// Manifest map
// ---------------------------------------------------------------------------

/**
 * Maps SpaceCategory string values to ordered domain lists.
 *
 * Keys match the SpaceCategory enum values in schema.prisma exactly.
 * Non-finance categories (TRIP, VEHICLE, EQUIPMENT, PROPERTY) are
 * placeholder entries — they will be expanded when Travel / Property /
 * Vehicle templates land. For now they fall back to FINANCE_CORE to
 * avoid empty manifests.
 *
 * CUSTOM and OTHER fall back to FINANCE_CORE until a template-driven
 * override is applied (post-D9).
 */
const DOMAIN_MANIFEST_BY_CATEGORY: Record<string, ContextDomain[]> = {
  // Finance categories
  PERSONAL:        FINANCE_CORE,
  FAMILY:          FINANCE_CORE,
  BUSINESS:        FINANCE_CORE,
  INVESTMENT:      FINANCE_WITH_HOLDINGS,
  RETIREMENT:      FINANCE_WITH_HOLDINGS,
  DEBT_PAYOFF:     FINANCE_CORE,
  EMERGENCY_FUND:  FINANCE_CORE,
  GOAL:            FINANCE_CORE,

  // Non-finance categories — placeholder domain lists.
  // These will be replaced when their templates land (D9 or later).
  PROPERTY:  FINANCE_CORE,
  VEHICLE:   FINANCE_CORE,
  TRIP:      FINANCE_CORE,
  EQUIPMENT: FINANCE_CORE,

  // Catch-all
  CUSTOM: FINANCE_CORE,
  OTHER:  FINANCE_CORE,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the ordered list of ContextDomain keys for a Space in the given
 * SpaceCategory.
 *
 * @param category  - SpaceCategory string (e.g. "PERSONAL", "INVESTMENT").
 * @param templateId - Reserved for D9 (SpaceTemplate). Accepted but ignored
 *                    until D9 lands. When D9 is implemented, a non-null
 *                    templateId will look up SpaceTemplate.contextDomains
 *                    and use those instead of the category default.
 *
 * Falls back to FINANCE_CORE if the category is unrecognized, so new
 * categories added to the schema do not break context assembly before their
 * manifest entry is written.
 */
export function getDomainManifest(
  category:   string,
  templateId?: string | null, // eslint-disable-line @typescript-eslint/no-unused-vars
): ContextDomain[] {
  // templateId is intentionally ignored until D9 lands.
  return DOMAIN_MANIFEST_BY_CATEGORY[category] ?? FINANCE_CORE;
}

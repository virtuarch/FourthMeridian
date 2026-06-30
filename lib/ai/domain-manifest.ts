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
 */
const FINANCE_CORE: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.GOALS,
  FinanceDomains.MEMBERS,
  FinanceDomains.PROVIDERS,
];

/**
 * Finance core + investment holdings.
 * Used for INVESTMENT and RETIREMENT categories.
 */
const FINANCE_WITH_HOLDINGS: ContextDomain[] = [
  ...FINANCE_CORE,
  FinanceDomains.HOLDINGS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
];

/**
 * Finance core + member management emphasis.
 * Used for HOUSEHOLD and FAMILY categories where member roles matter.
 */
const FINANCE_WITH_MEMBERS: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.MEMBERS,
  FinanceDomains.GOALS,
  FinanceDomains.PROVIDERS,
];

/**
 * Focused debt payoff domain list.
 * Accounts and transactions are the primary signals; holdings not relevant.
 */
const FINANCE_DEBT_FOCUSED: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.GOALS,
  FinanceDomains.PROVIDERS,
];

/**
 * Emergency fund / goal-focused domain list.
 */
const FINANCE_GOAL_FOCUSED: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.GOALS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.PROVIDERS,
];

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
  HOUSEHOLD:       FINANCE_WITH_MEMBERS,
  FAMILY:          FINANCE_WITH_MEMBERS,
  BUSINESS:        FINANCE_CORE,
  INVESTMENT:      FINANCE_WITH_HOLDINGS,
  RETIREMENT:      FINANCE_WITH_HOLDINGS,
  DEBT_PAYOFF:     FINANCE_DEBT_FOCUSED,
  EMERGENCY_FUND:  FINANCE_GOAL_FOCUSED,
  GOAL:            FINANCE_GOAL_FOCUSED,

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

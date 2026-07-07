/**
 * lib/transactions/merchant-resolver.ts
 *
 * Merchant Intelligence — M2 category-resolution engine (MI1).
 *
 * A single, PURE, deterministic write-time resolver. It computes WHO a
 * transaction's merchant is (normalized identity + injected alias/merchant
 * lookup) and WHAT category it should carry, and — critically — WHY (the
 * CategorySource provenance). It performs NO I/O: it never touches the database,
 * never mutates anything, and returns a plain result object. All persistence
 * (creating merchants/aliases, stamping the resolved values onto transactions,
 * backfilling history) belongs to later slices (M3/M4) and lives in the caller.
 *
 * ── Zero runtime dependencies on Prisma / the db client ──────────────────────
 * Every @prisma/client import here is TYPE-ONLY (erased at compile time), and
 * the two runtime imports (merchant.ts, merchant-rules.ts) are themselves pure /
 * type-only on Prisma. So this module — and its tsx test — run with a plain
 * `npx tsx`, no `prisma generate`, no DB, no PLAID_* env. Mirrors the
 * dependency-free pattern of merchant.ts / merchant-rules.ts / plaid-category.ts.
 *
 * ── Precedence (approved — MI1 M2, do not add arms) ──────────────────────────
 *     User rules  →  Merchant rules (global catalog)  →  Provider categories  →  Unknown
 * Each arm that fires stamps its own CategorySource:
 *     USER_RULE      GLOBAL_CATALOG                      PLAID_PFC              (null)
 * A resolved category ALWAYS carries a CategorySource; an unresolved category is
 * `null` category + `null` source (the MC1 Phase-0 "provenance unknown" shape).
 *
 * The alias/merchant/rule lookups are INJECTED (pure functions on the optional
 * `ResolverContext`). This keeps the engine testable without a database: the
 * live caller (M4) supplies DB-backed lookups; tests supply in-memory ones.
 * When no context is supplied, the resolver still normalizes and resolves the
 * category from the global catalog + provider hints (the alias/merchant/user-rule
 * arms simply do not fire — nothing to look them up against yet).
 *
 * See docs/initiatives/mi1/MI1_M0_RATIFICATION_2026-07-07.md and the readiness
 * investigation §3/§5.
 */

import type {
  TransactionCategory,
  CategorySource,
  MerchantRuleScope,
} from "@prisma/client";
import { normalizeMerchant } from "@/lib/transactions/merchant";
import { resolveMerchantCategory } from "@/lib/transactions/merchant-rules";

// ── Deterministic confidence per source tier ─────────────────────────────────
// Exposed as a constant so tests assert against it rather than magic numbers.
export const RESOLUTION_CONFIDENCE = {
  /** Explicit human-authored rule — the ratchet's dominating signal. */
  USER_RULE: 1.0,
  /** Curated global merchant catalog — high but not human-certain. */
  GLOBAL_CATALOG: 0.9,
  /** Provider category, keyed off the provider's own confidence level. */
  PROVIDER_VERY_HIGH: 0.99,
  PROVIDER_HIGH: 0.9,
  PROVIDER_MEDIUM: 0.7,
  PROVIDER_LOW: 0.5,
  /** Provider category with no/unknown confidence level. */
  PROVIDER_DEFAULT: 0.6,
} as const;

// ── Public types ─────────────────────────────────────────────────────────────

/** Provider category hints, in a provider-NEUTRAL shape (Plaid PFC is first). */
export interface ProviderCategoryHint {
  /** Plaid personal_finance_category.primary (or an equivalent provider bucket). */
  pfcPrimary?: string | null;
  /** Plaid personal_finance_category.detailed. */
  pfcDetailed?: string | null;
  /** Plaid personal_finance_category.confidence_level (VERY_HIGH/HIGH/MEDIUM/LOW). */
  pfcConfidenceLevel?: string | null;
  /** Legacy provider category array (Plaid's older `category`). */
  legacyCategory?: readonly string[] | null;
}

/** What the resolver is asked to resolve. Provider-neutral; no Plaid types. */
export interface MerchantResolverInput {
  /** Raw merchant descriptor (Transaction.merchant). */
  merchant: string;
  /** Secondary descriptor (Transaction.description / provider `name`). */
  description?: string | null;
  /** Provider category hints, when present. */
  provider?: ProviderCategoryHint | null;
  /** Stable provider merchant id (Transaction.merchantEntityId), for lookup. */
  merchantEntityId?: string | null;
}

/** A minimal reference to an already-persisted merchant (from an injected lookup). */
export interface ResolvedMerchantRef {
  id: string;
  canonicalKey: string;
  displayName: string;
}

/** A minimal reference to a user-scoped merchant rule (from an injected lookup). */
export interface MerchantRuleRef {
  id: string;
  category: TransactionCategory;
  scope: MerchantRuleScope;
}

/**
 * Injected, PURE lookups. All optional — the resolver degrades gracefully when a
 * lookup is absent (the corresponding arm simply cannot fire). The live caller
 * (M4) backs these with the database; tests back them with in-memory maps.
 */
export interface ResolverContext {
  /** Resolve a normalized alias key to a known merchant. */
  lookupAlias?: (aliasKey: string) => ResolvedMerchantRef | null;
  /** Resolve a canonical key / provider id to a known merchant. */
  lookupMerchant?: (query: {
    canonicalKey: string;
    merchantEntityId: string | null;
  }) => ResolvedMerchantRef | null;
  /** User-scoped rules for a resolved merchant, highest-precedence first. */
  lookupUserRules?: (merchantId: string) => readonly MerchantRuleRef[];
}

/** Which precedence arm produced the category (mirrors CategorySource + UNKNOWN). */
export type ResolutionTier = CategorySource | "UNKNOWN";

/** The deterministic result of resolution. Pure data — never persisted here. */
export interface MerchantResolution {
  /** Normalized identity + the matched persisted merchant (null until M4 mints). */
  merchant: {
    canonicalKey: string;
    displayName: string;
    matched: ResolvedMerchantRef | null;
  };
  /** The alias key looked up, and the merchant it matched (if any). */
  alias: {
    aliasKey: string;
    matched: ResolvedMerchantRef | null;
  };
  /** Resolved category, or null when unknown. */
  category: TransactionCategory | null;
  /** Provenance for `category`, or null when unknown. */
  categorySource: CategorySource | null;
  /** The user rule that set the category, when the USER_RULE arm fired. */
  matchedRule: MerchantRuleRef | null;
  /** Deterministic confidence in `category`, or null when unknown. */
  confidence: number | null;
  /** Diagnostics — the arm that fired and the normalization inputs. */
  metadata: {
    tier: ResolutionTier;
    normalizedFrom: string;
  };
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Trailing web-domain suffixes stripped from a single-token display name so a
 * bare-domain descriptor resolves to the brand (NETFLIX.COM → Netflix). Small,
 * deterministic, and applied only to the display/identity name — NOT to the
 * catalog haystack (which matches the raw descriptor), so it cannot change which
 * global rule fires. Fuller normalizer consolidation is M4's job (investigation
 * §5), deliberately not done here.
 */
const WEB_TLD_SUFFIX = /\.(com|net|org|io|co|app|ai|dev|store|shop)$/i;

/**
 * Normalize a raw merchant descriptor into a stable identity. Delegates the
 * heavy lifting (rail-prefix / store-number / masked-tail stripping, casing) to
 * the single existing canonical normalizer (lib/transactions/merchant.ts) — no
 * new normalizer is introduced — then applies the deterministic web-suffix strip.
 */
function normalizeIdentity(raw: string): { canonicalKey: string; displayName: string } {
  const { canonicalName } = normalizeMerchant(raw);
  const displayName = canonicalName.replace(WEB_TLD_SUFFIX, "") || canonicalName;
  return { canonicalKey: displayName.toUpperCase(), displayName };
}

// ── Provider category mapping (PLAID_PFC arm) ─────────────────────────────────

/** Map a provider confidence level to a deterministic numeric confidence. */
function providerConfidence(level: string | null | undefined): number {
  switch ((level ?? "").toUpperCase()) {
    case "VERY_HIGH": return RESOLUTION_CONFIDENCE.PROVIDER_VERY_HIGH;
    case "HIGH":      return RESOLUTION_CONFIDENCE.PROVIDER_HIGH;
    case "MEDIUM":    return RESOLUTION_CONFIDENCE.PROVIDER_MEDIUM;
    case "LOW":       return RESOLUTION_CONFIDENCE.PROVIDER_LOW;
    default:          return RESOLUTION_CONFIDENCE.PROVIDER_DEFAULT;
  }
}

/**
 * Resolve a category from provider hints alone — PFC primary/detailed, then the
 * legacy category array. Returns null when the provider gives no usable signal
 * (→ the Unknown arm). Deliberately does NOT fold in merchant rules (that is the
 * separate GLOBAL_CATALOG arm, already checked before this one) and does NOT
 * default to "Other": an unmapped provider bucket is "unknown", not a category.
 */
function mapProviderCategory(
  hint: ProviderCategoryHint | null | undefined,
): { category: TransactionCategory; confidence: number } | null {
  if (!hint) return null;

  const primary = hint.pfcPrimary ?? "";
  const detailed = hint.pfcDetailed ?? "";
  if (primary) {
    const confidence = providerConfidence(hint.pfcConfidenceLevel);

    // Detailed-level overrides.
    if (detailed.includes("INTEREST")) return { category: "Interest", confidence };
    if (detailed.includes("CREDIT_CARD_PAYMENT")) return { category: "Payment", confidence };

    // Flow-structural + spend-bucket primaries.
    switch (primary) {
      case "INCOME":              return { category: "Income", confidence };
      case "TRANSFER_IN":
      case "TRANSFER_OUT":        return { category: "Transfer", confidence };
      case "LOAN_PAYMENTS":       return { category: "Payment", confidence };
      case "BANK_FEES":           return { category: "Fee", confidence };
      case "FOOD_AND_DRINK":      return { category: "Dining", confidence };
      case "GENERAL_MERCHANDISE": return { category: "Shopping", confidence };
      case "RENT_AND_UTILITIES":  return { category: "Utilities", confidence };
      case "TRAVEL":              return { category: "Travel", confidence };
      default:                    return null; // unmapped primary → unknown
    }
  }

  // Legacy provider category array (older Items). Null on no match.
  const legacy = hint.legacyCategory?.[0]?.toLowerCase() ?? "";
  if (legacy === "") return null;
  const confidence = RESOLUTION_CONFIDENCE.PROVIDER_DEFAULT;
  if (legacy.includes("food") || legacy.includes("restaurant")) return { category: "Dining", confidence };
  if (legacy.includes("shop"))                                  return { category: "Shopping", confidence };
  if (legacy.includes("travel"))                                return { category: "Travel", confidence };
  if (legacy.includes("transfer"))                              return { category: "Transfer", confidence };
  if (legacy.includes("payment"))                               return { category: "Payment", confidence };
  if (legacy.includes("interest"))                              return { category: "Interest", confidence };
  if (legacy.includes("payroll") || legacy.includes("deposit")) return { category: "Income", confidence };
  if (legacy.includes("utilities") || legacy.includes("rent"))  return { category: "Utilities", confidence };
  if (legacy.includes("subscription"))                          return { category: "Subscriptions", confidence };
  return null;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Resolve a transaction's merchant identity and category with provenance.
 *
 * The single public entry point of the Merchant Intelligence resolution layer —
 * every future write path flows through here. Pure and deterministic: identical
 * input (and identical injected lookups) always yields identical output. It does
 * not read or write the database.
 */
export function resolveMerchant(
  input: MerchantResolverInput,
  context: ResolverContext = {},
): MerchantResolution {
  const { canonicalKey, displayName } = normalizeIdentity(input.merchant);
  const aliasKey = canonicalKey;
  const merchantEntityId = input.merchantEntityId ?? null;

  // Identity: alias lookup first, then merchant lookup (both injected/optional).
  const aliasMatch = context.lookupAlias?.(aliasKey) ?? null;
  const merchantMatch =
    aliasMatch ??
    context.lookupMerchant?.({ canonicalKey, merchantEntityId }) ??
    null;

  let category: TransactionCategory | null = null;
  let categorySource: CategorySource | null = null;
  let matchedRule: MerchantRuleRef | null = null;
  let confidence: number | null = null;
  let tier: ResolutionTier = "UNKNOWN";

  // Tier 1 — User rules (only resolvable once a merchant is matched).
  if (merchantMatch && context.lookupUserRules) {
    const rules = context.lookupUserRules(merchantMatch.id);
    const userRule = rules.find((r) => r.scope === "USER") ?? rules[0] ?? null;
    if (userRule) {
      category = userRule.category;
      categorySource = "USER_RULE";
      matchedRule = userRule;
      confidence = RESOLUTION_CONFIDENCE.USER_RULE;
      tier = "USER_RULE";
    }
  }

  // Tier 2 — Merchant rules (curated global catalog).
  if (category === null) {
    const byCatalog = resolveMerchantCategory(input.merchant, input.description);
    if (byCatalog) {
      category = byCatalog;
      categorySource = "GLOBAL_CATALOG";
      confidence = RESOLUTION_CONFIDENCE.GLOBAL_CATALOG;
      tier = "GLOBAL_CATALOG";
    }
  }

  // Tier 3 — Provider categories.
  if (category === null) {
    const provider = mapProviderCategory(input.provider);
    if (provider) {
      category = provider.category;
      categorySource = "PLAID_PFC";
      confidence = provider.confidence;
      tier = "PLAID_PFC";
    }
  }

  // Tier 4 — Unknown: category/source/confidence stay null.

  return {
    merchant: { canonicalKey, displayName, matched: merchantMatch },
    alias: { aliasKey, matched: aliasMatch },
    category,
    categorySource,
    matchedRule,
    confidence,
    metadata: { tier, normalizedFrom: input.merchant },
  };
}

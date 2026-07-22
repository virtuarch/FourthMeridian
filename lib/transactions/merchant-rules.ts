/**
 * lib/transactions/merchant-rules.ts
 *
 * Pure, deterministic GLOBAL merchant → TransactionCategory rules
 * (Merchant Intelligence Slice 1). No I/O, no DB, no LLM, no Plaid dependency:
 * a single pure resolver, mirroring lib/transactions/merchant.ts and
 * lib/transactions/plaid-category.ts (which is TYPE-ONLY on @prisma/client, so
 * this module pulls in NOTHING at runtime and its tsx test runs without
 * `prisma generate` and without any PLAID_* env vars).
 *
 * ── What this is / is NOT ────────────────────────────────────────────────────
 * This is a small, CURATED SEED CATALOG — a stop-gap that rescues recognizable
 * merchants from landing in `Other`. It is NOT the long-term merchant system
 * (that is the future MerchantRule table + user/space overrides + cadence
 * detection, see docs/investigations/MERCHANT_INTELLIGENCE_LAYER_INVESTIGATION.md).
 * It MUST NOT become a dumping ground: entries are limited to
 *   - GLOBAL brands whose identity is universal (Uber, Anthropic, Sephora…),
 *   - REGIONAL-GLOBAL brands that are unambiguous within a locale (Careem,
 *     Gathern, Ajmal), tagged with `locale` (metadata only in this slice — it
 *     does not gate matching yet), and
 *   - a single, phrase-scoped FEE pattern (Amex membership/annual fee).
 *
 * Deliberately HELD OUT (do not add here without a category/design decision):
 *   - merchants blocked by a MISSING category — pharmacies/clinics (Medical),
 *     Vox Cinema/Six Flags/Speedzone (Entertainment), USPS (Postal),
 *     car washes (Auto), trolley (Transit). Forcing them into an inaccurate
 *     existing category would be a lie the AI layer and FlowType inherit.
 *   - CADENCE-AMBIGUOUS merchants — PlayStation, Amazon Prime Video, Namecheap
 *     — a flat Subscriptions rule would mislabel one-off purchases; that is
 *     cadence detection's job, a separate slice.
 *   - USER-SPECIFIC identity — WGU tuition, Georgia LLC filings, personal card
 *     payments. Never global. (Card payments are already resolved by Plaid PFC
 *     LOAN_PAYMENTS upstream of this module.)
 *
 * ── Output contract ──────────────────────────────────────────────────────────
 * resolveMerchantCategory(...) returns a TransactionCategory when a curated rule
 * matches, else null. It only ever returns SPEND/merchant-meaningful categories
 * (Dining, Travel, Shopping, Subscriptions, Fee). It NEVER returns a
 * flow-structural value (Income/Transfer/Payment/Interest) — those belong to
 * Plaid PFC / the flow-classifier, never to a merchant string. Category is the
 * ONLY thing this module influences; FlowType stays downstream in
 * lib/transactions/flow-classifier.ts.
 *
 * ── Matching semantics (CONSERVATIVE) ────────────────────────────────────────
 * Lowercased substring match of a curated token against a haystack built from
 * BOTH the merchant field and the descriptor (`${merchant} ${name}`), mirroring
 * the pre-existing subscription allowlist. Tokens are SPECIFIC phrases
 * ("ace hardware", not "ace"; "napa auto", not "napa") so two unrelated
 * merchants are never merged — the same conservative-merge doctrine as
 * merchant.ts. The catalog is ORDERED and the FIRST matching rule wins, so a
 * more-specific rule ("uber eats" → Dining) is listed BEFORE a broader one
 * ("uber" → Travel).
 */

import type { TransactionCategory } from "@prisma/client";

export type MerchantRuleScope = "global" | "regional";

export interface MerchantRule {
  /** Curated, lowercase, SPECIFIC substrings. Any one matching the haystack fires the rule. */
  tokens: readonly string[];
  /** Target category. Restricted to spend/merchant-meaningful values (never flow-structural). */
  category: TransactionCategory;
  /** Universality of the brand's identity. */
  scope: MerchantRuleScope;
  /** Locale hint for regional brands. METADATA ONLY this slice — does not gate matching. */
  locale?: string;
  /** Human note (e.g. specificity guards). */
  note?: string;
}

/**
 * Subscription-BRAND allowlist — brands that ARE a subscription business.
 * Single source of truth (moved here from plaid-category.ts). Intentionally
 * small and brand-specific. NOTE: "disney" also matches Disney Store / Parks —
 * a pre-existing accepted caveat, preserved unchanged.
 *
 * These are subscription businesses by IDENTITY. This is distinct from
 * CADENCE detection ("does this specific charge recur"), which is a separate,
 * future slice — see the held-out list in this file's header.
 */
export const SUBSCRIPTION_MERCHANTS: readonly string[] = [
  "netflix",
  "spotify",
  "hulu",
  "disney", // Disney+ (caveat: also matches Disney Store / Parks)
  "adobe",
  "microsoft 365",
  "google one",
  "google workspace",
  "apple.com/bill",
  "youtube premium",
];

/**
 * Curated non-subscription global rules. ORDERED — first match wins, so
 * specificity guards (e.g. "uber eats") MUST precede broader tokens ("uber").
 * Subscription BRANDS are handled separately via SUBSCRIPTION_MERCHANTS below,
 * but the CURATED SaaS additions (Anthropic, Supabase, …) live here because
 * they are new to this slice and are not part of the pre-existing allowlist the
 * reclassify-subscriptions backfill keys off.
 */
export const MERCHANT_RULES: readonly MerchantRule[] = [
  // ── Specificity guard — MUST come first ──────────────────────────────────
  { tokens: ["uber eats"], category: "Dining", scope: "global", note: "beats 'uber' → Travel" },

  // ── Travel ───────────────────────────────────────────────────────────────
  { tokens: ["uber"],   category: "Travel", scope: "global" },
  { tokens: ["careem"], category: "Travel", scope: "regional", locale: "MENA" },
  { tokens: ["gathern"], category: "Travel", scope: "regional", locale: "SA" },

  // ── Subscriptions (curated SaaS additions; NOT in the legacy allowlist) ───
  { tokens: ["anthropic"], category: "Subscriptions", scope: "global" },
  { tokens: ["claude.ai"], category: "Subscriptions", scope: "global" },
  { tokens: ["supabase"],  category: "Subscriptions", scope: "global" },
  { tokens: ["vercel"],    category: "Subscriptions", scope: "global" },
  { tokens: ["hostinger"], category: "Subscriptions", scope: "global" },

  // ── Shopping ─────────────────────────────────────────────────────────────
  { tokens: ["sephora"],                                  category: "Shopping", scope: "global" },
  { tokens: ["bath & body works", "bath and body works"], category: "Shopping", scope: "global" },
  { tokens: ["ace hardware"],                             category: "Shopping", scope: "global" },
  { tokens: ["napa auto"],                                category: "Shopping", scope: "global" },
  { tokens: ["ajmal"],                                    category: "Shopping", scope: "regional", locale: "MENA" },

  // ── Fee (pattern-family, phrase-scoped) ──────────────────────────────────
  {
    tokens: ["amex annual fee", "amex membership fee", "amex annual membership", "american express annual"],
    category: "Fee",
    scope: "global",
    note: "membership/annual fee only — phrase-scoped so ordinary Amex purchases are untouched",
  },
];

/** Build the lowercase haystack from both merchant identity fields. */
function haystackOf(merchantName: string | null | undefined, name: string | null | undefined): string {
  return `${merchantName ?? ""} ${name ?? ""}`.toLowerCase();
}

/**
 * Public, narrow predicate for the subscription-brand allowlist — the SINGLE
 * source of truth for "is this a known subscription merchant". Exposed so
 * offline tooling (scripts/reclassify-subscriptions.ts) matches candidates with
 * the exact same rule the live mapper uses. `name` is optional: callers with
 * only a single merchant string may pass just that.
 */
export function isKnownSubscriptionMerchant(
  merchantName: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  const haystack = haystackOf(merchantName, name);
  return SUBSCRIPTION_MERCHANTS.some((token) => haystack.includes(token));
}

/**
 * Resolve a merchant to a TransactionCategory using the curated global catalog.
 * Returns null when no rule matches (the caller then falls back to Plaid PFC /
 * legacy signals). Pure and deterministic.
 *
 * Order: curated MERCHANT_RULES first (most-specific-first within the list),
 * then the subscription-brand allowlist. The two sets do not overlap, so the
 * relative order is not correctness-critical — it is fixed for determinism.
 */
export function resolveMerchantCategory(
  merchantName: string | null | undefined,
  name?: string | null | undefined,
): TransactionCategory | null {
  const haystack = haystackOf(merchantName, name);
  if (haystack.trim() === "") return null;

  for (const rule of MERCHANT_RULES) {
    if (rule.tokens.some((token) => haystack.includes(token))) {
      return rule.category;
    }
  }

  if (SUBSCRIPTION_MERCHANTS.some((token) => haystack.includes(token))) {
    return "Subscriptions";
  }

  return null;
}

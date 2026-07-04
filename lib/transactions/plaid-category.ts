/**
 * lib/transactions/plaid-category.ts
 *
 * Pure, deterministic Plaid → TransactionCategory mapping.
 *
 * Extracted verbatim (then extended) from lib/plaid/syncTransactions.ts so it
 * can be unit-tested WITHOUT importing Prisma, the db client, or the Plaid API
 * client — mirroring the dependency-free extraction pattern of
 * lib/transactions/fingerprint.ts, merchant.ts, and plaid-flow-input.ts.
 *
 * ── Zero runtime dependencies ────────────────────────────────────────────────
 * Both imports are TYPE-ONLY (`import type`), so they are erased at compile time
 * and this module pulls in nothing at runtime. TransactionCategory's Prisma type
 * is a string-literal union, so returning the literal values (e.g.
 * "Subscriptions") is fully type-checked while keeping the module — and its tsx
 * test — free of `@prisma/client`, `@/lib/db`, and `@/lib/plaid/client` (the
 * last of which throws at module load when PLAID_* env vars are unset). The test
 * therefore runs with a plain `npx tsx` and needs no `prisma generate`.
 *
 * ── Subscription detection (v2.5 fix) ────────────────────────────────────────
 * The original mapper only produced `Subscriptions` when Plaid's PFC `detailed`
 * contained the token "SUBSCRIPTION". Confirmed against Plaid's published
 * taxonomy CSV (transactions-personal-finance-category-taxonomy.csv, retrieved
 * 2026-07-04): NO PFC detailed value contains that token, so that branch never
 * fired on real Plaid data and streaming/SaaS merchants fell through to
 * Other/Shopping.
 *
 * Detection is deterministic and MERCHANT-ALLOWLIST-DRIVEN (added BEFORE the
 * primary PFC switch). It deliberately does NOT allowlist whole PFC detailed
 * buckets: Plaid folds concerts, movie theaters, sporting events, and one-off
 * music/video purchases into the same ENTERTAINMENT_* detaileds as streaming
 * services, so classifying an entire bucket as Subscriptions would misclassify
 * those one-off purchases. Only merchants on SUBSCRIPTION_MERCHANTS become
 * Subscriptions. Everything else is byte-identical to the original behavior.
 */

import type { TransactionCategory } from "@prisma/client";
import type { Transaction as PlaidTransaction } from "plaid";

/**
 * Input shape for the mapper. Widened from the original
 * Pick<PlaidTransaction, "personal_finance_category" | "category"> to also carry
 * merchant identity (`merchant_name`, `name`) for the deterministic merchant
 * fallback. Still a structural Pick — no new dependency.
 */
export type PlaidCategoryInput = Pick<
  PlaidTransaction,
  "personal_finance_category" | "category" | "merchant_name" | "name"
>;

/**
 * Tight, deterministic merchant-name substring allowlist (lower-cased match
 * against `merchant_name` and `name`). Intentionally small and brand-specific —
 * this is a seed of unambiguous subscription brands, not an exhaustive registry
 * (full brand→category resolution is the future Merchant Engine's job).
 */
const SUBSCRIPTION_MERCHANTS: readonly string[] = [
  "netflix",
  "spotify",
  "hulu",
  "disney", // Disney+ (see caveat: also matches Disney Store / Parks)
  "adobe",
  "microsoft 365",
  "google one",
  "google workspace",
  "apple.com/bill",
  "youtube premium",
];

/**
 * True when either Plaid merchant field contains an allowlisted subscription
 * brand. Checks BOTH `merchant_name` and `name` because subscription billing
 * descriptors (e.g. "APPLE.COM/BILL") frequently live in `name` while
 * `merchant_name` is a cleaner brand ("Apple").
 */
function isSubscriptionMerchant(
  merchantName: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const haystack = `${merchantName ?? ""} ${name ?? ""}`.toLowerCase();
  return SUBSCRIPTION_MERCHANTS.some((token) => haystack.includes(token));
}

/**
 * Public, narrow predicate for the subscription merchant allowlist — the SINGLE
 * source of truth for "is this a known subscription merchant". Exposed so
 * offline tooling (e.g. scripts/reclassify-subscriptions.ts, which reclassifies
 * historical rows that incremental Plaid sync never revisits) matches candidates
 * with the exact same rule the live import mapper uses, and the two can never
 * drift. `name` is optional: callers with only a single merchant string (e.g. a
 * persisted Transaction.merchant) may pass just that.
 */
export function isKnownSubscriptionMerchant(
  merchantName: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  return isSubscriptionMerchant(merchantName, name);
}

/**
 * Maps a Plaid transaction's category info to our TransactionCategory enum.
 * Prefers the modern `personal_finance_category` taxonomy; falls back to the
 * legacy `category` string array; defaults to "Other". Never throws — an
 * unrecognized or missing category should never block a transaction import.
 */
export function mapPlaidCategory(txn: PlaidCategoryInput): TransactionCategory {
  const pfc = txn.personal_finance_category;
  if (pfc?.primary) {
    const detailed = pfc.detailed ?? "";

    // Detailed-level override — more precise than the primary bucket alone.
    if (detailed.includes("INTEREST")) return "Interest";

    // ── Subscription detection (additive, before the primary switch) ─────────
    // Merchant-allowlist-driven ONLY. We do NOT allowlist whole ENTERTAINMENT_*
    // detaileds, because Plaid folds concerts, theaters, sporting events, and
    // one-off music/video purchases into the same buckets as streaming services.
    // (The original literal-token heuristic is kept as a harmless defensive
    // superset — it never fires on real Plaid PFC but preserves the prior contract.)
    if (isSubscriptionMerchant(txn.merchant_name, txn.name)) return "Subscriptions";
    if (detailed.includes("SUBSCRIPTION")) return "Subscriptions";

    switch (pfc.primary) {
      case "INCOME":              return "Income";
      case "TRANSFER_IN":
      case "TRANSFER_OUT":        return "Transfer";
      case "LOAN_PAYMENTS":       return "Payment";
      case "BANK_FEES":           return "Fee";
      case "FOOD_AND_DRINK":      return "Dining";
      case "GENERAL_MERCHANDISE": return "Shopping";
      case "RENT_AND_UTILITIES":  return "Utilities";
      case "TRAVEL":              return "Travel";
      default:                    return "Other";
    }
  }

  // No PFC at all (older Items / sparse rows): the merchant allowlist still
  // applies, checked before the legacy category-array fallback.
  if (isSubscriptionMerchant(txn.merchant_name, txn.name)) return "Subscriptions";

  // Legacy fallback — Plaid's older `category` array, e.g. ["Food and Drink", "Restaurants"].
  const legacy = txn.category?.[0]?.toLowerCase() ?? "";
  if (legacy.includes("food") || legacy.includes("restaurant")) return "Dining";
  if (legacy.includes("shop"))                                  return "Shopping";
  if (legacy.includes("travel"))                                return "Travel";
  if (legacy.includes("transfer"))                              return "Transfer";
  if (legacy.includes("payment"))                               return "Payment";
  if (legacy.includes("interest"))                              return "Interest";
  if (legacy.includes("payroll") || legacy.includes("deposit")) return "Income";
  if (legacy.includes("utilities") || legacy.includes("rent"))  return "Utilities";
  if (legacy.includes("subscription"))                          return "Subscriptions";

  return "Other";
}

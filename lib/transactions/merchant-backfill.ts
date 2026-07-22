/**
 * lib/transactions/merchant-backfill.ts
 *
 * Merchant Intelligence — M3 historical-backfill PLANNER (MI1).
 *
 * A single PURE, deterministic function that decides — for one historical
 * transaction row — what Merchant Intelligence writes should happen, given the
 * M2 resolver's output and what already exists in the database. It performs NO
 * I/O: the caller (scripts/backfill-merchant-intelligence.ts) supplies the
 * existing-identity facts (looked up in the DB) and executes the returned plan.
 * Splitting the decision out keeps the backfill's core logic fully unit-testable
 * without Prisma or a live database (mirrors the injected-lookup purity of
 * merchant-resolver.ts).
 *
 * ── Safety doctrine (why category VALUES are never rewritten here) ────────────
 * This backfill STAMPS provenance and merchant identity; it does NOT rewrite the
 * stored `category` value. Rewriting a category offline without atomically
 * re-deriving `flowType` is precisely the flow/category desync seam the Desync
 * initiative certified clean (STATUS §FlowType) — and the atomic rewrite helper
 * (`buildCategoryRewrite`) is deliberately NOT built yet (deferred with M2). So:
 *   • `categorySource` is stamped ONLY when the resolver INDEPENDENTLY produces
 *     the SAME category already stored — i.e. we record how an existing,
 *     unchanged category was obtained. Provenance is therefore always accurate.
 *   • When the resolver disagrees or returns nothing, the stored category is left
 *     untouched and `categorySource` stays null ("unknown" — never downgraded).
 *   • `category` and `categoryRuleId` columns are never written by M3
 *     (no MerchantRule-sourced category arises during backfill).
 * This guarantees zero runtime-behavior / flow-desync risk. Divergent category
 * value rewrites belong to the later rewrite-helper slice.
 *
 * ── Never-overwrite guarantees ───────────────────────────────────────────────
 *   • USER_RULE / USER_OVERRIDE (manual) provenance — never touched (a row whose
 *     `categorySource` is already set is never re-stamped).
 *   • Existing merchant assignments — a row whose `merchantId` is already set is
 *     never re-pointed.
 * Idempotent by construction: once a row has `merchantId`, the planner emits no
 * merchant writes for it; a re-run is a no-op.
 *
 * Zero runtime deps on Prisma/db: the only @prisma/client import is TYPE-ONLY.
 */

import type {
  CategorySource,
  MerchantAliasSource,
  TransactionCategory,
} from "@prisma/client";
import type { MerchantResolution } from "@/lib/transactions/merchant-resolver";

/** The current persisted state of the row being considered (MI columns only). */
export interface BackfillRowState {
  id: string;
  /** Current stored category (Transaction.category is non-null). */
  category: TransactionCategory;
  /** Current MI provenance — null = no MI provenance yet. */
  categorySource: CategorySource | null;
  /** Current merchant assignment — null = unassigned. */
  merchantId: string | null;
  /** Stable provider merchant id (Transaction.merchantEntityId), if any. */
  merchantEntityId: string | null;
}

/** Existing-identity facts the caller looks up in the DB (in-memory in tests). */
export interface ExistingIdentity {
  /** An existing Merchant matched by plaidEntityId or canonicalKey, else null. */
  existingMerchant: { id: string } | null;
  /** Whether a MerchantAlias already exists for this row's alias key. */
  aliasExists: boolean;
}

/** A minted-merchant identity (id is assigned by the DB at insert time). */
export interface MintMerchant {
  canonicalKey: string;
  displayName: string;
  plaidEntityId: string | null;
}

/** The deterministic write plan for one row. Pure data — executed by the script. */
export interface BackfillPlan {
  /** True when the row needs no writes at all (already fully processed). */
  skip: boolean;
  /** True when Transaction.merchantId should be written (row.merchantId was null). */
  assignMerchant: boolean;
  /** Mint a new Merchant with this identity, or null when reusing an existing one. */
  mintMerchant: MintMerchant | null;
  /** Reuse this existing merchant id, or null when minting / not assigning. */
  reuseMerchantId: string | null;
  /** Create a MerchantAlias for this key, or null when the alias already exists. */
  createAlias: { aliasKey: string; source: MerchantAliasSource } | null;
  /** Value to write to Transaction.categorySource, or null to leave it unchanged. */
  setCategorySource: CategorySource | null;
}

/**
 * Decide the Merchant Intelligence backfill writes for one row. Pure and
 * deterministic: identical inputs always yield an identical plan, which is what
 * makes the backfill restart-safe (a row's plan depends only on its own current
 * state) and idempotent (once `merchantId` is set, the plan does nothing).
 */
export function computeBackfillPlan(
  row: BackfillRowState,
  resolution: MerchantResolution,
  existing: ExistingIdentity,
): BackfillPlan {
  // ── Merchant identity — only when the row has none (never re-point) ──────────
  const assignMerchant = row.merchantId === null;
  let mintMerchant: MintMerchant | null = null;
  let reuseMerchantId: string | null = null;
  let createAlias: { aliasKey: string; source: MerchantAliasSource } | null = null;

  if (assignMerchant) {
    if (existing.existingMerchant) {
      reuseMerchantId = existing.existingMerchant.id;
    } else {
      mintMerchant = {
        canonicalKey: resolution.merchant.canonicalKey,
        displayName: resolution.merchant.displayName,
        plaidEntityId: row.merchantEntityId,
      };
    }
    if (!existing.aliasExists) {
      createAlias = {
        aliasKey: resolution.alias.aliasKey,
        // Provenance of the descriptor: Plaid when a provider id is present, else
        // it came through the import/history path. (USER aliases are an M5 concern.)
        source: (row.merchantEntityId ? "PLAID" : "IMPORT") as MerchantAliasSource,
      };
    }
  }

  // ── Category provenance — stamp ONLY when currently unknown AND the resolver ──
  //    confirms the already-stored category (accurate, non-mutating). Never
  //    overwrites USER_RULE / USER_OVERRIDE (those have a non-null source).
  let setCategorySource: CategorySource | null = null;
  if (
    row.categorySource === null &&
    resolution.category !== null &&
    resolution.category === row.category
  ) {
    setCategorySource = resolution.categorySource;
  }

  const skip = !assignMerchant && setCategorySource === null;
  return { skip, assignMerchant, mintMerchant, reuseMerchantId, createAlias, setCategorySource };
}

/**
 * lib/transactions/merchant-write.ts
 *
 * Merchant Intelligence — shared write-time integration (MI1 M4).
 *
 * The ONE place that turns a transaction's merchant fields into persisted
 * Merchant Intelligence: it reuses the M2 resolver (lib/transactions/
 * merchant-resolver.ts) and the M3 planner (lib/transactions/merchant-backfill.ts)
 * — no resolver or decision logic is duplicated here — mints/reuses the Merchant
 * and its MerchantAlias, captures provider enrichment when supplied, and returns
 * the MI columns for the caller to stamp onto the Transaction. Used by:
 *   • the live Plaid sync write path (lib/plaid/syncTransactions.ts),
 *   • the import CREATE path (app/api/accounts/[id]/import/route.ts), and
 *   • the offline historical backfill (scripts/backfill-merchant-intelligence.ts),
 * so all three agree by construction.
 *
 * Never overwrites: an existing merchant assignment (row already has merchantId)
 * or an existing category provenance (USER_RULE / USER_OVERRIDE / any set
 * categorySource). Never rewrites the category VALUE and never touches flowType —
 * the flow classifier remains the sole flow authority, so the flow/category
 * desync invariant is preserved.
 *
 * The Prisma client is passed in (a PrismaClient or a $transaction client), which
 * keeps the module reusable across those three callers and unit-testable with an
 * in-memory fake.
 */

import type { CategorySource, Prisma, TransactionCategory } from "@prisma/client";
import { resolveMerchant, type ProviderCategoryHint, type MerchantRuleRef, type ResolverContext } from "@/lib/transactions/merchant-resolver";
import { computeBackfillPlan, type BackfillPlan, type ExistingIdentity } from "@/lib/transactions/merchant-backfill";
import type { EnrichmentCapture } from "@/lib/transactions/merchant-enrichment";

/** A PrismaClient or a $transaction client — both satisfy this. */
export type MerchantWriteClient = Prisma.TransactionClient;

/** Build the Merchant enrichment columns from a neutral capture. */
function enrichmentData(e: EnrichmentCapture) {
  return {
    website: e.website,
    logoUrl: e.logoUrl,
    enrichmentSource: e.source,
    enrichmentConfidence: e.confidence,
    enrichedAt: e.timestamp,
  };
}

/**
 * Look up an existing Merchant + alias for a normalized identity. Alias is the
 * strongest signal (it names both existence and the merchant); otherwise resolve
 * by the stable provider id, then the canonical key.
 */
export async function lookupExisting(
  client: MerchantWriteClient,
  canonicalKey: string,
  aliasKey: string,
  plaidEntityId: string | null,
): Promise<ExistingIdentity> {
  const aliasRow = await client.merchantAlias.findUnique({
    where: { aliasKey },
    select: { merchantId: true },
  });
  if (aliasRow) return { existingMerchant: { id: aliasRow.merchantId }, aliasExists: true };

  if (plaidEntityId) {
    const byEntity = await client.merchant.findUnique({ where: { plaidEntityId }, select: { id: true } });
    if (byEntity) return { existingMerchant: byEntity, aliasExists: false };
  }
  const byKey = await client.merchant.findUnique({ where: { canonicalKey }, select: { id: true } });
  return { existingMerchant: byKey, aliasExists: false };
}

/** Result of executing a plan: the merchant id plus what was done (for reporting). */
export interface AppliedMerchant {
  merchantId: string | null;
  minted: boolean;
  reused: boolean;
  aliasCreated: boolean;
}

/**
 * Execute a backfill plan's merchant/alias writes against the client, optionally
 * stamping enrichment. UPSERTs (by the unique canonicalKey / aliasKey) so it is
 * idempotent and duplicate-safe. Enrichment is applied on mint, and on reuse
 * ONLY when the existing merchant has no enrichmentSource yet (never overwrites a
 * higher/earlier source). Returns the resolved merchant id.
 */
export async function applyMerchantPlan(
  client: MerchantWriteClient,
  plan: BackfillPlan,
  enrichment?: EnrichmentCapture | null,
): Promise<AppliedMerchant> {
  let merchantId: string | null = plan.reuseMerchantId;
  let minted = false;
  let reused = false;
  let aliasCreated = false;

  if (plan.assignMerchant) {
    if (plan.mintMerchant) {
      const created = await client.merchant.upsert({
        where: { canonicalKey: plan.mintMerchant.canonicalKey },
        create: {
          canonicalKey: plan.mintMerchant.canonicalKey,
          displayName: plan.mintMerchant.displayName,
          plaidEntityId: plan.mintMerchant.plaidEntityId,
          ...(enrichment ? enrichmentData(enrichment) : {}),
        },
        update: {}, // never overwrite an existing merchant's fields on a mint race
        select: { id: true },
      });
      merchantId = created.id;
      minted = true;
    } else if (plan.reuseMerchantId) {
      merchantId = plan.reuseMerchantId;
      reused = true;
      if (enrichment) {
        // Fill enrichment only when the existing merchant has none.
        await client.merchant.updateMany({
          where: { id: plan.reuseMerchantId, enrichmentSource: null },
          data: enrichmentData(enrichment),
        });
      }
    }
    if (plan.createAlias && merchantId) {
      await client.merchantAlias.upsert({
        where: { aliasKey: plan.createAlias.aliasKey },
        create: { aliasKey: plan.createAlias.aliasKey, source: plan.createAlias.source, merchantId },
        update: {}, // never re-point an existing alias (avoid over-merge)
        select: { id: true },
      });
      aliasCreated = true;
    }
  }

  return { merchantId, minted, reused, aliasCreated };
}

/** Input to the one-shot live resolver. Provider-neutral. */
export interface MerchantWriteInput {
  merchant: string;
  description?: string | null;
  provider?: ProviderCategoryHint | null;
  merchantEntityId?: string | null;
  /** The category being written for this row (used to confirm provenance). */
  currentCategory: string;
  /** Existing provenance — non-null means "do not overwrite". */
  currentCategorySource?: CategorySource | null;
  /** Existing merchant assignment — non-null means "do not re-point". */
  currentMerchantId?: string | null;
  /**
   * M5 — the user whose persisted USER MerchantRules should apply to this write
   * (the account/import owner). When supplied and the resolved merchant has a
   * USER rule, the rule's category overrides at USER_RULE provenance so the
   * correction reaches future transactions. Omitted (e.g. the historical
   * backfill) means no user rules apply — no historical rewrite.
   */
  ownerUserId?: string | null;
}

/** The MI columns the caller should stamp onto the Transaction. */
export interface MerchantWriteResult {
  /** Resolved/minted merchant id (or the existing one). */
  merchantId: string | null;
  /** True when the caller should write merchantId (row had none). */
  setMerchantId: boolean;
  /**
   * M5 — a category OVERRIDE to apply (from a USER rule), or null to keep the
   * caller's computed category. When set, the caller MUST re-derive flowType from
   * this category via the authoritative pipeline (no category/flow desync).
   */
  category: TransactionCategory | null;
  /** categorySource to stamp, or null to leave the column untouched. */
  categorySource: CategorySource | null;
  /** The USER MerchantRule that produced the override, else null. */
  categoryRuleId: string | null;
  /**
   * M5 — true when the row already carries USER_OVERRIDE / USER_RULE provenance:
   * the caller must PRESERVE the existing category, flow, and categorySource
   * (never downgrade a user correction on a later sync/modified event).
   */
  preserveExisting: boolean;
  applied: AppliedMerchant;
}

/**
 * Resolve a transaction's merchant identity + category provenance and persist the
 * Merchant/MerchantAlias (mint or reuse), returning the MI columns to stamp.
 * The single entry point for live write paths. Reuses the M2 resolver and the M3
 * planner verbatim.
 */
export async function resolveMerchantWrite(
  client: MerchantWriteClient,
  input: MerchantWriteInput,
  enrichment?: EnrichmentCapture | null,
): Promise<MerchantWriteResult> {
  const baseInput = {
    merchant: input.merchant,
    description: input.description ?? null,
    provider: input.provider ?? null,
    merchantEntityId: input.merchantEntityId ?? null,
  };
  const resolution0 = resolveMerchant(baseInput);

  const existing = await lookupExisting(
    client,
    resolution0.merchant.canonicalKey,
    resolution0.alias.aliasKey,
    input.merchantEntityId ?? null,
  );

  // M5 — owner-scoped USER rules. Only consulted for an EXISTING merchant (a
  // brand-new merchant has no rules) and only when an owner is supplied (the
  // backfill supplies none → no historical rewrite). Fed back through the M2
  // resolver's own context so the precedence stays single-sourced (no duplicate
  // rule engine): USER_RULE > GLOBAL_CATALOG > PLAID_PFC.
  let userRules: MerchantRuleRef[] = [];
  if (existing.existingMerchant && input.ownerUserId) {
    const rules = await client.merchantRule.findMany({
      where: { merchantId: existing.existingMerchant.id, scope: "USER", ownerUserId: input.ownerUserId },
      orderBy: { createdAt: "desc" },
      select: { id: true, category: true, scope: true },
    });
    userRules = rules as MerchantRuleRef[];
  }
  const resolution = userRules.length
    ? resolveMerchant(baseInput, {
        lookupMerchant: () => existing.existingMerchant && { id: existing.existingMerchant.id, canonicalKey: resolution0.merchant.canonicalKey, displayName: resolution0.merchant.displayName },
        lookupAlias: () => (existing.aliasExists && existing.existingMerchant ? { id: existing.existingMerchant.id, canonicalKey: resolution0.merchant.canonicalKey, displayName: resolution0.merchant.displayName } : null),
        lookupUserRules: () => userRules,
      } as ResolverContext)
    : resolution0;

  const plan = computeBackfillPlan(
    {
      id: "",
      category: input.currentCategory as never,
      categorySource: input.currentCategorySource ?? null,
      merchantId: input.currentMerchantId ?? null,
      merchantEntityId: input.merchantEntityId ?? null,
    },
    resolution,
    existing,
  );

  const applied = plan.assignMerchant
    ? await applyMerchantPlan(client, plan, enrichment)
    : { merchantId: input.currentMerchantId ?? null, minted: false, reused: false, aliasCreated: false };

  // Category decision, in precedence order:
  //  1. PRESERVE — an existing USER_OVERRIDE / USER_RULE is never downgraded.
  //  2. OVERRIDE — a matched USER rule applies its category at USER_RULE.
  //  3. CONFIRM  — otherwise stamp provenance for the caller's category (M4).
  let category: TransactionCategory | null = null;
  let categorySource: CategorySource | null = plan.setCategorySource;
  let categoryRuleId: string | null = null;
  let preserveExisting = false;

  if (input.currentCategorySource === "USER_OVERRIDE" || input.currentCategorySource === "USER_RULE") {
    preserveExisting = true;
    categorySource = null;
  } else if (resolution.categorySource === "USER_RULE" && resolution.matchedRule) {
    category = resolution.category;
    categorySource = "USER_RULE";
    categoryRuleId = resolution.matchedRule.id;
  }

  return {
    merchantId: applied.merchantId,
    setMerchantId: plan.assignMerchant,
    category,
    categorySource,
    categoryRuleId,
    preserveExisting,
    applied,
  };
}

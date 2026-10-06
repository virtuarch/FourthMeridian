/**
 * lib/transactions/merchant-merge-review.ts
 *
 * Merchant Intelligence — MI2 S2 review orchestration.
 *
 * The single place that wires the PURE detector (merchant-merge-suggest.ts), the
 * decision store (merchant-merge-decisions.ts), and the merge ENGINE
 * (merchant-merge.ts) together for the review surface. It owns all merchant
 * behaviour so the route and page carry NONE: a route calls one of these two
 * functions with the db client and returns the result.
 *
 *   getPendingMergeCandidates(client)  — load facts → detect → drop decided pairs
 *                                        → enrich with review counts. READ-ONLY.
 *   applyMergeReviewDecision(client, …) — MERGE: resolve keys → ids → the engine
 *                                        → record MERGED. DISMISS: record only,
 *                                        touching no merchant record.
 *
 * Execution stays in mergeMerchants(); this module never re-implements a merge.
 * The client is injected (the route passes `db`), so no `db`/`prisma` singleton
 * handle is referenced here — merchant-table access is via the injected client,
 * keeping the MI-schema tripwire green.
 */

import type { PrismaClient } from "@prisma/client";
import { mergeMerchants } from "@/lib/transactions/merchant-merge";
import {
  suggestMerchantMerges,
  type MergeCandidate,
  type MergeDetectorMerchant,
} from "@/lib/transactions/merchant-merge-suggest";
import {
  loadDecidedPairKeys,
  filterPendingCandidates,
  recordMergeDecision,
  mergePairKey,
} from "@/lib/transactions/merchant-merge-decisions";
import { AuditAction } from "@/lib/audit-actions";

/** Per-merchant review counts shown beside a candidate. */
export interface MerchantReviewFacts {
  displayName: string;
  aliasCount: number;
  transactionCount: number;
  ruleCount: number;
}

/** A pending candidate enriched with the minimum a human needs to decide. */
export interface PendingMergeCandidate extends MergeCandidate {
  survivor: MerchantReviewFacts;
  absorbed: MerchantReviewFacts;
}

/**
 * Compute the still-pending merge candidates. Pure detection over injected facts,
 * filtered by persisted decisions, enriched with counts. No writes.
 */
export async function getPendingMergeCandidates(
  client: PrismaClient,
): Promise<PendingMergeCandidate[]> {
  // 1. Merchant identity facts + review counts (one query).
  const merchants = await client.merchant.findMany({
    select: {
      id: true,
      canonicalKey: true,
      displayName: true,
      plaidEntityId: true,
      _count: { select: { aliases: true, transactions: true, rules: true } },
    },
  });

  // 2. Provider entity ids observed on each merchant's transactions (one query),
  //    feeding the T1 contradiction signal. Nulls are skipped in the loop below
  //    (no where-filter — keeps this module free of any MI-column write shape).
  const observed = await client.transaction.groupBy({
    by: ["merchantId", "merchantEntityId"],
  });
  const observedByMerchant = new Map<string, string[]>();
  for (const row of observed) {
    if (!row.merchantId || !row.merchantEntityId) continue;
    const list = observedByMerchant.get(row.merchantId) ?? [];
    list.push(row.merchantEntityId);
    observedByMerchant.set(row.merchantId, list);
  }

  // 3. Detect (pure) → filter out already-decided pairs.
  const detectorInput: MergeDetectorMerchant[] = merchants.map((m) => ({
    id: m.id,
    canonicalKey: m.canonicalKey,
    displayName: m.displayName,
    plaidEntityId: m.plaidEntityId,
    observedEntityIds: observedByMerchant.get(m.id) ?? [],
  }));
  const decided = await loadDecidedPairKeys(client);
  const pending = filterPendingCandidates(suggestMerchantMerges(detectorInput), decided);

  // 4. Enrich with counts for display.
  const factsById = new Map(
    merchants.map((m) => [
      m.id,
      {
        displayName: m.displayName,
        aliasCount: m._count.aliases,
        transactionCount: m._count.transactions,
        ruleCount: m._count.rules,
      } satisfies MerchantReviewFacts,
    ]),
  );
  const fallback = (name: string): MerchantReviewFacts => ({
    displayName: name,
    aliasCount: 0,
    transactionCount: 0,
    ruleCount: 0,
  });
  return pending.map((c) => ({
    ...c,
    survivor: factsById.get(c.survivorId) ?? fallback(c.survivorKey),
    absorbed: factsById.get(c.absorbedId) ?? fallback(c.absorbedKey),
  }));
}

/** The operator's verdict on one reviewed pair. */
export interface MergeReviewDecision {
  verdict: "MERGED" | "DISMISSED";
  survivorKey: string;
  absorbedKey: string;
  evidenceTier: string;
  evidenceSignal?: string | null;
}

/** The pair is not one the detector currently proposes (or it was already decided). */
export class MergeReviewIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeReviewIneligibleError";
  }
}

/**
 * Apply a human verdict (MERCHANT-OPS AUTHORITY, 2026-10-06).
 *
 *   ELIGIBILITY — the pair must be a CURRENT pending candidate from the detector
 *               (same unordered pair; the operator may flip which side survives).
 *               The evidence tier/signal recorded are the DETECTOR's, never the
 *               request's. A pair nobody proposed cannot be merged or dismissed.
 *   MERGED    → resolve the two canonicalKeys, run the engine (the ONLY execution
 *               path). The decision row AND an AuditLog record carrying the full
 *               merge report and a recovery snapshot of the merged-away merchant
 *               are written INSIDE the merge transaction: all commit together or
 *               none do.
 *   DISMISSED → record the decision and its AuditLog record in one transaction;
 *               no merchant record is touched.
 */
export async function applyMergeReviewDecision(
  client: PrismaClient,
  decision: MergeReviewDecision,
  decidedByUserId: string,
): Promise<{ pairKey: string; merged: boolean }> {
  const pending = await getPendingMergeCandidates(client);
  const candidate = pending.find((c) =>
    (c.survivorKey === decision.survivorKey && c.absorbedKey === decision.absorbedKey) ||
    (c.survivorKey === decision.absorbedKey && c.absorbedKey === decision.survivorKey));
  if (!candidate) {
    throw new MergeReviewIneligibleError(
      `not a pending merge candidate (${decision.survivorKey} / ${decision.absorbedKey}); only detector-proposed, undecided pairs can be decided`,
    );
  }
  const evidenceTier = candidate.tier;
  const evidenceSignal = candidate.signal ?? null;
  const pairKey = mergePairKey(decision.survivorKey, decision.absorbedKey);

  if (decision.verdict === "DISMISSED") {
    await client.$transaction(async (tx) => {
      await recordMergeDecision(tx, {
        survivorKey: decision.survivorKey,
        absorbedKey: decision.absorbedKey,
        verdict: "DISMISSED",
        evidenceTier,
        evidenceSignal,
        decidedByUserId,
      });
      await tx.auditLog.create({
        data: {
          userId: decidedByUserId,
          action: AuditAction.MERCHANT_MERGE_DISMISSED,
          metadata: { pairKey, survivorKey: decision.survivorKey, absorbedKey: decision.absorbedKey, evidenceTier, evidenceSignal },
        },
      });
    });
    return { pairKey, merged: false };
  }

  // MERGED — resolve keys to ids, then delegate execution to the engine.
  const [survivor, absorbed] = await Promise.all([
    client.merchant.findUnique({ where: { canonicalKey: decision.survivorKey }, select: { id: true } }),
    client.merchant.findUnique({ where: { canonicalKey: decision.absorbedKey }, select: { id: true } }),
  ]);
  if (!survivor) throw new Error(`survivor merchant not found (canonicalKey=${decision.survivorKey})`);
  if (!absorbed) throw new Error(`absorbed merchant not found (canonicalKey=${decision.absorbedKey})`);
  if (survivor.id === absorbed.id) throw new Error("survivor and absorbed resolve to the same merchant");

  // The single sanctioned execution path. Atomic: the merge, the decision and the
  // audit record commit together; any throw leaves nothing changed or recorded.
  await mergeMerchants(client, {
    survivorId: survivor.id,
    duplicateIds: [absorbed.id],
    evidence: { tier: evidenceTier, signal: evidenceSignal ?? undefined, note: "merge-review" },
    dryRun: false,
    withinTransaction: async (tx, applied) => {
      await recordMergeDecision(tx, {
        survivorKey: decision.survivorKey,
        absorbedKey: decision.absorbedKey,
        verdict: "MERGED",
        evidenceTier,
        evidenceSignal,
        decidedByUserId,
      });
      await tx.auditLog.create({
        data: {
          userId: decidedByUserId,
          action: AuditAction.MERCHANT_MERGE_APPLIED,
          metadata: JSON.parse(JSON.stringify({
            pairKey,
            evidence: { tier: evidenceTier, signal: evidenceSignal },
            survivor: applied.survivor,
            perDuplicate: applied.perDuplicate,
            recovery: applied.snapshots,
          })),
        },
      });
    },
  });
  return { pairKey, merged: true };
}

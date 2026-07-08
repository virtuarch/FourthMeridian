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
} from "@/lib/transactions/merchant-merge-decisions";

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

/**
 * Apply a human verdict.
 *   MERGED    → resolve the two canonicalKeys to merchant ids, run the engine
 *               (the ONLY execution path), then record the MERGED decision. If
 *               the engine throws, NO decision is recorded (the merge is atomic).
 *   DISMISSED → record the DISMISSED decision only; NO merchant record is touched.
 * Returns the persisted pairKey. Throws on unresolved keys or a same-merchant pair.
 */
export async function applyMergeReviewDecision(
  client: PrismaClient,
  decision: MergeReviewDecision,
  decidedByUserId: string,
): Promise<{ pairKey: string; merged: boolean }> {
  if (decision.verdict === "DISMISSED") {
    const { pairKey } = await recordMergeDecision(client, {
      survivorKey: decision.survivorKey,
      absorbedKey: decision.absorbedKey,
      verdict: "DISMISSED",
      evidenceTier: decision.evidenceTier,
      evidenceSignal: decision.evidenceSignal ?? null,
      decidedByUserId,
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

  // The single sanctioned execution path. Atomic; throws leave nothing recorded.
  await mergeMerchants(client, {
    survivorId: survivor.id,
    duplicateIds: [absorbed.id],
    evidence: { tier: decision.evidenceTier, signal: decision.evidenceSignal ?? undefined, note: "merge-review" },
    dryRun: false,
  });

  const { pairKey } = await recordMergeDecision(client, {
    survivorKey: decision.survivorKey,
    absorbedKey: decision.absorbedKey,
    verdict: "MERGED",
    evidenceTier: decision.evidenceTier,
    evidenceSignal: decision.evidenceSignal ?? null,
    decidedByUserId,
  });
  return { pairKey, merged: true };
}

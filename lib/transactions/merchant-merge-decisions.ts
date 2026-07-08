/**
 * lib/transactions/merchant-merge-decisions.ts
 *
 * Merchant Intelligence — MI2 S2 decision store helpers.
 *
 * The thin, single-sourced boundary around the `MerchantMergeDecision` table:
 * derive the order-independent pair key, record a human verdict, and filter live
 * detector output by already-decided pairs. Suggestions are NEVER persisted —
 * only human DECISIONS are (DISMISSED suppresses a pair; MERGED is the audit
 * trail). No merge logic lives here (execution is mergeMerchants()); no
 * detection logic lives here (that is merchant-merge-suggest.ts). The Prisma
 * client is injected (a PrismaClient or a $transaction client) so this module is
 * reusable across the review route and unit-testable with an in-memory fake —
 * mirroring merchant-write.ts / merchant-corrections.ts.
 */

import type { MerchantMergeVerdict, Prisma } from "@prisma/client";
import type { MergeCandidate } from "@/lib/transactions/merchant-merge-suggest";

/** A PrismaClient or a $transaction client — both satisfy this. */
export type DecisionClient = Prisma.TransactionClient;

/**
 * The order-independent pair key: the two canonicalKeys uppercased, sorted, and
 * joined with a separator unlikely to occur in a key. A dismissal is symmetric
 * ("these two are NOT the same" regardless of direction), so the suppress key
 * must not depend on which side is the survivor. Deterministic and pure.
 */
export function mergePairKey(keyA: string, keyB: string): string {
  const a = keyA.trim().toUpperCase();
  const b = keyB.trim().toUpperCase();
  return (a <= b ? [a, b] : [b, a]).join("␟"); // ␟ (unit separator symbol)
}

/** The verdict to record. Direction (survivor/absorbed) is meaningful only for MERGED. */
export interface RecordDecisionInput {
  survivorKey: string;
  absorbedKey: string;
  verdict: MerchantMergeVerdict;
  evidenceTier: string;
  evidenceSignal?: string | null;
  decidedByUserId?: string | null;
}

/**
 * Record (or idempotently re-affirm) a human decision on one pair. Upsert by
 * `pairKey` so a re-decision on the same pair overwrites rather than errors —
 * suppression must be stable, and re-merging a gone pair is a no-op the caller
 * guards. This writes ONLY the decision table; it never touches merchant records.
 */
export async function recordMergeDecision(
  client: DecisionClient,
  input: RecordDecisionInput,
): Promise<{ pairKey: string }> {
  const pairKey = mergePairKey(input.survivorKey, input.absorbedKey);
  await client.merchantMergeDecision.upsert({
    where: { pairKey },
    create: {
      pairKey,
      verdict: input.verdict,
      survivorKey: input.survivorKey,
      absorbedKey: input.absorbedKey,
      evidenceTier: input.evidenceTier,
      evidenceSignal: input.evidenceSignal ?? null,
      decidedByUserId: input.decidedByUserId ?? null,
    },
    update: {
      verdict: input.verdict,
      survivorKey: input.survivorKey,
      absorbedKey: input.absorbedKey,
      evidenceTier: input.evidenceTier,
      evidenceSignal: input.evidenceSignal ?? null,
      decidedByUserId: input.decidedByUserId ?? null,
    },
    select: { id: true },
  });
  return { pairKey };
}

/** Load the set of already-decided pair keys (any verdict). Read-only. */
export async function loadDecidedPairKeys(client: DecisionClient): Promise<Set<string>> {
  const rows = await client.merchantMergeDecision.findMany({ select: { pairKey: true } });
  return new Set(rows.map((r: { pairKey: string }) => r.pairKey));
}

/**
 * Filter detector output down to the still-PENDING candidates: any pair already
 * present in `decidedPairKeys` (dismissed — must never resurface; or merged —
 * defensively excluded) is dropped. Pure — the caller supplies the decided set.
 */
export function filterPendingCandidates(
  candidates: readonly MergeCandidate[],
  decidedPairKeys: ReadonlySet<string>,
): MergeCandidate[] {
  return candidates.filter((c) => !decidedPairKeys.has(mergePairKey(c.survivorKey, c.absorbedKey)));
}

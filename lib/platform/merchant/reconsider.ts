/**
 * lib/platform/merchant/reconsider.ts  (PB-9 — reconsider a dismissed merge candidate)
 *
 * A dismissal ("not the same") suppresses a pair from every later suggestion
 * (merchant-merge-decisions.ts filters decided pairs). Reconsidering REMOVES
 * that suppression: the DISMISSED decision row is deleted and the act is
 * recorded through the operator-action envelope with the operator's required
 * reason and a snapshot of the decision it removed — both in ONE transaction.
 * The pair returns to the review page only if the detector still proposes it;
 * nothing is merged here, and no merchant, alias, rule or transaction is
 * touched. A MERGED decision cannot be reconsidered (a merge has no undo).
 *
 * The client is injected (the route passes systemDb), like the review module.
 */

import type { PrismaClient } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction } from "@/lib/audit";
import type { MergeReviewActor } from "@/lib/transactions/merchant-merge-review";

/** The pair has no DISMISSED decision to reconsider (gone, or it was a merge). */
export class ReconsiderIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconsiderIneligibleError";
  }
}

export type ReconsiderClient = Pick<PrismaClient, "$transaction">;

export async function reconsiderDismissedPair(
  client: ReconsiderClient,
  pairKey: string,
  by: MergeReviewActor,
): Promise<{ pairKey: string; reconsidered: true }> {
  await client.$transaction(async (tx) => {
    const decision = await tx.merchantMergeDecision.findUnique({
      where: { pairKey },
      select: { id: true, verdict: true, survivorKey: true, absorbedKey: true, evidenceTier: true, evidenceSignal: true, decidedByUserId: true, createdAt: true },
    });
    if (!decision) throw new ReconsiderIneligibleError("This pair has no recorded decision; there is nothing to reconsider.");
    if (decision.verdict !== "DISMISSED") throw new ReconsiderIneligibleError("Only a dismissed pair can be reconsidered; a merge has no undo.");
    // Guarded delete: a concurrent reconsider (or a later decision) makes this a no-op that refuses.
    const { count } = await tx.merchantMergeDecision.deleteMany({ where: { id: decision.id, verdict: "DISMISSED" } });
    if (count !== 1) throw new ReconsiderIneligibleError("The decision changed meanwhile. Refresh and try again.");
    await recordOperatorAction(tx, {
      actor: by.actor,
      action: AuditAction.MERCHANT_MERGE_RECONSIDERED,
      target: { kind: "MERCHANT_PAIR", id: pairKey },
      reason: by.reason,
      result: "SUCCESS",
      detail: {
        pairKey,
        survivorKey: decision.survivorKey,
        absorbedKey: decision.absorbedKey,
        // The removed decision, so the record says exactly what was undone.
        removedDecision: {
          verdict: decision.verdict,
          evidenceTier: decision.evidenceTier,
          evidenceSignal: decision.evidenceSignal,
          decidedByUserId: decision.decidedByUserId,
          decidedAt: decision.createdAt.toISOString(),
        },
      },
      ipAddress: by.ipAddress ?? null,
      userAgent: by.userAgent ?? null,
    });
  });
  return { pairKey, reconsidered: true };
}

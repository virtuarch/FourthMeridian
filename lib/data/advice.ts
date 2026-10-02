/**
 * lib/data/advice.ts
 *
 * Server-only AI advice queries.
 * AiAdvice is now space-scoped — queries by spaceId, not userId.
 */

import { db } from "@/lib/db";
import { AiAdvice } from "@/types";

/**
 * The most recent advice record for the named space, or null if none exists yet.
 *
 * RLS-C-S1 — `scope.spaceId` is REQUIRED. The ambient space-context fallback
 * is gone: tenant identity is bound at the request boundary, and the Space is an
 * ordinary argument. The one caller (the Analyze page) already resolves it.
 */
export async function getLatestAdvice(scope: { spaceId: string }): Promise<AiAdvice | null> {
  const { spaceId } = scope;

  const row = await db.aiAdvice.findFirst({
    where:   { spaceId },
    orderBy: { generatedAt: "desc" },
  });

  if (!row) return null;

  return {
    id:          row.id,
    summary:     row.summary,
    adviceText:  row.adviceText,
    riskLevel:   row.riskLevel as AiAdvice["riskLevel"],
    actionReady: row.actionReady,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * lib/data/advice.ts
 *
 * Server-only AI advice queries.
 * AiAdvice is now space-scoped — queries by spaceId, not userId.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { AiAdvice } from "@/types";

/** The most recent advice record for the current space, or null if none exists yet. */
export async function getLatestAdvice(ctx?: { spaceId: string }): Promise<AiAdvice | null> {
  const { spaceId } = ctx ?? (await getSpaceContext());

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

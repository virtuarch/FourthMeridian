/**
 * lib/data/advice.ts
 *
 * Server-only AI advice queries.
 * AiAdvice is now workspace-scoped — queries by workspaceId, not userId.
 */

import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { AiAdvice } from "@/types";

/** The most recent advice record for the current workspace, or null if none exists yet. */
export async function getLatestAdvice(): Promise<AiAdvice | null> {
  const { workspaceId } = await getWorkspaceContext();

  const row = await db.aiAdvice.findFirst({
    where:   { workspaceId },
    orderBy: { generatedAt: "desc" },
  });

  if (!row) return null;

  return {
    id:          row.id,
    summary:     row.summary,
    adviceText:  row.adviceText,
    riskLevel:   row.riskLevel as AiAdvice["riskLevel"],
    playReady:   row.playReady,
    generatedAt: row.generatedAt.toISOString(),
  };
}

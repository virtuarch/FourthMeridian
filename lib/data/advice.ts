/**
 * lib/data/advice.ts
 *
 * Server-only AI advice queries.
 * AiAdvice is now space-scoped — queries by spaceId, not userId.
 */

import type { ReadClient } from "@/lib/db/tenant-context";
import { AiAdvice } from "@/types";

/**
 * The most recent advice record for the named space, or null if none exists yet.
 *
 * RLS-C-S1 — `scope.spaceId` is REQUIRED. The ambient space-context fallback
 * is gone: tenant identity is bound at the request boundary, and the Space is an
 * ordinary argument. The one caller (the Analyze page) already resolves it.
 *
 * RLS-C-S3 — `client` is REQUIRED and leading. AiAdvice carries a direct
 * `spaceId`, so the fm_app policy is `"spaceId" IN (SELECT fm_visible_space_ids())`
 * and on a tenant client the predicate below is enforced twice — once by this
 * query and once by the database. The redundancy is the point.
 */
export async function getLatestAdvice(
  client: ReadClient,
  scope: { spaceId: string },
): Promise<AiAdvice | null> {
  const { spaceId } = scope;

  const row = await client.aiAdvice.findFirst({
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

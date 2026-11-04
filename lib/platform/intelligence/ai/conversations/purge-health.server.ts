/**
 * lib/platform/intelligence/ai/conversations/purge-health.server.ts  (PR D — the purge-staleness AUTHORITY)
 *
 * Gathers the facts for ./purge-health.ts (the pure verdict) and is consumed by
 * the alerting engine (lib/alerts — rule `platform-ai-purge-late`, authority
 * `platform-ai-purge`) like every other health authority. READ-ONLY, and it
 * reads only the two ledgers the purge already writes:
 *   · JobRun rows of `purge-trash` (status + timestamps + the counts-only summary);
 *   · the recent PLATFORM_AI_CONVERSATIONS_PURGED AuditLog rows written by the
 *     MANUAL dispatch (trigger MANUAL_DISPATCH — every run, zero included) that
 *     did not fail (no `failed` key): createdAt + those two keys only. A
 *     scheduled run is judged by its JobRun alone (its audit row is written only
 *     when something was removed, and a failed run is a failed JobRun).
 * It never reads a conversation table (fm_system / the operator principal have
 * no business there), an id beyond the job name, or any content.
 *
 * With the conversations flag OFF it reads NOTHING and returns state OFF.
 */

import "server-only";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AuditAction } from "@/lib/audit-actions";
import {
  PLATFORM_AI_PURGE_JOB_NAME, evaluatePlatformAiPurgeHealth, isSuccessfulDispatchAudit, isSuccessfulPurgeSummary, newestOf,
  type PlatformAiPurgeHealth,
} from "./purge-health";

/** Recent succeeded purge-trash runs examined (daily job ⇒ weeks of history; the window is 36 h). */
const RUNS_EXAMINED = 30;

/** The ledger reads, injectable for the unit test. */
export interface PurgeHealthReads {
  succeededPurgeRuns(limit: number): Promise<Array<{ startedAt: Date; completedAt: Date | null; summary: unknown }>>;
  /** Recent manual-dispatch purge audit rows, newest first: createdAt + the metadata (counts / trigger / failed only). */
  recentDispatchAudits(limit: number): Promise<Array<{ createdAt: Date; metadata: unknown }>>;
}

const realReads: PurgeHealthReads = {
  succeededPurgeRuns: (limit) => db.jobRun.findMany({
    where: { jobName: PLATFORM_AI_PURGE_JOB_NAME, status: "succeeded" },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { startedAt: true, completedAt: true, summary: true },
  }),
  recentDispatchAudits: (limit) => db.auditLog.findMany({
    where: { action: AuditAction.PLATFORM_AI_CONVERSATIONS_PURGED, metadata: { path: ["trigger"], equals: "MANUAL_DISPATCH" } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { createdAt: true, metadata: true },
  }),
};

export async function getPlatformAiPurgeHealth(
  now: Date = new Date(),
  opts: { conversationsOn?: boolean; reads?: PurgeHealthReads } = {},
): Promise<PlatformAiPurgeHealth> {
  // ON = the conversations flag is set — fully enabled, OR set without the purge (misordered).
  const conversationsOn = opts.conversationsOn ?? (env.isPlatformAiConversationsEnabled || env.isPlatformAiConversationsFlagSetWithoutPurge);
  if (!conversationsOn) return evaluatePlatformAiPurgeHealth({ conversationsOn: false, lastSuccessAt: null, now });
  const reads = opts.reads ?? realReads;
  const [runs, audits] = await Promise.all([reads.succeededPurgeRuns(RUNS_EXAMINED), reads.recentDispatchAudits(RUNS_EXAMINED)]);
  const run = runs.find((r) => isSuccessfulPurgeSummary(r.summary));
  const fromRun = run ? (run.completedAt ?? run.startedAt) : null;
  const dispatch = audits.find((a) => isSuccessfulDispatchAudit(a.metadata));
  return evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: newestOf(fromRun, dispatch?.createdAt ?? null), now });
}

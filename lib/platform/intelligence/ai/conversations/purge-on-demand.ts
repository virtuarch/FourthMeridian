/**
 * lib/platform/intelligence/ai/conversations/purge-on-demand.ts  (Platform AI conversations — the ON-DEMAND purge trigger)
 *
 * The retention purge (./purge.ts) runs daily inside `purge-trash` (07:30 UTC),
 * and Preview (no crons) has the operator's manual dispatch script. This is the
 * third trigger: GET /api/jobs/dispatch?only=platform-ai-purge — CRON_SECRET
 * bearer first, exactly as every dispatch — for an environment that RUNS crons
 * (Production), so an operator can drain a backlog or prove the purge now
 * instead of waiting for the next slot. It does NOT go through the dispatcher's
 * schedule / due logic (lib/jobs/dispatch.ts): it is a direct, ledgered run.
 *
 * ⚠️ SHIPS DISABLED. Two switches, both strict `=== "true"`:
 * PLATFORM_AI_PURGE_ENABLED AND PLATFORM_AI_PURGE_ON_DEMAND_ENABLED
 * (env.isPlatformAiPurgeOnDemandEnabled). Either off ⇒ 409
 * PURGE_ON_DEMAND_DISABLED and NO database contact — no JobRun, no call, no
 * audit row. Production enablement is owner-gated.
 *
 *   · Ledgered: the purge runs inside runJob(PLATFORM_AI_PURGE_ON_DEMAND_JOB,
 *     …, { trigger: "manual" }) — its own JobRun, summary = the purge's counts
 *     { enabled, conversations, messages, batches, exhausted } (the shape of
 *     purge-trash's `retention.platformAiConversations`; an error's TEXT is never
 *     stored here — `failed: true` instead). A failed purge throws
 *     JobFailedWithSummaryError (a fixed message), so the JobRun is `failed`
 *     WITH its counts.
 *   · Audited: ON_DEMAND deps (jobs/data-retention.ts platformAiPurgeOnDemandDeps)
 *     write one counts-only AuditLog row EVERY run, zero included, tagged
 *     trigger: "ON_DEMAND" (`failed: true` on an errored run).
 *   · Bounded: one run = ≤ PLATFORM_AI_PURGE_MAX_CALLS definer calls (./purge.ts);
 *     `exhausted: false` in the response means "more remain — call again".
 *   · Answers counts only — never an error message, an id or content.
 *
 * CONCURRENCY. Two on-demand runs: the runJob claim (one `running` JobRun per
 * job name, a unique partial index) refuses the second ⇒ 409 BUSY, body not run.
 * An on-demand run beside the scheduled purge-trash (a different job name, so
 * no claim conflict): the definer function selects its rows
 * `FOR UPDATE SKIP LOCKED` (prisma/migrations/20261104120000_platform_ai_
 * conversations/migration.sql, fm_purge_platform_ai_conversations — both the
 * expired-message and the conversation SELECT), so concurrent calls lock and
 * delete DISJOINT rows: nothing is deleted twice and no count is double-counted
 * (pinned by ./purge-on-demand.test.ts).
 *
 * Pure orchestration over injected deps (like ./purge.ts): the route passes the
 * real ones; the unit test drives every branch without a database.
 */

import {
  runJob, JobAlreadyRunningError, JobFailedWithSummaryError, JobLedgerUnavailableError,
  type JobRunWriteClient,
} from "@/lib/jobs/run";
import { runPlatformAiConversationPurge, type PlatformAiPurgeDeps, type PlatformAiPurgeResult } from "./purge";
import { PLATFORM_AI_PURGE_ON_DEMAND_JOB } from "./purge-health";

export { PLATFORM_AI_PURGE_ON_DEMAND_JOB };

/** The `?only=` key on GET /api/jobs/dispatch (lib/jobs/dispatch.ts SINGLE_JOB_DISPATCH_ALLOWLIST). */
export const PLATFORM_AI_PURGE_DISPATCH_KEY = "platform-ai-purge";

/** The fixed JobRun errorSummary of a failed on-demand purge — never the underlying error text. */
export const PLATFORM_AI_PURGE_ON_DEMAND_FAILED = "platform-ai-conversations on-demand purge FAILED (counts in the summary)";

export interface PlatformAiPurgeOnDemandDeps {
  /** env.isPlatformAiPurgeOnDemandEnabled — false ⇒ 409, nothing contacted. */
  enabled: boolean;
  /** The purge seams (ON_DEMAND), built only inside the ledgered body. */
  purgeDeps(): Promise<PlatformAiPurgeDeps>;
  /** Test injection seam for runJob's ledger — production never passes it. */
  jobRunClient?: JobRunWriteClient;
}

/** The JobRun summary: counts only. */
export interface PlatformAiPurgeOnDemandSummary {
  enabled: boolean;
  conversations: number;
  messages: number;
  batches: number;
  exhausted: boolean;
  failed?: true;
}

type Counts = { conversations: number; messages: number; batches: number; exhausted: boolean };

export type PlatformAiPurgeOnDemandBody =
  | ({ ok: true } & Counts)
  | ({ ok: false; code: "PURGE_FAILED" } & Counts)
  | { ok: false; code: "PURGE_ON_DEMAND_DISABLED" | "BUSY" | "LEDGER_UNAVAILABLE" };

export interface PlatformAiPurgeOnDemandResponse {
  status: 200 | 409 | 500 | 503;
  body: PlatformAiPurgeOnDemandBody;
}

const countsOf = (s: Pick<PlatformAiPurgeOnDemandSummary, keyof Counts>): Counts =>
  ({ conversations: s.conversations, messages: s.messages, batches: s.batches, exhausted: s.exhausted });

function summaryOf(r: PlatformAiPurgeResult, failed: boolean): PlatformAiPurgeOnDemandSummary {
  return { enabled: r.enabled, ...countsOf(r), ...(failed ? { failed: true as const } : {}) };
}

export async function runPlatformAiPurgeOnDemand(deps: PlatformAiPurgeOnDemandDeps): Promise<PlatformAiPurgeOnDemandResponse> {
  if (!deps.enabled) return { status: 409, body: { ok: false, code: "PURGE_ON_DEMAND_DISABLED" } };
  try {
    const summary = await runJob(PLATFORM_AI_PURGE_ON_DEMAND_JOB, async (): Promise<PlatformAiPurgeOnDemandSummary> => {
      const r = await runPlatformAiConversationPurge(await deps.purgeDeps());
      // Errored part-way, or (defence in depth — both flags were just checked) the
      // purge read itself as disabled / misordered: a FAILED JobRun, counts kept.
      const failed = r.error !== undefined || !r.enabled || r.misordered === true;
      const s = summaryOf(r, failed);
      if (failed) throw new JobFailedWithSummaryError(PLATFORM_AI_PURGE_ON_DEMAND_FAILED, s);
      return s;
    }, { trigger: "manual", ...(deps.jobRunClient ? { client: deps.jobRunClient } : {}) });
    return { status: 200, body: { ok: true, ...countsOf(summary) } };
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) return { status: 409, body: { ok: false, code: "BUSY" } };
    if (err instanceof JobLedgerUnavailableError) return { status: 503, body: { ok: false, code: "LEDGER_UNAVAILABLE" } };
    if (err instanceof JobFailedWithSummaryError) {
      return { status: 500, body: { ok: false, code: "PURGE_FAILED", ...countsOf(err.summary as PlatformAiPurgeOnDemandSummary) } };
    }
    throw err;
  }
}

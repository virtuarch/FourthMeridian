/**
 * lib/platform/ops/overview.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The operations OVERVIEW: one read that composes the existing authorities —
 * never a second one — into per-domain verdicts (overview-core.ts):
 *
 *   refresh pipeline   getPipelineStatus         (RefreshExecution projection)
 *   sources            getConnectionHealth        (PlaidItem / Connection + policy)
 *   scheduled jobs     checkScheduledJobHealth    (JobRun ledger vs registry)
 *   Daily Brief        getBriefOps                (DailyBrief ⨝ AiInvocation)
 *   AI invocations     getAiOperations            (AiInvocation ⨝ rate card)
 *   Plaid              getPlaidUsage              (PlaidItem census ⨝ rates)
 *   policies           loadRefreshPolicies        (PlatformSetting)
 *
 * UX-P1 — the four Platform Health groups fold into the same read as a POSTURE
 * row (overview-core.ts derivePosture), so the status board is ONE request:
 *
 *   alerts             loadLatestAlertEvaluation  (latest evaluate-alerts run — firing NOW,
 *                                                  never the delivery history; OBS-001:
 *                                                  age-gated against the evaluator's cadence)
 *   providers          getProviderHealth          (handed the SAME freshness and connection
 *                                                  reads above, so nothing is read twice)
 *   freshness          checkResourceFreshness     (stored data, never a job's exit status)
 *   configuration      getEnvReport               (names and verdicts, never values)
 *
 * Each posture authority is BEST-EFFORT: a loader that throws yields a chip in
 * the `unavailable` state — the board says it could not ask, never zero and
 * never fine — while the six domain verdicts still render.
 *
 * The refresh policies are loaded ONCE and handed to every consumer that
 * judges against them, so the overview cannot disagree with itself.
 *
 * BOUNDED: each authority reads its own bounded window (the pipeline since
 * yesterday 00:00 UTC; AI and Brief the last 24 h; 50 JobRun rows per job).
 * No provider is called. The overview is a read of persisted truth.
 */

import "server-only";
import { db } from "@/lib/db";
import { todayUTCISO } from "@/lib/time/clock";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import { getPipelineStatus } from "@/lib/platform/refresh/projections";
import { getConnectionHealth } from "@/lib/connections/health";
import { checkScheduledJobHealth } from "@/lib/jobs/health";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { deriveNextDueFromLedger } from "@/lib/platform/scheduler/observation";
import { getAiOperations } from "@/lib/platform/ai/invocations";
import { getBriefOps } from "@/lib/platform/ai/brief-ops";
import { getPlaidUsage } from "@/lib/platform/plaid/usage";
import { getProviderHealth } from "@/lib/platform/provider-health";
import { checkResourceFreshness } from "@/lib/platform/resource-freshness";
import { getEnvReport } from "@/lib/env";
import { ALERT_JOB_NAME, loadLatestAlertEvaluation } from "@/lib/alerts/run";
import { ALERT_RULES } from "@/lib/alerts/rules";
import {
  buildOverview,
  derivePosture,
  type DomainStatus,
  type JobHealthCounts,
  type OverviewCore,
  type PostureChip,
} from "@/lib/platform/ops/overview-core";
import type { ExecutionRowDTO } from "@/lib/platform/refresh/execution-query-core";
import { projectExecutionRow } from "@/lib/platform/refresh/execution-query-core";

export interface OperationsOverview extends OverviewCore {
  checkedAt: string;
  windows: { pipeline: string; ai: string; brief: string };
  /** The newest failed / partial executions since yesterday — the drill-down
   *  from "something is wrong" to "this exact execution". */
  latestFailures: readonly ExecutionRowDTO[];
  nextSlotAt: string | null;
  /** UX-P1 — Alerts · Providers · Freshness · Configuration, in that order. */
  posture: readonly PostureChip[];
}

/** A best-effort read: the value, or null when the authority could not be asked. */
async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    console.warn(`[overview] posture authority "${what}" could not be read (non-fatal):`, e);
    return null;
  }
}

function minusDays(dayISO: string, days: number): string {
  const d = new Date(`${dayISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getOperationsOverview(now: Date = new Date()): Promise<OperationsOverview> {
  const policies = await loadRefreshPolicies(db);
  const today = todayUTCISO(now);
  const yesterday = minusDays(today, 1);

  // The connection read is shared with the provider roll-up below (one read).
  const sourcesP = getConnectionHealth(20, policies);
  const freshnessP = attempt("resource-freshness", () => checkResourceFreshness(undefined, now));

  const [pipeline, sources, jobHealth, ai, brief, plaid, freshness, providers, alerts] = await Promise.all([
    getPipelineStatus({ from: yesterday, to: today }),
    sourcesP,
    checkScheduledJobHealth(undefined, now, SCHEDULED_JOBS, { policies }),
    getAiOperations({ window: "24h" }),
    getBriefOps("24h"),
    getPlaidUsage(),
    freshnessP,
    attempt("provider-health", async () => {
      const fresh = await freshnessP;
      if (!fresh) throw new Error("freshness unavailable");
      return getProviderHealth({ now, loadFreshness: () => Promise.resolve(fresh), loadConnections: () => sourcesP });
    }),
    attempt("alerts", async () => ({ latest: await loadLatestAlertEvaluation(), rulesRegistered: ALERT_RULES.length })),
  ]);
  // OBS-001 — the evaluator's RESOLVED cadence, from the job-health read already
  // made above (the dispatcher's own number), so the age gate on the Alerts chip
  // judges against what the platform actually executes by.
  const alertsWithCadence = alerts
    ? { ...alerts, cadenceHours: jobHealth.jobs.find((j) => j.job === ALERT_JOB_NAME)?.expectedEveryHours ?? null }
    : null;
  const configuration = attemptSync("env-report", getEnvReport);

  const jobs: JobHealthCounts = { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 };
  for (const j of jobHealth.jobs) {
    if (j.status === "healthy") jobs.healthy++;
    else if (j.status === "running") jobs.running++;
    else if (j.status === "overdue") jobs.overdue++;
    else if (j.status === "failing") jobs.failing++;
    else if (j.status === "dead") jobs.dead++;
    else if (j.status === "never-ran") jobs.neverRan++;
  }
  // P1 — the next DUE instant from the ledger and the execution cadence policy
  // (there are no registry slots left to read a "next slot" from).
  const nextSlot = (await deriveNextDueFromLedger(now, SCHEDULED_JOBS)).at;
  const currentCycle = plaid.cycles[0];

  const core = buildOverview(
    {
      pipeline,
      pipelineWindowLabel: "window since yesterday (UTC)",
      sources,
      jobs,
      ai: {
        invocations: ai.totals.invocations, usd: ai.totals.usd, unpricedTokens: ai.totals.unpricedTokens,
        cacheShare: ai.totals.cacheShare, windowLabel: "last 24 h",
        failures: { failed: ai.failures.failed, timeouts: ai.failures.timeouts, rateLimited: ai.failures.rateLimited, quota: ai.failures.quota },
      },
      brief: {
        windowLabel: "last 24 h",
        generated: brief.counts.generated, failed: brief.counts.failed, inProgress: brief.counts.inProgress,
        versionStale: brief.counts.versionStale, usd: brief.economics.correlated.usd,
        uncorrelatedGenerations: brief.economics.uncorrelatedGenerations,
      },
      plaid: {
        billableItems: plaid.population.billable,
        byStatus: plaid.population.byStatus,
        currentCycle: {
          transactions: currentCycle.during.itemMonths.transactions,
          investments: currentCycle.during.itemMonths.investments,
          usd: currentCycle.during.usd,
          agree: currentCycle.agree,
          label: currentCycle.label,
        },
        priceConfigured: plaid.priceAuthority.configured,
      },
      policies,
    },
    nextSlot ? nextSlot.toISOString() : null,
    now,
  );

  return {
    ...core,
    checkedAt: now.toISOString(),
    windows: { pipeline: `${yesterday} .. ${today} (UTC)`, ai: "24h", brief: "24h" },
    latestFailures: pipeline.latestFailures.map((f) => projectExecutionRow(f, "operator")),
    nextSlotAt: nextSlot ? nextSlot.toISOString() : null,
    posture: derivePosture({ alerts: alertsWithCadence, providers, freshness, configuration }, now),
  };
}

function attemptSync<T>(what: string, read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    console.warn(`[overview] posture authority "${what}" could not be read (non-fatal):`, e);
    return null;
  }
}

export type { DomainStatus };

/**
 * lib/platform/ops/attention.ts  (UX-P1 · Agent 2)
 *
 * The ATTENTION read: one request that asks six EXISTING authorities what is
 * wrong right now and composes their verdicts (attention-core.ts) into one
 * ranked list. It reads no table itself — this file imports no database
 * client — so it cannot become a seventh authority or widen any read.
 *
 *   connections   getConnectionHealth        (cap 20 — reported as a floor)
 *   jobs          checkScheduledJobHealth    (JobRun ledger vs registry)
 *   providers     getProviderHealth          (handed the SAME freshness + connection reads)
 *   resources     checkResourceFreshness     (stored data)
 *   alerts        loadLatestAlertEvaluation  (firing NOW) + loadRecentAlertRuns (history, kept apart)
 *   incidents     incidentAccessors.brokenNow (Ops tier, module order; PB-1 R6a) → D5 projection,
 *                 subjects named for the shown slice (resolveSubjects),
 *                 + getIncidentDetail for the correlated few, to name an execution as evidence
 *   policy-assignments loadPolicyAssignmentHealth (missing / invalid customer policy-group
 *                 assignments, capped 25 + exact counts; opaque customer reference only)
 *
 * BEST-EFFORT PER AUTHORITY. A reader that throws contributes no rows and is
 * NAMED in `authoritiesFailed`; the others still answer. Absence of rows from a
 * failed reader is never read as "nothing wrong" — the response says how many
 * authorities actually answered, and the empty state repeats it.
 *
 * TWO CLOCKS. `items` may contain an alert rule only if it breached in the
 * LATEST evaluation. `recentFirings` is the delivery history across the retained
 * runs and is returned as its own field so no consumer can fold it into the
 * active list.
 */

import "server-only";
import { getConnectionHealth } from "@/lib/connections/health";
import { checkScheduledJobHealth } from "@/lib/jobs/health";
import { getProviderHealth } from "@/lib/platform/provider-health";
import { checkResourceFreshness } from "@/lib/platform/resource-freshness";
import { loadLatestAlertEvaluation, loadRecentAlertRuns } from "@/lib/alerts/run";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { collectAlertHistory, type AlertFiredRecord } from "@/lib/alerts/evaluate";
import { resolveSubjects } from "@/lib/platform/incidents/preview";
import { incidentAccessors, type OpsToken } from "@/lib/platform/incidents/intelligence";
import { getIncidentDetail } from "@/lib/platform/incidents/projections";
import { projectVerdictForPlatform, type PlatformIncidentProjection } from "@/lib/platform/incidents/platform-projection";
import {
  ATTENTION_AUTHORITIES,
  USER_IMPACT_WINDOW_HOURS,
  buildAttention,
  buildUserImpact,
  type AttentionAuthority,
  type AttentionCore,
  type AttentionInputs,
  type AttentionItem,
  type UserImpactAuthority,
  type UserImpactCore,
} from "@/lib/platform/ops/attention-core";
// BETA V1 — the three user-impact readers. Seams and readers only: this file
// still imports no database client and touches no ledger accessor.
import { queryRefreshExecutions } from "@/lib/platform/refresh/execution-query";
import { getAiFailureHealth } from "@/lib/platform/ai/failures";
import { getBriefOps } from "@/lib/platform/ai/brief-ops";
// Owner ruling (2026-10-30) — the policy-assignment authority (its own bounded,
// read-only fm_system read; this file still imports no database client).
import { loadPolicyAssignmentHealth } from "@/lib/platform/policy-assignment-health";

/** Broken-now incidents shown. More than the preview's six; still a floor when exceeded. */
export const ATTENTION_INCIDENT_LIMIT = 20;
/** Open SyncIssue rows the module scans for the broken-now page (the preview's scan; `truncated` past it). */
const ATTENTION_INCIDENT_SCAN = 200;
/** How many correlated incidents get a detail read to name their execution. */
const INCIDENT_EVIDENCE_LOOKUPS = 10;
/** Delivery-history rows returned (the retained runs hold at most ~10 cycles). */
const RECENT_FIRINGS_CAP = 10;
/** BETA V1 — FAILED/PARTIAL executions asked of the seam for the 24 h window; a further page is a floor. */
export const USER_IMPACT_EXECUTIONS_LIMIT = 50;

export interface AttentionRecentFirings {
  /** How many evaluation runs the history was collected from. */
  runs: number;
  /** The evaluation window those runs span (newest → oldest), or null when none. */
  newestEvaluatedAt: string | null;
  oldestEvaluatedAt: string | null;
  count: number;
  items: AlertFiredRecord[];
}

export interface AttentionResponse {
  checkedAt: string;
  items: readonly AttentionItem[];
  counts: AttentionCore["counts"];
  authoritiesChecked: { count: number; names: AttentionAuthority[] };
  authoritiesFailed: AttentionAuthority[];
  /** Every reader that returned a floor rather than a total, in words. */
  floors: string[];
  /** HISTORICAL — never mixed into `items`. */
  recentFirings: AttentionRecentFirings;
  /** BETA V1 — failures that reached a customer in the last 24 h, a separate composition (attention-core.ts). */
  userImpact: UserImpactCore;
}

async function attempt<T>(what: AttentionAuthority | UserImpactAuthority | "alert-history", read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    console.warn(`[attention] authority "${what}" could not be read (non-fatal):`, e);
    return null;
  }
}

/**
 * PB-1 R6a — broken-now incidents straight from the incident-intelligence module
 * (Ops-tier token the ROUTE minted with atOpsTier), in the module's own order
 * (attentionPriority, then recency, then id). No projection view, no `state`
 * filter, no referent rule here: D1 / D2 / D2b / D10 are the module's. Subjects
 * are named for the shown slice only; an execution is named where one is
 * correlated. `truncated` is the module's D5 flag.
 */
async function readIncidents(token: OpsToken): Promise<NonNullable<AttentionInputs["incidents"]>> {
  const page = await incidentAccessors.brokenNow(token, { limit: ATTENTION_INCIDENT_SCAN });
  const shown = page.items.slice(0, ATTENTION_INCIDENT_LIMIT);
  const subjects = await resolveSubjects(shown);
  const lookups = shown.filter((v) => v.correlatedOccurrenceCount > 0).slice(0, INCIDENT_EVIDENCE_LOOKUPS);
  const executionById = new Map<string, string | null>();
  await Promise.all(
    lookups.map(async (v) => {
      const detail = await getIncidentDetail(v.id).catch(() => null);
      const newest = detail?.occurrences.find((o) => o.refreshExecutionId != null);
      executionById.set(v.id, newest?.refreshExecutionId ?? null);
    }),
  );
  const items: PlatformIncidentProjection[] = shown.map((v) =>
    projectVerdictForPlatform(v, subjects.get(v.id) ?? { primary: null, secondary: null }, executionById.get(v.id) ?? null));
  return { items, activeTotal: page.items.length, truncated: page.truncated };
}

export async function getAttention(
  /** PB-1 R4 — the Ops-tier incident token the ROUTE minted (atOpsTier) from its own guard result. */
  incidentToken: OpsToken,
  now: Date = new Date(),
): Promise<AttentionResponse> {
  const connectionsP = attempt("connection-health", () => getConnectionHealth(20));
  const freshnessP = attempt("resource-freshness", () => checkResourceFreshness(undefined, now));

  const impactSince = new Date(now.getTime() - USER_IMPACT_WINDOW_HOURS * 3_600_000);
  const [connections, jobs, resources, providers, alerts, incidents, history, impactRefresh, impactAi, impactBrief, policyAssignments] = await Promise.all([
    connectionsP,
    attempt("job-health", () => checkScheduledJobHealth(undefined, now)),
    freshnessP,
    attempt("provider-health", async () => {
      const [fresh, conn] = await Promise.all([freshnessP, connectionsP]);
      if (!fresh || !conn) throw new Error("freshness or connection health unavailable");
      return getProviderHealth({ now, loadFreshness: () => Promise.resolve(fresh), loadConnections: () => Promise.resolve(conn) });
    }),
    attempt("alert-evaluation", async () => ({
      latest: await loadLatestAlertEvaluation(),
      titles: Object.fromEntries(ALERT_RULES.map((r) => [r.id, r.title])),
    })),
    attempt("incidents", () => readIncidents(incidentToken)),
    attempt("alert-history", () => loadRecentAlertRuns()),
    // BETA V1 — user-impact readers, each best-effort and named when it fails.
    attempt("refresh-executions", async () => {
      const page = await queryRefreshExecutions({ audience: "operator", filter: { overallStatus: ["FAILED", "PARTIAL"], since: impactSince }, limit: USER_IMPACT_EXECUTIONS_LIMIT });
      return { rows: page.rows, more: page.nextCursor !== null };
    }),
    attempt("ai-failures", () => getAiFailureHealth(USER_IMPACT_WINDOW_HOURS, now)),
    attempt("brief-ops", async () => {
      const ops = await getBriefOps("24h");
      return { counts: ops.counts, rows: ops.rows };
    }),
    attempt("policy-assignments", () => loadPolicyAssignmentHealth({ now })),
  ]);

  const core = buildAttention(
    {
      connections,
      jobs: jobs
        ? {
            jobs: jobs.jobs.map((j) => ({
              job: j.job, status: j.status, expectedEveryHours: j.expectedEveryHours, consecutiveFailures: j.consecutiveFailures,
              lastStartedAt: j.lastStartedAt?.toISOString() ?? null,
              lastFailureAt: j.lastFailureAt?.toISOString() ?? null,
              lastFailureSummary: j.lastFailureSummary,
            })),
          }
        : null,
      providers,
      resources,
      alerts,
      incidents,
      policyAssignments,
    },
    now,
  );

  const userImpact = buildUserImpact({ refresh: impactRefresh, ai: impactAi, brief: impactBrief, connections }, now);

  const runs = history ?? [];
  const fired = collectAlertHistory(runs, RECENT_FIRINGS_CAP);
  return {
    checkedAt: now.toISOString(),
    items: core.items,
    counts: core.counts,
    authoritiesChecked: { count: core.authorities.checked.length, names: core.authorities.checked },
    authoritiesFailed: ATTENTION_AUTHORITIES.filter((a) => core.authorities.failed.includes(a)),
    floors: core.floors,
    recentFirings: {
      runs: runs.length,
      newestEvaluatedAt: runs[0]?.evaluatedAtISO ?? null,
      oldestEvaluatedAt: runs.at(-1)?.evaluatedAtISO ?? null,
      count: fired.length,
      items: fired,
    },
    userImpact,
  };
}

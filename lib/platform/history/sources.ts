/**
 * lib/platform/history/sources.ts  (OPS-5 S7)
 *
 * THE registry of operational-history SOURCES. Each source reads ONE existing
 * append-only ledger and REUSES that subsystem's OWN live engine at the as-of
 * point — never a second interpretation. Adding a historical subsystem = adding
 * one descriptor here; the authority (history.ts) and every consumer are
 * unchanged. This mirrors SCHEDULED_JOBS / RESOURCE_FRESHNESS / PROVIDER_SPECS.
 *
 * Reuse map (no duplication):
 *   jobs        JobRun ledger        → classifyJobHealth (OPS-4/S2) at as-of
 *   operations  JobRun trigger="manual" (observed rows — S4's ledger citizens)
 *   alerts      evaluate-alerts JobRun summaries (S5's alert store — observed)
 *   freshness   FxRate archive       → classifyResourceFreshness (S1) at as-of
 *
 * PROVIDER EVOLUTION (mission example) is deliberately NOT a separate source: it
 * is composable from `jobs` (the provider's producing job) + `freshness` (its
 * archive), and re-deriving provider TRUST here would be a forbidden "second
 * provider-health model". A first-class provider-trust-as-of reuses S3's
 * deriveProviderTrust once connection-state history exists (documented, not faked).
 *
 * PURE + INJECTABLE: sources read through the injected `HistoryReaders`, so the
 * whole authority unit-tests with in-memory fakes (the house pattern).
 */

import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { classifyJobHealth, type JobRunHealthRow, type JobHealthStatus } from "@/lib/jobs/health";
import { classifyResourceFreshness, RESOURCE_FRESHNESS, type RefreshLedgerFacts } from "@/lib/platform/resource-freshness";
import { SUPPORTED_QUOTES } from "@/lib/fx/config";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";
import type { OperationalAsOfState, OperationalHistorySeries, OperationalHistoryPoint, OperationalTier } from "@/lib/platform/history/types";

const NO_LEDGER: RefreshLedgerFacts = { lastAttemptedAt: null, lastAttemptStatus: null, lastSuccessfulAt: null };

/** Cap on points returned per series (a chart buckets them; this bounds the read). */
const MAX_POINTS = 500;

// ── Injected reads (the ONLY I/O boundary; real impls in history.ts) ────────────

/** One JobRun row as history reads it (superset of JobRunHealthRow, reuse-safe). */
export interface HistoryJobRun {
  jobName: string;
  startedAt: Date;
  status: string;
  completedAt: Date | null;
  durationMs: number | null;
  trigger: string | null;
  errorSummary: string | null;
}

/** One FX archive-coverage fact (a stored closed-day date + when it was fetched). */
export interface FxCoverageRow {
  /** The archive date (YYYY-MM-DD). */
  dateISO: string;
  /** When that date's rows were first stored (the "freshness advanced" moment). */
  fetchedAt: Date;
  /** Supported quotes present on that date. */
  observedUnits: number;
}

export interface HistoryReaders {
  now: Date;
  /** All JobRun rows started in [from, to] (any job, any trigger). */
  jobRunsInWindow(from: Date, to: Date): Promise<HistoryJobRun[]>;
  /** Newest-first JobRun rows for one job started at or before `asOf` (take N). */
  jobRunsAsOf(jobName: string, asOf: Date, take: number): Promise<HistoryJobRun[]>;
  /** Recent evaluate-alerts JobRun summaries (S5's alert store), newest first. */
  alertRuns(limit: number): Promise<AlertRunSummary[]>;
  /** FX archive coverage rows whose fetchedAt is in [from, to]. */
  fxCoverageInWindow(from: Date, to: Date): Promise<FxCoverageRow[]>;
  /** Newest FX archive date at or before `asOf`, with its observed unit count. */
  fxNewestAsOf(asOf: Date): Promise<{ dateISO: string; observedUnits: number } | null>;
}

/** The trend window. */
export interface OperationalWindow {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

/** A registered history source. */
export interface OperationalHistorySource {
  id: string;
  label: string;
  readSeries(readers: HistoryReaders, window: OperationalWindow): Promise<OperationalHistorySeries[]>;
  readAsOf(readers: HistoryReaders, at: string): Promise<OperationalAsOfState>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function worstTier(tiers: readonly OperationalTier[]): OperationalTier {
  const order: OperationalTier[] = ["observed", "derived", "estimated", "incomplete", "unknown"];
  let worst: OperationalTier = "observed";
  for (const t of tiers) if (order.indexOf(t) > order.indexOf(worst)) worst = t;
  return worst;
}
function endOfDay(dateISO: string): Date {
  return new Date(`${dateISO}T23:59:59.999Z`);
}
function toHealthRow(r: HistoryJobRun): JobRunHealthRow {
  return { startedAt: r.startedAt, status: r.status, completedAt: r.completedAt, durationMs: r.durationMs, trigger: r.trigger, errorSummary: r.errorSummary };
}

// ── jobs — JobRun executions + job health at as-of (reuses classifyJobHealth) ───

const jobsSource: OperationalHistorySource = {
  id: "jobs",
  label: "Job Executions",
  async readSeries(readers, window) {
    const runs = await readers.jobRunsInWindow(new Date(`${window.from}T00:00:00.000Z`), endOfDay(window.to));
    const exec: OperationalHistoryPoint[] = runs
      .slice(0, MAX_POINTS)
      .map((r) => ({ at: r.startedAt.toISOString(), tier: "observed", label: `${r.jobName}:${r.status}`, value: r.durationMs }));
    const latency: OperationalHistoryPoint[] = runs
      .filter((r) => r.durationMs != null)
      .slice(0, MAX_POINTS)
      .map((r) => ({ at: r.startedAt.toISOString(), tier: "observed", label: r.jobName, value: r.durationMs }));
    return [
      { sourceId: "jobs", label: "Executions", metric: "execution", unit: "count", points: exec, trust: "observed", coverageFrom: window.from },
      { sourceId: "jobs", label: "Runtime", metric: "latency", unit: "ms", points: latency, trust: "observed", coverageFrom: window.from },
    ];
  },
  async readAsOf(readers, at) {
    const asOf = endOfDay(at);
    // Reuse the LIVE dead-job detector at the as-of point: classify each registered
    // job over the runs that existed as-of `at`. Observed rows → derived verdict.
    let healthy = 0, unhealthy = 0, anyObserved = false;
    const worst: JobHealthStatus[] = [];
    for (const job of SCHEDULED_JOBS) {
      const runs = await readers.jobRunsAsOf(job.name, asOf, 10);
      if (runs.length > 0) anyObserved = true;
      const report = classifyJobHealth(job, runs.map(toHealthRow), asOf);
      if (report.status === "healthy") healthy++;
      else if (report.status !== "never-ran") { unhealthy++; worst.push(report.status); }
    }
    const tier: OperationalTier = anyObserved ? "derived" : "unknown";
    return {
      sourceId: "jobs", label: "Job Health", at,
      tier,
      status: unhealthy > 0 ? "unhealthy" : anyObserved ? "healthy" : "unknown",
      summary: anyObserved ? `${healthy} healthy, ${unhealthy} unhealthy of ${SCHEDULED_JOBS.length} jobs` : "no job runs recorded as of this date",
      value: unhealthy,
    };
  },
};

// ── operations — manual runs (observed JobRun trigger="manual" rows) ────────────

const operationsSource: OperationalHistorySource = {
  id: "operations",
  label: "Manual Operations",
  async readSeries(readers, window) {
    const runs = (await readers.jobRunsInWindow(new Date(`${window.from}T00:00:00.000Z`), endOfDay(window.to)))
      .filter((r) => r.trigger === "manual");
    const points: OperationalHistoryPoint[] = runs.slice(0, MAX_POINTS).map((r) => ({
      at: r.startedAt.toISOString(), tier: "observed", label: `${r.jobName}:${r.status}`, value: r.durationMs,
    }));
    return [{ sourceId: "operations", label: "Manual Runs", metric: "operations", unit: "count", points, trust: "observed", coverageFrom: window.from }];
  },
  async readAsOf(readers, at) {
    // Manual runs are per-job; surface the most recent manual run as-of across all jobs.
    const asOf = endOfDay(at);
    let latest: HistoryJobRun | null = null;
    for (const job of SCHEDULED_JOBS) {
      const runs = await readers.jobRunsAsOf(job.name, asOf, 10);
      for (const r of runs) if (r.trigger === "manual" && (!latest || r.startedAt > latest.startedAt)) latest = r;
    }
    return {
      sourceId: "operations", label: "Manual Operations", at,
      tier: latest ? "observed" : "unknown",
      status: latest ? latest.status : "none",
      summary: latest ? `last manual run: ${latest.jobName} (${latest.status})` : "no manual run recorded as of this date",
      value: null,
    };
  },
};

// ── alerts — evaluate-alerts JobRun summaries (S5's alert store, observed) ───────

const alertsSource: OperationalHistorySource = {
  id: "alerts",
  label: "Alerts",
  async readSeries(readers, window) {
    const from = `${window.from}T00:00:00.000Z`, to = endOfDay(window.to).toISOString();
    const runs = await readers.alertRuns(200);
    const points: OperationalHistoryPoint[] = [];
    for (const run of runs) {
      for (const f of run.fired) {
        if (f.deliveredAtISO >= from && f.deliveredAtISO <= to) {
          points.push({ at: f.deliveredAtISO, tier: "observed", label: `${f.ruleId}:${f.severity}`, value: 1 });
        }
      }
    }
    points.sort((a, b) => a.at.localeCompare(b.at));
    return [{ sourceId: "alerts", label: "Alert Firings", metric: "alerts", unit: "count", points: points.slice(0, MAX_POINTS), trust: "observed", coverageFrom: window.from }];
  },
  async readAsOf(readers, at) {
    const asOfISO = endOfDay(at).toISOString();
    const runs = await readers.alertRuns(200);
    // The most recent evaluation at or before `at` (HIST-1 nearest-≤ primitive over
    // the ISO-comparable evaluatedAt; always-replace tie-break = latest wins).
    const prior = nearestOnOrBefore(runs, asOfISO, (r) => r.evaluatedAtISO, { preferOnTie: () => true });
    return {
      sourceId: "alerts", label: "Alerts", at,
      tier: prior ? "observed" : "unknown",
      status: prior ? (prior.counts.firing > 0 ? "firing" : "clear") : "unknown",
      summary: prior ? `${prior.counts.firing} firing, ${prior.counts.delivered} delivered at last evaluation` : "no alert evaluation recorded as of this date",
      value: prior ? prior.counts.firing : null,
    };
  },
};

// ── freshness — FX archive coverage + freshness at as-of (reuses S1 classifier) ─

const fxDescriptor = RESOURCE_FRESHNESS.find((d) => d.id === "fx-rates")!;

const freshnessSource: OperationalHistorySource = {
  id: "freshness",
  label: "Resource Freshness",
  async readSeries(readers, window) {
    const rows = await readers.fxCoverageInWindow(new Date(`${window.from}T00:00:00.000Z`), endOfDay(window.to));
    // Each stored archive date is an OBSERVED freshness advance. value = the archive's
    // newest-date age (days) at the moment it was fetched.
    const points: OperationalHistoryPoint[] = rows.slice(0, MAX_POINTS).map((r) => {
      const ageDays = Math.max(0, Math.round((r.fetchedAt.getTime() - Date.parse(`${r.dateISO}T00:00:00.000Z`)) / 86_400_000));
      return { at: r.fetchedAt.toISOString(), tier: "observed", label: "fx archive advanced", value: ageDays, detail: r.dateISO };
    });
    return [{ sourceId: "freshness", label: "FX Archive Coverage", metric: "freshness", unit: "days", points, trust: "observed", coverageFrom: window.from }];
  },
  async readAsOf(readers, at) {
    // Reconstruct the freshness OBSERVATION as-of `at` (newest archive date ≤ at via
    // the HIST-1 nearest-≤ primitive), then feed S1's LIVE classifier — same model,
    // as-of input. Security prices are position-history-dependent (HIST-1 domain) and
    // are honestly reported as unknown here, not re-modelled.
    const newest = await readers.fxNewestAsOf(endOfDay(at));
    const obs = {
      newestObservedDate: newest ? new Date(`${newest.dateISO}T00:00:00.000Z`) : null,
      expectedUnits: SUPPORTED_QUOTES.length,
      observedUnits: newest ? newest.observedUnits : 0,
    };
    const report = classifyResourceFreshness(fxDescriptor, obs, NO_LEDGER, endOfDay(at));
    return {
      sourceId: "freshness", label: "Resource Freshness", at,
      tier: newest ? "derived" : "unknown",
      status: report.healthState,
      summary: newest ? `FX archive ${report.healthState} — newest ${newest.dateISO} (${report.ageDays ?? "?"}d old)` : "no FX archive data as of this date",
      value: report.ageDays,
    };
  },
};

// ── The registry ─────────────────────────────────────────────────────────────────

export const OPERATIONAL_HISTORY_SOURCES: readonly OperationalHistorySource[] = [
  jobsSource, operationsSource, alertsSource, freshnessSource,
];

export { worstTier };

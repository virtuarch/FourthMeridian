/**
 * lib/platform/provider-health.ts  (OPS-5 S3 — Provider Health)
 *
 * THE canonical ProviderHealth read-model — the answer to "treat every EXTERNAL
 * PROVIDER as a first-class operational resource, and tell me how healthy each
 * one is." This is PROVIDER health, deliberately NOT job health: a job is one
 * input signal among several, and a provider outlives, precedes, and is broader
 * than any single job that happens to call it.
 *
 * ── Separation of authorities (the whole design) ─────────────────────────────
 * Provider health is a SYNTHESIS over authorities that already exist. It creates
 * NO new table, performs NO write, and — critically — invents NO new freshness
 * model. Each field is sourced from the module that already owns that truth:
 *
 *   availability / last success / last failure / latency / error rate /
 *   sync failures          ← the JobRun ledger (OPS-4) via a windowed read.
 *   calls today / 30d       ← ApiUsageCounter (Wave 2 S7, lib/usage/record.ts).
 *   freshness               ← CONSUMED, never recomputed:
 *                               · archive providers (OXR → "fx-rates") take the
 *                                 canonical ResourceFreshnessReport straight from
 *                                 lib/platform/resource-freshness.ts (OPS-5 S1).
 *                               · sync providers (Plaid) take their recency from
 *                                 lib/connections/health.ts (the connection
 *                                 authority) — the SAME derived STALE state its
 *                                 own widget shows.
 *   coverage                ← S1's completeness frontier (currency pairs priced),
 *                               or the connection authority for sync providers.
 *   quota / remaining quota ← honestly null today: neither Plaid nor OXR exposes
 *                               a quota figure in any fact this app persists. The
 *                               fields exist (the brief enumerates them) and are
 *                               structurally ready; OXR's GET /api/usage.json is
 *                               the documented, uncalled path to populate them
 *                               (see the completion report). Null + a caveat is
 *                               the honest-signal house idiom (estimatedSpendUsd).
 *   trust                   ← a derived roll-up (this module's ONLY judgement):
 *                               content OR execution, whichever is worse.
 *
 * "Do NOT invent another freshness model" (OPS-5 S3 brief, Architecture): honored
 * structurally — this module imports freshness, it never derives staleness. The
 * one place freshness semantics live is S1; the one place connection recency
 * lives is lib/connections/health.ts. Provider health only maps and rolls up.
 *
 * ── One reusable synthesis, N providers ──────────────────────────────────────
 * The rule lives once, in the pure buildProviderHealth() + deriveProviderTrust().
 * Each provider contributes a thin PROVIDER spec (its producing job, its usage
 * key, and WHICH freshness authority feeds it). Adding a provider (a price
 * vendor, a wallet/exchange provider, a CSV importer) = adding one spec. This
 * mirrors SCHEDULED_JOBS + classifyJobHealth and RESOURCE_FRESHNESS + its
 * classifier exactly.
 *
 * PURE + INJECTABLE: buildProviderHealth/deriveProviderTrust are pure functions;
 * getProviderHealth runs against injected loaders (real in prod, fakes in tests),
 * so the whole surface unit-tests with no live database — the house pattern
 * (lib/jobs/health.ts, lib/platform/resource-freshness.ts, lib/money/fx-freshness.ts).
 *
 * READ-ONLY: zero writes, zero new tables. Every fact is read-time-computed from
 * data that already exists.
 */

import { db } from "@/lib/db";
import {
  checkResourceFreshness,
  type ResourceFreshnessReport,
  type ResourceFreshnessResult,
  type FreshnessHealthState,
} from "@/lib/platform/resource-freshness";
import {
  getConnectionHealth,
  type ConnectionHealthResult,
  type ConnectionHealthRow,
  type HealthState,
} from "@/lib/connections/health";

// ── Tunables (local — deliberately not coupled to a concurrently-owned module) ─

/** Window over which availability / error-rate / sync-failures are computed. */
export const PROVIDER_WINDOW_DAYS = 7;
/** Consecutive failed runs at which a provider's execution is "failing". Mirrors
 *  lib/jobs/health.ts FAILURE_STREAK_THRESHOLD; kept local so this slice does not
 *  import from a module a concurrent slice is actively editing. */
export const PROVIDER_FAILING_STREAK = 3;
/** A "running" JobRun older than this is a crashed run (no completion write). */
export const PROVIDER_STALE_RUNNING_HOURS = 2;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Public shapes ─────────────────────────────────────────────────────────────

export type ProviderKind = "BANKING" | "FX" | "PRICES" | "CRYPTO";

/** The roll-up status shown on a provider card — content OR execution, worst-wins. */
export type ProviderTrust =
  /** Recent success and fresh data — nothing wrong. */
  | "OPERATIONAL"
  /** Working but with a wart (some failures, a degraded connection, unknown freshness). */
  | "DEGRADED"
  /** The DATA is behind or absent even if the job is "green" (the false-green catch). */
  | "STALE"
  /** The provider's execution is broken (failure streak / high error rate / hard connection error). */
  | "FAILING"
  /** No signal at all — nothing to judge yet. */
  | "UNKNOWN";

/** How current a provider's data is — a compact view CONSUMED from a freshness
 *  authority (S1 ResourceFreshnessReport for archives; connection health for
 *  sync). Provider health never fills `state` by its own staleness math. */
export interface ProviderFreshness {
  /** S1 vocabulary (fresh|stale|empty|idle) plus "unknown" for un-tracked recency. */
  state: FreshnessHealthState | "unknown";
  /** Newest data point — ISO date (archives) or ISO instant (sync). null when empty/unknown. */
  asOf: string | null;
  ageDays: number | null;
  /** Which authority produced this (audit trail; also drives the brief's wording). */
  source: "resource-freshness" | "connection-health" | "none";
  detail: string;
}

/** The canonical health report for ONE provider. Every field the OPS-5 S3 brief
 *  enumerates is present; timestamps are ISO at the boundary. */
export interface ProviderHealth {
  key: string;
  label: string;
  kind: ProviderKind;
  /** The roll-up status (the card headline). This module's only judgement. */
  trust: ProviderTrust;

  /** Succeeded / total runs over the window, in [0,1]. null when no runs. */
  availability: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Whole-job wall-clock of the most recent completed run (ms). Provider-level
   *  per-call latency needs a telemetry emission that does not exist yet — this
   *  is the honest approximation the data supports today. null when unavailable. */
  latencyMs: number | null;

  /** Total quota, if the provider exposes one this app persists. null today. */
  quota: number | null;
  /** Remaining quota. null today — see the module header + report. */
  remainingQuota: number | null;

  /** Breadth the provider currently covers (e.g. currency pairs priced). null when unknown. */
  coverage: number | null;
  coverageUnit: string | null;

  /** CONSUMED from a freshness authority — never recomputed here. */
  freshness: ProviderFreshness;

  /** Failed runs over the window. */
  syncFailures: number;
  /** Failed / total runs over the window, in [0,1]. null when no runs. */
  errorRate: number | null;

  /** Calls today / last 30 days from ApiUsageCounter. null when the provider is not metered. */
  callsToday: number | null;
  calls30d: number | null;

  /** Honest, worst-first caveats (quota unavailable, false-green, degraded connections, …). */
  notes: string[];
}

export interface ProviderHealthResult {
  checkedAt: Date;
  counts: Record<ProviderTrust, number>;
  providers: ProviderHealth[];
}

// ── Provider registry — add a provider = add a spec ───────────────────────────

/** Where a provider's freshness comes from. Provider health CONSUMES one of these. */
type FreshnessSource =
  /** The S1 Resource Freshness resource this provider produces (by descriptor id). */
  | { via: "resource"; resourceId: string; coverageUnit: string }
  /** The connection-health source this provider's recency is derived from. */
  | { via: "connection"; source: string };

export interface ProviderSpec {
  key: string;
  label: string;
  kind: ProviderKind;
  /** JobRun.jobName of the producing job — the execution authority. null = none. */
  producingJob: string | null;
  /** ApiUsageCounter.provider for call volume. null = not metered there. */
  usageProvider: string | null;
  freshness: FreshnessSource;
  /** Honest, always-surfaced caveats (e.g. how/whether quota is knowable). */
  staticNotes: string[];
}

/**
 * The initial providers (OPS-5 S3 brief): Plaid and Open Exchange Rates. The
 * registry is the extension point — a price vendor, a wallet/exchange provider,
 * or a CSV importer is one more spec here, no change to the synthesis below.
 */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    key: "PLAID",
    label: "Plaid",
    kind: "BANKING",
    producingJob: "sync-banks",
    usageProvider: "PLAID",
    freshness: { via: "connection", source: "PLAID" },
    staticNotes: ["Plaid exposes no pollable quota/billing API — quota is not reportable."],
  },
  {
    key: "OPEN_EXCHANGE_RATES",
    label: "Open Exchange Rates",
    kind: "FX",
    producingJob: "fetch-fx-rates",
    // FX providers are not yet in ApiUsageCounter (PLATOPS investigation §6).
    usageProvider: null,
    freshness: { via: "resource", resourceId: "fx-rates", coverageUnit: "currency pairs" },
    staticNotes: [
      "Quota is reportable only via OXR's separate GET /api/usage.json, which this app does not yet call.",
    ],
  },
];

// ── JobRun window summary (execution authority) ───────────────────────────────

/** One recent run, newest-first per job. */
export interface ProviderJobRun {
  status: string; // "running" | "succeeded" | "failed"
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

export interface JobRunSummary {
  hasRuns: boolean;
  total: number;
  succeeded: number;
  failed: number;
  availability: number | null;
  errorRate: number | null;
  syncFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastRunFailed: boolean;
}

/** True when a run counts as a failure (a long-running row is a crash). */
function isFailureRun(r: ProviderJobRun, now: Date): boolean {
  if (r.status === "failed") return true;
  if (r.status === "running") return now.getTime() - r.startedAt.getTime() > PROVIDER_STALE_RUNNING_HOURS * HOUR_MS;
  return false;
}

/**
 * Summarize a provider's recent runs (newest-first). Pure and deterministic.
 * `running` rows are excluded from availability/error-rate denominators (they
 * have no outcome yet) but a STALE running row counts toward the failure streak.
 */
export function summarizeJobRuns(runs: readonly ProviderJobRun[], now: Date): JobRunSummary {
  if (runs.length === 0) {
    return {
      hasRuns: false, total: 0, succeeded: 0, failed: 0,
      availability: null, errorRate: null, syncFailures: 0,
      lastSuccessAt: null, lastFailureAt: null, latencyMs: null,
      consecutiveFailures: 0, lastRunFailed: false,
    };
  }

  let succeeded = 0;
  let failed = 0;
  let lastSuccessAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let latencyMs: number | null = null;

  for (const r of runs) {
    if (r.status === "succeeded") {
      succeeded++;
      if (!lastSuccessAt || r.startedAt > lastSuccessAt) lastSuccessAt = r.startedAt;
      if (latencyMs === null && r.durationMs != null) latencyMs = r.durationMs;
    } else if (isFailureRun(r, now)) {
      failed++;
      if (!lastFailureAt || r.startedAt > lastFailureAt) lastFailureAt = r.startedAt;
    }
  }
  // Fall back to the newest completed run's duration if no success carried one.
  if (latencyMs === null) {
    const completed = runs.find((r) => r.durationMs != null);
    latencyMs = completed?.durationMs ?? null;
  }

  const decided = succeeded + failed;

  // Leading failure streak (newest-first); a recent in-flight run breaks it.
  let consecutiveFailures = 0;
  for (const r of runs) {
    if (r.status === "running" && !isFailureRun(r, now)) break;
    if (!isFailureRun(r, now)) break;
    consecutiveFailures++;
  }

  return {
    hasRuns: true,
    total: decided,
    succeeded,
    failed,
    availability: decided === 0 ? null : succeeded / decided,
    errorRate: decided === 0 ? null : failed / decided,
    syncFailures: failed,
    lastSuccessAt,
    lastFailureAt,
    latencyMs,
    consecutiveFailures,
    lastRunFailed: isFailureRun(runs[0], now),
  };
}

// ── Freshness consumption (map an authority's output → ProviderFreshness) ──────

/** Map an S1 ResourceFreshnessReport (archive providers) → ProviderFreshness. */
export function freshnessFromResourceReport(report: ResourceFreshnessReport): ProviderFreshness {
  return {
    state: report.healthState,
    asOf: report.newestObservedDate,
    ageDays: report.ageDays,
    source: "resource-freshness",
    detail: report.trust.caveats[0] ?? `${report.label}: ${report.healthState}`,
  };
}

/** Severity for picking the worst connection state (higher = worse). */
const CONNECTION_SEVERITY: Record<HealthState, number> = {
  ERROR: 5, REVOKED: 4, NEEDS_REAUTH: 3, DEGRADED: 2, STALE: 1, HEALTHY: 0,
};

/**
 * Derive a provider's freshness from the connection authority's rows (sync
 * providers). We consume connection health's DERIVED STALE state — we never
 * re-derive recency from raw lastSyncedAt. Healthy connections are not in the
 * authority's `unhealthy` list, so an absence of unhealthy rows is treated as
 * fresh (with a null asOf — the authority does not surface healthy sync times).
 */
export function freshnessFromConnections(source: string, rows: readonly ConnectionHealthRow[]): ProviderFreshness {
  // The connection authority's `unhealthy` list never contains HEALTHY rows;
  // filter them defensively so a caller passing all rows still reads correctly.
  const mine = rows.filter((r) => r.source === source && r.healthState !== "HEALTHY");
  if (mine.length === 0) {
    return { state: "fresh", asOf: null, ageDays: null, source: "connection-health", detail: "all connections healthy" };
  }
  // Worst-first; STALE is the recency signal, harder states feed trust (below).
  const worst = [...mine].sort((a, b) => CONNECTION_SEVERITY[b.healthState] - CONNECTION_SEVERITY[a.healthState])[0];
  const state: ProviderFreshness["state"] = worst.healthState === "STALE" ? "stale" : "unknown";
  const detail =
    worst.healthState === "STALE"
      ? `${mine.length} connection(s) stale — newest lag ${worst.since ? "since " + worst.since.slice(0, 10) : "unknown"}`
      : `${mine.length} connection(s) unhealthy (${worst.healthState})`;
  return { state, asOf: worst.lastSyncedAt, ageDays: null, source: "connection-health", detail };
}

/** Do this provider's connections carry a hard (non-stale) fault? Feeds trust. */
function connectionsHaveHardFault(source: string, rows: readonly ConnectionHealthRow[]): boolean {
  return rows.some(
    (r) => r.source === source && (r.healthState === "ERROR" || r.healthState === "REVOKED" || r.healthState === "NEEDS_REAUTH"),
  );
}

/** Do this provider's connections carry any degradation (incl. DEGRADED)? */
function connectionsDegraded(source: string, rows: readonly ConnectionHealthRow[]): boolean {
  return rows.some((r) => r.source === source && r.healthState !== "HEALTHY");
}

// ── Trust roll-up (the ONE judgement — pure) ──────────────────────────────────

export interface TrustSignals {
  hasExecutionSignal: boolean;
  lastRunFailed: boolean;
  consecutiveFailures: number;
  errorRate: number | null;
  freshnessState: ProviderFreshness["state"];
  /** A hard, actionable connection fault (revoked / error / needs-reauth). */
  connectionHardFault: boolean;
  /** Any connection degradation short of a hard fault. */
  connectionDegraded: boolean;
}

/**
 * Roll the signals up to a single trust level — content OR execution, whichever
 * is WORSE (the PLATOPS doctrine). Precedence:
 *   FAILING  execution clearly broken, OR a hard connection fault.
 *   STALE    the DATA is behind/absent (freshness stale|empty) — the false-green
 *            catch: a green job over a stale archive still reads STALE here.
 *   UNKNOWN  no signal at all to judge (no runs AND freshness un-assertable).
 *   DEGRADED some failures, a degraded connection, or un-assertable freshness
 *            despite having an execution signal.
 *   OPERATIONAL otherwise (fresh/idle data + clean execution).
 */
export function deriveProviderTrust(s: TrustSignals): ProviderTrust {
  const highErrorRate = s.errorRate != null && s.errorRate >= 0.5;
  if (s.consecutiveFailures >= PROVIDER_FAILING_STREAK || highErrorRate || s.connectionHardFault) {
    return "FAILING";
  }
  if (s.freshnessState === "stale" || s.freshnessState === "empty") {
    return "STALE";
  }
  // Nothing to judge on either axis — honest UNKNOWN before any softer verdict.
  if (!s.hasExecutionSignal && s.freshnessState === "unknown") {
    return "UNKNOWN";
  }
  const someFailures = (s.errorRate != null && s.errorRate > 0) || s.consecutiveFailures > 0 || s.lastRunFailed;
  if (someFailures || s.connectionDegraded || s.freshnessState === "unknown") {
    return "DEGRADED";
  }
  return "OPERATIONAL";
}

// ── Pure assembly ─────────────────────────────────────────────────────────────

export interface ProviderInputs {
  runs: readonly ProviderJobRun[];
  callsToday: number | null;
  calls30d: number | null;
  /** The S1 report for this provider's resource (archive providers), if any. */
  freshnessReport: ResourceFreshnessReport | null;
  /** Connection-health rows (sync providers). */
  connectionRows: readonly ConnectionHealthRow[];
  now: Date;
}

/** Build one provider's health from its spec + gathered authority inputs. Pure. */
export function buildProviderHealth(spec: ProviderSpec, inputs: ProviderInputs): ProviderHealth {
  const runs = summarizeJobRuns(inputs.runs, inputs.now);
  const notes: string[] = [...spec.staticNotes];

  // Freshness — CONSUMED from the mapped authority; never computed here.
  let freshness: ProviderFreshness;
  let coverage: number | null = null;
  let coverageUnit: string | null = null;
  let connectionHardFault = false;
  let connectionDegraded = false;

  if (spec.freshness.via === "resource") {
    coverageUnit = spec.freshness.coverageUnit;
    if (inputs.freshnessReport) {
      freshness = freshnessFromResourceReport(inputs.freshnessReport);
      const c = inputs.freshnessReport.completeness;
      coverage = c ? c.observed : null;
      // Surface S1's own trust caveats (false-green flags, partial frontier) verbatim.
      for (const cav of inputs.freshnessReport.trust.caveats) if (!notes.includes(cav)) notes.push(cav);
    } else {
      freshness = { state: "unknown", asOf: null, ageDays: null, source: "resource-freshness", detail: "freshness resource not found" };
      notes.push(`No Resource Freshness descriptor for "${spec.freshness.resourceId}".`);
    }
  } else {
    freshness = freshnessFromConnections(spec.freshness.source, inputs.connectionRows);
    connectionHardFault = connectionsHaveHardFault(spec.freshness.source, inputs.connectionRows);
    connectionDegraded = connectionsDegraded(spec.freshness.source, inputs.connectionRows);
    if (connectionHardFault) notes.push("One or more connections need attention (revoked / error / re-auth).");
  }

  const trust = deriveProviderTrust({
    hasExecutionSignal: runs.hasRuns,
    lastRunFailed: runs.lastRunFailed,
    consecutiveFailures: runs.consecutiveFailures,
    errorRate: runs.errorRate,
    freshnessState: freshness.state,
    connectionHardFault,
    connectionDegraded,
  });

  // False-green surfacing: a green execution window while the data is behind.
  if ((freshness.state === "stale" || freshness.state === "empty") && runs.lastSuccessAt) {
    const flag = "Execution recently reported success but the data is behind — job success is not provider health.";
    if (!notes.includes(flag)) notes.push(flag);
  }

  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    trust,
    availability: runs.availability,
    lastSuccessAt: runs.lastSuccessAt ? runs.lastSuccessAt.toISOString() : null,
    lastFailureAt: runs.lastFailureAt ? runs.lastFailureAt.toISOString() : null,
    latencyMs: runs.latencyMs,
    quota: null,
    remainingQuota: null,
    coverage,
    coverageUnit,
    freshness,
    syncFailures: runs.syncFailures,
    errorRate: runs.errorRate,
    callsToday: inputs.callsToday,
    calls30d: inputs.calls30d,
    notes,
  };
}

// ── Read-client (injection seam; `db` in prod, a fake in tests) ───────────────

interface JobRunRow {
  jobName: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}
interface UsageRow {
  provider: string;
  day: Date;
  count: bigint | number;
}

export interface ProviderHealthReadClient {
  jobRun: {
    findMany(args: {
      where: { jobName: { in: string[] }; startedAt: { gte: Date } };
      orderBy: { startedAt: "desc" };
      select: { jobName: true; status: true; startedAt: true; completedAt: true; durationMs: true };
    }): Promise<JobRunRow[]>;
  };
  apiUsageCounter: {
    findMany(args: {
      where: { provider: { in: string[] }; unit: string; day: { gte: Date } };
      select: { provider: true; day: true; count: true };
    }): Promise<UsageRow[]>;
  };
}

export interface ProviderHealthDeps {
  now?: Date;
  windowDays?: number;
  client?: ProviderHealthReadClient;
  /** The freshness authority — injected for tests; defaults to S1's checkResourceFreshness. */
  loadFreshness?: () => Promise<ResourceFreshnessResult>;
  /** The connection authority — injected for tests; defaults to getConnectionHealth. */
  loadConnections?: () => Promise<ConnectionHealthResult>;
  specs?: readonly ProviderSpec[];
}

/** Start of the UTC day — matches the ApiUsageCounter day bucket (lib/usage/record.ts). */
function utcDayBucket(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── The driver ────────────────────────────────────────────────────────────────

/**
 * Evaluate health for every registered provider. Read-only; deterministic given
 * a fixed clock and fixed ledger/archive/connection state. Gathers each
 * authority's facts ONCE, then assembles per provider through the pure builder.
 */
export async function getProviderHealth(deps: ProviderHealthDeps = {}): Promise<ProviderHealthResult> {
  const now = deps.now ?? new Date();
  const windowDays = deps.windowDays ?? PROVIDER_WINDOW_DAYS;
  const client = deps.client ?? (db as unknown as ProviderHealthReadClient);
  const specs = deps.specs ?? PROVIDER_SPECS;
  const loadFreshness = deps.loadFreshness ?? (() => checkResourceFreshness(undefined, now));
  const loadConnections = deps.loadConnections ?? (() => getConnectionHealth());

  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const monthStart = new Date(utcDayBucket(now).getTime() - 29 * DAY_MS);
  const today = utcDayBucket(now);

  const jobNames = [...new Set(specs.map((s) => s.producingJob).filter((j): j is string => j != null))];
  const usageProviders = [...new Set(specs.map((s) => s.usageProvider).filter((p): p is string => p != null))];

  const needsFreshness = specs.some((s) => s.freshness.via === "resource");
  const needsConnections = specs.some((s) => s.freshness.via === "connection");

  const [jobRuns, usageRows, freshness, connections] = await Promise.all([
    jobNames.length
      ? client.jobRun.findMany({
          where: { jobName: { in: jobNames }, startedAt: { gte: windowStart } },
          orderBy: { startedAt: "desc" },
          select: { jobName: true, status: true, startedAt: true, completedAt: true, durationMs: true },
        })
      : Promise.resolve([] as JobRunRow[]),
    usageProviders.length
      ? client.apiUsageCounter.findMany({
          where: { provider: { in: usageProviders }, unit: "calls", day: { gte: monthStart } },
          select: { provider: true, day: true, count: true },
        })
      : Promise.resolve([] as UsageRow[]),
    needsFreshness ? loadFreshness() : Promise.resolve<ResourceFreshnessResult | null>(null),
    needsConnections ? loadConnections() : Promise.resolve<ConnectionHealthResult | null>(null),
  ]);

  // Index the gathered facts by provider.
  const runsByJob = new Map<string, ProviderJobRun[]>();
  for (const r of jobRuns) {
    const arr = runsByJob.get(r.jobName) ?? [];
    arr.push({ status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, durationMs: r.durationMs });
    runsByJob.set(r.jobName, arr);
  }

  const callsTodayByProvider = new Map<string, number>();
  const calls30dByProvider = new Map<string, number>();
  for (const u of usageRows) {
    const n = Number(u.count);
    calls30dByProvider.set(u.provider, (calls30dByProvider.get(u.provider) ?? 0) + n);
    if (u.day.getTime() >= today.getTime()) {
      callsTodayByProvider.set(u.provider, (callsTodayByProvider.get(u.provider) ?? 0) + n);
    }
  }

  const freshnessByResource = new Map<string, ResourceFreshnessReport>();
  for (const r of freshness?.resources ?? []) freshnessByResource.set(r.resource, r);
  const connectionRows = connections?.unhealthy ?? [];

  const providers = specs.map((spec) =>
    buildProviderHealth(spec, {
      runs: spec.producingJob ? runsByJob.get(spec.producingJob) ?? [] : [],
      callsToday: spec.usageProvider ? callsTodayByProvider.get(spec.usageProvider) ?? 0 : null,
      calls30d: spec.usageProvider ? calls30dByProvider.get(spec.usageProvider) ?? 0 : null,
      freshnessReport: spec.freshness.via === "resource" ? freshnessByResource.get(spec.freshness.resourceId) ?? null : null,
      connectionRows,
      now,
    }),
  );

  const counts: Record<ProviderTrust, number> = { OPERATIONAL: 0, DEGRADED: 0, STALE: 0, FAILING: 0, UNKNOWN: 0 };
  for (const p of providers) counts[p.trust]++;

  return { checkedAt: now, counts, providers };
}

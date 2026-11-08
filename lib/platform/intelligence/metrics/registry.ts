/**
 * lib/platform/intelligence/metrics/registry.ts  (Platform Intelligence — foundation step 1)
 *
 * THE METRIC REGISTRY: typed, versioned DEFINITIONS of the metrics the Platform
 * already computes. Design: docs/plans/PLATFORM-INTELLIGENCE.md ("Smallest
 * coherent foundation", step 1; the pattern of lib/usage/pricing.ts).
 *
 * WHAT IT IS
 *   One entry per existing authority. Each entry DESCRIBES a metric — its
 *   window and timezone, numerator and denominator, inclusion and exclusion,
 *   freshness, provenance, coverage gaps, the permission boundary and the
 *   records an operator drills to — and POINTS AT the code that computes it
 *   (`compute`) and the route → reader → function chain (`path`) that the
 *   Platform UI already reads. The Platform UI, alerts and the future Platform
 *   AI read the SAME definition; there is no AI-only definition, and the AI never
 *   substitutes its own (owner rule).
 *
 * WHAT IT IS NOT
 *   No values, no queries, no maths. Nothing here computes a number: every
 *   figure stays where it is computed today, and this file only names it.
 *   Values arrive later through the Phase 3 retrieval contracts, through the
 *   SAME permissioned readers listed in `path`.
 *
 * PINS (registry.test.ts): every `compute` / numerator / denominator symbol is
 * exported by its module; every `path` hop calls the next; every tile reads the
 * figure; every permission route guards with exactly its `requirePlatformAccess`
 * area and level; ids are unique and versioned; every metric has a permission
 * and an identity tier; an UNAVAILABLE provenance carries its reason; a metric
 * whose code carries its own definition version agrees with it.
 *
 * Pure and import-free at runtime (type imports only): safe for client and server.
 */

import type { PlatformAccessLevel, PlatformArea } from "@prisma/client";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type MetricDomain =
  | "providers" | "economics" | "engagement" | "incidents" | "merchants" | "customers" | "growth" | "security"
  /** Platform AI operational briefing (2026-11-08): the Platform Ops posture, impact, job, connection and freshness aggregates. */
  | "operations";

/**
 * How an ANSWER built on this metric is classed (owner rule): OBSERVED = a row
 * count or a recorded fact read as-is; CALCULATED = a deterministic rule over
 * observed facts; INFERRED = a judgement beyond the facts. No registered metric
 * is INFERRED: every one is a deterministic rule.
 */
export type AnswerClass = "OBSERVED" | "CALCULATED" | "INFERRED";

/**
 * Where the INPUTS come from. MEASURED = counted from our own ledger rows;
 * ESTIMATED = priced or modelled (a rate card, never an invoice);
 * UNAVAILABLE = the source does not exist, and the reason is mandatory.
 */
export type MetricProvenance =
  | { class: "MEASURED"; note?: string }
  | { class: "ESTIMATED"; note: string }
  | { class: "UNAVAILABLE"; reason: string };

/**
 * Who may see identities beside this metric. OPS = identity-free aggregates
 * (Platform Ops / Growth / Merchant output carries no customer identity);
 * CUSTOMER_SUCCESS = an authorised CS operator may see the customer it is about.
 */
export type IdentityTier = "OPS" | "CUSTOMER_SUCCESS";

/** A named export in a repository file. Pinned: the file exports the symbol. */
export interface CodeRef { module: string; symbol: string }

/** One hop of the route → reader → compute chain. Pinned: `file` calls `calls(`. */
export interface PathHop { file: string; calls: string }

export interface MetricTerm { description: string; source: CodeRef }

/**
 * One permission boundary: the gate a reader of this metric already applies
 * (`requirePlatformAccess(area, level)` in `route`, pinned), and the identity
 * tier output carries under it.
 */
export interface MetricPermission {
  area: PlatformArea;
  level: PlatformAccessLevel;
  identityTier: IdentityTier;
  /** The API route that serves this metric under this gate. */
  route: string;
}

/** A Platform tile showing the metric. Pinned: `component` contains `reads`. */
export interface MetricTile { component: string; reads: string }

/** One records route and the Platform page that opens it. */
export interface MetricDrillLink { api: string; page: string; note?: string }

/**
 * Where an operator drills from the figure: one link (served on the surface
 * whose area gates its route), a stated reason, or — when the metric is shown
 * on more than one surface — a link PER SURFACE (each still gated by its own
 * route's area; a surface without an entry has no drill there).
 */
export type MetricDrill =
  | MetricDrillLink
  | { unavailable: string }
  | { bySurface: Readonly<Partial<Record<PlatformArea, MetricDrillLink>>> };

/** Every records link a drill names (none for a stated reason). */
export function drillLinks(d: MetricDrill): readonly MetricDrillLink[] {
  if ("unavailable" in d) return [];
  if ("bySurface" in d) return Object.values(d.bySurface).filter((x): x is MetricDrillLink => !!x);
  return [d];
}

/** The link a drill offers on `surface` before the route-gate check: the per-surface entry, or the single link. */
export function drillLinkOn(d: MetricDrill, surface: PlatformArea): MetricDrillLink | null {
  if ("unavailable" in d) return null;
  if ("bySurface" in d) return d.bySurface[surface] ?? null;
  return d;
}

/** The short server phrase for a window of N days / hours ("in the last 7 days") — MetricWindow.label's form. */
export const daysWindowLabel = (n: number) => `in the last ${n} day${n === 1 ? "" : "s"}`;
export const hoursWindowLabel = (n: number) => `in the last ${n} hour${n === 1 ? "" : "s"}`;

export interface MetricWindow {
  kind: "ROLLING" | "POINT_IN_TIME" | "UTC_DAYS";
  description: string;
  timezone: "UTC";
  /** The constant that sets the window, when one exists. */
  source?: CodeRef;
  /**
   * The windows (in days) a caller may ask for, the first being the tile's default.
   * Absent = a fixed window (no `window` parameter). Pinned equal to the retrieval
   * contract's declared windows (retrieve.test.ts); any other window is refused.
   */
  days?: readonly number[];
  /**
   * The short server phrase a renderer states beside a figure (S2, 2026-11-04),
   * e.g. "in the last 7 days", "this UTC calendar month to date". Required for
   * every kind except POINT_IN_TIME. For a metric with `days`, it is the DEFAULT
   * window's phrase (a read with another window states that window's phrase). Any
   * number in it must equal the envelope's days / hours (pinned).
   */
  label?: string;
}

export interface MetricDefinition {
  id: string;
  /** Explicit, integer, ≥ 1. A changed meaning is a new version, never an edit. */
  version: number;
  domain: MetricDomain;
  label: string;
  /** One sentence: what the figure means. */
  summary: string;
  answerClass: AnswerClass;
  window: MetricWindow;
  numerator: MetricTerm;
  /** null when the metric is a count or a per-subject state, not a ratio (said in `summary`). */
  denominator: MetricTerm | null;
  /** THE function that computes it. */
  compute: CodeRef;
  /**
   * The route → reader → compute chain the Platform UI reads, hop by hop. Each
   * hop's `calls` is exported by the next hop's file; the last hop calls
   * `compute`, unless a tile calls it on the route's payload (pure folds).
   */
  path: readonly PathHop[];
  inclusion: readonly string[];
  exclusion: readonly string[];
  /** The clock the figure's freshness follows. */
  freshnessSource: string;
  provenance: MetricProvenance;
  /** Known gaps, stated: what the figure cannot see. */
  coverageGaps: readonly string[];
  /** ≥ 1. Visible to a caller who satisfies ANY entry. */
  permission: readonly MetricPermission[];
  tiles: readonly MetricTile[];
  drill: MetricDrill;
}

/** "id@version" — the stamp an answer built on a metric carries. */
export const metricKey = (m: Pick<MetricDefinition, "id" | "version">): `${string}@${number}` => `${m.id}@${m.version}`;

const PO = "PLATFORM_OPS" as const;
const CS = "CUSTOMER_SUCCESS" as const;
const GR = "GROWTH_REVENUE" as const;
const MO = "MERCHANT_OPS" as const;
const page = (area: PlatformArea) => `/dashboard/platform/${area}`;

// ── The registry ─────────────────────────────────────────────────────────────

export const METRICS: readonly MetricDefinition[] = [
  // ── providers ──────────────────────────────────────────────────────────────
  {
    id: "provider-outcome", version: 1, domain: "providers",
    label: "Provider outcome verdict",
    summary: "A provider's verdict (Healthy / Degraded / Failing / Not enough data) from its recorded outcome counts, one evidence kind at a time.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Producing-job runs in the 7-day provider window; ProviderCall attempts in the 7-day roll-up.", label: "in the last 7 days" },
    numerator: { description: "Failed decided outcomes (failed job runs, or failed ProviderCall attempts).", source: { module: "lib/platform/verdicts/provider-outcome.ts", symbol: "assessOutcomes" } },
    denominator: { description: "Decided outcomes: succeeded + failed (in-flight excluded). A verdict needs PROVIDER_OUTCOME_DEFINITION.minSample of them.", source: { module: "lib/platform/verdicts/provider-outcome.ts", symbol: "PROVIDER_OUTCOME_DEFINITION" } },
    compute: { module: "lib/platform/verdicts/provider-outcome.ts", symbol: "assessOutcomes" },
    path: [
      { file: "app/api/platform/platform-ops/provider-health/route.ts", calls: "getProviderHealth" },
      { file: "lib/platform/provider-health.ts", calls: "assessOutcomes" },
    ],
    inclusion: ["Job runs of the provider's producing jobs (ordered: the recency rule applies)", "ProviderCall attempt rows (unordered: the all-failed rule applies instead)"],
    exclusion: ["In-flight runs and calls (no outcome yet)"],
    freshnessSource: "JobRun rows (90-day retention) and ProviderCall rows (60-day retention)",
    provenance: { class: "MEASURED" },
    coverageGaps: ["A small sample never reads Healthy (NOT_ENOUGH_DATA)", "ProviderCall roll-ups carry no order, so a recent failure streak is only visible in job runs", "The provider-health route carries the job-run execution verdict only; the ProviderCall attempt verdict is folded by the Providers tile from the provider-operations payload (callsAssessment), so a retrieval through provider-health does not see it",
      "Envelope status rule (the verdict rule is unchanged): MEASURED only when every provider has an evaluable verdict (Healthy / Degraded / Failing); PARTIAL, with the counts, when some providers have no runs or not enough data; UNAVAILABLE when none does — no evaluable job runs in the window (scheduled jobs may not run in this environment). Zero healthy is never reported as a measurement when nothing was evaluated"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/provider-health/route.ts" }],
    tiles: [
      { component: "components/platform/leads/providers-model.ts", reads: "assessOutcomes(" },
      { component: "components/platform/widgets/provider-view.ts", reads: "trustBadge(p.trust)" },
    ],
    drill: { api: "/api/platform/platform-ops/provider-health", page: page(PO) },
  },
  {
    // v2 (S2 P8 item 5) supersedes v1: an ERROR share one institution explains
    // DEGRADES instead of failing. v1 is retired (no code computes it), so it has no entry.
    id: "provider-connection", version: 2, domain: "providers",
    label: "Provider connection verdict",
    summary: "Whether a provider's live connection population says the PROVIDER is failing (a provider-side ERROR share that holds with its worst institution set aside), not one customer or one institution.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Current connection health state (no window)." },
    numerator: { description: "Live connections in provider-side ERROR (PROVIDER_SIDE_ERROR_CODES).", source: { module: "lib/platform/verdicts/provider-connection.ts", symbol: "connectionTrustState" } },
    denominator: { description: "The provider's LIVE connections: every connection except REVOKED and those whose owner is inactive or pending deletion.", source: { module: "lib/platform/verdicts/provider-connection.ts", symbol: "tallyConnections" } },
    compute: { module: "lib/platform/verdicts/provider-connection.ts", symbol: "assessConnections" },
    path: [
      { file: "app/api/platform/platform-ops/provider-health/route.ts", calls: "getProviderHealth" },
      { file: "lib/platform/provider-health.ts", calls: "assessConnections" },
    ],
    inclusion: ["PlaidItem and wallet Connection rows of the provider"],
    exclusion: ["REVOKED connections (reported as a neutral fact)", "Connections whose owner is inactive or pending deletion", "NEEDS_REAUTH never FAILS a provider (only a reauth wave DEGRADES it)", "An ERROR share one institution explains never FAILS a provider (institution-concentrated ⇒ DEGRADED; the basis counts institutions, never names one)"],
    freshnessSource: "The connection health authority (lib/connections/health.ts) — live columns",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Without the authority's per-source tally the population is unknown and no share is computed", "Connections with no recorded institution are never assumed to share one; with no institution split at all, concentration is not assessed and the share alone decides", "A single-institution fleet can never reach FAILING on the connection half; a genuine provider outage also fails the producing job's runs, so provider-outcome@1 raises FAILING through the execution half. 'Degraded (institution-concentrated)' does NOT mean the provider is fine.",
      "Envelope status rule: UNAVAILABLE when no provider reports a connection population (nothing to assess); PARTIAL when some providers report none, or a population is unknown; MEASURED otherwise"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/provider-health/route.ts" }],
    tiles: [{ component: "components/platform/widgets/provider-view.ts", reads: "trustBadge(p.trust)" }],
    drill: { api: "/api/platform/platform-ops/provider-health", page: page(PO) },
  },
  {
    id: "provider-call-volume", version: 1, domain: "providers",
    label: "Provider call volume (today / rolling month)",
    summary: "Fleet provider API calls recorded by the usage counters, summed over the METERED providers: calls today (UTC) and over the rolling thirty-day window, plus failed producing-job runs in the provider window. Unmetered providers are counted, never treated as zero calls.",
    answerClass: "OBSERVED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "Calls: today (UTC) and the trailing thirty-day counter window (ApiUsageCounter); sync failures: the provider window of producing-job runs.", label: "today and over the rolling month (UTC)" },
    numerator: { description: "Σ callsToday / calls30d (as callsMonth) over providers whose usage is metered (non-null); Σ syncFailures.", source: { module: "lib/platform/provider-health.ts", symbol: "getProviderHealth" } },
    denominator: null,
    compute: { module: "lib/platform/provider-health.ts", symbol: "getProviderHealth" },
    path: [
      { file: "app/api/platform/platform-ops/provider-health/route.ts", calls: "getProviderHealth" },
    ],
    inclusion: ["Every registered provider's ApiUsageCounter totals (metered providers only)", "Failed producing-job runs in the provider window"],
    exclusion: ["Providers with no usage counter (counted as unmetered, never 0 calls)", "No per-customer or per-connection dimension"],
    freshnessSource: "ApiUsageCounter rows and JobRun rows, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["PARTIAL when any provider is unmetered: its calls are unknown, never 0", "A volume, not a verdict: provider-outcome@1 and provider-connection@2 judge health"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/provider-health/route.ts" }],
    tiles: [{ component: "components/platform/widgets/OpsProviderHealthWidget.tsx", reads: "p.callsToday" }],
    drill: { api: "/api/platform/platform-ops/provider-health", page: `${page(PO)}?workspace=platform-providers` },
  },

  // ── operations (Platform AI operational briefing, 2026-11-08) ──────────────
  // Each one wraps the aggregated reader its Platform Ops tile already reads;
  // counts and registry / module names only — never a customer, connection,
  // execution or incident identifier.
  {
    id: "ops-overall-posture", version: 1, domain: "operations",
    label: "Platform operating posture",
    summary: "The Platform Ops overview's per-domain verdicts (refresh pipeline, connections, scheduled jobs, Daily Brief, AI, Plaid) counted by state, and the worst known state. Which domains are not healthy is named by the server.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Each domain's own window as the overview reads it (pipeline since yesterday UTC; AI and Brief the last 24 h; the rest current state)." },
    numerator: { description: "Domains per DomainState (FAILED / DEGRADED / STALE / UNKNOWN / HEALTHY); worst = the worst KNOWN state.", source: { module: "lib/platform/ops/overview-core.ts", symbol: "buildOverview" } },
    denominator: null,
    compute: { module: "lib/platform/ops/overview-core.ts", symbol: "buildOverview" },
    path: [
      { file: "app/api/platform/platform-ops/overview/route.ts", calls: "getOperationsOverview" },
      { file: "lib/platform/ops/overview.ts", calls: "buildOverview" },
    ],
    inclusion: ["The six overview domains, each judged by its own authority"],
    exclusion: ["The overview's latest failed executions (per-execution rows — never retrieved)", "Security, email delivery and MFA posture (not part of the overview)"],
    freshnessSource: "The overview's authorities, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["UNKNOWN never outranks a real verdict: a domain with nothing to judge is counted as unknown, not healthy", "Security, email delivery and MFA are not overview domains"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/overview/route.ts" }],
    tiles: [{ component: "components/platform/leads/operations-model.ts", reads: "overallWord(o.worst)" }],
    drill: { api: "/api/platform/platform-ops/overview", page: page(PO) },
  },
  {
    id: "customer-impact-24h", version: 1, domain: "operations",
    label: "Customer-impacting failures (24 h)",
    summary: "Failures that reached a customer in the last 24 hours, by kind (refresh failed / partial, AI failure, Brief failed, connection needs reconnect), with the distinct customers affected — counts only.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Trailing USER_IMPACT_WINDOW_HOURS (24 h) from the reader's now.", label: "in the last 24 hours", source: { module: "lib/platform/ops/attention-core.ts", symbol: "USER_IMPACT_WINDOW_HOURS" } },
    numerator: { description: "Facts per UserImpactKind (a roll-up row counts for its count); distinct user references for customers affected.", source: { module: "lib/platform/ops/attention-core.ts", symbol: "buildUserImpact" } },
    denominator: null,
    compute: { module: "lib/platform/ops/attention-core.ts", symbol: "buildUserImpact" },
    path: [
      { file: "app/api/platform/platform-ops/attention/route.ts", calls: "getAttention" },
      { file: "lib/platform/ops/attention.ts", calls: "buildUserImpact" },
    ],
    inclusion: ["FAILED / PARTIAL refresh executions", "AI failures", "Failed Daily Brief generations", "Connections needing reconnect (connection health)"],
    exclusion: ["The impact rows and their references (never retrieved: counts only)"],
    freshnessSource: "RefreshExecution, AiInvocation, Brief and connection-health reads, on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Customers affected is a floor (or unavailable) when a reader exposes no user reference", "PARTIAL when one of the four impact readers could not be read, or a reader returned a floor"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/attention/route.ts" }],
    tiles: [{ component: "components/platform/widgets/overview/attention-view.ts", reads: "u.usersAffected.count" }],
    drill: { api: "/api/platform/platform-ops/attention", page: page(PO) },
  },
  {
    id: "alerts-firing-now", version: 1, domain: "operations",
    label: "Alert rules firing now",
    summary: "From the LATEST alert evaluation: rules firing now (and how many are critical), rules that could not judge, enabled rules, and alert sources the evaluator could not read. Firing rules are named by their registry id.",
    answerClass: "OBSERVED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "As of the latest alert evaluation run (its evaluatedAt is the freshness)." },
    numerator: { description: "Rules with firing = true in the latest evaluation (firingNow).", source: { module: "lib/alerts/latest-evaluation.ts", symbol: "firingNow" } },
    denominator: null,
    compute: { module: "lib/alerts/latest-evaluation.ts", symbol: "latestAlertEvaluation" },
    path: [
      { file: "app/api/platform/platform-ops/alerts/route.ts", calls: "loadRecentAlertRuns" },
      { file: "lib/alerts/run.ts", calls: "latestAlertEvaluation" },
    ],
    inclusion: ["The newest AlertRun summary's rule outcomes and source statuses"],
    exclusion: ["Alert history and deliveries (historical — never 'firing now')", "The alert destination address"],
    freshnessSource: "The newest alert evaluation run (JobRun summary)",
    provenance: { class: "MEASURED" },
    coverageGaps: ["UNAVAILABLE when no evaluation has run (never 'nothing firing')", "An old evaluation is still the latest: check freshness", "A rule whose source was unreadable cannot fire — sourcesUnavailable counts them"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/alerts/route.ts" }],
    tiles: [{ component: "components/platform/widgets/platform-health-view.ts", reads: "firing.length" }],
    drill: { api: "/api/platform/platform-ops/alerts", page: `${page(PO)}?workspace=platform-policies&view=alerts` },
  },
  {
    id: "connection-health-summary", version: 1, domain: "operations",
    label: "Connection health (fleet)",
    summary: "Live bank and wallet connections by health state, how many need the customer to reconnect (NEEDS_REAUTH, or an ERROR whose code Plaid fixes through update mode, e.g. NO_ACCOUNTS), and how many are customer-impacting (every live connection that is not healthy).",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Current connection health state (no window)." },
    numerator: { description: "Connections per HealthState; reconnect needed = NEEDS_REAUTH + ERROR rows with an update-mode-fixable code (isUpdateModeFixable).", source: { module: "lib/plaid/reauth-codes.ts", symbol: "isUpdateModeFixable" } },
    denominator: { description: "Live connections (the authority's total; revoked and owner-inactive connections are retired, outside it).", source: { module: "lib/connections/health.ts", symbol: "getConnectionHealth" } },
    compute: { module: "lib/connections/health.ts", symbol: "getConnectionHealth" },
    path: [
      { file: "app/api/platform/platform-ops/connection-health/route.ts", calls: "getConnectionHealth" },
    ],
    inclusion: ["PlaidItem and wallet Connection rows with a live owner"],
    exclusion: ["Revoked connections and connections of inactive owners (retired)", "The unhealthy rows themselves (ids, institutions, owners — never retrieved)"],
    freshnessSource: "The connection health authority (lib/connections/health.ts) — live columns",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Without the per-source fault tally, reconnect needed is a floor (NEEDS_REAUTH only)"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/connection-health/route.ts" }],
    tiles: [{ component: "components/platform/widgets/connection-health-view.ts", reads: "r.counts.HEALTHY" }],
    drill: { api: "/api/platform/platform-ops/connection-health", page: `${page(PO)}?view=pipeline` },
  },
  {
    id: "refresh-pipeline", version: 1, domain: "operations",
    label: "Refresh pipeline (since yesterday)",
    summary: "Refresh executions since yesterday (UTC): executions, failed (FAILED net of recovered, plus PARTIAL), succeeded and running now, and the pipeline domain's verdict — exactly the overview's Refresh pipeline card.",
    answerClass: "CALCULATED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "Yesterday and today (UTC) — the overview's pipeline window.", label: "since yesterday (UTC)" },
    numerator: { description: "Failed = FAILED − recovered + PARTIAL executions in the window (derivePipeline).", source: { module: "lib/platform/ops/overview-core.ts", symbol: "derivePipeline" } },
    denominator: { description: "Attempted = failed + succeeded executions.", source: { module: "lib/platform/ops/overview-core.ts", symbol: "derivePipeline" } },
    compute: { module: "lib/platform/refresh/projections.ts", symbol: "getPipelineStatus" },
    path: [
      { file: "app/api/platform/platform-ops/overview/route.ts", calls: "getOperationsOverview" },
      { file: "lib/platform/ops/overview.ts", calls: "getPipelineStatus" },
    ],
    inclusion: ["RefreshExecution rows started yesterday or today (UTC)"],
    exclusion: ["The executions themselves (ids, sources, owners — never retrieved)"],
    freshnessSource: "RefreshExecution ledger, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The window is calendar days, not a rolling 24 h", "UNAVAILABLE when the overview could not judge the pipeline"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/overview/route.ts" }],
    tiles: [{ component: "components/platform/leads/operations-model.ts", reads: "o?.domains.find((x) => x.key === key)" }],
    drill: { api: "/api/platform/platform-ops/overview", page: `${page(PO)}?view=pipeline` },
  },
  {
    id: "scheduled-job-health", version: 1, domain: "operations",
    label: "Scheduled job health",
    summary: "Registered scheduled jobs by health status (healthy, running, overdue, failing, dead, never ran, skipped, not scheduled here). Jobs that are not healthy are named by their registry job name.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Each job's current status from the JobRun ledger and its resolved cadence." },
    numerator: { description: "Jobs per JobHealthStatus (the job-health route's own counts).", source: { module: "lib/jobs/health.ts", symbol: "checkScheduledJobHealth" } },
    denominator: { description: "Every registered scheduled job (SCHEDULED_JOBS).", source: { module: "lib/jobs/registry.ts", symbol: "SCHEDULED_JOBS" } },
    compute: { module: "lib/jobs/health.ts", symbol: "checkScheduledJobHealth" },
    path: [
      { file: "app/api/platform/platform-ops/job-health/route.ts", calls: "checkScheduledJobHealth" },
    ],
    inclusion: ["Every registered scheduled job"],
    exclusion: ["Run rows and failure summaries (never retrieved)"],
    freshnessSource: "JobRun rows (90-day retention), read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["On a deployment with no scheduler (Preview), jobs read not scheduled — neutral, never healthy or failing"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/job-health/route.ts" }],
    tiles: [{ component: "components/platform/leads/operations-model.ts", reads: "c.failing + c.dead" }],
    drill: { api: "/api/platform/platform-ops/job-health", page: `${page(PO)}?view=jobs` },
  },
  {
    id: "data-freshness", version: 1, domain: "operations",
    label: "Data freshness (resources)",
    summary: "Platform data resources (FX rates, security prices, …) by freshness state: fresh, stale, empty, idle, not refreshed here. Resources that are stale or empty are named by their registry id.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Each resource's newest observation against its own cadence, as of the read." },
    numerator: { description: "Resources per FreshnessHealthState.", source: { module: "lib/platform/resource-freshness.ts", symbol: "checkResourceFreshness" } },
    denominator: null,
    compute: { module: "lib/platform/resource-freshness.ts", symbol: "checkResourceFreshness" },
    path: [
      { file: "app/api/platform/platform-ops/resource-freshness/route.ts", calls: "checkResourceFreshness" },
    ],
    inclusion: ["Every registered freshness resource"],
    exclusion: ["Per-customer data freshness (that is connection-health-summary@1)"],
    freshnessSource: "The resources' own newest observations, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Platform reference data only: a customer's own sync freshness is connection-health-summary@1"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/resource-freshness/route.ts" }],
    tiles: [{ component: "components/platform/widgets/platform-health-view.ts", reads: "d.counts.stale + d.counts.empty" }],
    drill: { api: "/api/platform/platform-ops/resource-freshness", page: `${page(PO)}?workspace=platform-providers` },
  },

  // ── economics ──────────────────────────────────────────────────────────────
  {
    id: "ai-fleet-spend-status", version: 1, domain: "economics",
    label: "AI fleet spend vs budget (24 h)",
    summary: "How priced the fleet's rolling 24-hour customer AI spend is, and what share of the fleet alert threshold it uses. A budget check over 24 hours, not a cost breakdown: for what the platform is costing, read economics-operating-cost@1 and economics-ai-cost@1.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Trailing BUDGET_WINDOW_HOURS (24 h) from the reader's now.", label: "in the last 24 hours", source: { module: "lib/platform/ai/ai-budget.ts", symbol: "BUDGET_WINDOW_HOURS" } },
    numerator: { description: "Σ rate-card-priced spend of customer-surface AiInvocations in the window (a lower bound when some are unpriced).", source: { module: "lib/platform/ai/fleet-spend-status.ts", symbol: "fleetSpendStatus" } },
    denominator: { description: "The fleet alert threshold (USD). 0 or unset is NO threshold: utilisation is null, never 0%.", source: { module: "lib/platform/ai/fleet-spend-status.ts", symbol: "NO_THRESHOLD" } },
    compute: { module: "lib/platform/ai/fleet-spend-status.ts", symbol: "fleetSpendStatus" },
    path: [
      // The route serves the utilisation payload; the tiles fold it through
      // fleetSpendStatus (client-side, the same pure function) — see `tiles`.
      { file: "app/api/platform/platform-ops/ai-budget/route.ts", calls: "loadAiBudgetUtilization" },
    ],
    inclusion: ["Customer-surface AiInvocation rows in the window"],
    exclusion: ["Overhead surfaces (harness, operator)", "Unpriced calls are COUNTED, never priced at $0"],
    freshnessSource: "AiInvocation rows (90-day retention), read on request",
    provenance: { class: "ESTIMATED", note: "Rate-card estimate. MEASURED (invoice) is never produced: no AI invoice is read anywhere." },
    coverageGaps: ["UNAVAILABLE (no figure, never $0) when nothing in the window could be priced", "PARTIAL figures are lower bounds"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/ai-budget/route.ts" }],
    tiles: [
      { component: "components/platform/widgets/ai-budget-view.ts", reads: "fleetSpendStatus(b)" },
      { component: "components/platform/leads/ai-costs-model.ts", reads: "fleetSpendStatus(b)" },
    ],
    drill: { api: "/api/platform/platform-ops/ai-budget/calls", page: page(PO) },
  },

  // Economics › Overview and AI & Costs figures (Platform AI cost metrics). Each one
  // wraps the reader its tile reads; none depends on OD-1 (the engaged-customer
  // definition): per-customer and cost-per-customer figures are NOT registered, and
  // revenue / margin stay unregistered (no billing source). Every dollar is a
  // rate-card ESTIMATE, never a bill.
  {
    id: "economics-ai-cost", version: 1, domain: "economics",
    label: "Estimated AI cost (7 / 30 / 90 d)",
    summary: "Estimated AI spend (cost) over the last 7, 30 or 90 UTC days, every surface: the invocation ledger's RETURNED calls priced by the code-owned rate card. An estimate, never a bill.",
    answerClass: "CALCULATED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "The last 7, 30 or 90 UTC calendar days ending today (window=30 default, or 7 or 90).", label: "in the last 30 days", source: { module: "lib/platform/economics/snapshot-core.ts", symbol: "TREND_WINDOWS" }, days: [30, 7, 90] },
    numerator: { description: "Σ rate-card-priced cost of RETURNED AiInvocation rows per (model, UTC day) in the window; days with unpriced calls make it a lower bound.", source: { module: "lib/platform/economics/snapshot-core.ts", symbol: "aiDayRows" } },
    denominator: null,
    compute: { module: "lib/platform/economics/snapshot-core.ts", symbol: "aiCostFigure" },
    path: [
      { file: "app/api/platform/platform-ops/economics/route.ts", calls: "getEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot.ts", calls: "buildEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot-core.ts", calls: "aiCostFigure" },
    ],
    inclusion: ["RETURNED AiInvocation rows on every surface (Conversations, Daily Brief, evaluation, Platform AI, unattributed)"],
    exclusion: ["Failed calls (they cost nothing)", "Unpriced calls are named in coverage, never priced at $0"],
    freshnessSource: "AiInvocation rows (90-day retention), read on request",
    provenance: { class: "ESTIMATED", note: "Rate-card estimate (tokens × code-owned rates). No AI invoice is read anywhere, so no AI dollar figure is ever billed or MEASURED." },
    coverageGaps: ["UNAVAILABLE (no figure, never $0) with no rate card, no calls, or nothing priced in the window", "PARTIAL figures are lower bounds: some days carry unpriced calls", "AI only: Plaid, other providers and infrastructure are not in this figure (economics-operating-cost@1 holds the cycle total)"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/economics/route.ts" }],
    tiles: [{ component: "components/platform/leads/EconomicsOverviewLead.tsx", reads: "s.trend.windows[win]" }],
    drill: { api: "/api/platform/platform-ops/economics/drill?figure=ai_cost", page: `${page(PO)}?workspace=platform-economics`, note: "The figure's per-UTC-day rows (window=7d|30d|90d)." },
  },
  {
    id: "economics-operating-cost", version: 1, domain: "economics",
    label: "Estimated operating cost this cycle (by category)",
    summary: "What the platform is costing this billing cycle, estimated: the total and its categories — AI, providers (Plaid) and infrastructure — exactly as the Economics Overview shows them. The total is the sum of its categories, never a category; for what is costing the most, read largestMeasuredCategory — the largest MEASURED category, computed by the server (ties: the first in declared order). PARTIAL while any component is unmetered (other providers, infrastructure), so a ranking of categories covers only the measured ones.",
    answerClass: "CALCULATED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "The current billing cycle: the calendar month to date (UTC). Fixed — no other window.", label: "this UTC calendar month to date" },
    numerator: { description: "Σ of the operating-cost components that could be priced: AI (customer, overhead, Platform AI) and Plaid Item-months; the parts are the Overview's AI / Providers / Infrastructure split figures.", source: { module: "lib/platform/economics/snapshot-core.ts", symbol: "operatingCostRows" } },
    denominator: null,
    compute: { module: "lib/platform/economics/snapshot-core.ts", symbol: "economicsFigure" },
    path: [
      { file: "app/api/platform/platform-ops/economics/route.ts", calls: "getEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot.ts", calls: "buildEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot-core.ts", calls: "economicsFigure" },
    ],
    inclusion: ["AI (OpenAI, every surface) this cycle", "Plaid Transactions Item-months this cycle"],
    exclusion: ["Revenue and margin (no billing source — not registered)", "Per-customer and cost-per-customer figures (pending owner definition OD-1 — not registered)", "Consented Plaid Investments Item-months not evidenced as billed (named, never priced)"],
    freshnessSource: "AiInvocation rows and the PlaidItem census, read on request",
    provenance: { class: "ESTIMATED", note: "Rate-card estimates (AI tokens × rate card; Plaid Item-months × invoice-derived rate). No invoice is read: never a bill." },
    coverageGaps: ["Always PARTIAL today: other providers and infrastructure (hosting, database) are not metered — their parts are null, never $0", "A ranking of categories is a ranking of the MEASURED ones; the unmetered parts could be larger (largestMeasuredCategory then carries the qualifier \"ranking among measured categories; some categories are incomplete\"; S2 ruling 2026-11-05)", "UNAVAILABLE when no component could be priced"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/economics/route.ts" }],
    tiles: [
      { component: "components/platform/leads/EconomicsOverviewLead.tsx", reads: "s.figures.operating_cost" },
      { component: "components/platform/leads/economics-model.ts", reads: "SPLIT_KEYS.map((k) => s.figures[k])" },
    ],
    drill: { api: "/api/platform/platform-ops/economics/drill?figure=operating_cost&window=cycle", page: `${page(PO)}?workspace=platform-economics`, note: "One row per component: priced, or null with why." },
  },
  {
    id: "economics-provider-cost", version: 1, domain: "economics",
    label: "Estimated provider cost this cycle (Plaid)",
    summary: "Estimated third-party provider cost this billing cycle: Plaid Item-months × the invoice-derived rate. PARTIAL whenever another provider is unmetered (always today), never $0 for an unknown part.",
    answerClass: "CALCULATED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "The current billing cycle: the calendar month to date (UTC). Fixed — no other window.", label: "this UTC calendar month to date" },
    numerator: { description: "Σ priced Plaid product Item-months present during the cycle (Transactions; Investments only when evidenced as billed).", source: { module: "lib/platform/economics/snapshot-core.ts", symbol: "providerCostRows" } },
    denominator: null,
    compute: { module: "lib/platform/economics/snapshot-core.ts", symbol: "economicsFigure" },
    path: [
      { file: "app/api/platform/platform-ops/economics/route.ts", calls: "getEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot.ts", calls: "buildEconomicsSnapshot" },
      { file: "lib/platform/economics/snapshot-core.ts", calls: "economicsFigure" },
    ],
    inclusion: ["PlaidItem census, present during the cycle (sandbox and seeded Items excluded)"],
    exclusion: ["AI (economics-ai-cost@1)", "Other providers — not metered (named, never $0)"],
    freshnessSource: "The PlaidItem census, read on request",
    provenance: { class: "ESTIMATED", note: "Item-months × invoice-derived rate. No provider invoice is read: never a bill." },
    coverageGaps: ["PARTIAL while any provider is unmetered (other providers are not metered today)", "UNAVAILABLE with no Plaid rate card, no cycle census, or nothing priced", "Census caveats (incomplete census, unevidenced product, disagreeing readings) are named in coverage"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/economics/route.ts" }],
    tiles: [{ component: "components/platform/leads/EconomicsOverviewLead.tsx", reads: "f.provider_cost" }],
    drill: { api: "/api/platform/platform-ops/economics/drill?figure=provider_cost&window=cycle", page: `${page(PO)}?workspace=platform-economics` },
  },
  {
    id: "ai-call-outcomes", version: 1, domain: "economics",
    label: "AI calls and error rate (7 / 30 d)",
    summary: "Fleet AI provider calls over the last 7 or 30 days: calls, returned, failed, and the error rate (failed ÷ calls). Counted, not priced.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Trailing 7 or 30 days (7 × 24 h or 30 × 24 h) from the reader's now (window=7 default, or 30).", label: "in the last 7 days", source: { module: "lib/platform/ai/invocations-core.ts", symbol: "AI_WINDOWS" }, days: [7, 30] },
    numerator: { description: "Failed calls: non-RETURNED AiInvocation rows (FAILED, TIMEOUT, RATE_LIMITED, QUOTA).", source: { module: "lib/platform/ai/invocations.ts", symbol: "buildAiFailureCounts" } },
    denominator: { description: "Every call in the window: RETURNED + failed. No call ⇒ the error rate is null, never 0%.", source: { module: "lib/platform/ai/call-stats.ts", symbol: "aiCallStats" } },
    compute: { module: "lib/platform/ai/call-stats.ts", symbol: "aiCallStats" },
    path: [
      // The route serves the AiOperations payload; the AI & Costs tile folds it through aiCallStats (the same pure function).
      { file: "app/api/platform/platform-ops/ai-invocations/route.ts", calls: "getAiOperations" },
    ],
    inclusion: ["AiInvocation rows of every surface in the window, RETURNED and failed"],
    exclusion: ["No per-user, per-Space or per-customer dimension (the fleet reader exposes none)"],
    freshnessSource: "AiInvocation rows (90-day retention), read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Failures are recorded since 2026-10-07; a window reaching before then undercounts them"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/ai-invocations/route.ts" }],
    tiles: [{ component: "components/platform/leads/ai-costs-model.ts", reads: "aiCallStats(i)" }],
    drill: { api: "/api/platform/platform-ops/ai-invocations", page: `${page(PO)}?workspace=platform-economics&view=ai`, note: "The newest invocations (window=7d|30d)." },
  },
  {
    id: "ai-cost-per-call", version: 1, domain: "economics",
    label: "Estimated AI cost per call (7 / 30 d)",
    summary: "Estimated AI cost per RETURNED call over the last 7 or 30 days, fleet-wide: priced spend ÷ returned calls. An aggregate estimate, never per customer and never a bill.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Trailing 7 or 30 days (7 × 24 h or 30 × 24 h) from the reader's now (window=7 default, or 30).", label: "in the last 7 days", source: { module: "lib/platform/ai/invocations-core.ts", symbol: "AI_WINDOWS" }, days: [7, 30] },
    numerator: { description: "Σ rate-card-priced spend of RETURNED calls in the window.", source: { module: "lib/platform/ai/invocations-core.ts", symbol: "buildAiOperations" } },
    denominator: { description: "RETURNED calls in the window (failures cost nothing and are not in the denominator).", source: { module: "lib/platform/ai/call-stats.ts", symbol: "aiCostPerCall" } },
    compute: { module: "lib/platform/ai/call-stats.ts", symbol: "aiCostPerCall" },
    path: [
      { file: "app/api/platform/platform-ops/ai-invocations/route.ts", calls: "getAiOperations" },
    ],
    inclusion: ["RETURNED AiInvocation rows of every surface in the window"],
    exclusion: ["Failed calls", "No per-user, per-Space or per-customer dimension"],
    freshnessSource: "AiInvocation rows (90-day retention), read on request",
    provenance: { class: "ESTIMATED", note: "Tokens × code-owned rate card ÷ returned calls. No AI invoice is read: never a bill." },
    coverageGaps: ["UNAVAILABLE with no rate card, no returned calls, or nothing priced", "PARTIAL (a lower bound) when some tokens had no rate"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/ai-invocations/route.ts" }],
    tiles: [{ component: "components/platform/leads/ai-costs-model.ts", reads: "aiCostPerCall(i)" }],
    drill: { api: "/api/platform/platform-ops/ai-invocations", page: `${page(PO)}?workspace=platform-economics&view=ai` },
  },

  // ── engagement (PB-10) ─────────────────────────────────────────────────────
  {
    id: "presence-state", version: 1, domain: "engagement",
    label: "Customer presence (Active now / Online, idle / Offline)",
    summary: "One customer's presence bucket from the visible-tab heartbeat clocks — presence, never engagement.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "PRESENCE_CONFIG windows from the reader's now (database clock).", label: "right now (presence cut-offs)", source: { module: "lib/presence/definitions.ts", symbol: "PRESENCE_CONFIG" } },
    numerator: { description: "Per customer: the newest presence and interaction clocks across their sessions.", source: { module: "lib/presence/definitions.ts", symbol: "foldPresenceClocks" } },
    denominator: null,
    compute: { module: "lib/presence/definitions.ts", symbol: "derivePresenceState" },
    path: [
      { file: "app/api/platform/customer-success/customers/route.ts", calls: "listCustomers" },
      { file: "lib/platform/customer/customers.ts", calls: "projectActivity" },
      { file: "lib/platform/customer/customer-core.ts", calls: "derivePresenceState" },
    ],
    inclusion: ["UserSession heartbeat clocks (server-stamped)"],
    exclusion: ["UserSession.lastActiveAt (SESSION LAST USED) is never read as activity", "Revoked sessions"],
    freshnessSource: "The UserSession presence and interaction heartbeat clocks (database clock; read only by the PB-10 allowlisted readers)",
    provenance: { class: "MEASURED", note: "The interaction clock is CLIENT-ASSERTED (low trust): presence buckets and the CS 'last active ~' only." },
    coverageGaps: ["An interaction is credited at the next beat's arrival (up to one interval late)", "Must never feed engagement, SEC-010 or any security decision"],
    permission: [{ area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/customers/route.ts" }],
    tiles: [{ component: "components/platform/widgets/CsCustomersWidget.tsx", reads: "presenceLabel" }],
    drill: { api: "/api/platform/customer-success/customers", page: page(CS) },
  },
  {
    id: "engaged-users", version: 1, domain: "engagement",
    label: "Engaged users (DAU / WAU / MAU)",
    summary: "Distinct users with at least one MEANINGFUL ENGAGEMENT fact (server-side product events or customer AI turns) in the trailing 1 / 7 / 30 UTC days.",
    answerClass: "OBSERVED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "Trailing 1 / 7 / 30 UTC calendar days (ENGAGEMENT_WINDOW_DAYS); Growth's tile shows the 30-day figure.", label: "in the last 30 days", source: { module: "lib/presence/definitions.ts", symbol: "ENGAGEMENT_WINDOW_DAYS" }, days: [30, 7, 1] },
    numerator: { description: "Distinct users with an engagement day inside the window.", source: { module: "lib/platform/growth/product-analytics-core.ts", symbol: "engagementDays" } },
    denominator: null,
    compute: { module: "lib/platform/growth/product-analytics-core.ts", symbol: "activeUsers" },
    path: [
      { file: "app/api/platform/growth-revenue/product-analytics/route.ts", calls: "getProductAnalytics" },
      { file: "lib/platform/growth/product-analytics.ts", calls: "buildProductAnalytics" },
      { file: "lib/platform/growth/product-analytics-core.ts", calls: "activeUsers" },
    ],
    inclusion: ["ENGAGEMENT_AUDIT_ACTIONS AuditLog rows", "AiInvocation on ENGAGEMENT_AI_SURFACES with a userId"],
    exclusion: ["Background sync, cron, webhooks, polling, prefetch, heartbeats", "SESSION_ACTIVE_DAY (that is presence)", "Operator actions on a customer; harness AI runs"],
    freshnessSource: "AuditLog product events (13-month retention) and AiInvocation (90-day retention)",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Feature use outside Space, Brief and Transactions is not measured", "AI turns older than 90 days are not visible", "PENDING OWNER DEFINITION: operators (OD-2), accounts deactivated since (OD-3) and test accounts (OD-4) are all counted today; the policies are named UNDECIDED in lib/platform/customer/population.ts"],
    permission: [{ area: GR, level: "READ", identityTier: "OPS", route: "app/api/platform/growth-revenue/product-analytics/route.ts" }],
    tiles: [{ component: "components/platform/leads/growth-model.ts", reads: "p.active.monthly.engaged" }],
    drill: { unavailable: "No per-user records route on Growth (identity-free by design); the navigation registry (foundation step 3) owns any drill." },
  },

  // ── growth ─────────────────────────────────────────────────────────────────
  {
    id: "growth-registrations", version: 1, domain: "growth",
    label: "Registrations",
    summary: "Accounts created per UTC day in the selected 30- or 90-day window, and their total.",
    answerClass: "OBSERVED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "The last 30 or 90 UTC days (?window=30|90).", label: "in the last 90 days", days: [90, 30] },
    numerator: { description: "User rows by User.createdAt UTC day inside the window.", source: { module: "lib/platform/growth/acquisition-core.ts", symbol: "buildAcquisition" } },
    denominator: null,
    compute: { module: "lib/platform/growth/acquisition-core.ts", symbol: "buildAcquisition" },
    path: [
      { file: "app/api/platform/growth-revenue/acquisition/route.ts", calls: "getAcquisition" },
      { file: "lib/platform/growth/acquisition.ts", calls: "buildAcquisition" },
    ],
    inclusion: ["Every User row (the same user set the product analytics use)"],
    exclusion: [],
    freshnessSource: "User.createdAt, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["A day before the source began, or past its retention edge, is null (declared, never inferred)", "No geography (no country recorded at registration)"],
    permission: [{ area: GR, level: "READ", identityTier: "OPS", route: "app/api/platform/growth-revenue/acquisition/route.ts" }],
    tiles: [{ component: "components/platform/leads/growth-model.ts", reads: "a.registrations.total" }],
    drill: { api: "/api/platform/growth-revenue/users", page: page(GR), note: "Growth users list (GROWTH_REVENUE)." },
  },

  // ── incidents (PB-1) ───────────────────────────────────────────────────────
  {
    id: "incident-broken-now", version: 1, domain: "incidents",
    label: "Broken now (incidents)",
    summary: "Incident rows whose derived state is active, acknowledged or recovering — counted as broken right now.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Unresolved incidents as of the reader's now; staleness windows from STALE_WINDOWS_MS.", source: { module: "lib/platform/incidents/intelligence/staleness.ts", symbol: "STALE_WINDOWS_MS" } },
    numerator: { description: "Verdicts with brokenNow = true (row class incident, state active / acknowledged / recovering; duplicates folded).", source: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" } },
    denominator: null,
    compute: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" },
    path: [
      { file: "app/api/platform/platform-ops/incidents/route.ts", calls: "incidentAccessors.search" },
      { file: "lib/platform/incidents/intelligence/index.ts", calls: "deriveIncidentVerdicts" },
    ],
    inclusion: ["Unresolved SyncIssue rows (scan capped at DEFAULT_SCAN_LIMIT)"],
    exclusion: ["A stale-unverified row (no attempt or skip since it last occurred) is NOT broken now", "Events (non-incident row classes)", "Duplicate rows of one episode (folded onto the newest)"],
    freshnessSource: "SyncIssue.lastOccurredAt and RefreshEndpointResult attempt / skip evidence",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The scan is capped (DEFAULT_SCAN_LIMIT); a capped read is a floor", "Stale windows are proposed defaults pending owner confirmation (Q2)"],
    permission: [
      { area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/incidents/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/incidents/route.ts" },
    ],
    tiles: [
      { component: "lib/platform/customer/customer-core.ts", reads: "issues.filter((i) => i.brokenNow)" },
      { component: "components/platform/widgets/CsCustomersWidget.tsx", reads: "detail.incidents.open.length" },
      // The incidents workspace's "Broken now" view: its list total (Ops and CS leads alike).
      { component: "components/platform/incidents/IncidentsLead.tsx", reads: "incidentTotalText(list.data)" },
    ],
    // Per surface: each tier drills to its own incidents route and the "Broken now" view
    // (the navigation registry resolves both pages to the same href — pinned).
    drill: {
      bySurface: {
        PLATFORM_OPS: { api: "/api/platform/platform-ops/incidents", page: `${page(PO)}?workspace=platform-incidents` },
        CUSTOMER_SUCCESS: { api: "/api/platform/customer-success/incidents", page: `${page(CS)}?workspace=platform-incidents&view=open` },
      },
    },
  },
  {
    id: "incident-alertable", version: 1, domain: "incidents",
    label: "Alertable (critical alert eligibility)",
    summary: "Broken-now incidents that are current (not stale) and not recovering — eligible for the critical alert.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "As broken-now, with freshness = current inside STALE_WINDOWS_MS.", source: { module: "lib/platform/incidents/intelligence/staleness.ts", symbol: "STALE_WINDOWS_MS" } },
    numerator: { description: "Verdicts with alertable = brokenNow AND freshness current AND state not recovering.", source: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" } },
    denominator: null,
    compute: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" },
    path: [
      { file: "app/api/platform/platform-ops/incidents/route.ts", calls: "incidentAccessors.search" },
      { file: "lib/platform/incidents/intelligence/index.ts", calls: "deriveIncidentVerdicts" },
    ],
    inclusion: ["Broken-now verdicts"],
    exclusion: ["Unverified (stale) rows", "Recovering rows"],
    freshnessSource: "SyncIssue.lastOccurredAt and RefreshEndpointResult attempt / skip evidence",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The scan is capped (DEFAULT_SCAN_LIMIT)"],
    permission: [
      { area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/incidents/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/incidents/route.ts" },
    ],
    tiles: [{ component: "components/platform/incidents/incidents-model.ts", reads: "r.alertable" }],
    drill: { api: "/api/platform/platform-ops/incidents", page: page(PO) },
  },
  {
    id: "incident-needs-verification", version: 1, domain: "incidents",
    label: "Needs verification (incidents)",
    summary: "Unresolved incidents whose derived state is stale-unverified: nothing has attempted or skipped the work since they last occurred, so whether they are still broken is unknown. Shown separately; never alerts.",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "As of the reader's now; staleness windows from STALE_WINDOWS_MS.", source: { module: "lib/platform/incidents/intelligence/staleness.ts", symbol: "STALE_WINDOWS_MS" } },
    numerator: { description: "Incident-class verdicts matching the needs-verification preset (state stale-unverified).", source: { module: "lib/platform/incidents/intelligence/search-core.ts", symbol: "matchesStatus" } },
    denominator: null,
    compute: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" },
    path: [
      { file: "app/api/platform/platform-ops/incidents/route.ts", calls: "incidentAccessors.search" },
      { file: "lib/platform/incidents/intelligence/index.ts", calls: "deriveIncidentVerdicts" },
    ],
    inclusion: ["Unresolved SyncIssue rows (scan capped at DEFAULT_SCAN_LIMIT)"],
    exclusion: ["Broken-now incidents (incident-broken-now@1)", "Events and duplicate rows (folded)"],
    freshnessSource: "SyncIssue.lastOccurredAt and RefreshEndpointResult attempt / skip evidence",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The scan is capped (DEFAULT_SCAN_LIMIT); a capped read is a floor (PARTIAL)", "Stale windows are proposed defaults pending owner confirmation (Q2)"],
    permission: [
      { area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/incidents/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/incidents/route.ts" },
    ],
    tiles: [{ component: "components/platform/incidents/incidents-model.ts", reads: "export function incidentTotalText" }],
    drill: {
      bySurface: {
        PLATFORM_OPS: { api: "/api/platform/platform-ops/incidents", page: `${page(PO)}?workspace=platform-incidents&view=verify` },
        CUSTOMER_SUCCESS: { api: "/api/platform/customer-success/incidents", page: `${page(CS)}?workspace=platform-incidents&view=verify` },
      },
    },
  },
  {
    id: "incident-resolved-window", version: 1, domain: "incidents",
    label: "Resolved incidents last seen in the last 1 / 7 / 30 days",
    summary: "Resolved or archived incidents whose LAST OCCURRENCE falls in the window (the History preset filtered to the window's UTC days on last seen) — NOT incidents resolved in the window: one last seen earlier and resolved inside the window is not counted.",
    answerClass: "CALCULATED",
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "UTC days from (today − (N − 1)) through today, on lastSeenAt — not on resolvedAt (window=7 default, or 1 or 30).", label: "last seen in the last 7 days", days: [7, 1, 30] },
    numerator: { description: "Incident-class verdicts in state resolved or archived whose lastSeenAt falls in the window.", source: { module: "lib/platform/incidents/intelligence/search-core.ts", symbol: "matchesStatus" } },
    denominator: null,
    compute: { module: "lib/platform/incidents/intelligence/core.ts", symbol: "deriveIncidentVerdicts" },
    path: [
      { file: "app/api/platform/platform-ops/incidents/route.ts", calls: "incidentAccessors.search" },
      { file: "lib/platform/incidents/intelligence/index.ts", calls: "deriveIncidentVerdicts" },
    ],
    inclusion: ["Resolved and archived incident rows (the archive's retention)"],
    exclusion: ["Open incidents", "Events and duplicate rows (folded)"],
    freshnessSource: "SyncIssue rows and the incident archive",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The scan is capped (DEFAULT_SCAN_LIMIT); a capped read is a floor (PARTIAL)", "Keyed on last seen, not on the resolution instant: an incident resolved in the window but last seen before it is not counted"],
    permission: [
      { area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/incidents/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/incidents/route.ts" },
    ],
    tiles: [{ component: "components/platform/incidents/incidents-model.ts", reads: "export function incidentTotalText" }],
    drill: {
      bySurface: {
        PLATFORM_OPS: { api: "/api/platform/platform-ops/incidents", page: `${page(PO)}?workspace=platform-incidents&view=history` },
        CUSTOMER_SUCCESS: { api: "/api/platform/customer-success/incidents", page: `${page(CS)}?workspace=platform-incidents&view=history` },
      },
    },
  },

  // ── merchants (PB-9) ───────────────────────────────────────────────────────
  {
    id: "merchant-identity-linked", version: 1, domain: "merchants",
    label: "Merchant identity linked share",
    summary: "The share of live transactions linked to a canonical merchant, displayed floored to two decimals (never rounds up to 100%).",
    answerClass: "OBSERVED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "All live transactions as of the read." },
    numerator: { description: "Live transactions with a merchant link (coverage.linked).", source: { module: "lib/platform/merchant/records.ts", symbol: "readIdentityCoverage" } },
    denominator: { description: "Live transactions (coverage.live).", source: { module: "lib/platform/merchant/records.ts", symbol: "readIdentityCoverage" } },
    compute: { module: "lib/platform/merchant/records.ts", symbol: "readIdentityCoverage" },
    path: [
      { file: "app/api/platform/merchant-ops/overview/route.ts", calls: "getMerchantOverview" },
      { file: "lib/platform/merchant/overview.ts", calls: "readMerchantIdentityKpis" },
      { file: "lib/platform/merchant/records.ts", calls: "readIdentityCoverage" },
    ],
    inclusion: ["Live (not soft-deleted) transactions"],
    exclusion: ["Unlinked rows split by class: TRANSFER, WALLET and NO_COUNTERPARTY are legitimate exclusions; only ELIGIBLE is actionable (classifyIdentity)"],
    freshnessSource: "Transaction rows, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["The headline share counts every live row; the actionable share is eligibleLinked / eligible"],
    permission: [{ area: MO, level: "READ", identityTier: "OPS", route: "app/api/platform/merchant-ops/overview/route.ts" }],
    tiles: [{ component: "components/platform/leads/merchant-model.ts", reads: "formatCoveragePct(m.transactions.resolved, m.transactions.total)" }],
    drill: { api: "/api/platform/merchant-ops/records", page: page(MO) },
  },

  // ── customers (PB-4) ───────────────────────────────────────────────────────
  {
    id: "cs-needs-help", version: 1, domain: "customers",
    label: "Customers who need help",
    summary: "Distinct ACTIVE customers with at least one help reason (reconnect, active incident, broken policy group, unassigned under fail-closed, stalled before first connection).",
    answerClass: "CALCULATED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Current state; 'stalled' uses ABANDONMENT_HORIZON_DAYS since registration.", source: { module: "lib/platform/growth/product-analytics-core.ts", symbol: "ABANDONMENT_HORIZON_DAYS" } },
    numerator: { description: "The union of the per-reason customer sets (each customer counted once).", source: { module: "lib/platform/customer/attention-core.ts", symbol: "foldAttention" } },
    denominator: { description: "Open (not deactivated) role-USER customer accounts — the only population that can need help (open-customers@1).", source: { module: "lib/platform/customer/attention-core.ts", symbol: "foldAttention" } },
    compute: { module: "lib/platform/customer/attention-core.ts", symbol: "foldAttention" },
    path: [
      { file: "app/api/platform/customer-success/overview/route.ts", calls: "getCsOverview" },
      { file: "lib/platform/customer/overview.ts", calls: "buildCsOverview" },
      { file: "lib/platform/customer/overview-core.ts", calls: "foldAttention" },
    ],
    inclusion: ["ATTENTION_KEYS reasons, in display order", "'unassigned' only while the fail-closed policy switch is ENFORCED"],
    exclusion: ["Deactivated accounts and operators", "A customer with NO policy assignment (resolves to the default and works)"],
    freshnessSource: "Connection health, SyncIssue, policy assignments and the funnel facts, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["A capped read reports 'at least' (floor)", "PENDING OWNER DEFINITION of the customer population (OD-2 operators, OD-4 test accounts); the denominator is open-customers@1"],
    permission: [{ area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/overview/route.ts" }],
    tiles: [{ component: "components/platform/leads/CustomerSuccessLead.tsx", reads: "o.attention.customers" }],
    drill: { api: "/api/platform/customer-success/customers?attention=any", page: page(CS), note: "Each reason drills to attention=<key>: the same fold, so the count and the list agree." },
  },
  {
    id: "open-customers", version: 1, domain: "customers",
    label: "Open customer accounts",
    summary: "Customer (role USER) accounts that are open now: not deactivated — pending deletion also stamps deactivatedAt, so a deletion-scheduled account is not open.",
    answerClass: "OBSERVED",
    window: { kind: "POINT_IN_TIME", timezone: "UTC", description: "Current account state as of the read." },
    numerator: { description: "User rows matching OPEN_CUSTOMER_WHERE (role USER ∧ deactivatedAt IS NULL) — the one shared predicate (lib/platform/customer/population.ts).", source: { module: "lib/platform/customer/population.ts", symbol: "OPEN_CUSTOMER_WHERE" } },
    denominator: null,
    compute: { module: "lib/platform/customer/overview-core.ts", symbol: "buildCsOverview" },
    path: [
      { file: "app/api/platform/customer-success/overview/route.ts", calls: "getCsOverview" },
      { file: "lib/platform/customer/overview.ts", calls: "buildCsOverview" },
    ],
    inclusion: ["role USER accounts with deactivatedAt IS NULL", "role-USER PlatformGrant holders (operators are distinguished only by SYSTEM_ADMIN role today)"],
    exclusion: ["SYSTEM_ADMIN accounts (by role)", "Deactivated accounts, including those scheduled for deletion"],
    freshnessSource: "User rows, read on request",
    provenance: { class: "MEASURED", note: "PENDING OWNER DEFINITION (OD-2: whether operators count as customers; OD-4: whether test and internal accounts are excluded). Counted as today until decided — the policies are named UNDECIDED in lib/platform/customer/population.ts." },
    coverageGaps: ["The fleet read is capped (ATTENTION_SCAN_CAP); a capped read is a floor", "No test-account flag exists, so test and internal accounts are counted (OD-4)"],
    permission: [{ area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/overview/route.ts" }],
    tiles: [{ component: "components/platform/leads/customer-success-model.ts", reads: "o.customers.active" }],
    drill: { api: "/api/platform/customer-success/customers", page: page(CS), note: "The Customers list shows every account; its population line counts the open customer accounts among the rows shown." },
  },

  // ── security (SEC-010) ─────────────────────────────────────────────────────
  {
    id: "live-sessions", version: 1, domain: "security",
    label: "Live sessions",
    summary: "A SESSION count (UserSession rows, never accounts): sessions that can still authenticate now: not revoked, inside the SEC-010 idle and absolute lifetime, and owned by an open account (not deactivated, not scheduled for deletion).",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Idle and absolute cut-offs measured back from the reader's now (SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_LIFETIME_MS).", label: "live now (session cut-offs)", source: { module: "lib/auth/session-proof.ts", symbol: "SESSION_IDLE_TIMEOUT_MS" } },
    numerator: { description: "Sessions matching liveSessionWhere(now): revokedAt IS NULL ∧ createdAt ≥ now − absolute ∧ lastActiveAt ≥ now − idle ∧ owner not locked out.", source: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" } },
    denominator: null,
    compute: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" },
    path: [
      { file: "app/api/platform/security-ops/sessions/route.ts", calls: "countLiveSessions" },
      { file: "lib/platform/security/live-sessions.ts", calls: "liveSessionWhere" },
    ],
    inclusion: ["Non-revoked sessions inside both lifetimes", "Owner deactivatedAt IS NULL ∧ deletionScheduledAt IS NULL"],
    exclusion: ["Revoked sessions", "Idle- or absolute-expired rows that were never revoked", "Sessions of deactivated or deletion-scheduled accounts"],
    freshnessSource: "UserSession rows, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["A live session is NOT proof a browser is open (that is presence-state@1)", "Counts SESSIONS: one account with two devices is 2. The per-account figure is accounts-with-live-session@1"],
    permission: [
      { area: "SECURITY_OPS", level: "READ", identityTier: "OPS", route: "app/api/platform/security-ops/sessions/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/customers/[userId]/route.ts" },
    ],
    tiles: [
      { component: "components/platform/widgets/security-posture-view.ts", reads: "d.totalActive" },
      { component: "components/platform/widgets/CsCustomersWidget.tsx", reads: "detail.activity.activeSessions" },
    ],
    drill: { api: "/api/platform/security-ops/sessions", page: page("SECURITY_OPS"), note: "The newest live sessions as browser · device · OS — a bounded page, never a session id or token." },
  },
  {
    id: "accounts-with-live-session", version: 1, domain: "security",
    label: "Accounts with a live session",
    summary: "An ACCOUNT count: distinct customer (role USER) accounts holding at least one live session (live-sessions@1's rule) now.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "As live-sessions@1: idle and absolute cut-offs measured back from the reader's now.", label: "live now (session cut-offs)", source: { module: "lib/auth/session-proof.ts", symbol: "SESSION_IDLE_TIMEOUT_MS" } },
    numerator: { description: "Distinct userId over sessions matching liveSessionWhere(now, { userWhere: CUSTOMER_WHERE }) (a groupBy by userId).", source: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" } },
    denominator: null,
    compute: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" },
    path: [
      { file: "app/api/platform/growth-revenue/users/route.ts", calls: "countAccountsWithLiveSession" },
      { file: "lib/platform/security/live-sessions.ts", calls: "liveSessionWhere" },
    ],
    inclusion: ["role USER accounts with ≥ 1 live session"],
    exclusion: ["SYSTEM_ADMIN accounts (by role)", "Accounts whose every session is revoked or expired", "Deactivated or deletion-scheduled accounts (the session lockout)"],
    freshnessSource: "UserSession rows, read on request",
    provenance: { class: "MEASURED", note: "Customer population PENDING OWNER DEFINITION (OD-2 operators, OD-4 test accounts); counted as role USER until decided (lib/platform/customer/population.ts)." },
    coverageGaps: ["A live session is NOT proof a browser is open (that is presence-state@1)"],
    permission: [{ area: GR, level: "READ", identityTier: "OPS", route: "app/api/platform/growth-revenue/users/route.ts" }],
    tiles: [{ component: "components/platform/widgets/OpsUsersWidget.tsx", reads: "data.withLiveSession" }],
    drill: { unavailable: "Growth is identity-free by design: no per-account records route; Customer Success owns per-customer session detail." },
  },
];

// ── Structural rules (pure; registry.test.ts runs them over METRICS) ─────────

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** Every structural problem with one definition ([] = sound). Source pins live in the test. */
export function metricDefinitionProblems(m: MetricDefinition): string[] {
  const p: string[] = [];
  const k = `${m.id}@${m.version}`;
  if (!ID_RE.test(m.id)) p.push(`${k}: id must be kebab-case`);
  if (!Number.isInteger(m.version) || m.version < 1) p.push(`${k}: version must be an explicit integer ≥ 1`);
  if (!m.label.trim() || !m.summary.trim()) p.push(`${k}: label and summary are required`);
  if (m.window.timezone !== "UTC" || !m.window.description.trim()) p.push(`${k}: window needs a UTC timezone and a description`);
  if (m.window.kind !== "POINT_IN_TIME" && !m.window.label?.trim()) p.push(`${k}: a ${m.window.kind} window needs a label (the phrase stated beside its figures)`);
  if (!m.numerator.description.trim()) p.push(`${k}: numerator needs a description`);
  if (m.denominator && !m.denominator.description.trim()) p.push(`${k}: denominator needs a description`);
  if (m.path.length === 0) p.push(`${k}: path must name at least the route hop`);
  if (!m.freshnessSource.trim()) p.push(`${k}: freshnessSource is required`);
  if (m.permission.length === 0) p.push(`${k}: at least one permission is required`);
  for (const e of m.permission) {
    if (!e.area || !e.level) p.push(`${k}: a permission needs an area and a level`);
    if (e.identityTier !== "OPS" && e.identityTier !== "CUSTOMER_SUCCESS") p.push(`${k}: a permission needs an identity tier`);
    if (e.identityTier === "CUSTOMER_SUCCESS" && e.area !== "CUSTOMER_SUCCESS") p.push(`${k}: customer identity is allowed only under CUSTOMER_SUCCESS`);
  }
  if (m.provenance.class === "UNAVAILABLE" && !m.provenance.reason?.trim()) p.push(`${k}: UNAVAILABLE provenance must carry a reason`);
  if (m.provenance.class === "ESTIMATED" && !m.provenance.note?.trim()) p.push(`${k}: ESTIMATED provenance must say what is estimated`);
  if (m.tiles.length === 0 && m.provenance.class !== "UNAVAILABLE") p.push(`${k}: a computed metric names the tile that shows it`);
  if ("unavailable" in m.drill ? !m.drill.unavailable.trim() : drillLinks(m.drill).length === 0 || drillLinks(m.drill).some((l) => !l.api.startsWith("/api/platform/"))) p.push(`${k}: drill is a /api/platform/ records route or a stated reason`);
  if ("bySurface" in m.drill) for (const a of Object.keys(m.drill.bySurface)) if (!m.permission.some((e) => e.area === a)) p.push(`${k}: a per-surface drill on ${a} needs a permission entry there`);
  return p;
}

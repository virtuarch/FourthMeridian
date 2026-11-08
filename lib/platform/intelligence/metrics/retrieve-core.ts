/**
 * lib/platform/intelligence/metrics/retrieve-core.ts  (Platform Intelligence — Phase 3 retrieval contracts, slice 1)
 *
 * THE RETRIEVAL CONTRACT: one registered metric's VALUE, as a uniform,
 * identity-free envelope, read through the SAME reader the Platform tile reads.
 * Design: docs/plans/PLATFORM-INTELLIGENCE.md ("Phase 3 slice 1 — LANDED").
 *
 * This file is the pure core: the per-metric table, the surface tiering and the
 * projections. It never names a database. `./retrieve.ts` binds the readers to
 * the real functions each definition's `path` names (getProviderHealth,
 * loadAiBudgetUtilization, …); the tests bind fixtures. There is no parallel
 * query anywhere: a projection only picks the figure the tile already shows out
 * of the reader's own payload, using the tile's own function where it has one
 * (fleetSpendStatus for the AI budget).
 *
 * AUTHORITY — NO NEW MINT PATHS (S2 condition 1)
 *   The caller's route builds a RetrievalContext from its OWN guard result:
 *   `{ metricToken: metricAccessFor(auth), incidentToken: incidentAudienceFor(auth) }`.
 *   This module never issues a MetricAccessToken and never calls
 *   incidentAudienceFor (pinned). The only token it ever derives is the
 *   DOWNGRADE `atOpsTier(incidentToken)` — the PB-1 helper that turns an
 *   identity-bearing incident token into the identity-free one.
 *
 * SURFACE TIERING — atSurface(surface, token, metric)  (S2 conditions 2 + 3)
 *   `surface` is the Platform area whose page the value is shown on. It is a
 *   SERVER-SIDE STRING LITERAL at every call site (`retrieveMetric("PLATFORM_OPS", …)`),
 *   never a request parameter — pinned by a source scan over the repository.
 *   (The surface is the FIRST argument so the scan reads it unambiguously.)
 *   The effective identity tier is DOWNGRADE-ONLY, per metric:
 *       min(token tier on that surface, surface tier, the metric's identity tier
 *           in its permission entry for that surface)
 *   where OPS < CUSTOMER_SUCCESS. A metric with no permission entry for the
 *   surface is not served there (null). A System Admin's break-glass token
 *   holds every area, so on an Ops surface it is re-tiered to OPS — the
 *   metric-level twin of `atOpsTier` (access.ts ⚠️ header).
 *
 * NO EXISTENCE ORACLE
 *   A forged / unissued token, an unknown id, an invisible metric and a metric
 *   not served on the surface all return `null` from the same branch, before
 *   any reader runs (same code path, no I/O — the same timing class).
 *
 * AGGREGATES ONLY (S2 condition 4)
 *   `value` is a number, null, or a small fixed object of numbers (each entry a
 *   finite number or null). `assertAggregate` refuses anything else at runtime
 *   (the envelope becomes UNAVAILABLE). The one structured entry is a declared
 *   RANKING part (S2 ruling 2026-11-05, PartRole below): computed HERE from the
 *   projection's own category parts, never by a projection, and its strings are
 *   registry / module text (a declared category label, the window label, the
 *   fixed RANKING_QUALIFIER). No per-user row, no identifier, no
 *   label from a payload ever enters the envelope: every string in it comes
 *   from the registry or from this module. Per-row and per-subject readers are
 *   NOT_RETRIEVABLE with a stated reason (the table below), and a permission
 *   entry whose route is per-subject (a `[param]` segment) is never served as a
 *   fleet value (isFleetEntry): that surface reads null.
 *
 * HONEST ABSENCE (S2 condition 6; the Economics status vocabulary)
 *   MEASURED · ESTIMATED · PARTIAL (a floor / lower bound, reason + missing) ·
 *   UNAVAILABLE (value null + reason). A failing reader is UNAVAILABLE with a
 *   reason, never 0 or $0.
 *
 * DRILL = a descriptor, never data (S2 condition 5): `{ figure, window, href, page }`
 * pointing at the registry's existing permissioned records route — and only
 * when the drill route's own gate is the surface the value is read on. On any
 * other surface `drill` is null with `drillReason: "no drill on this surface"`
 * (e.g. incident-broken-now on Customer Success: its drill is a Platform Ops route).
 *
 * NO SIDE EFFECTS (S2 condition 8): no writes, no caching, no module state.
 *
 * FUTURE ROUTE (not in this slice): GET only, `Cache-Control: no-store`, and
 * guarded by the metric's OWN permission entry for the surface
 * (`requirePlatformAccess(area, level)`), building the context from that guard
 * result. Any AI / chat caller goes through this same contract and the same
 * atSurface — there is no bypass and no AI-only reader.
 */

import type { PlatformArea } from "@prisma/client";
import { describeMetric, isMetricAccessToken, type MetricAccessToken } from "./access";
import { daysWindowLabel, drillLinkOn, hoursWindowLabel, metricKey, type IdentityTier, type MetricDefinition, type MetricPermission } from "./registry";
import { assertAudienceToken, atOpsTier, type CsToken, type OpsToken } from "@/lib/platform/incidents/intelligence/audience";
import { DEFAULT_SEARCH } from "@/lib/platform/incidents/intelligence/search-core";
import type { IncidentSearchQuery, IncidentSearchResult } from "@/lib/platform/incidents/intelligence/types";
import { fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import type { AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import type { ProviderHealthResult } from "@/lib/platform/provider-health";
import type { AcquisitionResponse } from "@/lib/platform/growth/acquisition-types";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import type { MerchantOverviewResponse } from "@/lib/platform/merchant/overview-types";
import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";
import type { LiveSessionCounts } from "@/lib/platform/security/live-sessions";
import type { EconomicsFigure, EconomicsSnapshot, TrendWindow } from "@/lib/platform/economics/snapshot-core";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import { aiCallStats, aiCostPerCall } from "@/lib/platform/ai/call-stats";
import { NO_EVALUABLE_PROVIDER } from "@/lib/platform/verdicts/provider-outcome";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import type { DomainState, DomainStatus } from "@/lib/platform/ops/overview-core";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";
import { firingNow, latestAlertEvaluation, notEvaluableNow, unavailableAlertSources } from "@/lib/alerts/latest-evaluation";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import { isUpdateModeFixable } from "@/lib/plaid/reauth-codes";
import type { ScheduledJobsHealth } from "@/lib/jobs/health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The Economics status vocabulary (lib/platform/economics/snapshot-core.ts EconomicsStatus). */
export type RetrievalStatus = "MEASURED" | "ESTIMATED" | "PARTIAL" | "UNAVAILABLE";

/**
 * WHY an envelope is UNAVAILABLE — a CLOSED enum, one code per path in
 * retrieveWith / envelope() that yields UNAVAILABLE (pinned path by path in
 * retrieve.test.ts). A code, never text: the reason TEXT stays in `reason`.
 *   NOT_RETRIEVABLE    — no retrieval contract, or the metric is listed NOT_RETRIEVABLE
 *   WINDOW_FIXED       — a window was passed to a metric that takes none (its window is fixed)
 *   WINDOW_NOT_OFFERED — a window outside the metric's declared windows
 *   READER_FAILED      — the reader threw (its error text never enters the envelope)
 *   PROJECTION_REFUSED — the projection was not an aggregate, or its parts differ from the declared units
 *   NO_FIGURE          — the reader ran and gave no figure (its own UNAVAILABLE verdict, or a null value)
 */
export const UNAVAILABLE_CODES = ["NOT_RETRIEVABLE", "WINDOW_FIXED", "WINDOW_NOT_OFFERED", "READER_FAILED", "PROJECTION_REFUSED", "NO_FIGURE"] as const;
export type UnavailableCode = (typeof UNAVAILABLE_CODES)[number];

/**
 * PART ROLES (S2 ruling 2026-11-05 — "fix the contract, not prose"). An object
 * value whose parts are a TOTAL and the CATEGORIES it sums declares each part's
 * role, so no reader (the Platform AI included) can present the total as a
 * category:
 *   total    — the sum of the categories; NEVER a category, never ranked
 *   category — one category of the total, with its server label
 *   ranking  — SERVER-COMPUTED by envelope() (largestMeasuredCategory), never
 *              projected: the largest MEASURED (non-null) category part
 * Pinned (retrieve.test.ts): every declared part exists in valueUnits and every
 * unit part is declared; at most one total; a ranking part needs ≥ 1 category and
 * carries the categories' unit.
 */
export type PartRole = "total" | "category" | "ranking";
export type PartDeclaration = { role: "total" } | { role: "category"; label: string } | { role: "ranking" };
export type PartDeclarations = Readonly<Record<string, PartDeclaration>>;

/**
 * The FIXED qualifier a ranking carries when the ranking cannot be complete (S2
 * ruling 2026-11-05): any category part is null (unmetered / unpriced) or the
 * envelope is not MEASURED (PARTIAL = a floor; ESTIMATED = a rate-card estimate).
 */
export const RANKING_QUALIFIER = "ranking among measured categories; some categories are incomplete";

/**
 * A ranking part's value: the largest MEASURED category — its server label, its
 * figure (the category part's own value: same unit, same basis) and the
 * envelope's window label — plus the qualifier (null only when every category is
 * measured and the envelope is MEASURED). Never the total.
 */
export interface RankedCategory { label: string; figure: number; window: string | null; qualifier: typeof RANKING_QUALIFIER | null }

/**
 * A number, or a small fixed object of numbers (null = that part has no figure,
 * never 0); a declared ranking part holds a RankedCategory (or null: no category measured).
 */
export type AggregateValue = number | Readonly<Record<string, number | null | RankedCategory>>;

/**
 * THE EXPLICIT UNIT of a figure — what a renderer (Platform AI's placeholder
 * grounding) prints beside it. Never inferred from a name at render time.
 *   count — a plain count (no unit);  usd — US dollars;  pct — a percent on the 0–100 scale.
 * A scalar value declares one unit; an object value declares one per part, and
 * the projection's parts must be EXACTLY the declared ones (else UNAVAILABLE,
 * never an unlabelled figure). Pinned: platform-ai.test.ts ("units").
 */
export type FigureUnit = "count" | "usd" | "pct";
export type ValueUnits = FigureUnit | Readonly<Record<string, FigureUnit>>;
/**
 * WHICH PARTS ARE ESTIMATES (S2, binding) — the source of truth for a renderer's
 * "(estimated)" label. Explicit per metric; may list a pct derived from estimated
 * dollars. When a metric declares none, a renderer treats its usd parts as the
 * estimates IF the metric is an estimate; a count part is never an estimate
 * unless listed. Every listed part exists in valueUnits (pinned).
 */
export type EstimatedParts = readonly string[];

/**
 * CONFIGURATION parts (S2, 2026-11-04): a value that is not measured over the
 * metric's window (e.g. a configured threshold). A renderer gives it its unit but
 * NO window label; it is an estimate only if listed in EstimatedParts. Every
 * listed part exists in valueUnits (pinned).
 */
export type UnwindowedParts = readonly string[];

/** The Platform area whose surface shows the value. A server-side literal at every call site (pinned). */
export type MetricSurface = PlatformArea;

/** Built by the caller's route from ITS OWN guard result; this module mints nothing. */
export interface RetrievalContext {
  metricToken: MetricAccessToken;
  /** incidentAudienceFor(auth) — required only by metrics whose reader is incident-scoped. */
  incidentToken?: CsToken | OpsToken | null;
}

export interface RetrievalParams {
  /**
   * Days, only for metrics that declare windows (growth-registrations: 30 | 90;
   * engaged-users: 1 | 7 | 30; economics-ai-cost: 30 | 7 | 90; ai-call-outcomes and
   * ai-cost-per-call: 7 | 30). Any other value is refused with the declared list.
   */
  window?: number;
}

export type MetricDrillDescriptor =
  | { figure: `${string}@${number}`; window: number | null; href: string; page: string }
  | { figure: `${string}@${number}`; unavailable: string };

export interface MetricEnvelope {
  metric: `${string}@${number}`;
  surface: MetricSurface;
  /** The identity tier the value was read at (after the downgrade). */
  tier: IdentityTier;
  /**
   * "usd" = US dollars; "usd-and-counts" = dollars beside counts. The unit of
   * EACH figure is `valueUnits` (explicit; the placeholder renderer reads only it).
   */
  unit: "count" | "usd" | "usd-and-counts" | "counts";
  /** The explicit unit of the value (scalar) or of each part (object); null when no retrieval contract declares one. */
  valueUnits: ValueUnits | null;
  /** The parts that are estimates (EstimatedParts); null = not declared (the usd-parts default applies). */
  estimatedParts: EstimatedParts | null;
  /** Configuration parts rendered with no window label (UnwindowedParts); null = none. */
  unwindowedParts: UnwindowedParts | null;
  /** Each part's role (PartRole: total / category / ranking); null = not declared (S2 ruling 2026-11-05). */
  partRoles: Readonly<Record<string, PartRole>> | null;
  /**
   * Each CATEGORY part's server label (the declaration's `label`, e.g. "Providers (Plaid)");
   * null / absent = no category parts declared. What Platform AI's {{l:<key>|part=<category>}}
   * renders (S2 F-C2, 2026-11-07) — never model text.
   */
  partLabels?: Readonly<Record<string, string>> | null;
  /** null ⇔ UNAVAILABLE. A floor / lower bound when PARTIAL. Never a stand-in 0. */
  value: AggregateValue | null;
  status: RetrievalStatus;
  /** Why there is no figure (UNAVAILABLE) or why it is a floor (PARTIAL); null otherwise. */
  reason: string | null;
  /** The UNAVAILABLE path as a code (UnavailableCode); null ⇔ status is not UNAVAILABLE. */
  unavailableCode: UnavailableCode | null;
  /**
   * `label` is the short SERVER phrase a renderer states beside a figure: built from
   * `days` / `hours` when the read carries them, else the registry's window.label;
   * null only for POINT_IN_TIME. `start` is an explicit window start FROM THE READER
   * (never inferred: today only the economics cycle metrics, from the snapshot's
   * s.cycle.start); null when the reader gives none.
   */
  window: { kind: MetricDefinition["window"]["kind"]; description: string; days: number | null; hours: number | null; label: string | null; start: string | null };
  freshness: { asOf: string | null; source: string };
  coverage: { gaps: readonly string[]; missing: readonly string[] };
  /**
   * `kind` is "estimated" for a rate-card figure (provenance ESTIMATED: every dollar
   * here — never a bill) and "measured" for a counted one. A PARTIAL estimate is
   * still "estimated" (a lower bound of an estimate).
   */
  basis: { kind: "estimated" | "measured"; definition: `${string}@${number}`; compute: string; reader: string; answerClass: MetricDefinition["answerClass"] };
  /**
   * NAMED SUBJECTS (2026-11-08, Platform AI briefing): which subjects of an aggregate are
   * not healthy — a closed state word beside a REGISTRY / MODULE name (an overview domain's
   * server title, a scheduled job's registry name, an alert rule id, a freshness resource id).
   * Never a customer, connection, institution, execution or incident: every label passes
   * isSubjectLabel (a server label or a kebab-case registry slug — no digit, no identifier
   * shape), at most MAX_SUBJECTS. Absent / null = the metric names no subjects.
   */
  subjects?: readonly MetricSubject[] | null;
  /** null when the drill route's own gate is not this surface (the caller could not open it here) — see drillReason. */
  drill: MetricDrillDescriptor | null;
  /** Why `drill` is null; null when a drill is given. */
  drillReason: string | null;
}

/** The closed state vocabulary a named subject may carry. */
export const SUBJECT_STATES = [
  "failed", "degraded", "stale", "unknown",
  "firing", "firing-critical", "not-evaluable", "source-unavailable",
  "overdue", "failing", "dead", "never-ran", "skipped", "running",
  "empty",
] as const;
export type SubjectState = (typeof SUBJECT_STATES)[number];
export interface MetricSubject { label: string; state: SubjectState }
export const MAX_SUBJECTS = 12;
/** A kebab-case registry slug ("sync-banks", "resource-stale"): letters and hyphens, at least one hyphen, no digit. */
const SUBJECT_SLUG = /^[a-z]{2,20}(?:-[a-z]{2,20}){1,4}$/;
/** True for a subject label the envelope may carry: a server label (SERVER_LABEL) or a registry slug. */
export const isSubjectLabel = (s: unknown): s is string => typeof s === "string" && (SERVER_LABEL.test(s) || SUBJECT_SLUG.test(s));

// ── Readers (bound to the real functions in ./retrieve.ts) ──────────────────

/**
 * Exactly the readers the registered `path`s name. Each key's REAL binding is
 * the function in READER_SYMBOL (pinned against the registry path and against
 * ./retrieve.ts's source).
 */
export interface RetrievalReaders {
  providerHealth(): Promise<Pick<ProviderHealthResult, "checkedAt" | "providers">>;
  aiBudget(): Promise<AiBudgetUtilization>;
  acquisition(windowDays: 30 | 90): Promise<AcquisitionResponse>;
  productAnalytics(): Promise<ProductAnalyticsResponse>;
  incidentSearch(token: CsToken | OpsToken, query: IncidentSearchQuery, opts: { now: Date }): Promise<Pick<IncidentSearchResult, "total" | "truncated" | "scanned">>;
  merchantOverview(): Promise<MerchantOverviewResponse>;
  csOverview(token: CsToken): Promise<CsOverviewResponse>;
  liveSessions(now: Date): Promise<LiveSessionCounts>;
  accountsWithLiveSession(now: Date): Promise<number>;
  economicsSnapshot(nowMs: number): Promise<EconomicsSnapshot>;
  aiOperations(window: "7d" | "30d"): Promise<AiOperations>;
  operationsOverview(): Promise<Pick<OperationsOverview, "checkedAt" | "domains" | "worst">>;
  attention(token: OpsToken): Promise<Pick<AttentionResponse, "checkedAt" | "userImpact">>;
  alertRuns(): Promise<readonly AlertRunSummary[]>;
  connectionHealth(): Promise<ConnectionHealthResult>;
  jobHealth(): Promise<Pick<ScheduledJobsHealth, "checkedAt" | "jobs">>;
  resourceFreshness(): Promise<Pick<ResourceFreshnessResult, "checkedAt" | "resources">>;
}
export type ReaderKey = keyof RetrievalReaders;

/** The function each reader key is bound to — the first `path` hop's `calls` (pinned). */
export const READER_SYMBOL: Readonly<Record<ReaderKey, string>> = {
  providerHealth: "getProviderHealth",
  aiBudget: "loadAiBudgetUtilization",
  acquisition: "getAcquisition",
  productAnalytics: "getProductAnalytics",
  incidentSearch: "incidentAccessors.search",
  merchantOverview: "getMerchantOverview",
  csOverview: "getCsOverview",
  liveSessions: "countLiveSessions",
  accountsWithLiveSession: "countAccountsWithLiveSession",
  economicsSnapshot: "getEconomicsSnapshot",
  aiOperations: "getAiOperations",
  operationsOverview: "getOperationsOverview",
  attention: "getAttention",
  alertRuns: "loadRecentAlertRuns",
  connectionHealth: "getConnectionHealth",
  jobHealth: "checkScheduledJobHealth",
  resourceFreshness: "checkResourceFreshness",
};

// ── The per-metric table ─────────────────────────────────────────────────────

/** What a projection returns: the figure and its honest status, nothing else. */
interface Projected {
  value: AggregateValue | null;
  /** Overrides the definition's provenance class (PARTIAL / UNAVAILABLE, or the AI status). */
  status?: RetrievalStatus;
  reason?: string | null;
  missing?: string[];
  asOf: string | null;
  days?: number | null;
  hours?: number | null;
  /** An EXPLICIT window start the reader itself holds (ISO date, YYYY-MM-DD) — never inferred. */
  start?: string | null;
  /**
   * A server phrase that REPLACES the generic day / hour label (S2 #483 R1: "last seen in the last
   * N days"); built only from module text and the read's own days — never payload text.
   */
  windowLabel?: string;
  /** Named subjects (MetricSubject) — registry / module names only; envelope() drops any label that is not one. */
  subjects?: readonly MetricSubject[];
}

interface ReadInput {
  readers: RetrievalReaders;
  tier: IdentityTier;
  /** The incident token at the effective tier (null when the context carries none). */
  incident: CsToken | OpsToken | null;
  window: number | null;
  now: Date;
}

interface Retrievable {
  kind: "RETRIEVABLE";
  reader: ReaderKey;
  unit: MetricEnvelope["unit"];
  /** The explicit unit(s) of the projected value — see FigureUnit. */
  valueUnits: ValueUnits;
  /** The parts that are estimates — see EstimatedParts. */
  estimatedParts?: EstimatedParts;
  /** Configuration parts rendered without a window label — see UnwindowedParts. */
  unwindowedParts?: UnwindowedParts;
  /** Each part's role (total / category / ranking) — see PartRole. Ranking parts are computed by envelope(). */
  parts?: PartDeclarations;
  /** Windows the metric accepts, the first being the tile's default; [] = no window parameter. */
  windows: readonly number[];
  /** Needs an incident token at the effective tier. */
  incidentScoped?: "ANY" | "CUSTOMER_SUCCESS_ONLY";
  read(i: ReadInput): Promise<Projected>;
}

interface NotRetrievable { kind: "NOT_RETRIEVABLE"; reason: string }

export type RetrievalEntry = Retrievable | NotRetrievable;

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/**
 * An Economics figure as the tile shows it: its value, status (ESTIMATED /
 * PARTIAL / UNAVAILABLE — the same vocabulary), reason and missing parts, read
 * from the snapshot the Overview tile reads. Nothing is recomputed.
 */
function fromFigure(f: EconomicsFigure, asOf: string, days: number | null = null): Projected {
  return { value: f.value, status: f.status, reason: f.reason, missing: [...f.coverage.missing], asOf, days };
}

const TREND_OF: Readonly<Record<number, TrendWindow>> = { 7: "7d", 30: "30d", 90: "90d" };

/** The overview domains' SERVER labels (keyed by the closed DomainStatus key — never the payload's title). */
const DOMAIN_LABEL: Readonly<Record<DomainStatus["key"], string>> = {
  pipeline: "Refresh pipeline", sources: "Connections", jobs: "Scheduled jobs", ai: "AI", brief: "Daily Brief", plaid: "Plaid",
};
const DOMAIN_PART: Readonly<Record<DomainState, "failed" | "degraded" | "stale" | "unknown" | "healthy">> = {
  FAILED: "failed", DEGRADED: "degraded", STALE: "stale", UNKNOWN: "unknown", HEALTHY: "healthy",
};
const DOMAIN_SUBJECT: Readonly<Record<DomainState, SubjectState>> = { FAILED: "failed", DEGRADED: "degraded", STALE: "stale", UNKNOWN: "unknown", HEALTHY: "unknown" };
const JOB_PART: Readonly<Record<string, "healthy" | "running" | "overdue" | "failing" | "dead" | "neverRan" | "skipped" | "notScheduled">> = {
  healthy: "healthy", running: "running", overdue: "overdue", failing: "failing", dead: "dead", "never-ran": "neverRan", skipped: "skipped", "not-scheduled": "notScheduled",
};
const JOB_SUBJECT: Readonly<Record<string, SubjectState | null>> = {
  healthy: null, running: null, "not-scheduled": null, overdue: "overdue", failing: "failing", dead: "dead", "never-ran": "never-ran", skipped: "skipped",
};
const FRESHNESS_PART: Readonly<Record<string, "fresh" | "stale" | "empty" | "idle" | "notRefreshed">> = {
  fresh: "fresh", stale: "stale", empty: "empty", idle: "idle", "not-refreshed": "notRefreshed",
};

/**
 * EVERY registered metric appears here exactly once (pinned): retrievable, or
 * NOT_RETRIEVABLE with the reason. Never silently omitted.
 */
export const RETRIEVAL: Readonly<Record<string, RetrievalEntry>> = {
  "provider-outcome@1": {
    kind: "RETRIEVABLE", reader: "providerHealth", unit: "counts", windows: [],
    valueUnits: { healthy: "count", degraded: "count", failing: "count", notEnoughData: "count", noRuns: "count" },
    async read({ readers }) {
      const r = await readers.providerHealth();
      const v = { healthy: 0, degraded: 0, failing: 0, notEnoughData: 0, noRuns: 0 };
      for (const p of r.providers) {
        const e = p.execution?.verdict ?? null;
        if (e === null) v.noRuns++;
        else if (e === "HEALTHY") v.healthy++;
        else if (e === "DEGRADED") v.degraded++;
        else if (e === "FAILING") v.failing++;
        else if (e === "NOT_ENOUGH_DATA") v.notEnoughData++;
        else throw new Error("unknown execution verdict"); // never guessed into a bucket ⇒ UNAVAILABLE
      }
      // The envelope-status rule (registry coverageGaps; the verdict rule is unchanged):
      // zero evaluable providers is not a measurement of "0 healthy".
      const evaluable = v.healthy + v.degraded + v.failing;
      const unevaluated = v.noRuns + v.notEnoughData;
      const asOf = iso(r.checkedAt);
      const why = [
        ...(v.noRuns > 0 ? [`${plural(v.noRuns, "provider")} with no run in the window`] : []),
        ...(v.notEnoughData > 0 ? [`${plural(v.notEnoughData, "provider")} with not enough data for a verdict`] : []),
      ];
      if (evaluable === 0) return { value: null, status: "UNAVAILABLE", reason: `no provider has an evaluable verdict: ${NO_EVALUABLE_PROVIDER}`, missing: why, asOf };
      if (unevaluated > 0) return { value: v, status: "PARTIAL", reason: `only ${plural(evaluable, "provider")} of ${r.providers.length} could be evaluated`, missing: why, asOf };
      return { value: v, asOf };
    },
  },
  "provider-connection@2": {
    kind: "RETRIEVABLE", reader: "providerHealth", unit: "counts", windows: [],
    valueUnits: { failing: "count", degraded: "count", institutionConcentrated: "count", noVerdict: "count", noConnections: "count" },
    async read({ readers }) {
      const r = await readers.providerHealth();
      // institutionConcentrated ⊂ degraded (v2): the error share one institution explains.
      const v = { failing: 0, degraded: 0, institutionConcentrated: 0, noVerdict: 0, noConnections: 0 };
      let unknownPopulation = 0;
      for (const p of r.providers) {
        const c = p.connections ?? null;
        if (c === null) { v.noConnections++; continue; }
        if (c.tally.populationUnknown) unknownPopulation++;
        if (c.verdict === "FAILING") v.failing++;
        else if (c.verdict === "DEGRADED") { v.degraded++; if (c.rule === "institution-concentrated") v.institutionConcentrated++; }
        else v.noVerdict++;
      }
      // The envelope-status rule (registry coverageGaps): nothing to assess is not a measured zero.
      if (r.providers.length === 0 || v.noConnections === r.providers.length) {
        return { value: null, status: "UNAVAILABLE", reason: "no provider reports a connection population to assess", asOf: iso(r.checkedAt) };
      }
      const missing = [
        ...(unknownPopulation > 0 ? [`${plural(unknownPopulation, "provider")}: connection population unavailable — share not computed`] : []),
        ...(v.noConnections > 0 ? [`${plural(v.noConnections, "provider")} with no connection population`] : []),
      ];
      if (unknownPopulation > 0) {
        return { value: v, status: "PARTIAL", reason: "the error-share rule could not be applied to every provider", missing, asOf: iso(r.checkedAt) };
      }
      if (v.noConnections > 0) {
        return { value: v, status: "PARTIAL", reason: "not every provider reports a connection population", missing, asOf: iso(r.checkedAt) };
      }
      return { value: v, asOf: iso(r.checkedAt) };
    },
  },
  "ai-fleet-spend-status@1": {
    kind: "RETRIEVABLE", reader: "aiBudget", unit: "usd-and-counts", windows: [],
    valueUnits: { pricedUsd: "usd", utilisationPct: "pct", thresholdUsd: "usd", invocations: "count", unpricedInvocations: "count" },
    // utilisationPct = estimated spend ÷ threshold ⇒ estimated; thresholdUsd is a configured figure and the counts are counted.
    estimatedParts: ["pricedUsd", "utilisationPct"],
    unwindowedParts: ["thresholdUsd"],
    async read({ readers }) {
      const b = await readers.aiBudget();
      // THE tile function (ai-budget-view.ts / ai-costs-model.ts read fleetSpendStatus(b)).
      const s = fleetSpendStatus(b);
      const base = { asOf: b.checkedAt ?? null, hours: s.windowHours };
      if (s.status === "UNAVAILABLE") return { ...base, value: null, status: "UNAVAILABLE", reason: s.reason ?? "no customer invocation could be priced" };
      const value = {
        pricedUsd: s.pricedUsd,
        utilisationPct: s.thresholdSet ? s.utilisationPct : null,
        thresholdUsd: s.thresholdSet ? s.thresholdUsd : null,
        invocations: s.invocations,
        unpricedInvocations: s.unpricedInvocations,
      };
      const missing = [
        ...(s.unpricedInvocations > 0 ? [`${plural(s.unpricedInvocations, "customer invocation")} the rate card could not price (counted, never $0)`] : []),
        ...(!s.thresholdSet ? ["No threshold set — utilisation has no denominator"] : []),
      ];
      return s.status === "PARTIAL"
        ? { ...base, value, status: "PARTIAL", reason: "lower bound — some customer invocations are unpriced", missing }
        : { ...base, value, status: "ESTIMATED", reason: null, missing };
    },
  },
  "economics-ai-cost@1": {
    // The Overview's AI trend card: s.trend.windows[win] (EconomicsOverviewLead.tsx) — the snapshot's own figure.
    kind: "RETRIEVABLE", reader: "economicsSnapshot", unit: "usd", windows: [30, 7, 90],
    valueUnits: { spendUsd: "usd" }, estimatedParts: ["spendUsd"],
    async read({ readers, window, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      const p = fromFigure(s.trend.windows[TREND_OF[window ?? 30]], s.checkedAt, window);
      // Named parts (`…Usd`) so a renderer formats dollars, never a unitless count.
      return { ...p, value: p.value === null ? null : { spendUsd: p.value as number } };
    },
  },
  "economics-operating-cost@1": {
    // The Overview's hero (s.figures.operating_cost) and its split tiles (SPLIT_KEYS: AI / Providers / Infrastructure).
    kind: "RETRIEVABLE", reader: "economicsSnapshot", unit: "usd", windows: [],
    valueUnits: { totalUsd: "usd", aiUsd: "usd", providersUsd: "usd", infrastructureUsd: "usd", largestMeasuredCategory: "usd" },
    estimatedParts: ["totalUsd", "aiUsd", "providersUsd", "infrastructureUsd", "largestMeasuredCategory"],
    // S2 ruling 2026-11-05: the total is the SUM of the categories, never a category. The
    // category labels are the Overview's split tiles; largestMeasuredCategory is computed by
    // envelope() from the three category parts (declared order = the tie order), never the total.
    parts: {
      totalUsd: { role: "total" },
      aiUsd: { role: "category", label: "AI" },
      providersUsd: { role: "category", label: "Providers (Plaid)" },
      infrastructureUsd: { role: "category", label: "Infrastructure" },
      largestMeasuredCategory: { role: "ranking" },
    },
    async read({ readers, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      const op = s.figures.operating_cost;
      // window.start = the snapshot's OWN billing cycle start (s.cycle.start), never derived here.
      const p = { ...fromFigure(op, s.checkedAt), start: s.cycle.start };
      if (op.value === null) return p;
      // Each part is the split tile's own figure: null = unmetered / unpriced (never $0).
      return { ...p, value: { totalUsd: op.value, aiUsd: s.figures.ai_cost.value, providersUsd: s.figures.provider_cost.value, infrastructureUsd: s.figures.infra_cost.value } };
    },
  },
  "economics-provider-cost@1": {
    kind: "RETRIEVABLE", reader: "economicsSnapshot", unit: "usd", windows: [],
    valueUnits: { costUsd: "usd" }, estimatedParts: ["costUsd"],
    async read({ readers, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      const p = { ...fromFigure(s.figures.provider_cost, s.checkedAt), start: s.cycle.start };
      return { ...p, value: p.value === null ? null : { costUsd: p.value as number } };
    },
  },
  "ai-call-outcomes@1": {
    // The AI & Costs KPIs "Calls · 7 d" / "Error rate · 7 d": aiCallStats(i) (ai-costs-model.ts aiKpis).
    kind: "RETRIEVABLE", reader: "aiOperations", unit: "counts", windows: [7, 30],
    valueUnits: { calls: "count", returned: "count", failed: "count", errorRatePct: "pct" },
    async read({ readers, window }) {
      const i = await readers.aiOperations(window === 30 ? "30d" : "7d");
      const st = aiCallStats(i);
      return {
        value: { calls: st.calls, returned: st.returned, failed: st.failed, errorRatePct: st.errorRatePct },
        missing: st.calls === 0 ? ["no calls recorded in the window — the error rate is undefined (never 0%)"] : [],
        asOf: i.checkedAt, days: window,
      };
    },
  },
  "ai-cost-per-call@1": {
    // The AI & Costs KPI "Est. cost / call": aiCostPerCall(i) (ai-costs-model.ts costPerCall).
    kind: "RETRIEVABLE", reader: "aiOperations", unit: "usd-and-counts", windows: [7, 30],
    valueUnits: { costPerCallUsd: "usd", pricedUsd: "usd", returnedCalls: "count" }, estimatedParts: ["costPerCallUsd", "pricedUsd"],
    async read({ readers, window }) {
      const i = await readers.aiOperations(window === 30 ? "30d" : "7d");
      const c = aiCostPerCall(i);
      const base = { asOf: i.checkedAt, days: window };
      if (c.kind === "UNKNOWN") return { ...base, value: null, status: "UNAVAILABLE", reason: c.reason };
      const value = { costPerCallUsd: c.usd, pricedUsd: c.pricedUsd, returnedCalls: c.returned };
      return c.partial
        ? { ...base, value, status: "PARTIAL", reason: "lower bound — some tokens had no rate", missing: ["tokens the rate card could not price (counted, never $0)"] }
        : { ...base, value, status: "ESTIMATED", reason: null };
    },
  },
  "presence-state@1": {
    kind: "NOT_RETRIEVABLE",
    reason: "Per-subject: one customer's presence bucket, shown only beside that customer's identity (CUSTOMER_SUCCESS tier). This slice returns aggregates only, and no fleet presence projection exists.",
  },
  "engaged-users@1": {
    kind: "RETRIEVABLE", reader: "productAnalytics", unit: "count", windows: [30, 7, 1],
    valueUnits: "count",
    async read({ readers, window }) {
      const p = await readers.productAnalytics();
      const w = window === 1 ? p.active.daily : window === 7 ? p.active.weekly : p.active.monthly;
      return { value: w.engaged, asOf: p.checkedAt ?? null, days: window };
    },
  },
  "growth-registrations@1": {
    // The route's default window is 90 (`raw === "30" ? 30 : 90`).
    kind: "RETRIEVABLE", reader: "acquisition", unit: "count", windows: [90, 30],
    valueUnits: "count",
    async read({ readers, window }) {
      const a = await readers.acquisition(window === 30 ? 30 : 90);
      const unknownDays = a.registrations.perDay.filter((d) => d.count === null).length;
      const capped = a.notes.some((n) => /^Read cap reached/.test(n));
      const base = { asOf: a.checkedAt ?? null, days: a.windowDays };
      if (a.registrations.perDay.length > 0 && unknownDays === a.registrations.perDay.length) {
        return { ...base, value: null, status: "UNAVAILABLE", reason: "no day of the window is covered by the registration source" };
      }
      const missing = [
        ...(unknownDays > 0 ? [`${plural(unknownDays, "UTC day")} before the source began or past its retention edge`] : []),
        ...(capped ? ["the read cap was reached"] : []),
      ];
      return missing.length > 0
        ? { ...base, value: a.registrations.total, status: "PARTIAL", reason: "a floor — part of the window is not covered", missing }
        : { ...base, value: a.registrations.total };
    },
  },
  "incident-broken-now@1": {
    kind: "RETRIEVABLE", reader: "incidentSearch", unit: "count", windows: [], incidentScoped: "ANY",
    valueUnits: "count",
    async read({ readers, incident, now }) {
      const r = await readers.incidentSearch(incident!, { ...DEFAULT_SEARCH, status: "broken-now" }, { now });
      // The Incidents KPI and list header print `total` (+ when truncated): incidentTotalText.
      return r.truncated
        ? { value: r.total, status: "PARTIAL", reason: "a floor — the read was capped", missing: [`only ${plural(r.scanned, "row")} scanned`], asOf: now.toISOString() }
        : { value: r.total, asOf: now.toISOString() };
    },
  },
  "incident-alertable@1": {
    kind: "NOT_RETRIEVABLE",
    reason: "No aggregate projection exists: the search reader pages its items (INCIDENT_PAGE_SIZE), so an alertable count over every broken-now verdict is not in its payload, and the alertable accessor is SYSTEM-only (lib/alerts/, pinned by audience.test.ts).",
  },
  "merchant-identity-linked@1": {
    kind: "RETRIEVABLE", reader: "merchantOverview", unit: "counts", windows: [],
    valueUnits: { linked: "count", live: "count" },
    async read({ readers }) {
      const m = await readers.merchantOverview();
      // The tile: formatCoveragePct(m.transactions.resolved, m.transactions.total) (merchant-model.ts).
      if (m.transactions.total <= 0) return { value: null, status: "UNAVAILABLE", reason: "no live transactions — the linked share is undefined (never 0%)", asOf: m.checkedAt ?? null };
      return { value: { linked: m.transactions.resolved, live: m.transactions.total }, asOf: m.checkedAt ?? null };
    },
  },
  "cs-needs-help@1": {
    kind: "RETRIEVABLE", reader: "csOverview", unit: "count", windows: [], incidentScoped: "CUSTOMER_SUCCESS_ONLY",
    valueUnits: "count",
    async read({ readers, incident }) {
      const o = await readers.csOverview(incident as CsToken);
      // The tile: atLeast(o.attention.customers, o.attention.floor) (customer-success-model.ts).
      return o.attention.floor
        ? { value: o.attention.customers, status: "PARTIAL", reason: "at least — a fleet read hit its row cap", missing: ["the attention scan was capped"], asOf: o.checkedAt ?? null }
        : { value: o.attention.customers, asOf: o.checkedAt ?? null };
    },
  },
  "open-customers@1": {
    kind: "RETRIEVABLE", reader: "csOverview", unit: "count", windows: [], incidentScoped: "CUSTOMER_SUCCESS_ONLY",
    valueUnits: "count",
    async read({ readers, incident }) {
      const o = await readers.csOverview(incident as CsToken);
      // The tile: o.customers.active — counted from the same capped attention read (overview-core.ts).
      return o.attention.floor
        ? { value: o.customers.active, status: "PARTIAL", reason: "at least — the fleet read hit its row cap (ATTENTION_SCAN_CAP)", missing: ["the attention scan was capped"], asOf: o.checkedAt ?? null }
        : { value: o.customers.active, asOf: o.checkedAt ?? null };
    },
  },
  "live-sessions@1": {
    // The Security Ops FLEET count, identity-free. Its CUSTOMER_SUCCESS entry is the
    // per-customer detail route (customers/[userId]) — a per-customer figure, never
    // served as a fleet value (isFleetEntry; pinned in retrieve.test.ts).
    kind: "RETRIEVABLE", reader: "liveSessions", unit: "counts", windows: [],
    valueUnits: { sessions: "count", distinctUsers: "count" },
    async read({ readers, now }) {
      // The tile: d.totalActive / d.distinctUsers, which the route sets from this reader.
      const c = await readers.liveSessions(now);
      return { value: { sessions: c.sessions, distinctUsers: c.distinctUsers }, asOf: now.toISOString() };
    },
  },
  "accounts-with-live-session@1": {
    kind: "RETRIEVABLE", reader: "accountsWithLiveSession", unit: "count", windows: [],
    valueUnits: "count",
    async read({ readers, now }) {
      // The tile: data.withLiveSession, which the Growth users route sets from this reader.
      return { value: await readers.accountsWithLiveSession(now), asOf: now.toISOString() };
    },
  },

  // ── operations (Platform AI operational briefing, 2026-11-08) ──────────────
  "ops-overall-posture@1": {
    // The Operations lead's status header: overallWord(o.worst) and each domain's state (operations-model.ts).
    kind: "RETRIEVABLE", reader: "operationsOverview", unit: "counts", windows: [],
    valueUnits: { failed: "count", degraded: "count", stale: "count", unknown: "count", healthy: "count" },
    async read({ readers }) {
      const o = await readers.operationsOverview();
      const v = { failed: 0, degraded: 0, stale: 0, unknown: 0, healthy: 0 };
      for (const d of o.domains) v[DOMAIN_PART[d.state]]++;
      const subjects = o.domains.filter((d) => d.state !== "HEALTHY").map((d) => ({ label: DOMAIN_LABEL[d.key], state: DOMAIN_SUBJECT[d.state] }));
      if (o.domains.length === 0) return { value: null, status: "UNAVAILABLE", reason: "the overview returned no domain verdicts", asOf: o.checkedAt };
      return v.unknown > 0
        ? { value: v, status: "PARTIAL", reason: `${plural(v.unknown, "domain")} had nothing to judge (unknown, never counted healthy)`, missing: subjects.filter((x) => x.state === "unknown").map((x) => `${x.label}: unknown`), asOf: o.checkedAt, subjects }
        : { value: v, asOf: o.checkedAt, subjects };
    },
  },
  "customer-impact-24h@1": {
    // The Attention block's customer-impact panel: counts per kind and usersAffectedReading(u) (attention-view.ts).
    kind: "RETRIEVABLE", reader: "attention", unit: "counts", windows: [], incidentScoped: "ANY",
    valueUnits: { refreshFailed: "count", refreshPartial: "count", aiFailures: "count", briefFailed: "count", needsReauth: "count", customersAffected: "count", sourcesAffected: "count" },
    async read({ readers, incident }) {
      const a = await readers.attention(incident as OpsToken);
      const u = a.userImpact;
      const value = {
        refreshFailed: u.counts["refresh-failed"], refreshPartial: u.counts["refresh-partial"], aiFailures: u.counts["ai-failure"],
        briefFailed: u.counts["brief-failed"], needsReauth: u.counts["needs-reauth"],
        customersAffected: u.usersAffected.count, sourcesAffected: u.sourcesAffected,
      };
      const missing = [
        ...u.authorities.failed.map((f) => `impact reader unavailable: ${f}`),
        ...(u.usersAffected.count === null ? ["customers affected: no reader exposed a customer reference"] : u.usersAffected.reason ? ["customers affected is a floor (some rows carry no customer reference)"] : []),
        ...(u.floors.length > 0 ? [`${plural(u.floors.length, "impact reader")} returned a floor`] : []),
      ];
      const base = { asOf: a.checkedAt, hours: u.windowHours };
      if (u.authorities.checked.length === 0) return { ...base, value: null, status: "UNAVAILABLE", reason: "no customer-impact reader could be read", missing };
      return missing.length > 0
        ? { ...base, value, status: "PARTIAL", reason: "a floor — not every impact fact could be read or attributed", missing }
        : { ...base, value };
    },
  },
  "incident-needs-verification@1": {
    // The Incidents "Needs verification" view's list total (incidentTotalText, the same search preset).
    kind: "RETRIEVABLE", reader: "incidentSearch", unit: "count", windows: [], incidentScoped: "ANY",
    valueUnits: "count",
    async read({ readers, incident, now }) {
      const r = await readers.incidentSearch(incident!, { ...DEFAULT_SEARCH, status: "needs-verification" }, { now });
      return r.truncated
        ? { value: r.total, status: "PARTIAL", reason: "a floor — the read was capped", missing: [`only ${plural(r.scanned, "row")} scanned`], asOf: now.toISOString() }
        : { value: r.total, asOf: now.toISOString() };
    },
  },
  "incident-resolved-window@1": {
    // The Incidents "History" view's list total over the window's UTC days (from / to on lastSeenAt).
    // S2 #483 R1 (fallback): the search contract filters on LAST SEEN, not resolvedAt, so the window
    // is LABELLED as such ("last seen in the last N days") — never "resolved in the last N days".
    kind: "RETRIEVABLE", reader: "incidentSearch", unit: "count", windows: [7, 1, 30], incidentScoped: "ANY",
    valueUnits: "count",
    async read({ readers, incident, now, window }) {
      const days = window ?? 7;
      const to = now.toISOString().slice(0, 10);
      const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const r = await readers.incidentSearch(incident!, { ...DEFAULT_SEARCH, status: "history", from, to }, { now });
      const base = { asOf: now.toISOString(), days, windowLabel: `last seen ${daysWindowLabel(days)}` };
      return r.truncated
        ? { ...base, value: r.total, status: "PARTIAL", reason: "a floor — the read was capped", missing: [`only ${plural(r.scanned, "row")} scanned`] }
        : { ...base, value: r.total };
    },
  },
  "alerts-firing-now@1": {
    // The Platform health drawer's Alerts group: firing.length from the latest evaluation (platform-health-view.ts alertsView).
    kind: "RETRIEVABLE", reader: "alertRuns", unit: "counts", windows: [],
    valueUnits: { firing: "count", firingCritical: "count", notEvaluable: "count", enabledRules: "count", sourcesUnavailable: "count" },
    async read({ readers }) {
      const latest = latestAlertEvaluation(await readers.alertRuns());
      if (!latest) return { value: null, status: "UNAVAILABLE", reason: "no alert evaluation has run — nothing is known to be firing or quiet", asOf: null };
      const firing = firingNow(latest);
      const blind = unavailableAlertSources(latest);
      const notEval = notEvaluableNow(latest);
      const value = {
        firing: firing.length, firingCritical: firing.filter((r) => r.severity === "critical").length,
        notEvaluable: notEval.length, enabledRules: latest.rules.filter((r) => r.enabled).length, sourcesUnavailable: blind.length,
      };
      const subjects: MetricSubject[] = [
        ...firing.map((r) => ({ label: r.id, state: (r.severity === "critical" ? "firing-critical" : "firing") as SubjectState })),
        ...notEval.map((r) => ({ label: r.id, state: "not-evaluable" as const })),
      ];
      return blind.length > 0
        ? { value, status: "PARTIAL", reason: "some alert sources could not be read in the latest evaluation — a rule over them cannot fire", missing: [`${plural(blind.length, "alert source")} unavailable`], asOf: latest.evaluatedAtISO, subjects }
        : { value, asOf: latest.evaluatedAtISO, subjects };
    },
  },
  "connection-health-summary@1": {
    // The Connection health card's composition (compositionSegments / listCoverage over r.counts).
    kind: "RETRIEVABLE", reader: "connectionHealth", unit: "counts", windows: [],
    valueUnits: { live: "count", healthy: "count", stale: "count", degraded: "count", needsReauth: "count", error: "count", reconnectNeeded: "count", customerImpacting: "count" },
    async read({ readers }) {
      const r = await readers.connectionHealth();
      const c = r.counts;
      // Reconnect needed: NEEDS_REAUTH, plus ERROR rows whose code Plaid fixes through update mode (NO_ACCOUNTS, ITEM_LOGIN_REQUIRED, …).
      let fixableErrors = 0;
      for (const t of Object.values(r.bySource ?? {})) for (const f of t.faults) if (f.healthState === "ERROR" && isUpdateModeFixable(f.errorCode)) fixableErrors += f.count;
      const healthy = c.HEALTHY ?? 0;
      const value = {
        live: r.total, healthy, stale: c.STALE ?? 0, degraded: c.DEGRADED ?? 0, needsReauth: c.NEEDS_REAUTH ?? 0, error: c.ERROR ?? 0,
        reconnectNeeded: (c.NEEDS_REAUTH ?? 0) + fixableErrors, customerImpacting: Math.max(0, r.total - healthy),
      };
      return r.bySource
        ? { value, asOf: r.checkedAt }
        : { value, status: "PARTIAL", reason: "reconnect needed is a floor — the per-source fault tally was not available", missing: ["ERROR connections fixable by reconnect could not be counted"], asOf: r.checkedAt };
    },
  },
  "refresh-pipeline@1": {
    // The Operations lead's Refresh pipeline KPI: o.domains.find((x) => x.key === "pipeline") (operations-model.ts).
    kind: "RETRIEVABLE", reader: "operationsOverview", unit: "counts", windows: [],
    valueUnits: { executions: "count", failed: "count", runningNow: "count" },
    async read({ readers }) {
      const o = await readers.operationsOverview();
      const d = o.domains.find((x) => x.key === "pipeline");
      if (!d) return { value: null, status: "UNAVAILABLE", reason: "the overview carries no pipeline verdict", asOf: o.checkedAt };
      const fact = (label: string): number | null => {
        const f = d.facts.find((x) => x.label === label);
        return f && /^\d+$/.test(f.value) ? Number(f.value) : null;
      };
      const value = { executions: fact("Executions"), failed: fact("Failed"), runningNow: fact("Running now") };
      const subjects = d.state === "HEALTHY" ? [] : [{ label: DOMAIN_LABEL.pipeline, state: DOMAIN_SUBJECT[d.state] }];
      if (value.executions === null || value.failed === null) return { value: null, status: "UNAVAILABLE", reason: "the pipeline verdict carries no execution counts", asOf: o.checkedAt };
      return d.state === "UNKNOWN"
        ? { value, status: "PARTIAL", reason: "no attempted refresh execution in the window — nothing to judge", missing: [], asOf: o.checkedAt, subjects }
        : { value, asOf: o.checkedAt, subjects };
    },
  },
  "scheduled-job-health@1": {
    // The Operations lead's job KPIs (jobKpis: c.failing + c.dead …) — the job-health route's own counts.
    kind: "RETRIEVABLE", reader: "jobHealth", unit: "counts", windows: [],
    valueUnits: { healthy: "count", running: "count", overdue: "count", failing: "count", dead: "count", neverRan: "count", skipped: "count", notScheduled: "count" },
    async read({ readers }) {
      const h = await readers.jobHealth();
      const v = { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0, skipped: 0, notScheduled: 0 };
      const subjects: MetricSubject[] = [];
      for (const j of h.jobs) {
        const k = JOB_PART[j.status];
        if (!k) throw new Error("unknown job status"); // never guessed into a bucket ⇒ UNAVAILABLE
        v[k]++;
        const st = JOB_SUBJECT[j.status];
        if (st) subjects.push({ label: j.job, state: st });
      }
      if (h.jobs.length === 0) return { value: null, status: "UNAVAILABLE", reason: "no scheduled job is registered", asOf: iso(h.checkedAt) };
      return { value: v, asOf: iso(h.checkedAt), subjects };
    },
  },
  "data-freshness@1": {
    // The Platform health drawer's Freshness group: d.counts.stale + d.counts.empty (platform-health-view.ts freshnessView).
    kind: "RETRIEVABLE", reader: "resourceFreshness", unit: "counts", windows: [],
    valueUnits: { fresh: "count", stale: "count", empty: "count", idle: "count", notRefreshed: "count" },
    async read({ readers }) {
      const f = await readers.resourceFreshness();
      const v = { fresh: 0, stale: 0, empty: 0, idle: 0, notRefreshed: 0 };
      const subjects: MetricSubject[] = [];
      for (const r of f.resources) {
        const k = FRESHNESS_PART[r.healthState];
        if (!k) throw new Error("unknown freshness state");
        v[k]++;
        if (r.healthState === "stale" || r.healthState === "empty") subjects.push({ label: r.resource, state: r.healthState });
      }
      if (f.resources.length === 0) return { value: null, status: "UNAVAILABLE", reason: "no freshness resource is registered", asOf: iso(f.checkedAt) };
      return { value: v, asOf: iso(f.checkedAt), subjects };
    },
  },
  "provider-call-volume@1": {
    // The Provider health widget's "Calls" field (p.callsToday / p.calls30d), summed over metered providers.
    kind: "RETRIEVABLE", reader: "providerHealth", unit: "counts", windows: [],
    valueUnits: { callsToday: "count", callsMonth: "count", syncFailures: "count", meteredProviders: "count", unmeteredProviders: "count" },
    async read({ readers }) {
      const r = await readers.providerHealth();
      const v = { callsToday: 0, callsMonth: 0, syncFailures: 0, meteredProviders: 0, unmeteredProviders: 0 };
      for (const p of r.providers) {
        const today = (p as { callsToday?: number | null }).callsToday ?? null;
        const month = (p as { calls30d?: number | null }).calls30d ?? null;
        if (today === null && month === null) v.unmeteredProviders++;
        else { v.meteredProviders++; v.callsToday += today ?? 0; v.callsMonth += month ?? 0; }
        v.syncFailures += (p as { syncFailures?: number }).syncFailures ?? 0;
      }
      const asOf = iso(r.checkedAt);
      if (v.meteredProviders === 0) return { value: null, status: "UNAVAILABLE", reason: "no provider's calls are metered — call volume is unknown, never 0", asOf };
      return v.unmeteredProviders > 0
        ? { value: v, status: "PARTIAL", reason: "a floor — some providers are not metered", missing: [`${plural(v.unmeteredProviders, "provider")} not metered (calls unknown, never 0)`], asOf }
        : { value: v, asOf };
    },
  },
};

// ── Tiering ──────────────────────────────────────────────────────────────────

export const TIER_RANK: Readonly<Record<IdentityTier, number>> = { OPS: 0, CUSTOMER_SUCCESS: 1 };
const minTier = (...t: IdentityTier[]): IdentityTier => t.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a));

/** The most identity a surface can ever show: only the Customer Success surface shows customers. */
export const SURFACE_TIER = (surface: MetricSurface): IdentityTier => (surface === "CUSTOMER_SUCCESS" ? "CUSTOMER_SUCCESS" : "OPS");

/**
 * True when a permission entry's route serves a FLEET figure: its path has no
 * dynamic segment. A `/[userId]/`-style route is a per-subject figure (e.g. the
 * CS customer detail's live sessions), and retrieval never serves it as a fleet
 * value on that surface — the surface reads null, like a metric not served there.
 */
export const isFleetEntry = (p: Pick<MetricPermission, "route">): boolean => !/\[[^\]]+\]/.test(p.route);

export interface SurfaceScope {
  definition: MetricDefinition;
  entry: MetricPermission;
  surface: MetricSurface;
  tier: IdentityTier;
}

/**
 * DOWNGRADE ONLY. The metric as `token` may read it on `surface` (a server-side
 * literal), at min(token tier, surface tier, the metric's tier there); null when
 * the token is forged, the metric unknown or invisible, or not served on the
 * surface — one branch, no oracle. Never raises a tier.
 */
export function atSurface(surface: MetricSurface, token: MetricAccessToken, metric: string): SurfaceScope | null {
  if (!isMetricAccessToken(token)) return null;
  const definition = describeMetric(token, metric);
  // describeMetric keeps only the entries the token satisfies; the one for this surface decides.
  const entry = definition?.permission.find((p) => p.area === surface) ?? null;
  if (!definition || !entry) return null;
  return { definition, entry, surface, tier: minTier(tokenTierOnSurface(surface, token), entry.identityTier) };
}

/**
 * DOWNGRADE ONLY. The most identity `token` may carry on `surface`: min(token
 * tier, surface tier), where the token's own tier is the surface area's tier
 * only when it holds a grant (or break-glass) on that area — CUSTOMER_SUCCESS
 * only on CUSTOMER_SUCCESS. Shared by atSurface and the navigation registry
 * (lib/platform/intelligence/navigation/access.ts), so both tier one way.
 */
export function tokenTierOnSurface(surface: MetricSurface, token: MetricAccessToken): IdentityTier {
  const tokenTier: IdentityTier = token.grants.some((g) => g.area === surface) ? SURFACE_TIER(surface) : "OPS";
  return minTier(tokenTier, SURFACE_TIER(surface));
}

/** The incident token at the effective tier, or null when the context's token cannot serve it. */
function incidentAt(tier: IdentityTier, token: CsToken | OpsToken | null | undefined, need: "ANY" | "CUSTOMER_SUCCESS_ONLY"): CsToken | OpsToken | null {
  if (token === null || token === undefined) return null;
  try {
    const audience = assertAudienceToken(token, ["CUSTOMER_SUCCESS", "PLATFORM_OPS"] as const);
    if (tier === "OPS") return need === "ANY" ? atOpsTier(token) : null;
    return audience === "CUSTOMER_SUCCESS" ? token : null;
  } catch {
    return null; // forged / unissued: nothing, like an unknown id
  }
}

// ── Aggregate guard ──────────────────────────────────────────────────────────

const MAX_PARTS = 8;
const PART_KEY = /^[a-z][A-Za-z]{0,31}$/;

/**
 * True for a number, or a flat object of ≤ 8 camelCase keys whose values are finite
 * numbers or null. `rankingParts` (S2 ruling 2026-11-05) names the declared ranking
 * parts that may instead hold a RankedCategory (isRankedCategory) — only those keys;
 * a projection is checked with none (it never supplies one).
 */
export function isAggregate(v: unknown, rankingParts: readonly string[] = []): v is AggregateValue {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length > 0 && entries.length <= MAX_PARTS
    && entries.every(([k, x]) => PART_KEY.test(k) && (x === null || (typeof x === "number" && Number.isFinite(x)) || (rankingParts.includes(k) && isRankedCategory(x))));
}

/** A server label: letters, spaces and ( ) & / - only — no digit, no identifier shape. */
const SERVER_LABEL = /^[A-Za-z][A-Za-z ()&/-]{0,47}$/;

/** EXACTLY { label, figure, window, qualifier }: a server label, a finite figure, a short window label or null, the fixed qualifier or null. */
export function isRankedCategory(x: unknown): x is RankedCategory {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return Object.keys(r).sort().join() === "figure,label,qualifier,window"
    && typeof r.label === "string" && SERVER_LABEL.test(r.label)
    && typeof r.figure === "number" && Number.isFinite(r.figure)
    && (r.window === null || (typeof r.window === "string" && r.window.length <= 80))
    && (r.qualifier === null || r.qualifier === RANKING_QUALIFIER);
}

/**
 * THE RANKING RULE (S2 ruling 2026-11-05), one named pure function: the largest
 * MEASURED category of an object value.
 *   · only parts declared role "category" are candidates — the total is NEVER one;
 *   · a null (unmetered / unpriced) or non-finite part is not measured: skipped, never $0;
 *   · the largest figure wins; a TIE (exactly equal figures) goes to the FIRST
 *     category in declared order (the `parts` declaration's key order);
 *   · no category measured ⇒ null;
 *   · the qualifier (RANKING_QUALIFIER) is set when any category part is null or
 *     the envelope status is not MEASURED (PARTIAL or ESTIMATED).
 * `window` is the envelope's own window label (server text).
 */
export function largestMeasuredCategory(
  value: Readonly<Record<string, number | null | RankedCategory>>, parts: PartDeclarations,
  opts: { status: RetrievalStatus; window: string | null },
): RankedCategory | null {
  let best: { label: string; figure: number } | null = null;
  let incomplete = opts.status !== "MEASURED";
  for (const [part, d] of Object.entries(parts)) {
    if (d.role !== "category") continue;
    const v = value[part];
    if (typeof v !== "number" || !Number.isFinite(v)) { incomplete = true; continue; }
    if (best === null || v > best.figure) best = { label: d.label, figure: v };
  }
  if (best === null) return null;
  return { label: best.label, figure: best.figure, window: opts.window, qualifier: incomplete ? RANKING_QUALIFIER : null };
}

/** The declared ranking parts of a declaration (none when it declares no parts). */
export const rankingPartsOf = (parts: PartDeclarations | undefined): string[] =>
  Object.entries(parts ?? {}).filter(([, d]) => d.role === "ranking").map(([k]) => k);

/** The role map an envelope carries (null when the metric declares no parts). */
const partRolesOf = (parts: PartDeclarations | undefined): Readonly<Record<string, PartRole>> | null =>
  parts ? Object.fromEntries(Object.entries(parts).map(([k, d]) => [k, d.role])) : null;

/** The category parts' server labels (null when the metric declares no category part). */
const partLabelsOf = (parts: PartDeclarations | undefined): Readonly<Record<string, string>> | null => {
  const cats = Object.entries(parts ?? {}).flatMap(([k, d]) => (d.role === "category" ? [[k, d.label] as const] : []));
  return cats.length > 0 ? Object.fromEntries(cats) : null;
};

// ── Retrieval ────────────────────────────────────────────────────────────────

const iso = (d: Date | string | null | undefined): string | null =>
  d instanceof Date ? (Number.isFinite(d.getTime()) ? d.toISOString() : null) : typeof d === "string" ? d : null;

/**
 * The Platform area that gates a records route, from its path segment
 * (/api/platform/<segment>/…). retrieve.test.ts pins, per registered drill,
 * that the route file guards with requirePlatformAccess(<this area>, …).
 */
const DRILL_SEGMENT_AREA: Readonly<Record<string, MetricSurface>> = {
  "platform-ops": "PLATFORM_OPS",
  "security-ops": "SECURITY_OPS",
  "growth-revenue": "GROWTH_REVENUE",
  "customer-success": "CUSTOMER_SUCCESS",
  "merchant-ops": "MERCHANT_OPS",
};
export const drillRouteArea = (api: string): MetricSurface | null => DRILL_SEGMENT_AREA[/^\/api\/platform\/([^/?]+)/.exec(api)?.[1] ?? ""] ?? null;

export const NO_DRILL_ON_SURFACE = "no drill on this surface";

/**
 * A drill only where the effective surface satisfies the drill route's own gate:
 * the route's area IS the surface the value is read on (that is the grant the
 * effective tier was derived from). Otherwise null + reason — never a link the
 * caller cannot open, and never a link from an identity-free surface into an
 * identity-bearing one.
 */
function drillOf(scope: SurfaceScope, window: number | null): Pick<MetricEnvelope, "drill" | "drillReason"> {
  const m = scope.definition;
  const figure = metricKey(m);
  if ("unavailable" in m.drill) return { drill: { figure, unavailable: m.drill.unavailable }, drillReason: null };
  // The surface's own link (per-surface drills) or the single link — and still only where its route's gate IS the surface.
  const link = drillLinkOn(m.drill, scope.surface);
  if (!link || drillRouteArea(link.api) !== scope.surface) return { drill: null, drillReason: NO_DRILL_ON_SURFACE };
  return { drill: { figure, window, href: link.api, page: link.page }, drillReason: null };
}

/** The projection's shape EXACTLY matches the declared units (a scalar ⇔ one unit; an object ⇔ the same parts). */
function unitsMatch(value: AggregateValue, units: ValueUnits | null): boolean {
  if (units === null) return false;
  if (typeof value === "number") return typeof units === "string";
  if (typeof units === "string") return false;
  const a = Object.keys(value).sort(), b = Object.keys(units).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** Named subjects, kept only when the label is a server label / registry slug and the state is in the closed vocabulary; at most MAX_SUBJECTS. */
function subjectsOnly(xs: readonly MetricSubject[]): MetricSubject[] {
  return xs.filter((x) => isSubjectLabel(x?.label) && (SUBJECT_STATES as readonly string[]).includes(x?.state)).slice(0, MAX_SUBJECTS).map((x) => ({ label: x.label, state: x.state }));
}

/** The reader's window start, kept only when it is exactly an ISO date (YYYY-MM-DD); anything else ⇒ null. */
const isoDateOrNull = (s: string | null | undefined): string | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

function envelope(scope: SurfaceScope, unit: MetricEnvelope["unit"], p: Projected, valueUnits: ValueUnits | null = null, estimatedParts: EstimatedParts | null = null, code: UnavailableCode | null = null): MetricEnvelope {
  const m = scope.definition;
  const base: MetricEnvelope["status"] = m.provenance.class === "ESTIMATED" ? "ESTIMATED" : "MEASURED";
  let value = p.value;
  let status: RetrievalStatus = p.status ?? base;
  let reason = p.reason ?? null;
  const days = p.days ?? null;
  const hours = p.hours ?? null;
  const windowLabel = p.windowLabel ?? (days !== null ? daysWindowLabel(days) : hours !== null ? hoursWindowLabel(hours) : m.window.label ?? null);
  const entry = RETRIEVAL[metricKey(m)];
  const unwindowedParts = entry?.kind === "RETRIEVABLE" ? entry.unwindowedParts ?? null : null;
  const parts = entry?.kind === "RETRIEVABLE" ? entry.parts : undefined;
  const ranking = rankingPartsOf(parts);
  const refuse = (why: string) => { value = null; status = "UNAVAILABLE"; reason = `projection refused: ${why}`; code = "PROJECTION_REFUSED"; };
  // The projection itself is a flat aggregate (no ranking entry may come from a reader).
  if (value !== null && !isAggregate(value)) refuse("not an aggregate");
  // S2 ruling 2026-11-05: a declared ranking part is SERVER-COMPUTED here from the
  // projection's own category parts — a projection that supplies one is refused.
  if (value !== null && ranking.length > 0) {
    const v = value;
    if (typeof v === "number" || ranking.some((k) => Object.prototype.hasOwnProperty.call(v, k))) refuse("a ranking part is server-computed, never projected");
    else {
      const ranked = largestMeasuredCategory(v, parts!, { status, window: windowLabel });
      value = { ...v, ...Object.fromEntries(ranking.map((k) => [k, ranked])) };
      if (!isAggregate(value, ranking)) refuse("not an aggregate");
    }
  }
  if (value !== null && !unitsMatch(value, valueUnits)) refuse("its parts do not match the declared units");
  if (value === null && status !== "UNAVAILABLE") status = "UNAVAILABLE";
  if (status === "UNAVAILABLE") { value = null; reason = reason ?? "no figure"; }
  if (status === "PARTIAL" && !reason) reason = "a floor";
  return {
    metric: metricKey(m),
    surface: scope.surface,
    tier: scope.tier,
    unit,
    valueUnits,
    estimatedParts,
    unwindowedParts,
    partRoles: partRolesOf(parts),
    partLabels: partLabelsOf(parts),
    value,
    status,
    reason,
    unavailableCode: status === "UNAVAILABLE" ? code ?? "NO_FIGURE" : null,
    window: { kind: m.window.kind, description: m.window.description, days, hours, label: windowLabel, start: isoDateOrNull(p.start) },
    freshness: { asOf: p.asOf, source: m.freshnessSource },
    coverage: { gaps: m.coverageGaps, missing: p.missing ?? [] },
    ...(p.subjects !== undefined ? { subjects: status === "UNAVAILABLE" ? null : subjectsOnly(p.subjects) } : {}),
    basis: { kind: m.provenance.class === "ESTIMATED" ? "estimated" : "measured", definition: metricKey(m), compute: `${m.compute.module}#${m.compute.symbol}`, reader: m.path[0].calls, answerClass: m.answerClass },
    ...drillOf(scope, days),
  };
}

/**
 * One metric's value on one surface. null ⇔ the caller may not read it there
 * (forged token, unknown, invisible, not served on the surface, or missing the
 * incident authority its reader needs) — indistinguishable from an unknown id.
 * A readable metric always returns an envelope: UNAVAILABLE + reason when it is
 * not retrievable, its parameters are invalid, or its reader fails.
 */
export async function retrieveWith(
  surface: MetricSurface,
  readers: RetrievalReaders,
  ctx: RetrievalContext,
  id: string,
  params: RetrievalParams = {},
  now: Date = new Date(),
): Promise<MetricEnvelope | null> {
  const scope = atSurface(surface, ctx?.metricToken, id);
  if (!scope) return null;
  const entry = RETRIEVAL[metricKey(scope.definition)];
  const unavailable = (code: UnavailableCode, reason: string, unit: MetricEnvelope["unit"] = "count", units: ValueUnits | null = null, est: EstimatedParts | null = null) =>
    envelope(scope, unit, { value: null, status: "UNAVAILABLE", reason, asOf: null }, units, est, code);

  if (!entry) return unavailable("NOT_RETRIEVABLE", "not retrievable: this metric version has no retrieval contract");
  if (entry.kind === "NOT_RETRIEVABLE") return unavailable("NOT_RETRIEVABLE", `not retrievable: ${entry.reason}`);
  // A per-subject permission entry (a /[param]/ records route) is never served as a fleet value.
  if (!isFleetEntry(scope.entry)) return null;

  let incident: CsToken | OpsToken | null = null;
  if (entry.incidentScoped) {
    incident = incidentAt(scope.tier, ctx.incidentToken, entry.incidentScoped);
    if (!incident) return null;
  }

  let window: number | null = null;
  if (params.window !== undefined) {
    if (!entry.windows.includes(params.window)) {
      return unavailable(entry.windows.length === 0 ? "WINDOW_FIXED" : "WINDOW_NOT_OFFERED", entry.windows.length === 0
        ? `this metric takes no window — its window is fixed: ${scope.definition.window.description}`
        : `window must be one of ${entry.windows.join(", ")} (days) — ${params.window} is not offered`, entry.unit, entry.valueUnits, entry.estimatedParts ?? null);
    }
    window = params.window;
  } else if (entry.windows.length > 0) window = entry.windows[0];

  try {
    const p = await entry.read({ readers, tier: scope.tier, incident, window, now });
    return envelope(scope, entry.unit, p, entry.valueUnits, entry.estimatedParts ?? null);
  } catch {
    // The reader's error text never enters the envelope (it could carry identifiers).
    return unavailable("READER_FAILED", `the reader (${READER_SYMBOL[entry.reader]}) failed — no figure, never 0`, entry.unit, entry.valueUnits, entry.estimatedParts ?? null);
  }
}

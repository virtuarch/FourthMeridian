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
 *   (the envelope becomes UNAVAILABLE). No per-user row, no identifier, no
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
import { drillLinkOn, metricKey, type IdentityTier, type MetricDefinition, type MetricPermission } from "./registry";
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

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The Economics status vocabulary (lib/platform/economics/snapshot-core.ts EconomicsStatus). */
export type RetrievalStatus = "MEASURED" | "ESTIMATED" | "PARTIAL" | "UNAVAILABLE";

/** A number, or a small fixed object of numbers (null = that part has no figure, never 0). */
export type AggregateValue = number | Readonly<Record<string, number | null>>;

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
  /** "usd" = US dollars (a number, or an object of dollar parts); "usd-and-counts" = dollars beside counts. */
  unit: "count" | "usd" | "usd-and-counts" | "counts";
  /** null ⇔ UNAVAILABLE. A floor / lower bound when PARTIAL. Never a stand-in 0. */
  value: AggregateValue | null;
  status: RetrievalStatus;
  /** Why there is no figure (UNAVAILABLE) or why it is a floor (PARTIAL); null otherwise. */
  reason: string | null;
  window: { kind: MetricDefinition["window"]["kind"]; description: string; days: number | null; hours: number | null };
  freshness: { asOf: string | null; source: string };
  coverage: { gaps: readonly string[]; missing: readonly string[] };
  /**
   * `kind` is "estimated" for a rate-card figure (provenance ESTIMATED: every dollar
   * here — never a bill) and "measured" for a counted one. A PARTIAL estimate is
   * still "estimated" (a lower bound of an estimate).
   */
  basis: { kind: "estimated" | "measured"; definition: `${string}@${number}`; compute: string; reader: string; answerClass: MetricDefinition["answerClass"] };
  /** null when the drill route's own gate is not this surface (the caller could not open it here) — see drillReason. */
  drill: MetricDrillDescriptor | null;
  /** Why `drill` is null; null when a drill is given. */
  drillReason: string | null;
}

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

/**
 * EVERY registered metric appears here exactly once (pinned): retrievable, or
 * NOT_RETRIEVABLE with the reason. Never silently omitted.
 */
export const RETRIEVAL: Readonly<Record<string, RetrievalEntry>> = {
  "provider-outcome@1": {
    kind: "RETRIEVABLE", reader: "providerHealth", unit: "counts", windows: [],
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
    async read({ readers, window, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      return fromFigure(s.trend.windows[TREND_OF[window ?? 30]], s.checkedAt, window);
    },
  },
  "economics-operating-cost@1": {
    // The Overview's hero (s.figures.operating_cost) and its split tiles (SPLIT_KEYS: AI / Providers / Infrastructure).
    kind: "RETRIEVABLE", reader: "economicsSnapshot", unit: "usd", windows: [],
    async read({ readers, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      const op = s.figures.operating_cost;
      const p = fromFigure(op, s.checkedAt);
      if (op.value === null) return p;
      // Each part is the split tile's own figure: null = unmetered / unpriced (never $0).
      return { ...p, value: { totalUsd: op.value, aiUsd: s.figures.ai_cost.value, providersUsd: s.figures.provider_cost.value, infrastructureUsd: s.figures.infra_cost.value } };
    },
  },
  "economics-provider-cost@1": {
    kind: "RETRIEVABLE", reader: "economicsSnapshot", unit: "usd", windows: [],
    async read({ readers, now }) {
      const s = await readers.economicsSnapshot(now.getTime());
      return fromFigure(s.figures.provider_cost, s.checkedAt);
    },
  },
  "ai-call-outcomes@1": {
    // The AI & Costs KPIs "Calls · 7 d" / "Error rate · 7 d": aiCallStats(i) (ai-costs-model.ts aiKpis).
    kind: "RETRIEVABLE", reader: "aiOperations", unit: "counts", windows: [7, 30],
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
    async read({ readers, window }) {
      const i = await readers.aiOperations(window === 30 ? "30d" : "7d");
      const c = aiCostPerCall(i);
      const base = { asOf: i.checkedAt, days: window };
      if (c.kind === "UNKNOWN") return { ...base, value: null, status: "UNAVAILABLE", reason: c.reason };
      const value = { usdPerCall: c.usd, pricedUsd: c.pricedUsd, returnedCalls: c.returned };
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
    async read({ readers, window }) {
      const p = await readers.productAnalytics();
      const w = window === 1 ? p.active.daily : window === 7 ? p.active.weekly : p.active.monthly;
      return { value: w.engaged, asOf: p.checkedAt ?? null, days: window };
    },
  },
  "growth-registrations@1": {
    // The route's default window is 90 (`raw === "30" ? 30 : 90`).
    kind: "RETRIEVABLE", reader: "acquisition", unit: "count", windows: [90, 30],
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
    async read({ readers }) {
      const m = await readers.merchantOverview();
      // The tile: formatCoveragePct(m.transactions.resolved, m.transactions.total) (merchant-model.ts).
      if (m.transactions.total <= 0) return { value: null, status: "UNAVAILABLE", reason: "no live transactions — the linked share is undefined (never 0%)", asOf: m.checkedAt ?? null };
      return { value: { linked: m.transactions.resolved, live: m.transactions.total }, asOf: m.checkedAt ?? null };
    },
  },
  "cs-needs-help@1": {
    kind: "RETRIEVABLE", reader: "csOverview", unit: "count", windows: [], incidentScoped: "CUSTOMER_SUCCESS_ONLY",
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
    async read({ readers, now }) {
      // The tile: d.totalActive / d.distinctUsers, which the route sets from this reader.
      const c = await readers.liveSessions(now);
      return { value: { sessions: c.sessions, distinctUsers: c.distinctUsers }, asOf: now.toISOString() };
    },
  },
  "accounts-with-live-session@1": {
    kind: "RETRIEVABLE", reader: "accountsWithLiveSession", unit: "count", windows: [],
    async read({ readers, now }) {
      // The tile: data.withLiveSession, which the Growth users route sets from this reader.
      return { value: await readers.accountsWithLiveSession(now), asOf: now.toISOString() };
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

/** True for a number, or a flat object of ≤ 8 camelCase keys whose values are finite numbers or null. */
export function isAggregate(v: unknown): v is AggregateValue {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length > 0 && entries.length <= MAX_PARTS
    && entries.every(([k, x]) => PART_KEY.test(k) && (x === null || (typeof x === "number" && Number.isFinite(x))));
}

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

function envelope(scope: SurfaceScope, unit: MetricEnvelope["unit"], p: Projected): MetricEnvelope {
  const m = scope.definition;
  const base: MetricEnvelope["status"] = m.provenance.class === "ESTIMATED" ? "ESTIMATED" : "MEASURED";
  let value = p.value;
  let status: RetrievalStatus = p.status ?? base;
  let reason = p.reason ?? null;
  if (value !== null && !isAggregate(value)) { value = null; status = "UNAVAILABLE"; reason = "projection refused: not an aggregate"; }
  if (value === null && status !== "UNAVAILABLE") status = "UNAVAILABLE";
  if (status === "UNAVAILABLE") { value = null; reason = reason ?? "no figure"; }
  if (status === "PARTIAL" && !reason) reason = "a floor";
  const days = p.days ?? null;
  return {
    metric: metricKey(m),
    surface: scope.surface,
    tier: scope.tier,
    unit,
    value,
    status,
    reason,
    window: { kind: m.window.kind, description: m.window.description, days, hours: p.hours ?? null },
    freshness: { asOf: p.asOf, source: m.freshnessSource },
    coverage: { gaps: m.coverageGaps, missing: p.missing ?? [] },
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
  const unavailable = (reason: string, unit: MetricEnvelope["unit"] = "count") =>
    envelope(scope, unit, { value: null, status: "UNAVAILABLE", reason, asOf: null });

  if (!entry) return unavailable("not retrievable: this metric version has no retrieval contract");
  if (entry.kind === "NOT_RETRIEVABLE") return unavailable(`not retrievable: ${entry.reason}`);
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
      return unavailable(entry.windows.length === 0
        ? `this metric takes no window — its window is fixed: ${scope.definition.window.description}`
        : `window must be one of ${entry.windows.join(", ")} (days) — ${params.window} is not offered`, entry.unit);
    }
    window = params.window;
  } else if (entry.windows.length > 0) window = entry.windows[0];

  try {
    const p = await entry.read({ readers, tier: scope.tier, incident, window, now });
    return envelope(scope, entry.unit, p);
  } catch {
    // The reader's error text never enters the envelope (it could carry identifiers).
    return unavailable(`the reader (${READER_SYMBOL[entry.reader]}) failed — no figure, never 0`, entry.unit);
  }
}

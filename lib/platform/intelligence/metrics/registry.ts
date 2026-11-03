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
  | "providers" | "economics" | "engagement" | "incidents" | "merchants" | "customers" | "growth" | "security";

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

export type MetricDrill =
  | { api: string; page: string; note?: string }
  | { unavailable: string };

export interface MetricWindow {
  kind: "ROLLING" | "POINT_IN_TIME" | "UTC_DAYS";
  description: string;
  timezone: "UTC";
  /** The constant that sets the window, when one exists. */
  source?: CodeRef;
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
    window: { kind: "ROLLING", timezone: "UTC", description: "Producing-job runs in the 7-day provider window; ProviderCall attempts in the 7-day roll-up." },
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
    coverageGaps: ["A small sample never reads Healthy (NOT_ENOUGH_DATA)", "ProviderCall roll-ups carry no order, so a recent failure streak is only visible in job runs"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/provider-health/route.ts" }],
    tiles: [
      { component: "components/platform/leads/providers-model.ts", reads: "assessOutcomes(" },
      { component: "components/platform/widgets/provider-view.ts", reads: "trustBadge(p.trust)" },
    ],
    drill: { api: "/api/platform/platform-ops/provider-health", page: page(PO) },
  },
  {
    id: "provider-connection", version: 1, domain: "providers",
    label: "Provider connection verdict",
    summary: "Whether a provider's live connection population says the PROVIDER is failing (a provider-side ERROR share), not one customer.",
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
    exclusion: ["REVOKED connections (reported as a neutral fact)", "Connections whose owner is inactive or pending deletion", "NEEDS_REAUTH never FAILS a provider (only a reauth wave DEGRADES it)"],
    freshnessSource: "The connection health authority (lib/connections/health.ts) — live columns",
    provenance: { class: "MEASURED" },
    coverageGaps: ["Without the authority's per-source tally the population is unknown and no share is computed", "No per-institution concentration rule (all of one institution failing while the provider is fine)"],
    permission: [{ area: PO, level: "READ", identityTier: "OPS", route: "app/api/platform/platform-ops/provider-health/route.ts" }],
    tiles: [{ component: "components/platform/widgets/provider-view.ts", reads: "trustBadge(p.trust)" }],
    drill: { api: "/api/platform/platform-ops/provider-health", page: page(PO) },
  },

  // ── economics ──────────────────────────────────────────────────────────────
  {
    id: "ai-fleet-spend-status", version: 1, domain: "economics",
    label: "AI fleet spend vs budget (24 h)",
    summary: "How priced the fleet's rolling 24-hour customer AI spend is, and what share of the fleet alert threshold it uses.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Trailing BUDGET_WINDOW_HOURS (24 h) from the reader's now.", source: { module: "lib/platform/ai/ai-budget.ts", symbol: "BUDGET_WINDOW_HOURS" } },
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

  // ── engagement (PB-10) ─────────────────────────────────────────────────────
  {
    id: "presence-state", version: 1, domain: "engagement",
    label: "Customer presence (Active now / Online, idle / Offline)",
    summary: "One customer's presence bucket from the visible-tab heartbeat clocks — presence, never engagement.",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "PRESENCE_CONFIG windows from the reader's now (database clock).", source: { module: "lib/presence/definitions.ts", symbol: "PRESENCE_CONFIG" } },
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
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "Trailing 1 / 7 / 30 UTC calendar days (ENGAGEMENT_WINDOW_DAYS); Growth's tile shows the 30-day figure.", source: { module: "lib/presence/definitions.ts", symbol: "ENGAGEMENT_WINDOW_DAYS" } },
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
    window: { kind: "UTC_DAYS", timezone: "UTC", description: "The last 30 or 90 UTC days (?window=30|90)." },
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
    ],
    drill: { api: "/api/platform/platform-ops/incidents", page: page(PO) },
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
    summary: "UserSession rows that can still authenticate now: not revoked, inside the SEC-010 idle and absolute lifetime, and owned by an open account (not deactivated, not scheduled for deletion).",
    answerClass: "CALCULATED",
    window: { kind: "ROLLING", timezone: "UTC", description: "Idle and absolute cut-offs measured back from the reader's now (SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_LIFETIME_MS).", source: { module: "lib/auth/session-proof.ts", symbol: "SESSION_IDLE_TIMEOUT_MS" } },
    numerator: { description: "Sessions matching liveSessionWhere(now): revokedAt IS NULL ∧ createdAt ≥ now − absolute ∧ lastActiveAt ≥ now − idle ∧ owner not locked out.", source: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" } },
    denominator: null,
    compute: { module: "lib/auth/session-proof.ts", symbol: "liveSessionWhere" },
    path: [
      { file: "app/api/platform/security-ops/sessions/route.ts", calls: "liveSessionWhere" },
    ],
    inclusion: ["Non-revoked sessions inside both lifetimes", "Owner deactivatedAt IS NULL ∧ deletionScheduledAt IS NULL"],
    exclusion: ["Revoked sessions", "Idle- or absolute-expired rows that were never revoked", "Sessions of deactivated or deletion-scheduled accounts"],
    freshnessSource: "UserSession rows, read on request",
    provenance: { class: "MEASURED" },
    coverageGaps: ["A live session is NOT proof a browser is open (that is presence-state@1)", "Growth's 'Live sessions' counts distinct customer accounts with a live session, not session rows"],
    permission: [
      { area: "SECURITY_OPS", level: "READ", identityTier: "OPS", route: "app/api/platform/security-ops/sessions/route.ts" },
      { area: CS, level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "app/api/platform/customer-success/customers/[userId]/route.ts" },
      { area: GR, level: "READ", identityTier: "OPS", route: "app/api/platform/growth-revenue/users/route.ts" },
    ],
    tiles: [
      { component: "components/platform/widgets/security-posture-view.ts", reads: "d.totalActive" },
      { component: "components/platform/widgets/CsCustomersWidget.tsx", reads: "detail.activity.activeSessions" },
      { component: "components/platform/widgets/OpsUsersWidget.tsx", reads: "data.withLiveSession" },
    ],
    drill: { api: "/api/platform/security-ops/sessions", page: page("SECURITY_OPS"), note: "The newest live sessions as browser · device · OS — a bounded page, never a session id or token." },
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
  if ("unavailable" in m.drill ? !m.drill.unavailable.trim() : !m.drill.api.startsWith("/api/platform/")) p.push(`${k}: drill is a /api/platform/ records route or a stated reason`);
  return p;
}

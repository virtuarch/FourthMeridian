/**
 * lib/platform/intelligence/metrics/retrieve.test.ts  (Platform Intelligence — Phase 3 retrieval contracts, slice 1)
 *
 * Pins for retrieve-core.ts / retrieve.ts (fixtures only, no database):
 *   1. registry coverage — every registered metric is retrievable or listed
 *      NOT_RETRIEVABLE with a reason; nothing silently omitted;
 *   2. one reader — each retrievable metric is bound to exactly the function its
 *      registry path names, in retrieve.ts's source;
 *   3. PARITY — value and status equal the tile's on the same fixture;
 *   4. authority — forged token ⇒ null; invisible ≡ unknown; break-glass
 *      downgraded per surface; the incident reader receives the downgraded token;
 *   5. honest absence — a failing reader ⇒ null + reason, per metric; never 0;
 *   6. aggregates only — identity scan of every envelope (CS tier and
 *      break-glass on an Ops surface); the aggregate guard;
 *   7. drill = the registry's records route, a descriptor only, and only on the
 *      surface whose area gates that route (else null + drillReason);
 *   8. static — no mint path, surface literals at every call site, no writes
 *      or caching, importers bounded.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/metrics/retrieve.test.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { METRICS, drillLinkOn, drillLinks, metricKey } from "./registry";
import { metricAccessFor, type MetricAccessToken } from "./access";
import {
  NO_DRILL_ON_SURFACE, RANKING_QUALIFIER, READER_SYMBOL, RETRIEVAL, SUBJECT_STATES, UNAVAILABLE_CODES, atSurface, isSubjectLabel, drillRouteArea, isAggregate, isFleetEntry, isRankedCategory,
  largestMeasuredCategory, retrieveWith,
  type MetricEnvelope, type PartDeclarations, type RankedCategory, type RetrievalContext, type RetrievalReaders,
} from "./retrieve-core";
import { incidentAudienceFor, type CsToken, type OpsToken } from "@/lib/platform/incidents/intelligence/audience";
import { fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import { formatCoveragePct } from "@/lib/platform/merchant/records-core";
import { growthKpis } from "@/components/platform/leads/growth-model";
import { coverageLabel } from "@/components/platform/leads/merchant-model";
import { csKpis } from "@/components/platform/leads/customer-success-model";
import { incidentTotalText } from "@/components/platform/incidents/incidents-model";
import { sessionsReadings } from "@/components/platform/widgets/security-posture-view";
import type { AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import type { AcquisitionResponse } from "@/lib/platform/growth/acquisition-types";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import type { MerchantOverviewResponse } from "@/lib/platform/merchant/overview-types";
import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";
import type { ProviderHealthResult } from "@/lib/platform/provider-health";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import type { PlaidItemFact } from "@/lib/platform/plaid/item-months";
import { PLAID_RATES } from "@/lib/usage/pricing";
import { getEconomicsSnapshot, type EconomicsDeps } from "@/lib/platform/economics/snapshot";
import { splitFigures } from "@/components/platform/leads/economics-model";
import { aiKpis, costPerCall, usd } from "@/components/platform/leads/ai-costs-model";
import { providerEntities, providerKpis } from "@/components/platform/leads/providers-model";
import { NO_EVALUABLE_PROVIDER } from "@/lib/platform/verdicts/provider-outcome";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fetched = <T,>(data: T) => ({ data, loading: false, error: null });
const NOW = new Date("2026-11-04T12:00:00.000Z");

// ── fixtures (identity-laden on purpose: the envelope must carry none of it) ─

const CUID = "ckq1x2y3z4a5b6c7d8e9f0g1h";
const EMAIL = "someone@example.test";

const providerFx = (): Pick<ProviderHealthResult, "checkedAt" | "providers"> => ({
  checkedAt: NOW,
  providers: [
    { key: "A", label: `Provider ${EMAIL}`, execution: { verdict: "HEALTHY" }, connections: { verdict: null, tally: { active: 3, error: 0, reauth: 0, unclassified: 0, revoked: 0 } }, notes: [`user #12 ${CUID}`] },
    { key: "B", label: "B", execution: { verdict: "FAILING" }, connections: { verdict: "FAILING", tally: { active: 4, error: 3, reauth: 0, unclassified: 0, revoked: 0 } }, notes: [] },
    { key: "C", label: "C", execution: { verdict: "NOT_ENOUGH_DATA" }, connections: null, notes: [] },
    { key: "D", label: "D", execution: null, notes: [] },
    { key: "E", label: "E", execution: { verdict: "DEGRADED" }, connections: { verdict: "DEGRADED", rule: "any-error", tally: { active: 9, error: 1, reauth: 0, unclassified: 0, revoked: 0 } }, notes: [] },
    { key: "F", label: "F", execution: { verdict: "HEALTHY" }, connections: { verdict: "DEGRADED", rule: "institution-concentrated", tally: { active: 6, error: 4, reauth: 0, unclassified: 0, revoked: 0, institutions: [{ active: 4, error: 4, reauth: 0 }, { active: 2, error: 0, reauth: 0 }] } }, notes: [] },
  ],
} as unknown as Pick<ProviderHealthResult, "checkedAt" | "providers">);

const aiFx = (over: Partial<AiBudgetUtilization["fleet"]> = {}, unpriced = 2): AiBudgetUtilization => ({
  checkedAt: NOW.toISOString(), windowHours: 24,
  fleet: { estimatedUsd: 12.5, thresholdUsd: 50, alertEnabled: true, utilizationPct: 25, invocations: 40, customers: 3, ...over },
  overhead: { estimatedUsd: 1, invocations: 2 },
  customers: [{ ref: "user #7", userId: CUID, email: EMAIL, estimatedUsd: 9 }],
  bySurface: [{ surface: "chat", customer: true, unpricedInvocations: unpriced }],
  unpriced: { invocations: unpriced, models: ["m"] },
  recentAlerts: [], controls: {},
} as unknown as AiBudgetUtilization);

const acqFx = (perDay: { day: string; count: number | null }[] = [{ day: "2026-11-03", count: 4 }, { day: "2026-11-04", count: 3 }], notes: string[] = []): AcquisitionResponse => ({
  checkedAt: NOW.toISOString(), windowDays: 90, from: "2026-08-07", to: "2026-11-04",
  requests: { perDay: [], total: 9 }, registrations: { perDay, total: perDay.reduce((a, d) => a + (d.count ?? 0), 0) },
  waitlist: { pending: 1, invited: 0, invitedExpired: 0, redeemed: 0, declined: 0, revoked: 0 }, notes,
} as unknown as AcquisitionResponse);

const paFx = (): ProductAnalyticsResponse => ({
  checkedAt: NOW.toISOString(), windowDays: 30,
  registrations: { total: 20, deactivated: 2, last7d: 1, last30d: 5, perDay: [] },
  active: { daily: { present: 3, engaged: 2, signIns: 4 }, weekly: { present: 7, engaged: 6, signIns: 8 }, monthly: { present: 12, engaged: 11, signIns: 13 }, perDay: [] },
} as unknown as ProductAnalyticsResponse);

const merchantFx = (resolved = 7986, total = 8014): MerchantOverviewResponse => ({
  checkedAt: NOW.toISOString(), windowDays: 30, transactions: { total, resolved, coverage: { eligible: 0, eligibleLinked: 0 }, bySource: [] }, notes: [],
} as unknown as MerchantOverviewResponse);

const csFx = (floor = false): CsOverviewResponse => ({
  checkedAt: NOW.toISOString(), windowDays: 30,
  customers: { active: 17, deactivated: 2 }, stages: [],
  attention: { customers: 5, floor, reasons: [{ key: "reconnect", label: `user #3 ${EMAIL}`, count: 5 }] },
  incidents: { days: [], floor: false, openByKind: [], open: 0, openFloor: false }, notes: [],
} as unknown as CsOverviewResponse);

type SearchResult = Awaited<ReturnType<RetrievalReaders["incidentSearch"]>>;
const searchFx = (truncated = false): SearchResult => ({
  // A real search result also carries items; these identity-laden ones must never reach the envelope.
  items: [{ brokenNow: true, subjectUserId: CUID, customer: { email: EMAIL, ref: "user #9" } }],
  total: 3, page: 1, pageSize: 25, truncated, scanned: 500, facets: { providers: [], operations: [], codes: [] },
} as unknown as SearchResult);

// Economics: the REAL snapshot reader (getEconomicsSnapshot) over synthetic ledger deps — the same world the Overview tile reads.
const ecoGroup = (day: string, surface: string | null, o: Partial<SpendGroup> = {}): SpendGroup => ({
  provider: "OPENAI", model: "gpt-5-mini", surface, day, invocations: 2, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000, ...o,
});
const ECO_GROUPS: SpendGroup[] = [ecoGroup("2026-11-01", "chat"), ecoGroup("2026-11-02", "brief"), ecoGroup("2026-11-04", "harness"), ecoGroup("2026-10-20", "chat"), ecoGroup("2026-09-10", "chat")];
const ecoItem = (id: string): PlaidItemFact => ({ id, externalItemId: `ext_${id}`, createdAt: "2026-08-01T00:00:00Z", status: "ACTIVE", investmentsConsent: null, environment: "production", plaidEnvironment: "production" } as PlaidItemFact);
const ecoDeps = (o: { groups?: SpendGroup[]; aiPricingConfigured?: boolean; plaidRates?: EconomicsDeps["plaidRates"]; items?: number } = {}): EconomicsDeps => ({
  groups: async () => o.groups ?? ECO_GROUPS,
  plaidReaders: { items: async () => Array.from({ length: o.items ?? 2 }, (_, i) => ecoItem(`p${i + 1}`)), transitions: async () => [] },
  engagedSince: async () => new Set([CUID]),
  aiPricingConfigured: o.aiPricingConfigured ?? true,
  plaidRates: o.plaidRates ?? PLAID_RATES,
  ref: () => "user #00x",
});

// AI & Costs: the ai-invocations payload (AiOperations) the tile's aiKpis folds.
const aiOpsFx = (over: { invocations?: number; usd?: number | null; unpricedTokens?: number; failed?: number; pricing?: boolean } = {}): AiOperations => ({
  totals: { invocations: over.invocations ?? 58, usd: over.usd === undefined ? 1.45 : over.usd, unpricedTokens: over.unpricedTokens ?? 0 },
  failures: { failed: over.failed ?? 2, timeouts: 0, rateLimited: 0, quota: 0, total: over.failed ?? 2 },
  pricingConfigured: over.pricing ?? true,
  recent: [{ correlationId: CUID, subSurface: `user #4 ${EMAIL}` }],
  checkedAt: NOW.toISOString(),
} as unknown as AiOperations);


// ── operations fixtures (Platform AI briefing, 2026-11-08) — identity-laden on purpose ──
const INSTITUTION = "Capital One";
const overviewFx = (states: Record<string, string> = { pipeline: "FAILED", sources: "DEGRADED", jobs: "HEALTHY", ai: "HEALTHY", brief: "UNKNOWN", plaid: "HEALTHY" }) => ({
  checkedAt: NOW.toISOString(), worst: "FAILED",
  domains: Object.entries(states).map(([key, state]) => ({
    key, state, title: `${key} ${EMAIL}`, headline: `user #3 ${CUID}`, basis: "x", workspace: "x",
    figure: { value: "1 of 2 failed", qualifier: INSTITUTION },
    facts: key === "pipeline" ? [{ label: "Executions", value: "12" }, { label: "Failed", value: "3" }, { label: "Running now", value: "1" }, { label: "Last bank success", value: INSTITUTION }] : [],
  })),
  latestFailures: [{ id: CUID, userId: CUID, institution: INSTITUTION }],
} as unknown as Awaited<ReturnType<RetrievalReaders["operationsOverview"]>>);
const attentionFx = (o: { failed?: string[]; users?: { count: number | null; reason: string | null } } = {}) => ({
  checkedAt: NOW.toISOString(),
  items: [{ id: CUID, entity: { label: EMAIL } }],
  userImpact: {
    windowHours: 24,
    rows: [{ id: CUID, kind: "needs-reauth", label: `Connection · ${INSTITUTION}`, reference: { kind: "user", tail: "abc123" }, count: 1 }],
    counts: { "refresh-failed": 2, "refresh-partial": 1, "ai-failure": 4, "brief-failed": 0, "needs-reauth": 3 },
    usersAffected: o.users ?? { count: 5, reason: null }, sourcesAffected: 2,
    authorities: { checked: ["refresh-executions", "ai-failures", "brief-ops", "connection-health"].filter((a) => !(o.failed ?? []).includes(a)), failed: o.failed ?? [] },
    floors: [],
  },
} as unknown as Awaited<ReturnType<RetrievalReaders["attention"]>>);
const alertRunsFx = (o: { blind?: boolean } = {}) => [{
  evaluatedAtISO: NOW.toISOString(), deliveryStatus: "DELIVERED", destination: EMAIL, counts: {},
  rules: [
    { id: "job-failing", kind: "job", enabled: true, live: true, firing: true, breaches: 2, severity: "critical" },
    { id: "resource-stale", kind: "resource", enabled: true, live: true, firing: true, breaches: 1, severity: "warning" },
    { id: EMAIL, kind: "x", enabled: true, live: true, firing: true, breaches: 1, severity: "warning" },
    { id: "quota-low", kind: "quota", enabled: true, live: true, firing: false, breaches: 0, severity: null, notEvaluable: "no data" },
    { id: "provider-unhealthy", kind: "provider", enabled: false, live: true, firing: false, breaches: 0, severity: null },
  ],
  authorities: o.blind ? { jobHealth: "failed" } : {},
}] as unknown as Awaited<ReturnType<RetrievalReaders["alertRuns"]>>;
const connectionFx = (withTally = true) => ({
  total: 10, counts: { HEALTHY: 5, STALE: 1, DEGRADED: 1, NEEDS_REAUTH: 1, ERROR: 2, REVOKED: 0 },
  unhealthy: [{ id: CUID, institution: INSTITUTION, owner: EMAIL, errorCode: "NO_ACCOUNTS" }],
  checkedAt: NOW.toISOString(), cap: 20, listedScope: "unhealthy", retired: { revoked: 1, ownerInactive: 0 },
  ...(withTally ? { bySource: { PLAID: { active: 10, revoked: 1, faults: [
    { healthState: "ERROR", errorCode: "NO_ACCOUNTS", count: 1 },
    { healthState: "ERROR", errorCode: "INSTITUTION_DOWN", count: 1 },
    { healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", count: 1 },
  ] } } } : {}),
} as unknown as Awaited<ReturnType<RetrievalReaders["connectionHealth"]>>);
const jobsFx = () => ({
  checkedAt: NOW,
  jobs: [
    { job: "sync-banks", status: "failing", lastFailureSummary: `boom ${EMAIL} ${CUID}` },
    { job: "fetch-fx-rates", status: "healthy" },
    { job: "evaluate-alerts", status: "overdue" },
    { job: "purge-trash", status: "not-scheduled" },
  ],
} as unknown as Awaited<ReturnType<RetrievalReaders["jobHealth"]>>);
const freshnessFx = () => ({
  checkedAt: NOW,
  resources: [{ resource: "fx-rates", label: `FX ${EMAIL}`, healthState: "stale" }, { resource: "security-prices", label: "x", healthState: "fresh" }],
} as unknown as Awaited<ReturnType<RetrievalReaders["resourceFreshness"]>>);

const LIVE_FX = { sessions: 7, distinctUsers: 3 };
const ACCOUNTS_FX = 2;

interface Recorder { incidentAudiences: string[]; csAudiences: string[]; windows: number[]; aiWindows: string[] }
function readers(rec: Recorder, over: Partial<RetrievalReaders> = {}): RetrievalReaders {
  return {
    providerHealth: async () => providerFx(),
    aiBudget: async () => aiFx(),
    acquisition: async (w) => { rec.windows.push(w); return acqFx(); },
    productAnalytics: async () => paFx(),
    incidentSearch: async (t) => { rec.incidentAudiences.push(t.audience); return searchFx(); },
    merchantOverview: async () => merchantFx(),
    csOverview: async (t) => { rec.csAudiences.push(t.audience); return csFx(); },
    liveSessions: async () => ({ ...LIVE_FX }),
    accountsWithLiveSession: async () => ACCOUNTS_FX,
    economicsSnapshot: (nowMs) => getEconomicsSnapshot(nowMs, ecoDeps()),
    aiOperations: async (w) => { rec.aiWindows.push(w); return aiOpsFx(); },
    operationsOverview: async () => overviewFx(),
    attention: async (t) => { rec.incidentAudiences.push(t.audience); return attentionFx(); },
    alertRuns: async () => alertRunsFx(),
    connectionHealth: async () => connectionFx(),
    jobHealth: async () => jobsFx(),
    resourceFreshness: async () => freshnessFx(),
    ...over,
  };
}
const newRec = (): Recorder => ({ incidentAudiences: [], csAudiences: [], windows: [], aiWindows: [] });

// ── tokens, from the same guard-result shapes the routes pass ────────────────
const user = (role: UserRole) => ({ role });
const grant = (area: string, level = "READ") => ({ area, level }) as never;
const ctxFor = (role: UserRole, g: ReturnType<typeof grant> | null): RetrievalContext => ({
  metricToken: metricAccessFor({ user: user(role), grant: g })!,
  incidentToken: incidentAudienceFor({ user: user(role), grant: g }),
});
const OPS = ctxFor(UserRole.USER, grant("PLATFORM_OPS"));
const CS = ctxFor(UserRole.USER, grant("CUSTOMER_SUCCESS"));
const GR = ctxFor(UserRole.USER, grant("GROWTH_REVENUE"));
const MO = ctxFor(UserRole.USER, grant("MERCHANT_OPS"));
const SA = ctxFor(UserRole.SYSTEM_ADMIN, null);

const retrievable = METRICS.filter((m) => RETRIEVAL[metricKey(m)]?.kind === "RETRIEVABLE");

async function main(): Promise<void> {
console.log("\nmetric retrieval\n");

// ── 1. registry coverage ─────────────────────────────────────────────────────
console.log("1. every registered metric is retrievable or NOT_RETRIEVABLE with a reason");
{
  const keys: string[] = METRICS.map(metricKey);
  const missing = keys.filter((k) => !RETRIEVAL[k]);
  const stray = Object.keys(RETRIEVAL).filter((k) => !keys.includes(k));
  check("every registered metric has a retrieval entry (none silently omitted)", missing.length === 0, missing.join(", "));
  check("every retrieval entry names a registered metric", stray.length === 0, stray.join(", "));
  const blank = Object.entries(RETRIEVAL).filter(([, e]) => e.kind === "NOT_RETRIEVABLE" && e.reason.trim().length < 20).map(([k]) => k);
  check("every NOT_RETRIEVABLE entry states its reason", blank.length === 0, blank.join(", "));
  const table = Object.entries(RETRIEVAL).map(([k, e]) => `${k}=${e.kind === "RETRIEVABLE" ? "R" : "N"}`).join(" ");
  console.log(`    ${table}`);
  check("the per-subject and per-row metrics are NOT_RETRIEVABLE",
    ["presence-state@1", "incident-alertable@1"].every((k) => RETRIEVAL[k]?.kind === "NOT_RETRIEVABLE"));
  check("the live-session counts are retrievable through the shared readers (#361)",
    ["live-sessions@1", "accounts-with-live-session@1"].every((k) => RETRIEVAL[k]?.kind === "RETRIEVABLE"));
}

// ── 2. one reader: the registry's path, bound in retrieve.ts ────────────────
console.log("\n2. each retrievable metric reads ONLY the reader its registry path names");
{
  const bind = code(src("lib/platform/intelligence/metrics/retrieve.ts"));
  for (const m of retrievable) {
    const e = RETRIEVAL[metricKey(m)];
    if (e.kind !== "RETRIEVABLE") continue;
    const sym = READER_SYMBOL[e.reader];
    check(`${metricKey(m)}: reader ${e.reader} = ${sym} = the route's call (path[0].calls)`, sym === m.path[0].calls, m.path[0].calls);
    const owner = sym.split(".")[0];
    // The module the ROUTE imports the reader from (the same specifier must appear in retrieve.ts).
    const routeImport = code(src(m.path[0].file)).match(new RegExp(`import\\s*\\{[^}]*\\b${owner}\\b[^}]*\\}\\s*from\\s*"@/([^"]+)"`));
    const readerModule = routeImport?.[1];
    check(`${metricKey(m)}: retrieve.ts binds ${e.reader} to ${sym}( imported from ${readerModule}`,
      new RegExp(`\\b${e.reader}:\\s*\\([^)]*\\)\\s*=>\\s*${esc(sym)}\\(`).test(bind)
      && !!readerModule && new RegExp(`import\\s*\\{[^}]*\\b${owner}\\b[^}]*\\}\\s*from\\s*"@/${esc(readerModule)}"`).test(bind));
  }
  const keys = Object.keys(READER_SYMBOL);
  check("retrieve.ts binds every reader key and nothing else",
    keys.every((k) => new RegExp(`\\b${k}:\\s*\\(`).test(bind)) && (bind.match(/^\s{2}\w+:\s*\(/gm) ?? []).length === keys.length);
  check("the AI projection uses THE tile function (fleetSpendStatus), not a re-derivation",
    /fleetSpendStatus\(b\)/.test(code(src("lib/platform/intelligence/metrics/retrieve-core.ts"))));
}

// ── 3. parity with the tiles ─────────────────────────────────────────────────
console.log("\n3. PARITY — the retrieved value and status equal the tile's on the same fixture");
await (async () => {
  const rec = newRec();
  const R = readers(rec);
  const get = (surface: Parameters<typeof retrieveWith>[0], ctx: RetrievalContext, id: string, params = {}) => retrieveWith(surface, R, ctx, id, params, NOW);

  const po = await get("PLATFORM_OPS", OPS, "provider-outcome");
  const pf = providerFx();
  const byVerdict = (v: string | null) => pf.providers.filter((p) => (p.execution?.verdict ?? null) === v).length;
  check("provider-outcome: counts = the reader's own execution verdicts (the tile's per-row verdict, tallied)",
    JSON.stringify(po?.value) === JSON.stringify({ healthy: byVerdict("HEALTHY"), degraded: byVerdict("DEGRADED"), failing: byVerdict("FAILING"), notEnoughData: byVerdict("NOT_ENOUGH_DATA"), noRuns: byVerdict(null) })
    && po?.status === "PARTIAL", JSON.stringify(po?.value));
  check("provider-outcome: SOME providers unevaluated (no runs / not enough data) ⇒ PARTIAL with the counts and why, never MEASURED",
    po?.status === "PARTIAL" && /only 4 providers of 6 could be evaluated/.test(po.reason ?? "")
    && po.coverage.missing.join("|") === "1 provider with no run in the window|1 provider with not enough data for a verdict", JSON.stringify(po?.coverage.missing));
  const allEval = { checkedAt: NOW, providers: providerFx().providers.filter((p) => p.execution && p.execution.verdict !== "NOT_ENOUGH_DATA") } as Pick<ProviderHealthResult, "checkedAt" | "providers">;
  const poM = await retrieveWith("PLATFORM_OPS", readers(newRec(), { providerHealth: async () => allEval }), OPS, "provider-outcome", {}, NOW);
  check("provider-outcome: every provider evaluable ⇒ MEASURED", poM?.status === "MEASURED" && (poM.value as Record<string, number>).healthy === 2, JSON.stringify(poM));
  // The Preview world: crons do not run, so every provider has no run or too few.
  const noneEval = { checkedAt: NOW, providers: [
    { key: "PLAID", label: "Plaid", execution: { verdict: "NOT_ENOUGH_DATA" }, connections: null, notes: [] },
    { key: "OPEN_EXCHANGE_RATES", label: "Open Exchange Rates", execution: null, connections: null, notes: [] },
  ] } as unknown as Pick<ProviderHealthResult, "checkedAt" | "providers">;
  const poU = await retrieveWith("PLATFORM_OPS", readers(newRec(), { providerHealth: async () => noneEval }), OPS, "provider-outcome", {}, NOW);
  check("provider-outcome: NO provider evaluable ⇒ UNAVAILABLE (value null, never '0 healthy'), reason names the environment",
    poU?.status === "UNAVAILABLE" && poU.value === null && (poU.reason ?? "").includes(NO_EVALUABLE_PROVIDER)
    && poU.coverage.missing.length === 2, JSON.stringify(poU));
  check("provider-outcome: the envelope-status rule is written into the registry definition (and so the envelope)",
    (poU?.coverage.gaps ?? []).some((g) => /^Envelope status rule/.test(g) && /UNAVAILABLE when none does/.test(g)));
  // Tile parity (same world): the Providers "Providers healthy" KPI shows no count either.
  const provInputs = (providers: unknown[]) => ({
    health: fetched({ checkedAt: NOW.toISOString(), counts: {}, providers }), apiUsage: fetched(null), email: fetched(null), plaid: fetched(null),
    operations: fetched(null), trend: fetched(null), nowMs: NOW.getTime(),
  }) as never;
  const tileProviders = [
    { key: "PLAID", label: "Plaid", trust: "INSUFFICIENT_DATA", notes: [], freshness: { state: "not-refreshed" } },
    { key: "OPEN_EXCHANGE_RATES", label: "Open Exchange Rates", trust: "UNKNOWN", notes: [], freshness: { state: "unknown" } },
  ];
  const tileKpi = providerKpis(providerEntities(provInputs(tileProviders)), provInputs(tileProviders)).find((k) => k.key === "healthy")!;
  check("Providers tile parity: nothing assessed ⇒ 'Providers healthy' reads '—' with the same reason (never '0/2')",
    tileKpi.value === "—" && tileKpi.sub.includes(NO_EVALUABLE_PROVIDER) && tileKpi.tone === "muted", JSON.stringify(tileKpi));
  const tileOk = [{ ...tileProviders[0], trust: "OPERATIONAL" }, tileProviders[1]];
  const tileKpiOk = providerKpis(providerEntities(provInputs(tileOk)), provInputs(tileOk)).find((k) => k.key === "healthy")!;
  check("…and once one provider is assessed the tile counts again (1/2 · 1 not assessed)", tileKpiOk.value === "1/2" && tileKpiOk.sub === "1 not assessed", JSON.stringify(tileKpiOk));
  // Re-pinned (provider-connection@2): the key is @2, and the institution-concentrated
  // DEGRADED verdicts are counted inside `degraded` AND named on their own.
  const pc = await get("PLATFORM_OPS", OPS, "provider-connection@2");
  check("provider-connection@2: counts = the reader's own connection verdicts (institutionConcentrated ⊂ degraded)",
    JSON.stringify(pc?.value) === JSON.stringify({ failing: 1, degraded: 2, institutionConcentrated: 1, noVerdict: 1, noConnections: 2 }) && pc?.status === "PARTIAL", JSON.stringify(pc?.value));
  check("provider-connection@2: some providers without a connection population ⇒ PARTIAL, named", pc?.coverage.missing.includes("2 providers with no connection population") === true, JSON.stringify(pc?.coverage.missing));
  const pcU = await retrieveWith("PLATFORM_OPS", readers(newRec(), { providerHealth: async () => noneEval }), OPS, "provider-connection@2", {}, NOW);
  check("provider-connection@2: no provider reports a connection population ⇒ UNAVAILABLE, never measured zeros", pcU?.status === "UNAVAILABLE" && pcU.value === null && !!pcU.reason, JSON.stringify(pcU));
  const allConn = { checkedAt: NOW, providers: providerFx().providers.filter((p) => p.connections) } as Pick<ProviderHealthResult, "checkedAt" | "providers">;
  check("provider-connection@2: every provider assessed ⇒ MEASURED",
    (await retrieveWith("PLATFORM_OPS", readers(newRec(), { providerHealth: async () => allConn }), OPS, "provider-connection@2", {}, NOW))?.status === "MEASURED");
  check("provider-connection@1 is retired: no longer retrievable", (await get("PLATFORM_OPS", OPS, "provider-connection@1")) === null);

  const ai = await get("PLATFORM_OPS", OPS, "ai-fleet-spend-status");
  const tile = fleetSpendStatus(aiFx());
  check("ai-fleet-spend-status: value and status = fleetSpendStatus(b) (the tile function)",
    ai?.status === tile.status && (ai?.value as Record<string, number>).pricedUsd === tile.pricedUsd
    && (ai?.value as Record<string, number>).utilisationPct === tile.utilisationPct && (ai?.value as Record<string, number>).unpricedInvocations === tile.unpricedInvocations,
    JSON.stringify(ai?.value));
  const aiE = await retrieveWith("PLATFORM_OPS", readers(newRec(), { aiBudget: async () => aiFx({}, 0) }), OPS, "ai-fleet-spend-status", {}, NOW);
  check("…fully priced ⇒ ESTIMATED (never MEASURED: no invoice)", aiE?.status === "ESTIMATED" && fleetSpendStatus(aiFx({}, 0)).status === "ESTIMATED");
  const aiU = await retrieveWith("PLATFORM_OPS", readers(newRec(), { aiBudget: async () => aiFx({ estimatedUsd: null, invocations: 0 }, 0) }), OPS, "ai-fleet-spend-status", {}, NOW);
  const tileU = fleetSpendStatus(aiFx({ estimatedUsd: null, invocations: 0 }, 0));
  check("…nothing priced ⇒ UNAVAILABLE + the tile's reason, value null (never $0)",
    aiU?.status === "UNAVAILABLE" && aiU.value === null && aiU.reason === tileU.reason, JSON.stringify(aiU));
  const aiN = await retrieveWith("PLATFORM_OPS", readers(newRec(), { aiBudget: async () => aiFx({ thresholdUsd: 0, utilizationPct: null }, 0) }), OPS, "ai-fleet-spend-status", {}, NOW);
  check("…no threshold ⇒ utilisation and threshold null (never 0% of $0)",
    (aiN?.value as Record<string, number | null>).utilisationPct === null && (aiN?.value as Record<string, number | null>).thresholdUsd === null);

  const reg = await get("GROWTH_REVENUE", GR, "growth-registrations");
  const kpiReg = growthKpis(fetched(acqFx()), fetched(paFx())).find((k) => k.key === "registrations")!;
  check("growth-registrations: value = the Growth KPI (a.registrations.total), at the route's default 90-day window",
    reg?.value === acqFx().registrations.total && kpiReg.value === (reg?.value as number).toLocaleString("en-US") && rec.windows[0] === 90 && reg?.window.days === 90);
  await get("GROWTH_REVENUE", GR, "growth-registrations", { window: 30 });
  check("…?window=30 reaches the reader as 30", rec.windows[1] === 30);
  const regBad = await get("GROWTH_REVENUE", GR, "growth-registrations", { window: 7 });
  check("…an unsupported window ⇒ UNAVAILABLE + reason, the reader not called", regBad?.status === "UNAVAILABLE" && !!regBad.reason && rec.windows.length === 2);
  const regP = await retrieveWith("GROWTH_REVENUE", readers(newRec(), { acquisition: async () => acqFx([{ day: "a", count: null }, { day: "b", count: 2 }]) }), GR, "growth-registrations", {}, NOW);
  check("…a day the source does not cover ⇒ PARTIAL (a floor) with a reason", regP?.status === "PARTIAL" && regP.value === 2 && !!regP.reason && regP.coverage.missing.length === 1);
  const regU = await retrieveWith("GROWTH_REVENUE", readers(newRec(), { acquisition: async () => acqFx([{ day: "a", count: null }]) }), GR, "growth-registrations", {}, NOW);
  check("…no covered day ⇒ UNAVAILABLE, value null (never 0)", regU?.status === "UNAVAILABLE" && regU.value === null && !!regU.reason);

  const eng = await get("GROWTH_REVENUE", GR, "engaged-users");
  const kpiEng = growthKpis(fetched(acqFx()), fetched(paFx())).find((k) => k.key === "engaged")!;
  check("engaged-users: value = the Growth 'Engaged · 30 d' KPI (p.active.monthly.engaged)", eng?.value === 11 && kpiEng.value === "11" && eng.window.days === 30);
  const eng7 = await get("GROWTH_REVENUE", GR, "engaged-users", { window: 7 });
  check("…window 7 / 1 read weekly / daily from the same payload", eng7?.value === 6 && (await get("GROWTH_REVENUE", GR, "engaged-users", { window: 1 }))?.value === 2);

  const inc = await get("PLATFORM_OPS", OPS, "incident-broken-now");
  const dto = { total: searchFx().total, truncated: false };
  check("incident-broken-now: value = the Incidents KPI total (incidentTotalText)", inc?.value === 3 && incidentTotalText(dto) === `${inc?.value}` && inc.status === "MEASURED");
  const incT = await retrieveWith("PLATFORM_OPS", readers(newRec(), { incidentSearch: async () => searchFx(true) }), OPS, "incident-broken-now", {}, NOW);
  check("…a capped read ⇒ PARTIAL (the tile's '+')", incT?.status === "PARTIAL" && incidentTotalText({ total: 3, truncated: true }) === `${incT.value}+`);

  const mer = await get("MERCHANT_OPS", MO, "merchant-identity-linked");
  const v = mer?.value as { linked: number; live: number };
  check("merchant-identity-linked: the tile's floored share reads the same from the value (coverageLabel)",
    formatCoveragePct(v.linked, v.live) === coverageLabel(merchantFx()) && coverageLabel(merchantFx()) === "99.65%");
  const merU = await retrieveWith("MERCHANT_OPS", readers(newRec(), { merchantOverview: async () => merchantFx(0, 0) }), MO, "merchant-identity-linked", {}, NOW);
  check("…no live transactions ⇒ UNAVAILABLE + reason (never 0%)", merU?.status === "UNAVAILABLE" && merU.value === null && coverageLabel(merchantFx(0, 0)) === null);

  const help = await get("CUSTOMER_SUCCESS", CS, "cs-needs-help");
  const kpis = csKpis(fetched(csFx()));
  check("cs-needs-help: value = the 'Need help' KPI (o.attention.customers)", kpis.find((k) => k.key === "help")!.value === `${help?.value}` && help?.status === "MEASURED");
  const open = await get("CUSTOMER_SUCCESS", CS, "open-customers");
  check("open-customers: value = the 'Customers' KPI (o.customers.active)", kpis.find((k) => k.key === "customers")!.value === `${open?.value}`);
  const helpF = await retrieveWith("CUSTOMER_SUCCESS", readers(newRec(), { csOverview: async () => csFx(true) }), CS, "cs-needs-help", {}, NOW);
  check("…a capped fleet read ⇒ PARTIAL (the tile's '≥')", helpF?.status === "PARTIAL" && csKpis(fetched(csFx(true))).find((k) => k.key === "help")!.value === `≥${helpF.value}`);
  check("the CS overview reader received a CUSTOMER_SUCCESS incident token", rec.csAudiences.every((a) => a === "CUSTOMER_SUCCESS") && rec.csAudiences.length >= 2);

  // live-sessions@1 — the route sets { totalActive: counts.sessions, distinctUsers: counts.distinctUsers } from the same reader.
  const SEC = ctxFor(UserRole.USER, grant("SECURITY_OPS"));
  const ls = await get("SECURITY_OPS", SEC, "live-sessions");
  const lsv = ls?.value as { sessions: number; distinctUsers: number };
  const readings = sessionsReadings({ totalActive: LIVE_FX.sessions, distinctUsers: LIVE_FX.distinctUsers, recent: [] });
  check("live-sessions: value = the Security posture readings (d.totalActive, d.distinctUsers) the route builds from countLiveSessions",
    readings[0].value === String(lsv.sessions) && readings[1].value === String(lsv.distinctUsers) && ls?.status === "MEASURED" && ls.tier === "OPS");
  const acc = await get("GROWTH_REVENUE", GR, "accounts-with-live-session");
  check("accounts-with-live-session: value = data.withLiveSession (the Growth users route sets it from countAccountsWithLiveSession)",
    acc?.value === ACCOUNTS_FX && acc.status === "MEASURED" && acc.tier === "OPS");
  check("…a measured 0 stays 0 (a real count of no accounts, not missing data)",
    (await retrieveWith("GROWTH_REVENUE", readers(newRec(), { accountsWithLiveSession: async () => 0 }), GR, "accounts-with-live-session", {}, NOW))?.value === 0);
})();

// ── 3c. Economics / AI & Costs cost metrics — parity with their tiles ────────
console.log("\n3c. cost metrics — envelope = the Economics / AI & Costs tile, same world");
await (async () => {
  const rec = newRec();
  const R = readers(rec);
  const get = (id: string, params = {}, r: RetrievalReaders = R) => retrieveWith("PLATFORM_OPS", r, OPS, id, params, NOW);
  const snap = await getEconomicsSnapshot(NOW.getTime(), ecoDeps());

  // economics-ai-cost@1 — the Overview AI trend card: s.trend.windows[win].
  for (const [w, key] of [[30, "30d"], [7, "7d"], [90, "90d"]] as const) {
    const e = await get("economics-ai-cost", w === 30 ? {} : { window: w });
    const f = snap.trend.windows[key];
    check(`economics-ai-cost @ ${w} d: value / status / reason = the tile's figure (${f.status} ${f.value})`,
      (e?.value === null ? f.value === null : (e?.value as Record<string, number>).spendUsd === f.value) && e?.status === f.status && e?.reason === f.reason && e?.window.days === w && e?.unit === "usd" && e?.basis.kind === "estimated", JSON.stringify(e?.value));
  }
  const bad = await get("economics-ai-cost", { window: 14 });
  check("economics-ai-cost: an undeclared window (14) ⇒ UNAVAILABLE naming the declared ones",
    bad?.status === "UNAVAILABLE" && bad.value === null && /window must be one of 30, 7, 90 \(days\) — 14 is not offered/.test(bad.reason ?? ""), bad?.reason ?? "");
  const noRate = await get("economics-ai-cost", {}, readers(newRec(), { economicsSnapshot: (n) => getEconomicsSnapshot(n, ecoDeps({ aiPricingConfigured: false })) }));
  check("economics-ai-cost: no AI rate card ⇒ UNAVAILABLE with the tile's reason (never $0)", noRate?.status === "UNAVAILABLE" && noRate.value === null && noRate.reason === "no AI rate card configured", JSON.stringify(noRate));
  const unpricedGroups = [...ECO_GROUPS, ecoGroup("2026-11-03", "chat", { model: "not-a-rated-model" })];
  const snapP = await getEconomicsSnapshot(NOW.getTime(), ecoDeps({ groups: unpricedGroups }));
  const partial = await get("economics-ai-cost", {}, readers(newRec(), { economicsSnapshot: (n) => getEconomicsSnapshot(n, ecoDeps({ groups: unpricedGroups })) }));
  check("economics-ai-cost: an unpriced day ⇒ PARTIAL (lower bound), missing parts = the tile's coverage.missing",
    partial?.status === "PARTIAL" && snapP.trend.windows["30d"].status === "PARTIAL" && (partial.value as Record<string, number>).spendUsd === snapP.trend.windows["30d"].value
    && JSON.stringify(partial.coverage.missing) === JSON.stringify(snapP.trend.windows["30d"].coverage.missing) && partial.basis.kind === "estimated", JSON.stringify(partial));

  // economics-operating-cost@1 — the Overview hero + its AI / Providers / Infrastructure split tiles.
  const op = await get("economics-operating-cost");
  const opv = op?.value as Record<string, number | null>;
  const split = splitFigures(snap);
  check("economics-operating-cost: total = the hero figure, parts = the split tiles (AI, Providers, Infrastructure null — never $0)",
    opv?.totalUsd === snap.figures.operating_cost.value && opv.aiUsd === split[0].value && opv.providersUsd === split[1].value
    && opv.infrastructureUsd === null && split[2].value === null, JSON.stringify(opv));
  check("economics-operating-cost: PARTIAL while any component is unmetered (other providers, infrastructure), with the tile's reason and missing parts",
    op?.status === "PARTIAL" && snap.figures.operating_cost.status === "PARTIAL" && op.reason === snap.figures.operating_cost.reason
    && op.coverage.missing.some((m) => /not metered/.test(m)) && op.basis.kind === "estimated" && op.unit === "usd", JSON.stringify(op?.coverage.missing));
  const opW = await get("economics-operating-cost", { window: 30 });
  check("economics-operating-cost: any window ⇒ UNAVAILABLE, the window is fixed (the current cycle)", opW?.status === "UNAVAILABLE" && /takes no window — its window is fixed: The current billing cycle/.test(opW.reason ?? ""), opW?.reason ?? "");

  // economics-provider-cost@1 — the Overview Providers tile (f.provider_cost).
  const pv = await get("economics-provider-cost");
  check("economics-provider-cost: value / status = the Providers tile (PARTIAL: other providers unmetered, never $0)",
    (pv?.value as Record<string, number>).costUsd === snap.figures.provider_cost.value && pv?.status === "PARTIAL" && snap.figures.provider_cost.status === "PARTIAL"
    && !!pv?.coverage.missing.some((m) => /other providers are not metered/.test(m)), JSON.stringify(pv));
  const pvU = await get("economics-provider-cost", {}, readers(newRec(), { economicsSnapshot: (n) => getEconomicsSnapshot(n, ecoDeps({ plaidRates: [] })) }));
  check("economics-provider-cost: no Plaid rate card ⇒ UNAVAILABLE with the tile's reason", pvU?.status === "UNAVAILABLE" && pvU.value === null && pvU.reason === "no Plaid rate card configured", JSON.stringify(pvU));

  // ai-call-outcomes@1 — the AI & Costs KPIs "Calls · 7 d" / "Error rate · 7 d" (aiKpis over the same payload).
  const kp = aiKpis({ budget: fetched(aiFx()) as never, inv7: fetched(aiOpsFx()) as never });
  const co = await get("ai-call-outcomes");
  const cov = co?.value as Record<string, number | null>;
  check("ai-call-outcomes: calls / error rate = the AI & Costs KPIs (60 calls, 3.3%)",
    kp.find((k) => k.key === "calls")!.value === (cov.calls as number).toLocaleString("en-US") && cov.calls === 60 && cov.returned === 58 && cov.failed === 2
    && kp.find((k) => k.key === "errors")!.value === `${(cov.errorRatePct as number).toFixed(1)}%` && co?.status === "MEASURED" && co.basis.kind === "measured" && co.window.days === 7, JSON.stringify(cov));
  await get("ai-call-outcomes", { window: 30 });
  check("ai-call-outcomes: the tile's 7 d by default, 30 d on request (the route's ?window=7d|30d)", rec.aiWindows.join() === "7d,30d", rec.aiWindows.join());
  const coBad = await get("ai-call-outcomes", { window: 1 });
  check("ai-call-outcomes: an undeclared window ⇒ refused before the reader runs", coBad?.status === "UNAVAILABLE" && /window must be one of 7, 30/.test(coBad.reason ?? "") && rec.aiWindows.length === 2);
  const co0 = await get("ai-call-outcomes", {}, readers(newRec(), { aiOperations: async () => aiOpsFx({ invocations: 0, failed: 0, usd: null }) }));
  check("ai-call-outcomes: no calls ⇒ a measured 0 calls, error rate null (never 0%), and the tile says '—'",
    (co0?.value as Record<string, number | null>).calls === 0 && (co0?.value as Record<string, number | null>).errorRatePct === null
    && aiKpis({ budget: fetched(aiFx()) as never, inv7: fetched(aiOpsFx({ invocations: 0, failed: 0, usd: null })) as never }).find((k) => k.key === "errors")!.value === "—");

  // ai-cost-per-call@1 — the AI & Costs KPI "Est. cost / call" (costPerCall over the same payload).
  const cpc = await get("ai-cost-per-call");
  const tileCpc = costPerCall(aiOpsFx());
  check("ai-cost-per-call: value = the tile's estimate ($0.03 per returned call), ESTIMATED",
    tileCpc.kind === "ESTIMATED" && (cpc?.value as Record<string, number>).costPerCallUsd === tileCpc.usd && kp.find((k) => k.key === "per-call")!.value === usd((cpc?.value as Record<string, number>).costPerCallUsd)
    && cpc?.status === "ESTIMATED" && cpc.basis.kind === "estimated" && cpc.unit === "usd-and-counts", JSON.stringify(cpc?.value));
  const cpcP = await get("ai-cost-per-call", {}, readers(newRec(), { aiOperations: async () => aiOpsFx({ unpricedTokens: 900 }) }));
  check("ai-cost-per-call: unpriced tokens ⇒ PARTIAL (the tile's 'estimated · partial')", cpcP?.status === "PARTIAL" && (costPerCall(aiOpsFx({ unpricedTokens: 900 })) as { partial: boolean }).partial);
  const cpcU = await get("ai-cost-per-call", {}, readers(newRec(), { aiOperations: async () => aiOpsFx({ pricing: false }) }));
  check("ai-cost-per-call: no rate card ⇒ UNAVAILABLE with the tile's reason", cpcU?.status === "UNAVAILABLE" && cpcU.value === null && cpcU.reason === "no rate card");

  // E5 — aggregates only: no cost metric carries a per-user / per-Space / per-customer part.
  const COST = ["economics-ai-cost@1", "economics-operating-cost@1", "economics-provider-cost@1", "ai-call-outcomes@1", "ai-cost-per-call@1"];
  const envs = await Promise.all(COST.map((k) => get(k)));
  check("cost metrics: every one is served on PLATFORM_OPS only, at the OPS tier (no CS exposure, no new grant)",
    COST.every((k) => { const m = METRICS.find((d) => metricKey(d) === k)!; return m.permission.length === 1 && m.permission[0].area === "PLATFORM_OPS" && m.permission[0].level === "READ" && m.permission[0].identityTier === "OPS"; })
    && envs.every((e) => e?.tier === "OPS"));
  // A declared RANKING part (S2 ruling 2026-11-05: largestMeasuredCategory) is exempt from the suffix rule; its unit is pinned in 3d.
  const notRanking = (e: (typeof envs)[number], k: string) => e?.partRoles?.[k] !== "ranking";
  check("cost metrics: value parts follow the renderer convention — dollars '…Usd', percentages '…Pct', the rest counts; never a bare top-level dollar number",
    envs.every((e) => e?.value === null || (typeof e?.value === "object" && Object.keys(e.value).filter((k) => notRanking(e, k)).every((k) => /Usd$|Pct$/.test(k) || ["calls", "returned", "failed", "returnedCalls"].includes(k))))
    && envs.filter((e) => e?.unit === "usd").every((e) => e?.value === null || Object.keys(e!.value as object).filter((k) => notRanking(e, k)).every((k) => /Usd$/.test(k))), JSON.stringify(envs.map((e) => e?.value)));
  check("cost metrics: value parts are fleet aggregates only (no customer / user / space / group key)",
    envs.every((e) => e?.value === null || typeof e?.value === "number" || Object.keys(e!.value).every((k) => !/customer|user|space|group|member/i.test(k))));
  check("OD-1 / no billing: no per-customer, cost-per-customer, revenue or margin metric is registered",
    !METRICS.some((m) => /per-customer|per-active|active-customer|revenue|margin|entitlement|group-cost/.test(m.id)));
  check("cost metrics are discoverable under domain \"economics\"", COST.every((k) => METRICS.find((d) => metricKey(d) === k)!.domain === "economics"));
})();

// ── 3d. part roles + the largest measured category (S2 ruling 2026-11-05) ────
console.log("\n3d. part roles — the total is never a category; largestMeasuredCategory is server-computed from the measured categories");
await (async () => {
  const get = (id: string, r: RetrievalReaders = readers(newRec())) => retrieveWith("PLATFORM_OPS", r, OPS, id, {}, NOW);
  type Entry = Extract<(typeof RETRIEVAL)[string], { kind: "RETRIEVABLE" }>;
  const declared = Object.entries(RETRIEVAL).filter((x): x is [string, Entry] => x[1].kind === "RETRIEVABLE" && !!(x[1] as Entry).parts);
  check("economics-operating-cost@1 is the metric that declares part roles", declared.map(([k]) => k).includes("economics-operating-cost@1"), declared.map(([k]) => k).join());
  for (const [k, e] of declared) {
    const parts = e.parts!;
    const units = typeof e.valueUnits === "string" ? {} : e.valueUnits;
    const roles = Object.values(parts).map((d) => d.role);
    const cats = Object.entries(parts).filter(([, d]) => d.role === "category");
    const rank = Object.entries(parts).filter(([, d]) => d.role === "ranking").map(([p]) => p);
    check(`${k}: every declared part is a unit part and every unit part is declared (one role each)`, Object.keys(parts).sort().join() === Object.keys(units).sort().join(), JSON.stringify({ parts: Object.keys(parts), units: Object.keys(units) }));
    check(`${k}: at most one total; a ranking part needs ≥ 1 category`, roles.filter((r) => r === "total").length <= 1 && (rank.length === 0 || cats.length > 0));
    check(`${k}: each ranking part carries its categories' unit, and is an estimate exactly when they are`,
      rank.every((p) => cats.every(([c]) => (units as Record<string, string>)[c] === (units as Record<string, string>)[p]) && (e.estimatedParts ?? []).includes(p) === cats.every(([c]) => (e.estimatedParts ?? []).includes(c))));
    check(`${k}: category labels are server labels (letters only — no digit, no identifier) and distinct`,
      cats.every(([, d]) => d.role === "category" && /^[A-Za-z][A-Za-z ()&/-]{0,47}$/.test(d.label)) && new Set(cats.map(([, d]) => (d as { label: string }).label)).size === cats.length);
  }

  // Through the REAL reader (getEconomicsSnapshot), the fixture world: AI (~$3.75) > Providers ($0.60) > Infrastructure (unmetered).
  const op = await get("economics-operating-cost");
  const v = op?.value as Record<string, number | null> & { largestMeasuredCategory: RankedCategory | null };
  check("the envelope carries the part roles: totalUsd = total, AI / Providers / Infrastructure = category, largestMeasuredCategory = ranking",
    JSON.stringify(op?.partRoles) === JSON.stringify({ totalUsd: "total", aiUsd: "category", providersUsd: "category", infrastructureUsd: "category", largestMeasuredCategory: "ranking" }), JSON.stringify(op?.partRoles));
  check("NORMAL: the largest measured category is AI — its figure IS the aiUsd part (same unit, basis), the window is the envelope's label",
    v.largestMeasuredCategory?.label === "AI" && v.largestMeasuredCategory.figure === v.aiUsd && (v.aiUsd as number) > (v.providersUsd as number)
    && v.largestMeasuredCategory.window === op?.window.label && op?.window.label === "this UTC calendar month to date", JSON.stringify(v));
  check("…PARTIAL + an unmetered category (infrastructure null) ⇒ the fixed qualifier", v.largestMeasuredCategory?.qualifier === RANKING_QUALIFIER && RANKING_QUALIFIER === "ranking among measured categories; some categories are incomplete");
  check("…the TOTAL is never chosen (it is larger than every category, and the ranked figure is not it)", (v.totalUsd as number) > (v.aiUsd as number) && v.largestMeasuredCategory?.figure !== v.totalUsd);
  check("…the other parts are untouched (still the split tiles), and the envelope stays an aggregate under its declared ranking part",
    v.infrastructureUsd === null && isAggregate(op!.value, ["largestMeasuredCategory"]) && !isAggregate(op!.value), JSON.stringify(op?.value));

  // Providers (Plaid) larger than AI — the owner's live shape (Plaid ≫ AI).
  const plaidHeavy = readers(newRec(), { economicsSnapshot: (n) => getEconomicsSnapshot(n, ecoDeps({ groups: [ecoGroup("2026-11-02", "chat", { promptTokens: 10_000, completionTokens: 5_000 })], items: 11 })) });
  const op2 = await get("economics-operating-cost", plaidHeavy);
  const v2 = op2?.value as Record<string, number | null> & { largestMeasuredCategory: RankedCategory | null };
  check("Providers (Plaid) larger than AI ⇒ the ranking is Providers (Plaid), with the providersUsd figure",
    v2.largestMeasuredCategory?.label === "Providers (Plaid)" && v2.largestMeasuredCategory.figure === v2.providersUsd && (v2.providersUsd as number) > (v2.aiUsd as number), JSON.stringify(v2));

  // ALL categories null (no AI priced, no provider priced) but a total — no category measured ⇒ null, never $0.
  const snap = await getEconomicsSnapshot(NOW.getTime(), ecoDeps());
  const blank = { ...snap, figures: { ...snap.figures, ai_cost: { ...snap.figures.ai_cost, value: null }, provider_cost: { ...snap.figures.provider_cost, value: null } } };
  const op3 = await get("economics-operating-cost", readers(newRec(), { economicsSnapshot: async () => blank }));
  check("ALL categories null ⇒ largestMeasuredCategory null (the envelope keeps its total; no category is invented)",
    op3?.status === "PARTIAL" && (op3.value as Record<string, unknown>).largestMeasuredCategory === null && (op3.value as Record<string, unknown>).totalUsd === snap.figures.operating_cost.value, JSON.stringify(op3?.value));
  const opU = await get("economics-operating-cost", readers(newRec(), { economicsSnapshot: async () => { throw new Error("x"); } }));
  check("an UNAVAILABLE envelope has no value at all (no ranking), and still states its part roles", opU?.status === "UNAVAILABLE" && opU.value === null && opU.partRoles?.totalUsd === "total");

  // A projection may NEVER supply the ranking part (it is server-computed) ⇒ PROJECTION_REFUSED.
  const entry = RETRIEVAL["economics-operating-cost@1"] as Entry;
  const orig = entry.read;
  try {
    (entry as { read: Entry["read"] }).read = async (i) => { const p = await orig(i); return { ...p, value: { ...(p.value as object), largestMeasuredCategory: 99 } }; };
    const forged = await get("economics-operating-cost");
    check("a projection that supplies largestMeasuredCategory itself ⇒ UNAVAILABLE[PROJECTION_REFUSED] (never trusted)",
      forged?.status === "UNAVAILABLE" && forged.unavailableCode === "PROJECTION_REFUSED" && forged.value === null && /server-computed/.test(forged.reason ?? ""), JSON.stringify(forged?.reason));
  } finally { (entry as { read: Entry["read"] }).read = orig; }

  // The pure rule (one named function).
  const P: PartDeclarations = { totalUsd: { role: "total" }, aUsd: { role: "category", label: "Alpha" }, bUsd: { role: "category", label: "Beta" }, cUsd: { role: "category", label: "Gamma" }, top: { role: "ranking" } };
  const L = (val: Record<string, number | null>, status: "MEASURED" | "ESTIMATED" | "PARTIAL" = "MEASURED") => largestMeasuredCategory(val, P, { status, window: "w" });
  check("pure: the largest category wins; MEASURED + every category measured ⇒ no qualifier",
    JSON.stringify(L({ totalUsd: 6, aUsd: 1, bUsd: 3, cUsd: 2 })) === JSON.stringify({ label: "Beta", figure: 3, window: "w", qualifier: null }));
  check("pure: TIE ⇒ the FIRST category in declared order (Alpha before Beta; Beta before Gamma)",
    L({ totalUsd: 6, aUsd: 3, bUsd: 3, cUsd: 0 })?.label === "Alpha" && L({ totalUsd: 6, aUsd: 1, bUsd: 2.5, cUsd: 2.5 })?.label === "Beta");
  check("pure: ALL categories null ⇒ null (whatever the total)", L({ totalUsd: 9, aUsd: null, bUsd: null, cUsd: null }) === null && L({ totalUsd: null, aUsd: null, bUsd: null, cUsd: null }) === null);
  check("pure: a null category, PARTIAL or ESTIMATED ⇒ the qualifier; the null part is skipped, never $0",
    L({ totalUsd: 3, aUsd: 1, bUsd: null, cUsd: 2 })?.qualifier === RANKING_QUALIFIER && L({ totalUsd: 3, aUsd: 1, bUsd: null, cUsd: 2 })?.label === "Gamma"
    && L({ totalUsd: 6, aUsd: 1, bUsd: 3, cUsd: 2 }, "PARTIAL")?.qualifier === RANKING_QUALIFIER && L({ totalUsd: 6, aUsd: 1, bUsd: 3, cUsd: 2 }, "ESTIMATED")?.qualifier === RANKING_QUALIFIER);
  check("pure: the TOTAL is never chosen, even as the only measured part", L({ totalUsd: 100, aUsd: null, bUsd: null, cUsd: null }) === null && L({ totalUsd: 100, aUsd: 1, bUsd: 2, cUsd: 3 })?.figure === 3);

  // The aggregate guard: a ranked category only under a DECLARED ranking key, and only in its exact shape.
  const rc: RankedCategory = { label: "Providers (Plaid)", figure: 3.3, window: "this UTC calendar month to date", qualifier: RANKING_QUALIFIER };
  check("aggregate guard: a ranked category passes ONLY under a declared ranking part",
    isAggregate({ totalUsd: 4, top: rc }, ["top"]) && !isAggregate({ totalUsd: 4, top: rc }) && !isAggregate({ totalUsd: 4, other: rc }, ["top"]) && isAggregate({ totalUsd: 4, top: null }, ["top"]));
  check("aggregate guard: a malformed ranked category is refused (extra key, digit / identifier label, foreign qualifier, non-finite figure)",
    isRankedCategory(rc) && !isRankedCategory({ ...rc, extra: 1 }) && !isRankedCategory({ ...rc, label: "user #1" }) && !isRankedCategory({ ...rc, label: EMAIL })
    && !isRankedCategory({ ...rc, qualifier: "anything else" }) && !isRankedCategory({ ...rc, figure: NaN }) && !isRankedCategory({ label: rc.label, figure: 1, window: null }));
})();

// ── 3b. fleet vs per-subject (S2) ────────────────────────────────────────────
console.log("\n3b. a per-subject permission entry is never served as a fleet value");
await (async () => {
  const R = readers(newRec());
  const SEC = ctxFor(UserRole.USER, grant("SECURITY_OPS"));
  const ls = METRICS.find((m) => m.id === "live-sessions")!;
  const lsCs = ls.permission.find((p) => p.area === "CUSTOMER_SUCCESS");
  check("live-sessions@1's CUSTOMER_SUCCESS entry is the PER-CUSTOMER detail route (not fleet-level) — if it ever becomes fleet-level, this pin must be revisited",
    !!lsCs && /\[userId\]/.test(lsCs.route) && !isFleetEntry(lsCs), lsCs?.route);
  check("…so live-sessions on CUSTOMER_SUCCESS reads null (CS grant), like a metric not served there",
    (await retrieveWith("CUSTOMER_SUCCESS", R, CS, "live-sessions", {}, NOW)) === null);
  check("…and null for break-glass on CUSTOMER_SUCCESS too", (await retrieveWith("CUSTOMER_SUCCESS", R, SA, "live-sessions", {}, NOW)) === null);
  check("live-sessions on SECURITY_OPS is the fleet count, identity-free (OPS tier), for a Security grant and for break-glass",
    (await retrieveWith("SECURITY_OPS", R, SEC, "live-sessions", {}, NOW))?.tier === "OPS" && (await retrieveWith("SECURITY_OPS", R, SA, "live-sessions", {}, NOW))?.tier === "OPS");
  const acc = METRICS.find((m) => m.id === "accounts-with-live-session")!;
  check("accounts-with-live-session@1: its only entry is GROWTH_REVENUE, fleet-level (no [param] route), OPS tier",
    acc.permission.length === 1 && acc.permission[0].area === "GROWTH_REVENUE" && isFleetEntry(acc.permission[0]) && acc.permission[0].identityTier === "OPS");
  check("…served on GROWTH_REVENUE, and on no other surface (CS / Security / Ops read null, break-glass included)",
    (await retrieveWith("GROWTH_REVENUE", R, SA, "accounts-with-live-session", {}, NOW))?.tier === "OPS"
    && (await retrieveWith("CUSTOMER_SUCCESS", R, SA, "accounts-with-live-session", {}, NOW)) === null
    && (await retrieveWith("SECURITY_OPS", R, SA, "accounts-with-live-session", {}, NOW)) === null
    && (await retrieveWith("PLATFORM_OPS", R, SA, "accounts-with-live-session", {}, NOW)) === null);
  // Generic: every retrievable metric, every per-subject entry ⇒ null; every fleet entry ⇒ an envelope.
  for (const m of retrievable) {
    for (const p of m.permission) {
      const e = await retrieveWith(p.area, R, SA, metricKey(m), {}, NOW);
      check(`${metricKey(m)} on ${p.area}: ${isFleetEntry(p) ? "fleet entry ⇒ served" : "per-subject entry ⇒ null"}`, isFleetEntry(p) ? e !== null : e === null);
    }
  }
  check("isFleetEntry: a [param] segment is per-subject; a list route is fleet",
    !isFleetEntry({ route: "app/api/platform/customer-success/customers/[userId]/route.ts" }) && isFleetEntry({ route: "app/api/platform/customer-success/customers/route.ts" }));
})();

// ── 4. authority ─────────────────────────────────────────────────────────────
console.log("\n4. authority — forged ⇒ null, no oracle, break-glass downgraded per surface");
await (async () => {
  const rec = newRec();
  const R = readers(rec);
  const forged = { metricToken: Object.freeze({ grants: [{ area: "PLATFORM_OPS", level: "CONTROL" }] }) as unknown as MetricAccessToken };
  check("a forged metric token ⇒ null, and no reader runs",
    (await retrieveWith("PLATFORM_OPS", R, forged, "provider-outcome")) === null && (await retrieveWith("PLATFORM_OPS", R, { ...OPS, metricToken: { ...OPS.metricToken } }, "provider-outcome")) === null);
  check("a missing context ⇒ null", (await retrieveWith("PLATFORM_OPS", R, undefined as never, "provider-outcome")) === null);
  const invisible = await retrieveWith("MERCHANT_OPS", R, MO, "cs-needs-help");
  const unknown = await retrieveWith("MERCHANT_OPS", R, MO, "no-such-metric");
  const wrongVer = await retrieveWith("MERCHANT_OPS", R, MO, "merchant-identity-linked@2");
  check("no existence oracle: invisible ≡ unknown ≡ unknown version (all null)", invisible === null && unknown === null && wrongVer === null);
  check("a visible metric not served on the surface ⇒ null (Ops caller, CS surface)", (await retrieveWith("CUSTOMER_SUCCESS", R, OPS, "incident-broken-now")) === null);
  check("no reader ran for any refused call", rec.incidentAudiences.length === 0 && rec.csAudiences.length === 0);

  // Break-glass: holds every area. On an Ops surface every value is at the OPS tier.
  for (const m of METRICS) {
    for (const p of m.permission) {
      const s = atSurface(p.area, SA.metricToken, metricKey(m));
      if (p.area !== "CUSTOMER_SUCCESS") check(`break-glass on ${p.area} reads ${metricKey(m)} at OPS (never CUSTOMER_SUCCESS)`, s?.tier === "OPS", s?.tier);
      else check(`break-glass on CUSTOMER_SUCCESS reads ${metricKey(m)} at ${p.identityTier} (the entry's tier, not more)`, s?.tier === p.identityTier, s?.tier);
    }
  }
  const saInc = await retrieveWith("PLATFORM_OPS", R, SA, "incident-broken-now", {}, NOW);
  check("break-glass incident token is CUSTOMER_SUCCESS (lead decision) …", SA.incidentToken?.audience === "CUSTOMER_SUCCESS");
  check("… and on the Ops surface the incident reader receives the DOWNGRADED PLATFORM_OPS token", saInc?.tier === "OPS" && rec.incidentAudiences.at(-1) === "PLATFORM_OPS", rec.incidentAudiences.join());
  await retrieveWith("CUSTOMER_SUCCESS", R, SA, "incident-broken-now", {}, NOW);
  check("on the CS surface the same break-glass reads at CUSTOMER_SUCCESS", rec.incidentAudiences.at(-1) === "CUSTOMER_SUCCESS");
  await retrieveWith("PLATFORM_OPS", R, OPS, "incident-broken-now", {}, NOW);
  check("an Ops grant's incident token stays PLATFORM_OPS", rec.incidentAudiences.at(-1) === "PLATFORM_OPS");
  check("a CS grant reading a CS-only metric needs a CS incident token: an Ops one ⇒ null",
    (await retrieveWith("CUSTOMER_SUCCESS", R, { metricToken: CS.metricToken, incidentToken: OPS.incidentToken }, "cs-needs-help")) === null);
  check("… a forged incident token ⇒ null", (await retrieveWith("CUSTOMER_SUCCESS", R, { metricToken: CS.metricToken, incidentToken: { audience: "CUSTOMER_SUCCESS" } as unknown as CsToken }, "cs-needs-help")) === null
    && (await retrieveWith("PLATFORM_OPS", R, { metricToken: OPS.metricToken, incidentToken: { audience: "PLATFORM_OPS" } as unknown as OpsToken }, "incident-broken-now")) === null);
  check("… and no incident token at all ⇒ null", (await retrieveWith("PLATFORM_OPS", R, { metricToken: OPS.metricToken }, "incident-broken-now")) === null);
  check("atSurface never raises: a CS grant on the CS surface reads at most CUSTOMER_SUCCESS; an Ops grant at OPS",
    atSurface("CUSTOMER_SUCCESS", CS.metricToken, "cs-needs-help")?.tier === "CUSTOMER_SUCCESS" && atSurface("PLATFORM_OPS", OPS.metricToken, "incident-broken-now")?.tier === "OPS");
  const nr = await retrieveWith("CUSTOMER_SUCCESS", R, CS, "presence-state");
  check("a visible NOT_RETRIEVABLE metric ⇒ UNAVAILABLE envelope with its reason (not null, not 0)",
    nr?.status === "UNAVAILABLE" && nr.value === null && /not retrievable/.test(nr.reason ?? ""));
})();

// ── 5. honest absence ────────────────────────────────────────────────────────
console.log("\n5. a failing reader ⇒ value null + reason, per retrievable metric (never 0)");
await (async () => {
  const boom = async () => { throw new Error(`db down for ${EMAIL} ${CUID}`); };
  const failing: RetrievalReaders = {
    providerHealth: boom, aiBudget: boom, acquisition: boom, productAnalytics: boom, incidentSearch: boom, merchantOverview: boom, csOverview: boom,
    liveSessions: boom, accountsWithLiveSession: boom, economicsSnapshot: boom, aiOperations: boom,
    operationsOverview: boom, attention: boom, alertRuns: boom, connectionHealth: boom, jobHealth: boom, resourceFreshness: boom,
  };
  for (const m of retrievable) {
    const surface = m.permission[0].area;
    const e = await retrieveWith(surface, failing, SA, metricKey(m), {}, NOW);
    check(`${metricKey(m)}: reader failure ⇒ UNAVAILABLE, null, reason, and the error text is not echoed`,
      e?.status === "UNAVAILABLE" && e.value === null && !!e.reason && !e.reason.includes(EMAIL) && !JSON.stringify(e).includes(CUID), JSON.stringify(e?.reason));
  }
})();

// ── 5c. the UNAVAILABLE reason code — one closed-enum code per path ──────────
console.log("\n5c. UNAVAILABLE reason code — every path that yields UNAVAILABLE carries its own code (enum, never text)");
await (async () => {
  const R = readers(newRec());
  const on = (id: string) => METRICS.find((m) => metricKey(m) === id || m.id === id)!.permission[0].area;
  const get = (id: string, params = {}, r: RetrievalReaders = R) => retrieveWith(on(id), r, SA, id, params, NOW);
  check("the enum is closed and exactly the six paths", UNAVAILABLE_CODES.join() === "NOT_RETRIEVABLE,WINDOW_FIXED,WINDOW_NOT_OFFERED,READER_FAILED,PROJECTION_REFUSED,NO_FIGURE");

  const notRetrievable = METRICS.filter((m) => RETRIEVAL[metricKey(m)]?.kind === "NOT_RETRIEVABLE");
  const nr = (await Promise.all(notRetrievable.map((m) => retrieveWith(m.permission[0].area, R, SA, metricKey(m), {}, NOW)))).filter((e) => e !== null);
  check("NOT_RETRIEVABLE: a metric listed NOT_RETRIEVABLE ⇒ UNAVAILABLE[NOT_RETRIEVABLE]",
    nr.length > 0 && nr.every((e) => e!.status === "UNAVAILABLE" && e!.unavailableCode === "NOT_RETRIEVABLE"), JSON.stringify(nr.map((e) => [e!.metric, e!.unavailableCode])));
  const fixed = await get("economics-operating-cost", { window: 30 });
  check("WINDOW_FIXED: a window on a metric that takes none (billing cycle) ⇒ UNAVAILABLE[WINDOW_FIXED]", fixed?.status === "UNAVAILABLE" && fixed.unavailableCode === "WINDOW_FIXED", String(fixed?.unavailableCode));
  const notOffered = await get("economics-ai-cost", { window: 14 });
  check("WINDOW_NOT_OFFERED: a window outside the declared ones ⇒ UNAVAILABLE[WINDOW_NOT_OFFERED]", notOffered?.status === "UNAVAILABLE" && notOffered.unavailableCode === "WINDOW_NOT_OFFERED", String(notOffered?.unavailableCode));
  const failed = await get("economics-ai-cost", {}, readers(newRec(), { economicsSnapshot: async () => { throw new Error(`down ${EMAIL}`); } }));
  check("READER_FAILED: the reader throws ⇒ UNAVAILABLE[READER_FAILED]", failed?.status === "UNAVAILABLE" && failed.unavailableCode === "READER_FAILED", String(failed?.unavailableCode));
  const refused = await get("live-sessions", {}, readers(newRec(), { liveSessions: async () => ({ sessions: Number.POSITIVE_INFINITY, distinctUsers: 1 }) as never }));
  check("PROJECTION_REFUSED: a projection that is not an aggregate ⇒ UNAVAILABLE[PROJECTION_REFUSED]", refused?.status === "UNAVAILABLE" && refused.unavailableCode === "PROJECTION_REFUSED" && /projection refused/.test(refused.reason ?? ""), String(refused?.unavailableCode));
  const noFigure = await get("economics-provider-cost", {}, readers(newRec(), { economicsSnapshot: (n) => getEconomicsSnapshot(n, ecoDeps({ plaidRates: [] })) }));
  check("NO_FIGURE: the reader ran and gave no figure (its own UNAVAILABLE verdict) ⇒ UNAVAILABLE[NO_FIGURE], its reason text unchanged",
    noFigure?.status === "UNAVAILABLE" && noFigure.unavailableCode === "NO_FIGURE" && noFigure.reason === "no Plaid rate card configured", String(noFigure?.unavailableCode));
  const readable = await Promise.all(["economics-operating-cost", "economics-ai-cost", "live-sessions"].map((id) => get(id)));
  check("a readable envelope carries unavailableCode null", readable.every((e) => e !== null && e.status !== "UNAVAILABLE" && e.unavailableCode === null), JSON.stringify(readable.map((e) => [e?.status, e?.unavailableCode])));
  const unavailableCalls = [...src("lib/platform/intelligence/metrics/retrieve-core.ts").matchAll(/return unavailable\(([^,]+),/g)].map((m) => m[1].trim());
  check("static: every unavailable(…) call in retrieveWith names a code (4 calls), and envelope() defaults a reader-side UNAVAILABLE to NO_FIGURE",
    unavailableCalls.length === 4 && unavailableCalls.every((c) => /^"[A-Z_]+"$|^entry\.windows\.length === 0 \? "WINDOW_FIXED" : "WINDOW_NOT_OFFERED"$/.test(c))
    && /unavailableCode: status === "UNAVAILABLE" \? code \?\? "NO_FIGURE" : null/.test(src("lib/platform/intelligence/metrics/retrieve-core.ts")), unavailableCalls.join("; "));
})();

// ── 6. aggregates only ───────────────────────────────────────────────────────
console.log("\n6. aggregates only — identity scan (CS tier and break-glass on an Ops surface)");
await (async () => {
  const R = readers(newRec());
  const IDENTITY = [/subjectUserId/, /\buser #/i, /\boperator #/i, /\bc[a-z0-9]{24,}\b/, /[^\s@"]+@[^\s@"]+\.[^\s@"]+/];
  const scan = (e: MetricEnvelope | null) => { const s = JSON.stringify(e); return IDENTITY.filter((r) => r.test(s)).map(String); };
  for (const m of retrievable) {
    const k = metricKey(m);
    const ops = m.permission.find((p) => p.area !== "CUSTOMER_SUCCESS");
    if (ops) {
      const e = await retrieveWith(ops.area, R, SA, k, {}, NOW);
      check(`${k}: break-glass on ${ops.area} — no identity in the envelope, tier OPS`, !!e && scan(e).length === 0 && e.tier === "OPS", scan(e).join());
    }
    if (m.permission.some((p) => p.area === "CUSTOMER_SUCCESS" && isFleetEntry(p))) {
      const e = await retrieveWith("CUSTOMER_SUCCESS", R, CS, k, {}, NOW);
      check(`${k}: CS tier — no identity in the envelope either (aggregates only in this slice)`, !!e && scan(e).length === 0, scan(e).join());
    }
  }
  check("aggregate guard: numbers and flat objects of numbers / null pass",
    isAggregate(3) && isAggregate({ linked: 1, live: 2 }) && isAggregate({ pricedUsd: null, invocations: 4 }));
  check("aggregate guard: strings, arrays, nested objects, NaN, empty and oversized objects are refused",
    !isAggregate("3") && !isAggregate([1]) && !isAggregate({ a: { b: 1 } }) && !isAggregate(NaN) && !isAggregate({}) && !isAggregate({ email: "x" as unknown as number })
    && !isAggregate(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${"abcdefghi"[i]}`, i]))));
})();

// ── 7. drill ─────────────────────────────────────────────────────────────────
console.log("\n7. drill — a descriptor pointing at the registry's records route, never rows");
await (async () => {
  const R = readers(newRec());
  for (const m of retrievable) {
    const surface = m.permission[0].area;
    const e = await retrieveWith(surface, R, SA, metricKey(m), {}, NOW);
    const d = e?.drill;
    const link = drillLinkOn(m.drill, surface);
    const ok = !!d && d.figure === metricKey(m) && ("unavailable" in m.drill
      ? "unavailable" in d && d.unavailable === m.drill.unavailable
      : !!link && "href" in d && d.href === link.api && d.page === link.page);
    check(`${metricKey(m)}: drill = registry (${link ? link.api : "unavailable"}), keys only figure/window/href/page`,
      ok && Object.keys(d!).every((x) => ["figure", "window", "href", "page", "unavailable"].includes(x)));
    check(`${metricKey(m)}: basis names the registry's code refs`, e?.basis.compute === `${m.compute.module}#${m.compute.symbol}` && e.basis.reader === m.path[0].calls && e.basis.definition === metricKey(m));
    check(`${metricKey(m)}: basis.kind = "${m.provenance.class === "ESTIMATED" ? "estimated" : "measured"}" (from the registry's provenance)`,
      e?.basis.kind === (m.provenance.class === "ESTIMATED" ? "estimated" : "measured"));
    // E2 — the registry declares exactly the windows retrieval accepts.
    const entry = RETRIEVAL[metricKey(m)];
    if (entry.kind === "RETRIEVABLE") check(`${metricKey(m)}: registry window.days = the retrieval contract's declared windows (${entry.windows.join(",") || "fixed"})`,
      JSON.stringify(m.window.days ?? []) === JSON.stringify(entry.windows));
  }

  // The drill exists only where the EFFECTIVE surface satisfies the drill route's own gate.
  for (const m of METRICS) {
    for (const l of drillLinks(m.drill)) {
      const area = drillRouteArea(l.api);
      const route = path.join("app", l.api.split("?")[0], "route.ts");
      check(`${metricKey(m)}: drill route ${l.api} is gated by its segment's area (${area})`,
        !!area && new RegExp(`require(?:Fresh)?PlatformAccess\\(\\s*"${area}"`).test(code(src(route))), route);
    }
    if (!drillLinks(m.drill).length) continue;
    for (const p of m.permission) {
      if (RETRIEVAL[metricKey(m)]?.kind !== "RETRIEVABLE" || !isFleetEntry(p)) continue;
      // The null-drill rule, unchanged: a drill only where the surface's link is gated by the surface itself.
      const link = drillLinkOn(m.drill, p.area);
      const given = !!link && drillRouteArea(link.api) === p.area;
      const e = await retrieveWith(p.area, R, SA, metricKey(m), {}, NOW);
      check(`${metricKey(m)} on ${p.area}: drill ${given ? "given" : "null + reason"}`,
        given ? (!!e?.drill && e.drillReason === null && "href" in e.drill && e.drill.href === link!.api) : (e?.drill === null && e.drillReason === NO_DRILL_ON_SURFACE));
    }
  }
  const csInc = await retrieveWith("CUSTOMER_SUCCESS", R, CS, "incident-broken-now", {}, NOW);
  const opsInc = await retrieveWith("PLATFORM_OPS", R, OPS, "incident-broken-now", {}, NOW);
  check("incident-broken-now on CUSTOMER_SUCCESS ⇒ the CS incidents route and the CS Broken now view (per-surface drill)",
    !!csInc?.drill && "href" in csInc.drill && csInc.drill.href === "/api/platform/customer-success/incidents"
    && csInc.drill.page === "/dashboard/platform/CUSTOMER_SUCCESS?workspace=platform-incidents&view=open" && csInc.drillReason === null && csInc.value === 3);
  check("incident-broken-now on PLATFORM_OPS ⇒ the Ops incidents route and the Incidents workspace (not the bare area)",
    !!opsInc?.drill && "href" in opsInc.drill && opsInc.drill.href === "/api/platform/platform-ops/incidents"
    && opsInc.drill.page === "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents" && opsInc.drillReason === null);
  check("break-glass gets the same answer (the drill follows the surface, not the token)",
    (await retrieveWith("CUSTOMER_SUCCESS", R, SA, "incident-broken-now", {}, NOW))?.drill?.figure === "incident-broken-now@1");
  {
    const saOps = await retrieveWith("PLATFORM_OPS", R, SA, "incident-broken-now", {}, NOW);
    const hrefOf = (e: typeof csInc) => (e?.drill && "href" in e.drill ? e.drill.href : null);
    check("neither surface gets the other's drill (CS ≠ Ops; break-glass on Ops gets the Ops drill, never the CS one)",
      hrefOf(csInc) !== hrefOf(opsInc) && hrefOf(saOps) === "/api/platform/platform-ops/incidents");
    check("an Ops grant reads nothing on CUSTOMER_SUCCESS and a CS grant nothing on PLATFORM_OPS (identity-tier CS drill stays off Ops)",
      (await retrieveWith("CUSTOMER_SUCCESS", R, OPS, "incident-broken-now", {}, NOW)) === null
      && (await retrieveWith("PLATFORM_OPS", R, CS, "incident-broken-now", {}, NOW)) === null);
  }
  const po = METRICS.find((m) => m.id === "provider-outcome")!;
  check("provider-outcome: the ProviderCall attempt-verdict gap is stated in the registry's coverageGaps (and so in the envelope)",
    po.coverageGaps.some((g) => /ProviderCall attempt verdict/.test(g) && /provider-health/.test(g))
    && ((await retrieveWith("PLATFORM_OPS", R, OPS, "provider-outcome", {}, NOW))?.coverage.gaps ?? []).some((g) => /ProviderCall attempt verdict/.test(g)));
})();

// ── 8. static pins ───────────────────────────────────────────────────────────
console.log("\n8. static — no mint path, literal surfaces, no side effects, bounded importers");
{
  const core = code(src("lib/platform/intelligence/metrics/retrieve-core.ts"));
  const bind = code(src("lib/platform/intelligence/metrics/retrieve.ts"));
  // The navigation registry (foundation step 3) sits under the SAME no-mint pin (S2 #365).
  const navReg = code(src("lib/platform/intelligence/navigation/registry.ts"));
  const navAcc = code(src("lib/platform/intelligence/navigation/access.ts"));
  for (const [name, s] of [["navigation/registry.ts", navReg], ["navigation/access.ts", navAcc]] as const) {
    check(`${name}: no issue( / mint( / incidentAudienceFor( / metricAccessFor( / SYSTEM token`,
      !/\bissue\(|\bmint\(|incidentAudienceFor\(|metricAccessFor\(|systemIncidentAudience|ISSUED|MINTED/.test(s));
  }
  for (const [name, s] of [["retrieve-core.ts", core], ["retrieve.ts", bind]] as const) {
    check(`${name}: no issue( / mint( / incidentAudienceFor( / metricAccessFor( / SYSTEM token`,
      !/\bissue\(|\bmint\(|incidentAudienceFor\(|metricAccessFor\(|systemIncidentAudience|ISSUED|MINTED/.test(s));
    check(`${name}: no writes, no raw SQL, no caching or module state`,
      !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|localStorage|new (Weak)?Map\(|^let\s|^var\s/m.test(s));
  }
  check("retrieve.ts is server-only", /^import "server-only";/m.test(src("lib/platform/intelligence/metrics/retrieve.ts")));

  // Literal-surface scanner, with fixtures.
  const CALL = /\b(retrieveMetric|retrieveWith|atSurface)\(\s*([^,)]*)/g;
  const nonLiteral = (s: string): string[] => [...code(s).matchAll(CALL)]
    .filter((mm) => !/function\s+$/.test(code(s).slice(Math.max(0, (mm.index ?? 0) - 9), mm.index)))
    .map((mm) => mm[2].trim()).filter((a) => !/^"[A-Z_]+"$/.test(a));
  check("scanner: a literal surface passes", nonLiteral(`await retrieveMetric("PLATFORM_OPS", ctx, "x")`).length === 0);
  check("scanner: a variable, a template or a request param is caught",
    nonLiteral(`retrieveMetric(area, ctx, "x")`).length === 1 && nonLiteral("retrieveMetric(`${a}`, ctx, id)").length === 1
    && nonLiteral(`atSurface(url.searchParams.get("s"), t, id)`).length === 1);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(path.relative(ROOT, p));
    }
  };
  for (const d of ["app", "lib", "components", "jobs", "scripts"]) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  // The two forwarding hops inside the contract itself (retrieveMetric → retrieveWith → atSurface) pass the parameter on.
  const FORWARDS: Record<string, string[]> = {
    "lib/platform/intelligence/metrics/retrieve.ts": ["surface"],
    "lib/platform/intelligence/metrics/retrieve-core.ts": ["surface"],
  };
  const bad = files.flatMap((f) => {
    const s = readFileSync(path.join(ROOT, f), "utf8");
    if (!/retrieveMetric\(|retrieveWith\(|atSurface\(/.test(s)) return [];
    return nonLiteral(s).filter((a) => !(FORWARDS[f] ?? []).includes(a)).map((a) => `${f}: ${a}`);
  });
  check("every retrieveMetric / atSurface call site passes a string-literal surface", bad.length === 0, bad.join("; "));
  check("…and the forwards are exactly one each (retrieveMetric → retrieveWith, retrieveWith → atSurface)",
    nonLiteral(src("lib/platform/intelligence/metrics/retrieve.ts")).join() === "surface" && nonLiteral(src("lib/platform/intelligence/metrics/retrieve-core.ts")).join() === "surface");

  const importers = files.filter((f) => /intelligence\/metrics\/retrieve(-core)?["']/.test(readFileSync(path.join(ROOT, f), "utf8")));
  // The navigation registry imports only pure tiering helpers (access.ts: tokenTierOnSurface / TIER_RANK;
  // registry.ts: SURFACE_TIER) — pinned in navigation/registry.test.ts.
  // Platform AI v0 core (lib/platform/intelligence/ai/) takes TYPES only from the contract; the guarded route binds it.
  const typeOnlyImp = (f: string) => [...readFileSync(path.join(ROOT, f), "utf8").matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@\/lib\/platform\/intelligence\/metrics\/retrieve(?:-core)?";/gm)]
    .every((m) => !!m[1]);
  const strayImp = importers.filter((f) => f !== "lib/platform/intelligence/metrics/retrieve.ts"
    && f !== "lib/platform/intelligence/navigation/access.ts" && f !== "lib/platform/intelligence/navigation/registry.ts"
    && !(f.startsWith("lib/platform/intelligence/ai/") && typeOnlyImp(f))
    && !(f.startsWith("app/api/") && /const \[(\w+), \w+\] = await require(?:Fresh)?PlatformAccess\(/.test(readFileSync(path.join(ROOT, f), "utf8"))));
  check("the contract is imported only by retrieve.ts, the navigation registry (tiering only), the AI core (types only), tests, or guarded API routes", strayImp.length === 0, strayImp.join(", "));
}

// ── 9. operations metrics (Platform AI operational briefing, 2026-11-08) ─────
console.log("\n9. operations metrics — the Platform Ops aggregates, counts and registry names only");
await (async () => {
  const OPS_METRICS = ["ops-overall-posture@1", "customer-impact-24h@1", "incident-needs-verification@1", "incident-resolved-window@1", "alerts-firing-now@1",
    "connection-health-summary@1", "refresh-pipeline@1", "scheduled-job-health@1", "provider-call-volume@1", "data-freshness@1"];
  const IDENTITY = [/subjectUserId/, /\buser #/i, new RegExp(CUID), /[^\s@"]+@[^\s@"]+\.[^\s@"]+/, new RegExp(INSTITUTION), /abc123/];
  const scan = (e: MetricEnvelope | null) => { const j = JSON.stringify(e); return IDENTITY.filter((r) => r.test(j)).map(String); };
  const queries: { status: string; from: string | null; to: string | null }[] = [];
  const rec = newRec();
  const calls = (today: number | null, month: number | null) => ({ callsToday: today, calls30d: month, syncFailures: 1 });
  const R = readers(rec, {
    incidentSearch: async (t, q) => { rec.incidentAudiences.push(t.audience); queries.push({ status: q.status, from: q.from, to: q.to }); return searchFx(); },
    providerHealth: async () => ({ checkedAt: NOW, providers: [{ key: "A", label: `P ${EMAIL}`, ...calls(10, 300), notes: [CUID] }, { key: "B", label: "B", ...calls(5, 50), notes: [] }] }) as never,
  });
  const get = (surface: Parameters<typeof retrieveWith>[0], ctx: RetrievalContext, id: string, params = {}, r: RetrievalReaders = R) => retrieveWith(surface, r, ctx, id, params, NOW);

  check("every operations metric is registered, RETRIEVABLE, and served on PLATFORM_OPS (identity tier OPS)",
    OPS_METRICS.every((k) => RETRIEVAL[k]?.kind === "RETRIEVABLE" && METRICS.find((m) => metricKey(m) === k)!.permission.some((p) => p.area === "PLATFORM_OPS" && p.identityTier === "OPS")));
  check("permission: only the incident pair is also served on CUSTOMER_SUCCESS; the rest are PLATFORM_OPS-only (no new grant, no CS exposure)",
    OPS_METRICS.every((k) => { const areas = METRICS.find((m) => metricKey(m) === k)!.permission.map((p) => p.area).sort().join();
      return k.startsWith("incident-") ? areas === "CUSTOMER_SUCCESS,PLATFORM_OPS" : areas === "PLATFORM_OPS"; }));
  for (const k of OPS_METRICS) {
    const e = await get("PLATFORM_OPS", OPS, k);
    check(`${k}: an Ops grant reads it (status ${e?.status}), with NO identity in the envelope (no id, email, institution, user ref)`, !!e && e.status !== "UNAVAILABLE" && scan(e).length === 0, `${e?.status} ${e?.reason} ${scan(e).join()}`);
    check(`${k}: subjects (when present) are registry names in the closed state vocabulary`,
      !!e && (e.subjects ?? []).every((x) => isSubjectLabel(x.label) && (SUBJECT_STATES as readonly string[]).includes(x.state)));
    for (const [name, ctx] of [["Growth", GR], ["Merchant", MO]] as const) {
      check(`${k}: a ${name} grant reads nothing on PLATFORM_OPS (null — no oracle)`, (await get("PLATFORM_OPS", ctx, k)) === null);
    }
  }
  const posture = await get("PLATFORM_OPS", OPS, "ops-overall-posture");
  check("ops-overall-posture: domains counted by state; an UNKNOWN domain ⇒ PARTIAL (never counted healthy)",
    JSON.stringify(posture?.value) === JSON.stringify({ failed: 1, degraded: 1, stale: 0, unknown: 1, healthy: 3 }) && posture?.status === "PARTIAL", JSON.stringify(posture?.value));
  check("ops-overall-posture: the not-healthy domains are named by SERVER labels (never the payload's title), latestFailures never read",
    JSON.stringify(posture?.subjects) === JSON.stringify([{ label: "Refresh pipeline", state: "failed" }, { label: "Connections", state: "degraded" }, { label: "Daily Brief", state: "unknown" }]), JSON.stringify(posture?.subjects));
  const pipe = await get("PLATFORM_OPS", OPS, "refresh-pipeline");
  check("refresh-pipeline: the overview's pipeline card facts (executions / failed / running now), its verdict named",
    JSON.stringify(pipe?.value) === JSON.stringify({ executions: 12, failed: 3, runningNow: 1 }) && pipe?.subjects?.[0]?.state === "failed" && pipe.window.label === "since yesterday (UTC)", JSON.stringify(pipe));
  const impact = await get("PLATFORM_OPS", OPS, "customer-impact-24h");
  check("customer-impact-24h: counts per kind + customers affected, 24 h window, read with the OPS-tier incident token",
    JSON.stringify(impact?.value) === JSON.stringify({ refreshFailed: 2, refreshPartial: 1, aiFailures: 4, briefFailed: 0, needsReauth: 3, customersAffected: 5, sourcesAffected: 2 })
    && impact?.window.hours === 24 && impact.status === "MEASURED" && rec.incidentAudiences.at(-1) === "PLATFORM_OPS", JSON.stringify(impact?.value));
  const impactP = await get("PLATFORM_OPS", OPS, "customer-impact-24h", {}, readers(newRec(), { attention: async () => attentionFx({ failed: ["ai-failures"], users: { count: null, reason: "no ref" } }) }));
  check("customer-impact-24h: a failed impact reader or no customer reference ⇒ PARTIAL, customers affected null (never 0), both named",
    impactP?.status === "PARTIAL" && (impactP.value as Record<string, unknown>).customersAffected === null && impactP.coverage.missing.length === 2, JSON.stringify(impactP));
  const conn = await get("PLATFORM_OPS", OPS, "connection-health-summary");
  check("connection-health-summary: NO_ACCOUNTS (update-mode fixable ERROR) counts as reconnect needed beside NEEDS_REAUTH; every non-healthy live connection is customer-impacting",
    (conn?.value as Record<string, number>).reconnectNeeded === 2 && (conn?.value as Record<string, number>).customerImpacting === 5 && (conn?.value as Record<string, number>).error === 2 && conn?.status === "MEASURED", JSON.stringify(conn?.value));
  const connP = await get("PLATFORM_OPS", OPS, "connection-health-summary", {}, readers(newRec(), { connectionHealth: async () => connectionFx(false) }));
  check("connection-health-summary: no per-source tally ⇒ PARTIAL, reconnect needed a floor (NEEDS_REAUTH only)", connP?.status === "PARTIAL" && (connP.value as Record<string, number>).reconnectNeeded === 1);
  const alerts = await get("PLATFORM_OPS", OPS, "alerts-firing-now");
  check("alerts-firing-now: firing / critical / not evaluable / enabled from the LATEST evaluation; the destination never read",
    JSON.stringify(alerts?.value) === JSON.stringify({ firing: 3, firingCritical: 1, notEvaluable: 1, enabledRules: 4, sourcesUnavailable: 0 }) && alerts?.freshness.asOf === NOW.toISOString(), JSON.stringify(alerts?.value));
  check("alerts-firing-now: firing rules named by registry id; a non-slug id is DROPPED from subjects (still counted)",
    JSON.stringify(alerts?.subjects) === JSON.stringify([{ label: "job-failing", state: "firing-critical" }, { label: "resource-stale", state: "firing" }, { label: "quota-low", state: "not-evaluable" }]), JSON.stringify(alerts?.subjects));
  const alertsU = await get("PLATFORM_OPS", OPS, "alerts-firing-now", {}, readers(newRec(), { alertRuns: async () => [] }));
  check("alerts-firing-now: no evaluation ⇒ UNAVAILABLE (never 'nothing firing')", alertsU?.status === "UNAVAILABLE" && alertsU.value === null);
  const alertsB = await get("PLATFORM_OPS", OPS, "alerts-firing-now", {}, readers(newRec(), { alertRuns: async () => alertRunsFx({ blind: true }) }));
  check("alerts-firing-now: an unreadable alert source ⇒ PARTIAL", alertsB?.status === "PARTIAL" && (alertsB.value as Record<string, number>).sourcesUnavailable === 1);
  const jobs = await get("PLATFORM_OPS", OPS, "scheduled-job-health");
  check("scheduled-job-health: the job-health route's counts; not-healthy jobs named by registry name, failure text never read",
    JSON.stringify(jobs?.value) === JSON.stringify({ healthy: 1, running: 0, overdue: 1, failing: 1, dead: 0, neverRan: 0, skipped: 0, notScheduled: 1 })
    && JSON.stringify(jobs?.subjects) === JSON.stringify([{ label: "sync-banks", state: "failing" }, { label: "evaluate-alerts", state: "overdue" }]), JSON.stringify(jobs));
  const fresh = await get("PLATFORM_OPS", OPS, "data-freshness");
  check("data-freshness: resources per state; stale resource named by registry id (never its label)",
    JSON.stringify(fresh?.value) === JSON.stringify({ fresh: 1, stale: 1, empty: 0, idle: 0, notRefreshed: 0 }) && JSON.stringify(fresh?.subjects) === JSON.stringify([{ label: "fx-rates", state: "stale" }]));
  const vol = await get("PLATFORM_OPS", OPS, "provider-call-volume");
  check("provider-call-volume: Σ metered calls (today / rolling month) and sync failures", JSON.stringify(vol?.value) === JSON.stringify({ callsToday: 15, callsMonth: 350, syncFailures: 2, meteredProviders: 2, unmeteredProviders: 0 }), JSON.stringify(vol?.value));
  const volU = await get("PLATFORM_OPS", OPS, "provider-call-volume", {}, readers(newRec()));
  check("provider-call-volume: no metered provider ⇒ UNAVAILABLE (never 0 calls)", volU?.status === "UNAVAILABLE" && volU.value === null);
  queries.length = 0;
  const verify = await get("PLATFORM_OPS", OPS, "incident-needs-verification");
  const resolved = await get("PLATFORM_OPS", OPS, "incident-resolved-window");
  const resolved1 = await get("PLATFORM_OPS", OPS, "incident-resolved-window", { window: 1 });
  check("incident-needs-verification: the needs-verification preset's total", verify?.value === 3 && queries[0]?.status === "needs-verification");
  check("incident-resolved-window: the history preset over the window's UTC days (7 default: from = today − 6; 1 = today only)",
    resolved?.value === 3 && queries[1]?.status === "history" && queries[1].from === "2026-10-29" && queries[1].to === "2026-11-04" && queries[2].from === "2026-11-04" && resolved1?.window.label === "in the last 1 day", JSON.stringify(queries));
  const capped = await get("PLATFORM_OPS", OPS, "incident-needs-verification", {}, readers(newRec(), { incidentSearch: async () => searchFx(true) }));
  check("incident counts: a capped scan ⇒ PARTIAL (a floor — say 'at least')", capped?.status === "PARTIAL" && /floor/.test(capped.reason ?? ""));
  const csVerify = await get("CUSTOMER_SUCCESS", CS, "incident-needs-verification");
  check("incident-needs-verification on CUSTOMER_SUCCESS: its own tier, still no identity (aggregates only)", csVerify?.tier === "CUSTOMER_SUCCESS" && scan(csVerify).length === 0);
  check("resolved window: an undeclared window (14) ⇒ UNAVAILABLE[WINDOW_NOT_OFFERED] naming 7, 1, 30",
    (await get("PLATFORM_OPS", OPS, "incident-resolved-window", { window: 14 }))?.reason === "window must be one of 7, 1, 30 (days) — 14 is not offered");
  check("isSubjectLabel: server labels and kebab slugs pass; identifiers, emails, digits and payload labels fail",
    isSubjectLabel("Refresh pipeline") && isSubjectLabel("sync-banks") && !isSubjectLabel(EMAIL) && !isSubjectLabel(CUID) && !isSubjectLabel("job-2") && !isSubjectLabel(`Connection · ${INSTITUTION} 42`));
})();

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

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
import { METRICS, metricKey } from "./registry";
import { metricAccessFor, type MetricAccessToken } from "./access";
import {
  NO_DRILL_ON_SURFACE, READER_SYMBOL, RETRIEVAL, atSurface, drillRouteArea, isAggregate, isFleetEntry, retrieveWith,
  type MetricEnvelope, type RetrievalContext, type RetrievalReaders,
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
    { key: "E", label: "E", execution: { verdict: "DEGRADED" }, connections: { verdict: "DEGRADED", tally: { active: 9, error: 1, reauth: 0, unclassified: 0, revoked: 0 } }, notes: [] },
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

const LIVE_FX = { sessions: 7, distinctUsers: 3 };
const ACCOUNTS_FX = 2;

interface Recorder { incidentAudiences: string[]; csAudiences: string[]; windows: number[] }
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
    ...over,
  };
}
const newRec = (): Recorder => ({ incidentAudiences: [], csAudiences: [], windows: [] });

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
    && po?.status === "MEASURED", JSON.stringify(po?.value));
  const pc = await get("PLATFORM_OPS", OPS, "provider-connection@1");
  check("provider-connection: counts = the reader's own connection verdicts",
    JSON.stringify(pc?.value) === JSON.stringify({ failing: 1, degraded: 1, noVerdict: 1, noConnections: 2 }) && pc?.status === "MEASURED", JSON.stringify(pc?.value));

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
    liveSessions: boom, accountsWithLiveSession: boom,
  };
  for (const m of retrievable) {
    const surface = m.permission[0].area;
    const e = await retrieveWith(surface, failing, SA, metricKey(m), {}, NOW);
    check(`${metricKey(m)}: reader failure ⇒ UNAVAILABLE, null, reason, and the error text is not echoed`,
      e?.status === "UNAVAILABLE" && e.value === null && !!e.reason && !e.reason.includes(EMAIL) && !JSON.stringify(e).includes(CUID), JSON.stringify(e?.reason));
  }
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
    const e = await retrieveWith(m.permission[0].area, R, SA, metricKey(m), {}, NOW);
    const d = e?.drill;
    const ok = !!d && d.figure === metricKey(m) && ("unavailable" in m.drill
      ? "unavailable" in d && d.unavailable === m.drill.unavailable
      : "href" in d && d.href === m.drill.api && d.page === m.drill.page);
    check(`${metricKey(m)}: drill = registry (${"api" in m.drill ? m.drill.api : "unavailable"}), keys only figure/window/href/page`,
      ok && Object.keys(d!).every((x) => ["figure", "window", "href", "page", "unavailable"].includes(x)));
    check(`${metricKey(m)}: basis names the registry's code refs`, e?.basis.compute === `${m.compute.module}#${m.compute.symbol}` && e.basis.reader === m.path[0].calls && e.basis.definition === metricKey(m));
  }

  // The drill exists only where the EFFECTIVE surface satisfies the drill route's own gate.
  for (const m of METRICS) {
    if (!("api" in m.drill)) continue;
    const area = drillRouteArea(m.drill.api);
    const route = path.join("app", m.drill.api.split("?")[0], "route.ts");
    check(`${metricKey(m)}: drill route ${m.drill.api} is gated by its segment's area (${area})`,
      !!area && new RegExp(`require(?:Fresh)?PlatformAccess\\(\\s*"${area}"`).test(code(src(route))), route);
    for (const p of m.permission) {
      if (RETRIEVAL[metricKey(m)]?.kind !== "RETRIEVABLE" || !isFleetEntry(p)) continue;
      const e = await retrieveWith(p.area, R, SA, metricKey(m), {}, NOW);
      check(`${metricKey(m)} on ${p.area}: drill ${p.area === area ? "given" : "null + reason"} (drill route gated by ${area})`,
        p.area === area ? (!!e?.drill && e.drillReason === null) : (e?.drill === null && e.drillReason === NO_DRILL_ON_SURFACE));
    }
  }
  const csInc = await retrieveWith("CUSTOMER_SUCCESS", R, CS, "incident-broken-now", {}, NOW);
  const opsInc = await retrieveWith("PLATFORM_OPS", R, OPS, "incident-broken-now", {}, NOW);
  check("incident-broken-now on CUSTOMER_SUCCESS ⇒ drill null, drillReason 'no drill on this surface' (the drill route is Platform Ops)",
    csInc?.drill === null && csInc.drillReason === "no drill on this surface" && csInc.value === 3);
  check("incident-broken-now on PLATFORM_OPS ⇒ drill non-null, the registry's route",
    !!opsInc?.drill && "href" in opsInc.drill && opsInc.drill.href === "/api/platform/platform-ops/incidents" && opsInc.drillReason === null);
  check("break-glass gets the same answer (the drill follows the surface, not the token)",
    (await retrieveWith("CUSTOMER_SUCCESS", R, SA, "incident-broken-now", {}, NOW))?.drill === null);
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
  const strayImp = importers.filter((f) => f !== "lib/platform/intelligence/metrics/retrieve.ts"
    && !(f.startsWith("app/api/") && /const \[(\w+), \w+\] = await require(?:Fresh)?PlatformAccess\(/.test(readFileSync(path.join(ROOT, f), "utf8"))));
  check("the contract is imported only by retrieve.ts, tests, or guarded API routes (none in this slice)", strayImp.length === 0, strayImp.join(", "));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

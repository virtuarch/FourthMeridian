/**
 * lib/platform/ops/attention-core.test.ts  (UX-P1 · Agent 2)
 *
 * The attention composition restates existing verdicts, ranks them by the ONE
 * declared table, sorts server-side, names failed authorities, captions floors,
 * and never lets a historical alert become a row. Plus the SOURCE pins for the
 * reader, the route and the D5 projection: no database client, no customer
 * identity, PLATFORM_OPS READ first.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ops/attention-core.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ATTENTION_AUTHORITIES,
  ATTENTION_SEVERITY_RANK,
  SEVERITY_OF,
  buildAttention,
  relativeAge,
  type AttentionInputs,
} from "./attention-core";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import type { ProviderHealth, ProviderHealthResult } from "@/lib/platform/provider-health";
import type { ResourceFreshnessReport, ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { PlatformIncidentProjection } from "@/lib/platform/incidents/platform-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const now = new Date("2026-10-14T12:00:00.000Z");
const AGO = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

// ── Fixtures (typed against the real authority shapes) ───────────────────────

const connections: ConnectionHealthResult = {
  total: 5,
  counts: { HEALTHY: 2, STALE: 1, DEGRADED: 0, NEEDS_REAUTH: 1, ERROR: 1, REVOKED: 0 },
  unhealthy: [
    { source: "PLAID", id: "item_err", label: "Chase", status: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED", healthState: "ERROR", lastSyncedAt: AGO(30), since: AGO(26) },
    { source: "PLAID", id: "item_reauth", label: "Wells Fargo", status: "NEEDS_REAUTH", errorCode: null, healthState: "NEEDS_REAUTH", lastSyncedAt: AGO(50), since: AGO(48) },
    { source: "WALLET", id: "conn_w", label: "Wallet …abc123", status: "ACTIVE", errorCode: null, healthState: "STALE", lastSyncedAt: AGO(10), since: null },
  ],
  retired: { revoked: 1, ownerInactive: 0 },
};

const jobs: NonNullable<AttentionInputs["jobs"]> = {
  jobs: [
    { job: "sync-banks", status: "failing", expectedEveryHours: 24, consecutiveFailures: 3, lastStartedAt: AGO(6), lastFailureAt: AGO(6), lastFailureSummary: "Plaid timed out" },
    { job: "fetch-fx-rates", status: "overdue", expectedEveryHours: 24, consecutiveFailures: 0, lastStartedAt: AGO(40), lastFailureAt: null, lastFailureSummary: null },
    { job: "purge-trash", status: "dead", expectedEveryHours: 24, consecutiveFailures: 0, lastStartedAt: AGO(200), lastFailureAt: null, lastFailureSummary: null },
    { job: "evaluate-alerts", status: "healthy", expectedEveryHours: 6, consecutiveFailures: 0, lastStartedAt: AGO(1), lastFailureAt: null, lastFailureSummary: null },
    { job: "sync-crypto", status: "never-ran", expectedEveryHours: 6, consecutiveFailures: 0, lastStartedAt: null, lastFailureAt: null, lastFailureSummary: null },
  ],
};

function provider(over: Partial<ProviderHealth> & { key: string; label: string }): ProviderHealth {
  return {
    kind: "BANKING", trust: "OPERATIONAL", availability: 1, lastSuccessAt: AGO(1), lastFailureAt: null, latencyMs: 900,
    quota: null, remainingQuota: null, coverage: null, coverageUnit: null,
    freshness: { state: "fresh", asOf: AGO(1), ageDays: 0, source: "connection-health", detail: "synced 1h ago" },
    syncFailures: 0, errorRate: 0, callsToday: null, calls30d: null, notes: [], ...over,
  };
}
const providers: ProviderHealthResult = {
  checkedAt: now,
  counts: { OPERATIONAL: 1, DEGRADED: 0, STALE: 0, FAILING: 1, UNKNOWN: 0 },
  providers: [
    provider({ key: "PLAID", label: "Plaid" }),
    provider({ key: "OXR", label: "Open Exchange Rates", kind: "FX", trust: "FAILING", lastFailureAt: AGO(3), freshness: { state: "stale", asOf: "2026-10-10", ageDays: 4, source: "resource-freshness", detail: "4 days stale" }, notes: ["3 consecutive failures"] }),
  ],
};

function resource(over: Partial<ResourceFreshnessReport> & { resource: string; label: string }): ResourceFreshnessReport {
  return {
    newestObservedDate: "2026-10-14", ageHours: 3, ageDays: 0, expectedCadenceHours: 24, cadenceLabel: "daily", staleAfterHours: 48,
    healthState: "fresh", completeness: null, lastSuccessfulRefresh: AGO(3), lastAttemptedRefresh: AGO(3), lastAttemptStatus: "succeeded",
    trust: { level: "high", caveats: [] }, ...over,
  };
}
const resources: ResourceFreshnessResult = {
  checkedAt: now, allFresh: false,
  resources: [
    resource({ resource: "fx-rates", label: "FX rates", healthState: "stale", newestObservedDate: "2026-10-10", ageDays: 4 }),
    resource({ resource: "security-prices", label: "Security prices", healthState: "empty", newestObservedDate: null, ageDays: null, trust: { level: "unknown", caveats: ["no price vendor configured"] } }),
    resource({ resource: "cold", label: "Cold archive", healthState: "empty", newestObservedDate: null, ageDays: null, trust: { level: "low", caveats: ["archive is empty"] } }),
  ],
};

const alerts: NonNullable<AttentionInputs["alerts"]> = {
  latest: {
    evaluatedAtISO: AGO(2),
    deliveryStatus: "sent",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: 1, delivered: 1, suppressed: 0 },
    rules: [
      { id: "job-failing", kind: "job-failing", enabled: true, live: true, firing: true, breaches: 1, severity: "critical" },
      { id: "resource-stale", kind: "resource-stale", enabled: true, live: true, firing: false, breaches: 0, severity: null },
    ],
  },
  titles: { "job-failing": "Repeated job failures", "resource-stale": "Resource stale" },
};

const incident = (over: Partial<PlatformIncidentProjection> & { id: string }): PlatformIncidentProjection => ({
  label: "Transaction persistence failed", operationLabel: "storing delivered transactions", subject: "Chase · Checking",
  domain: "transactions", severity: "critical", state: "active", firstOccurredAt: AGO(100), lastOccurredAt: AGO(2),
  occurrenceCount: 4, occurrenceCountKnown: true, recovery: "automatic-available", refreshExecutionId: "exec_1", ...over,
});
const incidents: NonNullable<AttentionInputs["incidents"]> = {
  items: [incident({ id: "inc_a" }), incident({ id: "inc_b", severity: "warning", subject: null, refreshExecutionId: null, state: "active" })],
  activeTotal: 2, truncated: false,
};

const full: AttentionInputs = { connections, jobs, providers, resources, alerts, incidents };

// ── Composition ──────────────────────────────────────────────────────────────

console.log("rank and order");
{
  const out = buildAttention(full, now);
  check("rank is declared critical < error < warning < info",
    ATTENTION_SEVERITY_RANK.critical < ATTENTION_SEVERITY_RANK.error && ATTENTION_SEVERITY_RANK.error < ATTENTION_SEVERITY_RANK.warning && ATTENTION_SEVERITY_RANK.warning < ATTENTION_SEVERITY_RANK.info);
  const ranks = out.items.map((i) => ATTENTION_SEVERITY_RANK[i.severity]);
  check("items are sorted by severity, non-decreasing", ranks.every((r, i) => i === 0 || r >= ranks[i - 1]), ranks.join(","));
  const crit = out.items.filter((i) => i.severity === "critical");
  check("within a severity, longest-standing first (since ascending)",
    crit.every((it, i) => i === 0 || !it.since || !crit[i - 1].since || it.since >= (crit[i - 1].since as string)), crit.map((c) => `${c.id}@${c.since}`).join(" | "));
  check("every row names its basis", out.items.every((i) => i.basis.length > 20));
  check("counts match the rows", out.counts.critical + out.counts.error + out.counts.warning + out.counts.info === out.items.length);
}

console.log("restatements, never new verdicts");
{
  const out = buildAttention(full, now);
  const by = (id: string) => out.items.find((i) => i.id === id);
  // Connections
  check("ERROR connection → critical (declared)", by("connection:PLAID:item_err")?.severity === SEVERITY_OF.connection.ERROR);
  check("NEEDS_REAUTH connection → error, and no resync is offered (the route would refuse)",
    by("connection:PLAID:item_reauth")?.severity === "error" && !by("connection:PLAID:item_reauth")?.actions.some((a) => a.kind === "resync")
    && by("connection:PLAID:item_reauth")?.actions.some((a) => a.kind === "request-reauth") === true);
  check("ERROR Plaid connection offers resync + request-reauth", by("connection:PLAID:item_err")?.actions.map((a) => a.kind).join(",") === "resync,request-reauth,open-workspace");
  check("a wallet offers no Plaid write, only the doorway", by("connection:WALLET:conn_w")?.actions.map((a) => a.kind).join(",") === "open-workspace");
  check("a stale row's since falls back to its last sync", by("connection:WALLET:conn_w")?.since === connections.unhealthy[2].lastSyncedAt);
  check("the connection entity carries the institution label and an opaque ref", by("connection:PLAID:item_err")?.entity.label === "Chase" && by("connection:PLAID:item_err")?.entity.ref === "item_err");
  // Jobs
  check("dead → critical, failing → error, overdue → warning", by("job:purge-trash")?.severity === "critical" && by("job:sync-banks")?.severity === "error" && by("job:fetch-fx-rates")?.severity === "warning");
  check("healthy and never-ran jobs are not rows", !by("job:evaluate-alerts") && !by("job:sync-crypto"));
  check("run-now is a doorway action, paired with the Jobs workspace", by("job:sync-banks")?.actions.map((a) => a.kind).join(",") === "run-now,open-workspace");
  check("a failing job's since is its last failure", by("job:sync-banks")?.since === jobs.jobs[0].lastFailureAt);
  // Providers
  check("FAILING provider → error, named with the authority's word", by("provider:OXR")?.severity === "error" && /Failing/.test(by("provider:OXR")?.problem ?? ""));
  check("an operational provider is not a row", !by("provider:PLAID"));
  // Resources
  check("stale resource → warning", by("resource:fx-rates")?.severity === "warning");
  check("a genuinely empty archive → error", by("resource:cold")?.severity === "error");
  check("a known-blocked empty archive (trust unknown) is NOT a row — mirrors alerting", !by("resource:security-prices"));
  // Alerts
  check("only the rule firing in the LATEST evaluation is a row", by("alert:job-failing") != null && !by("alert:resource-stale"));
  check("the alert row carries the rule title and the evaluation time as since", by("alert:job-failing")?.entity.label === "Repeated job failures" && by("alert:job-failing")?.since === alerts.latest?.evaluatedAtISO);
  // Incidents
  check("a correlated incident's evidence is its execution", by("incident:inc_a")?.evidence.kind === "execution" && (by("incident:inc_a")?.evidence as { id?: string }).id === "exec_1");
  check("an uncorrelated incident's evidence is a doorway", by("incident:inc_b")?.evidence.kind === "incident");
  check("an unknown subject is stated, never guessed", by("incident:inc_b")?.entity.label === "Subject unavailable");
}

console.log("history never becomes a row");
{
  const quiet = buildAttention({ ...full, alerts: { ...alerts, latest: { ...alerts.latest!, rules: alerts.latest!.rules.map((r) => ({ ...r, firing: false })) } } }, now);
  check("no rule firing in the latest run → no alert rows, whatever was delivered before", !quiet.items.some((i) => i.entity.kind === "alert-rule"));
  const never = buildAttention({ ...full, alerts: { latest: null, titles: {} } }, now);
  check("never evaluated → checked, but no alert rows", never.authorities.checked.includes("alert-evaluation") && !never.items.some((i) => i.entity.kind === "alert-rule"));
}

console.log("failed authorities and floors");
{
  const partial = buildAttention({ ...full, jobs: null, incidents: null }, now);
  check("failed readers are NAMED", partial.authorities.failed.join(",") === "job-health,incidents");
  check("the rest still answer", partial.authorities.checked.length === 4 && partial.items.some((i) => i.entity.kind === "connection"));
  check("ATTENTION_AUTHORITIES lists every reader exactly once", ATTENTION_AUTHORITIES.length === 6 && new Set(ATTENTION_AUTHORITIES).size === 6);
  const empty = buildAttention({ connections: { total: 2, counts: { HEALTHY: 2, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 } }, jobs: { jobs: [] }, providers: { ...providers, providers: [] }, resources: { ...resources, resources: [] }, alerts: { latest: null, titles: {} }, incidents: { items: [], activeTotal: 0, truncated: false } }, now);
  check("nothing wrong → zero rows and six authorities checked", empty.items.length === 0 && empty.authorities.checked.length === 6 && empty.floors.length === 0);
  const capped = buildAttention({ ...full, connections: { ...connections, total: 40, counts: { ...connections.counts, HEALTHY: 2 } } }, now);
  check("a capped connection list is captioned as a floor", capped.floors.some((f) => /Connections: 3 of 38 unhealthy shown/.test(f)), capped.floors.join(" | "));
  const trunc = buildAttention({ ...full, incidents: { ...incidents, activeTotal: 25, truncated: true } }, now);
  check("a truncated incident scan is captioned as a floor", trunc.floors.some((f) => /Incidents: 2 of 25\+ active shown/.test(f)), trunc.floors.join(" | "));
}

console.log("privacy · the emitted DTO carries no customer identity");
{
  const out = buildAttention(full, now);
  const json = JSON.stringify(out);
  check("no email-shaped string", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(json));
  check("no key named email/userId/address/token", !/"(email|userId|walletAddress|address|accessToken|token)"\s*:/.test(json));
  check("the incident subject is the institution · account label", json.includes("Chase · Checking"));
}

console.log("relative age");
{
  check("ago", relativeAge(AGO(3), now) === "3 h ago");
  check("days", relativeAge(AGO(100), now) === "4 d ago");
  check("null → never recorded", relativeAge(null, now) === "never recorded");
}

// ── Source pins ──────────────────────────────────────────────────────────────

console.log("source · the reader composes EXISTING authorities and owns no database client");
{
  const reader = strip("lib/platform/ops/attention.ts");
  const core = strip("lib/platform/ops/attention-core.ts");
  const projection = strip("lib/platform/incidents/platform-projection.ts");
  const route = strip("app/api/platform/platform-ops/attention/route.ts");
  const overview = strip("lib/platform/ops/overview.ts");
  for (const [name, src] of [["attention.ts", reader], ["attention-core.ts", core], ["platform-projection.ts", projection], ["attention route", route]] as const) {
    check(`${name}: imports no database client`, !/@\/lib\/db\b|systemDb|tenantDb|authDb|PrismaClient/.test(src));
    check(`${name}: selects/reads no email, address, credential, token or password`,
      !/\b(email|walletAddress|encryptedToken|credential|passwordHash|sessionToken|accessToken|refreshToken|totpSecret|apiKey|secretKey)\s*:\s*true|\.(email|walletAddress|encryptedToken|credential|passwordHash)\b/.test(src));
    check(`${name}: reads no process.env`, !/process\.env/.test(src));
  }
  check("the reader composes the six named authorities",
    ["getConnectionHealth", "checkScheduledJobHealth", "getProviderHealth", "checkResourceFreshness", "loadLatestAlertEvaluation", "getIncidentPreview"].every((fn) => reader.includes(fn)));
  check("the reader hands provider health the SAME freshness and connection reads (no duplicate read)", /loadFreshness:\s*\(\)\s*=>/.test(reader) && /loadConnections:\s*\(\)\s*=>/.test(reader));
  check("history is returned as its own field, never folded into items", /recentFirings:/.test(reader) && /collectAlertHistory/.test(reader));
  check("incidents pass through the D5 projection", reader.includes("projectIncidentForPlatform"));
  check("the core never sorts in the UI's place — sortAttention is exported from the core", /export function sortAttention/.test(core));
  check("route: requires PLATFORM_OPS READ", /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(route));
  check("route: returns the auth error before reading", /if\s*\(\s*err\s*\)\s*return\s+err/.test(route) && route.indexOf("requirePlatformAccess") < route.indexOf("getAttention()"));
  check("route: never requests WRITE or CONTROL", !/["'](WRITE|CONTROL)["']/.test(route));
  check("route: exports no mutating verb", !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(route));
  // The overview's posture composition follows the same rules.
  check("overview.ts: posture authorities are best-effort (attempt) and the alerts posture reads the LATEST evaluation",
    /attempt\("alerts"/.test(overview) && overview.includes("loadLatestAlertEvaluation") && !overview.includes("collectAlertHistory"));
  check("overview.ts: hands provider health the shared freshness + connection reads", /loadConnections:\s*\(\)\s*=>\s*sourcesP/.test(overview));
  // The alerts route's new field strips the destination (an address).
  const alertsRoute = strip("app/api/platform/platform-ops/alerts/route.ts");
  const latest = strip("lib/alerts/latest-evaluation.ts");
  check("alerts route exposes `latest` through the projection, not the raw summary", alertsRoute.includes("latest: latestAlertEvaluation(recentRuns)"));
  check("the projection never copies `destination`", !/destination/.test(latest.replace(/strips `destination`/g, "")));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");

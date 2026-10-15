/**
 * lib/platform/ops/overview-core.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The overview's verdicts are derived from evidence, never from the absence
 * of an error row:
 *   · a pipeline with no executions is UNKNOWN, not HEALTHY;
 *   · failures with successes are DEGRADED; failures alone are FAILED;
 *   · sources are STALE when only overdue, DEGRADED when any needs attention;
 *   · jobs are FAILED on dead/failing, STALE on overdue, UNKNOWN when nothing
 *     ever recorded a run;
 *   · AI is always UNKNOWN (the ledger records successes only) but reports
 *     its activity; Brief is UNKNOWN on a quiet window, FAILED / DEGRADED on
 *     failures; Plaid is DEGRADED on reconnect/error;
 *   · the overall worst state ignores UNKNOWN when any real verdict exists;
 *   · every domain names its authority.
 */

import { buildOverview, derivePipeline, deriveSources, deriveJobs, deriveAi, deriveBrief, derivePlaid, derivePosture, deriveAlertsPosture, type OverviewInputs, type PostureInputs } from "./overview-core";
import type { PipelineStatus } from "@/lib/platform/refresh/types";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import { defaultRefreshPolicies } from "@/lib/platform/refresh-policy.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const now = new Date("2026-09-15T18:00:00.000Z");

function pipeline(over: Partial<PipelineStatus>): PipelineStatus {
  return {
    window: { from: "2026-09-14", to: "2026-09-15" }, deterministic: true, indeterminacyReason: null, checkedAt: now.toISOString(),
    executions: 0, byStatus: {}, kinds: [], networks: [], openExecutions: 0, latestFailures: [], tier: "observed" as PipelineStatus["tier"],
    ...over,
  };
}
function sources(counts: Partial<ConnectionHealthResult["counts"]>, total: number): ConnectionHealthResult {
  return { total, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0, ...counts }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 }, checkedAt: "2026-10-14T00:00:00.000Z", cap: 20, listedScope: "unhealthy" };
}
const policies = defaultRefreshPolicies();

console.log("pipeline");
{
  check("no executions → UNKNOWN", derivePipeline(pipeline({}), "w", now).state === "UNKNOWN");
  check("only running → UNKNOWN (nothing attempted)", derivePipeline(pipeline({ executions: 1, byStatus: { RUNNING: 1 }, openExecutions: 1 }), "w", now).state === "UNKNOWN");
  check("successes only → HEALTHY", derivePipeline(pipeline({ executions: 3, byStatus: { SUCCEEDED: 3 } }), "w", now).state === "HEALTHY");
  const mixed = derivePipeline(pipeline({ executions: 5, byStatus: { SUCCEEDED: 1, FAILED: 3, PARTIAL: 1 }, networks: [{ network: "BTC", total: 3, failed: 3, lastStatus: "FAILED", lastStartedAt: now.toISOString() }] }), "since yesterday", now);
  check("failures + a success → DEGRADED", mixed.state === "DEGRADED");
  check("headline names the failing network", /BTC/.test(mixed.headline), mixed.headline);
  check("failures only → FAILED", derivePipeline(pipeline({ executions: 2, byStatus: { FAILED: 2 } }), "w", now).state === "FAILED");
  const withLast = derivePipeline(pipeline({ executions: 1, byStatus: { SUCCEEDED: 1 }, kinds: [{ kind: "WALLET", total: 1, succeeded: 1, failed: 0, partial: 0, skipped: 0, running: 0, lastSucceededAt: "2026-09-15T17:00:00.000Z" }] }), "w", now);
  check("last wallet success is relative, last bank success 'never recorded'",
    withLast.facts.some((f) => f.label === "Last wallet success" && f.value === "1 h ago") && withLast.facts.some((f) => f.label === "Last bank success" && f.value === "never recorded"));
  check("names its authority", /RefreshExecution/.test(withLast.basis));
}

console.log("sources");
{
  check("no sources → UNKNOWN", deriveSources(sources({}, 0), policies).state === "UNKNOWN");
  check("all healthy → HEALTHY", deriveSources(sources({ HEALTHY: 3 }, 3), policies).state === "HEALTHY");
  const stale = deriveSources(sources({ HEALTHY: 1, STALE: 2 }, 3), policies);
  check("only stale → STALE, headline cites the policy", stale.state === "STALE" && /24h/.test(stale.headline) && /6h/.test(stale.headline), stale.headline);
  check("a reconnect among healthy → DEGRADED", deriveSources(sources({ HEALTHY: 2, NEEDS_REAUTH: 1 }, 3), policies).state === "DEGRADED");
  check("every source broken → FAILED", deriveSources(sources({ ERROR: 2 }, 2), policies).state === "FAILED");
}

console.log("jobs");
{
  check("nothing recorded → UNKNOWN", deriveJobs({ healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 11 }, null, now).state === "UNKNOWN");
  check("healthy + never-ran → HEALTHY with the count in the headline", (() => { const d = deriveJobs({ healthy: 1, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 10 }, null, now); return d.state === "HEALTHY" && /10 never ran/.test(d.headline); })());
  check("overdue → STALE", deriveJobs({ healthy: 3, running: 0, overdue: 1, failing: 0, dead: 0, neverRan: 0 }, null, now).state === "STALE");
  check("failing → FAILED", deriveJobs({ healthy: 3, running: 0, overdue: 1, failing: 1, dead: 0, neverRan: 0 }, null, now).state === "FAILED");
  check("dead → FAILED", deriveJobs({ healthy: 3, running: 0, overdue: 0, failing: 0, dead: 1, neverRan: 0 }, null, now).state === "FAILED");
  check("next slot 'not derivable' when null", deriveJobs({ healthy: 1, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 }, null, now).facts.some((f) => f.label === "Next slot" && f.value === "not derivable"));
}

console.log("ai / brief / plaid");
{
  // OPERATIONALIZATION P0 — failures are facts, so AI is a REAL health domain now.
  const noF = { failed: 0, timeouts: 0, rateLimited: 0, quota: 0 };
  const ai = deriveAi({ invocations: 15, usd: 0.48, unpricedTokens: 0, cacheShare: 0.52, windowLabel: "last 24 h", failures: noF });
  check("AI returned-only → HEALTHY, activity + cost in the headline", ai.state === "HEALTHY" && /15 invocations/.test(ai.headline) && /\$0\.48/.test(ai.headline) && !/unknown/i.test(ai.headline), ai.headline);
  const none = deriveAi({ invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: noF });
  check("AI with nothing recorded → UNKNOWN and says so", none.state === "UNKNOWN" && /No AI invocations/.test(none.headline));
  check("some hard failures beside returns → DEGRADED",
    deriveAi({ invocations: 10, usd: 0.1, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { ...noF, failed: 2 } }).state === "DEGRADED");
  check("failures and nothing returned → FAILED",
    deriveAi({ invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { ...noF, timeouts: 1 } }).state === "FAILED");
  const quota = deriveAi({ invocations: 30, usd: 1, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { ...noF, quota: 1 } });
  check("ANY quota refusal → FAILED even beside returns, and the headline names the cause", quota.state === "FAILED" && /QUOTA/.test(quota.headline) && /out of credit/.test(quota.headline), quota.headline);
  check("retried rate limits beside returns → still HEALTHY (noise, not breakage)",
    deriveAi({ invocations: 5, usd: 0.1, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { ...noF, rateLimited: 3 } }).state === "HEALTHY");
  check("rate limits and nothing returned → DEGRADED",
    deriveAi({ invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { ...noF, rateLimited: 3 } }).state === "DEGRADED");
  check("facts carry Failed / Quota refusals / Rate-limited", ["Failed", "Quota refusals", "Rate-limited"].every((l) => quota.facts.some((f) => f.label === l)));
  check("brief quiet window → UNKNOWN, not failure", deriveBrief({ windowLabel: "w", generated: 0, failed: 0, inProgress: 0, versionStale: 0, usd: null, uncorrelatedGenerations: 0 }).state === "UNKNOWN");
  check("brief generated → HEALTHY", deriveBrief({ windowLabel: "w", generated: 2, failed: 0, inProgress: 0, versionStale: 1, usd: 0.01, uncorrelatedGenerations: 0 }).state === "HEALTHY");
  check("brief failed only → FAILED", deriveBrief({ windowLabel: "w", generated: 0, failed: 1, inProgress: 0, versionStale: 0, usd: null, uncorrelatedGenerations: 0 }).state === "FAILED");
  check("brief mixed → DEGRADED", deriveBrief({ windowLabel: "w", generated: 1, failed: 1, inProgress: 0, versionStale: 0, usd: null, uncorrelatedGenerations: 0 }).state === "DEGRADED");
  const plaid = derivePlaid({ billableItems: 4, byStatus: { ACTIVE: 3, NEEDS_REAUTH: 1 }, currentCycle: { transactions: 4, investments: 2, usd: 1.9, agree: true, label: "current" }, priceConfigured: true });
  check("plaid reconnect → DEGRADED, cost in the headline", plaid.state === "DEGRADED" && /\$1\.90/.test(plaid.headline), plaid.headline);
  const noPrice = derivePlaid({ billableItems: 4, byStatus: { ACTIVE: 4 }, currentCycle: { transactions: 4, investments: 0, usd: null, agree: true, label: "current" }, priceConfigured: false });
  check("no price authority → 'cost authority not configured', never $0", /cost authority not configured/.test(noPrice.headline) && !/\$0/.test(noPrice.headline));
  check("no billable items → UNKNOWN", derivePlaid({ billableItems: 0, byStatus: {}, currentCycle: { transactions: 0, investments: 0, usd: null, agree: true, label: "current" }, priceConfigured: true }).state === "UNKNOWN");
}

console.log("buildOverview");
{
  const inputs: OverviewInputs = {
    pipeline: pipeline({ executions: 2, byStatus: { SUCCEEDED: 2 } }), pipelineWindowLabel: "w",
    sources: sources({ HEALTHY: 2, STALE: 1 }, 3),
    jobs: { healthy: 1, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 10 },
    ai: { invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { failed: 0, timeouts: 0, rateLimited: 0, quota: 0 } },
    brief: { windowLabel: "w", generated: 0, failed: 0, inProgress: 0, versionStale: 0, usd: null, uncorrelatedGenerations: 0 },
    plaid: { billableItems: 1, byStatus: { ACTIVE: 1 }, currentCycle: { transactions: 1, investments: 0, usd: 0.3, agree: true, label: "current" }, priceConfigured: true },
    policies,
  };
  const o = buildOverview(inputs, null, now);
  check("six domains, in cockpit order", o.domains.map((d) => d.key).join(",") === "pipeline,sources,jobs,brief,ai,plaid");
  check("worst = STALE (UNKNOWN domains do not outrank a real verdict)", o.worst === "STALE", o.worst);
  check("policy strip carries cadence and origin", o.policies.bank === "24h" && o.policies.wallet === "6h" && o.policies.bankOrigin === "DEFAULT");
  const allUnknown = buildOverview({ ...inputs, pipeline: pipeline({}), sources: sources({}, 0), jobs: { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 11 }, plaid: { ...inputs.plaid, billableItems: 0 } }, null, now);
  check("everything unknown → worst UNKNOWN, never HEALTHY", allUnknown.worst === "UNKNOWN");
  check("every domain names a workspace and an authority", o.domains.every((d) => d.workspace.startsWith("platform-") && d.basis.length > 0));
}

console.log("UX-P1 · figures (server-chosen, one per domain)");
{
  const p = derivePipeline(pipeline({ executions: 5, byStatus: { SUCCEEDED: 4, FAILED: 1 } }), "since yesterday", now);
  check("pipeline figure is 'n of m failed'", p.figure.value === "1 of 5 failed" && /5 executions/.test(p.figure.qualifier), JSON.stringify(p.figure));
  check("unknown pipeline figure says none recorded, never 0 of 0", derivePipeline(pipeline({}), "w", now).figure.value === "none recorded");
  check("sources figure leads with the count that matters", deriveSources(sources({ HEALTHY: 2, STALE: 2 }, 4), policies).figure.value === "2 stale"
    && deriveSources(sources({ HEALTHY: 1, NEEDS_REAUTH: 1, STALE: 1 }, 3), policies).figure.value === "1 need attention");
  const j = deriveJobs({ healthy: 1, running: 0, overdue: 0, failing: 1, dead: 0, neverRan: 10 }, null, now);
  check("jobs figure '1 failing' with never-ran in the qualifier", j.figure.value === "1 failing" && /10 never ran/.test(j.figure.qualifier), JSON.stringify(j.figure));
  check("brief figure 'n generated'", deriveBrief({ windowLabel: "last 24 h", generated: 1, failed: 0, inProgress: 0, versionStale: 0, usd: 0.01, uncorrelatedGenerations: 0 }).figure.value === "1 generated");
  check("ai figure 'n failed'", deriveAi({ invocations: 3, usd: 0.02, unpricedTokens: 0, cacheShare: null, windowLabel: "w", failures: { failed: 0, timeouts: 0, rateLimited: 0, quota: 0 } }).figure.value === "0 failed");
  check("plaid figure 'n billable Items'", derivePlaid({ billableItems: 12, byStatus: { ACTIVE: 12 }, currentCycle: { transactions: 12, investments: 0, usd: 3.6, agree: true, label: "c" }, priceConfigured: true }).figure.value === "12 billable Items");
}

console.log("UX-P1 · posture (firing NOW, never the delivery history)");
{
  const latest = (firing: boolean, severity: "critical" | "warning" | null = "critical") => ({
    evaluatedAtISO: now.toISOString(), deliveryStatus: "sent" as const,
    counts: { evaluated: 2, live: 2, enabled: 2, firing: firing ? 1 : 0, delivered: 0, suppressed: 0 },
    rules: [
      { id: "job-failing", kind: "job-failing" as const, enabled: true, live: true, firing, breaches: firing ? 1 : 0, severity: firing ? severity : null },
      { id: "resource-stale", kind: "resource-stale" as const, enabled: true, live: true, firing: false, breaches: 0, severity: null },
    ],
  });
  check("quiet latest run → Quiet (ok), 0 of 2 firing", deriveAlertsPosture({ latest: latest(false), rulesRegistered: 2 }).word === "Quiet" && deriveAlertsPosture({ latest: latest(false), rulesRegistered: 2 }).count === "0 of 2 firing");
  check("critical firing → bad tone, worded", deriveAlertsPosture({ latest: latest(true), rulesRegistered: 2 }).tone === "bad" && /Firing/.test(deriveAlertsPosture({ latest: latest(true), rulesRegistered: 2 }).word));
  check("warning firing → warn tone", deriveAlertsPosture({ latest: latest(true, "warning"), rulesRegistered: 2 }).tone === "warn");
  check("never evaluated → Unknown (muted), never Quiet", deriveAlertsPosture({ latest: null, rulesRegistered: 2 }).word === "Unknown" && deriveAlertsPosture({ latest: null, rulesRegistered: 2 }).tone === "muted");
  check("loader failed → Unavailable, muted, 'could not be asked'", deriveAlertsPosture(null).state === "unavailable" && deriveAlertsPosture(null).tone === "muted");

  const inputs: PostureInputs = {
    alerts: { latest: latest(false), rulesRegistered: 2 },
    providers: { checkedAt: now, counts: { OPERATIONAL: 1, DEGRADED: 0, STALE: 0, FAILING: 1, UNKNOWN: 0 }, providers: [
      { key: "PLAID", label: "Plaid", kind: "BANKING", trust: "OPERATIONAL", availability: 1, lastSuccessAt: null, lastFailureAt: null, latencyMs: null, quota: null, remainingQuota: null, coverage: null, coverageUnit: null, freshness: { state: "fresh", asOf: null, ageDays: null, source: "none", detail: "" }, syncFailures: 0, errorRate: null, callsToday: null, calls30d: null, notes: [] },
      { key: "OXR", label: "OXR", kind: "FX", trust: "FAILING", availability: 0, lastSuccessAt: null, lastFailureAt: null, latencyMs: null, quota: null, remainingQuota: null, coverage: null, coverageUnit: null, freshness: { state: "stale", asOf: null, ageDays: null, source: "none", detail: "" }, syncFailures: 3, errorRate: 1, callsToday: null, calls30d: null, notes: [] },
    ] },
    freshness: { checkedAt: now, allFresh: false, resources: [
      { resource: "fx", label: "FX", newestObservedDate: "2026-09-10", ageHours: 100, ageDays: 4, expectedCadenceHours: 24, cadenceLabel: "daily", staleAfterHours: 48, healthState: "stale", completeness: null, lastSuccessfulRefresh: null, lastAttemptedRefresh: null, lastAttemptStatus: null, trust: { level: "medium", caveats: [] } },
      { resource: "prices", label: "Prices", newestObservedDate: null, ageHours: null, ageDays: null, expectedCadenceHours: 24, cadenceLabel: "daily", staleAfterHours: 48, healthState: "empty", completeness: null, lastSuccessfulRefresh: null, lastAttemptedRefresh: null, lastAttemptStatus: null, trust: { level: "unknown", caveats: ["no price vendor configured"] } },
    ] },
    configuration: { nodeEnv: "test", deploymentEnv: "development", ok: true, counts: { pass: 3, warn: 1, fail: 0 }, keys: [],
      openAi: { keyConfigured: false, keyKind: "unknown", projectPin: { state: "unpinned", projectId: null }, expectedEnvironment: { state: "unset", expected: null, actual: "development" }, refused: false } },
  };
  const chips = derivePosture(inputs);
  check("four chips in order Alerts · Providers · Freshness · Configuration", chips.map((c) => c.key).join(",") === "alerts,providers,freshness,configuration");
  check("providers: worst-wins trust word, count of operational", chips[1].word === "Failing" && chips[1].count === "1 of 2 operational" && chips[1].tone === "bad");
  check("freshness: a known-blocked empty is not red; stale leads", chips[2].word === "Stale" && chips[2].tone === "warn" && /1 of 2 not fresh · 1 blocked/.test(chips[2].count), chips[2].count);
  check("configuration: warn", chips[3].word === "Warning" && /1 of 4 warning/.test(chips[3].count));
  check("every chip names a platform workspace and a basis", chips.every((c) => c.workspace.startsWith("platform-") && c.basis.length > 10));
  const allDown = derivePosture({ alerts: null, providers: null, freshness: null, configuration: null });
  check("every loader failing → four Unavailable chips, none ok", allDown.every((c) => c.state === "unavailable" && c.tone === "muted"));
  check("empty registries → Unknown, never Fresh/Operational", derivePosture({ ...inputs, providers: { ...inputs.providers!, providers: [] }, freshness: { ...inputs.freshness!, resources: [] } }).slice(1, 3).every((c) => c.word === "Unknown"));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");

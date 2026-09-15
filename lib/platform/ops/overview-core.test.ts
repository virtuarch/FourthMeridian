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

import { buildOverview, derivePipeline, deriveSources, deriveJobs, deriveAi, deriveBrief, derivePlaid, type OverviewInputs } from "./overview-core";
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
  return { total, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0, ...counts }, unhealthy: [] };
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
  const ai = deriveAi({ invocations: 15, usd: 0.48, unpricedTokens: 0, cacheShare: 0.52, windowLabel: "last 24 h" });
  check("AI health is UNKNOWN by construction, activity still reported", ai.state === "UNKNOWN" && /15 invocations/.test(ai.headline) && /\$0\.48/.test(ai.headline), ai.headline);
  check("AI with nothing recorded says so", /No AI invocations/.test(deriveAi({ invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w" }).headline));
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
    ai: { invocations: 0, usd: null, unpricedTokens: 0, cacheShare: null, windowLabel: "w" },
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

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");

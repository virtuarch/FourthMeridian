/**
 * lib/platform/refresh/pipeline-status.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The pipeline status fold and its authority:
 *   · counts by status / kind / network are exact over the window;
 *   · "last succeeded" per kind comes from the lookup beyond the window and is
 *     null when no success was ever recorded — never "now", never the window's
 *     newest row;
 *   · open executions use the ONE open-execution rule (RUNNING or never
 *     completed);
 *   · latest failures are newest-first and bounded;
 *   · the authority reads the window through the single loader and carries
 *     the same envelope as every other projection.
 */

import { buildPipelineStatus } from "./projections-core";
import { getPipelineStatus, type RefreshProjectionReaders } from "./projections";
import type { ExecutionFact } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (iso: string) => new Date(iso);

function exec(over: Partial<ExecutionFact>): ExecutionFact {
  return {
    id: "e", runId: "r", plaidItemId: null, sourceKind: "WALLET", sourceRef: "acct-1", network: "BTC",
    trigger: "MANUAL", profile: "WALLET_SYNC", startedAt: D("2026-09-15T16:35:00.000Z"),
    completedAt: D("2026-09-15T16:35:11.600Z"), durationMs: 11_600, overallStatus: "FAILED",
    parentJobRunId: null, errorSummary: "This operation was aborted", deploymentSha: null,
    admissionReason: null, failureStage: "price", failureCategory: "PROVIDER_TIMEOUT", outcome: null,
    ...over,
  };
}

const rows: ExecutionFact[] = [
  exec({ id: "btc-fail", startedAt: D("2026-09-15T16:35:00.000Z") }),
  exec({ id: "btc-ok", overallStatus: "SUCCEEDED", failureStage: null, failureCategory: null, outcome: "NO_CHANGE", startedAt: D("2026-09-15T10:00:00.000Z"), errorSummary: null }),
  exec({ id: "eth-ok", network: "ETH", sourceRef: "acct-2", overallStatus: "SUCCEEDED", failureStage: null, failureCategory: null, outcome: "NO_CHANGE", startedAt: D("2026-09-15T12:00:00.000Z"), errorSummary: null }),
  exec({ id: "plaid-partial", sourceKind: "PLAID_ITEM", plaidItemId: "item-1", sourceRef: null, network: null, profile: "FULL_REFRESH", trigger: "CRON", overallStatus: "PARTIAL", failureStage: "HOLDINGS", failureCategory: "PROVIDER_ERROR", startedAt: D("2026-09-15T06:00:00.000Z") }),
  exec({ id: "plaid-running", sourceKind: "PLAID_ITEM", plaidItemId: "item-2", sourceRef: null, network: null, overallStatus: "RUNNING", completedAt: null, durationMs: null, failureStage: null, failureCategory: null, errorSummary: null, startedAt: D("2026-09-15T16:40:00.000Z") }),
];

async function main(): Promise<void> {
console.log("buildPipelineStatus · counts");
{
  const s = buildPipelineStatus(rows, { WALLET: rows[1], PLAID_ITEM: null });
  check("executions counted", s.executions === 5);
  check("byStatus exact", s.byStatus.FAILED === 1 && s.byStatus.SUCCEEDED === 2 && s.byStatus.PARTIAL === 1 && s.byStatus.RUNNING === 1);
  const wallet = s.kinds.find((k) => k.kind === "WALLET")!;
  const plaid = s.kinds.find((k) => k.kind === "PLAID_ITEM")!;
  check("WALLET kind rollup", wallet.total === 3 && wallet.succeeded === 2 && wallet.failed === 1 && wallet.running === 0);
  check("PLAID_ITEM kind rollup", plaid.total === 2 && plaid.partial === 1 && plaid.running === 1);
  check("last succeeded comes from the lookup, not the window's newest row",
    wallet.lastSucceededAt === "2026-09-15T10:00:00.000Z");
  check("a kind with no recorded success reports null, never now", plaid.lastSucceededAt === null);
  const btc = s.networks.find((n) => n.network === "BTC")!;
  const eth = s.networks.find((n) => n.network === "ETH")!;
  check("BTC network: 2 runs, 1 failed, last status FAILED", btc.total === 2 && btc.failed === 1 && btc.lastStatus === "FAILED");
  check("ETH network: 1 run, 0 failed, last status SUCCEEDED", eth.total === 1 && eth.failed === 0 && eth.lastStatus === "SUCCEEDED");
  check("Plaid executions carry no network and appear in no network rollup", s.networks.length === 2);
  check("open executions by the one rule", s.openExecutions === 1);
  check("latest failures newest-first, PARTIAL included",
    s.latestFailures.map((f) => f.id).join(",") === "btc-fail,plaid-partial");
  check("latest failures bounded", buildPipelineStatus(rows, {}, 1).latestFailures.length === 1);
}

console.log("buildPipelineStatus · empty window");
{
  const s = buildPipelineStatus([], { WALLET: rows[1], PLAID_ITEM: null });
  check("no executions → zero counts, no networks", s.executions === 0 && s.networks.length === 0 && s.openExecutions === 0);
  check("…but the kinds still report their last success", s.kinds.find((k) => k.kind === "WALLET")?.lastSucceededAt === "2026-09-15T10:00:00.000Z");
}

console.log("getPipelineStatus · authority");
{
  const asked: string[] = [];
  const readers: RefreshProjectionReaders = {
    now: D("2026-09-15T17:00:00.000Z"),
    executions: async (from, to) => { asked.push(`window:${from.toISOString()}..${to.toISOString()}`); return rows; },
    endpoints: async () => [], providerCalls: async () => [], coverage: async () => [],
    execution: async () => null,
    lastSucceededByKind: async (kind) => { asked.push(`last:${kind}`); return kind === "WALLET" ? rows[1] : null; },
  };
  const r = await getPipelineStatus({ from: "2026-09-14", to: "2026-09-15" }, { readers });
  check("carries the projection envelope", r.window.from === "2026-09-14" && r.window.to === "2026-09-15" && typeof r.deterministic === "boolean");
  check("an open execution makes the window non-deterministic", r.deterministic === false && r.indeterminacyReason !== null);
  check("asks the lookup once per source kind", asked.filter((a) => a.startsWith("last:")).sort().join(",") === "last:PLAID_ITEM,last:WALLET");
  check("reads the window exactly once", asked.filter((a) => a.startsWith("window:")).length === 1);
  check("fold result present", r.executions === 5 && r.kinds.length === 2);
  const empty = await getPipelineStatus({ plaidItemIds: [] }, { readers });
  check("an explicitly empty scope reads nothing and never widens", empty.executions === 0);
}

}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}, (err) => { console.error(err); process.exit(1); });

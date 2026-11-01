/**
 * lib/platform/refresh/recovery-core.test.ts  (PB-7 — recovered, not failed)
 *
 * REPRODUCTION FIRST: the Production sequence of 2026-11-01, as a fixture.
 *   20:39:00Z  exchange-token after() opens a RECONNECT execution (A)
 *   20:44:00Z  the function is killed at 300 s — A gets no completion write
 *   20:50:30Z  resume-stale-imports opens a RESUME / IMPORT_RECOVERY execution (B)
 *   20:55:00Z  B SUCCEEDED (1,388 transactions, wealth regen ran)
 *   21:00:00Z  the reaper finalises A as FAILED / "stale: …" (completedAt 21:00 — LATER than B's)
 *
 * Before PB-7 every reader below read A as a failure. Each check pins the
 * reader-side fix, and a control pins that a NON-reaped failure, or a reaped
 * row with no later success, still reads as failed (the rule is narrow).
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/refresh/recovery-core.test.ts
 */

import { findRecoveredExecutions, recoveredExecutionIds, unrecoveredFailed } from "./recovery-core";
import { buildPipelineStatus, buildRefreshDailySeries, buildRefreshSummary } from "./projections-core";
import { queryRefreshExecutions, getRefreshExecutionDetail, type ExecutionQueryReaders } from "./execution-query";
import { EXECUTION_ROW_KEYS, projectExecutionRow } from "./execution-query-core";
import { STALE_EXECUTION_ERROR_SUMMARY, isReapedStaleExecution } from "@/lib/plaid/stale-execution.core";
import { STALE_EXECUTION_ERROR_SUMMARY as DOOR_SUMMARY } from "@/lib/plaid/refresh-ledger";
import { buildUserImpact } from "@/lib/platform/ops/attention-core";
import { derivePipeline } from "@/lib/platform/ops/overview-core";
import { projectIncidents } from "@/lib/platform/customer/customer-core";
import type { ExecutionFact, PipelineStatus } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (iso: string) => new Date(iso);
const ITEM = "item-wells-fargo";

function exec(over: Partial<ExecutionFact>): ExecutionFact {
  return {
    id: "e", runId: "r", plaidItemId: ITEM, sourceKind: "PLAID_ITEM", sourceRef: null, network: null,
    trigger: "RECONNECT", profile: "RECONNECT", startedAt: D("2026-11-01T20:39:00Z"), completedAt: null, durationMs: null,
    overallStatus: "RUNNING", parentJobRunId: null, errorSummary: null, deploymentSha: null, admissionReason: null,
    failureStage: null, failureCategory: null, outcome: null, ...over,
  };
}

/** A — killed at 20:44, reaped at 21:00 (exactly the reaper's write: FAILED, completedAt now, summary, UNKNOWN, durationMs null). */
export const REAPED_A = exec({
  id: "exec-A", runId: "run-A", overallStatus: "FAILED", completedAt: D("2026-11-01T21:00:00Z"),
  errorSummary: STALE_EXECUTION_ERROR_SUMMARY, failureCategory: "UNKNOWN",
});
/** B — resume-stale-imports drove the import to completion. */
export const RESUMED_B = exec({
  id: "exec-B", runId: "run-B", trigger: "RESUME", profile: "IMPORT_RECOVERY", startedAt: D("2026-11-01T20:50:30Z"),
  completedAt: D("2026-11-01T20:55:00Z"), durationMs: 270_000, overallStatus: "SUCCEEDED", outcome: "UPDATED",
});
const SEQUENCE = [REAPED_A, RESUMED_B];

async function main() {
  console.log("vocabulary");
  check("the door re-exports the pure literal unchanged", DOOR_SUMMARY === STALE_EXECUTION_ERROR_SUMMARY);
  check("A is recognised as reaped", isReapedStaleExecution(REAPED_A));
  check("a FAILED row with its own error is not 'reaped'", !isReapedStaleExecution({ overallStatus: "FAILED", errorSummary: "ITEM_LOGIN_REQUIRED" }));

  console.log("the rule (20:44 → 20:55 → 21:00)");
  {
    const m = findRecoveredExecutions(SEQUENCE);
    check("A is recovered by B", m.get("exec-A") === "exec-B");
    check("B itself is not 'recovered'", !m.has("exec-B"));
    check("order-independent", findRecoveredExecutions([...SEQUENCE].reverse()).get("exec-A") === "exec-B");
    check("start order, not completion order (A completed AFTER B)", REAPED_A.completedAt! > RESUMED_B.completedAt!);
    check("control: reaped with NO later success stays failed", !recoveredExecutionIds([REAPED_A]).has("exec-A"));
    check("control: a success BEFORE the reaped row does not supersede it",
      !recoveredExecutionIds([REAPED_A, { ...RESUMED_B, startedAt: D("2026-11-01T20:30:00Z") }]).has("exec-A"));
    check("control: a later success for ANOTHER item does not supersede it",
      !recoveredExecutionIds([REAPED_A, { ...RESUMED_B, plaidItemId: "other" }]).has("exec-A"));
    check("control: a later PARTIAL does not supersede it",
      !recoveredExecutionIds([REAPED_A, { ...RESUMED_B, overallStatus: "PARTIAL" }]).has("exec-A"));
    const real = { ...REAPED_A, id: "exec-real", errorSummary: "provider timeout", failureCategory: "PROVIDER_TIMEOUT" };
    check("control: a NON-reaped failure followed by success still reads failed", !recoveredExecutionIds([real, RESUMED_B]).has("exec-real"));
    check("wallets key by sourceRef", recoveredExecutionIds([
      { ...REAPED_A, plaidItemId: null, sourceKind: "WALLET", sourceRef: "acct-eth" },
      { ...RESUMED_B, plaidItemId: null, sourceKind: "WALLET", sourceRef: "acct-eth" },
    ]).has("exec-A"));
  }

  console.log("projections (Pipeline KPIs, pipeline domain, latest failures, day series)");
  {
    const summary = buildRefreshSummary(SEQUENCE, []);
    check("summary keeps the ledger tally (FAILED 1) and names 1 recovered", summary.byStatus.FAILED === 1 && summary.recovered === 1);
    check("the 'failed' figure is 0", unrecoveredFailed(summary) === 0);
    const pipe = buildPipelineStatus(SEQUENCE, { PLAID_ITEM: RESUMED_B });
    check("latestFailures excludes the recovered row", pipe.latestFailures.length === 0 && pipe.recovered === 1);
    const envelope = { window: { from: "2026-11-01", to: "2026-11-01" }, deterministic: true, indeterminacyReason: null, checkedAt: "2026-11-02T00:00:00Z" };
    const domain = derivePipeline({ ...envelope, ...pipe } as PipelineStatus, "24 h", D("2026-11-02T00:00:00Z"));
    check("pipeline domain is HEALTHY, not DEGRADED", domain.state === "HEALTHY", domain.state);
    check("the domain names the recovery as its own fact", domain.facts.some((f) => f.label === "Recovered" && f.value === "1"));
    check("control: without B the domain is FAILED", derivePipeline({ ...envelope, ...buildPipelineStatus([REAPED_A], {}) } as PipelineStatus, "24 h", D("2026-11-02T00:00:00Z")).state === "FAILED");
    const daily = buildRefreshDailySeries(SEQUENCE, { from: "2026-11-01", to: "2026-11-01" }, { todayISO: "2026-11-02", capHit: false });
    check("the day bucket names 1 recovered; failed bars show 0", daily.days[0].recovered === 1 && unrecoveredFailed(daily.days[0]) === 0);
  }

  console.log("execution query seam (Refresh tables, timeline panel, Ops user impact)");
  {
    let laterCalls = 0;
    const readers: ExecutionQueryReaders = {
      executions: async () => [RESUMED_B, REAPED_A].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
      execution: async (id) => (id === "exec-A" ? REAPED_A : RESUMED_B),
      lastSucceeded: async () => null,
      laterSucceeded: async (s) => { laterCalls++; return SEQUENCE.filter((e) => e.overallStatus === "SUCCEEDED" && e.startedAt > s.after && s.plaidItemIds.includes(e.plaidItemId ?? "")); },
      endpoints: async () => [], providerCalls: async () => [], coverage: async () => [],
    };
    const page = await queryRefreshExecutions({ audience: "operator", filter: { overallStatus: ["FAILED", "PARTIAL"] } }, { readers: { ...readers, executions: async () => [REAPED_A] } });
    check("a FAILED-only page still resolves the successor (one extra read)", page.rows[0].recoveredByExecutionId === "exec-B" && laterCalls === 1);
    const detail = await getRefreshExecutionDetail({ audience: "operator", executionId: "exec-A" }, { readers });
    check("the execution panel's row says recovered", detail?.execution.recoveredByExecutionId === "exec-B");
    const quiet = await queryRefreshExecutions({ audience: "operator" }, { readers: { ...readers, executions: async () => [RESUMED_B] } });
    check("a page with no reaped row makes no successor read", laterCalls === 2 && quiet.rows[0].recoveredByExecutionId === null);
    const legacy = await queryRefreshExecutions({ audience: "operator" }, { readers: { ...readers, laterSucceeded: undefined, executions: async () => [REAPED_A] } });
    check("a reader without laterSucceeded resolves none (reads as written)", legacy.rows[0].recoveredByExecutionId === null);
    check("the DTO key pin includes recoveredByExecutionId", EXECUTION_ROW_KEYS.includes("recoveredByExecutionId")
      && Object.keys(projectExecutionRow(REAPED_A, "support")).sort().join(",") === [...EXECUTION_ROW_KEYS].sort().join(","));

    const impact = buildUserImpact({ refresh: { rows: page.rows, more: false }, ai: null, brief: null, connections: null }, D("2026-11-01T22:00:00Z"));
    check("Platform Ops user impact lists NO refresh failure for the recovered import", impact.counts["refresh-failed"] === 0 && impact.rows.length === 0);
    check("…and says why in a note", impact.floors.some((f) => /recovered/.test(f)));
    const before = buildUserImpact({ refresh: { rows: [projectExecutionRow(REAPED_A, "operator")], more: false }, ai: null, brief: null, connections: null }, D("2026-11-01T22:00:00Z"));
    check("control (the pre-PB-7 reading): an unresolved reaped row IS a refresh failure", before.counts["refresh-failed"] === 1);
  }

  console.log("Customer Success profile — recent refreshes");
  {
    const view = projectIncidents([], [RESUMED_B, REAPED_A].map((e) => ({ ...e })), []);
    const a = view.recentExecutions.find((e) => e.id === "exec-A");
    check("A is marked recovered (the widget shows 'reconnect recovered')", a?.recovered === true && a.overallStatus === "FAILED");
    check("errorSummary is never projected", !JSON.stringify(view).includes("stale:"));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });

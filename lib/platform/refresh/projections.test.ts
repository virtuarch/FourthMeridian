/**
 * lib/platform/refresh/projections.test.ts  (OPS-2B)
 *
 * Behaviour guards for the refresh projection layer. Standalone tsx (house
 * pattern). Every assertion runs over INJECTED in-memory facts — no database.
 *
 * What this pins:
 *   • DETERMINISM — a closed window with no open execution is deterministic; an
 *     open window, or a closed window still holding a RUNNING execution, is not.
 *   • REPRODUCIBILITY — the pure cores are byte-stable, and stay byte-stable when
 *     the input rows are shuffled (ordering is part of the contract).
 *   • CORRECTNESS — the reductions compute what they claim.
 *   • ISOLATION — no projection re-derives an upstream authority, and none
 *     publishes a retry rate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCoverageSummary,
  buildExecutionTimeline,
  buildFailureSummary,
  buildProviderOperationSummary,
  buildRefreshSummary,
  countOpenExecutions,
} from "@/lib/platform/refresh/projections-core";
import {
  getCoverageSummary,
  getExecutionTimeline,
  getFailureSummary,
  getProviderOperationSummary,
  getRefreshSummary,
  type RefreshProjectionReaders,
} from "@/lib/platform/refresh/projections";
import type {
  CoverageFact,
  EndpointFact,
  ExecutionFact,
  ProviderCallFact,
} from "@/lib/platform/refresh/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err);
  process.exit(1);
});

// ── Fixtures ────────────────────────────────────────────────────────────────────

const D = (iso: string) => new Date(iso);

function execution(over: Partial<ExecutionFact> = {}): ExecutionFact {
  return {
    id: "exec1",
    runId: "run1",
    plaidItemId: "item1",
    trigger: "CRON",
    profile: "FULL_REFRESH",
    startedAt: D("2026-07-10T06:00:00.000Z"),
    completedAt: D("2026-07-10T06:00:12.000Z"),
    durationMs: 12_000,
    overallStatus: "SUCCEEDED",
    parentJobRunId: null,
    errorSummary: null,
    ...over,
  };
}
function endpoint(over: Partial<EndpointFact> = {}): EndpointFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    stageKind: "PROVIDER",
    status: "SUCCEEDED",
    skipReason: null,
    startedAt: D("2026-07-10T06:00:01.000Z"),
    completedAt: D("2026-07-10T06:00:03.000Z"),
    durationMs: 2_000,
    recordsRead: 4,
    recordsWritten: 4,
    recordsChanged: 2,
    freshnessAdvanced: true,
    errorSummary: null,
    ...over,
  };
}
function call(over: Partial<ProviderCallFact> = {}): ProviderCallFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    provider: "PLAID",
    operation: "accountsGet",
    status: "SUCCEEDED",
    attempt: 1,
    startedAt: D("2026-07-10T06:00:01.000Z"),
    completedAt: D("2026-07-10T06:00:02.000Z"),
    durationMs: 1_000,
    providerRequestId: "req-1",
    httpStatus: 200,
    errorCode: null,
    errorCategory: null,
    ...over,
  };
}
function coverage(over: Partial<CoverageFact> = {}): CoverageFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    financialAccountId: "acct1",
    status: "COVERED",
    reason: null,
    freshnessAdvanced: true,
    createdAt: D("2026-07-10T06:00:03.000Z"),
    ...over,
  };
}

function fakeReaders(over: Partial<RefreshProjectionReaders> = {}): RefreshProjectionReaders {
  return {
    now: D("2026-07-20T00:00:00.000Z"),
    executions: async () => [execution()],
    endpoints: async () => [endpoint()],
    providerCalls: async () => [call()],
    coverage: async () => [coverage()],
    execution: async () => execution(),
    ...over,
  };
}

async function main() {
  // ── determinism ────────────────────────────────────────────────────────────────
  console.log("determinism · window + open executions");
  {
    const closed = await getRefreshSummary(
      { from: "2026-07-01", to: "2026-07-10" },
      { readers: fakeReaders() },
    );
    check("closed window with no open execution IS deterministic", closed.deterministic === true);
    check("deterministic result states no indeterminacy reason", closed.indeterminacyReason === null);

    const open = await getRefreshSummary(
      { from: "2026-07-01", to: "2026-07-20" },
      { readers: fakeReaders() },
    );
    check("open window (ends today) is NOT deterministic", open.deterministic === false);
    check("open window explains why", (open.indeterminacyReason ?? "").includes("open"));

    // The subtle one: a CLOSED window that still holds a RUNNING execution.
    const running = await getRefreshSummary(
      { from: "2026-07-01", to: "2026-07-10" },
      {
        readers: fakeReaders({
          executions: async () => [
            execution(),
            execution({ id: "exec2", overallStatus: "RUNNING", completedAt: null, durationMs: null }),
          ],
        }),
      },
    );
    check("CLOSED window holding a RUNNING execution is NOT deterministic", running.deterministic === false);
    check("open-execution indeterminacy names RUNNING", (running.indeterminacyReason ?? "").includes("RUNNING"));
    check("open executions are surfaced, not hidden", running.openExecutions === 1);

    check(
      "an execution with a null completedAt counts as open even if status lies",
      countOpenExecutions([execution({ completedAt: null, overallStatus: "SUCCEEDED" })]) === 1,
    );
  }

  // ── determinism agrees ACROSS projections (OPS-2B′ Part VII regression) ────────
  console.log("determinism · every projection agrees on the same window");
  {
    // The row that exposed the original drift: a completion write that never
    // landed (completedAt null) while the status still reads SUCCEEDED. The
    // inline `overallStatus === "RUNNING"` rule called this closed; the canonical
    // countOpenExecutions rule calls it open. All four must now agree.
    const halfWritten = execution({ id: "half", completedAt: null, durationMs: null, overallStatus: "SUCCEEDED" });
    const readers = fakeReaders({ executions: async () => [execution(), halfWritten] });
    const args = { from: "2026-07-01", to: "2026-07-10" };

    const [refresh, provider, cov, fail] = await Promise.all([
      getRefreshSummary(args, { readers }),
      getProviderOperationSummary(args, { readers }),
      getCoverageSummary(args, { readers }),
      getFailureSummary(args, { readers }),
    ]);

    const verdicts = [refresh, provider, cov, fail].map((r) => r.deterministic);
    check("all four projections return the SAME determinism verdict", new Set(verdicts).size === 1, `verdicts: ${verdicts.join()}`);
    check("...and that verdict is `false` (an unfinalized row is open)", verdicts.every((v) => v === false));

    const reasons = [refresh, provider, cov, fail].map((r) => r.indeterminacyReason);
    check("all four give the SAME indeterminacy reason", new Set(reasons).size === 1);

    const windows = [refresh, provider, cov, fail].map((r) => `${r.window.from}..${r.window.to}`);
    check("all four resolve the same window", new Set(windows).size === 1);
  }

  // ── reproducibility ────────────────────────────────────────────────────────────
  console.log("reproducibility · byte-stable, order-independent");
  {
    const execs = [
      execution({ id: "a", startedAt: D("2026-07-10T06:00:00.000Z"), durationMs: 1000 }),
      execution({ id: "b", startedAt: D("2026-07-10T07:00:00.000Z"), durationMs: 3000, trigger: "MANUAL" }),
      execution({ id: "c", startedAt: D("2026-07-10T08:00:00.000Z"), durationMs: 2000, overallStatus: "PARTIAL" }),
    ];
    const stages = [
      endpoint({ refreshExecutionId: "a", endpoint: "TRANSACTIONS" }),
      endpoint({ refreshExecutionId: "b", endpoint: "BALANCES" }),
      endpoint({ refreshExecutionId: "c", endpoint: "HOLDINGS", status: "FAILED", errorSummary: "boom" }),
    ];

    const once = JSON.stringify(buildRefreshSummary(execs, stages));
    const twice = JSON.stringify(buildRefreshSummary(execs, stages));
    check("same facts ⇒ byte-identical output", once === twice);

    const shuffled = JSON.stringify(
      buildRefreshSummary([...execs].reverse(), [...stages].reverse()),
    );
    check("SHUFFLED input ⇒ byte-identical output (ordering is contractual)", once === shuffled);

    check("the pure core emits no checkedAt (a read property, not a value)", !once.includes("checkedAt"));
    check("the pure core emits no deterministic flag", !once.includes("deterministic"));

    const cov = [
      coverage({ financialAccountId: "z", endpoint: "HOLDINGS" }),
      coverage({ financialAccountId: "a", endpoint: "BALANCES" }),
    ];
    check(
      "coverage summary is order-independent",
      JSON.stringify(buildCoverageSummary(cov)) === JSON.stringify(buildCoverageSummary([...cov].reverse())),
    );

    const calls = [call({ operation: "transactionsSync", attempt: 2 }), call({ operation: "accountsGet" })];
    check(
      "provider summary is order-independent",
      JSON.stringify(buildProviderOperationSummary(calls)) ===
        JSON.stringify(buildProviderOperationSummary([...calls].reverse())),
    );
  }

  // ── refresh summary correctness ────────────────────────────────────────────────
  console.log("correctness · refresh summary");
  {
    const summary = buildRefreshSummary(
      [
        execution({ id: "a", durationMs: 1000 }),
        execution({ id: "b", durationMs: 3000, overallStatus: "PARTIAL", trigger: "MANUAL" }),
        execution({ id: "c", durationMs: null, overallStatus: "RUNNING", completedAt: null, parentJobRunId: "job1" }),
      ],
      [
        endpoint({ refreshExecutionId: "a", endpoint: "BALANCES", recordsChanged: 2 }),
        endpoint({ refreshExecutionId: "b", endpoint: "BALANCES", recordsChanged: 3, freshnessAdvanced: false }),
        endpoint({ refreshExecutionId: "b", endpoint: "HOLDINGS", status: "SKIPPED", skipReason: "NOT_APPLICABLE", recordsChanged: null, durationMs: null }),
      ],
    );
    check("counts executions", summary.executions === 3);
    check("byStatus reads overallStatus verbatim", summary.byStatus.SUCCEEDED === 1 && summary.byStatus.PARTIAL === 1 && summary.byStatus.RUNNING === 1);
    check("byTrigger tallies triggers", summary.byTrigger.CRON === 2 && summary.byTrigger.MANUAL === 1);
    check("withParentJob counts correlated executions", summary.withParentJob === 1);
    check("mean duration ignores null durations", summary.meanDurationMs === 2000);
    check("max duration ignores null durations", summary.maxDurationMs === 3000);

    const balances = summary.endpoints.find((e) => e.endpoint === "BALANCES")!;
    check("endpoint roll-up sums recordsChanged", balances.recordsChanged === 5);
    check("freshnessAdvanced counts the FLAG, never success", balances.freshnessAdvanced === 1);

    const holdings = summary.endpoints.find((e) => e.endpoint === "HOLDINGS")!;
    check("skip reasons use the ledger vocabulary", holdings.skipReasons.NOT_APPLICABLE === 1);
    check("a stage with no recordsChanged reports null, never 0", holdings.recordsChanged === null);
    check("endpoints are sorted by name", summary.endpoints.map((e) => e.endpoint).join() === "BALANCES,HOLDINGS");
  }

  // ── provider operation summary ─────────────────────────────────────────────────
  console.log("correctness · provider operation summary");
  {
    const summary = buildProviderOperationSummary([
      call({ operation: "transactionsSync", attempt: 1, durationMs: 100 }),
      call({ operation: "transactionsSync", attempt: 2, durationMs: 300 }),
      call({ operation: "transactionsSync", attempt: 3, durationMs: 200 }),
      call({ operation: "investmentsHoldingsGet", attempt: 1, status: "FAILED", errorCode: "PRODUCT_NOT_READY", durationMs: 50 }),
      call({ operation: "investmentsHoldingsGet", attempt: 2, durationMs: 150 }),
    ]);

    const sync = summary.operations.find((o) => o.operation === "transactionsSync")!;
    check("counts attempt rows", sync.calls === 3);
    check("attempt distribution is ascending", sync.attemptDistribution.map((a) => a.attempt).join() === "1,2,3");
    check("mean latency is derived", sync.meanDurationMs === 200);
    check("max latency is derived", sync.maxDurationMs === 300);
    check("transactionsSync is flagged pagination-confounded", sync.paginationConfounded === true);
    check("confounded semantics are stated honestly", sync.attemptSemantics.includes("pagination"));

    const holdings = summary.operations.find((o) => o.operation === "investmentsHoldingsGet")!;
    check("a stage can retry: attempt 1 FAILED + attempt 2 SUCCEEDED are separate rows", holdings.failed === 1 && holdings.succeeded === 1);
    check("non-paginated operation is NOT flagged confounded", holdings.paginationConfounded === false);
    check("operations sorted by (provider, operation)", summary.operations.map((o) => o.operation).join() === "investmentsHoldingsGet,transactionsSync");

    // DOCTRINE: no retry rate anywhere in the output.
    const json = JSON.stringify(summary);
    check("publishes NO retry rate / retry count", !/retryRate|retryCount|"retries"/i.test(json));
  }

  // ── coverage summary ───────────────────────────────────────────────────────────
  console.log("correctness · coverage summary");
  {
    const summary = buildCoverageSummary([
      coverage({ financialAccountId: "acct1", createdAt: D("2026-07-10T06:00:00.000Z") }),
      coverage({ financialAccountId: "acct1", createdAt: D("2026-07-11T06:00:00.000Z"), status: "SKIPPED", reason: "ACCOUNT_DISCONNECTED", freshnessAdvanced: false }),
      coverage({ financialAccountId: "acct2", endpoint: "HOLDINGS", status: "SKIPPED", reason: "NO_HOLDINGS", freshnessAdvanced: false }),
    ]);

    const balances = summary.endpoints.find((e) => e.endpoint === "BALANCES")!;
    check("covered/skipped are counted separately", balances.covered === 1 && balances.skipped === 1);
    check("skip reasons use the DF-2E vocabulary", balances.reasons.ACCOUNT_DISCONNECTED === 1);
    check("freshnessAdvanced counted from the flag", balances.freshnessAdvanced === 1);
    check("distinct accounts across the window", summary.distinctAccounts === 2);

    const acct1 = summary.accounts.find((a) => a.financialAccountId === "acct1")!;
    check("lastCoveredAt is the newest COVERED row", acct1.lastCoveredAt === "2026-07-10T06:00:00.000Z");
    check("lastReason comes from the NEWEST row", acct1.lastReason === "ACCOUNT_DISCONNECTED");
    check(
      "a later SKIPPED does not erase the earlier freshness advance",
      acct1.lastFreshnessAdvancedAt === "2026-07-10T06:00:00.000Z",
    );

    // Doctrine: absence is not uncovered and not fresh.
    check("an account never evaluated simply does not appear", summary.accounts.every((a) => a.financialAccountId !== "acct-never"));
    check("empty facts ⇒ unknown tier, never a fabricated healthy state", buildCoverageSummary([]).tier === "unknown");
  }

  // ── failure summary ────────────────────────────────────────────────────────────
  console.log("correctness · failure summary");
  {
    const summary = buildFailureSummary(
      [execution({ id: "a" }), execution({ id: "b", overallStatus: "FAILED", errorSummary: "internal detail" }), execution({ id: "c", overallStatus: "PARTIAL" })],
      [endpoint({ status: "FAILED", endpoint: "HOLDINGS", errorSummary: "stage blew up" })],
      [
        call({ status: "FAILED", errorCode: "RATE_LIMIT", errorCategory: "RATE_LIMIT_EXCEEDED" }),
        call({ status: "FAILED", errorCode: "RATE_LIMIT", errorCategory: "RATE_LIMIT_EXCEEDED" }),
        call({ status: "RATE_LIMITED", errorCode: "TOO_MANY", errorCategory: "RATE_LIMIT_EXCEEDED" }),
      ],
    );
    check("RUNNING is not a failure", summary.totalFailedExecutions === 2);
    check("failed stages counted by endpoint", summary.endpoints[0].endpoint === "HOLDINGS" && summary.endpoints[0].failed === 1);
    check("provider failures grouped by Plaid's OWN code", summary.providerCalls.some((p) => p.errorCode === "RATE_LIMIT" && p.count === 2));
    check("RATE_LIMITED counts as a failed attempt", summary.totalFailedCalls === 3);

    // DOCTRINE: free-text error bodies are never grouped or echoed.
    const json = JSON.stringify(summary);
    check("free-text errorSummary is NEVER echoed into the summary", !json.includes("internal detail") && !json.includes("stage blew up"));
  }

  // ── execution timeline ─────────────────────────────────────────────────────────
  console.log("correctness · execution timeline");
  {
    const built = buildExecutionTimeline(
      execution(),
      [endpoint()],
      [call()],
      [coverage()],
    );
    check("opens with execution-started", built.entries[0].kind === "execution-started");
    check("closes with execution-completed", built.entries[built.entries.length - 1].kind === "execution-completed");
    check("entries are chronological", built.entries.every((e, i, all) => i === 0 || all[i - 1].at <= e.at));
    check("a closed execution yields a complete timeline", built.complete === true);
    check("a complete timeline is observed", built.tier === "observed");

    const open = buildExecutionTimeline(
      execution({ overallStatus: "RUNNING", completedAt: null, durationMs: null }),
      [endpoint()],
      [],
      [],
    );
    check("a RUNNING execution is INCOMPLETE, never asserted whole", open.complete === false);
    check("an incomplete timeline is tiered `incomplete`, never observed", open.tier === "incomplete");

    // Ties must not reorder — same instant across three kinds.
    const at = D("2026-07-10T06:00:05.000Z");
    const tied = () =>
      JSON.stringify(
        buildExecutionTimeline(
          execution(),
          [endpoint({ startedAt: at, completedAt: at })],
          [call({ startedAt: at, completedAt: at })],
          [coverage({ createdAt: at })],
        ).entries,
      );
    check("equal timestamps sort deterministically", tied() === tied());

    // Free text must never leak into a timeline entry.
    const withError = buildExecutionTimeline(
      execution({ overallStatus: "FAILED", errorSummary: "secret internal message" }),
      [endpoint({ status: "FAILED", errorSummary: "another secret" })],
      [],
      [],
    );
    check(
      "timeline never echoes free-text error bodies",
      !JSON.stringify(withError.entries).includes("secret"),
    );
  }

  // ── scope fails closed ─────────────────────────────────────────────────────────
  console.log("scope · fails closed");
  {
    // A fake that would HAPPILY return rows if consulted — so this proves the
    // guard lives in the authority, not in a reader's internal short-circuit.
    let executionsHit = false;
    let childHit = false;
    const loud = fakeReaders({
      executions: async () => { executionsHit = true; return [execution()]; },
      endpoints: async () => { childHit = true; return [endpoint()]; },
      providerCalls: async () => { childHit = true; return [call()]; },
      coverage: async () => { childHit = true; return [coverage()]; },
    });
    const args = { from: "2026-07-01", to: "2026-07-10", plaidItemIds: [] as string[] };

    const cov = await getCoverageSummary(args, { readers: loud });
    check("an explicitly EMPTY scope reads nothing (never widens)", cov.distinctAccounts === 0);
    check("an empty scope does not hit the executions reader", executionsHit === false);
    check("an empty scope does not hit the CHILD readers either", childHit === false);

    // Every projection must fail closed the same way.
    const [refresh, provider, fail] = await Promise.all([
      getRefreshSummary(args, { readers: loud }),
      getProviderOperationSummary(args, { readers: loud }),
      getFailureSummary(args, { readers: loud }),
    ]);
    check("refresh summary is empty under an empty scope", refresh.executions === 0 && refresh.endpoints.length === 0);
    check("provider summary is empty under an empty scope", provider.totalCalls === 0);
    check("failure summary is empty under an empty scope", fail.totalFailedCalls === 0 && fail.totalFailedStages === 0);
    check("no reader was consulted by ANY projection under an empty scope", executionsHit === false && childHit === false);
  }

  // ── the authority composes the core, and adds only the envelope ────────────────
  console.log("composition · authority adds envelope only");
  {
    const readers = fakeReaders();
    const viaAuthority = await getProviderOperationSummary({ from: "2026-07-01", to: "2026-07-10" }, { readers });
    const viaCore = buildProviderOperationSummary([call()]);
    check("authority output contains the core output verbatim", JSON.stringify(viaAuthority.operations) === JSON.stringify(viaCore.operations));
    check("authority stamps checkedAt", typeof viaAuthority.checkedAt === "string" && viaAuthority.checkedAt.length > 0);

    const failure = await getFailureSummary({ from: "2026-07-01", to: "2026-07-10" }, { readers });
    check("failure summary reaches the ledger through injected readers", failure.window.to === "2026-07-10");

    const timeline = await getExecutionTimeline("exec1", { readers });
    check("timeline resolves by id", timeline?.executionId === "exec1");

    const missing = await getExecutionTimeline("nope", { readers: fakeReaders({ execution: async () => null }) });
    check("a missing execution returns null, never a fabricated shell", missing === null);
  }

  // ── doctrine: isolation from upstream authorities ──────────────────────────────
  console.log("doctrine · projection isolation");
  {
    const strip = (p: string) =>
      readFileSync(path.join(process.cwd(), p), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const core = strip("lib/platform/refresh/projections-core.ts");
    const authority = strip("lib/platform/refresh/projections.ts");

    check("the pure core imports no db", !/@\/lib\/db/.test(core));
    check("the pure core imports no server-only", !/server-only/.test(core));
    check("the pure core reads no clock", !/Date\.now\(\)|new Date\(\)/.test(core));
    check("the core does not re-derive overallStatus", !/deriveOverallStatus/.test(core));
    check(
      "no projection recomputes execution status from stage rows",
      !/status\s*===\s*["']FAILED["'][\s\S]{0,80}\?\s*["']PARTIAL["']/.test(core),
    );
    check("NO caching is introduced", !/unstable_cache|revalidate|new Map\(\)\s*\/\/\s*cache|lruCache/i.test(authority));
    check("no stored health state — the authority performs no writes", !/\.create\(|\.update\(|\.upsert\(|createMany|deleteMany/.test(authority));
    check("the authority uses explicit select allowlists, never a bare findMany", !/findMany\(\{\s*\}\)/.test(authority));
  }

  if (failures > 0) {
    console.error(`\nprojections.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nprojections.test: all passed.");
}

void main();

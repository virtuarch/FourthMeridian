/**
 * lib/platform/operations/execute.test.ts  (OPS-5 S4)
 *
 * Pure guards for the manual-operation execution seam. Standalone tsx script:
 * npx tsx lib/platform/operations/execute.test.ts — exits 0/1. NO LIVE DB:
 * runJob and the in-flight JobRun read are injected via OperationDeps fakes.
 *
 * Covers: dry-run PLANS without touching runJob or a body · run-now routes
 * through runJob(trigger:"manual") with the target jobName · the JobRun-backed
 * in-flight LOCK refuses a mutating run while a run is live, and RELEASES once
 * the running row goes stale · a body throw is surfaced as outcome "failed"
 * (never rethrown — runJob already ledgered it) · isInFlight staleness.
 */

import { STALE_RUNNING_HOURS } from "@/lib/jobs/health";
import {
  runOperation,
  isInFlight,
  type OperationDeps,
  type RunningJobRow,
} from "@/lib/platform/operations/execute";
import { getOperationCommand } from "@/lib/platform/operations/registry";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-07-16T12:00:00Z");

interface RunJobCall { name: string; trigger: string }

/** A fake OperationDeps recording runJob calls and serving a fixed running row. */
function makeDeps(opts: {
  running?: RunningJobRow | null;
  runResult?: unknown;
  runThrows?: boolean;
} = {}): { deps: OperationDeps; calls: RunJobCall[] } {
  const calls: RunJobCall[] = [];
  const deps: OperationDeps = {
    runJob: async <T>(name: string, fn: () => Promise<T>, o: { trigger: string }): Promise<T> => {
      calls.push({ name, trigger: o.trigger });
      if (opts.runThrows) throw new Error("body blew up");
      // Never actually invoke fn — the body reaches real providers/DB.
      return opts.runResult as T;
    },
    findRunningJobRun: async () => opts.running ?? null,
    now: () => NOW,
  };
  return { deps, calls };
}

const runNow = getOperationCommand("run-now:fetch-fx-rates");
const dryRun = getOperationCommand("dry-run:fetch-fx-rates");
if (!runNow || !dryRun) { console.error("  ✗ fixtures missing from registry"); process.exit(1); }

async function main(): Promise<void> {
console.log("execute: isInFlight staleness");
{
  check("null row is never in flight", isInFlight(null, NOW) === false);
  check("a fresh running row is in flight", isInFlight({ startedAt: new Date(NOW.getTime() - 60_000) }, NOW) === true);
  check(
    "a running row older than STALE_RUNNING_HOURS is not in flight",
    isInFlight({ startedAt: new Date(NOW.getTime() - (STALE_RUNNING_HOURS + 1) * HOUR_MS) }, NOW) === false,
  );
}

console.log("execute: dry-run plans, never executes");
{
  const { deps, calls } = makeDeps({ running: null });
  const res = await runOperation(dryRun!, deps);
  check("outcome is planned", res.outcome === "planned");
  check("runJob was NOT called", calls.length === 0);
  check("plan writes no JobRun", res.plan?.writesJobRun === false);
  check("plan reports not-in-flight when no running row", res.plan?.inFlight === false);
}

console.log("execute: dry-run reflects an in-flight run");
{
  const { deps } = makeDeps({ running: { startedAt: new Date(NOW.getTime() - 30_000) } });
  const res = await runOperation(dryRun!, deps);
  check("plan reports in-flight", res.plan?.inFlight === true);
}

console.log("execute: run-now routes through runJob(trigger:manual)");
{
  const { deps, calls } = makeDeps({ running: null, runResult: { inserted: 3 } });
  const res = await runOperation(runNow!, deps);
  check("outcome is executed", res.outcome === "executed");
  check("runJob called exactly once", calls.length === 1);
  check("runJob called with the target jobName", calls[0]?.name === "fetch-fx-rates");
  check('runJob called with trigger "manual"', calls[0]?.trigger === "manual");
  check("summary passthrough from the job result", (res.summary as { inserted?: number })?.inserted === 3);
}

console.log("execute: in-flight lock refuses a mutating run");
{
  const { deps, calls } = makeDeps({ running: { startedAt: new Date(NOW.getTime() - 10_000) } });
  const res = await runOperation(runNow!, deps);
  check("outcome is in-flight", res.outcome === "in-flight");
  check("runJob was NOT called (locked)", calls.length === 0);
}

console.log("execute: stale running row does NOT lock");
{
  const { deps, calls } = makeDeps({
    running: { startedAt: new Date(NOW.getTime() - (STALE_RUNNING_HOURS + 1) * HOUR_MS) },
    runResult: { ok: true },
  });
  const res = await runOperation(runNow!, deps);
  check("stale lock is ignored — run proceeds", res.outcome === "executed");
  check("runJob was called", calls.length === 1);
}

console.log("execute: a body throw becomes outcome failed, not a rethrow");
{
  const { deps, calls } = makeDeps({ running: null, runThrows: true });
  let rethrew = false;
  let res;
  try { res = await runOperation(runNow!, deps); } catch { rethrew = true; }
  check("runOperation did not rethrow", rethrew === false);
  check("outcome is failed", res?.outcome === "failed");
  check("error message surfaced", (res?.error ?? "").includes("body blew up"));
  check("runJob was attempted", calls.length === 1);
}
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\nexecute.test: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nexecute.test: all checks passed");
  })
  .catch((err) => {
    console.error("execute.test: unexpected error", err);
    process.exit(1);
  });

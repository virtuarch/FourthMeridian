/**
 * jobs/wake-deadline-anchor.test.ts  (B7 Production finding, 2026-11-01)
 *
 * The wake-aware deadlines (sync-crypto's revaluation, the SOL backfill worker)
 * must anchor to the enclosing FUNCTION's start — the dispatch wake's instant,
 * carried by runJob as currentBudgetStartedAtMs — and never to "the earliest
 * JobRun of any job in the last 300 s". On Production resume-stale-imports (its
 * own cron, its own function, :x0:49 / :x5:49) always had a run ~280 s before
 * the :x0:29 / :x5:29 dispatch (08:10:49 → 08:15:29), so the deadline fell
 * before sync-crypto began and every pass deferred the whole revaluation
 * ("skipped: wake time") after stamping.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/wake-deadline-anchor.test.ts
 */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { runJob, currentBudgetStartedAtMs, type JobRunWriteClient } from "@/lib/jobs/run";
import { revaluationDeadlineMs } from "@/jobs/sync-crypto";
import { WAKE_SAFE_MS } from "@/jobs/sol-history-backfill";
import { revalueHoldersAfterPriceGaps, type RevaluationDeps, type HolderRevaluation } from "@/lib/prices/price-gap";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ""); }
}

/** An owed holder whose rebuild advances a simulated wall clock (1 s per call), from `startMs`. */
function revaluationWorld(startMs: number) {
  let t = startMs; const regens: string[] = [];
  const marks: string[] = [];
  const deps: RevaluationDeps = {
    acquireGaps: async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }),
    owed: async (ids) => ids.map((id): HolderRevaluation => ({ accountId: id, windowFromISO: "2026-10-20", valuedFromISO: "2026-10-20", evidenceKey: `revaluation:v2:${id}:k` })),
    revaluedAlready: async (ks) => new Set(ks.filter((k) => marks.includes(k))),
    markRevalued: async (k) => { marks.push(k); },
    attemptsOf: async () => new Map(),
    markAttempt: async () => {},
    markUnavailable: async () => 1,
    regenerate: async (id, from, to) => { regens.push(`${id}:${from}..${to}`); t += 1_000; },
    now: () => t,
  };
  return { deps, regens };
}

/** A JobRun ledger that also holds an earlier resume-stale-imports row inside the old 300 s window. */
function ledger(foreignStartedAt: Date): JobRunWriteClient {
  const rows: Array<{ id: string; jobName: string; startedAt: Date }> = [{ id: "r_resume", jobName: "resume-stale-imports", startedAt: foreignStartedAt }];
  return {
    jobRun: {
      create: async ({ data }: { data: { jobName: string; startedAt: Date } }) => { const id = `r_${rows.length}`; rows.push({ id, jobName: data.jobName, startedAt: data.startedAt }); return { id }; },
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as JobRunWriteClient;
}

async function main() {
  console.log("wake deadline anchor");

  const wake = new Date("2026-11-01T08:15:29.000Z");
  const resume = new Date("2026-11-01T08:10:49.000Z"); // 280 s before the wake
  const seen = await runJob("sync-crypto", async () => currentBudgetStartedAtMs(), { budgetStartedAt: wake, client: ledger(resume) });
  check("inside a dispatched job the budget start is the WAKE's instant, not another cron's earlier JobRun", seen === wake.getTime(), seen);

  const jobStart = wake.getTime() + 12_000;
  const deadline = revaluationDeadlineMs(jobStart, seen);
  check("the revaluation deadline is WAKE_SAFE_MS after the wake — after the job began, with time left", deadline === wake.getTime() + WAKE_SAFE_MS && deadline > jobStart + 200_000, deadline - jobStart);
  check("the regression shape: anchored to the resume run, the deadline fell BEFORE the job began", revaluationDeadlineMs(jobStart, resume.getTime()) < jobStart);
  check("outside a dispatch (manual / script) the run's own start anchors it", revaluationDeadlineMs(jobStart, null) === jobStart + WAKE_SAFE_MS);
  check("outside any runJob body there is no ambient budget start", currentBudgetStartedAtMs() === null);

  // BEHAVIOURAL — the real revaluation, driven with each anchor's deadline from the job's real start.
  const fixed = revaluationWorld(jobStart);
  const rFixed = await revalueHoldersAfterPriceGaps({ accountIds: ["btc", "sol"], deps: fixed.deps, todayISO: "2026-11-01", deadlineMs: deadline });
  check("an earlier unrelated JobRun no longer blocks it: both owed holders are rebuilt, nothing skipped for wake time",
    rFixed.revalued === 2 && rFixed.deferred === 0 && !rFixed.skippedForTime && fixed.regens.length > 0, JSON.stringify(rFixed));
  const regressed = revaluationWorld(jobStart);
  const rOld = await revalueHoldersAfterPriceGaps({ accountIds: ["btc", "sol"], deps: regressed.deps, todayISO: "2026-11-01", deadlineMs: resume.getTime() + WAKE_SAFE_MS });
  check("…whereas the old anchor (the resume run) reproduces Production: owed 2, revalued 0, skipped: wake time",
    rOld.owed === 2 && rOld.revalued === 0 && rOld.skippedForTime && regressed.regens.length === 0, JSON.stringify(rOld));

  const SYNC = readFileSync("jobs/sync-crypto.ts", "utf8");
  const SOL = readFileSync("jobs/sol-history-backfill.ts", "utf8");
  const ledgerWake = /jobRun\.findFirst\(\{\s*where:\s*\{\s*startedAt:\s*\{\s*gte:/;
  check("sync-crypto no longer infers the wake from the JobRun ledger", !ledgerWake.test(SYNC));
  check("sync-crypto's revaluation deadline reads currentBudgetStartedAtMs()", /deadlineMs: revaluationDeadlineMs\(runStartedAt\.getTime\(\), currentBudgetStartedAtMs\(\)\)/.test(SYNC));
  check("the SOL backfill worker no longer infers the wake from the JobRun ledger", !ledgerWake.test(SOL));
  check("the SOL backfill worker's wakeStartedAt returns currentBudgetStartedAtMs()", /async wakeStartedAt\(\) \{\s*const \{ currentBudgetStartedAtMs \} = await import\("@\/lib\/jobs\/run"\);\s*return currentBudgetStartedAtMs\(\);/.test(SOL));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });

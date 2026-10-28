/**
 * lib/crypto/sol-backfill-worker.test.ts
 *
 * The background Solana backfill worker: fair order, bounded budgets, a global
 * rate limit, a daily request cap, off by default — and the cost model the
 * owner asked for before throughput is enabled.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { workerConfig, orderCandidates, createRateLimiter, estimateBackfill, requestsForHistory } from "@/lib/crypto/sol-backfill-worker.core";
import { emptyCheckpoint, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import { runSolHistoryBackfill, type SolRpcCall } from "@/lib/crypto/sol-history-backfill";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  console.log("configuration");
  {
    const d = workerConfig({});
    check("OFF unless SOL_BACKFILL_ENABLED=true", d.enabled === false && workerConfig({ SOL_BACKFILL_ENABLED: "true" }).enabled === true && workerConfig({ SOL_BACKFILL_ENABLED: "1" }).enabled === false);
    check("defaults: 120 s job, 60 s per wallet, 10 req/s, 100k requests/day", d.jobBudgetMs === 120_000 && d.walletBudgetMs === 60_000 && d.maxRequestsPerSecond === 10 && d.dailyRequestCap === 100_000);
    const bad = workerConfig({ SOL_BACKFILL_MAX_RPS: "100000", SOL_BACKFILL_JOB_BUDGET_MS: "999999", SOL_BACKFILL_DAILY_REQUEST_CAP: "-1" });
    check("out-of-bounds values fall back to the safe default, never 'unlimited'", bad.maxRequestsPerSecond === 10 && bad.jobBudgetMs === 120_000 && bad.dailyRequestCap === 100_000);
    check("the job budget can never exceed the dispatcher's 300 s invocation", workerConfig({ SOL_BACKFILL_JOB_BUDGET_MS: "290000" }).jobBudgetMs === 120_000);
  }

  console.log("fair scheduling");
  {
    const cp = (over: Partial<SolBackfillCheckpoint>): SolBackfillCheckpoint => ({ ...emptyCheckpoint("a", "x", "2026-10-01T00:00:00Z"), ...over });
    const row = (id: string, checkpoint: SolBackfillCheckpoint | null) => ({ accountId: id, connectionId: `c${id}`, cursor: null, address: "x", checkpoint });
    const ordered = orderCandidates([
      row("recent", cp({ licensedFromISO: "2025-01-01", licensedToISO: "2026-10-28", lastProgressAtISO: "2026-10-28T03:00:00Z", top: { signature: "t", slot: 1, blockTime: 1, dateISO: "2026-10-28", preLamports: "0", postLamports: "1" }, bottom: { signature: "b", slot: 1, blockTime: 1, dateISO: "2025-01-01", preLamports: "0", postLamports: "1" } })),
      row("new", null),
      row("stale", cp({ licensedFromISO: "2025-06-01", licensedToISO: "2026-10-28", lastProgressAtISO: "2026-10-27T00:00:00Z", top: { signature: "t", slot: 1, blockTime: 1, dateISO: "2026-10-28", preLamports: "0", postLamports: "1" }, bottom: { signature: "b", slot: 1, blockTime: 1, dateISO: "2025-06-01", preLamports: "0", postLamports: "1" } })),
      row("done", cp({ reachedBeginning: true, completedAtISO: "2026-10-28T00:00:00Z", licensedFromISO: "2020-01-01", licensedToISO: "2026-10-28" })),
      row("gap", cp({ licensedFromISO: "2024-01-01", licensedToISO: "2026-10-28", gap: { side: "HISTORY", provenSignature: "p", neighbourSignature: "n", expectedLamports: "1", statedLamports: "2", detectedAtISO: "2026-10-28T00:00:00Z" } })),
    ], Date.parse("2026-10-28T04:00:00Z"));
    check("never-started first, then least recently progressed; complete and gapped wallets skipped",
      ordered.map((r) => r.accountId).join(",") === "new,stale,recent", ordered.map((r) => r.accountId).join(","));
  }

  console.log("rate limiting");
  {
    let t = 0; const slept: number[] = [];
    const take = createRateLimiter(10, () => t, async (ms) => { slept.push(ms); t += ms; });
    for (let i = 0; i < 5; i++) await take();
    check("a 10 req/s bucket spaces five requests 100 ms apart", slept.join(",") === "100,100,100,100", slept.join(","));
  }

  console.log("request budget and metering inside a run");
  {
    const OWNER = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
    const sigs = Array.from({ length: 3000 }, (_, i) => ({ signature: `s${i}`, slot: 3000 - i, blockTime: 1_700_000_000 + (3000 - i) * 600, err: null }));
    let bal = 0;
    const tx = new Map<string, unknown>();
    for (let i = sigs.length - 1; i >= 0; i--) {
      const pre = bal; bal += 1000;
      tx.set(sigs[i].signature, { slot: sigs[i].slot, blockTime: sigs[i].blockTime, transaction: { message: { accountKeys: [OWNER] } }, meta: { preBalances: [pre], postBalances: [bal] } });
    }
    const call: SolRpcCall = async (m, p) => m === "getSignaturesForAddress"
      ? (() => { const before = (p[1] as { before?: string }).before; const s = before ? sigs.findIndex((x) => x.signature === before) + 1 : 0; return sigs.slice(s, s + 1000); })()
      : tx.get(p[0] as string);
    const meter: Record<string, number> = {};
    const store = { cursor: null as string | null, async readCursor() { return this.cursor; },
      async anchor() { return { dateISO: "2026-10-28", lamports: BigInt(bal) }; },
      async commit(c: { nextCursor: string }) { this.cursor = c.nextCursor; } };
    let t = 0;
    const o = await runSolHistoryBackfill({ accountId: "a", address: OWNER, store }, { call, meter, requestBudget: 1_200, now: () => ++t, budgetMs: 1e12 });
    const sent = Object.values(meter).reduce((a, b) => a + b, 0);
    check("every request is metered by method", (meter.getTransaction ?? 0) > 0 && (meter.getSignaturesForAddress ?? 0) > 0);
    check("the run stops at its request allowance (+ ≤ one in-flight batch) and commits what it proved",
      o.stoppedBecause === "BUDGET" && sent <= 1_200 + 4 && o.progressed, `${o.stoppedBecause} ${sent}`);
  }

  console.log("cost and throughput model (Alchemy PAYG, 40 CU/call, $0.52/M CU)");
  {
    const cfg = workerConfig({});
    for (const n of [10_000, 50_000, 100_000]) {
      const e = estimateBackfill(n, cfg);
      console.log(`    ${n.toLocaleString().padStart(7)} tx: ${e.requests.total.toLocaleString()} requests, ${(e.units / 1e6).toFixed(2)}M CU ≈ $${e.usd.toFixed(2)}; ${e.runs} runs; ~${e.elapsedHoursAlone.toFixed(1)} h at 10 req/s alone`);
    }
    const r = requestsForHistory(100_000);
    check("100k transactions ≈ 100,200 requests (one per tx + one page per 1,000 + ≤1 deferred re-fetch per page)", r.total === 100_200, String(r.total));
    const e = estimateBackfill(100_000, cfg);
    check("…≈ 4.0M CU ≈ $2.08 at pay-as-you-go", Math.abs(e.units - 4_008_000) < 1 && Math.abs(e.usd - 2.08) < 0.01, `${e.units} ${e.usd}`);
    check("the daily cap bounds spend: 100k requests/day ≈ 4M CU ≈ $2.08/day maximum", estimateBackfill(1e9, cfg).requestsPerDay === 100_000);
  }

  console.log("wiring");
  {
    const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
    const job = read("jobs/sol-history-backfill.ts");
    check("the job returns immediately when disabled", /if \(!cfg\.enabled\) return summary;/.test(job));
    check("each wallet runs under its sync lock and is released in finally (normal syncs never blocked)",
      /claimWalletSyncLock\(c\.connectionId, systemDb\)/.test(job) && /finally \{\s*await releaseWalletSyncLock\(c\.connectionId, systemDb\);/.test(job));
    check("the daily cap is summed from this job's own ledger", /systemDb\.jobRun\.findMany\(\{\s*where: \{ jobName: SOL_BACKFILL_JOB, startedAt: \{ gte: startOfUTCDay/.test(job));
    check("changed rows regenerate wealth history over the impacted window (no new snapshot writer)",
      /resolveHistoricalWorkWindow\(/.test(job) && /regenerateWealthHistoryForAccounts\(\[c\.accountId\]/.test(job) && !/snapshot\.(create|upsert)/i.test(job));
    check("self-continues by reporting deferred wallets", /summary\.deferred = candidates\.length - i/.test(job));
    const run = read("lib/crypto/sol-history-backfill.ts");
    check("a wallet SYNC runs the backfill briefly (15 s) so holdings stay responsive", /export const DEFAULT_RUN_BUDGET_MS = 15_000;/.test(run));
  }

  if (failures > 0) { console.error(`\nsol-backfill-worker: ${failures} failed.`); process.exit(1); }
  console.log("\nsol-backfill-worker: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });

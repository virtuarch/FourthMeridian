/**
 * lib/crypto/sol-backfill-worker.test.ts
 *
 * The background Solana backfill worker: fair order, bounded budgets, a global
 * rate limit, a daily request cap, off by default — and the cost model the
 * owner asked for before throughput is enabled.
 */

import { OPEN_BACKFILL_GATES } from "@/lib/test-support/billable-open";
import { readFileSync } from "node:fs";
import path from "node:path";
import { workerConfig, orderCandidates, createRateLimiter, estimateBackfill, requestsForHistory } from "@/lib/crypto/sol-backfill-worker.core";
import { emptyCheckpoint, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import { runSolHistoryBackfill, syncRunBudgetMs, type SolRpcCall, type SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import { solHistoryBackfill, solBackfillJobOutcome, WAKE_SAFE_MS, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import { serializeCheckpoint, parseCheckpoint } from "@/lib/crypto/sol-history-backfill.core";

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

  console.log("the job, end to end against fakes");
  {
    const ADDR = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
    const DAY = "2026-10-28";
    const mk = (id: string, over: Partial<SolBackfillCheckpoint> = {}) => serializeCheckpoint({ ...emptyCheckpoint(id, ADDR, `${DAY}T00:00:00Z`),
      top: { signature: "t", slot: 9, blockTime: 1, dateISO: DAY, preLamports: "0", postLamports: "1" },
      bottom: { signature: "b", slot: 1, blockTime: 1, dateISO: "2026-01-01", preLamports: "0", postLamports: "1" },
      licensedFromISO: "2026-01-01", licensedToISO: DAY, ...over });
    type SplP = { status: "COMPLETE" | "ALLOWANCE_EXHAUSTED" | "BUDGET_STOPPED"; reason: string | null; mintsSkipped: number };
    function world(cursors: Record<string, string | null>, o: { wake?: number | null; lockBusy?: string[]; regen?: boolean; workMs?: number; splPrices?: SplP | ((accountId: string) => SplP) } = {}) {
      let t = Date.parse(`${DAY}T10:00:00Z`);
      const locks = new Map<string, number>();
      const log: string[] = [];
      const store = (id: string): SolBackfillStore => ({
        async readCursor() { return cursors[id] ?? null; },
        async anchor() { return null; },
        async commit(c) { if (c.expectedCursor !== cursors[id]) throw new Error("cas"); cursors[id] = c.nextCursor; },
      });
      const deps: SolBackfillJobDeps = { ...OPEN_BACKFILL_GATES,
        now: () => t, sleep: async (ms) => { t += ms; },
        wakeStartedAt: async () => (o.wake === undefined ? null : o.wake === null ? null : t - o.wake),
        wallets: async () => Object.keys(cursors).map((id) => ({ accountId: id, connectionId: `c-${id}`, address: ADDR, cursor: cursors[id] })),
        claimLock: async (c, s) => { if (o.lockBusy?.includes(c) || locks.has(c)) return false; locks.set(c, s); return true; },
        renewLock: async (c, f, to) => { if (locks.get(c) !== f) return false; locks.set(c, to); return true; },
        releaseLock: async (c, s) => { if (locks.get(c) === s) locks.delete(c); else log.push(`release-refused:${c}`); },
        reconstruct: async ({ accountId }) => {
          t += o.workMs ?? 5_000; log.push(`run:${accountId}`);
          return { accountId, ok: true, derivedRowsWritten: 10, mode: "INCREMENTAL", impactedFromISO: "2025-12-01",
            ...(o.splPrices ? { tokens: { prices: typeof o.splPrices === "function" ? o.splPrices(accountId) : o.splPrices } as never } : {}),
            backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 10, impactedFromISO: "2025-12-01", signaturesProcessed: 100, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } };
        },
        store: async (id) => store(id),
        regenerationEnabled: () => o.regen ?? true,
        regenerate: async (id) => { t += 20_000; log.push(`regen:${id}`); },
      };
      return { deps, log, cursors, locks, at: () => t };
    }
    const cfg = { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }) };

    const off = await solHistoryBackfill({ config: { ...cfg, enabled: false }, deps: world({ a: null }).deps });
    check("disabled ⇒ returns at once, touches nothing (the rollback)", off.stoppedBecause === "DISABLED" && off.walletsRun === 0);

    const w1 = world({ a: null, b: mk("b", { lastProgressAtISO: `${DAY}T01:00:00Z` }), c: mk("c", { lastProgressAtISO: `${DAY}T00:30:00Z` }) });
    const s1 = await solHistoryBackfill({ config: cfg, deps: w1.deps });
    check("fair order: never started, then least recently progressed", w1.log.filter((x) => x.startsWith("run:")).join(",") === "run:a,run:c,run:b", w1.log.join(","));
    check("unfinished wallets self-continue (deferred > 0)", s1.deferred >= 3 && s1.stoppedBecause !== "DAILY_CAP", JSON.stringify({ d: s1.deferred, s: s1.stoppedBecause }));
    check("every lock taken is released (ownership-checked)", w1.locks.size === 0 && !w1.log.some((x) => x.startsWith("release-refused")));

    const w2 = world({ a: mk("a", { usage: { dayISO: DAY, requests: 99_990 } }), b: mk("b", { usage: { dayISO: DAY, requests: 20 } }) });
    const s2 = await solHistoryBackfill({ config: cfg, deps: w2.deps });
    check("the daily cap is the DURABLE usage across all wallets (worker + syncs): at the cap nothing runs", s2.stoppedBecause === "DAILY_CAP" && s2.dailyRequestsUsedBefore === 100_010 && !w2.log.some((x) => x.startsWith("run:")), JSON.stringify(s2));
    const w2b = world({ a: mk("a", { usage: { dayISO: "2026-10-27", requests: 99_990 } }) });
    check("…and yesterday's usage does not count today", (await solHistoryBackfill({ config: cfg, deps: w2b.deps })).dailyRequestsUsedBefore === 0);

    const w3 = world({ a: null, b: null }, { lockBusy: ["c-a"] });
    const s3 = await solHistoryBackfill({ config: cfg, deps: w3.deps });
    check("a wallet a sync is holding is skipped (never blocked) and counted as deferred", s3.walletsSkippedLocked === 1 && w3.log.includes("run:b") && !w3.log.includes("run:a"));

    const w4 = world({ a: mk("a") }, { wake: 200_000 });
    const s4 = await solHistoryBackfill({ config: cfg, deps: w4.deps });
    check("wake-aware: 200 s into a wake the job plans only to the wake's safe point", s4.budgetMs === WAKE_SAFE_MS - 200_000, String(s4.budgetMs));
    check("…too little left to regenerate ⇒ regeneration DEFERRED and marked pending in the checkpoint",
      s4.regenerationsDeferred === 1 && parseCheckpoint(w4.cursors.a, "a", ADDR)?.snapshotPendingFromISO === "2025-12-01", JSON.stringify(s4));
    const w5 = world({ a: w4.cursors.a });
    const s5 = await solHistoryBackfill({ config: cfg, deps: w5.deps });
    check("the next run regenerates the pending window FIRST and clears the marker",
      w5.log[0] === "regen:a" && s5.regenerated >= 1 && !parseCheckpoint(w5.cursors.a, "a", ADDR)?.snapshotPendingFromISO, w5.log.join(","));

    // Re-review F4 — a stopped token price run is the JOB's verdict (PARTIAL), not only a summary field.
    check("re-review F4: a run whose prices all completed reads outcome COMPLETE", s1.outcome === "COMPLETE" && (s1.partialReasons ?? []).length === 0, JSON.stringify(s1.outcome));
    const wp = world({ a: null }, { splPrices: { status: "BUDGET_STOPPED", reason: "CoinGecko token budget reached; remaining SPL mints not priced this run", mintsSkipped: 2 } });
    const sp = await solHistoryBackfill({ config: cfg, deps: wp.deps });
    check("re-review F4 (SPL): a budget-stopped SPL price run ⇒ job outcome PARTIAL, named, with the skipped count",
      sp.outcome === "PARTIAL" && sp.splPrices?.status === "BUDGET_STOPPED" && sp.splPrices.mintsSkipped === 2 && /^SPL_PRICES_BUDGET_STOPPED: CoinGecko token budget reached/.test(sp.partialReasons?.[0] ?? ""), JSON.stringify({ o: sp.outcome, r: sp.partialReasons, p: sp.splPrices }));
    // SPL first-time quote probe — a refused probe on one wallet and a budget stop on another: worst wins, counts add.
    const wmix = world({ a: null, b: null }, { splPrices: (id) => id === "a"
      ? { status: "BUDGET_STOPPED", reason: "CoinGecko token budget reached; remaining SPL mints not priced this run", mintsSkipped: 2 }
      : { status: "ALLOWANCE_EXHAUSTED", reason: "quote-probe allowance exhausted; never-priced SPL mint(s) left NOT_VALUED_YET for a later run", mintsSkipped: 1 } });
    const smix = await solHistoryBackfill({ config: cfg, deps: wmix.deps });
    check("SPL probe: across wallets the worst SPL price status wins (a later ALLOWANCE_EXHAUSTED never downgrades BUDGET_STOPPED); skipped counts add",
      smix.outcome === "PARTIAL" && smix.splPrices?.status === "BUDGET_STOPPED" && /budget/.test(smix.splPrices.reason ?? "") && smix.splPrices.mintsSkipped === 3 && smix.splPrices.wallets === 2,
      JSON.stringify(smix.splPrices));
    const wonly = world({ a: null }, { splPrices: { status: "ALLOWANCE_EXHAUSTED", reason: "quote-probe allowance exhausted; never-priced SPL mint(s) left NOT_VALUED_YET for a later run", mintsSkipped: 1 } });
    const sonly = await solHistoryBackfill({ config: cfg, deps: wonly.deps });
    check("SPL probe: an exhausted probe allowance alone ⇒ job outcome PARTIAL (SPL_PRICES_ALLOWANCE_EXHAUSTED)",
      sonly.outcome === "PARTIAL" && /^SPL_PRICES_ALLOWANCE_EXHAUSTED: quote-probe allowance/.test(sonly.partialReasons?.[0] ?? ""), JSON.stringify(sonly.partialReasons));
    const erc = (status: "COMPLETE" | "BUDGET_STOPPED" | "ALLOWANCE_EXHAUSTED" | "TOKEN_LIMIT") => solBackfillJobOutcome({ ethTokens: { prices: { tokensFetched: 0, inserted: 0, calls: 0, status, reason: status === "COMPLETE" ? null : "why", tokensSkipped: 1 } } as never });
    check("re-review F4 (ERC-20): every non-COMPLETE price status ⇒ job outcome PARTIAL; COMPLETE ⇒ COMPLETE",
      (["BUDGET_STOPPED", "ALLOWANCE_EXHAUSTED", "TOKEN_LIMIT"] as const).every((st) => erc(st).outcome === "PARTIAL" && erc(st).partialReasons[0] === `ERC20_PRICES_${st}: why`) && erc("COMPLETE").outcome === "COMPLETE");

    const w6 = world({ a: null }, { regen: false });
    const s6 = await solHistoryBackfill({ config: cfg, deps: w6.deps });
    check("with WEALTH_REGENERATION_ENABLED off, no regeneration runs (as sync-crypto)", !w6.log.some((x) => x.startsWith("regen")) && s6.regenerationsDeferred === 0);

    check("syncs run 15 s only while the worker is enabled (45 s otherwise)", syncRunBudgetMs({ SOL_BACKFILL_ENABLED: "true" }) === 15_000 && syncRunBudgetMs({}) === 45_000);
  }

  console.log("wiring");
  {
    const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
    const job = read("jobs/sol-history-backfill.ts");
    check("the job returns immediately when disabled", /if \(!cfg\.enabled\) return summary;/.test(job));
    check("each wallet runs under its sync lock, released in finally", /deps\.claimLock\(w\.connectionId, stamp\)/.test(job) && /finally \{\s*await deps\.releaseLock\(w\.connectionId, stamp\);/.test(job));
    check("the lock is released only while still ours", /syncLockedAt: new Date\(stampMs\) \}, data: \{ syncLockedAt: null \}/.test(job));
    check("changed rows regenerate wealth history over the impacted window (no new snapshot writer)",
      /resolveHistoricalWorkWindow\(/.test(job) && /regenerateWealthHistoryForAccounts\(\[accountId\]/.test(job) && !/snapshot\.(create|upsert)/i.test(job));
    check("one candidate per ACCOUNT, on the store's own link", /orderBy: \[\{ isCanonical: "desc" \}, \{ createdAt: "asc" \}\]/.test(job) && /seen\.has\(l\.financialAccountId\)/.test(job));
    const run = read("lib/crypto/sol-history-backfill.ts");
    check("a wallet SYNC runs the backfill briefly (15 s) while the worker is on", /export const DEFAULT_RUN_BUDGET_MS = 15_000;/.test(run) && /syncRunBudgetMs\(\)/.test(run));
  }

  if (failures > 0) { console.error(`\nsol-backfill-worker: ${failures} failed.`); process.exit(1); }
  console.log("\nsol-backfill-worker: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });

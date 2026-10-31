/**
 * jobs/history-worker-fairness.test.ts
 *
 * The background history worker (jobs/sol-history-backfill.ts), three defects
 * live-verified on Preview 2026-10-28:
 *
 *   1. FAIRNESS — a fixed SOL → BTC → ETH order with ETH taking the remainder
 *      starved Ethereum (its step needs 75 s) whenever SOL or BTC had backlog.
 *      Now: a persisted rotation + a phase never shorter than its chain's step.
 *   2. METERING — requests of a pass killed mid-flight were counted nowhere
 *      (meter flushed only at wallet end). Now flushed while the pass sends.
 *   3. PRICE GAPS — only planned inside a regeneration, so a COMPLETE wallet
 *      never had its gap acquired. Now: every run, across every holder.
 *
 * Deterministic fakes only — no database, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/history-worker-fairness.test.ts
 */

import { readFileSync } from "node:fs";
import { OPEN_BACKFILL_GATES } from "@/lib/test-support/billable-open";
import { solHistoryBackfill, solBackfillJobOutcome, WAKE_SAFE_MS, PRICE_GAP_RESERVE_MS, type SolBackfillJobDeps, type SolBackfillJobSummary } from "@/jobs/sol-history-backfill";
import { workerConfig } from "@/lib/crypto/sol-backfill-worker.core";
import { btcWorkerConfig } from "@/lib/crypto/btc-backfill-worker.core";
import { ethWorkerConfig, queuedCheckpoint, serializeCheckpoint as serializeEth } from "@/lib/crypto/eth-history-backfill.core";
import { erc20HistoryConfig } from "@/lib/crypto/erc20-history.core";
import { emptyCheckpoint as emptyBtc, serializeCheckpoint as serializeBtc } from "@/lib/crypto/btc-history-backfill.core";
import { emptyCheckpoint as emptySol, serializeCheckpoint as serializeSol, parseCheckpoint as parseSol, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import type { SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import { chainOrder, nextRotation, phaseDeadlineFor, HISTORY_CHAINS, type HistoryChain } from "@/lib/crypto/history-worker-schedule.core";
import { incrementalMeter, meterTotal, METER_FLUSH_EVERY_CALLS, type RequestMeter } from "@/lib/usage/provider-budget.core";
import {
  acquireHistoricalPriceGaps, revalueHoldersAfterPriceGaps, priceGapAttemptKey, valuedFromISO, holderRevaluationFor, revaluationPending, revaluationBlocks,
  planRevaluation, stampOwedHolders,
  REVALUATION_RESERVE_MS,
  type PriceGapDeps, type RevaluationDeps, type HolderLicence, type InstrumentPriceFacts, type RevaluationOwed, type HolderRevaluation,
} from "@/lib/prices/price-gap";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const DAY = "2026-10-28";
const T0 = Date.parse(`${DAY}T10:00:00Z`);
const ADDR = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
const solCfg = { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }), dailyRequestCap: 1_000_000 };
const btcCfg = btcWorkerConfig({ SOL_BACKFILL_ENABLED: "true" });
const ethCfg = ethWorkerConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" });
const importingSol = (id: string) => serializeSol({ ...emptySol(id, ADDR, `${DAY}T00:00:00Z`), licensedFromISO: "2024-06-01", licensedToISO: DAY });

/** A fake world: `sol`/`btc`/`eth` wallets with BACKLOG — each pass spends every ms it is given. */
function world(o: { sol?: number; btc?: number; eth?: number; persist?: boolean; wakeAgoMs?: number | ((run: number) => number);
  /** Probes the ETH wallet's current chunk needs to close (dense ⇒ near the step budget). */
  ethChunkProbes?: number; btcPending?: boolean; regen?: boolean } = {}) {
  let t = T0;
  let runNo = 0;
  /** The post-#116 ETH step: probes at the provider's rate, STOPS on its deadline, halves on a stop that closed nothing. */
  const eth = { need: o.ethChunkProbes ?? 1_000, closed: 0, halvings: 0, clockStops: 0, failed: false, probes: [] as number[] };
  const regens: string[] = [];
  const btcCursors = new Map<string, string>();
  const runs: Array<{ summary: unknown }> = []; // newest first, as the JobRun read returns them
  const ledger: Record<string, number> = {};
  const deadlines: Array<{ chain: HistoryChain; endsAt: number; runStart: number }> = [];
  let runStart = T0;
  const ran: HistoryChain[] = [];
  const rec = (prefix: string) => async (meter: Readonly<RequestMeter>, flushed: RequestMeter) => {
    for (const [k, v] of Object.entries(meter)) { const d = v - (flushed[k] ?? 0); if (d > 0) { ledger[`${prefix}:${k}`] = (ledger[`${prefix}:${k}`] ?? 0) + d; flushed[k] = v; } }
  };
  const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const deps: SolBackfillJobDeps = { ...OPEN_BACKFILL_GATES,
    now: () => t, sleep: async (ms) => { t += ms; },
    wakeStartedAt: async () => (o.wakeAgoMs === undefined ? null : t - (typeof o.wakeAgoMs === "function" ? o.wakeAgoMs(runNo) : o.wakeAgoMs)),
    wallets: async () => ids("s", o.sol ?? 0).map((id) => ({ accountId: id, connectionId: `c-${id}`, address: ADDR, cursor: importingSol(id) })),
    claimLock: async () => true, renewLock: async () => true, releaseLock: async () => {},
    reconstruct: async ({ accountId, deps: dd }) => {
      const d = { ...dd!, budgetMs: dd!.budgetMs! };
      ran.push("SOL"); deadlines.push({ chain: "SOL", endsAt: t + d.budgetMs, runStart });
      for (let i = 0; i < 10; i++) d.meter!.getTransaction = (d.meter!.getTransaction ?? 0) + 1;
      t += d.budgetMs;
      return { accountId, ok: true, derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null,
        backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 0, impactedFromISO: null, signaturesProcessed: 10, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } } as never;
    },
    store: async () => null,
    regenerationEnabled: () => o.regen === true,
    regenerate: async (id, from) => { regens.push(`${id}:${from}`); t += 20_000; },
    recordUsage: rec("sol"),
    ...(o.persist === false ? {} : { previousRuns: async () => runs.slice(0, 16) }),
    btc: {
      wallets: async () => [
        ...(o.btcPending ? [{ accountId: "bp", connectionId: "c-bp", cursor: btcCursors.get("bp") ?? serializeBtc({ ...emptyBtc("bp", `${DAY}T00:00:00Z`), snapshotPendingFromISO: "2026-10-01" }) }] : []),
        ...ids("b", o.btc ?? 0).map((id) => ({ accountId: id, connectionId: `c-${id}`, cursor: serializeBtc(emptyBtc(id, `${DAY}T00:00:00Z`)) })),
      ],
      reconstruct: async ({ accountId, deps: dd }) => {
        const d = { ...dd, budgetMs: dd.budgetMs! };
        ran.push("BTC"); deadlines.push({ chain: "BTC", endsAt: t + d.budgetMs, runStart });
        for (let i = 0; i < 10; i++) d.meter!.txs = (d.meter!.txs ?? 0) + 1;
        t += d.budgetMs;
        return { accountId, ok: true, derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null,
          backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 0, impactedFromISO: null, txsProcessed: 399, pagesFetched: 16, verified: null, stoppedBecause: "BUDGET", failure: null } } as never;
      },
      store: async (id) => (id !== "bp" ? null : {
        readCursor: async () => btcCursors.get("bp") ?? serializeBtc({ ...emptyBtc("bp", `${DAY}T00:00:00Z`), snapshotPendingFromISO: "2026-10-01" }),
        commit: async (c: { nextCursor: string }) => { btcCursors.set("bp", c.nextCursor); },
      } as never),
      recordUsage: rec("btc"),
    },
    eth: {
      wallets: async () => ids("e", o.eth ?? 0).map((id) => ({ accountId: id, connectionId: `c-${id}`, cursor: serializeEth(queuedCheckpoint(id, "NO_COVERAGE", `${DAY}T00:00:00Z`)) })),
      reconstruct: async ({ deps: d }) => {
        ran.push("ETH"); deadlines.push({ chain: "ETH", endsAt: d.deadlineMs ?? Infinity, runStart });
        const RATE = 25; // probes/s, as measured (1,500 ≈ 60 s)
        const byTime = Math.floor((Math.max(0, (d.deadlineMs ?? Infinity) - t) / 1000) * RATE);
        const spent = Math.min(d.probeBudget, byTime);
        eth.probes.push(spent);
        for (let i = 0; i < Math.ceil(spent * 0.15); i++) d.eth!.meter!.eth_getBalance = (d.eth!.meter!.eth_getBalance ?? 0) + 1;
        t += Math.ceil((spent / RATE) * 1000);
        if (spent >= eth.need) eth.closed++;
        else {
          if (byTime < d.probeBudget) eth.clockStops++;
          if (eth.need <= 100) { eth.failed = true; return { stoppedBecause: "FAILED", status: null, rowsWritten: 0, impactedFromISO: null, failure: { code: "PROVIDER_FAILED", detail: "floor" }, requests: spent }; }
          eth.need = Math.ceil(eth.need / 2); eth.halvings++;
        }
        return { stoppedBecause: "PROBE_BUDGET", status: null, rowsWritten: 0, impactedFromISO: null, failure: null, requests: spent };
      },
      store: async () => null,
      recordUsage: rec("eth"),
    },
  };
  const run = async (): Promise<SolBackfillJobSummary> => {
    runStart = t;
    runNo++;
    const s = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, deps });
    runs.unshift({ summary: JSON.parse(JSON.stringify(s)) });
    t += 15 * 60_000; // the next wake
    return s;
  };
  return { deps, run, runs, ledger, deadlines, ran, eth, regens, btcCursors, now: () => t, kill: () => { runs.unshift({ summary: null }); t += 15 * 60_000; } };
}
const stepped = (s: SolBackfillJobSummary, c: HistoryChain) =>
  c === "SOL" ? s.walletsRun > 0 : c === "BTC" ? (s.btc?.walletsRun ?? 0) > 0 : (s.eth?.walletsRun ?? 0) > 0;

async function main() {
  console.log("schedule (pure)");
  {
    check("rotation 0 is the old order SOL → BTC → ETH", chainOrder(0, new Set(HISTORY_CHAINS)).join() === "SOL,BTC,ETH");
    check("…and every chain leads once in any 3 consecutive rotations",
      [0, 1, 2].map((r) => chainOrder(r, new Set(HISTORY_CHAINS))[0]).sort().join() === "BTC,ETH,SOL"
      && [7, 8, 9].map((r) => chainOrder(r, new Set(HISTORY_CHAINS))[0]).sort().join() === "BTC,ETH,SOL");
    check("chains without work are skipped, the cycle kept", chainOrder(2, new Set<HistoryChain>(["SOL", "BTC"])).join() === "SOL,BTC" && chainOrder(1, new Set<HistoryChain>(["SOL", "ETH"])).join() === "ETH,SOL");
    check("nextRotation: newest persisted + 1", nextRotation([{ summary: { schedule: { rotation: 4 } } }], 99) === 5);
    check("…a killed run (no summary) still advances it", nextRotation([{ summary: null }, { summary: { schedule: { rotation: 4 } } }], 99) === 6);
    check("…a NO_WORK run (no schedule) also counts as a run", nextRotation([{ summary: { stoppedBecause: "NO_WORK" } }, { summary: { schedule: { rotation: 0 } } }], 99) === 2);
    check("…the job's first run ⇒ 0; nothing persisted ⇒ the slot fallback; garbage is ignored", nextRotation([], 7) === 0 && nextRotation([{ summary: { schedule: { rotation: -1 } } }, { summary: "x" }], 3) === 3);
    check("phase: fair share when it covers the step", phaseDeadlineFor({ nowMs: 0, jobDeadlineMs: 120_000, chainsLeft: 3, needMs: 17_000 }) === 40_000);
    check("…raised to the step need (ETH 77 s) when it does not", phaseDeadlineFor({ nowMs: 0, jobDeadlineMs: 120_000, chainsLeft: 3, needMs: 77_000 }) === 77_000);
    check("…never past the job deadline", phaseDeadlineFor({ nowMs: 100_000, jobDeadlineMs: 120_000, chainsLeft: 2, needMs: 77_000 }) === 120_000
      && phaseDeadlineFor({ nowMs: 130_000, jobDeadlineMs: 120_000, chainsLeft: 2, needMs: 77_000 }) === 130_000);
    check("…the last phase takes everything left", phaseDeadlineFor({ nowMs: 10_000, jobDeadlineMs: 120_000, chainsLeft: 1, needMs: 0 }) === 120_000);
  }

  console.log("defect 1 reproduced: the fixed order starves Ethereum");
  {
    const w = world({ sol: 20, btc: 20, eth: 1, persist: false });
    const out: SolBackfillJobSummary[] = [];
    for (let i = 0; i < 6; i++) out.push(await w.run());
    check("without the rotation (rotation 0 every run) ETH never starts a step: JOB_BUDGET, walletsRun 0, every run",
      out.every((s) => s.eth?.stoppedBecause === "JOB_BUDGET" && s.eth.walletsRun === 0) && out.every((s) => s.btc!.walletsRun > 0), JSON.stringify(out.map((s) => s.eth)));
  }

  console.log("fixed: SOL backlog + BTC backlog + ETH work");
  {
    const N = 9, K = 3;
    const w = world({ sol: 20, btc: 20, eth: 2 });
    const out: SolBackfillJobSummary[] = [];
    for (let i = 0; i < N; i++) out.push(await w.run());
    const windowsOk = HISTORY_CHAINS.every((c) => out.every((_, i) => i + K > N || out.slice(i, i + K).some((s) => stepped(s, c))));
    check(`every chain starts ≥ 1 step in EVERY window of ${K} consecutive runs (over ${N} runs)`, windowsOk,
      out.map((s) => `${s.schedule?.order.join(">")}:${HISTORY_CHAINS.filter((c) => stepped(s, c)).join("+")}`).join(" | "));
    check("…the leader rotates run to run (persisted in the summary)", out.map((s) => s.schedule?.rotation).join() === "0,1,2,3,4,5,6,7,8"
      && out.slice(0, 3).map((s) => s.schedule!.order[0]).join() === "SOL,BTC,ETH");
    check("…an ETH-led run gives Ethereum its full step (deadline ≥ 75 s after the phase starts)", out[2].eth!.walletsRun >= 1 && out[2].eth!.stoppedBecause !== "DAILY_CAP");
    check("…no phase ever plans past the job budget", w.deadlines.length > 0 && w.deadlines.every((d) => d.endsAt <= d.runStart + solCfg.jobBudgetMs));

    // A killed run (no summary written) still advances the rotation.
    const k = world({ sol: 20, btc: 20, eth: 2 });
    const a = await k.run(); k.kill(); const b = await k.run();
    check("a run killed before its summary still advances the rotation (0, [killed 1], 2)", a.schedule?.rotation === 0 && b.schedule?.rotation === 2 && b.schedule.order[0] === "ETH");
  }

  console.log("single chain unchanged");
  {
    const e = world({ eth: 1 });
    const s = await e.run();
    check("ETH alone: whole budget, one step", s.eth?.walletsRun === 1 && s.schedule?.order.join() === "ETH" && e.deadlines[0].endsAt <= T0 + solCfg.jobBudgetMs);
    const so = world({ sol: 1 });
    const s2 = await so.run();
    check("SOL alone: whole budget (wallet budget min(60 s, budget − 30 s))", s2.walletsRun === 1 && so.deadlines[0].endsAt - T0 === Math.min(solCfg.walletBudgetMs, solCfg.jobBudgetMs - 30_000));
    const two = world({ sol: 1, btc: 1 });
    await two.run();
    check("SOL + BTC at rotation 0: Solana's first half, as before", two.deadlines[0].chain === "SOL" && two.deadlines[0].endsAt - T0 === solCfg.jobBudgetMs / 2 - 30_000);
  }

  console.log("budget never exceeds the wake");
  {
    // The wake began 170 s ago: 90 s remain before WAKE_SAFE_MS — less than the 120 s job budget.
    const w = world({ sol: 20, btc: 20, eth: 1, wakeAgoMs: 170_000 });
    for (let i = 0; i < 3; i++) {
      const before = w.now();
      const s = await w.run();
      const wakeSafe = before - 170_000 + WAKE_SAFE_MS;
      const mine = w.deadlines.filter((d) => d.runStart === before);
      check(`run ${i}: budget = what the wake has left (${s.budgetMs} ms), every phase deadline within it`,
        s.budgetMs === wakeSafe - before && mine.length > 0 && mine.every((d) => d.endsAt <= wakeSafe));
    }
  }

  console.log("review fixes: ETH steps stop on the clock (post-#116), short wakes, pending regenerations");
  {
    // A DENSE wallet: its chunk needs 1,400 of the 1,500 probes. Under SOL + BTC backlogs, every ETH step
    // must be given the time its probes need, or it clock-stops, halves, and walks toward FAILED.
    const w = world({ sol: 20, btc: 20, eth: 1, ethChunkProbes: 1_400 });
    const out: SolBackfillJobSummary[] = [];
    for (let i = 0; i < 6; i++) out.push(await w.run());
    check("dense ETH chunk in shared runs: closes within 3 runs, no clock stop, no halving, never FAILED",
      w.eth.closed >= 1 && out.slice(0, 3).some((s) => (s.eth?.walletsRun ?? 0) > 0) && w.eth.clockStops === 0 && w.eth.halvings === 0 && !w.eth.failed,
      JSON.stringify({ ...w.eth, probes: w.eth.probes }));
    check("…each step plans only the probes its time proves (≤ the configured 1,500)", w.eth.probes.every((p) => p > 0 && p <= ethCfg.probeBudget), w.eth.probes.join());
    check("…and every ETH step's deadline is inside its run's budget", w.deadlines.filter((d) => d.chain === "ETH").every((d) => d.endsAt <= d.runStart + solCfg.jobBudgetMs));

    // A short wake on ETH's turn: the lead is KEPT, not consumed.
    // Run 1 (rotation 0, SOL leads) normal; run 2 (rotation 1, BTC) normal; run 3 (rotation 2, ETH) starts with 60 s of wake left.
    const sw = world({ sol: 20, btc: 20, eth: 1, wakeAgoMs: (n) => (n === 3 ? WAKE_SAFE_MS - 60_000 : 0) });
    const r: SolBackfillJobSummary[] = [];
    for (let i = 0; i < 4; i++) r.push(await sw.run());
    check("a short-wake run whose leader cannot start records leaderShort and does not consume the lead",
      r[2].schedule?.order[0] === "ETH" && r[2].schedule.leaderShort === true && (r[2].eth?.walletsRun ?? 0) === 0, JSON.stringify(r[2].schedule));
    check("…the next run keeps ETH in the lead and it steps", r[3].schedule?.rotation === 2 && r[3].schedule.order[0] === "ETH" && (r[3].eth?.walletsRun ?? 0) === 1, JSON.stringify(r[3].schedule));
    check("…the other chains still used the short run's time", r[2].walletsRun + (r[2].btc?.walletsRun ?? 0) > 0);

    // A chain whose only work is a PENDING regeneration, under SOL + ETH backlogs.
    const pw = world({ sol: 20, eth: 1, btcPending: true, regen: true });
    const pr: SolBackfillJobSummary[] = [];
    for (let i = 0; i < 3 && !pw.regens.some((x) => x.startsWith("bp:")); i++) pr.push(await pw.run());
    check("a pending-regeneration-only chain gets the regeneration reserve and clears its marker within 3 runs",
      pw.regens.includes("bp:2026-10-01") && pr.some((s) => (s.btc?.regenerated ?? 0) === 1) && !/"snapshotPendingFromISO":"2026/.test(pw.btcCursors.get("bp") ?? ""),
      JSON.stringify(pr.map((s) => ({ o: s.schedule?.order, btc: s.btc && { regen: s.btc.regenerated, def: s.btc.regenerationsDeferred } }))));
  }

  console.log("re-review: the sweep survives a single-chain backlog; an impossible ETH reserve is clamped");
  {
    for (const chain of HISTORY_CHAINS) {
      const w = world({ sol: chain === "SOL" ? 20 : 0, btc: chain === "BTC" ? 20 : 0, eth: chain === "ETH" ? 1 : 0 });
      let swept = 0;
      w.deps.cryptoHolders = async () => ["h1"];
      w.deps.acquirePriceGaps = async () => { swept++; return { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }; };
      const out: SolBackfillJobSummary[] = [];
      for (let i = 0; i < 3; i++) out.push(await w.run());
      check(`${chain}-only backlog: the price-gap sweep runs every run (the leader's phase leaves PRICE_GAP_RESERVE_MS)`,
        swept === 3 && out.every((s) => s.priceGapSweep?.skippedForTime === false && stepped(s, chain)), JSON.stringify(out.map((s) => s.priceGapSweep)));
    }
    const w = world({ eth: 1 });
    const big = { ...ethCfg, startReserveMs: 200_000 };
    const s = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: big, deps: w.deps });
    check("ETH_BACKFILL_START_RESERVE_MS above the job budget is clamped: ETH still steps", (s.eth?.walletsRun ?? 0) === 1 && s.eth?.stoppedBecause !== "JOB_BUDGET", JSON.stringify(s.eth));
  }

  console.log("P1 2026-10-31 fairness: a history backlog cannot starve an owed holder revaluation");
  {
    for (const chain of ["BTC", "ETH", "SOL"] as const) {
      const run = async (pending: boolean) => {
        const w = world({ sol: chain === "SOL" ? 20 : 0, btc: chain === "BTC" ? 20 : 0, eth: chain === "ETH" ? 1 : 0, regen: true });
        let leftAtStart = -1;
        w.deps.cryptoHolders = async () => ["h1"];
        w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
        w.deps.revaluationPending = async () => pending;
        w.deps.revalueHolders = async (_ids, { deadlineMs }) => {
          leftAtStart = deadlineMs - w.now();
          const skipped = leftAtStart < REVALUATION_RESERVE_MS;
          return { priceGaps: null, owed: 1, revalued: skipped ? 0 : 1, chunksRebuilt: skipped ? 0 : 1, deferred: 0, alreadyRevalued: 0, abandonedBlocks: 0, rowsStampedUnavailable: 0, rowsStampedPending: 0, blocksCredited: 0, failures: 0, skippedForTime: skipped };
        };
        const s = await w.run();
        return { s, leftAtStart, stepped: stepped(s, chain) };
      };
      const starved = await run(false);
      // (ETH's fake wallet is one bounded step, so it may leave time over; BTC/SOL backlogs spend every ms.)
      if (chain !== "ETH") check(`${chain} backlog, nothing reported owed: the revaluation runs last on what is left (the live starvation)`,
        starved.leftAtStart < REVALUATION_RESERVE_MS && starved.stepped && !starved.s.revaluationReserved, JSON.stringify({ left: starved.leftAtStart }));
      const fair = await run(true);
      check(`${chain} backlog, a revaluation owed: its slice is reserved — it starts with ≥ REVALUATION_RESERVE_MS and the chain still steps`,
        fair.leftAtStart >= REVALUATION_RESERVE_MS && fair.s.revaluationReserved === true && fair.s.holderRevaluation?.revalued === 1 && fair.stepped,
        JSON.stringify({ left: fair.leftAtStart, h: fair.s.holderRevaluation }));
    }
    // Two backlogs: the reserved slice is taken right after the leader, so the FOLLOWER cannot eat it either.
    {
      const w = world({ sol: 20, btc: 20, regen: true });
      let leftAtStart = -1;
      w.deps.cryptoHolders = async () => ["h1"];
      w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
      w.deps.revaluationPending = async () => true;
      w.deps.revalueHolders = async (_ids, { deadlineMs }) => {
        leftAtStart = deadlineMs - w.now();
        return { priceGaps: null, owed: 1, revalued: 1, chunksRebuilt: 1, deferred: 0, alreadyRevalued: 0, abandonedBlocks: 0, rowsStampedUnavailable: 0, rowsStampedPending: 0, blocksCredited: 0, failures: 0, skippedForTime: false };
      };
      const s = await w.run();
      check("SOL + BTC backlogs, a revaluation owed: it runs BEFORE the follower chain (≥ REVALUATION_RESERVE_MS left), both chains still step",
        leftAtStart >= REVALUATION_RESERVE_MS && stepped(s, "SOL") && stepped(s, "BTC"), JSON.stringify({ left: leftAtStart, order: s.schedule?.order }));
    }
    // OWNER RULING: abandoned blocks make the run PARTIAL (never silent), in BOTH jobs.
    const hr = (abandonedBlocks: number) => ({ holders: 1, owed: 0, revalued: 0, chunksRebuilt: 0, deferred: 0, alreadyRevalued: 0, abandonedBlocks, rowsStampedUnavailable: abandonedBlocks * 7, failures: 0, skippedForTime: false });
    const okOut = solBackfillJobOutcome({ holderRevaluation: hr(0) });
    const abOut = solBackfillJobOutcome({ holderRevaluation: hr(2) });
    check("worker: abandoned revaluation blocks ⇒ outcome PARTIAL, reason REVALUATION_ABANDONED",
      okOut.outcome === "COMPLETE" && abOut.outcome === "PARTIAL" && abOut.partialReasons.some((x) => x.startsWith("REVALUATION_ABANDONED: 2 block(s)")), JSON.stringify(abOut));
    const { syncCryptoOutcome } = await import("@/jobs/sync-crypto");
    const runOf = (abandonedBlocks: number) => ({ priceGaps: null, owed: 0, revalued: 0, chunksRebuilt: 0, deferred: 0, alreadyRevalued: 0, abandonedBlocks, rowsStampedUnavailable: 3, rowsStampedPending: 0, blocksCredited: 0, failures: 0, skippedForTime: false });
    check("sync-crypto: abandoned revaluation blocks ⇒ outcome PARTIAL, reason REVALUATION_ABANDONED",
      syncCryptoOutcome(runOf(0)).outcome === "COMPLETE" && syncCryptoOutcome(null).outcome === "COMPLETE"
        && syncCryptoOutcome(runOf(1)).outcome === "PARTIAL" && syncCryptoOutcome(runOf(1)).partialReasons[0].startsWith("REVALUATION_ABANDONED: 1 block(s)"));
    {
      // …and end to end through the worker: the summary carries it.
      const w = world({ regen: true });
      w.deps.cryptoHolders = async () => ["h1"];
      w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
      w.deps.revalueHolders = async () => runOf(1);
      const s = await w.run();
      check("worker run with an abandoned block: summary.outcome PARTIAL (REVALUATION_ABANDONED), holderRevaluation.abandonedBlocks 1",
        s.outcome === "PARTIAL" && !!s.partialReasons?.some((x) => x.startsWith("REVALUATION_ABANDONED")) && s.holderRevaluation?.abandonedBlocks === 1, JSON.stringify({ o: s.outcome, r: s.partialReasons }));
    }
    {
      // L2 × reservation: the early (reserved) holder set passes the SAME billable gate — a refused owner gets no revaluation.
      const w = world({ btc: 20, regen: true });
      const seen: string[][] = [];
      w.deps.cryptoHolders = async () => ["ok1", "frozen1"];
      w.deps.billableAccounts = async (ids) => new Map(ids.map((id) => [id, id === "frozen1" ? { allowed: false, reason: "COST_FREEZE" } as never : { allowed: true }] as const));
      w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
      w.deps.revaluationPending = async (ids) => { seen.push([...ids]); return true; };
      w.deps.revalueHolders = async (ids) => { seen.push([...ids]); return runOf(0); };
      await w.run();
      check("cost freeze × reservation: a refused (frozen) owner's holder is in neither the pending read nor the revaluation",
        seen.length >= 2 && seen.every((x) => !x.includes("frozen1") && x.includes("ok1")), JSON.stringify(seen));
      const sc = readFileSync("jobs/sync-crypto.ts", "utf8");
      check("sync-crypto: under the GLOBAL freeze the revaluation's price-gap fetch is replaced by an empty run (DB recompute only)",
        /if \(platformFrozen\) revalDeps\.acquireGaps = async \(\) => \(\{ decisions: \[\], acquired: 0/.test(sc) && /deps: revalDeps,/.test(sc));
    }
    {
      // Session 2 ruling: STAMP, DON'T REBUILD for frozen / refused holders — then unfreeze clears it.
      const mkW = (o: { global?: boolean; refuse?: boolean }) => {
        const w = world({ btc: 1, regen: true });
        const log: string[] = [];
        w.deps.costFreeze = async () => (o.global ? { frozen: true, state: "FROZEN", reason: "COST_FREEZE" } as never : { frozen: false, state: "MISSING", reason: null });
        w.deps.billableAccounts = async (ids) => new Map(ids.map((id) => [id, o.refuse && id === "frozen1" ? { allowed: false, reason: "COST_FREEZE" } as never : { allowed: true }] as const));
        w.deps.cryptoHolders = async () => ["ok1", "frozen1"];
        w.deps.stampOwedHolders = async (ids) => { log.push(`stamp:${[...ids].sort().join("+")}`); return 5; };
        w.deps.acquirePriceGaps = async (ids) => { log.push(`prices:${ids.join("+")}`); return { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }; };
        w.deps.revalueHolders = async (ids) => { log.push(`revalue:${[...ids].sort().join("+")}`); return runOf(0); };
        return { w, log };
      };
      const g = mkW({ global: true });
      const gs = await g.w.run();
      check("GLOBAL freeze: owed holders are STAMPED (status only), the job reports SKIPPED, and nothing paid runs (no step, no price fetch, no revaluation, no usage)",
        gs.outcome === "SKIPPED" && gs.revaluationStamped === 5 && g.log.join() === "stamp:frozen1+ok1" && g.w.ran.length === 0 && Object.keys(g.w.ledger).length === 0,
        JSON.stringify({ o: gs.outcome, l: g.log, ran: g.w.ran, led: g.w.ledger }));
      const r = mkW({ refuse: true });
      await r.w.run();
      check("per-account refusal: the refused holder is stamped with the rest, but never revalued or price-fetched",
        r.log[0] === "stamp:frozen1+ok1" && r.log.filter((x) => !x.startsWith("stamp:")).every((x) => !x.includes("frozen1")) && r.log.some((x) => x.startsWith("revalue:ok1")), r.log.join(" | "));
      const u = mkW({});
      await u.w.run();
      check("after unfreeze: the holder is revalued (its rebuild clears the stamp — proved in stale-holder-revaluation.test.ts)",
        u.log.some((x) => x.startsWith("revalue:") && x.includes("frozen1")), u.log.join(" | "));
    }
    {
      // REVIEW #183 (P2): the regeneration KILL SWITCH off ⇒ no stamp, no revaluation, nothing marked; on ⇒ normal.
      const mkK = (on: boolean) => {
        const w = world({ btc: 1, regen: on });
        const log: string[] = [];
        w.deps.cryptoHolders = async () => ["h1"];
        w.deps.stampOwedHolders = async (ids) => { log.push(`stamp:${ids.join("+")}`); return 3; };
        w.deps.revaluationPending = async () => true;
        w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
        w.deps.revalueHolders = async (ids) => { log.push(`revalue:${ids.join("+")}`); return runOf(0); };
        return { w, log };
      };
      const off = mkK(false); const so = await off.w.run();
      check("kill switch OFF: nothing stamped, nothing revalued, no reservation", off.log.length === 0 && !so.revaluationStamped && !so.revaluationReserved, off.log.join());
      const offFrozen = mkK(false);
      offFrozen.w.deps.costFreeze = async () => ({ frozen: true, state: "FROZEN", reason: "COST_FREEZE" } as never);
      const sf = await offFrozen.w.run();
      check("kill switch OFF under the GLOBAL freeze: still SKIPPED, and nothing stamped", sf.outcome === "SKIPPED" && offFrozen.log.length === 0 && !sf.revaluationStamped, offFrozen.log.join());
      const on = mkK(true); await on.w.run();
      check("kill switch ON: the normal stamp and revaluation run", on.log[0] === "stamp:h1" && on.log.some((x) => x === "revalue:h1"), on.log.join());
    }
    {
      // PERF 2026-10-31: the revaluation PLAN is read ONCE per pass (stamp + reservation + rebuild share it).
      const w = world({ btc: 20, regen: true });
      let owedCalls = 0, stampWrites = 0;
      const holder: HolderRevaluation = { accountId: "h1", windowFromISO: "2026-09-01", valuedFromISO: "2026-09-01", evidenceKey: "revaluation:v2:h1:k", spaceIds: ["qa"] };
      const marks = new Set<string>();
      const rd: RevaluationDeps = {
        acquireGaps: async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null }),
        owed: async () => { owedCalls++; return [holder]; },
        revaluedAlready: async (ks) => new Set(ks.filter((k) => marks.has(k))),
        markRevalued: async (k) => { marks.add(k); },
        markUnavailable: async () => { stampWrites++; return 7; },
        regenerate: async () => { w.deps.sleep(1_000); },
        now: () => w.now(),
      };
      w.deps.cryptoHolders = async () => ["h1"];
      w.deps.acquirePriceGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
      w.deps.planRevaluation = (ids) => planRevaluation(rd, ids, DAY);
      w.deps.stampOwedHolders = (ids, plan) => stampOwedHolders(rd, ids, DAY, plan);
      w.deps.revaluationPending = (ids, plan) => revaluationPending(rd, ids, DAY, plan);
      w.deps.revalueHolders = (ids, { deadlineMs, plan, alreadyStamped }) => revalueHoldersAfterPriceGaps({ accountIds: ids, deps: rd, deadlineMs, todayISO: DAY, plan, alreadyStamped });
      const s = await w.run();
      check("ONE planning read per pass: stamp, reservation and rebuild share the plan (was ~3 per pass)",
        owedCalls === 1 && s.revaluationReserved === true && (s.holderRevaluation?.chunksRebuilt ?? 0) > 0, JSON.stringify({ owedCalls, hr: s.holderRevaluation }));
      check("ONE stamp truth: revaluationStamped = atStart + inRevaluation, and the rebuild did not re-stamp the plan",
        s.revaluationStamped === 7 && s.revaluationStampedBreakdown?.atStart === 7 && s.revaluationStampedBreakdown?.inRevaluation === 0
          && s.holderRevaluation?.rowsStampedPending === 0 && stampWrites === 1, JSON.stringify({ st: s.revaluationStamped, b: s.revaluationStampedBreakdown, stampWrites }));
      // A gap fill moved a floor mid-pass ⇒ the rebuild stamps the newly owed blocks: the total says so.
      const w2 = world({ btc: 20, regen: true });
      w2.deps.cryptoHolders = async () => ["h1"];
      w2.deps.acquirePriceGaps = w.deps.acquirePriceGaps;
      w2.deps.planRevaluation = w.deps.planRevaluation;
      w2.deps.stampOwedHolders = w.deps.stampOwedHolders;
      w2.deps.revaluationPending = async () => true;
      w2.deps.revalueHolders = async () => ({ ...runOf(0), rowsStampedPending: 4 });
      const s2 = await w2.run();
      check("…and when the rebuild stamps newly owed blocks, revaluationStamped = atStart + inRevaluation",
        s2.revaluationStampedBreakdown?.inRevaluation === 4 && s2.revaluationStamped === (s2.revaluationStampedBreakdown?.atStart ?? -1) + 4, JSON.stringify({ st: s2.revaluationStamped, b: s2.revaluationStampedBreakdown }));
    }
    // revaluationPending is the cheap state read the reservation is decided by.
    const marks = new Set<string>();
    const h: HolderRevaluation = { accountId: "b0", windowFromISO: "2026-10-01", valuedFromISO: "2026-10-01", evidenceKey: "revaluation:v2:b0:k" };
    const rd = { owed: async () => [h], revaluedAlready: async (ks: readonly string[]) => new Set(ks.filter((k) => marks.has(k))) };
    const before = await revaluationPending(rd, ["b0"], DAY);
    for (const b of revaluationBlocks(h.evidenceKey, h.windowFromISO, DAY)) marks.add(b.key);
    check("revaluationPending: owed until its chunks are marked, then not (no reservation on a quiet run)", before === true && (await revaluationPending(rd, ["b0"], DAY)) === false);
  }

  console.log("ERC-20 review N3: a native ETH backlog cannot starve the token pass");
  {
    const erc20Cfg = erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: "true" });
    for (const shape of ["eth-led"] as const) {
      const w = world({ eth: 1 });
      w.deps.providerUsageToday = async () => ({ solana: 0, other: 0 });
      // A native backlog that spends every ms its pass is given (a dense step stops only on its deadline).
      const native = w.deps.eth!.reconstruct;
      w.deps.eth!.reconstruct = async (a) => { const r = await native(a); await w.deps.sleep!(Math.max(0, (a.deps.deadlineMs ?? w.now()) - w.now())); return r; };
      const tokenSteps: number[] = [];
      w.deps.ethTokens = {
        wallets: async () => [{ accountId: "e0", connectionId: "c-e0", cursor: null }],
        step: async () => { tokenSteps.push(w.now()); return { stoppedBecause: "DONE", requests: 0, pagesRead: 0, verified: [], unsupported: [], inconclusive: [], pending: 0, impactedFromISO: null, verifiedInstrumentIds: [], pricingCandidates: [], failure: null }; },
        setPending: async () => true,
      };
      const out: SolBackfillJobSummary[] = [];
      for (let i = 0; i < 3 && tokenSteps.length === 0; i++) out.push(await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, erc20Config: erc20Cfg, deps: w.deps }));
      const ethLed = out.find((s) => s.schedule?.order.includes("ETH") && (s.eth?.walletsRun ?? 0) > 0);
      check(`N3 (${shape}): the native ETH step still runs AND the token pass steps in the same ETH phase`,
        !!ethLed && (ethLed.ethTokens?.walletsRun ?? 0) === 1 && ethLed.ethTokens?.stoppedBecause !== "JOB_BUDGET",
        JSON.stringify(out.map((s) => ({ order: s.schedule?.order, eth: s.eth?.walletsRun, tok: s.ethTokens && { run: s.ethTokens.walletsRun, stop: s.ethTokens.stoppedBecause } }))));
    }
  }

  console.log("defect 2: crash-safe metering");
  {
    // Unit: a kill after k calls leaves ≥ k − (granularity) on the ledger.
    let recorded = 0;
    const m = incrementalMeter(async (meter, flushed) => { const d = meterTotal(meter) - meterTotal(flushed); recorded += d; for (const [k, v] of Object.entries(meter)) flushed[k] = v; });
    for (let i = 0; i < 137; i++) { m.meter.x = (m.meter.x ?? 0) + 1; await Promise.resolve(); }
    await ticks();
    check(`killed after 137 calls (no final flush): ≥ 137 − ${METER_FLUSH_EVERY_CALLS - 1} recorded`, recorded >= 137 - (METER_FLUSH_EVERY_CALLS - 1) && recorded <= 137, String(recorded));
    await m.flush();
    check("…and a normal end records exactly the rest (no double count)", recorded === 137);
    await m.flush();
    check("…a second flush records nothing", recorded === 137);

    let t = 0, timed = 0;
    const tm = incrementalMeter(async (meter, flushed) => { timed += meterTotal(meter) - meterTotal(flushed); Object.assign(flushed, meter); }, { now: () => t });
    tm.meter.x = 1; await ticks(); const early = timed;
    t = 11_000; tm.meter.x = 2; await ticks();
    check("a slow pass is flushed on time too (a call 10 s after the last flush)", early === 0 && timed === 2);

    let calls = 0;
    const bad = incrementalMeter(async () => { calls++; throw new Error("ledger down"); });
    for (let i = 0; i < 120; i++) bad.meter.x = (bad.meter.x ?? 0) + 1;
    await ticks(); await bad.flush();
    check("a failing recorder never fails the run and never spins", calls > 0 && calls <= 4, String(calls));

    // Batched ETH-style increments (225 calls in one synchronous loop).
    let batch = 0;
    const bm = incrementalMeter(async (meter, flushed) => { batch += meterTotal(meter) - meterTotal(flushed); Object.assign(flushed, { ...meter }); });
    for (let i = 0; i < 225; i++) bm.meter.eth_getBalance = (bm.meter.eth_getBalance ?? 0) + 1;
    await ticks();
    check("a synchronous batch of 225 is recorded without waiting for the pass end", batch >= 225 - (METER_FLUSH_EVERY_CALLS - 1), String(batch));

    // Job level: each chain's pass killed mid-flight (the reconstruct never returns).
    for (const chain of HISTORY_CHAINS) {
      const w = world({ sol: chain === "SOL" ? 1 : 0, btc: chain === "BTC" ? 1 : 0, eth: chain === "ETH" ? 1 : 0 });
      const k = 173;
      const hang = new Promise<never>(() => {});
      const spend = async (meter: RequestMeter, key: string) => { for (let i = 0; i < k; i++) { meter[key] = (meter[key] ?? 0) + 1; await Promise.resolve(); } return hang; };
      if (chain === "SOL") w.deps.reconstruct = async ({ deps: d }) => spend(d!.meter!, "getTransaction");
      if (chain === "BTC") w.deps.btc!.reconstruct = async ({ deps: d }) => spend(d.meter!, "txs");
      if (chain === "ETH") w.deps.eth!.reconstruct = async ({ deps: d }) => spend(d.eth!.meter!, "eth_getBalance");
      void solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, deps: w.deps });
      await ticks(40);
      const onLedger = Object.values(w.ledger).reduce((a, b) => a + b, 0);
      check(`${chain} pass killed after ${k} requests: ${onLedger} on the shared ledger (≥ ${k - (METER_FLUSH_EVERY_CALLS - 1)})`,
        onLedger >= k - (METER_FLUSH_EVERY_CALLS - 1) && onLedger <= k);
    }

    // Normal completion across several wallets and all three passes: ledger = meters, exactly.
    const w = world({ sol: 3, btc: 3, eth: 1 });
    const s = await w.run();
    const sum = (p: string) => Object.entries(w.ledger).filter(([k]) => k.startsWith(`${p}:`)).reduce((a, [, n]) => a + n, 0);
    check("normal completion: each ledger equals its pass's meter exactly (no double count)",
      sum("sol") === s.requests.total && sum("btc") === s.btc!.requests.total && sum("eth") === (s.eth?.requests.total ?? 0) && s.requests.total > 0,
      `${JSON.stringify(w.ledger)} vs sol ${s.requests.total} btc ${s.btc?.requests.total} eth ${s.eth?.requests.total}`);
  }

  console.log("defect 3: price gaps for holders with no backfill work");
  {
    // Preview's facts: a COMPLETE SOL wallet licensed from 2022-03-26; the archive holds 2026-09-27..; the provider serves 365 days.
    const mk = (o: { earliest: string | null; wakeAgoMs?: number; snapshotStart?: string }) => {
      let t = T0;
      const facts = { SOL: o.earliest, ETH: o.earliest };
      const attempts = new Set<string>();
      const revalued = new Set<string>();
      const requests: string[] = [];
      const log: string[] = [];
      const snapshotStart = o.snapshotStart ?? "2026-09-27";
      const licences: HolderLicence[] = [
        { financialAccountId: "s0", instrumentId: "SOL", licensedFromISO: "2022-03-26" },
        { financialAccountId: "e0", instrumentId: "ETH", licensedFromISO: "2021-01-01" },
      ];
      const cursors: Record<string, string> = { s0: serializeSol({ ...emptySol("s0", ADDR, `${DAY}T00:00:00Z`), reachedBeginning: true,
        completedAtISO: `${DAY}T00:00:00Z`, licensedFromISO: "2022-03-26", licensedToISO: DAY } as SolBackfillCheckpoint) };
      const solStore: SolBackfillStore = {
        async readCursor() { return cursors.s0; }, async anchor() { return null; },
        async commit(c) { if (c.expectedCursor !== cursors.s0) throw new Error("cas"); cursors.s0 = c.nextCursor; },
      };
      const gapDeps: PriceGapDeps = {
        licences: async (ids) => licences.filter((l) => ids.includes(l.financialAccountId)),
        priceFacts: async (ids) => new Map(ids.map((id) => [id, { instrumentId: id, earliestRawCloseISO: facts[id as "SOL"], provider: { kind: "provider", source: "COINGECKO", floorISO: "2025-10-28" } } satisfies InstrumentPriceFacts])),
        acquire: async (id, from, to) => { requests.push(`${id}:${from}..${to}`); facts[id as "SOL"] = from; t += 2_000; return { inserted: 334, detail: "ok" }; },
        attemptedOn: async (keys) => new Set(keys.filter((k) => attempts.has(k))),
        markAttempted: async (key) => { attempts.add(key); },
      };
      const owed = async (ids: readonly string[]): Promise<RevaluationOwed[]> => licences.filter((l) => ids.includes(l.financialAccountId)).flatMap((l) => {
        const from = valuedFromISO(l.licensedFromISO, facts[l.instrumentId as "SOL"]);
        return from && from < snapshotStart ? [{ accountId: l.financialAccountId, fromISO: from, floorISO: facts[l.instrumentId as "SOL"]!, earliestSnapshotISO: snapshotStart }] : [];
      });
      // The holder revaluation's own view: evidence-keyed, existing rows included (price-gap.core holderRevaluationFor).
      const holders = async (ids: readonly string[]): Promise<HolderRevaluation[]> => licences.filter((l) => ids.includes(l.financialAccountId)).flatMap((l) => {
        const lic = new Map([[l.instrumentId, l.licensedFromISO]]);
        const f = facts[l.instrumentId as "SOL"];
        const h = holderRevaluationFor({ accountId: l.financialAccountId, nativeLicences: lic, allLicences: lic, floors: new Map(f ? [[l.instrumentId, f]] : []),
          snapshotMinBySpace: new Map([["sp", snapshotStart]]), spaceIds: ["sp"] });
        return h ? [h] : [];
      });
      const deps: SolBackfillJobDeps = { ...OPEN_BACKFILL_GATES,
        now: () => t, sleep: async (ms) => { t += ms; },
        wakeStartedAt: async () => (o.wakeAgoMs !== undefined ? t - o.wakeAgoMs : null),
        wallets: async () => [{ accountId: "s0", connectionId: "c-s0", address: ADDR, cursor: cursors.s0 }],
        claimLock: async () => true, renewLock: async () => true, releaseLock: async () => {},
        reconstruct: async () => { throw new Error("a COMPLETE wallet is never reconstructed"); },
        store: async () => solStore,
        regenerationEnabled: () => true,
        regenerate: async (id, from) => { log.push(`regen:${id}:${from}`); },
        cryptoHolders: async () => ["e0", "s0"],
        acquirePriceGaps: (ids, { attempted, maxInstruments }) => acquireHistoricalPriceGaps({ accountIds: ids, attempted, maxInstruments, deps: gapDeps, yesterdayISO: "2026-10-27" }),
        revaluationOwed: (ids) => owed(ids),
        revalueHolders: (ids, { deadlineMs, attempted, maxInstruments }) => {
          const rd: RevaluationDeps = {
            acquireGaps: (x) => acquireHistoricalPriceGaps({ accountIds: x, attempted, maxInstruments, deps: gapDeps, yesterdayISO: "2026-10-27" }),
            owed: holders, revaluedAlready: async (keys) => new Set(keys.filter((k) => revalued.has(k))), markRevalued: async (k) => { revalued.add(k); },
            regenerate: async (id, from, to) => { log.push(`revalue:${id}:${from}..${to}`); }, now: () => t,
          };
          return revalueHoldersAfterPriceGaps({ accountIds: ids, deps: rd, deadlineMs, todayISO: DAY });
        },
      };
      return { deps, requests, log, cursors, attempts, revalued, run: () => solHistoryBackfill({ config: { ...solCfg, jobBudgetMs: 240_000 }, deps }) };
    };

    const w = mk({ earliest: "2026-09-27" });
    const s1 = await w.run();
    check("a COMPLETE wallet's uncovered range: ONE acquisition per instrument, inside the provider window",
      w.requests.join() === "ETH:2025-10-28..2026-09-26,SOL:2025-10-28..2026-09-26" && s1.priceGaps.acquired === 2 && s1.priceGapSweep?.holders === 2, w.requests.join());
    const cp = parseSol(w.cursors.s0, "s0", ADDR);
    check("…the SOL holder is flagged from its new valued-from and rebuilt under its lock this run",
      s1.revaluationsRederived === 1 && w.log.includes("regen:s0:2025-10-28") && cp?.valuationCheckedFloorISO === "2025-10-28" && !cp?.snapshotPendingFromISO, w.log.join(","));
    check("…the non-SOL holder is revalued from its new valued-from THROUGH TODAY (existing rows included), newest batch first",
      w.log.filter((x) => x.startsWith("revalue:e0:"))[0].endsWith(`..${DAY}`) && w.log.some((x) => x.startsWith("revalue:e0:2025-10-28..")), w.log.join(","));
    check("…SOL parity: the SOL holder is in the worker's revaluation too (not only sync-crypto's)",
      w.log.some((x) => x.startsWith("revalue:s0:")) && s1.holderRevaluation?.holders === 2 && s1.holderRevaluation?.revalued === 2, JSON.stringify(s1.holderRevaluation));
    check("…observations are shared per instrument: the durable once-a-day markers are set",
      w.attempts.has(priceGapAttemptKey("COINGECKO", "SOL", "2026-09-27")) && [...w.revalued].some((k) => k.startsWith("revaluation:v2:e0:")));

    const before = w.log.length;
    const s2 = await w.run();
    check("second run the same day: no provider request, nothing rebuilt again",
      w.requests.length === 2 && s2.priceGaps.acquired === 0 && w.log.length === before && s2.revaluationsRederived === 0 && s2.stoppedBecause === "NO_WORK", JSON.stringify({ r: w.requests, l: w.log.slice(before) }));

    const covered = mk({ earliest: "2021-01-01", snapshotStart: "2021-01-01" });
    const s3 = await covered.run();
    check("covered archive: no request, SOL not flagged by the self-heal; both holders' existing rows are revalued ONCE",
      covered.requests.length === 0 && s3.priceGaps.acquired === 0 && !covered.log.some((x) => x.startsWith("regen:")) && (s3.holderRevaluation?.owed ?? 0) === 2, covered.log.join(","));

    const late = mk({ earliest: "2026-09-27", wakeAgoMs: WAKE_SAFE_MS - PRICE_GAP_RESERVE_MS + 1_000 });
    const s4 = await late.run();
    check("too little wake time: deferred (no request, nothing written), the run finishes normally",
      late.requests.length === 0 && s4.priceGapSweep?.skippedForTime === true && s4.stoppedBecause === "NO_WORK" && late.log.length === 0 && late.attempts.size === 0, JSON.stringify(s4.priceGapSweep));
    const s5 = await late.run(); void s5;
    const next = mk({ earliest: "2026-09-27" });
    await next.run();
    check("…and a later run with time acquires it", next.requests.length === 2);
  }

  console.log(`\nhistory-worker-fairness: ${passes} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

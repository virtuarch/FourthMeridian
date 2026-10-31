/**
 * lib/crypto/eth-history-inline-step.test.ts
 *
 * ETH history with the worker OFF (2026-10-31): a sync advances the resumable
 * checkpoint by ONE bounded worker step instead of running an unbounded FULL
 * rebuild that ignored the checkpoint, kept nothing, and was killed by the
 * function's time limit (Preview: ~1,000 of ~1,800 needed probes per attempt,
 * ~3.2k Alchemy calls wasted, restarted at the head every sync).
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/eth-history-inline-step.test.ts
 *
 * Deterministic and offline: a SIMULATED chain (as eth-history-backfill.test.ts)
 * and an in-memory checkpoint store. Pinned:
 *   1. an inline run with a checkpoint resumes at provenFromBlock, never the head;
 *   2. it stops at its deadline and persists the advanced boundary;
 *   3. repeated short syncs reach COMPLETE (one write, reconciles, usage true);
 *   4. no inline path reaches the acquisition without a finite deadline;
 *   5. the shared daily cap bounds the step (and an unreadable one stops it);
 *   6. a short request never resets / demotes a valid checkpoint;
 *   7. Connections states an incomplete ETH import with the worker off.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { WEI_PER_GWEI, EARLIEST_PROVABLE_BLOCK, type EthAccountState, type EthRpcTransport } from "./eth-history";
import { reconcileMovementsAgainstBalance, type ChainCoverage, type ChainMovement } from "./chain-movement";
import {
  queuedCheckpoint, serializeCheckpoint, parseCheckpoint, backfillStatus, boundedEthDeps, inlineStepProbeBudget, probeBudgetFor,
  ethInlineStepMs, ethWorkerConfig, DEFAULT_ETH_INLINE_STEP_MS, type EthBackfillCheckpoint,
} from "./eth-history-backfill.core";
import { runEthHistoryBackfill, EthCheckpointConflictError, type EthBackfillStore } from "./eth-history-backfill";
import { reconstructEthHistoryForSync, runInlineEthHistoryStep, type EthSyncImpl } from "./eth-history-backfill.store";
import type { EthHistoryResult } from "./eth-history-sync";
import { walletHistoryCheckpointStatus } from "./history-checkpoint-status";
import { historyImportText, unprovenHistorySummary } from "@/lib/connections/connection-detail.core";
import { meterTotal } from "@/lib/usage/provider-budget.core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);
const GAS = (gwei: number) => BigInt(21000) * BigInt(gwei) * WEI_PER_GWEI;
const OWNER = "0x000000000000000000000000000000000000abcd";
const OTHER = "0x0000000000000000000000000000000000001234";
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

interface SimEvent { block: number; delta: bigint; originated?: boolean; feeWei?: bigint }
/** A simulated chain; `msPerCall` > 0 advances `clock` per JSON-RPC call (a slow provider). */
function simulate(opts: { events: SimEvent[]; head: number; headTimeSec: number; clock?: { t: number }; msPerCall?: number }) {
  const chain = { head: opts.head, events: [...opts.events].sort((a, b) => a.block - b.block), calls: 0, probed: [] as number[] };
  const stateAt = (block: number): EthAccountState => {
    let balance = BigInt(0); let nonce = BigInt(0);
    for (const e of chain.events) { if (e.block > block) break; balance += e.delta; if (e.originated) nonce += BigInt(1); }
    return { balance, nonce, code: "0x" };
  };
  const tsOf = (b: number) => BigInt(opts.headTimeSec + (b - opts.head) * 12);
  interface Row { id: number; method: string; params: unknown[] }
  const transport: EthRpcTransport = async (body) => {
    const rows: Row[] = Array.isArray(body) ? body as Row[] : [body as Row];
    if (opts.clock && opts.msPerCall) opts.clock.t += rows.length * opts.msPerCall;
    const out = rows.map((r) => {
      chain.calls++;
      const blockOf = () => Number(BigInt(r.params[1] as string));
      if (r.method === "eth_getBalance") { chain.probed.push(blockOf()); return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(blockOf()).balance) }; }
      if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(blockOf()).nonce) };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: stateAt(blockOf()).code };
      if (r.method === "eth_getBlockByNumber") {
        const b = r.params[0] === "finalized" ? chain.head : Number(BigInt(r.params[0] as string));
        return { jsonrpc: "2.0", id: r.id, result: { number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)), withdrawals: [] } };
      }
      if (r.method === "eth_getBlockReceipts") {
        const ev = chain.events.find((e) => e.block === Number(BigInt(r.params[0] as string)));
        const receipts = ev?.originated
          ? [{ from: OWNER, to: OTHER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }] : [];
        return { jsonrpc: "2.0", id: r.id, result: receipts };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  return { chain, transport, stateAt };
}

class MemoryStore implements EthBackfillStore {
  walletAddress = OWNER;
  writes: Array<{ movements: ChainMovement[]; coverage: ChainCoverage; anchorBalanceWei: bigint }> = [];
  constructor(public cursor: string | null) {}
  async readCursor() { return this.cursor; }
  async casCursor(expected: string | null, next: string) { if (this.cursor !== expected) return false; this.cursor = next; return true; }
  async complete(c: Parameters<EthBackfillStore["complete"]>[0]): Promise<EthHistoryResult> {
    const recon = reconcileMovementsAgainstBalance(c.movements, c.anchorBalanceWei);
    if (!recon.reconciles) return { accountId: "a1", ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE", reason: recon.reason };
    if (this.cursor !== c.expectedCursor) throw new EthCheckpointConflictError();
    this.cursor = c.nextCursor;
    this.writes.push({ movements: c.movements, coverage: c.coverage, anchorBalanceWei: c.anchorBalanceWei });
    return { accountId: "a1", ok: true, mode: "FULL", derivedRowsWritten: 7, impactedFromISO: c.coverage.kind === "COMPLETE" ? c.coverage.fromISO : null };
  }
  cp(): EthBackfillCheckpoint | null { return parseCheckpoint(this.cursor, "a1"); }
}

const HEAD = 26_000_000;
const T_HEAD = Date.UTC(2026, 9, 30, 12, 0, 0) / 1000;
// Preview-shaped: first activity at 21.7M (an inbound transfer), a signed spend (FEE) later, an inbound near the head.
const FIRST = 21_736_759;
const EVENTS: SimEvent[] = [
  { block: FIRST, delta: ETH(1) },
  { block: 24_000_000, delta: -ETH(0.1) - GAS(10), originated: true, feeWei: GAS(10) },
  { block: 25_999_000, delta: ETH(0.05) },
];
const NOW_ISO = "2026-10-31T05:36:00.000Z";
const TODAY = "2026-10-31";
const CFG = ethWorkerConfig({});
const queued = () => serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO));

/** A checkpoint some way into the proof (fast provider, small budget, walk only). */
async function partialCheckpoint(budget: number): Promise<string> {
  const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
  const st = new MemoryStore(queued());
  await runEthHistoryBackfill({ accountId: "a1", store: st, todayISO: TODAY }, { probeBudget: budget, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) + 60_000, eth: { transport: sim.transport, earlyOrigin: false } });
  return st.cursor!;
}

async function main() {
  // ══ 1. RESUMES AT THE PROVEN BOUNDARY, NOT THE HEAD ═══════════════════════
  console.log("1. an inline run with a checkpoint resumes from provenFromBlock");
  {
    const start = await partialCheckpoint(120);
    const before = parseCheckpoint(start, "a1")!;
    const P = before.provenFromBlock!;
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(start);
    const r = await runInlineEthHistoryStep({ accountId: "a1", store, todayISO: TODAY, allowanceCalls: 100_000,
      deps: { transport: sim.transport, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) + 60_000 } });
    const above = sim.chain.probed.filter((b) => b > P && b !== before.anchorBlock);
    check("the stored checkpoint is mid-proof (a boundary below the anchor, not at the floor)", P > EARLIEST_PROVABLE_BLOCK && P < before.anchorBlock! && !before.reachedFloor);
    check("no block between the proven boundary and the anchor is probed again (the walk did not restart at the head)",
      above.length === 0 && sim.chain.probed.length > 0, `re-probed ${above.length}: ${above.slice(0, 5).join(",")}`);
    const after = store.cp()!;
    check("…it proves BELOW the boundary, on the SAME anchor, keeping every stored movement",
      after.anchorBlock === before.anchorBlock && (after.reachedFloor || after.provenFromBlock! < P)
        && before.movements.every((m) => after.movements.some((n) => n.eventId === m.eventId && n.movementKey === m.movementKey)),
      JSON.stringify({ p0: P, p1: after.provenFromBlock, floor: after.reachedFloor }));
    check("…and reports progress, not success, while the proof is open", !r.ok && r.refusal === "FULL_REBUILD_IN_PROGRESS" && store.writes.length === 0);
  }

  // ══ 2. STOPS AT THE DEADLINE AND PERSISTS THE ADVANCED BOUNDARY ═══════════
  console.log("2. an inline run stops at its deadline and persists the advanced boundary");
  {
    const start = await partialCheckpoint(120);
    const P = parseCheckpoint(start, "a1")!.provenFromBlock!;
    const clock = { t: Date.parse(NOW_ISO) };
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD, clock, msPerCall: 1_000 });
    const store = new MemoryStore(start);
    const t0 = clock.t;
    const r = await runInlineEthHistoryStep({ accountId: "a1", store, todayISO: TODAY, allowanceCalls: 100_000,
      deps: { transport: sim.transport, batchSize: 3, earlyOrigin: false, now: () => clock.t, deadlineMs: t0 + DEFAULT_ETH_INLINE_STEP_MS } });
    const overrun = clock.t - (t0 + DEFAULT_ETH_INLINE_STEP_MS);
    check("a slow provider (1 s per call) cannot stretch the step past its deadline (only evidence for proven changes after it)",
      overrun <= 10_000, `overrun ${overrun} ms over ${sim.chain.calls} calls`);
    check("…the step returns cleanly (no kill, no throw) as in-progress", !r.ok && r.refusal === "FULL_REBUILD_IN_PROGRESS", r.reason);
    const after = store.cp()!;
    check("…and the boundary it proved is PERSISTED on the checkpoint (the next sync starts there)",
      after.provenFromBlock! < P && (after.usage?.requests ?? 0) > 0, `${P} → ${after.provenFromBlock}`);
  }

  // ══ 3. REPEATED SHORT SYNCS REACH COMPLETE ════════════════════════════════
  console.log("3. repeated short syncs (worker off) reach COMPLETE, through the sync entry point");
  {
    const clock = { t: Date.parse(NOW_ISO) };
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD, clock, msPerCall: 400 });
    const store = new MemoryStore(null); // a newly connected wallet: no checkpoint yet
    let incremental = 0;
    const meter: Record<string, number> = {};
    const impl: EthSyncImpl = {
      // No licence yet: the incremental path falls back (and must then never rebuild inline).
      reconstruct: async (a) => { incremental++; if (a.deferFull !== true) throw new Error("inline FULL rebuild requested");
        return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED", mode: "INCREMENTAL", fallbackReason: "NO_COVERAGE" }; },
      pending: async () => { const cp = store.cp(); if (!cp || cp.completedAtISO) return null; const s = backfillStatus(cp).state; return s === "RECOVERY_REQUIRED" ? null : s; },
      enqueue: async (_c, id, reason) => { if (store.cursor !== null) return false; store.cursor = serializeCheckpoint(queuedCheckpoint(id, reason, new Date(clock.t).toISOString())); return true; },
      step: (a) => runInlineEthHistoryStep({ accountId: a.accountId, store, todayISO: a.todayISO, deps: a.deps, allowanceCalls: 1_000_000 }),
    };
    let result: EthHistoryResult | null = null;
    let runs = 0; let worstRunMs = 0;
    const boundaries: Array<number | null> = [];
    for (; runs < 80; runs++) {
      const t0 = clock.t;
      // No deadline from the caller (as wallet-history-refresh.ts): the entry point bounds it.
      result = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: false,
        deps: { transport: sim.transport, batchSize: 3, meter, now: () => clock.t } }, impl);
      worstRunMs = Math.max(worstRunMs, clock.t - t0);
      boundaries.push(store.cp()?.provenFromBlock ?? null);
      if (result.ok) break;
      clock.t += 6 * 3_600_000; // the next sync
    }
    const cp = store.cp()!;
    check("the wallet reaches COMPLETE after several bounded syncs (not one unbounded one)",
      !!result?.ok && result.mode === "FULL" && runs >= 1 && cp.completedAtISO !== null, `${runs + 1} run(s): ${result?.refusal} ${result?.reason}`);
    check("…every sync stayed inside its deadline (+ evidence for proven changes)", worstRunMs <= DEFAULT_ETH_INLINE_STEP_MS + 15_000, `${worstRunMs} ms`);
    check("…the boundary only ever moved DOWN (progress accumulated, never reset)",
      boundaries.filter((b): b is number => b !== null).every((b, i, a) => i === 0 || b <= a[i - 1]), boundaries.join(","));
    check("…the incremental path ran once (the fallback); every later sync took a step directly", incremental === 1, `${incremental}`);
    const w = store.writes;
    const finalWei = sim.stateAt(HEAD).balance;
    check("…ONE write, whose movements reconcile EXACTLY to the head balance in wei",
      w.length === 1 && w[0].anchorBalanceWei === finalWei && reconcileMovementsAgainstBalance(w[0].movements, finalWei).reconciles
        && w[0].movements.filter((m) => m.role === "FEE").length === 1 && w[0].movements.length === EVENTS.length + 1);
    check("…the licence starts at the provable floor", w[0]?.coverage.kind === "COMPLETE");
    check("ledger accuracy: every call the transport served was metered, and the checkpoint's usage says the same",
      meterTotal(meter) === sim.chain.calls && cp.usage?.requests === sim.chain.calls, `meter ${meterTotal(meter)} / served ${sim.chain.calls} / checkpoint ${cp.usage?.requests}`);
  }

  // ══ 3b. THE PREVIEW SHAPE — boundary below first activity, FEE stored ═════
  console.log("3b. a Preview-shaped checkpoint (FEE stored, boundary below first activity) closes in a couple of syncs");
  {
    // Walk (no early origin) until the boundary is below the first activity — as the 10-28 worker left it.
    const sim0 = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const st0 = new MemoryStore(queued());
    for (let i = 0; i < 200; i++) {
      await runEthHistoryBackfill({ accountId: "a1", store: st0, todayISO: TODAY }, { probeBudget: 200, now: () => Date.parse(NOW_ISO), eth: { transport: sim0.transport, earlyOrigin: false } });
      const c = st0.cp()!; if (c.provenFromBlock !== null && c.provenFromBlock < FIRST - 200_000) break;
    }
    const preview = st0.cp()!;
    check("the fixture matches Preview: FEE movement stored, boundary below first activity, not at the floor",
      preview.movements.some((m) => m.role === "FEE") && preview.provenFromBlock! < FIRST && !preview.reachedFloor);
    const sim = simulate({ events: EVENTS, head: HEAD + 600, headTimeSec: T_HEAD + 600 * 12 }); // the head moved on since
    const store = new MemoryStore(st0.cursor);
    const outcomes: string[] = [];
    let probes = 0;
    for (let i = 0; i < 4; i++) {
      const before = sim.chain.probed.length;
      const r = await runInlineEthHistoryStep({ accountId: "a1", store, todayISO: TODAY, allowanceCalls: 100_000,
        deps: { transport: sim.transport, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) + 60_000 } });
      probes += sim.chain.probed.length - before;
      outcomes.push(r.ok ? "COMPLETE" : String(r.refusal));
      if (r.ok) break;
    }
    check("the early-origin shortcut (K from the stored FEE) closes the backward proof, then the head gap, then writes — within 3 syncs",
      outcomes.at(-1) === "COMPLETE" && outcomes.length <= 3 && store.writes.length === 1, outcomes.join(" → "));
    check("…for a handful of probes, not ~1,800", probes < 200, `${probes} probes`);
  }

  // ══ 4. NO INLINE PATH WITHOUT A FINITE DEADLINE ═══════════════════════════
  console.log("4. no inline path reaches the acquisition without a finite deadline");
  {
    const T = 1_000_000;
    const b = boundedEthDeps(undefined, 60_000);
    check("boundedEthDeps: none ⇒ now + default", Number.isFinite(b.deadlineMs) && b.deadlineMs > Date.now() && b.deadlineMs <= Date.now() + 60_000);
    check("…an infinite one is replaced on the deps' own clock", boundedEthDeps({ deadlineMs: Infinity, now: () => T }, 5_000).deadlineMs === T + 5_000);
    check("…a caller's finite one is kept", boundedEthDeps({ deadlineMs: T + 1, now: () => T }, 5_000).deadlineMs === T + 1);
    check("the inline step is 60 s by default and clamped (never unbounded, never past 120 s)",
      ethInlineStepMs({}) === 60_000 && ethInlineStepMs({ ETH_INLINE_STEP_MS: "999999999" }) === 60_000 && ethInlineStepMs({ ETH_INLINE_STEP_MS: "Infinity" }) === 60_000
        && ethInlineStepMs({ ETH_INLINE_STEP_MS: "90000" }) === 90_000);
    const seen: Array<{ where: string; deadlineMs: unknown }> = [];
    const spy: EthSyncImpl = {
      reconstruct: async (a) => { seen.push({ where: "incremental", deadlineMs: a.deps?.deadlineMs }); return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED", fallbackReason: "NO_COVERAGE" }; },
      pending: async () => null, enqueue: async () => true,
      step: async (a) => { seen.push({ where: "step", deadlineMs: a.deps.deadlineMs }); return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_IN_PROGRESS" }; },
    };
    const t = Date.now();
    await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: false }, spy);
    await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: true }, spy);
    check("the sync entry point, called with NO deadline (as production), hands a finite one ≤ 120 s out to every path (incremental and step, worker on or off)",
      seen.length === 3 && seen.every((s) => typeof s.deadlineMs === "number" && Number.isFinite(s.deadlineMs) && s.deadlineMs <= t + 120_000 + 1_000),
      JSON.stringify(seen));
    const SYNC = code(read("lib", "crypto", "eth-history-sync.ts"));
    check("reconstructEthHistory hands its acquisitions the BOUNDED deps only (args.deps never reaches one)",
      /const deps = boundedEthDeps\(args\.deps, ethInlineStepMs\(\)\);/.test(SYNC) && (SYNC.match(/args\.deps/g) ?? []).length === 1);
    // Every production call of the worker step passes a deadline. (The store's
    // reconstructEthHistoryResumable forwards `args.deps` untouched; its one
    // caller is the job's `eth.reconstruct`, scanned here.)
    const callArgs = (src: string, callee: string): string[] => {
      const out: string[] = [];
      for (let i = src.indexOf(callee + "("); i >= 0; i = src.indexOf(callee + "(", i + 1)) {
        let depth = 0, j = i + callee.length;
        for (; j < src.length; j++) { if (src[j] === "(") depth++; else if (src[j] === ")" && --depth === 0) break; }
        out.push(src.slice(i, j + 1));
      }
      return out;
    };
    const sites = [
      ...callArgs(code(read("jobs", "sol-history-backfill.ts")), "eth.reconstruct"),
      ...callArgs(code(read("lib", "platform", "wallet-history-recovery.ts")), "runEthHistoryBackfill"),
      ...callArgs(code(read("lib", "crypto", "eth-history-backfill.store.ts")), "runEthHistoryBackfill"),
    ];
    const bare = sites.filter((c) => !/deadlineMs/.test(c) && !/^runEthHistoryBackfill\(\{ accountId: args\.accountId, store: bound\.store, todayISO: args\.todayISO, resume: args\.resume \}, args\.deps\)$/.test(c));
    check(`every production call of the worker step passes deadlineMs (${sites.length} call site(s))`, sites.length >= 4 && bare.length === 0, bare.join("\n---\n"));
  }

  // ══ 5. THE SHARED DAILY CAP ═══════════════════════════════════════════════
  console.log("5. the step's probes count against the shared daily cap");
  {
    const start = await partialCheckpoint(120);
    for (const [label, allowance] of [["spent", 0], ["unreadable", null]] as const) {
      const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
      const store = new MemoryStore(start);
      const r = await runInlineEthHistoryStep({ accountId: "a1", store, todayISO: TODAY, allowanceCalls: allowance,
        deps: { transport: sim.transport, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) + 60_000 } });
      check(`a ${label} allowance sends NOTHING and leaves the checkpoint untouched`, sim.chain.calls === 0 && store.cursor === start && r.refusal === "FULL_REBUILD_IN_PROGRESS", r.reason);
    }
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(start);
    const meter: Record<string, number> = {};
    await runInlineEthHistoryStep({ accountId: "a1", store, todayISO: TODAY, allowanceCalls: 400,
      deps: { transport: sim.transport, meter, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) + 60_000 } });
    const planned = inlineStepProbeBudget({ allowanceCalls: 400, msLeft: 60_000, cfg: CFG });
    check("a small allowance bounds the step's probes by the worker's own arithmetic (probeBudgetFor), so its calls fit the cap",
      planned === probeBudgetFor(400, CFG.probeBudget) && sim.chain.calls <= 400 && sim.chain.calls > 0, `planned ${planned}, sent ${sim.chain.calls}`);
    check("…and every call it sent is on the meter the ledger is flushed from", meterTotal(meter) === sim.chain.calls);
    const STORE = code(read("lib", "crypto", "eth-history-backfill.store.ts"));
    check("production reads the SHARED Alchemy ledger and the SOL worker's daily cap (one key, one budget)",
      /providerCallsOn\(args\.client, ALCHEMY_USAGE_PROVIDER, args\.todayISO\)/.test(STORE) && /workerConfig\(\)\.dailyRequestCap - spent/.test(STORE));
  }

  // ══ 6. A SHORT REQUEST NEVER RESETS A VALID CHECKPOINT ════════════════════
  console.log("6. a short request never resets, re-versions or demotes a valid checkpoint");
  {
    const start = await partialCheckpoint(300);
    const before = parseCheckpoint(start, "a1")!;
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const expired = new MemoryStore(start);
    await runInlineEthHistoryStep({ accountId: "a1", store: expired, todayISO: TODAY, allowanceCalls: 100_000,
      deps: { transport: sim.transport, now: () => Date.parse(NOW_ISO), deadlineMs: Date.parse(NOW_ISO) - 1 } });
    check("no time left: nothing sent, checkpoint byte-identical", expired.cursor === start && sim.chain.calls === 0);
    // Time for ~one probe: nothing closes — only the chunk halves (the worker's own remedy); the proof is kept.
    const clock = { t: Date.parse(NOW_ISO) };
    const slow = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD, clock, msPerCall: 1_000 });
    const tight = new MemoryStore(start);
    await runInlineEthHistoryStep({ accountId: "a1", store: tight, todayISO: TODAY, allowanceCalls: 100_000,
      deps: { transport: slow.transport, batchSize: 3, now: () => clock.t, deadlineMs: clock.t + 2_000 } });
    const after = tight.cp()!;
    check("a step too short to close a chunk keeps anchor, boundary, movements, version and generation",
      after.v === before.v && after.anchorBlock === before.anchorBlock && after.anchorBalanceWei === before.anchorBalanceWei
        && after.provenFromBlock === before.provenFromBlock && after.movements.length === before.movements.length
        && after.queuedAtISO === before.queuedAtISO && after.completedAtISO === null && after.reconcileFailures === before.reconcileFailures,
      JSON.stringify({ p: [before.provenFromBlock, after.provenFromBlock], chunk: [before.chunkBlocks, after.chunkBlocks] }));
  }

  // ══ 7. HONEST STATUS WITH THE WORKER OFF ══════════════════════════════════
  console.log("7. Connections states an incomplete ETH import with the worker off");
  {
    const start = await partialCheckpoint(120);
    const st = walletHistoryCheckpointStatus(null, start, TODAY);
    check("an incomplete ETH checkpoint reads IMPORTING (never complete, no licence claimed)",
      st?.chain === "ETH" && st.state === "IMPORTING" && st.historyFromISO === null);
    const words = historyImportText(st?.state, false);
    check("…in words that claim neither completion nor automatic background progress (worker off)",
      words?.text === "In progress" && words.tone === "progress" && !/automatic|complete/i.test(unprovenHistorySummary(st?.state, false, null)));
    const sd = code(read("lib", "connections", "space-data.ts"));
    check("space-data passes every chain's checkpoint status through — no ETH worker gate hides it",
      /const st = walletHistoryCheckpointStatus\(/.test(sd) && !/found\.chain !== "ETH"/.test(sd) && !/historyWorkerEnabledFor\("ETH"\)/.test(sd));
  }

  console.log(`\neth-history-inline-step: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

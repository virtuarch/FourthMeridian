/**
 * lib/crypto/eth-history-incremental.test.ts
 *
 * INCREMENTAL ETH HISTORY — reuse proven history only after verifying it, prove
 * only the suffix, write only what changed, and agree with a full rebuild.
 *
 * A simulated chain serves the real acquisition code; a fake store holds the
 * "persisted" rows. The full-rebuild reference is the same acquisition from the
 * provable floor, replayed through the same derivation the production full path
 * uses.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/eth-history-incremental.test.ts
 */

import { readFileSync } from "node:fs";
import { baseUnitsToWhole, reconcileMovementsAgainstOpening, type ChainCoverage } from "./chain-movement";
import {
  acquireEthHistory, provablyUnchanged, readAccountStateAt, EARLIEST_PROVABLE_BLOCK, ETH_HISTORY_SOURCE, WEI_PER_GWEI,
  type EthAccountState, type EthRpcTransport,
} from "./eth-history";
import { ETH_RECONSTRUCTION_VERSION, replayEthHistory, sameQuantity, earliestRowDifference } from "./eth-history-rows";
import { runIncrementalEthHistory, type EthHistoryStore, type StoredDerivedRow } from "./eth-history-incremental";
import { earliestImpactedFrom, planHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── A simulated chain (the same shape eth-history.test.ts uses) ─────────────
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);
const GAS = (gwei: number) => BigInt(21000) * BigInt(gwei) * WEI_PER_GWEI;
const OWNER = "0x000000000000000000000000000000000000abcd";
const OTHER = "0x0000000000000000000000000000000000001234";
interface SimEvent { block: number; delta: bigint; originated?: boolean; feeWei?: bigint; withdrawalWei?: bigint }

function simulate(opts: { events: readonly SimEvent[]; head: number; headTimeSec: number; failOn?: (method: string) => boolean; lieAt?: { block: number; afterReads: number } }) {
  const sorted = [...opts.events].sort((a, b) => a.block - b.block);
  const stateAt = (block: number): EthAccountState => {
    let balance = BigInt(0); let nonce = BigInt(0);
    for (const e of sorted) { if (e.block > block) break; balance += e.delta; if (e.originated) nonce += BigInt(1); }
    return { balance, nonce, code: "0x" };
  };
  const tsOf = (b: number) => BigInt(opts.headTimeSec + (b - opts.head) * 12);
  const stats = { requests: 0, calls: 0, minBlock: Number.POSITIVE_INFINITY };
  let balanceReadsAtLie = 0;
  type Row = { id: number; method: string; params: unknown[] };
  const transport: EthRpcTransport = async (body) => {
    const rows: Row[] = Array.isArray(body) ? (body as Row[]) : [body as Row];
    stats.requests++; stats.calls += rows.length;
    const out = rows.map((r) => {
      if (opts.failOn?.(r.method)) throw new Error(`simulated provider failure on ${r.method}`);
      const blockParam = r.method === "eth_getBlockByNumber" || r.method === "eth_getBlockReceipts" ? r.params[0] : r.params[1];
      const b = blockParam === "finalized" ? opts.head : Number(BigInt(blockParam as string));
      stats.minBlock = Math.min(stats.minBlock, b);
      const s = stateAt(b);
      if (r.method === "eth_getBalance") {
        let bal = s.balance;
        if (opts.lieAt && b === opts.lieAt.block && ++balanceReadsAtLie > opts.lieAt.afterReads) bal += BigInt(1);
        return { jsonrpc: "2.0", id: r.id, result: hex(bal) };
      }
      if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(s.nonce) };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: s.code };
      const ev = sorted.find((e) => e.block === b);
      if (r.method === "eth_getBlockByNumber") {
        return { jsonrpc: "2.0", id: r.id, result: { number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)),
          withdrawals: ev?.withdrawalWei ? [{ address: OWNER, amount: hex(ev.withdrawalWei / WEI_PER_GWEI) }] : [] } };
      }
      if (r.method === "eth_getBlockReceipts") {
        return { jsonrpc: "2.0", id: r.id, result: ev?.originated
          ? [{ from: OWNER, to: OTHER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }]
          : [] };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  return { transport, stats, stateAt };
}

const ACCOUNT = "acct_eth";
const INSTRUMENT = "inst_eth";
const HEAD1 = 26_000_000;
const T1 = Date.UTC(2026, 8, 12, 10, 0, 0) / 1000;        // head 1: 2026-09-12 10:00 UTC
const dateOfBlock = (b: number) => new Date((T1 + (b - HEAD1) * 12) * 1000).toISOString().slice(0, 10);
const HISTORY: SimEvent[] = [
  { block: HEAD1 - 3_000_000, delta: ETH(5) },
  { block: HEAD1 - 1_000_000, delta: -ETH(1) - GAS(20), originated: true, feeWei: GAS(20) },
  { block: HEAD1 - 200_000, delta: ETH(0.032), withdrawalWei: ETH(0.032) },
  { block: HEAD1 - 90_000, delta: ETH(0.25) },
];

const anchorFor = (quantity: number, todayISO: string) => ({
  observationId: "obs", dateISO: todayISO, effectiveDateTimeISO: `${todayISO}T00:00:00.000Z`,
  quantity, origin: "OBSERVED", completeness: "observed",
});

/** The full-rebuild reference: acquire from the provable floor, replay through the shared derivation. */
async function fullRebuild(events: SimEvent[], head: number) {
  const sim = simulate({ events, head, headTimeSec: T1 + (head - HEAD1) * 12 });
  const acq = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: head }, { transport: sim.transport });
  if (acq.coverage.kind !== "COMPLETE") throw new Error("reference acquisition not COMPLETE");
  const todayISO = acq.coverage.toISO;
  const { rows } = replayEthHistory({
    accountId: ACCOUNT, instrumentId: INSTRUMENT, anchor: anchorFor(baseUnitsToWhole(acq.anchorBalanceWei!, 18), todayISO),
    movements: acq.movements, coverage: acq.coverage, windowFromISO: acq.coverage.fromISO, windowToISO: todayISO,
  });
  return { rows, coverage: acq.coverage, todayISO, stats: sim.stats };
}

function fakeStore(seed: Awaited<ReturnType<typeof fullRebuild>>) {
  const rows = new Map<string, StoredDerivedRow>(seed.rows.map((r) => [r.dateISO,
    { dateISO: r.dateISO, quantity: r.quantity, completeness: r.basis, version: ETH_RECONSTRUCTION_VERSION }]));
  const cov = seed.coverage as Extract<ChainCoverage, { kind: "COMPLETE" }>;
  const state = {
    rows,
    coverage: { kind: "COMPLETE", coveredFromISO: cov.fromISO, coveredToISO: cov.toISO, source: ETH_HISTORY_SOURCE } as
      { kind: string; coveredFromISO: string | null; coveredToISO: string | null; source: string } | null,
    applies: 0, deleted: 0, inserted: 0, duplicates: 0,
  };
  const store: EthHistoryStore = {
    coverage: async () => state.coverage,
    derivedStats: async (_a, _i, from, to) => {
      const inRange = [...state.rows.values()].filter((r) => r.dateISO >= from && r.dateISO <= to);
      return { count: inRange.length, notCurrentVersion: inRange.filter((r) => r.version !== ETH_RECONSTRUCTION_VERSION).length };
    },
    derivedRow: async (_a, _i, d) => state.rows.get(d) ?? null,
    derivedRowsFrom: async (_a, _i, from) => [...state.rows.values()].filter((r) => r.dateISO >= from).sort((x, y) => x.dateISO.localeCompare(y.dateISO)),
    anchor: async () => null,
    applySuffix: async ({ deleteDatesISO, insert, coverage }) => {
      state.applies++;
      for (const d of deleteDatesISO) if (state.rows.delete(d)) state.deleted++;
      for (const r of insert) {
        if (state.rows.has(r.dateISO)) { state.duplicates++; continue; }   // skipDuplicates
        state.rows.set(r.dateISO, { dateISO: r.dateISO, quantity: r.quantity, completeness: r.basis, version: ETH_RECONSTRUCTION_VERSION });
        state.inserted++;
      }
      if (coverage.kind === "COMPLETE") state.coverage = { kind: "COMPLETE", coveredFromISO: coverage.fromISO, coveredToISO: coverage.toISO, source: coverage.source };
    },
  };
  return { store, state };
}

async function incremental(events: SimEvent[], head: number, s: ReturnType<typeof fakeStore>, sim?: ReturnType<typeof simulate>) {
  const chain = sim ?? simulate({ events, head, headTimeSec: T1 + (head - HEAD1) * 12 });
  const todayISO = dateOfBlock(head);
  s.store.anchor = async () => ({ id: "obs", date: new Date(`${todayISO}T00:00:00.000Z`), origin: "OBSERVED", completeness: "observed" });
  const outcome = await runIncrementalEthHistory({
    accountId: ACCOUNT, walletAddress: OWNER, instrumentId: INSTRUMENT, todayISO, store: s.store, deps: { transport: chain.transport },
  });
  return { outcome, stats: chain.stats, todayISO };
}

const snapshot = (m: Map<string, StoredDerivedRow>) => JSON.stringify([...m.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO)));

async function main() {
  console.log("0. pure pieces");
  {
    const m = (d: bigint) => ({ networkId: "n", eventId: "e", movementKey: "k", assetKey: "a", ownedAddress: OWNER,
      baseUnitsDelta: d, role: "TRANSFER" as const, occurredAtISO: null, dateISO: "2026-09-12", timeBasis: "BLOCK_TIME" as const,
      failed: false, counterparties: [], sequence: 1, source: "s" });
    check("opening + Σ movements = anchor reconciles exactly in wei",
      reconcileMovementsAgainstOpening([m(ETH(1)), m(-GAS(3))], ETH(2), ETH(3) - GAS(3)).reconciles);
    check("…one wei off does not", !reconcileMovementsAgainstOpening([m(ETH(1))], ETH(2), ETH(3) + BigInt(1)).reconciles);
    check("…and a missing opening never reconciles", !reconcileMovementsAgainstOpening([], null, ETH(1)).reconciles);
    check("canonical quantity equality tolerates float representation only",
      sameQuantity(0.000831130959461841, 0.000831130959461847) && !sameQuantity(1.0, 1.000001));
    check("earliest row difference finds the first changed, added or removed date",
      earliestRowDifference([{ dateISO: "2026-09-10", quantity: 1 }, { dateISO: "2026-09-11", quantity: 1 }],
        [{ dateISO: "2026-09-10", quantity: 1 }, { dateISO: "2026-09-11", quantity: 2 }]) === "2026-09-11"
      && earliestRowDifference([{ dateISO: "2026-09-10", quantity: 1 }], [{ dateISO: "2026-09-10", quantity: 1 }]) === null);
  }

  const base = await fullRebuild(HISTORY, HEAD1);
  console.log(`\n(reference full rebuild: ${base.rows.length} rows, ${base.stats.requests} requests, coverage ${JSON.stringify(base.coverage)})`);

  console.log("\nA. no new events, six hours later (same day)");
  {
    const s = fakeStore(base);
    const before = snapshot(s.state.rows);
    const { outcome, stats } = await incremental(HISTORY, HEAD1 + 1_800, s);
    const r = outcome.kind === "DONE" ? outcome.result : null;
    check("incremental, NO_CHANGE, nothing historical changed", r?.mode === "NO_CHANGE" && r.impactedFromISO === null, JSON.stringify(outcome).slice(0, 200));
    check("no write at all: the rows and coverage already say this", s.state.applies === 0 && snapshot(s.state.rows) === before);
    check(`bounded RPC work (${stats.requests} requests, ${stats.calls} calls) — vs ${base.stats.requests} for the full rebuild`,
      stats.requests <= 30 && stats.requests * 10 < base.stats.requests);
    check("no genesis scan: nothing below the day before the boundary was read", stats.minBlock > HEAD1 - 10_000, String(stats.minBlock));
  }

  console.log("\nA2. no new events, next day");
  {
    const s = fakeStore(base);
    const prefix = snapshot(new Map([...s.state.rows].filter(([d]) => d < "2026-09-12")));
    const { outcome } = await incremental(HISTORY, HEAD1 + 7_200, s);
    const r = outcome.kind === "DONE" ? outcome.result : null;
    check("NO_CHANGE with exactly one new day written, coverage extended, no impact",
      r?.mode === "NO_CHANGE" && r.rowsChanged === 1 && s.state.inserted === 1 && s.state.deleted === 0
        && s.state.coverage?.coveredToISO === "2026-09-13" && r.impactedFromISO === null);
    check("pre-boundary history untouched", snapshot(new Map([...s.state.rows].filter(([d]) => d < "2026-09-12"))) === prefix);
  }

  const APPENDED: SimEvent[] = [...HISTORY, { block: HEAD1 + 5_000, delta: -ETH(0.4) - GAS(15), originated: true, feeWei: GAS(15) }];
  const HEAD2 = HEAD1 + 14_400;
  console.log("\nB/I. a movement after the boundary — and agreement with a full rebuild");
  {
    const s = fakeStore(base);
    const prefix = snapshot(new Map([...s.state.rows].filter(([d]) => d < "2026-09-12")));
    const { outcome, stats } = await incremental(APPENDED, HEAD2, s);
    const r = outcome.kind === "DONE" ? outcome.result : null;
    const movementDay = dateOfBlock(HEAD1 + 5_000);
    check("INCREMENTAL finds the movement and reconciles it", r?.mode === "INCREMENTAL" && r.reconciliation?.movementCount === 2
      && r.reconciliation.residualWei === "0", JSON.stringify(outcome).slice(0, 240));
    check(`impact starts at the movement's day (${movementDay})`, r?.impactedFromISO === movementDay);
    check("pre-boundary rows untouched", snapshot(new Map([...s.state.rows].filter(([d]) => d < "2026-09-12"))) === prefix);
    check("coverage advances to the new head, keeping its original floor",
      s.state.coverage?.coveredToISO === dateOfBlock(HEAD2)
        && s.state.coverage.coveredFromISO === (base.coverage as { fromISO: string }).fromISO);
    check(`RPC stays small with a change (${stats.requests} requests)`, stats.requests <= 80);

    const reference = await fullRebuild(APPENDED, HEAD2);
    const stored = [...s.state.rows.values()];
    const refByDate = new Map(reference.rows.map((x) => [x.dateISO, x]));
    const quantityMismatch = stored.filter((x) => !refByDate.has(x.dateISO) || !sameQuantity(refByDate.get(x.dateISO)!.quantity, x.quantity));
    check(`I. identical canonical quantities on every one of ${reference.rows.length} days (full rebuild vs incremental)`,
      stored.length === reference.rows.length && quantityMismatch.length === 0, JSON.stringify(quantityMismatch.slice(0, 3)));
    const suffixBasisMismatch = stored.filter((x) => x.dateISO >= "2026-09-12" && refByDate.get(x.dateISO)?.basis !== x.completeness);
    check("…and the same basis label on the rewritten suffix", suffixBasisMismatch.length === 0, JSON.stringify(suffixBasisMismatch.slice(0, 3)));

    console.log("\nC. overlapping replay of already-known activity");
    s.state.coverage = { ...s.state.coverage!, coveredToISO: "2026-09-12" };   // pretend the boundary is back before the movement
    const again = await incremental(APPENDED, HEAD2, s);
    const ra = again.outcome.kind === "DONE" ? again.outcome.result : null;
    check("the replay re-finds the movement but writes nothing and duplicates nothing",
      ra?.rowsChanged === 0 && s.state.duplicates === 0 && stored.length === s.state.rows.size, JSON.stringify(again.outcome).slice(0, 200));
    const third = await incremental(APPENDED, HEAD2, s);
    check("…and a normal next run from the advanced boundary is NO_CHANGE", third.outcome.kind === "DONE" && third.outcome.result.mode === "NO_CHANGE");
  }

  console.log("\nD–H. falling back to the full rebuild — and refusing without writing");
  {
    const fb = async (mutate: (s: ReturnType<typeof fakeStore>) => void, expect: string, events = HISTORY, head = HEAD1 + 7_200, sim?: ReturnType<typeof simulate>) => {
      const s = fakeStore(base); mutate(s);
      const before = snapshot(s.state.rows);
      const { outcome } = await incremental(events, head, s, sim);
      const got = outcome.kind === "FALLBACK" ? outcome.reason : outcome.kind;
      check(`${expect}`, got === expect && s.state.applies === 0 && snapshot(s.state.rows) === before, `${got} ${JSON.stringify(outcome).slice(0, 160)}`);
    };
    await fb((s) => { s.state.coverage = null; }, "NO_COVERAGE");
    await fb((s) => { s.state.coverage = { ...s.state.coverage!, kind: "PARTIAL" }; }, "COVERAGE_INCOMPLETE");
    await fb((s) => { s.state.coverage = { ...s.state.coverage!, source: "solana:getSignaturesForAddress" }; }, "COVERAGE_SOURCE");
    await fb((s) => { s.state.coverage = { ...s.state.coverage!, coveredFromISO: "2026-09-12", coveredToISO: "2026-09-12" }; }, "NO_CHECKPOINT_ROW");
    await fb((s) => { s.state.rows.delete("2024-01-15"); }, "HISTORY_GAP");
    await fb((s) => { s.state.rows.get("2025-06-01")!.version = null; }, "VERSION_MISMATCH");
    await fb((s) => { s.state.rows.get("2026-09-11")!.quantity += 0.5; }, "CHECKPOINT_MISMATCH");
    const resumeBlock = HEAD1 - Math.ceil(10 * 3600 / 12) - 1;
    const lying = simulate({ events: HISTORY, head: HEAD1 + 7_200, headTimeSec: T1 + 7_200 * 12, lieAt: { block: resumeBlock, afterReads: 1 } });
    await fb(() => {}, "RECONCILIATION_MISMATCH", HISTORY, HEAD1 + 7_200, lying);

    const failing = simulate({ events: APPENDED, head: HEAD2, headTimeSec: T1 + 14_400 * 12, failOn: (m) => m === "eth_getBlockReceipts" });
    const s = fakeStore(base);
    const before = snapshot(s.state.rows);
    const { outcome } = await incremental(APPENDED, HEAD2, s, failing);
    check("G. a provider failure mid-acquisition is a REFUSAL: old history and coverage stay exactly as they were",
      outcome.kind === "REFUSED" && outcome.refusal === "COVERAGE_UNLICENSED" && s.state.applies === 0
        && snapshot(s.state.rows) === before && s.state.coverage?.coveredToISO === "2026-09-12", JSON.stringify(outcome).slice(0, 160));
  }

  console.log("\nSAME ENDING BALANCE, REAL ACTIVITY");
  {
    const netZero: SimEvent[] = [...HISTORY, { block: HEAD1 + 5_000, delta: BigInt(0), originated: true, feeWei: GAS(30) }];
    const sim = simulate({ events: netZero, head: HEAD2, headTimeSec: T1 + 14_400 * 12 });
    const opening = await readAccountStateAt(OWNER, HEAD1, { transport: sim.transport });
    const closing = await readAccountStateAt(OWNER, HEAD2, { transport: sim.transport });
    check("the balance is unchanged, but the nonce moved — so the interval is NOT provably empty",
      opening.balance === closing.balance && !provablyUnchanged(opening, closing));
    const s = fakeStore(base);
    const { outcome } = await incremental(netZero, HEAD2, s);
    const r = outcome.kind === "DONE" ? outcome.result : null;
    check("the activity is found (fee + offsetting transfer), reconciles, and is reported as an impact",
      r?.mode === "INCREMENTAL" && r.reconciliation?.movementCount === 2 && r.impactedFromISO === dateOfBlock(HEAD1 + 5_000),
      JSON.stringify(outcome).slice(0, 200));
  }

  console.log("\nWEALTH-HISTORY REGENERATION BOUNDARY");
  {
    check("the reconstruction boundary joins the measured evidence (earliest wins)",
      earliestImpactedFrom("2026-09-10", "2026-09-05") === "2026-09-05" && earliestImpactedFrom(null, "2026-09-05") === "2026-09-05"
        && earliestImpactedFrom("2026-09-10", null) === "2026-09-10" && earliestImpactedFrom(null, undefined) === null);
    const plan = (impactedFromISO: string | null) => planHistoricalWorkWindow({
      evidenceFloorISO: "2017-10-16", blockingPriceFloorISO: "2025-09-14", writableToISO: "2026-09-12",
      recentFromISO: "2026-08-13", initialBuild: false, changeDetection: "measured", impactedFromISO,
    });
    check("a position change at D regenerates from D", plan("2026-06-01").fromDate === "2026-06-01" && plan("2026-06-01").historicalWorkRequired);
    check("no position change regenerates only the recent window", plan(null).fromDate === "2026-08-13" && !plan(null).historicalWorkRequired);
    const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("the scheduled job passes the sweep's reconstruction boundary to the ONE planner",
      /positionHistoryImpactedFromISO: result\.historyImpactedFromISO/.test(code("jobs/sync-crypto.ts")));
    check("…the manual route passes its own", /positionHistoryImpactedFromISO: result\.historyRefresh\?\.impactedFromISO/.test(code("app/api/accounts/[id]/sync/route.ts")));
    check("…the binding merges it into measured change only", /earliestImpactedFrom\(impactedFromISO, args\.positionHistoryImpactedFromISO\)/.test(code("lib/snapshots/historical-work-window.ts")));
    check("…and it travels from the reconstruction through the refresh and the sweep",
      /impactedFromISO: result\.impactedFromISO \?\? null/.test(code("lib/crypto/wallet-history-refresh.ts"))
        && /outcome\.historyRefresh\?\.impactedFromISO/.test(code("lib/crypto/wallet-refresh.ts")));
  }

  console.log("\nBOUNDARIES");
  {
    const inc = readFileSync("lib/crypto/eth-history-incremental.ts", "utf8");
    const rows = readFileSync("lib/crypto/eth-history-rows.ts", "utf8");
    const sync = readFileSync("lib/crypto/eth-history-sync.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("native ETH only: no token calls, and the limit is stated where the proof is reused",
      !/eth_call|balanceOf|erc-?20.*support/i.test(inc.replace(/\/\*[\s\S]*?\*\//g, "")) && /NATIVE ETH ONLY/.test(inc) && /NATIVE ETH ONLY/.test(rows));
    check("no index shortcut replaces the proof", !/getAssetTransfers/i.test(inc));
    check("an explicit full rebuild skips the incremental path", /if \(!args\.full\)/.test(sync) && /"EXPLICIT_FULL"/.test(sync));
    check("the full path stamps every row with the reconstruction version",
      /reconstructionVersion: ETH_RECONSTRUCTION_VERSION/.test(sync));
    check("the incremental path writes the same version, in one transaction with the coverage",
      /reconstructionVersion: ETH_RECONSTRUCTION_VERSION/.test(inc) && /\$transaction\(async \(tx\)[\s\S]*persistPositionCoverage\(tx/.test(inc));
    check("BNB/AVAX are not reconstructed", /key === ETH_NATIVE\.chain \? reconstructEthHistory/.test(readFileSync("lib/crypto/wallet-history-refresh.ts", "utf8"))
      && !/BNB|AVAX/.test(inc.replace(/\/\*[\s\S]*?\*\//g, "")));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

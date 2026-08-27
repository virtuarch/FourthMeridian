/**
 * lib/crypto/eth-history.test.ts
 *
 * ETH-H1 — native ETH historical acquisition: the acceptance suite.
 *
 *     npx tsx lib/crypto/eth-history.test.ts
 *
 * Deterministic and fully offline. Every RPC response is served by a SIMULATED
 * CHAIN — a fixture that answers `eth_getBalance` / `eth_getTransactionCount` /
 * `eth_getCode` for any block from a declared event list, exactly as an archive
 * node would. That shape is chosen deliberately: the thing under test is a
 * SEARCH over chain state, so a per-call fixture table would only prove the
 * search visits the blocks the fixture anticipated. A simulated chain lets the
 * search be wrong.
 *
 * ── WHAT THIS DOES AND DOES NOT PROVE ────────────────────────────────────────
 * It proves the implementation: the emptiness proof, the enumeration's
 * exhaustiveness against an oracle that knows every change block, the exact wei
 * decomposition, the refusals, and the bridge into the canonical replay.
 *
 * It is NOT real-wallet verification. Doctrine invariant 45 requires that
 * separately, and it was performed against mainnet during ETH-H1 — see the
 * investigation report. No ETH wallet exists in this deployment, so it cannot be
 * automated here.
 */

import {
  provablyUnchanged, isPlainEoa, movementsForBlock, blockEvidence,
  blockTimeToDateISO, blockTimeToInstantISO, acquireEthHistory, callBatch,
  EARLIEST_PROVABLE_BLOCK, ETH_HISTORY_SOURCE, ETHEREUM_NETWORK_ID, WEI_PER_GWEI,
  EthThrottleError, callBatchWithBackoff,
  type EthAccountState, type EthRpcTransport,
} from "./eth-history";
import {
  reconcileMovementsAgainstBalance, toEventStreamCompleteness,
  movementsToQuantityEvents, describeCoverage,
} from "./chain-movement";
import { resolveLicensedQuantityAsOf } from "./position-coverage";
import { derivedRowsFromTimeline } from "./wallet-reconstruction";
import { replayQuantityTimeline } from "@/lib/investments/quantity-replay.core";
import { ETH_NATIVE, ledgerEpsilonFor } from "./native-asset";
import { weiToEth } from "./eth-rpc";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);
/** An exact gas cost: 21000 gas at `gwei`. Divisible by the gas used, so the
 *  simulated receipt reproduces it EXACTLY — a fixture whose fee did not divide
 *  evenly would manufacture a residual and test the arithmetic's rounding
 *  instead of the decomposition. */
const GAS = (gwei: number) => BigInt(21000) * BigInt(gwei) * WEI_PER_GWEI;

const OWNER = "0x000000000000000000000000000000000000abcd";
const OTHER = "0x0000000000000000000000000000000000001234";

// ── A SIMULATED CHAIN ────────────────────────────────────────────────────────

/** One thing that happened to the address at a block. */
interface SimEvent {
  block: number;
  /** Signed wei delta. */
  delta: bigint;
  /** Did the address ORIGINATE a transaction here? Then its nonce increments. */
  originated?: boolean;
  /** Gas the address paid, in wei. Only meaningful with `originated`. */
  feeWei?: bigint;
  /** Validator withdrawal credited in this block, in wei. */
  withdrawalWei?: bigint;
  /** The address's own transaction reverted. */
  reverted?: boolean;
}

interface SimOpts {
  genesisBalance: bigint;
  genesisNonce: number;
  /** Non-"0x" makes the address a contract / delegated EOA from `codeFrom` on. */
  code?: string;
  codeFrom?: number;
  events: readonly SimEvent[];
  /** Blocks are 12s apart from this UTC instant at block `base`. */
  base: number;
  baseTimeSec: number;
}

function simulate(opts: SimOpts) {
  const sorted = [...opts.events].sort((a, b) => a.block - b.block);
  const stateAt = (block: number): EthAccountState => {
    let balance = opts.genesisBalance;
    let nonce = BigInt(opts.genesisNonce);
    for (const e of sorted) {
      if (e.block > block) break;
      balance += e.delta;
      if (e.originated) nonce += BigInt(1);
    }
    const code = opts.code && block >= (opts.codeFrom ?? 0) ? opts.code : "0x";
    return { balance, nonce, code };
  };
  const tsOf = (b: number) => BigInt(opts.baseTimeSec + (b - opts.base) * 12);

  let reads = 0;
  interface RpcRow { id: number; method: string; params: unknown[] }
  const transport: EthRpcTransport = async (body) => {
    const rows: RpcRow[] = Array.isArray(body) ? body as RpcRow[] : [body as RpcRow];
    const out = rows.map((r) => {
      reads++;
      const m = r.method as string;
      if (m === "eth_getBalance")          return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(Number(BigInt(r.params[1] as string))).balance) };
      if (m === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(Number(BigInt(r.params[1] as string))).nonce) };
      if (m === "eth_getCode")             return { jsonrpc: "2.0", id: r.id, result: stateAt(Number(BigInt(r.params[1] as string))).code };
      if (m === "eth_getBlockByNumber") {
        const b = r.params[0] === "finalized" ? opts.base : Number(BigInt(r.params[0] as string));
        const ev = sorted.find((e) => e.block === b);
        return { jsonrpc: "2.0", id: r.id, result: {
          number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)),
          withdrawals: ev?.withdrawalWei
            ? [{ address: OWNER, amount: hex(ev.withdrawalWei / WEI_PER_GWEI) }]
            : [],
        } };
      }
      if (m === "eth_getBlockReceipts") {
        const b = Number(BigInt(r.params[0] as string));
        const ev = sorted.find((e) => e.block === b);
        const receipts = ev?.originated
          ? [{ from: OWNER, to: OTHER, status: ev.reverted ? "0x0" : "0x1",
               gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }]
          : [];
        return { jsonrpc: "2.0", id: r.id, result: receipts };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${m}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  // Every block where SOMETHING moved — including one whose NET delta is zero.
  // A block with a nonce change moved value even when the endpoints agree.
  return { transport, stateAt, changeBlocks: sorted.filter((e) => e.delta !== BigInt(0) || e.originated).map((e) => e.block), reads: () => reads };
}

async function main() {
  // ── 1. THE EMPTINESS PREDICATE ────────────────────────────────────────────
  const eoa = (bal: bigint, nonce: number): EthAccountState => ({ balance: bal, nonce: BigInt(nonce), code: "0x" });
  const contract = (bal: bigint, nonce: number): EthAccountState => ({ balance: bal, nonce: BigInt(nonce), code: "0x60" });

  check("equal balance + equal nonce + empty code ⇒ provably unchanged",
    provablyUnchanged(eoa(ETH(1), 5), eoa(ETH(1), 5)));
  check("a DIFFERENT balance is never provably unchanged",
    !provablyUnchanged(eoa(ETH(1), 5), eoa(ETH(2), 5)));
  check("EQUAL BALANCES WITH A CHANGED NONCE PROVE NOTHING — the cancelling-pair hazard",
    !provablyUnchanged(eoa(ETH(1), 5), eoa(ETH(1), 6)),
    "an origination means a debit happened, so equal endpoints no longer imply a constant interval");
  check("a CONTRACT (or 7702-delegated) account can never be proven unchanged",
    !provablyUnchanged(contract(ETH(1), 5), contract(ETH(1), 5)));
  check("isPlainEoa is exactly code === \"0x\"",
    isPlainEoa(eoa(ETH(1), 0)) && !isPlainEoa(contract(ETH(1), 0)) &&
    !isPlainEoa({ balance: BigInt(0), nonce: BigInt(0), code: "0xef0100aa" }));

  // ── 2. BATCH RESPONSES ARE RE-KEYED BY id, NOT BY POSITION ────────────────
  const shuffling: EthRpcTransport = async (body) => {
    const rows = (body as Array<{ id: number }>).map((r) => ({ jsonrpc: "2.0", id: r.id, result: hex(r.id * 10) }));
    return JSON.stringify(rows.reverse());
  };
  const rekeyed = await callBatch(
    [0, 1, 2, 3].map(() => ({ method: "eth_getBalance", params: [OWNER, "latest"] })), shuffling);
  check("a batch answered OUT OF ORDER is re-keyed by id, never by position",
    JSON.stringify(rekeyed) === JSON.stringify(["0x0", "0xa", "0x14", "0x1e"]),
    JSON.stringify(rekeyed));

  const short: EthRpcTransport = async () => JSON.stringify([{ jsonrpc: "2.0", id: 0, result: "0x1" }]);
  let shortThrew = false;
  try { await callBatch([{ method: "eth_getBalance", params: [] }, { method: "eth_getBalance", params: [] }], short); }
  catch { shortThrew = true; }
  check("a batch that answers FEWER calls than it was asked is a failure, not a partial success", shortThrew);

  // ── 3. THROTTLING IS RETRIED, NOTHING ELSE IS ─────────────────────────────
  let attempts = 0;
  const flaky: EthRpcTransport = async () => {
    attempts++;
    if (attempts < 3) return JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: 429, message: "capacity" } });
    return JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x2a" });
  };
  const backed = await callBatchWithBackoff([{ method: "eth_getBalance", params: [] }], flaky, { retries: 5, sleepImpl: async () => {} });
  check("a 429 is retried with backoff and then succeeds", backed[0] === "0x2a" && attempts === 3);

  let tierAttempts = 0;
  const tierRefusal: EthRpcTransport = async () => {
    tierAttempts++;
    return JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32600, message: "trace_block is not available on the Free tier" } });
  };
  let tierThrew = false;
  try { await callBatchWithBackoff([{ method: "trace_block", params: [] }], tierRefusal, { retries: 5, sleepImpl: async () => {} }); }
  catch (e) { tierThrew = !(e instanceof EthThrottleError); }
  check("a TIER REFUSAL is not retried — it would fail identically", tierThrew && tierAttempts === 1);

  // ── 4. EXHAUSTIVE ENUMERATION AGAINST AN ORACLE ───────────────────────────
  // A wallet with everything at once: withdrawals no index can see, an inbound
  // transfer, an outbound transfer with gas, and a REVERTED transaction that
  // still cost gas. Blocks are spread so the search cannot stumble onto them.
  const BASE = 26_000_000;
  const T0 = Date.UTC(2026, 7, 1, 0, 0, 0) / 1000;
  const sim = simulate({
    genesisBalance: ETH(10), genesisNonce: 3, base: BASE, baseTimeSec: T0,
    events: [
      { block: BASE - 47_311, delta: ETH(0.032),  withdrawalWei: ETH(0.032) },
      { block: BASE - 39_002, delta: ETH(2),                                  },
      { block: BASE - 39_001, delta: -ETH(1.5) - GAS(50), originated: true, feeWei: GAS(50) },
      { block: BASE - 20_000, delta: -GAS(19), originated: true, feeWei: GAS(19), reverted: true },
      { block: BASE - 13,     delta: ETH(0.031),  withdrawalWei: ETH(0.031) },
      // THE SHARPEST CASE: an inbound transfer that exactly offsets the gas the
      // address paid in the same block. NET DELTA IS ZERO, so a search that
      // pruned on balance alone would declare the interval empty and lose both
      // movements. The nonce condition is what catches it.
      { block: BASE - 9_997,  delta: BigInt(0), originated: true, feeWei: GAS(30) },
    ],
  });
  const acq = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 50_000, toBlock: BASE },
    { transport: sim.transport, chunkBlocks: 50_000 },
  );

  check("every balance-changing block is found — none hides between probes",
    JSON.stringify(acq.changeBlocks) === JSON.stringify(sim.changeBlocks),
    `found ${JSON.stringify(acq.changeBlocks)} want ${JSON.stringify(sim.changeBlocks)}`);
  check("coverage is COMPLETE when the proof closed over the whole window",
    acq.coverage.kind === "COMPLETE", describeCoverage(acq.coverage));
  check("the licence runs to the ANCHOR block, not to the newest movement",
    acq.coverage.kind === "COMPLETE" && acq.coverage.toISO === blockTimeToDateISO(BigInt(T0)));
  check("the cursor records that the requested window start was reached",
    acq.cursor.reachedWindowStart && acq.cursor.provenFromBlock === BASE - 50_000);

  // ── 5. EXACT WEI RECONCILIATION ───────────────────────────────────────────
  const windowChange = (acq.anchorBalanceWei ?? BigInt(0)) - (acq.openingBalanceWei ?? BigInt(0));
  const recon = reconcileMovementsAgainstBalance(acq.movements, windowChange);
  check("Σ movements equals the window's exact wei change, with ZERO residual",
    recon.reconciles && recon.residual === BigInt(0),
    `residual ${recon.residual}`);
  check("wei arithmetic never passes through a float — the residual is a BigInt",
    typeof recon.residual === "bigint" && typeof acq.anchorBalanceWei === "bigint");

  // ── 6. MECHANICAL DECOMPOSITION ───────────────────────────────────────────
  const roles = acq.movements.reduce<Record<string, number>>((a, m) => ({ ...a, [m.role]: (a[m.role] ?? 0) + 1 }), {});
  check("a validator withdrawal is a REWARD, read from the BLOCK HEADER",
    roles.REWARD === 2, JSON.stringify(roles));
  check("gas is a FEE, split out of the block delta exactly as Solana splits its fee payer",
    roles.FEE === 3, JSON.stringify(roles));
  const zeroNet = acq.movements.filter((m) => m.sequence === BASE - 9_997);
  check("A BLOCK WHOSE NET DELTA IS ZERO IS STILL FOUND — the nonce condition catches it",
    acq.changeBlocks.includes(BASE - 9_997),
    "balance-only pruning would have declared this interval empty and lost both movements");
  check("that block yields BOTH the fee and the inflow that offset it, summing to zero",
    zeroNet.length === 2 &&
    zeroNet.reduce((s, m) => s + m.baseUnitsDelta, BigInt(0)) === BigInt(0) &&
    zeroNet.some((m) => m.role === "FEE") && zeroNet.some((m) => m.role === "TRANSFER"),
    JSON.stringify(zeroNet.map((m) => [m.role, String(m.baseUnitsDelta)])));

  check("a REVERTED transaction yields a FEE and NO transfer — the cost was real, the movement was not",
    acq.movements.filter((m) => m.sequence === BASE - 20_000).every((m) => m.role === "FEE") &&
    acq.movements.filter((m) => m.sequence === BASE - 20_000).length === 1);
  check("the withdrawal amount is converted from GWEI, not taken as wei",
    acq.movements.filter((m) => m.role === "REWARD").every((m) => m.baseUnitsDelta === ETH(0.032) || m.baseUnitsDelta === ETH(0.031)));
  check("every movement carries the CAIP-2 network and canonical assetKey, never a ticker",
    acq.movements.every((m) => m.networkId === ETHEREUM_NETWORK_ID && m.assetKey === ETH_NATIVE.assetKey));
  check("the adapter stamps its own provenance",
    acq.movements.every((m) => m.source === ETH_HISTORY_SOURCE));
  check("a block timestamp is BLOCK_TIME, not a validator estimate",
    acq.movements.every((m) => m.timeBasis === "BLOCK_TIME"));
  check("the chain event identity is the BLOCK HASH — this evidence is a block's state transition",
    acq.movements.every((m) => m.eventId.startsWith("0xblock")));
  check("no movement carries a financial classification",
    acq.movements.every((m) => !("flowType" in m) && !("category" in m) && !("merchant" in m)));

  // ── 7. THE PROOF'S REFUSALS ───────────────────────────────────────────────
  const contractSim = simulate({
    genesisBalance: ETH(5), genesisNonce: 1, base: BASE, baseTimeSec: T0,
    code: "0x6080604052", codeFrom: 0,
    events: [{ block: BASE - 100, delta: ETH(1) }],
  });
  const contractAcq = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 1000, toBlock: BASE },
    { transport: contractSim.transport },
  );
  check("A CONTRACT ACCOUNT IS REFUSED — no state read can prove an interval empty for it",
    contractAcq.coverage.kind === "UNKNOWN" && contractAcq.movements.length === 0,
    describeCoverage(contractAcq.coverage));

  const delegated = simulate({
    genesisBalance: ETH(5), genesisNonce: 1, base: BASE, baseTimeSec: T0,
    code: "0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d", codeFrom: 0,
    events: [{ block: BASE - 100, delta: ETH(1) }],
  });
  const delegatedAcq = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 1000, toBlock: BASE },
    { transport: delegated.transport },
  );
  check("AN EIP-7702 DELEGATED EOA IS REFUSED for the same reason — code can spend it",
    delegatedAcq.coverage.kind === "UNKNOWN" && delegatedAcq.movements.length === 0);

  const dark = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 1000, toBlock: BASE }, { rpcUrl: null });
  check("NO PROVIDER is UNKNOWN, never an empty history",
    dark.coverage.kind === "UNKNOWN" &&
    dark.coverage.caveats.includes("NO_PROVIDER_CONFIGURED") && dark.movements.length === 0);

  const starved = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 50_000, toBlock: BASE },
    { transport: sim.transport, probeBudget: 8, chunkBlocks: 50_000 },
  );
  check("A RUN THAT PROVED NOTHING LICENSES NOTHING and says why",
    starved.coverage.kind === "UNKNOWN" &&
    starved.coverage.caveats.includes("PAGE_BUDGET_EXHAUSTED") &&
    starved.movements.length === 0,
    describeCoverage(starved.coverage));

  // A run that completed SOME chunks and then ran out. The chunks it closed are
  // proven; the ones it never reached are simply outside the licence.
  const partial = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: BASE - 50_000, toBlock: BASE },
    { transport: sim.transport, probeBudget: 40, chunkBlocks: 10_000 },
  );
  check("a run that closed SOME chunks licenses exactly those — a smaller claim, not a weaker one",
    partial.coverage.kind === "COMPLETE" &&
    partial.cursor.provenFromBlock !== null &&
    partial.cursor.provenFromBlock > BASE - 50_000 &&
    !partial.cursor.reachedWindowStart,
    `${describeCoverage(partial.coverage)} provenFrom=${partial.cursor.provenFromBlock}`);
  check("and the cursor records WHY it stopped, so a caller can resume",
    partial.cursor.stoppedBecause === "PROBE_BUDGET", String(partial.cursor.stoppedBecause));
  check("a truncated run discards the chunk it was in the middle of, never keeping half a proof",
    partial.changeBlocks.every((b) => b >= partial.cursor.provenFromBlock!));

  const deep = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: 1_000_000, toBlock: 1_500_000 }, { transport: sim.transport });
  check("a window entirely before Byzantium is refused — the proof's premises do not hold there",
    deep.coverage.kind === "UNKNOWN" && deep.coverage.caveats.includes("ARCHIVE_DEPTH_LIMIT"),
    describeCoverage(deep.coverage));

  const clamped = await acquireEthHistory(
    { ownerAddress: OWNER, fromBlock: 1_000_000, toBlock: BASE },
    { transport: sim.transport, chunkBlocks: 30_000_000 },
  );
  check("a window that STRADDLES the floor is clamped to it and licenses the provable part",
    clamped.coverage.kind === "COMPLETE" && clamped.cursor.provenFromBlock === EARLIEST_PROVABLE_BLOCK &&
    clamped.cursor.stoppedBecause === "PROVABLE_FLOOR",
    `${describeCoverage(clamped.coverage)} provenFrom=${clamped.cursor.provenFromBlock}`);
  check("EARLIEST_PROVABLE_BLOCK is Byzantium, past every irregular state transition",
    EARLIEST_PROVABLE_BLOCK === 4_370_000);

  // ── 8. PURE DECOMPOSITION AND EVIDENCE READING ────────────────────────────
  const ev = blockEvidence(
    BASE, OWNER, ETH(0.5),
    { hash: "0xabc", timestamp: hex(BigInt(T0)), withdrawals: [
      { address: OWNER, amount: hex(BigInt(1_000_000)) },        // 0.001 ETH in gwei
      { address: OTHER, amount: hex(BigInt(9_000_000_000)) },     // someone else's
    ] },
    [{ from: OWNER, to: OTHER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex(BigInt(1_000_000_000)) },
     { from: OTHER, to: OWNER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex(BigInt(5)) }],
  );
  check("a withdrawal to ANOTHER address is not counted",
    ev.withdrawalWei === BigInt(1_000_000) * WEI_PER_GWEI);
  check("the fee is gasUsed × effectiveGasPrice for THIS address's own transactions only",
    ev.feeWei === BigInt(21000) * BigInt(1_000_000_000));
  check("counterparties are RAW ADDRESSES from receipts — no labels, no entity resolution",
    JSON.stringify(ev.counterparties) === JSON.stringify([OTHER]));

  const parts = movementsForBlock(ev, OWNER);
  const sum = parts.reduce((s, m) => s + m.baseUnitsDelta, BigInt(0));
  check("the decomposition sums to the observed delta BY CONSTRUCTION",
    sum === ETH(0.5), `${sum} vs ${ETH(0.5)}`);
  check("the residual absorbs everything the header and receipts do not explain, exactly",
    parts.find((m) => m.role === "TRANSFER")!.baseUnitsDelta ===
      ETH(0.5) - ev.withdrawalWei + ev.feeWei);

  check("block time maps to a UTC calendar date and a full instant",
    blockTimeToDateISO(BigInt(T0)) === "2026-08-01" &&
    blockTimeToInstantISO(BigInt(T0)) === "2026-08-01T00:00:00.000Z");

  // ── 9. THE BRIDGE INTO THE ONE REPLAY ENGINE ──────────────────────────────
  const anchorEth = weiToEth(acq.anchorBalanceWei!);
  const events = movementsToQuantityEvents(acq.movements, {
    accountId: "a", instrumentId: "i", decimals: ETH_NATIVE.decimals,
  });
  check("every movement becomes a REPLAYABLE quantity event",
    events.length === acq.movements.length && events.every((e) => e.status === "REPLAYABLE"));

  const cov = acq.coverage as Extract<typeof acq.coverage, { kind: "COMPLETE" }>;
  const timeline = replayQuantityTimeline({
    instrumentId: "i", accountId: "a",
    anchors: [{ observationId: "obs", dateISO: cov.toISO, effectiveDateTimeISO: null,
                quantity: anchorEth, origin: "OBSERVED", completeness: "" }],
    events, windowFromISO: cov.fromISO, windowToISO: cov.toISO,
    eventStream: toEventStreamCompleteness(acq.coverage),
    tolerance: ledgerEpsilonFor(ETH_NATIVE),
  });
  check("the replay resolves the window with no uncovered time",
    timeline.uncovered.length === 0 && timeline.segments.some((s) => s.kind === "ABSOLUTE"),
    JSON.stringify({ uncovered: timeline.uncovered.length, kinds: timeline.segments.map((s) => s.kind) }));
  check("the replay's own reconciliation leaves no residue",
    timeline.diagnostics.reconciliationResidues.length === 0,
    JSON.stringify(timeline.diagnostics.reconciliationResidues));

  const rows = derivedRowsFromTimeline(timeline);
  check("only ABSOLUTE segments become dated rows", rows.length > 0);

  // ── 10. THE READ-TIME LICENCE ─────────────────────────────────────────────
  const resolvable = rows.map((r) => ({ dateISO: r.dateISO, quantity: r.quantity }));
  const before = resolveLicensedQuantityAsOf(resolvable, acq.coverage, "2020-01-01");
  const after = resolveLicensedQuantityAsOf(resolvable, acq.coverage, "2099-01-01");
  const inside = resolveLicensedQuantityAsOf(resolvable, acq.coverage, cov.toISO);
  check("before the licence: UNKNOWN with a coded reason, never zero",
    before.quantity === null && before.refusal === "BEFORE_FIRST_DEFENSIBLE_ANCHOR");
  check("beyond the licence: UNKNOWN with a coded reason, never a carried figure",
    after.quantity === null && after.refusal === "BEYOND_LICENSED_COVERAGE");
  check("inside the licence: a quantity", inside.quantity !== null && inside.refusal === null);
  check("no coverage record at all licenses NOTHING",
    resolveLicensedQuantityAsOf(resolvable, null, cov.toISO).refusal === "NO_COVERAGE_RECORD");

  // ── 11. THE 18-DECIMAL FLOAT BOUNDARY, STATED RATHER THAN ASSUMED ─────────
  // SOL recovers exact base units from PositionObservation.quantity because 9
  // decimals round-trip through float64. ETH does NOT, and a reconstruction that
  // assumed it would reconcile against a wei figure it invented.
  const awkward = BigInt("1802319046131905123");
  check("wei → ETH → wei does NOT round-trip at 18 decimals — the adapter must read wei from the CHAIN",
    BigInt(Math.round(weiToEth(awkward) * 1e18)) !== awkward);
  check("this adapter's reconciliation therefore uses chain-read wei, never a float round-trip",
    typeof acq.anchorBalanceWei === "bigint" && typeof acq.openingBalanceWei === "bigint");

  console.log(`\neth-history: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();

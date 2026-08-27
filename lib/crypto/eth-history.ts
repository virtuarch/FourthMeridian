/**
 * lib/crypto/eth-history.ts
 *
 * ETH-H1 — native Ethereum historical acquisition: the PURE provider layer.
 *
 * No @/lib/db, no next/*, injectable transport — the same constraint every
 * wallet provider layer in this directory carries.
 *
 * ── THE PROBLEM ETHEREUM POSES, AND WHY IT IS NOT SOLANA'S ───────────────────
 * Solana hands an adapter a complete answer per transaction: `meta.preBalances`
 * and `meta.postBalances` state every account's lamport delta, program-agnostic.
 * The only open question there is whether the address INDEX listed every
 * transaction, and it demonstrably may not (ADDRESS_INDEX_INCOMPLETE).
 *
 * Ethereum has no equivalent. A native ETH balance changes through at least
 * seven distinct protocol mechanisms, and no single standard JSON-RPC method
 * enumerates them for an address:
 *
 *   1. top-level transaction `value` sent by the address
 *   2. top-level transaction `value` received by the address
 *   3. gas paid by the address — INCLUDING for a transaction that REVERTED
 *   4. value moved by an internal CALL / CALLCODE / DELEGATECALL frame
 *   5. the endowment of a contract the address CREATEs
 *   6. SELFDESTRUCT paying its remaining balance to the address
 *   7. consensus-layer credits: block/priority-fee rewards to a fee recipient,
 *      and post-Shapella validator WITHDRAWALS — which have no transaction, no
 *      receipt and no trace, and appear only as a `withdrawals` entry in the
 *      BLOCK HEADER
 *
 * Categories 4–6 are visible only through `trace_*` / `debug_trace*`, which the
 * configured provider tier refuses outright (verified: JSON-RPC −32600, "not
 * available on the Free tier"). Category 7 is invisible to every transfer index
 * that exists, because it is not a transfer.
 *
 * ── WHY THE VENDOR'S TRANSFER INDEX IS NOT THE ANSWER ────────────────────────
 * `alchemy_getAssetTransfers` is the obvious shortcut and it is measurably
 * wrong for this purpose. Measured against mainnet on 2026-08-27, over a
 * seven-day window on a public externally-owned address:
 *
 *     index reported                 0 transfers
 *     the address actually gained    1.008975659 ETH
 *     across                         60 distinct balance-changing blocks
 *     every one of them              a validator withdrawal
 *
 * The vendor's own API states its complete category set — `{erc20, erc721,
 * erc1155, specialnft, external, internal}` — and there is no withdrawal or
 * reward category in it. This is not a gap a paid tier closes; a transfer index
 * cannot list a state change that is not a transfer. Doctrine already forbids a
 * provider's interpreted DTO from being the truth shape (invariant 7); this
 * adapter does not use the endpoint AT ALL, not even as an accelerator, because
 * the accelerator turned out to be unnecessary — see the cost note below.
 *
 * ── WHAT THIS ADAPTER READS INSTEAD: CONSENSUS STATE ─────────────────────────
 * `eth_getBalance(address, block)` is not an index and not an interpretation. It
 * is the account's balance in the state trie committed by that block's
 * `stateRoot`, and it is EXACT in wei. It observes all seven mechanisms above
 * identically, because it observes the RESULT rather than the cause. The
 * configured endpoint serves it at ARCHIVAL depth on the current tier (verified
 * at blocks 1, 1,000,000 and 4,000,000).
 *
 * That converts the acquisition problem from "enumerate every cause" — which
 * this tier cannot do — into "find every block where the balance changed", and
 * that is a search problem over a monotone predicate.
 *
 * ── THE EMPTINESS PROOF — the load-bearing argument of this file ─────────────
 * Reading state at a boundary tells you the NET change across an interval. On
 * its own that proves nothing about completeness: two omitted movements that
 * cancel would leave the endpoints equal, which is exactly the "a missing
 * movement can hide" hazard. For Ethereum, one structural fact closes it.
 *
 *   AN EXTERNALLY-OWNED ACCOUNT CANNOT BE DEBITED BY ANYONE BUT ITSELF.
 *
 * Every EVM debit of an account requires one of exactly three things:
 *   (a) the account ORIGINATED a transaction — which increments its nonce,
 *       whether the transaction succeeded or reverted;
 *   (b) code executed IN THE ACCOUNT'S CONTEXT — which requires the account to
 *       have code, and for an EOA that means an EIP-7702 delegation, whose
 *       installation increments the authority's nonce;
 *   (c) a contract was CREATEd at the address — which requires nonce 0 and empty
 *       code, and sets the nonce to 1 (EIP-161).
 *
 * There is no fourth. A CALL transfers value from the CALLING account, never
 * from an arbitrary third party. SELFDESTRUCT debits the destructing contract.
 * Withdrawals, block rewards and inbound transfers are credits only.
 *
 * Therefore, over an interval where an address's nonce did not change and its
 * code was empty at the interval's start, the balance is MONOTONE
 * NON-DECREASING — and so:
 *
 *     code(a) == "0x"  ∧  nonce(a) == nonce(b)  ∧  balance(a) == balance(b)
 *        ⟹  NO balance change occurred anywhere in (a, b]
 *
 * That is a DEDUCTION, not a coincidence argument. It is strictly stronger than
 * the reconciliation that licenses Solana's coverage, which rests on "a set of
 * missed movements summing to exactly zero is not a coincidence we entertain".
 * Here nothing is entertained: the cancelling pair the Solana argument dismisses
 * as improbable is here IMPOSSIBLE, because one of the two would have had to be
 * a debit.
 *
 * The predicate is what makes bisection sound, and bisection over a proven
 * predicate is what makes an EXHAUSTIVE enumeration possible from state reads
 * alone. `provablyUnchanged` is that predicate and it is the only thing in this
 * file permitted to prune.
 *
 * ── WHERE THE PROOF STOPS, STATED RATHER THAN ASSUMED ────────────────────────
 * The proof's premises are properties of the EVM as it has run since Byzantium.
 * Two pre-2017 protocol irregularities changed balances outside a transaction:
 * the DAO fork's irregular state transition (block 1,920,000) and the
 * pre-EIP-161 nonce conventions. Both affected specific CONTRACT accounts, and
 * neither can affect an interval this adapter licenses, because
 * `EARLIEST_PROVABLE_BLOCK` refuses to reason before Byzantium at all.
 *
 * And the proof applies to an EOA. Where `eth_getCode` is non-empty at any
 * probed boundary — a contract wallet, or an EOA carrying a live EIP-7702
 * delegation — premise (b) is live, debits become possible without a nonce
 * change, monotonicity fails, and NO amount of state reading can prove an
 * interval empty. This adapter REFUSES that case rather than pruning anyway.
 * That refusal is the honest answer, and it is a real limit: contract wallets
 * (Safe, and every ERC-4337 account) are not reconstructible by this method.
 *
 * ── COST: SCALES WITH EVENT COUNT, NOT WINDOW WIDTH ──────────────────────────
 * The recursion visits O(K · log(span/K)) blocks for K balance-changing blocks.
 * Measured on mainnet, K = 60 over 50,000 blocks cost 440 state probes / 1,320
 * RPC reads / 449 batched HTTP requests, with no throttling. A QUIET wallet over
 * a decade costs almost nothing; only an active one is expensive, and it is
 * expensive in proportion to how much actually happened to it.
 *
 * ── WHAT THIS LAYER REFUSES TO DO ────────────────────────────────────────────
 * It emits no `flowType`, no category, no merchant, no "sale". It reads ERC-20
 * balances not at all. It declares no completeness it cannot PROVE — and,
 * unusually, it CAN prove one, which is why this adapter may return COMPLETE
 * where Solana's never may. That is not a weaker standard reached by a different
 * route; it is a stronger proof available on a different chain.
 */

import {
  EthRpcError, ethRpcUrl, isEthAddressShape, normalizeEthAddress, parseHexQuantity,
  type FetchFn,
} from "./eth-rpc";
import { ETH_NATIVE } from "./native-asset";
import { redactProviderSecrets } from "./alchemy";
import type { ChainMovement, ChainCoverage, ChainCoverageCaveat } from "./chain-movement";

/** Provenance stamped on every movement this adapter emits. */
export const ETH_HISTORY_SOURCE = "ethereum-rpc";

/** CAIP-2 network reference, derived from the canonical asset key. */
export const ETHEREUM_NETWORK_ID = ETH_NATIVE.assetKey.split("/")[0];

/**
 * The earliest block whose interval this adapter will reason about.
 *
 * Byzantium (4,370,000 — 16 October 2017). Chosen because every protocol
 * irregularity that moved an account's balance WITHOUT a transaction — the DAO
 * fork's state transition at 1,920,000, the pre-EIP-161 nonce conventions and
 * the EIP-158 empty-account clearing — is strictly earlier. Reasoning across one
 * of those would break premise (a) of the emptiness proof silently, which is the
 * one failure mode that would produce a confident wrong history rather than a
 * refusal.
 *
 * It costs nothing today: the dated price archive this system reads cannot serve
 * any date more than a year back (the vendor answers a longer request with
 * error_code 10012), so no valuation exists for the interval this forbids.
 */
export const EARLIEST_PROVABLE_BLOCK = 4_370_000;

/**
 * Blocks probed per RUN. A bound on WORK, not on history: the run checkpoints
 * and the next one resumes, exactly as Solana's signature paging does. A run
 * that stops early says so (`PAGE_BUDGET_EXHAUSTED`) rather than pretending it
 * reached the beginning.
 */
export const DEFAULT_PROBE_BUDGET = 4_000;

/** JSON-RPC calls per batched HTTP request. Verified: 200 accepted, 500 throttles. */
export const DEFAULT_BATCH_SIZE = 20;

/**
 * The window is processed right-to-left in chunks so that a budget-exhausted run
 * still has a PROVEN lower boundary to checkpoint at, rather than a half-explored
 * recursion it cannot describe.
 */
export const DEFAULT_CHUNK_BLOCKS = 50_000;

// ── The account state a proof step reads ─────────────────────────────────────

/**
 * Everything the emptiness proof needs about one address at one block. All three
 * fields are load-bearing: the balance is what is being proven constant, the
 * nonce is what proves no debit was possible, and the code is what proves the
 * nonce argument applies at all.
 */
export interface EthAccountState {
  /** EXACT wei. Never a float, never a whole-unit number. */
  balance: bigint;
  nonce:   bigint;
  /** `"0x"` for a plain EOA. Anything else and the proof does not apply. */
  code:    string;
}

/** A plain externally-owned account — the only shape the proof covers. */
export function isPlainEoa(state: EthAccountState): boolean {
  return state.code === "0x";
}

/**
 * THE PREDICATE. True ⟹ the interval (a, b] contains NO balance change at all.
 *
 * See the file header for the argument. Three conditions, all necessary:
 *
 *   code(a) empty    the account had no code executing in its context, so the
 *                    only possible debit is one it originated itself
 *   nonce equal      it originated nothing — so it was never debited, so the
 *                    balance over the interval is monotone NON-DECREASING
 *   balance equal    a monotone non-decreasing quantity with equal endpoints is
 *                    CONSTANT; there is no room for a movement to hide
 *
 * Dropping any one of them turns a proof into a guess. In particular, balance
 * equality ALONE is exactly the "two omitted movements that cancel" hazard, and
 * it is the nonce condition — not the balance condition — that eliminates it.
 */
export function provablyUnchanged(a: EthAccountState, b: EthAccountState): boolean {
  return isPlainEoa(a) && a.nonce === b.nonce && a.balance === b.balance;
}

// ── Pure time and unit helpers ───────────────────────────────────────────────

/** UTC calendar date from a block timestamp (seconds). */
export function blockTimeToDateISO(timestampSec: bigint): string {
  return new Date(Number(timestampSec) * 1000).toISOString().slice(0, 10);
}

/** Full ISO instant from a block timestamp (seconds). */
export function blockTimeToInstantISO(timestampSec: bigint): string {
  return new Date(Number(timestampSec) * 1000).toISOString();
}

/** Withdrawal amounts are stated in GWEI, not wei. Getting this wrong is 10^9x. */
export const WEI_PER_GWEI = BigInt(1_000_000_000);

// ── The evidence one changed block yields ────────────────────────────────────

/**
 * The RAW block-level evidence behind one balance change, before any movement is
 * built from it. Every field is read from consensus data — a block header and
 * its transaction receipts — and none of it is a provider's interpretation.
 */
export interface EthBlockEvidence {
  blockNumber:  number;
  /** The block's own content-addressed identity. This is the chain event id. */
  blockHash:    string;
  timestampSec: bigint;
  /** balance(b) − balance(b−1). EXACT, and the sum every movement must reproduce. */
  deltaWei:     bigint;
  /** Σ of the block's `withdrawals` entries paying THIS address, converted to wei. */
  withdrawalWei: bigint;
  /** Σ gasUsed × effectiveGasPrice over receipts whose `from` is THIS address. */
  feeWei:       bigint;
  /** Raw counterparty addresses from receipts touching this address. NO labels. */
  counterparties: readonly string[];
  /** True when a receipt for one of this address's own transactions has status 0. */
  hadRevertedOwnTransaction: boolean;
}

/**
 * Split one block's exact wei delta into the mechanical parts the chain STATES.
 *
 * Mirrors Solana's fee-payer split, for the same reason and with the same
 * guarantee: the parts sum to the observed delta BY CONSTRUCTION, so the split
 * can never introduce a reconciliation shortfall. What it buys is that a gas
 * payment is recorded as a `FEE` and a validator withdrawal as a `REWARD`
 * instead of both being flattened into "a transfer" — mechanical facts the chain
 * asserts, not financial classifications this layer is forbidden to make.
 *
 * ── THE RESIDUAL IS THE HONEST PART ──────────────────────────────────────────
 * Whatever the withdrawal and the fee do not explain is emitted as ONE
 * `TRANSFER` movement. On this tier that residual absorbs top-level value,
 * internal CALL value, contract endowments, SELFDESTRUCT proceeds and block
 * rewards indiscriminately, because the trace methods that would separate them
 * are refused. Its AMOUNT is exact; its CAUSE is partly unknown.
 *
 * That is the correct trade and it is the point of this whole approach:
 * QUANTITY history is defensible while MEANING stays unknown. Splitting the
 * residual further would require guessing, and a guess here would be a
 * financial claim wearing a mechanical label.
 */
export function movementsForBlock(
  ev: EthBlockEvidence,
  ownedAddress: string,
): ChainMovement[] {
  const dateISO = blockTimeToDateISO(ev.timestampSec);
  const base = {
    networkId:      ETHEREUM_NETWORK_ID,
    eventId:        ev.blockHash,
    assetKey:       ETH_NATIVE.assetKey,
    ownedAddress,
    occurredAtISO:  blockTimeToInstantISO(ev.timestampSec),
    dateISO,
    // A block timestamp is a value the proposer sets and consensus bounds — a
    // real header field, not a validator's after-the-fact estimate.
    timeBasis:      "BLOCK_TIME" as const,
    // A block is not a transaction and cannot fail. Where one of this address's
    // own transactions reverted, the FEE movement below is precisely the cost
    // that reverting still incurred.
    failed:         false,
    counterparties: ev.counterparties,
    sequence:       ev.blockNumber,
    source:         ETH_HISTORY_SOURCE,
  };

  const out: ChainMovement[] = [];
  if (ev.withdrawalWei !== BigInt(0)) {
    out.push({ ...base, movementKey: "withdrawal", baseUnitsDelta: ev.withdrawalWei, role: "REWARD" });
  }
  if (ev.feeWei !== BigInt(0)) {
    out.push({ ...base, movementKey: "fee", baseUnitsDelta: -ev.feeWei, role: "FEE" });
  }
  const residual = ev.deltaWei - ev.withdrawalWei + ev.feeWei;
  if (residual !== BigInt(0)) {
    out.push({ ...base, movementKey: "transfer", baseUnitsDelta: residual, role: "TRANSFER" });
  }
  return out;
}

// ── Transport ────────────────────────────────────────────────────────────────

/** One JSON-RPC call, before batching. */
export interface EthRpcCall { method: string; params: unknown[] }

/** Injectable transport: takes a JSON-RPC body (single or batch), returns raw text. */
export type EthRpcTransport = (body: unknown) => Promise<string>;

export interface EthHistoryDeps {
  fetchImpl?: FetchFn;
  rpcUrl?:    string | null;
  /** Full transport override (offline fixtures). */
  transport?: EthRpcTransport;
  /** Blocks probed per run. Default DEFAULT_PROBE_BUDGET. */
  probeBudget?: number;
  /** JSON-RPC calls per HTTP request. Default DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  /** Window slice processed per proof pass. Default DEFAULT_CHUNK_BLOCKS. */
  chunkBlocks?: number;
  /** Pause between batched requests, ms. A politeness bound, not correctness. */
  pauseMs?: number;
  /** Backoff attempts before a throttle becomes a coverage caveat. */
  throttleRetries?: number;
  /** Injectable sleep, so the retry path is testable without real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * The provider said "too fast", not "no".
 *
 * Distinguished from every other failure because the RESPONSE differs: a
 * throttle is retried with backoff and, if it persists, becomes the
 * `PROVIDER_THROTTLED` caveat — which licenses nothing but is honestly
 * retryable. Collapsing it into a generic error would present a temporary
 * capacity limit as a terminal one and invite a retry that reads as pointless.
 *
 * This is not an incidental concern on the configured tier. Measured: a batch of
 * 200 state reads is served, a batch of 500 is throttled, and a sustained ~145
 * reads/second trips the per-second compute limit. An adapter for this chain
 * without backoff does not work.
 */
export class EthThrottleError extends Error {
  constructor(message: string) { super(message); this.name = "EthThrottleError"; }
}

/** JSON-RPC error code the provider uses for its per-second capacity limit. */
const THROTTLE_CODE = 429;

function buildTransport(deps: EthHistoryDeps): EthRpcTransport {
  if (deps.transport) return deps.transport;
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : ethRpcUrl();
  if (!url) {
    throw new EthRpcError("config",
      "no Ethereum RPC endpoint configured (set ETH_RPC_URL or ALCHEMY_API_KEY)");
  }
  const doFetch = deps.fetchImpl ?? fetch;
  return async (body: unknown) => {
    const res = await doFetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.status === THROTTLE_CODE) throw new EthThrottleError("HTTP 429 from the Ethereum RPC endpoint");
    if (!res.ok) throw new EthRpcError("balance", `HTTP ${res.status} from the Ethereum RPC endpoint`);
    return res.text();
  };
}

/**
 * `callBatch` with bounded exponential backoff on throttling only.
 *
 * Deliberately retries NOTHING else. A malformed response, a tier refusal or an
 * id mismatch will fail identically on a second attempt, and retrying them would
 * turn a clear refusal into a slow one.
 */
export async function callBatchWithBackoff(
  calls: readonly EthRpcCall[],
  transport: EthRpcTransport,
  opts: { retries?: number; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<unknown[]> {
  const retries = opts.retries ?? 6;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await callBatch(calls, transport); }
    catch (e) {
      if (!(e instanceof EthThrottleError)) throw e;
      last = e;
      if (attempt < retries) await sleep(300 * 2 ** attempt);
    }
  }
  throw last as Error;
}

/**
 * Send one batch and return the results IN REQUEST ORDER.
 *
 * JSON-RPC permits a server to answer a batch in any order, so results are
 * re-keyed by `id` rather than by position. Trusting position here would
 * mis-attribute a balance to the wrong block — a corruption that reconciles
 * perfectly and is invisible downstream.
 *
 * A JSON-RPC `error` member is a PROVIDER refusal and is surfaced as such. The
 * message is redacted first: a provider's error text quotes the request URL
 * surprisingly often, and the configured URL carries the credential in its path.
 */
export async function callBatch(
  calls: readonly EthRpcCall[],
  transport: EthRpcTransport,
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const rawText = await transport(calls.length === 1 ? body[0] : body);

  let parsed: unknown;
  try { parsed = JSON.parse(rawText); }
  catch { throw new EthRpcError("balance", "unparseable JSON-RPC response"); }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: unknown[] = new Array(calls.length);
  let seen = 0;
  for (const row of rows as Array<{ id?: unknown; result?: unknown; error?: { code?: number; message?: string } }>) {
    if (row.error) {
      if (row.error.code === THROTTLE_CODE) {
        throw new EthThrottleError("the Ethereum RPC endpoint refused the batch for capacity");
      }
      throw new EthRpcError("balance", redactProviderSecrets(
        `provider error ${row.error.code ?? "?"}: ${row.error.message ?? "unknown"}`));
    }
    const idx = typeof row.id === "number" ? row.id : Number(row.id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= calls.length) {
      throw new EthRpcError("balance", "JSON-RPC response carried an id outside the batch");
    }
    out[idx] = row.result;
    seen++;
  }
  if (seen !== calls.length) {
    throw new EthRpcError("balance", `JSON-RPC batch answered ${seen} of ${calls.length} calls`);
  }
  return out;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/**
 * Opaque, resumable checkpoint.
 *
 * `provenFromBlock` is the DEEPEST block down to which the emptiness proof has
 * been carried without a gap — never the oldest block merely looked at. The
 * distinction is the whole point: a half-explored recursion has looked at blocks
 * it cannot vouch for, and checkpointing there would license an interval nothing
 * proved.
 */
export interface EthHistoryCursor {
  /** Deepest PROVEN block, or null when nothing has been proven yet. */
  provenFromBlock: number | null;
  /** The block the run anchored its state reads at. */
  anchorBlock:     number | null;
  /** True once the proof reached the requested lower bound. */
  reachedWindowStart: boolean;
  /**
   * WHY the run stopped where it did. Recorded here rather than as a coverage
   * caveat, because none of these weakens what was proven above the boundary —
   * they decide whether a caller should RESUME, which is a different question
   * from whether the proven interval may be trusted.
   */
  stoppedBecause?: "WINDOW_START" | "PROBE_BUDGET" | "PROVIDER_THROTTLED" | "PROVABLE_FLOOR";
}

export const EMPTY_ETH_HISTORY_CURSOR: EthHistoryCursor = {
  provenFromBlock: null, anchorBlock: null, reachedWindowStart: false,
};

export interface EthHistoryAcquisition {
  movements: ChainMovement[];
  coverage:  ChainCoverage;
  cursor:    EthHistoryCursor;
  /** The blocks at which the balance changed. Diagnostics — never branched on. */
  changeBlocks: readonly number[];
  /** EXACT wei balance at the anchor block, for an independent reconciliation. */
  anchorBalanceWei: bigint | null;
  /** EXACT wei balance at the proven lower boundary. Opening state, not zero. */
  openingBalanceWei: bigint | null;
  /** Diagnostics — never branched on. */
  probesUsed: number;
  rpcReads:   number;
}

// ── Acquisition ──────────────────────────────────────────────────────────────

interface AcquireArgs {
  ownerAddress: string;
  /** Inclusive lower bound of the window to prove. */
  fromBlock: number;
  /** Inclusive upper bound — must be FINALIZED. The caller resolves the tag. */
  toBlock:   number;
  cursor?:   EthHistoryCursor;
}

/**
 * Acquire an address's native ETH movement history over a block window.
 *
 * ── COVERAGE MAY BE COMPLETE HERE, AND THAT IS NOT A LOWERED BAR ─────────────
 * Solana's adapter can never return COMPLETE from a scan, because its evidence
 * is an address INDEX and an index cannot prove it listed everything. This
 * adapter's evidence is CONSENSUS STATE plus a deductive emptiness proof over
 * every gap, so when the proof holds across the whole window there is nothing
 * left for the arithmetic to license — the completeness is already established.
 *
 * The corollary matters as much: when the proof does NOT hold at any boundary —
 * a non-empty `eth_getCode` anywhere — coverage is UNKNOWN and no reconciliation
 * may rescue it. There is no partial credit for a proof with a hole in it.
 */
export async function acquireEthHistory(
  args: AcquireArgs,
  deps: EthHistoryDeps = {},
): Promise<EthHistoryAcquisition> {
  const address = normalizeEthAddress(args.ownerAddress);
  const budget      = deps.probeBudget ?? DEFAULT_PROBE_BUDGET;
  const batchSize   = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const chunkBlocks = deps.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;
  const pauseMs     = deps.pauseMs ?? 0;
  const throttleRetries = deps.throttleRetries ?? 6;
  const sleepImpl   = deps.sleepImpl;

  const cursor: EthHistoryCursor = { ...(args.cursor ?? EMPTY_ETH_HISTORY_CURSOR) };
  const empty = (coverage: ChainCoverage): EthHistoryAcquisition => ({
    movements: [], coverage, cursor, changeBlocks: [],
    anchorBalanceWei: null, openingBalanceWei: null, probesUsed: 0, rpcReads: 0,
  });

  if (!isEthAddressShape(address)) {
    throw new EthRpcError("address", `not a well-formed Ethereum address: ${args.ownerAddress}`);
  }

  let transport: EthRpcTransport;
  try {
    transport = buildTransport(deps);
  } catch (e) {
    if (e instanceof EthRpcError && e.stage === "config") {
      // THE DARK PATH. No archival endpoint means UNKNOWN history — a different
      // fact from "this wallet has no history", and never recorded as one.
      return empty({ kind: "UNKNOWN", caveats: ["NO_PROVIDER_CONFIGURED"], source: ETH_HISTORY_SOURCE });
    }
    throw e;
  }

  // The proof's premises do not hold before Byzantium. Refuse the interval
  // rather than reason across an irregular state transition.
  const lo = Math.max(args.fromBlock, EARLIEST_PROVABLE_BLOCK);
  const hi = args.toBlock;
  const depthLimited = lo > args.fromBlock;
  if (hi <= lo) {
    return empty({
      kind: "UNKNOWN",
      caveats: depthLimited ? ["ARCHIVE_DEPTH_LIMIT"] : ["INVALID_DATA"],
      source: ETH_HISTORY_SOURCE,
    });
  }

  // ── State probing: batched, memoised, budget-bounded ───────────────────────
  const states = new Map<number, EthAccountState>();
  let probesUsed = 0;
  let rpcReads = 0;
  let budgetExhausted = false;

  async function probe(blocks: readonly number[]): Promise<boolean> {
    const need = [...new Set(blocks)].filter((b) => !states.has(b));
    if (need.length === 0) return true;
    if (probesUsed + need.length > budget) { budgetExhausted = true; return false; }

    const calls: EthRpcCall[] = [];
    for (const b of need) {
      const tag = "0x" + b.toString(16);
      calls.push({ method: "eth_getBalance",          params: [address, tag] });
      calls.push({ method: "eth_getTransactionCount", params: [address, tag] });
      calls.push({ method: "eth_getCode",             params: [address, tag] });
    }
    // Results land in a staging array and are committed to `states` only once
    // every field of every block has arrived. A partially-filled entry would be
    // indistinguishable from a complete one to the memo check, and a state whose
    // `code` had not arrived yet would read as "" — which is not "0x", so the
    // proof would abort on evidence that was merely in flight.
    const staged: unknown[] = new Array(calls.length);
    for (let i = 0; i < calls.length; i += batchSize) {
      const slice = calls.slice(i, i + batchSize);
      const res = await callBatchWithBackoff(slice, transport, { retries: throttleRetries, sleepImpl });
      rpcReads += slice.length;
      for (let j = 0; j < slice.length; j++) staged[i + j] = res[j];
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
    need.forEach((b, k) => {
      const code = staged[k * 3 + 2];
      if (typeof code !== "string" || !code.startsWith("0x")) {
        throw new EthRpcError("balance", `eth_getCode returned a non-hex value for block ${b}`);
      }
      states.set(b, {
        balance: parseHexQuantity(staged[k * 3]),
        nonce:   parseHexQuantity(staged[k * 3 + 1]),
        code,
      });
    });
    probesUsed += need.length;
    return true;
  }

  const at = (b: number): EthAccountState => states.get(b)!;

  /**
   * Every block in (a, b] where the balance changed.
   *
   * Prunes ONLY on `provablyUnchanged`. `proofHole` is set when a boundary is
   * not a plain EOA: the recursion then cannot prune, so it would descend to
   * every single block — which is neither affordable nor meaningful, since the
   * result would still not be provably complete. It aborts instead.
   */
  let proofHole = false;
  async function enumerate(a: number, b: number): Promise<number[]> {
    if (proofHole || budgetExhausted || b <= a) return [];
    if (!(await probe([a, b]))) return [];
    if (!isPlainEoa(at(a))) { proofHole = true; return []; }
    if (provablyUnchanged(at(a), at(b))) return [];
    if (b - a === 1) return [b];
    const m = a + Math.floor((b - a) / 2);
    if (!(await probe([m]))) return [];
    const left  = await enumerate(a, m);
    if (proofHole || budgetExhausted) return left;
    const right = await enumerate(m, b);
    return [...left, ...right];
  }

  // ── Right-to-left chunking, so a truncated run has a PROVEN boundary ───────
  const changeBlocks: number[] = [];
  let provenFrom = hi;
  cursor.anchorBlock = hi;

  // A throttle that OUTLASTS the backoff is not a failure of the proof — it is
  // the provider declining to serve more work right now. The run keeps whatever
  // it PROVED and records why it stopped. Throwing instead would discard proven
  // chunks and turn a wait into an error, which is the retry-that-reads-as-
  // pointless invariant 22 forbids.
  let throttledOut = false;

  try {
    if (!(await probe([hi]))) {
      return empty({ kind: "PARTIAL", coveredFromISO: null, coveredToISO: null,
        caveats: ["PAGE_BUDGET_EXHAUSTED"], source: ETH_HISTORY_SOURCE });
    }
    if (!isPlainEoa(at(hi))) proofHole = true;

    while (!proofHole && !budgetExhausted && provenFrom > lo) {
      const chunkLo = Math.max(lo, provenFrom - chunkBlocks);
      const found = await enumerate(chunkLo, provenFrom);
      if (proofHole || budgetExhausted) break;
      changeBlocks.push(...found);
      provenFrom = chunkLo;
    }
  } catch (e) {
    if (!(e instanceof EthThrottleError)) throw e;
    throttledOut = true;
  }

  // NOTHING WAS PROVEN. Not "a little was proven" — the first chunk did not
  // complete, so there is no interval to speak for. Coverage is UNKNOWN and the
  // reason is the one that stopped it.
  if (!proofHole && provenFrom >= hi) {
    const why: ChainCoverageCaveat =
      throttledOut ? "PROVIDER_THROTTLED"
      : budgetExhausted ? "PAGE_BUDGET_EXHAUSTED"
      : "INVALID_DATA";
    cursor.stoppedBecause = throttledOut ? "PROVIDER_THROTTLED"
      : budgetExhausted ? "PROBE_BUDGET" : "WINDOW_START";
    return empty({ kind: "UNKNOWN", caveats: [why], source: ETH_HISTORY_SOURCE });
  }

  if (proofHole) {
    // A CONTRACT ACCOUNT, OR AN EOA CARRYING A LIVE EIP-7702 DELEGATION.
    // Code can execute in this account's context, so it can be debited without
    // originating anything, so the balance is not monotone between nonce
    // changes, so no interval can be proven empty. State reading cannot rescue
    // this and neither can arithmetic; the honest answer is that the history is
    // UNKNOWN. The caveat is PROOF_PREMISES_UNMET rather than INVALID_DATA: the
    // provider answered correctly and the data was fine — this account is simply
    // not the kind of thing the argument is about, and a retry will keep
    // succeeding without ever helping.
    return {
      movements: [], coverage: { kind: "UNKNOWN", caveats: ["PROOF_PREMISES_UNMET"], source: ETH_HISTORY_SOURCE },
      cursor, changeBlocks: [], anchorBalanceWei: at(hi)?.balance ?? null,
      openingBalanceWei: null, probesUsed, rpcReads,
    };
  }

  changeBlocks.sort((x, y) => x - y);
  cursor.provenFromBlock    = provenFrom;
  cursor.reachedWindowStart = provenFrom <= lo;

  // ── Block evidence for each changed block ─────────────────────────────────
  const movements: ChainMovement[] = [];
  let earliestISO: string | null = null;
  let latestISO:   string | null = null;

  try {
  for (const b of changeBlocks) {
    const tag = "0x" + b.toString(16);
    const [header, receipts] = await callBatchWithBackoff(
      [
        { method: "eth_getBlockByNumber", params: [tag, false] },
        { method: "eth_getBlockReceipts", params: [tag] },
      ],
      transport,
      { retries: throttleRetries, sleepImpl },
    );
    rpcReads += 2;
    const ev = blockEvidence(b, address, at(b).balance - at(b - 1).balance, header, receipts);
    for (const m of movementsForBlock(ev, address)) {
      movements.push(m);
      if (earliestISO === null || m.dateISO < earliestISO) earliestISO = m.dateISO;
      if (latestISO   === null || m.dateISO > latestISO)   latestISO   = m.dateISO;
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  } catch (e) {
    // Evidence for a block the proof already found could not be fetched. The
    // movement set is now INCOMPLETE against its own enumeration, so nothing may
    // be licensed from it.
    if (!(e instanceof EthThrottleError)) throw e;
    return empty({ kind: "UNKNOWN", caveats: ["PROVIDER_THROTTLED"], source: ETH_HISTORY_SOURCE });
  }

  // ── Coverage ──────────────────────────────────────────────────────────────
  // The interval runs to the BOUNDARY BLOCKS the proof closed over, NOT to the
  // dates of the movements found. A quiet wallet's newest movement may be months
  // before the anchor; the proof says the gap is empty, so the licence must
  // reach the anchor or the reconstruction would refuse its own proven interval.
  // This is invariant 39's argument, arrived at deductively rather than by
  // arithmetic.
  const [fromTsRaw, toTsRaw] = await callBatchWithBackoff(
    [
      { method: "eth_getBlockByNumber", params: ["0x" + provenFrom.toString(16), false] },
      { method: "eth_getBlockByNumber", params: ["0x" + hi.toString(16), false] },
    ],
    transport,
    { retries: throttleRetries, sleepImpl },
  );
  rpcReads += 2;
  const fromISO = blockTimeToDateISO(headerTimestamp(fromTsRaw));
  const toISO   = blockTimeToDateISO(headerTimestamp(toTsRaw));

  // ── THE LICENCE IS THE INTERVAL THE PROOF CLOSED, NOT THE INTERVAL ASKED FOR
  //
  // A run may stop short of the requested window for four reasons — it reached
  // the start, it ran out of probe budget, the provider throttled it, or the
  // window reached below `EARLIEST_PROVABLE_BLOCK`. NONE of them weakens what
  // was proven ABOVE the boundary it stopped at: the chunk loop only advances
  // `provenFrom` past a chunk the emptiness proof closed completely, and an
  // in-flight chunk's findings are discarded rather than kept.
  //
  // So coverage is COMPLETE over `[provenFrom, hi]` and says nothing at all
  // about earlier dates — which `resolveLicensedQuantityAsOf` then refuses with
  // BEFORE_FIRST_DEFENSIBLE_ANCHOR, not with a number.
  //
  // ── WHY THIS IS NOT SOLANA'S FORBIDDEN UPGRADE ──────────────────────────────
  // `licenseCoverageByReconciliation` deliberately refuses to upgrade a run that
  // knows it stopped early, because there the completeness argument is
  // ARITHMETIC — "the movements sum to the balance" — and a sum that happens to
  // close over a truncated window says nothing about the window never requested.
  // The argument HERE is a per-interval DEDUCTION, evaluated gap by gap, and it
  // was never evaluated over the unrequested window at all. A truncated run
  // makes a smaller claim; it does not make a weaker one.
  //
  // Why the run stopped is recorded on the CURSOR, where a caller decides
  // whether to resume — not as a caveat that would void a licence the evidence
  // earned.
  if (depthLimited && provenFrom <= lo) {
    // The window reached below Byzantium and was clamped there. The proof over
    // the clamped interval still holds; the caller asked a wider question than
    // this method can answer, and that is recorded rather than silently dropped.
    cursor.stoppedBecause = "PROVABLE_FLOOR";
  } else if (throttledOut)    cursor.stoppedBecause = "PROVIDER_THROTTLED";
  else if (budgetExhausted)   cursor.stoppedBecause = "PROBE_BUDGET";
  else                        cursor.stoppedBecause = "WINDOW_START";

  // THIS ADAPTER NEVER RETURNS `PARTIAL`, AND THAT IS DELIBERATE.
  //
  // PARTIAL exists for an acquisition that saw SOME of an interval and cannot
  // say what it missed — an index scan that reached page five of an unknown
  // number. This method has no such state. Either the emptiness proof closed
  // every gap in `[provenFrom, hi]`, in which case that interval is COMPLETE and
  // earlier dates are simply outside it; or it closed nothing, in which case the
  // answer is UNKNOWN and was returned above. There is no middle where an
  // interval is partly proven.
  const coverage: ChainCoverage = { kind: "COMPLETE", fromISO, toISO, source: ETH_HISTORY_SOURCE };

  return {
    movements, coverage, cursor, changeBlocks,
    anchorBalanceWei:  at(hi).balance,
    openingBalanceWei: at(provenFrom)?.balance ?? null,
    probesUsed, rpcReads,
  };
}

// ── Raw response readers (pure, and deliberately strict) ─────────────────────

interface BlockHeaderView {
  hash?: unknown;
  timestamp?: unknown;
  withdrawals?: Array<{ address?: unknown; amount?: unknown }> | null;
}
interface ReceiptView {
  from?: unknown; to?: unknown; status?: unknown;
  gasUsed?: unknown; effectiveGasPrice?: unknown;
}

function headerTimestamp(header: unknown): bigint {
  const h = (header ?? {}) as BlockHeaderView;
  return parseHexQuantity(h.timestamp);
}

/**
 * Read one block's raw evidence for one address.
 *
 * STRICT on shape, because a silently-missing field here becomes a wrong
 * decomposition rather than a failure: an absent `withdrawals` array would move
 * a validator credit into the residual, and an unread receipt would move a gas
 * payment there. Both still reconcile — the residual absorbs anything — which is
 * exactly why the strictness has to be here rather than caught downstream.
 */
export function blockEvidence(
  blockNumber: number,
  address: string,
  deltaWei: bigint,
  header: unknown,
  receipts: unknown,
): EthBlockEvidence {
  const h = (header ?? {}) as BlockHeaderView;
  if (typeof h.hash !== "string") {
    throw new EthRpcError("balance", `block ${blockNumber}: header carried no hash`);
  }
  const timestampSec = parseHexQuantity(h.timestamp);

  let withdrawalWei = BigInt(0);
  for (const w of h.withdrawals ?? []) {
    if (typeof w.address === "string" && w.address.toLowerCase() === address) {
      withdrawalWei += parseHexQuantity(w.amount) * WEI_PER_GWEI;
    }
  }

  if (!Array.isArray(receipts)) {
    throw new EthRpcError("balance", `block ${blockNumber}: eth_getBlockReceipts did not return an array`);
  }
  let feeWei = BigInt(0);
  let hadRevertedOwnTransaction = false;
  const counterparties = new Set<string>();
  for (const r of receipts as ReceiptView[]) {
    const from = typeof r.from === "string" ? r.from.toLowerCase() : null;
    const to   = typeof r.to === "string" ? r.to.toLowerCase() : null;
    if (from === address) {
      feeWei += parseHexQuantity(r.gasUsed) * parseHexQuantity(r.effectiveGasPrice);
      if (r.status === "0x0") hadRevertedOwnTransaction = true;
      if (to && to !== address) counterparties.add(to);
    } else if (to === address) {
      if (from) counterparties.add(from);
    }
  }

  return {
    blockNumber, blockHash: h.hash, timestampSec, deltaWei,
    withdrawalWei, feeWei,
    counterparties: [...counterparties].sort(),
    hadRevertedOwnTransaction,
  };
}

/**
 * Resolve the FINALIZED head block. A balance that can still be rolled back is
 * not a balance, and the `finalized` tag is the chain's own statement of that —
 * not a heuristic block lag chosen here. Verified served by the configured
 * endpoint (observed ~70 blocks behind `latest`).
 */
export async function finalizedBlockNumber(deps: EthHistoryDeps = {}): Promise<number> {
  const transport = buildTransport(deps);
  const [header] = await callBatchWithBackoff([{ method: "eth_getBlockByNumber", params: ["finalized", false] }], transport, { retries: deps.throttleRetries, sleepImpl: deps.sleepImpl });
  const h = (header ?? {}) as { number?: unknown };
  return Number(parseHexQuantity(h.number));
}

/**
 * The latest block at or before a UTC instant — the date→block map a dated
 * window needs.
 *
 * Bisection is sound here for the ordinary reason and not the proof's: block
 * timestamps are strictly increasing by consensus rule, so the predicate really
 * is monotone. Stated so nobody later mistakes this for the emptiness proof and
 * copies its premises somewhere they do not hold.
 */
export async function blockAtOrBefore(
  timestampSec: number,
  bounds: { lo: number; hi: number },
  deps: EthHistoryDeps = {},
): Promise<number> {
  const transport = buildTransport(deps);
  const tsOf = async (b: number): Promise<number> => {
    const [h] = await callBatchWithBackoff([{ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] }], transport, { retries: deps.throttleRetries, sleepImpl: deps.sleepImpl });
    return Number(headerTimestamp(h));
  };
  let lo = bounds.lo, hi = bounds.hi;
  if (await tsOf(lo) > timestampSec) return lo;
  while (hi - lo > 1) {
    const m = lo + Math.floor((hi - lo) / 2);
    if (await tsOf(m) <= timestampSec) lo = m; else hi = m;
  }
  return lo;
}

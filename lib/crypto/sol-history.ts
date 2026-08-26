/**
 * lib/crypto/sol-history.ts
 *
 * W-M2 — native SOL historical acquisition: the PURE provider layer.
 *
 * No @/lib/db, no next/*, injectable transport — the same constraint every
 * wallet provider layer in this directory carries.
 *
 * Acquires an owner address's native SOL movement history using STANDARD Solana
 * RPC only:
 *
 *     getSignaturesForAddress   paginated backward via `before`
 *     getTransaction            commitment finalized, maxSupportedTransactionVersion 0
 *
 * Standard methods are the vendor-neutral contract; ARCHIVAL is a URL. Helius,
 * Triton, QuickNode and a self-hosted archive all speak these, so pointing at a
 * different vendor is configuration rather than a rewrite.
 *
 * ── HELIUS ENHANCED ENDPOINTS ARE DELIBERATELY NOT USED ──────────────────────
 * `getTransactionsForAddress` and the DAS API return a parsed, proprietary DTO
 * that already contains the vendor's opinion of what happened — "this was a
 * swap", "this was a transfer". Accepting that shape would put a vendor's
 * interpretation inside this system's truth layer, and would make the honesty
 * of every downstream refusal depend on a contract nobody here controls. They
 * may later serve as an ACCELERATOR whose output is re-derived against
 * `pre/postBalances` before it is trusted. They may never be the truth shape.
 *
 * ── THE BALANCE DELTA IS STATED, NOT DECODED ─────────────────────────────────
 * `meta.preBalances` / `meta.postBalances` are lamport balances for every account
 * in `accountKeys`, indexed positionally. The delta for an owned account is
 * `post[i] - pre[i]`. That is complete, program-agnostic, and requires decoding
 * exactly zero programs — the single most important fact about Solana ingestion,
 * and the reason a native-SOL history needs no protocol knowledge at all.
 *
 * ── WHAT THIS LAYER REFUSES TO DO ────────────────────────────────────────────
 * It emits no `flowType`, no category, no merchant, no "sale". It reads token
 * balances not at all (SPL is out of scope). It declares no completeness it
 * cannot prove — see `ADDRESS_INDEX_INCOMPLETE`.
 */

import {
  LAMPORTS_PER_SOL, isSolAddressShape, normalizeSolAddress, solRpcUrl, SolRpcError,
  type FetchFn,
} from "./sol-rpc";
import { SOL_NATIVE } from "./native-asset";
import type { ChainMovement, ChainCoverage, ChainCoverageCaveat } from "./chain-movement";

/** Provenance stamped on every movement this adapter emits. */
export const SOL_HISTORY_SOURCE = "solana-rpc";

/** CAIP-2 network reference, derived from the canonical asset key. */
export const SOLANA_NETWORK_ID = SOL_NATIVE.assetKey.split("/")[0];

/** Max signatures per `getSignaturesForAddress` page, per the RPC spec. */
export const SIGNATURE_PAGE_LIMIT = 1000;

/**
 * Default signature pages per RUN. A bound, not a limit on history: the run
 * checkpoints and the next one resumes, exactly as BTC's xpub discovery does.
 * A run that stops early says so (`PAGE_BUDGET_EXHAUSTED`) rather than
 * pretending it reached the beginning.
 */
export const DEFAULT_PAGE_BUDGET = 5;

// ── Wire shapes (this adapter's private view of the RPC) ─────────────────────

/** One row of `getSignaturesForAddress`. */
export interface SolSignatureRow {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime: number | null;
  confirmationStatus?: string;
}

/** The subset of `getTransaction` this adapter reads. */
export interface SolTransactionView {
  slot: number;
  blockTime: number | null;
  transaction: { message: { accountKeys: string[] } };
  meta: {
    err: unknown | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    /** Present when the transaction used Address Lookup Tables. */
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    /** SPL balances — READ ONLY to detect multi-asset events, never ingested. */
    preTokenBalances?: unknown[] | null;
    postTokenBalances?: unknown[] | null;
  } | null;
}

/** Injectable transport: takes a JSON-RPC body, returns the raw response text. */
export type SolRpcTransport = (body: unknown) => Promise<string>;

export interface SolHistoryDeps {
  fetchImpl?: FetchFn;
  rpcUrl?: string | null;
  /** Full transport override (offline fixtures). */
  transport?: SolRpcTransport;
  /** Signature pages per run. Default DEFAULT_PAGE_BUDGET. */
  pageBudget?: number;
  /** Signatures per page. Default SIGNATURE_PAGE_LIMIT. */
  pageLimit?: number;
}

// ── Pure parsing ─────────────────────────────────────────────────────────────

/** UTC calendar date from a Solana `blockTime` (seconds), or null. */
export function blockTimeToDateISO(blockTime: number | null): string | null {
  if (blockTime === null || !Number.isFinite(blockTime)) return null;
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

/** Full ISO instant from a Solana `blockTime` (seconds), or null. */
export function blockTimeToInstantISO(blockTime: number | null): string | null {
  if (blockTime === null || !Number.isFinite(blockTime)) return null;
  return new Date(blockTime * 1000).toISOString();
}

/**
 * Did this transaction touch any asset other than native SOL?
 *
 * Read from `pre/postTokenBalances` PRESENCE only — the contents are not
 * ingested (SPL is out of scope) and their MEANING is not interpreted. What it
 * buys is honesty: a native-only view of a token swap looks exactly like a plain
 * SOL transfer, and calling that a transfer would be the invention this system
 * refuses. Knowing the event was multi-asset lets the disposition stay
 * UNCLASSIFIED_PROGRAM_INTERACTION instead.
 */
export function isMultiAssetTransaction(tx: SolTransactionView): boolean {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  return pre.length > 0 || post.length > 0;
}

/**
 * Derive this wallet's native SOL movements from one transaction.
 *
 * ── The fee, and why it is a separate movement ───────────────────────────────
 * `meta.fee` is charged to the FEE PAYER — `accountKeys[0]` — and is ALREADY
 * included in that account's `post - pre` delta. Emitting the raw delta and the
 * fee as two movements would double-count it.
 *
 * So when the owned account IS the fee payer, its delta is split: a FEE movement
 * of exactly `-fee`, and a TRANSFER movement of the remainder. The two sum back
 * to the observed delta by construction, which is what keeps the integer
 * reconciliation exact. When the owned account is not the fee payer, its whole
 * delta is a TRANSFER and no fee movement is emitted for it.
 *
 * ── Failed transactions ──────────────────────────────────────────────────────
 * `err != null` means the transaction failed — but the FEE IS STILL CHARGED and
 * no other balance changed. That is real cost and real evidence, so a failed
 * transaction yields a fee movement and nothing else. Emitting a transfer for it
 * would fabricate a value movement that never happened; emitting nothing would
 * lose lamports the wallet actually spent and break the reconciliation.
 *
 * ── Counterparties ───────────────────────────────────────────────────────────
 * The accounts whose balance moved the OTHER way, as raw addresses. No labels,
 * no entity resolution, no exchange detection.
 */
export function deriveNativeMovements(
  tx: SolTransactionView,
  signature: string,
  ownedAddresses: ReadonlySet<string>,
): ChainMovement[] {
  const meta = tx.meta;
  if (!meta) return [];
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const { preBalances: pre, postBalances: post } = meta;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || keys.length < pre.length) {
    throw new SolRpcError("balance", `transaction ${signature}: balance arrays do not align with accountKeys`);
  }

  const failed = meta.err != null;
  const dateISO = blockTimeToDateISO(tx.blockTime);
  if (dateISO === null) {
    // Without a block time the movement cannot be placed on a date, and a
    // replay is a claim ABOUT dates. Refuse rather than invent one.
    throw new SolRpcError("balance", `transaction ${signature}: no blockTime, so it cannot be dated`);
  }
  const occurredAtISO = blockTimeToInstantISO(tx.blockTime);
  const feeLamports = BigInt(Math.trunc(meta.fee ?? 0));

  // Counterparties: every account whose balance moved, excluding owned ones.
  const counterparties: string[] = [];
  for (let i = 0; i < pre.length; i++) {
    const delta = BigInt(post[i]) - BigInt(pre[i]);
    if (delta !== BigInt(0) && !ownedAddresses.has(keys[i])) counterparties.push(keys[i]);
  }

  const base = {
    networkId:     SOLANA_NETWORK_ID,
    eventId:       signature,
    assetKey:      SOL_NATIVE.assetKey,
    occurredAtISO,
    dateISO,
    // Solana documents blockTime as a validator ESTIMATE, not a clock reading.
    timeBasis:     "VALIDATOR_ESTIMATE" as const,
    failed,
    counterparties,
    sequence:      tx.slot ?? null,
    source:        SOL_HISTORY_SOURCE,
  };

  const movements: ChainMovement[] = [];
  for (let i = 0; i < pre.length; i++) {
    const address = keys[i];
    if (!ownedAddresses.has(address)) continue;

    const delta = BigInt(post[i]) - BigInt(pre[i]);
    const isFeePayer = i === 0;

    if (isFeePayer && feeLamports > BigInt(0)) {
      movements.push({ ...base, movementKey: `${i}:fee`, ownedAddress: address, baseUnitsDelta: -feeLamports, role: "FEE" });
      const remainder = delta + feeLamports; // delta already includes -fee
      if (remainder !== BigInt(0)) {
        movements.push({ ...base, movementKey: `${i}:transfer`, ownedAddress: address, baseUnitsDelta: remainder, role: "TRANSFER" });
      }
      continue;
    }
    if (delta !== BigInt(0)) {
      movements.push({ ...base, movementKey: `${i}:transfer`, ownedAddress: address, baseUnitsDelta: delta, role: "TRANSFER" });
    }
  }
  return movements;
}

// ── Transport ────────────────────────────────────────────────────────────────

function buildTransport(deps: SolHistoryDeps): SolRpcTransport {
  if (deps.transport) return deps.transport;
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : solRpcUrl();
  if (!url) {
    throw new SolRpcError("config",
      "no Solana RPC endpoint configured (set SOL_RPC_URL or HELIUS_API_KEY)");
  }
  const doFetch = deps.fetchImpl ?? fetch;
  return async (body: unknown) => {
    const res = await doFetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new SolRpcError("balance", `HTTP ${res.status} from the Solana RPC endpoint`);
    return res.text();
  };
}

function rpcResult(rawBody: string, what: string): unknown {
  let env: { result?: unknown; error?: { code?: number; message?: string } };
  try { env = JSON.parse(rawBody); }
  catch { throw new SolRpcError("balance", `unparseable JSON-RPC response for ${what}`); }
  if (env.error) {
    throw new SolRpcError("balance", `provider error ${env.error.code ?? "?"}: ${env.error.message ?? "unknown"} (${what})`);
  }
  return env.result;
}

/** One backward page of signatures for an address. */
export async function fetchSignaturePage(
  address: string,
  opts: { before?: string | null; until?: string | null; limit?: number },
  transport: SolRpcTransport,
): Promise<SolSignatureRow[]> {
  const params: Record<string, unknown> = {
    limit: opts.limit ?? SIGNATURE_PAGE_LIMIT,
    // FINALIZED — a signature that can still be rolled back is not history.
    commitment: "finalized",
  };
  if (opts.before) params.before = opts.before;
  if (opts.until)  params.until = opts.until;

  const raw = await transport({
    jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
    params: [normalizeSolAddress(address), params],
  });
  const result = rpcResult(raw, "getSignaturesForAddress");
  if (!Array.isArray(result)) throw new SolRpcError("balance", "getSignaturesForAddress did not return an array");
  return result as SolSignatureRow[];
}

/** One transaction, at finalized commitment, v0-aware. */
export async function fetchTransaction(
  signature: string,
  transport: SolRpcTransport,
): Promise<SolTransactionView> {
  const raw = await transport({
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [signature, {
      commitment: "finalized",
      encoding: "json",
      // REQUIRED. Omitting it returns only legacy transactions and ERRORS on v0
      // — which is most of modern Solana, so a scan without it silently sees a
      // fraction of history and reports success.
      maxSupportedTransactionVersion: 0,
    }],
  });
  const result = rpcResult(raw, `getTransaction(${signature})`);
  if (!result || typeof result !== "object") {
    throw new SolRpcError("balance", `getTransaction(${signature}) returned no transaction`);
  }
  return result as SolTransactionView;
}

// ── Acquisition ──────────────────────────────────────────────────────────────

/** Opaque, resumable checkpoint. Stored on `Connection.cursor` by the binding. */
export interface SolHistoryCursor {
  /** The oldest signature reached so far — the next run pages BEFORE it. */
  oldestSignature: string | null;
  /** The newest signature ever seen — the next run pages UNTIL it for new activity. */
  newestSignature: string | null;
  /** True once a page came back short, proving the beginning was reached. */
  reachedBeginning: boolean;
}

export const EMPTY_SOL_HISTORY_CURSOR: SolHistoryCursor = {
  oldestSignature: null, newestSignature: null, reachedBeginning: false,
};

export interface SolHistoryAcquisition {
  movements: ChainMovement[];
  coverage:  ChainCoverage;
  cursor:    SolHistoryCursor;
  /** Signatures whose transaction touched a non-SOL asset. Disposition input. */
  multiAssetEventIds: readonly string[];
  /** Diagnostics — never branched on. */
  pagesFetched: number;
  signaturesSeen: number;
}

/**
 * Acquire an owner address's native SOL movement history.
 *
 * ── COVERAGE IS NEVER COMPLETE FROM A SCAN ALONE ─────────────────────────────
 * Even a run that pages all the way back to the first signature returns PARTIAL
 * with `ADDRESS_INDEX_INCOMPLETE`, because `getSignaturesForAddress` cannot list
 * transactions that referenced this address only through an Address Lookup
 * Table. Reaching the beginning proves the SCAN finished; it does not prove the
 * INDEX was complete.
 *
 * Only `licenseCoverageByReconciliation` may upgrade that, and only on the
 * strength of an independently observed balance the movements sum to exactly.
 * Arithmetic is allowed to license what a scan cannot prove; a successful HTTP
 * response is not.
 *
 * ── Bounded and resumable ────────────────────────────────────────────────────
 * A run fetches at most `pageBudget` signature pages. Stopping early is recorded
 * (`PAGE_BUDGET_EXHAUSTED`) and blocks the reconciliation upgrade — a balance
 * that happens to close over a truncated window says nothing about the window
 * that was never requested.
 */
export async function acquireSolHistory(
  args: {
    ownerAddress: string;
    /** Every address whose movements belong to this wallet. Usually the owner alone. */
    ownedAddresses?: ReadonlySet<string>;
    cursor?: SolHistoryCursor;
  },
  deps: SolHistoryDeps = {},
): Promise<SolHistoryAcquisition> {
  const owner = normalizeSolAddress(args.ownerAddress);
  const owned = args.ownedAddresses ?? new Set([owner]);
  const cursor: SolHistoryCursor = { ...(args.cursor ?? EMPTY_SOL_HISTORY_CURSOR) };
  const pageBudget = deps.pageBudget ?? DEFAULT_PAGE_BUDGET;
  const pageLimit  = deps.pageLimit ?? SIGNATURE_PAGE_LIMIT;

  const caveats: ChainCoverageCaveat[] = ["ADDRESS_INDEX_INCOMPLETE"];
  const movements: ChainMovement[] = [];
  const multiAssetEventIds: string[] = [];
  let pagesFetched = 0;
  let signaturesSeen = 0;
  let earliestISO: string | null = null;
  let latestISO: string | null = null;

  if (!isSolAddressShape(owner)) {
    throw new SolRpcError("address", `not a well-formed Solana address: ${args.ownerAddress}`);
  }

  let transport: SolRpcTransport;
  try {
    transport = buildTransport(deps);
  } catch (e) {
    if (e instanceof SolRpcError && e.stage === "config") {
      return {
        movements: [], multiAssetEventIds: [], pagesFetched: 0, signaturesSeen: 0, cursor,
        coverage: { kind: "UNKNOWN", caveats: ["NO_PROVIDER_CONFIGURED"], source: SOL_HISTORY_SOURCE },
      };
    }
    throw e;
  }

  let before: string | null = cursor.oldestSignature;
  let budgetExhausted = false;

  while (pagesFetched < pageBudget) {
    const page = await fetchSignaturePage(owner, { before, limit: pageLimit }, transport);
    pagesFetched++;
    signaturesSeen += page.length;

    for (const row of page) {
      const tx = await fetchTransaction(row.signature, transport);
      if (isMultiAssetTransaction(tx)) multiAssetEventIds.push(row.signature);
      const derived = deriveNativeMovements(tx, row.signature, owned);
      movements.push(...derived);
      for (const m of derived) {
        if (earliestISO === null || m.dateISO < earliestISO) earliestISO = m.dateISO;
        if (latestISO === null   || m.dateISO > latestISO)   latestISO = m.dateISO;
      }
      if (cursor.newestSignature === null) cursor.newestSignature = row.signature;
      cursor.oldestSignature = row.signature;
      before = row.signature;
    }

    // A SHORT PAGE PROVES THE SCAN REACHED THE BEGINNING — the RPC returns up to
    // `limit`, so fewer means there is nothing older to return.
    if (page.length < pageLimit) { cursor.reachedBeginning = true; break; }
    if (pagesFetched >= pageBudget) { budgetExhausted = true; }
  }

  if (budgetExhausted && !cursor.reachedBeginning) caveats.push("PAGE_BUDGET_EXHAUSTED");

  const coverage: ChainCoverage = {
    kind: "PARTIAL",
    // Bounds are the acquired movements' own dates. When the scan did not reach
    // the beginning the lower bound is NOT claimed — an open boundary licenses
    // nothing, which is exactly the honest outcome for a truncated run.
    coveredFromISO: cursor.reachedBeginning ? earliestISO : null,
    coveredToISO:   latestISO,
    caveats,
    source: SOL_HISTORY_SOURCE,
  };

  return { movements, coverage, cursor, multiAssetEventIds, pagesFetched, signaturesSeen };
}

/** Whole SOL from lamports — the canonical boundary conversion, re-exported. */
export function lamportsToSolExact(lamports: bigint): number {
  const whole = lamports / LAMPORTS_PER_SOL;
  const rem   = lamports % LAMPORTS_PER_SOL;
  return Number(whole) + Number(rem) / Number(LAMPORTS_PER_SOL);
}

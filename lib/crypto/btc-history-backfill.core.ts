/**
 * lib/crypto/btc-history-backfill.core.ts
 *
 * RESUMABLE BITCOIN HISTORY — the PURE half. No db, no network, no clock.
 *
 * ── Why the old path stopped at 1,000 transactions per address ──────────────
 * `fetchAddressTxsRaw` (btc-explorer.ts) re-lists every address from its newest
 * confirmed transaction on EVERY sync, bounded by `BTC_TX_PAGE_BUDGET` (40) ×
 * Esplora's fixed page of 25, and keeps no cursor. An address with more than
 * 1,000 confirmed transactions imports its newest 1,000 and nothing older, the
 * ledger can never sum to the balance, `reconstructBtcHistory` refuses
 * LEDGER_DOES_NOT_RECONCILE, and the next sync lists the same 40 pages again.
 * The ceiling was ours, not the provider's: `/txs/chain/:last_seen_txid` pages
 * to the very first transaction.
 *
 * ── The proof model: Bitcoin does NOT state balances, so this is not Solana ──
 * A Solana transaction states the owner's balance before and after it, so a
 * chunk of history proves itself by continuity. A Bitcoin transaction states
 * nothing of the kind: it spends earlier outputs and creates new ones. An
 * address's balance at any point is only ever a SUM — Σ outputs paid to it
 * minus Σ of those outputs later spent — over its chain-ordered confirmed
 * transactions. A missing transaction anywhere in the middle is invisible to
 * its neighbours. So a PARTIAL Bitcoin history proves nothing on its own, and
 * this module never licenses one.
 *
 * What does prove it is an independent observation of the same sums. Esplora's
 * `/address/:a` reports, per address, `chain_stats` = { funded_txo_sum,
 * spent_txo_sum, tx_count } over every CONFIRMED transaction. The listing is
 * complete exactly when, for EVERY address of the wallet,
 *
 *     Σ funded(listed)  === chain_stats.funded_txo_sum
 *     Σ spent(listed)   === chain_stats.spent_txo_sum
 *     count(listed)     === chain_stats.tx_count
 *
 * all three, in exact satoshis — and the listing reached the address's first
 * transaction (a short page). Three independent equalities per address (one
 * of them a count) make an omitted, duplicated or mis-valued transaction
 * detectable; a balance-only check could be fooled by an omission that a
 * double count offsets. For an xpub wallet the check runs PER DERIVED ADDRESS
 * and requires discovery to have finished (an undiscovered address would be an
 * unlisted one). The wallet's end-of-day quantity is then the running sum of
 * every address's net flow, from zero at the first transaction, by UTC day of
 * the MONOTONE block time: each block is dated by the latest `block_time` among
 * the wallet's blocks at or below its height. Raw `block_time` is not monotone
 * (consensus only bounds it by the median of the previous eleven blocks), and a
 * spend stamped before the receipt it spends would otherwise put a negative
 * balance on a day. The Transaction rows keep their raw dates (unchanged).
 *
 * ── Verification persists per address ──────────────────────────────────────
 * Each address's reconciliation is recorded (`verifiedAtISO`) when its listing
 * matched chain_stats with no shallow head, and invalidated the moment anything
 * new is folded for it. A large xpub therefore proves across several runs — a
 * rotating `verifyCursor` picks where each run starts — and the licence then
 * runs only to the day BEFORE the oldest verification still relied on (an
 * address verified at noon says nothing about its afternoon).
 *
 * ── Confirmation depth and tip reorgs ───────────────────────────────────────
 * Only transactions at least `depth` blocks deep (default 6) are SETTLED into
 * the checkpoint's totals; shallower confirmed ones are re-listed every run
 * and only ever counted in that run's verification. A reorg of the tip
 * therefore never corrupts the checkpoint: the next run sees the new tip,
 * re-verifies against the new chain_stats, and rewrites the rows that relied
 * on the shallow head (`headFromISO`). A disagreement withdraws the licence
 * back to before those rows. A reorg DEEPER than `depth` makes the settled top
 * disappear from the listing — that is recorded (RECOVERY_REQUIRED), never
 * walked across.
 *
 * ── Where the checkpoint lives ──────────────────────────────────────────────
 * `Connection.historyCheckpoint` (migration 20261028120000 — which must be
 * applied on every environment BEFORE this code deploys: the column is in the
 * Prisma schema, so every unselected `connection.*` read names it), NOT
 * `Connection.cursor`: for an xpub wallet the cursor already holds discovery's
 * checkpoint, which discovery overwrites without a compare-and-swap, and every
 * Connections reader treats "has a cursor" as "discovery in progress".
 *
 * This file decides; btc-history-backfill.ts fetches, schedules and writes.
 */

export const BTC_BACKFILL_KIND = "btc-history";
export const BTC_BACKFILL_VERSION = 1;

/** `PositionObservation.completeness` on rows this path writes. */
export const BTC_CHAIN_SUMMED_BASIS = "CHAIN_SUMMED";
/** `PositionObservation.reconstructionVersion` — distinguishes rows from the wholesale path (NULL). */
export const BTC_RECONSTRUCTION_VERSION = 2;
/** Coverage provenance: the chain listing, verified against Esplora's per-address chain_stats. */
export const BTC_CHAIN_STATS_SOURCE = "esplora:txs-chain+chain-stats";

/** Esplora's fixed page size for `/address/:a/txs/chain` (btc-explorer.ts). */
export const ESPLORA_PAGE_SIZE = 25;
/** Blocks deep before a transaction is settled into the checkpoint. */
export const DEFAULT_CONFIRMATION_DEPTH = 6;
/** Consecutive failed runs before automatic retries slow to once per day. */
export const MAX_CONSECUTIVE_FAILURES = 6;
export const FAILED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Consecutive FULLY-LISTED runs whose sums disagree with chain_stats before the
 * wallet needs recovery. One disagreement is expected now and then: a block can
 * land between the listing and the stats read. Three in a row is not a race.
 */
export const MISMATCH_RECOVERY_THRESHOLD = 3;

export type BtcBackfillFailureCode =
  | "PROVIDER_THROTTLED"   // 429/503 after bounded retries, or a backoff past the deadline
  | "PROVIDER_TIMEOUT"     // a request exceeded its own timeout
  | "PROVIDER_ERROR"       // HTTP / network failure, or a cursor that did not advance
  | "INVALID_DATA"         // a response that cannot be read as confirmed transactions
  | "NO_ADDRESSES";        // the wallet has no address to list

/** The boundary transaction of a settled region, and every txid folded in its block. */
export interface BtcEdge {
  txid: string;
  height: number;
  /** Txids already folded at `height` — the dedupe set for that block. */
  blockTxids: string[];
  /**
   * BOTTOM only: the last txid folded in the block ABOVE `height`. A resumed
   * walk pages after IT, so the whole bottom block is listed again and deduped
   * by `blockTxids` — the explorer's order WITHIN a block is not a documented
   * contract, and paging after a mid-block txid could skip a reordered one.
   * Null until the bottom has crossed one block boundary.
   */
  resumeTxid?: string | null;
}

export interface BtcAddressProgress {
  address: string;
  /** Newest SETTLED transaction folded; the head phase lists down to it. */
  top: BtcEdge | null;
  /** Oldest transaction folded; the next page continues after `bottom.txid`. */
  bottom: BtcEdge | null;
  /** A short page below `bottom` proved there is nothing older. */
  reachedBeginning: boolean;
  /** Settled totals, satoshis as decimal strings (JSON-safe). */
  funded: string;
  spent: string;
  txCount: number;
  /** Settled net flow per block: [height, block_time (s), signed sats], ascending height. */
  blocks: Array<[number, number, string]>;
  /**
   * When the listing last matched chain_stats exactly with NO shallow head.
   * Cleared whenever anything new is folded for the address.
   */
  verifiedAtISO: string | null;
}

export interface BtcRecovery {
  reason: "BALANCE_MISMATCH" | "HEAD_BOUNDARY_LOST";
  address: string;
  detail: string;
  detectedAtISO: string;
}

export interface BtcBackfillCheckpoint {
  kind: typeof BTC_BACKFILL_KIND;
  v: typeof BTC_BACKFILL_VERSION;
  accountId: string;
  /** Sorted by address — deterministic order. */
  addresses: BtcAddressProgress[];
  /** Index into `addresses` where the next run starts its verification visits (rotation). */
  verifyCursor: number;
  /** Earliest day of a settled transaction folded since the rows were last written. */
  dirtyFromISO: string | null;
  /** True once THIS checkpoint generation has written rows (the first proof replaces all). */
  provenOnce: boolean;
  /** The licensed interval of the rows in force (this path's, once proven). */
  licensedFromISO: string | null;
  licensedToISO: string | null;
  /** Earliest day whose stored row included SHALLOW (unsettled) transactions. */
  headFromISO: string | null;
  headVerifiedAtISO: string | null;
  /** Set while the listing does not reconcile with chain_stats (never by itself a failure). */
  headUnverifiedSinceISO: string | null;
  mismatchStreak: number;
  recovery: BtcRecovery | null;
  /**
   * OWNER DECISION 2026-10-28 (as for Solana) — PRESERVE VALIDATED LEGACY HISTORY.
   * "STAGING": the wallet carries a licensed history from the wholesale path.
   * Bitcoin proves nothing until the whole listing reconciles, so this path
   * writes NO rows and NO licence before that — the legacy history stays in
   * force untouched — and the first proof replaces it in ONE transaction.
   */
  mode?: "DIRECT" | "STAGING";
  legacy?: { fromISO: string; toISO: string } | null;
  promotedAtISO?: string | null;
  /** Days on which the proof disagreed with the legacy rows it replaced (disclosed, never hidden). */
  legacyDiscrepancy?: { days: number; firstISO: string; detectedAtISO: string } | null;
  /** Requests this wallet's backfill sent on `dayISO` (UTC), by ANY caller — the worker's daily cap. */
  usage?: { dayISO: string; requests: number } | null;
  /** The worker wrote rows from this date and has not regenerated wealth history over them yet. */
  snapshotPendingFromISO?: string | null;
  failures: number;
  lastFailure: { code: BtcBackfillFailureCode; atISO: string; detail?: string } | null;
  txsProcessed: number;
  startedAtISO: string;
  lastProgressAtISO: string | null;
  completedAtISO: string | null;
}

export function emptyProgress(address: string): BtcAddressProgress {
  return { address, top: null, bottom: null, reachedBeginning: false, funded: "0", spent: "0", txCount: 0, blocks: [], verifiedAtISO: null };
}

export function emptyCheckpoint(accountId: string, nowISO: string): BtcBackfillCheckpoint {
  return {
    kind: BTC_BACKFILL_KIND, v: BTC_BACKFILL_VERSION, accountId,
    addresses: [], verifyCursor: 0, dirtyFromISO: null, provenOnce: false,
    licensedFromISO: null, licensedToISO: null, headFromISO: null,
    headVerifiedAtISO: null, headUnverifiedSinceISO: null, mismatchStreak: 0, recovery: null,
    failures: 0, lastFailure: null, txsProcessed: 0,
    startedAtISO: nowISO, lastProgressAtISO: null, completedAtISO: null,
  };
}

const edgeOk = (e: unknown) => e === null || (typeof e === "object" && e !== null
  && typeof (e as BtcEdge).txid === "string" && Number.isSafeInteger((e as BtcEdge).height)
  && Array.isArray((e as BtcEdge).blockTxids) && (e as BtcEdge).blockTxids.every((t) => typeof t === "string"));

/**
 * Read a stored checkpoint. Anything that is not THIS account's BTC checkpoint
 * at THIS version is "no checkpoint" — the run starts a fresh generation
 * rather than trusting a shape it did not write.
 */
export function parseCheckpoint(raw: string | null | undefined, accountId: string): BtcBackfillCheckpoint | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<BtcBackfillCheckpoint>;
  if (c.kind !== BTC_BACKFILL_KIND || c.v !== BTC_BACKFILL_VERSION || c.accountId !== accountId) return null;
  if (!Array.isArray(c.addresses) || !Number.isSafeInteger(c.verifyCursor) || typeof c.failures !== "number" || typeof c.provenOnce !== "boolean") return null;
  for (const a of c.addresses) {
    if (!a || typeof a.address !== "string" || typeof a.reachedBeginning !== "boolean" || !edgeOk(a.top ?? null) || !edgeOk(a.bottom ?? null)) return null;
    if ((a.top == null) !== (a.bottom == null)) return null;
    if (!/^\d+$/.test(String(a.funded)) || !/^\d+$/.test(String(a.spent)) || !Number.isSafeInteger(a.txCount)) return null;
    if (!Array.isArray(a.blocks) || !a.blocks.every((b) => Array.isArray(b) && b.length === 3
      && Number.isSafeInteger(b[0]) && Number.isFinite(b[1]) && /^-?\d+$/.test(String(b[2])))) return null;
    if (a.verifiedAtISO !== null && typeof a.verifiedAtISO !== "string") return null;
  }
  if (c.mode !== undefined && c.mode !== "DIRECT" && c.mode !== "STAGING") return null;
  return c as BtcBackfillCheckpoint;
}

export function serializeCheckpoint(cp: BtcBackfillCheckpoint): string {
  return JSON.stringify(cp);
}

// ── Reading one transaction ──────────────────────────────────────────────────

/** The subset of an Esplora transaction the proof reads. */
export interface EsploraTxForProof {
  txid: string;
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } | null }>;
  vout: Array<{ scriptpubkey_address?: string; value?: number }>;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
}

export class BtcProofDataError extends Error {
  constructor(message: string) { super(message); this.name = "BtcProofDataError"; }
}

/** One listed transaction, reduced to what the proof needs for ONE address. */
export interface BtcTxPoint {
  txid: string;
  height: number;
  /** Raw `block_time`, seconds. */
  time: number;
  /** UTC day of the RAW block time (the Transaction row's date). */
  dateISO: string;
  /** Satoshis paid TO the address by this transaction's outputs. */
  funded: bigint;
  /** Satoshis of the address's earlier outputs this transaction spends. */
  spent: bigint;
}

const sats = (n: unknown, what: string, txid: string): bigint => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new BtcProofDataError(`transaction ${txid}: ${what} is not a satoshi integer`);
  return BigInt(n);
};

/**
 * Funded/spent for `address` in one CONFIRMED transaction. Throws on anything
 * that cannot be read exactly — a proof built on a guessed value is not one.
 */
export function pointFromTransaction(tx: EsploraTxForProof, address: string): BtcTxPoint {
  const txid = typeof tx?.txid === "string" ? tx.txid : "";
  if (!txid) throw new BtcProofDataError("a listed transaction has no txid");
  const st = tx.status;
  if (!st || st.confirmed !== true) throw new BtcProofDataError(`transaction ${txid}: not confirmed (the chain listing must contain confirmed transactions only)`);
  if (!Number.isSafeInteger(st.block_height) || (st.block_height as number) < 0) throw new BtcProofDataError(`transaction ${txid}: no block height`);
  if (typeof st.block_time !== "number" || !Number.isFinite(st.block_time) || st.block_time <= 0) throw new BtcProofDataError(`transaction ${txid}: no block time, so it cannot be dated`);
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw new BtcProofDataError(`transaction ${txid}: inputs/outputs missing`);
  let funded = BigInt(0);
  let spent = BigInt(0);
  for (const o of tx.vout) if (o?.scriptpubkey_address === address) funded += sats(o.value, "an output value", txid);
  for (const i of tx.vin) if (i?.prevout?.scriptpubkey_address === address) spent += sats(i.prevout.value, "a spent output value", txid);
  return { txid, height: st.block_height as number, time: st.block_time, dateISO: new Date(st.block_time * 1000).toISOString().slice(0, 10), funded, spent };
}

/** Is a transaction at `height` settled (at least `depth` blocks deep) under `tipHeight`? */
export function isSettled(height: number, tipHeight: number, depth: number): boolean {
  return tipHeight - height + 1 >= depth;
}

// ── Folding ──────────────────────────────────────────────────────────────────

/** Mutable working state for one address during a run. */
export interface ProgressWork {
  p: BtcAddressProgress;
  funded: bigint;
  spent: bigint;
  blocks: Map<number, { time: number; sats: bigint }>;
}

export function workOf(p: BtcAddressProgress): ProgressWork {
  return { p: { ...p, top: p.top && { ...p.top, blockTxids: [...p.top.blockTxids] }, bottom: p.bottom && { ...p.bottom, blockTxids: [...p.bottom.blockTxids] } },
    funded: BigInt(p.funded), spent: BigInt(p.spent), blocks: new Map(p.blocks.map(([h, t, s]) => [h, { time: t, sats: BigInt(s) }])) };
}

export function progressOf(w: ProgressWork): BtcAddressProgress {
  const blocks: Array<[number, number, string]> = [...w.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([h, b]) => [h, b.time, b.sats.toString()]);
  return { ...w.p, funded: w.funded.toString(), spent: w.spent.toString(), blocks };
}

/** Add one settled point's net flow to the address's blocks and totals; its verification no longer holds. */
export function foldPoint(w: ProgressWork, t: BtcTxPoint): void {
  w.funded += t.funded;
  w.spent += t.spent;
  w.p.txCount += 1;
  const b = w.blocks.get(t.height);
  w.blocks.set(t.height, { time: t.time, sats: (b?.sats ?? BigInt(0)) + t.funded - t.spent });
  w.p.verifiedAtISO = null;
}

/**
 * Is a point listed while walking BACKWARD already folded? Above the bottom's
 * block, or in it and already counted — a repeated page, a repeated boundary
 * transaction, or a provider that ignored the cursor.
 */
export function isFoldedBelowCheck(bottom: BtcEdge | null, t: { txid: string; height: number }): boolean {
  if (!bottom) return false;
  return t.height > bottom.height || (t.height === bottom.height && bottom.blockTxids.includes(t.txid));
}

/** Move the bottom edge to `t` (an older, newly folded point). */
export function lowerBottom(w: ProgressWork, t: { txid: string; height: number }): void {
  const b = w.p.bottom;
  if (b && b.height === t.height) { b.txid = t.txid; b.blockTxids.push(t.txid); }
  // Crossing into an older block: resume after the newer block's last txid.
  else w.p.bottom = { txid: t.txid, height: t.height, blockTxids: [t.txid], resumeTxid: b ? b.txid : null };
  // A point in the top's own block belongs to the top's dedupe set as well.
  const top = w.p.top;
  if (top && top.height === t.height && !top.blockTxids.includes(t.txid)) top.blockTxids.push(t.txid);
}

/** Raise the top edge to `t` (a newer, newly settled point). */
export function raiseTop(w: ProgressWork, t: { txid: string; height: number }): void {
  const top = w.p.top;
  if (top && top.height === t.height) { top.txid = t.txid; if (!top.blockTxids.includes(t.txid)) top.blockTxids.push(t.txid); }
  else w.p.top = { txid: t.txid, height: t.height, blockTxids: [t.txid] };
}

/**
 * Split the transactions listed ABOVE the top (newest first) into the settled
 * run adjacent to the top (oldest first — fold these) and the shallow head
 * (count only in this run's verification). Heights are non-increasing in the
 * listing, so settledness is a prefix of the oldest-first order.
 */
export function splitHead(aboveNewestFirst: readonly BtcTxPoint[], tipHeight: number, depth: number): { settled: BtcTxPoint[]; shallow: BtcTxPoint[] } {
  const oldestFirst = [...aboveNewestFirst].reverse();
  let i = 0;
  while (i < oldestFirst.length && isSettled(oldestFirst[i].height, tipHeight, depth)) i++;
  return { settled: oldestFirst.slice(0, i), shallow: oldestFirst.slice(i) };
}

// ── Days ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export function addDaysISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The wallet's net flow per UTC day, from every address's settled blocks plus
 * this run's shallow points, each block dated by the MONOTONE block time — the
 * latest `block_time` among the wallet's blocks at or below its height. So the
 * day sequence follows chain order and every end-of-day sum is a chain-order
 * prefix (never negative for a correct listing).
 */
export function walletDays(
  progress: ReadonlyArray<Pick<BtcAddressProgress, "blocks">>, extra: ReadonlyArray<Pick<BtcTxPoint, "height" | "time" | "funded" | "spent">> = [],
): Map<string, bigint> {
  const byHeight = new Map<number, { time: number; sats: bigint }>();
  const add = (h: number, time: number, sats: bigint) => {
    const b = byHeight.get(h);
    byHeight.set(h, { time: b ? Math.max(b.time, time) : time, sats: (b?.sats ?? BigInt(0)) + sats });
  };
  for (const p of progress) for (const [h, t, s] of p.blocks) add(h, t, BigInt(s));
  for (const t of extra) add(t.height, t.time, t.funded - t.spent);
  const days = new Map<string, bigint>();
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const [, b] of [...byHeight.entries()].sort((a, c) => a[0] - c[0])) {
    maxTime = Math.max(maxTime, b.time);
    const d = new Date(maxTime * 1000).toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? BigInt(0)) + b.sats);
  }
  return days;
}

/**
 * End-of-day satoshis for every day in [fromISO, toISO]: the running sum of
 * every day's net flow from the FIRST transaction. A day before the first
 * transaction gets NO entry — never a zero. A negative running sum is refused:
 * it can only mean the listing (or its dating) is wrong.
 */
export function dailyClosings(days: ReadonlyMap<string, bigint>, fromISO: string, toISO: string): Array<{ dateISO: string; sats: bigint }> {
  const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sorted.length === 0 || fromISO > toISO) return [];
  const out: Array<{ dateISO: string; sats: bigint }> = [];
  let i = 0;
  let running = BigInt(0);
  let started = false;
  // Fold everything strictly before the range first.
  while (i < sorted.length && sorted[i][0] < fromISO) { running += sorted[i][1]; started = true; i++; }
  for (let d = fromISO, guard = 0; d <= toISO && guard < 20_000; d = addDaysISO(d, 1), guard++) {
    while (i < sorted.length && sorted[i][0] <= d) { running += sorted[i][1]; started = true; i++; }
    if (!started) continue;
    if (running < BigInt(0)) throw new BtcProofDataError(`the chain-ordered sum is negative on ${d}`);
    out.push({ dateISO: d, sats: running });
  }
  return out;
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface ChainStats { funded: bigint; spent: bigint; txCount: number }

/** Esplora `/address/:a` → its CONFIRMED chain_stats, or a data error. */
export function parseChainStats(json: unknown): ChainStats {
  const cs = (json as { chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown; tx_count?: unknown } } | null)?.chain_stats;
  const ok = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!cs || !ok(cs.funded_txo_sum) || !ok(cs.spent_txo_sum) || !ok(cs.tx_count)) {
    throw new BtcProofDataError("unexpected address response shape (missing chain_stats)");
  }
  return { funded: BigInt(cs.funded_txo_sum as number), spent: BigInt(cs.spent_txo_sum as number), txCount: cs.tx_count as number };
}

/** Does settled + shallow equal the observed chain_stats, all three? Null when it does. */
export function statsMismatch(expected: ChainStats, observed: ChainStats): string | null {
  if (expected.funded === observed.funded && expected.spent === observed.spent && expected.txCount === observed.txCount) return null;
  return `listed funded ${expected.funded} / spent ${expected.spent} / ${expected.txCount} txs; `
    + `chain_stats funded ${observed.funded} / spent ${observed.spent} / ${observed.txCount} txs`;
}

// ── Customer / operator state ────────────────────────────────────────────────

export type BtcBackfillState =
  /** Queued; nothing settled has been imported yet. */
  | "QUEUED"
  /** Older activity is still being imported; no Bitcoin-proven licence yet (or a re-proof is owed). */
  | "IMPORTING"
  /** Every address listed to its first transaction and reconciled with chain_stats. */
  | "COMPLETE"
  /** Repeated provider failures; retried automatically once a day. Proven history is kept. */
  | "FAILED"
  /** The listing persistently disagrees with chain_stats, or the settled top vanished. Needs an operator. */
  | "RECOVERY_REQUIRED";

export interface BtcBackfillStatus {
  state: BtcBackfillState;
  /** The licensed interval in force, when there is one — "history shown from …". */
  historyFromISO: string | null;
  historyToISO: string | null;
  /** Oldest day imported so far — progress, NOT a licence. */
  importedBackToISO: string | null;
  partial: boolean;
  retryable: boolean;
  lastFailureCode: BtcBackfillFailureCode | null;
  lastProgressAtISO: string | null;
  txsProcessed: number;
  /** False while the newest activity does not reconcile with chain_stats. */
  headVerified: boolean;
  /** True while the wholesale path's validated history is still the one shown. */
  legacyInForce: boolean;
  legacyDiscrepancy: { days: number; firstISO: string } | null;
  recovery: BtcRecovery | null;
}

export function allReachedBeginning(cp: Pick<BtcBackfillCheckpoint, "addresses">): boolean {
  return cp.addresses.length > 0 && cp.addresses.every((a) => a.reachedBeginning);
}

export function backfillStatus(cp: BtcBackfillCheckpoint | null): BtcBackfillStatus {
  if (!cp) {
    return { state: "QUEUED", historyFromISO: null, historyToISO: null, importedBackToISO: null, partial: false, retryable: true,
      lastFailureCode: null, lastProgressAtISO: null, txsProcessed: 0, headVerified: false, legacyInForce: false,
      legacyDiscrepancy: null, recovery: null };
  }
  const base = {
    historyFromISO: cp.licensedFromISO, historyToISO: cp.licensedToISO,
    importedBackToISO: cp.addresses.flatMap((a) => a.blocks.length ? [new Date(a.blocks[0][1] * 1000).toISOString().slice(0, 10)] : []).sort()[0] ?? null,
    lastFailureCode: cp.lastFailure?.code ?? null, lastProgressAtISO: cp.lastProgressAtISO, txsProcessed: cp.txsProcessed,
    headVerified: cp.provenOnce && !cp.headUnverifiedSinceISO,
    legacyInForce: cp.mode === "STAGING",
    legacyDiscrepancy: cp.legacyDiscrepancy ? { days: cp.legacyDiscrepancy.days, firstISO: cp.legacyDiscrepancy.firstISO } : null,
    recovery: cp.recovery,
  };
  const hasHistory = cp.licensedFromISO !== null;
  if (cp.recovery) return { ...base, state: "RECOVERY_REQUIRED", partial: hasHistory, retryable: false };
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES) return { ...base, state: "FAILED", partial: hasHistory, retryable: true };
  if (cp.provenOnce && cp.completedAtISO && allReachedBeginning(cp)) return { ...base, state: "COMPLETE", partial: false, retryable: true };
  if (cp.txsProcessed === 0 && !allReachedBeginning(cp)) return { ...base, state: "QUEUED", partial: false, retryable: true };
  return { ...base, state: "IMPORTING", partial: true, retryable: true };
}

/** Should an automatic (scheduled / user-sync) run do work now? Operator resume bypasses this. */
export function shouldRunAutomatically(cp: BtcBackfillCheckpoint | null, nowMs: number): { run: boolean; why?: string } {
  if (!cp) return { run: true };
  if (cp.recovery) return { run: false, why: "history does not reconcile — recovery required" };
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES && cp.lastFailure) {
    const since = nowMs - Date.parse(cp.lastFailure.atISO);
    if (since < FAILED_RETRY_INTERVAL_MS) return { run: false, why: "repeated provider failures — next automatic retry within a day" };
  }
  return { run: true };
}

/**
 * Reconcile the checkpoint's addresses with the wallet's current address set.
 * New addresses join fresh (an xpub's newly used receive address). An address
 * that LEFT the set cannot be un-summed from the day map, so it returns
 * `shrank: true` and the caller starts a new generation.
 */
export function mergeAddresses(progress: readonly BtcAddressProgress[], addresses: readonly string[]): { addresses: BtcAddressProgress[]; shrank: boolean; added: number } {
  const want = new Set(addresses);
  const shrank = progress.some((p) => !want.has(p.address));
  const have = new Map(progress.map((p) => [p.address, p]));
  let added = 0;
  const out = [...want].sort().map((a) => { const p = have.get(a); if (p) return p; added++; return emptyProgress(a); });
  return { addresses: out, shrank, added };
}

// ── Legacy comparison (disclosure only — Bitcoin proves nothing before the whole) ─

/**
 * Days where the proof disagrees with the wholesale path's rows. legacy.toISO is
 * EXCLUDED, as for Solana: the old licence ran through the day of a midday
 * balance reading, which later activity that day legitimately moves.
 */
export function legacyDiscrepancy(
  proven: ReadonlyArray<{ dateISO: string; sats: bigint }>, legacy: { fromISO: string; toISO: string }, legacyRows: ReadonlyMap<string, number>,
): { days: number; firstISO: string } | null {
  let days = 0;
  let firstISO: string | null = null;
  for (const r of proven) {
    if (r.dateISO < legacy.fromISO || r.dateISO >= legacy.toISO) continue;
    const q = legacyRows.get(r.dateISO);
    if (q === undefined) continue;
    if (Math.abs(Number(r.sats) / 1e8 - q) > 5e-9) { days++; if (!firstISO) firstISO = r.dateISO; }
  }
  return days > 0 ? { days, firstISO: firstISO! } : null;
}

/** How long a persisted per-address verification is relied on before a worker revisit. */
export const REVERIFY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Does a wallet need a (rate-limited) worker visit even though it is not
 * importing? A COMPLETE wallet whose addresses are not all verified, or whose
 * oldest verification is stale — a large xpub that a 15 s sync cannot
 * re-verify in one go.
 */
export function needsVerificationVisit(cp: BtcBackfillCheckpoint | null, nowMs: number): boolean {
  if (!cp || cp.addresses.length === 0) return false;
  return cp.addresses.some((a) => !a.verifiedAtISO || nowMs - Date.parse(a.verifiedAtISO) >= REVERIFY_AFTER_MS);
}

/** Requests recorded for `dayISO` in a checkpoint (0 when the day differs). */
export function usageOn(cp: Pick<BtcBackfillCheckpoint, "usage"> | null, dayISO: string): number {
  return cp?.usage && cp.usage.dayISO === dayISO && Number.isFinite(cp.usage.requests) ? cp.usage.requests : 0;
}

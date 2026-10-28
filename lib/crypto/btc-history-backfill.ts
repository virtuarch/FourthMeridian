/**
 * lib/crypto/btc-history-backfill.ts
 *
 * RESUMABLE BITCOIN HISTORY — fetch, schedule, write. The proof model lives in
 * btc-history-backfill.core.ts; read that first.
 *
 * ONE RUN, bounded by WALL-CLOCK and (worker) a request allowance — never by a
 * transaction count:
 *
 *   0. ENQUEUE   a fresh wallet's checkpoint is committed before any network,
 *                so the background worker can see it.
 *   1. TIP       one request: the chain tip height, which decides what is
 *                settled (≥ `depth` blocks deep) and what is shallow.
 *   2. HEAD      per address with a settled top: list `/txs/chain` from the
 *                newest down to the top, fold the newly SETTLED transactions,
 *                keep the shallow ones for this run's verification only.
 *   3. HISTORY   per address not yet at its beginning: page
 *                `/txs/chain/:bottom` (or from the newest, for a fresh address),
 *                folding every transaction; a short page is the beginning.
 *   4. VERIFY    when every address has reached its beginning, its head was
 *                listed this run, and the address set is complete: read each
 *                address's chain_stats and require settled + shallow to equal
 *                them exactly. Only then are rows written and licensed.
 *
 * Every commit is ONE transaction: the checkpoint by compare-and-swap on the
 * value this run last read or wrote, the page's movements as Transaction rows
 * (idempotent, the existing BTC import), and — on a proof — the DERIVED rows and
 * the coverage licence. Stopping is always safe: what was committed stays, what
 * was not is re-listed next run, and a repeated listing is deduped by block.
 *
 * Runs inside the caller's wallet sync lock (lib/refresh/wallet-lock.ts) or the
 * worker's claim of the same lock; the default budgets sit far inside its TTL.
 */

import { BTC_NATIVE } from "./native-asset";
import {
  esploraGetJson, btcExplorerBaseUrl, btcBalanceBaseUrl, BtcSyncError,
  type FetchFn, type RawBtcTx, type BtcSyncStage,
} from "./btc-explorer";
import { baseUnitsToWhole, type ChainCoverage } from "./chain-movement";
import {
  emptyCheckpoint, parseCheckpoint, serializeCheckpoint, pointFromTransaction, isSettled,
  workOf, progressOf, foldPoint, isFoldedBelowCheck, lowerBottom, raiseTop, splitHead,
  daysToMap, mapToDays, dailyClosings, addDaysISO, parseChainStats, statsMismatch,
  backfillStatus, shouldRunAutomatically, mergeAddresses, allReachedBeginning, legacyDiscrepancy, usageOn,
  BtcProofDataError, BTC_CHAIN_STATS_SOURCE, ESPLORA_PAGE_SIZE, DEFAULT_CONFIRMATION_DEPTH, MISMATCH_RECOVERY_THRESHOLD,
  type BtcBackfillCheckpoint, type BtcBackfillFailureCode, type BtcBackfillStatus, type BtcTxPoint,
  type ProgressWork, type ChainStats, type EsploraTxForProof,
} from "./btc-history-backfill.core";

/** Budget for a run inside a WALLET SYNC while the background worker carries history. */
export const DEFAULT_RUN_BUDGET_MS = 15_000;
/** Without the worker, syncs carry history alone (as Solana's standalone 45 s). */
export const STANDALONE_RUN_BUDGET_MS = 45_000;
/** Pages between checkpoint commits (25 transactions each). */
export const DEFAULT_COMMIT_EVERY_PAGES = 8;

/**
 * Is the background history worker carrying Bitcoin? It is the SAME job as
 * Solana's (jobs/sol-history-backfill.ts, gated by SOL_BACKFILL_ENABLED), with
 * Bitcoin on unless BTC_BACKFILL_ENABLED=false.
 */
export function btcWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SOL_BACKFILL_ENABLED === "true" && env.BTC_BACKFILL_ENABLED !== "false";
}
/** While the worker carries Bitcoin, a wallet sync proves only new activity. */
export function btcSyncHeadOnly(env: Record<string, string | undefined> = process.env): boolean {
  return btcWorkerEnabled(env);
}
export function btcSyncRunBudgetMs(env: Record<string, string | undefined> = process.env): number {
  return btcWorkerEnabled(env) ? DEFAULT_RUN_BUDGET_MS : STANDALONE_RUN_BUDGET_MS;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class CheckpointConflictError extends Error {
  constructor() { super("the Bitcoin history checkpoint moved under this run (another run advanced it)"); this.name = "CheckpointConflictError"; }
}

export interface BtcBackfillCommit {
  /** The checkpoint this run last read or wrote — compare-and-swap. */
  expectedCursor: string | null;
  nextCursor: string;
  /** First proof of a generation: remove every DERIVED row this source owns (legacy rows included). */
  replaceAll: boolean;
  deleteFromISO: string | null;
  deleteToISO: string | null;
  /** Whole BTC by date. */
  rows: Array<{ dateISO: string; quantity: number }>;
  /** Null: leave the stored licence as it is. */
  coverage: ChainCoverage | null;
  /** Confirmed transactions listed since the last commit — imported as Transaction rows (idempotent). */
  rawTxs: RawBtcTx[];
}

export interface BtcBackfillStore {
  readCursor(): Promise<string | null>;
  /** The wallet's REAL addresses, and whether that set is final (xpub discovery finished). */
  addresses(): Promise<{ addresses: string[]; complete: boolean }>;
  /** One transaction. Throws CheckpointConflictError when the stored checkpoint is not `expectedCursor`. */
  commit(c: BtcBackfillCommit): Promise<void>;
  /** The wholesale path's LICENSED history, when there is one. */
  legacy?(): Promise<{ fromISO: string; toISO: string; rows: Map<string, number> } | null>;
}

// ── Deps / outcome ───────────────────────────────────────────────────────────

export interface BtcBackfillDeps {
  fetchImpl?: FetchFn;
  explorerBaseUrl?: string;
  balanceBaseUrl?: string;
  budgetMs?: number;
  /** Stop (as for the wall clock) once this many requests were sent in the run. */
  requestBudget?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Awaited before EVERY request (incl. retries) — the worker's rate limiter. */
  beforeRequest?: () => Promise<void>;
  /** Counts every request (incl. retries) by kind: tip, txs, stats. */
  meter?: Record<string, number>;
  /** HEAD only: prove new activity, leave older history to the worker. */
  headOnly?: boolean;
  confirmationDepth?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  requestTimeoutMs?: number;
  commitEveryPages?: number;
}

export interface BtcBackfillOutcome {
  status: BtcBackfillStatus;
  progressed: boolean;
  rowsWritten: number;
  /** Earliest date whose stored quantity this run changed (drives the snapshot rebuild window). */
  impactedFromISO: string | null;
  txsProcessed: number;
  pagesFetched: number;
  /** null: verification was not reached this run. */
  verified: boolean | null;
  stoppedBecause: "COMPLETE" | "BUDGET" | "FAILURE" | "RECOVERY" | "UNVERIFIED" | "CONFLICT" | "SKIPPED" | "IDLE";
  /** Set on the run whose first proof replaced the wholesale path's licensed history. */
  promoted?: "PROVEN" | null;
  failure: { code: BtcBackfillFailureCode | "CHECKPOINT_CONFLICT"; detail: string } | null;
}

const toBtc = (s: bigint) => baseUnitsToWhole(s, BTC_NATIVE.decimals);

function failureCodeOf(e: unknown): BtcBackfillFailureCode {
  if (e instanceof BtcProofDataError) return "INVALID_DATA";
  if (e instanceof BtcSyncError) {
    if (e.kind === "THROTTLED") return "PROVIDER_THROTTLED";
    if (e.kind === "TIMEOUT") return "PROVIDER_TIMEOUT";
    if (e.kind === "INVALID_DATA") return "INVALID_DATA";
    return "PROVIDER_ERROR";
  }
  return "PROVIDER_ERROR";
}

class CursorStuckError extends Error {
  constructor(address: string) { super(`the explorer returned a full page with nothing new after the cursor for ${address.slice(0, 6)}… (it did not advance)`); this.name = "CursorStuckError"; }
}

class HeadLostError extends Error {
  constructor(public readonly address: string, message: string) { super(message); this.name = "HeadLostError"; }
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runBtcHistoryBackfill(
  args: { accountId: string; store: BtcBackfillStore; resume?: boolean },
  depsIn: BtcBackfillDeps = {},
): Promise<BtcBackfillOutcome> {
  const now = depsIn.now ?? Date.now;
  const startMs = now();
  const deadlineMs = startMs + (depsIn.budgetMs ?? envNumber("BTC_HISTORY_RUN_BUDGET_MS", btcSyncRunBudgetMs()));
  const depth = depsIn.confirmationDepth ?? envNumber("BTC_HISTORY_CONFIRMATIONS", DEFAULT_CONFIRMATION_DEPTH);
  const commitEvery = depsIn.commitEveryPages ?? DEFAULT_COMMIT_EVERY_PAGES;
  const nowISO = () => new Date(now()).toISOString();
  const todayISO = () => nowISO().slice(0, 10);
  // Every request is metered (an internal meter when the caller passes none),
  // so the checkpoint's daily usage is true for syncs as well as the worker.
  const meter = depsIn.meter ?? {};
  const deps: BtcBackfillDeps = { ...depsIn, meter };
  const sent = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const sentAtStart = sent();
  let recordedThrough = sentAtStart;
  const overBudget = (deadline: number) => now() >= deadline
    || (deps.requestBudget !== undefined && sent() - sentAtStart >= deps.requestBudget);

  let raw = await args.store.readCursor();
  let cp = parseCheckpoint(raw, args.accountId);
  const outcome: BtcBackfillOutcome = {
    status: backfillStatus(cp), progressed: false, rowsWritten: 0, impactedFromISO: null,
    txsProcessed: 0, pagesFetched: 0, verified: null, stoppedBecause: "IDLE", failure: null,
  };
  const impacted = (d: string) => { if (outcome.impactedFromISO === null || d < outcome.impactedFromISO) outcome.impactedFromISO = d; };

  if (args.resume && cp) {
    // Operator resume. A recovery means the listing could not be trusted, so
    // the import restarts as a NEW GENERATION — the rows and licence in force
    // stay exactly as they are until the new listing proves itself.
    cp = cp.recovery
      ? { ...emptyCheckpoint(args.accountId, nowISO()), mode: cp.mode, legacy: cp.legacy, usage: cp.usage,
          licensedFromISO: cp.licensedFromISO, licensedToISO: cp.licensedToISO, snapshotPendingFromISO: cp.snapshotPendingFromISO }
      : { ...cp, failures: 0, lastFailure: null, mismatchStreak: 0 };
  }
  if (!args.resume) {
    const gate = shouldRunAutomatically(cp, startMs);
    if (!gate.run) { outcome.stoppedBecause = "SKIPPED"; return outcome; }
  }

  let state: BtcBackfillCheckpoint = cp ?? emptyCheckpoint(args.accountId, nowISO());
  if (state.mode === undefined) {
    const legacy = args.store.legacy ? await args.store.legacy() : null;
    state = legacy ? { ...state, mode: "STAGING", legacy: { fromISO: legacy.fromISO, toISO: legacy.toISO } } : { ...state, mode: "DIRECT", legacy: null };
  }

  let pendingRaw: RawBtcTx[] = [];
  let dirty = cp === null || raw !== serializeCheckpoint(state);
  /** Folds the run's in-memory progress into `state` (set once the work map exists). */
  let absorb = () => {};
  const stamp = (c: BtcBackfillCheckpoint): BtcBackfillCheckpoint => {
    const day = todayISO();
    const delta = sent() - recordedThrough;
    recordedThrough = sent();
    return { ...c, usage: { dayISO: day, requests: usageOn(c, day) + delta } };
  };
  const commit = async (extra: { rows?: Array<{ dateISO: string; sats: bigint }>; span?: { from: string; to: string } | null; replaceAll?: boolean; coverage?: ChainCoverage | null } = {}) => {
    const next = stamp(state);
    const nextRaw = serializeCheckpoint(next);
    const seen = new Set<string>();
    const rawTxs = pendingRaw.filter((t) => (seen.has(t.txid) ? false : (seen.add(t.txid), true)));
    const rows = extra.rows ?? [];
    await args.store.commit({
      expectedCursor: raw, nextCursor: nextRaw, replaceAll: extra.replaceAll ?? false,
      deleteFromISO: extra.span?.from ?? null, deleteToISO: extra.span?.to ?? null,
      rows: rows.map((r) => ({ dateISO: r.dateISO, quantity: toBtc(r.sats) })), coverage: extra.coverage ?? null, rawTxs,
    });
    raw = nextRaw; state = next; pendingRaw = []; dirty = false;
    if (rows.length > 0) { outcome.rowsWritten += rows.length; impacted(rows[0].dateISO); }
  };
  const fail = async (code: BtcBackfillFailureCode, detail: string) => {
    outcome.failure = { code, detail };
    outcome.stoppedBecause = "FAILURE";
    // Transactions folded before the failure were listed in chain order up to
    // the bottom edge, so they are kept and the next run continues after it.
    absorb();
    state = { ...state, failures: state.failures + 1, lastFailure: { code, atISO: nowISO(), detail: detail.slice(0, 300) } };
    try { await commit(); } catch (e) { if (!(e instanceof CheckpointConflictError)) throw e; }
  };
  const finish = async () => {
    // Requests a run sent without committing still count against the day.
    if (sent() > recordedThrough || dirty) {
      try { await commit(); } catch (e) {
        if (!(e instanceof CheckpointConflictError)) throw e;
        // Another run advanced the checkpoint first: this run's uncommitted
        // progress is discarded (it will be re-listed), never merged blindly.
        outcome.stoppedBecause = "CONFLICT";
        outcome.failure = { code: "CHECKPOINT_CONFLICT", detail: e.message };
      }
    }
    outcome.status = backfillStatus(state);
    return outcome;
  };

  try {
    // ── Address set ─────────────────────────────────────────────────────────
    const set = await args.store.addresses();
    if (set.addresses.length === 0) { await fail("NO_ADDRESSES", "the wallet has no address to list"); return await finish(); }
    const merged = mergeAddresses(state.addresses, set.addresses);
    if (merged.shrank) {
      // An address left the set: its flows cannot be un-summed. New generation;
      // rows and licence in force are kept until the new listing proves itself.
      state = { ...emptyCheckpoint(args.accountId, nowISO()), mode: state.mode, legacy: state.legacy, usage: state.usage,
        licensedFromISO: state.licensedFromISO, licensedToISO: state.licensedToISO, snapshotPendingFromISO: state.snapshotPendingFromISO,
        addresses: mergeAddresses([], set.addresses).addresses };
      dirty = true;
    } else if (merged.added > 0 || state.addresses.length !== merged.addresses.length) {
      // A new address re-opens the import (and a re-proof) — kept rows stay.
      state = { ...state, addresses: merged.addresses, completedAtISO: merged.added > 0 ? null : state.completedAtISO };
      dirty = true;
    }

    // ── 0. ENQUEUE ──────────────────────────────────────────────────────────
    if (dirty) await commit();

    // ── Transport ───────────────────────────────────────────────────────────
    const fetchImpl = deps.fetchImpl ?? fetch;
    const explorer = (deps.explorerBaseUrl ?? btcExplorerBaseUrl()).replace(/\/+$/, "");
    const balance = (deps.balanceBaseUrl ?? btcBalanceBaseUrl()).replace(/\/+$/, "");
    const get = (url: string, stage: BtcSyncStage, kind: string) => esploraGetJson(url, stage, fetchImpl, {
      deadlineMs, now, sleep: deps.sleep, beforeRequest: deps.beforeRequest,
      onAttempt: () => { meter[kind] = (meter[kind] ?? 0) + 1; },
      maxRetries: deps.maxRetries, backoffBaseMs: deps.backoffBaseMs, timeoutMs: deps.requestTimeoutMs,
    });
    const listPage = async (address: string, after: string | null): Promise<EsploraTxForProof[]> => {
      const url = `${explorer}/api/address/${encodeURIComponent(address)}/txs/chain${after ? `/${encodeURIComponent(after)}` : ""}`;
      const json = await get(url, "transactions", "txs");
      outcome.pagesFetched++;
      if (!Array.isArray(json)) throw new BtcProofDataError("unexpected txs response shape (expected array)");
      return json as EsploraTxForProof[];
    };
    const stats = async (address: string): Promise<ChainStats> =>
      parseChainStats(await get(`${balance}/api/address/${encodeURIComponent(address)}`, "balance", "stats"));

    // ── 1. TIP ──────────────────────────────────────────────────────────────
    if (overBudget(deadlineMs)) { outcome.stoppedBecause = "BUDGET"; return await finish(); }
    const tipJson = await get(`${explorer}/api/blocks/tip/height`, "transactions", "tip");
    const tip = typeof tipJson === "number" ? tipJson : Number(tipJson);
    if (!Number.isSafeInteger(tip) || tip < 0) throw new BtcProofDataError("the explorer returned no chain tip height");

    const days = daysToMap(state.days);
    const work = new Map<string, ProgressWork>(state.addresses.map((a) => [a.address, workOf(a)]));
    /** Shallow (unsettled) points listed this run, per address; `listed` = the head was listed to its edge. */
    const head = new Map<string, { shallow: BtcTxPoint[]; listed: boolean }>();
    let foldedSinceCommit = 0;
    let pagesSinceCommit = 0;
    const markDirty = (d: string) => { if (state.dirtyFromISO === null || d < state.dirtyFromISO) state = { ...state, dirtyFromISO: d }; };
    absorb = () => {
      state = {
        ...state, days: mapToDays(days), addresses: state.addresses.map((a) => progressOf(work.get(a.address)!)),
        ...(foldedSinceCommit > 0 ? { lastProgressAtISO: nowISO(), failures: 0, lastFailure: null } : {}),
      };
      foldedSinceCommit = 0; pagesSinceCommit = 0; dirty = true;
    };
    /** Persist the in-memory progress (address totals + day map), then commit. */
    const flush = async () => { absorb(); await commit(); };
    const fold = (w: ProgressWork, t: BtcTxPoint) => {
      foldPoint(w, days, t);
      markDirty(t.dateISO);
      state = { ...state, txsProcessed: state.txsProcessed + 1 };
      outcome.txsProcessed++;
      foldedSinceCommit++;
      outcome.progressed = true;
    };

    /**
     * Walk BACKWARD from the bottom (or from the newest, for an address with
     * nothing settled yet), folding every transaction. Shallow transactions met
     * before the first settled one are this run's head. Returns why it stopped.
     */
    const walkBackward = async (w: ProgressWork, deadline: number): Promise<"BEGINNING" | "BUDGET"> => {
      const fromNewest = w.p.bottom === null;
      const shallow: BtcTxPoint[] = [];
      if (fromNewest) head.set(w.p.address, { shallow, listed: false });
      const seen = new Set<string>();
      let cursor = w.p.bottom?.txid ?? null;
      let prevHeight = Number.POSITIVE_INFINITY;
      for (;;) {
        if (overBudget(deadline)) return "BUDGET";
        const page = await listPage(w.p.address, cursor);
        let added = 0;
        for (const rawTx of page) {
          const t = pointFromTransaction(rawTx, w.p.address);
          if (seen.has(t.txid) || isFoldedBelowCheck(w.p.bottom, t)) continue; // duplicate delivery
          seen.add(t.txid);
          if (t.height > prevHeight) throw new BtcProofDataError(`the listing for ${w.p.address.slice(0, 6)}… is not in chain order`);
          prevHeight = t.height;
          added++;
          pendingRaw.push(rawTx as RawBtcTx);
          if (w.p.top === null) {
            if (!isSettled(t.height, tip, depth)) { shallow.push(t); continue; }
            w.p.top = { txid: t.txid, height: t.height, blockTxids: [] };
            raiseTop(w, t);
          }
          lowerBottom(w, t);
          fold(w, t);
        }
        pagesSinceCommit++;
        const short = page.length < ESPLORA_PAGE_SIZE;
        if (short) {
          w.p.reachedBeginning = true;
          if (fromNewest) head.set(w.p.address, { shallow, listed: true });
          await flush();
          return "BEGINNING";
        }
        if (added === 0) throw new CursorStuckError(w.p.address);
        if (fromNewest && w.p.top !== null) head.set(w.p.address, { shallow, listed: true });
        cursor = page[page.length - 1].txid;
        if (pagesSinceCommit >= commitEvery) await flush();
      }
    };

    /** List from the newest down to the settled top; fold what has settled since. */
    const extendHead = async (w: ProgressWork, deadline: number): Promise<"OK" | "BUDGET"> => {
      const top = w.p.top!;
      const above: BtcTxPoint[] = [];
      const aboveRaw: RawBtcTx[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let prevHeight = Number.POSITIVE_INFINITY;
      for (;;) {
        if (overBudget(deadline)) { head.set(w.p.address, { shallow: [], listed: false }); return "BUDGET"; }
        const page = await listPage(w.p.address, cursor);
        let found = false;
        for (const rawTx of page) {
          const t = pointFromTransaction(rawTx, w.p.address);
          if (seen.has(t.txid)) continue;
          seen.add(t.txid);
          if (t.height > prevHeight) throw new BtcProofDataError(`the listing for ${w.p.address.slice(0, 6)}… is not in chain order`);
          prevHeight = t.height;
          if (t.txid === top.txid) { found = true; break; }
          if (t.height > top.height || (t.height === top.height && !top.blockTxids.includes(t.txid))) {
            above.push(t); aboveRaw.push(rawTx as RawBtcTx);
          } else if (t.height < top.height) {
            throw new HeadLostError(w.p.address, `the settled top ${top.txid.slice(0, 10)}… (height ${top.height}) is no longer in the listing — a reorg deeper than ${depth} blocks or an inconsistent explorer`);
          }
        }
        if (found) break;
        if (page.length < ESPLORA_PAGE_SIZE) throw new HeadLostError(w.p.address, `the listing ended without reaching the settled top ${top.txid.slice(0, 10)}…`);
        cursor = page[page.length - 1].txid;
      }
      const { settled, shallow } = splitHead(above, tip, depth);
      for (const t of settled) { raiseTop(w, t); fold(w, t); }
      pendingRaw.push(...aboveRaw);
      head.set(w.p.address, { shallow, listed: true });
      return "OK";
    };

    // ── 2. HEAD ─────────────────────────────────────────────────────────────
    // Bounded to half the run while older history is owed, so a busy wallet's
    // new activity can never starve its backfill.
    const historyOwed = !allReachedBeginning(state);
    const headDeadline = historyOwed && !deps.headOnly ? startMs + Math.floor((deadlineMs - startMs) / 2) : deadlineMs;
    let budgetHit = false;
    for (const a of state.addresses) {
      const w = work.get(a.address)!;
      if (w.p.top) {
        if ((await extendHead(w, headDeadline)) === "BUDGET") { budgetHit = true; break; }
      } else if (w.p.reachedBeginning) {
        // Nothing settled yet at all (empty, or only shallow activity): the
        // head IS the whole listing, from the newest.
        w.p.reachedBeginning = false;
        if ((await walkBackward(w, headDeadline)) === "BUDGET") { budgetHit = true; break; }
      }
    }
    absorb();

    // ── 3. HISTORY ──────────────────────────────────────────────────────────
    if (!deps.headOnly && !budgetHit) {
      for (const a of state.addresses) {
        const w = work.get(a.address)!;
        if (w.p.reachedBeginning) continue;
        if ((await walkBackward(w, deadlineMs)) === "BUDGET") { budgetHit = true; break; }
      }
    }
    absorb();

    // ── 4. VERIFY ───────────────────────────────────────────────────────────
    const ready = set.complete && allReachedBeginning(state)
      && state.addresses.every((a) => head.get(a.address)?.listed === true);
    if (!ready) {
      outcome.stoppedBecause = budgetHit || !allReachedBeginning(state) ? "BUDGET" : "UNVERIFIED";
      return await finish();
    }
    let mismatch: { address: string; detail: string } | null = null;
    for (const a of state.addresses) {
      if (overBudget(deadlineMs)) { outcome.stoppedBecause = "BUDGET"; return await finish(); }
      const shallow = head.get(a.address)?.shallow ?? [];
      const expected: ChainStats = {
        funded: BigInt(a.funded) + shallow.reduce((s, t) => s + t.funded, BigInt(0)),
        spent: BigInt(a.spent) + shallow.reduce((s, t) => s + t.spent, BigInt(0)),
        txCount: a.txCount + shallow.length,
      };
      const diff = statsMismatch(expected, await stats(a.address));
      if (diff) { mismatch = { address: a.address, detail: diff }; break; }
    }

    if (mismatch) {
      outcome.verified = false;
      outcome.stoppedBecause = "UNVERIFIED";
      const streak = state.mismatchStreak + 1;
      let span: { from: string; to: string } | null = null;
      let coverage: ChainCoverage | null = null;
      let licensedToISO = state.licensedToISO;
      // Rows that relied on the shallow head are no longer proven: withdraw the
      // licence to the day before them (a tip reorg, or new activity racing the
      // stats read — the next run re-verifies).
      if (state.provenOnce && state.headFromISO && state.licensedFromISO && state.licensedToISO) {
        const cap = addDaysISO(state.headFromISO, -1);
        if (cap >= state.licensedFromISO) {
          span = { from: state.headFromISO, to: state.licensedToISO };
          licensedToISO = cap;
          coverage = { kind: "COMPLETE", fromISO: state.licensedFromISO, toISO: cap, source: BTC_CHAIN_STATS_SOURCE };
        }
      }
      state = {
        ...state, mismatchStreak: streak, licensedToISO, headFromISO: span ? null : state.headFromISO,
        headUnverifiedSinceISO: state.headUnverifiedSinceISO ?? nowISO(),
        recovery: streak >= MISMATCH_RECOVERY_THRESHOLD
          ? { reason: "BALANCE_MISMATCH", address: mismatch.address, detail: mismatch.detail, detectedAtISO: nowISO() } : null,
      };
      if (state.recovery) outcome.stoppedBecause = "RECOVERY";
      await commit({ span, coverage });
      if (span) impacted(span.from);
      return await finish();
    }

    // ── PROVEN ──────────────────────────────────────────────────────────────
    outcome.verified = true;
    const shallowAll = [...head.values()].flatMap((h) => h.shallow);
    const withHead = new Map(days);
    for (const t of shallowAll) withHead.set(t.dateISO, (withHead.get(t.dateISO) ?? BigInt(0)) + t.funded - t.spent);
    const sortedDays = [...withHead.keys()].sort();
    const today = todayISO();
    const shallowFrom = shallowAll.length ? shallowAll.map((t) => t.dateISO).sort()[0] : null;
    const firstProof = !state.provenOnce;
    let promoted: "PROVEN" | null = null;
    const legacyFrom = firstProof && state.mode === "STAGING" ? state.legacy?.fromISO ?? null : null;
    let discrepancy: { days: number; firstISO: string } | null = null;
    let rows: Array<{ dateISO: string; sats: bigint }> = [];
    let span: { from: string; to: string } | null = null;
    let coverage: ChainCoverage;
    let licensedFromISO: string;
    let licensedToISO: string;

    if (sortedDays.length === 0) {
      // No confirmed activity on any address: proven empty, today only, no rows.
      licensedFromISO = today; licensedToISO = today;
      coverage = { kind: "COMPLETE", fromISO: today, toISO: today, source: BTC_CHAIN_STATS_SOURCE };
    } else {
      licensedFromISO = sortedDays[0];
      licensedToISO = sortedDays[sortedDays.length - 1] > today ? sortedDays[sortedDays.length - 1] : today;
      const from = firstProof ? licensedFromISO
        : [state.dirtyFromISO, state.headFromISO, shallowFrom, state.licensedToISO ? addDaysISO(state.licensedToISO, 1) : null, state.licensedFromISO && state.licensedFromISO > licensedFromISO ? licensedFromISO : null]
          .filter((d): d is string => d !== null).sort()[0] ?? null;
      if (from !== null) {
        const f = from < licensedFromISO ? licensedFromISO : from;
        if (f <= licensedToISO) {
          rows = dailyClosings(withHead, f, licensedToISO);
          const oldTo = state.licensedToISO;
          span = { from: f, to: oldTo && oldTo > licensedToISO ? oldTo : licensedToISO };
        }
      }
      coverage = { kind: "COMPLETE", fromISO: licensedFromISO, toISO: licensedToISO, source: BTC_CHAIN_STATS_SOURCE };
    }
    if (firstProof && state.mode === "STAGING" && state.legacy) {
      const legacy = args.store.legacy ? await args.store.legacy() : null;
      if (legacy) discrepancy = legacyDiscrepancy(rows, state.legacy, legacy.rows);
      promoted = "PROVEN";
    }
    const changed = firstProof || rows.length > 0 || licensedToISO !== state.licensedToISO || licensedFromISO !== state.licensedFromISO;
    state = {
      ...state, provenOnce: true, licensedFromISO, licensedToISO, headFromISO: shallowFrom, dirtyFromISO: null,
      headVerifiedAtISO: nowISO(), headUnverifiedSinceISO: null, mismatchStreak: 0, recovery: null,
      completedAtISO: state.completedAtISO ?? nowISO(),
      ...(firstProof ? { mode: "DIRECT" as const, legacy: null, promotedAtISO: state.mode === "STAGING" ? nowISO() : (state.promotedAtISO ?? null),
        legacyDiscrepancy: discrepancy ? { ...discrepancy, detectedAtISO: nowISO() } : null } : {}),
    };
    if (changed) {
      // ATOMIC: on the first proof every DERIVED row of the source (the legacy
      // history included) goes and the proven rows + licence land, with the
      // checkpoint flip, in ONE transaction.
      await commit({ rows, span: firstProof ? null : span, replaceAll: firstProof, coverage });
      outcome.progressed = true;
      // The replaced legacy rows changed too — the snapshot window must reach them.
      if (legacyFrom) impacted(legacyFrom);
      if (firstProof && rows.length === 0 && sortedDays.length === 0) impacted(today);
    }
    outcome.promoted = promoted;
    outcome.stoppedBecause = "COMPLETE";
    return await finish();
  } catch (e) {
    if (e instanceof CheckpointConflictError) {
      outcome.stoppedBecause = "CONFLICT";
      outcome.failure = { code: "CHECKPOINT_CONFLICT", detail: e.message };
      outcome.status = backfillStatus(state);
      return outcome;
    }
    if (e instanceof HeadLostError) {
      absorb();
      state = { ...state, recovery: { reason: "HEAD_BOUNDARY_LOST", address: e.address, detail: e.message, detectedAtISO: nowISO() } };
      outcome.stoppedBecause = "RECOVERY";
      try { await commit(); } catch (c) { if (!(c instanceof CheckpointConflictError)) throw c; }
      outcome.status = backfillStatus(state);
      return outcome;
    }
    if (e instanceof CursorStuckError) { await fail("PROVIDER_ERROR", e.message); outcome.status = backfillStatus(state); return outcome; }
    if (e instanceof BtcSyncError || e instanceof BtcProofDataError) {
      await fail(failureCodeOf(e), e.message);
      outcome.status = backfillStatus(state);
      return outcome;
    }
    throw e;
  }
}

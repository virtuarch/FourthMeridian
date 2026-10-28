/**
 * lib/crypto/sol-history-backfill.ts
 *
 * RESUMABLE SOLANA HISTORY — fetch, schedule, write. The proof rules live in
 * sol-history-backfill.core.ts; read that first.
 *
 * ONE RUN, bounded by WALL-CLOCK (never by a transaction count):
 *
 *   1. HEAD      if a checkpoint exists, list signatures NEWER than its top
 *                (`until`), fetch them oldest-first and extend the top while
 *                pre(newer) === post(older). When the newest reached states the
 *                observed balance, the licence runs to the observation's date.
 *   2. HISTORY   page BEFORE the bottom, newest-first, extending it while
 *                post(older) === pre(newer). A short page proves the beginning.
 *   3. COMMIT    after every page (and wherever the run stops), ONE transaction
 *                writes the new days' rows, the coverage licence and the
 *                checkpoint — the checkpoint by compare-and-swap on the cursor
 *                the run started from, so two runners can never both advance it.
 *
 * Stopping is always safe: whatever was committed is proven and stays; whatever
 * was not is re-fetched next run. A provider failure (after bounded, Retry-After
 * aware backoff) ends the run, keeps every committed chunk and is counted; six
 * in a row slow automatic retries to once a day (FAILED). A continuity break is
 * never guessed across: the gap is recorded (RECOVERY_REQUIRED) and the proven
 * history above it is kept.
 *
 * Runs inside the caller's wallet sync lock (lib/refresh/wallet-lock.ts); the
 * default budget sits far inside WALLET_LOCK_TTL_MS.
 */

import { SOL_NATIVE } from "./native-asset";
import { normalizeSolAddress, solRpcUrl, type FetchFn } from "./sol-rpc";
import { redactProviderSecrets } from "./alchemy";
import { baseUnitsToWhole, type ChainCoverage } from "./chain-movement";
import {
  emptyCheckpoint, parseCheckpoint, serializeCheckpoint, pointFromTransaction,
  extendBackward, extendForward, dailyClosings, addDaysISO, backfillStatus, shouldRunAutomatically,
  SolProofDataError, SOL_CONTINUITY_SOURCE,
  type SolBackfillCheckpoint, type SolBackfillFailureCode, type SolBackfillStatus,
  type SolTxForProof, type SolTxPoint,
} from "./sol-history-backfill.core";

export const SIGNATURE_PAGE_SIZE = 1000;           // the RPC's own per-call maximum
export const DEFAULT_RUN_BUDGET_MS = 45_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

// ── Transport ────────────────────────────────────────────────────────────────

export class SolTransportError extends Error {
  constructor(public readonly code: Exclude<SolBackfillFailureCode, "ANCHOR_MISMATCH" | "NO_OBSERVED_ANCHOR">, message: string) {
    super(message);
    this.name = "SolTransportError";
  }
}

/** A JSON-RPC call returning `result`, or throwing SolTransportError. */
export type SolRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface SolBackfillDeps {
  /** Full override (offline fixtures). */
  call?: SolRpcCall;
  fetchImpl?: FetchFn;
  rpcUrl?: string | null;
  budgetMs?: number;
  requestTimeoutMs?: number;
  concurrency?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isThrottleRpcError = (code: unknown, message: string) =>
  code === 429 || code === -32429 || code === -32005 || /rate.?limit|too many requests/i.test(message);

/**
 * Standard JSON-RPC over HTTP with a per-request timeout, and bounded
 * exponential backoff on 429/503 (and JSON-RPC rate-limit errors) that honours
 * Retry-After and never sleeps past the run's deadline.
 */
export function buildRpcCall(deps: SolBackfillDeps, deadlineMs: number): SolRpcCall {
  if (deps.call) return deps.call;
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : solRpcUrl();
  if (!url) throw new SolTransportError("NO_PROVIDER_CONFIGURED", "no Solana RPC endpoint configured (set SOL_RPC_URL or HELIUS_API_KEY)");
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = deps.requestTimeoutMs ?? envNumber("SOL_HISTORY_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let retryAfterMs: number | null = null;
      let throttled = false;
      try {
        const res = await doFetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (res.status === 429 || res.status === 503) {
          throttled = true;
          const ra = Number(res.headers?.get?.("retry-after"));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
        } else if (!res.ok) {
          throw new SolTransportError("PROVIDER_ERROR", `HTTP ${res.status} from the Solana RPC endpoint (${method})`);
        } else {
          let env: { result?: unknown; error?: { code?: number; message?: string } };
          try { env = JSON.parse(await res.text()); }
          catch { throw new SolTransportError("INVALID_DATA", `unparseable JSON-RPC response (${method})`); }
          if (env.error) {
            const msg = env.error.message ?? "unknown";
            if (isThrottleRpcError(env.error.code, msg)) throttled = true;
            else throw new SolTransportError("PROVIDER_ERROR", redactProviderSecrets(`provider error ${env.error.code ?? "?"}: ${msg} (${method})`));
          } else {
            return env.result;
          }
        }
      } catch (e) {
        if (e instanceof SolTransportError) throw e;
        if (controller.signal.aborted) throw new SolTransportError("PROVIDER_TIMEOUT", `Solana RPC did not respond within ${timeout} ms (${method})`);
        throw new SolTransportError("PROVIDER_ERROR", redactProviderSecrets(`network error reaching the Solana RPC (${method}): ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        clearTimeout(timer);
      }
      // Throttled.
      if (!throttled) continue; // unreachable; keeps the type checker honest
      const wait = Math.min(MAX_BACKOFF_MS, retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt);
      if (attempt >= maxRetries || now() + wait >= deadlineMs) {
        throw new SolTransportError("PROVIDER_THROTTLED", `rate limited by the Solana RPC after ${attempt + 1} attempt(s) (${method})`);
      }
      await sleep(wait);
    }
  };
}

interface SigRow { signature: string; slot: number; blockTime: number | null }

async function signaturePage(call: SolRpcCall, address: string, opts: { before?: string | null; until?: string | null }): Promise<SigRow[]> {
  const p: Record<string, unknown> = { limit: SIGNATURE_PAGE_SIZE, commitment: "finalized" };
  if (opts.before) p.before = opts.before;
  if (opts.until) p.until = opts.until;
  const r = await call("getSignaturesForAddress", [address, p]);
  if (!Array.isArray(r)) throw new SolTransportError("INVALID_DATA", "getSignaturesForAddress did not return an array");
  return r as SigRow[];
}

async function transaction(call: SolRpcCall, signature: string): Promise<SolTxForProof> {
  const r = await call("getTransaction", [signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]);
  if (!r || typeof r !== "object") throw new SolTransportError("INVALID_DATA", `getTransaction(${signature}) returned no transaction`);
  return r as SolTxForProof;
}

/**
 * Fetch transactions in order with a small pool. Returns the in-order prefix
 * that completed before the deadline or the first failure, plus that failure.
 * Throttling drops the pool to one for the rest of the run.
 */
async function fetchPoints(
  call: SolRpcCall, owner: string, sigs: readonly SigRow[], ctx: { concurrency: number; deadlineMs: number; now: () => number },
): Promise<{ points: Array<SolTxPoint | null>; error: SolTransportError | SolProofDataError | null; stoppedForBudget: boolean }> {
  const out: Array<SolTxPoint | null> = [];
  let pool = Math.max(1, ctx.concurrency);
  for (let i = 0; i < sigs.length; ) {
    if (ctx.now() >= ctx.deadlineMs) return { points: out, error: null, stoppedForBudget: true };
    const batch = sigs.slice(i, i + pool);
    const settled = await Promise.allSettled(batch.map((s) => transaction(call, s.signature)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "rejected") {
        const e = s.reason;
        if (e instanceof SolTransportError && e.code === "PROVIDER_THROTTLED" && pool > 1) { pool = 1; break; }
        return { points: out, error: e instanceof SolTransportError ? e : new SolTransportError("PROVIDER_ERROR", String(e)), stoppedForBudget: false };
      }
      try { out.push(pointFromTransaction(s.value, batch[j].signature, owner)); }
      catch (e) { return { points: out, error: e as SolProofDataError, stoppedForBudget: false }; }
    }
    i = out.length;
  }
  return { points: out, error: null, stoppedForBudget: false };
}

// ── Store ────────────────────────────────────────────────────────────────────

export class CheckpointConflictError extends Error {
  constructor() { super("the history checkpoint moved under this run (another run advanced it)"); this.name = "CheckpointConflictError"; }
}

export interface SolBackfillCommit {
  /** The cursor this run started from — compare-and-swap. */
  expectedCursor: string | null;
  nextCursor: string;
  /** First commit of a fresh checkpoint: remove every row this source owns (rows of the old wholesale path). */
  replaceAll: boolean;
  /** Days rewritten by this chunk. */
  deleteFromISO: string | null;
  deleteToISO: string | null;
  rows: Array<{ dateISO: string; quantity: number }>;
  /** Null: leave the stored licence as it is (a failure-only update). */
  coverage: ChainCoverage | null;
}

export interface SolBackfillStore {
  readCursor(): Promise<string | null>;
  /** The newest OBSERVED/IMPORTED balance: the independent anchor. */
  anchor(): Promise<{ dateISO: string; lamports: bigint } | null>;
  /** One transaction. Throws CheckpointConflictError when the cursor is not `expectedCursor`. */
  commit(c: SolBackfillCommit): Promise<void>;
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface SolBackfillOutcome {
  status: SolBackfillStatus;
  /** True when this run committed at least one chunk. */
  progressed: boolean;
  rowsWritten: number;
  /** Earliest date whose stored quantity this run changed (drives the snapshot rebuild window). */
  impactedFromISO: string | null;
  signaturesProcessed: number;
  pagesFetched: number;
  stoppedBecause: "COMPLETE" | "BUDGET" | "FAILURE" | "GAP" | "CONFLICT" | "SKIPPED" | "IDLE";
  failure: { code: SolBackfillFailureCode | "CHECKPOINT_CONFLICT"; detail: string } | null;
}

const toSol = (lamports: string | bigint) => baseUnitsToWhole(BigInt(lamports), SOL_NATIVE.decimals);

function coverageOf(cp: SolBackfillCheckpoint): ChainCoverage | null {
  if (!cp.licensedFromISO || !cp.licensedToISO) return null;
  return { kind: "COMPLETE", fromISO: cp.licensedFromISO, toISO: cp.licensedToISO, source: SOL_CONTINUITY_SOURCE };
}

export async function runSolHistoryBackfill(
  args: { accountId: string; address: string; store: SolBackfillStore; resume?: boolean },
  deps: SolBackfillDeps = {},
): Promise<SolBackfillOutcome> {
  const now = deps.now ?? Date.now;
  const startMs = now();
  const deadlineMs = startMs + (deps.budgetMs ?? envNumber("SOL_HISTORY_RUN_BUDGET_MS", DEFAULT_RUN_BUDGET_MS));
  const concurrency = deps.concurrency ?? envNumber("SOL_HISTORY_CONCURRENCY", DEFAULT_CONCURRENCY);
  const owner = normalizeSolAddress(args.address);
  const nowISO = () => new Date(now()).toISOString();

  let raw = await args.store.readCursor();
  let cp = parseCheckpoint(raw, args.accountId, owner);

  const outcome: SolBackfillOutcome = {
    status: backfillStatus(cp), progressed: false, rowsWritten: 0, impactedFromISO: null,
    signaturesProcessed: 0, pagesFetched: 0, stoppedBecause: "IDLE", failure: null,
  };
  const impacted = (d: string) => { if (outcome.impactedFromISO === null || d < outcome.impactedFromISO) outcome.impactedFromISO = d; };

  if (args.resume && cp) cp = { ...cp, gap: null, failures: 0, lastFailure: null };
  if (!args.resume) {
    const gate = shouldRunAutomatically(cp, startMs);
    if (!gate.run) { outcome.stoppedBecause = "SKIPPED"; return outcome; }
  }

  let working: SolBackfillCheckpoint = cp ?? emptyCheckpoint(args.accountId, owner, nowISO());
  // Until a run has proven its first transaction, the rows this source owns
  // (the old wholesale path's, or none) are replaced, not merged.
  let replaceAll = working.top === null;

  /** Persist `next` (and rows) by CAS from the cursor this run last wrote. */
  const commit = async (next: SolBackfillCheckpoint, rows: Array<{ dateISO: string; lamports: bigint }>, span: { from: string; to: string } | null) => {
    const nextRaw = serializeCheckpoint(next);
    await args.store.commit({
      expectedCursor: raw, nextCursor: nextRaw, replaceAll,
      deleteFromISO: span?.from ?? null, deleteToISO: span?.to ?? null,
      rows: rows.map((r) => ({ dateISO: r.dateISO, quantity: toSol(r.lamports) })),
      coverage: coverageOf(next),
    });
    raw = nextRaw; working = next; replaceAll = false;
    if (rows.length > 0) { outcome.rowsWritten += rows.length; impacted(rows[0].dateISO); }
  };

  const fail = async (code: SolBackfillFailureCode, detail: string) => {
    outcome.failure = { code, detail };
    outcome.stoppedBecause = "FAILURE";
    const next: SolBackfillCheckpoint = { ...working, failures: working.failures + 1, lastFailure: { code, atISO: nowISO(), detail: detail.slice(0, 300) } };
    try {
      // A failure-only update writes no rows; on a fresh wallet it records the
      // checkpoint (QUEUED with a failure) so the state is visible.
      await args.store.commit({ expectedCursor: raw, nextCursor: serializeCheckpoint(next), replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [], coverage: null });
      raw = serializeCheckpoint(next); working = next;
    } catch (e) {
      if (!(e instanceof CheckpointConflictError)) throw e;
    }
  };

  const finish = () => { outcome.status = backfillStatus(working); return outcome; };

  let call: SolRpcCall;
  try { call = buildRpcCall(deps, deadlineMs); }
  catch (e) {
    if (e instanceof SolTransportError) { await fail(e.code, e.message); return finish(); }
    throw e;
  }

  const anchor = await args.store.anchor();
  if (!anchor) { await fail("NO_OBSERVED_ANCHOR", "no observed balance yet to anchor history on"); return finish(); }

  try {
    // ── 1. HEAD ─────────────────────────────────────────────────────────────
    if (working.top) {
      const top0: SolTxPoint = working.top;
      const newer: SigRow[] = [];
      for (let before: string | null = null; ; ) {
        if (now() >= deadlineMs) { outcome.stoppedBecause = "BUDGET"; return finish(); }
        const page = await signaturePage(call, owner, { before, until: working.top.signature });
        outcome.pagesFetched++;
        newer.push(...page);
        if (page.length < SIGNATURE_PAGE_SIZE) break;
        before = page[page.length - 1].signature;
      }
      const oldestFirst = newer.reverse();
      const fetched = await fetchPoints(call, owner, oldestFirst, { concurrency, deadlineMs, now });
      const points = fetched.points.filter((p): p is SolTxPoint => p !== null);
      outcome.signaturesProcessed += fetched.points.length;
      const ext = extendForward(working.top, points);
      const allFetched = fetched.points.length === oldestFirst.length && !fetched.error && !fetched.stoppedForBudget;
      const newTop = ext.points.length ? ext.points[ext.points.length - 1] : working.top;

      if (ext.kind === "GAP") {
        working = { ...working, gap: { ...ext.gap, side: "HEAD", detectedAtISO: nowISO() } };
      }
      // How far the licence may now run. All new activity proven AND the newest
      // states the observed balance ⇒ through the observation's date. Otherwise
      // only through the day before the first activity not yet proven.
      const headVerified = ext.kind === "OK" && allFetched && newTop.postLamports === anchor.lamports.toString();
      // The first signature NOT proven by this run (the gap's neighbour, or the
      // first one not fetched), whose day bounds the licence when unverified.
      const nextUnproven = ext.kind === "GAP"
        ? oldestFirst.find((s) => s.signature === ext.gap.neighbourSignature)
        : oldestFirst[fetched.points.length];
      let licensedTo = working.licensedToISO;
      if (headVerified) {
        licensedTo = anchor.dateISO > newTop.dateISO ? anchor.dateISO : newTop.dateISO;
      } else if (ext.points.length > 0 && nextUnproven?.blockTime) {
        const before = addDaysISO(new Date(nextUnproven.blockTime * 1000).toISOString().slice(0, 10), -1);
        if (!licensedTo || before > licensedTo) licensedTo = before;
      }
      const changedFrom = ext.points.length ? ext.points[0].dateISO : null;
      const spanFrom = [changedFrom, working.licensedToISO ? addDaysISO(working.licensedToISO, 1) : null]
        .filter((d): d is string => d !== null).sort()[0] ?? null;
      const advanced = ext.points.length > 0 || licensedTo !== working.licensedToISO;
      if (advanced || ext.kind === "GAP") {
        const next: SolBackfillCheckpoint = {
          ...working, top: newTop, licensedToISO: licensedTo,
          signaturesProcessed: working.signaturesProcessed + ext.points.length,
          lastProgressAtISO: nowISO(), failures: 0, lastFailure: null,
        };
        const rows = spanFrom && licensedTo && spanFrom <= licensedTo
          ? dailyClosings([top0, ...ext.points], spanFrom, licensedTo) : [];
        await commit(next, rows, spanFrom && licensedTo && spanFrom <= licensedTo ? { from: spanFrom, to: licensedTo } : null);
        outcome.progressed = true;
      }
      if (ext.kind === "GAP") { outcome.stoppedBecause = "GAP"; return finish(); }
      if (fetched.error) {
        const code = fetched.error instanceof SolTransportError ? fetched.error.code : "INVALID_DATA";
        await fail(code, fetched.error.message); return finish();
      }
      if (fetched.stoppedForBudget) { outcome.stoppedBecause = "BUDGET"; return finish(); }
      if (!headVerified) {
        // Every new transaction is proven continuous, but the newest does not
        // state the observed balance: a race with this sync's balance read, or
        // activity the index has not listed yet. Retry next run; never guess.
        await fail("ANCHOR_MISMATCH", `newest transaction states ${newTop.postLamports} lamports; observed balance is ${anchor.lamports}`);
        return finish();
      }
    }

    // ── 2. HISTORY (and the whole of a fresh wallet's first run) ────────────
    // Pages are walked by their own cursor: a page whose transactions never
    // move this wallet's lamports proves nothing new, but must not be re-read.
    let pageBefore: string | null = working.bottom?.signature ?? null;
    while (!working.reachedBeginning) {
      if (now() >= deadlineMs) { outcome.stoppedBecause = "BUDGET"; return finish(); }
      const page = await signaturePage(call, owner, { before: pageBefore });
      outcome.pagesFetched++;
      const fetched = await fetchPoints(call, owner, page, { concurrency, deadlineMs, now });
      outcome.signaturesProcessed += fetched.points.length;
      const points = fetched.points.filter((p): p is SolTxPoint => p !== null);
      const pageDone = fetched.points.length === page.length && !fetched.error && !fetched.stoppedForBudget;

      // A fresh wallet's first proven transaction must state the observed balance.
      if (!working.top && points.length > 0 && points[0].postLamports !== anchor.lamports.toString()) {
        await fail("ANCHOR_MISMATCH", `newest transaction states ${points[0].postLamports} lamports; observed balance is ${anchor.lamports}`);
        return finish();
      }
      if (!working.top && points.length === 0 && pageDone && page.length < SIGNATURE_PAGE_SIZE) {
        // No activity at all. Proven only if the observed balance is zero.
        if (anchor.lamports !== BigInt(0)) {
          await fail("ANCHOR_MISMATCH", `no transactions listed, but the observed balance is ${anchor.lamports} lamports`);
          return finish();
        }
        const next: SolBackfillCheckpoint = { ...working, reachedBeginning: true, licensedFromISO: anchor.dateISO, licensedToISO: anchor.dateISO,
          lastProgressAtISO: nowISO(), completedAtISO: nowISO(), failures: 0, lastFailure: null };
        await commit(next, [], null);
        outcome.progressed = true;
        break;
      }

      const ext = extendBackward(working.bottom, points);
      const reachedBeginning = pageDone && ext.kind === "OK" && page.length < SIGNATURE_PAGE_SIZE;
      if (ext.points.length > 0 || reachedBeginning || ext.kind === "GAP") {
        const newBottom = ext.points.length ? ext.points[ext.points.length - 1] : working.bottom;
        const top = working.top ?? ext.points[0] ?? null;
        const licensedTo = working.licensedToISO
          ?? (top ? (anchor.dateISO > top.dateISO ? anchor.dateISO : top.dateISO) : null);
        // Days newly proven: [new bottom's day, old bottom's day − 1] — or, on
        // a fresh wallet, everything from the new bottom through the licence.
        const spanFrom = newBottom?.dateISO ?? null;
        const spanTo = working.bottom ? addDaysISO(working.bottom.dateISO, -1) : licensedTo;
        const rows = spanFrom && spanTo && spanFrom <= spanTo ? dailyClosings(ext.points, spanFrom, spanTo) : [];
        const next: SolBackfillCheckpoint = {
          ...working, top, bottom: newBottom,
          reachedBeginning, licensedFromISO: newBottom?.dateISO ?? working.licensedFromISO, licensedToISO: licensedTo,
          signaturesProcessed: working.signaturesProcessed + ext.points.length,
          lastProgressAtISO: nowISO(), failures: 0, lastFailure: null,
          completedAtISO: reachedBeginning ? nowISO() : null,
          gap: ext.kind === "GAP" ? { ...ext.gap, side: "HISTORY", detectedAtISO: nowISO() } : working.gap,
        };
        await commit(next, rows, spanFrom && spanTo && spanFrom <= spanTo ? { from: spanFrom, to: spanTo } : null);
        outcome.progressed = true;
      }
      if (ext.kind === "GAP") { outcome.stoppedBecause = "GAP"; return finish(); }
      if (fetched.error) {
        const code = fetched.error instanceof SolTransportError ? fetched.error.code : "INVALID_DATA";
        await fail(code, fetched.error.message); return finish();
      }
      if (fetched.stoppedForBudget) { outcome.stoppedBecause = "BUDGET"; return finish(); }
      if (page.length > 0) pageBefore = page[page.length - 1].signature;
    }
    outcome.stoppedBecause = "COMPLETE";
    return finish();
  } catch (e) {
    if (e instanceof CheckpointConflictError) {
      outcome.stoppedBecause = "CONFLICT";
      outcome.failure = { code: "CHECKPOINT_CONFLICT", detail: e.message };
      return finish();
    }
    if (e instanceof SolTransportError) { await fail(e.code, e.message); return finish(); }
    if (e instanceof SolProofDataError) { await fail("INVALID_DATA", e.message); return finish(); }
    throw e;
  }
}

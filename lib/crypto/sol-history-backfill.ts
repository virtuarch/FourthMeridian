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
  orderSameSlot, statesAnchor, applyToStaged, decidePromotion, usageOn,
  SolProofDataError, SOL_CONTINUITY_SOURCE,
  type SolBackfillCheckpoint, type SolBackfillFailureCode, type SolBackfillStatus,
  type SolTxForProof, type SolTxPoint,
} from "./sol-history-backfill.core";

export const SIGNATURE_PAGE_SIZE = 1000;           // the RPC's own per-call maximum
/**
 * Budget for a run inside a WALLET SYNC (manual or scheduled). Short so the
 * sync stays responsive; the background worker (jobs/sol-history-backfill.ts)
 * carries large histories with its own, larger, rate-limited budget.
 */
export const DEFAULT_RUN_BUDGET_MS = 15_000;
/** Without the background worker, syncs must carry history alone — the pre-worker 45 s. */
export const STANDALONE_RUN_BUDGET_MS = 45_000;
/** While the worker is enabled, a wallet sync proves only new activity. */
export function syncHeadOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.SOL_BACKFILL_ENABLED === "true";
}
export function syncRunBudgetMs(env: Record<string, string | undefined> = process.env): number {
  return env.SOL_BACKFILL_ENABLED === "true" ? DEFAULT_RUN_BUDGET_MS : STANDALONE_RUN_BUDGET_MS;
}
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
  /** Awaited before EVERY provider request (incl. retries) — the worker's shared rate limiter. */
  beforeRequest?: () => Promise<void>;
  /** Counts every provider request by method (incl. retries) — cost observability. */
  meter?: Record<string, number>;
  /** Stop (as for the wall clock) once this many requests were sent in the run. */
  requestBudget?: number;
  /**
   * HEAD only: prove new activity, leave older history to the background worker.
   * What a wallet SYNC does while the worker is enabled, so historical work never
   * slows a holdings refresh and every history request runs under the worker's
   * rate limit and daily cap.
   */
  headOnly?: boolean;
  /**
   * SPL TOKEN HISTORY — sees every transaction this run fetches (json encoding
   * states pre/postTokenBalances too), so token-account discovery reuses the
   * native fetch instead of repeating it (lib/crypto/spl-history.ts). Never
   * changes what the native proof reads.
   */
  observeTransaction?: (signature: string, tx: unknown) => void;
  /** Applied to every checkpoint this run commits — folds the observed token accounts in at the same CAS. */
  annotateCheckpoint?: (cp: SolBackfillCheckpoint) => SolBackfillCheckpoint;
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
  if (deps.call) {
    // Fixture transport: still metered and rate-limited, so tests see what production would.
    const c = deps.call;
    return async (method, params) => {
      if (deps.beforeRequest) await deps.beforeRequest();
      if (deps.meter) deps.meter[method] = (deps.meter[method] ?? 0) + 1;
      return c(method, params);
    };
  }
  const url = deps.rpcUrl !== undefined ? deps.rpcUrl : solRpcUrl();
  if (!url) throw new SolTransportError("NO_PROVIDER_CONFIGURED", "no Solana RPC endpoint configured (set SOL_RPC_URL or HELIUS_API_KEY)");
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = deps.requestTimeoutMs ?? envNumber("SOL_HISTORY_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      if (deps.beforeRequest) await deps.beforeRequest();
      if (deps.meter) deps.meter[method] = (deps.meter[method] ?? 0) + 1;
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
        // The abort FIRST: a timeout while the body is read surfaces as a parse
        // failure inside, and is a timeout, not invalid data.
        if (controller.signal.aborted) throw new SolTransportError("PROVIDER_TIMEOUT", `Solana RPC did not respond within ${timeout} ms (${method})`);
        if (e instanceof SolTransportError) throw e;
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
  call: SolRpcCall, owner: string, sigs: readonly SigRow[], ctx: { concurrency: number; stop: () => boolean; observe?: (signature: string, tx: unknown) => void },
): Promise<{ points: Array<SolTxPoint | null>; error: SolTransportError | SolProofDataError | null; stoppedForBudget: boolean }> {
  const out: Array<SolTxPoint | null> = [];
  let pool = Math.max(1, ctx.concurrency);
  for (let i = 0; i < sigs.length; ) {
    if (ctx.stop()) return { points: out, error: null, stoppedForBudget: true };
    const batch = sigs.slice(i, i + pool);
    const settled = await Promise.allSettled(batch.map((s) => transaction(call, s.signature)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "rejected") {
        const e = s.reason;
        if (e instanceof SolTransportError && e.code === "PROVIDER_THROTTLED" && pool > 1) { pool = 1; break; }
        return { points: out, error: e instanceof SolTransportError ? e : new SolTransportError("PROVIDER_ERROR", String(e)), stoppedForBudget: false };
      }
      if (ctx.observe) ctx.observe(batch[j].signature, s.value);
      try { out.push(pointFromTransaction(s.value, batch[j].signature, owner)); }
      catch (e) { return { points: out, error: e as SolProofDataError, stoppedForBudget: false }; }
    }
    i = out.length;
  }
  return { points: out, error: null, stoppedForBudget: false };
}

/**
 * Never commit PART of a slot: within one slot the provider's order is not an
 * execution order, so a slot is proven only as a whole (orderSameSlot). Returns
 * the fetched points minus every point in a `deferred` slot.
 */
function withoutSlots(points: ReadonlyArray<SolTxPoint | null>, sigs: readonly SigRow[], deferred: ReadonlySet<number>): Array<SolTxPoint | null> {
  return points.map((p, i) => (deferred.has(sigs[i].slot) ? undefined : p)).filter((p): p is SolTxPoint | null => p !== undefined);
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
  /** `toleranceLamports`: the float-storage error of the stored quantity (0 when exact). */
  anchor(): Promise<{ dateISO: string; lamports: bigint; toleranceLamports?: bigint } | null>;
  /** One transaction. Throws CheckpointConflictError when the cursor is not `expectedCursor`. */
  commit(c: SolBackfillCommit): Promise<void>;
  /**
   * The previous importer's LICENSED history, when there is one: its interval
   * and its DERIVED rows (whole SOL by date). Null when nothing is licensed.
   */
  legacy?(): Promise<{ fromISO: string; toISO: string; rows: Map<string, number> } | null>;
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
  /** Set on the run that promoted staged history over legacy rows. */
  promoted?: "COVERED" | "LEGACY_DISPROVED" | null;
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
  const deadlineMs = startMs + (deps.budgetMs ?? envNumber("SOL_HISTORY_RUN_BUDGET_MS", syncRunBudgetMs()));
  const concurrency = deps.concurrency ?? envNumber("SOL_HISTORY_CONCURRENCY", DEFAULT_CONCURRENCY);
  const owner = normalizeSolAddress(args.address);
  const nowISO = () => new Date(now()).toISOString();
  // Every request is metered (an internal meter when the caller passes none),
  // so the checkpoint's daily usage is true for syncs as well as the worker.
  const meter = deps.meter ?? {};
  deps = { ...deps, meter };
  const sent = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const sentAtStart = sent();
  let recordedThrough = sentAtStart;
  const todayISO = () => new Date(now()).toISOString().slice(0, 10);
  /** Fold requests sent since the last commit into the checkpoint's daily usage. */
  const stamp = (c: SolBackfillCheckpoint): SolBackfillCheckpoint => {
    const day = todayISO();
    const delta = sent() - recordedThrough;
    recordedThrough = sent();
    const stamped = { ...c, usage: { dayISO: day, requests: usageOn(c, day) + delta } };
    return deps.annotateCheckpoint ? deps.annotateCheckpoint(stamped) : stamped;
  };
  /** The run's budget: wall clock, and (worker) a request allowance. */
  const overBudget = (deadline: number) => now() >= deadline
    || (deps.requestBudget !== undefined && sent() - sentAtStart >= deps.requestBudget);

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
  // OWNER DECISION 1 — a fresh checkpoint over a licensed legacy history
  // STAGES its proof instead of replacing anything.
  let legacyRows: Map<string, number> | null = null;
  if (working.top === null && working.mode === undefined) {
    const legacy = args.store.legacy ? await args.store.legacy() : null;
    if (legacy) {
      legacyRows = legacy.rows;
      working = { ...working, mode: "STAGING", staged: [], legacy: { fromISO: legacy.fromISO, toISO: legacy.toISO } };
    } else {
      working = { ...working, mode: "DIRECT" };
    }
  }
  const loadLegacyRows = async () => {
    if (legacyRows) return legacyRows;
    legacyRows = (args.store.legacy ? (await args.store.legacy())?.rows : null) ?? new Map();
    return legacyRows;
  };

  const commit = async (nextUnstamped: SolBackfillCheckpoint, rows: Array<{ dateISO: string; lamports: bigint }>, span: { from: string; to: string } | null) => {
    const nextIn = stamp(nextUnstamped);
    if (nextIn.mode === "STAGING" && nextIn.legacy) {
      const staged = applyToStaged(nextIn.staged ?? [], span, rows);
      const decision = decidePromotion(nextIn, staged, nextIn.legacy, await loadLegacyRows());
      if (!decision.promote) {
        // Proof advances; rows and licence are untouched (legacy stays in force).
        const next = { ...nextIn, staged };
        const nextRaw = serializeCheckpoint(next);
        await args.store.commit({ expectedCursor: raw, nextCursor: nextRaw, replaceAll: false,
          deleteFromISO: null, deleteToISO: null, rows: [], coverage: null });
        raw = nextRaw; working = next;
        return;
      }
      // ATOMIC PROMOTION: every legacy row of this source goes, the proven rows
      // and the new licence land, and the checkpoint flips — one transaction.
      const next: SolBackfillCheckpoint = { ...nextIn, mode: "DIRECT", staged: undefined, legacy: null,
        promotedAtISO: nowISO(),
        legacyDiscrepancy: decision.discrepancy ? { ...decision.discrepancy, detectedAtISO: nowISO() } : null };
      const nextRaw = serializeCheckpoint(next);
      const all = staged.map(([d, l]) => ({ dateISO: d, lamports: BigInt(l) }));
      await args.store.commit({ expectedCursor: raw, nextCursor: nextRaw, replaceAll: true,
        deleteFromISO: null, deleteToISO: null,
        rows: all.map((r) => ({ dateISO: r.dateISO, quantity: toSol(r.lamports) })), coverage: coverageOf(next) });
      raw = nextRaw; working = next; replaceAll = false;
      outcome.promoted = decision.reason;
      if (all.length > 0) { outcome.rowsWritten += all.length; impacted(all[0].dateISO); }
      return;
    }
    const next = nextIn;
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
    const next: SolBackfillCheckpoint = stamp({ ...working, failures: working.failures + 1, lastFailure: { code, atISO: nowISO(), detail: detail.slice(0, 300) } });
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
  const anchorText = `${anchor.lamports} lamports`;

  try {
    // ── 1. HEAD ─────────────────────────────────────────────────────────────
    // Bounded to half the run while older history is still owed, so a busy
    // wallet's new activity can never starve its backfill. Only a GAP or a
    // provider failure here ends the run; an unverified or unfinished head
    // just leaves the licence short of today and carries on.
    if (working.top) {
      const headDeadline = working.reachedBeginning ? deadlineMs : startMs + Math.floor((deadlineMs - startMs) / 2);
      const top0: SolTxPoint = working.top;
      const newer: SigRow[] = [];
      let listed = true;
      for (let before: string | null = null; ; ) {
        if (overBudget(headDeadline)) { listed = false; break; }
        const page = await signaturePage(call, owner, { before, until: top0.signature });
        outcome.pagesFetched++;
        newer.push(...page);
        if (page.length < SIGNATURE_PAGE_SIZE) break;
        before = page[page.length - 1].signature;
      }
      // Slots at or below the top's are already proven whole.
      const oldestFirst = listed ? newer.reverse().filter((r) => r.slot > top0.slot) : [];
      const fetched = await fetchPoints(call, owner, oldestFirst, { concurrency, stop: () => overBudget(headDeadline), observe: deps.observeTransaction });
      const headDeferred = new Set<number>();
      if (fetched.points.length < oldestFirst.length) headDeferred.add(oldestFirst[fetched.points.length].slot);
      const points = orderSameSlot(withoutSlots(fetched.points, oldestFirst, headDeferred).filter((p): p is SolTxPoint => p !== null), top0.postLamports, "forward");
      outcome.signaturesProcessed += fetched.points.length;
      const ext = extendForward(top0, points);
      const allFetched = listed && fetched.points.length === oldestFirst.length && !fetched.error && !fetched.stoppedForBudget;
      const newTop = ext.points.length ? ext.points[ext.points.length - 1] : top0;
      const headVerified = ext.kind === "OK" && allFetched && statesAnchor(newTop.postLamports, anchor);

      // How far the licence may run. Verified ⇒ through the observation's date.
      // Otherwise ONLY through the day before the newest proven transaction:
      // whatever is unproven (a gap's hidden transaction, an unfetched one, the
      // mismatch with the observed balance) may have happened on that very day.
      let licensedTo = working.licensedToISO;
      if (headVerified) {
        licensedTo = anchor.dateISO > newTop.dateISO ? anchor.dateISO : newTop.dateISO;
      } else if (ext.points.length > 0) {
        // May SHRINK: a licence that ran through the day of a midday balance
        // reading no longer holds for that day once newer, unproven activity
        // shares it.
        const cap = addDaysISO(newTop.dateISO, -1);
        licensedTo = working.licensedFromISO && cap < working.licensedFromISO ? working.licensedToISO : cap;
      }
      const changedFrom = ext.points.length ? ext.points[0].dateISO : null;
      const spanFrom = [changedFrom, working.licensedToISO ? addDaysISO(working.licensedToISO, 1) : null]
        .filter((d): d is string => d !== null).sort()[0] ?? null;
      const unverifiedSince = headVerified ? null : (working.headUnverifiedSinceISO ?? nowISO());
      const advanced = ext.points.length > 0 || licensedTo !== working.licensedToISO
        || (working.headUnverifiedSinceISO ?? null) !== unverifiedSince;
      if (advanced || ext.kind === "GAP") {
        const next: SolBackfillCheckpoint = {
          ...working, top: newTop, licensedToISO: licensedTo, headUnverifiedSinceISO: unverifiedSince,
          signaturesProcessed: working.signaturesProcessed + ext.points.length,
          ...(ext.points.length > 0 ? { lastProgressAtISO: nowISO(), failures: 0, lastFailure: null } : {}),
          gap: ext.kind === "GAP" ? { ...ext.gap, side: "HEAD", detectedAtISO: nowISO() } : working.gap,
        };
        const writeRows = spanFrom !== null && licensedTo !== null && spanFrom <= licensedTo;
        const rows = writeRows ? dailyClosings([top0, ...ext.points], spanFrom, licensedTo!) : [];
        // Delete through the OLD edge too, so a withdrawn day loses its row.
        const oldTo = working.licensedToISO;
        const shrunk = oldTo !== null && licensedTo !== null && licensedTo < oldTo;
        const delFrom = shrunk ? [spanFrom, addDaysISO(licensedTo!, 1)].filter((d): d is string => d !== null).sort()[0] : spanFrom;
        const delTo = shrunk ? oldTo : licensedTo;
        await commit(next, rows, (writeRows || shrunk) && delFrom && delTo ? { from: delFrom, to: delTo } : null);
        if (ext.points.length > 0 || rows.length > 0) outcome.progressed = true;
      }
      if (ext.kind === "GAP") { outcome.stoppedBecause = "GAP"; return finish(); }
      if (fetched.error) {
        const code = fetched.error instanceof SolTransportError ? fetched.error.code : "INVALID_DATA";
        await fail(code, fetched.error.message); return finish();
      }
    }

    if (deps.headOnly) { outcome.stoppedBecause = working.reachedBeginning ? "COMPLETE" : "BUDGET"; return finish(); }

    // ── 2. HISTORY (and the whole of a fresh wallet's first run) ────────────
    // Pages are walked by their own cursor: a page whose transactions never
    // move this wallet's lamports proves nothing new, but must not be re-read.
    let pageBefore: string | null = working.bottom?.signature ?? null;
    while (!working.reachedBeginning) {
      if (overBudget(deadlineMs)) { outcome.stoppedBecause = "BUDGET"; return finish(); }
      const listedPage = await signaturePage(call, owner, { before: pageBefore });
      outcome.pagesFetched++;
      const fullPage = listedPage.length === SIGNATURE_PAGE_SIZE;
      // Slots at or above the bottom's are already proven whole.
      const page = working.bottom ? listedPage.filter((r) => r.slot < working.bottom!.slot) : listedPage;
      const fetched = await fetchPoints(call, owner, page, { concurrency, stop: () => overBudget(deadlineMs), observe: deps.observeTransaction });
      outcome.signaturesProcessed += fetched.points.length;
      // Defer a slot that may continue on the next page, and one cut short by
      // the budget or a failure — unless that would defer the whole page.
      const deferred = new Set<number>();
      if (fullPage && page.length > 0) deferred.add(page[page.length - 1].slot);
      if (fetched.points.length < page.length) deferred.add(page[fetched.points.length].slot);
      if (page.length > 0 && page.every((r) => deferred.has(r.slot)) && fetched.points.length === page.length) deferred.clear();
      const edge = working.bottom ? working.bottom.preLamports : anchor.lamports.toString();
      const points = orderSameSlot(withoutSlots(fetched.points, page, deferred).filter((p): p is SolTxPoint => p !== null), edge, "backward");
      const pageDone = fetched.points.length === page.length && !fetched.error && !fetched.stoppedForBudget;

      // A fresh wallet's first proven transaction must state the observed balance.
      if (!working.top && points.length > 0 && !statesAnchor(points[0].postLamports, anchor)) {
        await fail("ANCHOR_MISMATCH", `newest transaction states ${points[0].postLamports} lamports; observed balance is ${anchorText}`);
        return finish();
      }
      if (!working.top && points.length === 0 && pageDone && !fullPage) {
        // No activity at all. Proven only if the observed balance is zero.
        if (!statesAnchor("0", anchor)) {
          await fail("ANCHOR_MISMATCH", `no transactions listed, but the observed balance is ${anchorText}`);
          return finish();
        }
        const next: SolBackfillCheckpoint = { ...working, reachedBeginning: true, licensedFromISO: anchor.dateISO, licensedToISO: anchor.dateISO,
          lastProgressAtISO: nowISO(), completedAtISO: nowISO(), failures: 0, lastFailure: null };
        await commit(next, [], null);
        outcome.progressed = true;
        break;
      }

      const ext = extendBackward(working.bottom, points);
      const reachedBeginning = pageDone && ext.kind === "OK" && !fullPage;
      if (ext.points.length > 0 || reachedBeginning || ext.kind === "GAP") {
        const newBottom = ext.points.length ? ext.points[ext.points.length - 1] : working.bottom;
        const top = working.top ?? ext.points[0] ?? null;
        const licensedTo = working.licensedToISO
          ?? (top ? (anchor.dateISO > top.dateISO ? anchor.dateISO : top.dateISO) : null);
        // Days newly proven: [new bottom's day, old bottom's day − 1] — or, on
        // a fresh wallet, everything from the new bottom through the licence.
        const spanFrom = newBottom?.dateISO ?? null;
        const spanTo = working.bottom ? addDaysISO(working.bottom.dateISO, -1) : licensedTo;
        // Chain order, oldest first — never re-sorted (same-slot transactions).
        const rows = spanFrom && spanTo && spanFrom <= spanTo ? dailyClosings([...ext.points].reverse(), spanFrom, spanTo) : [];
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
      // Next page: after the last signature NOT deferred, so a deferred slot is listed again whole.
      const lastKept = [...page].reverse().find((r) => !deferred.has(r.slot));
      if (lastKept) pageBefore = lastKept.signature;
      else if (listedPage.length > 0) pageBefore = listedPage[listedPage.length - 1].signature;
    }
    if (working.top && working.headUnverifiedSinceISO) { outcome.stoppedBecause = "BUDGET"; return finish(); }
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

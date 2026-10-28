/**
 * lib/crypto/sol-history-backfill.core.ts
 *
 * RESUMABLE SOLANA HISTORY — the PURE half. No db, no network, no clock.
 *
 * ── Why the old path stopped at 5,000 transactions ───────────────────────────
 * `acquireSolHistory` + `reconstructSolHistory` (sol-history.ts / -sync.ts)
 * re-scan the address from the newest signature on EVERY run, bounded by
 * DEFAULT_PAGE_BUDGET (5) × SIGNATURE_PAGE_LIMIT (1,000), keep no checkpoint,
 * and prove history by summing every movement from ZERO and comparing the total
 * to today's balance. A wallet with more than 5,000 signatures can never reach
 * its opening, so the sum can never close (residual = the opening balance), the
 * run refuses LEDGER_DOES_NOT_RECONCILE, and the next run repeats the same five
 * pages. It was application-enforced, not a provider limit.
 *
 * ── What replaces it: the chain STATES balances, so chunks prove themselves ──
 * Every Solana transaction reports the owner's lamport balance immediately
 * before (`preBalances[i]`) and after (`postBalances[i]`) it. For two
 * consecutive transactions on the address — A older, B newer —
 *
 *     post(A) === pre(B)
 *
 * holds exactly when nothing changed the balance between them. A system wallet's
 * lamports change only through transactions, so a mismatch is a PROVEN GAP (a
 * transaction the address index did not list) and is recorded as one; a match
 * proves that stretch complete. That makes history provable a chunk at a time,
 * from either end, without the opening balance and without persisting movements:
 *
 *   top      the newest proven transaction; its post must equal the OBSERVED
 *            balance (the independent anchor) before the licence reaches today
 *   bottom   the oldest proven transaction; the next run pages BEFORE it
 *
 * The quantity on each day is READ from the chain's own statement (the post
 * balance of the last transaction on or before that day) — never inferred, never
 * carried from today. Days before the bottom have no row and no licence.
 *
 * This file decides; sol-history-backfill.ts fetches, schedules and writes.
 */

/** Stored on `Connection.cursor` for a SOL wallet connection (unused by SOL before). */
export const SOL_BACKFILL_CURSOR_KIND = "sol-history";
export const SOL_BACKFILL_CURSOR_VERSION = 1;

/** `PositionObservation.completeness` on rows this path writes. */
export const SOL_CHAIN_STATED_BASIS = "CHAIN_STATED";
/** `PositionObservation.reconstructionVersion` — distinguishes rows from the old wholesale path. */
export const SOL_RECONSTRUCTION_VERSION = 2;
/** Coverage provenance: the chain's stated balances, verified by continuity. */
export const SOL_CONTINUITY_SOURCE = "solana-rpc+chain-continuity";

/** Consecutive failed runs before automatic retries slow to once per day. */
export const MAX_CONSECUTIVE_FAILURES = 6;
export const FAILED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SolBackfillFailureCode =
  | "PROVIDER_THROTTLED"   // 429 / rate-limit after bounded retries
  | "PROVIDER_TIMEOUT"     // a request exceeded its own timeout
  | "PROVIDER_ERROR"       // HTTP / JSON-RPC error, network failure
  | "INVALID_DATA"         // a response that cannot be read as a transaction
  | "ANCHOR_MISMATCH"      // the newest transaction's balance ≠ the observed balance
  | "NO_OBSERVED_ANCHOR"   // no current balance observed yet
  | "NO_PROVIDER_CONFIGURED";

/** One transaction, reduced to what the proof needs. Lamports as decimal strings (JSON-safe). */
export interface SolTxPoint {
  signature: string;
  slot: number;
  /** Seconds, as the chain states it (a validator estimate). */
  blockTime: number;
  dateISO: string;
  preLamports: string;
  postLamports: string;
}

export interface SolHistoryGap {
  /** "HEAD": between the old top and newer activity. "HISTORY": below the bottom. */
  side: "HEAD" | "HISTORY";
  /** The proven transaction at the edge of the gap, and the unproven neighbour. */
  provenSignature: string;
  neighbourSignature: string;
  /** What continuity required vs what the neighbour states. */
  expectedLamports: string;
  statedLamports: string;
  detectedAtISO: string;
}

export interface SolBackfillCheckpoint {
  kind: typeof SOL_BACKFILL_CURSOR_KIND;
  v: typeof SOL_BACKFILL_CURSOR_VERSION;
  accountId: string;
  address: string;
  top: SolTxPoint | null;
  bottom: SolTxPoint | null;
  /** A short signature page below `bottom` proved there is nothing older. */
  reachedBeginning: boolean;
  /** The licensed interval persisted with the rows (also in PositionCoverage). */
  licensedFromISO: string | null;
  licensedToISO: string | null;
  gap: SolHistoryGap | null;
  failures: number;
  lastFailure: { code: SolBackfillFailureCode; atISO: string; detail?: string } | null;
  signaturesProcessed: number;
  startedAtISO: string;
  lastProgressAtISO: string | null;
  completedAtISO: string | null;
}

export function emptyCheckpoint(accountId: string, address: string, nowISO: string): SolBackfillCheckpoint {
  return {
    kind: SOL_BACKFILL_CURSOR_KIND, v: SOL_BACKFILL_CURSOR_VERSION, accountId, address,
    top: null, bottom: null, reachedBeginning: false,
    licensedFromISO: null, licensedToISO: null, gap: null,
    failures: 0, lastFailure: null, signaturesProcessed: 0,
    startedAtISO: nowISO, lastProgressAtISO: null, completedAtISO: null,
  };
}

/**
 * Read a stored cursor. Anything that is not THIS account's SOL checkpoint at
 * THIS version is "no checkpoint" — the run starts fresh and rewrites the rows
 * it owns, rather than trusting a shape it did not write.
 */
export function parseCheckpoint(raw: string | null | undefined, accountId: string, address: string): SolBackfillCheckpoint | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<SolBackfillCheckpoint>;
  if (c.kind !== SOL_BACKFILL_CURSOR_KIND || c.v !== SOL_BACKFILL_CURSOR_VERSION) return null;
  if (c.accountId !== accountId || c.address !== address) return null;
  if (typeof c.reachedBeginning !== "boolean" || typeof c.failures !== "number") return null;
  const pointOk = (p: unknown) => p === null || (typeof p === "object" && p !== null
    && typeof (p as SolTxPoint).signature === "string" && typeof (p as SolTxPoint).postLamports === "string"
    && typeof (p as SolTxPoint).preLamports === "string" && /^\d{4}-\d{2}-\d{2}$/.test((p as SolTxPoint).dateISO));
  if (!pointOk(c.top ?? null) || !pointOk(c.bottom ?? null)) return null;
  if ((c.top == null) !== (c.bottom == null)) return null;
  return c as SolBackfillCheckpoint;
}

export function serializeCheckpoint(cp: SolBackfillCheckpoint): string {
  return JSON.stringify(cp);
}

// ── Reading one transaction ──────────────────────────────────────────────────

/** The subset of `getTransaction` the proof reads (mirrors sol-history.ts). */
export interface SolTxForProof {
  slot: number;
  blockTime: number | null;
  transaction: { message: { accountKeys: string[] } };
  meta: {
    preBalances: number[];
    postBalances: number[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
}

export class SolProofDataError extends Error {
  constructor(message: string) { super(message); this.name = "SolProofDataError"; }
}

/**
 * The owner's stated balance before and after one transaction, or null when the
 * owner is not one of its accounts (an index entry that cannot move lamports).
 *
 * Keys are static `accountKeys` then loaded WRITABLE then loaded READONLY — the
 * order `pre/postBalances` follow for v0 transactions (see sol-history.ts).
 */
export function pointFromTransaction(tx: SolTxForProof, signature: string, owner: string): SolTxPoint | null {
  const meta = tx.meta;
  if (!meta) throw new SolProofDataError(`transaction ${signature}: no meta`);
  const loaded = meta.loadedAddresses ?? null;
  const keys = [
    ...(tx.transaction?.message?.accountKeys ?? []),
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
  const { preBalances: pre, postBalances: post } = meta;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || keys.length < pre.length) {
    throw new SolProofDataError(`transaction ${signature}: balance arrays do not align with account keys`);
  }
  if (tx.blockTime === null || !Number.isFinite(tx.blockTime)) {
    throw new SolProofDataError(`transaction ${signature}: no blockTime, so it cannot be dated`);
  }
  const i = keys.indexOf(owner);
  if (i < 0 || i >= pre.length) return null;
  const toLamports = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new SolProofDataError(`transaction ${signature}: balance is not a lamport integer`);
    return String(n);
  };
  return {
    signature, slot: tx.slot, blockTime: tx.blockTime,
    dateISO: new Date(tx.blockTime * 1000).toISOString().slice(0, 10),
    preLamports: toLamports(pre[i]), postLamports: toLamports(post[i]),
  };
}

// ── Continuity ───────────────────────────────────────────────────────────────

export type ExtendResult =
  | { kind: "OK"; points: SolTxPoint[] }
  | { kind: "GAP"; points: SolTxPoint[]; gap: Omit<SolHistoryGap, "detectedAtISO" | "side"> };

/**
 * Walk OLDER transactions below `bottom`, newest first. Each must close exactly
 * onto the one above it: post(older) === pre(newer). Returns the proven prefix
 * and, on the first break, the gap. Duplicates (a page delivered twice, the
 * boundary signature repeated) are ignored by signature.
 */
export function extendBackward(bottom: SolTxPoint | null, olderNewestFirst: readonly SolTxPoint[]): ExtendResult {
  const seen = new Set<string>(bottom ? [bottom.signature] : []);
  const points: SolTxPoint[] = [];
  let edge = bottom;
  for (const p of olderNewestFirst) {
    if (seen.has(p.signature)) continue;
    seen.add(p.signature);
    if (edge && p.postLamports !== edge.preLamports) {
      return { kind: "GAP", points, gap: {
        provenSignature: edge.signature, neighbourSignature: p.signature,
        expectedLamports: edge.preLamports, statedLamports: p.postLamports,
      } };
    }
    points.push(p);
    edge = p;
  }
  return { kind: "OK", points };
}

/** Walk NEWER transactions above `top`, oldest first: pre(newer) === post(older). */
export function extendForward(top: SolTxPoint, newerOldestFirst: readonly SolTxPoint[]): ExtendResult {
  const seen = new Set<string>([top.signature]);
  const points: SolTxPoint[] = [];
  let edge = top;
  for (const p of newerOldestFirst) {
    if (seen.has(p.signature)) continue;
    seen.add(p.signature);
    if (p.preLamports !== edge.postLamports) {
      return { kind: "GAP", points, gap: {
        provenSignature: edge.signature, neighbourSignature: p.signature,
        expectedLamports: edge.postLamports, statedLamports: p.preLamports,
      } };
    }
    points.push(p);
    edge = p;
  }
  return { kind: "OK", points };
}

// ── Days ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
export function addDaysISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * End-of-day lamports for every day in [fromISO, toISO], from stated balances.
 *
 * `points` must contain every proven transaction that can be the latest one on
 * or before any day in the range (the caller includes the boundary point). A day
 * with no point on or before it in `points` gets NO entry — never a zero.
 */
export function dailyClosings(
  points: readonly SolTxPoint[], fromISO: string, toISO: string,
): Array<{ dateISO: string; lamports: bigint }> {
  if (fromISO > toISO) return [];
  const asc = [...points].sort((a, b) => a.slot - b.slot || a.blockTime - b.blockTime);
  const out: Array<{ dateISO: string; lamports: bigint }> = [];
  let i = 0;
  let last: SolTxPoint | null = null;
  // Bounded walk (≤ ~27 years of days) — both ends are ISO dates.
  for (let d = fromISO, guard = 0; d <= toISO && guard < 10_000; d = addDaysISO(d, 1), guard++) {
    while (i < asc.length && asc[i].dateISO <= d) { last = asc[i]; i++; }
    if (last) out.push({ dateISO: d, lamports: BigInt(last.postLamports) });
  }
  return out;
}

// ── Customer / operator state ────────────────────────────────────────────────

export type SolBackfillState =
  /** Wallet connected; no history run has committed anything yet. */
  | "QUEUED"
  /** Proven history exists and older activity is still being imported. */
  | "IMPORTING"
  /** Every transaction back to the first is proven, and the head reaches the observed balance. */
  | "COMPLETE"
  /** Repeated provider failures; retried automatically once a day. Proven history is kept. */
  | "FAILED"
  /** Continuity broke: a transaction the index did not list. Needs recovery. Proven history above it is kept. */
  | "RECOVERY_REQUIRED"
  /** No history provider is configured in this environment. */
  | "UNAVAILABLE";

export interface SolBackfillStatus {
  state: SolBackfillState;
  /** The proven interval, when there is one — "history shown from …". */
  historyFromISO: string | null;
  historyToISO: string | null;
  /** True when some, but not all, history is proven. */
  partial: boolean;
  /** Retryable without an operator. */
  retryable: boolean;
  lastFailureCode: SolBackfillFailureCode | null;
  lastProgressAtISO: string | null;
  signaturesProcessed: number;
}

export function backfillStatus(cp: SolBackfillCheckpoint | null): SolBackfillStatus {
  if (!cp) {
    return { state: "QUEUED", historyFromISO: null, historyToISO: null, partial: false, retryable: true,
      lastFailureCode: null, lastProgressAtISO: null, signaturesProcessed: 0 };
  }
  const base = {
    historyFromISO: cp.licensedFromISO, historyToISO: cp.licensedToISO,
    lastFailureCode: cp.lastFailure?.code ?? null,
    lastProgressAtISO: cp.lastProgressAtISO, signaturesProcessed: cp.signaturesProcessed,
  };
  const hasHistory = cp.licensedFromISO !== null;
  if (cp.gap) return { ...base, state: "RECOVERY_REQUIRED", partial: hasHistory, retryable: false };
  if (cp.lastFailure?.code === "NO_PROVIDER_CONFIGURED") return { ...base, state: "UNAVAILABLE", partial: hasHistory, retryable: false };
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES) return { ...base, state: "FAILED", partial: hasHistory, retryable: true };
  if (cp.reachedBeginning && cp.completedAtISO) return { ...base, state: "COMPLETE", partial: false, retryable: true };
  if (!hasHistory) return { ...base, state: "QUEUED", partial: false, retryable: true };
  return { ...base, state: "IMPORTING", partial: true, retryable: true };
}

/** Should an automatic (scheduled / user-sync) run do work now? Operator resume bypasses this. */
export function shouldRunAutomatically(cp: SolBackfillCheckpoint | null, nowMs: number): { run: boolean; why?: string } {
  if (!cp) return { run: true };
  if (cp.gap) return { run: false, why: "history gap — recovery required" };
  if (cp.lastFailure?.code === "NO_PROVIDER_CONFIGURED") return { run: true };
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES && cp.lastFailure) {
    const since = nowMs - Date.parse(cp.lastFailure.atISO);
    if (since < FAILED_RETRY_INTERVAL_MS) return { run: false, why: "repeated provider failures — next automatic retry within a day" };
  }
  return { run: true };
}

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
  /**
   * Set while the head is proven continuous but its newest transaction does
   * not (yet) state the observed balance — a race with the balance read, or
   * activity not indexed yet. The licence then stops before the top's day.
   * Not a failure: it never pauses the backfill.
   */
  headUnverifiedSinceISO?: string | null;
  /**
   * OWNER DECISION 2026-10-28 — PRESERVE VALIDATED LEGACY HISTORY.
   * "STAGING": the wallet already carries a licensed history from the previous
   * importer. The new proof is built here (end-of-day closings in `staged`)
   * and writes NO rows and NO licence until it is promoted — atomically —
   * so the legacy history stays exactly as it was and two projections are
   * never mixed. "DIRECT" (or absent): rows and licence are written as proven.
   */
  mode?: "DIRECT" | "STAGING";
  /** STAGING only: [dateISO, lamports] end-of-day closings proven so far, ascending. */
  staged?: Array<[string, string]>;
  /** STAGING only: the legacy licensed interval being preserved. */
  legacy?: { fromISO: string; toISO: string } | null;
  promotedAtISO?: string | null;
  /** Days on which the proof disagreed with the legacy rows it replaced (disclosed, never hidden). */
  legacyDiscrepancy?: { days: number; firstISO: string; detectedAtISO: string } | null;
  /**
   * Provider requests this wallet's backfill has sent on `dayISO` (UTC), by ANY
   * caller — the background worker AND wallet syncs — persisted with every
   * commit. The worker's daily cap is the sum of these across wallets, so it
   * holds across runs, overlapping triggers and runs killed mid-flight (at most
   * the requests since the last commit go uncounted).
   */
  usage?: { dayISO: string; requests: number } | null;
  /**
   * The worker wrote rows from this date and has not yet regenerated the wealth
   * history over them (it ran out of wake time). Done first on its next run.
   */
  snapshotPendingFromISO?: string | null;
  /**
   * The price floor this wallet was last flagged for revaluation under
   * (jobs/sol-history-backfill.ts). A state-derived "revaluation owed" is acted
   * on at most once per floor, so a history the snapshots still cannot reach
   * (another unpriced holding in the Space) never loops.
   */
  valuationCheckedFloorISO?: string | null;
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
  if (c.mode !== undefined && c.mode !== "DIRECT" && c.mode !== "STAGING") return null;
  if (c.staged !== undefined && !(Array.isArray(c.staged) && c.staged.every((e) => Array.isArray(e) && e.length === 2
    && /^\d{4}-\d{2}-\d{2}$/.test(String(e[0])) && /^\d+$/.test(String(e[1]))))) return null;
  if (c.mode === "STAGING" && (!c.legacy || typeof c.legacy.fromISO !== "string" || typeof c.legacy.toISO !== "string")) return null;
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
 * or before any day in the range (the caller includes the boundary point), in
 * CHAIN ORDER, oldest first — the order continuity proved. They are NOT
 * re-sorted: two transactions in one slot share a blockTime, so only the proven
 * order says which closed the day. A day with no point on or before it in
 * `points` gets NO entry — never a zero.
 */
export function dailyClosings(
  points: readonly SolTxPoint[], fromISO: string, toISO: string,
): Array<{ dateISO: string; lamports: bigint }> {
  if (fromISO > toISO) return [];
  const asc = points;
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
  /** False while the newest activity does not yet reconcile with the observed balance (history then stops short of today). */
  headVerified: boolean;
  /** True while the previous importer's validated history is still the one shown. */
  legacyInForce: boolean;
  /** Days where the proof disagreed with replaced legacy history (disclosed). */
  legacyDiscrepancy: { days: number; firstISO: string } | null;
}

export function backfillStatus(cp: SolBackfillCheckpoint | null): SolBackfillStatus {
  if (!cp) {
    return { state: "QUEUED", historyFromISO: null, historyToISO: null, partial: false, retryable: true,
      lastFailureCode: null, lastProgressAtISO: null, signaturesProcessed: 0, headVerified: false,
      legacyInForce: false, legacyDiscrepancy: null };
  }
  const base = {
    historyFromISO: cp.licensedFromISO, historyToISO: cp.licensedToISO,
    lastFailureCode: cp.lastFailure?.code ?? null,
    lastProgressAtISO: cp.lastProgressAtISO, signaturesProcessed: cp.signaturesProcessed,
    headVerified: cp.top !== null && !cp.headUnverifiedSinceISO,
    legacyInForce: cp.mode === "STAGING",
    legacyDiscrepancy: cp.legacyDiscrepancy ? { days: cp.legacyDiscrepancy.days, firstISO: cp.legacyDiscrepancy.firstISO } : null,
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

/**
 * Is this `Connection.cursor` a SOL history checkpoint? Source health reads
 * "has a cursor" as "Bitcoin xpub discovery in progress"; a SOL checkpoint must
 * never be mistaken for one.
 */
export function isSolBackfillCursor(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.startsWith(`{"kind":"${SOL_BACKFILL_CURSOR_KIND}"`);
}

/**
 * Order transactions WITHIN a slot so the balances chain.
 *
 * `getSignaturesForAddress` orders by slot; within one slot its order is not a
 * documented execution order. Reading a same-slot pair backwards would report a
 * gap that is not there (and RECOVERY_REQUIRED for ever). So each run of
 * same-slot points is permuted, small groups only, to the order whose
 * pre/post balances connect to `edgeLamports` and to each other. No connecting
 * order ⇒ the input order is kept and continuity reports the gap honestly.
 *
 * `direction` "backward": input newest-first, edge = the newer neighbour's PRE
 * (or, for a fresh wallet, the observed balance its newest must state).
 * "forward": input oldest-first, edge = the older neighbour's POST.
 */
export function orderSameSlot(points: readonly SolTxPoint[], edgeLamports: string | null, direction: "backward" | "forward"): SolTxPoint[] {
  const out: SolTxPoint[] = [];
  let edge = edgeLamports;
  for (let i = 0; i < points.length; ) {
    let j = i + 1;
    while (j < points.length && points[j].slot === points[i].slot) j++;
    const group = points.slice(i, j);
    let ordered = group;
    if (group.length > 1 && group.length <= 7 && edge !== null) {
      const found = permuteToChain(group, edge, direction);
      if (found) ordered = found;
    }
    out.push(...ordered);
    const last = ordered[ordered.length - 1];
    edge = direction === "backward" ? last.preLamports : last.postLamports;
    i = j;
  }
  return out;
}

function permuteToChain(group: readonly SolTxPoint[], edge: string, direction: "backward" | "forward"): SolTxPoint[] | null {
  const used = new Array(group.length).fill(false);
  const path: SolTxPoint[] = [];
  const walk = (e: string): boolean => {
    if (path.length === group.length) return true;
    for (let k = 0; k < group.length; k++) {
      if (used[k]) continue;
      const p = group[k];
      const fits = direction === "backward" ? p.postLamports === e : p.preLamports === e;
      if (!fits) continue;
      used[k] = true; path.push(p);
      if (walk(direction === "backward" ? p.preLamports : p.postLamports)) return true;
      used[k] = false; path.pop();
    }
    return false;
  };
  return walk(edge) ? [...path] : null;
}

/** The observed balance an anchor states, with the float-storage tolerance it carries. */
export function statesAnchor(postLamports: string, anchor: { lamports: bigint; toleranceLamports?: bigint }): boolean {
  const d = BigInt(postLamports) - anchor.lamports;
  const tol = anchor.toleranceLamports ?? BigInt(0);
  return (d < BigInt(0) ? -d : d) <= tol;
}

// ── Legacy preservation (staging → atomic promotion) ─────────────────────────

/** Apply one chunk to the staged closings exactly as the store applies it to rows. */
export function applyToStaged(
  staged: ReadonlyArray<[string, string]>, span: { from: string; to: string } | null, rows: ReadonlyArray<{ dateISO: string; lamports: bigint }>,
): Array<[string, string]> {
  const m = new Map<string, string>(staged);
  if (span) for (const d of [...m.keys()]) if (d >= span.from && d <= span.to) m.delete(d);
  for (const r of rows) m.set(r.dateISO, r.lamports.toString());
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export interface PromotionDecision {
  promote: boolean;
  /** Why: COVERED (the proof spans the legacy interval) or LEGACY_DISPROVED (it disagrees on a proven day). */
  reason: "COVERED" | "LEGACY_DISPROVED" | null;
  discrepancy: { days: number; firstISO: string } | null;
}

/**
 * Promote when the new proof covers the whole legacy interval — or as soon as
 * it DISAGREES with a legacy row on a day it has proven: that legacy history is
 * then demonstrably wrong, and presenting it any longer would mislead. A
 * disagreement is returned for disclosure either way.
 *
 * `toleranceSol` absorbs float storage of the legacy quantity (never more).
 */
export function decidePromotion(
  next: Pick<SolBackfillCheckpoint, "licensedFromISO" | "licensedToISO" | "reachedBeginning" | "completedAtISO">,
  staged: ReadonlyArray<[string, string]>,
  legacy: { fromISO: string; toISO: string },
  legacyRows: ReadonlyMap<string, number>,
  toleranceSol = 1e-9,
): PromotionDecision {
  let days = 0;
  let firstISO: string | null = null;
  for (const [d, lamports] of staged) {
    // legacy.toISO is EXCLUDED: the old importer licensed through the day of a
    // MIDDAY balance reading, so its row there is that moment's balance, while
    // the proof states the END of the day. Activity later that day makes them
    // differ legitimately — that is not evidence the legacy history was wrong.
    if (d < legacy.fromISO || d >= legacy.toISO) continue;
    const q = legacyRows.get(d);
    if (q === undefined) continue;
    const sol = Number(BigInt(lamports)) / 1e9;
    if (Math.abs(sol - q) > Math.max(toleranceSol, Math.abs(q) * 1e-12)) { days++; if (!firstISO) firstISO = d; }
  }
  const discrepancy = days > 0 ? { days, firstISO: firstISO! } : null;
  const covered = !!next.licensedFromISO && !!next.licensedToISO
    && (next.licensedFromISO <= legacy.fromISO || (next.reachedBeginning && !!next.completedAtISO))
    && next.licensedToISO >= legacy.toISO;
  if (discrepancy) return { promote: true, reason: "LEGACY_DISPROVED", discrepancy };
  if (covered) return { promote: true, reason: "COVERED", discrepancy: null };
  return { promote: false, reason: null, discrepancy: null };
}

/** Requests recorded for `dayISO` in a checkpoint (0 when the day differs). */
export function usageOn(cp: Pick<SolBackfillCheckpoint, "usage"> | null, dayISO: string): number {
  return cp?.usage && cp.usage.dayISO === dayISO && Number.isFinite(cp.usage.requests) ? cp.usage.requests : 0;
}

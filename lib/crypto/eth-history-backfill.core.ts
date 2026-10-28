/**
 * lib/crypto/eth-history-backfill.core.ts
 *
 * PURE. The Ethereum FULL rebuild, taken off the sync path (2026-10-28).
 *
 * The incremental path (eth-history-incremental.ts) is cheap — measured ≈4.7 s
 * and 18 requests — but when one of its invariants fails it hands back to the
 * FULL rebuild, which re-proves every block since Byzantium: measured 157 s and
 * 551 requests, inside the sync request. A newly connected wallet gets its
 * first history the same way.
 *
 * With the history worker enabled for Ethereum (`ETH_BACKFILL_ENABLED=true`,
 * and the worker job itself on — SOL_BACKFILL_ENABLED, as for Bitcoin), a sync
 * runs the INCREMENTAL path only. On a fallback it records a QUEUED checkpoint
 * here (reason = the fallback reason) and writes nothing; the worker
 * (jobs/sol-history-backfill.ts, ETH pass) runs the full rebuild in bounded,
 * resumable steps and writes the rows ONCE, when the whole proof closes and
 * reconciles — never a partial history that looks complete.
 *
 * ── Where the checkpoint lives ──────────────────────────────────────────────
 * `Connection.historyCheckpoint` (migration 20261028120000 — Bitcoin's column),
 * on the same history link (canonical first, then oldest). The chain
 * discriminator is `kind: "eth-history"` + `chain: "ETH"`; a BTC or SOL reader
 * rejects it, and this parser rejects theirs.
 *
 * ── What a step carries ─────────────────────────────────────────────────────
 * The acquisition (eth-history.ts) proves right-to-left from a FINALIZED
 * anchor and stops at its probe budget with a PROVEN lower boundary. The
 * checkpoint keeps that anchor (block + exact wei balance), the boundary, and
 * every movement proven so far — wei as decimal STRINGS, never floats. The next
 * step resumes the same anchor from the boundary. When the proof reaches the
 * provable floor, a last step proves the gap from the anchor to the current
 * finalized head, and only then is anything reconciled and written.
 */

import type { ChainMovement, ChainMovementRole, ChainTimeBasis } from "./chain-movement";

export const ETH_BACKFILL_KIND = "eth-history";
export const ETH_BACKFILL_VERSION = 1;
export const ETH_BACKFILL_CHAIN = "ETH";
export const MAX_CONSECUTIVE_FAILURES = 6;
export const FAILED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The acquisition's default chunk; halved after a step that proved nothing (a dense chunk), never below the minimum. */
export const DEFAULT_ETH_CHUNK_BLOCKS = 50_000;
export const MIN_ETH_CHUNK_BLOCKS = 1_000;

export type EthBackfillFailureCode =
  /** Provider error, throttle that outlasted backoff, or no provider configured. Progress kept. */
  | "PROVIDER_FAILED"
  /** Contract wallet or a live EIP-7702 delegation — no interval can be proven. Retried daily (a delegation can be revoked). */
  | "PROOF_PREMISES_UNMET"
  /** Movements did not sum to the anchor, or a segment disagreed with the stored anchor. The generation restarts. */
  | "LEDGER_DOES_NOT_RECONCILE"
  /** No OBSERVED position to anchor the replay against yet. Progress kept. */
  | "NO_OBSERVED_ANCHOR";

/** A ChainMovement with its wei as a decimal string (JSON has no bigint). */
export interface StoredEthMovement {
  networkId: string; eventId: string; movementKey: string; assetKey: string; ownedAddress: string;
  baseUnitsDelta: string; role: ChainMovementRole; occurredAtISO: string | null; dateISO: string;
  timeBasis: ChainTimeBasis; failed: boolean; counterparties: string[]; sequence: number | null; source: string;
}

export interface EthBackfillCheckpoint {
  kind: typeof ETH_BACKFILL_KIND;
  v: typeof ETH_BACKFILL_VERSION;
  chain: typeof ETH_BACKFILL_CHAIN;
  accountId: string;
  /** Why the sync handed the rebuild over (an EthIncrementalFallback code). */
  reason: string;
  queuedAtISO: string;
  /** The finalized block the backward proof is anchored at, and its EXACT wei balance. */
  anchorBlock: number | null;
  anchorBalanceWei: string | null;
  /** The deepest PROVEN block and its date (the licence's lower edge so far). */
  provenFromBlock: number | null;
  provenFromISO: string | null;
  /** The anchor block's date (the licence's upper edge so far). */
  anchorToISO: string | null;
  /** True once the backward proof reached the provable floor. */
  reachedFloor: boolean;
  movements: StoredEthMovement[];
  /** Set on completion, when the movements are dropped (they live in the rows). */
  movementsFound?: number;
  chunkBlocks: number;
  probesUsed: number;
  /** Requests this wallet's backfill sent on `dayISO` (UTC). */
  usage: { dayISO: string; requests: number } | null;
  /** Rows were written from this date and wealth history has not been regenerated over them yet. */
  snapshotPendingFromISO: string | null;
  failures: number;
  lastFailure: { code: EthBackfillFailureCode; atISO: string; detail?: string } | null;
  lastProgressAtISO: string | null;
  completedAtISO: string | null;
  /** Licensed interval written by the completing step. */
  licensedFromISO: string | null;
  licensedToISO: string | null;
}

export function queuedCheckpoint(accountId: string, reason: string, nowISO: string): EthBackfillCheckpoint {
  return {
    kind: ETH_BACKFILL_KIND, v: ETH_BACKFILL_VERSION, chain: ETH_BACKFILL_CHAIN, accountId, reason, queuedAtISO: nowISO,
    anchorBlock: null, anchorBalanceWei: null, provenFromBlock: null, provenFromISO: null, anchorToISO: null,
    reachedFloor: false, movements: [], chunkBlocks: DEFAULT_ETH_CHUNK_BLOCKS, probesUsed: 0, usage: null,
    snapshotPendingFromISO: null, failures: 0, lastFailure: null, lastProgressAtISO: null, completedAtISO: null,
    licensedFromISO: null, licensedToISO: null,
  };
}

/** The same generation, with its proof progress discarded (a restart after a reconciliation failure). */
export function restartGeneration(cp: EthBackfillCheckpoint): EthBackfillCheckpoint {
  return { ...cp, anchorBlock: null, anchorBalanceWei: null, provenFromBlock: null, provenFromISO: null, anchorToISO: null,
    reachedFloor: false, movements: [], chunkBlocks: DEFAULT_ETH_CHUNK_BLOCKS };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nullableInt = (v: unknown) => v === null || Number.isSafeInteger(v);
const nullableStr = (v: unknown) => v === null || typeof v === "string";

function movementOk(m: unknown): boolean {
  if (!isObj(m)) return false;
  return typeof m.eventId === "string" && typeof m.movementKey === "string" && typeof m.dateISO === "string"
    && typeof m.baseUnitsDelta === "string" && /^-?\d+$/.test(m.baseUnitsDelta)
    && Array.isArray(m.counterparties) && nullableInt(m.sequence) && nullableStr(m.occurredAtISO);
}

/** Shape check only — no account match (the operator view reads many wallets at once). */
function parseAny(raw: string | null | undefined): EthBackfillCheckpoint | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v)) return null;
  if (v.kind !== ETH_BACKFILL_KIND || v.v !== ETH_BACKFILL_VERSION || v.chain !== ETH_BACKFILL_CHAIN) return null;
  if (typeof v.accountId !== "string" || typeof v.reachedFloor !== "boolean" || typeof v.failures !== "number") return null;
  if (!nullableInt(v.anchorBlock) || !nullableInt(v.provenFromBlock) || !Number.isSafeInteger(v.chunkBlocks)) return null;
  if (v.anchorBalanceWei !== null && !(typeof v.anchorBalanceWei === "string" && /^\d+$/.test(v.anchorBalanceWei))) return null;
  if (!Array.isArray(v.movements) || !v.movements.every(movementOk)) return null;
  return v as unknown as EthBackfillCheckpoint;
}

/** Is this stored value an ETH history checkpoint at all (any account)? */
export function isEthBackfillCursor(raw: string | null | undefined): boolean {
  return parseAny(raw) !== null;
}

/**
 * Read a stored checkpoint. Anything that is not THIS account's ETH checkpoint
 * at THIS version is "no checkpoint" — never trusted.
 */
export function parseCheckpoint(raw: string | null | undefined, accountId: string): EthBackfillCheckpoint | null {
  const cp = parseAny(raw);
  return cp && cp.accountId === accountId ? cp : null;
}

export function serializeCheckpoint(cp: EthBackfillCheckpoint): string {
  return JSON.stringify(cp);
}

export function storeMovement(m: ChainMovement): StoredEthMovement {
  return { ...m, baseUnitsDelta: m.baseUnitsDelta.toString(), counterparties: [...m.counterparties] };
}

export function loadMovement(m: StoredEthMovement): ChainMovement {
  return { ...m, baseUnitsDelta: BigInt(m.baseUnitsDelta) };
}

/** Union by chain identity (eventId + movementKey) — a resumed step never double-counts a block. */
export function mergeMovements(a: readonly StoredEthMovement[], b: readonly StoredEthMovement[]): StoredEthMovement[] {
  const seen = new Map<string, StoredEthMovement>();
  for (const m of [...a, ...b]) seen.set(`${m.eventId}#${m.movementKey}`, m);
  return [...seen.values()].sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0) || x.eventId.localeCompare(y.eventId) || x.movementKey.localeCompare(y.movementKey));
}

// ── Customer / operator state — the SOL/BTC vocabulary ───────────────────────

export type EthBackfillState = "QUEUED" | "IMPORTING" | "COMPLETE" | "FAILED";

export interface EthBackfillStatus {
  state: EthBackfillState;
  /** The licensed interval written by the worker — null until the whole proof closed (nothing partial is licensed). */
  historyFromISO: string | null;
  historyToISO: string | null;
  /** Oldest day proven so far — progress, NOT a licence. */
  importedBackToISO: string | null;
  partial: boolean;
  retryable: boolean;
  lastFailureCode: EthBackfillFailureCode | null;
  lastProgressAtISO: string | null;
  /** Movements proven so far (ETH has no signatures; this is the honest count). */
  movementsFound: number;
  headVerified: boolean;
}

export function backfillStatus(cp: EthBackfillCheckpoint): EthBackfillStatus {
  const base = {
    historyFromISO: cp.licensedFromISO, historyToISO: cp.licensedToISO, importedBackToISO: cp.provenFromISO,
    lastFailureCode: cp.lastFailure?.code ?? null, lastProgressAtISO: cp.lastProgressAtISO,
    movementsFound: cp.movementsFound ?? cp.movements.length, headVerified: cp.completedAtISO !== null,
  };
  if (cp.completedAtISO) return { ...base, state: "COMPLETE", partial: false, retryable: true };
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES) return { ...base, state: "FAILED", partial: false, retryable: true };
  if (cp.provenFromBlock === null) return { ...base, state: "QUEUED", partial: false, retryable: true };
  return { ...base, state: "IMPORTING", partial: false, retryable: true };
}

/** Should an automatic run do work now? FAILED waits out its daily pause. */
export function shouldRunAutomatically(cp: EthBackfillCheckpoint, nowMs: number): boolean {
  if (cp.completedAtISO) return false;
  if (cp.failures >= MAX_CONSECUTIVE_FAILURES && cp.lastFailure) {
    return nowMs - Date.parse(cp.lastFailure.atISO) >= FAILED_RETRY_INTERVAL_MS;
  }
  return true;
}

/** Requests recorded for `dayISO` (0 when the day differs). */
export function usageOn(cp: Pick<EthBackfillCheckpoint, "usage"> | null, dayISO: string): number {
  return cp?.usage && cp.usage.dayISO === dayISO && Number.isFinite(cp.usage.requests) ? cp.usage.requests : 0;
}

/** Add `n` requests to today's usage. */
export function addUsage(cp: EthBackfillCheckpoint, dayISO: string, n: number): EthBackfillCheckpoint["usage"] {
  return { dayISO, requests: usageOn(cp, dayISO) + Math.max(0, n) };
}

/**
 * OPERATOR VIEW — the same shape `statusFromCursor` (sol-history-backfill.core)
 * returns, so Platform Ops and Connections read Ethereum with SOL's words.
 * `signaturesProcessed` carries 0: Ethereum has no signatures, and the
 * movement count is reported separately rather than relabelled.
 */
export function ethStatusFromCursor(raw: string | null | undefined, todayISO: string): (EthBackfillStatus & {
  failures: number; mode: "DIRECT"; requestsToday: number; nextAutomaticRetryISO: string | null;
  signaturesProcessed: number; legacyDiscrepancy: null;
}) | null {
  const cp = parseAny(raw);
  if (!cp) return null;
  const st = backfillStatus(cp);
  const next = st.state === "FAILED" && cp.lastFailure
    ? new Date(Date.parse(cp.lastFailure.atISO) + FAILED_RETRY_INTERVAL_MS).toISOString() : null;
  return { ...st, failures: cp.failures, mode: "DIRECT", requestsToday: usageOn(cp, todayISO), nextAutomaticRetryISO: next,
    signaturesProcessed: 0, legacyDiscrepancy: null };
}

// ── Gates and worker budget ─────────────────────────────────────────────────

/**
 * The worker carries Ethereum only when its job runs at all (SOL_BACKFILL_ENABLED,
 * which gates the whole job — as for Bitcoin) AND Ethereum is opted in. Off:
 * syncs run the full rebuild inline exactly as before.
 */
export function ethWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SOL_BACKFILL_ENABLED === "true" && env.ETH_BACKFILL_ENABLED === "true";
}

export interface EthBackfillWorkerConfig {
  enabled: boolean;
  /** Blocks probed per wallet step (each probe = 3 JSON-RPC calls; ≈1,500 ≈ 225 batched requests ≈ 60 s). */
  probeBudget: number;
  /** Do not START a wallet with less than this left of the pass. */
  startReserveMs: number;
}

const num = (env: Record<string, string | undefined>, k: string, d: number, min: number, max: number) => {
  const n = Number(env[k]);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

/** Env-configured, clamped. A bad value falls back to the default, never to "unlimited". */
export function ethWorkerConfig(env: Record<string, string | undefined> = process.env): EthBackfillWorkerConfig {
  return {
    enabled:        ethWorkerEnabled(env),
    probeBudget:    num(env, "ETH_BACKFILL_PROBE_BUDGET", 1_500, 100, 4_000),
    startReserveMs: num(env, "ETH_BACKFILL_START_RESERVE_MS", 75_000, 5_000, 200_000),
  };
}

/** JSON-RPC calls one probe costs (balance, nonce, code). */
export const CALLS_PER_PROBE = 3;
/** Calls reserved beyond the probes: head, two coverage headers, and evidence for a few change blocks. */
export const STEP_CALL_RESERVE = 16;

/** The probe budget a step may spend under the remaining shared Alchemy allowance (0 ⇒ do not start). */
export function probeBudgetFor(allowanceCalls: number, configured: number): number {
  const n = Math.floor((allowanceCalls - STEP_CALL_RESERVE) / CALLS_PER_PROBE);
  return Math.max(0, Math.min(configured, n));
}

export interface EthBackfillCandidate { accountId: string; connectionId: string; cursor: string | null }

/** Who runs, in order: never progressed → least recently progressed → account id. COMPLETE and paused FAILED are skipped. */
export function orderEthCandidates<T extends EthBackfillCandidate & { checkpoint: EthBackfillCheckpoint | null }>(rows: readonly T[], nowMs: number): T[] {
  return rows
    .filter((r) => r.checkpoint !== null && shouldRunAutomatically(r.checkpoint, nowMs))
    .sort((a, b) => (a.checkpoint!.lastProgressAtISO ?? "").localeCompare(b.checkpoint!.lastProgressAtISO ?? "") || a.accountId.localeCompare(b.accountId));
}

/**
 * lib/platform/stall-projection.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 1 — project a PlaidItem's unresolved cursor-blocking
 * SyncIssue rows into the one operational fact an operator needs:
 *
 *   "Chase is syncing normally"   vs   "Chase has been stalled for 3 days
 *                                       after 7 failed persistence attempts"
 *
 * The cursor-safety invariant (986d97a) makes a stall SAFE — a held cursor is
 * how we refuse to lose a transaction. But safe is not the same as visible, and
 * a permanently failing row can now hold one item indefinitely. Platform Ops
 * previously showed only that some issues existed, with no duration and no
 * notion of repeated attempts.
 *
 * ── ATTEMPTS ARE NOT ROWS ────────────────────────────────────────────────────
 * This is the semantic that matters and the easiest to get wrong. `runId` is
 * minted ONCE per `syncTransactionsForItem` invocation, so it identifies a sync
 * ATTEMPT. One failed attempt that could not persist twelve transactions writes
 * TWELVE rows sharing ONE runId. Counting rows would report "12 retries" for a
 * single try — an order-of-magnitude lie about how hard the system is working.
 *
 *   attempts         = COUNT(DISTINCT detail.runId)   ← failed sync runs
 *   unpersistedCount = row count                      ← failed persistence
 *                                                       obligations
 *
 * Both are reported, labelled differently, and never conflated.
 *
 * ── LEGACY ROWS ARE NOT COUNTED ──────────────────────────────────────────────
 * Rows written before the cursor-safety slice carry no `runId` and no
 * `cursorBlocking` flag. Their attempt count is genuinely unknowable — each may
 * represent one attempt or many. They are surfaced separately as
 * `legacyFailureCount` and NEVER folded into `attempts`, because an honest
 * "unknown" beats a confident wrong number.
 *
 * ── WHAT "STALLED" MEANS ─────────────────────────────────────────────────────
 * BOTH conditions must hold:
 *   • the item is still sync-incomplete (`syncIncompleteAt != null`), AND
 *   • at least one unresolved cursor-blocking condition exists.
 *
 * Historical rows alone are not a stall — they may all have recovered. And a
 * `syncIncompleteAt` with no cursor-blocking issue is some OTHER incompleteness
 * (an interrupted first import, a lock skip); this module reports
 * `stalled: false` for it rather than fabricating a persistence incident, and
 * leaves the pre-existing generic sync-incomplete semantics untouched.
 *
 * PURE: no DB, no clock beyond the injected `now`, no I/O.
 */

import { classifySyncIssue, type ClassifiableSyncIssue } from "@/lib/platform/sync-issue-semantics";

/** The SyncIssue fields this projection needs. `detail` is read, never re-emitted. */
export interface StallIssueRow extends ClassifiableSyncIssue {
  createdAt: Date;
  resolved:  boolean;
}

export interface StallInput {
  /** PlaidItem.syncIncompleteAt — null means a full sync has completed. */
  syncIncompleteAt: Date | null;
  /** Every SyncIssue row for THIS item (resolved ones included; filtered here). */
  issues: readonly StallIssueRow[];
  now: Date;
}

export interface ItemStall {
  /** True only when the item is sync-incomplete AND has an unresolved
   *  cursor-blocking condition. See the module header. */
  stalled: boolean;
  /** Earliest unresolved cursor-blocking failure — when THIS stall began. */
  stalledSince: Date | null;
  /** Most recent unresolved cursor-blocking failure. */
  latestFailure: Date | null;
  /** Milliseconds since `stalledSince`. Null when not stalled. */
  stalledForMs: number | null;
  /** DISTINCT failed sync RUNS. Never the row count. */
  attempts: number;
  /** Failed persistence OBLIGATIONS — transactions still unwritten. */
  unpersistedCount: number;
  /** Unresolved transaction-domain failures predating runId/cursorBlocking.
   *  Their attempt count is unknowable, so they are reported, not counted. */
  legacyFailureCount: number;
}

const EMPTY: ItemStall = {
  stalled: false, stalledSince: null, latestFailure: null, stalledForMs: null,
  attempts: 0, unpersistedCount: 0, legacyFailureCount: 0,
};

function runIdOf(row: StallIssueRow): string | null {
  const d = row.detail;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const v = (d as Record<string, unknown>).runId;
  return typeof v === "string" ? v : null;
}

/**
 * Project one item's issues into its stall state. Pure.
 *
 * Only UNRESOLVED rows participate: a recovered incident is history, and the
 * cursor-safety slice resolves cursor-blocking rows precisely when a later sync
 * proves the held page replayed.
 */
export function projectItemStall(input: StallInput): ItemStall {
  const unresolved = input.issues.filter((r) => !r.resolved);

  const blocking: StallIssueRow[] = [];
  let legacyFailureCount = 0;

  for (const row of unresolved) {
    const cls = classifySyncIssue(row);
    if (cls.cursorBlocking) { blocking.push(row); continue; }
    // A transaction-domain CONDITION without the cursor-blocking stamp is a
    // pre-cursor-safety failure: real, unresolved, but of unknown attempt depth.
    if (cls.domain === "transactions" && cls.nature === "condition") legacyFailureCount++;
  }

  if (blocking.length === 0) {
    // No cursor-blocking condition ⇒ not a persistence stall, even if the item
    // is sync-incomplete for some other reason. Legacy rows still reported.
    return { ...EMPTY, legacyFailureCount };
  }

  const times = blocking.map((r) => r.createdAt.getTime());
  const stalledSince  = new Date(Math.min(...times));
  const latestFailure = new Date(Math.max(...times));

  // DISTINCT runs, not rows. A row with no runId cannot be attributed to a run;
  // it is already excluded from `blocking` unless explicitly stamped, and if a
  // stamped row ever lacked a runId it is counted once under a stable sentinel
  // rather than inflating the total per-row.
  const runIds = new Set(blocking.map((r) => runIdOf(r) ?? "__unattributed__"));

  const stalled = input.syncIncompleteAt !== null;

  return {
    stalled,
    stalledSince,
    latestFailure,
    stalledForMs: stalled ? Math.max(0, input.now.getTime() - stalledSince.getTime()) : null,
    attempts: runIds.size,
    unpersistedCount: blocking.length,
    legacyFailureCount,
  };
}

/**
 * Coarse duration for operator copy ("3d 4h", "2h 15m", "8m"). Deliberately
 * coarser than a timestamp and never rounded up — an operator reading "3d"
 * should never discover it was actually 2d 1h.
 */
export function formatStallDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** One-line operator summary. Counts are labelled so they can't be confused. */
export function describeStall(stall: ItemStall, institution: string): string {
  if (!stall.stalled) return `${institution} — syncing normally`;
  const parts = [
    `stalled ${formatStallDuration(stall.stalledForMs ?? 0)}`,
    `${stall.attempts} failed attempt${stall.attempts === 1 ? "" : "s"}`,
    `${stall.unpersistedCount} transaction${stall.unpersistedCount === 1 ? "" : "s"} unpersisted`,
  ];
  if (stall.legacyFailureCount > 0) {
    parts.push(`${stall.legacyFailureCount} legacy failure${stall.legacyFailureCount === 1 ? "" : "s"} (attempts unknown)`);
  }
  return `${institution} — ${parts.join(" · ")}`;
}
